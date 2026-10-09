/**
 * Input validation: the gate every public entry point passes through before it
 * is allowed to certify anything.
 *
 * The point is not defensive programming for its own sake. Accepting whatever
 * the caller hands over makes two whole classes of false certificate
 * possible: a role literally named `"any"` collided with the generic-performer
 * sentinel, and a caller-asserted state could name actions that were never
 * performed or hold tokens nobody ever produced. A certificate is only a proof
 * about a puzzle that means something, so "does this puzzle mean something" is
 * checked first and separately.
 *
 * `validatePuzzle` answers a malformed *shape* with a typed error: a value that
 * is not an object, or an object with a missing or mistyped field, comes back as
 * `ok: false` and the caller can show the author what is wrong. It is not total
 * over runtime input, though -- an object whose property reads throw (a revoked
 * `Proxy`, a throwing getter) passes that throw on to the caller.
 */
import {
  type Action,
  type ActionId,
  type Capability,
  type Primitive,
  type Puzzle,
  type State,
  PROGRESS_MARKER,
  RESERVED_PREFIX,
  STEP_MARKER,
  isReservedId,
  isSubset,
  normalizeState,
  parseGeneratedActionId,
  sameSet,
  sortedUnique,
} from "./model";
export { RESERVED_PREFIX, isReservedId, parseGeneratedActionId } from "./model";
import { chainRoundTrips } from "./convert";

/** The capabilities the model knows about. Anything else is a typo, not a new input mode. */
export const KNOWN_CAPABILITIES: readonly Capability[] = ["dpad", "scan", "voice"];

export interface ValidationIssue {
  kind:
    | "reserved_id"
    | "duplicate_id"
    | "empty_id"
    | "unknown_capability"
    | "invalid_options"
    | "missing_answer_token"
    | "unknown_action"
    | "unproduced_flag"
    | "unproduced_token"
    | "no_goal"
    /** A field is missing, null, or the wrong type for the model. */
    | "malformed_input"
    /**
     * A history event could not have happened as declared: wrong performer,
     * wrong or unheld capability, a prerequisite not yet known, an action
     * repeated, or a `capability_change` whose `from` does not match what was
     * actually replayed up to that point.
     */
    | "invalid_history"
    /** The replayed history does not produce exactly the facts the state declares. */
    | "unreachable_state";
  /** The offending action, when the issue is about one. */
  action: string | null;
  /** The offending role, when the issue is about one. */
  role: string | null;
  /** One line, phrased for a puzzle author. */
  detail: string;
}

export interface ValidationOk {
  ok: true;
  errors: [];
}

export interface ValidationFailed {
  ok: false;
  errors: ValidationIssue[];
}

export type ValidationResult = ValidationOk | ValidationFailed;

/** The shape every public entry point returns instead of a certificate when its input is not a puzzle. */
export interface ValidationError {
  kind: "invalid_puzzle";
  /** True when the problem is the caller's state rather than the puzzle itself. */
  stateInvalid: boolean;
  errors: ValidationIssue[];
  reason: string;
}

function issue(
  kind: ValidationIssue["kind"],
  detail: string,
  where: { action?: string; role?: string } = {},
): ValidationIssue {
  return { kind, action: where.action ?? null, role: where.role ?? null, detail };
}

