/**
 * The certificate: the whole point of this package.
 *
 * `certify(puzzle, state)` either returns a certificate with `ok === true`, in
 * which case the puzzle is provably solvable from `state` AND every role is
 * provably necessary, or it returns `ok === false` with the reason spelled out.
 * There is no middle ground and no partial credit.
 *
 * "Necessary" is a counterfactual, not a heuristic: remove the role -- its
 * private tokens and its ability to perform anything -- and the solver must
 * come back UNSOLVABLE. A role that a witness plan merely *mentions* is not
 * enough; a role that is only decorative fails here.
 */
import {
  type ActionId,
  type Capability,
  type Puzzle,
  type RoleId,
  type State,
  doneActionIds,
  normalizeState,
  optionField,
  puzzleKey,
  removeRole,
  roleHas,
} from "./model";
import { canonicalStringify, stableHash } from "./hash";
import { type PlanStep, type SolveOptions, solve } from "./solve";
import {
  type ValidationError,
  type ValidationIssue,
  validatePuzzle,
  validateState,
  validationError,
} from "./validate";

export interface NecessityProof {
  role: RoleId;
  /** Removing this role makes the goal unreachable. */
  necessary: boolean;
  /**
   * The unsolvability search finished rather than hitting the state cap.
   * A truncated search proves nothing, so `necessary` is false when this is false.
   */
  proven: boolean;
  statesExplored: number;
  truncated: boolean;
  reason: string;
}

export type AccessibilityViolationKind =
  | "no_eligible_performer"
  | "scan_too_many_options"
  | "choice_without_answer"
  | "empty_action_pool";

export interface AccessibilityViolation {
  kind: AccessibilityViolationKind;
  action: ActionId | null;
  detail: string;
}

export interface MeaningfulnessProof {
  role: RoleId;
  meaningful: boolean;
  reason: string;
}

export interface SolvabilityProof {
  ok: boolean;
  /** The search finished; `ok === false` with `proven === true` is a real refutation. */
  proven: boolean;
  statesExplored: number;
  truncated: boolean;
  plan: PlanStep[];
}

export interface Certificate {
  puzzleId: string;
  /**
   * Canonical identity of the WHOLE puzzle this certificate is about, not just
   * its id. Two puzzles that share an id but differ in any action, role,
   * primitive or goal get different keys, and therefore different hashes.
   */
  puzzleKey: string;
  /** The exact state this certificate is about, normalised. */
  fromState: State;
  solvable: SolvabilityProof;
  /** Keyed by role id. A missing role means the role is not in the puzzle. */
  necessity: Record<RoleId, NecessityProof>;
  accessibility: { ok: boolean; violations: AccessibilityViolation[] };
  meaningful: Record<RoleId, MeaningfulnessProof>;
  /** True only when every check above passed. */
  ok: boolean;
  /** Short, stable, non-cryptographic digest of everything above. */
  hash: string;
}

export interface CertifyOptions extends SolveOptions {
  /** State cap for each counterfactual search. Defaults to `maxStates`. */
  maxCounterfactualStates?: number;
}

/** Hard limit baked into the model: a `scan` choice may offer no more than 4 alternatives. */
export const SCAN_MAX_OPTIONS = 4;

/**
 * The result of asking for a certificate: either a certificate, or a typed
 * refusal because the input is not a puzzle this compiler can speak about.
 */
export type CertifyResult = Certificate | ValidationError;

export function isCertificate(result: CertifyResult): result is Certificate {
  return (result as Certificate).hash !== undefined;
}

/**
 * Certify a puzzle from a state.
 *
 * Validation runs FIRST and is not optional: a value that is not an object, or
 * an object with a missing or mistyped field, comes back as a typed error
 * rather than a certificate, and so does a state that could not have been
 * reached. An object whose property reads throw (a revoked `Proxy`, a throwing
 * getter) passes that throw on. Without this gate a puzzle whose
 * only role is named `"any"` certifies happily, because the reserved sentinel
 * is then documented but never enforced.
 *
 * There is exactly one certification function, deliberately. Splitting the
 * recompiler's own candidates onto a second, weaker-gated entry point would
 * make that entry point a plain export, reachable by any caller with no
 * restriction at all. The reserved namespace has no disable flag:
 * `validatePuzzle` accepts a `§`-prefixed id only in the exact shape the
 * generator emits (a complete, consecutive split-chain step or its progress
 * token, wired exactly as `convertAction` wires it), so a repaired puzzle's
 * ids are ordinary, verifiable input and `recompile.ts` certifies its own
 * candidates through this same function.
 */
