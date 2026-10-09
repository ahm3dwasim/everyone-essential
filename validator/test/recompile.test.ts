/**
 * Repair, plus the operator-level behaviour underneath it.
 *
 *  1. After C switches to scan, C is still *necessary* -- not merely still able
 *     to press something. The counterfactual has to be re-proven against the
 *     repaired puzzle.
 *  2. When no operator can keep everyone essential, the answer is
 *     NO_VALID_RECOMPILE, not a quietly weaker certificate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, explainFailure, isCertificate } from "../src/certify";
import { DEMO_CHANGE_ROLE, demoPuzzle, runDemo } from "../src/demo";
import { type Puzzle, type State, doneActionIds, emptyState, removeRole } from "../src/model";
import { convertAction, handOffToken, recompile } from "../src/recompile";
import { applyPlan, solve } from "../src/solve";

/**
 * `certify` returns a typed refusal for an invalid puzzle or state rather than
 * always a certificate. Every puzzle in this file is well formed, so
 * the tests want the certificate and should fail loudly if they ever get a
 * refusal instead.
 */
function certificateFor(puzzle: Parameters<typeof certify>[0], state: Parameters<typeof certify>[1]) {
  const result = certify(puzzle, state);
  assert.ok(isCertificate(result), `expected a certificate, got a refusal: ${explainFailure(result)}`);
  return result;
}

/**
 * The same, for a puzzle the *recompiler* produced.
 *
 * A repaired puzzle's generated ids live in the reserved namespace, but that
 * namespace is legal input in exactly the generator's own shape, so the
 * same `certify` every other caller uses re-proves it -- there is no second,
 * weaker-gated entry point.
 */
function certificateForGenerated(puzzle: Parameters<typeof certify>[0], state: Parameters<typeof certify>[1]) {
  return certificateFor(puzzle, state);
}

/* ------------------------------------------------------------------ */
/* 5. everyone stays essential after the change                        */
/* ------------------------------------------------------------------ */

test("5. after C -> scan, C is still necessary, not just still able to act", () => {
  const run = runDemo();
  assert.equal(run.recompile.kind, "ok");
  if (run.recompile.kind !== "ok") return;

  const repaired = run.recompile.puzzle;

  // C really did change input mode.
  const roleC = repaired.roles.find((r) => r.id === DEMO_CHANGE_ROLE);
  assert.deepEqual(roleC?.capabilities, ["scan"]);

  // C is on the remaining plan...
  const remaining = run.finalPlan;
  assert.ok(
    remaining.some((step) => step.performer === DEMO_CHANGE_ROLE),
    "C should still perform actions after the repair",
  );

  // ...and the counterfactual is re-proven, not inherited from before the change.
  // `run.recompile.state`, not `run.midpointState`: it carries the
  // `capability_change` event the repaired puzzle's roles now depend on.
  const certificate = certificateForGenerated(repaired, run.recompile.state);
  assert.equal(certificate.ok, true, explainFailure(certificate));
  assert.equal(certificate.necessity[DEMO_CHANGE_ROLE]?.necessary, true);
  assert.equal(certificate.necessity[DEMO_CHANGE_ROLE]?.proven, true);

  // Independent of the certificate, ask the solver directly: without C, is the
  // study reachable?
  const withoutC = solve(removeRole(repaired, DEMO_CHANGE_ROLE), run.recompile.state);
  assert.equal(withoutC.status, "unsolvable", "C must be load-bearing in the repaired puzzle");
  assert.equal(withoutC.truncated, false);
});

test("5. the repair actually rewrites C's wide choice rather than dodging it", () => {
  const run = runDemo();
  if (run.recompile.kind !== "ok") assert.fail("demo did not recompile");

  const repaired = run.recompile.puzzle;
  const dialSteps = repaired.actions.filter((a) => a.id.includes("c_dial_safe__step"));
  assert.equal(dialSteps.length, 2, "the 9-way choice should be split into two steps");
  for (const step of dialSteps) {
    assert.equal(step.needs, "scan");
    assert.equal(step.performer, DEMO_CHANGE_ROLE);
    assert.ok((step.options ?? 0) <= 4, `scan step offers ${step.options} options`);
  }
  // Two 3-way steps carry at least the nine alternatives the original offered.
  assert.ok(
    (dialSteps[0]!.options ?? 0) ** dialSteps.length >= 9,
    "the split must not lose any of the original alternatives",
  );
});

/* ------------------------------------------------------------------ */
/* 6. no valid recompile is reported honestly                          */
/* ------------------------------------------------------------------ */

/**
 * C's only action is a 9-way d-pad grid choice with no way to express it under
 * the capability C moves to. Nobody holds a private token, so there is nothing
 * to hand off either, and handing the action to D would leave C with no reason
 * to be in the room.
 */
