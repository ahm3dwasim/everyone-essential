/**
 * The APK's relay is a Kotlin port of the TypeScript protocol, and nothing
 * makes the two agree on its own: the TS `Intent` union and the port's
 * `decodeIntent` are two independent sources of truth for which intent kinds
 * are known. A kind the TS decoder accepts but the Kotlin decoder refuses as
 * "unknown intent" means a phone on the Fire TV Stick cannot dismiss its own
 * switch or reclaim a dropped seat, even though every desktop test -- which
 * runs the TS relay -- passes.
 *
 * This reads both sources and fails when an intent kind the TS decoder accepts
 * has no branch in the Kotlin decoder. It checks presence, not behaviour: the
 * behaviour of each branch is `ProtocolTest.kt`'s job.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TS = read("../app/shared/protocol.ts");
const KT = read("../app/android/app/src/main/java/com/everyoneisessential/tv/protocol/Protocol.kt");

/** The body of a function, from its signature to the next top-level declaration. */
function body(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`not found: ${signature}`);
  const rest = src.slice(start + signature.length);
  const end = rest.search(/\n(export |fun |private fun |function )/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the TS protocol and the APK's Kotlin port accept the same intents", () => {
  const tsKinds = [...body(TS, "export function decodeIntent").matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]!);
  const ktKinds = [...body(KT, "fun decodeIntent").matchAll(/^\s*"([a-z_]+)" ->/gm)].map((m) => m[1]!);

  it("found the decoders it is comparing", () => {
    // Without this, a renamed function makes both lists empty and the next test passes.
    expect(tsKinds.length).toBeGreaterThanOrEqual(4);
    expect(ktKinds.length).toBeGreaterThanOrEqual(4);
  });

  it("every intent the TS relay accepts, the Stick's relay accepts too", () => {
    const missing = tsKinds.filter((k) => !ktKinds.includes(k));
    expect(missing, `intents the APK relay refuses as unknown: ${missing.join(", ")}`).toEqual([]);
  });

  it("the Stick's relay accepts nothing the TS relay would refuse", () => {
    const extra = ktKinds.filter((k) => !tsKinds.includes(k));
    expect(extra, `intents only the Kotlin port accepts: ${extra.join(", ")}`).toEqual([]);
  });
});

/**
 * The other direction: the TV-to-phone `GameMessage` union. A kind the TS
 * `decodeGameMessage` accepts but the Kotlin port refuses as unknown means a
 * phone on the Fire TV Stick never receives that message at all -- exactly
 * the gap `superseded` would have opened if only the TS side had been
 * updated for it.
 */
describe("the TS protocol and the APK's Kotlin port accept the same game messages", () => {
  const tsKinds = [...body(TS, "export function decodeGameMessage").matchAll(/case "([a-z]+)"/g)].map(
    (m) => m[1]!,
  );
  const ktKinds = [...body(KT, "fun decodeGameMessage").matchAll(/^\s*"([a-z]+)" ->/gm)].map((m) => m[1]!);

  it("found the decoders it is comparing", () => {
    expect(tsKinds.length).toBeGreaterThanOrEqual(4);
    expect(ktKinds.length).toBeGreaterThanOrEqual(4);
  });

  it("every game message the TS relay accepts, the Stick's relay accepts too", () => {
    const missing = tsKinds.filter((k) => !ktKinds.includes(k));
    expect(missing, `game messages the APK relay refuses as unknown: ${missing.join(", ")}`).toEqual([]);
  });

  it("the Stick's relay accepts nothing the TS relay would refuse", () => {
    const extra = ktKinds.filter((k) => !tsKinds.includes(k));
    expect(extra, `game messages only the Kotlin port accepts: ${extra.join(", ")}`).toEqual([]);
  });
});

/**
 * The same risk, one level down. The Kotlin relay does not forward a phone
 * view: it rebuilds it from the fields it knows and drops the rest. If the TS
 * `PhoneView` gains a field the port's rebuild does not carry -- `heldRoles`,
 * which the reclaim offer depends on, is the concrete case -- a returning
 * phone on the Stick would never learn its seat was held, and neither the
 * intent check above nor any desktop run would catch it.
 */
describe("the TS protocol and the Kotlin port carry the same phone-view fields", () => {
  const tsView = body(TS, "function decodePhoneView");
  const viewBlock = tsView.slice(tsView.indexOf("view: {"));
  const tsFields = [
    ...new Set(
      [...viewBlock.matchAll(/^\s{6}(?:\.\.\.\(typeof value\.)?([a-zA-Z]+)\b/gm)].map((m) => m[1]!),
    ),
  ].filter((f) => f !== "view");
  const ktView = body(KT, "private fun decodePhoneView");
  const ktFields = [...new Set([...ktView.matchAll(/put\("([a-zA-Z]+)"/g)].map((m) => m[1]!))];

  it("found the fields it is comparing", () => {
    expect(tsFields.length).toBeGreaterThanOrEqual(8);
    expect(ktFields.length).toBeGreaterThanOrEqual(8);
  });

  it("every field the TS relay keeps in a phone view, the Stick's relay keeps too", () => {
    const missing = tsFields.filter((f) => !ktFields.includes(f));
    expect(missing, `phone-view fields the APK relay strips: ${missing.join(", ")}`).toEqual([]);
  });
});

/**
 * And the handshake itself. Both relays read a client's first frame field by
 * field, and a field one of them reads and the other drops is a client that
 * works on a laptop and not on the Stick. The host credential is exactly that
 * shape of change: a TV coming back to its room presents the room and the
 * credential it was given, so both decoders have to carry it -- one of them
 * dropping it means that TV is refused as a stranger by one of the two
 * relays, with no desktop run to catch it.
 */
describe("the TS protocol and the APK's Kotlin port read the same hello fields", () => {
  const between = (src: string, from: string, to: string): string => {
    const start = src.indexOf(from);
    if (start < 0) throw new Error(`not found: ${from}`);
    const end = src.indexOf(to, start + from.length);
    if (end < 0) throw new Error(`not found: ${to}`);
    return src.slice(start, end);
  };
  // `t` chooses the branch, and only one side reads it inside its own slice;
  // it is not a field either decoder carries into the message.
  const fields = (src: string, pattern: RegExp): string[] =>
    [...new Set([...src.matchAll(pattern)].map((m) => m[1]!))].filter((f) => f !== "t").sort();

  const tsHello = between(TS, 'if (parsed.t === "hello")', 'if (parsed.t === "relay")');
  const ktHello = between(KT, '"hello" -> {', '"relay" -> {');
  const tsFields = fields(tsHello, /parsed\.([a-zA-Z]+)/g);
  const ktFields = fields(ktHello, /parsed\.opt\("([a-zA-Z]+)"\)/g);

  it("found the decoders it is comparing", () => {
    // Without this, a renamed function makes both lists empty and the next test passes.
    expect(tsFields.length).toBeGreaterThanOrEqual(4);
    expect(ktFields.length).toBeGreaterThanOrEqual(4);
  });

  it("carries the room's host credential in both, or neither", () => {
    expect(tsFields).toContain("hostToken");
    expect(ktFields).toContain("hostToken");
  });

  it("reads the same fields off a hello on both sides", () => {
    expect(ktFields, `hello fields the APK relay does not read: ${tsFields.filter((f) => !ktFields.includes(f)).join(", ")}`)
      .toEqual(tsFields);
  });
});
