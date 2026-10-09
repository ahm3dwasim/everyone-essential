/**
 * The one generator: `convertAction` retargets an action at a new capability,
 * splitting a wide choice into chained steps when the new capability cannot
 * present it in one go. Lives in its own module, separate from both
 * `validate.ts` (which has to call it to check a `§` chain round-trips) and
 * `recompile.ts` (which calls it to actually repair one) -- neither of those
 * two may import the other, so the generator sits below both.
 *
 * `deriveLogicalAction` and `chainRoundTrips` are the other half of the gate:
 * a `§` chain is legal input iff recovering the logical action it stands for
 * and re-running THIS function reproduces it exactly. See `validate.ts` for
 * where that gate lives and why a round trip through this function, not a
 * hand-listed set of rules, is what decides it.
 */
import { canonicalStringify } from "./hash";
import {
  type Action,
  type ActionId,
  type Capability,
  type Primitive,
  type Puzzle,
  type RoleId,
  type TokenId,
  PROGRESS_MARKER,
  RESERVED_PREFIX,
  STEP_MARKER,
  cloneAction,
  clonePuzzle,
} from "./model";

export interface Converted {
  actions: Action[];
  actionIds: ActionId[];
  summary: string;
}

/**
 * Retarget one action at `toCapability`, using the puzzle's primitive library.
 *
 * If the action presents a choice the primitive cannot show in one step, the
 * choice is spread over chained steps: the smallest k with
 * `maxOptions^k >= options`, each step offering the smallest b with
 * `b^k >= options` -- the SAME b on every step, never one chosen per step. A
 * 9-way grid choice under a 4-option scan primitive becomes two 3-way scan
 * steps, which is how a real accessible grid picker works.
 *
 * The chain is enforced with synthetic progress tokens so a step cannot be
 * skipped: step i+1 requires the token step i produces. The original
 * prerequisites move to the first step and the original effects move to the
 * last one, so the action as a whole still means the same thing.
 *
 * Generated ids live in the reserved namespace (`§<actionId>__progress<i>`,
 * `§<actionId>__step<i>`). `validatePuzzle` refuses author ids in the
 * namespace, so a generated id can never collide with one; `freeId`
 * additionally probes the puzzle so that generation stays collision-free even
 * on an unvalidated one.
 *
 * Each step of the chain presents part of the choice, so each step that offers
 * more than one option also requires the choice's `answerToken`. Requiring it
 * only on the last step would let a player take the earlier steps blind.
 *
 * Returns null when the primitive library cannot express the action at all --
 * that is a real "cannot convert", not a soft failure.
 */
export function convertAction(
  puzzle: Puzzle,
  action: Action,
  roleId: RoleId,
  toCapability: Capability,
  primitive: Primitive | undefined = undefined,
): Converted | null {
  // With no primitive named, every primitive for the capability is tried in
  // order and the first that works wins.
  if (primitive === undefined) {
    for (const candidate of primitivesFor(puzzle, toCapability)) {
      const converted = convertAction(puzzle, action, roleId, toCapability, candidate);
      if (converted) return converted;
    }
    return null;
  }
  if (primitive.capability !== toCapability) return null;

  const options = action.options ?? 1;

  if (options <= primitive.maxOptions) {
    const replacement = cloneAction(action);
    replacement.needs = toCapability;
    replacement.performer = roleId;
    if (options > 1 && action.answerToken && !replacement.requiresTokens.includes(action.answerToken)) {
      // Keeping the choice means keeping its answer requirement: a converted
      // multi-option action that dropped it would be an action nobody could
      // perform correctly, which the validator would then refuse.
      replacement.requiresTokens = [...replacement.requiresTokens, action.answerToken];
    }
    return {
      actions: [replacement],
      actionIds: [action.id],
      summary: `"${action.label ?? action.id}" becomes a ${toCapability} action for ${roleId} (${options} option${
        options === 1 ? "" : "s"
      }, fits in one step)`,
    };
  }

  if (!primitive.splittable || primitive.maxOptions < 2) {
    return null; // the new capability cannot present this choice, in one step or in many
  }

  let steps = 1;
  while (primitive.maxOptions ** steps < options) steps++;
  let breadth = 2;
  while (breadth ** steps < options) breadth++;

  const progressToken = (i: number): string => `${RESERVED_PREFIX}${action.id}${PROGRESS_MARKER}${i}`;
  const built: Action[] = [];

  for (let i = 1; i <= steps; i++) {
    const isFirst = i === 1;
    const isLast = i === steps;
    const requiresTokens = isFirst ? [...action.requiresTokens] : [progressToken(i - 1)];
    // EVERY step of the chain presents part of the choice, so every step needs
    // the answer -- otherwise a player could take step 1 blind. Step 1 inherits
    // the original `requiresTokens`, which the validator already forces to
    // contain the answer, so in practice this adds it to the later steps only.
    if (breadth > 1 && action.answerToken && !requiresTokens.includes(action.answerToken)) {
      requiresTokens.push(action.answerToken);
    }
    const step: Action = {
      id: freeId(puzzle, `${RESERVED_PREFIX}${action.id}${STEP_MARKER}${i}`),
      performer: roleId,
      needs: toCapability,
      requiresTokens,
      requiresFlags: isFirst ? [...action.requiresFlags] : [],
      producesTokens: isLast ? [...action.producesTokens] : [progressToken(i)],
      setsFlags: isLast ? [...action.setsFlags] : [],
      options: breadth,
      label: `${action.label ?? action.id} (step ${i} of ${steps}, ${breadth} options)`,
    };
    if (options > 1 && action.answerToken) step.answerToken = action.answerToken;
    built.push(step);
  }

  return {
    actions: built,
    actionIds: built.map((a) => a.id),
    summary: `"${action.label ?? action.id}" was a ${options}-way ${action.needs} choice for ${roleId}; now ${steps} chained ${breadth}-way ${toCapability} steps (${breadth}^${steps} >= ${options})`,
  };
}

