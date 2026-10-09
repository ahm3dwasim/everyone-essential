/**
 * Regression tests for reachability, repair expressibility, and the reserved
 * namespace. Each test is a permanent guard for one invariant.
 *
 * The bar: a certificate must be a proof about a state the documented model can
 * actually reach, the recompiler may not call a repair inexpressible while a
 * primitive in the declared library expresses it, and no invalid input may reach
 * a certificate by any door -- public or internal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type Certificate,
  type CertifyResult,
  certify,
  explainFailure,
  isCertificate,
} from "../src/certify";
import { type RecompileResult, convertAction, recompile } from "../src/recompile";
import type { Action } from "../src/model";
import { type Puzzle, type State, emptyState } from "../src/model";
import {
  RESERVED_PREFIX,
  type ValidationError,
  type ValidationResult,
  validatePuzzle,
  validateState,
} from "../src/validate";
import { solve } from "../src/solve";
import * as api from "../src/api";
import { demoPuzzle } from "../src/demo";
import { historyFor } from "./helpers";

/* ------------------------------------------------------------------ */
/* Shared fixtures                                                     */
/* ------------------------------------------------------------------ */

function standardPrimitives(): Puzzle["primitives"] {
  return [
    { id: "dpad.grid", capability: "dpad", maxOptions: 9, splittable: false, label: "3x3 grid" },
    { id: "scan.paged", capability: "scan", maxOptions: 4, splittable: true, label: "scan" },
    { id: "voice.one", capability: "voice", maxOptions: 1, splittable: false, label: "voice" },
  ];
}

/* ------------------------------------------------------------------ */
/* state reachability                                                  */
/* ------------------------------------------------------------------ */

/**
 * The `forged` fixture: A holds `a`, B holds `b`, and a state claims
 * an action called `forged` was done. `forged` requires a token that is neither
 * private to a present role nor produced by anything, and its declared effect
 * (`irrelevant`) is the only thing standing in the state.
 *
 * The state is self-accounting -- every token in it comes from a listed done
 * action -- but it cannot arise: no order of play puts `never_available` in the
 * team's hands. A validator that only asks "is every entry accounted for?"
 * says yes, and a positive certificate follows.
 */
function forgedStateFixture(): { puzzle: Puzzle; state: State } {
  const puzzle: Puzzle = {
    id: "forged",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["a"] },
      { id: "B", capabilities: ["voice"], privateTokens: ["b"] },
    ],
    actions: [
      {
        id: "forged",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["never_available"],
        requiresFlags: [],
        producesTokens: ["irrelevant"],
        setsFlags: [],
        label: "forged step",
      },
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
  return { puzzle, state: { flags: [], tokens: ["irrelevant"], history: historyFor(puzzle, ["forged"]) } };
}

test("reachability-and-repair-1. a self-accounting but unreachable state is refused", () => {
  const { puzzle, state } = forgedStateFixture();

  const check = validateState(puzzle, state);
  assert.equal(check.ok, false, "the forged state is not reachable, so it must be refused");
  // The replay catches this at the event itself -- "forged" could
  // never have fired, because `never_available` was never known -- rather than
  // at the later fact-level cross-check that reports it as `unreachable_state`.
  assert.ok(
    check.errors.some((e) => e.kind === "invalid_history"),
    `expected an invalid_history error, got ${JSON.stringify(check.errors)}`,
  );

  // The state that never happened must not be able to carry a positive
  // certificate about progress.
  const result = certify(puzzle, state);
  assert.equal(isCertificate(result), false, `certify returned a certificate: ${JSON.stringify(result)}`);
  if (!isCertificate(result)) {
    assert.equal(result.kind, "invalid_puzzle");
    assert.equal(result.stateInvalid, true);
  }

  // The same puzzle from the empty state is genuinely solvable and both roles
  // are genuinely load-bearing, so the refusal above is about the state alone.
  const honest = certify(puzzle, emptyState());
  assert.equal(isCertificate(honest), true, "the puzzle itself should still certify");
  if (isCertificate(honest)) {
    assert.equal(honest.ok, true, explainFailure(honest));
  }
});

