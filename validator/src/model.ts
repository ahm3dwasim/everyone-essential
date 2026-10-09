/**
 * Puzzle model.
 *
 * Pure data plus pure helpers. No I/O, no Node-only APIs: this file is meant to
 * run unchanged in a browser or a React Native JS engine.
 *
 * The model is deliberately tiny. Everything the validator proves is derived
 * from these six types -- there is no hidden behaviour a puzzle author can use
 * to smuggle in a "necessary" role that is not actually necessary.
 */
import { canonicalStringify } from "./hash";

/** The three input modes a player might have. */
export type Capability =
  /** Directional pad: full grid navigation. */
  | "dpad"
  /** One-button switch scanning: at most 4 options per choice, no timing windows. */
  | "scan"
  /** Speech, e.g. a phone microphone. */
  | "voice";

export type RoleId = string;
export type TokenId = string;
export type FlagId = string;
export type ActionId = string;
export type PrimitiveId = string;

/**
 * Who performs an action: a specific role, or the literal `"any"` meaning
 * "whichever present role has the required capability".
 *
 * Caveat: `"any"` is reserved. A puzzle must not name a role `"any"`.
 */
export type Performer = RoleId | "any";

export interface Role {
  id: RoleId;
  capabilities: Capability[];
  /**
   * Facts only this role can see. The team learns them as soon as the holder
   * is present (they are spoken aloud), so presence -- not effort -- is what
   * makes a private token available. Removing the role removes the token.
   */
  privateTokens: TokenId[];
}

/**
 * A building block a capability can offer. `convert` uses these to rebuild an
 * action for a capability the role still has.
 */
export interface Primitive {
  id: PrimitiveId;
  capability: Capability;
  /** Most alternatives this primitive can present in one step. 1 = a single confirmed press. */
  maxOptions: number;
  /** May a choice wider than `maxOptions` be spread across several chained steps? */
  splittable: boolean;
  label: string;
}

export interface Action {
  id: ActionId;
  performer: Performer;
  needs: Capability;
  requiresTokens: TokenId[];
  requiresFlags: FlagId[];
  producesTokens: TokenId[];
  setsFlags: FlagId[];
  /**
   * How many alternatives this action presents, if it is a choice. Must be a
   * positive integer; omitted means "no choice" (a single activation), which is
   * the same as 1.
   */
  options?: number;
  /**
   * The token whose knowledge makes the correct choice determinable. Required
   * (and required to be in `requiresTokens`) whenever `options > 1`.
   *
   * This is the model's whole representation of a choice, and it is deliberately
   * the weakest honest one: knowing the answer token makes the action fire, and
   * *not* knowing it means the action never fires at all -- a wrong choice is a
   * no-op, which is exactly how the model stays monotone. It does not model a
   * failed attempt that costs something, a lockout after too many wrong tries,
   * or consumable keys. See the README.
   */
  answerToken?: TokenId;
  label?: string;
}

export interface Puzzle {
  id: string;
  roles: Role[];
  actions: Action[];
  /** The puzzle is solved once every one of these flags is set. */
  goalFlags: FlagId[];
  primitives: Primitive[];
}

/**
 * One action, actually performed: by whom, and under which capability.
 *
 * Recording the performer and the capability -- not just "this action happened"
 * -- is what lets a replay catch a done action nobody could have performed: a
 * role crediting itself for work its capability at the time could not do.
 */
export interface ActionEvent {
  kind: "action";
  actionId: ActionId;
  /** The concrete role credited. Never `"any"` -- a replay has to know who acted. */
  performer: RoleId;
  /** The capability the performer used. Must equal the action's `needs`. */
  capability: Capability;
}

/**
 * A role's input mode changed mid-game (what `recompile` records).
 *
 * `from` is the role's capability set immediately before the change, as the
 * replay has tracked it up to this point; `to` is what it becomes. `from` is
 * part of the event, not re-derived, so a replay can catch a forged change that
 * does not follow from what actually came before it.
 */
export interface CapabilityChangeEvent {
  kind: "capability_change";
  role: RoleId;
  from: Capability[];
  to: Capability[];
}

export type HistoryEvent = ActionEvent | CapabilityChangeEvent;

/**
 * The state of play: facts the team has plus the ordered log of how they got
 * there.
 *
 * `flags` and `tokens` are the facts -- what a solver reasons over. `history` is
 * the proof: an ordered replay log a validator can step through to check that
 * every fact is one an action, performed by someone who could actually perform
 * it, actually put there. There is no separate `doneActions` field to fall out
 * of sync with it -- `doneActionIds` derives the set of performed actions from
 * `history` on demand.
 */
export interface State {
  flags: FlagId[];
  tokens: TokenId[];
  history: HistoryEvent[];
}

export const NO_ROLE = "any";