function puzzleWithNoValidRecompile(): Puzzle {
  return {
    id: "no-valid-recompile",
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
        requiresTokens: ["inner"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 9,
        // The nine grid positions are only distinguishable once D has opened
        // the panel and shared what is inside it.
        answerToken: "inner",
      },
    ],
  };
}

test("6. when nothing can keep C necessary, the answer is NO_VALID_RECOMPILE", () => {
  const puzzle = puzzleWithNoValidRecompile();

  // The puzzle is healthy before the change -- so the failure is about the
  // change, not about a broken puzzle.
  const before = certificateFor(puzzle, emptyState());
  assert.equal(before.ok, true, "the starting puzzle should certify");

  const result = recompile(puzzle, emptyState(), "C", ["voice"]);

  assert.ok(result.kind === "no_valid_recompile", `expected a refusal, got ${result.kind}`);
  assert.equal(
    "certificate" in result,
    false,
    "a failed recompile must not hand back a certificate at all",
  );
  assert.ok(result.operatorsTried.length > 0, "the operators tried must be reported");
  assert.ok(result.reason.length > 0, "the failure must come with a reason");

  // The only thing that could have been done is handing C's action to D, and
  // that is reported as tried and rejected for making C decorative.
  const details = result.operatorsTried.map((a) => a.detail).join(" | ");
  assert.ok(/c_grid/.test(details), "the attempted rewrites should name the action");
  assert.ok(/\bC\b/.test(result.reason), "the reason should name the role that cannot be kept");
  assert.ok(
    /decorative/.test(result.reason),
    `the reason should say why C cannot be kept: ${result.reason}`,
  );
});

test("6. a failed recompile never returns ok for a puzzle where C is redundant", () => {
  const puzzle = puzzleWithNoValidRecompile();
  const result = recompile(puzzle, emptyState(), "C", ["voice"]);
  if (result.kind === "ok") {
    assert.fail("recompiler claimed success; its certificate must then be genuine");
  }
  // Belt and braces: if a future implementation does return ok here, prove the
  // certificate it returns is genuine rather than trusting the kind tag.
  const handedOver = recompile(puzzle, emptyState(), "C", ["voice"], { maxDepth: 1 });
  assert.ok(handedOver.kind !== "ok", `a bounded search must not claim success: ${handedOver.kind}`);
  assert.equal(
    "certificate" in handedOver,
    false,
    "a bounded search must not hand back a certificate either",
  );
});

/* ------------------------------------------------------------------ */
/* operator-level behaviour                                            */
/* ------------------------------------------------------------------ */

test("convert: a 9-way d-pad grid becomes two chained 3-way scan steps", () => {
  const puzzle = demoPuzzle();
  const action = puzzle.actions.find((a) => a.id === "c_dial_safe")!;
  const converted = convertAction(puzzle, action, "C", "scan");

  assert.ok(converted, "the scan primitive library can express this choice");
  assert.equal(converted.actions.length, 2);

  const [first, second] = converted.actions;
  assert.equal(first!.options, 3);
  assert.equal(second!.options, 3);
  assert.equal(first!.needs, "scan");
  assert.equal(second!.needs, "scan");

  // Original prerequisites land on the first step; original effects on the last.
  assert.deepEqual(first!.requiresTokens, ["safe_code", "safe_location", "dial_symbol"]);
  assert.deepEqual(first!.requiresFlags, ["painting_moved"]);
  assert.deepEqual(second!.setsFlags, ["safe_open"]);

  // The chain cannot be short-circuited: step 2 needs what step 1 produced.
  assert.ok(
    first!.producesTokens.every((t) => second!.requiresTokens.includes(t)),
    "step 2 must require the token step 1 produced",
  );
  // Every step presents part of the choice, so every step requires the answer.
  for (const step of [first!, second!]) {
    assert.ok(
      step.requiresTokens.includes("safe_code"),
      `step "${step.id}" offers ${step.options} options but does not require the answer`,
    );
    assert.equal(step.answerToken, "safe_code");
  }
  assert.deepEqual(second!.requiresTokens.length, 2);
});

test("convert: a choice that already fits becomes a single retagged action", () => {
  const puzzle = demoPuzzle();
  const action = puzzle.actions.find((a) => a.id === "c_match_symbol")!;
  const converted = convertAction(puzzle, action, "C", "scan");

  assert.ok(converted);
  assert.equal(converted.actions.length, 1);
  assert.equal(converted.actions[0]!.id, "c_match_symbol");
  assert.equal(converted.actions[0]!.needs, "scan");
  assert.equal(converted.actions[0]!.options, 4);
});