test("reachability-and-repair-1b. a reachable state in the same puzzle is accepted", () => {
  const { puzzle } = forgedStateFixture();
  // `forged` was never done, so it is not marked done; A really did bridge.
  const state: State = { flags: [], tokens: ["bridge"], history: historyFor(puzzle, ["a_make"]) };
  const check = validateState(puzzle, state);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

test("reachability-and-repair-1c. a done action whose declared effect is missing from the state is refused", () => {
  const { puzzle } = forgedStateFixture();
  // `a_make` is marked done but the token it declares it produces is absent.
  const state: State = { flags: [], tokens: [], history: historyFor(puzzle, ["a_make"]) };
  const check = validateState(puzzle, state);
  assert.equal(check.ok, false, "every declared effect of a done action must be present");
});

test("reachability-and-repair-1d. a flag nobody set is still refused", () => {
  const { puzzle } = forgedStateFixture();
  const state: State = { flags: ["goal"], tokens: ["bridge"], history: historyFor(puzzle, ["a_make"]) };
  const check = validateState(puzzle, state);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.kind === "unproduced_flag"));
});

/* ------------------------------------------------------------------ */
/* primitive selection                                                 */
/* ------------------------------------------------------------------ */

/**
 * The 9-option fixture: C owns a 9-way d-pad choice gated on its own
 * `c_answer` token; A supplies the `a` clue; B finishes the goal from B's `b`
 * plus the `x` C's action produces.
 *
 * C switches from `dpad + scan` to `scan`. The scan library offers
 * `maxOptions: 4, splittable: false` and `maxOptions: 2, splittable: true`. Only
 * the second can express a 9-way choice (2^4 = 16 >= 9), so a recompiler that
 * picks the *largest* primitive reports NO_VALID_RECOMPILE for a repair the
 * declared library can express.
 */
function nineOptionFixture(): Puzzle {
  return {
    id: "nine-option",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["a"] },
      { id: "B", capabilities: ["voice"], privateTokens: ["b"] },
      { id: "C", capabilities: ["dpad", "scan"], privateTokens: ["c_answer"] },
    ],
    actions: [
      {
        id: "a_bridge",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["a"],
        requiresFlags: [],
        producesTokens: ["bridge"],
        setsFlags: [],
        label: "A bridges",
      },
      {
        id: "c_choice",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["c_answer"],
        requiresFlags: [],
        producesTokens: ["x"],
        setsFlags: [],
        options: 9,
        answerToken: "c_answer",
        label: "C picks the right cell",
      },
      {
        id: "b_finish",
        performer: "B",
        needs: "voice",
        requiresTokens: ["b", "bridge", "x"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        label: "B finishes",
      },
    ],
    goalFlags: ["goal"],
    primitives: [
      { id: "dpad.grid", capability: "dpad", maxOptions: 9, splittable: false, label: "3x3 grid" },
      { id: "scan.paged", capability: "scan", maxOptions: 4, splittable: false, label: "scan, 4 per page" },
      { id: "scan.pair", capability: "scan", maxOptions: 2, splittable: true, label: "scan, 2 per step" },
      { id: "voice.one", capability: "voice", maxOptions: 1, splittable: false, label: "voice" },
    ],
  };
}

