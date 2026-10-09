/**
 * The ending's context line is derived from the certificate, and gated.
 *
 * The line -- "the remaining puzzle still needed all three roles" -- asserted a
 * role count that was (a) hard-coded, wrong for any mystery that does not seat
 * exactly three players, and (b) never gated
 * behind `claimHoldsLive`, so it could sit right next to a headline saying
 * "Waiting for A" while still claiming every role was needed. Both are fixed
 * the same way every other positive claim in this app is: through
 * `claimHoldsLive`, with the count read off the certificate's own proven
 * role set.
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

function startedDemo(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

function startedTreehouse(): GameState {
  let state = createGame("TREE", "the-treehouse");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
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

function renderEnding(state: GameState): string {
  return render(
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
}

describe("the ending's context line is derived, and gated the same as every other positive claim", () => {
  it("says 'all three roles' for the three-player demo when everyone stayed connected", () => {
    const state = playToGoal(startedDemo());
    const html = renderEnding(state);
    expect(html).toContain("At the start, the puzzle needed all three roles.");
  });

  it("says 'both roles', never 'all three', for the two-player Treehouse", () => {
    const state = playToGoal(startedTreehouse());
    const html = renderEnding(state);
    expect(html).toContain("At the start, the puzzle needed both roles.");
    expect(html).not.toContain("all three roles");
  });

  it("never asserts a role count once a seat the claim counts on is not actually there", () => {
    // Complete the goal, then disconnect a performer who is not the one who
    // just finished it: the headline correctly says "Waiting for A", and the
    // context line must not contradict it by still claiming every role was
    // needed.
    let state = playToGoal(startedDemo());
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
    expect(heldRolesIn(state)).toEqual(["A"]);
    const html = renderEnding(state);
    expect(html).toContain("Waiting for A to come back.");
    expect(html).not.toContain("needed all three roles");
    expect(html).not.toContain("still needed all three roles");
    expect(html).toContain("here is what we checked");
  });

  it("still asserts the role count after a switch, read off the certificate the switch produced", () => {
    // No mid-run switch is exercised end to end here (that path is covered
    // by the smoke suite's own switch run) -- this only pins the branch that
    // narrates which role last changed controls, still through the same
    // derived count rather than a hard-coded one.
    const state = playToGoal(startedDemo());
    const withSwitch: GameState = {
      ...state,
      switches: [
        {
          kind: "ok",
          role: "A",
          from: ["dpad"],
          to: ["voice"],
          applied: true,
          diff: [],
          reason: "",
          beforePuzzle: state.puzzle,
          certificate: state.certificate,
        },
      ],
    };
    const html = renderEnding(withSwitch);
    expect(html).toContain("After A changed controls, the remaining puzzle still needed all three roles.");
  });
});
