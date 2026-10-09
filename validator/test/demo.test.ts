/**
 * The shipped demo puzzle, end to end.
 *
 *  1. The demo puzzle certifies at the start, certifies after the mid-game
 *     recompile, and loses no progress.
 *  2. Determinism: two runs produce an identical certificate hash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, explainFailure, isCertificate } from "../src/certify";
import { demoPuzzle, runDemo, DEMO_CHANGE_ROLE } from "../src/demo";
import { type Capability, doneActionIds, emptyState, puzzleKey, roleById } from "../src/model";
import { solve } from "../src/solve";
import { recompile } from "../src/recompile";

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

test("1. demo puzzle certifies at the start: solvable, and every role necessary", () => {
  const puzzle = demoPuzzle();
  const certificate = certificateFor(puzzle, emptyState());

  assert.equal(certificate.ok, true, `expected ok: ${JSON.stringify(certificate, null, 2)}`);
  assert.equal(certificate.solvable.ok, true);
  assert.equal(certificate.solvable.proven, true, "solvability must be proven, not truncated");
  assert.equal(certificate.solvable.plan.length, 10, "every demo action is required");

  for (const role of puzzle.roles) {
    const proof = certificate.necessity[role.id];
    assert.ok(proof, `no necessity proof for ${role.id}`);
    assert.equal(proof.necessary, true, `role ${role.id} is not necessary`);
    assert.equal(proof.proven, true, `necessity of ${role.id} was never actually proven`);
  }

  assert.equal(certificate.accessibility.ok, true);
  for (const proof of Object.values(certificate.meaningful)) {
    assert.equal(proof.meaningful, true, `role ${proof.role} is decorative`);
  }
});

test("1. demo recompiles after C loses d-pad, and the repaired puzzle certifies", () => {
  const run = runDemo();
  assert.equal(run.recompile.kind, "ok", `expected a recompile, got: ${JSON.stringify(run.recompile)}`);
  if (run.recompile.kind !== "ok") return;

  assert.equal(run.finalCertificate?.ok, true);
  assert.equal(run.recompile.certificate.ok, true);
});

test("1. progress is preserved exactly across the recompile", () => {
  const run = runDemo();
  if (run.recompile.kind !== "ok") assert.fail("demo did not recompile");

  // `recompile` returns a NEW state: the old one plus one appended
  // `capability_change` event. Facts must not move, and the old history must
  // be an exact prefix of the new one.
  const before = run.midpointState;
  const after = run.recompile.state;

  assert.deepEqual([...after.flags].sort(), [...before.flags].sort(), "flags changed");
  assert.deepEqual([...after.tokens].sort(), [...before.tokens].sort(), "tokens changed");
  assert.deepEqual(
    after.history.slice(0, before.history.length),
    before.history,
    "the old history must be an untouched prefix of the new one",
  );
  assert.equal(
    after.history.length,
    before.history.length + 1,
    "recompile must append exactly one event (the capability change)",
  );

  // Progress is only real if the actions already performed still exist. A
  // rewrite that quietly replaces a half-finished action loses progress even
  // though the state's facts look identical.
  const repaired = run.recompile.puzzle;
  const present = new Set(repaired.actions.map((a) => a.id));
  for (const id of doneActionIds(before.history)) {
    assert.ok(present.has(id), `already-performed action "${id}" vanished from the repaired puzzle`);
  }

  assert.equal(run.progress.preserved, true);
  assert.equal(run.progress.vanishedActions.length, 0);
});

test("1. only not-yet-done actions may change", () => {
  const run = runDemo();
  if (run.recompile.kind !== "ok") assert.fail("demo did not recompile");

  const before = new Map(run.puzzle.actions.map((a) => [a.id, a]));
  const after = new Map(run.recompile.puzzle.actions.map((a) => [a.id, a]));
  const done = new Set(doneActionIds(run.midpointState.history));

  for (const [id, action] of before) {
    if (!done.has(id)) continue;
    const replacement = after.get(id);
    assert.ok(replacement, `done action "${id}" was removed by the recompiler`);
    assert.deepEqual(replacement, action, `done action "${id}" was rewritten by the recompiler`);
  }
});

test("1. the repaired puzzle still needs C: the counterfactual is re-proven, not inherited", () => {
  const run = runDemo();
  if (run.recompile.kind !== "ok") assert.fail("demo did not recompile");

  const repaired = run.recompile.puzzle;
  assert.deepEqual(
    roleById(repaired, DEMO_CHANGE_ROLE)?.capabilities,
    ["scan"],
    "C should now be scan-only",
  );

  const after = certificateForGenerated(repaired, run.recompile.state);
  assert.equal(after.necessity[DEMO_CHANGE_ROLE]?.necessary, true);
  assert.equal(after.necessity[DEMO_CHANGE_ROLE]?.proven, true);
  assert.notEqual(after.hash, run.initialCertificate.hash, "a new certificate must be a new proof");
});

test("7. determinism: two runs give an identical certificate hash and plan", () => {
  const puzzle = demoPuzzle();

  const first = certificateFor(puzzle, emptyState());
  const second = certificateFor(puzzle, emptyState());
  assert.equal(first.hash, second.hash, "certificate hash is not stable");
  assert.deepEqual(first, second, "certificate is not stable");

  const firstSolve = solve(puzzle, emptyState());
  const secondSolve = solve(puzzle, emptyState());
  assert.deepEqual(firstSolve, secondSolve, "solver output is not stable");
});

test("7. determinism: two recompiles give the identical repaired puzzle", () => {
  const run = runDemo();
  const again = recompile(
    run.puzzle,
    run.midpointState,
    DEMO_CHANGE_ROLE,
    [...run.changeTo] as Capability[],
  );

  assert.equal(again.kind, "ok");
  if (run.recompile.kind !== "ok" || again.kind !== "ok") return;

  assert.equal(puzzleKey(again.puzzle), puzzleKey(run.recompile.puzzle), "repaired puzzles differ");
  assert.equal(again.certificate.hash, run.recompile.certificate.hash, "certificate hashes differ");
  assert.deepEqual(
    again.diff.map((d) => d.summary),
    run.recompile.diff.map((d) => d.summary),
    "diffs differ",
  );
});
