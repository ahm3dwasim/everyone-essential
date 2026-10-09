/**
 * Recompiler: a player's input mode changes mid-game, and the puzzle has to be
 * repaired without losing progress and without quietly demoting anyone to
 * decorative.
 *
 * Progress is preserved by construction: the recompiler never rewrites or
 * removes anything already in `state.history`, only appends one
 * `capability_change` event to it, and it refuses to rewrite an action that
 * has already been performed. Only not-yet-done actions are eligible for
 * rewriting.
 *
 * The repair is a bounded search over a small fixed operator library:
 *
 *   convert   retarget one of the changed role's actions at a capability it
 *             still has, splitting a wide choice into chained narrow steps when
 *             the new capability cannot present it in one go
 *   reassign  give one of the changed role's actions to another role that has
 *             the capability
 *   handoff   move a private token to the changed role so it stays necessary
 *
 * Candidates are tried in a fixed order (convert, then reassign, then handoff;
 * each in puzzle order) and the first puzzle whose certificate is `ok` wins.
 * If nothing in the bounded space works, the result is NO_VALID_RECOMPILE with
 * every operator that was tried and why it was rejected -- never a weaker
 * certificate.
 */
import {
  type Action,
  type ActionId,
  type Capability,
  type Puzzle,
  type RoleId,
  type State,
  type TokenId,
  clonePuzzle,
  describeOptionValue,
  doneActionIds,
  normalizeState,
  optionField,
  puzzleKey,
  replaceActions,
  roleHas,
  withRoleCapabilities,
} from "./model";
import {
  type Certificate,
  type CertifyOptions,
  certify,
  explainFailure,
  isCertificate,
  totalStates,
} from "./certify";
import {
  type ValidationIssue,
  KNOWN_CAPABILITIES,
  parseGeneratedActionId,
  validatePuzzle,
  validateState,
  validationError,
} from "./validate";
import { convertAction, deriveLogicalAction, handOffToken, primitivesFor } from "./convert";
import { now } from "./clock";

export { convertAction, handOffToken } from "./convert";

export type OperatorName = "convert" | "reassign" | "handoff";

export interface DiffEntry {
  op: OperatorName | "capability_change";
  /** One line, phrased for a shared screen. */
  summary: string;
  actionIds: ActionId[];
  roleIds: RoleId[];
  tokenIds: TokenId[];
}

export interface OperatorAttempt {
  /** How many operators had to be applied to reach this candidate. */
  depth: number;
  op: OperatorName;
  detail: string;
  ok: boolean;
  rejectedBecause: string;
}

export interface RecompileOk {
  kind: "ok";
  puzzle: Puzzle;
  /**
   * The state to certify and continue play from: `state` with a
   * `capability_change` event appended. `state.history` is always a strict
   * prefix of this -- nothing already recorded is altered or removed. Any
   * further certification of `puzzle` MUST use this, not the `state` the
   * caller passed in: the puzzle's roles already carry the NEW capabilities, so
   * a replay against the old state (with no record of the change) would judge
   * the role's already-performed actions against a capability it never held.
   */
  state: State;
  /** The role whose capabilities changed, and what they are now. */
  role: RoleId;
  capabilities: Capability[];
  diff: DiffEntry[];
  certificate: Certificate;
  operatorsTried: OperatorAttempt[];
  /**
   * Solver states spent on EVERY candidate certified along the way, not just
   * the winner: the cost of a recompile is the whole search, and reporting only
   * the winning certificate's cost would understate it by an order of magnitude.
   */
  totalStatesExplored: number;
  elapsedMs: number;
}

export interface RecompileFail {
  kind: "no_valid_recompile";
  role: RoleId;
  capabilities: Capability[];
  diff: DiffEntry[];
  /** Best-effort diagnosis: what the last, most-repaired candidate failed on. */
  reason: string;
  operatorsTried: OperatorAttempt[];
  /** Solver states spent on every candidate certified before giving up. */
  totalStatesExplored: number;
  elapsedMs: number;
}

/**
 * A bound was hit, so the honest answer is "not shown to exist", NOT "does not
 * exist". Returning `no_valid_recompile` for both claims the bounded search
 * settled a question it had only failed to answer.
 */
export interface RecompileExhausted {
  kind: "search_exhausted";
  role: RoleId;
  capabilities: Capability[];
  diff: DiffEntry[];
  /** Which bound stopped the search, and what to raise. */
  reason: string;
  bound: "maxDepth" | "maxCandidates" | "maxStates";
  operatorsTried: OperatorAttempt[];
  /** Solver states spent on every candidate certified before the bound stopped it. */
  totalStatesExplored: number;
  elapsedMs: number;
}

/**
 * The input is not something this compiler can speak about, so nothing was
 * searched and nothing is claimed about the operator space.
 *
 * Folding this into `no_valid_recompile`, whose README row says the operator
 * space was *exhausted*, makes a claim about the puzzle: a reserved-role
 * puzzle comes back `no_valid_recompile` with zero operators tried, telling
 * the caller the repair space was searched and settled when it was never
 * entered. Invalid inputs have their own outcome: an unknown role id and a
 * capability the model does not know are refusals like any other, not
 * exceptions that escape this function.
 */
