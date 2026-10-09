/**
 * Regression tests for history replay, the reserved namespace, primitive shape
 * validation, solver-option validation, and the de-duplicated flag diagnostic.
 * Each test is a permanent guard for one invariant.
 *
 * The bar: a completed action that could never have fired -- wrong prerequisite,
 * wrong capability, wrong performer -- must be refused even when it declares no
 * effect to cross-check; no public entry point may certify an author puzzle
 * whose ids live in the reserved namespace; a malformed primitive must be
 * refused, not silently accepted; and a solver option that cannot be honoured
 * must stop the search rather than silently disable the bound it names.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, explainFailure, isCertificate } from "../src/certify";
import { type Puzzle, type State, emptyState } from "../src/model";
import { recompile } from "../src/recompile";
import { validatePuzzle, validateState } from "../src/validate";
import { solve } from "../src/solve";
import * as api from "../src/api";
import { historyFor } from "./helpers";

/* ------------------------------------------------------------------ */
/* reachability via an explicit history                                */
/* ------------------------------------------------------------------ */

function standardPrimitives(): Puzzle["primitives"] {
  return [
    { id: "dpad.grid", capability: "dpad", maxOptions: 9, splittable: false, label: "3x3 grid" },
    { id: "scan.paged", capability: "scan", maxOptions: 4, splittable: true, label: "scan" },
    { id: "voice.one", capability: "voice", maxOptions: 1, splittable: false, label: "voice" },
  ];
}

/**
 * The base fixture: A holds `a`, B holds `b`. A can bridge and B can
 * finish, so the puzzle is genuinely solvable and both roles genuinely
 * necessary -- the only question each test asks is whether a FORGED completed
 * action can be smuggled into `history` on top of that honest puzzle.
 */
