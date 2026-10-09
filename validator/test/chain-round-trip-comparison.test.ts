/**
 * Regression tests for the round-trip comparison that decides chain legality.
 *
 * A chain is legal only if recovering the logical action it stands for and
 * re-running the real `convertAction` reproduces it. The comparison that
 * decides "reproduces it" (`canonicalStep`, `convert.ts`) has to be exact,
 * not merely structural:
 *
 *   - `canonicalStep` compares every array field as the exact sequence
 *     `convertAction` produces -- order and multiplicity both, never sorted
 *     or deduplicated. `convertAction` never repeats a token in
 *     `requiresTokens`, so a repeat is not a fact about the puzzle the round
 *     trip could see past; it is a shape the generator does not produce, and
 *     comparing it as equal to a single occurrence would let it slip
 *     through unnoticed.
 *   - `canonicalStep` includes `label` in the comparison. `convertAction`
 *     always builds a step's label from one source label plus the fixed
 *     suffix `" (step i of N, B options)"` (`convert.ts:136`), so two steps
 *     of one chain with unrelated labels is exactly as impossible as two
 *     steps that disagree on `performer`; leaving `label` out of the
 *     comparison would leave that case unchecked.
 *   - `validatePuzzle` refuses a non-string action `label`, the same way it
 *     refuses a non-string `performer` or `needs`. Without that check, a
 *     non-string label (a `Symbol`, say) would pass `validatePuzzle` and
 *     reach `recompile`'s whole-chain repair, which copies it into the
 *     recovered logical action and interpolates it into a template string
 *     while rebuilding the chain for a new capability -- surfacing only as
 *     a generic `operator_error` at the point of the throw.
 *
 * `deriveLogicalAction` reads `requiresTokens`/`requiresFlags`/`label` from
 * step 1 and `producesTokens`/`setsFlags` from the last step verbatim, not
 * folded across every step with `sortedUnique` (which would normalise a
 * repeated token and could reorder a field the real generator emits in a
 * fixed order); a value smuggled onto a middle link is still caught, by the
 * per-step comparison itself rather than by the recovery.
 *
 * All three fixtures below are invalid chains, refused by these checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, isCertificate } from "../src/certify";
import { type Puzzle, emptyState } from "../src/model";
import { recompile } from "../src/recompile";
import { validatePuzzle } from "../src/validate";

/**
 * A real, uniform two-step `§gate` chain: C holds `scan` and private
 * `answer`; the 4-way logical choice splits into two 2-way `scan` steps
 * under a `maxOptions: 2` primitive. Every field, labels included, is
 * exactly what `convertAction` would produce -- the positive shape each
 * fixture below mutates by exactly one field.
 */
function gateChain(): Puzzle {
  return {
    id: "round-trip-gate",
    roles: [{ id: "C", capabilities: ["scan"], privateTokens: ["answer"] }],
    primitives: [{ id: "scan.two", capability: "scan", maxOptions: 2, splittable: true, label: "scan" }],
    goalFlags: ["goal"],
    actions: [
      {
        id: "§gate__step1",
        performer: "C",
        needs: "scan",
        requiresTokens: ["answer"],
        requiresFlags: [],
        producesTokens: ["§gate__progress1"],
        setsFlags: [],
        options: 2,
        answerToken: "answer",
        label: "gate (step 1 of 2, 2 options)",
      },
      {
        id: "§gate__step2",
        performer: "C",
        needs: "scan",
        requiresTokens: ["§gate__progress1", "answer"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 2,
        answerToken: "answer",
        label: "gate (step 2 of 2, 2 options)",
      },
    ],
  };
}

/** First scenario: two labels no single source label and step count could produce. */
function incompatibleLabelsChain(): Puzzle {
  const puzzle = gateChain();
  return {
    ...puzzle,
    actions: [
      { ...puzzle.actions[0]!, label: "first forged caption" },
      { ...puzzle.actions[1]!, label: "second forged caption" },
    ],
  };
}

/** Second scenario: step 2's answer token appears twice. `convertAction` appends it at most once (`convert.ts:124-126`). */
function duplicatedAnswerTokenChain(): Puzzle {
  const puzzle = gateChain();
  return {
    ...puzzle,
    actions: [puzzle.actions[0]!, { ...puzzle.actions[1]!, requiresTokens: ["§gate__progress1", "answer", "answer"] }],
  };
}

/** Third scenario: step 1's `label` is a `Symbol`, not a string. Built loosely-typed and cast at each call site, the same way `terminal-capabilities-4`/`terminal-capabilities-4b` exercise other malformed runtime fields. */
function nonStringLabelChain(): unknown {
  const puzzle = gateChain();
  const poisoned: Record<string, unknown> = { ...puzzle.actions[0]!, label: Symbol("poisoned label") };
  return { ...puzzle, actions: [poisoned, puzzle.actions[1]!] };
}

test("round-trip-1. middle-link-incompatible-labels: two labels no source label and step count could produce are refused, not certified", () => {
  const puzzle = incompatibleLabelsChain();
  const start = emptyState();

  // This chain must be refused, not certified and recompiled to `ok`: no
  // source logical action can produce these two labels reaching the template
  // interpolation that builds a generated label.
  const result = validatePuzzle(puzzle);
  assert.equal(
    result.ok,
    false,
    "convertAction builds every step's label from one source label plus a fixed suffix; two unrelated strings cannot come from one",
  );
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `expected a round-trip refusal, got ${JSON.stringify(result.errors)}`,
  );

  assert.equal(isCertificate(certify(puzzle, start)), false, "a chain with incompatible labels must not certify");

  const recompiled = recompile(puzzle, start, "C", ["voice"]);
  assert.equal(recompiled.kind, "invalid_input", JSON.stringify(recompiled));
  if (recompiled.kind !== "invalid_input") return;
  assert.equal(recompiled.operatorsTried.length, 0, "an input refusal searches nothing");
});

