/**
 * A phone that is already in the room does not leave it because the TV did.
 *
 * While a room has no TV, everything a phone sends to the TV comes back as
 * `no_tv_yet` ("no TV in this room yet") -- including the `join` a phone sends
 * the moment it is welcomed back, so a short Wi-Fi blip that takes the phones
 * down before the TV would otherwise push every one of them out to the join
 * screen and make them ask again by hand. The relay facts behind that are
 * pinned in `test/relay-tv-gap.test.ts`; this file pins what the phone does
 * with them.
 *
 * The other half is the refusal that looks like it and is not. A relay that
 * has restarted has forgotten the room entirely, and answers the same
 * reconnect with `unknown_room` -- "the room is gone". That one is not a gap
 * to sit out: there is no room on the other end for the phone to be in, its
 * seat went with the room, and waiting is waiting for nothing. The phone's own
 * memory cannot tell the two apart -- it kept the room code it was admitted
 * with, exactly so that an ordinary blip returns it to the same room -- so the
 * code on the wire is the only thing that can, and that is why there are two.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  GAME_ENDED_MESSAGE,
  WaitingForTv,
  endedOnTheTv,
  errorAfterRefusal,
  waitsOutTvGap,
} from "../app/phone/src/app.tsx";
import type { RelayErrorMessage } from "../app/shared/protocol.ts";

const noTv: RelayErrorMessage = {
  t: "relay_error",
  code: "no_tv_yet",
  detail: "no TV in this room yet",
};

/** What a restarted relay answers this phone's reconnect with. */
const roomGone: RelayErrorMessage = {
  t: "relay_error",
  code: "unknown_room",
  detail: "no room ZZZZ — check the code on the TV",
};

describe("a phone's reading of the room's TV being away", () => {
  it("waits it out when the relay says the room is there and has no TV", () => {
    // The room is there and this phone is in it: the one thing missing is the
    // TV, and the seat this phone is holding is not going anywhere while the
    // room waits for it.
    expect(waitsOutTvGap(noTv)).toBe(true);
  });

  it("does not wait it out when the relay says there is no such room", () => {
    // The code alone carries this now, and it has to: a phone that has been
    // admitted to a room keeps that room's code across every reconnect, so
    // its own memory says "I am in a room" in both cases.
    expect(waitsOutTvGap(roomGone)).toBe(false);
  });

  it("does not wait out a refusal that is not about a missing TV at all", () => {
    expect(waitsOutTvGap({ t: "relay_error", code: "too_many_peers", detail: "room AAAA is full" })).toBe(
      false,
    );
    expect(
      waitsOutTvGap({ t: "relay_error", code: "malformed", detail: "a phone may only address the TV" }),
    ).toBe(false);
  });
});

describe("a phone's reading of a room that is gone", () => {
  it("takes it as the game being over when this phone was admitted to that room", () => {
    // The an earlier version fixture's probe, flipped. It ran: welcome at ABCD, socket
    // drops, reconnect refused `unknown_room`. The client still holds "ABCD"
    // -- that is its memory of having been admitted, which is what returns a
    // phone to its room after a blip -- so the phone must not read that as
    // the TV stepping out. The room is gone; the game ended on the TV.
    expect(endedOnTheTv(roomGone, true)).toBe(true);
    expect(GAME_ENDED_MESSAGE).toBe(
      "This game has ended on the TV — scan the TV's code to join again",
    );
  });

  it("leaves a first join at a code that names nothing on the join screen", () => {
    // Nothing was ever admitted here, so there is no game to have ended: the
    // code was wrong, and the relay's own detail says so. That phone belongs
    // on the join form with the relay's sentence, not on an ending.
    expect(endedOnTheTv(roomGone, false)).toBe(false);
  });

  it("is not what a TV gap is, and a TV gap is not what this is", () => {
    expect(endedOnTheTv(noTv, true)).toBe(false);
    expect(waitsOutTvGap(roomGone)).toBe(false);
  });
});

describe("what the phone shows while it waits", () => {
  it("says it is waiting for the TV, and never shows the join form", () => {
    const html = render(h(WaitingForTv, {}));
    expect(html).toContain("Waiting for the TV");
    // It stays joined: the screen a phone that had been thrown out would show.
    expect(html).not.toContain("join-button");
  });

  it("puts no error on screen for the wait, and the relay's own sentence for anything else", () => {
    // A refusal that the client answers by closing the socket and dialling
    // again also carries a status line, and the phone puts every closed
    // detail on screen as an error. This wait is not one: its screen says the
    // seat is safe and the room sorts itself out, and a red sentence on top of
    // it would be the screen contradicting itself. It is cleared here.
    expect(errorAfterRefusal(noTv)).toBeNull();
    // Nothing else is swallowed. A room that is gone still has to say so on
    // the join form it sends the phone back to.
    expect(errorAfterRefusal(roomGone)).toBe(roomGone.detail);
    expect(errorAfterRefusal({ t: "relay_error", code: "too_many_peers", detail: "room AAAA is full" })).toBe(
      "room AAAA is full",
    );
  });
});
