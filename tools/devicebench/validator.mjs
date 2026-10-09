// Built from validator/src/api.ts by tools/devicebench/build-validator.mjs, esbuild 0.28.2.
// Generated file: do not edit it by hand. Run `npm run build:devicebench` from the repository root.

// src/hash.ts
var FNV_PRIME = 0x100000001b3n;
var MASK64 = (1n << 64n) - 1n;
var BASIS_A = 0xcbf29ce484222325n;
var BASIS_B = 0x9e3779b97f4a7c15n;
function fnv1a64(input, basis) {
  let hash = basis;
  for (const byte of utf8Bytes(input)) {
    hash ^= BigInt(byte);
    hash = hash * FNV_PRIME & MASK64;
  }
  return hash;
}
function utf8Bytes(input) {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 55296 && code <= 56319 && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        code = 65536 + (code - 55296 << 10) + (next - 56320);
        i++;
      }
    }
    if (code < 128) {
      out.push(code);
    } else if (code < 2048) {
      out.push(192 | code >> 6, 128 | code & 63);
    } else if (code < 65536) {
      out.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
    } else {
      out.push(
        240 | code >> 18,
        128 | code >> 12 & 63,
        128 | code >> 6 & 63,
        128 | code & 63
      );
    }
  }
  return out;
}
function hex64(value) {
  return value.toString(16).padStart(16, "0");
}
function stableHash(input) {
  const salted = `${input.length}:${input}`;
  return hex64(fnv1a64(salted, BASIS_A)) + hex64(fnv1a64(salted, BASIS_B));
}
function canonicalStringify(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify(value.toString());
  if (t === "undefined" || t === "function" || t === "symbol") return "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
  }
  const record = value;
  const keys = Object.keys(record).filter((k) => record[k] !== void 0).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k])}`);
  return `{${parts.join(",")}}`;
}

// src/model.ts
var NO_ROLE = "any";
var RESERVED_PREFIX = "\xA7";
function isReservedId(id) {
  return id.startsWith(RESERVED_PREFIX);
}
var STEP_MARKER = "__step";
var PROGRESS_MARKER = "__progress";
function parseGeneratedActionId(id) {
  if (!isReservedId(id)) return null;
  const rest = id.slice(RESERVED_PREFIX.length);
  const match = /^(.*)__step(\d+)$/.exec(rest);
  if (!match) return null;
  const [, origId, digits] = match;
  if (!origId || !digits || !/^[1-9]\d*$/.test(digits)) return null;
  return { origId, step: Number(digits) };
}
function emptyState() {
  return { flags: [], tokens: [], history: [] };
}
var UNREADABLE_OPTIONS = /* @__PURE__ */ Symbol("unreadable options");
function optionField(container, name) {
  if (container === null || typeof container !== "object") return UNREADABLE_OPTIONS;
  try {
    return container[name];
  } catch {
    return UNREADABLE_OPTIONS;
  }
}
function describeOptionValue(value) {
  if (value === UNREADABLE_OPTIONS) {
    return "a container this compiler cannot read (not an object, or reading it threw)";
  }
  try {
    const json = JSON.stringify(value);
    if (json !== void 0) return json;
  } catch {
  }
  return `a value of type ${typeof value}, which cannot be printed`;
}
function isActionEvent(event) {
  return event.kind === "action";
}
function isCapabilityChangeEvent(event) {
  return event.kind === "capability_change";
}
function doneActionIds(history) {
  const ids = [];
  for (const event of history) {
    if (event.kind === "action") ids.push(event.actionId);
  }
  return sortedUnique(ids);
}
function sortedUnique(values) {
  return [...new Set(values)].sort();
}
function isSubset(needles, haystack) {
  for (const n of needles) {
    if (!haystack.has(n)) return false;
  }
  return true;
}
function sameSet(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const v of sa) {
    if (!sb.has(v)) return false;
  }
  return true;
}
function normalizeState(state) {
  return {
    flags: sortedUnique(state.flags),
    tokens: sortedUnique(state.tokens),
    history: [...state.history]
  };
}
function roleById(puzzle, id) {
  return puzzle.roles.find((r) => r.id === id);
}
function roleHas(role, capability) {
  return role.capabilities.includes(capability);
}
function firstCapableRole(puzzle, capability) {
  return puzzle.roles.find((r) => roleHas(r, capability));
}
function knownTokensAtStart(puzzle, state) {
  const tokens = new Set(state.tokens);
  for (const role of puzzle.roles) {
    for (const t of role.privateTokens) tokens.add(t);
  }
  return tokens;
}
function cloneAction(action) {
  const copy = {
    id: action.id,
    performer: action.performer,
    needs: action.needs,
    requiresTokens: [...action.requiresTokens],
    requiresFlags: [...action.requiresFlags],
    producesTokens: [...action.producesTokens],
    setsFlags: [...action.setsFlags]
  };
  if (action.options !== void 0) copy.options = action.options;
  if (action.answerToken !== void 0) copy.answerToken = action.answerToken;
  if (action.label !== void 0) copy.label = action.label;
  return copy;
}
function clonePuzzle(puzzle) {
  return {
    id: puzzle.id,
    roles: puzzle.roles.map((r) => ({
      id: r.id,
      capabilities: [...r.capabilities],
      privateTokens: [...r.privateTokens]
    })),
    actions: puzzle.actions.map(cloneAction),
    goalFlags: [...puzzle.goalFlags],
    primitives: puzzle.primitives.map((p) => ({ ...p }))
  };
}
function replaceActions(puzzle, actionId, replacements) {
  const next = clonePuzzle(puzzle);
  const index = next.actions.findIndex((a) => a.id === actionId);
  if (index < 0) throw new Error(`replaceActions: unknown action ${actionId}`);
  next.actions.splice(index, 1, ...replacements);
  return next;
}
function withRoleCapabilities(puzzle, roleId, capabilities) {
  const next = clonePuzzle(puzzle);
  const role = next.roles.find((r) => r.id === roleId);
  if (!role) throw new Error(`withRoleCapabilities: unknown role ${roleId}`);
  role.capabilities = [...capabilities];
  return next;
}
function removeRole(puzzle, roleId) {
  const isGeneric = (a) => a.performer === NO_ROLE;
  return {
    id: `${puzzle.id}~without:${roleId}`,
    roles: puzzle.roles.filter((r) => r.id !== roleId).map((r) => ({
      id: r.id,
      capabilities: [...r.capabilities],
      privateTokens: [...r.privateTokens]
    })),
    actions: puzzle.actions.filter((a) => isGeneric(a) || a.performer !== roleId).map(cloneAction),
    goalFlags: [...puzzle.goalFlags],
    primitives: puzzle.primitives.map((p) => ({ ...p }))
  };
}
function puzzleKey(puzzle) {
  return canonicalStringify({
    roles: puzzle.roles,
    actions: puzzle.actions,
    goalFlags: puzzle.goalFlags,
    primitives: puzzle.primitives
  });
}

// src/solve.ts
var DEFAULT_MAX_STATES = 5e5;
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function stateKey(flags, tokens, done) {
  return canonicalStringify([[...flags].sort(), [...tokens].sort(), [...done].sort()]);
}
var keyOf = stateKey;
function solve(puzzle, state, options = {}) {
  const requestedMaxStates = optionField(options, "maxStates");
  if (requestedMaxStates !== void 0 && !isPositiveInteger(requestedMaxStates)) {
    return {
      status: "invalid_options",
      plan: [],
      statesExplored: 0,
      truncated: false,
      reason: `maxStates must be a positive integer, got ${describeOptionValue(requestedMaxStates)}`
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
  if (1 > maxStates) {
    return { status: "unsolvable", plan: [], statesExplored: 1, truncated: true };
  }
  const nodes = [
    {
      flags: startFlags,
      tokens: startTokens,
      done: startDone,
      key: startKey,
      parent: -1,
      viaAction: null,
      viaRole: null
    }
  ];
  const visited = /* @__PURE__ */ new Set([startKey]);
  for (let head = 0; head < nodes.length; head++) {
    const node = nodes[head];
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
      if (visited.size + 1 > maxStates) {
        return { status: "unsolvable", plan: [], statesExplored: visited.size, truncated: true };
      }
      visited.add(key);
      const child = { flags, tokens, done, key, parent: head, viaAction: action, viaRole: performer };
      if (isSubset(goalFlags, flags)) {
        return {
          status: "solvable",
          plan: buildPlan(nodes, child),
          statesExplored: visited.size,
          truncated: false
        };
      }
      nodes.push(child);
    }
  }
  return { status: "unsolvable", plan: [], statesExplored: visited.size, truncated: false };
}
function resolvePerformer(puzzle, action) {
  if (action.performer === "any") {
    return firstCapableRole(puzzle, action.needs)?.id ?? null;
  }
  const role = roleById(puzzle, action.performer);
  if (!role) return null;
  return roleHas(role, action.needs) ? role.id : null;
}
function buildPlan(nodes, goal) {
  const backwards = [];
  let cursor = goal;
  while (cursor && cursor.viaAction && cursor.viaRole) {
    backwards.push({ action: cursor.viaAction, performer: cursor.viaRole });
    cursor = cursor.parent >= 0 ? nodes[cursor.parent] : void 0;
  }
  backwards.reverse();
  return backwards.map((entry, index) => ({
    step: index + 1,
    action: entry.action.id,
    performer: entry.performer,
    needs: entry.action.needs,
    label: entry.action.label ?? entry.action.id
  }));
}
function applyPlan(puzzle, state, plan, count) {
  const normalized = normalizeState(state);
  const flags = new Set(normalized.flags);
  const tokens = new Set(normalized.tokens);
  const history = [...normalized.history];
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
    history
  };
}

// src/convert.ts
function convertAction(puzzle, action, roleId, toCapability, primitive = void 0) {
  if (primitive === void 0) {
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
      replacement.requiresTokens = [...replacement.requiresTokens, action.answerToken];
    }
    return {
      actions: [replacement],
      actionIds: [action.id],
      summary: `"${action.label ?? action.id}" becomes a ${toCapability} action for ${roleId} (${options} option${options === 1 ? "" : "s"}, fits in one step)`
    };
  }
  if (!primitive.splittable || primitive.maxOptions < 2) {
    return null;
  }
  let steps = 1;
  while (primitive.maxOptions ** steps < options) steps++;
  let breadth = 2;
  while (breadth ** steps < options) breadth++;
  const progressToken = (i) => `${RESERVED_PREFIX}${action.id}${PROGRESS_MARKER}${i}`;
  const built = [];
  for (let i = 1; i <= steps; i++) {
    const isFirst = i === 1;
    const isLast = i === steps;
    const requiresTokens = isFirst ? [...action.requiresTokens] : [progressToken(i - 1)];
    if (breadth > 1 && action.answerToken && !requiresTokens.includes(action.answerToken)) {
      requiresTokens.push(action.answerToken);
    }
    const step = {
      id: freeId(puzzle, `${RESERVED_PREFIX}${action.id}${STEP_MARKER}${i}`),
      performer: roleId,
      needs: toCapability,
      requiresTokens,
      requiresFlags: isFirst ? [...action.requiresFlags] : [],
      producesTokens: isLast ? [...action.producesTokens] : [progressToken(i)],
      setsFlags: isLast ? [...action.setsFlags] : [],
      options: breadth,
      label: `${action.label ?? action.id} (step ${i} of ${steps}, ${breadth} options)`
    };
    if (options > 1 && action.answerToken) step.answerToken = action.answerToken;
    built.push(step);
  }
  return {
    actions: built,
    actionIds: built.map((a) => a.id),
    summary: `"${action.label ?? action.id}" was a ${options}-way ${action.needs} choice for ${roleId}; now ${steps} chained ${breadth}-way ${toCapability} steps (${breadth}^${steps} >= ${options})`
  };
}
function freeId(puzzle, preferred) {
  const taken = /* @__PURE__ */ new Set([
    ...puzzle.actions.map((a) => a.id),
    ...puzzle.roles.flatMap((r) => r.privateTokens),
    ...puzzle.actions.flatMap((a) => [...a.requiresTokens, ...a.producesTokens])
  ]);
  if (!taken.has(preferred)) return preferred;
  for (let i = 2; ; i++) {
    const candidate = `${preferred}~${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
function primitivesFor(puzzle, capability) {
  return puzzle.primitives.map((primitive, index) => ({ primitive, index })).filter((entry) => entry.primitive.capability === capability).sort((a, b) => a.primitive.maxOptions - b.primitive.maxOptions || a.index - b.index).map((entry) => entry.primitive);
}
function handOffToken(puzzle, token, toRoleId) {
  const next = clonePuzzle(puzzle);
  for (const role of next.roles) {
    role.privateTokens = role.privateTokens.filter((t) => t !== token);
  }
  const recipient = next.roles.find((r) => r.id === toRoleId);
  if (recipient) recipient.privateTokens = [...recipient.privateTokens, token].sort();
  return next;
}
function chainLabelSuffix(step, totalSteps, breadth) {
  return ` (step ${step} of ${totalSteps}, ${breadth} options)`;
}
function recoverChainLabel(steps) {
  const first = steps[0];
  if (typeof first.label !== "string") return void 0;
  const suffix = chainLabelSuffix(1, steps.length, first.options ?? 1);
  if (!first.label.endsWith(suffix)) return void 0;
  return first.label.slice(0, -suffix.length);
}
function deriveLogicalAction(origId, steps) {
  const first = steps[0];
  const last = steps[steps.length - 1];
  const logical = {
    id: origId,
    performer: first.performer,
    needs: first.needs,
    requiresTokens: [...first.requiresTokens],
    requiresFlags: [...first.requiresFlags],
    producesTokens: [...last.producesTokens],
    setsFlags: [...last.setsFlags],
    options: steps.reduce((total, step) => total * (step.options ?? 1), 1)
  };
  if (first.answerToken !== void 0) logical.answerToken = first.answerToken;
  const label = recoverChainLabel(steps);
  if (label !== void 0) logical.label = label;
  return logical;
}
function canonicalStep(action) {
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
    setsFlags: action.setsFlags
  };
}
function stepsRoundtripEqual(generated, actual) {
  if (generated.length !== actual.length) return false;
  return generated.every(
    (g, i) => canonicalStringify(canonicalStep(g)) === canonicalStringify(canonicalStep(actual[i]))
  );
}
function chainRoundTrips(origId, steps, primitives) {
  const logical = deriveLogicalAction(origId, steps);
  const probe = { id: "\xA7probe", roles: [], actions: [], goalFlags: [], primitives: [] };
  for (const primitive of primitives) {
    if (primitive.capability !== logical.needs) continue;
    const converted = convertAction(probe, logical, logical.performer, logical.needs, primitive);
    if (converted && stepsRoundtripEqual(converted.actions, steps)) return true;
  }
  return false;
}

