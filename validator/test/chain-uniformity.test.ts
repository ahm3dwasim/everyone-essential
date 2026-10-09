/**
 * Regression tests for chain uniformity.
 *
 * `validateGeneratedNamespace` checks a chain's ids and progress wiring.
 * Legality of a chain's CONTENT is decided by a round trip through the real
 * `convertAction` (see `validate.ts`), not a hand-listed set of per-field
 * rules: `convertAction` makes three things uniform across every chain it
 * builds -- one performer, one `needs`, one answer token on every
 * multi-option link, and the same breadth (`options`) on every step -- and a
 * chain that violates any of them fails the round trip and is refused.
 *
 * Two shapes this covers:
 *
 *   1. a chain whose steps need different capabilities. Whole-chain
 *      conversion reads the FIRST link's `needs` as the chain's, so a role
 *      that still holds link 1's capability but not a later link's would
 *      skip the chain entirely rather than reach the link it cannot
 *      perform -- a false definitive `no_valid_recompile` for a puzzle the
 *      same operator library repairs by hand.
 *   2. a chain whose only choice is on its LAST link. Whole-chain
 *      reconstruction copies the answer token from the first link only, so
 *      a naive rebuild would offer two options with no answer token at all
 *      -- invalid input to `validatePuzzle`, which would make
 *      `certificateFor` throw out of `recompile` instead of returning a
 *      typed outcome.
 *
 * Both fixtures below are invalid chains; each assertion checks for the one
 * round-trip-failure message `convertAction` produces, since the fixtures
 * describe real invalid shapes and belong as regression coverage regardless
 * of which check reports them. Fixture 2 (`chain-uniformity-2a`/
 * `chain-uniformity-2b`) needs its first link to have one option (no choice)
 * and its second to have two: `convertAction` gives every step of a chain
 * the SAME breadth (`options`) as well as the same answer token, so that
 * asymmetry is not reproducible by any conversion at all, and the round
 * trip refuses it rather than repairing it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { certify, explainFailure, isCertificate } from "../src/certify";
import {
  type Action,
  type Capability,
  type Puzzle,
  emptyState,
  normalizeState,
} from "../src/model";
import { recompile } from "../src/recompile";
import { validatePuzzle } from "../src/validate";

/* ------------------------------------------------------------------ */
/* Fixture 1 -- a mixed-capability generated chain                     */
/* ------------------------------------------------------------------ */

/**
 * The puzzle: C holds `scan` and `dpad`, and `gate` was split
 * into two correctly wired two-option steps -- but step 1 is a `scan` action
 * and step 2 a `dpad` one. `convertAction` gives every step of a chain the
 * capability it was converted TO, so no repair ever produced this; the gate
 * accepted it and certified it all the same.
 */