test("reachability-and-repair-2. the splittable primitive in the declared library is used", () => {
  const puzzle = nineOptionFixture();
  const start = emptyState();
  const before = certify(puzzle, start);
  assert.equal(isCertificate(before), true, "the original puzzle should certify");
  if (isCertificate(before)) assert.equal(before.ok, true, explainFailure(before));

  // The defect is inside conversion itself: the largest
  // primitive cannot express a 9-way choice and the smaller splittable one can,
  // so returning null here discards a repair the declared library expresses.
  const converted = convertAction(puzzle, puzzle.actions[1]!, "C", "scan");
  assert.notEqual(
    converted,
    null,
    "convertAction returned null although scan.pair (maxOptions 2, splittable) can express a 9-way choice",
  );
  if (converted) {
    assert.ok(
      converted.actions.length >= 2,
      `expected the choice to be split into chained steps, got ${converted.actions.length} action(s)`,
    );
    for (const step of converted.actions) {
      assert.equal(step.needs, "scan");
      assert.ok((step.options ?? 1) <= 2, `step "${step.id}" offers ${step.options} options, above scan.pair's 2`);
      assert.equal(step.answerToken, "c_answer", `step "${step.id}" dropped the answer token`);
    }
  }

  const result: RecompileResult = recompile(puzzle, start, "C", ["scan"], { maxDepth: 6 });
  assert.equal(
    result.kind,
    "ok",
    `expected a repair, got ${result.kind}: ${result.kind === "ok" ? "" : result.reason}; attempts: ${JSON.stringify(
      result.operatorsTried,
    )}`,
  );
  if (result.kind !== "ok") return;

  assert.equal(result.certificate.ok, true, explainFailure(result.certificate));

  // The witness uses split steps, and every role is still necessary.
  const steps = result.certificate.solvable.plan.filter((s) => s.performer === "C");
  assert.ok(steps.length >= 2, `expected C's action split into chained steps, got ${steps.length}`);
  for (const step of steps) {
    const action: Action | undefined = result.puzzle.actions.find((a) => a.id === step.action);
    assert.ok(action, `plan names unknown action ${step.action}`);
    assert.equal(action.needs, "scan", `${step.action} should be a scan action`);
  }
  for (const role of ["A", "B", "C"]) {
    assert.equal(
      result.certificate.necessity[role]?.necessary,
      true,
      `${role} was demoted to decorative by the repair`,
    );
  }

  // The token C's original action produced is still produced by the repaired chain.
  assert.ok(
    result.certificate.solvable.plan.some((s) => s.performer === "C"),
    "the plan should credit C",
  );
});

