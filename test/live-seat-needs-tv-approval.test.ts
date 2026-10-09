/**
 * The seat-ownership class, closed. Two sequences that were left open, kept
 * here as the regressions that must never come back:
 *
 *  1. the cross-tab first-mint race -- a returning tab presenting the token
 *     that SURVIVED a mint race, which belongs to a seat somebody else is
 *     playing right now;
 *  2. the live replay -- a different browser presenting a live seat's token
 *     off the wire.
 *
 * Both are the same thing to the TV, and the rule is the same for both: a
 * token presented by a peer id that is not the live connection holding that
 * seat NEVER takes the seat on its own. The older live connection keeps the
 * role, the newcomer is roleless with a pending claim, and only the TV
 * remote's own approval supersedes the older connection. There is never a
 * second live holder, and a seat is never handed over without the room
 * seeing the question.
 */
import { describe, expect, it } from "vitest";

import {
  createGame,
  heldRolesIn,
  playerByPeer,
  reduce,
  reduceApp,
  roleOfPeer,
  type GameState,
} from "../app/tv/src/game/reducer.ts";

const TOKEN_ONE = "11111111111111111111111111111111";
const TOKEN_TWO = "22222222222222222222222222222222";

function join(state: GameState, peerId: string, seat: string, want?: "A" | "B" | "C"): GameState {
  return reduceApp(state, {
    k: "phone_join",
    peerId,
    name: "",
    ...(want ? { want } : {}),
    seat,
  });
}

describe("an earlier version reproduction: the cross-tab first-mint race", () => {
  /**
   * The exact sequence, unchanged: two tabs of one browser walk away from the
   * mint race with different tokens, the first tab drops, and it comes back
   * presenting the token that survived -- which by then is the LIVE second
   * tab's seat. That seat was once handed over automatically.
   */
  it("a returning tab presenting a live seat's token gets no role, and raises a request instead", () => {
    let state = createGame("ABCD");
    state = join(state, "first-tab", TOKEN_ONE, "A");
    state = join(state, "second-tab", TOKEN_TWO, "B");
    state = reduce(state, { k: "player_left", peerId: "first-tab", at: 1_000 });

    state = join(state, "first-tab-reopened", TOKEN_TWO);

    // The live seat did not move.
    expect(roleOfPeer(state, "second-tab")).toBe("B");
    expect(roleOfPeer(state, "first-tab-reopened")).toBeNull();
    expect(state.superseded).toBeNull();
    // The newcomer is a claimant, and the TV is being asked.
    expect(playerByPeer(state, "first-tab-reopened")?.claimedSeat).toBe(TOKEN_TWO);
    expect(state.pendingReclaim?.peerId).toBe("first-tab-reopened");
    expect(state.pendingReclaim?.role).toBe("B");
    // A's seat is still held for whoever comes back to it, untouched by any
    // of this.
    expect(heldRolesIn(state)).toContain("A");
  });

  it("only the TV's approval moves the seat -- and it closes the older connection", () => {
    let state = createGame("ABCD");
    state = join(state, "first-tab", TOKEN_ONE, "A");
    state = join(state, "second-tab", TOKEN_TWO, "B");
    state = reduce(state, { k: "player_left", peerId: "first-tab", at: 1_000 });
    state = join(state, "first-tab-reopened", TOKEN_TWO);

    const request = state.pendingReclaim!;
    state = reduce(state, { k: "approve_reclaim", requestId: request.id });

    expect(roleOfPeer(state, "first-tab-reopened")).toBe("B");
    expect(playerByPeer(state, "second-tab")).toBeUndefined();
    // The superseded connection's peer id is gone from `players`, so this is
    // its only remaining address -- what the TV's own effect sends the
    // `superseded` notice to.
    expect(state.superseded?.peerId).toBe("second-tab");
  });

  it("declining leaves the live seat exactly where it was", () => {
    let state = createGame("ABCD");
    state = join(state, "first-tab", TOKEN_ONE, "A");
    state = join(state, "second-tab", TOKEN_TWO, "B");
    state = reduce(state, { k: "player_left", peerId: "first-tab", at: 1_000 });
    state = join(state, "first-tab-reopened", TOKEN_TWO);

    const request = state.pendingReclaim!;
    state = reduce(state, { k: "decline_reclaim", requestId: request.id });

    expect(roleOfPeer(state, "second-tab")).toBe("B");
    expect(roleOfPeer(state, "first-tab-reopened")).toBeNull();
    expect(state.superseded).toBeNull();
    expect(playerByPeer(state, "first-tab-reopened")?.claimedSeat).toBeNull();
  });
});

describe("live replay: another browser presents a seat token somebody is playing under", () => {
  it("the replay never takes the live seat, and cannot take it by repeating itself", () => {
    let state = createGame("ABCD");
    state = join(state, "phone-a", TOKEN_ONE, "A");

    state = join(state, "replay", TOKEN_ONE);
    expect(roleOfPeer(state, "phone-a")).toBe("A");
    expect(roleOfPeer(state, "replay")).toBeNull();
    expect(state.superseded).toBeNull();
    expect(state.pendingReclaim?.peerId).toBe("replay");

    // Repeating the join is not a second chance at the seat.
    state = join(state, "replay", TOKEN_ONE);
    expect(roleOfPeer(state, "phone-a")).toBe("A");
    expect(roleOfPeer(state, "replay")).toBeNull();
    expect(state.superseded).toBeNull();

    // Nor is a third connection presenting the same token: it queues behind
    // the first claimant rather than displacing anyone.
    state = join(state, "replay-two", TOKEN_ONE);
    expect(roleOfPeer(state, "phone-a")).toBe("A");
    expect(roleOfPeer(state, "replay-two")).toBeNull();
    expect(state.superseded).toBeNull();
    expect(state.pendingReclaim?.peerId).toBe("replay");
  });

  it("the TV declining the replay leaves the player who is actually playing alone", () => {
    let state = createGame("ABCD");
    state = join(state, "phone-a", TOKEN_ONE, "A");
    state = join(state, "replay", TOKEN_ONE);

    state = reduce(state, { k: "decline_reclaim", requestId: state.pendingReclaim!.id });
    expect(roleOfPeer(state, "phone-a")).toBe("A");
    expect(roleOfPeer(state, "replay")).toBeNull();
    expect(state.pendingReclaim).toBeNull();
  });
});
