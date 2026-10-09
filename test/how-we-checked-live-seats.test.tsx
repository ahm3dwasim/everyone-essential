/**
 * The in-play "How we checked" sheet is gated by live seats too.
 *
 * `Lobby` and the phone's mid-play badge have their own files
 * (`test/lobby-badge-live-seats.test.tsx`, `test/game.test.ts`). This file
 * covers the `HowWeChecked` call app.tsx makes for the in-play "How we checked"
 * sheet (app.tsx:711) -- a screen the switching-phase and ending renders of the
 * same shared component do not exercise, since neither passes
 * `contextLine="Checked as the game stands right now."`.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { createGame, heldRolesIn, reduce, reduceApp, type GameState } from "../app/tv/src/game/reducer.ts";
import { HowWeChecked } from "../app/tv/src/screens.tsx";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

describe("the in-play 'How we checked' sheet is gated by live seats (app.tsx:711)", () => {
  it("does not say 'You can finish together' once a connected role drops mid-play", () => {
    let state = reduce(started(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    expect(heldRolesIn(state)).toEqual(["B"]);

    const html = render(
      h(HowWeChecked, {
        certificate: state.certificate,
        contextLine: "Checked as the game stands right now.",
        waitingFor: heldRolesIn(state).map((role) => role),
        vacantFor: [],
        relayOpen: true,
      }),
    );
    expect(html).not.toContain("You can finish together.");
    expect(html).toContain("Waiting for B to come back.");
  });

  it("still says the room can finish together while everyone stays connected", () => {
    const state = started();
    const html = render(
      h(HowWeChecked, {
        certificate: state.certificate,
        contextLine: "Checked as the game stands right now.",
        waitingFor: [],
        vacantFor: [],
        relayOpen: true,
      }),
    );
    expect(html).toContain("You can finish together.");
  });
});
