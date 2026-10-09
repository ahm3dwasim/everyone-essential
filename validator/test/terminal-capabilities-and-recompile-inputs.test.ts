/**
 * Regression tests for terminal-capability binding, the absence of any
 * generated-input certification bypass, repaired puzzles as input to the next
 * repair, required shape fields, and validated numeric options. Each test is
 * a permanent guard for one invariant.
 *
 * The bar: a certificate must be about a state whose history actually lands on
 * the capabilities the puzzle currently declares; there is exactly one
 * certification function and it is the only door, reachable or not, that can
 * ever return `ok: true`; a repaired puzzle must be able to absorb a second
 * capability change without special-casing; a missing required field is a shape
 * error, not an implied default; and a bad search bound must never read as "the
 * puzzle has no valid repair".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as api from "../src/api";
import * as certifyModule from "../src/certify";
import { type CertifyResult, certify, explainFailure, isCertificate } from "../src/certify";
import {
  type Puzzle,
  type State,
  emptyState,
  normalizeState,
} from "../src/model";
import { type RecompileResult, recompile } from "../src/recompile";
import { validatePuzzle, validateState } from "../src/validate";
import { demoPuzzle } from "../src/demo";
import { historyFor } from "./helpers";

function standardPrimitives(): Puzzle["primitives"] {
  return [
    { id: "dpad.grid", capability: "dpad", maxOptions: 9, splittable: false, label: "3x3 grid" },
    { id: "scan.paged", capability: "scan", maxOptions: 4, splittable: true, label: "scan" },
    { id: "voice.one", capability: "voice", maxOptions: 1, splittable: false, label: "voice" },
  ];
}

/* ------------------------------------------------------------------ */
/* terminal capabilities bound to the puzzle                            */
/* ------------------------------------------------------------------ */

/**
 * The scenario: C really did do d-pad work, and the history
 * honestly records a later switch to voice -- but the SUPPLIED puzzle still
 * says C(scan). Every individual event replays fine; only the ENDPOINT is
 * impossible. Without this check, this state would receive `ok: true`
 * and then crash `recompile` on the very next capability change.
 */