export function certify(puzzle: Puzzle, state: State, options: CertifyOptions = {}): CertifyResult {
  const refusal = validate(puzzle, state);
  if (refusal) return refusal;
  return buildCertificate(puzzle, state, options);
}

/**
 * The certification itself, past the gate. **Module-private, and it must stay
 * that way.**
 *
 * Exporting this as `certifyUnchecked` and re-exporting it from `api.ts`,
 * with a comment saying every other caller must use `certify`, is not enough:
 * from the public surface it certifies a puzzle whose only role is literally
 * named `"any"` -- the reserved sentinel -- and returns `ok: true`. An exported name is not an
 * access-control boundary; the module is: nothing outside this file can
 * reach a certificate without passing `certify` first, and `certify` always
 * validates.
 */
function buildCertificate(
  puzzle: Puzzle,
  state: State,
  options: CertifyOptions = {},
): Certificate {
  const fromState = normalizeState(state);

  const solvableResult = solve(puzzle, fromState, options);
  const solvable: SolvabilityProof = {
    ok: solvableResult.status === "solvable",
    // `invalid_options` means the search never ran at all -- neither solved nor
    // proven unsolvable -- so it must not fall into "proven" just because
    // nothing was truncated either.
    proven:
      solvableResult.status !== "invalid_options" &&
      (solvableResult.status === "solvable" || !solvableResult.truncated),
    statesExplored: solvableResult.statesExplored,
    truncated: solvableResult.truncated,
    plan: solvableResult.plan,
  };

  const necessity: Record<RoleId, NecessityProof> = {};
  for (const role of puzzle.roles) {
    necessity[role.id] = proveNecessity(puzzle, fromState, role.id, options);
  }

  const accessibility = checkAccessibility(puzzle, fromState);
  const meaningful = checkMeaningfulness(puzzle, solvable.plan);

  const ok =
    solvable.ok &&
    solvable.proven &&
    accessibility.ok &&
    Object.values(necessity).every((n) => n.necessary && n.proven) &&
    Object.values(meaningful).every((m) => m.meaningful);

  // The body carries the canonical key of the whole puzzle, not just its id:
  // two puzzles sharing an id but differing in any action must not be able to
  // produce the same certificate hash.
  const key = puzzleKey(puzzle);
  const body = {
    puzzleId: puzzle.id,
    puzzleKey: key,
    fromState,
    solvable,
    necessity,
    accessibility,
    meaningful,
    ok,
  };

  return { ...body, hash: stableHash(canonicalStringify(body)) };
}

/**
 * Validate a puzzle and a state, returning a refusal or null.
 *
 * Puzzle errors are checked first and stop the state check: `validateState`
 * leans on the puzzle being well-formed (it indexes actions by id, for one
 * thing), so running it on a broken puzzle would produce noise rather than
 * signal.
 */
function validate(puzzle: Puzzle, state: State): ValidationError | null {
  const puzzleCheck = validatePuzzle(puzzle);
  if (!puzzleCheck.ok) return validationError(puzzleCheck.errors, []);
  // The state is checked against the puzzle as it actually is -- roles present
  // and all. Whether it stays legal in a counterfactual world is a different
  // question that `proveNecessity` answers by construction: removing a role
  // removes its private tokens from the solver's starting knowledge, so a state
  // that names one of them is not re-checked against a world that never had it.
  const stateCheck = validateState(puzzle, state);
  if (!stateCheck.ok) return validationError([], stateCheck.errors);
  return null;
}

