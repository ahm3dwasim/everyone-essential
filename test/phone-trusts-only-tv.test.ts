/**
 * A phone accepts a game message only from the room's TV.
 *
 * `client.ts`'s `onGame` hands the phone the relay-stamped `from` alongside
 * every payload -- the one thing a phone cannot forge about itself, because
 * the relay overwrites whatever a frame claims (`relay.ts`'s `route`). Before
 * this, `app.tsx`'s `onGame` handler read the payload's own `t` and acted on
 * it without ever looking at who sent it, so a peer that had merely joined as
 * a phone could address another phone directly with `{ t: "superseded" }` and
 * close it, or forge `assigned`/`view`/`switch` the same way.
 *
 * `isFromRoomTv` is the gate the handler now runs first. It is a pure
 * function of the stamped `from` and this phone's own record of which
 * connection the relay told it holds the TV (`welcome.peers`, kept in step by
 * `peer_joined`/`peer_left`) -- proving it here proves the handler's
 * behaviour without standing up a socket.
 */
import { describe, expect, it } from "vitest";
import { isFromRoomTv } from "../app/phone/src/app.tsx";

describe("a phone accepts a game message only from the room's TV", () => {
  it("accepts a message stamped from the known TV peer", () => {
    expect(isFromRoomTv("tv-1", "tv-1")).toBe(true);
  });

  it("ignores a message stamped from any other peer -- an attacker phone forging assigned/view/switch/superseded", () => {
    expect(isFromRoomTv("attacker-phone", "tv-1")).toBe(false);
  });

  it("ignores everything before this phone has learned who the TV is", () => {
    expect(isFromRoomTv("tv-1", null)).toBe(false);
  });

  it("ignores a relay-less message (from === null) even if a TV peer is known", () => {
    expect(isFromRoomTv(null, "tv-1")).toBe(false);
  });
});