function terminalCapabilityMismatchFixture(): { puzzle: Puzzle; state: State } {
  const puzzle: Puzzle = {
    id: "term-cap-mismatch",
    roles: [
      { id: "C", capabilities: ["scan"], privateTokens: ["c"] },
      { id: "B", capabilities: ["voice"], privateTokens: ["b"] },
    ],
    actions: [
      {
        id: "c_bridge",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["c"],
        requiresFlags: [],
        producesTokens: ["bridge"],
        setsFlags: [],
        label: "C bridges",
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
  const state: State = {
    flags: [],
    tokens: ["bridge"],
    history: [
      { kind: "action", actionId: "c_bridge", performer: "C", capability: "dpad" },
      { kind: "capability_change", role: "C", from: ["dpad"], to: ["voice"] },
    ],
  };
  return { puzzle, state };
}

test("terminal-capabilities-1a. a state whose replayed history ends at different capabilities than the puzzle declares is refused", () => {
  const { puzzle, state } = terminalCapabilityMismatchFixture();

  const check = validateState(puzzle, state);
  assert.equal(check.ok, false, "C's history ends at voice, but the puzzle says C(scan) -- impossible state");
  assert.ok(
    check.errors.some((e) => e.kind === "invalid_history" && e.role === "C"),
    `expected an invalid_history issue naming C, got ${JSON.stringify(check.errors)}`,
  );

  assert.equal(isCertificate(certify(puzzle, state)), false, "certify must not prove this impossible state");

  // The positive control: the same history, against a puzzle that honestly
  // says C ends at voice, validates and certifies.
  const honestPuzzle: Puzzle = { ...puzzle, roles: puzzle.roles.map((r) => (r.id === "C" ? { ...r, capabilities: ["voice"] } : r)) };
  assert.equal(validateState(honestPuzzle, state).ok, true, JSON.stringify(validateState(honestPuzzle, state).errors));
});

test("terminal-capabilities-1b. recompile on the terminal-capability-mismatch state returns invalid_input and searches nothing", () => {
  const { puzzle, state } = terminalCapabilityMismatchFixture();
  let result: RecompileResult;
  try {
    result = recompile(puzzle, state, "C", ["dpad"]);
  } catch (error) {
    assert.fail(`recompile threw: ${String(error)}`);
  }
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
  if (result.kind !== "invalid_input") return;
  assert.ok(result.errors.length > 0);
  assert.equal(result.operatorsTried.length, 0, "an invalid input must search nothing");
});

/**
 * The options container itself is runtime input, and this test asserts that
 * `recompile` REFUSES an unusable one rather than escaping as a `TypeError`.
 * Every shape below would throw if the bounds were read directly: `null` and a
 * primitive are dereferenced ahead of the options gate, a `BigInt`, a cycle and
 * a throwing `toJSON` break the `JSON.stringify` that builds a refusal's
 * message, and a revoked `Proxy` or a throwing getter raises on the property
 * read. Each read goes through `optionField`, so every shape comes back as
 * `UNREADABLE_OPTIONS` and is refused with the bound named and asserted here.
 */
test("terminal-capabilities-1d. an options container `recompile` cannot read -- null, a primitive, a BigInt, a cycle, a throwing toJSON, a revoked Proxy or a throwing getter -- is refused with invalid_options", () => {
  const puzzle = demoPuzzle();
  const state = emptyState();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const revokedProxy = revocable.proxy;
  // An object whose own property read throws, the same hazard a revoked Proxy
  // poses: the getter must be caught by `optionField`, not escape the call.
  const throwingGetter = {
    get maxDepth() {
      throw new Error("no");
    },
  };

  const containers: { name: string; options: unknown }[] = [
    { name: "null", options: null },
    { name: "a number", options: 7 },
    { name: "a string", options: "maxDepth: 2" },
    { name: "a BigInt bound", options: { maxDepth: 2n } },
    { name: "a BigInt candidate bound", options: { maxCandidates: 3n } },
    { name: "a cyclic bound", options: { maxDepth: cyclic } },
    { name: "a bound whose own toJSON throws", options: { maxCandidates: { toJSON() { throw new Error("no"); } } } },
    { name: "a revoked Proxy container", options: revokedProxy },
    { name: "a container whose own getter throws", options: throwingGetter },
  ];

  for (const { name, options } of containers) {
    let result: RecompileResult;
    try {
      result = recompile(puzzle, state, "A", ["scan"], options as never);
    } catch (error) {
      assert.fail(`recompile threw on ${name}: ${String(error)}`);
    }
    assert.equal(result.kind, "invalid_input", `${name}: expected invalid_input, got ${result.kind}`);
    if (result.kind !== "invalid_input") continue;
    assert.equal(result.operatorsTried.length, 0, `${name}: an input refusal must search nothing`);
    assert.equal(result.totalStatesExplored, 0, `${name}: an input refusal must explore no states`);
    assert.ok(
      result.errors.some((e) => e.kind === "invalid_options"),
      `${name}: expected an invalid_options issue, got ${JSON.stringify(result.errors)}`,
    );
    // The thrown read is named by the refusal, not swallowed into a generic
    // "not a positive integer": `optionField` maps it to `UNREADABLE_OPTIONS`
    // and `describeOptionValue` renders the "reading it threw" wording.
    if (name === "a container whose own getter throws") {
      assert.ok(
        result.errors.some((e) => e.kind === "invalid_options" && e.detail.includes("reading it threw")),
        `${name}: the refusal must name the thrown read, got ${JSON.stringify(result.errors)}`,
      );
    }
  }

  // The positive control: a well-formed container still runs, so the refusals
  // above are not "this gate refuses everything".
  const ok = recompile(puzzle, state, "A", ["scan"], { maxDepth: 2, maxCandidates: 8, maxStates: 5000, maxCounterfactualStates: 5000 });
  assert.notEqual(ok.kind, "invalid_input", `a well-formed options container was refused: ${JSON.stringify(ok)}`);
});

/**
 * `certify` shares the same accessor, so a container it cannot read reaches the
 * searches as an unusable bound instead of a throw. The certificate is then
 * unproven by construction -- the search never ran -- which is exactly what an
 * invalid numeric bound already produced. Only containers whose
 * `maxStates`/`maxCounterfactualStates` read fails belong here: a container
 * that merely carries a bad `maxDepth` leaves certify's own bounds readable,
 * so certify searches normally and may well prove the puzzle.
 */
test("terminal-capabilities-1e. `certify` answers an options container it cannot read -- null, a primitive, a BigInt, a revoked Proxy or a throwing getter -- with an unproven certificate", () => {
  const puzzle = demoPuzzle();
  const state = emptyState();
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const throwingGetter = {
    get maxStates() {
      throw new Error("no");
    },
  };

  const unreadable: { name: string; options: unknown }[] = [
    { name: "null", options: null },
    { name: "a number", options: 7 },
    { name: "a string", options: "maxStates: 2" },
    { name: "a BigInt state bound", options: { maxStates: 1n } },
    { name: "a revoked Proxy container", options: revocable.proxy },
    { name: "a container whose own getter throws", options: throwingGetter },
  ];

  for (const { name, options } of unreadable) {
    let certified;
    try {
      certified = certify(puzzle, state, options as never);
    } catch (error) {
      assert.fail(`certify threw on ${name}: ${String(error)}`);
    }
    assert.equal(isCertificate(certified), true, `certify must answer with a certificate for ${name}`);
    if (isCertificate(certified)) {
      assert.equal(certified.ok, false, `${name}: an unreadable container cannot certify the puzzle`);
      assert.equal(certified.solvable.proven, false, `${name}: a search that never ran proves nothing`);
    }
  }
});

/**
 * The same guard through the published entry point, which is where the deleted
 * `exported-input-totality-1c` asserted it: `api.ts` is what `package.json`'s
 * `exports` hands a host, so a caller who only ever imported the public surface
 * must not be able to reach the read-throw of a revoked `Proxy` or a throwing
 * getter by passing one as the OPTIONS argument.
 */
test("terminal-capabilities-1f. through the public api, a revoked Proxy or a throwing getter as the OPTIONS argument is refused, not passed on", () => {
  const puzzle = demoPuzzle();
  const state = emptyState();
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const throwingGetter = {
    get maxStates() {
      throw new Error("no");
    },
  };

  const unreadable: { name: string; options: unknown }[] = [
    { name: "a revoked Proxy", options: revocable.proxy },
    { name: "a throwing getter", options: throwingGetter },
  ];

  for (const { name, options } of unreadable) {
    let recompiled!: RecompileResult;
    assert.doesNotThrow(() => {
      recompiled = api.recompile(puzzle, state, "A", ["scan"], options as never);
    }, `api.recompile passed ${name}'s read-throw on to the caller`);
    assert.equal(recompiled.kind, "invalid_input", `${name}: api.recompile should refuse the unreadable container`);

    let certified!: CertifyResult;
    assert.doesNotThrow(() => {
      certified = api.certify(puzzle, state, options as never);
    }, `api.certify passed ${name}'s read-throw on to the caller`);
    assert.equal(isCertificate(certified), true, `${name}: api.certify should answer with a certificate`);
    if (isCertificate(certified)) {
      assert.equal(certified.ok, false, `${name}: an unreadable container cannot certify the puzzle`);
      assert.equal(certified.solvable.proven, false, `${name}: a search that never ran proves nothing`);
    }
  }
});

/**
 * Malformed and contradictory fixtures gathered in one table: bad shapes
 * (the malformed-input probes above) and bad histories (forged or
 * self-contradicting event logs). `recompile` is asked about every one of
 * them, under several different (role, capabilities) requests, so the
 * property under test is "answers with one of these four outcomes (not
 * operator_error)" -- not any particular outcome kind.
 */
function contradictoryFixtures(): { name: string; puzzle: unknown; state: unknown }[] {
  const good = demoPuzzle();
  const goodState = emptyState();

  const forgedBase = (extra: Puzzle["actions"][number]): Puzzle => ({
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
      },
      {
        id: "b_finish",
        performer: "B",
        needs: "voice",
        requiresTokens: ["b", "bridge"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  });
  const forgedNoop = forgedBase({
    id: "forged_noop",
    performer: "A",
    needs: "dpad",
    requiresTokens: ["never_available"],
    requiresFlags: [],
    producesTokens: [],
    setsFlags: [],
  });
  const { puzzle: termMismatchPuzzle, state: termMismatchState } = terminalCapabilityMismatchFixture();

  return [
    { name: "null puzzle", puzzle: null, state: goodState },
    { name: "undefined puzzle", puzzle: undefined, state: goodState },
    { name: "a string instead of a puzzle", puzzle: "not a puzzle", state: goodState },
    { name: "roles is null", puzzle: { id: "bad", roles: null, actions: [], goalFlags: ["goal"], primitives: [] }, state: goodState },
    {
      name: "requiresTokens is a number",
      puzzle: {
        id: "bad",
        roles: [good.roles[0]],
        actions: [{ ...good.actions[0], requiresTokens: 7 }],
        goalFlags: ["goal"],
        primitives: [],
      },
      state: goodState,
    },
    { name: "null state", puzzle: good, state: null },
    { name: "state flags is null", puzzle: good, state: { flags: null, tokens: [], history: [] } },
    { name: "state history is missing", puzzle: good, state: { flags: [], tokens: [] } },
    { name: "forged_noop: a completed action whose prerequisite was never known", puzzle: forgedNoop, state: { flags: [], tokens: [], history: historyFor(forgedNoop, ["forged_noop"]) } },
    { name: "terminal capability mismatch", puzzle: termMismatchPuzzle, state: termMismatchState },
    {
      name: "capability_change from does not match the replayed set",
      puzzle: { id: "bad-from", roles: [{ id: "C", capabilities: ["voice"], privateTokens: [] }], actions: [], goalFlags: ["goal"], primitives: [] },
      state: {
        flags: [],
        tokens: [],
        history: [
          { kind: "capability_change", role: "C", from: ["dpad"], to: ["scan"] },
          { kind: "capability_change", role: "C", from: ["dpad"], to: ["voice"] },
        ],
      },
    },
  ];
}

test("terminal-capabilities-1c. recompile answers every fixture in this malformed/contradictory table with one of these four outcomes (not operator_error)", () => {
  const requests: { role: string; capabilities: unknown[] }[] = [
    { role: "A", capabilities: ["scan"] },
    { role: "C", capabilities: ["dpad"] },
    { role: "nonexistent", capabilities: ["voice"] },
    { role: "A", capabilities: [] },
    { role: "A", capabilities: ["not-a-capability"] },
  ];

  let checked = 0;
  for (const { name, puzzle, state } of contradictoryFixtures()) {
    for (const request of requests) {
      checked++;
      let result: RecompileResult;
      try {
        result = recompile(puzzle as unknown as Puzzle, state as unknown as State, request.role, request.capabilities as never);
      } catch (error) {
        assert.fail(`recompile threw on "${name}" with role=${request.role}: ${String(error)}`);
      }
      assert.ok(
        result.kind === "invalid_input" || result.kind === "ok" || result.kind === "no_valid_recompile" || result.kind === "search_exhausted",
        `recompile returned an unrecognised outcome kind for "${name}"`,
      );
    }
  }
  assert.ok(checked > 0, "the probe did not actually check anything -- it would pass vacuously");
});

/* ------------------------------------------------------------------ */
/* no generated-input bypass; the namespace is verified                 */
/* ------------------------------------------------------------------ */

test("terminal-capabilities-2a. certifyGeneratedInternal does not exist on the certify module at all", () => {
  assert.equal(
    "certifyGeneratedInternal" in certifyModule,
    false,
    "the generated-input certification path must be deleted, not merely unexported",
  );
});

test("terminal-capabilities-2b. package.json exposes only the public entry and its own manifest", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    exports?: Record<string, unknown>;
  };
  assert.ok(pkg.exports, "package.json must declare an exports map");
  const subpaths = Object.keys(pkg.exports!).sort();
  assert.deepEqual(subpaths, [".", "./package.json"].sort(), `unexpected exposed subpaths: ${subpaths.join(", ")}`);
});

/**
 * A genuine 9-way choice split under `scan.paged` (`maxOptions: 4`): two
 * chained 3-way steps, `3 * 3 = 9`, exactly what `convertAction` builds for
 * that combination. `convertAction` only ever splits an action whose
 * `options` exceeds what the target primitive can present in one step, so a
 * no-choice chain (`options` omitted on both steps) is never something it
 * produces, and the round-trip check (correctly) refuses that shape.
 */
function unsplitGate(): Puzzle {
  return {
    id: "ns-probe",
    roles: [{ id: "C", capabilities: ["scan"], privateTokens: ["answer"] }],
    actions: [
      {
        id: "§gate__step1",
        performer: "C",
        needs: "scan",
        requiresTokens: ["answer"],
        requiresFlags: [],
        producesTokens: ["§gate__progress1"],
        setsFlags: [],
        options: 3,
        answerToken: "answer",
        label: "gate (step 1 of 2, 3 options)",
      },
      {
        id: "§gate__step2",
        performer: "C",
        needs: "scan",
        requiresTokens: ["§gate__progress1", "answer"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
        options: 3,
        answerToken: "answer",
        label: "gate (step 2 of 2, 3 options)",
      },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
}

test("terminal-capabilities-2c. a well-formed generated split chain is legal input to the one public certify, with no special mode", () => {
  const puzzle = unsplitGate();
  assert.equal(validatePuzzle(puzzle).ok, true, "a correctly wired split chain must be legal input");
  const result = certify(puzzle, emptyState());
  assert.ok(isCertificate(result), `expected a certificate, got a refusal: ${isCertificate(result) ? "" : explainFailure(result)}`);
  if (isCertificate(result)) assert.equal(result.ok, true, explainFailure(result));
});

test("terminal-capabilities-2d. the split-chain origId existing un-split alongside its own split is refused", () => {
  const split = unsplitGate();
  const puzzle: Puzzle = {
    ...split,
    actions: [
      { id: "gate", performer: "C", needs: "scan", requiresTokens: [], requiresFlags: [], producesTokens: [], setsFlags: ["goal"] },
      ...split.actions,
    ],
  };
  const result = validatePuzzle(puzzle);
  assert.equal(result.ok, false, "an origId present both split and un-split must be refused");
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.kind === "reserved_id"));
});

test("terminal-capabilities-2e. a broken chain -- missing step, or a step wired to the wrong progress token -- is refused", () => {
  const missingStep: Puzzle = {
    ...unsplitGate(),
    actions: [
      { id: "§gate__step1", performer: "C", needs: "scan", requiresTokens: [], requiresFlags: [], producesTokens: ["§gate__progress1"], setsFlags: [] },
      { id: "§gate__step3", performer: "C", needs: "scan", requiresTokens: ["§gate__progress2"], requiresFlags: [], producesTokens: [], setsFlags: ["goal"] },
    ],
  };
  assert.equal(validatePuzzle(missingStep).ok, false, "a non-consecutive step chain must be refused");

  const skippableStep: Puzzle = {
    ...unsplitGate(),
    actions: [
      { id: "§gate__step1", performer: "C", needs: "scan", requiresTokens: [], requiresFlags: [], producesTokens: ["§gate__progress1"], setsFlags: [] },
      // step2 does not require the progress token: it could fire without step1 ever happening.
      { id: "§gate__step2", performer: "C", needs: "scan", requiresTokens: [], requiresFlags: [], producesTokens: [], setsFlags: ["goal"] },
    ],
  };
  assert.equal(validatePuzzle(skippableStep).ok, false, "a step that does not require its predecessor's progress token must be refused");

  const leakedToken: Puzzle = {
    ...unsplitGate(),
    actions: [
      ...unsplitGate().actions,
      { id: "sneaky", performer: "C", needs: "scan", requiresTokens: ["§gate__progress1"], requiresFlags: [], producesTokens: [], setsFlags: [] },
    ],
  };
  assert.equal(validatePuzzle(leakedToken).ok, false, "a progress token consumed by more than its one chain successor must be refused");
});

test("terminal-capabilities-2g. a lone one-step 'chain' is refused: the generator never splits into fewer than two steps", () => {
  const puzzle: Puzzle = {
    id: "ns-probe",
    roles: [{ id: "C", capabilities: ["scan"], privateTokens: [] }],
    actions: [
      { id: "§lonely__step1", performer: "C", needs: "scan", requiresTokens: [], requiresFlags: [], producesTokens: [], setsFlags: ["goal"] },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
  const result = validatePuzzle(puzzle);
  assert.equal(result.ok, false, "a single-step split chain does not match the generator's own shape");
});

test("terminal-capabilities-2h. cross-chain progress-token leakage -- one chain's step consuming another chain's progress token -- is refused", () => {
  const puzzle: Puzzle = {
    id: "ns-probe",
    roles: [{ id: "C", capabilities: ["scan"], privateTokens: [] }],
    actions: [
      { id: "§a__step1", performer: "C", needs: "scan", requiresTokens: [], requiresFlags: [], producesTokens: ["§a__progress1"], setsFlags: [] },
      { id: "§a__step2", performer: "C", needs: "scan", requiresTokens: ["§a__progress1"], requiresFlags: [], producesTokens: [], setsFlags: [] },
      { id: "§b__step1", performer: "C", needs: "scan", requiresTokens: [], requiresFlags: [], producesTokens: [], setsFlags: [] },
      { id: "§b__step2", performer: "C", needs: "scan", requiresTokens: ["§a__progress1"], requiresFlags: [], producesTokens: [], setsFlags: ["goal"] },
    ],
    goalFlags: ["goal"],
    primitives: standardPrimitives(),
  };
  const result = validatePuzzle(puzzle);
  assert.equal(result.ok, false, "chain b must not be able to consume chain a's progress token");
});

test("terminal-capabilities-2f. an author id in the reserved namespace that is not a generated split-chain step is refused, whoever calls it", () => {
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
  const state = emptyState();

  // Every function on the certify module -- the only module that could ever
  // produce a certificate -- must refuse this, whether by a typed refusal or a
  // thrown error.
  const surface = certifyModule as unknown as Record<string, unknown>;
  let calledSomething = false;
  for (const [name, value] of Object.entries(surface)) {
    if (typeof value !== "function") continue;
    calledSomething = true;
    let result: unknown;
    try {
      result = (value as (...args: unknown[]) => unknown)(puzzle, state);
    } catch {
      continue;
    }
    if (result && typeof result === "object" && (result as { hash?: unknown }).hash !== undefined) {
      assert.notEqual((result as { ok?: unknown }).ok, true, `"${name}" produced an ok certificate for the §-namespace fixture`);
    }
  }
  assert.ok(calledSomething, "the probe did not actually call anything -- it would pass vacuously");
});

/* ------------------------------------------------------------------ */
/* a repaired puzzle survives a second recompile                        */
/* ------------------------------------------------------------------ */

test("terminal-capabilities-3. the demo's C dpad->scan repair is itself valid input to a second recompile (B voice->dpad)", () => {
  const puzzle = demoPuzzle();
  const start = emptyState();

  const first = recompile(puzzle, start, "C", ["scan"]);
  assert.equal(first.kind, "ok", first.kind === "ok" ? "" : JSON.stringify(first));
  if (first.kind !== "ok") return;
  assert.equal(first.certificate.ok, true, explainFailure(first.certificate));

  // The repaired puzzle -- generated §-ids and all -- is ordinary input: no
  // special mode is needed to feed it back into `recompile`.
  const second = recompile(first.puzzle, first.state, "B", ["dpad"]);
  assert.equal(second.kind, "ok", `expected a second ok, got ${second.kind}: ${JSON.stringify(second)}`);
  if (second.kind !== "ok") return;
  assert.equal(second.certificate.ok, true, explainFailure(second.certificate));

  // History is prefix-preserved across BOTH changes.
  const a = normalizeState(start);
  const b = normalizeState(first.state);
  const c = normalizeState(second.state);
  assert.ok(b.history.length >= a.history.length);
  assert.deepEqual(b.history.slice(0, a.history.length), a.history);
  assert.ok(c.history.length >= b.history.length);
  assert.deepEqual(c.history.slice(0, b.history.length), b.history);

  // And the second repaired puzzle is, again, valid input to `certify`: it
  // comes back a certificate, not a refusal.
  assert.equal(isCertificate(certify(second.puzzle, second.state)), true);
});

/* ------------------------------------------------------------------ */
/* required fields are required                                        */
/* ------------------------------------------------------------------ */

function minimalRole(): Puzzle["roles"][number] {
  return { id: "A", capabilities: ["dpad"], privateTokens: [] };
}

test("terminal-capabilities-4. a missing requiresTokens/requiresFlags/producesTokens/setsFlags is refused, not defaulted to []", () => {
  const fields = ["requiresTokens", "requiresFlags", "producesTokens", "setsFlags"] as const;
  for (const field of fields) {
    const action: Record<string, unknown> = {
      id: "finish",
      performer: "A",
      needs: "dpad",
      requiresTokens: [],
      requiresFlags: [],
      producesTokens: [],
      setsFlags: ["goal"],
    };
    delete action[field];
    const puzzle = { id: "bad", roles: [minimalRole()], actions: [action], goalFlags: ["goal"], primitives: [] };
    const result = validatePuzzle(puzzle as unknown as Puzzle);
    assert.equal(result.ok, false, `a missing "${field}" must be refused, not silently treated as []`);
    if (result.ok) continue;
    assert.ok(
      result.errors.some((e) => e.detail.includes(field)),
      `expected an issue naming "${field}", got ${JSON.stringify(result.errors)}`,
    );

    let threw = false;
    try {
      certify(puzzle as unknown as Puzzle, emptyState());
    } catch {
      threw = true;
    }
    assert.equal(threw, false, `certify must not throw on a puzzle missing "${field}"`);
  }
});

test("terminal-capabilities-4b. a missing privateTokens on a role is refused, not defaulted to []", () => {
  const role: Record<string, unknown> = { id: "A", capabilities: ["dpad"] };
  const puzzle = { id: "bad", roles: [role], actions: [], goalFlags: ["goal"], primitives: [] };
  const result = validatePuzzle(puzzle as unknown as Puzzle);
  assert.equal(result.ok, false, "a role missing privateTokens must be refused");
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.detail.includes("privateTokens")));

  let threw = false;
  try {
    certify(puzzle as unknown as Puzzle, emptyState());
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "certify must not throw on a role missing privateTokens");
});

/* ------------------------------------------------------------------ */
/* recompile's own numeric options are validated                        */
/* ------------------------------------------------------------------ */

test("terminal-capabilities-5a. maxStates: NaN is invalid_input, never no_valid_recompile, and nothing is searched", () => {
  const puzzle = demoPuzzle();
  const result = recompile(puzzle, emptyState(), "C", ["scan"], { maxStates: Number.NaN });
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
  if (result.kind !== "invalid_input") return;
  assert.equal(result.operatorsTried.length, 0, "an invalid option must stop before any candidate is certified");
  assert.equal(result.totalStatesExplored, 0);
  assert.ok(result.errors.some((e) => e.kind === "invalid_options"));
});

test("terminal-capabilities-5b. maxDepth: 1, maxCandidates: NaN does not silently disable the candidate cap", () => {
  const puzzle = demoPuzzle();
  const result = recompile(puzzle, emptyState(), "C", ["scan"], { maxDepth: 1, maxCandidates: Number.NaN });
  assert.equal(result.kind, "invalid_input", `got ${result.kind}: ${JSON.stringify(result)}`);
  if (result.kind !== "invalid_input") return;
  assert.equal(result.operatorsTried.length, 0, "certified >= NaN must never read as \"cap disabled\"");
});

test("terminal-capabilities-5c. maxCounterfactualStates and non-integer/negative/zero/Infinity bounds are all refused the same way", () => {
  const puzzle = demoPuzzle();
  const badOptions: Record<string, unknown>[] = [
    { maxCounterfactualStates: Number.NaN },
    { maxDepth: Number.POSITIVE_INFINITY },
    { maxDepth: "5" },
    { maxDepth: 0 },
    { maxCandidates: 0 },
    { maxStates: -1 },
    { maxCounterfactualStates: 1.5 },
  ];
  for (const options of badOptions) {
    let result: RecompileResult;
    try {
      result = recompile(puzzle, emptyState(), "C", ["scan"], options as never);
    } catch (error) {
      assert.fail(`recompile threw on ${JSON.stringify(options)}: ${String(error)}`);
    }
    assert.equal(result.kind, "invalid_input", `${JSON.stringify(options)} got ${result.kind}`);
  }
});

test("terminal-capabilities-5d. well-formed options still run the search normally", () => {
  const puzzle = demoPuzzle();
  const result = recompile(puzzle, emptyState(), "C", ["scan"], { maxDepth: 5, maxCandidates: 200, maxStates: 10_000 });
  assert.equal(result.kind, "ok", result.kind === "ok" ? "" : JSON.stringify(result));
});
