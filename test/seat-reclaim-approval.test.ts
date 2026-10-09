/**
 * A reclaim decision answers the request it names, and nothing else.
 *
 * The TV approves one seat request at a time. The overlay's two controls carry
 * the fingerprint of the request they are showing, and the reducer refuses a
 * decision whose fingerprint is not the request waiting right now.
 *
 * Without that binding, the overlay was decided by position rather than by
 * identity: a request could be replaced between the moment it appeared and the
 * moment the remote's button was pressed, and the press landed on whoever the
 * queue had promoted into its place. The sequence below is the one that
 * matters -- a phone that was shown asking for a seat by name drops, a queued
 * phone that had only replayed a seat token is promoted into its place, and the
 * stale press must not hand that second phone the seat.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  RECLAIM_APPROVE,
  RECLAIM_DECLINE,
  reclaimControlId,
  reclaimDecision,
  reclaimFocusTarget,
} from "../app/tv/src/remote.ts";
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
const RETURNING = "phone-returning";
const REPLAY = "replay-c";

/** The same three phones, each carrying the seat token it minted for itself. */
function seated(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A", seat: "seat-a" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B", seat: "seat-b" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C", seat: "seat-c" });
  return state;
}

/**
 * Two questions about two different seats, so the overlay has something it can
 * be wrong about. B has dropped, and Bo's own phone has asked for that seat
 * back by name -- the deliberate route, which the TV answers. C is still
 * PLAYING, and a second browser replaying C's seat token has queued behind
 * that request, because a token for a seat somebody is playing is a question
 * and not a credential. The overlay is showing the name request from
 * `phone-returning`.
 *
 * The two cannot be about the same seat: a token for a seat nobody is playing
 * takes it on the spot, so it never becomes a request to queue.
 */
function nameRequestWithReplayQueued(): GameState {
  let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
  state = reduceApp(state, { k: "phone_join", peerId: RETURNING, name: "" });
  state = reduceApp(state, { k: "phone_reclaim_seat", peerId: RETURNING, name: "Bo" });
  state = reduceApp(state, { k: "phone_join", peerId: REPLAY, seat: "seat-c" });
  return state;
}

function onScreen(state: GameState): PendingReclaim {
  const request = state.pendingReclaim;
  if (!request) throw new Error("no reclaim request is on screen");
  return request;
}

describe("a reclaim decision only applies to the request it names", () => {
  it("refuses a press aimed at a request the queue has already replaced", () => {
    let state = nameRequestWithReplayQueued();
    const shown = onScreen(state);
    expect(shown.peerId).toBe(RETURNING);

    // The requester drops before the TV answers, and the queued replay is
    // promoted into the slot the overlay was showing.
    state = reduce(state, { k: "player_left", peerId: RETURNING, at: 2_000 });
    const promoted = onScreen(state);
    expect(promoted.peerId).toBe(REPLAY);
    expect(promoted.id).not.toBe(shown.id);

    // The press the remote was about to make, aimed at the request it saw.
    state = reduce(state, { k: "approve_reclaim", requestId: shown.id });

    expect(roleOfPeer(state, REPLAY)).toBeNull();
    expect(roleOfPeer(state, RETURNING)).toBeNull();
    // B's seat is still only held, and the promoted request is still waiting.
    expect(state.players.some((p) => p.role === "B" && !p.connected)).toBe(true);
    expect(onScreen(state).id).toBe(promoted.id);
    expect(state.notice?.text).toContain("not the one");
  });

  it("refuses a stale decline too -- it must not close the request it was not answering", () => {
    let state = nameRequestWithReplayQueued();
    const shown = onScreen(state);
    state = reduce(state, { k: "player_left", peerId: RETURNING, at: 2_000 });
    const promoted = onScreen(state);

    state = reduce(state, { k: "decline_reclaim", requestId: shown.id });

    // The promoted request is untouched: no answer was given to it.
    expect(onScreen(state).id).toBe(promoted.id);
    expect(roleOfPeer(state, REPLAY)).toBeNull();
  });

  it("applies the decision that does name the request on screen", () => {
    let state = nameRequestWithReplayQueued();
    const shown = onScreen(state);

    state = reduce(state, { k: "approve_reclaim", requestId: shown.id });

    expect(roleOfPeer(state, RETURNING)).toBe("B");
    expect(roleOfPeer(state, REPLAY)).toBeNull();
    // The replay is still asking about C's seat, which C is still playing, so
    // its claim does not evaporate: it is the next question the TV has to
    // answer. Approving Bo's name request never doubles as a refusal of
    // somebody else's.
    expect(onScreen(state).peerId).toBe(REPLAY);
    expect(onScreen(state).id).not.toBe(shown.id);
  });

  it("the queued replay, now asking for a LIVE seat, still takes nothing until the TV answers it", () => {
    let state = nameRequestWithReplayQueued();
    state = reduce(state, { k: "approve_reclaim", requestId: onScreen(state).id });

    // The replay's own request is on screen now. Declining it leaves the
    // player who is actually playing exactly where they were.
    state = reduce(state, { k: "decline_reclaim", requestId: onScreen(state).id });
    expect(roleOfPeer(state, RETURNING)).toBe("B");
    expect(roleOfPeer(state, REPLAY)).toBeNull();
    expect(state.pendingReclaim).toBeNull();
    expect(state.superseded).toBeNull();
  });

  it("refuses a press with no request on screen at all", () => {
    const state = reduce(seated(), { k: "approve_reclaim", requestId: "nothing-was-asked" });
    expect(state.pendingReclaim).toBeNull();
    expect(state.players.map((p) => p.role)).toEqual(["A", "B", "C"]);
  });
});