test("round-trip-2. middle-link-duplicated-answer-token: a later step whose requiresTokens repeats the answer token is refused, not silently deduplicated", () => {
  const puzzle = duplicatedAnswerTokenChain();
  const start = emptyState();

  // This chain must be refused, not certified and recompiled to `ok`:
  // `canonicalStep`'s `sortedUnique` would collapse the repeat before
  // comparing, but a real step 2 requires the answer exactly once
  // (`convert.ts:124-126`).
  const result = validatePuzzle(puzzle);
  assert.equal(
    result.ok,
    false,
    "convertAction requires the answer token at most once per step; a step that requires it twice is not a shape any conversion produces",
  );
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `expected a round-trip refusal, got ${JSON.stringify(result.errors)}`,
  );

  assert.equal(isCertificate(certify(puzzle, start)), false, "a chain with a duplicated requirement must not certify");

  const recompiled = recompile(puzzle, start, "C", ["voice"]);
  assert.equal(recompiled.kind, "invalid_input", JSON.stringify(recompiled));
  if (recompiled.kind !== "invalid_input") return;
  assert.equal(recompiled.operatorsTried.length, 0, "an input refusal searches nothing");
});

test("round-trip-3. middle-link-non-string-label: a Symbol label is refused by validatePuzzle itself, never reaching recompile's operator_error", () => {
  const puzzle = nonStringLabelChain() as unknown as Puzzle;
  const start = emptyState();

  // `entry.label` must be type-checked here: an unchecked label would validate,
  // certify, and reach `recompile(..., "C", ["voice"])`, where a poisoned label
  // surviving into the recovered logical action throws out of the
  // template-string interpolation that builds a generated label
  // (`convert.ts:136`, `recompile.ts:892`), returning `operator_error` instead
  // of a refusal.
  const result = validatePuzzle(puzzle);
  assert.equal(result.ok, false, "an action's label, if present, must be a string");
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.detail.includes("label")),
    `expected an issue naming label, got ${JSON.stringify(result.errors)}`,
  );

  assert.equal(isCertificate(certify(puzzle, start)), false, "a puzzle with a non-string label must not certify");

  const recompiled = recompile(puzzle, start, "C", ["voice"]);
  assert.equal(recompiled.kind, "invalid_input", JSON.stringify(recompiled));
  if (recompiled.kind !== "invalid_input") return;
  assert.equal(recompiled.operatorsTried.length, 0, "an input refusal searches nothing, and never reaches operator_error");
});

/* ------------------------------------------------------------------ */
/* Control: the unmodified chain each fixture above mutates by one field */
/* still round-trips and certifies                                       */
/* ------------------------------------------------------------------ */

test("round-trip-4. control: the unmodified gate chain every fixture above mutates is itself legal, certified input", () => {
  const puzzle = gateChain();
  const start = emptyState();
  const result = validatePuzzle(puzzle);
  assert.equal(result.ok, true, "the base chain is a real convertAction output, labels included, and must round-trip");
  const certificate = certify(puzzle, start);
  assert.equal(isCertificate(certificate), true);
  if (isCertificate(certificate)) assert.equal(certificate.ok, true);
});
