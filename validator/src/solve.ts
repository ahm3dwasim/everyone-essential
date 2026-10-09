/**
 * Bounded breadth-first search over puzzle states.
 *
 * State is monotone: doing an action never takes a token or a flag away, and an
 * action can only be done once. So the reachable set is a finite lattice, BFS
 * gives a shortest witness plan, and the visited set makes the search exact.
 *
 * Determinism: actions are expanded in `puzzle.actions` order, and an `"any"`
 * action is credited to the first role in `puzzle.roles` order that has the
 * capability. Same input -> byte-identical output.
 */
import {
  type Action,
  type ActionId,
  type Capability,
  type HistoryEvent,
  type Puzzle,
  type RoleId,
  type State,
  doneActionIds,
  firstCapableRole,
  isSubset,
  roleById,
  roleHas,
  normalizeState,
  knownTokensAtStart,
  describeOptionValue,
  optionField,
} from "./model";
import { canonicalStringify } from "./hash";

export interface PlanStep {
  /** 1-based position in the plan. */
  step: number;
  action: ActionId;
  /** The concrete role the plan credits. Never `"any"`. */
  performer: RoleId;
  needs: Capability;
  label: string;
}

export interface SolveResult {
  status: "solvable" | "unsolvable" | "invalid_options";
  /** Empty when unsolvable or when the options were invalid. */
  plan: PlanStep[];
  /** Number of distinct reachable states the search touched, including the start state. */
  statesExplored: number;
  /**
   * True when the state cap was hit before the search finished. A truncated
   * "unsolvable" is NOT a proof of unsolvability -- callers must check this.
   */
  truncated: boolean;
  /** Set only when `status === "invalid_options"`. */
  reason?: string;
}

export interface SolveOptions {
  /**
   * Hard cap on states allocated. Default 500_000.
   *
   * "Hard" is meant literally and is checked at **insertion**. Checking it
   * only before expanding the next queued node lets the node being expanded
   * add every one of its children first: a legal one-role puzzle with 128
   * independent actions and `maxStates: 1` then allocates 129 states, which
   * defeats the bound exactly where it is supposed to protect.
   *
   * Must be a positive integer when given at all. The portable build is plain
   * JavaScript, so nothing stops a caller from passing `NaN` or a string at
   * runtime -- and every numeric comparison below is silently false against
   * `NaN`, which disables the cap rather than enforcing it. `solve` refuses
   * such a value outright instead of running unbounded.
   */
  maxStates?: number;
}

const DEFAULT_MAX_STATES = 500_000;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

interface Node {
  flags: Set<string>;
  tokens: Set<string>;
  done: Set<string>;
  key: string;
  parent: number;
  viaAction: Action | null;
  viaRole: RoleId | null;
}

/**
 * The visited-set key for a state.
 *
 * Concatenating the three sorted sets with U+0001/U+0002 separators aliases
 * distinct states the moment an id contains one of those characters: a flag "x\u0002y" and the pair flags ["x"], tokens ["y\u0002"]
 * produce the same key. A visited-set collision silently discards a reachable
 * state, so the advertised exact-BFS guarantee would not hold for legal id
 * strings.
 *
 * Canonical JSON is unambiguous by construction -- every element is quoted and
 * escaped and the array boundaries are explicit -- so no two distinct states can
 * share a key. Sorted first so array order stays irrelevant.
 *
 * Exported because "distinct states have distinct keys" is worth testing
 * directly, not only through a puzzle that happens to trip it.
 */
export function stateKey(flags: Set<string>, tokens: Set<string>, done: Set<string>): string {
  return canonicalStringify([[...flags].sort(), [...tokens].sort(), [...done].sort()]);
}

const keyOf = stateKey;

/**
 * Search for a shortest ordered plan from `state` to `puzzle.goalFlags`.
 * Bounded, deterministic, exact unless `truncated` is set on the result.
 */