/* ------------------------------------------------------------------ */
/* Generated split-chain ids                                          */
/* ------------------------------------------------------------------ */

/**
 * The namespace reserved for identifiers the recompiler generates.
 *
 * `convertAction` splits a wide choice into chained steps and has to invent
 * action ids and progress tokens. Author ids may not start with this prefix,
 * so a generated id can never collide with one. Lives here, not in
 * `validate.ts`, because `convert.ts` (the generator) and `validate.ts` (the
 * gate) both need it and neither may import the other.
 */
export const RESERVED_PREFIX = "§";

export function isReservedId(id: string): boolean {
  return id.startsWith(RESERVED_PREFIX);
}

export const STEP_MARKER = "__step";
export const PROGRESS_MARKER = "__progress";

/**
 * `§<origId>__step<k>`, greedily splitting on the LAST `__step<digits>`
 * suffix so an `<origId>` that itself contains the substring `__step` (for
 * example a second-generation split of an already-generated step) still
 * parses as the innermost id it actually is.
 */
export function parseGeneratedActionId(id: string): { origId: string; step: number } | null {
  if (!isReservedId(id)) return null;
  const rest = id.slice(RESERVED_PREFIX.length);
  const match = /^(.*)__step(\d+)$/.exec(rest);
  if (!match) return null;
  const [, origId, digits] = match;
  if (!origId || !digits || !/^[1-9]\d*$/.test(digits)) return null;
  return { origId, step: Number(digits) };
}

export function emptyState(): State {
  return { flags: [], tokens: [], history: [] };
}

/* ------------------------------------------------------------------ */
/* Reading a search bound out of runtime input                        */
/* ------------------------------------------------------------------ */

/**
 * The value `optionField` returns for a container it cannot read at all: a
 * `null`, a primitive, or an object whose property read throws.
 *
 * It is a distinct value rather than `undefined` on purpose. `undefined` means
 * "the caller did not pass this bound", which is legal and takes the default;
 * this means "the caller passed something that is not an options object",
 * which must be refused by the caller's own gate rather than silently read as
 * "no options at all". Collapsing the two would let `solve(p, s, null)` run an
 * unbounded search and certify as if nothing had been wrong.
 */
export const UNREADABLE_OPTIONS = Symbol("unreadable options");

/**
 * One named field of an options container that may be anything at all: `null`,
 * a primitive, a `Proxy` that throws on read, an object carrying a `BigInt`, or
 * a cycle.
 *
 * Returns `undefined` when the container is an object and the field is absent;
 * otherwise the raw value, for the caller's own "positive integer" check to
 * refuse. A `null` or primitive container, and an object whose property read
 * throws, both come back as `UNREADABLE_OPTIONS` rather than propagating:
 * reading the options is the first thing `recompile` does, so a `TypeError`
 * here would escape a public function before the gate that names the problem
 * ever ran.
 */
export function optionField(container: unknown, name: string): unknown {
  if (container === null || typeof container !== "object") return UNREADABLE_OPTIONS;
  try {
    return (container as Record<string, unknown>)[name];
  } catch {
    return UNREADABLE_OPTIONS;
  }
}

/**
 * One option value as a human-readable fragment for a refusal message. Never
 * throws: `JSON.stringify` throws on a `BigInt` and on a cycle, and the whole
 * point of these gates is that a malformed option is REFUSED rather than
 * escaping as an exception.
 */
export function describeOptionValue(value: unknown): string {
  if (value === UNREADABLE_OPTIONS) {
    return "a container this compiler cannot read (not an object, or reading it threw)";
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // A BigInt, a cycle, or a value whose own `toJSON` throws.
  }
  return `a value of type ${typeof value}, which cannot be printed`;
}

export function isActionEvent(event: HistoryEvent): event is ActionEvent {
  return event.kind === "action";
}

export function isCapabilityChangeEvent(event: HistoryEvent): event is CapabilityChangeEvent {
  return event.kind === "capability_change";
}

/** Every action id `history` performed, deduplicated and sorted. */
export function doneActionIds(history: readonly HistoryEvent[]): ActionId[] {
  const ids: string[] = [];
  for (const event of history) {
    if (event.kind === "action") ids.push(event.actionId);
  }
  return sortedUnique(ids);
}

/* ------------------------------------------------------------------ */
/* Small set/list helpers                                              */
/* ------------------------------------------------------------------ */

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function isSubset(needles: readonly string[], haystack: ReadonlySet<string>): boolean {
  for (const n of needles) {
    if (!haystack.has(n)) return false;
  }
  return true;
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) {
    if (!sb.has(v)) return false;
  }
  return true;
}

/**
 * Canonical form. `flags` and `tokens` are sets, so their order never matters
 * and duplicates collapse. `history` is a log -- order is the whole point of it
 * -- so it is only cloned, never sorted or deduplicated.
 */