test("reachability-and-repair-2b. the split primitive is used when it is the only repair", () => {
  // The same fixture, reshaped so `reassign` has no legal target: role A's
  // bridging step is folded away and the finishing action becomes generic and
  // gates on the `x` token only C's action produces. Reassigning C's action to B
  // would still reach the goal while C does nothing, which the necessity check
  // refuses -- so the split conversion is the only repair left, and a recompiler
  // that cannot see scan.pair can only report a false refusal.
  const puzzle = nineOptionFixture();
  puzzle.actions = puzzle.actions.filter((a) => a.id !== "a_bridge");
  puzzle.roles = puzzle.roles
    .filter((r) => r.id !== "A")
    .map((r) => (r.id === "B" ? { ...r, capabilities: ["voice", "dpad"] as Puzzle["roles"][number]["capabilities"] } : r));
  const finish = puzzle.actions.find((a) => a.id === "b_finish")!;
  finish.performer = "any";
  finish.requiresTokens = ["b", "x"];

  const start = emptyState();
  const before = certify(puzzle, start);
  assert.equal(isCertificate(before), true, "the reshaped puzzle should still certify");
  if (isCertificate(before)) assert.equal(before.ok, true, explainFailure(before));

  const result = recompile(puzzle, start, "C", ["scan"], { maxDepth: 6 });
  assert.equal(
    result.kind,
    "ok",
    `expected the split repair, got ${result.kind}: ${
      result.kind === "ok" ? "" : result.reason
    }; attempts: ${JSON.stringify(result.operatorsTried)}`,
  );
  if (result.kind !== "ok") return;

  assert.ok(
    result.operatorsTried.some((a) => a.op === "convert" && a.ok),
    "the winning repair should be a conversion",
  );
  const steps = result.certificate.solvable.plan.filter((s) => s.performer === "C");
  assert.ok(steps.length >= 2, `expected C's choice split into chained steps, got ${steps.length}`);
  for (const step of steps) {
    const action: Action | undefined = result.puzzle.actions.find((a) => a.id === step.action);
    assert.equal(action?.needs, "scan", `${step.action} should be a scan action`);
  }
  for (const role of ["B", "C"]) {
    assert.equal(
      result.certificate.necessity[role]?.necessary,
      true,
      `${role} was demoted to decorative by the repair`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* no public bypass                                                    */
/* ------------------------------------------------------------------ */

/**
 * The reserved-role fixture: one role literally named `"any"`.
 *
 * It is deliberately a puzzle that *would* certify if the reserved name were
 * allowed -- the generic goal action requires the private token the `"any"` role
 * holds, and that role has the capability to perform it. So the only thing
 * standing between this input and an `ok: true` certificate is the gate, which
 * is exactly what makes it a probe for a bypass.
 */
function reservedRoleFixture(): Puzzle {
  return {
    id: "reserved-role",
    roles: [{ id: "any", capabilities: ["dpad"], privateTokens: ["a"] }],
    actions: [
      {
        id: "finish",
        performer: "any",
        needs: "dpad",
        requiresTokens: ["a"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        label: "finish",
      },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
}

test("reachability-and-repair-3. no public api entry point can certify the reserved-role fixture", () => {
  const puzzle = reservedRoleFixture();
  const state = emptyState();

  // Nothing named like an unvalidated producer may be on the surface at all.
  assert.equal(
    "certifyUnchecked" in api,
    false,
    "certifyUnchecked is exported from the public api; an exported name is not an access-control boundary",
  );

  // Whatever the public surface does export, none of it may hand back
  // `ok: true` for a puzzle `certify` refuses.
  const surface = api as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(surface)) {
    if (typeof value !== "function") continue;
    if (name === "explainFailure" || name === "refusalIssues" || name === "isCertificate") continue;
    let result: unknown;
    try {
      result = (value as (...args: unknown[]) => unknown)(puzzle, state);
    } catch {
      continue; // a throw is a refusal too; the point is no certificate
    }
    if (result && typeof result === "object" && (result as { hash?: unknown }).hash !== undefined) {
      assert.notEqual(
        (result as Certificate).ok,
        true,
        `public api entry "${name}" produced an ok certificate for the reserved-role fixture`,
      );
    }
  }

  // And the sanctioned gate still refuses it. There is only one gate:
  // there is no separate generated-input entry point.
  assert.equal(isCertificate(certify(puzzle, state)), false, "certify must refuse a role named any");
});

/* ------------------------------------------------------------------ */
/* recompile input handling                                            */
/* ------------------------------------------------------------------ */

test("reachability-and-repair-4. an invalid puzzle gives a typed invalid_input, not a definitive refusal", () => {
  const puzzle = reservedRoleFixture();
  const result = recompile(puzzle, emptyState(), "any", ["scan"]);
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
  if (result.kind !== "invalid_input") return;
  assert.ok(result.errors.length > 0, "an invalid input must come with the issues behind it");
  // Nothing was searched, so no claim about the operator space may be made.
  assert.equal(result.operatorsTried.length, 0);
});

test("reachability-and-repair-4b. an invalid state gives invalid_input", () => {
  const puzzle = nineOptionFixture();
  const badState: State = { flags: ["goal"], tokens: [], history: [] };
  const result = recompile(puzzle, badState, "C", ["scan"]);
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
});

test("reachability-and-repair-4c. an unknown role id gives invalid_input", () => {
  const puzzle = nineOptionFixture();
  const result = recompile(puzzle, emptyState(), "no_such_role", ["scan"]);
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
});

test("reachability-and-repair-4d. an unknown capability gives invalid_input", () => {
  const puzzle = nineOptionFixture();
  const result = recompile(
    puzzle,
    emptyState(),
    "C",
    ["telepathy"] as unknown as Puzzle["roles"][number]["capabilities"],
  );
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
});

test("reachability-and-repair-4e. an empty capability list gives invalid_input", () => {
  const puzzle = nineOptionFixture();
  const result = recompile(puzzle, emptyState(), "C", []);
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
});

/* ------------------------------------------------------------------ */
/* runtime shape validation                                            */
/* ------------------------------------------------------------------ */

test("reachability-and-repair-5. each value in this fixture table is refused with a typed error", () => {
  const good = nineOptionFixture();
  const primitives = good.primitives;

  const malformed: { name: string; value: unknown }[] = [
    { name: "null puzzle", value: null },
    { name: "undefined puzzle", value: undefined },
    { name: "a string instead of a puzzle", value: "not a puzzle" },
    { name: "roles is null", value: { id: "bad", roles: null, actions: [], goalFlags: ["goal"], primitives } },
    { name: "roles is a string", value: { id: "bad", roles: "A", actions: [], goalFlags: ["goal"], primitives } },
    { name: "roles is missing", value: { id: "bad", actions: [], goalFlags: ["goal"], primitives } },
    {
      name: "a role is null",
      value: { id: "bad", roles: [null], actions: [], goalFlags: ["goal"], primitives },
    },
    {
      name: "capabilities is not an array",
      value: {
        id: "bad",
        roles: [{ id: "A", capabilities: "dpad", privateTokens: [] }],
        actions: [],
        goalFlags: ["goal"],
        primitives,
      },
    },
    {
      name: "privateTokens is not an array",
      value: {
        id: "bad",
        roles: [{ id: "A", capabilities: ["dpad"], privateTokens: "a" }],
        actions: [],
        goalFlags: ["goal"],
        primitives,
      },
    },
    { name: "actions is null", value: { id: "bad", roles: [], actions: null, goalFlags: ["goal"], primitives } },
    {
      name: "an action is null",
      value: { id: "bad", roles: [good.roles[0]], actions: [null], goalFlags: ["goal"], primitives },
    },
    {
      name: "requiresTokens is a number",
      value: {
        id: "bad",
        roles: [good.roles[0]],
        actions: [{ ...good.actions[0], requiresTokens: 7 }],
        goalFlags: ["goal"],
        primitives,
      },
    },
    { name: "primitives is null", value: { id: "bad", roles: [], actions: [], goalFlags: ["goal"], primitives: null } },
    {
      name: "a primitive is null",
      value: { id: "bad", roles: [], actions: [], goalFlags: ["goal"], primitives: [null] },
    },
    {
      name: "goalFlags is a string",
      value: { id: "bad", roles: [], actions: [], goalFlags: "goal", primitives },
    },
    { name: "role id is a number", value: { id: "bad", roles: [{ id: 7 }], actions: [], goalFlags: ["goal"], primitives } },
  ];

  for (const { name, value } of malformed) {
    let result: ValidationResult;
    try {
      result = validatePuzzle(value as unknown as Puzzle);
    } catch (error) {
      assert.fail(`validatePuzzle threw on ${name}: ${String(error)}`);
    }
    assert.equal(result.ok, false, `validatePuzzle accepted ${name}`);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.ok(result.errors.length > 0, `${name} produced no issue`);
  }

  // The same guard, one level down: a state that is not a state.
  const malformedStates: { name: string; value: unknown }[] = [
    { name: "null state", value: null },
    { name: "undefined state", value: undefined },
    { name: "flags is null", value: { flags: null, tokens: [], history: [] } },
    { name: "tokens is a string", value: { flags: [], tokens: "x", history: [] } },
    { name: "history is missing", value: { flags: [], tokens: [] } },
    { name: "a flag is a number", value: { flags: [7], tokens: [], history: [] } },
  ];

  for (const { name, value } of malformedStates) {
    let result: ValidationResult;
    try {
      result = validateState(good, value as unknown as State);
    } catch (error) {
      assert.fail(`validateState threw on ${name}: ${String(error)}`);
    }
    assert.equal(result.ok, false, `validateState accepted ${name}`);
  }
});

test("reachability-and-repair-5b. certify answers each of these four mis-shaped (puzzle, state) pairs with a typed refusal", () => {
  const cases: { name: string; puzzle: unknown; state: unknown }[] = [
    { name: "null puzzle", puzzle: null, state: emptyState() },
    { name: "roles null", puzzle: { id: "bad", roles: null, actions: [], goalFlags: ["goal"], primitives: [] }, state: emptyState() },
    { name: "null state", puzzle: demoPuzzle(), state: null },
    { name: "state flags null", puzzle: demoPuzzle(), state: { flags: null, tokens: [], history: [] } },
  ];

  for (const { name, puzzle, state } of cases) {
    let result: CertifyResult;
    try {
      result = certify(puzzle as unknown as Puzzle, state as unknown as State);
    } catch (error) {
      assert.fail(`certify threw on ${name}: ${String(error)}`);
    }
    assert.equal(isCertificate(result), false, `certify certified ${name}`);
    assert.equal((result as ValidationError).kind, "invalid_puzzle");
  }
});

/* ------------------------------------------------------------------ */
/* hard state cap                                                      */
/* ------------------------------------------------------------------ */

/**
 * The 128-action fixture: one role with a `dpad` input and 128
 * independent actions whose flags form a chain of prerequisites, so the graph is
 * legal and the search has 128 children to add from the very first expansion.
 */
function wideFixture(): Puzzle {
  const size = 128;
  const actions: Puzzle["actions"] = [];
  for (let i = 0; i < size; i++) {
    actions.push({
      id: `step${i}`,
      performer: "A",
      needs: "dpad",
      requiresTokens: [],
      requiresFlags: i === 0 ? [] : [`f${i - 1}`],
      producesTokens: [],
      setsFlags: [`f${i}`],
    });
  }
  return {
    id: "wide",
    roles: [{ id: "A", capabilities: ["dpad"], privateTokens: [] }],
    actions,
    goalFlags: ["f127"],
    primitives: standardPrimitives(),
  };
}

test("reachability-and-repair-6. maxStates is a hard cap checked at insertion", () => {
  const puzzle = wideFixture();
  const result = solve(puzzle, emptyState(), { maxStates: 1 });
  assert.equal(result.status, "unsolvable");
  assert.equal(result.truncated, true, "the search must report that it was cut short");
  assert.ok(
    result.statesExplored <= 1,
    `statesExplored was ${result.statesExplored}; maxStates: 1 is a hard cap on states allocated`,
  );
});

test("reachability-and-repair-6b. maxStates: 0 is not a positive integer, so it is refused rather than run", () => {
  // `maxStates` must be a positive integer or the search must not run
  // at all -- 0 is not treated as "a valid but tiny cap".
  const puzzle = wideFixture();
  const result = solve(puzzle, emptyState(), { maxStates: 0 });
  assert.equal(result.status, "invalid_options");
  assert.equal(result.statesExplored, 0);
  assert.ok(result.reason && /maxStates/.test(result.reason));
});

test("reachability-and-repair-6c. a cap large enough to finish is not reported as truncated", () => {
  const puzzle = wideFixture();
  const result = solve(puzzle, emptyState(), { maxStates: 100_000 });
  assert.equal(result.status, "solvable");
  assert.equal(result.truncated, false);
  assert.equal(result.plan.length, 128);
});

/* ------------------------------------------------------------------ */
/* The earlier suite still holds                                      */
/* ------------------------------------------------------------------ */

test("reachability-and-repair-sanity. the demo still certifies and recompiles", () => {
  const puzzle = demoPuzzle();
  const certificate = certify(puzzle, emptyState());
  assert.equal(isCertificate(certificate), true, isCertificate(certificate) ? "" : (certificate as ValidationError).reason);
  if (isCertificate(certificate)) assert.equal(certificate.ok, true, explainFailure(certificate));

  const midpoint: State = { flags: [], tokens: [], history: [] };
  const repaired = recompile(puzzle, midpoint, "C", ["scan"]);
  assert.equal(repaired.kind, "ok", repaired.kind === "ok" ? "" : repaired.reason);
  if (repaired.kind === "ok") {
    for (const id of repaired.puzzle.actions.map((a) => a.id)) {
      if (id.startsWith(RESERVED_PREFIX)) {
        assert.ok(id.length > RESERVED_PREFIX.length);
      }
    }
  }
});