/**
 * `preferred` unless something in the puzzle already uses that id, in which
 * case a numeric suffix that nothing uses.
 *
 * The reserved namespace already makes a collision with an author id
 * impossible; this is the second line of defence, so that generation on an
 * unvalidated puzzle still cannot produce two actions with one id.
 */
function freeId(puzzle: Puzzle, preferred: string): string {
  const taken = new Set<string>([
    ...puzzle.actions.map((a) => a.id),
    ...puzzle.roles.flatMap((r) => r.privateTokens),
    ...puzzle.actions.flatMap((a) => [...a.requiresTokens, ...a.producesTokens]),
  ]);
  if (!taken.has(preferred)) return preferred;
  for (let i = 2; ; i++) {
    const candidate = `${preferred}~${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Every primitive the puzzle declares for a capability, smallest capacity
 * first, with declaration order breaking ties.
 *
 * Smallest first is not arbitrary. A primitive that fits the choice in one step
 * is tried before one that has to chain, and among chaining candidates the one
 * that needs the fewest steps comes first -- so the first repair found is also
 * the cheapest, and the order is a total order on the declared library. Every
 * candidate is tried; a primitive that cannot express the action is skipped
 * rather than allowed to veto the ones behind it.
 */
export function primitivesFor(puzzle: Puzzle, capability: Capability): Primitive[] {
  return puzzle.primitives
    .map((primitive, index) => ({ primitive, index }))
    .filter((entry) => entry.primitive.capability === capability)
    .sort((a, b) => a.primitive.maxOptions - b.primitive.maxOptions || a.index - b.index)
    .map((entry) => entry.primitive);
}

/** Move a private token to `toRoleId`, taking it away from whoever held it. */
export function handOffToken(puzzle: Puzzle, token: TokenId, toRoleId: RoleId): Puzzle {
  const next = clonePuzzle(puzzle);
  for (const role of next.roles) {
    role.privateTokens = role.privateTokens.filter((t) => t !== token);
  }
  const recipient = next.roles.find((r) => r.id === toRoleId);
  if (recipient) recipient.privateTokens = [...recipient.privateTokens, token].sort();
  return next;
}

/* ------------------------------------------------------------------ */
/* A `§` chain is legal input iff it round-trips through the generator */
/* above -- see `validate.ts` for where this gate is actually called.  */
/* ------------------------------------------------------------------ */

/**
 * The exact suffix `convertAction` appends to a step's source label
 * (`convert.ts:136`): `"<label> (step i of N, B options)"`. Kept as one
 * function so the two places that need it -- building it forward here, and
 * stripping it back off in `recoverChainLabel` below -- cannot drift apart.
 */
function chainLabelSuffix(step: number, totalSteps: number, breadth: number): string {
  return ` (step ${step} of ${totalSteps}, ${breadth} options)`;
}

/**
 * The source label `convertAction` started from, recovered from step 1's
 * generated label by stripping the one suffix it can carry.
 *
 * A label is the one field of a generated step that is not otherwise
 * reproducible: `convertAction` derives it from `action.label ?? action.id`,
 * and nothing in the chain records which of those two it was, or what the
 * original string was, except the label itself. Stripping the known suffix
 * back off step 1 is therefore the whole recovery -- there is nowhere else to
 * read it from. When the suffix is not literally there (a forged label, or a
 * non-string one `validatePuzzle` already refuses on its own), `undefined` is
 * correct: it makes the round trip regenerate from `origId` instead, which is
 * guaranteed to disagree with a label that did not truly come from that
 * origin, so `chainRoundTrips` refuses it exactly like any other field
 * mismatch, rather than this function silently accepting a label the real
 * generator could never have produced.
 */
function recoverChainLabel(steps: readonly Action[]): string | undefined {
  const first = steps[0]!;
  if (typeof first.label !== "string") return undefined;
  const suffix = chainLabelSuffix(1, steps.length, first.options ?? 1);
  if (!first.label.endsWith(suffix)) return undefined;
  return first.label.slice(0, -suffix.length);
}

/**
 * The one action a generated split chain stands for.
 *
 * Read only from where `convertAction` actually puts each field: step 1 for
 * `requiresTokens`/`requiresFlags`/`label`, the last step for
 * `producesTokens`/`setsFlags` (`convert.ts:116-140`). Reading the endpoints
 * without also making that true of the input silently drops a requirement or
 * a flag smuggled onto a middle link instead of catching it. Folding every
 * step's fields together with `sortedUnique` closes that gap but opens
 * another: it collapses a duplicated token and reorders fields the real
 * generator emits in a fixed, deterministic order, so a chain that repeats an
 * answer token or renumbers its steps still round-trips. Reading verbatim
 * from the endpoints closes both:
 * this recovers exactly the value `convertAction` would be given back, in
 * its original order, and `chainRoundTrips`' per-step, per-field, in-order
 * comparison against the ACTUAL chain -- not this recovery -- is what catches
 * a value smuggled anywhere else, including a middle link, because the
 * regenerated middle link can only ever be the fixed progress-token shape
 * `convertAction` produces for one.
 */
export function deriveLogicalAction(origId: ActionId, steps: readonly Action[]): Action {
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const logical: Action = {
    id: origId,
    performer: first.performer,
    needs: first.needs,
    requiresTokens: [...first.requiresTokens],
    requiresFlags: [...first.requiresFlags],
    producesTokens: [...last.producesTokens],
    setsFlags: [...last.setsFlags],
    options: steps.reduce((total, step) => total * (step.options ?? 1), 1),
  };
  if (first.answerToken !== undefined) logical.answerToken = first.answerToken;
  const label = recoverChainLabel(steps);
  if (label !== undefined) logical.label = label;
  return logical;
}

/**
 * Deterministic shape of one step, for the round-trip compare.
 *
 * Array fields are compared in the exact order and multiplicity
 * `convertAction` produces them in (`canonicalStringify` already treats array
 * order as meaningful, per `hash.ts`) -- NOT sorted or deduplicated. Every
 * field `convertAction` sets is built in a fixed, deterministic order from
 * the source action's own order (`convert.ts:119-136`), so there is no
 * generator nondeterminism to be order-insensitive about; sorting here would
 * let a duplicated answer token or a reordered field pass as
 * equivalent. `label` is included for the same
 * reason: it is fully reproducible (`recoverChainLabel` above), so excluding
 * it would mean accepting a chain the generator never produced, exactly the
 * class of gap this comparison exists to close.
 */
function canonicalStep(action: Action): unknown {
  return {
    id: action.id,
    performer: action.performer,
    needs: action.needs,
    options: action.options ?? 1,
    answerToken: action.answerToken ?? null,
    label: action.label ?? null,
    requiresTokens: action.requiresTokens,
    requiresFlags: action.requiresFlags,
    producesTokens: action.producesTokens,
    setsFlags: action.setsFlags,
  };
}

function stepsRoundtripEqual(generated: readonly Action[], actual: readonly Action[]): boolean {
  if (generated.length !== actual.length) return false;
  return generated.every(
    (g, i) => canonicalStringify(canonicalStep(g)) === canonicalStringify(canonicalStep(actual[i]!)),
  );
}

/**
 * True iff `steps` (a complete, consecutive chain of ids for `origId`) is
 * EXACTLY what `convertAction` would build, for some primitive this puzzle
 * declares, from the logical action `deriveLogicalAction` recovers from them.
 *
 * `label` IS part of the comparison: it is display text, but it is also
 * fully reproducible -- `recoverChainLabel` strips the one suffix
 * `convertAction` can append -- so excluding it would mean accepting any two
 * labels a chain's steps happened to carry, including two that no single
 * source label and step count could ever produce.
 *
 * The probe puzzle handed to `convertAction` is empty on purpose: the ids
 * `convertAction` wants (`§<origId>__step<k>`, `§<origId>__progress<k>`) can
 * never collide with anything outside this one chain -- every id shaped like
 * one is, by construction, already grouped into this chain or one of its
 * siblings -- so there is nothing for `freeId`'s collision check to find
 * either way, and an empty puzzle keeps this check independent of every other
 * field validation is still in the middle of doing.
 */
export function chainRoundTrips(origId: ActionId, steps: readonly Action[], primitives: readonly Primitive[]): boolean {
  const logical = deriveLogicalAction(origId, steps);
  const probe: Puzzle = { id: "§probe", roles: [], actions: [], goalFlags: [], primitives: [] };
  for (const primitive of primitives) {
    if (primitive.capability !== logical.needs) continue;
    const converted = convertAction(probe, logical, logical.performer, logical.needs, primitive);
    if (converted && stepsRoundtripEqual(converted.actions, steps)) return true;
  }
  return false;
}
