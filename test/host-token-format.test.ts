/**
 * The host credential is the relay's own mint, and it is also a string a
 * client puts on the wire in a `hello`. Those two facts have to meet at
 * exactly one place: the decoder.
 *
 * It is not a secret a phone ever holds -- the relay puts it in the TV's own
 * `welcome` and nowhere else -- but its shape still matters, because it is
 * the one field a connection presents as a claim about who it is. So the wire
 * accepts exactly what the relay mints (32 random bytes as lowercase hex) and
 * drops everything else, and the relay is then left refusing a hello that
 * carries nothing at all. Fail-closed, and never a comparison against input
 * of a length an attacker chose.
 */
import { describe, expect, it } from "vitest";
import { HOST_TOKEN_PATTERN, decodeClientMessage, isHostToken } from "../app/shared/protocol.ts";
import { mintHostToken } from "../app/relay/src/relay.ts";

/** One real credential, from the same mint the relay uses. */
const GOOD = mintHostToken();

/** What a client would have to send, plus the near misses. */
const NOT_A_CREDENTIAL: readonly [string, unknown][] = [
  ["uppercase hex, which the mint never produces", GOOD.toUpperCase()],
  ["one character short", GOOD.slice(0, 63)],
  ["one character too long", `${GOOD}a`],
  ["an empty string", ""],
  ["a plausible-looking but wrong alphabet", "g".repeat(64)],
  ["a number", 7],
  ["an object whose toString is a credential", { toString: () => GOOD }],
  ["an array holding a credential", [GOOD]],
];

describe("a room's host credential is only ever the shape the relay mints", () => {
  it("mints 32 random bytes as lowercase hex, and never the same one twice", () => {
    const mints = new Set(Array.from({ length: 64 }, () => mintHostToken()));
    expect(mints.size).toBe(64);
    for (const token of mints) {
      expect(token).toMatch(HOST_TOKEN_PATTERN);
      expect(isHostToken(token)).toBe(true);
    }
  });

  it("carries a credential through a hello", () => {
    const decoded = decodeClientMessage(
      JSON.stringify({ t: "hello", kind: "tv", room: "ABCD", hostToken: GOOD }),
    );
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.message.t === "hello" && decoded.message.hostToken).toBe(GOOD);
  });

  it("keeps a hello with no credential at all, which is every phone and every new TV", () => {
    const decoded = decodeClientMessage(JSON.stringify({ t: "hello", kind: "tv" }));
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.message.t === "hello" && decoded.message.hostToken).toBeUndefined();
  });

  for (const [what, hostToken] of NOT_A_CREDENTIAL) {
    it(`drops ${what}, so the relay refuses the hello rather than comparing it`, () => {
      expect(isHostToken(hostToken)).toBe(false);
      const decoded = decodeClientMessage(
        JSON.stringify({ t: "hello", kind: "tv", room: "ABCD", hostToken }),
      );
      expect(decoded.ok).toBe(true);
      expect(decoded.ok && decoded.message.t === "hello" && decoded.message.hostToken).toBeUndefined();
    });
  }
});