export interface RecompileInvalidInput {
  kind: "invalid_input";
  /** The requested role, or null when the request named a role that is not in the puzzle. */
  role: RoleId | null;
  capabilities: Capability[];
  /** Empty: no diff can exist, because no candidate was built. */
  diff: DiffEntry[];
  reason: string;
  errors: ValidationIssue[];
  /** Always empty. An input refusal searches nothing. */
  operatorsTried: OperatorAttempt[];
  totalStatesExplored: number;
  elapsedMs: number;
}

/**
 * A candidate could not be evaluated at all: building it, or certifying it,
 * threw. This is a bug in the operator library rather than a statement about
 * the puzzle, and it is the one outcome that must never be an uncaught throw
 * -- a caller cannot tell a thrown `recompile` apart from a crash, and an
 * accepted, certified chain that makes `certificateFor` throw does exactly
 * that out of the public entry point.
 *
 * It is deliberately NOT `no_valid_recompile`: the candidate was never shown
 * invalid, so nothing about the operator space has been established. The
 * operator that produced the candidate and the message it threw are in
 * `reason`, and every candidate certified before it is in `operatorsTried`.
 */
export interface RecompileOperatorError {
  kind: "operator_error";
  role: RoleId;
  capabilities: Capability[];
  /** The capability change, plus the operators applied to reach the candidate that threw. */
  diff: DiffEntry[];
  reason: string;
  operatorsTried: OperatorAttempt[];
  totalStatesExplored: number;
  elapsedMs: number;
}

export type RecompileResult =
  | RecompileOk
  | RecompileFail
  | RecompileExhausted
  | RecompileInvalidInput
  | RecompileOperatorError;

