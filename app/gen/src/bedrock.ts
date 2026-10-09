/**
 * The Bedrock proposer: Amazon Bedrock's Converse API, behind an injected
 * transport, with a missing credential as an ordinary typed failure.
 *
 * Three rules shape this file, and each of them is a rule about *this* project
 * rather than about AWS:
 *
 * 1. **No credential is ever needed to run the tests, and none is ever read
 *    here.** The proposer checks only whether credentials are *present* in the
 *    environment; it never reads a value into a string, never logs one and
 *    never puts one in a failure detail. A deployment with no credentials gets
 *    `credentials_missing` before a single byte leaves the process.
 *
 * 2. **Nothing here throws.** Every way this can go wrong is a member of
 *    `ProposeFailureKind`, because the caller is a retry loop that has to
 *    decide whether to try again, and "it threw" gives it nothing to decide
 *    with. The garbage the network hands back -- a truncated envelope, a
 *    refusal, a body that is JSON but not a mystery -- is data, not an
 *    exception.
 *
 * 3. **The network is injected, never reached for.** `ConverseTransport` is one
 *    method wide, so the tests drive a good answer, a malformed one, a refusal
 *    and a timeout without a socket, and the real client is one adapter away.
 *    The default adapter is deliberately the *only* place that would touch the
 *    AWS SDK, and it reaches for it lazily, so importing this module never
 *    pulls an AWS dependency into anything.
 */
import type { Capability, Puzzle, RoleId } from "../../../validator/src/api.ts";
import {
  SEAT_IDS,
  type ProposeFailure,
  type ProposeFailureKind,
  type ProposeResult,
  type ProposeSpec,
  type ProposedMystery,
  type PuzzleProposer,
} from "./proposer.ts";

/* ------------------------------------------------------------------ */
/* The injected transport                                              */
/* ------------------------------------------------------------------ */

export interface ConverseRequest {
  modelId: string;
  region: string;
  temperature: number;
  /** The grammar, as a system instruction. */
  system: string;
  /** The ask, as a user turn. */
  prompt: string;
  timeoutMs: number;
  /** Aborted when the proposer's own budget elapses. */
  signal: AbortSignal;
}

export interface ConverseResponse {
  /** The assistant's text, exactly as it came back. Parsed by the caller. */
  text: string;
  /** Bedrock's stop reason, when it gave one. `"refusal"` and friends. */
  stopReason?: string;
}

export interface ConverseTransport {
  converse(request: ConverseRequest): Promise<ConverseResponse>;
}

/**
 * A transport failure the caller can classify, carried as a *value* a fake
 * transport can reject with.
 *
 * Deliberately a branded plain object rather than an `Error` subclass: the
 * point is that it survives being thrown across a boundary where the class
 * identity might not, and that a test can construct one without importing
 * anything but the type.
 */
export interface BedrockTransportError {
  readonly isBedrockTransportError: true;
  kind: ProposeFailureKind;
  detail: string;
  retryable: boolean;
}

export function transportError(
  kind: ProposeFailureKind,
  detail: string,
  retryable = kind === "timeout" || kind === "transport_error" || kind === "rate_limited",
): BedrockTransportError {
  return { isBedrockTransportError: true, kind, detail, retryable };
}

export function isTransportError(value: unknown): value is BedrockTransportError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as BedrockTransportError).isBedrockTransportError === true
  );
}

/** The stop reasons that mean "the model declined", not "the model answered". */
const REFUSAL_STOP_REASONS: readonly string[] = [
  "guardrail_intervened",
  "content_filtered",
  "refusal",
];

/* ------------------------------------------------------------------ */
/* Config, from the environment and nowhere else                       */
/* ------------------------------------------------------------------ */

export interface BedrockConfig {
  region: string;
  modelId: string;
  temperature: number;
  timeoutMs: number;
}

// No built-in default: a specific model id is an operational choice, not a
// constant this package should ship baked in. `--proposer bedrock` requires
// `BEDROCK_MODEL_ID` to be set explicitly; every other proposer never calls this.
export function configFromEnv(env: Record<string, string | undefined> = process.env): BedrockConfig {
  const modelId = env["BEDROCK_MODEL_ID"];
  if (!modelId) {
    throw new Error(
      "BEDROCK_MODEL_ID is not set. --proposer bedrock needs an explicit model id " +
        "(for example a Bedrock inference profile or on-demand model id); set the " +
        "BEDROCK_MODEL_ID environment variable before running it.",
    );
  }
  const temperature = Number(env["BEDROCK_TEMPERATURE"] ?? "0.7");
  const timeoutMs = Number(env["BEDROCK_TIMEOUT_MS"] ?? "30000");
  return {
    region: env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1",
    modelId,
    // A config that cannot be a temperature is not a temperature; falling back
    // is honest here because the gate judges the *output*, not the dial.
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
  };
}

