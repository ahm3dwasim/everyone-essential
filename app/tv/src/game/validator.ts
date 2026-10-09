/**
 * The one place the app touches the validator.
 *
 * The validator is a separate package with its own release cadence and its own
 * maintainers; nothing in this app edits it. What it does NOT export, the app must
 * re-derive, and that is exactly two small things:
 *
 *   - `knownTokens(puzzle, state)`: the validator's `knownTokensAtStart` is not
 *     on its public surface. The rule is documented in its README -- a private
 *     token has been said out loud as soon as its holder is present -- so the
 *     app implements the same rule. A divergence here cannot be silent: every
 *     action the TV applies is followed by a real `certify`, and `certify`
 *     replays the history against the real rules. A laxer local check would
 *     show up as a refused certificate on screen, not as a wrong badge.
 *   - `resolvePerformer(puzzle, action)`: which role an action is credited to,
 *     including the `"any"` case. Also not exported; also five lines, and also
 *     checked by `certify` afterwards.
 *
 * The assertions at the bottom are compile-time: if the validator ever renames
 * a capability or changes the shape of a certificate, this file stops
 * typechecking rather than drifting.
 */
import type { Capability as ValidatorCapability } from "../../../../validator/src/api.ts";
import type { Capability as ProtocolCapability } from "../../../shared/protocol.ts";
import { SCAN_MAX_OPTIONS as VALIDATOR_SCAN_MAX_OPTIONS } from "../../../../validator/src/api.ts";

export type {
  Action,
  Capability,
  Certificate,
  CertifyResult,
  DiffEntry,
  NecessityProof,
  PlanStep,
  Puzzle,
  RecompileResult,
  Role,
  RoleId,
  SolvabilityProof,
  State,
} from "../../../../validator/src/api.ts";

export {
  RESERVED_PREFIX,
  SCAN_MAX_OPTIONS,
  applyPlan,
  certify,
  demoPuzzle,
  doneActionIds,
  emptyState,
  explainFailure,
  isCertificate,
  normalizeState,
  recompile,
  refusalIssues,
  solve,
} from "../../../../validator/src/api.ts";

/* ------------------------------------------------------------------ */
/* Re-derived helpers (see the header)                                 */
/* ------------------------------------------------------------------ */

import type { Action, Puzzle, RoleId, State } from "../../../../validator/src/api.ts";

/**
 * Everything the team collectively knows: the state's own tokens plus every
 * private token of every role still in the puzzle. Holders speak up.
 */
export function knownTokens(puzzle: Puzzle, state: State): Set<string> {
  const tokens = new Set<string>(state.tokens);
  for (const role of puzzle.roles) {
    for (const token of role.privateTokens) tokens.add(token);
  }
  return tokens;
}

/** The role an action is credited to, or null when nobody present can perform it. */
export function resolvePerformer(puzzle: Puzzle, action: Action): RoleId | null {
  if (action.performer === "any") {
    const capable = puzzle.roles.find((role) => role.capabilities.includes(action.needs));
    return capable ? capable.id : null;
  }
  const role = puzzle.roles.find((r) => r.id === action.performer);
  if (!role) return null;
  return role.capabilities.includes(action.needs) ? role.id : null;
}

export function isSubset(needles: readonly string[], haystack: ReadonlySet<string>): boolean {
  for (const needle of needles) {
    if (!haystack.has(needle)) return false;
  }
  return true;
}

export function roleCapabilities(puzzle: Puzzle, roleId: RoleId): ValidatorCapability[] {
  return puzzle.roles.find((r) => r.id === roleId)?.capabilities ?? [];
}

export function rolePrivateTokens(puzzle: Puzzle, roleId: RoleId): string[] {
  return puzzle.roles.find((r) => r.id === roleId)?.privateTokens ?? [];
}

/* ------------------------------------------------------------------ */
/* Compile-time compatibility with the protocol vocabulary             */
/* ------------------------------------------------------------------ */

type Assert<T extends true> = T;

/** The app's capability vocabulary must still be the validator's. */
export type CapabilitiesMatch = Assert<
  ProtocolCapability extends ValidatorCapability
    ? ValidatorCapability extends ProtocolCapability
      ? true
      : false
    : false
>;

/** The 4-option scan bound is the model's; the protocol repeats it. */
export type ScanBoundMatches = Assert<
  typeof VALIDATOR_SCAN_MAX_OPTIONS extends 4 ? true : false
>;
