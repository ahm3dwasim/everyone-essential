/**
 * Two functions' OWN documentation, held by a test: what each says it does with
 * an argument it cannot read.
 *
 * This file used to hold a sentence in `README.md` that enumerated which calls
 * refuse and which throw, and every guard below derived from that sentence. The
 * sentence is gone, because three attempts to state the enumeration were each
 * wrong about a call, and the library now makes no claim about malformed input
 * as a whole. What is left is the part the source documents about itself, quoted
 * here from the two doc comments that speak about a malformed argument:
 *
 *   `src/validate.ts` (module comment)
 *     "`validatePuzzle` answers a malformed *shape* with a typed error: a value
 *      that is not an object, or an object with a missing or mistyped field,
 *      comes back as `ok: false` ... an object whose property reads throw (a
 *      revoked `Proxy`, a throwing getter) passes that throw on to the caller."
 *
 *   `src/certify.ts` (`certify`)
 *     "a value that is not an object, or an object with a missing or mistyped
 *      field, comes back as a typed error rather than a certificate ... An
 *      object whose property reads throw (a revoked `Proxy`, a throwing getter)
 *      passes that throw on."
 *
 * Each guard asserts one of those statements and nothing further. A position or
 * a value shape neither statement names is OUT of scope: no guard here claims a
 * call is total over runtime input, and none is a completeness claim about the
 * exports, the positions or the shapes. `certify`'s state position is not probed
 * by the non-object table below -- its doc comment is about the puzzle argument.
 * A revoked `Proxy` IS probed, at both functions' first position, because both
 * comments now name that case explicitly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as api from "../src/api";

/* ------------------------------------------------------------------ */
/* The probe table                                                     */
/* ------------------------------------------------------------------ */

type Call = (...args: unknown[]) => unknown;
type Record_ = Record<string, unknown>;

const surface = api as unknown as Record<string, Call>;

const puzzle = api.demoPuzzle();
const state = api.emptyState();

/**
 * The value shape both quoted statements speak about first: a value that is not
 * an object. A revoked `Proxy` is deliberately absent from THIS table -- it is
 * an object whose reads throw, which the quoted statements name separately, and
 * `exported-input-refusal-2` below pins that separate case.
 */
function nonObjectValues(): ReadonlyArray<readonly [string, unknown]> {
  return [
    ["null", null],
    ["a number", 42],
    ["a string", "x"],
    ["a Symbol", Symbol("s")],
  ];
}

/**
 * One argument position per function, each named by that function's own doc
 * comment (quoted above): the puzzle `certify` refuses before it certifies
 * anything, and the puzzle `validatePuzzle` answers with a typed error.
 * `refused` is read off the call's own public result shape, so a call that
 * silently started answering something else would be red here rather than
 * passing on "it returned an object".
 */
const REFUSALS: ReadonlyArray<{
  name: string;
  position: number;
  refused: (result: Record_) => boolean;
}> = [
  { name: "certify", position: 0, refused: (r) => !api.isCertificate(r as unknown as api.CertifyResult) },
  { name: "validatePuzzle", position: 0, refused: (r) => r.ok === false },
];

/** One well-formed argument list per function, so the probe has a baseline to substitute into. */
const BASE: Record<string, readonly unknown[]> = {
  certify: [puzzle, state],
  validatePuzzle: [puzzle],
};

function callWith(name: string, position: number, value: unknown): unknown {
  const fn = surface[name];
  if (!fn) throw new Error(`"${name}" is not a function export of api.ts`);
  const base = BASE[name];
  if (!base) throw new Error(`no probe baseline for "${name}"`);
  const args = [...base];
  args[position] = value;
  return fn(...args);
}

function keyOf(name: string, position: number): string {
  return `${name}@${position}`;
}

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

test("exported-input-refusal-1: each documented call answers a non-object argument with its own typed refusal", () => {
  for (const { name, position, refused } of REFUSALS) {
    for (const [label, value] of nonObjectValues()) {
      let result: unknown;
      assert.doesNotThrow(() => {
        result = callWith(name, position, value);
      }, `${keyOf(name, position)} threw on ${label} instead of answering the typed refusal its doc comment documents`);
      assert.ok(
        refused(result as Record_),
        `${keyOf(name, position)} did not answer its documented refusal for ${label}; got ${JSON.stringify(result)?.slice(0, 160)}`,
      );
    }
  }
});

test("exported-input-refusal-2: a revoked Proxy is an object whose reads throw, so validatePuzzle and certify pass that throw on", () => {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const proxy = revocable.proxy;

  const calls: ReadonlyArray<readonly [string, () => unknown]> = [
    ["validatePuzzle", () => callWith("validatePuzzle", 0, proxy)],
    ["certify", () => callWith("certify", 0, proxy)],
  ];

  for (const [name, call] of calls) {
    let thrown: unknown = undefined;
    try {
      call();
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      thrown instanceof TypeError,
      `${name} must pass the revoked Proxy's read-throw on, as both doc comments say; it ${thrown === undefined ? "returned a value instead" : `threw ${String(thrown)}`}`,
    );
  }
});