export interface RecompileOptions extends CertifyOptions {
  /**
   * How many operators may be stacked. Default 5.
   *
   * This is a bound, not a claim: hitting it produces SEARCH_EXHAUSTED. It is
   * 5 rather than 3 because a repair that converts each of a role's actions is
   * a *chain* of conversions -- a four-action role needs four -- and a default
   * that cannot reach a known-valid repair is reporting its own limit as a
   * property of the puzzle.
   */
  maxDepth?: number;
  /** Hard cap on candidates certified. Default 200. Enforced BEFORE certifying. */
  maxCandidates?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_CANDIDATES = 200;

interface AppliedOp {
  op: OperatorName;
  detail: string;
  summary: string;
  actionIds: ActionId[];
  roleIds: RoleId[];
  tokenIds: TokenId[];
}

interface Candidate {
  puzzle: Puzzle;
  path: AppliedOp[];
}

/**
 * Change `roleId`'s capabilities and repair the puzzle so that it certifies
 * again from `state`. Returns NO_VALID_RECOMPILE rather than a weaker proof.
 */
export function recompile(
  puzzle: Puzzle,
  state: State,
  roleId: RoleId,
  newCapabilities: Capability[],
  options: RecompileOptions = {},
): RecompileResult {
  const startedAt = now();
  const attempts: OperatorAttempt[] = [];

  // Same gate as `certify`: a repair proven about a puzzle that does not mean
  // anything is not a repair.
  const puzzleCheck = validatePuzzle(puzzle);
  if (!puzzleCheck.ok) {
    return invalidInput(puzzleCheck.errors, [], startedAt, roleId, newCapabilities, false);
  }
  const stateCheck = validateState(puzzle, state);
  if (!stateCheck.ok) {
    return invalidInput([], stateCheck.errors, startedAt, roleId, newCapabilities, roleIsIn(puzzle, roleId));
  }

  // The search bounds are part of the input too, and they need the same gate:
  // an ungated `maxStates: NaN` would pass the base candidate straight to
  // `solve`, which correctly returns `invalid_options` -- but
  // `certificateFor` folds that non-result into an ordinary failed
  // certificate, so the loop above it reads "one candidate certified, one
  // failed" as NO_VALID_RECOMPILE without ever searching an operator. And
  // because `certified >= maxCandidates` is a numeric comparison, a NaN budget
  // is never `>=` anything, which would silently disable the very cap it
  // names. Refusing a bad bound here, before any candidate is built, keeps
  // `solve`'s own `invalid_options` out of the search loop entirely.
  const optionErrors = validateRecompileOptions(options);
  if (optionErrors.length > 0) {
    return invalidInput([], optionErrors, startedAt, roleId, newCapabilities, roleIsIn(puzzle, roleId));
  }

  // The requested change is part of the input too, and it is the one part
  // this check covers: an unknown role id would otherwise reach
  // `withRoleCapabilities` and throw, and an unknown new capability would
  // otherwise reach `certificateFor` and throw. Both are refusals here,
  // raised before any operator runs.
  const changeErrors = validateChange(puzzle, roleId, newCapabilities);
  if (changeErrors.length > 0) {
    return invalidInput([], changeErrors, startedAt, roleId, newCapabilities, roleIsIn(puzzle, roleId));
  }

  // Read after the gates, never before: reading a bound here with `??` would
  // throw on a `null` container, so the options gate would never run on the very
  // input it exists to refuse, and the bound would be read out of an input the
  // gates have not yet accepted.
  const maxDepth = boundOr(options, "maxDepth", DEFAULT_MAX_DEPTH);
  const maxCandidates = boundOr(options, "maxCandidates", DEFAULT_MAX_CANDIDATES);

  const base = withRoleCapabilities(puzzle, roleId, newCapabilities);
  const capabilityEntry: DiffEntry = {
    op: "capability_change",
    summary: `${roleId} switches to ${newCapabilities.length ? newCapabilities.join(" + ") : "no input at all"}`,
    actionIds: [],
    roleIds: [roleId],
    tokenIds: [],
  };

  // The state a candidate is certified against has to record the change: the
  // repaired puzzle's `roleId` already carries the NEW capabilities, so without
  // this event a replay would judge `roleId`'s already-performed actions (fired
  // under the OLD capability) against a capability it now appears to have held
  // from the start. This is appended once, here, and used for every candidate
  // below -- the change itself is the same regardless of which operator repairs
  // the puzzle around it.
  const changedRole = puzzle.roles.find((r) => r.id === roleId)!;
  const normalized = normalizeState(state);
  const nextState: State = {
    flags: normalized.flags,
    tokens: normalized.tokens,
    history: [
      ...normalized.history,
      {
        kind: "capability_change",
        role: roleId,
        from: [...changedRole.capabilities],
        to: [...newCapabilities],
      },
    ],
  };

  const visited = new Set<string>([puzzleKey(base)]);
  // Every certification below adds to this, winners included.
  let statesExplored = 0;

  // Depth 0: the capability change alone may already be fine (for example when
  // the role never needed the capability it lost). It counts against the
  // candidate budget like any other candidate.
  if (maxCandidates < 1) {
    return exhausted(
      "maxCandidates",
      `candidate budget of ${maxCandidates} is smaller than the base candidate`,
      startedAt,
      roleId,
      newCapabilities,
      capabilityEntry,
      attempts,
      statesExplored,
    );
  }
  let baseCert: Certificate;
  try {
    baseCert = certificateFor(base, nextState, options);
  } catch (error) {
    return operatorError(
      roleId,
      newCapabilities,
      capabilityEntry,
      [],
      attempts,
      statesExplored,
      startedAt,
      "the base candidate (the capability change alone) could not be evaluated",
      error,
    );
  }
  statesExplored += totalStates(baseCert);
  attempts.push({
    depth: 0,
    op: "convert",
    detail: "no rewrite (capability change only)",
    ok: baseCert.ok,
    rejectedBecause: baseCert.ok ? "" : explainFailure(baseCert),
  });
  // A candidate's "no" only counts toward "the operator space is exhausted"
  // when it was actually proven. One hit against the state cap means the
  // final "every candidate certified and none holds" claim would be false.
  let anyCertificateStateCapped = !baseCert.ok && certificateStateCapped(baseCert);
  if (baseCert.ok) {
    return {
      kind: "ok",
      puzzle: base,
      state: nextState,
      role: roleId,
      capabilities: [...newCapabilities],
      diff: [capabilityEntry],
      certificate: baseCert,
      operatorsTried: attempts,
      totalStatesExplored: statesExplored,
      elapsedMs: elapsed(startedAt),
    };
  }

  let frontier: Candidate[] = [{ puzzle: base, path: [] }];
  let certified = 1;
  let lastFailure: { certificate: Certificate; path: AppliedOp[] } | null = {
    certificate: baseCert,
    path: [],
  };

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Candidate[] = [];

    for (const candidate of frontier) {
      let ops: Application[];
      try {
        ops = applications(candidate.puzzle, roleId, nextState);
      } catch (error) {
        return operatorError(
          roleId,
          newCapabilities,
          capabilityEntry,
          candidate.path,
          attempts,
          statesExplored,
          startedAt,
          "the operator library threw while listing the operators that apply",
          error,
        );
      }
      for (const application of ops) {
        const path = [...candidate.path, application.op];
        let repaired: Puzzle;
        let key: string;
        try {
          repaired = application.apply();
          key = puzzleKey(repaired);
        } catch (error) {
          return operatorError(
            roleId,
            newCapabilities,
            capabilityEntry,
            path,
            attempts,
            statesExplored,
            startedAt,
            `applying operator "${application.op.detail}" threw`,
            error,
          );
        }
        if (visited.has(key)) continue;
        visited.add(key);

        // The budget is enforced BEFORE the certificate is computed. Checking
        // it only when deciding whether to queue descendants lets a
        // `maxCandidates: 1` search certify five candidates and then call the
        // result "no valid recompile".
        if (certified >= maxCandidates) {
          return exhausted(
            "maxCandidates",
            `stopped after certifying ${certified} of a ${maxCandidates}-candidate budget, with search still to do`,
            startedAt,
            roleId,
            newCapabilities,
            capabilityEntry,
            attempts,
            statesExplored,
          );
        }

        let certificate: Certificate;
        try {
          certificate = certificateFor(repaired, nextState, options);
        } catch (error) {
          return operatorError(
            roleId,
            newCapabilities,
            capabilityEntry,
            path,
            attempts,
            statesExplored,
            startedAt,
            `certifying the candidate from "${application.op.detail}" threw`,
            error,
          );
        }
        statesExplored += totalStates(certificate);
        certified++;
        attempts.push({
          depth,
          op: application.op.op,
          detail: application.op.detail,
          ok: certificate.ok,
          rejectedBecause: certificate.ok ? "" : explainFailure(certificate),
        });

        if (certificate.ok) {
          return {
            kind: "ok",
            puzzle: repaired,
            state: nextState,
            role: roleId,
            capabilities: [...newCapabilities],
            diff: [capabilityEntry, ...path.map(toDiffEntry)],
            certificate,
            operatorsTried: attempts,
            totalStatesExplored: statesExplored,
            elapsedMs: elapsed(startedAt),
          };
        }
        if (!certificate.ok && certificateStateCapped(certificate)) anyCertificateStateCapped = true;
        lastFailure = { certificate, path };
        next.push({ puzzle: repaired, path });
      }
    }

    // Running out of frontier before the depth bound is the real "the operator
    // space is exhausted" signal -- UNLESS one of the certificates along the
    // way was only rejected because its own solver proof hit `maxStates`
    // (or `maxCounterfactualStates`). That candidate was never shown invalid,
    // so "every candidate within depth was certified and none holds" would be
    // a claim the search never actually established. That gets the honest
    // unproven answer instead of the definitive one.
    if (next.length === 0) {
      if (anyCertificateStateCapped) {
        return exhausted(
          "maxStates",
          `every candidate within depth ${maxDepth} was certified, but at least one candidate's own solver proof hit its state cap (unproven) rather than being disproven, so "no repair exists" is not established`,
          startedAt,
          roleId,
          newCapabilities,
          capabilityEntry,
          attempts,
          statesExplored,
        );
      }
      const reason = lastFailure
        ? `the operator space is exhausted: every candidate within depth ${maxDepth} was certified and none holds; last candidate failed on: ${explainFailure(
            lastFailure.certificate,
          )}`
        : `the operator space is exhausted: no operator applies to this puzzle at all`;
      return {
        kind: "no_valid_recompile",
        role: roleId,
        capabilities: [...newCapabilities],
        diff: [capabilityEntry],
        reason,
        operatorsTried: attempts,
        totalStatesExplored: statesExplored,
        elapsedMs: elapsed(startedAt),
      };
    }

    frontier = next;
  }