export function solve(puzzle: Puzzle, state: State, options: SolveOptions = {}): SolveResult {
  // Read through `optionField`, not through `options.maxStates`: the parameter
  // is typed, but this is a public function reached from JavaScript, and a
  // `null` container must be refused with `invalid_options` rather than throw a
  // `TypeError` out of the gate. Every caller folds that status into an unproven
  // result already; no caller can fold a throw.
  const requestedMaxStates = optionField(options, "maxStates");
  if (requestedMaxStates !== undefined && !isPositiveInteger(requestedMaxStates)) {
    return {
      status: "invalid_options",
      plan: [],
      statesExplored: 0,
      truncated: false,
      reason: `maxStates must be a positive integer, got ${describeOptionValue(requestedMaxStates)}`,
    };
  }
  const maxStates = isPositiveInteger(requestedMaxStates) ? requestedMaxStates : DEFAULT_MAX_STATES;
  const goalFlags = puzzle.goalFlags;
  const normalized = normalizeState(state);

  const startFlags = new Set(normalized.flags);
  const startTokens = knownTokensAtStart(puzzle, normalized);
  const startDone = new Set(doneActionIds(normalized.history));

  if (isSubset(goalFlags, startFlags)) {
    return { status: "solvable", plan: [], statesExplored: 1, truncated: false };
  }

  const startKey = keyOf(startFlags, startTokens, startDone);
  // The start state is the first allocation, so a cap that cannot hold it stops
  // the search before anything is expanded. `statesExplored` still reports it:
  // the start state is a state the search touched.
  if (1 > maxStates) {
    return { status: "unsolvable", plan: [], statesExplored: 1, truncated: true };
  }

  const nodes: Node[] = [
    {
      flags: startFlags,
      tokens: startTokens,
      done: startDone,
      key: startKey,
      parent: -1,
      viaAction: null,
      viaRole: null,
    },
  ];
  const visited = new Set<string>([startKey]);

  for (let head = 0; head < nodes.length; head++) {
    const node = nodes[head]!;

    for (const action of puzzle.actions) {
      if (node.done.has(action.id)) continue;
      if (!isSubset(action.requiresTokens, node.tokens)) continue;
      if (!isSubset(action.requiresFlags, node.flags)) continue;

      const performer = resolvePerformer(puzzle, action);
      if (performer === null) continue;

      const flags = new Set(node.flags);
      for (const f of action.setsFlags) flags.add(f);
      const tokens = new Set(node.tokens);
      for (const t of action.producesTokens) tokens.add(t);
      const done = new Set(node.done);
      done.add(action.id);

      const key = keyOf(flags, tokens, done);
      if (visited.has(key)) continue;

      // The cap is on states ALLOCATED, so it is enforced here -- before the
      // state is added to the visited set or the queue -- rather than before the
      // next expansion. A child that would exceed the cap ends the search
      // instead of being stored.
      if (visited.size + 1 > maxStates) {
        return { status: "unsolvable", plan: [], statesExplored: visited.size, truncated: true };
      }
      visited.add(key);

      const child: Node = { flags, tokens, done, key, parent: head, viaAction: action, viaRole: performer };

      if (isSubset(goalFlags, flags)) {
        return {
          status: "solvable",
          plan: buildPlan(nodes, child),
          statesExplored: visited.size,
          truncated: false,
        };
      }
      nodes.push(child);
    }
  }

  return { status: "unsolvable", plan: [], statesExplored: visited.size, truncated: false };
}

/**
 * Which role the plan credits for this action, or null if nobody present can do
 * it. An action naming a role that is not in `puzzle.roles` (because the role
 * was removed for a counterfactual) is unperformable.
 */
export function resolvePerformer(puzzle: Puzzle, action: Action): RoleId | null {
  if (action.performer === "any") {
    return firstCapableRole(puzzle, action.needs)?.id ?? null;
  }
  const role = roleById(puzzle, action.performer);
  if (!role) return null;
  return roleHas(role, action.needs) ? role.id : null;
}

function buildPlan(nodes: Node[], goal: Node): PlanStep[] {
  const backwards: { action: Action; performer: RoleId }[] = [];
  let cursor: Node | undefined = goal;
  while (cursor && cursor.viaAction && cursor.viaRole) {
    backwards.push({ action: cursor.viaAction, performer: cursor.viaRole });
    cursor = cursor.parent >= 0 ? nodes[cursor.parent] : undefined;
  }
  backwards.reverse();
  return backwards.map((entry, index) => ({
    step: index + 1,
    action: entry.action.id,
    performer: entry.performer,
    needs: entry.action.needs,
    label: entry.action.label ?? entry.action.id,
  }));
}

/**
 * The state reached by following the first `count` steps of a plan. Used to
 * build the demo's midpoint and to check that progress is preserved.
 */
export function applyPlan(puzzle: Puzzle, state: State, plan: readonly PlanStep[], count: number): State {
  const normalized = normalizeState(state);
  const flags = new Set(normalized.flags);
  // Only facts the team acquired. Private tokens are not stored in the state --
  // the solver re-derives them from which roles are present.
  const tokens = new Set(normalized.tokens);
  const history: HistoryEvent[] = [...normalized.history];
  for (const step of plan.slice(0, count)) {
    const action = puzzle.actions.find((a) => a.id === step.action);
    if (!action) throw new Error(`applyPlan: unknown action ${step.action}`);
    for (const f of action.setsFlags) flags.add(f);
    for (const t of action.producesTokens) tokens.add(t);
    history.push({ kind: "action", actionId: action.id, performer: step.performer, capability: step.needs });
  }
  return {
    flags: [...flags].sort(),
    tokens: [...tokens].sort(),
    history,
  };
}
