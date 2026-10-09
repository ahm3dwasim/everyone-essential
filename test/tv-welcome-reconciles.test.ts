/**
 * A TV that comes back to its room finds out who is still in it.
 *
 * A phone that leaves while the TV's socket is down is never announced to the
 * TV: the relay tells the peers in the room, and the TV is not one of them for
 * as long as it is away. When the TV returns, its `welcome` carries the room's
 * accurate peer list -- and the TV has to read it. Without that reconciliation
 * the absent phone stays `connected` in the reducer, so `claimHolds` goes on
 * saying the room can finish together with an empty seat on screen, the seat
 * never enters its grace window (and so never sweeps), and the same player
 * coming back on a new connection is queued for a TV decision it should never
 * have needed.
 *
 * These cases drive the reducer the way `app/tv/src/app.tsx` drives it: a
 * `peers_present` per welcome, carrying the peer ids the relay just listed.
 */
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  claimHolds,
  createGame,
  heldRolesIn,
  reduce,
  reduceApp,
  vacantRolesIn,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { ROLE_LABEL } from "../app/tv/src/game/presentation.ts";
import { waitingOrVacantLine } from "../app/tv/src/game/certificate-presenter.ts";

const A = "phone-a";
const B = "phone-b";
const C = "phone-c";
const TOKEN: Record<string, string> = { A: "seat-A", B: "seat-B", C: "seat-C" };

/** The room as it stands with one phone per seat, all of them connected. */
function seated(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: A, name: "Ada", want: "A", seat: TOKEN.A });
  state = reduceApp(state, { k: "phone_join", peerId: B, name: "Bo", want: "B", seat: TOKEN.B });
  state = reduceApp(state, { k: "phone_join", peerId: C, name: "Cy", want: "C", seat: TOKEN.C });
  return state;
}

/** What the TV sends when its welcome lists `present` as the room. */
function welcomeLists(state: GameState, present: readonly string[], at: number): GameState {
  return reduce(state, {
    k: "peers_present",
    peerIds: [...present, "the-tv-itself"],
    at,
  });
}

function waitingLine(state: GameState): string {
  return waitingOrVacantLine(
    heldRolesIn(state).map((role) => ROLE_LABEL[role] ?? role),
    vacantRolesIn(state).map((role) => ROLE_LABEL[role] ?? role),
  );
}

describe("a TV reading its welcome's peer list", () => {
  it("marks a phone that left during the gap as absent, so the claim stops holding", () => {
    const before = seated();
    expect(claimHolds(before)).toBe(true);

    // The TV's socket was down while Ada left, so no `player_left` ever
    // reached this reducer. The welcome is the only news of it there is.
    const back = welcomeLists(before, [B, C], 5_000);

    const ada = back.players.find((player) => player.peerId === A);
    expect(ada?.connected).toBe(false);
    expect(ada?.disconnectedAt).toBe(5_000);
    // The seat is held, not vacant: Ada is expected back, and the room has to
    // say so rather than offer her role to a newcomer.
    expect(heldRolesIn(back)).toEqual(["A"]);
    expect(vacantRolesIn(back)).toEqual([]);
    expect(claimHolds(back)).toBe(false);
    expect(waitingLine(back)).toContain("Waiting for A to come back.");
  });

  it("says who it is waiting for in the room's own log, so the line on screen names them", () => {
    const back = welcomeLists(seated(), [B, C], 5_000);
    expect(back.log[back.log.length - 1]?.text).toContain("Ada dropped out");
  });

  it("hands the seat straight back to the same player, with nothing to answer on the TV", () => {
    const back = welcomeLists(seated(), [B, C], 5_000);
    // Ada returns on a brand new connection, with the token her browser kept.
    const returned = reduceApp(back, {
      k: "phone_join",
      peerId: "phone-a-again",
      name: "Ada",
      seat: TOKEN.A,
    });

    // Nobody is sitting at A, and this connection presents A's own token --
    // the one thing that says which browser the seat belongs to. So the seat
    // comes back with the join, and the room has no question to put on the
    // TV: the remote's OK is for taking a seat somebody is PLAYING right
    // now, not for a chair its owner has come back to.
    expect(returned.pendingReclaim).toBeNull();
    const ada = returned.players.find((player) => player.peerId === "phone-a-again");
    expect(ada?.role).toBe("A");
    expect(ada?.connected).toBe(true);
    expect(ada?.seat).toBe(TOKEN.A);
    expect(returned.players.some((player) => player.peerId === A)).toBe(false);
    expect(heldRolesIn(returned)).toEqual([]);
    expect(claimHolds(returned)).toBe(true);
  });

  it("still asks the TV before a token takes a seat somebody is playing right now", () => {
    // The other half of the rule, unchanged: while A is CONNECTED, a token
    // presented on a different connection is a live-seat contest, and the
    // room asks rather than guesses.
    const live = seated();
    const second = reduceApp(live, {
      k: "phone_join",
      peerId: "phone-a-again",
      name: "Ada",
      seat: TOKEN.A,
    });
    expect(second.pendingReclaim).toMatchObject({ peerId: "phone-a-again", role: "A", via: "token" });
    expect(second.players.find((player) => player.peerId === A)?.connected).toBe(true);
    expect(second.players.find((player) => player.peerId === A)?.role).toBe("A");
  });

  it("leaves the room exactly as it was when the welcome lists everyone still there", () => {
    const before = seated();
    // A TV that blinked and came back to an unchanged room: a no-op, and not
    // even a new object -- nothing here reads a clock or a list it was not
    // given.
    expect(welcomeLists(before, [A, B, C], 5_000)).toBe(before);
  });

  it("puts every seat in the waiting line when the TV returns to a room that emptied", () => {
    const back = welcomeLists(seated(), [], 5_000);
    expect(heldRolesIn(back)).toEqual(["A", "B", "C"]);
    expect(vacantRolesIn(back)).toEqual([]);
    expect(claimHolds(back)).toBe(false);
  });

  it("leaves the absent seat on the ordinary grace clock, and sweeps it like any other drop", () => {
    let state = welcomeLists(seated(), [B, C], 5_000);
    state = reduce(state, { k: "sweep_seats", at: 5_000 + SEAT_GRACE_MS - 1 });
    expect(heldRolesIn(state)).toEqual(["A"]);

    state = reduce(state, { k: "sweep_seats", at: 5_000 + SEAT_GRACE_MS });
    expect(state.players.some((player) => player.peerId === A)).toBe(false);
    expect(vacantRolesIn(state)).toEqual(["A"]);
    expect(heldRolesIn(state)).toEqual([]);
  });

  it("never brings a phone back on the strength of a welcome that lists it", () => {
    // The relay's list is the news of who is PRESENT. It is not a way to
    // resurrect a seat the grace window already let go, or one the phone
    // itself gave back -- nothing in the app resurrects a seat that way, and
    // a list that could would be a second, contradictory source of truth.
    const released = reduceApp(seated(), { k: "phone_release_role", peerId: C });
    const back = welcomeLists(released, [A, B], 5_000);
    expect(back.players.find((player) => player.peerId === C)?.role).toBeNull();
    expect(vacantRolesIn(back)).toEqual(["C"]);
  });
});