/**
 * Whether credentials are present. **Presence only** -- this is the whole of
 * this module's contact with a credential, and it never returns or logs a
 * value, only whether there was one.
 */
export function credentialsPresent(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    (env["AWS_ACCESS_KEY_ID"] && env["AWS_SECRET_ACCESS_KEY"]) ||
      env["AWS_PROFILE"] ||
      env["AWS_SESSION_TOKEN"],
  );
}

/* ------------------------------------------------------------------ */
/* The grammar, as a prompt                                             */
/* ------------------------------------------------------------------ */

/**
 * The prompt is built from the grammar rather than written by hand, so the
 * bounds the model is told about are the bounds the compiler enforces. A model
 * told "up to 4 options" and a compiler that rejects 5 is the whole design in
 * one line.
 */
export function buildGrammarPrompt(spec: ProposeSpec): { system: string; prompt: string } {
  const seats = SEAT_IDS.slice(0, Math.max(2, Math.min(3, spec.roles)));
  const system = [
    "You propose one couch co-op mystery as strict JSON. You do not solve it and you do not explain it.",
    "The puzzle is only ever a proposal: a compiler checks it afterwards and will reject it if it is wrong.",
    "",
    "Return a single JSON object and nothing else -- no prose, no markdown fence.",
    "",
    "Shape:",
    "{",
    '  "id": string, "title": string, "subtitle": string, "opening": string,',
    `  "roles": [${seats.map((s) => `"${s}"`).join(", ")}],`,
    '  "headline": { "role": string, "capabilities": ["scan"] },',
    '  "puzzle": {',
    '    "id": string,',
    '    "roles": [ { "id": string, "capabilities": ["dpad"|"scan"|"voice"], "privateTokens": [string] } ],',
    '    "actions": [ {',
    '      "id": string, "performer": string, "needs": "dpad"|"scan"|"voice",',
    '      "requiresTokens": [string], "requiresFlags": [string],',
    '      "producesTokens": [string], "setsFlags": [string],',
    '      "options": integer, "answerToken": string, "label": string',
    "    } ],",
    '    "goalFlags": [string],',
    '    "primitives": [ { "id": string, "capability": string, "maxOptions": integer, "splittable": boolean, "label": string } ]',
    "  }",
    "}",
    "",
    "Rules the compiler enforces, and will reject you for breaking:",
    "1. Role ids are exactly " + seats.map((s) => `"${s}"`).join(", ") + ". The id \"any\" is reserved and must not be used as a role.",
    "2. Every role must be NECESSARY: removing it must make the goal unreachable from the start AND from the middle of the game.",
    "   A role that has finished all its own actions is still necessary if a later action consumes a private token it holds.",
    "3. Every role must be MEANINGFUL: it must perform an action, or hold a private token that some action consumes.",
    "4. A private token is known from the start, while its holder is present, and is gone when they are not.",
    "5. Any action with \"options\" greater than 1 MUST also name \"answerToken\", and that token MUST be in \"requiresTokens\".",
    "6. A \"scan\" action may offer at most 4 options. No exceptions.",
    "7. Every token or flag an action requires must be produced by some action, or be a private token of some role.",
    "8. At least one goalFlag must be set by some action, or the puzzle can never be solved.",
    "9. No two actions may share an id. No id may be empty. No id may begin with the reserved prefix.",
    "",
    "Aim for a puzzle where the roles genuinely depend on one another, and where changing one role's input mode",
    "to one-button switch scanning could still be repaired.",
  ].join("\n");

  const prompt = [
    `Propose one mystery seating ${seats.length} roles (${seats.join(", ")}).`,
    `Use seed ${spec.seed} for your choices, so that the same seed tends to give the same proposal.`,
    "Return only the JSON object.",
  ].join("\n");

  return { system, prompt };
}

/* ------------------------------------------------------------------ */
/* Parsing: total, and never throwing                                  */
/* ------------------------------------------------------------------ */

/**
 * A parse failure says *which* failure it was, because the two mean different
 * things to an operator: `malformed` is "the model did not answer in JSON at
 * all" (often a truncation or a chatty preamble), while a false `malformed` is
 * "it answered in JSON and the JSON is not a mystery" (the prompt or the model
 * needs changing, not the transport). Collapsing them would make the ledger's
 * counts unreadable.
 */
type ParseResult =
  | { ok: true; mystery: ProposedMystery }
  | { ok: false; detail: string; malformed: boolean };

