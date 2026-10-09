/**
 * The run: propose, gate, retry a bounded number of times, then give up
 * honestly.
 *
 * The retry loop is deliberately the *only* thing here that decides to try
 * again, and the gate is the only thing that decides whether an attempt was
 * any good. Nothing in this file inspects a puzzle. If it did -- if it
 * "helped" by nudging a proposal towards acceptance -- the rejection ledger
 * would stop being a measurement of the generator and start being a
 * measurement of the helper.
 *
 * Retrying advances the seed deterministically (`spec.seed + attempt`), so a
 * run is reproducible end to end: the same spec produces the same sequence of
 * proposals, the same rejections, and the same accepted mystery.
 */
import { gate, type GateCheckName, type GateVerdict } from "./gate.ts";
import type {
  ProposeFailureKind,
  ProposeSpec,
  ProposedMystery,
  PuzzleProposer,
} from "./proposer.ts";

/** One proposal, and what became of it. */
export interface RunRecord {
  attempt: number;
  /** The seed this attempt was made with. */
  seed: number;
  outcome: "accepted" | "rejected" | "proposer_failed";
  /** The proposal's id, when the proposer produced one. */
  proposalId: string | null;
  /** The gate's first failing check, when the gate saw it. */
  check: GateCheckName | null;
  /** The validator's typed kind, when it named one. */
  kind: string | null;
  /** One line of prose, for a human reading the ledger. */
  reason: string | null;
  /** The proposer's typed failure kind, when the proposer failed. */
  failure: ProposeFailureKind | null;
}

export interface GenerateOptions {
  /** How many proposals to make before giving up. Defaults to 8. */
  maxAttempts?: number;
}

export interface GenerateResult {
  accepted: boolean;
  /** The mystery that cleared the gate, or `null` if none did. */
  mystery: ProposedMystery | null;
  /** The verdict it cleared, or the last refusal if none did. */
  verdict: GateVerdict | null;
  /** Every attempt, in order. This is the evidence. */
  ledger: RunRecord[];
}

const DEFAULT_MAX_ATTEMPTS = 8;

export const GIVE_UP_DETAIL =
  "no proposal cleared the gate within the attempt budget; the generator gave up rather than offering an unproven puzzle";

/**
 * Propose until something clears the gate, or the budget runs out.
 *
 * "Gives up honestly" is a real requirement, not a figure of speech: the
 * result says `accepted: false` and carries the full ledger of why, so a
 * caller can never mistake exhaustion for success.
 */
export async function generateMystery(
  proposer: PuzzleProposer,
  spec: ProposeSpec,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const ledger: RunRecord[] = [];
  let lastVerdict: GateVerdict | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seed = spec.seed + attempt;
    const result = await proposer.propose({ ...spec, seed });

    if (result.kind === "failed") {
      ledger.push({
        attempt,
        seed,
        outcome: "proposer_failed",
        proposalId: null,
        check: null,
        kind: null,
        reason: result.failure.detail,
        failure: result.failure.kind,
      });
      // A proposer that cannot answer will not answer differently on the same
      // spec unless the spec changes, and here the spec barely does. Only a
      // failure the proposer itself called retryable is worth another attempt.
      if (!result.failure.retryable) break;
      continue;
    }

    const verdict = gate(result.mystery);
    lastVerdict = verdict;
    if (verdict.accepted) {
      ledger.push({
        attempt,
        seed,
        outcome: "accepted",
        proposalId: result.mystery.id,
        check: null,
        kind: null,
        reason: null,
        failure: null,
      });
      return { accepted: true, mystery: result.mystery, verdict, ledger };
    }

    ledger.push({
      attempt,
      seed,
      outcome: "rejected",
      proposalId: result.mystery.id,
      check: verdict.rejection?.check ?? null,
      kind: verdict.rejection?.kind ?? null,
      reason: verdict.rejection?.reason ?? null,
      failure: null,
    });
  }

  return { accepted: false, mystery: null, verdict: lastVerdict, ledger };
}

/* ------------------------------------------------------------------ */
/* The rejection ledger                                                */
/* ------------------------------------------------------------------ */

export interface LedgerRow {
  check: GateCheckName | "proposer";
  kind: string;
  count: number;
}

export interface Ledger {
  proposer: string;
  /** How many proposals were made, across every seat count. */
  proposals: number;
  accepted: number;
  rejected: number;
  proposerFailures: number;
  /** Rejections by the validator's own typed reason, most frequent first. */
  byReason: LedgerRow[];
  /** The seed range the run covered, so it can be reproduced exactly. */
  seeds: { from: number; to: number };
  seatCounts: number[];
  records: RunRecord[];
}

/**
 * Count a batch of proposals without retrying any of them.
 *
 * This is the measurement the design asks for: *of the proposals a generator
 * actually made, how many were wrong, and what kind of wrong*. A run that
 * retried first would report how often the generator got lucky, which is a
 * different and much less interesting number.
 */
export async function runLedger(
  proposer: PuzzleProposer,
  spec: ProposeSpec,
  count: number,
  seatCounts: readonly number[] = [spec.roles],
): Promise<Ledger> {
  const records: RunRecord[] = [];
  const tally = new Map<string, LedgerRow>();
  let accepted = 0;
  let proposerFailures = 0;

  for (let index = 0; index < count; index++) {
    const roles = seatCounts[index % seatCounts.length]!;
    const seed = spec.seed + index;
    const result = await proposer.propose({ seed, roles });

    if (result.kind === "failed") {
      proposerFailures += 1;
      records.push({
        attempt: index,
        seed,
        outcome: "proposer_failed",
        proposalId: null,
        check: null,
        kind: null,
        reason: result.failure.detail,
        failure: result.failure.kind,
      });
      const key = `proposer\u0000${result.failure.kind}`;
      const row = tally.get(key) ?? { check: "proposer" as const, kind: result.failure.kind, count: 0 };
      row.count += 1;
      tally.set(key, row);
      continue;
    }

    const verdict = gate(result.mystery);
    if (verdict.accepted) {
      accepted += 1;
      records.push({
        attempt: index,
        seed,
        outcome: "accepted",
        proposalId: result.mystery.id,
        check: null,
        kind: null,
        reason: null,
        failure: null,
      });
      continue;
    }

    const check = verdict.rejection?.check ?? "well_formed";
    const kind = verdict.rejection?.kind ?? "unnamed";
    records.push({
      attempt: index,
      seed,
      outcome: "rejected",
      proposalId: result.mystery.id,
      check,
      kind,
      reason: verdict.rejection?.reason ?? null,
      failure: null,
    });
    const key = `${check}\u0000${kind}`;
    const row = tally.get(key) ?? { check, kind, count: 0 };
    row.count += 1;
    tally.set(key, row);
  }

  return {
    proposer: proposer.name,
    proposals: count,
    accepted,
    rejected: count - accepted - proposerFailures,
    proposerFailures,
    byReason: [...tally.values()].sort((x, y) => y.count - x.count || x.kind.localeCompare(y.kind)),
    seeds: { from: spec.seed, to: spec.seed + count - 1 },
    seatCounts: [...seatCounts],
    records,
  };
}
