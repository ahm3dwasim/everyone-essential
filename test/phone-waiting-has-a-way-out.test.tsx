/**
 * A phone waiting for a TV that is not coming back has to be able to leave.
 *
 * The waiting screen exists for a room whose TV has stepped out. While the
 * room is live the TV can come back to it, and the seat this phone holds is
 * held for it: waiting is right, and the screen says so. What it also said was
 * "this sorts itself out on its own" -- true for a Wi-Fi blip, false for the
 * room the TV is never coming back to. A TV reloaded onto a new game, or
 * simply switched off, leaves the phones holding the old room open: the relay
 * keeps a room while anything is in it, so nothing on the other end ever ends
 * the wait, and the screen had no button at all.
 *
 * The deadline is the seat's own grace window, and it is the same three
 * minutes in both places because it is the same fact: how long a chair is kept
 * for somebody who has stepped away. Waiting less than that and offering to
 * leave would invite a player to give up a seat that is still being kept for
 * them. So the button arrives with the copy, at the moment the seat would go.
 *
 * Leaving is not giving up the seat: the token is not rotated and not
 * discarded, and the room code is cleared so the form starts empty.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { SEAT_GRACE_MS } from "../app/tv/src/game/reducer.ts";
import { WAITING_GRACE_MS, WaitingForTv } from "../app/phone/src/app.tsx";

describe("the screen a phone shows while the room has no TV", () => {
  it("says it is waiting, and keeps the join form away while the wait is still reasonable", () => {
    const html = render(h(WaitingForTv, {}));
    expect(html).toContain("Waiting for the TV");
    // It stays joined: the screen a phone that had been thrown out would show
    // is the join form, and nothing about this phone's place has changed.
    expect(html).not.toContain("join-button");
    // And nothing to leave with: the seat is still being kept.
    expect(html).not.toContain('data-testid="join-different-game"');
  });

  it("stops promising the wait sorts itself out once the seat's own grace has passed", () => {
    const early = render(h(WaitingForTv, {}));
    expect(early).toContain("this sorts itself out on its own");
    const late = render(h(WaitingForTv, { waitedPastGrace: true, onJoinDifferentGame: () => {} }));
    expect(late).not.toContain("this sorts itself out on its own");
    // And it says the true thing: a TV showing a different code has started a
    // different game, and this room is the old one.
    expect(late).toContain("new game");
  });

  it("offers the way out of the room once the wait has stopped being reasonable", () => {
    const html = render(h(WaitingForTv, { waitedPastGrace: true, onJoinDifferentGame: () => {} }));
    expect(html).toContain('data-testid="join-different-game"');
    // Still not the join form's own button: this phone leaves the room
    // deliberately rather than being thrown back to the form.
    expect(html).not.toContain("join-button");
  });

  it("never offers the way out without the copy that explains it", () => {
    // The button and the honest sentence are one state, not two: a way out
    // next to "this sorts itself out on its own" would be the screen arguing
    // with itself.
    const html = render(h(WaitingForTv, { onJoinDifferentGame: () => {} }));
    expect(html).not.toContain('data-testid="join-different-game"');
    expect(html).toContain("this sorts itself out on its own");
  });

  it("turns at exactly the moment a seat stops being held, because it is the same wait", () => {
    expect(WAITING_GRACE_MS).toBe(SEAT_GRACE_MS);
    expect(SEAT_GRACE_MS).toBe(180_000);
  });
});