/** The issues behind a refusal, for callers that want them separately. */
export function refusalIssues(result: CertifyResult): ValidationIssue[] {
  return isCertificate(result) ? [] : result.errors;
}

/**
 * The states a full certification costs: the initial solve plus every
 * counterfactual search.
 *
 * `certificate.solvable.statesExplored` alone is the cost of one search out of
 * R+1, and reporting it as "the cost" understates the real total.
 */
export function totalStates(certificate: Certificate): number {
  let total = certificate.solvable.statesExplored;
  for (const proof of Object.values(certificate.necessity)) total += proof.statesExplored;
  return total;
}

/* ------------------------------------------------------------------ */
/* Necessity                                                           */
/* ------------------------------------------------------------------ */

function proveNecessity(
  puzzle: Puzzle,
  state: State,
  roleId: RoleId,
  options: CertifyOptions,
): NecessityProof {
  const reduced = removeRole(puzzle, roleId);
  // Read through `optionField` for the same reason `solve` does: `certify` is
  // reached from JavaScript, its options container may be `null`, and a direct
  // read here would throw before `solve`'s own gate could refuse it.
  //
  // The value that reaches `solve` is therefore a number, `undefined`, or the
  // unreadable sentinel. The sentinel is passed through rather than filtered:
  // `solve` refuses anything that is not a positive integer with
  // `invalid_options`, which is precisely the typed outcome this path wants,
  // and the assertion is only here because that third case is deliberately not
  // a number at the type level.
  const counterfactualBound = optionField(options, "maxCounterfactualStates");
  const stateBound = optionField(options, "maxStates");
  const result = solve(reduced, state, {
    maxStates: (counterfactualBound ?? stateBound) as SolveOptions["maxStates"],
  });

  if (result.status === "invalid_options") {
    return {
      role: roleId,
      necessary: false,
      proven: false,
      statesExplored: 0,
      truncated: false,
      reason: `counterfactual search for ${roleId} could not run: ${result.reason}`,
    };
  }
  if (result.status === "solvable") {
    return {
      role: roleId,
      necessary: false,
      proven: true,
      statesExplored: result.statesExplored,
      truncated: false,
      reason: `goal still reachable without ${roleId} -- role is decorative`,
    };
  }
  if (result.truncated) {
    return {
      role: roleId,
      necessary: false,
      proven: false,
      statesExplored: result.statesExplored,
      truncated: true,
      reason: `search without ${roleId} hit the state cap; necessity is unproven, not disproven`,
    };
  }
  return {
    role: roleId,
    necessary: true,
    proven: true,
    statesExplored: result.statesExplored,
    truncated: false,
    reason: `goal unreachable without ${roleId} (${result.statesExplored} states exhausted)`,
  };
}

/* ------------------------------------------------------------------ */
/* Accessibility                                                       */
/* ------------------------------------------------------------------ */

/**
 * Accessibility is about actions the team still has to perform.
 *
 * An action that is already in `state.doneActions` is deliberately skipped: it
 * has been performed, it cannot be rewritten without losing progress, and
 * holding its old capability requirement against the puzzle would make every
 * mid-game input change unrecompilable the moment the changed role did anything
 * at all. What must remain true is that every action *still ahead of the team*
 * can be performed by someone who can actually perform it.
 */
