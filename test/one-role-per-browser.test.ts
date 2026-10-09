/**
 * One browser is one player.
 *
 * The seat token is BROWSER-wide: every tab of one browser reads the same
 * token out of one IndexedDB store. That closes the "two tabs, two tokens"
 * hole and opens a narrower one in its place, which this file pins: with one
 * token per browser, two tabs are the same player, and the reducer has to say
 * so.
 *
 * Two sequences otherwise reach two roles in one browser:
 *
 *   1. DECLINE. Tab 1 holds B. Tab 2 opens, presents the browser's token,
 *      collides, and the TV says "not this time". The decline cleared the
 *      claim and left tab 2 connected, roleless and -- crucially -- with no
 *      record at all of the token it had presented. The role picker then
 *      handed it A.
 *   2. ROTATE. Same start, but tab 2 takes the "This isn't my seat" exit,
 *      which mints a FRESH token into the one store both tabs read. Tab 1's
 *      seat is now backed by a token no browser holds any more: when tab 1
 *      drops, reopening the link returns the rotated token and B can never
 *      be reclaimed.
 *
 * The rules this file holds the code to:
 *
 *   R1. A connected peer whose token backs a seat that is live or held is
 *       never assigned a role of its own -- by the picker, by a rejoin's
 *       automatic grant, or by a named reclaim -- including after its claim
 *       has been declined. The only way for it to hold that seat is the
 *       TV-approved handoff.
 *   R2. Rotation is offered only when this browser's token backs no live or
 *       held seat. A token still backing one is never rotated away.
 *   R3. A role is never granted to a seatless claimant: a peer gets a role
 *       only together with a durable token its own store still holds.
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { mayRotateSeat } from "../app/phone/src/app.tsx";
import { mintFreshSeat, seatIdFor } from "../app/phone/src/seat.ts";
import {
  createGame,
  phoneView,
  reduce,
  reduceApp,
  SEAT_GRACE_MS,
  type GameState,
} from "../app/tv/src/game/reducer.ts";

const ROOM = "ABCD";

/**
 * Runs `fn` with `globalThis.indexedDB` pointing at one fresh store, which is
 * what makes two `seatIdFor` calls "two tabs of one browser" rather than two
 * browsers. Restored afterwards, so no test can read another's store.
 */
async function inOneBrowser(fn: (store: IDBFactory) => Promise<void>): Promise<void> {
  const globals = globalThis as { indexedDB?: unknown };
  const original = globals.indexedDB;
  const store = new IDBFactory();
  globals.indexedDB = store;
  try {
    await fn(store);
  } finally {
    if (original === undefined) delete globals.indexedDB;
    else globals.indexedDB = original;
  }
}

/** Tab 1 holding B, tab 2 of the same browser colliding with it. */
async function twoTabsOneBrowser(name: string): Promise<{ state: GameState; token: string }> {
  const seat = await seatIdFor(ROOM);
  let state = createGame("ONE-BROWSER");
  state = reduceApp(state, { k: "phone_join", peerId: "tab-1", name, want: "B", seat: seat.token });
  state = reduceApp(state, { k: "phone_join", peerId: "tab-2", name, seat: seat.token });
  return { state, token: seat.token };
}

function rolesHeld(state: GameState): (string | null)[] {
  return state.players
    .filter((p) => p.role !== null)
    .map((p) => p.role)
    .sort();
}

