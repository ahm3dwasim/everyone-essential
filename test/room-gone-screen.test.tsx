/**
 * What the TV shows when the relay will not take it back into its room.
 *
 * A TV returns to its room by naming it with the credential the relay issued
 * that room. When that is refused the game the family was playing cannot be
 * reached from this screen at all -- but the board underneath still looks like
 * a game in progress, and a phone that reconnects would be dialling an address
 * with nothing behind it. So the screen has to say so, and has to offer the
 * one thing that is still possible.
 *
 * The action has to be reachable from the remote, which in this app means
 * carrying a `data-focus-id` -- `collectTargets` takes exactly the elements
 * that have one, and `app.tsx` puts the ring on this id whenever the room is
 * gone.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { RoomGone } from "../app/tv/src/screens.tsx";

function screen(focusId: string | null): string {
  return render(h(RoomGone, { focusId, onStartNewRoom: () => {} }));
}

describe("the screen for a room this TV can no longer serve", () => {
  it("says the game cannot be picked up again, and why", () => {
    const html = screen(null);
    expect(html).toContain("picked up again");
    expect(html).toContain("The room this TV was serving has gone");
  });

  it("offers one action, and it is on the remote's ring", () => {
    const html = screen(null);
    expect(html).toContain('data-testid="start-new-room"');
    expect(html).toContain("Start a new room");
    // One focus id, and it is that action's: nothing else on this screen can
    // take the ring, and the ring cannot land nowhere.
    expect(html.match(/data-focus-id="([^"]+)"/g)).toEqual(['data-focus-id="start-new-room"']);
    expect(html).toContain('data-focused="false"');
  });

  it("shows the action as the focused one when the ring is on it", () => {
    expect(screen("start-new-room")).toContain('data-focused="true"');
  });
});