function checkId(
  id: string,
  what: string,
  seen: Map<string, number>,
  errors: ValidationIssue[],
  counter: { n: number },
  /**
   * True for action ids only: an action id in the reserved namespace is not a
   * blanket refusal, because a generated split-chain step legitimately lives
   * there. `validateGeneratedNamespace` is the actual gate for those; skipping
   * the blanket check here just avoids double-reporting the same id.
   */
  skipReservedCheck: boolean,
): void {
  if (typeof id !== "string" || id.length === 0) {
    errors.push(issue("empty_id", `${what} has an empty id`));
    return;
  }
  if (isReservedId(id) && !skipReservedCheck) {
    errors.push(
      issue("reserved_id", `${what} id "${id}" uses the reserved "${RESERVED_PREFIX}" namespace`),
    );
  }
  const previous = seen.get(id);
  if (previous !== undefined) {
    errors.push(issue("duplicate_id", `${what} id "${id}" appears more than once`));
  } else {
    seen.set(id, counter.n++);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/* ------------------------------------------------------------------ */
/* The reserved namespace: legal ONLY as the generator's exact shape    */
/* ------------------------------------------------------------------ */

/**
 * A `{ generated: true }` flag that disabled every reserved-namespace check
 * at once would be a bypass, not an option: any author puzzle whose ids start
 * with `§` would reach a positive certificate through a second door.
 *
 * There is no such flag. A `§`-prefixed id is legal input, but ONLY in the
 * exact structural shape `convertAction` emits: an action id
 * `§<origId>__step<k>`, or a token id `§<origId>__progress<k>`, where the full
 * step chain for `<origId>` is complete and consecutive from 1, and `<origId>`
 * does not also exist as an un-split action. This makes a repaired puzzle's
 * ids ordinary, verifiable input: `certify` is the only certification
 * function there is, and it validates every puzzle it is given, generated or
 * not.
 *
 * Hand-listing the ways a chain can disagree with itself and still slip past
 * -- one performer, one capability, one answer token -- never terminates:
 * uneven breadth between steps, and a requirement or a flag smuggled onto a
 * middle link, each need another rule. So there is no list. A chain past the structural checks above is legal ONLY if
 * it round-trips: `chainRoundTrips` (in `convert.ts`) recovers the logical
 * action it stands for and re-runs the REAL `convertAction` with it, and the
 * chain is accepted only if that reproduces it exactly, field for field. Any
 * way a hand-built chain could disagree with what the generator would
 * actually produce is caught by this the same way, because it is the same
 * check -- there is no separate rule per field left to fall behind the next
 * counterexample.
 */
interface GeneratedActionEntry {
  id: ActionId;
  /** Null when the field is missing or not a string -- reported by the action loop itself. */
  performer: string | null;
  /** Null when the field is missing or not a string -- reported by the action loop itself. */
  needs: string | null;
  /** Normalised the same way `convertAction` reads it: absent means one option. */
  options: number;
  /** Null when absent or not a non-empty string. */
  answerToken: string | null;
  /** Null when absent -- reported as `malformed_input` if present and not a string. */
  label: string | null;
  requiresTokens: string[];
  requiresFlags: string[];
  producesTokens: string[];
  setsFlags: string[];
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function describeActionSet(actions: ReadonlySet<string>): string {
  return actions.size ? [...actions].sort().join(", ") : "nothing";
}

/**
 * The gate for every `§`-prefixed action or token id in the puzzle. Called
 * once, after every action's shape is known, with `allActionIds` holding
 * every action id seen (reserved or not) so an "also exists un-split" check
 * can be made.
 */
function validateGeneratedNamespace(
  actions: readonly GeneratedActionEntry[],
  allActionIds: ReadonlySet<ActionId>,
  primitives: readonly Primitive[],
  errors: ValidationIssue[],
): void {
  // --- group reserved action ids into step chains, by origId -----------
  const chains = new Map<string, Map<number, ActionId>>();
  for (const action of actions) {
    if (!isReservedId(action.id)) continue;
    const parsed = parseGeneratedActionId(action.id);
    if (!parsed) {
      errors.push(
        issue(
          "reserved_id",
          `action id "${action.id}" uses the reserved "${RESERVED_PREFIX}" namespace but is not a generated split-chain step (expected "${RESERVED_PREFIX}<id>${STEP_MARKER}<k>")`,
          { action: action.id },
        ),
      );
      continue;
    }
    let byStep = chains.get(parsed.origId);
    if (!byStep) {
      byStep = new Map();
      chains.set(parsed.origId, byStep);
    }
    byStep.set(parsed.step, action.id);
  }

  // --- a chain must be complete, consecutive from 1, and not shadow an  --
  // --- un-split action of the same id -----------------------------------
  const entryById = new Map<ActionId, GeneratedActionEntry>(actions.map((a) => [a.id, a]));
  const validChains = new Map<string, number>(); // origId -> chain length
  for (const [origId, byStep] of chains) {
    const steps = [...byStep.keys()].sort((a, b) => a - b);
    const consecutive = steps.every((s, i) => s === i + 1);
    // `convertAction` only ever splits a choice that does not already fit in
    // one step, and its splitting loop starts at 1 and increments until it
    // fits -- so a real chain is always at least 2 steps. A lone
    // "§x__step1" is not something the generator ever emits; refusing it
    // keeps the accepted shape an exact match rather than a superset of it.
    if (consecutive && steps.length < 2) {
      for (const id of byStep.values()) {
        errors.push(
          issue(
            "reserved_id",
            `generated step "${id}" is a one-step "chain" for "${origId}"; the generator never splits a choice into fewer than two steps`,
            { action: id },
          ),
        );
      }
      continue;
    }
    if (!consecutive) {
      for (const id of byStep.values()) {
        errors.push(
          issue(
            "reserved_id",
            `generated step "${id}" is part of an incomplete or non-consecutive chain for "${origId}" (found steps [${steps.join(", ")}])`,
            { action: id },
          ),
        );
      }
      continue;
    }
    if (allActionIds.has(origId)) {
      for (const id of byStep.values()) {
        errors.push(
          issue(
            "reserved_id",
            `generated step chain "${RESERVED_PREFIX}${origId}${STEP_MARKER}*" exists alongside an un-split action "${origId}", which the generator never produces at the same time`,
            { action: id },
          ),
        );
      }
      continue;
    }
    // --- the chain is legal ONLY if it round-trips through the real -------
    // --- generator: recover the logical action it stands for and re-run --
    // --- `convertAction`; the chain is accepted only if that reproduces it
    // --- exactly. See the doc comment above `GeneratedActionEntry` for why
    // --- a round trip through the real generator, not a hand-listed set of
    // --- per-field rules, is what decides it.
    //
    // A chain refused here still counts as a chain for the progress-token
    // checks below: its wiring is checked (and reported) as well, rather than
    // a round-trip failure burying it under "not a valid generated progress
    // token" noise.
    const stepEntries = steps
      .map((step) => entryById.get(byStep.get(step)!))
      .filter((e): e is GeneratedActionEntry => e !== undefined);
    const canRoundTrip = stepEntries.length === steps.length && stepEntries.every((e) => e.performer !== null && e.needs !== null);
    if (canRoundTrip) {
      const stepActions: Action[] = stepEntries.map((e) => {
        const step: Action = {
          id: e.id,
          performer: e.performer as string,
          needs: e.needs as Capability,
          requiresTokens: e.requiresTokens,
          requiresFlags: e.requiresFlags,
          producesTokens: e.producesTokens,
          setsFlags: e.setsFlags,
          options: e.options,
        };
        if (e.answerToken !== null) step.answerToken = e.answerToken;
        if (e.label !== null) step.label = e.label;
        return step;
      });
      if (!chainRoundTrips(origId, stepActions, primitives)) {
        for (const id of byStep.values()) {
          errors.push(
            issue(
              "reserved_id",
              `generated split chain "${RESERVED_PREFIX}${origId}${STEP_MARKER}*" is not exactly what "convertAction" would produce: recovering the logical action it stands for and re-running the generator does not reproduce these steps`,
              { action: id },
            ),
          );
        }
      }
    } else {
      // A malformed performer or capability on one of the steps is already
      // reported by the action loop that built this entry; the chain cannot
      // be round-tripped at all without them, so it is refused here too.
      for (const id of byStep.values()) {
        errors.push(
          issue(
            "reserved_id",
            `generated split chain "${RESERVED_PREFIX}${origId}${STEP_MARKER}*" cannot be checked against the generator: one of its steps has a malformed performer or capability`,
            { action: id },
          ),
        );
      }
    }
    validChains.set(origId, steps.length);
  }

  // --- every reserved token must be exactly one chain's progress wiring -
  const producers = new Map<string, Set<string>>();
  const consumers = new Map<string, Set<string>>();
  for (const action of actions) {
    for (const t of action.producesTokens) if (isReservedId(t)) addToSetMap(producers, t, action.id);
    for (const t of action.requiresTokens) if (isReservedId(t)) addToSetMap(consumers, t, action.id);
  }

  const expectedTokens = new Set<string>();
  for (const [origId, length] of validChains) {
    for (let i = 1; i < length; i++) {
      const token = `${RESERVED_PREFIX}${origId}${PROGRESS_MARKER}${i}`;
      expectedTokens.add(token);
      const expectedProducer = `${RESERVED_PREFIX}${origId}${STEP_MARKER}${i}`;
      const expectedConsumer = `${RESERVED_PREFIX}${origId}${STEP_MARKER}${i + 1}`;
      const producedBy = producers.get(token) ?? new Set<string>();
      const consumedBy = consumers.get(token) ?? new Set<string>();
      if (producedBy.size !== 1 || !producedBy.has(expectedProducer)) {
        errors.push(
          issue(
            "reserved_id",
            `progress token "${token}" must be produced by exactly "${expectedProducer}" (actually produced by: ${describeActionSet(producedBy)})`,
          ),
        );
      }
      if (consumedBy.size !== 1 || !consumedBy.has(expectedConsumer)) {
        errors.push(
          issue(
            "reserved_id",
            `progress token "${token}" must be required by exactly "${expectedConsumer}" (actually required by: ${describeActionSet(consumedBy)})`,
          ),
        );
      }
    }
  }

  // Any reserved token that is not one of the expected progress tokens above
  // -- garbage shaped like one, one with an out-of-range index, one whose
  // chain never validated, or one wired to more or fewer actions than its
  // chain allows -- is refused outright, whether or not it happens to parse.
  const allReservedTokens = new Set<string>([...producers.keys(), ...consumers.keys()]);
  for (const token of allReservedTokens) {
    if (expectedTokens.has(token)) continue;
    errors.push(
      issue(
        "reserved_id",
        `token "${token}" uses the reserved "${RESERVED_PREFIX}" namespace but is not a valid generated progress token`,
      ),
    );
  }
}

/**
 * Shape probes.
 *
 * The portable build is plain JavaScript: nothing enforces these types at
 * runtime, so every dereference below has to be earned first. Checking the
 * *contents* of the puzzle while assuming its *shape* makes `certify` on a
 * puzzle with `roles: null` throw a TypeError instead of returning the typed
 * refusal it promises. A refusal a caller cannot receive is not a refusal.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCounter(): { n: number } {
  return { n: 0 };
}

/** A short, safe rendering of a value of unknown type, for a shape message. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "object") return "an object";
  return String(value);
}

/**
 * Every structural rule the rest of the compiler relies on.
 *
 * Called first by `certify` and `recompile`. `validateState` is called after it,
 * and depends on the puzzle being well-formed.
 */
export function validatePuzzle(puzzle: Puzzle): ValidationResult {
  const errors: ValidationIssue[] = [];
  const counter = createCounter();

  if (!isRecord(puzzle)) {
    return {
      ok: false,
      errors: [issue("malformed_input", `expected a puzzle object, got ${describeValue(puzzle)}`)],
    };
  }

  // --- shape ---------------------------------------------------------
  // Checked before anything is dereferenced or iterated. Each missing or
  // wrong-typed collection collects one issue and is skipped, so one bad field
  // does not hide every other problem in the puzzle.
  const complain = (what: string, got: unknown, expected: string): void => {
    errors.push(issue("malformed_input", `${what} must be ${expected}, got ${describeValue(got)}`));
  };
  const isText = (value: unknown): value is string => typeof value === "string";
  // `Array.isArray` on an `unknown` primitive narrows to `any[]`, which would
  // quietly disable checking on the elements; this keeps them `unknown`.
  const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

  const roles = puzzle.roles;
  const actions = puzzle.actions;
  const primitives = puzzle.primitives;
  const rolesOk = isArray(roles);
  const actionsOk = isArray(actions);
  const primitivesOk = isArray(primitives);
  if (!rolesOk) complain("puzzle.roles", roles, "an array of roles");
  if (!actionsOk) complain("puzzle.actions", actions, "an array of actions");
  if (!primitivesOk) complain("puzzle.primitives", primitives, "an array of primitives");

  // `puzzle.id` is required: an unchecked id would surface later as a
  // certificate whose `puzzleId` is `undefined`, rather than as this refusal.
  if (puzzle.id === undefined) {
    errors.push(issue("malformed_input", "puzzle.id is required and must be a non-empty string"));
  } else if (!isText(puzzle.id)) {
    // Reported here rather than by `shape` so the message names the field the
    // way an author wrote it.
    errors.push(issue("malformed_input", `puzzle.id must be a string, got ${describeValue(puzzle.id)}`));
  } else if (puzzle.id.length === 0) {
    errors.push(issue("empty_id", "puzzle has an empty id"));
  }

  // --- roles ---------------------------------------------------------
  const roleIds = new Map<string, number>();
  const roleList: unknown[] = rolesOk ? roles : [];
  const tokenOwners = new Map<string, string>();
  for (let index = 0; index < roleList.length; index++) {
    const entry: unknown = roleList[index];
    // A role id is the one field every later message wants; without it the
    // position is all a caller can be told, so it is named by index.
    if (!isRecord(entry)) {
      complain(`roles[${index}]`, entry, "an object");
      continue;
    }
    if (!isText(entry.id)) {
      complain(`roles[${index}].id`, entry.id, "a string");
      continue;
    }
    const roleId: string = entry.id;
    checkId(roleId, "role", roleIds, errors, counter, false);
    if (roleId === "any") {
      errors.push(
        issue(
          "reserved_id",
          `role id "any" is reserved: it is the generic-performer sentinel, not a name a role may use`,
          { role: roleId },
        ),
      );
    }
    const capabilities = entry.capabilities;
    if (!isArray(capabilities)) {
      complain(`capabilities of role "${roleId}"`, capabilities, "an array");
      continue;
    }
    for (const capability of capabilities) {
      if (!isText(capability) || !KNOWN_CAPABILITIES.includes(capability as Capability)) {
        errors.push(
          issue("unknown_capability", `role "${roleId}" declares unknown capability "${describeValue(capability)}"`, {
            role: roleId,
          }),
        );
      }
    }
    const privateTokens = entry.privateTokens;
    if (privateTokens === undefined) {
      errors.push(
        issue("malformed_input", `role "${roleId}" is missing required field "privateTokens"`, { role: roleId }),
      );
      continue;
    }
    if (!isArray(privateTokens)) {
      complain(`privateTokens of role "${roleId}"`, privateTokens, "an array");
      continue;
    }
    for (const token of privateTokens) {
      if (!isText(token) || token.length === 0) {
        errors.push(
          issue("empty_id", `role "${roleId}" has a private token with an empty id`, { role: roleId }),
        );
        continue;
      }
      // A private token is never generated -- the recompiler only invents
      // action ids and progress tokens -- so the reserved namespace is refused
      // here unconditionally.
      if (isReservedId(token)) {
        errors.push(
          issue("reserved_id", `private token "${token}" of role "${roleId}" uses the reserved namespace`, {
            role: roleId,
          }),
        );
      }
      const owner = tokenOwners.get(token);
      if (owner !== undefined) {
        errors.push(
          issue("duplicate_id", `token "${token}" is private to both "${owner}" and "${roleId}"`, {
            role: roleId,
          }),
        );
      } else {
        tokenOwners.set(token, roleId);
      }
    }
  }

  // --- primitives ----------------------------------------------------
  // `primitiveIds` is built ONCE, outside the loop: a `new Map()` per iteration
  // can never see a previous entry, so two primitives sharing an id would sail
  // through as if each were the first.
  const primitiveList: unknown[] = primitivesOk ? primitives : [];
  const primitiveIds = new Map<string, number>();
  // Every well-formed primitive, gathered alongside the shape checks below --
  // this is what the round-trip check in `validateGeneratedNamespace` tries
  // `convertAction` against. A malformed primitive is simply left out of it:
  // its own shape errors are already reported above, and excluding it from
  // the round-trip search only means a chain that could otherwise only be
  // reproduced through THAT primitive is refused, which is the safe side to
  // fail on for garbage input.
  const validPrimitives: Primitive[] = [];
  for (let index = 0; index < primitiveList.length; index++) {
    const entry: unknown = primitiveList[index];
    if (!isRecord(entry)) {
      complain(`primitives[${index}]`, entry, "an object");
      continue;
    }
    if (!isText(entry.id)) {
      complain(`primitives[${index}].id`, entry.id, "a string");
      continue;
    }
    checkId(entry.id, "primitive", primitiveIds, errors, counter, false);
    const capabilityOk = isText(entry.capability) && KNOWN_CAPABILITIES.includes(entry.capability as Capability);
    if (!capabilityOk) {
      errors.push(
        issue(
          "unknown_capability",
          `primitive "${entry.id}" targets unknown capability "${describeValue(entry.capability)}"`,
        ),
      );
    }
    const maxOptionsOk = isPositiveInteger(entry.maxOptions);
    if (!maxOptionsOk) {
      errors.push(issue("invalid_options", `primitive "${entry.id}" has a non-positive maxOptions`));
    }
    const splittableOk = typeof entry.splittable === "boolean";
    if (!splittableOk) {
      complain(`splittable of primitive "${entry.id}"`, entry.splittable, "a boolean");
    }
    if (!isText(entry.label)) {
      complain(`label of primitive "${entry.id}"`, entry.label, "a string");
    }
    if (capabilityOk && maxOptionsOk && splittableOk) {
      validPrimitives.push({
        id: entry.id,
        capability: entry.capability as Capability,
        maxOptions: entry.maxOptions as number,
        splittable: entry.splittable as boolean,
        label: isText(entry.label) ? entry.label : entry.id,
      });
    }
  }

  // --- actions -------------------------------------------------------
  const actionIds = new Map<string, number>();
  const actionList: unknown[] = actionsOk ? actions : [];
  const generatedActionEntries: GeneratedActionEntry[] = [];
  for (let index = 0; index < actionList.length; index++) {
    const entry: unknown = actionList[index];
    if (!isRecord(entry)) {
      complain(`actions[${index}]`, entry, "an object");
      continue;
    }
    if (!isText(entry.id)) {
      complain(`actions[${index}].id`, entry.id, "a string");
      continue;
    }
    const actionId: string = entry.id;
    // Action ids skip the blanket reserved-namespace check: a generated
    // split-chain step legitimately lives there, and `validateGeneratedNamespace`
    // (below, once every action's shape is known) is what actually gates it.
    checkId(actionId, "action", actionIds, errors, counter, true);
    const performer = entry.performer;
    if (!isText(performer) || (performer !== "any" && !roleIds.has(performer))) {
      errors.push(
        issue("unknown_action", `action "${actionId}" names unknown performer "${describeValue(performer)}"`, {
          action: actionId,
        }),
      );
    }
    if (!isText(entry.needs) || !KNOWN_CAPABILITIES.includes(entry.needs as Capability)) {
      errors.push(
        issue("unknown_capability", `action "${actionId}" needs unknown capability "${describeValue(entry.needs)}"`, {
          action: actionId,
        }),
      );
    }
    if (entry.options !== undefined && !isPositiveInteger(entry.options)) {
      errors.push(
        issue(
          "invalid_options",
          `action "${actionId}" declares options: ${describeValue(entry.options)}; it must be a positive integer (1 = no choice)`,
          { action: actionId },
        ),
      );
    }
    // `label` is display text, never read by the solver -- but a generated
    // step's label is part of what `convertAction` reproduces exactly, so a
    // non-string value has to be caught here, the same as every other
    // action field, rather than reaching the round trip or a later template
    // interpolation as an untyped value.
    if (entry.label !== undefined && !isText(entry.label)) {
      errors.push(
        issue(
          "malformed_input",
          `action "${actionId}" declares label: ${describeValue(entry.label)}; it must be a string when present`,
          { action: actionId },
        ),
      );
    }
    validateChoice(entry as unknown as Action, errors);

    // Every one of these four is a REQUIRED field on `Action`. Defaulting a
    // missing one to `[]` lets `certify` reach a solver that assumes the field
    // exists and throw. A missing field is a shape error, not an implied empty
    // list.
    const requiresTokens = requiredArrayField(entry, "requiresTokens", actionId, errors, complain);
    const producesTokens = requiredArrayField(entry, "producesTokens", actionId, errors, complain);
    const requiresFlags = requiredArrayField(entry, "requiresFlags", actionId, errors, complain);
    const setsFlags = requiredArrayField(entry, "setsFlags", actionId, errors, complain);

    // Tokens: reserved ids are legal here in the exact shape the generator
    // emits (a split-chain progress token), so the reserved check is deferred
    // to `validateGeneratedNamespace` below; only emptiness is checked now.
    for (const list of [requiresTokens, producesTokens]) {
      for (const id of list ?? []) {
        if (!isText(id) || id.length === 0) {
          errors.push(
            issue("empty_id", `action "${actionId}" has an empty token id`, { action: actionId }),
          );
        }
      }
    }
    // Flags are never generated, so the reserved namespace is refused here
    // unconditionally.
    for (const [field, list] of [
      ["requiresFlags", requiresFlags] as const,
      ["setsFlags", setsFlags] as const,
    ]) {
      for (const id of list ?? []) {
        if (!isText(id) || id.length === 0) {
          errors.push(
            issue("empty_id", `action "${actionId}" has an empty flag id in ${field}`, { action: actionId }),
          );
        } else if (isReservedId(id)) {
          errors.push(issue("reserved_id", `action "${actionId}" uses the reserved id "${id}"`, { action: actionId }));
        }
      }
    }

    generatedActionEntries.push({
      id: actionId,
      performer: isText(performer) ? performer : null,
      needs: isText(entry.needs) ? entry.needs : null,
      options: isPositiveInteger(entry.options) ? entry.options : 1,
      answerToken: isText(entry.answerToken) && entry.answerToken.length > 0 ? entry.answerToken : null,
      label: isText(entry.label) ? entry.label : null,
      requiresTokens: (requiresTokens ?? []).filter(isText),
      requiresFlags: (requiresFlags ?? []).filter(isText),
      producesTokens: (producesTokens ?? []).filter(isText),
      setsFlags: (setsFlags ?? []).filter(isText),
    });
  }

  validateGeneratedNamespace(generatedActionEntries, new Set(actionIds.keys()), validPrimitives, errors);

  // --- goal ----------------------------------------------------------
  const goalFlags = puzzle.goalFlags;
  const goalOk = isArray(goalFlags);
  if (!goalOk) complain("puzzle.goalFlags", goalFlags, "an array of flag ids");
  if (goalOk && goalFlags.length === 0) {
    errors.push(issue("no_goal", "puzzle has no goal flags, so nothing could ever be solved"));
  }
  for (const flag of goalOk ? goalFlags : []) {
    if (!isText(flag) || flag.length === 0) {
      errors.push(issue("empty_id", "puzzle has an empty goal flag id"));
    } else if (isReservedId(flag)) {
      errors.push(issue("reserved_id", `goal flag "${flag}" uses the reserved namespace`));
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * Read a required array field off a shape-unknown action entry, reporting
 * exactly one issue (missing, or wrong type) and returning `null` in either
 * case so the caller can skip further checks on it.
 */
function requiredArrayField(
  entry: Record<string, unknown>,
  field: string,
  actionId: string,
  errors: ValidationIssue[],
  complain: (what: string, got: unknown, expected: string) => void,
): unknown[] | null {
  const value = entry[field];
  if (value === undefined) {
    errors.push(
      issue("malformed_input", `action "${actionId}" is missing required field "${field}"`, { action: actionId }),
    );
    return null;
  }
  if (!Array.isArray(value)) {
    complain(`${field} of action "${actionId}"`, value, "an array");
    return null;
  }
  return value;
}

/**
 * A choice is only meaningful if the team can know which option is right.
 *
 * `options > 1` means the action presents alternatives, so it must name the
 * token whose knowledge makes the correct choice determinable, and that token
 * must already be a requirement -- otherwise the action would fire for a player
 * who has no way to pick correctly.
 */
function validateChoice(action: Action, errors: ValidationIssue[]): void {
  const options = action.options ?? 1;
  if (options <= 1) return;
  if (typeof action.answerToken !== "string" || action.answerToken.length === 0) {
    errors.push(
      issue(
        "missing_answer_token",
        `action "${action.id}" offers ${options} options but declares no answerToken, so nothing determines the right choice`,
        { action: action.id },
      ),
    );
    return;
  }
  if (!(action.requiresTokens ?? []).includes(action.answerToken)) {
    errors.push(
      issue(
        "missing_answer_token",
        `action "${action.id}" declares answerToken "${action.answerToken}", which is not in requiresTokens`,
        { action: action.id },
      ),
    );
  }
}

/**
 * The state the caller says the team has already reached.
 *
 * The rule is not "is every entry accounted for" -- that is self-accounting,
 * and it is not the same as reachable: a done action that requires an
 * impossible token but produces nothing has nothing for a fact-level check to
 * catch, and a performer's capability was never checked
 * against what the action actually needs. The rule here is REPLAY: step through
 * `state.history` in order and require that every event actually could have
 * happened at the point it claims to, then require that what comes out the
 * other end is exactly the state's declared `flags` and `tokens` -- no more, no
 * less.
 *
 * Semantics, stated once so the counterfactual can lean on them:
 *
 *   `state.tokens` is knowledge **already shared with the team**. A private
 *   token of a present role counts as shared -- the holder has said it out loud
 *   by now -- so it is legal in the state even though no action produced it.
 *
 * That is what makes the necessity counterfactual honest: removing a role keeps
 * knowledge the team already had, including the role's already-shared private
 * tokens, and removes only the role's future actions and its not-yet-shared
 * private tokens. It is also why the state is checked against the puzzle as it
 * actually is, roles and all: whether the state stays legal in a counterfactual
 * world is a different question, and `proveNecessity` answers it by
 * construction rather than by re-validating against a world that never had the
 * role.
 */
export function validateState(puzzle: Puzzle, state: State): ValidationResult {
  const errors: ValidationIssue[] = [];

  if (!isRecord(state)) {
    return {
      ok: false,
      errors: [issue("malformed_input", `expected a state object, got ${describeValue(state)}`)],
    };
  }
  for (const field of ["flags", "tokens", "history"] as const) {
    if (!Array.isArray(state[field])) {
      errors.push(
        issue(
          "malformed_input",
          `state.${field} must be an array, got ${describeValue(state[field])}`,
        ),
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const normalized = normalizeState(state);

  const replay = replayHistory(puzzle, normalized.history, errors);
  // A history that could not have happened as declared makes "does the state
  // match it" a meaningless question -- report the replay failures and stop.
  if (errors.length > 0) return { ok: false, errors };

  const flags = sortedUnique(normalized.flags);
  const tokens = sortedUnique(normalized.tokens);

  // Both directions of the equality matter, but not against the same set for
  // tokens: `replay.tokens` also holds every present role's PRIVATE tokens,
  // available from the start without any action producing them, and the
  // documented semantics say a state need not spell those out (`shared` in the
  // test above declares one with an empty history). Only what an actually
  // FIRED action produced is required to appear -- `replay.producedTokens`,
  // not the full known set. Flags have no such seed (nothing is a flag before
  // some action sets it), so `replay.flags` alone is exactly what must match.
  for (const flag of flags) {
    if (!replay.flags.has(flag)) {
      errors.push(
        issue("unproduced_flag", `state has flag "${flag}", but no performed action in history sets it`),
      );
    }
  }
  for (const flag of replay.flags) {
    if (!flags.includes(flag)) {
      errors.push(
        issue(
          "unreachable_state",
          `history sets flag "${flag}", but the state does not declare it`,
        ),
      );
    }
  }
  for (const token of tokens) {
    if (!replay.tokens.has(token)) {
      errors.push(
        issue(
          "unproduced_token",
          `state has token "${token}", which no performed action produces and no present role holds`,
        ),
      );
    }
  }
  for (const token of replay.producedTokens) {
    if (!tokens.includes(token)) {
      errors.push(
        issue(
          "unreachable_state",
          `history produces token "${token}", but the state does not declare it`,
        ),
      );
    }
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

function isCapabilityValue(value: unknown): value is Capability {
  return typeof value === "string" && KNOWN_CAPABILITIES.includes(value as Capability);
}

function isCapabilityArray(value: unknown): value is Capability[] {
  return Array.isArray(value) && value.every(isCapabilityValue);
}

/**
 * Replay `history` against `puzzle` from scratch, pushing an issue for every
 * event that could not have happened as declared, and return the facts the
 * replay actually produced (used only when the replay is otherwise clean).
 *
 * A role's capability set at the START of the replay is the `from` of the
 * FIRST `capability_change` event `history` records for that role, if any --
 * that is the role's capability BEFORE any change the history remembers, which
 * `puzzle.roles[...].capabilities` no longer holds once a recompile has
 * happened (the puzzle only carries the CURRENT capabilities). A role history
 * never mentions keeps whatever the puzzle currently says, which is correct
 * because nothing ever changed it.
 *
 * Every action event must, in order: name an action that exists; name a
 * performer who exists and is allowed (`action.performer === performer` or the
 * action is generic); use the capability the action actually needs; be
 * performed by someone who holds that capability at this point in the replay;
 * have every required token and flag already known. Each action may fire at
 * most once. Every `capability_change`'s `from` must equal the capability set
 * actually replayed for that role so far.
 */
function replayHistory(
  puzzle: Puzzle,
  history: readonly unknown[],
  errors: ValidationIssue[],
): { tokens: Set<string>; flags: Set<string>; producedTokens: Set<string> } {
  const actionsById = new Map(puzzle.actions.map((a) => [a.id, a]));
  const roleIds = new Set(puzzle.roles.map((r) => r.id));

  const initialFrom = new Map<string, Capability[]>();
  for (const entry of history) {
    if (!isRecord(entry) || entry.kind !== "capability_change") continue;
    const role = entry.role;
    if (typeof role !== "string" || initialFrom.has(role) || !isCapabilityArray(entry.from)) continue;
    initialFrom.set(role, entry.from);
  }
  const capabilities = new Map<string, Set<Capability>>();
  for (const role of puzzle.roles) {
    capabilities.set(role.id, new Set(initialFrom.get(role.id) ?? role.capabilities));
  }

  const tokens = new Set<string>();
  for (const role of puzzle.roles) {
    for (const token of role.privateTokens ?? []) tokens.add(token);
  }
  const flags = new Set<string>();
  // Only tokens an actually-fired action produced -- NOT the private-token seed
  // above. A private token needs no action to be legal in a state (its holder
  // spoke it aloud on presence alone), so it must not be required to appear.
  const producedTokens = new Set<string>();
  const fired = new Set<string>();

  const malformed = (index: number, field: string, got: unknown, expected: string): void => {
    errors.push(
      issue("malformed_input", `history[${index}].${field} must be ${expected}, got ${describeValue(got)}`),
    );
  };

  for (let index = 0; index < history.length; index++) {
    const entry = history[index];
    if (!isRecord(entry)) {
      errors.push(issue("malformed_input", `history[${index}] must be an object, got ${describeValue(entry)}`));
      continue;
    }

    if (entry.kind === "action") {
      const actionId = entry.actionId;
      const performer = entry.performer;
      const capability = entry.capability;
      if (typeof actionId !== "string" || actionId.length === 0) {
        malformed(index, "actionId", actionId, "a non-empty string");
        continue;
      }
      if (typeof performer !== "string" || performer.length === 0) {
        malformed(index, "performer", performer, "a non-empty string");
        continue;
      }
      if (!isCapabilityValue(capability)) {
        malformed(index, "capability", capability, "a known capability");
        continue;
      }
      const action = actionsById.get(actionId);
      if (!action) {
        errors.push(
          issue("unknown_action", `history[${index}] performs action "${actionId}", which is not in the puzzle`, {
            action: actionId,
          }),
        );
        continue;
      }
      if (!roleIds.has(performer)) {
        errors.push(
          issue(
            "unknown_action",
            `history[${index}] credits action "${actionId}" to "${performer}", who is not a role in the puzzle`,
            { action: actionId, role: performer },
          ),
        );
        continue;
      }
      if (fired.has(actionId)) {
        errors.push(
          issue("invalid_history", `history performs action "${actionId}" more than once`, { action: actionId }),
        );
        continue;
      }
      if (action.performer !== "any" && action.performer !== performer) {
        errors.push(
          issue(
            "invalid_history",
            `history credits action "${actionId}" to "${performer}", but the puzzle assigns it to "${action.performer}"`,
            { action: actionId, role: performer },
          ),
        );
        continue;
      }
      if (capability !== action.needs) {
        errors.push(
          issue(
            "invalid_history",
            `history performs action "${actionId}" with capability "${capability}", but the action needs "${action.needs}"`,
            { action: actionId },
          ),
        );
        continue;
      }
      const held = capabilities.get(performer);
      if (!held || !held.has(capability)) {
        errors.push(
          issue(
            "invalid_history",
            `history performs action "${actionId}" as "${performer}", who does not hold "${capability}" at that point in the replay`,
            { action: actionId, role: performer },
          ),
        );
        continue;
      }
      if (!isSubset(action.requiresTokens ?? [], tokens) || !isSubset(action.requiresFlags ?? [], flags)) {
        errors.push(
          issue(
            "invalid_history",
            `history performs action "${actionId}" before its requirements are known`,
            { action: actionId },
          ),
        );
        continue;
      }
      fired.add(actionId);
      for (const token of action.producesTokens ?? []) {
        tokens.add(token);
        producedTokens.add(token);
      }
      for (const flag of action.setsFlags ?? []) flags.add(flag);
    } else if (entry.kind === "capability_change") {
      const role = entry.role;
      const from = entry.from;
      const to = entry.to;
      if (typeof role !== "string" || role.length === 0) {
        malformed(index, "role", role, "a non-empty string");
        continue;
      }
      if (!roleIds.has(role)) {
        errors.push(
          issue(
            "unknown_action",
            `history[${index}] changes capabilities of "${role}", who is not a role in the puzzle`,
            { role },
          ),
        );
        continue;
      }
      if (!isCapabilityArray(from)) {
        malformed(index, "from", from, "an array of known capabilities");
        continue;
      }
      if (!isCapabilityArray(to)) {
        malformed(index, "to", to, "an array of known capabilities");
        continue;
      }
      const current = capabilities.get(role)!;
      if (!sameSet(from, [...current])) {
        errors.push(
          issue(
            "invalid_history",
            `history[${index}] changes "${role}" from [${from.join(", ")}], but the replayed capability set at that point is [${[...current].sort().join(", ")}]`,
            { role },
          ),
        );
        continue;
      }
      capabilities.set(role, new Set(to));
    } else {
      errors.push(
        issue(
          "malformed_input",
          `history[${index}].kind must be "action" or "capability_change", got ${describeValue(entry.kind)}`,
        ),
      );
    }
  }

  // Replaying every event is not enough without checking where the replay
  // actually LANDS: a role's capability set at the end of the replay has to
  // equal what the puzzle currently says that role has, or the state describes
  // a puzzle that isn't this one. A history for C that ends at "voice" while
  // the supplied puzzle still says C(scan) is an impossible state that would
  // otherwise receive `ok: true`, and then crash `recompile` when a second
  // change tried to build on it. `puzzle.roles[x].capabilities` is
  // always the ground truth for the CURRENT puzzle, whether or not history
  // ever mentions a change for that role.
  for (const role of puzzle.roles) {
    const finalCapabilities = capabilities.get(role.id);
    if (!finalCapabilities) continue; // every role was seeded above; defensive only
    if (!sameSet([...finalCapabilities], role.capabilities)) {
      errors.push(
        issue(
          "invalid_history",
          `history replay leaves "${role.id}" with capabilities [${[...finalCapabilities].sort().join(", ")}], but the puzzle says "${role.id}" has [${[...role.capabilities].sort().join(", ")}] -- this state cannot be a state of this puzzle`,
          { role: role.id },
        ),
      );
    }
  }

  return { tokens, flags, producedTokens };
}

/** Turn a pile of issues into the one-line reason a refusal carries. */
export function describeIssues(errors: readonly ValidationIssue[]): string {
  return errors.map((e) => e.detail).join("; ");
}

export function validationError(
  puzzleErrors: readonly ValidationIssue[],
  stateErrors: readonly ValidationIssue[],
): ValidationError {
  const errors = [...puzzleErrors, ...stateErrors];
  return {
    kind: "invalid_puzzle",
    stateInvalid: stateErrors.length > 0,
    errors,
    reason: errors.length
      ? `input rejected before any search: ${describeIssues(errors)}`
      : "input rejected before any search",
  };
}