  // The frontier still had work in it: the depth bound is what stopped us, not
  // the operator space. Saying "no repair exists" here would be a claim the
  // search never established.
  return exhausted(
    "maxDepth",
    `deepest candidate certified was depth ${maxDepth} and the search still had unexplored candidates; raise maxDepth (currently ${maxDepth}) to search further`,
    startedAt,
    roleId,
    newCapabilities,
    capabilityEntry,
    attempts,
    statesExplored,
  );
}

function exhausted(
  bound: "maxDepth" | "maxCandidates" | "maxStates",
  detail: string,
  startedAt: number,
  roleId: RoleId,
  newCapabilities: Capability[],
  capabilityEntry: DiffEntry,
  attempts: OperatorAttempt[],
  statesExplored: number,
): RecompileExhausted {
  return {
    kind: "search_exhausted",
    role: roleId,
    capabilities: [...newCapabilities],
    diff: [capabilityEntry],
    bound,
    reason: `search hit the ${bound} bound, so no repair is shown to exist -- and none is shown not to: ${detail}`,
    operatorsTried: attempts,
    totalStatesExplored: statesExplored,
    elapsedMs: elapsed(startedAt),
  };
}

function isPositiveFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Every numeric option `recompile` reads, checked before anything is
 * searched. `Number.isInteger` already refuses `NaN` and `Infinity` (neither
 * is an integer), so "positive finite integer" is one check, not two.
 */
function validateRecompileOptions(options: unknown): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  // Every read goes through `optionField`: a `null` container, a primitive, and
  // an object whose property read throws all come back as `UNREADABLE_OPTIONS`
  // and are refused just below, where a `BigInt` and a cyclic value are refused
  // too (the message is built by `describeOptionValue`, never by
  // `JSON.stringify` directly). Reading the options is the first thing
  // `recompile` does, so a read that throws here would be a `TypeError`
  // escaping a public function before the gate that names the problem ran.
  for (const name of ["maxDepth", "maxCandidates", "maxStates", "maxCounterfactualStates"]) {
    const value = optionField(options, name);
    if (value !== undefined && !isPositiveFiniteInteger(value)) {
      errors.push({
        kind: "invalid_options",
        action: null,
        role: null,
        detail: `${name} must be a positive integer, got ${describeOptionValue(value)}`,
      });
    }
  }
  return errors;
}

/**
 * One numeric bound as the search loop will use it. Only called after
 * `validateRecompileOptions` has refused every present-but-unusable value, so
 * anything that is not a positive finite integer here is an absent bound and
 * takes the default.
 */
function boundOr(options: unknown, name: string, fallback: number): number {
  const value = optionField(options, name);
  return isPositiveFiniteInteger(value) ? value : fallback;
}

/**
 * The requested change, checked before it is applied.
 *
 * A capability the model does not know is a typo, not a new input mode, and a
 * role that is not in the puzzle cannot be given one. `newCapabilities` arriving
 * as something other than an array is the same class of problem one level up.
 */
