/**
 * Regression tests for certificate and recompile correctness. Each test is a
 * permanent guard for one invariant.
 *
 * The bar these tests hold: a certificate must be a proof about the puzzle
 * the caller actually handed over, and the recompiler must never call an
 * unsearched repair space "no repair exists".
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { type CertifyResult, certify, explainFailure } from "../src/certify";
import { type RecompileResult, convertAction, recompile } from "../src/recompile";
import { type Puzzle, type State, emptyState, normalizeState, removeRole } from "../src/model";
import {
  RESERVED_PREFIX,
  type ValidationError,
  describeIssues,
  validatePuzzle,
  validateState,
} from "../src/validate";
import { solve, stateKey } from "../src/solve";
import { demoPuzzle } from "../src/demo";
import { historyFor } from "./helpers";

/* ------------------------------------------------------------------ */
/* Shared fixtures                                                     */
/* ------------------------------------------------------------------ */

function primitives(): Puzzle["primitives"] {
  return [
    { id: "dpad.grid", capability: "dpad", maxOptions: 9, splittable: false, label: "3x3 grid" },
    { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
    { id: "scan.paged", capability: "scan", maxOptions: 4, splittable: true, label: "scan" },
    { id: "voice.confirm", capability: "voice", maxOptions: 1, splittable: false, label: "speak" },
  ];
}

/** The certificate's `ok` for a puzzle the test expects to be well formed. */
function certifyOk(puzzle: Puzzle, state: State): boolean {
  const result = certify(puzzle, state);
  assert.ok(!isRefusal(result), `expected a certificate, got a refusal: ${explainFailure(result)}`);
  if (isRefusal(result)) throw new Error("unreachable");
  return result.ok;
}

/** Is a result a refusal rather than a certificate? */
function isRefusal(result: CertifyResult): result is ValidationError {
  return (result as ValidationError).kind === "invalid_puzzle";
}

/* ------------------------------------------------------------------ */
/* ok must depend on necessity                                        */
/* ------------------------------------------------------------------ */

/**
 * B's key-maker is the FIRST action, so it is the one breadth-first search
 * reaches first: the witness plan really does name B, and B really does consume
 * its own private token, so B is meaningful by both rules in
 * `checkMeaningfulness`.
 *
 * But C can make the same key itself (`c_make_key`), so removing B leaves the
 * goal reachable and B is NOT necessary. The two predicates disagree, which is
 * the whole point: a plan that mentions a role is not evidence that the role is
 * load-bearing. C, which alone can finish, stays necessary throughout.
 *
 * An `ok` that never consults
 * `necessity`. Deleting the necessity term from `ok` turns this test red.
 */
function puzzleWithMeaningfulButUnnecessaryRole(): Puzzle {
  return {
    id: "meaningful-but-unnecessary",
    roles: [
      { id: "B", capabilities: ["dpad"], privateTokens: ["b_clue"] },
      { id: "C", capabilities: ["dpad"], privateTokens: ["c_seed"] },
    ],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        id: "b_make_key",
        performer: "B",
        needs: "dpad",
        requiresTokens: ["b_clue"],
        requiresFlags: [],
        producesTokens: ["key"],
        setsFlags: [],
      },
      {
        id: "c_make_key",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["c_seed"],
        requiresFlags: [],
        producesTokens: ["key"],
        setsFlags: [],
      },
      {
        id: "c_finish",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["key"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
}

test("1. a role that is meaningful but not necessary sinks the certificate", () => {
  const certificate = certify(puzzleWithMeaningfulButUnnecessaryRole(), emptyState());
  assert.equal(isRefusal(certificate), false);
  if (isRefusal(certificate)) return;

  // B really does appear on the witness plan...
  assert.ok(
    certificate.solvable.plan.some((s) => s.performer === "B"),
    "B should be on the plan, otherwise this fixture is not testing meaningfulness",
  );
  assert.equal(certificate.meaningful["B"]?.meaningful, true, "B is meaningful by plan participation");

  // ...and is still not necessary, because C can make the same key alone.
  assert.equal(certificate.necessity["B"]?.necessary, false, "C can reach the goal without B");
  assert.equal(certificate.necessity["B"]?.proven, true);
  assert.equal(certificate.necessity["C"]?.necessary, true, "C is the only one who can finish");

  // Therefore ok must be false. This is the assertion the mutation breaks.
  assert.equal(certificate.ok, false, "ok must require necessity, not just meaningfulness");
});

/* ------------------------------------------------------------------ */
/* choices have semantics                                              */
/* ------------------------------------------------------------------ */

/**
 * A four-option safe. Choosing correctly requires knowing `safe_answer`; a
 * wrong choice does nothing, so without the token the action can never fire.
 */
function puzzleWithChoice(withAnswerToken: boolean): Puzzle {
  return {
    id: "choice",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["a_clue"] },
      { id: "B", capabilities: ["dpad"], privateTokens: ["b_clue", "safe_answer"] },
    ],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        id: "b_reveal",
        performer: "B",
        needs: "dpad",
        requiresTokens: ["b_clue"],
        requiresFlags: [],
        producesTokens: ["revealed"],
        setsFlags: [],
      },
      {
        id: "a_open_safe",
        performer: "A",
        needs: "dpad",
        requiresTokens: withAnswerToken ? ["a_clue", "revealed", "safe_answer"] : ["a_clue", "revealed"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 4,
        answerToken: "safe_answer",
      },
    ],
  };
}

