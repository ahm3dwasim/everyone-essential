/**
 * The acceptance gate: what it checks, and the proof that it is the same bar
 * the hand-written catalogue clears.
 *
 * Two things are worth testing about a gate and this file does both. The first
 * is that each claim is *separately* reported, because "which claim failed" is
 * the number the rejection ledger exists to produce. The second, and the more
 * important one, is that the gate cannot quietly become laxer than the
 * catalogue's table: `auditMystery` in `app/shared/audit.ts` is the same
 * function `test/mysteries.test.ts` holds the hand-written three to, and the
 * agreement test below runs both over the catalogue, over the crafted
 * boundary cases and over a seeded corpus of proposals. If the gate ever
 * accepts something the table rejects, or the reverse, that test is what goes
 * red -- which is what makes the mutation control at the bottom meaningful
 * rather than theatrical.
 */
import { describe, expect, it } from "vitest";
import { auditMystery } from "../app/shared/audit.ts";
import { MYSTERIES } from "../app/tv/src/game/mysteries.ts";
import { GATE_CHECKS, gate, gatePuzzle, type GateCheckName } from "../app/gen/src/gate.ts";
import { LocalProposer, composeFromShape, composeLocal } from "../app/gen/src/local.ts";
import { runLedger } from "../app/gen/src/generate.ts";
import { clonePuzzle } from "../validator/src/api.ts";
import type { ProposedMystery } from "../app/gen/src/proposer.ts";

/** The gate's verdict reduced to the names of the claims that failed. */
function failedChecks(verdict: ReturnType<typeof gate>): GateCheckName[] {
  return verdict.checks.filter((c) => !c.ok).map((c) => c.name);
}

/** A proposal in the shape `auditMystery` wants, so the two can be compared. */
function asMystery(proposal: ProposedMystery) {
  return {
    id: proposal.id,
    title: proposal.title,
    subtitle: proposal.subtitle,
    roles: proposal.roles as never,
    opening: proposal.opening,
    build: () => clonePuzzle(proposal.puzzle),
    headline: proposal.headline as never,
  };
}

/** Does the catalogue's own table accept this proposal? */
function tableAccepts(proposal: ProposedMystery): boolean {
  return auditMystery(asMystery(proposal)).failures.length === 0;
}

describe("the gate reports every claim separately", () => {
  it("runs exactly the checks it declares, in order, whatever the verdict", () => {
    const verdict = gate(composeFromShape({ seed: 7, roles: 3 }, "braid"));
    expect(verdict.checks.map((c) => c.name)).toEqual([...GATE_CHECKS]);
  });

  it("accepts a sound proposal and rejects nothing about it", () => {
    for (const shape of ["braid", "keystone"]) {
      const roles = shape === "keystone" ? 3 : 3;
      const verdict = gate(composeFromShape({ seed: 7, roles }, shape));
      expect(failedChecks(verdict), shape).toEqual([]);
      expect(verdict.accepted, shape).toBe(true);
      expect(verdict.rejection, shape).toBeNull();
      expect(verdict.certificate?.ok, shape).toBe(true);
      expect(verdict.probes, shape).toBeGreaterThan(1);
    }
  });

  it("names the validator's typed kind, not just prose, for every rejection family", () => {
    const families: { shape: string; check: GateCheckName; kind: string }[] = [
      { shape: "spare-clue", check: "every_role_necessary", kind: "decorative_role" },
      { shape: "answerless-choice", check: "well_formed", kind: "missing_answer_token" },
      { shape: "open-goal", check: "solvable", kind: "unsolvable" },
      { shape: "wrong-capability", check: "accessible", kind: "no_eligible_performer" },
    ];
    for (const family of families) {
      const verdict = gate(composeFromShape({ seed: 3, roles: 3 }, family.shape));
      expect(verdict.accepted, family.shape).toBe(false);
      expect(verdict.rejection?.check, family.shape).toBe(family.check);
      expect(verdict.rejection?.kind, family.shape).toBe(family.kind);
      expect(verdict.rejection?.reason.length, family.shape).toBeGreaterThan(0);
    }
  });

  it("rejects a proposal whose declared roles disagree with the puzzle it carries", () => {
    const sound = composeFromShape({ seed: 7, roles: 3 }, "braid");
    const lying: ProposedMystery = { ...sound, roles: ["A", "B"] };
    const verdict = gate(lying);
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejection?.check).toBe("roles_are_seatable");
  });
});

/* ------------------------------------------------------------------ */
/* The gate is the catalogue's bar, not a weaker one                   */
/* ------------------------------------------------------------------ */

