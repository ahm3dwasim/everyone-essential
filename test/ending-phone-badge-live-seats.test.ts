/**
 * The ending's phone badge is gated by live seats.
 *
 * The ending branch of `phoneView` built its badge from an ungated
 * `finalBadge(state)`. Every other badge on that path goes through
 * `badge(certificate, isConnected)`, and the TV's own ending headline goes
 * through `claimHoldsLive`, so the phone was the last place a room-wide
 * "A essential ✓" could be printed for a seat that had already dropped. The
 * phone has no headline and no waiting line beside its badge: whatever
 * `phone/app.tsx`'s `phone-badge` shows is the whole claim, in ticks. So the
 * gate has to be on the badge itself.
 *
 * The pinned case: complete the game, disconnect A, read B's phone view.
 */
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  createGame,
  phoneView,
  reduce,
  reduceApp,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { solve } from "../validator/src/api.ts";
import { correctOptionIndex } from "../app/tv/src/game/presentation.ts";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";
const ROLES = ["A", "B", "C"] as const;

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

/** Every `<role> essential` line on a phone's badge, by role. */
function essentialLines(view: ReturnType<typeof phoneView>): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = {};
  for (const role of ROLES) {
    out[role] = view.badge?.lines.find((line) => line.label === `${role} essential`)?.ok;
  }
  return out;
}

describe("the ending's phone badge is gated by live seats", () => {
  it("does not go ok, or mark A essential, on B's phone once A has dropped after the goal", () => {
    let state = playToGoal(started());
    expect(state.phase).toBe("ending");

    // A -- who is not the performer who finished the run -- disconnects. The
    // reducer already knows: A is held, not gone (`heldRolesIn`).
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });

    const view = phoneView(state, PEER_B);
    expect(view.badge?.ok).toBe(false);
    expect(essentialLines(view)).toEqual({ A: false, B: true, C: true });
    // The line itself still carries its own proof text; only the tick is
    // withheld, exactly as the mid-play gate does it.
    expect(view.badge?.lines.find((line) => line.label === "A essential")?.detail).toBe(
      "A has not joined yet",
    );
  });

  it("still goes ok -- with every role's line ticked -- while the whole room is connected at the goal", () => {
    const state = playToGoal(started());
    const view = phoneView(state, PEER_B);
    expect(view.badge?.ok).toBe(true);
    expect(essentialLines(view)).toEqual({ A: true, B: true, C: true });
  });

  it("gates a genuinely vacant seat the same way, not only a held one", () => {
    let state = playToGoal(started());
    // A's phone never comes back: past the grace window the seat is swept and
    // genuinely empty, which is the `vacantFor` half of the same gate.
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    expect(state.players.find((p) => p.peerId === PEER_A)).toBeUndefined();

    const view = phoneView(state, PEER_B);
    expect(view.badge?.ok).toBe(false);
    expect(essentialLines(view).A).toBe(false);
  });
});