test("2. a choice whose answer token is in requiresTokens certifies", () => {
  const certificate = certify(puzzleWithChoice(true), emptyState());
  assert.equal(isRefusal(certificate), false);
  if (isRefusal(certificate)) return;
  assert.equal(certificate.ok, true, explainFailure(certificate));
});

test("2. a multi-option action whose answer token is not required is invalid", () => {
  const result = certify(puzzleWithChoice(false), emptyState());
  assert.equal(isRefusal(result), true, "a choice with no required answer token must not certify");

  const puzzleCheck = validatePuzzle(puzzleWithChoice(false));
  assert.equal(puzzleCheck.ok, false);
  assert.ok(
    puzzleCheck.errors.some((e) => /answerToken/.test(e.detail) && e.action === "a_open_safe"),
    `expected an answerToken error, got ${JSON.stringify(puzzleCheck.errors)}`,
  );
});

test("2. without the answer token the choice genuinely cannot fire", () => {
  const puzzle = puzzleWithChoice(true);
  // Strip the answer token from the puzzle: the safe cannot be opened.
  const stripped: Puzzle = {
    ...puzzle,
    roles: puzzle.roles.map((r) =>
      r.id === "B" ? { ...r, privateTokens: r.privateTokens.filter((t) => t !== "safe_answer") } : r,
    ),
  };
  const result = solve(stripped, emptyState());
  assert.equal(result.status, "unsolvable", "the choice must not fire without its answer token");
  assert.equal(result.truncated, false);
});

test("2. options must be a positive integer", () => {
  for (const bad of [0, -1, 2.5, Number.NaN]) {
    const puzzle = puzzleWithChoice(true);
    puzzle.actions[1]!.options = bad;
    const check = validatePuzzle(puzzle);
    assert.equal(check.ok, false, `options: ${String(bad)} must be rejected`);
    assert.ok(
      check.errors.some((e) => /options/.test(e.detail)),
      `expected an options error for ${String(bad)}`,
    );
  }
});

test("2. a single-option action needs no answer token", () => {
  const puzzle = puzzleWithChoice(true);
  const action = puzzle.actions[1]!;
  action.options = 1;
  delete action.answerToken;
  assert.equal(validatePuzzle(puzzle).ok, true);
  const certificate = certify(puzzle, emptyState());
  assert.equal(isRefusal(certificate), false);
  if (!isRefusal(certificate)) assert.equal(certificate.ok, true);
});

/* ------------------------------------------------------------------ */
/* reserved and duplicate identifiers                                  */
/* ------------------------------------------------------------------ */