// src/validate.ts
var KNOWN_CAPABILITIES = ["dpad", "scan", "voice"];
function issue(kind, detail, where = {}) {
  return { kind, action: where.action ?? null, role: where.role ?? null, detail };
}
function checkId(id, what, seen, errors, counter, skipReservedCheck) {
  if (typeof id !== "string" || id.length === 0) {
    errors.push(issue("empty_id", `${what} has an empty id`));
    return;
  }
  if (isReservedId(id) && !skipReservedCheck) {
    errors.push(
      issue("reserved_id", `${what} id "${id}" uses the reserved "${RESERVED_PREFIX}" namespace`)
    );
  }
  const previous = seen.get(id);
  if (previous !== void 0) {
    errors.push(issue("duplicate_id", `${what} id "${id}" appears more than once`));
  } else {
    seen.set(id, counter.n++);
  }
}
function isPositiveInteger2(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function addToSetMap(map, key, value) {
  let set = map.get(key);
  if (!set) {
    set = /* @__PURE__ */ new Set();
    map.set(key, set);
  }
  set.add(value);
}
function describeActionSet(actions) {
  return actions.size ? [...actions].sort().join(", ") : "nothing";
}
function validateGeneratedNamespace(actions, allActionIds, primitives, errors) {
  const chains = /* @__PURE__ */ new Map();
  for (const action of actions) {
    if (!isReservedId(action.id)) continue;
    const parsed = parseGeneratedActionId(action.id);
    if (!parsed) {
      errors.push(
        issue(
          "reserved_id",
          `action id "${action.id}" uses the reserved "${RESERVED_PREFIX}" namespace but is not a generated split-chain step (expected "${RESERVED_PREFIX}<id>${STEP_MARKER}<k>")`,
          { action: action.id }
        )
      );
      continue;
    }
    let byStep = chains.get(parsed.origId);
    if (!byStep) {
      byStep = /* @__PURE__ */ new Map();
      chains.set(parsed.origId, byStep);
    }
    byStep.set(parsed.step, action.id);
  }
  const entryById = new Map(actions.map((a) => [a.id, a]));
  const validChains = /* @__PURE__ */ new Map();
  for (const [origId, byStep] of chains) {
    const steps = [...byStep.keys()].sort((a, b) => a - b);
    const consecutive = steps.every((s, i) => s === i + 1);
    if (consecutive && steps.length < 2) {
      for (const id of byStep.values()) {
        errors.push(
          issue(
            "reserved_id",
            `generated step "${id}" is a one-step "chain" for "${origId}"; the generator never splits a choice into fewer than two steps`,
            { action: id }
          )
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
            { action: id }
          )
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
            { action: id }
          )
        );
      }
      continue;
    }
    const stepEntries = steps.map((step) => entryById.get(byStep.get(step))).filter((e) => e !== void 0);
    const canRoundTrip = stepEntries.length === steps.length && stepEntries.every((e) => e.performer !== null && e.needs !== null);
    if (canRoundTrip) {
      const stepActions = stepEntries.map((e) => {
        const step = {
          id: e.id,
          performer: e.performer,
          needs: e.needs,
          requiresTokens: e.requiresTokens,
          requiresFlags: e.requiresFlags,
          producesTokens: e.producesTokens,
          setsFlags: e.setsFlags,
          options: e.options
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
              { action: id }
            )
          );
        }
      }
    } else {
      for (const id of byStep.values()) {
        errors.push(
          issue(
            "reserved_id",
            `generated split chain "${RESERVED_PREFIX}${origId}${STEP_MARKER}*" cannot be checked against the generator: one of its steps has a malformed performer or capability`,
            { action: id }
          )
        );
      }
    }
    validChains.set(origId, steps.length);
  }
  const producers = /* @__PURE__ */ new Map();
  const consumers = /* @__PURE__ */ new Map();
  for (const action of actions) {
    for (const t of action.producesTokens) if (isReservedId(t)) addToSetMap(producers, t, action.id);
    for (const t of action.requiresTokens) if (isReservedId(t)) addToSetMap(consumers, t, action.id);
  }
  const expectedTokens = /* @__PURE__ */ new Set();
  for (const [origId, length] of validChains) {
    for (let i = 1; i < length; i++) {
      const token = `${RESERVED_PREFIX}${origId}${PROGRESS_MARKER}${i}`;
      expectedTokens.add(token);
      const expectedProducer = `${RESERVED_PREFIX}${origId}${STEP_MARKER}${i}`;
      const expectedConsumer = `${RESERVED_PREFIX}${origId}${STEP_MARKER}${i + 1}`;
      const producedBy = producers.get(token) ?? /* @__PURE__ */ new Set();
      const consumedBy = consumers.get(token) ?? /* @__PURE__ */ new Set();
      if (producedBy.size !== 1 || !producedBy.has(expectedProducer)) {
        errors.push(
          issue(
            "reserved_id",
            `progress token "${token}" must be produced by exactly "${expectedProducer}" (actually produced by: ${describeActionSet(producedBy)})`
          )
        );
      }
      if (consumedBy.size !== 1 || !consumedBy.has(expectedConsumer)) {
        errors.push(
          issue(
            "reserved_id",
            `progress token "${token}" must be required by exactly "${expectedConsumer}" (actually required by: ${describeActionSet(consumedBy)})`
          )
        );
      }
    }
  }
  const allReservedTokens = /* @__PURE__ */ new Set([...producers.keys(), ...consumers.keys()]);
  for (const token of allReservedTokens) {
    if (expectedTokens.has(token)) continue;
    errors.push(
      issue(
        "reserved_id",
        `token "${token}" uses the reserved "${RESERVED_PREFIX}" namespace but is not a valid generated progress token`
      )
    );
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function createCounter() {
  return { n: 0 };
}
function describeValue(value) {
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "object") return "an object";
  return String(value);
}
function validatePuzzle(puzzle) {
  const errors = [];
  const counter = createCounter();
  if (!isRecord(puzzle)) {
    return {
      ok: false,
      errors: [issue("malformed_input", `expected a puzzle object, got ${describeValue(puzzle)}`)]
    };
  }
  const complain = (what, got, expected) => {
    errors.push(issue("malformed_input", `${what} must be ${expected}, got ${describeValue(got)}`));
  };
  const isText = (value) => typeof value === "string";
  const isArray = (value) => Array.isArray(value);
  const roles = puzzle.roles;
  const actions = puzzle.actions;
  const primitives = puzzle.primitives;
  const rolesOk = isArray(roles);
  const actionsOk = isArray(actions);
  const primitivesOk = isArray(primitives);
  if (!rolesOk) complain("puzzle.roles", roles, "an array of roles");
  if (!actionsOk) complain("puzzle.actions", actions, "an array of actions");
  if (!primitivesOk) complain("puzzle.primitives", primitives, "an array of primitives");
  if (puzzle.id === void 0) {
    errors.push(issue("malformed_input", "puzzle.id is required and must be a non-empty string"));
  } else if (!isText(puzzle.id)) {
    errors.push(issue("malformed_input", `puzzle.id must be a string, got ${describeValue(puzzle.id)}`));
  } else if (puzzle.id.length === 0) {
    errors.push(issue("empty_id", "puzzle has an empty id"));
  }
  const roleIds = /* @__PURE__ */ new Map();
  const roleList = rolesOk ? roles : [];
  const tokenOwners = /* @__PURE__ */ new Map();
  for (let index = 0; index < roleList.length; index++) {
    const entry = roleList[index];
    if (!isRecord(entry)) {
      complain(`roles[${index}]`, entry, "an object");
      continue;
    }
    if (!isText(entry.id)) {
      complain(`roles[${index}].id`, entry.id, "a string");
      continue;
    }
    const roleId = entry.id;
    checkId(roleId, "role", roleIds, errors, counter, false);
    if (roleId === "any") {
      errors.push(
        issue(
          "reserved_id",
          `role id "any" is reserved: it is the generic-performer sentinel, not a name a role may use`,
          { role: roleId }
        )
      );
    }
    const capabilities = entry.capabilities;
    if (!isArray(capabilities)) {
      complain(`capabilities of role "${roleId}"`, capabilities, "an array");
      continue;
    }
    for (const capability of capabilities) {
      if (!isText(capability) || !KNOWN_CAPABILITIES.includes(capability)) {
        errors.push(
          issue("unknown_capability", `role "${roleId}" declares unknown capability "${describeValue(capability)}"`, {
            role: roleId
          })
        );
      }
    }
    const privateTokens = entry.privateTokens;
    if (privateTokens === void 0) {
      errors.push(
        issue("malformed_input", `role "${roleId}" is missing required field "privateTokens"`, { role: roleId })
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
          issue("empty_id", `role "${roleId}" has a private token with an empty id`, { role: roleId })
        );
        continue;
      }
      if (isReservedId(token)) {
        errors.push(
          issue("reserved_id", `private token "${token}" of role "${roleId}" uses the reserved namespace`, {
            role: roleId
          })
        );
      }
      const owner = tokenOwners.get(token);
      if (owner !== void 0) {
        errors.push(
          issue("duplicate_id", `token "${token}" is private to both "${owner}" and "${roleId}"`, {
            role: roleId
          })
        );
      } else {
        tokenOwners.set(token, roleId);
      }
    }
  }
  const primitiveList = primitivesOk ? primitives : [];
  const primitiveIds = /* @__PURE__ */ new Map();
  const validPrimitives = [];
  for (let index = 0; index < primitiveList.length; index++) {
    const entry = primitiveList[index];
    if (!isRecord(entry)) {
      complain(`primitives[${index}]`, entry, "an object");
      continue;
    }
    if (!isText(entry.id)) {
      complain(`primitives[${index}].id`, entry.id, "a string");
      continue;
    }
    checkId(entry.id, "primitive", primitiveIds, errors, counter, false);
    const capabilityOk = isText(entry.capability) && KNOWN_CAPABILITIES.includes(entry.capability);
    if (!capabilityOk) {
      errors.push(
        issue(
          "unknown_capability",
          `primitive "${entry.id}" targets unknown capability "${describeValue(entry.capability)}"`
        )
      );
    }
    const maxOptionsOk = isPositiveInteger2(entry.maxOptions);
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
        capability: entry.capability,
        maxOptions: entry.maxOptions,
        splittable: entry.splittable,
        label: isText(entry.label) ? entry.label : entry.id
      });
    }
  }
  const actionIds = /* @__PURE__ */ new Map();
  const actionList = actionsOk ? actions : [];
  const generatedActionEntries = [];
  for (let index = 0; index < actionList.length; index++) {
    const entry = actionList[index];
    if (!isRecord(entry)) {
      complain(`actions[${index}]`, entry, "an object");
      continue;
    }
    if (!isText(entry.id)) {
      complain(`actions[${index}].id`, entry.id, "a string");
      continue;
    }
    const actionId = entry.id;
    checkId(actionId, "action", actionIds, errors, counter, true);
    const performer = entry.performer;
    if (!isText(performer) || performer !== "any" && !roleIds.has(performer)) {
      errors.push(
        issue("unknown_action", `action "${actionId}" names unknown performer "${describeValue(performer)}"`, {
          action: actionId
        })
      );
    }
    if (!isText(entry.needs) || !KNOWN_CAPABILITIES.includes(entry.needs)) {
      errors.push(
        issue("unknown_capability", `action "${actionId}" needs unknown capability "${describeValue(entry.needs)}"`, {
          action: actionId
        })
      );
    }
    if (entry.options !== void 0 && !isPositiveInteger2(entry.options)) {
      errors.push(
        issue(
          "invalid_options",
          `action "${actionId}" declares options: ${describeValue(entry.options)}; it must be a positive integer (1 = no choice)`,
          { action: actionId }
        )
      );
    }
    if (entry.label !== void 0 && !isText(entry.label)) {
      errors.push(
        issue(
          "malformed_input",
          `action "${actionId}" declares label: ${describeValue(entry.label)}; it must be a string when present`,
          { action: actionId }
        )
      );
    }
    validateChoice(entry, errors);
    const requiresTokens = requiredArrayField(entry, "requiresTokens", actionId, errors, complain);
    const producesTokens = requiredArrayField(entry, "producesTokens", actionId, errors, complain);
    const requiresFlags = requiredArrayField(entry, "requiresFlags", actionId, errors, complain);
    const setsFlags = requiredArrayField(entry, "setsFlags", actionId, errors, complain);
    for (const list of [requiresTokens, producesTokens]) {
      for (const id of list ?? []) {
        if (!isText(id) || id.length === 0) {
          errors.push(
            issue("empty_id", `action "${actionId}" has an empty token id`, { action: actionId })
          );
        }
      }
    }
    for (const [field, list] of [
      ["requiresFlags", requiresFlags],
      ["setsFlags", setsFlags]
    ]) {
      for (const id of list ?? []) {
        if (!isText(id) || id.length === 0) {
          errors.push(
            issue("empty_id", `action "${actionId}" has an empty flag id in ${field}`, { action: actionId })
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
      options: isPositiveInteger2(entry.options) ? entry.options : 1,
      answerToken: isText(entry.answerToken) && entry.answerToken.length > 0 ? entry.answerToken : null,
      label: isText(entry.label) ? entry.label : null,
      requiresTokens: (requiresTokens ?? []).filter(isText),
      requiresFlags: (requiresFlags ?? []).filter(isText),
      producesTokens: (producesTokens ?? []).filter(isText),
      setsFlags: (setsFlags ?? []).filter(isText)
    });
  }
  validateGeneratedNamespace(generatedActionEntries, new Set(actionIds.keys()), validPrimitives, errors);
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
function requiredArrayField(entry, field, actionId, errors, complain) {
  const value = entry[field];
  if (value === void 0) {
    errors.push(
      issue("malformed_input", `action "${actionId}" is missing required field "${field}"`, { action: actionId })
    );
    return null;
  }
  if (!Array.isArray(value)) {
    complain(`${field} of action "${actionId}"`, value, "an array");
    return null;
  }
  return value;
}
function validateChoice(action, errors) {
  const options = action.options ?? 1;
  if (options <= 1) return;
  if (typeof action.answerToken !== "string" || action.answerToken.length === 0) {
    errors.push(
      issue(
        "missing_answer_token",
        `action "${action.id}" offers ${options} options but declares no answerToken, so nothing determines the right choice`,
        { action: action.id }
      )
    );
    return;
  }
  if (!(action.requiresTokens ?? []).includes(action.answerToken)) {
    errors.push(
      issue(
        "missing_answer_token",
        `action "${action.id}" declares answerToken "${action.answerToken}", which is not in requiresTokens`,
        { action: action.id }
      )
    );
  }
}
function validateState(puzzle, state) {
  const errors = [];
  if (!isRecord(state)) {
    return {
      ok: false,
      errors: [issue("malformed_input", `expected a state object, got ${describeValue(state)}`)]
    };
  }
  for (const field of ["flags", "tokens", "history"]) {
    if (!Array.isArray(state[field])) {
      errors.push(
        issue(
          "malformed_input",
          `state.${field} must be an array, got ${describeValue(state[field])}`
        )
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const normalized = normalizeState(state);
  const replay = replayHistory(puzzle, normalized.history, errors);
  if (errors.length > 0) return { ok: false, errors };
  const flags = sortedUnique(normalized.flags);
  const tokens = sortedUnique(normalized.tokens);
  for (const flag of flags) {
    if (!replay.flags.has(flag)) {
      errors.push(
        issue("unproduced_flag", `state has flag "${flag}", but no performed action in history sets it`)
      );
    }
  }
  for (const flag of replay.flags) {
    if (!flags.includes(flag)) {
      errors.push(
        issue(
          "unreachable_state",
          `history sets flag "${flag}", but the state does not declare it`
        )
      );
    }
  }
  for (const token of tokens) {
    if (!replay.tokens.has(token)) {
      errors.push(
        issue(
          "unproduced_token",
          `state has token "${token}", which no performed action produces and no present role holds`
        )
      );
    }
  }
  for (const token of replay.producedTokens) {
    if (!tokens.includes(token)) {
      errors.push(
        issue(
          "unreachable_state",
          `history produces token "${token}", but the state does not declare it`
        )
      );
    }
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
function isCapabilityValue(value) {
  return typeof value === "string" && KNOWN_CAPABILITIES.includes(value);
}
function isCapabilityArray(value) {
  return Array.isArray(value) && value.every(isCapabilityValue);
}
function replayHistory(puzzle, history, errors) {
  const actionsById = new Map(puzzle.actions.map((a) => [a.id, a]));
  const roleIds = new Set(puzzle.roles.map((r) => r.id));
  const initialFrom = /* @__PURE__ */ new Map();
  for (const entry of history) {
    if (!isRecord(entry) || entry.kind !== "capability_change") continue;
    const role = entry.role;
    if (typeof role !== "string" || initialFrom.has(role) || !isCapabilityArray(entry.from)) continue;
    initialFrom.set(role, entry.from);
  }
  const capabilities = /* @__PURE__ */ new Map();
  for (const role of puzzle.roles) {
    capabilities.set(role.id, new Set(initialFrom.get(role.id) ?? role.capabilities));
  }
  const tokens = /* @__PURE__ */ new Set();
  for (const role of puzzle.roles) {
    for (const token of role.privateTokens ?? []) tokens.add(token);
  }
  const flags = /* @__PURE__ */ new Set();
  const producedTokens = /* @__PURE__ */ new Set();
  const fired = /* @__PURE__ */ new Set();
  const malformed = (index, field, got, expected) => {
    errors.push(
      issue("malformed_input", `history[${index}].${field} must be ${expected}, got ${describeValue(got)}`)
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
            action: actionId
          })
        );
        continue;
      }
      if (!roleIds.has(performer)) {
        errors.push(
          issue(
            "unknown_action",
            `history[${index}] credits action "${actionId}" to "${performer}", who is not a role in the puzzle`,
            { action: actionId, role: performer }
          )
        );
        continue;
      }
      if (fired.has(actionId)) {
        errors.push(
          issue("invalid_history", `history performs action "${actionId}" more than once`, { action: actionId })
        );
        continue;
      }
      if (action.performer !== "any" && action.performer !== performer) {
        errors.push(
          issue(
            "invalid_history",
            `history credits action "${actionId}" to "${performer}", but the puzzle assigns it to "${action.performer}"`,
            { action: actionId, role: performer }
          )
        );
        continue;
      }
      if (capability !== action.needs) {
        errors.push(
          issue(
            "invalid_history",
            `history performs action "${actionId}" with capability "${capability}", but the action needs "${action.needs}"`,
            { action: actionId }
          )
        );
        continue;
      }
      const held = capabilities.get(performer);
      if (!held || !held.has(capability)) {
        errors.push(
          issue(
            "invalid_history",
            `history performs action "${actionId}" as "${performer}", who does not hold "${capability}" at that point in the replay`,
            { action: actionId, role: performer }
          )
        );
        continue;
      }
      if (!isSubset(action.requiresTokens ?? [], tokens) || !isSubset(action.requiresFlags ?? [], flags)) {
        errors.push(
          issue(
            "invalid_history",
            `history performs action "${actionId}" before its requirements are known`,
            { action: actionId }
          )
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
            { role }
          )
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
      const current = capabilities.get(role);
      if (!sameSet(from, [...current])) {
        errors.push(
          issue(
            "invalid_history",
            `history[${index}] changes "${role}" from [${from.join(", ")}], but the replayed capability set at that point is [${[...current].sort().join(", ")}]`,
            { role }
          )
        );
        continue;
      }
      capabilities.set(role, new Set(to));
    } else {
      errors.push(
        issue(
          "malformed_input",
          `history[${index}].kind must be "action" or "capability_change", got ${describeValue(entry.kind)}`
        )
      );
    }
  }
  for (const role of puzzle.roles) {
    const finalCapabilities = capabilities.get(role.id);
    if (!finalCapabilities) continue;
    if (!sameSet([...finalCapabilities], role.capabilities)) {
      errors.push(
        issue(
          "invalid_history",
          `history replay leaves "${role.id}" with capabilities [${[...finalCapabilities].sort().join(", ")}], but the puzzle says "${role.id}" has [${[...role.capabilities].sort().join(", ")}] -- this state cannot be a state of this puzzle`,
          { role: role.id }
        )
      );
    }
  }
  return { tokens, flags, producedTokens };
}
function describeIssues(errors) {
  return errors.map((e) => e.detail).join("; ");
}
function validationError(puzzleErrors, stateErrors) {
  const errors = [...puzzleErrors, ...stateErrors];
  return {
    kind: "invalid_puzzle",
    stateInvalid: stateErrors.length > 0,
    errors,
    reason: errors.length ? `input rejected before any search: ${describeIssues(errors)}` : "input rejected before any search"
  };
}

// src/certify.ts
var SCAN_MAX_OPTIONS = 4;
function isCertificate(result) {
  return result.hash !== void 0;
}
function certify(puzzle, state, options = {}) {
  const refusal = validate(puzzle, state);
  if (refusal) return refusal;
  return buildCertificate(puzzle, state, options);
}
function buildCertificate(puzzle, state, options = {}) {
  const fromState = normalizeState(state);
  const solvableResult = solve(puzzle, fromState, options);
  const solvable = {
    ok: solvableResult.status === "solvable",
    // `invalid_options` means the search never ran at all -- neither solved nor
    // proven unsolvable -- so it must not fall into "proven" just because
    // nothing was truncated either.
    proven: solvableResult.status !== "invalid_options" && (solvableResult.status === "solvable" || !solvableResult.truncated),
    statesExplored: solvableResult.statesExplored,
    truncated: solvableResult.truncated,
    plan: solvableResult.plan
  };
  const necessity = {};
  for (const role of puzzle.roles) {
    necessity[role.id] = proveNecessity(puzzle, fromState, role.id, options);
  }
  const accessibility = checkAccessibility(puzzle, fromState);
  const meaningful = checkMeaningfulness(puzzle, solvable.plan);
  const ok = solvable.ok && solvable.proven && accessibility.ok && Object.values(necessity).every((n) => n.necessary && n.proven) && Object.values(meaningful).every((m) => m.meaningful);
  const key = puzzleKey(puzzle);
  const body = {
    puzzleId: puzzle.id,
    puzzleKey: key,
    fromState,
    solvable,
    necessity,
    accessibility,
    meaningful,
    ok
  };
  return { ...body, hash: stableHash(canonicalStringify(body)) };
}
function validate(puzzle, state) {
  const puzzleCheck = validatePuzzle(puzzle);
  if (!puzzleCheck.ok) return validationError(puzzleCheck.errors, []);
  const stateCheck = validateState(puzzle, state);
  if (!stateCheck.ok) return validationError([], stateCheck.errors);
  return null;
}
function refusalIssues(result) {
  return isCertificate(result) ? [] : result.errors;
}
function totalStates(certificate) {
  let total = certificate.solvable.statesExplored;
  for (const proof of Object.values(certificate.necessity)) total += proof.statesExplored;
  return total;
}
function proveNecessity(puzzle, state, roleId, options) {
  const reduced = removeRole(puzzle, roleId);
  const counterfactualBound = optionField(options, "maxCounterfactualStates");
  const stateBound = optionField(options, "maxStates");
  const result = solve(reduced, state, {
    maxStates: counterfactualBound ?? stateBound
  });
  if (result.status === "invalid_options") {
    return {
      role: roleId,
      necessary: false,
      proven: false,
      statesExplored: 0,
      truncated: false,
      reason: `counterfactual search for ${roleId} could not run: ${result.reason}`
    };
  }
  if (result.status === "solvable") {
    return {
      role: roleId,
      necessary: false,
      proven: true,
      statesExplored: result.statesExplored,
      truncated: false,
      reason: `goal still reachable without ${roleId} -- role is decorative`
    };
  }
  if (result.truncated) {
    return {
      role: roleId,
      necessary: false,
      proven: false,
      statesExplored: result.statesExplored,
      truncated: true,
      reason: `search without ${roleId} hit the state cap; necessity is unproven, not disproven`
    };
  }
  return {
    role: roleId,
    necessary: true,
    proven: true,
    statesExplored: result.statesExplored,
    truncated: false,
    reason: `goal unreachable without ${roleId} (${result.statesExplored} states exhausted)`
  };
}
function checkAccessibility(puzzle, state) {
  const violations = [];
  const done = new Set(doneActionIds(state.history));
  if (puzzle.roles.length === 0) {
    violations.push({
      kind: "empty_action_pool",
      action: null,
      detail: "puzzle has no roles, so no action can ever be performed"
    });
  }
  for (const action of puzzle.actions) {
    if (done.has(action.id)) continue;
    const eligible = eligiblePerformers(puzzle, action.needs, action.performer);
    if (eligible.length === 0) {
      violations.push({
        kind: "no_eligible_performer",
        action: action.id,
        detail: action.performer === "any" ? `action "${action.id}" needs "${action.needs}" but no role in the puzzle has it` : `action "${action.id}" is assigned to "${action.performer}", who does not have "${action.needs}"`
      });
    }
    if (action.needs === "scan" && action.options !== void 0 && action.options > SCAN_MAX_OPTIONS) {
      violations.push({
        kind: "scan_too_many_options",
        action: action.id,
        detail: `scan action "${action.id}" offers ${action.options} options; switch scanning allows at most ${SCAN_MAX_OPTIONS}`
      });
    }
    if ((action.options ?? 1) > 1 && !action.answerToken) {
      violations.push({
        kind: "choice_without_answer",
        action: action.id,
        detail: `action "${action.id}" offers ${action.options} options but names no answerToken, so a player cannot know which choice is right`
      });
    }
  }
  return { ok: violations.length === 0, violations };
}
function eligiblePerformers(puzzle, capability, performer) {
  if (performer === "any") {
    return puzzle.roles.filter((r) => roleHas(r, capability)).map((r) => r.id);
  }
  const role = puzzle.roles.find((r) => r.id === performer);
  return role && roleHas(role, capability) ? [role.id] : [];
}
function checkMeaningfulness(puzzle, plan) {
  const consumed = /* @__PURE__ */ new Set();
  for (const step of plan) {
    const action = puzzle.actions.find((a) => a.id === step.action);
    if (!action) continue;
    for (const t of action.requiresTokens) consumed.add(t);
  }
  const performers = new Set(plan.map((s) => s.performer));
  const out = {};
  for (const role of puzzle.roles) {
    if (performers.has(role.id)) {
      out[role.id] = {
        role: role.id,
        meaningful: true,
        reason: `performs at least one action on the witness plan`
      };
      continue;
    }
    const contributed = role.privateTokens.filter((t) => consumed.has(t));
    if (contributed.length > 0) {
      out[role.id] = {
        role: role.id,
        meaningful: true,
        reason: `supplies token(s) the witness plan consumes: ${contributed.join(", ")}`
      };
      continue;
    }
    out[role.id] = {
      role: role.id,
      meaningful: false,
      reason: `performs no action on the witness plan and holds no token it consumes (holds: ${role.privateTokens.length ? role.privateTokens.join(", ") : "nothing"})`
    };
  }
  return out;
}
function explainFailure(result) {
  if (!isCertificate(result)) {
    return `${result.reason}${result.stateInvalid ? " (the state is the problem)" : ""}`;
  }
  const certificate = result;
  const reasons = [];
  const unsolvable = !certificate.solvable.ok;
  if (unsolvable) {
    reasons.push(
      certificate.solvable.truncated ? "solvability search hit the state cap (unproven)" : "goal unreachable from this state"
    );
  }
  if (!certificate.accessibility.ok) {
    for (const v of certificate.accessibility.violations) reasons.push(`accessibility: ${v.detail}`);
  }
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

// src/clock.ts
var perf = globalThis.performance;
function now() {
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
}

// src/recompile.ts
var DEFAULT_MAX_DEPTH = 5;
var DEFAULT_MAX_CANDIDATES = 200;
function recompile(puzzle, state, roleId, newCapabilities, options = {}) {
  const startedAt = now();
  const attempts = [];
  const puzzleCheck = validatePuzzle(puzzle);
  if (!puzzleCheck.ok) {
    return invalidInput(puzzleCheck.errors, [], startedAt, roleId, newCapabilities, false);
  }
  const stateCheck = validateState(puzzle, state);
  if (!stateCheck.ok) {
    return invalidInput([], stateCheck.errors, startedAt, roleId, newCapabilities, roleIsIn(puzzle, roleId));
  }
  const optionErrors = validateRecompileOptions(options);
  if (optionErrors.length > 0) {
    return invalidInput([], optionErrors, startedAt, roleId, newCapabilities, roleIsIn(puzzle, roleId));
  }
  const changeErrors = validateChange(puzzle, roleId, newCapabilities);
  if (changeErrors.length > 0) {
    return invalidInput([], changeErrors, startedAt, roleId, newCapabilities, roleIsIn(puzzle, roleId));
  }
  const maxDepth = boundOr(options, "maxDepth", DEFAULT_MAX_DEPTH);
  const maxCandidates = boundOr(options, "maxCandidates", DEFAULT_MAX_CANDIDATES);
  const base = withRoleCapabilities(puzzle, roleId, newCapabilities);
  const capabilityEntry = {
    op: "capability_change",
    summary: `${roleId} switches to ${newCapabilities.length ? newCapabilities.join(" + ") : "no input at all"}`,
    actionIds: [],
    roleIds: [roleId],
    tokenIds: []
  };
  const changedRole = puzzle.roles.find((r) => r.id === roleId);
  const normalized = normalizeState(state);
  const nextState = {
    flags: normalized.flags,
    tokens: normalized.tokens,
    history: [
      ...normalized.history,
      {
        kind: "capability_change",
        role: roleId,
        from: [...changedRole.capabilities],
        to: [...newCapabilities]
      }
    ]
  };
  const visited = /* @__PURE__ */ new Set([puzzleKey(base)]);
  let statesExplored = 0;
  if (maxCandidates < 1) {
    return exhausted(
      "maxCandidates",
      `candidate budget of ${maxCandidates} is smaller than the base candidate`,
      startedAt,
      roleId,
      newCapabilities,
      capabilityEntry,
      attempts,
      statesExplored
    );
  }
  let baseCert;
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
      error
    );
  }
  statesExplored += totalStates(baseCert);
  attempts.push({
    depth: 0,
    op: "convert",
    detail: "no rewrite (capability change only)",
    ok: baseCert.ok,
    rejectedBecause: baseCert.ok ? "" : explainFailure(baseCert)
  });
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
      elapsedMs: elapsed(startedAt)
    };
  }
  let frontier = [{ puzzle: base, path: [] }];
  let certified = 1;
  let lastFailure = {
    certificate: baseCert,
    path: []
  };
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next = [];
    for (const candidate of frontier) {
      let ops;
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
          error
        );
      }
      for (const application of ops) {
        const path = [...candidate.path, application.op];
        let repaired;
        let key;
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
            error
          );
        }
        if (visited.has(key)) continue;
        visited.add(key);
        if (certified >= maxCandidates) {
          return exhausted(
            "maxCandidates",
            `stopped after certifying ${certified} of a ${maxCandidates}-candidate budget, with search still to do`,
            startedAt,
            roleId,
            newCapabilities,
            capabilityEntry,
            attempts,
            statesExplored
          );
        }
        let certificate;
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
            error
          );
        }
        statesExplored += totalStates(certificate);
        certified++;
        attempts.push({
          depth,
          op: application.op.op,
          detail: application.op.detail,
          ok: certificate.ok,
          rejectedBecause: certificate.ok ? "" : explainFailure(certificate)
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
            elapsedMs: elapsed(startedAt)
          };
        }
        if (!certificate.ok && certificateStateCapped(certificate)) anyCertificateStateCapped = true;
        lastFailure = { certificate, path };
        next.push({ puzzle: repaired, path });
      }
    }
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
          statesExplored
        );
      }
      const reason = lastFailure ? `the operator space is exhausted: every candidate within depth ${maxDepth} was certified and none holds; last candidate failed on: ${explainFailure(
        lastFailure.certificate
      )}` : `the operator space is exhausted: no operator applies to this puzzle at all`;
      return {
        kind: "no_valid_recompile",
        role: roleId,
        capabilities: [...newCapabilities],
        diff: [capabilityEntry],
        reason,
        operatorsTried: attempts,
        totalStatesExplored: statesExplored,
        elapsedMs: elapsed(startedAt)
      };
    }
    frontier = next;
  }
  return exhausted(
    "maxDepth",
    `deepest candidate certified was depth ${maxDepth} and the search still had unexplored candidates; raise maxDepth (currently ${maxDepth}) to search further`,
    startedAt,
    roleId,
    newCapabilities,
    capabilityEntry,
    attempts,
    statesExplored
  );
}
function exhausted(bound, detail, startedAt, roleId, newCapabilities, capabilityEntry, attempts, statesExplored) {
  return {
    kind: "search_exhausted",
    role: roleId,
    capabilities: [...newCapabilities],
    diff: [capabilityEntry],
    bound,
    reason: `search hit the ${bound} bound, so no repair is shown to exist -- and none is shown not to: ${detail}`,
    operatorsTried: attempts,
    totalStatesExplored: statesExplored,
    elapsedMs: elapsed(startedAt)
  };
}
function isPositiveFiniteInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function validateRecompileOptions(options) {
  const errors = [];
  for (const name of ["maxDepth", "maxCandidates", "maxStates", "maxCounterfactualStates"]) {
    const value = optionField(options, name);
    if (value !== void 0 && !isPositiveFiniteInteger(value)) {
      errors.push({
        kind: "invalid_options",
        action: null,
        role: null,
        detail: `${name} must be a positive integer, got ${describeOptionValue(value)}`
      });
    }
  }
  return errors;
}
function boundOr(options, name, fallback) {
  const value = optionField(options, name);
  return isPositiveFiniteInteger(value) ? value : fallback;
}
function validateChange(puzzle, roleId, newCapabilities) {
  const errors = [];
  if (!Array.isArray(newCapabilities)) {
    return [
      {
        kind: "malformed_input",
        action: null,
        role: typeof roleId === "string" ? roleId : null,
        detail: `the new capability list must be an array, got ${typeof newCapabilities}`
      }
    ];
  }
  for (const capability of newCapabilities) {
    if (!KNOWN_CAPABILITIES.includes(capability)) {
      errors.push({
        kind: "unknown_capability",
        action: null,
        role: typeof roleId === "string" ? roleId : null,
        detail: `"${String(capability)}" is not a capability this model knows (${KNOWN_CAPABILITIES.join(", ")})`
      });
    }
  }
  if (errors.length > 0) return errors;
  if (typeof roleId !== "string" || !puzzle.roles.some((r) => r.id === roleId)) {
    errors.push({
      kind: "unknown_action",
      action: null,
      role: typeof roleId === "string" ? roleId : null,
      detail: `role "${String(roleId)}" is not in this puzzle, so its capabilities cannot change`
    });
    return errors;
  }
  if (newCapabilities.length === 0) {
    errors.push({
      kind: "malformed_input",
      action: null,
      role: roleId,
      detail: `role "${roleId}" would be left with no input at all, which is not a puzzle this model can repair`
    });
  }
  return errors;
}
function invalidInput(puzzleErrors, stateErrors, startedAt, roleId, newCapabilities, roleIsKnown) {
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
    elapsedMs: elapsed(startedAt)
  };
}
function roleIsIn(puzzle, roleId) {
  return typeof roleId === "string" && puzzle.roles.some((r) => r.id === roleId);
}
function certificateFor(puzzle, state, options) {
  const result = certify(puzzle, state, options);
  if (!isCertificate(result)) {
    throw new Error(
      `recompile: generated candidate failed validation, which is a bug in the operator library: ${result.reason}`
    );
  }
  return result;
}
function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return `"${error}"`;
  try {
    return String(error);
  } catch {
    return `a ${typeof error} value`;
  }
}
function operatorError(roleId, newCapabilities, capabilityEntry, path, attempts, statesExplored, startedAt, detail, error) {
  return {
    kind: "operator_error",
    role: roleId,
    capabilities: [...newCapabilities],
    diff: [capabilityEntry, ...path.map(toDiffEntry)],
    reason: `${detail}, which is a bug in the operator library rather than a property of the puzzle: ${describeError(error)}`,
    operatorsTried: attempts,
    totalStatesExplored: statesExplored,
    elapsedMs: elapsed(startedAt)
  };
}
function certificateStateCapped(certificate) {
  if (certificate.solvable.truncated) return true;
  return Object.values(certificate.necessity).some((proof) => proof.truncated);
}
function elapsed(startedAt) {
  return Math.round((now() - startedAt) * 1e3) / 1e3;
}
function toDiffEntry(op) {
  return {
    op: op.op,
    summary: op.summary,
    actionIds: op.actionIds,
    roleIds: op.roleIds,
    tokenIds: op.tokenIds
  };
}
function applications(puzzle, roleId, state) {
  const done = new Set(doneActionIds(state.history));
  const role = puzzle.roles.find((r) => r.id === roleId);
  if (!role) return [];
  const out = [];
  const chainGroups = chainGroupsFor(puzzle);
  const chainStepIds = /* @__PURE__ */ new Set();
  for (const steps of chainGroups.values()) {
    for (const step of steps) chainStepIds.add(step.id);
  }
  for (const action of puzzle.actions) {
    if (chainStepIds.has(action.id)) continue;
    const ownedByRole = action.performer === roleId;
    const genericOrphan = action.performer === "any" && orphanedGenericAction(puzzle, action, roleId);
    if (!ownedByRole && !genericOrphan) continue;
    if (done.has(action.id)) continue;
    if (roleHas(role, action.needs)) continue;
    for (const capability of role.capabilities) {
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
            tokenIds: []
          },
          apply: () => replaceActions(puzzle, action.id, converted.actions)
        });
      }
    }
  }
  for (const [origId, steps] of chainGroups) {
    const ownedByRole = steps.every((step) => step.performer === roleId);
    const strandedGeneric = steps.every((step) => step.performer === "any") && orphanedGenericChain(puzzle, steps);
    if (!ownedByRole && !strandedGeneric) continue;
    if (steps.some((step) => done.has(step.id))) continue;
    if (steps.every((step) => roleHas(role, step.needs))) continue;
    const logical = deriveLogicalAction(origId, steps);
    const stepIds = new Set(steps.map((step) => step.id));
    const withoutChain = { ...puzzle, actions: puzzle.actions.filter((a) => !stepIds.has(a.id)) };
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
            tokenIds: []
          },
          apply: () => replaceChainActions(puzzle, steps.map((step) => step.id), converted.actions)
        });
      }
    }
  }
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
          tokenIds: []
        },
        apply: () => {
          const next = clonePuzzle(puzzle);
          const target = next.actions.find((a) => a.id === action.id);
          if (target) target.performer = other.id;
          return next;
        }
      });
    }
  }
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
          summary: `the ${steps.length}-step "${origId}" chain moves from ${roleId} to ${other.id}, who still has ${steps[0].needs}`,
          actionIds: steps.map((step) => step.id),
          roleIds: [roleId, other.id],
          tokenIds: []
        },
        apply: () => {
          const next = clonePuzzle(puzzle);
          const stepIds = new Set(steps.map((step) => step.id));
          for (const action of next.actions) {
            if (stepIds.has(action.id)) action.performer = other.id;
          }
          return next;
        }
      });
    }
  }
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
          tokenIds: [token]
        },
        apply: () => handOffToken(puzzle, token, roleId)
      });
    }
  }
  return out;
}
function chainGroupsFor(puzzle) {
  const byOrigId = /* @__PURE__ */ new Map();
  for (const action of puzzle.actions) {
    const parsed = parseGeneratedActionId(action.id);
    if (!parsed) continue;
    let byStep = byOrigId.get(parsed.origId);
    if (!byStep) {
      byStep = /* @__PURE__ */ new Map();
      byOrigId.set(parsed.origId, byStep);
    }
    byStep.set(parsed.step, action);
  }
  const groups = /* @__PURE__ */ new Map();
  for (const [origId, byStep] of byOrigId) {
    const steps = [...byStep.keys()].sort((a, b) => a - b);
    groups.set(origId, steps.map((step) => byStep.get(step)));
  }
  return groups;
}
function replaceChainActions(puzzle, oldIds, replacements) {
  const next = clonePuzzle(puzzle);
  const oldSet = new Set(oldIds);
  const index = next.actions.findIndex((a) => oldSet.has(a.id));
  if (index < 0) throw new Error(`replaceChainActions: none of [${oldIds.join(", ")}] found`);
  next.actions = next.actions.filter((a) => !oldSet.has(a.id));
  next.actions.splice(index, 0, ...replacements);
  return next;
}
function orphanedGenericAction(puzzle, action, roleId) {
  const changed = puzzle.roles.find((r) => r.id === roleId);
  if (changed && roleHas(changed, action.needs)) return false;
  return puzzle.roles.every((r) => r.id === roleId || !roleHas(r, action.needs));
}
function orphanedGenericChain(puzzle, steps) {
  return puzzle.roles.every((role) => steps.some((step) => !roleHas(role, step.needs)));
}

