/**
 * Regression tests for values smuggled onto a middle chain link.
 *
 * There is no hand-listed set of rules for the ways a `§` generated chain
 * could disagree with itself and still be accepted -- one performer, one
 * capability, one answer token, and so on. Instead, `validateGeneratedNamespace`
 * (`validate.ts`) accepts a chain only if recovering the logical action it
 * stands for and re-running the REAL `convertAction` reproduces it exactly
 * (`convert.ts`). `recompile`'s own whole-chain repair uses the same
 * recovery function, so the two can never disagree.
 *
 * The two fixtures below test for a requirement or a flag smuggled onto a
 * middle link of an otherwise-uniform chain. Both are refused: the round
 * trip only ever reproduces a requirement or effect where `convertAction`
 * actually puts it (link 1's requirements, link N's effects), so anything
 * smuggled onto a middle link makes the recovered logical action's
 * regenerated chain disagree with the one it was recovered from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, explainFailure, isCertificate } from "../src/certify";
import { type Capability, type Puzzle, emptyState, normalizeState } from "../src/model";
import { recompile } from "../src/recompile";
import { validatePuzzle } from "../src/validate";
import { demoPuzzle, ROLE_A, ROLE_B, ROLE_C } from "../src/demo";

const SCAN_THREE = { id: "scan.three", capability: "scan", maxOptions: 3, splittable: true, label: "scan" } as const;
const VOICE_FOUR = { id: "voice.four", capability: "voice", maxOptions: 4, splittable: true, label: "voice" } as const;

/* ------------------------------------------------------------------ */
/* The two fixtures, chain-uniformity-late-requirement/-late-flag         */
/* ------------------------------------------------------------------ */

/**
 * "chain-uniformity-late-requirement": C holds `scan` and
 * private `answer`; D holds private `later`; a uniform two-step `§gate` chain
 * has two answer-gated `scan` steps, correct `§gate__progress1` wiring, and
 * adds `later` only to step 2's `requiresTokens`. A `voice.four` primitive
 * permits C's change to `voice` -- the repair target, kept here even though
 * the search is never reached: the puzzle is refused before
 * any capability change is considered.
 *
 * This puzzle must be refused, not certified: a whole-chain candidate that
 * reconstructs the logical action from step 1's requirements alone silently
 * loses `later`, makes D decorative, and would report `no_valid_recompile` as
 * if no repair existed for what is actually a certified input.
 */
function lateRequirementChain(): Puzzle {
  return {
    id: "chain-uniformity-late-requirement",
    roles: [
      { id: "C", capabilities: ["scan"], privateTokens: ["answer"] },
      { id: "D", capabilities: [], privateTokens: ["later"] },
    ],
    primitives: [SCAN_THREE, VOICE_FOUR],
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
      },
      {
        id: "§gate__step2",
        performer: "C",
        needs: "scan",
        // "later" is the smuggled requirement: not on step 1, so a real
        // `convertAction` output could never have it here either.
        requiresTokens: ["§gate__progress1", "answer", "later"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 2,
        answerToken: "answer",
      },
    ],
  };
}

/**
 * "chain-uniformity-late-flag": the same accepted chain, but
 * instead of a smuggled token requirement, a D-produced flag `later` sits only
 * in step 2's `requiresFlags`.
 *
 * `recompile` must not return `ok` with a rebuilt `gate` whose `requiresFlags`
 * is `[]`: dropping the original prerequisite would certify a puzzle DIFFERENT
 * from the one it was asked to repair, instead of either preserving the
 * input's progress rules or refusing it.
 */
function lateFlagChain(): Puzzle {
  return {
    id: "chain-uniformity-late-flag",
    // D's necessity does not depend on "later" alone: `d_clue_action` gives D
    // a second, unrelated reason to be necessary (`goal2`). This is what lets
    // an implementation without this gate actually reach `ok` below rather
    // than a decorative-role
    // refusal -- the certificate looks fine because D is STILL necessary, even
    // though the specific rule "later before gate closes" silently vanished.
    // That gap between "the certificate says ok" and "this is still the puzzle
    // that was input" is exactly the point.
    roles: [
      { id: "C", capabilities: ["scan"], privateTokens: ["answer"] },
      { id: "D", capabilities: ["voice"], privateTokens: ["clue"] },
    ],
    primitives: [SCAN_THREE, VOICE_FOUR],
    goalFlags: ["goal", "goal2"],
    actions: [
      { id: "d_set_later", performer: "D", needs: "voice", requiresTokens: [], requiresFlags: [], producesTokens: [], setsFlags: ["later"] },
      { id: "d_clue_action", performer: "D", needs: "voice", requiresTokens: ["clue"], requiresFlags: [], producesTokens: [], setsFlags: ["goal2"] },
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
      },
      {
        id: "§gate__step2",
        performer: "C",
        needs: "scan",
        requiresTokens: ["§gate__progress1", "answer"],
        // "later" is the smuggled flag: not on step 1, so a real
        // `convertAction` output could never require it here either.
        requiresFlags: ["later"],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 2,
        answerToken: "answer",
      },
    ],
  };
}