function roleNamedAny(): Puzzle {
  return {
    id: "role-named-any",
    roles: [
      { id: "any", capabilities: ["dpad"], privateTokens: [] },
      { id: "B", capabilities: ["dpad"], privateTokens: ["b_key"] },
    ],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        id: "generic",
        performer: "any",
        needs: "dpad",
        requiresTokens: ["b_key"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
}

test("3. a role named \"any\" is rejected before anything is certified", () => {
  const check = validatePuzzle(roleNamedAny());
  assert.equal(check.ok, false);
  assert.ok(
    check.errors.some((e) => e.role === "any" && /reserved/.test(e.detail)),
    `expected a reserved-id error, got ${JSON.stringify(check.errors)}`,
  );

  const result = certify(roleNamedAny(), emptyState());
  assert.equal(isRefusal(result), true, "an invalid puzzle must never produce a certificate");
  assert.equal("hash" in result, false, "a refusal is not a certificate and carries no hash");
});

test("3. duplicate role, action and token ids are rejected", () => {
  const duplicateRoles = puzzleWithChoice(true);
  duplicateRoles.roles.push({ id: "A", capabilities: ["dpad"], privateTokens: [] });
  assert.equal(validatePuzzle(duplicateRoles).ok, false);

  const duplicateActions = puzzleWithChoice(true);
  duplicateActions.actions.push({ ...duplicateActions.actions[0]! });
  assert.equal(validatePuzzle(duplicateActions).ok, false);

  const duplicateTokens = puzzleWithChoice(true);
  duplicateTokens.roles[1]!.privateTokens = ["b_clue", "b_clue"];
  assert.equal(validatePuzzle(duplicateTokens).ok, false);
});

test("3. unknown capabilities and empty ids are rejected", () => {
  const unknownCapability = puzzleWithChoice(true);
  (unknownCapability.actions[0] as { needs: unknown }).needs = "telepathy";
  assert.equal(validatePuzzle(unknownCapability).ok, false);

  const emptyRoleId = puzzleWithChoice(true);
  emptyRoleId.roles[0]!.id = "";
  assert.equal(validatePuzzle(emptyRoleId).ok, false);

  const emptyActionId = puzzleWithChoice(true);
  emptyActionId.actions[0]!.id = "";
  assert.equal(validatePuzzle(emptyActionId).ok, false);
});

test("3. the reserved namespace is refused in author ids", () => {
  const puzzle = puzzleWithChoice(true);
  puzzle.roles[0]!.privateTokens = ["§a_clue"];
  const check = validatePuzzle(puzzle);
  assert.equal(check.ok, false, "author ids must not use the generator's namespace");
  assert.ok(check.errors.some((e) => /reserved/.test(e.detail)));
});

test("3. a generic action is never deleted by removeRole", () => {
  const puzzle = puzzleWithChoice(true);
  puzzle.actions.push({
    id: "generic_helper",
    performer: "any",
    needs: "dpad",
    requiresTokens: [],
    requiresFlags: [],
    producesTokens: ["helper_token"],
    setsFlags: [],
  });
  assert.equal(validatePuzzle(puzzle).ok, true);

  const removed = removeRole(puzzle, "A");
  assert.ok(
    removed.actions.some((a) => a.id === "generic_helper"),
    "removing a role must not remove actions that any capable role can perform",
  );
  assert.ok(
    !removed.actions.some((a) => a.id === "a_open_safe"),
    "removing a role must still remove the actions only that role could perform",
  );
});

test("3. resolving a generic performer checks capability", () => {
  // The first role in puzzle order cannot do the work; the second can. A
  // resolver that just takes roles[0] credits the wrong player.
  const puzzle: Puzzle = {
    id: "generic-capability",
    roles: [
      { id: "A", capabilities: ["voice"], privateTokens: [] },
      { id: "B", capabilities: ["dpad"], privateTokens: ["b_key"] },
    ],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        id: "generic",
        performer: "any",
        needs: "dpad",
        requiresTokens: ["b_key"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
  const plan = solve(puzzle, emptyState()).plan;
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.performer, "B", "the generic action must be credited to a role that has dpad");
});

/* ------------------------------------------------------------------ */
/* generic actions are repairable                                      */
/* ------------------------------------------------------------------ */

/**
 * The fixture: the only dpad in the room belongs to C, and the
 * goal-setting action is generic with a dpad requirement. Change C's input to
 * scan and BOTH actions are stranded -- C's own `c_read`, and `generic_finish`,
 * which no longer has any capable role at all. Hand-editing both `needs` fields
 * to scan yields a certificate, so a repair exists in the operator language.
 * Answering NO_VALID_RECOMPILE here comes of operator generation only looking
 * at `action.performer === roleId`, which a generic action never is.
 *
 * S is a scan-only role holding the token `c_read` needs, so S stays necessary
 * on both sides of the change.
 */
function puzzleWithGenericOnlyPerformer(): Puzzle {
  return {
    id: "generic-only-performer",
    roles: [
      { id: "C", capabilities: ["scan", "dpad"], privateTokens: ["c_key"] },
      { id: "S", capabilities: ["scan"], privateTokens: ["s_helper"] },
    ],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        id: "c_read",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["c_key", "s_helper"],
        requiresFlags: [],
        producesTokens: ["c_reading"],
        setsFlags: [],
      },
      {
        id: "generic_finish",
        performer: "any",
        needs: "dpad",
        requiresTokens: ["c_reading"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
}

test("4. a generic action whose only performer changed away is repairable", () => {
  const puzzle = puzzleWithGenericOnlyPerformer();
  assert.equal(certifyOk(puzzle, emptyState()), true, "the starting puzzle should certify");

  const result = recompile(puzzle, emptyState(), "C", ["scan"]);
  assert.equal(result.kind, "ok", `expected a repair, got ${result.kind}: ${describe(result)}`);
  if (result.kind !== "ok") return;

  const certificate = certify(result.puzzle, emptyState());
  assert.equal(isRefusal(certificate), false);
  if (isRefusal(certificate)) return;
  assert.equal(certificate.ok, true, explainFailure(certificate));
  assert.equal(certificate.necessity["C"]?.necessary, true);
});

test("4. the hand repair the recompiler should be able to find", () => {
  // Establishes that a repair exists at all, independently of the recompiler.
  // Both dpad actions have to move to scan: C's own, and the generic one that
  // is left with no capable role the moment C loses dpad.
  const puzzle = puzzleWithGenericOnlyPerformer();
  const handRepaired: Puzzle = {
    ...puzzle,
    roles: puzzle.roles.map((r) => (r.id === "C" ? { ...r, capabilities: ["scan" as const] } : r)),
    actions: puzzle.actions.map((a) => ({ ...a, needs: "scan" as const })),
  };
  const certificate = certify(handRepaired, emptyState());
  assert.equal(isRefusal(certificate), false);
  if (isRefusal(certificate)) return;
  assert.equal(certificate.ok, true, explainFailure(certificate));
  assert.equal(certificate.necessity["C"]?.necessary, true);
});

/* ------------------------------------------------------------------ */
/* bounded search is reported as bounded                               */
/* ------------------------------------------------------------------ */

/** C alone owns a seed and `length` dependent d-pad actions; the last sets the goal. */
function puzzleWithChainForRole(length: number): Puzzle {
  const actions: Puzzle["actions"] = [];
  for (let i = 0; i < length; i++) {
    actions.push({
      id: `c_link_${i}`,
      performer: "C",
      needs: "dpad",
      requiresTokens: [i === 0 ? "c_seed" : `c_out_${i - 1}`],
      requiresFlags: [],
      producesTokens: i === length - 1 ? [] : [`c_out_${i}`],
      setsFlags: i === length - 1 ? ["goal"] : [],
    });
  }
  return {
    id: `chain-for-role-${length}`,
    roles: [{ id: "C", capabilities: ["dpad"], privateTokens: ["c_seed"] }],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions,
  };
}

test("5. a repair needing four conversions is found with the default bounds", () => {
  const puzzle = puzzleWithChainForRole(4);
  assert.equal(certifyOk(puzzle, emptyState()), true, "the starting puzzle should certify");

  const result = recompile(puzzle, emptyState(), "C", ["scan"]);
  assert.equal(
    result.kind,
    "ok",
    `a four-conversion repair exists, so the default bounds must reach it (got ${result.kind}: ${describe(result)})`,
  );
  assert.equal(result.diff.filter((d) => d.op === "convert").length, 4);
});

test("5. a candidate-bound stop is reported as SEARCH_EXHAUSTED, not as impossibility", () => {
  const puzzle = puzzleWithChainForRole(4);
  const result = recompile(puzzle, emptyState(), "C", ["scan"], { maxCandidates: 1 });
  assert.ok(
    result.kind === "search_exhausted",
    `a bound was hit, so the answer must not be a claim about the puzzle (got ${result.kind})`,
  );
  if (result.kind !== "search_exhausted") return;
  assert.match(result.reason, /candidate/i);
  assert.equal(result.bound, "maxCandidates");
});

test("5. a genuinely repairless puzzle is still NO_VALID_RECOMPILE", () => {
  // C's only action is a wide grid choice and nothing else can express it, and
  // there is no token to hand off: the operator space really is empty of repairs.
  const puzzle: Puzzle = {
    id: "truly-no-repair",
    roles: [
      { id: "D", capabilities: ["dpad"], privateTokens: [] },
      { id: "C", capabilities: ["dpad"], privateTokens: [] },
    ],
    primitives: [
      { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
      { id: "dpad.grid", capability: "dpad", maxOptions: 9, splittable: false, label: "grid" },
      { id: "voice.confirm", capability: "voice", maxOptions: 1, splittable: false, label: "speak" },
    ],
    goalFlags: ["goal"],
    actions: [
      {
        id: "d_open",
        performer: "D",
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["inner"],
        setsFlags: [],
      },
      {
        id: "c_grid",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["inner", "grid_answer"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 9,
        answerToken: "grid_answer",
      },
    ],
  };

  const result = recompile(puzzle, emptyState(), "C", ["voice"]);
  assert.ok(result.kind === "no_valid_recompile", `got ${result.kind}`);
  if (result.kind !== "no_valid_recompile") return;
  assert.match(result.reason, /exhaust|no operator/i);
});

test("5. maxCandidates is enforced before a candidate is certified", () => {
  const puzzle = puzzleWithChainForRole(4);
  const result = recompile(puzzle, emptyState(), "C", ["scan"], { maxCandidates: 1 });
  if (result.kind === "ok") assert.fail("a one-candidate budget cannot certify a four-conversion repair");
  assert.ok(
    result.operatorsTried.length <= 1,
    `at most one certification should happen under maxCandidates: 1, saw ${result.operatorsTried.length}`,
  );
});

test("5. a truncated counterfactual is not a necessity proof", () => {
  // Mutation control: report a state-cap truncation as a necessity
  // proof. Nothing else in the suite searches a counterfactual that truncates,
  // so the mutation survived it. A cap of 1 makes every counterfactual stop
  // immediately while the solvability search still finishes normally.
  const certified = certify(demoPuzzle(), emptyState(), { maxCounterfactualStates: 1 });
  assert.equal(isRefusal(certified), false);
  if (isRefusal(certified)) return;

  assert.equal(certified.solvable.ok, true, "the solvability search itself is not capped");
  assert.equal(certified.solvable.truncated, false);

  for (const proof of Object.values(certified.necessity)) {
    assert.equal(proof.truncated, true, `${proof.role}'s counterfactual should have been cut short`);
    assert.equal(proof.necessary, false, `${proof.role}: an unfinished search proves nothing`);
    assert.equal(proof.proven, false);
  }
  assert.equal(certified.ok, false, "an unproven counterfactual must not certify");
});

/* ------------------------------------------------------------------ */
/* synthetic ids live in a reserved namespace                          */
/* ------------------------------------------------------------------ */

/**
 * The `gate__progress1` fixture: an author token shaped exactly like
 * a generated one. A holds the three clues the gate needs, C is the player who
 * works it (already switched to scan, which is why a conversion to scan is the
 * repair in play).
 */
function puzzleWithCollidingProgressToken(): Puzzle {
  return {
    id: "collision",
    roles: [
      {
        id: "A",
        capabilities: ["dpad"],
        privateTokens: ["gate__progress1", "independent", "gate_answer"],
      },
      { id: "C", capabilities: ["scan"], privateTokens: ["c_key"] },
    ],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        id: "gate",
        performer: "C",
        needs: "scan",
        requiresTokens: ["gate__progress1", "c_key", "independent", "gate_answer"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 9,
        answerToken: "gate_answer",
      },
    ],
  };
}

test("6. generated ids cannot collide with author ids", () => {
  const puzzle = puzzleWithCollidingProgressToken();
  assert.equal(validatePuzzle(puzzle).ok, true, "the fixture is a well-formed puzzle");

  const action = puzzle.actions[0]!;
  const converted = convertAction(puzzle, action, "C", "scan");
  assert.ok(converted, "the scan primitive can express a 9-way choice");

  const authorIds = new Set<string>([
    ...puzzle.actions.map((a) => a.id),
    ...puzzle.roles.flatMap((r) => r.privateTokens),
  ]);
  for (const step of converted.actions) {
    assert.ok(!authorIds.has(step.id), `generated id "${step.id}" collides with an author id`);
    for (const token of step.producesTokens) {
      assert.ok(
        !authorIds.has(token) || action.requiresTokens.includes(token),
        `generated token "${token}" collides with an author token`,
      );
    }
  }

  // And the whole repaired puzzle must still certify honestly. Its generated
  // ids are exactly the shape `certify` accepts from the reserved namespace --
  // there is no separate generated-input entry point.
  const repaired: Puzzle = { ...puzzle, actions: converted.actions };
  const certificate = certify(repaired, emptyState());
  assert.equal(isRefusal(certificate), false);
  if (isRefusal(certificate)) return;
  assert.equal(certificate.ok, true, explainFailure(certificate));
});

test("6. the witness cannot start at a later generated step", () => {
  const puzzle = puzzleWithCollidingProgressToken();
  const converted = convertAction(puzzle, puzzle.actions[0]!, "C", "scan");
  assert.ok(converted);
  const repaired: Puzzle = { ...puzzle, actions: converted.actions };

  const plan = solve(repaired, emptyState()).plan;
  assert.ok(plan.length > 0);
  assert.equal(
    plan[0]!.action,
    converted.actions[0]!.id,
    "the first step of the chain must come first, so no original prerequisite is skipped",
  );
});

test("6. a generated id never collides with an existing action id", () => {
  const puzzle = puzzleWithCollidingProgressToken();
  // Give the action a name whose generated steps would collide with it under a
  // naive scheme, and put a shadowing token in the puzzle for good measure.
  puzzle.actions[0]!.id = "gate";
  puzzle.roles[0]!.privateTokens = ["gate__step1", "gate__progress1", "independent"];
  const converted = convertAction(puzzle, puzzle.actions[0]!, "C", "scan");
  assert.ok(converted);

  const authorIds = new Set<string>([
    ...puzzle.actions.map((a) => a.id),
    ...puzzle.roles.flatMap((r) => r.privateTokens),
  ]);
  const generated = converted.actions.flatMap((a) => [...a.producesTokens, a.id]);
  for (const id of generated) {
    assert.ok(
      id.startsWith(RESERVED_PREFIX),
      `generated id "${id}" is outside the reserved namespace, so an author id could shadow it`,
    );
    assert.ok(!authorIds.has(id), `generated id "${id}" collides with an author id`);
  }
  // The author's shadowing tokens are still untouched by generation.
  assert.ok(puzzle.roles[0]!.privateTokens.includes("gate__step1"));
});

/* ------------------------------------------------------------------ */
/* state is validated                                                  */
/* ------------------------------------------------------------------ */

test("7. a state naming an action that does not exist is rejected", () => {
  const puzzle = demoPuzzle();
  const bad: State = {
    flags: [],
    tokens: [],
    history: [{ kind: "action", actionId: "no_such_action", performer: "A", capability: "dpad" }],
  };
  const check = validateState(puzzle, bad);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => /no_such_action/.test(e.detail)));

  const result = certify(puzzle, bad);
  assert.equal(isRefusal(result), true, "an invalid state must not produce a certificate");
});

test("7. a flag or token with no producing action is rejected", () => {
  const puzzle = demoPuzzle();
  // `safe_open` and `study_unlocked` are both real: the demo's own actions
  // produce them. These two are produced by nothing and held by nobody.
  const phantomFlag: State = { flags: ["study_flooded"], tokens: [], history: [] };
  assert.equal(validateState(puzzle, phantomFlag).ok, false);
  assert.ok(validateState(puzzle, phantomFlag).errors.some((e) => e.kind === "unproduced_flag"));

  const phantomToken: State = { flags: [], tokens: ["a_key_nobody_made"], history: [] };
  assert.equal(validateState(puzzle, phantomToken).ok, false);
  assert.ok(validateState(puzzle, phantomToken).errors.some((e) => e.kind === "unproduced_token"));
});

test("7. a token is valid when a done action produced it, or when it is a present role's private token", () => {
  const puzzle = demoPuzzle();
  // Produced by a done action.
  const produced: State = {
    flags: [],
    tokens: ["safe_location"],
    history: historyFor(puzzle, ["a_read_painting_hint"]),
  };
  assert.equal(validateState(puzzle, produced).ok, true, JSON.stringify(validateState(puzzle, produced).errors));

  // A private token of a present role: it has been spoken aloud, so it is shared.
  const shared: State = { flags: [], tokens: ["painting_hint"], history: [] };
  assert.equal(validateState(puzzle, shared).ok, true);
});

test("7. a token is only valid when the state says the producing action was done", () => {
  const puzzle = demoPuzzle();

  // `safe_location` really is produced -- but by `a_read_painting_hint`, which
  // this state does not claim happened. Naming the token without naming the
  // action is knowledge from nowhere.
  const orphanedToken: State = { flags: [], tokens: ["safe_location"], history: [] };
  assert.equal(validateState(puzzle, orphanedToken).ok, false);
  assert.ok(validateState(puzzle, orphanedToken).errors.some((e) => e.kind === "unproduced_token"));

  // Likewise a flag with no done action behind it.
  const orphanedFlag: State = { flags: ["painting_moved"], tokens: [], history: [] };
  assert.equal(validateState(puzzle, orphanedFlag).ok, false);
  assert.ok(validateState(puzzle, orphanedFlag).errors.some((e) => e.kind === "unproduced_flag"));

  // Name the two actions that did it and the same knowledge becomes accounted for.
  const accounted: State = {
    flags: ["painting_moved"],
    tokens: ["safe_location"],
    history: historyFor(puzzle, ["a_read_painting_hint", "a_shift_painting"]),
  };
  assert.equal(validateState(puzzle, accounted).ok, true, describeIssues(validateState(puzzle, accounted).errors));
});

/**
 * Both halves of the documented semantics, on a real certificate:
 *
 *   `state.tokens` is knowledge ALREADY SHARED with the team. The counterfactual
 *   for role R keeps that knowledge -- including R's private tokens, because
 *   they were spoken aloud before R left -- and removes only R's future actions
 *   and R's not-yet-shared private tokens.
 *
 * The fixture makes the two halves produce different answers on one puzzle: in
 * the copy where B's digits are already shared, B is redundant (anyone can
 * dictate them); in the copy where they are not, B is the only source of
 * `safe_code` and therefore necessary.
 */
function puzzleWhereSharingDecidesNecessity(): Puzzle {
  return {
    id: "sharing-decides-necessity",
    roles: [
      { id: "B", capabilities: ["dpad"], privateTokens: ["digits"] },
      { id: "C", capabilities: ["dpad"], privateTokens: [] },
    ],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        // Generic on purpose: once `digits` is shared knowledge, anyone with a
        // d-pad can dictate the code, so B stops being load-bearing. That is
        // the whole distinction this fixture exists to expose.
        id: "dictate",
        performer: "any",
        needs: "dpad",
        requiresTokens: ["digits"],
        requiresFlags: [],
        producesTokens: ["code"],
        setsFlags: [],
      },
      {
        id: "open",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["code"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
}

test("7. an already-shared private token survives the role's removal, so necessity is not manufactured", () => {
  const puzzle = puzzleWhereSharingDecidesNecessity();
  const shared: State = { flags: [], tokens: ["digits"], history: [] };
  assert.equal(validateState(puzzle, shared).ok, true, "already-shared knowledge is a legal state");

  const reference = certify(puzzle, shared);
  assert.equal(isRefusal(reference), false);
  if (isRefusal(reference)) return;
  assert.equal(
    reference.necessity["B"]?.necessary,
    false,
    "B's digits are already shared, so B is redundant in this world",
  );

  // The same state names a token that only B holds. The counterfactual must not
  // then hold it against the reduced puzzle -- that would refuse a legal state
  // for being about a role that is not there any more.
  const without = solveWithRoleRemoved(puzzle, shared, "B");
  assert.equal(without.status, "solvable", "shared knowledge survives its holder");
  assert.equal(without.truncated, false);
});

test("7. a not-yet-shared private token does not survive the role's removal", () => {
  const puzzle = puzzleWhereSharingDecidesNecessity();

  const reference = certify(puzzle, emptyState());
  assert.equal(isRefusal(reference), false);
  if (isRefusal(reference)) return;
  assert.equal(reference.necessity["B"]?.necessary, true, "nothing is shared, so only B has the digits");

  const without = solveWithRoleRemoved(puzzle, emptyState(), "B");
  assert.equal(without.status, "unsolvable", "B's unshared private tokens must go when B goes");
  assert.equal(without.truncated, false);
});

/* ------------------------------------------------------------------ */
/* state keys do not alias                                             */
/* ------------------------------------------------------------------ */

test("8. distinct states never share a visited-set key", () => {
  const a = stateKey(new Set(["x"]), new Set(["y"]), new Set());
  const b = stateKey(new Set(), new Set(["x", "y"]), new Set());
  const c = stateKey(new Set(), new Set(), new Set(["x", "y"]));
  assert.notEqual(a, b, "flags+tokens must not alias tokens alone");
  assert.notEqual(a, c);
  assert.notEqual(b, c);

  // The exact delimiter case.
  const aliased = stateKey(new Set(["x\u0002y"]), new Set(), new Set());
  const split = stateKey(new Set(["x"]), new Set(["y\u0002"]), new Set());
  assert.notEqual(aliased, split);
});

test("8. a reachable state is never discarded by a key collision", () => {
  // One action produces two tokens on one path; another produces them split
  // across two actions. Under a concatenating key the intermediate states alias
  // and the goal becomes unreachable.
  const puzzle: Puzzle = {
    id: "key-aliasing",
    roles: [{ id: "A", capabilities: ["dpad"], privateTokens: [] }],
    primitives: primitives(),
    goalFlags: ["goal"],
    actions: [
      {
        id: "both",
        performer: "A",
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["xy"],
        setsFlags: [],
      },
      {
        id: "first",
        performer: "A",
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["x"],
        setsFlags: [],
      },
      {
        id: "second",
        performer: "A",
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["y"],
        setsFlags: [],
      },
      {
        id: "finish",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["x", "y"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
  // The initial state itself is the aliasing hazard: flags empty, and a state
  // whose flags are ["xy"] produces the same concatenated key.
  const result = solve(puzzle, emptyState());
  assert.equal(result.status, "solvable");
  assert.equal(result.truncated, false);
});

/* ------------------------------------------------------------------ */
/* the certificate is bound to the whole puzzle                        */
/* ------------------------------------------------------------------ */

test("9. two puzzles sharing an id but differing in an action get different hashes", () => {
  const one = puzzleWithChoice(true);
  const two = puzzleWithChoice(true);
  // The difference has to be invisible to everything else in the certificate,
  // or the hash could differ for the wrong reason: a relabelled action also
  // relabels the witness plan's step, and `solvable` carries the plan. A
  // primitive's label is inert -- no search reads it -- so only a hash over the
  // whole puzzle can tell these two apart.
  two.primitives[0]!.label = "a different label entirely";
  assert.deepEqual(one.actions, two.actions, "the actions must be untouched by the relabelling");
  assert.notDeepEqual(one.primitives, two.primitives, "the fixtures must be distinct puzzles");

  const certOne = certify(one, emptyState());
  const certTwo = certify(two, emptyState());
  assert.equal(isRefusal(certOne), false);
  assert.equal(isRefusal(certTwo), false);
  if (isRefusal(certOne) || isRefusal(certTwo)) return;

  assert.equal(certOne.puzzleId, certTwo.puzzleId, "the fixture must share a puzzle id");
  assert.deepEqual(
    certOne.solvable.plan,
    certTwo.solvable.plan,
    "nothing else in the certificate can tell these two puzzles apart",
  );
  assert.notEqual(
    certOne.hash,
    certTwo.hash,
    "the hash must bind the certificate to the full puzzle, not just its id",
  );
  assert.ok(certOne.puzzleKey.length > 0, "the certificate should carry the canonical puzzle key");
});

test("9. the normalized state is inside the hashed body", () => {
  const puzzle = demoPuzzle();
  const before = certify(puzzle, emptyState());
  const after = certify(puzzle, {
    flags: [],
    tokens: ["painting_hint"],
    history: [],
  });
  if (isRefusal(before) || isRefusal(after)) assert.fail("both states should certify");
  assert.notEqual(before.hash, after.hash, "a different state must produce a different certificate hash");
});

test("9. the same puzzle and state still hash the same, whatever the array order", () => {
  const puzzle = demoPuzzle();
  const a = certify(puzzle, { flags: [], tokens: ["painting_hint", "code_digit_1"], history: [] });
  const b = certify(puzzle, { flags: [], tokens: ["code_digit_1", "painting_hint"], history: [] });
  if (isRefusal(a) || isRefusal(b)) assert.fail("both states should certify");
  assert.equal(a.hash, b.hash, "normalisation must make array order irrelevant");
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function describe(result: RecompileResult): string {
  return result.kind === "ok" ? "ok" : `${result.kind} (${result.reason})`;
}

function solveWithRoleRemoved(puzzle: Puzzle, state: State, roleId: string) {
  return solve(removeRole(puzzle, roleId), state);
}

test("sanity: the demo still certifies", () => {
  const certificate = certify(demoPuzzle(), emptyState());
  assert.equal(isRefusal(certificate), false);
  if (isRefusal(certificate)) return;
  assert.equal(certificate.ok, true, explainFailure(certificate));
});

test("sanity: normalizeState is unchanged by validation helpers", () => {
  const state: State = { flags: ["b", "a"], tokens: [], history: [] };
  assert.deepEqual(normalizeState(state).flags, ["a", "b"]);
});