function validateChange(
  puzzle: Puzzle,
  roleId: RoleId,
  newCapabilities: Capability[],
): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  if (!Array.isArray(newCapabilities)) {
    return [
      {
        kind: "malformed_input",
        action: null,
        role: typeof roleId === "string" ? roleId : null,
        detail: `the new capability list must be an array, got ${typeof newCapabilities}`,
      },
    ];
  }
  for (const capability of newCapabilities) {
    if (!KNOWN_CAPABILITIES.includes(capability)) {
      errors.push({
        kind: "unknown_capability",
        action: null,
        role: typeof roleId === "string" ? roleId : null,
        detail: `"${String(capability)}" is not a capability this model knows (${KNOWN_CAPABILITIES.join(", ")})`,
      });
    }
  }
  if (errors.length > 0) return errors;
  if (typeof roleId !== "string" || !puzzle.roles.some((r) => r.id === roleId)) {
    errors.push({
      kind: "unknown_action",
      action: null,
      role: typeof roleId === "string" ? roleId : null,
      detail: `role "${String(roleId)}" is not in this puzzle, so its capabilities cannot change`,
    });
    return errors;
  }
  if (newCapabilities.length === 0) {
    errors.push({
      kind: "malformed_input",
      action: null,
      role: roleId,
      detail: `role "${roleId}" would be left with no input at all, which is not a puzzle this model can repair`,
    });
  }
  return errors;
}

/**
 * `recompile` answers a puzzle or state that fails validation the same way
 * `certify` does: a typed outcome naming what is wrong, with nothing searched.
 * Returning
 * `no_valid_recompile` here would claim what the README defines as "the
 * operator space was exhausted" -- a statement about the puzzle rather than
 * about the input.
 */
function invalidInput(
  puzzleErrors: ValidationIssue[],
  stateErrors: ValidationIssue[],
  startedAt: number,
  roleId: RoleId,
  newCapabilities: Capability[],
  /** False when the request named a role this puzzle does not have. */
  roleIsKnown: boolean,
): RecompileInvalidInput {
  const errors = [...puzzleErrors, ...stateErrors];
  return {
    kind: "invalid_input",
    // Null when the request named a role the puzzle does not have: echoing an
    // unknown id back in a `role` field would suggest it was resolved.
    role: roleIsKnown ? roleId : null,
    capabilities: Array.isArray(newCapabilities) ? [...newCapabilities] : [],
    diff: [],
    reason: validationError(puzzleErrors, stateErrors).reason,
    errors,
    operatorsTried: [],
    totalStatesExplored: 0,
    elapsedMs: elapsed(startedAt),
  };
}

function roleIsIn(puzzle: Puzzle, roleId: unknown): boolean {
  return typeof roleId === "string" && puzzle.roles.some((r) => r.id === roleId);
}

/**
 * Certify a candidate the recompiler built itself, through the same `certify`
 * every other caller uses -- there is no second, weaker-gated entry point.
 * `validatePuzzle` accepts a candidate's generated ids because they are
 * exactly the shape the generator emits, not because anything told it to skip
 * the check. A refusal here is a bug rather than bad input: candidates come
 * from an already-validated puzzle through operators that preserve validity,
 * and the state was validated before the search began.
 *
 * The operator library actually preserves that invariant -- whole chains are
 * converted and reassigned whole, so no operator can produce a chain
 * `validatePuzzle` refuses -- and the belt below wraps every call, so that a
 * future hole in that argument is a typed outcome rather than an exception
 * escaping `recompile`.
 */
function certificateFor(puzzle: Puzzle, state: State, options: RecompileOptions): Certificate {
  const result = certify(puzzle, state, options);
  if (!isCertificate(result)) {
    throw new Error(
      `recompile: generated candidate failed validation, which is a bug in the operator library: ${result.reason}`,
    );
  }
  return result;
}

/** Never throws itself: it exists to describe a throw. */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return `"${error}"`;
  try {
    return String(error);
  } catch {
    return `a ${typeof error} value`;
  }
}

/**
 * The belt. Anything that escapes while a candidate is built or certified
 * comes back as `operator_error`, carrying the operator that produced it and
 * what it threw. The likeliest place to reach this belt is inside
 * `certificateFor`: an accepted, certified puzzle can make a candidate
 * invalid, and a refused candidate is a bug signal rather than a failed
 * certificate.
 *
 * It is a belt, not the fix: both known counterexamples are repaired and
 * refused by the layers above it with the belt removed, which the mutation
 * controls in the test suite check directly.
 */
function operatorError(
  roleId: RoleId,
  newCapabilities: Capability[],
  capabilityEntry: DiffEntry,
  path: AppliedOp[],
  attempts: OperatorAttempt[],
  statesExplored: number,
  startedAt: number,
  detail: string,
  error: unknown,
): RecompileOperatorError {
  return {
    kind: "operator_error",
    role: roleId,
    capabilities: [...newCapabilities],
    diff: [capabilityEntry, ...path.map(toDiffEntry)],
    reason: `${detail}, which is a bug in the operator library rather than a property of the puzzle: ${describeError(error)}`,
    operatorsTried: attempts,
    totalStatesExplored: statesExplored,
    elapsedMs: elapsed(startedAt),
  };
}