// src/demo.ts
var ROLE_A = "A";
var ROLE_B = "B";
var ROLE_C = "C";
var DEMO_PRIMITIVES = [
  {
    id: "dpad.grid",
    capability: "dpad",
    maxOptions: 9,
    splittable: false,
    label: "3x3 d-pad grid"
  },
  {
    id: "dpad.button",
    capability: "dpad",
    maxOptions: 1,
    splittable: false,
    label: "single d-pad press"
  },
  {
    id: "scan.paged",
    capability: "scan",
    maxOptions: 4,
    splittable: true,
    label: "switch-scan paged list"
  },
  {
    id: "voice.confirm",
    capability: "voice",
    maxOptions: 1,
    splittable: false,
    label: "spoken confirmation"
  }
];
function demoPuzzle() {
  return {
    id: "the-locked-study",
    roles: [
      { id: ROLE_A, capabilities: ["dpad"], privateTokens: ["painting_hint"] },
      { id: ROLE_B, capabilities: ["voice"], privateTokens: ["code_digit_1", "code_digit_2"] },
      { id: ROLE_C, capabilities: ["dpad"], privateTokens: ["desk_drawer_note"] }
    ],
    primitives: DEMO_PRIMITIVES.map((p) => ({ ...p })),
    goalFlags: ["study_unlocked"],
    actions: [
      {
        id: "a_read_painting_hint",
        performer: ROLE_A,
        needs: "dpad",
        requiresTokens: ["painting_hint"],
        requiresFlags: [],
        producesTokens: ["safe_location"],
        setsFlags: [],
        label: "read the note taped behind the painting"
      },
      {
        id: "a_shift_painting",
        performer: ROLE_A,
        needs: "dpad",
        // A can only lift the painting the right way once the hint is known --
        // and the hint is A's own private token, so A has to say it out loud.
        requiresTokens: ["safe_location", "painting_hint"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["painting_moved"],
        options: 4,
        // Four ways to lift it, and only the hint says which. A player who has
        // not heard the hint cannot pick correctly, so the action cannot fire.
        answerToken: "painting_hint",
        label: "swing the painting aside (4 ways to lift it)"
      },
      {
        id: "b_dictate_code",
        performer: ROLE_B,
        needs: "voice",
        requiresTokens: ["code_digit_1", "code_digit_2"],
        requiresFlags: [],
        producesTokens: ["safe_code"],
        setsFlags: [],
        label: "read the two code digits out loud"
      },
      {
        id: "b_describe_symbols",
        performer: ROLE_B,
        needs: "voice",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["symbol_names"],
        setsFlags: [],
        label: "name the nine symbols on the dial"
      },
      {
        id: "c_read_drawer_note",
        performer: ROLE_C,
        needs: "dpad",
        requiresTokens: ["desk_drawer_note"],
        requiresFlags: [],
        producesTokens: ["dial_rule"],
        setsFlags: [],
        label: "read the drawer note about the dial"
      },
      {
        id: "c_match_symbol",
        performer: ROLE_C,
        needs: "dpad",
        requiresTokens: ["dial_rule", "symbol_names"],
        requiresFlags: [],
        producesTokens: ["dial_symbol"],
        setsFlags: [],
        options: 4,
        // Four symbol families; the drawer note is what says which one.
        answerToken: "dial_rule",
        label: "match the rule to one of four symbol families"
      },
      {
        id: "c_dial_safe",
        performer: ROLE_C,
        needs: "dpad",
        // safe_code is both the dial's answer and B's dictated digits: the
        // choice is only makeable by someone who has heard them.
        requiresTokens: ["safe_code", "safe_location", "dial_symbol"],
        requiresFlags: ["painting_moved"],
        producesTokens: [],
        setsFlags: ["safe_open"],
        options: 9,
        // Nine grid positions; B's dictated digits are the only way to know
        // which. This is the action C has to re-earn after switching to scan.
        answerToken: "safe_code",
        label: "dial the safe on the 3x3 grid"
      },
      {
        id: "a_reach_into_safe",
        performer: ROLE_A,
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: ["safe_open"],
        producesTokens: ["study_key"],
        setsFlags: [],
        label: "feel around inside the safe for the key"
      },
      {
        id: "b_listen_for_tumblers",
        performer: ROLE_B,
        needs: "voice",
        requiresTokens: ["dial_symbol"],
        requiresFlags: ["safe_open"],
        producesTokens: [],
        setsFlags: ["tumblers_heard"],
        label: "listen to the tumblers settle"
      },
      {
        id: "any_enter_study",
        performer: "any",
        needs: "dpad",
        requiresTokens: ["study_key"],
        requiresFlags: ["tumblers_heard"],
        producesTokens: [],
        setsFlags: ["study_unlocked"],
        label: "unlock the study door"
      }
    ]
  };
}
var DEMO_CHANGE_ROLE = ROLE_C;
var DEMO_CHANGE_CAPABILITIES = ["scan"];
function runDemo() {
  const t0 = performanceNow();
  const puzzle = demoPuzzle();
  const start = emptyState();
  const solveStart = performanceNow();
  const initialSolve = solve(puzzle, start);
  const solveMs = round(performanceNow() - solveStart);
  const certifyStart = performanceNow();
  const initialResult = certify(puzzle, start);
  const certifyMs = round(performanceNow() - certifyStart);
  if (!isCertificate(initialResult) || !initialResult.ok || initialSolve.status !== "solvable") {
    throw new Error(
      `demo puzzle does not certify at the start: ${JSON.stringify(initialResult, null, 2)}`
    );
  }
  const initialCertificate = initialResult;
  const midpointSteps = Math.floor(initialSolve.plan.length / 2);
  const midpointState = applyPlan(puzzle, start, initialSolve.plan, midpointSteps);
  const midpointResult = certify(puzzle, midpointState);
  if (!isCertificate(midpointResult)) {
    throw new Error(`demo midpoint state rejected: ${explainFailure(midpointResult)}`);
  }
  const midpointCertificate = midpointResult;
  const recompileResult = recompile(puzzle, midpointState, DEMO_CHANGE_ROLE, [
    ...DEMO_CHANGE_CAPABILITIES
  ]);
  let finalCertificate = null;
  let finalPlan = [];
  let certifyAfterRecompileMs = 0;
  let progress = checkProgressPreserved(midpointState, midpointState, puzzle);
  if (recompileResult.kind === "ok") {
    const repaired = recompileResult.puzzle;
    const repairedState = recompileResult.state;
    const afterStart = performanceNow();
    const repairedCertificate = certify(repaired, repairedState);
    certifyAfterRecompileMs = round(performanceNow() - afterStart);
    if (!isCertificate(repairedCertificate)) {
      throw new Error(`repaired puzzle rejected: ${explainFailure(repairedCertificate)}`);
    }
    finalCertificate = repairedCertificate;
    finalPlan = solve(repaired, repairedState).plan;
    progress = checkProgressPreserved(midpointState, repairedState, repaired);
  }
  const changeRole = puzzle.roles.find((r) => r.id === DEMO_CHANGE_ROLE);
  return {
    puzzle,
    initialCertificate,
    initialPlan: initialSolve.plan,
    solveStates: initialSolve.statesExplored,
    midpointSteps,
    midpointState,
    midpointCertificate,
    changeRole: DEMO_CHANGE_ROLE,
    changeFrom: changeRole ? [...changeRole.capabilities] : [],
    changeTo: [...DEMO_CHANGE_CAPABILITIES],
    recompile: recompileResult,
    progress,
    finalCertificate,
    finalPlan,
    timings: {
      solveMs,
      certifyMs,
      certifyAfterRecompileMs,
      recompileMs: recompileResult.elapsedMs,
      totalMs: round(performanceNow() - t0)
    }
  };
}
function checkProgressPreserved(before, after, repaired) {
  const a = normalizeState(before);
  const b = normalizeState(after);
  const present = new Set(repaired.actions.map((x) => x.id));
  const vanishedActions = doneActionIds(a.history).filter((id) => !present.has(id));
  const factsUnchanged = sameSet(a.flags, b.flags) && sameSet(a.tokens, b.tokens);
  const historyIsPrefix = b.history.length >= a.history.length && a.history.every((event, i) => canonicalStringify(event) === canonicalStringify(b.history[i]));
  const doneActionsStillExist = vanishedActions.length === 0;
  return {
    preserved: factsUnchanged && historyIsPrefix && doneActionsStillExist,
    factsUnchanged,
    historyIsPrefix,
    doneActionsStillExist,
    vanishedActions
  };
}
function performanceNow() {
  const perf2 = globalThis.performance;
  return perf2 && typeof perf2.now === "function" ? perf2.now() : Date.now();
}
function round(value) {
  return Math.round(value * 1e3) / 1e3;
}
export {
  DEMO_CHANGE_CAPABILITIES,
  DEMO_CHANGE_ROLE,
  DEMO_PRIMITIVES,
  KNOWN_CAPABILITIES,
  NO_ROLE,
  RESERVED_PREFIX,
  ROLE_A,
  ROLE_B,
  ROLE_C,
  SCAN_MAX_OPTIONS,
  applyPlan,
  canonicalStringify,
  certify,
  checkAccessibility,
  checkProgressPreserved,
  cloneAction,
  clonePuzzle,
  convertAction,
  demoPuzzle,
  describeIssues,
  doneActionIds,
  emptyState,
  explainFailure,
  handOffToken,
  isActionEvent,
  isCapabilityChangeEvent,
  isCertificate,
  isReservedId,
  normalizeState,
  puzzleKey,
  recompile,
  refusalIssues,
  removeRole,
  replaceActions,
  roleHas,
  runDemo,
  sameSet,
  solve,
  sortedUnique,
  stableHash,
  totalStates,
  validatePuzzle,
  validateState,
  validationError,
  withRoleCapabilities
};