test("convert: refuses when the primitive library cannot express the choice", () => {
  const puzzle = demoPuzzle();
  const action = puzzle.actions.find((a) => a.id === "c_dial_safe")!;
  // "voice" can only confirm; it cannot present nine alternatives.
  assert.equal(convertAction(puzzle, action, "C", "voice"), null);
});

test("convert: converting every one of C's actions keeps the puzzle solvable", () => {
  const puzzle = demoPuzzle();

  // Converting one action in isolation is not enough: C's other d-pad action
  // would still be unperformable. Both have to move together, which is why the
  // recompiler searches over operator sequences rather than single rewrites.
  const rebuilt: Puzzle = {
    ...puzzle,
    roles: puzzle.roles.map((r) => (r.id === "C" ? { ...r, capabilities: ["scan" as const] } : r)),
    actions: puzzle.actions.flatMap((a) => {
      if (a.performer !== "C") return [a];
      const converted = convertAction(puzzle, a, "C", "scan");
      assert.ok(converted, `"${a.id}" should be convertible to scan`);
      return converted.actions;
    }),
  };

  const result = solve(rebuilt, emptyState());
  assert.equal(result.status, "solvable", "splitting a choice must not lose the goal");
  assert.equal(result.plan.length, 11, "two of C's steps became three");
});

test("handoff: a token moves to the changed role and leaves its old owner", () => {
  const puzzle = demoPuzzle();
  const moved = handOffToken(puzzle, "painting_hint", "C");

  assert.deepEqual(moved.roles.find((r) => r.id === "A")?.privateTokens, []);
  assert.deepEqual(moved.roles.find((r) => r.id === "C")?.privateTokens, [
    "desk_drawer_note",
    "painting_hint",
  ]);
});

test("handoff: handing over a clue is what makes an idle role necessary again", () => {
  // A does all the work and holds the only clue. C is genuinely idle.
  const puzzle: Puzzle = {
    id: "handoff-makes-necessary",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["clue"] },
      { id: "C", capabilities: ["dpad"], privateTokens: [] },
    ],
    primitives: [
      { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
    ],
    goalFlags: ["goal"],
    actions: [
      {
        id: "a_start",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["clue"],
        requiresFlags: [],
        producesTokens: ["started"],
        setsFlags: [],
      },
      {
        id: "a_finish",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["started"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };

  // Before the handoff C contributes nothing and is correctly rejected.
  assert.equal(certificateFor(puzzle, emptyState()).necessity["C"]?.necessary, false);
  assert.equal(certificateFor(puzzle, emptyState()).ok, false);

  const moved = handOffToken(puzzle, "clue", "C");
  const certificate = certificateFor(moved, emptyState());

  assert.equal(certificate.necessity["C"]?.necessary, true, "C now holds the only clue");
  assert.equal(certificate.meaningful["C"]?.meaningful, true);
  assert.equal(certificate.necessity["A"]?.necessary, true, "A still performs the work");
  assert.equal(certificate.ok, true);
});

test("5. C's necessity is a property of the repaired puzzle, not of the recompiler", () => {
  // Build the repaired puzzle by hand instead of asking the recompiler for it,
  // so this probe fails on the necessity claim itself rather than on whatever
  // the recompiler happened to return.
  const puzzle = demoPuzzle();
  const plan = solve(puzzle, emptyState()).plan;
  const midpoint = applyPlan(puzzle, emptyState(), plan, Math.floor(plan.length / 2));
  // Only C's NOT-YET-DONE actions may change capability: one already fired
  // under "dpad", recorded as such in `midpoint.history`, and rewriting ITS
  // `needs` too would make the puzzle disagree with its own history.
  const done = new Set(doneActionIds(midpoint.history));

  const rebuilt: Puzzle = {
    ...puzzle,
    roles: puzzle.roles.map((r) => (r.id === "C" ? { ...r, capabilities: ["scan" as const] } : r)),
    actions: puzzle.actions.flatMap((a) => {
      if (a.performer !== "C" || done.has(a.id)) return [a];
      const converted = convertAction(puzzle, a, "C", "scan");
      assert.ok(converted, `"${a.id}" should be convertible to scan`);
      return converted.actions;
    }),
  };
  // Mirror what `recompile` itself would append: a record of the change, so a
  // replay of C's already-performed "dpad" action judges it against the
  // capability C actually held at the time.
  const repairedState: State = {
    ...midpoint,
    history: [...midpoint.history, { kind: "capability_change", role: "C", from: ["dpad"], to: ["scan"] }],
  };

  const without = solve(removeRole(rebuilt, "C"), repairedState);
  assert.equal(
    without.status,
    "unsolvable",
    "C performs scan steps now; taking C away must still lose the goal",
  );
  assert.equal(without.truncated, false);
  const certificate = certificateForGenerated(rebuilt, repairedState);
  assert.equal(certificate.necessity["C"]?.necessary, true, explainFailure(certificate));
});