/**
 * True when a FAILED certificate's "no" is not actually proven: either the
 * solvability search or some role's necessity counterfactual hit its state
 * cap before it could finish. Such a candidate was never shown invalid -- it
 * was only never fully checked -- so it must not be allowed to make the
 * overall search's answer "no valid recompile", which is a claim that every
 * candidate WAS checked.
 */
function certificateStateCapped(certificate: Certificate): boolean {
  if (certificate.solvable.truncated) return true;
  return Object.values(certificate.necessity).some((proof) => proof.truncated);
}

function elapsed(startedAt: number): number {
  return Math.round((now() - startedAt) * 1000) / 1000;
}

function toDiffEntry(op: AppliedOp): DiffEntry {
  return {
    op: op.op,
    summary: op.summary,
    actionIds: op.actionIds,
    roleIds: op.roleIds,
    tokenIds: op.tokenIds,
  };
}

/* ------------------------------------------------------------------ */
/* Operator generation                                                 */
/* ------------------------------------------------------------------ */

interface Application {
  op: AppliedOp;
  apply(): Puzzle;
}

/**
 * Every single-operator rewrite that is legal on this puzzle, in a fixed order:
 * convert (action order, then the role's capability order, then primitive
 * capacity order), reassign (action order, then role order), handoff (role
 * order, then token order). The order is total, so the search is reproducible.
 */
