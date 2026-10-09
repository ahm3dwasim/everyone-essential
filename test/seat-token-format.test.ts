/**
 * A seat token is a credential the phone mints, and it is also a string that
 * travels on the wire -- where a phone can put anything it likes. Those two
 * facts have to meet at exactly one place: the decoder. The shape the phone
 * mints is 16 random bytes as lowercase hex (`mintSeatId`), and the wire
 * accepts that shape and nothing else.
 *
 * The reason it has to be exact rather than merely sanitised: a seat token is
 * copied into the fingerprint of a reclaim request, and that fingerprint
 * becomes a focus id on the TV. A token containing a quote or a bracket used
 * to travel all the way into a selector built out of it.
 */
import { describe, expect, it } from "vitest";
import {
  decodeClientMessage,
  decodeGameMessage,
  isSeatToken,
} from "../app/shared/protocol.ts";
import { mintSeatId } from "../app/phone/src/seat.ts";
import { findFocusTarget } from "../app/tv/src/remote.ts";

/** One real token, from the same mint the phone uses. */
const GOOD = mintSeatId();

/** What a phone would have to send to reach a selector, plus the near misses. */
const HOSTILE: readonly [string, string][] = [
  ["a bracket that closes an attribute selector", `${"a".repeat(31)}"]`],
  ["a double quote", `${"a".repeat(31)}"`],
  ["a backslash", `${"a".repeat(31)}\\`],
  ["a newline", `${"a".repeat(31)}\n`],
  ["a selector for everything", "*"],
  ["uppercase hex, which the mint never produces", GOOD.toUpperCase()],
  ["one character short", GOOD.slice(0, 31)],
  ["one character too long", `${GOOD}a`],
  ["an empty string", ""],
  ["a plausible-looking but wrong alphabet", "g".repeat(32)],
];
const HUGE = "a".repeat(10_240);

describe("the wire carries a seat token only in the shape the phone mints", () => {
  it("accepts the token the phone's own mint produces", () => {
    expect(mintSeatId()).toMatch(/^[0-9a-f]{32}$/);
    expect(isSeatToken(GOOD)).toBe(true);
    const decoded = decodeGameMessage({ t: "join", seat: GOOD });
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.message.t === "join" && decoded.message.seat).toBe(GOOD);
  });

  it("keeps a join with no seat at all, which is every new phone", () => {
    const decoded = decodeGameMessage({ t: "join", name: "Ada", want: "A" });
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.message.t === "join" && decoded.message.seat).toBeUndefined();
  });

  for (const [what, seat] of HOSTILE) {
    it(`refuses a join carrying ${what}`, () => {
      const decoded = decodeGameMessage({ t: "join", seat });
      expect(decoded.ok).toBe(false);
      // Refused at the door: nothing downstream is handed a half-parsed join.
      expect(decoded.ok === false && decoded.reason).toBe("join.seat");
    });
  }

  it("refuses a join carrying ten kilobytes of token", () => {
    const decoded = decodeGameMessage({ t: "join", seat: HUGE });
    expect(decoded.ok).toBe(false);
    expect(decoded.ok === false && decoded.reason).toBe("join.seat");
  });

  it("refuses a seat that is not a string at all", () => {
    for (const seat of [7, null, true, {}, [GOOD], { toString: () => GOOD }]) {
      expect(decodeGameMessage({ t: "join", seat }).ok).toBe(false);
    }
  });

  it("still takes a name and a want off the same message it refuses a seat from", () => {
    // The refusal is about the seat, not the phone: it is not a way to smuggle
    // a message past the other fields' own bounds.
    expect(decodeGameMessage({ t: "join", name: "x".repeat(50) }).ok).toBe(true);
    expect(decodeGameMessage({ t: "join", want: "Q" }).ok).toBe(true);
  });

  it("is refused by the relay too, so the envelope never reaches the TV at all", () => {
    // A phone addresses the TV through the relay's envelope. The envelope is
    // decoded before routing, so a refused join is answered with an error and
    // dropped -- there is no path by which it arrives at the TV.
    for (const seat of [HOSTILE[0]![1], HOSTILE[1]![1], HUGE]) {
      const raw = JSON.stringify({ t: "relay", to: "tv", payload: { t: "join", seat } });
      const decoded = decodeClientMessage(raw);
      expect(decoded.ok).toBe(false);
      expect(decoded.ok === false && decoded.reason).toContain("join.seat");
    }
    expect(
      decodeClientMessage(JSON.stringify({ t: "relay", to: "tv", payload: { t: "join", seat: GOOD } }))
        .ok,
    ).toBe(true);
  });
});

/**
 * The second half of the same property, and the one that holds even if a
 * token of an unexpected shape reaches the TV by some other route: the focus
 * lookup never builds a selector out of an id. It reads the ids already in the
 * DOM and compares them as strings, so there is no string that can be an id
 * and also be syntax.
 */
describe("the focus lookup compares ids, and never builds a selector from one", () => {
  type StubNode = { dataset: { focusId?: string } };
  function rootOf(ids: readonly string[]) {
    const nodes: StubNode[] = ids.map((id) => ({ dataset: { focusId: id } }));
    const seen: string[] = [];
    const root = {
      querySelectorAll: (selector: string) => {
        seen.push(selector);
        return nodes;
      },
    };
    return { root: root as unknown as ParentNode, seen };
  }

  it("finds the node whose own id matches, and no other", () => {
    const { root, seen } = rootOf(["stay", "leave", "opt:0"]);
    expect(findFocusTarget("leave", root)?.dataset.focusId).toBe("leave");
    expect(seen).toEqual(["[data-focus-id]"]);
  });

  it("returns null rather than throwing when nothing carries that id", () => {
    const { root } = rootOf(["stay"]);
    expect(findFocusTarget("no-such-target", root)).toBeNull();
  });

  it("asks the DOM for ids by attribute, whatever the id is spelled like", () => {
    const nasty = `${"a".repeat(31)}"]`;
    const { root, seen } = rootOf(["stay", nasty]);
    expect(findFocusTarget(nasty, root)?.dataset.focusId).toBe(nasty);
    // Whatever the id, the only selector ever handed to the DOM is the plain
    // attribute one.
    expect(seen).toEqual(["[data-focus-id]"]);
    for (const id of ['"', "\\", "\n", "*", "]", HUGE]) {
      expect(() => findFocusTarget(id, root)).not.toThrow();
      expect(seen.every((selector) => selector === "[data-focus-id]")).toBe(true);
    }
  });

  it("ignores a node with no id of its own", () => {
    const nodes = [{ dataset: {} }, { dataset: { focusId: "stay" } }];
    const root = {
      querySelectorAll: () => nodes,
    } as unknown as ParentNode;
    expect(findFocusTarget("stay", root)?.dataset.focusId).toBe("stay");
    expect(findFocusTarget("", root)).toBeNull();
  });
});