function bad(detail: string): ParseResult {
  return { ok: false, detail, malformed: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const text = str(item);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

/**
 * Turn the model's text into a proposal, or into the reason it is not one.
 *
 * This checks *structure* only. Whether the puzzle means anything -- whether
 * every role is load-bearing, whether the goal is reachable -- is not a
 * question a parser can answer, and answering it here would be a second,
 * weaker gate. The gate in `gate.ts` is the only one.
 */
export function parseProposal(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, detail: "the model returned no text", malformed: true };
  }

  // Models wrap JSON in a fence often enough that refusing it would be
  // pedantry about prose rather than about grammar.
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "")
    : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (error) {
    return {
      ok: false,
      detail: `the answer is not JSON (${error instanceof Error ? error.message : String(error)})`,
      malformed: true,
    };
  }

  if (!isRecord(parsed)) return bad("the answer is not a JSON object");

  const id = str(parsed["id"]);
  const title = str(parsed["title"]);
  const subtitle = str(parsed["subtitle"]);
  const opening = str(parsed["opening"]);
  const roles = strArray(parsed["roles"]);
  if (!id) return bad('missing or empty "id"');
  if (!title) return bad('missing or empty "title"');
  if (!subtitle) return bad('missing or empty "subtitle"');
  if (!opening) return bad('missing or empty "opening"');
  if (!roles) return bad('"roles" must be a list of non-empty strings');

  const headlineRaw = parsed["headline"];
  if (!isRecord(headlineRaw)) return bad('missing "headline"');
  const headlineRole = str(headlineRaw["role"]);
  const headlineCapabilities = strArray(headlineRaw["capabilities"]);
  if (!headlineRole) return bad('missing "headline.role"');
  if (!headlineCapabilities) return bad('"headline.capabilities" must be a list');

  const puzzleRaw = parsed["puzzle"];
  if (!isRecord(puzzleRaw)) return bad('missing "puzzle"');
  if (!str(puzzleRaw["id"])) return bad('missing "puzzle.id"');
  if (!Array.isArray(puzzleRaw["roles"])) return bad('"puzzle.roles" must be a list');
  if (!Array.isArray(puzzleRaw["actions"])) return bad('"puzzle.actions" must be a list');
  if (!Array.isArray(puzzleRaw["goalFlags"])) return bad('"puzzle.goalFlags" must be a list');
  if (!Array.isArray(puzzleRaw["primitives"])) return bad('"puzzle.primitives" must be a list');

  // Past the envelope, the value is handed over as the grammar's own types.
  // `validatePuzzle` is what decides whether these fields are *legal*; the
  // casts below are a promise about the envelope, not about the content.
  return {
    ok: true,
    mystery: {
      id,
      title,
      subtitle,
      opening,
      roles: roles as RoleId[],
      headline: { role: headlineRole as RoleId, capabilities: headlineCapabilities as Capability[] },
      puzzle: puzzleRaw as unknown as Puzzle,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The proposer                                                        */
/* ------------------------------------------------------------------ */

export interface BedrockProposerOptions {
  transport: ConverseTransport;
  config: BedrockConfig;
  /**
   * Whether credentials are present, decided by the caller. Defaults to the
   * environment. Passed in so a test can drive the missing-credential path
   * without touching a process-wide variable.
   */
  hasCredentials?: boolean;
}

export class BedrockProposer implements PuzzleProposer {
  readonly name = "bedrock";
  private readonly transport: ConverseTransport;
  private readonly config: BedrockConfig;
  private readonly hasCredentials: boolean;

  constructor(options: BedrockProposerOptions) {
    this.transport = options.transport;
    this.config = options.config;
    this.hasCredentials = options.hasCredentials ?? credentialsPresent();
  }

  async propose(spec: ProposeSpec): Promise<ProposeResult> {
    if (!this.hasCredentials) {
      // Nothing was sent, and nothing was read.
      return {
        kind: "failed",
        failure: {
          kind: "credentials_missing",
          detail:
            "no AWS credentials are present in the environment, so no Bedrock call was made; the local proposer needs none",
          retryable: false,
        },
      };
    }

    const { system, prompt } = buildGrammarPrompt(spec);
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(transportError("timeout", `the call did not answer within ${this.config.timeoutMs} ms`));
      }, this.config.timeoutMs);
    });

    const call = this.transport.converse({
      modelId: this.config.modelId,
      region: this.config.region,
      temperature: this.config.temperature,
      system,
      prompt,
      timeoutMs: this.config.timeoutMs,
      signal: controller.signal,
    });
    // A transport that loses the race may still reject later. Handling it here
    // is what keeps a slow failure from becoming an unhandled rejection.
    call.catch(() => {});

    let response: ConverseResponse;
    try {
      response = await Promise.race([call, budget]);
    } catch (error) {
      clearTimeout(timer);
      return { kind: "failed", failure: this.classify(error, timedOut) };
    }
    clearTimeout(timer);

    if (response.stopReason && REFUSAL_STOP_REASONS.includes(response.stopReason)) {
      return {
        kind: "failed",
        failure: {
          kind: "refusal",
          detail: `the model declined to answer (stop reason: ${response.stopReason})`,
          retryable: true,
        },
      };
    }

    const parsed = parseProposal(response.text);
    if (!parsed.ok) {
      // Three distinguishable failures, because they have three different
      // fixes. An empty answer is a refusal in all but name. Text that is not
      // JSON at all is a transport or truncation problem. JSON that is not a
      // mystery is a prompt or model problem. All three are values; none is a
      // throw.
      const empty = response.text.trim().length === 0;
      const kind: ProposeFailureKind = empty
        ? "refusal"
        : parsed.malformed
          ? "malformed_json"
          : "schema_violation";
      return { kind: "failed", failure: { kind, detail: parsed.detail, retryable: true } };
    }

    return { kind: "proposed", mystery: parsed.mystery };
  }

  /** Every throw becomes a typed failure. This is the only place that decides how. */
  private classify(error: unknown, timedOut: boolean): ProposeFailure {
    if (isTransportError(error)) {
      return { kind: error.kind, detail: error.detail, retryable: error.retryable };
    }
    if (timedOut) {
      return {
        kind: "timeout",
        detail: `the call did not answer within ${this.config.timeoutMs} ms`,
        retryable: true,
      };
    }
    const name = isRecord(error) && typeof error["name"] === "string" ? error["name"] : "";
    if (name === "AbortError") {
      return { kind: "timeout", detail: "the call was aborted before it answered", retryable: true };
    }
    // A thrown credential error is still a credential error, not a crash. The
    // names below are the ones the AWS SDK and the Bedrock endpoint actually
    // produce; "security token ... is expired" has a space in it, which a
    // naive `expiredtoken` match misses.
    const message = error instanceof Error ? error.message : String(error);
    if (
      /credential|access ?key|secret ?key|signature|security token|expired ?token|token[^.]{0,40}expired|unrecognizedclient|invalidclienttokenid|invalidaccesskeyid/i.test(
        message,
      )
    ) {
      return { kind: "credentials_missing", detail: "the provider rejected the credentials", retryable: false };
    }
    if (/throttl|toomanyrequests|rate/i.test(message)) {
      return { kind: "rate_limited", detail: "the provider asked us to slow down", retryable: true };
    }
    return { kind: "transport_error", detail: `the call failed: ${message}`, retryable: true };
  }
}