describe("the gate agrees with the table the hand-written mysteries are held to", { timeout: 60_000 }, () => {
  it("agrees on every mystery already in the catalogue", () => {
    for (const mystery of MYSTERIES) {
      const proposal: ProposedMystery = {
        id: mystery.id,
        title: mystery.title,
        subtitle: mystery.subtitle,
        opening: mystery.opening,
        roles: [...mystery.roles],
        headline: { role: mystery.headline.role, capabilities: [...mystery.headline.capabilities] },
        puzzle: mystery.build(),
      };
      const verdict = gate(proposal);
      expect(verdict.accepted, `${mystery.id}`).toBe(tableAccepts(proposal));
      expect(verdict.accepted, `${mystery.id} must clear its own catalogue's bar`).toBe(true);
    }
  });

  it(
    "agrees on a seeded corpus of proposals, accepted and rejected alike",
    async () => {
      let compared = 0;
      let accepted = 0;
      let rejected = 0;

      for (const roles of [2, 3]) {
        for (let seed = 1; seed <= 40; seed++) {
          const proposal = composeLocal({ seed, roles });
          const verdict = gate(proposal);
          compared += 1;
          if (verdict.accepted) accepted += 1;
          else rejected += 1;
          expect(verdict.accepted, `${proposal.id}`).toBe(tableAccepts(proposal));
        }
      }

      // A corpus that was all one outcome would make the agreement vacuous.
      expect(compared).toBe(80);
      expect(accepted).toBeGreaterThan(0);
      expect(rejected).toBeGreaterThan(0);
    },
    // This loop is synchronous CPU work, not I/O -- alone it finishes in
    // under 3s, but the full suite runs it at the same time as the wider
    // seat fuzz's 150,000-step loop on this machine's other CPU core, and
    // contention between the two has pushed it past the 5s default. The
    // extra budget covers scheduling variance, not a slower test.
    20_000,
  );

  it(
    "agrees on the whole ledger run, which is the corpus the report quotes",
    async () => {
      const ledger = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, 60, [2, 3]);
      let accepted = 0;
      for (const record of ledger.records) {
        if (record.outcome !== "accepted" && record.outcome !== "rejected") continue;
        const proposal = composeLocal({ seed: record.seed, roles: ledger.seatCounts[record.attempt % ledger.seatCounts.length]! });
        expect(proposal.id, `seed ${record.seed}`).toBe(record.proposalId);
        const verdict = gate(proposal);
        expect(verdict.accepted, `${proposal.id}`).toBe(tableAccepts(proposal));
        if (verdict.accepted) accepted += 1;
      }
      expect(accepted).toBe(ledger.accepted);
    },
    // Same CPU-contention reasoning as the corpus test above.
    20_000,
  );
});

/* ------------------------------------------------------------------ */
/* Mutation control: disable the necessity check, and this goes red     */
/* ------------------------------------------------------------------ */

/**
 * The fixture the mutation control is built on.
 *
 * `spare-clue` is the one shape in the library that fails *only* necessity:
 * its second seat holds a clue the ending consumes (so it is meaningful), and
 * cutting that seat out still leaves a longer route to the goal (so it is not
 * necessary). That is the boundary case, and it is why this shape and not
 * another is the fixture -- a proposal that failed two claims at once would
 * stay rejected after either one was disabled, and would prove nothing.
 *
 * The mutation itself is applied by hand in `app/gen/src/gate.ts`: make
 * `every_role_necessary` report `ok` unconditionally, run the named test
 * below, and confirm it fails, then restore it. This describe block is what
 * makes that a *control* rather than an anecdote: it asserts the
 * precondition (one failing check) and the
 * consequence (that check is the only thing standing between the proposal and
 * acceptance).
 */
describe("mutation control: the gate can go red on necessity alone", () => {
  const proposal = composeFromShape({ seed: 3, roles: 2 }, "spare-clue");

  it("the fixture fails necessity and nothing else", () => {
    const verdict = gate(proposal);
    expect(verdict.accepted).toBe(false);
    expect(failedChecks(verdict)).toEqual(["every_role_necessary"]);
    expect(verdict.rejection?.kind).toBe("decorative_role");
    // The roles that *are* necessary are proven so -- the failure is specific,
    // not a blanket refusal.
    const necessity = verdict.checks.find((c) => c.name === "every_role_necessary");
    expect(necessity?.reason).toMatch(/is decorative/);
  });

  it("is rejected by the catalogue's own table too, for the same reason", () => {
    const audit = auditMystery(asMystery(proposal));
    expect(audit.failures.length).toBeGreaterThan(0);
    expect(audit.failures.join("\n")).toMatch(/is decorative/);
    expect(audit.failures.join("\n")).toMatch(/goal still reachable without/);
  });

  it("is the named test the mutation control turns red", () => {
    // This is the assertion that flips when `every_role_necessary` is disabled
    // in the gate: with the check neutered, `failedChecks` becomes empty and
    // `accepted` becomes true, so this test fails on its first line. Nothing
    // else in this file depends on the necessity claim for this proposal,
    // which is what makes the red unambiguous.
    expect(gate(proposal).accepted).toBe(false);
    expect(failedChecks(gate(proposal))).toEqual(["every_role_necessary"]);
  });

  it("restores: the real catalogue still clears the bar through the same gate", () => {
    for (const mystery of MYSTERIES) {
      expect(gatePuzzle(mystery.build()).accepted, mystery.id).toBe(true);
    }
    expect(gate(composeFromShape({ seed: 7, roles: 3 }, "braid")).accepted).toBe(true);
  });
});
