/**
 * Regression tests for two invariants in candidate certification and
 * whole-chain conversion:
 *
 *   1. a `maxStates` truncation during candidate certification must never read as
 *      the definitive `NO_VALID_RECOMPILE` -- it makes the whole search's answer
 *      `SEARCH_EXHAUSTED`, because a truncated candidate is never shown invalid.
 *   2. a second capability change that lands on a role which already owns a
 *      generated split chain from an earlier repair must convert that chain as
 *      a whole, not one step at a time: converting a single step would leave
 *      its siblings pointing at progress tokens the replacement does not
 *      produce, which would make `certificateFor` throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, explainFailure, isCertificate } from "../src/certify";
import { type Capability, type Puzzle, emptyState, normalizeState } from "../src/model";
import { recompile } from "../src/recompile";
import { demoPuzzle, ROLE_A, ROLE_B, ROLE_C } from "../src/demo";

/* ------------------------------------------------------------------ */
/* a state-capped candidate must never read as definitive               */
/* ------------------------------------------------------------------ */

/**
 * The scenario: one role, C, has `dpad` and a private `key`;
 * `finish` needs C's `dpad` and `key` and sets `goal`; a one-option `scan`
 * primitive permits the single convert repair (retarget `finish` at `scan`,
 * one option, in one step). With no bound, the repair is found. With
 * `maxStates: 1`, the winning candidate's own solvability search hits the cap
 * one state before it would have reached the goal -- its "no" is UNPROVEN, not
 * a real refutation -- so the search as a whole must say so honestly rather
 * than claim every candidate was certified and none holds.
 */
