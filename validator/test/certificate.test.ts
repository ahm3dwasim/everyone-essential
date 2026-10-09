/**
 * The certificate refusing the things it should refuse.
 *
 * These are the tests that matter most. A validator that only ever says "ok"
 * is worse than no validator, because it launders hand-authored puzzles as
 * proven ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, explainFailure, isCertificate } from "../src/certify";
import { type Puzzle, emptyState } from "../src/model";
import { solve } from "../src/solve";
import { demoPuzzle } from "../src/demo";

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

/**
 * Test 2's puzzle: A and B carry the puzzle, C carries a trinket nobody ever
 * asks for and does nothing. C is exactly the "decorative role" the whole
 * entry rests on rejecting.
 */
function puzzleWithDecorativeRole(): Puzzle {
  return {
    id: "decorative-role",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["a_clue"] },
      { id: "B", capabilities: ["dpad"], privateTokens: ["b_clue"] },
      { id: "C", capabilities: ["dpad"], privateTokens: ["c_trinket"] },
    ],
    primitives: [
      { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
    ],
    goalFlags: ["goal"],
    actions: [
      {
        id: "a_open",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["a_clue"],
        requiresFlags: [],
        producesTokens: ["a_done"],
        setsFlags: [],
      },
      {
        id: "b_finish",
        performer: "B",
        needs: "dpad",
        requiresTokens: ["a_done", "b_clue"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
}

test("2. a decorative role is rejected: ok is false and necessity.C fails", () => {
  const puzzle = puzzleWithDecorativeRole();
  const certificate = certificateFor(puzzle, emptyState());

  assert.equal(certificate.ok, false, "a puzzle with a decorative role must not certify");
  assert.equal(certificate.solvable.ok, true, "the puzzle itself is solvable");

  const necessityC = certificate.necessity["C"];
  assert.ok(necessityC, "C should have a necessity proof");
  assert.equal(necessityC.necessary, false, "C must not be necessary");
  assert.equal(
    necessityC.proven,
    true,
    "the refutation must be a finished search, not a truncated one",
  );

  assert.equal(
    certificate.meaningful["C"]?.meaningful,
    false,
    "C performs nothing on the plan and holds nothing it consumes",
  );

  // The roles that do the work are still fine -- C is the only failure.
  assert.equal(certificate.necessity["A"]?.necessary, true);
  assert.equal(certificate.necessity["B"]?.necessary, true);
});

test("2. the same puzzle certifies once C actually does something", () => {
  // Control for the test above: give C a real job and the certificate flips.
  const puzzle = puzzleWithDecorativeRole();
  puzzle.actions[1]!.requiresTokens = ["a_done", "b_clue", "c_trinket"];

  const certificate = certificateFor(puzzle, emptyState());
  assert.equal(certificate.necessity["C"]?.necessary, true);
  assert.equal(certificate.meaningful["C"]?.meaningful, true);
  assert.equal(certificate.ok, true);
});

test("3. an unsolvable puzzle is rejected: solvable is false", () => {
  const puzzle = demoPuzzle();
  // Remove the only action that can produce "safe_code".
  puzzle.actions = puzzle.actions.filter((a) => a.id !== "b_dictate_code");

  const certificate = certificateFor(puzzle, emptyState());
  const result = solve(puzzle, emptyState());

  assert.equal(result.status, "unsolvable");
  assert.equal(result.truncated, false, "unsolvable must be proven, not a state-cap truncation");
  assert.equal(certificate.solvable.ok, false);
  assert.equal(certificate.solvable.proven, true);
  assert.equal(certificate.ok, false);
});

test("3. removing the goal-setting action also makes it unsolvable", () => {
  const puzzle = demoPuzzle();
  puzzle.actions = puzzle.actions.filter((a) => a.id !== "any_enter_study");

  const certificate = certificateFor(puzzle, emptyState());
  assert.equal(certificate.solvable.ok, false);
  assert.equal(certificate.ok, false);
});

/**
 * Test 4's puzzle: solvable, both roles necessary, and one scan action
 * offering six alternatives. Everything passes except accessibility.
 */
function puzzleWithBadScanAction(): Puzzle {
  return {
    id: "scan-too-wide",
    roles: [
      { id: "A", capabilities: ["scan"], privateTokens: ["clue"] },
      { id: "B", capabilities: ["dpad"], privateTokens: ["b_clue"] },
    ],
    primitives: [
      { id: "scan.paged", capability: "scan", maxOptions: 4, splittable: true, label: "scan" },
      { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
    ],
    goalFlags: ["goal"],
    actions: [
      {
        id: "b_helper",
        performer: "B",
        needs: "dpad",
        requiresTokens: ["b_clue"],
        requiresFlags: [],
        producesTokens: ["helper"],
        setsFlags: [],
      },
      {
        id: "a_wide_choice",
        performer: "A",
        needs: "scan",
        requiresTokens: ["clue", "helper"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 6,
        // Six ways to choose, and B's helper is the only thing that says which.
        answerToken: "helper",
      },
    ],
  };
}

test("4. an over-wide scan action is rejected: ok is false", () => {
  const puzzle = puzzleWithBadScanAction();
  const certificate = certificateFor(puzzle, emptyState());

  assert.equal(certificate.ok, false, "6 options on a scan action must not certify");
  assert.equal(certificate.accessibility.ok, false);
  assert.deepEqual(
    certificate.accessibility.violations.map((v) => v.kind),
    ["scan_too_many_options"],
    "accessibility should be the only thing wrong with this puzzle",
  );
  assert.equal(certificate.accessibility.violations[0]?.action, "a_wide_choice");

  // Everything else about the puzzle is sound, so the failure is specifically
  // the accessibility rule and not an accident of the puzzle being broken.
  assert.equal(certificate.solvable.ok, true);
  assert.equal(certificate.necessity["A"]?.necessary, true);
  assert.equal(certificate.necessity["B"]?.necessary, true);
  assert.equal(certificate.meaningful["A"]?.meaningful, true);
  assert.equal(certificate.meaningful["B"]?.meaningful, true);
});

test("4. four options on a scan action is fine", () => {
  const puzzle = puzzleWithBadScanAction();
  puzzle.actions[1]!.options = 4;

  const certificate = certificateFor(puzzle, emptyState());
  assert.equal(certificate.accessibility.ok, true);
  assert.equal(certificate.ok, true);
});
