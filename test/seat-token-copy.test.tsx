/**
 * A presented token is described as a presented token.
 *
 * A seat token is a BEARER token. Presenting it proves only that whoever holds
 * it can present it -- it is not evidence that this is the same phone, or the
 * same person, that held the seat before. The TV said otherwise on both
 * surfaces:
 *
 *  - the approval overlay's token branch read "A's phone is back — press OK to
 *    hand the seat back", and
 *  - the post-approval log line read "A is back — A is theirs again",
 *
 * so a peer that had never joined before, replaying a disconnected owner's
 * exact token, was shown a reassuring "the same phone returned" screen and
 * then written into the permanent log as the original player.
 *
 * The pinned case: a never-before-joined peer presenting the token, receiving
 * the screen, and becoming A after the TV's approval.
 *
 * The repair is copy, not mechanism: the approval gate and everything behind
 * it is unchanged (a token raises a request, only the TV's own press grants
 * the seat). What changes is that both surfaces now describe
 * the event truthfully -- a phone PRESENTED a code -- and hand the judgement to
 * the only party who can actually make it: the person holding the remote.
 *
 * The name branch is deliberately untouched: a typed name was already, and
 * still is, described as a typed name, and its log line still names the player
 * who came back.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  createGame,
  reduce,
  reduceApp,
  roleOfPeer,
  type GameState,
  type PendingReclaim,
} from "../app/tv/src/game/reducer.ts";
import { ReclaimApproval } from "../app/tv/src/screens.tsx";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

function seated(): GameState {
  let state = createGame("COPY");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A", seat: "seat-a" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B", seat: "seat-b" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C", seat: "seat-c" });
  return state;
}

/** The overlay's own text, as a couch sees it. */
function overlayText(request: PendingReclaim): string {
  return render(
    <ReclaimApproval request={request} focusId={null} onApprove={() => {}} onDecline={() => {}} />,
  );
}

/** The id of the reclaim request the TV is showing -- what a press on the overlay carries. */
function onScreenRequestId(state: GameState): string {
  if (!state.pendingReclaim) throw new Error("no reclaim request is on screen");
  return state.pendingReclaim.id;
}

describe("a presented token is described as a presented token", () => {
  it("the TV prompt never claims the same phone came back", () => {
    const text = overlayText({ peerId: "phone-a-2", name: "Ada", role: "A", via: "token" });

    // The claim that was wrong, in the words it was wrong in.
    expect(text).not.toContain("phone is back");
    expect(text).not.toContain("hand the seat back");

    // What actually happened, and who decides.
    expect(text).toContain("presented");
    expect(text).toContain("reconnect code");
    expect(text).toContain("Only if this is A");
  });

  it("names the role the code was presented for, not a generic sentence", () => {
    const text = overlayText({ peerId: "phone-b-2", name: "Bo", role: "B", via: "token" });
    expect(text).toContain("B");
    expect(text).toContain("Only if this is B");
  });

  it("keeps the prompt short enough for couch distance", () => {
    // The overlay is read at 960x480 from across a room; a paragraph is not.
    const text = overlayText({ peerId: "phone-a-2", name: "Ada", role: "A", via: "token" });
    const sub = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    expect(sub.length).toBeLessThan(160);
  });

  it("leaves the name branch saying exactly what it said before", () => {
    const text = overlayText({ peerId: "phone-x", name: "Bo", role: "B" });
    expect(text).toContain("typed the name");
    expect(text).toContain("Bo");
    expect(text).not.toContain("reconnect code");
  });

  it("the post-approval log says the TV let a phone take the seat, not that the player returned", () => {
    // The repro: a peer that never joined before, replaying A's token while A
    // is still playing it. A's own connection then goes before the press --
    // the request is already in front of the family and the seat is still A's
    // by the record, so the press is still the thing that moves it, and what
    // it did is hand the seat over. It is never described as a return: this
    // phone never went anywhere.
    let state = reduceApp(seated(), { k: "phone_join", peerId: "stranger", name: "Ada", seat: "seat-a" });
    expect(state.pendingReclaim).toMatchObject({
      peerId: "stranger",
      name: "Ada",
      role: "A",
      via: "token",
    });

    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "stranger")).toBe("A"); // the gate itself is unchanged

    const line = state.log[state.log.length - 1]?.text ?? "";
    expect(line).toContain("let a phone take A's seat");
    expect(line).not.toContain("is theirs again");
    expect(line).not.toContain("is back");
  });

  it("still records the returning player by name on the name path", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    // The returning phone reopened the join link -- a fresh tab, so a fresh
    // seat and no name typed at Join. That first join lands as a genuine
    // stranger (role null); `reclaim_seat` is the way back from that screen.
    state = reduceApp(state, { k: "phone_join", peerId: "phone-b-2", name: "" });
    expect(roleOfPeer(state, "phone-b-2")).toBeNull();
    state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-b-2", name: "Bo" });
    expect(state.pendingReclaim?.via).toBeUndefined();

    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "phone-b-2")).toBe("B");
    const line = state.log[state.log.length - 1]?.text ?? "";
    expect(line).toContain("is back");
    expect(line).toContain("B is theirs again");
    expect(line).not.toContain("let a phone take");
  });
});