function stateCapFixture(): Puzzle {
  return {
    id: "candidate-truncation-1-state-cap",
    roles: [{ id: "C", capabilities: ["dpad"], privateTokens: ["key"] }],
    primitives: [{ id: "scan.one", capability: "scan", maxOptions: 1, splittable: false, label: "single scan press" }],
    goalFlags: ["goal"],
    actions: [
      {
        id: "finish",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["key"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        label: "finish",
      },
    ],
  };
}

test("candidate-truncation-1a. an unbounded recompile of the state-cap fixture finds the repair", () => {
  const result = recompile(stateCapFixture(), emptyState(), "C", ["scan"]);
  assert.equal(result.kind, "ok", result.kind === "ok" ? "" : JSON.stringify(result));
});

test("candidate-truncation-1b. maxStates: 1 truncates the winning candidate's own proof, so the answer is SEARCH_EXHAUSTED, never NO_VALID_RECOMPILE", () => {
  const result = recompile(stateCapFixture(), emptyState(), "C", ["scan"], { maxStates: 1 });
  assert.notEqual(
    result.kind,
    "no_valid_recompile",
    `a candidate whose own certification was truncated by maxStates must not make the search's answer definitive, got ${JSON.stringify(result)}`,
  );
  assert.equal(result.kind, "search_exhausted", JSON.stringify(result));
  if (result.kind !== "search_exhausted") return;
  assert.equal(result.bound, "maxStates", `expected the maxStates bound named, got "${result.bound}"`);
});

test("candidate-truncation-1c. maxStates: 2 is enough for the same candidate to be proven, and the answer is ok again", () => {
  const result = recompile(stateCapFixture(), emptyState(), "C", ["scan"], { maxStates: 2 });
  assert.equal(result.kind, "ok", result.kind === "ok" ? "" : JSON.stringify(result));
});

/* ------------------------------------------------------------------ */
/* a second recompile must not split one link of a chain                */
/* ------------------------------------------------------------------ */

/**
 * The scenario: C begins with `dpad`, a private `answer`, and
 * a 9-option answer-gated `gate` action that sets `goal`. The primitive
 * library has `scan.paged` (4, splittable) and `dpad.tiny` (2, splittable) --
 * deliberately smaller than the 9-way choice, so both recompiles have to
 * split. The first change (C dpad -> scan) splits `gate` into a two-step
 * chain. The second change (C scan -> dpad) converts the whole chain as one
 * candidate: splitting just `§gate__step1` on its own would leave
 * `§gate__step2` an orphan and make `certificateFor` throw.
 */
function chainSplitFixture(): Puzzle {
  return {
    id: "candidate-truncation-2-chain-split",
    roles: [{ id: "C", capabilities: ["dpad"], privateTokens: ["answer"] }],
    primitives: [
      { id: "dpad.tiny", capability: "dpad", maxOptions: 2, splittable: true, label: "tiny dpad" },
      { id: "scan.paged", capability: "scan", maxOptions: 4, splittable: true, label: "scan paged" },
    ],
    goalFlags: ["goal"],
    actions: [
      {
        id: "gate",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["answer"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 9,
        answerToken: "answer",
        label: "gate",
      },
    ],
  };
}

test("candidate-truncation-2. C dpad->scan (splits gate into a chain), then C scan->dpad (splits again) returns an ok result that certifies", () => {
  const puzzle = chainSplitFixture();
  const start = emptyState();

  const first = recompile(puzzle, start, "C", ["scan"]);
  assert.equal(first.kind, "ok", first.kind === "ok" ? "" : JSON.stringify(first));
  if (first.kind !== "ok") return;
  assert.equal(first.certificate.ok, true, explainFailure(first.certificate));
  assert.ok(
    first.puzzle.actions.some((a) => a.id === "§gate__step1") &&
      first.puzzle.actions.some((a) => a.id === "§gate__step2"),
    "expected the first recompile to split \"gate\" into a two-step chain",
  );

  // The whole-chain re-split call must not throw. If it throws, the test
  // fails right here -- an uncaught exception inside a `node:test` test is a
  // failure -- which is exactly the assertion this test exists to make.
  const second = recompile(first.puzzle, first.state, "C", ["dpad"]);
  assert.equal(second.kind, "ok", `expected the whole-chain re-split to succeed, got ${second.kind}: ${JSON.stringify(second)}`);
  if (second.kind !== "ok") return;
  assert.equal(second.certificate.ok, true, explainFailure(second.certificate));

  // History is prefix-preserved across BOTH changes.
  const a = normalizeState(start);
  const b = normalizeState(first.state);
  const c = normalizeState(second.state);
  assert.deepEqual(b.history.slice(0, a.history.length), a.history);
  assert.deepEqual(c.history.slice(0, b.history.length), b.history);

  // And the second repaired puzzle is, again, valid input to `certify`.
  assert.equal(isCertificate(certify(second.puzzle, second.state)), true);
});

/* ------------------------------------------------------------------ */
/* Property test -- every sequence of two capability changes over the   */
/* demo roles: every sequence returns a typed outcome, every ok certifies,  */
/* history is prefix-preserved                                             */
/* ------------------------------------------------------------------ */

const ALL_CAPABILITIES: Capability[] = ["dpad", "scan", "voice"];

/** Every non-empty subset of the three capabilities: 7 of them. */
function nonEmptyCapabilitySubsets(): Capability[][] {
  const subsets: Capability[][] = [];
  for (let mask = 1; mask < 1 << ALL_CAPABILITIES.length; mask++) {
    subsets.push(ALL_CAPABILITIES.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return subsets;
}

test("candidate-truncation-3. property: over the demo roles, every sequence of two capability changes returns a typed outcome, and every ok result certifies with history prefix-preserved", () => {
  const roles = [ROLE_A, ROLE_B, ROLE_C];
  const subsets = nonEmptyCapabilitySubsets();
  const start = emptyState();
  let firstOkCount = 0;
  let secondOkCount = 0;
  let secondAttempts = 0;

  for (const role1 of roles) {
    for (const caps1 of subsets) {
      const puzzle = demoPuzzle();
      // An uncaught throw here fails the test on its own, which is this
      // property's point: a demo role and a capability subset get a typed
      // outcome, not an exception.
      const first = recompile(puzzle, start, role1, caps1);
      assert.ok(
        first.kind === "ok" ||
          first.kind === "no_valid_recompile" ||
          first.kind === "search_exhausted" ||
          first.kind === "invalid_input",
        `unexpected first recompile kind ${first.kind}`,
      );
      if (first.kind !== "ok") continue;
      firstOkCount++;
      assert.equal(first.certificate.ok, true, explainFailure(first.certificate));
      const a = normalizeState(start);
      const b = normalizeState(first.state);
      assert.deepEqual(b.history.slice(0, a.history.length), a.history);

      for (const role2 of roles) {
        for (const caps2 of subsets) {
          secondAttempts++;
          const second = recompile(first.puzzle, first.state, role2, caps2);
          assert.ok(
            second.kind === "ok" ||
              second.kind === "no_valid_recompile" ||
              second.kind === "search_exhausted" ||
              second.kind === "invalid_input",
            `unexpected second recompile kind ${second.kind}`,
          );
          if (second.kind !== "ok") continue;
          secondOkCount++;
          assert.equal(second.certificate.ok, true, explainFailure(second.certificate));
          const c = normalizeState(second.state);
          assert.deepEqual(c.history.slice(0, b.history.length), b.history);
          // And the twice-repaired puzzle is valid input to `certify` as well.
          assert.equal(isCertificate(certify(second.puzzle, second.state)), true);
        }
      }
    }
  }

  // Sanity: the property held over a non-trivial space, not vacuously over zero cases.
  assert.ok(firstOkCount > 0, "expected at least one first recompile to succeed");
  assert.ok(secondAttempts > 0, "the property test did not actually attempt any second recompile");
  assert.ok(secondOkCount > 0, "expected at least one second recompile to succeed");
});
