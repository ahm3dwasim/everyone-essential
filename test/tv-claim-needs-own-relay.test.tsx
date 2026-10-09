/**
 * The TV's own claim lines need the TV's own socket.
 *
 * Every positive line on the TV goes through `claimHoldsLive`: "you can finish
 * together", "you did that together", the still-needs-N-roles line. All of
 * them are statements about what the room can do RIGHT NOW, and the TV makes
 * them from state it was told over its own connection. While that connection
 * is down, the state on screen is the last thing it heard -- on the relay the
 * demo ships, a dead TV socket can sit unnoticed for ten to twenty seconds --
 * so a board that keeps saying "everyone still necessary" is reading out stale
 * news as if it were live.
 *
 * A disconnected TV has not lost the claim; it has lost the standing to make
 * it. What it says instead is that it is reconnecting.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  createGame,
  finalBadge,
  finalCertificate,
  heldRolesIn,
  reduce,
  reduceApp,
  vacantRolesIn,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { correctOptionIndex } from "../app/tv/src/game/presentation.ts";
import { solve } from "../validator/src/api.ts";
import { Ending, HowWeChecked } from "../app/tv/src/screens.tsx";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

/** A room with every seat taken and connected, and a certificate that holds. */
function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

/** The whole witness plan, taking the correct option wherever one is offered. */
function playToGoal(state: GameState): GameState {
  let next = state;
  for (;;) {
    const step = solve(next.puzzle, next.play).plan[0];
    if (!step) break;
    const action = next.puzzle.actions.find((a) => a.id === step.action)!;
    const peerId = next.players.find((p) => p.role === step.performer)!.peerId;
    next = reduce(next, { k: "choose_action", peerId, actionId: step.action });
    if ((action.options ?? 1) > 1) {
      next = reduce(next, { k: "choose_option", peerId, option: correctOptionIndex(action) });
    }
  }
  return next;
}

describe("'How we checked' needs the TV's own connection", () => {
  it("says it is reconnecting, not that the room can finish together, while the socket is down", () => {
    const state = started();
    expect(heldRolesIn(state)).toEqual([]);
    expect(vacantRolesIn(state)).toEqual([]);

    const html = render(
      h(HowWeChecked, {
        certificate: state.certificate,
        contextLine: "Checked as the game stands right now.",
        waitingFor: heldRolesIn(state).map((role) => role),
        vacantFor: vacantRolesIn(state),
        relayOpen: false,
      }),
    );
    expect(html).not.toContain("You can finish together.");
    expect(html).toContain("Reconnecting");
  });

  it("still says the room can finish together while the socket is up", () => {
    const state = started();
    const html = render(
      h(HowWeChecked, {
        certificate: state.certificate,
        contextLine: "Checked as the game stands right now.",
        waitingFor: heldRolesIn(state).map((role) => role),
        vacantFor: vacantRolesIn(state),
        relayOpen: true,
      }),
    );
    expect(html).toContain("You can finish together.");
    expect(html).not.toContain("Reconnecting");
  });
});

describe("the ending needs the TV's own connection", () => {
  it("says it is reconnecting, not that the room did it together, while the socket is down", () => {
    // The whole plan played out with everyone still connected: the positive
    // line is genuinely earned, so its absence below is the socket and
    // nothing else.
    const state = playToGoal(started());
    expect(state.phase).toBe("ending");
    const html = render(
      h(Ending, {
        state,
        badge: finalBadge(state),
        certificate: finalCertificate(state),
        onReplay: () => {},
        waitingFor: heldRolesIn(state).map((role) => role),
        vacantFor: vacantRolesIn(state),
        relayOpen: false,
      }),
    );
    expect(html).not.toContain("You did that together.");
    expect(html).toContain("Reconnecting");
    // The sheet the ending carries says the same thing: the claim is not
    // made, so no positive line survives anywhere on the screen.
    expect(html).not.toContain("You can finish together.");
  });

  it("still says the room did it together while the socket is up", () => {
    const state = playToGoal(started());
    const html = render(
      h(Ending, {
        state,
        badge: finalBadge(state),
        certificate: finalCertificate(state),
        onReplay: () => {},
        waitingFor: heldRolesIn(state).map((role) => role),
        vacantFor: vacantRolesIn(state),
        relayOpen: true,
      }),
    );
    expect(html).toContain("You did that together.");
  });
});