function applications(puzzle: Puzzle, roleId: RoleId, state: State): Application[] {
  const done = new Set(doneActionIds(state.history));
  const role = puzzle.roles.find((r) => r.id === roleId);
  if (!role) return [];

  const out: Application[] = [];
  const chainGroups = chainGroupsFor(puzzle);
  const chainStepIds = new Set<ActionId>();
  for (const steps of chainGroups.values()) {
    for (const step of steps) chainStepIds.add(step.id);
  }

  // --- convert ---------------------------------------------------------
  //
  // A generic action the changed role can no longer perform is repairable too.
  // Looking only at `action.performer === roleId` skips it, so when the changed
  // role is a generic action's ONLY capable performer the recompiler reports
  // NO_VALID_RECOMPILE for a puzzle a hand edit certifies.
  for (const action of puzzle.actions) {
    // A step of an already-generated split chain is not converted on its own
    // below: doing so would replace only that one step and leave its siblings
    // pointing at progress tokens the replacement no longer produces or
    // requires, which `validatePuzzle` correctly refuses as an incomplete
    // chain. The chain is converted as a whole, further down.
    if (chainStepIds.has(action.id)) continue;
    const ownedByRole = action.performer === roleId;
    const genericOrphan = action.performer === "any" && orphanedGenericAction(puzzle, action, roleId);
    if (!ownedByRole && !genericOrphan) continue;
    if (done.has(action.id)) continue;
    if (roleHas(role, action.needs)) continue; // still performable as-is
    for (const capability of role.capabilities) {
      // One application per primitive, so a conversion the largest primitive
      // cannot express is still reachable through a smaller one. `convertAction`
      // with no primitive named would stop at the first success, which is the
      // right answer for a caller but the wrong search space for the recompiler:
      // the candidates that fix the puzzle are certified, not guessed at.
      for (const primitive of primitivesFor(puzzle, capability)) {
        const converted = convertAction(puzzle, action, roleId, capability, primitive);
        if (!converted) continue;
        out.push({
          op: {
            op: "convert",
            detail: `convert "${action.id}" from ${action.needs} to ${capability} via ${primitive.id}`,
            summary: converted.summary,
            actionIds: converted.actionIds,
            roleIds: [roleId],
            tokenIds: [],
          },
          apply: () => replaceActions(puzzle, action.id, converted.actions),
        });
      }
    }
  }

  // --- convert (a whole already-generated split chain) ------------------
  //
  // A second capability change can land on a role that already owns a
  // generated split chain from an earlier recompile. The chain is converted
  // as one unit -- the whole thing replaced by a fresh split (or collapsed
  // back to a single step) for the new capability -- never one step at a
  // time, so the outer chain can never be left incomplete. A chain is offered
  // here when the changed role performs every one of its steps, or when it is
  // a generic chain no role can perform any more (below), and none of its
  // steps has been done yet; a chain partway performed is left alone and the
  // search falls back to reassign or handoff instead.
  //
  // "Still performable as-is" means EVERY step of it. Reading only the first
  // link's capability is not enough: a chain whose later links need something
  // the role no longer has is not performable, and skipping it as if it were
  // leaves that later link inaccessible with no candidate that could repair it
  // -- a false `no_valid_recompile`. `validatePuzzle` refuses a chain that is not uniform
  // in `needs`, so for validated input this test and the whole-chain reads
  // below always agree on a single answer; the check is here so the
  // operator library does not depend on that gate to be correct.
  //
  // A GENERIC chain (`performer: "any"`) is repairable here too. It is
  // otherwise the one shape this loop cannot reach: the ordinary generic loop
  // above skips chain steps (`chainStepIds`), and this loop skipped anything
  // whose steps are not performed by the changed role, so a generic chain whose
  // capability the change removed would have no candidate at all and get a
  // definitive `no_valid_recompile` for a puzzle the same operator library
  // repairs by hand. The rule is the ordinary generic-action rule, not a new
  // one: a generic action is only offered for conversion when it is
  // stranded -- nobody in the puzzle can perform it any more -- because
  // otherwise "any" is still the correct performer and rewriting it would
  // narrow a working action for no reason. The chain form of "nobody can
  // perform it" is `orphanedGenericChain`, below.
  for (const [origId, steps] of chainGroups) {
    const ownedByRole = steps.every((step) => step.performer === roleId);
    const strandedGeneric =
      steps.every((step) => step.performer === "any") && orphanedGenericChain(puzzle, steps);
    if (!ownedByRole && !strandedGeneric) continue;
    if (steps.some((step) => done.has(step.id))) continue;
    // Reached only for a chain the changed role performs: a stranded generic
    // chain is one no role can perform every link of, the changed role
    // included, so this test is already false for it.
    if (steps.every((step) => roleHas(role, step.needs))) continue; // still performable as-is
    // The logical action is recovered the same way `validatePuzzle`'s round
    // trip does: verbatim from step 1's requirements/flags/label and the last
    // step's effects (`deriveLogicalAction` in `convert.ts`), not folded
    // across every step. A validated chain has already round-tripped through
    // the real generator before repair ever sees it, so its middle links can
    // only hold the fixed progress-token shape `convertAction` produces -- a
    // requirement or a flag smuggled onto one is refused at `validatePuzzle`,
    // not read here.
    // This is the one derivation, used here and at the gate, rather than two
    // copies that could drift apart again.
    //
    // A generic chain's logical action comes back with `performer: "any"`
    // (`deriveLogicalAction` reads step 1 verbatim). `convertAction` names the
    // role it is given on every step it builds, so the replacement is the
    // changed role's -- the same thing the ordinary generic-orphan conversion
    // above produces, and the shape the round trip accepts: a repaired chain
    // is regenerated from its own step 1, so it can only ever be a chain
    // `convertAction` emitted for one performer.
    const logical = deriveLogicalAction(origId, steps);
    // Probed with the chain's OWN steps removed, so `freeId` offers the clean
    // "§origId__step1" ids back rather than treating them as taken and
    // appending a "~2" that would not parse as a generated id at all.
    const stepIds = new Set(steps.map((step) => step.id));
    const withoutChain: Puzzle = { ...puzzle, actions: puzzle.actions.filter((a) => !stepIds.has(a.id)) };
    for (const capability of role.capabilities) {
      for (const primitive of primitivesFor(puzzle, capability)) {
        const converted = convertAction(withoutChain, logical, roleId, capability, primitive);
        if (!converted) continue;
        out.push({
          op: {
            op: "convert",
            detail: `convert generated chain "${origId}" (${steps.length} steps) from ${logical.needs} to ${capability} via ${primitive.id}`,
            summary: converted.summary,
            actionIds: converted.actionIds,
            roleIds: [roleId],
            tokenIds: [],
          },
          apply: () => replaceChainActions(puzzle, steps.map((step) => step.id), converted.actions),
        });
      }
    }
  }

  // --- reassign --------------------------------------------------------
  //
  // Reassignment only applies to an action that names the changed role. A
  // generic action is already available to every capable role, so there is
  // nothing to give away -- if it became unperformable, no role in the puzzle
  // has the capability any more, and naming one of them would not help.
  //
  // A step of a generated split chain is not reassigned on its own. Doing so
  // leaves the chain performed by two roles, which is not a shape
  // `convertAction` emits and `validatePuzzle` refuses -- so the candidate is
  // not a weaker repair, it is invalid input, and `certificateFor` throws on it
  // rather than returning a failed certificate. Whole chains are reassigned
  // whole, below.
  for (const action of puzzle.actions) {
    if (chainStepIds.has(action.id)) continue;
    if (action.performer !== roleId) continue;
    if (done.has(action.id)) continue;
    for (const other of puzzle.roles) {
      if (other.id === roleId) continue;
      if (!roleHas(other, action.needs)) continue;
      out.push({
        op: {
          op: "reassign",
          detail: `reassign "${action.id}" from ${roleId} to ${other.id}`,
          summary: `"${action.label ?? action.id}" moves from ${roleId} to ${other.id}, who still has ${action.needs}`,
          actionIds: [action.id],
          roleIds: [roleId, other.id],
          tokenIds: [],
        },
        apply: () => {
          const next = clonePuzzle(puzzle);
          const target = next.actions.find((a) => a.id === action.id);
          if (target) target.performer = other.id;
          return next;
        },
      });
    }
  }

  // --- reassign (a whole already-generated split chain) -----------------
  //
  // The chain stays one action performed by one role, so it moves as one: one
  // candidate per role that can perform EVERY link. `validatePuzzle` refuses a
  // chain whose steps disagree on `needs`, so the `every` below admits a given
  // role either for all links or for none.
  //
  // A generic chain is not reassigned, for the reason the ordinary reassign
  // section above spells out: it is already available to every capable role,
  // so there is nothing to give away, and a stranded one is stranded because
  // no role has the capability -- naming one of them would not help. The
  // repair for a stranded generic chain is a conversion, above.
  for (const [origId, steps] of chainGroups) {
    if (steps.some((step) => step.performer !== roleId)) continue;
    if (steps.some((step) => done.has(step.id))) continue;
    for (const other of puzzle.roles) {
      if (other.id === roleId) continue;
      if (!steps.every((step) => roleHas(other, step.needs))) continue;
      out.push({
        op: {
          op: "reassign",
          detail: `reassign generated chain "${origId}" (${steps.length} steps) from ${roleId} to ${other.id}`,
          summary: `the ${steps.length}-step "${origId}" chain moves from ${roleId} to ${other.id}, who still has ${steps[0]!.needs}`,
          actionIds: steps.map((step) => step.id),
          roleIds: [roleId, other.id],
          tokenIds: [],
        },
        apply: () => {
          const next = clonePuzzle(puzzle);
          const stepIds = new Set(steps.map((step) => step.id));
          for (const action of next.actions) {
            if (stepIds.has(action.id)) action.performer = other.id;
          }
          return next;
        },
      });
    }
  }

  // --- handoff ---------------------------------------------------------
  for (const owner of puzzle.roles) {
    if (owner.id === roleId) continue;
    for (const token of owner.privateTokens) {
      out.push({
        op: {
          op: "handoff",
          detail: `hand off token "${token}" from ${owner.id} to ${roleId}`,
          summary: `${owner.id} tells ${roleId} the "${token}" clue, so ${roleId} still matters`,
          actionIds: [],
          roleIds: [owner.id, roleId],
          tokenIds: [token],
        },
        apply: () => handOffToken(puzzle, token, roleId),
      });
    }
  }

  return out;
}

