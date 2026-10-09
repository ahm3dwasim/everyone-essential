/**
 * A claim stops being a contest the moment the seat has nobody playing it.
 *
 * Presenting a seat's token while somebody IS playing that seat is a request,
 * not a proof: nothing on the wire can tell the seat's own browser reopening
 * from a token somebody intercepted, so the TV is asked and its approval is
 * what moves the seat. Presenting it when nobody is playing the seat is a
 * different thing entirely -- the chair is empty, and the token is the one
 * thing that says whose chair it is -- and that has always come back
 * automatically, with nothing for the remote to answer.
 *
 * The pair went wrong together. A claimant that had already queued a request
 * kept its `claimedSeat` (deliberately sticky, so a repeated `join` from an
 * active claimant cannot silently drop the claim), and once its seat's holder
 * dropped, that stickiness was the only thing left holding the request open:
 * the phone sat on "the TV has been asked whether to move that seat to this
 * tab" with nobody playing the seat it was asking about, and the answer it was
 * waiting for was one the token had already given.
 *
 * `player_joined` is where the answer belongs, and it is the only place it may
 * be given: a role whose holder has gone is taken back on a JOIN, never by a
 * drop, a sweep or a normalisation step (I5). So the claimant's next
 * presentation of the seat's own token -- which is what a phone's reconnect
 * sends -- merges into the seat's record exactly as a returning phone does.
 */
import { describe, expect, it } from "vitest";
import {
  checkSeatInvariants,
  createGame,
  reduce,
  reduceApp,
  roleOfPeer,
  type GameState,
} from "../app/tv/src/game/reducer.ts";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

/** Three phones, each carrying the seat it minted for itself. */
function seated(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A", seat: "seat-a" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B", seat: "seat-b" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C", seat: "seat-c" });
  return state;
}

describe("a claim whose seat's holder has dropped", () => {
  it("hands the seat to the claimant, with nothing for the TV, on its next presentation of the token", () => {
    // Bo's own browser opens a second connection -- a reloaded tab -- while
    // Bo is still playing B. That is the live-seat contest: the claim is
    // raised, and the TV is asked.
    let state = seated();
    state = reduceApp(state, { k: "phone_join", peerId: "b-again", name: "Bo", seat: "seat-b" });
    expect(roleOfPeer(state, "b-again")).toBeNull();
    expect(state.pendingReclaim).toMatchObject({ peerId: "b-again", role: "B" });

    // Bo's older connection drops while the question is still on the TV. B is
    // a chair nobody is sitting in now, kept only for whoever holds its token.
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    expect(state.players.some((p) => p.peerId === PEER_B && !p.connected)).toBe(true);

    // The claimant presents the seat's own token again. This is a return, not
    // a reclaim: there is no live connection to supersede and no answer the
    // token has not already given.
    state = reduceApp(state, { k: "phone_join", peerId: "b-again", name: "Bo", seat: "seat-b" });

    expect(roleOfPeer(state, "b-again")).toBe("B");
    expect(state.pendingReclaim).toBeNull(); // nothing left for the remote
    // Moved, not copied: exactly one record holds B, and it is the live one.
    expect(state.players.filter((p) => p.role === "B")).toHaveLength(1);
    expect(state.players.find((p) => p.role === "B")?.connected).toBe(true);
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("still asks the TV while somebody is playing the seat, so the live contest is not weakened", () => {
    let state = seated();
    state = reduceApp(state, { k: "phone_join", peerId: "b-again", name: "Bo", seat: "seat-b" });
    // Presenting it again changes nothing while Bo is still there: the claim
    // is a question, and a question asked twice is the same question.
    state = reduceApp(state, { k: "phone_join", peerId: "b-again", name: "Bo", seat: "seat-b" });
    expect(roleOfPeer(state, "b-again")).toBeNull();
    expect(roleOfPeer(state, PEER_B)).toBe("B");
    expect(state.pendingReclaim).toMatchObject({ peerId: "b-again", role: "B" });
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("does not let the claimant take a seat whose holder dropped if it is not the seat it claimed", () => {
    // A claim is for one seat. Bo's second connection claims B; when C's
    // holder drops, B's claimant is not the connection C's token names, and
    // nothing about the drop hands it anything.
    let state = seated();
    state = reduceApp(state, { k: "phone_join", peerId: "b-again", name: "Bo", seat: "seat-b" });
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "b-again", name: "Bo", seat: "seat-b" });
    expect(roleOfPeer(state, "b-again")).toBeNull();
    expect(roleOfPeer(state, PEER_C)).toBe("C");
    expect(checkSeatInvariants(state)).toEqual([]);
  });
});