describe("the overlay's controls name the request they answer", () => {
  const request: PendingReclaim = {
    id: "phone-returning:seat-b:7",
    peerId: RETURNING,
    name: "Bo",
    role: "B",
    seat: "seat-b",
  };

  function rendered(focusId: string | null): string {
    return render(
      h(ReclaimApproval, { request, focusId, onApprove: () => {}, onDecline: () => {} }),
    );
  }

  it("carries the request's own id on both controls", () => {
    const html = rendered(null);
    expect(html).toContain(`data-focus-id="${reclaimControlId(RECLAIM_DECLINE, request.id)}"`);
    expect(html).toContain(`data-focus-id="${reclaimControlId(RECLAIM_APPROVE, request.id)}"`);
  });

  it("reads a decision back out of the id, and nothing out of any other id", () => {
    expect(reclaimDecision(reclaimControlId(RECLAIM_APPROVE, request.id))).toEqual({
      control: RECLAIM_APPROVE,
      requestId: request.id,
    });
    expect(reclaimDecision(reclaimControlId(RECLAIM_DECLINE, request.id))).toEqual({
      control: RECLAIM_DECLINE,
      requestId: request.id,
    });
    expect(reclaimDecision("act:a_read_painting_hint")).toBeNull();
    expect(reclaimDecision("approve-reclaim")).toBeNull();
    expect(reclaimDecision(null)).toBeNull();
  });

  it("draws the ring on the request that is actually on screen", () => {
    const decline = reclaimControlId(RECLAIM_DECLINE, request.id);
    const approve = reclaimControlId(RECLAIM_APPROVE, request.id);
    const ids = [decline, approve];

    // Already on one of THIS request's controls: the ring stays where it is.
    expect(reclaimFocusTarget(ids, approve, request.id)).toBe(approve);
    expect(reclaimFocusTarget(ids, decline, request.id)).toBe(decline);

    // The ring was on a control belonging to the request this one replaced:
    // it falls back to the safe answer, never to "Hand it over".
    const replaced = reclaimControlId(RECLAIM_APPROVE, "phone-returning:seat-a:6");
    expect(reclaimFocusTarget(ids, replaced, request.id)).toBe(decline);

    // And a ring anywhere else in the app lands on the safe answer too.
    expect(reclaimFocusTarget(ids, "act:a_read_painting_hint", request.id)).toBe(decline);
    expect(reclaimFocusTarget(ids, null, request.id)).toBe(decline);
  });
});
