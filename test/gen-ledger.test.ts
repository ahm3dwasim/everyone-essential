/**
 * The rejection ledger: the number that proves the compiler is doing work.
 *
 * A generator with a gate in front of it makes a claim -- "the compiler
 * decides" -- and the only honest evidence for that claim is a count of
 * proposals the compiler actually refused, by the reason it refused them. A
 * run where nothing is ever rejected cannot distinguish a working gate from a
 * decorative one.
 *
 * So this file asserts the *shape* of that evidence and never a magic number:
 * that the corpus is big enough to mean anything, that both outcomes occur,
 * that every refusal carries the validator's own typed reason, and that the
 * reasons span more than one kind of mistake. The exact counts are
 * reproduced by rerunning the generator with its printed seed, and they are
 * allowed to move when the library moves -- what is not allowed to move is
 * that they are counted at all.
 */
import { describe, expect, it } from "vitest";
import { LocalProposer, composeLocal } from "../app/gen/src/local.ts";
import { gate } from "../app/gen/src/gate.ts";
import { runLedger } from "../app/gen/src/generate.ts";
import { auditMystery } from "../app/shared/audit.ts";
import { clonePuzzle } from "../validator/src/api.ts";
import type { ProposedMystery } from "../app/gen/src/proposer.ts";

const COUNT = 60;
const SEATS = [2, 3] as const;

function tableAccepts(proposal: ProposedMystery): boolean {
  return (
    auditMystery({
      id: proposal.id,
      title: proposal.title,
      subtitle: proposal.subtitle,
      roles: proposal.roles as never,
      opening: proposal.opening,
      build: () => clonePuzzle(proposal.puzzle),
      headline: proposal.headline as never,
    }).failures.length === 0
  );
}

describe("a real run of local proposals", { timeout: 60_000 }, () => {
  it(`makes at least 50 proposals across both seat counts and refuses some of them`, async () => {
    const ledger = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, COUNT, [...SEATS]);

    expect(ledger.proposals).toBe(COUNT);
    expect(ledger.proposals).toBeGreaterThanOrEqual(50);
    expect(ledger.seatCounts).toEqual([...SEATS]);
    expect(ledger.accepted).toBeGreaterThan(0);
    expect(ledger.rejected).toBeGreaterThan(0);
    expect(ledger.accepted + ledger.rejected + ledger.proposerFailures).toBe(COUNT);
    // The local proposer composes from a fixed library; it has no way to fail
    // to answer, and if it ever does, that is a change worth noticing.
    expect(ledger.proposerFailures).toBe(0);
  });

  it("refuses for more than one kind of reason, so the ledger says something", async () => {
    const ledger = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, COUNT, [...SEATS]);
    expect(ledger.byReason.length).toBeGreaterThanOrEqual(3);
    // Every row is the validator's own vocabulary, never this repository's
    // prose about it.
    for (const row of ledger.byReason) {
      expect(row.kind.length, row.check).toBeGreaterThan(0);
      expect(row.count).toBeGreaterThan(0);
    }
    // The reasons must add up to the refusals: a ledger that lost a refusal
    // would under-report the gate's work.
    const counted = ledger.byReason.reduce((sum, row) => sum + row.count, 0);
    expect(counted).toBe(ledger.rejected);
  });

  it("gives every refusal a typed reason with prose attached", async () => {
    const ledger = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, COUNT, [...SEATS]);
    for (const record of ledger.records) {
      if (record.outcome !== "rejected") continue;
      expect(record.check, `seed ${record.seed}`).not.toBeNull();
      expect(record.kind, `seed ${record.seed}`).not.toBeNull();
      expect(record.kind, `seed ${record.seed}`).not.toBe("");
      expect(record.reason, `seed ${record.seed}`).toBeTruthy();
      expect(record.proposalId, `seed ${record.seed}`).toBeTruthy();
    }
  });

  it(
    "only accepts what the catalogue's own table also accepts",
    async () => {
      const ledger = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, COUNT, [...SEATS]);
      let checked = 0;
      for (const record of ledger.records) {
        const proposal = composeLocal({
          seed: record.seed,
          roles: ledger.seatCounts[record.attempt % ledger.seatCounts.length]!,
        });
        expect(proposal.id, `seed ${record.seed}`).toBe(record.proposalId);
        expect(gate(proposal).accepted, proposal.id).toBe(tableAccepts(proposal));
        checked += 1;
      }
      expect(checked).toBe(COUNT);
    },
    // This test re-runs the gate (and the table it is checked against) once per record on
    // top of runLedger's own COUNT gate calls -- real puzzle-validator work, not a mock --
    // so it is the most CPU-bound test in this file. Under a heavily loaded machine
    // (measured 7.9s against 5000ms's default budget, oversubscribing this machine's 10
    // cores 4x with busy loops) it is the first to exceed vitest's 5000ms default and fail
    // on contention, not on a hang. 30s leaves comfortable margin above that measurement
    // without weakening what the test asserts.
    30_000,
  );

  it(
    "is reproducible: the same command twice gives the same verdicts",
    async () => {
      const first = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, COUNT, [...SEATS]);
      const second = await runLedger(new LocalProposer(), { seed: 1, roles: 3 }, COUNT, [...SEATS]);
      expect(second.records).toEqual(first.records);
      expect(second.byReason).toEqual(first.byReason);
    },
    // Two full runLedger passes, doubling this file's baseline cost -- measured 6.0s under
    // the same heavy-load condition above. Same reasoning, same margin.
    30_000,
  );
});