function mixedCapabilityChain(): Puzzle {
  return {
    id: "candidate-truncation-mixed-chain",
    roles: [{ id: "C", capabilities: ["scan", "dpad"], privateTokens: ["answer"] }],
    // maxOptions: 3, not 4 -- a real conversion of this chain's 4-way logical
    // choice (2 steps * 2 options) needs two steps under this library
    // (4 <= a maxOptions-4 primitive would fit in ONE step, never splitting at
    // all), which is what makes `uniformCapabilityChain` below an actual
    // `convertAction` output rather than a shape that merely satisfies a
    // hand-listed set of rules.
    primitives: [
      { id: "scan.three", capability: "scan", maxOptions: 3, splittable: true, label: "scan" },
      { id: "dpad.three", capability: "dpad", maxOptions: 3, splittable: true, label: "dpad" },
    ],
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
        needs: "dpad",
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

/** Control: the same chain with link 2 moved to `scan`. */
function uniformCapabilityChain(): Puzzle {
  const puzzle = mixedCapabilityChain();
  return {
    ...puzzle,
    roles: [{ ...puzzle.roles[0]!, capabilities: ["scan"] }],
    actions: puzzle.actions.map((action) =>
      action.id === "§gate__step2" ? { ...action, needs: "scan" } : action,
    ),
  };
}

test("chain-uniformity-1a. a mixed-capability chain is refused: every step of a chain needs the same capability", () => {
  const puzzle = mixedCapabilityChain();
  // A chain whose steps disagree on `needs` must be refused, never accepted and certified.
  const result = validatePuzzle(puzzle);
  assert.equal(result.ok, false, "a chain whose steps disagree on `needs` is not a shape the generator emits");
  if (result.ok) return;
  // There is no per-field "more than one capability" message: this shape is
  // refused because recovering its logical action and re-running
  // `convertAction` cannot reproduce it, the same way any other
  // non-generator shape is refused.
  const roundTripErrors = result.errors.filter(
    (e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail),
  );
  assert.equal(
    roundTripErrors.length,
    2,
    `expected one issue per step of the chain, got ${JSON.stringify(result.errors, null, 2)}`,
  );
});

test("chain-uniformity-1b. the mixed chain is a typed refusal on every public entry: certify refuses it, recompile returns invalid_input rather than no_valid_recompile", () => {
  const puzzle = mixedCapabilityChain();
  const start = emptyState();

  // A mixed-capability chain must never certify as `ok: true`.
  const certified = certify(puzzle, start);
  assert.equal(isCertificate(certified), false, "a mixed-capability chain must not be certified");
  if (!isCertificate(certified)) {
    assert.equal(certified.kind, "invalid_puzzle");
    assert.equal(certified.stateInvalid, false, "the puzzle, not the state, is what is wrong");
  }

  // `no_valid_recompile` would be the wrong outcome here: it is a claim about the
  // operator space, for a puzzle the validator must never let through, and a hand
  // repair disproves it outright.
  const result = recompile(puzzle, start, "C", ["scan"]);
  assert.equal(result.kind, "invalid_input", JSON.stringify(result));
  if (result.kind !== "invalid_input") return;
  assert.equal(result.operatorsTried.length, 0, "an input refusal searches nothing");
  assert.ok(
    result.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `the refusal must carry the chain issue, got ${JSON.stringify(result.errors)}`,
  );
});

test("chain-uniformity-1c. control: the same chain made uniform validates, certifies, and is repaired by the operator library", () => {
  const puzzle = uniformCapabilityChain();
  const start = emptyState();
  assert.equal(validatePuzzle(puzzle).ok, true, "moving link 2 to `scan` is exactly the generator's shape");
  const certificate = certify(puzzle, start);
  assert.equal(isCertificate(certificate), true, isCertificate(certificate) ? "" : explainFailure(certificate));
  if (isCertificate(certificate)) assert.equal(certificate.ok, true, explainFailure(certificate));
});

test("chain-uniformity-1d. a chain split across performers is refused: the generator splits an action for one role", () => {
  const puzzle = mixedCapabilityChain();
  const split: Puzzle = {
    ...puzzle,
    roles: [...puzzle.roles, { id: "D", capabilities: ["dpad"], privateTokens: [] }],
    // Same capability on both links; only the performer differs, so this pins
    // the performer rule on its own rather than riding on the capability one.
    actions: puzzle.actions.map((action, index) => ({
      ...action,
      needs: "scan" as Capability,
      performer: index === 0 ? "C" : "D",
    })),
  };
  const result = validatePuzzle(split);
  assert.equal(result.ok, false, "a chain performed by two roles is not a shape the generator emits");
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `expected a round-trip refusal, got ${JSON.stringify(result.errors)}`,
  );
});

/* ------------------------------------------------------------------ */
/* Fixture 2 -- a chain with its answer on a later link                */
/* ------------------------------------------------------------------ */

/**
 * The puzzle: a correctly wired two-link `dpad` chain whose
 * FIRST link has one option and no answer token, and whose SECOND link is the
 * two-option choice. `convertAction` gives every step of a chain it builds the
 * same answer token AND the same breadth (`options`), so this shape -- uneven
 * options between links -- is not something any conversion can produce,
 * regardless of performer/capability/answer agreement. Checking only those
 * three accepts it anyway; the round-trip check refuses it directly (see the
 * note at the top of this file).
 */
function lateAnswerChain(): Puzzle {
  return {
    id: "candidate-truncation-late-answer-chain",
    roles: [{ id: "C", capabilities: ["dpad"], privateTokens: ["answer"] }],
    primitives: [{ id: "scan.four", capability: "scan", maxOptions: 4, splittable: true, label: "scan" }],
    goalFlags: ["goal"],
    actions: [
      {
        id: "§gate__step1",
        performer: "C",
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["§gate__progress1"],
        setsFlags: [],
        options: 1,
      },
      {
        id: "§gate__step2",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["§gate__progress1", "answer"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 2,
        answerToken: "answer",
      },
    ],
  };
}

test("chain-uniformity-2a. the late-answer chain (uneven breadth between links) is not a shape convertAction ever emits, and is refused as invalid input rather than repaired", () => {
  const puzzle = lateAnswerChain();
  const start = emptyState();

  // This shape must not validate, certify, or reach `recompile`'s repair path:
  // `convertAction` never produces uneven breadth between the links of one
  // chain, so nothing this puzzle claims to be is actually reachable, and the
  // honest answer is refusal, not repair.
  const result = validatePuzzle(puzzle);
  assert.equal(
    result.ok,
    false,
    "convertAction gives every step of a chain the same breadth; a chain whose first link has 1 option and second has 2 cannot come from any conversion",
  );
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `expected a round-trip refusal, got ${JSON.stringify(result.errors)}`,
  );

  assert.equal(isCertificate(certify(puzzle, start)), false, "a chain that isn't the generator's shape must not be certified");

  const recompiled = recompile(puzzle, start, "C", ["scan"]);
  assert.equal(recompiled.kind, "invalid_input", JSON.stringify(recompiled));
  if (recompiled.kind !== "invalid_input") return;
  assert.equal(recompiled.operatorsTried.length, 0, "an input refusal searches nothing");
});

test("chain-uniformity-2b. a chain whose multi-option steps name different answer tokens is refused; the same chain sharing one answer token round-trips and is legal", () => {
  const puzzle = uniformCapabilityChain();
  const disagreeing: Puzzle = {
    ...puzzle,
    roles: [{ ...puzzle.roles[0]!, privateTokens: ["answer", "other"] }],
    actions: [
      puzzle.actions[0]!,
      { ...puzzle.actions[1]!, requiresTokens: ["§gate__progress1", "other"], answerToken: "other" },
    ],
  };
  const result = validatePuzzle(disagreeing);
  assert.equal(result.ok, false, "a chain gated on two different answers is not a shape convertAction ever emits");
  if (result.ok) return;
  assert.ok(
    result.errors.some((e) => e.kind === "reserved_id" && /not exactly what "convertAction" would produce/.test(e.detail)),
    `expected a round-trip refusal, got ${JSON.stringify(result.errors)}`,
  );

  // The same chain gated on ONE answer is legal input: the control that keeps
  // the rule from being "refuse every chain with a choice in it". This is
  // `uniformCapabilityChain` itself, unmodified -- already asserted `ok` by
  // chain-uniformity-1c, repeated here so this test does not depend on that one's ordering.
  assert.equal(validatePuzzle(puzzle).ok, true, "one shared answer token across the chain is the generator's shape");
});

/* ------------------------------------------------------------------ */
/* Property -- hand-built-but-valid generated chains as recompile input */
/* ------------------------------------------------------------------ */

/**
 * A generated chain in exactly the shape `convertAction` emits, built by hand:
 * one performer, one capability, the same answer token on every multi-option
 * link, `§<origId>__progress<i>` wiring step i -> step i+1, the original
 * prerequisites on the first link and the original effects on the last.
 */
function handBuiltChain(
  origId: string,
  performer: string,
  capability: Capability,
  options: readonly number[],
  answerToken: string | undefined,
  firstRequires: readonly string[],
  lastSetsFlags: readonly string[],
  firstRequiresFlags: readonly string[] = [],
): Action[] {
  const steps = options.length;
  return options.map((breadth, index) => {
    const step = index + 1;
    const isFirst = step === 1;
    const isLast = step === steps;
    const requiresTokens = isFirst ? [...firstRequires] : [`§${origId}__progress${step - 1}`];
    if (breadth > 1 && answerToken && !requiresTokens.includes(answerToken)) requiresTokens.push(answerToken);
    const action: Action = {
      id: `§${origId}__step${step}`,
      performer,
      needs: capability,
      requiresTokens,
      requiresFlags: isFirst ? [...firstRequiresFlags] : [],
      producesTokens: isLast ? [] : [`§${origId}__progress${step}`],
      setsFlags: isLast ? [...lastSetsFlags] : [],
      options: breadth,
      // The exact shape `convertAction` emits (`convert.ts:136`): the source
      // label (here, the unauthored origId, since none of these fixtures set
      // one) plus its fixed suffix. Labels are compared field for field,
      // so a hand-built chain not asserting a specific label mismatch has to
      // use this exact format to still round-trip as real generator output.
      label: `${origId} (step ${step} of ${steps}, ${breadth} options)`,
    };
    if (breadth > 1 && answerToken) action.answerToken = answerToken;
    return action;
  });
}

/**
 * Each variant is a puzzle whose `gate` is already a generated chain C owns:
 * a two-link chain (the canonical split), a three-link one, and a chain C
 * owns alongside a second role D whose action the chain depends on -- so
 * `reassign` has somewhere to go and the whole-chain reassign path is
 * exercised too.
 *
 * Note: the late-answer shape (`options: [1, 2]`, uneven breadth between two
 * links) does not belong here: `chainRoundTrips` refuses it (see
 * `middle-link-2a`), so it lives in the near-miss corpus in
 * `middle-link-smuggling.test.ts`, which asserts the refusal instead.
 * `SCAN`/`DPAD` use `maxOptions: 2`, not 4:
 * a 4-way logical choice fits in ONE step under a maxOptions-4 primitive, so
 * `[2, 2]`/`[2, 2, 2]` would never actually be `convertAction` output under
 * a maxOptions-4 library -- they would only happen to satisfy a hand-listed
 * set of uniformity rules. `maxOptions: 2` is small enough that these totals (4, 8)
 * genuinely require the number of steps and the per-step breadth each
 * variant declares, which `middle-link-smuggling.test.ts`'s round-trip property confirms
 * directly by generating chains the same way and checking they equal these.
 */
interface ChainVariant {
  name: string;
  puzzle: () => Puzzle;
}

const SCAN = { id: "scan.two", capability: "scan", maxOptions: 2, splittable: true, label: "scan" } as const;
const DPAD = { id: "dpad.two", capability: "dpad", maxOptions: 2, splittable: true, label: "dpad" } as const;

const CHAIN_VARIANTS: ChainVariant[] = [
  {
    name: "two-link scan chain, both links a two-option choice",
    puzzle: () => ({
      id: "chain-uniformity-chain-2",
      roles: [{ id: "C", capabilities: ["dpad", "scan"], privateTokens: ["answer"] }],
      primitives: [SCAN, DPAD],
      goalFlags: ["goal"],
      actions: handBuiltChain("gate", "C", "scan", [2, 2], "answer", ["answer"], ["goal"]),
    }),
  },
  {
    name: "three-link scan chain",
    puzzle: () => ({
      id: "chain-uniformity-chain-3",
      roles: [{ id: "C", capabilities: ["dpad", "scan"], privateTokens: ["answer"] }],
      primitives: [SCAN, DPAD],
      goalFlags: ["goal"],
      actions: handBuiltChain("gate", "C", "scan", [2, 2, 2], "answer", ["answer"], ["goal"]),
    }),
  },
  {
    name: "chain on C plus a second role D the chain depends on",
    puzzle: () => ({
      id: "chain-uniformity-two-roles",
      roles: [
        { id: "C", capabilities: ["dpad", "scan"], privateTokens: ["answer"] },
        { id: "D", capabilities: ["dpad"], privateTokens: [] },
      ],
      primitives: [SCAN, DPAD],
      goalFlags: ["goal"],
      actions: [
        ...handBuiltChain("gate", "C", "scan", [2, 2], "answer", ["answer"], ["goal"], ["prepped"]),
        { id: "prep", performer: "D", needs: "dpad", requiresTokens: [], requiresFlags: [], producesTokens: [], setsFlags: ["prepped"] },
      ],
    }),
  },
];

const ALL_CAPABILITIES: Capability[] = ["dpad", "scan", "voice"];

/** Every non-empty subset of the three capabilities: 7 of them. */
function nonEmptyCapabilitySubsets(): Capability[][] {
  const subsets: Capability[][] = [];
  for (let mask = 1; mask < 1 << ALL_CAPABILITIES.length; mask++) {
    subsets.push(ALL_CAPABILITIES.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return subsets;
}

/**
 * `operator_error` is this gate's own outcome. It is spelled as a plain
 * string here, rather than imported from the `RecompileResult` union, so
 * this file type-checks even where that member is not declared.
 */
const OPERATOR_ERROR: string = "operator_error";

function isTypedOutcome(kind: string): boolean {
  return (
    kind === "ok" ||
    kind === "no_valid_recompile" ||
    kind === "search_exhausted" ||
    kind === "invalid_input" ||
    kind === OPERATOR_ERROR
  );
}

test("chain-uniformity-3. property: hand-built-but-valid generated chains are accepted input, and every capability change over them returns a typed outcome", () => {
  const subsets = nonEmptyCapabilitySubsets();
  const start = emptyState();
  let accepted = 0;
  let okCount = 0;
  let attempts = 0;
  let expectedAttempts = 0;
  /** Capability changes whose base candidate already certifies -- the case where no operator runs at all. */
  let noRewriteOk = 0;

  for (const variant of CHAIN_VARIANTS) {
    const puzzle = variant.puzzle();
    assert.equal(
      validatePuzzle(puzzle).ok,
      true,
      `${variant.name}: the hand-built chain must be legal input, else this property tests nothing`,
    );
    const certificate = certify(puzzle, start);
    assert.equal(isCertificate(certificate), true, `${variant.name}: ${isCertificate(certificate) ? "" : explainFailure(certificate)}`);
    if (isCertificate(certificate)) {
      assert.equal(certificate.ok, true, `${variant.name}: ${explainFailure(certificate)}`);
      accepted++;
    }

    const roles = puzzle.roles.map((r) => r.id);
    expectedAttempts += roles.length * subsets.length;
    for (const roleId of roles) {
      for (const caps of subsets) {
        attempts++;
        // An uncaught throw here fails the test on its own, which is this
        // property's point: a well-formed chain and a well-formed request get
        // a typed outcome, not an exception.
        const result = recompile(puzzle, start, roleId, caps);
        assert.ok(isTypedOutcome(result.kind), `${variant.name}: unexpected result kind ${result.kind}`);
        if ((result.kind as string) === OPERATOR_ERROR) {
          assert.fail(`${variant.name}: ${roleId} -> ${caps.join("+")} hit the operator-error belt`);
        }
        if (result.kind !== "ok") continue;
        okCount++;
        if (result.diff.length === 1) noRewriteOk++;
        assert.equal(result.certificate.ok, true, explainFailure(result.certificate));

        // Feeding a repaired puzzle back in is recompile's own input class: a
        // chain this very search generated, accepted as an ordinary puzzle.
        const historyBefore = normalizeState(start).history;
        assert.deepEqual(normalizeState(result.state).history.slice(0, historyBefore.length), historyBefore);
        assert.equal(isCertificate(certify(result.puzzle, result.state)), true);
        const second = recompile(result.puzzle, result.state, roleId, subsets[0]!);
        assert.ok(isTypedOutcome(second.kind), `second pass: unexpected result kind ${second.kind}`);
        assert.notEqual(second.kind as string, OPERATOR_ERROR, `second pass hit the belt: ${JSON.stringify(second)}`);
      }
    }
  }

  // Not vacuous: every variant was accepted, the search ran, and it found
  // repairs both with and without a rewrite.
  assert.equal(accepted, CHAIN_VARIANTS.length, "every hand-built chain variant must be accepted input");
  assert.equal(
    attempts,
    expectedAttempts,
    `expected the full sweep of ${expectedAttempts} (role, capability subset) pairs, got ${attempts}`,
  );
  assert.ok(attempts >= CHAIN_VARIANTS.length * 7, `expected the full capability-subset sweep, got ${attempts} attempts`);
  assert.ok(okCount > 0, "expected at least one repair over the family");
  assert.ok(noRewriteOk > 0, "expected at least one capability change that needed no rewrite at all");
});