export function checkAccessibility(
  puzzle: Puzzle,
  state: State,
): {
  ok: boolean;
  violations: AccessibilityViolation[];
} {
  const violations: AccessibilityViolation[] = [];
  const done = new Set(doneActionIds(state.history));

  if (puzzle.roles.length === 0) {
    violations.push({
      kind: "empty_action_pool",
      action: null,
      detail: "puzzle has no roles, so no action can ever be performed",
    });
  }

  for (const action of puzzle.actions) {
    if (done.has(action.id)) continue;
    const eligible = eligiblePerformers(puzzle, action.needs, action.performer);
    if (eligible.length === 0) {
      violations.push({
        kind: "no_eligible_performer",
        action: action.id,
        detail:
          action.performer === "any"
            ? `action "${action.id}" needs "${action.needs}" but no role in the puzzle has it`
            : `action "${action.id}" is assigned to "${action.performer}", who does not have "${action.needs}"`,
      });
    }
    if (action.needs === "scan" && action.options !== undefined && action.options > SCAN_MAX_OPTIONS) {
      violations.push({
        kind: "scan_too_many_options",
        action: action.id,
        detail: `scan action "${action.id}" offers ${action.options} options; switch scanning allows at most ${SCAN_MAX_OPTIONS}`,
      });
    }
    // A choice with no answer token is a choice nobody can make. `validatePuzzle`
    // refuses such a puzzle outright; this is the same rule stated as an
    // accessibility violation so a certificate that somehow reached here still
    // cannot claim `ok`.
    if ((action.options ?? 1) > 1 && !action.answerToken) {
      violations.push({
        kind: "choice_without_answer",
        action: action.id,
        detail: `action "${action.id}" offers ${action.options} options but names no answerToken, so a player cannot know which choice is right`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

function eligiblePerformers(
  puzzle: Puzzle,
  capability: Capability,
  performer: string,
): RoleId[] {
  if (performer === "any") {
    return puzzle.roles.filter((r) => roleHas(r, capability)).map((r) => r.id);
  }
  const role = puzzle.roles.find((r) => r.id === performer);
  return role && roleHas(role, capability) ? [role.id] : [];
}

/* ------------------------------------------------------------------ */
/* Meaningfulness                                                      */
/* ------------------------------------------------------------------ */

function checkMeaningfulness(
  puzzle: Puzzle,
  plan: readonly PlanStep[],
): Record<RoleId, MeaningfulnessProof> {
  const consumed = new Set<string>();
  for (const step of plan) {
    const action = puzzle.actions.find((a) => a.id === step.action);
    if (!action) continue;
    for (const t of action.requiresTokens) consumed.add(t);
  }
  const performers = new Set(plan.map((s) => s.performer));

  const out: Record<RoleId, MeaningfulnessProof> = {};
  for (const role of puzzle.roles) {
    if (performers.has(role.id)) {
      out[role.id] = {
        role: role.id,
        meaningful: true,
        reason: `performs at least one action on the witness plan`,
      };
      continue;
    }
    const contributed = role.privateTokens.filter((t) => consumed.has(t));
    if (contributed.length > 0) {
      out[role.id] = {
        role: role.id,
        meaningful: true,
        reason: `supplies token(s) the witness plan consumes: ${contributed.join(", ")}`,
      };
      continue;
    }
    out[role.id] = {
      role: role.id,
      meaningful: false,
      reason: `performs no action on the witness plan and holds no token it consumes (holds: ${
        role.privateTokens.length ? role.privateTokens.join(", ") : "nothing"
      })`,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Human-readable summary of why a certificate failed                  */
/* ------------------------------------------------------------------ */

export function explainFailure(result: CertifyResult): string {
  if (!isCertificate(result)) {
    return `${result.reason}${result.stateInvalid ? " (the state is the problem)" : ""}`;
  }
  const certificate = result;
  const reasons: string[] = [];
  const unsolvable = !certificate.solvable.ok;

  if (unsolvable) {
    reasons.push(
      certificate.solvable.truncated
        ? "solvability search hit the state cap (unproven)"
        : "goal unreachable from this state",
    );
  }
  if (!certificate.accessibility.ok) {
    for (const v of certificate.accessibility.violations) reasons.push(`accessibility: ${v.detail}`);
  }
  // Necessity and meaningfulness are both statements about getting to the goal.
  // When the goal is unreachable they are vacuous and would only add noise.
  if (!unsolvable) {
    for (const proof of Object.values(certificate.necessity)) {
      if (!proof.necessary || !proof.proven) reasons.push(`${proof.role}: ${proof.reason}`);
    }
    for (const proof of Object.values(certificate.meaningful)) {
      if (!proof.meaningful) reasons.push(`${proof.role}: ${proof.reason}`);
    }
  }
  return reasons.length ? reasons.join("; ") : "certificate failed for an unlisted reason";
}