function baseFixture(extra: Puzzle["actions"][number]): Puzzle {
  return {
    id: "forged-base",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["a"] },
      { id: "B", capabilities: ["voice"], privateTokens: ["b"] },
    ],
    actions: [
      extra,
      {
        id: "a_make",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["a"],
        requiresFlags: [],
        producesTokens: ["bridge"],
        setsFlags: [],
        label: "A bridges",
      },
      {
        id: "b_finish",
        performer: "B",
        needs: "voice",
        requiresTokens: ["b", "bridge"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        label: "B finishes",
      },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
}

test("history-replay-1a. forged_noop: a completed action with an impossible prerequisite and NO effects is refused", () => {
  // The gap a fact-level check leaves open: an action that produces nothing gives a
  // fact-level cross-check nothing to catch, because nothing about the state's
  // own flags/tokens depends on whether it fired. Only checking the EVENT
  // itself -- were its prerequisites actually known at that point? -- catches
  // it.
  const puzzle = baseFixture({
    id: "forged_noop",
    performer: "A",
    needs: "dpad",
    requiresTokens: ["never_available"],
    requiresFlags: [],
    producesTokens: [],
    setsFlags: [],
    label: "forged, no effects at all",
  });
  const state: State = { flags: [], tokens: [], history: historyFor(puzzle, ["forged_noop"]) };

  const check = validateState(puzzle, state);
  assert.equal(check.ok, false, "forged_noop could never have fired: never_available is not known");
  assert.ok(
    check.errors.some((e) => e.kind === "invalid_history"),
    `expected invalid_history, got ${JSON.stringify(check.errors)}`,
  );

  const result = certify(puzzle, state);
  assert.equal(isCertificate(result), false, "a state containing an impossible completed action must not certify");

  // The same puzzle from the empty state is honestly solvable and both roles
  // are honestly necessary: the refusal above is about the forged state alone.
  const honest = certify(puzzle, emptyState());
  assert.equal(isCertificate(honest), true);
  if (isCertificate(honest)) assert.equal(honest.ok, true, explainFailure(honest));
});

test("history-replay-1b. forged_scan: a completed action claimed under a capability the performer never held is refused", () => {
  // A only ever has "dpad". A history event crediting A with performing a
  // "scan" action -- even one whose OWN token prerequisites are trivially
  // satisfied -- must be refused: a replay that never checks the
  // performer's capability against what the action actually needs at all.
  const puzzle = baseFixture({
    id: "forged_scan",
    performer: "A",
    needs: "scan",
    requiresTokens: [],
    requiresFlags: [],
    producesTokens: ["bridge"],
    setsFlags: [],
    label: "forged, wrong capability",
  });
  const state: State = {
    flags: [],
    tokens: ["bridge"],
    history: [{ kind: "action", actionId: "forged_scan", performer: "A", capability: "scan" }],
  };

  const check = validateState(puzzle, state);
  assert.equal(check.ok, false, "A never had scan, so forged_scan could not have fired");
  assert.ok(check.errors.some((e) => e.kind === "invalid_history"));

  assert.equal(isCertificate(certify(puzzle, state)), false);
});

test("history-replay-1c. a role that performed a dpad action, then switched to scan, still validates after the switch", () => {
  // The positive control: a REAL history -- C really did do dpad work before
  // recompiling to scan -- must not be collateral damage from closing 1a/1b.
  const puzzle: Puzzle = {
    id: "switch-mid-game",
    roles: [{ id: "C", capabilities: ["dpad"], privateTokens: ["clue"] }],
    actions: [
      {
        id: "c_dpad_step",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["clue"],
        requiresFlags: [],
        producesTokens: ["progress"],
        setsFlags: [],
        label: "C's dpad work",
      },
      {
        id: "c_scan_step",
        performer: "C",
        needs: "scan",
        requiresTokens: ["progress"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        label: "C's scan work",
      },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };

  const midpoint: State = { flags: [], tokens: ["progress"], history: historyFor(puzzle, ["c_dpad_step"]) };
  assert.equal(validateState(puzzle, midpoint).ok, true, JSON.stringify(validateState(puzzle, midpoint).errors));

  const result = recompile(puzzle, midpoint, "C", ["scan"]);
  assert.equal(result.kind, "ok", result.kind === "ok" ? "" : JSON.stringify(result));
  if (result.kind !== "ok") return;

  // The old dpad event survives untouched; only the capability_change is new.
  assert.deepEqual(result.state.history.slice(0, midpoint.history.length), midpoint.history);
  assert.equal(result.certificate.ok, true, explainFailure(result.certificate));

  // And a full replay -- old dpad action, then the switch, then the new scan
  // action -- validates end to end.
  const plan = solve(result.puzzle, result.state).plan;
  assert.ok(plan.some((s) => s.action === "c_scan_step"));
});

test("history-replay-1d. a capability_change whose `from` does not match the replayed set is refused", () => {
  // A single capability_change's `from` is the sole record of what a role held
  // BEFORE any change history remembers -- there is nothing else to check it
  // against, the same way `puzzle.roles[x].capabilities` is trusted outright
  // for a role no change ever mentions. The checkable case is the SECOND
  // change in a chain: its `from` must equal what the FIRST change actually
  // produced, not whatever the forger writes.
  const puzzle: Puzzle = {
    id: "bad-from-chained",
    roles: [{ id: "C", capabilities: ["voice"], privateTokens: [] }],
    actions: [],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
  const state: State = {
    flags: [],
    tokens: [],
    history: [
      { kind: "capability_change", role: "C", from: ["dpad"], to: ["scan"] },
      // The replayed set after the first change is ["scan"], not ["dpad"].
      { kind: "capability_change", role: "C", from: ["dpad"], to: ["voice"] },
    ],
  };
  const check = validateState(puzzle, state);
  assert.equal(check.ok, false, "the second change's from does not match what the first change produced");
  assert.ok(check.errors.some((e) => e.kind === "invalid_history"));

  // The honestly-chained version -- from matches what came before at each step
  // -- validates.
  const honest: State = {
    flags: [],
    tokens: [],
    history: [
      { kind: "capability_change", role: "C", from: ["dpad"], to: ["scan"] },
      { kind: "capability_change", role: "C", from: ["scan"], to: ["voice"] },
    ],
  };
  assert.equal(validateState(puzzle, honest).ok, true, JSON.stringify(validateState(puzzle, honest).errors));
});

test("history-replay-1e. out-of-order history (an action before its prerequisite) is refused", () => {
  const puzzle: Puzzle = {
    id: "out-of-order",
    roles: [{ id: "A", capabilities: ["dpad"], privateTokens: [] }],
    actions: [
      {
        id: "first",
        performer: "A",
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["seed"],
        setsFlags: [],
      },
      {
        id: "second",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["seed"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
  // "second" listed before "first": "seed" is not yet known when it claims to fire.
  const state: State = {
    flags: ["goal"],
    tokens: ["seed"],
    history: [
      { kind: "action", actionId: "second", performer: "A", capability: "dpad" },
      { kind: "action", actionId: "first", performer: "A", capability: "dpad" },
    ],
  };
  const check = validateState(puzzle, state);
  assert.equal(check.ok, false, "an action performed before its own prerequisite must be refused");
  assert.ok(check.errors.some((e) => e.kind === "invalid_history"));

  // The same two events, correctly ordered, validate.
  const good: State = { flags: ["goal"], tokens: ["seed"], history: historyFor(puzzle, ["first", "second"]) };
  assert.equal(validateState(puzzle, good).ok, true, JSON.stringify(validateState(puzzle, good).errors));
});

test("history-replay-1f. recompile's returned state is the old history plus exactly one appended event", () => {
  const puzzle: Puzzle = {
    id: "strict-prefix",
    roles: [{ id: "C", capabilities: ["dpad"], privateTokens: [] }],
    actions: [
      {
        id: "finish",
        performer: "C",
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
  const start = emptyState();
  const result = recompile(puzzle, start, "C", ["scan"]);
  assert.equal(result.kind, "ok", result.kind === "ok" ? "" : JSON.stringify(result));
  if (result.kind !== "ok") return;

  assert.equal(result.state.history.length, start.history.length + 1);
  assert.deepEqual(result.state.history.slice(0, start.history.length), start.history);
  const appended = result.state.history[result.state.history.length - 1]!;
  assert.deepEqual(appended, { kind: "capability_change", role: "C", from: ["dpad"], to: ["scan"] });
  // Facts never move -- only history grows.
  assert.deepEqual(result.state.flags, start.flags);
  assert.deepEqual(result.state.tokens, start.tokens);
});

/* ------------------------------------------------------------------ */
/* no public generated-input path                                      */
/* ------------------------------------------------------------------ */

/** The fixture: role, action, private token and goal all start with `§`. */
function reservedNamespaceFixture(): { puzzle: Puzzle; state: State } {
  const puzzle: Puzzle = {
    id: "reserved-namespace",
    roles: [{ id: "§role", capabilities: ["dpad"], privateTokens: ["§token"] }],
    actions: [
      {
        id: "§action",
        performer: "§role",
        needs: "dpad",
        requiresTokens: ["§token"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["§goal"],
        label: "§ action",
      },
    ],
    goalFlags: ["§goal"],
    primitives: standardPrimitives(),
  };
  return { puzzle, state: emptyState() };
}

test("history-replay-2. certifyGenerated is not part of api.ts, and no api.ts export certifies the §-namespace fixture", () => {
  assert.equal(
    "certifyGenerated" in api,
    false,
    "certifyGenerated must not be re-exported from the public surface",
  );

  const { puzzle, state } = reservedNamespaceFixture();
  const surface = api as unknown as Record<string, unknown>;
  let calledSomething = false;
  for (const [name, value] of Object.entries(surface)) {
    if (typeof value !== "function") continue;
    calledSomething = true;
    let result: unknown;
    try {
      result = (value as (...args: unknown[]) => unknown)(puzzle, state);
    } catch {
      continue; // a throw is a refusal too
    }
    if (result && typeof result === "object" && (result as { hash?: unknown }).hash !== undefined) {
      assert.notEqual(
        (result as { ok?: unknown }).ok,
        true,
        `public api entry "${name}" produced an ok certificate for the §-namespace fixture`,
      );
    }
  }
  assert.ok(calledSomething, "the probe did not actually call anything -- it would pass vacuously");

  // And the sanctioned gate still refuses it outright.
  assert.equal(isCertificate(api.certify(puzzle, state)), false);
});

/* ------------------------------------------------------------------ */
/* complete runtime shape validation                                   */
/* ------------------------------------------------------------------ */

function minimalPuzzleWithPrimitives(primitives: unknown[]): unknown {
  return {
    id: "shape-probe",
    roles: [],
    actions: [],
    goalFlags: ["goal"],
    primitives,
  };
}

test("history-replay-3a. a primitive with a non-boolean splittable is refused", () => {
  const puzzle = minimalPuzzleWithPrimitives([
    { id: "p", capability: "scan", maxOptions: 2, splittable: "false", label: "x" },
  ]);
  const result = validatePuzzle(puzzle as Puzzle);
  assert.equal(result.ok, false, "splittable: \"false\" (a truthy string) must not be accepted as splittable: true");
  if (result.ok) return;
  assert.ok(result.errors.some((e) => /splittable/.test(e.detail)));
});

test("history-replay-3b. a primitive with a non-string label is refused", () => {
  const puzzle = minimalPuzzleWithPrimitives([
    { id: "p", capability: "scan", maxOptions: 2, splittable: true, label: null },
  ]);
  const result = validatePuzzle(puzzle as Puzzle);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => /label/.test(e.detail)));
});

test("history-replay-3c. duplicate primitive ids are refused", () => {
  const puzzle = minimalPuzzleWithPrimitives([
    { id: "dup", capability: "scan", maxOptions: 2, splittable: true, label: "a" },
    { id: "dup", capability: "dpad", maxOptions: 4, splittable: false, label: "b" },
  ]);
  const result = validatePuzzle(puzzle as Puzzle);
  assert.equal(result.ok, false, "two primitives sharing an id must be refused");
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.kind === "duplicate_id"));
});

test("history-replay-3d. a primitive with a missing id is refused", () => {
  const puzzle = minimalPuzzleWithPrimitives([{ capability: "scan", maxOptions: 2, splittable: true, label: "a" }]);
  const result = validatePuzzle(puzzle as Puzzle);
  assert.equal(result.ok, false);
});

test("history-replay-3e. a puzzle with no id at all is refused", () => {
  const puzzle = {
    roles: [],
    actions: [],
    goalFlags: ["goal"],
    primitives: [],
  };
  const result = validatePuzzle(puzzle as unknown as Puzzle);
  assert.equal(result.ok, false, "a missing puzzle.id must be reported, not pass silently");
  if (result.ok) return;
  assert.ok(result.errors.some((e) => /puzzle\.id/.test(e.detail)));
});

/* ------------------------------------------------------------------ */
/* solver options validated                                            */
/* ------------------------------------------------------------------ */

function unsolvablePuzzle(actions: number): Puzzle {
  return {
    id: `unsolvable-${actions}`,
    roles: [{ id: "A", capabilities: ["dpad"], privateTokens: [] }],
    actions: Array.from({ length: actions }, (_, i) => ({
      id: `a${i}`,
      performer: "A",
      needs: "dpad" as const,
      requiresTokens: [],
      requiresFlags: [],
      producesTokens: [],
      setsFlags: [`f${i}`],
    })),
    goalFlags: ["never"],
    primitives: standardPrimitives(),
  };
}

test("history-replay-4a. maxStates: NaN is refused rather than silently unbounded", () => {
  const puzzle = unsolvablePuzzle(10);
  const result = solve(puzzle, emptyState(), { maxStates: Number.NaN });
  assert.equal(result.status, "invalid_options");
  assert.equal(result.statesExplored, 0, "an invalid option must stop the search before it allocates anything");
});

test("history-replay-4b. maxStates: a string is refused rather than silently unbounded", () => {
  const puzzle = unsolvablePuzzle(10);
  const result = solve(puzzle, emptyState(), { maxStates: "not-a-number" as unknown as number });
  assert.equal(result.status, "invalid_options");
  assert.equal(result.statesExplored, 0);
});

test("history-replay-4c. a well-formed maxStates still runs normally", () => {
  const puzzle = unsolvablePuzzle(10);
  const result = solve(puzzle, emptyState(), { maxStates: 5 });
  assert.equal(result.status, "unsolvable");
  assert.equal(result.truncated, true);
});

/* ------------------------------------------------------------------ */
/* duplicate diagnostics                                                */
/* ------------------------------------------------------------------ */

test("history-replay-5. a lone bad flag yields exactly one issue, not two", () => {
  const puzzle: Puzzle = {
    id: "ghost-flag",
    roles: [],
    actions: [],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
  const state: State = { flags: ["ghost"], tokens: [], history: [] };
  const check = validateState(puzzle, state);
  assert.equal(check.ok, false);
  const ghostIssues = check.errors.filter((e) => e.detail.includes("ghost"));
  assert.equal(ghostIssues.length, 1, `expected exactly one issue about "ghost", got ${JSON.stringify(ghostIssues)}`);
});