export function normalizeState(state: State): State {
  return {
    flags: sortedUnique(state.flags),
    tokens: sortedUnique(state.tokens),
    history: [...state.history],
  };
}

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

export function roleById(puzzle: Puzzle, id: RoleId): Role | undefined {
  return puzzle.roles.find((r) => r.id === id);
}

export function actionById(puzzle: Puzzle, id: ActionId): Action | undefined {
  return puzzle.actions.find((a) => a.id === id);
}

export function roleHas(role: Role, capability: Capability): boolean {
  return role.capabilities.includes(capability);
}

/** The first role in puzzle order that has `capability`; deterministic tie-break. */
export function firstCapableRole(puzzle: Puzzle, capability: Capability): Role | undefined {
  return puzzle.roles.find((r) => roleHas(r, capability));
}

/**
 * Everything the team collectively knows before doing anything: the state's own
 * tokens plus every private token of every present role (holders speak up).
 */
export function knownTokensAtStart(puzzle: Puzzle, state: State): Set<string> {
  const tokens = new Set<string>(state.tokens);
  for (const role of puzzle.roles) {
    for (const t of role.privateTokens) tokens.add(t);
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Puzzle rewrites (used by the recompiler; kept here so the model       */
/* stays the single place that knows the shape of a Puzzle)              */
/* ------------------------------------------------------------------ */

export function cloneAction(action: Action): Action {
  const copy: Action = {
    id: action.id,
    performer: action.performer,
    needs: action.needs,
    requiresTokens: [...action.requiresTokens],
    requiresFlags: [...action.requiresFlags],
    producesTokens: [...action.producesTokens],
    setsFlags: [...action.setsFlags],
  };
  if (action.options !== undefined) copy.options = action.options;
  if (action.answerToken !== undefined) copy.answerToken = action.answerToken;
  if (action.label !== undefined) copy.label = action.label;
  return copy;
}

export function clonePuzzle(puzzle: Puzzle): Puzzle {
  return {
    id: puzzle.id,
    roles: puzzle.roles.map((r) => ({
      id: r.id,
      capabilities: [...r.capabilities],
      privateTokens: [...r.privateTokens],
    })),
    actions: puzzle.actions.map(cloneAction),
    goalFlags: [...puzzle.goalFlags],
    primitives: puzzle.primitives.map((p) => ({ ...p })),
  };
}

/** Replace `actionId` with `replacements`, in place, preserving action order. */
export function replaceActions(puzzle: Puzzle, actionId: ActionId, replacements: Action[]): Puzzle {
  const next = clonePuzzle(puzzle);
  const index = next.actions.findIndex((a) => a.id === actionId);
  if (index < 0) throw new Error(`replaceActions: unknown action ${actionId}`);
  next.actions.splice(index, 1, ...replacements);
  return next;
}

export function withRoleCapabilities(
  puzzle: Puzzle,
  roleId: RoleId,
  capabilities: Capability[],
): Puzzle {
  const next = clonePuzzle(puzzle);
  const role = next.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`withRoleCapabilities: unknown role ${roleId}`);
  role.capabilities = [...capabilities];
  return next;
}

/**
 * Counterfactual: the puzzle as it would be if this role had never joined.
 * The role is gone, everything only that role could do is gone, and so are the
 * facts only that role could see.
 *
 * A generic (`performer: "any"`) action is NOT "something only that role could
 * do": any capable role can perform it, so it stays. Filtering on
 * `performer !== roleId` would delete every generic action the moment a role
 * is named `"any"` -- a false necessity proof. `validatePuzzle` rejects a
 * role named `"any"` outright, and this predicate is written so that the two
 * sentinel meanings cannot be confused even on an unvalidated puzzle.
 */
export function removeRole(puzzle: Puzzle, roleId: RoleId): Puzzle {
  const isGeneric = (a: Action): boolean => a.performer === NO_ROLE;
  return {
    id: `${puzzle.id}~without:${roleId}`,
    roles: puzzle.roles.filter((r) => r.id !== roleId).map((r) => ({
      id: r.id,
      capabilities: [...r.capabilities],
      privateTokens: [...r.privateTokens],
    })),
    actions: puzzle.actions
      .filter((a) => isGeneric(a) || a.performer !== roleId)
      .map(cloneAction),
    goalFlags: [...puzzle.goalFlags],
    primitives: puzzle.primitives.map((p) => ({ ...p })),
  };
}

/** Stable identity of a whole puzzle, for visited-sets and diffs. */
export function puzzleKey(puzzle: Puzzle): string {
  return canonicalStringify({
    roles: puzzle.roles,
    actions: puzzle.actions,
    goalFlags: puzzle.goalFlags,
    primitives: puzzle.primitives,
  });
}
