/**
 * The Bedrock proposer, driven entirely by a fake transport.
 *
 * There is no network in this file and there never may be: every case below --
 * a good answer, a malformed one, JSON that is not a mystery, a refusal, a
 * timeout, a missing credential, a throttled call -- is produced by an object
 * the test hands in. That is the whole reason `ConverseTransport` exists as a
 * one-method seam.
 *
 * The claim under test is not "Bedrock works". It is that a *failing* Bedrock
 * is an ordinary typed value that a retry loop can reason about: each of the
 * cases asserts the failure kind, and the `no throw` assertions are deliberate
 * -- `propose` resolves in every case, including the ones where the transport
 * itself threw.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BedrockProposer,
  buildGrammarPrompt,
  configFromEnv,
  credentialsPresent,
  defaultTransport,
  parseProposal,
  transportError,
  type ConverseRequest,
  type ConverseTransport,
} from "../app/gen/src/bedrock.ts";
import { gate } from "../app/gen/src/gate.ts";
import { composeLocal, mysteryJson } from "../app/gen/src/local.ts";
import type { ProposeResult } from "../app/gen/src/proposer.ts";

const CONFIG = { region: "us-east-1", modelId: "test-model", temperature: 0.7, timeoutMs: 200 };

/** A good answer, built by the repository's own generator rather than typed by hand. */
const GOOD_JSON = mysteryJson(composeLocal({ seed: 7, roles: 3 }));

function transportOf(answer: (request: ConverseRequest) => Promise<{ text: string; stopReason?: string }>): ConverseTransport {
  return { converse: answer };
}

function proposerWith(transport: ConverseTransport, timeoutMs = CONFIG.timeoutMs) {
  return new BedrockProposer({
    transport,
    config: { ...CONFIG, timeoutMs },
    hasCredentials: true,
  });
}

async function propose(transport: ConverseTransport, timeoutMs = CONFIG.timeoutMs): Promise<ProposeResult> {
  return proposerWith(transport, timeoutMs).propose({ seed: 7, roles: 3 });
}

describe("a good answer", () => {
  it("becomes a proposal that the gate then accepts, like any other", async () => {
    const result = await propose(transportOf(async () => ({ text: GOOD_JSON })));
    expect(result.kind).toBe("proposed");
    if (result.kind !== "proposed") return;
    expect(result.mystery.puzzle.roles).toHaveLength(3);
    // The seam is not a bypass: what the model returned is a *proposal*, and
    // it still has to clear the same gate the local proposer's output does.
    expect(gate(result.mystery).accepted).toBe(true);
  });

  it("tolerates the markdown fence models wrap JSON in", async () => {
    const result = await propose(transportOf(async () => ({ text: "```json\n" + GOOD_JSON + "\n```" })));
    expect(result.kind).toBe("proposed");
  });

  it("sends the model id, region and temperature from config, and the grammar as the system turn", async () => {
    let seen: ConverseRequest | null = null;
    await propose(
      transportOf(async (request) => {
        seen = request;
        return { text: GOOD_JSON };
      }),
    );
    expect(seen).not.toBeNull();
    expect(seen!.modelId).toBe("test-model");
    expect(seen!.region).toBe("us-east-1");
    expect(seen!.temperature).toBe(0.7);
    // The bounds the prompt states are the bounds the compiler enforces.
    expect(seen!.system).toContain("at most 4 options");
    expect(seen!.system).toContain("answerToken");
  });
});

