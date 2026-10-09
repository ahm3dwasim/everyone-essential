/**
 * Every claimant has a way out of the WAIT -- which is not the same as a way
 * into a seat.
 *
 * A phone that arrives carrying a seat token for a seat somebody else's
 * connection is PLAYING is left roleless while the TV decides. It has a real
 * request in front of it and the TV will answer, but the phone that raised it
 * may not want to wait, and `phone_release_claim` ends the wait without
 * needing the TV at all. A live seat is where that wait exists: a token
 * presented against a still-live connection waits for the TV's own approval
 * (`test/live-seat-needs-tv-approval.test.ts`), and only then is the older
 * connection superseded. Nothing takes a live seat by arriving.
 *
 * (A seat nobody is playing is not this case: the token is the whole of the
 * proof there, and the join takes the seat on the spot -- see `game.test.ts`,
 * "a held-seat token is the whole of the proof".)
 *
 * The sequence that reaches it is ordinary rather than exotic: two tabs of one
 * browser open the same join link. They read the SAME token -- one IndexedDB
 * store, settled in a single transaction -- so the second tab presents the
 * first tab's seat exactly.
 *
 * Which is why leaving the wait is not leaving the browser. One token per
 * browser means two tabs are one player: a tab that walks away from its claim
 * is still the same phone as the tab holding the role, so it does not pick up
 * a role of its own on the way out (`test/one-role-per-browser.test.ts`). It
 * becomes an ordinary arrival again only once nothing live or held stands
 * behind its browser's token.
 */
import { describe, expect, it } from "vitest";
import {
  createGame,
  phoneView,
  reduce,
  reduceApp,
  roleOfPeer,
  SEAT_GRACE_MS,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { IDBFactory } from "fake-indexeddb";
import { seatIdFor } from "../app/phone/src/seat.ts";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";
const A2 = "phone-a-2";

/** Three phones seated, each with a token of its own. */
function seated(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A", seat: "seat-a" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B", seat: "seat-b" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C", seat: "seat-c" });
  return state;
}

/** The collision: A is still playing, and a second connection presents A's own live seat token. */
function collided(): GameState {
  return reduceApp(seated(), { k: "phone_join", peerId: A2, seat: "seat-a" });
}

describe("a phone whose seat token belongs to a live seat is not stuck waiting on it", () => {
  it("starts out roleless, claiming a seat the TV has a real request to decide on", () => {
    const state = collided();
    expect(roleOfPeer(state, A2)).toBeNull();
    expect(state.players.find((p) => p.peerId === A2)?.claimedSeat).toBe("seat-a");
    // A is playing the seat, so this raises a genuine request for the TV.
    expect(state.pendingReclaim?.peerId).toBe(A2);
  });

  it("is refused every other route while it carries the claim", () => {
    const state = collided();
    // A role is free, and it still cannot have it.
    const freed = reduce(state, { k: "release_role", peerId: PEER_C });
    const picked = reduceApp(freed, { k: "phone_join", peerId: A2, want: "C" });
    expect(roleOfPeer(picked, A2)).toBeNull();
    // Nor by picking directly, nor by naming a seat.
    const assigned = reduce(freed, { k: "assign_role", peerId: A2, role: "C" });
    expect(roleOfPeer(assigned, A2)).toBeNull();
    expect(phoneView(assigned, A2).notice).toBe("wait for the TV to resolve your reclaim first");
    const named = reduce(freed, { k: "reclaim_seat", peerId: A2, name: "Ada" });
    expect(roleOfPeer(named, A2)).toBeNull();
    expect(phoneView(named, A2).notice).toBe("wait for the TV to resolve your reclaim first");
  });

  it("tells the phone it is in that state, so it can offer the way out", () => {
    expect(phoneView(collided(), A2).claimingSeat).toBe(true);
    // A phone that is not claiming anything is never offered it.
    expect(phoneView(seated(), PEER_A).claimingSeat).toBe(false);
    expect(phoneView(seated(), "stranger").claimingSeat).toBe(false);
  });

  it("clears the claim when the phone says it is not its seat -- the wait ends, the browser's one seat does not become two", () => {
    // C steps out, so there is a free role on the other side of the exit.
    let state = reduce(collided(), { k: "release_role", peerId: PEER_C });
    state = reduceApp(state, { k: "phone_release_claim", peerId: A2 });
    expect(state.players.find((p) => p.peerId === A2)?.claimedSeat).toBeNull();
    expect(phoneView(state, A2).claimingSeat).toBe(false);
    // The wait is over and the reclaim-first refusal is gone with it. What
    // has NOT changed is whose phone this is: `seat-a` is still held for A,
    // and this connection presented `seat-a`, so it is the same browser and
    // gets no second role. The phone is told exactly that.
    const picked = reduceApp(state, { k: "phone_join", peerId: A2, want: "C" });
    expect(roleOfPeer(picked, A2)).toBeNull();
    const assigned = reduce(state, { k: "assign_role", peerId: A2, role: "C" });
    expect(roleOfPeer(assigned, A2)).toBeNull();
    expect(phoneView(assigned, A2).notice).toBe("this phone is already playing as A in another tab");
    expect(phoneView(assigned, A2).otherTabRole).toBe("A");
    const named = reduceApp(state, { k: "phone_reclaim_seat", peerId: A2, name: "Ada" });
    expect(phoneView(named, A2).notice).not.toBe("wait for the TV to resolve your reclaim first");
  });

  it("and becomes an ordinary arrival once nothing stands behind its browser's token", () => {
    let state = reduce(collided(), { k: "release_role", peerId: PEER_C });
    state = reduceApp(state, { k: "phone_release_claim", peerId: A2 });
    // A's own connection goes, and its grace window then runs out: the seat
    // is gone, and `seat-a` backs nothing.
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 500 });
    state = reduce(state, { k: "sweep_seats", at: 500 + SEAT_GRACE_MS + 1 });
    expect(state.players.some((p) => p.peerId === PEER_A)).toBe(false);
    const picked = reduceApp(state, { k: "phone_join", peerId: A2, want: "C" });
    expect(roleOfPeer(picked, A2)).toBe("C");
    // With the role, the token its own store has held all along.
    expect(picked.players.find((p) => p.peerId === A2)?.seat).toBe("seat-a");
  });

  it("leaves the seat it collided with exactly as it was -- saying so is not a handover", () => {
    const before = collided();
    const after = reduceApp(before, { k: "phone_release_claim", peerId: A2 });
    expect(roleOfPeer(after, PEER_A)).toBe("A");
    expect(after.players.find((p) => p.peerId === PEER_A)?.seat).toBe("seat-a");
    expect(after.pendingReclaim).toBeNull();
  });

  it("never borrows the contested token as an identity in the first place", () => {
    // A claim records what it is asking for in `claimedSeat` and nothing
    // else: the token stays on the record that actually holds the seat. So
    // there is no borrowed identity to give back, and walking away cannot
    // leave the phone carrying a token no reload will ever match.
    let state = collided();
    const claiming = state.players.find((p) => p.peerId === A2);
    expect(claiming?.claimedSeat).toBe("seat-a");
    expect(claiming?.seat).toBeNull();
    // Exactly one record carries the token throughout -- the live seat.
    expect(state.players.filter((p) => p.seat === "seat-a")).toHaveLength(1);

    state = reduceApp(state, { k: "phone_release_claim", peerId: A2 });
    const claimer = state.players.find((p) => p.peerId === A2);
    expect(claimer?.claimedSeat).toBeNull();
    expect(claimer?.seat).toBeNull();
  });

  it("drops the request it had raised along with the claim", () => {
    let state = collided();
    expect(state.pendingReclaim?.peerId).toBe(A2);
    state = reduceApp(state, { k: "phone_release_claim", peerId: A2 });
    expect(state.pendingReclaim).toBeNull();
  });

  it("is a no-op for a phone that is not claiming anything", () => {
    const state = seated();
    const after = reduceApp(state, { k: "phone_release_claim", peerId: PEER_A });
    expect(roleOfPeer(after, PEER_A)).toBe("A");
    expect(after.players).toEqual(state.players);
    expect(phoneView(after, PEER_A).notice).toBe("you are not waiting on a seat");
  });

  it("is refused outright for a peer the room has never heard from", () => {
    const after = reduceApp(seated(), { k: "phone_release_claim", peerId: "stranger" });
    expect(after.players.some((p) => p.peerId === "stranger")).toBe(false);
  });
});