test("middle-link-1a. chain-uniformity-late-requirement is refused as invalid input, never certified or repaired", () => {
  const puzzle = lateRequirementChain();
  const start = emptyState();

  const validated = validatePuzzle(puzzle);
  assert.equal(validated.ok, false, "a chain that smuggles a requirement onto a middle link is not a shape convertAction ever emits");
  if (validated.ok) return;
  assert.ok(
    validated.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `expected a round-trip refusal, got ${JSON.stringify(validated.errors)}`,
  );

  assert.equal(isCertificate(certify(puzzle, start)), false, "must not certify");

  const result = recompile(puzzle, start, "C", ["voice"]);
  assert.equal(result.kind, "invalid_input", `expected invalid_input, got ${JSON.stringify(result)}`);
  if (result.kind !== "invalid_input") return;
  assert.equal(result.operatorsTried.length, 0, "an input refusal searches nothing -- D can never be silently demoted, because the puzzle never enters the search");
});

test("middle-link-1b. chain-uniformity-late-flag is refused as invalid input, never certified or repaired", () => {
  const puzzle = lateFlagChain();
  const start = emptyState();

  const validated = validatePuzzle(puzzle);
  assert.equal(validated.ok, false, "a chain that smuggles a flag requirement onto a middle link is not a shape convertAction ever emits");
  if (validated.ok) return;
  assert.ok(
    validated.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `expected a round-trip refusal, got ${JSON.stringify(validated.errors)}`,
  );

  assert.equal(isCertificate(certify(puzzle, start)), false, "must not certify");

  const result = recompile(puzzle, start, "C", ["voice"]);
  assert.equal(result.kind, "invalid_input", `expected invalid_input, got ${JSON.stringify(result)}`);
  if (result.kind !== "invalid_input") return;
  assert.equal(result.operatorsTried.length, 0, "an input refusal searches nothing -- the puzzle can never be silently swapped for a different one, because it never enters the search");
});

/* ------------------------------------------------------------------ */
/* candidate-truncation-2/candidate-truncation-3: a second capability change over a         */
/* recompiled chain must still work. Regression only -- the fixtures live in  */
/* candidate-truncation-and-chain-conversion.test.ts and are unchanged; this states the requirement       */
/* ------------------------------------------------------------------ */