/* ------------------------------------------------------------------ */
/* The real transport, lazily                                           */
/* ------------------------------------------------------------------ */

/**
 * The real Converse transport.
 *
 * The AWS SDK is imported *inside* this function and nowhere else, so:
 *
 *   - nothing that merely imports `app/gen` needs the SDK installed, and
 *   - nothing in the TV app can ever reach it -- `app/tv` imports neither this
 *     file nor the SDK, and `npm run sizes` is the proof.
 *
 * If the SDK is not installed the operator gets a typed `transport_error`
 * naming the package, not a module-resolution crash on import.
 */
export function defaultTransport(): ConverseTransport {
  return {
    async converse(request: ConverseRequest): Promise<ConverseResponse> {
      let mod: {
        BedrockRuntimeClient: new (config: { region: string }) => {
          send(command: unknown): Promise<{ output?: { message?: { content?: { text?: string }[] } }; stopReason?: string }>;
        };
        ConverseCommand: new (input: unknown) => unknown;
      };
      try {
        const name = "@aws-sdk/client-bedrock-runtime";
        mod = (await import(/* @vite-ignore */ name)) as unknown as typeof mod;
      } catch {
        throw transportError(
          "transport_error",
          "the AWS SDK is not installed; run `npm install @aws-sdk/client-bedrock-runtime` in app/gen to use --proposer bedrock",
          false,
        );
      }
      const client = new mod.BedrockRuntimeClient({ region: request.region });
      try {
        const response = await client.send(
          new mod.ConverseCommand({
            modelId: request.modelId,
            temperature: request.temperature,
            system: [{ text: request.system }],
            messages: [{ role: "user", content: [{ text: request.prompt }] }],
          }),
        );
        const text = (response.output?.message?.content ?? [])
          .map((part) => part.text ?? "")
          .join("");
        return { text, stopReason: response.stopReason };
      } catch (error) {
        throw transportError(
          "transport_error",
          `the Bedrock call failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