describe("one browser, one role", () => {
  it("a declined second tab cannot take a role of its own", async () =>
    inOneBrowser(async () => {
      let { state } = await twoTabsOneBrowser("");
      expect(state.pendingReclaim?.peerId).toBe("tab-2");

      state = reduce(state, { k: "decline_reclaim", requestId: state.pendingReclaim!.id });
      state = reduce(state, { k: "assign_role", peerId: "tab-2", role: "A" });

      expect(state.players.find((p) => p.peerId === "tab-2")?.role).toBeNull();
      expect(rolesHeld(state)).toEqual(["B"]);
      expect(state.notice?.text).toContain("already playing as B");
    }));

  it("a declined second tab is not handed a role by rejoining either", async () =>
    inOneBrowser(async () => {
      const { state: joined, token } = await twoTabsOneBrowser("");
      let state = reduce(joined, { k: "decline_reclaim", requestId: joined.pendingReclaim!.id });
      state = reduceApp(state, { k: "phone_join", peerId: "tab-2", name: "", want: "A", seat: token });

      expect(state.players.find((p) => p.peerId === "tab-2")?.role).toBeNull();
      expect(rolesHeld(state)).toEqual(["B"]);
    }));

  it("a declined second tab cannot reach a second role by name either", async () =>
    inOneBrowser(async () => {
      const seat = await seatIdFor(ROOM);
      let state = createGame("ONE-BROWSER-NAME");
      state = reduceApp(state, { k: "phone_join", peerId: "other", name: "Cy", want: "C", seat: "other-token" });
      state = reduceApp(state, { k: "phone_join", peerId: "tab-1", name: "Ada", want: "B", seat: seat.token });
      state = reduceApp(state, { k: "phone_join", peerId: "tab-2", name: "Ada", seat: seat.token });
      state = reduce(state, { k: "decline_reclaim", requestId: state.pendingReclaim!.id });
      // C drops, so a named reclaim has a real target -- one that is NOT this
      // browser's own seat.
      state = reduce(state, { k: "player_left", peerId: "other", at: 1_000 });
      state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "tab-2", name: "Cy" });

      expect(state.pendingReclaim).toBeNull();
      expect(state.notice?.text).toContain("already playing as B");
    }));

  it("the phone is told which role its own browser is already playing", async () =>
    inOneBrowser(async () => {
      const { state: collided } = await twoTabsOneBrowser("");
      expect(phoneView(collided, "tab-2").otherTabRole).toBe("B");
      expect(phoneView(collided, "tab-1").otherTabRole).toBeNull();

      const declined = reduce(collided, {
        k: "decline_reclaim",
        requestId: collided.pendingReclaim!.id,
      });
      // The claim is over; the fact that made it is not.
      expect(phoneView(declined, "tab-2").claimingSeat).toBe(false);
      expect(phoneView(declined, "tab-2").otherTabRole).toBe("B");
    }));

  it("R2: a tab whose browser is already playing is never offered the rotation", async () =>
    inOneBrowser(async () => {
      const { state: collided } = await twoTabsOneBrowser("");
      expect(mayRotateSeat(phoneView(collided, "tab-2"))).toBe(false);
      const declined = reduce(collided, {
        k: "decline_reclaim",
        requestId: collided.pendingReclaim!.id,
      });
      expect(mayRotateSeat(phoneView(declined, "tab-2"))).toBe(false);
    }));

  it("a nameless browser's held seat stays reclaimable through a collision", async () =>
    inOneBrowser(async () => {
      const { state: collided, token: original } = await twoTabsOneBrowser("");
      // The exit the phone actually offers here is no rotation at all, so the
      // browser's store keeps the token tab 1's seat is backed by.
      expect(mayRotateSeat(phoneView(collided, "tab-2"))).toBe(false);
      let state = reduceApp(collided, { k: "phone_release_claim", peerId: "tab-2" });
      expect((await seatIdFor(ROOM)).token).toBe(original);

      state = reduce(state, { k: "player_left", peerId: "tab-1", at: 100 });
      const held = state.players.find((p) => p.peerId === "tab-1");
      expect(held).toMatchObject({ role: "B", connected: false, name: "", seat: original });
      // Reopening the link returns the very token B is held under, so the
      // nameless seat can still ask for itself back.
      const reopened = await seatIdFor(ROOM);
      expect(reopened.token).toBe(original);
      state = reduceApp(state, { k: "phone_join", peerId: "tab-3", name: "", seat: reopened.token });
      // Nothing is playing B, so the token takes the seat on the spot -- no
      // walk to the remote for a browser that only reopened the link.
      expect(state.pendingReclaim).toBeNull();
      expect(state.players.find((p) => p.peerId === "tab-3")).toMatchObject({ role: "B", seat: original });
    }));

  it("R3: a role comes with the token the browser still holds, once nothing else backs it", async () =>
    inOneBrowser(async () => {
      const { state: collided, token } = await twoTabsOneBrowser("");
      let state = reduce(collided, { k: "decline_reclaim", requestId: collided.pendingReclaim!.id });
      // Tab 1 goes for good: its seat is swept, and nothing backs the token
      // any more.
      state = reduce(state, { k: "player_left", peerId: "tab-1", at: 100 });
      state = reduce(state, { k: "sweep_seats", at: 100 + SEAT_GRACE_MS + 1 });
      expect(state.players.some((p) => p.peerId === "tab-1")).toBe(false);

      state = reduce(state, { k: "assign_role", peerId: "tab-2", role: "B" });
      const seated = state.players.find((p) => p.peerId === "tab-2");
      expect(seated?.role).toBe("B");
      // The role and a durable token this browser's own store still holds,
      // together -- not a role on a seatless record.
      expect(seated?.seat).toBe(token);
      expect((await seatIdFor(ROOM)).token).toBe(token);
    }));

  it("R2: rotation is still what it was for a browser backing nothing live or held", async () =>
    inOneBrowser(async () => {
      const first = await seatIdFor(ROOM);
      const rotated = await mintFreshSeat(ROOM);
      expect(rotated.token).not.toBe(first.token);
      expect((await seatIdFor(ROOM)).token).toBe(rotated.token);
    }));
});