describe("every failure comes back as a typed value", () => {
  it("reports malformed JSON when the answer is not JSON at all", async () => {
    const result = await propose(transportOf(async () => ({ text: "I'm sorry, I can't help with that." })));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.kind).toBe("malformed_json");
    expect(result.failure.retryable).toBe(true);
  });

  it("reports a schema violation when the answer is JSON but not a mystery", async () => {
    const result = await propose(transportOf(async () => ({ text: '{"hello":"world"}' })));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    // Distinguished from malformed JSON on purpose: this one is a prompt or
    // model problem, that one is a truncation or transport problem.
    expect(result.failure.kind).toBe("schema_violation");
    expect(result.failure.detail).toContain('"id"');
  });

  it("reports a refusal when the model declines, without treating it as a bug", async () => {
    const result = await propose(
      transportOf(async () => ({ text: "", stopReason: "guardrail_intervened" })),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.kind).toBe("refusal");
    expect(result.failure.detail).toContain("guardrail_intervened");
  });

  it("reports a refusal when the model simply answers with nothing", async () => {
    const result = await propose(transportOf(async () => ({ text: "   " })));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.kind).toBe("refusal");
  });

  it("reports a timeout when the call never answers inside the budget", async () => {
    // The fake transport honours the abort signal the proposer passes it, so
    // this drives the real timeout path rather than a mocked rejection.
    const hanging = transportOf(
      (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const result = await propose(hanging, 25);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.kind).toBe("timeout");
    expect(result.failure.retryable).toBe(true);
  });

  it("reports a timeout even when the transport ignores the abort signal entirely", async () => {
    const stubborn = transportOf(() => new Promise(() => {}));
    const result = await propose(stubborn, 25);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.kind).toBe("timeout");
  });

  it("classifies a thrown transport error rather than propagating it", async () => {
    const cases: [unknown, string][] = [
      [transportError("rate_limited", "slow down"), "rate_limited"],
      [transportError("transport_error", "socket closed"), "transport_error"],
      [new Error("The security token included in the request is expired"), "credentials_missing"],
      [new Error("ThrottlingException: rate exceeded"), "rate_limited"],
      ["a bare string", "transport_error"],
    ];
    for (const [thrown, expected] of cases) {
      const result = await propose(
        transportOf(async () => {
          throw thrown;
        }),
      );
      expect(result.kind, String(thrown)).toBe("failed");
      if (result.kind !== "failed") continue;
      expect(result.failure.kind, String(thrown)).toBe(expected);
      expect(result.failure.detail.length, String(thrown)).toBeGreaterThan(0);
    }
  });

  it("a transport that throws still resolves to a typed failure", async () => {
    const hostile: ConverseTransport = {
      converse: async () => {
        throw new Error("catastrophe");
      },
    };
    await expect(propose(hostile)).resolves.toBeDefined();
  });
});

describe("credentials", () => {
  it("fails as credentials_missing without calling the transport at all", async () => {
    const converse = vi.fn(async () => ({ text: GOOD_JSON }));
    const proposer = new BedrockProposer({
      transport: { converse },
      config: CONFIG,
      hasCredentials: false,
    });
    const result = await proposer.propose({ seed: 7, roles: 3 });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.failure.kind).toBe("credentials_missing");
    expect(result.failure.retryable).toBe(false);
    // Nothing was sent, and nothing was read.
    expect(converse).not.toHaveBeenCalled();
    expect(result.failure.detail).not.toMatch(/AKIA|aws_secret|secret/i);
  });

  it("reads presence, never a value", () => {
    expect(credentialsPresent({})).toBe(false);
    expect(credentialsPresent({ AWS_ACCESS_KEY_ID: "x" })).toBe(false);
    expect(credentialsPresent({ AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" })).toBe(true);
    expect(credentialsPresent({ AWS_PROFILE: "default" })).toBe(true);
  });
});

describe("the SDK is never reached for by importing this module", () => {
  it("builds the real transport without importing anything", () => {
    // The AWS SDK is imported inside `converse`, not at module load. Calling
    // the factory must therefore be inert -- no import, and certainly no
    // network. This is the only test that touches `defaultTransport`, and it
    // deliberately never calls `converse`.
    const transport = defaultTransport();
    expect(typeof transport.converse).toBe("function");
  });
});

describe("config and the prompt", () => {
  it("falls back rather than throwing on nonsense in the environment", () => {
    const config = configFromEnv({
      AWS_REGION: "eu-west-1",
      BEDROCK_MODEL_ID: "some-model",
      BEDROCK_TEMPERATURE: "not-a-number",
      BEDROCK_TIMEOUT_MS: "-5",
    });
    expect(config.region).toBe("eu-west-1");
    expect(config.modelId).toBe("some-model");
    expect(config.temperature).toBe(0.7);
    expect(config.timeoutMs).toBe(30000);
  });

  it("refuses to invent a model id: BEDROCK_MODEL_ID must be set explicitly", () => {
    expect(() => configFromEnv({ AWS_REGION: "eu-west-1" })).toThrow(/BEDROCK_MODEL_ID/);
    expect(() => configFromEnv({})).toThrow(/BEDROCK_MODEL_ID/);
  });

  it("states the seats that were asked for, and no others", () => {
    expect(buildGrammarPrompt({ seed: 1, roles: 2 }).system).toContain('"A", "B"');
    expect(buildGrammarPrompt({ seed: 1, roles: 2 }).system).not.toContain('"A", "B", "C"');
  });

  it("parses a proposal, and refuses a non-object without throwing", () => {
    expect(parseProposal("[1,2,3]").ok).toBe(false);
    expect(parseProposal("null").ok).toBe(false);
    expect(parseProposal("").ok).toBe(false);
    expect(parseProposal("{").ok).toBe(false);
    expect(parseProposal(GOOD_JSON).ok).toBe(true);
  });
});