/**
 * Every complete, consecutive generated split chain currently in the puzzle,
 * grouped by the original action id they were split from and ordered by step.
 *
 * The puzzle passed in has already been through `validatePuzzle`, so every
 * `§`-prefixed action id it contains is either a well-formed chain step or the
 * puzzle would have been refused before the search ever started -- this does
 * not re-derive completeness, just the grouping.
 */
function chainGroupsFor(puzzle: Puzzle): Map<string, Action[]> {
  const byOrigId = new Map<string, Map<number, Action>>();
  for (const action of puzzle.actions) {
    const parsed = parseGeneratedActionId(action.id);
    if (!parsed) continue;
    let byStep = byOrigId.get(parsed.origId);
    if (!byStep) {
      byStep = new Map();
      byOrigId.set(parsed.origId, byStep);
    }
    byStep.set(parsed.step, action);
  }
  const groups = new Map<string, Action[]>();
  for (const [origId, byStep] of byOrigId) {
    const steps = [...byStep.keys()].sort((a, b) => a - b);
    groups.set(origId, steps.map((step) => byStep.get(step)!));
  }
  return groups;
}

/**
 * Replace every action in `oldIds` (a whole generated chain) with
 * `replacements`, in place, at the position the first surviving old id held.
 */
function replaceChainActions(puzzle: Puzzle, oldIds: ActionId[], replacements: Action[]): Puzzle {
  const next = clonePuzzle(puzzle);
  const oldSet = new Set(oldIds);
  const index = next.actions.findIndex((a) => oldSet.has(a.id));
  if (index < 0) throw new Error(`replaceChainActions: none of [${oldIds.join(", ")}] found`);
  next.actions = next.actions.filter((a) => !oldSet.has(a.id));
  next.actions.splice(index, 0, ...replacements);
  return next;
}

/**
 * True when this generic action is stranded: the changed role can no longer
 * perform it, and nobody else can either.
 *
 * Callers pass the puzzle *after* `withRoleCapabilities`, so the changed role's
 * entry already carries its new capabilities. The tempting condition -- "the
 * changed role was the only capable one" -- misses the case that actually
 * matters, because after the capability change the role is no longer capable at
 * all, leaving zero capable roles rather than one.
 */
function orphanedGenericAction(puzzle: Puzzle, action: Action, roleId: RoleId): boolean {
  const changed = puzzle.roles.find((r) => r.id === roleId);
  if (changed && roleHas(changed, action.needs)) return false; // the changed role can still do it
  return puzzle.roles.every((r) => r.id === roleId || !roleHas(r, action.needs));
}

/**
 * The chain counterpart of `orphanedGenericAction` above: true when no role in
 * the puzzle can perform this generated chain at all.
 *
 * A role performs a chain only when it can perform EVERY link, so "stranded"
 * is "no single role has every step's `needs`" -- exactly the test the
 * whole-chain loop's own "still performable as-is" line makes for one role,
 * asked of every role instead of one. It is deliberately NOT the narrower
 * "some step needs a capability nobody has": a two-link chain needing `scan`
 * then `voice` is stranded when one role has only `scan` and another only
 * `voice`, even though each link on its own is performable by somebody. For a
 * validated chain the two coincide, because `validatePuzzle` refuses a chain
 * that is not uniform in `needs`; the per-step form is here for the same
 * reason the line above it is, so the operator library does not depend on that
 * gate to be correct.
 *
 * Callers pass the puzzle *after* `withRoleCapabilities`, so the changed
 * role's entry already carries its new capabilities and no role needs
 * excluding: if the changed role can still perform the chain, it is not
 * stranded, and the loop has nothing to repair.
 */
function orphanedGenericChain(puzzle: Puzzle, steps: readonly Action[]): boolean {
  return puzzle.roles.every((role) => steps.some((step) => !roleHas(role, step.needs)));
}