/**
 * The cause, not just the symptom.
 *
 * "This isn't my seat" exists because a phone could end up holding a token
 * that was never its own. The deepest reason it could was the mint itself:
 * the token lives under one key for the whole room, so two tabs opening the
 * join link at the same moment both read "nothing kept yet" and both believed
 * they had won. One browser, two tokens, two players.
 *
 * `seat.ts` settles that in a single IndexedDB `readwrite` transaction, which
 * is serialised across every tab of a browser without needing a secure
 * context (Web Locks would, and these pages are plain HTTP on the LAN). This
 * checks the property that closes the class: however many tabs race, the
 * browser ends up with exactly one token, and the exit below is then only
 * ever needed for a token that really did come from somewhere else.
 */
describe("two tabs minting at once settle on one token, not two", () => {
  async function inBrowser<T>(factory: IDBFactory, fn: () => Promise<T>): Promise<T> {
    const globals = globalThis as { indexedDB?: unknown };
    const original = globals.indexedDB;
    globals.indexedDB = factory;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete globals.indexedDB;
      else globals.indexedDB = original;
    }
  }

  it("two tabs opening the join link at the same moment walk away with the same token", async () => {
    const one = new IDBFactory();
    const [tabA, tabB] = await inBrowser(one, () =>
      Promise.all([seatIdFor("ABCD"), seatIdFor("ABCD")]),
    );
    expect(tabA.token).toMatch(/^[0-9a-f]{32}$/);
    expect(tabB.token).toBe(tabA.token);
  });

  it("a tab that closes and reopens finds the same token, never a stranger's", async () => {
    const one = new IDBFactory();
    const before = await inBrowser(one, () => seatIdFor("ABCD"));
    const reopened = await inBrowser(one, () => seatIdFor("ABCD"));
    expect(reopened.token).toBe(before.token);
  });

  it("a different browser gets a different token -- one token per browser, not per room", async () => {
    const mine = await inBrowser(new IDBFactory(), () => seatIdFor("ABCD"));
    const theirs = await inBrowser(new IDBFactory(), () => seatIdFor("ABCD"));
    expect(theirs.token).not.toBe(mine.token);
  });
});
