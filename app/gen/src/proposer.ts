/**
 * The seam: a proposer proposes, and nothing else.
 *
 * Everything on this side of the seam is allowed to be wrong. A proposer is
 * a *source of candidate JSON*, never an authority: it hands back a
 * `ProposedMystery` in the game's grammar and the gate in `gate.ts` decides
 * whether a player may ever see it. That split is the whole pitch -- "Bedrock
 * proposes puzzles only from a bounded, tested grammar; the compiler proves
 * them" -- so this file deliberately contains no validation, no repair and no
 * "close enough" path. A proposer that cannot answer returns a typed failure.
 *
 * Two implementations live beside this file:
 *
 *   `local.ts`    -- deterministic, seeded, no network. Same seed, same bytes.
 *   `bedrock.ts`  -- Amazon Bedrock's Converse API, behind an injected
 *                    transport so tests never touch the network.
 *
 * `propose` is async because one of the two implementations is a network call,
 * and making the interface sync would force `local.ts`'s shape onto every
 * proposer that ever follows. The determinism `local.ts` promises is about its
 * *output*, not about when the promise settles.
 */
import type { Capability, Puzzle, RoleId } from "../../../validator/src/api.ts";

/** What the caller asks for. Everything else is the proposer's choice. */
export interface ProposeSpec {
  /** Deterministic seed. A proposer that ignores this is not reproducible. */
  seed: number;
  /** How many roles to seat. The wire protocol knows three (`A`, `B`, `C`). */
  roles: number;
}

/**
 * A mystery, as plain JSON in the game's grammar.
 *
 * This is exactly the data a saved catalogue file holds: no functions, no
 * class instances, nothing that would not survive `JSON.stringify`. The
 * catalogue turns it into a `Mystery` by wrapping `puzzle` in a `build()`
 * (see `app/tv/src/game/generated.ts`), which is why this type can stay free
 * of executable parts.
 */
export interface ProposedMystery {
  id: string;
  title: string;
  subtitle: string;
  /** The line the TV opens with, before anyone has done anything. */
  opening: string;
  /** The roles this mystery seats, in the order the lobby should show them. */
  roles: RoleId[];
  /** The input change the mystery's own story is about, for the report. */
  headline: { role: RoleId; capabilities: Capability[] };
  /** The puzzle itself, in the frozen validator's grammar. */
  puzzle: Puzzle;
}

/**
 * Every way a proposer is allowed to fail.
 *
 * The list is closed on purpose: a caller that has to handle "some error" has
 * no way to tell a missing credential (the operator's problem, and fixable)
 * from a refusal (the model's answer, and not a bug). `unknown` exists so a
 * genuinely unexpected transport error still lands as a value rather than an
 * exception, but it is the only member that carries no promise about cause.
 */
export type ProposeFailureKind =
  /** No credentials in the environment. Nothing was sent. */
  | "credentials_missing"
  /** The transport threw, or answered with a transport-level error. */
  | "transport_error"
  /** The call did not answer inside the configured budget. */
  | "timeout"
  /** The model declined to answer. */
  | "refusal"
  /** The answer arrived but was not the JSON envelope we asked for. */
  | "malformed_json"
  /** It was JSON, but it is not a mystery in this grammar. */
  | "schema_violation"
  /** The provider asked us to slow down. */
  | "rate_limited"
  /** Something else, reported rather than thrown. */
  | "unknown";

export interface ProposeFailure {
  kind: ProposeFailureKind;
  /** One line, for the ledger and the operator. Never contains a credential. */
  detail: string;
  /** Whether trying the same spec again could plausibly help. */
  retryable: boolean;
}

export type ProposeResult =
  | { kind: "proposed"; mystery: ProposedMystery }
  | { kind: "failed"; failure: ProposeFailure };

export interface PuzzleProposer {
  /** The name that appears in the run ledger and in the report. */
  readonly name: string;
  propose(spec: ProposeSpec): Promise<ProposeResult>;
}

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

/** The caps the wire protocol knows, in seat order. */
export const SEAT_IDS: readonly RoleId[] = ["A", "B", "C"];

/**
 * The capability each seat gets, mirroring the hand-written catalogue exactly:
 * seat A and seat C drive a d-pad, seat B speaks. The two-player mystery uses
 * the same prefix, so a two-role proposal and the treehouse are comparable.
 *
 * Kept here rather than in a shape so every shape agrees, and so the
 * capability-change story (`changeTarget` in the acceptance table) is the same
 * story for generated content as it is for hand-written content.
 */
export const SEAT_CAPABILITIES: readonly Capability[] = ["dpad", "voice", "dpad"];

export function seatIds(roles: number): RoleId[] {
  return SEAT_IDS.slice(0, roles).map((id) => id);
}

export function seatCapabilities(roles: number): Capability[] {
  return SEAT_CAPABILITIES.slice(0, roles).map((c) => c);
}