test("middle-link-1c. a chain recompile itself produced round-trips, and a second capability change over it still finds a repair (candidate-truncation-2's scenario, under this comparison)", () => {
  const puzzle: Puzzle = {
    id: "middle-link-second-change",
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
  const start = emptyState();

  const first = recompile(puzzle, start, "C", ["scan"]);
  assert.equal(first.kind, "ok", first.kind === "ok" ? "" : JSON.stringify(first));
  if (first.kind !== "ok") return;
  assert.equal(validatePuzzle(first.puzzle).ok, true, "recompile's own generated chain must round-trip");

  const second = recompile(first.puzzle, first.state, "C", ["dpad"]);
  assert.equal(second.kind, "ok", `expected the whole-chain re-split to succeed, got ${second.kind}: ${JSON.stringify(second)}`);
  if (second.kind !== "ok") return;
  assert.equal(validatePuzzle(second.puzzle).ok, true, "the re-split chain must round-trip too");
  assert.equal(second.certificate.ok, true, explainFailure(second.certificate));

  const a = normalizeState(start);
  const b = normalizeState(first.state);
  const c = normalizeState(second.state);
  assert.deepEqual(b.history.slice(0, a.history.length), a.history);
  assert.deepEqual(c.history.slice(0, b.history.length), b.history);
});

/* ------------------------------------------------------------------ */
/* Property -- every chain a real recompile produces round-trips        */
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

test("middle-link-3. property: for every demo role x capability subset, every chain a real recompile produces round-trips (validatePuzzle accepts recompile's own output)", () => {
  const roles = [ROLE_A, ROLE_B, ROLE_C];
  const subsets = nonEmptyCapabilitySubsets();
  const start = emptyState();
  let okCount = 0;
  let chainsChecked = 0;

  for (const role of roles) {
    for (const caps of subsets) {
      const puzzle = demoPuzzle();
      const result = recompile(puzzle, start, role, caps);
      assert.ok(
        result.kind === "ok" ||
          result.kind === "no_valid_recompile" ||
          result.kind === "search_exhausted" ||
          result.kind === "invalid_input",
        `unexpected recompile kind ${result.kind}`,
      );
      if (result.kind !== "ok") continue;
      okCount++;
      // `recompile`'s own output is, itself, ordinary input to `certify` --
      // there is no special mode. If it produced a `§` chain, that chain must
      // be exactly what `convertAction` would produce, because it is.
      const validated = validatePuzzle(result.puzzle);
      assert.equal(
        validated.ok,
        true,
        `recompile's own output must round-trip: ${validated.ok ? "" : JSON.stringify(validated.errors)}`,
      );
      if (result.puzzle.actions.some((a) => a.id.startsWith("§"))) chainsChecked++;
    }
  }

  assert.ok(okCount > 0, "expected at least one recompile to succeed");
  assert.ok(chainsChecked > 0, "expected at least one recompile to actually produce a § chain, else this property checks nothing about chains");
});

/* ------------------------------------------------------------------ */
/* Hand-built near-misses: everything the round trip has to catch        */
/* ------------------------------------------------------------------ */

/** A real 2-step uniform chain, breadth 2 both links -- the positive control every near-miss below is a one-field mutation of. */
function baseChain(): Puzzle {
  return {
    id: "middle-link-near-miss-base",
    roles: [{ id: "C", capabilities: ["scan"], privateTokens: ["answer"] }],
    primitives: [SCAN_THREE],
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

function unequalOptionsChain(): Puzzle {
  const puzzle = baseChain();
  return {
    ...puzzle,
    // Real convertAction gives every step the SAME breadth. 2 and 3 is not a
    // shape any single conversion produces.
    actions: [puzzle.actions[0]!, { ...puzzle.actions[1]!, options: 3 }],
  };
}

function mixedPerformerChain(): Puzzle {
  const puzzle = baseChain();
  return {
    ...puzzle,
    roles: [...puzzle.roles, { id: "D", capabilities: ["scan"], privateTokens: [] }],
    actions: [puzzle.actions[0]!, { ...puzzle.actions[1]!, performer: "D" }],
  };
}

function wrongProgressWiringChain(): Puzzle {
  const puzzle = baseChain();
  return {
    ...puzzle,
    // Step 2 no longer requires step 1's progress token, so it fires without
    // step 1 ever having happened -- and, just as importantly for this file,
    // the round trip alone catches it: recovering the logical action and
    // re-running the generator would put the progress requirement back.
    actions: [puzzle.actions[0]!, { ...puzzle.actions[1]!, requiresTokens: ["answer"] }],
  };
}

interface NearMiss {
  name: string;
  puzzle: () => Puzzle;
}

const NEAR_MISSES: NearMiss[] = [
  { name: "late requirement (chain-uniformity-late-requirement)", puzzle: lateRequirementChain },
  { name: "late flag (chain-uniformity-late-flag)", puzzle: lateFlagChain },
  { name: "unequal options between two links (2 then 3)", puzzle: unequalOptionsChain },
  { name: "mixed performer across two links", puzzle: mixedPerformerChain },
  { name: "wrong progress wiring: step 2 does not require step 1's progress token", puzzle: wrongProgressWiringChain },
];

test("middle-link-4. property: hand-built near-miss chains are all refused as invalid_input, never certified or repaired", () => {
  const start = emptyState();
  for (const { name, puzzle: build } of NEAR_MISSES) {
    const puzzle = build();
    const validated = validatePuzzle(puzzle);
    assert.equal(validated.ok, false, `${name}: must be refused by validatePuzzle`);
    assert.equal(isCertificate(certify(puzzle, start)), false, `${name}: must not certify`);
    const result = recompile(puzzle, start, puzzle.roles[0]!.id, ["voice"]);
    assert.equal(result.kind, "invalid_input", `${name}: recompile must refuse, got ${JSON.stringify(result)}`);
  }
});

/** The positive control for the near-miss table: unmodified, `baseChain` itself round-trips and certifies. */
test("middle-link-5. control: the unmodified base chain every near-miss above mutates is itself legal, certified input", () => {
  const puzzle = baseChain();
  const start = emptyState();
  assert.equal(validatePuzzle(puzzle).ok, true, "the base chain is a real convertAction output and must round-trip");
  const certificate = certify(puzzle, start);
  assert.equal(isCertificate(certificate), true, isCertificate(certificate) ? "" : explainFailure(certificate));
  if (isCertificate(certificate)) assert.equal(certificate.ok, true, explainFailure(certificate));
});
