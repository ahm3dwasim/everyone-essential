/**
 * The ending screen must not go green over a seat that is not there.
 *
 * It must not say "You did that together" or "You can finish together" while a
 * role the run's claim counts on is held or vacant -- the reducer already knows
 * this (`heldRolesIn`/`vacantRolesIn`, `claimHoldsLive`); this is the
 * render-time wiring that has to carry it through to `Ending`.
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
import { solve } from "../validator/src/api.ts";
import { correctOptionIndex } from "../app/tv/src/game/presentation.ts";
import { Ending } from "../app/tv/src/screens.tsx";

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

describe("the ending must not go green over an absent seat", () => {
  it("does not say 'You did that together' or the still-needs line once a non-final performer has dropped", () => {
    // The case this closes: complete the witness plan, then disconnect a
    // performer who is not the one who just finished it -- the goal is
    // reached, but the room reaching it is not actually all still there.
    let state = playToGoal(started());
    expect(state.phase).toBe("ending");
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
    expect(heldRolesIn(state)).toEqual(["A"]);

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
    expect(html).not.toContain("You did that together.");
    expect(html).not.toContain("You can finish together.");
    expect(html).not.toContain("The puzzle still needs all three roles.");
    expect(html).toContain("Waiting for A to come back.");
  });

  it("still says the room did it together when everyone stayed connected", () => {
    const state = playToGoal(started());
    expect(state.phase).toBe("ending");
    expect(heldRolesIn(state)).toEqual([]);
    expect(vacantRolesIn(state)).toEqual([]);

    const html = render(
      h(Ending, {
        state,
        badge: finalBadge(state),
        certificate: finalCertificate(state),
        onReplay: () => {},
        waitingFor: heldRolesIn(state),
        vacantFor: vacantRolesIn(state),
        relayOpen: true,
      }),
    );
    expect(html).toContain("You did that together.");
  });

  it("defaults waitingFor/vacantFor to empty when a caller omits them, same as HowWeChecked", () => {
    // Not a caller this app actually has any more (app.tsx always passes both
    // now), but the prop is optional and must not silently read as safe.
    // `relayOpen` is the one argument with no default, so it is named here:
    // a caller with no opinion about the connection has to say so.
    const state = playToGoal(started());
    const html = render(
      h(Ending, {
        state,
        badge: finalBadge(state),
        certificate: finalCertificate(state),
        onReplay: () => {},
        relayOpen: true,
      }),
    );
    expect(html).toContain("You did that together.");
  });

  it("refuses every claim on the ending while the TV's own socket is down, however good the run was", () => {
    const state = playToGoal(started());
    const html = render(
      h(Ending, {
        state,
        badge: finalBadge(state),
        certificate: finalCertificate(state),
        onReplay: () => {},
        relayOpen: false,
      }),
    );
    expect(html).not.toContain("You did that together.");
    expect(html).toContain('data-ok="false"');
  });
});
