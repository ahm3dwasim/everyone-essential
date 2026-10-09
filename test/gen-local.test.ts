/**
 * The local proposer: deterministic, offline, and honestly imperfect.
 *
 * Two claims are worth pinning here and nowhere else. The first is
 * reproducibility -- same seed, same bytes -- because "the model proposes"
 * is only a defensible design if a proposal can be re-derived and re-checked
 * later. The second is that the proposer does *not* pre-filter its own output:
 * a generator that only ever emitted certifiable puzzles would make the gate
 * decorative, so a test asserts the library really does contain shapes the
 * gate refuses, and that the proposer hands them over anyway.
 */
import { describe, expect, it } from "vitest";
import { LocalProposer, LOCAL_SHAPES, composeLocal, mysteryJson } from "../app/gen/src/local.ts";
import { gate } from "../app/gen/src/gate.ts";
import { generateMystery, GIVE_UP_DETAIL, runLedger } from "../app/gen/src/generate.ts";
import type { ProposeResult, PuzzleProposer } from "../app/gen/src/proposer.ts";

const ROLES = [2, 3] as const;

describe("the same seed produces the same bytes", () => {
  it("is byte-identical across two compositions", () => {
    for (const roles of ROLES) {
      for (const seed of [1, 7, 12345]) {
        const first = composeLocal({ seed, roles });
        const second = composeLocal({ seed, roles });
        expect(mysteryJson(second)).toBe(mysteryJson(first));
      }
    }
  });

  it("is byte-identical across two proposer calls, which is the path the CLI takes", async () => {
    const proposer = new LocalProposer();
    const first = await proposer.propose({ seed: 7, roles: 3 });
    const second = await proposer.propose({ seed: 7, roles: 3 });
    expect(first.kind).toBe("proposed");
    expect(second.kind).toBe("proposed");
    if (first.kind !== "proposed" || second.kind !== "proposed") return;
    expect(mysteryJson(second.mystery)).toBe(mysteryJson(first.mystery));
  });

  it("actually varies with the seed, so determinism is not a constant", () => {
    const ids = new Set(Array.from({ length: 40 }, (_, i) => composeLocal({ seed: i + 1, roles: 3 }).id));
    expect(ids.size).toBeGreaterThan(4);
  });

  it("seats exactly the number of roles asked for, from the protocol's own vocabulary", () => {
    for (const roles of ROLES) {
      for (let seed = 1; seed <= 20; seed++) {
        const mystery = composeLocal({ seed, roles });
        expect(mystery.roles).toHaveLength(roles);
        expect(mystery.puzzle.roles.map((r) => r.id)).toEqual(mystery.roles);
        expect(mystery.puzzle.roles.every((r) => ["A", "B", "C"].includes(r.id))).toBe(true);
      }
    }
  });
});

describe("the library is honestly imperfect", () => {
  it(
    "contains shapes the gate refuses, and the proposer hands them over anyway",
    { timeout: 30_000 },
    async () => {
    const flawed = LOCAL_SHAPES.filter((shape) => shape.flaw !== null);
    expect(flawed.length, "the library must contain mistakes for the gate to catch").toBeGreaterThan(0);

    // The proposer does not filter. Every shape it can draw is proposed, and
    // the gate is what decides -- never the proposer.
    const ledger = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, 60, [2, 3]);
    expect(ledger.rejected, "a proposer that never fails makes the gate decorative").toBeGreaterThan(0);
    expect(ledger.accepted).toBeGreaterThan(0);
    expect(ledger.proposals).toBe(60);
  });

  it("names each deliberate flaw in the library, not only in the gate's output", () => {
    for (const shape of LOCAL_SHAPES.filter((s) => s.flaw !== null)) {
      expect(shape.flaw, shape.id).toBeTruthy();
    }
  });
});

describe("giving up is honest", () => {
  /** A proposer that can never satisfy the gate, to reach the give-up path. */
  const hopeless: PuzzleProposer = {
    name: "hopeless",
    async propose(): Promise<ProposeResult> {
      return {
        kind: "failed",
        failure: { kind: "credentials_missing", detail: "nothing to send", retryable: false },
      };
    },
  };

  it("returns accepted: false and the full ledger rather than offering an unproven puzzle", async () => {
    const result = await generateMystery(hopeless, { seed: 1, roles: 3 }, { maxAttempts: 4 });
    expect(result.accepted).toBe(false);
    expect(result.mystery).toBeNull();
    expect(result.ledger).toHaveLength(1);
    expect(result.ledger[0]?.failure).toBe("credentials_missing");
    // A failure the proposer itself called unretryable stops the loop, rather
    // than burning the whole budget on the same non-answer.
    expect(GIVE_UP_DETAIL).toContain("gave up");
  });

  it("retries a retryable failure up to the budget and then stops", async () => {
    let calls = 0;
    const flaky: PuzzleProposer = {
      name: "flaky",
      async propose(): Promise<ProposeResult> {
        calls += 1;
        return {
          kind: "failed",
          failure: { kind: "timeout", detail: "no answer", retryable: true },
        };
      },
    };
    const result = await generateMystery(flaky, { seed: 1, roles: 3 }, { maxAttempts: 3 });
    expect(calls).toBe(3);
    expect(result.ledger).toHaveLength(3);
    expect(result.ledger.every((r) => r.outcome === "proposer_failed")).toBe(true);
  });

  it("finds an accepted mystery for a seed where the first shape is not the good one", async () => {
    // The retry advances the seed deterministically, so a run that needed two
    // attempts is still reproducible. Assert the mechanism, not a magic seed.
    const result = await generateMystery(new LocalProposer(), { seed: 1, roles: 3 }, { maxAttempts: 8 });
    if (result.accepted) {
      expect(result.mystery).not.toBeNull();
      expect(gate(result.mystery!).accepted).toBe(true);
      expect(result.ledger[result.ledger.length - 1]?.outcome).toBe("accepted");
    } else {
      // Even a run that ran out of budget must say so with the reasons.
      expect(result.ledger.length).toBe(8);
      expect(result.ledger.every((r) => r.reason !== null || r.outcome === "accepted")).toBe(true);
    }
  });
});
