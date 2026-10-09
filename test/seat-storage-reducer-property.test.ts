/**
 * The storage layer and the reducer, together, over one browser's real store.
 *
 * An earlier version's coverage of this proved the property it needed to assume: its
 * fuzz handed every browser one fixed token and never modeled the mint at all,
 * while the token test asserted issuance was atomic and then explicitly
 * expected two tabs to come away with two different tokens. Between the two,
 * nothing composed the storage outcome with what the reducer then did with it
 * -- which is exactly where the defect lived.
 *
 * So this drives BOTH halves for real: `seatIdFor`/`mintFreshSeat` against a
 * real IndexedDB (`fake-indexeddb`, one `IDBFactory` per modeled browser), and
 * every token they produce sent straight at the reducer as a `join`, with no
 * client-side gate anywhere in between. Tabs open (sometimes several at the
 * same instant, racing to mint), drop, reopen, rotate their token, and a
 * separate browser replays a token it captured off the wire. The TV answers
 * requests as they come.
 *
 * Five invariants are checked after every single step:
 *
 *   1. AT MOST ONE LIVE HOLDER PER SEAT -- the reducer's own I1-I15, which
 *      include "at most one connected player carries a given seat token",
 *      "at most one player holds a given role", and "at most one record holds
 *      a role under any given PRESENTED token".
 *   2. NO AUTOMATIC CROSS-PEER TAKEOVER OF A LIVE SEAT -- a role held by a
 *      CONNECTED peer only ever changes hands through `approve_reclaim`. This
 *      is a transition property, so it is checked by comparing consecutive
 *      states, not by reading one.
 *   3. EVERY HELD ROLE STAYS RECLAIMABLE BY ITS TOKEN -- a role held for
 *      someone who stepped away keeps the token that can ask for it back, and
 *      the store of some modeled browser still has that exact token. A NAME
 *      is deliberately NOT accepted in its place: that escape is what let a
 *      rotation strand a nameless seat and still look fine, so nameless
 *      browsers are modeled here and the escape is gone.
 *   4. ALL TABS OF A BROWSER HOLD THE SAME TOKEN -- concurrent first mints
 *      converge, and a rotation is adopted by whatever opens next.
 *   5. AT MOST ONE ROLE PER BROWSER -- two tabs of one browser are one
 *      player, so between them they never hold two roles.
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  checkSeatInvariants,
  createGame,
  playerByPeer,
  reduce,
  reduceApp,
  SEAT_GRACE_MS,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import type { RoleId } from "../app/tv/src/game/validator.ts";
import { mintFreshSeat, seatIdFor } from "../app/phone/src/seat.ts";

/** The same small deterministic PRNG the other seat fuzzes use. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

const ROOM = "ABCD";
const BROWSERS = ["one", "two", "three", "four"] as const;
type BrowserId = (typeof BROWSERS)[number];
/**
 * `three` and `four` join NAMELESS, on purpose. Give every modeled browser a
 * name and invariant 3 can always fall back on "reclaimable by name", never
 * actually testing that a browser still holds the token its own held seat is
 * backed by. A nameless browser has exactly one way back to its seat: the
 * token in its store.
 *
 * Four browsers for three seats, also on purpose: a browser with no role is
 * the only one allowed to rotate its token now, so a model with exactly as
 * many browsers as seats would almost never exercise a rotation at all.
 */
const NAME: Record<BrowserId, string> = { one: "Ada", two: "Bo", three: "", four: "" };

/** One modeled browser: its own IndexedDB, and the tabs currently open on it. */
interface Browser {
  store: IDBFactory;
  /** peer id -> the token that tab read when it last opened or rotated. */
  tabs: Map<string, string>;
}

/**
 * Runs `fn` with `globalThis.indexedDB` pointing at one browser's store, which
 * is what makes two calls "two tabs of the same browser" rather than two
 * browsers. Restored afterwards so one modeled browser can never read
 * another's.
 */
async function inBrowser<T>(browser: Browser, fn: () => Promise<T>): Promise<T> {
  const globals = globalThis as { indexedDB?: unknown };
  const original = globals.indexedDB;
  globals.indexedDB = browser.store;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete globals.indexedDB;
    else globals.indexedDB = original;
  }
}

/** Who holds each role right now, and whether that holder is connected. */
function roleOwners(state: GameState): Map<RoleId, { peerId: string; connected: boolean }> {
  const owners = new Map<RoleId, { peerId: string; connected: boolean }>();
  for (const player of state.players) {
    if (player.role !== null) owners.set(player.role, { peerId: player.peerId, connected: player.connected });
  }
  return owners;
}

/** Every token any modeled browser's store holds right now. */
async function tokensInStores(browsers: Record<BrowserId, Browser>): Promise<Set<string>> {
  const tokens = new Set<string>();
  for (const id of BROWSERS) {
    const seat = await inBrowser(browsers[id], () => seatIdFor(ROOM));
    tokens.add(seat.token);
  }
  return tokens;
}

describe("N tabs over one IndexedDB, straight into the reducer", () => {
  /**
   * One seeded run. `where` names the step for a failure message, because a
   * property violation 40 steps into a seeded sequence is otherwise a puzzle
   * on its own.
   */
  async function run(
    seed: number,
    steps: number,
  ): Promise<{ races: number; replays: number; rotations: number; declines: number }> {
    const rng = mulberry32(seed);
    const browsers: Record<BrowserId, Browser> = {
      one: { store: new IDBFactory(), tabs: new Map() },
      two: { store: new IDBFactory(), tabs: new Map() },
      three: { store: new IDBFactory(), tabs: new Map() },
      four: { store: new IDBFactory(), tabs: new Map() },
    };
    let state: GameState = createGame(`PROP-${seed}`);
    let clock = 0;
    let peerCounter = 0;
    let races = 0;
    let replays = 0;
    let rotations = 0;
    let declines = 0;
    // Tokens seen on the wire, which is all an interceptor would have.
    const onTheWire = new Set<string>();

    async function step(where: string, act: () => Promise<void> | void): Promise<void> {
      const before = roleOwners(state);
      await act();
      const after = roleOwners(state);

      // 1. At most one live holder per seat -- the reducer's whole contract.
      const violations = checkSeatInvariants(state);
      expect(violations, `${where}: ${violations.join(" | ")}`).toEqual([]);

      // 2. No automatic cross-peer takeover of a LIVE seat.
      for (const [role, was] of before) {
        const now = after.get(role);
        if (!was.connected || now === undefined || now.peerId === was.peerId) continue;
        expect(
          where.startsWith("approve"),
          `${where}: role ${role} moved from the connected ${was.peerId} to ${now.peerId} without a TV approval`,
        ).toBe(true);
      }

      // 3. Every held role stays reclaimable BY ITS TOKEN: it keeps a token,
      //    and a browser's store still holds that exact token. The "or it has
      //    a name" escape is deliberately absent -- it is what would let a
      //    rotation abandon the token a seat is held under and still pass.
      const stores = await tokensInStores(browsers);
      for (const player of state.players) {
        if (player.connected || player.role === null) continue;
        expect(player.seat, `${where}: held role ${player.role} has no token to reclaim with`).not.toBeNull();
        expect(
          stores.has(player.seat!),
          `${where}: held role ${player.role} can be reclaimed by nobody -- token ${player.seat} is in no browser's store`,
        ).toBe(true);
      }

      // 5. At most one role per browser. Two tabs of one browser read one
      //    token, so the tokens a browser's tabs have presented are the
      //    browser's own identity -- and no browser ever holds two roles.
      for (const id of BROWSERS) {
        const mine = new Set(browsers[id].tabs.values());
        const held = state.players.filter(
          (p) => p.role !== null && p.presentedSeat !== null && mine.has(p.presentedSeat),
        );
        expect(
          held.length,
          `${where}: browser ${id} holds ${held.length} roles at once (${held
            .map((p) => `${p.peerId}:${p.role}`)
            .join(", ")})`,
        ).toBeLessThanOrEqual(1);
      }
    }

    for (let i = 1; i <= steps; i++) {
      clock += 100 + Math.floor(rng() * 2_000);
      const browserId = pick(rng, BROWSERS);
      const browser = browsers[browserId];
      const kind = Math.floor(rng() * 7);
      const where = `seed ${seed}, step ${i} (${browserId}, kind ${kind})`;

      if (kind === 0 || kind === 1) {
        // One to four tabs of this browser open AT THE SAME MOMENT, each
        // minting through the real storage layer. 4. is checked right here:
        // whatever the transaction scheduling does, they converge on one
        // token -- and each then reaches the reducer as its own connection.
        const howMany = 1 + Math.floor(rng() * 4);
        if (howMany > 1) races += 1;
        const seats = await inBrowser(browser, () =>
          Promise.all(Array.from({ length: howMany }, () => seatIdFor(ROOM))),
        );
        const distinct = new Set(seats.map((s) => s.token));
        expect(
          distinct.size,
          `${where}: ${howMany} tabs of one browser minted ${distinct.size} different tokens`,
        ).toBe(1);
        const token = seats[0]!.token;
        onTheWire.add(token);
        for (const seat of seats) {
          const peerId = `${browserId}-${peerCounter++}`;
          const want = rng() < 0.6 ? (pick(rng, ["A", "B", "C"]) as RoleId) : undefined;
          browser.tabs.set(peerId, seat.token);
          await step(`open ${where}`, () => {
            state = reduceApp(state, {
              k: "phone_join",
              peerId,
              name: NAME[browserId],
              seat: seat.token,
              ...(want !== undefined ? { want } : {}),
            });
          });
        }
        continue;
      }

      if (kind === 2) {
        // A tab closes.
        const open = [...browser.tabs.keys()].filter(
          (peerId) => state.players.find((p) => p.peerId === peerId)?.connected,
        );
        if (open.length === 0) continue;
        const peerId = pick(rng, open);
        await step(`drop ${where}`, () => {
          state = reduce(state, { k: "player_left", peerId, at: clock });
        });
        continue;
      }

      if (kind === 3) {
        // "This isn't my seat": the claim goes, then this browser's token is
        // rotated in a transaction of its own, and the tab re-announces it.
        //
        // Gated exactly as the phone gates it (`mayRotateSeat`, app.tsx): a
        // token that still backs a live or held seat is never rotated away.
        // Rotation replaces the ONE token every tab of this browser reads, so
        // doing it while a seat is held under that token strands the seat.
        // A fuzz that rotates unconditionally and then exempts the identity
        // it has just abandoned cannot see that at all, so there is no
        // exemption here: the model rotates only where the phone would.
        const mine = await inBrowser(browser, () => seatIdFor(ROOM));
        if (state.players.some((p) => p.role !== null && p.seat === mine.token)) continue;
        const open = [...browser.tabs.keys()].filter(
          (peerId) => state.players.find((p) => p.peerId === peerId)?.connected,
        );
        if (open.length === 0) continue;
        const peerId = pick(rng, open);
        await step(`release ${where}`, () => {
          state = reduceApp(state, { k: "phone_release_claim", peerId });
        });
        rotations += 1;
        const fresh = await inBrowser(browser, () => mintFreshSeat(ROOM));
        browser.tabs.set(peerId, fresh.token);
        onTheWire.add(fresh.token);
        await step(`rotate ${where}`, () => {
          state = reduceApp(state, {
            k: "phone_join",
            peerId,
            name: NAME[browserId],
            seat: fresh.token,
          });
        });
        // 4. again, from the other side: a tab opening now reads the rotation.
        const nextTab = await inBrowser(browser, () => seatIdFor(ROOM));
        expect(nextTab.token, `${where}: a rotation was not adopted by the browser`).toBe(fresh.token);
        continue;
      }

      if (kind === 4) {
        // A different browser replays a token it saw on the wire -- the
        // indistinguishable-hijack case, arriving from a store that never
        // minted it.
        const wire = [...onTheWire];
        if (wire.length === 0) continue;
        const stolen = pick(rng, wire);
        const mine = await inBrowser(browser, () => seatIdFor(ROOM));
        if (stolen === mine.token) continue; // this browser's own token, not a replay
        replays += 1;
        const peerId = `replay-${peerCounter++}`;
        await step(`replay ${where}`, () => {
          state = reduceApp(state, { k: "phone_join", peerId, name: "", seat: stolen });
        });
        continue;
      }

      if (kind === 5) {
        // The TV answers whatever is on screen.
        const request = state.pendingReclaim;
        if (!request) continue;
        const approve = rng() < 0.5;
        if (!approve) declines += 1;
        await step(approve ? `approve ${where}` : `decline ${where}`, () => {
          state = reduce(
            state,
            approve
              ? { k: "approve_reclaim", requestId: request.id }
              : { k: "decline_reclaim", requestId: request.id },
          );
        });
        continue;
      }

      // Grace windows run out.
      const jump = rng() < 0.5 ? SEAT_GRACE_MS + 1 : 0;
      await step(`sweep ${where}`, () => {
        state = reduce(state, { k: "sweep_seats", at: clock + jump });
      });
    }

    return { races, replays, rotations, declines };
  }

  it("holds across 100 seeded sequences of 40 steps each: one live holder, no silent takeover, every held role reclaimable by its token, one role per browser", async () => {
    let races = 0;
    let replays = 0;
    let rotations = 0;
    let declines = 0;
    // 100 seeds: only a browser holding no role may rotate, so rotations are
    // rare per seed and the run needs a good many before "a rotation actually
    // happened" is a claim worth making.
    for (let seed = 1; seed <= 100; seed++) {
      const counted = await run(seed, 40);
      races += counted.races;
      replays += counted.replays;
      rotations += counted.rotations;
      declines += counted.declines;
    }
    // Proves the run actually exercised the things it exists for, rather than
    // passing because none of them ever happened. Rotations and declines are
    // counted too: they are the two sequences that put a second role in one
    // browser, and a fuzz that never performs either proves nothing about
    // them.
    expect(races).toBeGreaterThan(100);
    expect(replays).toBeGreaterThan(50);
    expect(rotations).toBeGreaterThan(20);
    expect(declines).toBeGreaterThan(50);
  }, 120_000);
});

/**
 * An earlier version's regression, generalised across random orders.
 *
 * The fuzz above mints a real token for every peer before it ever joins, so
 * it never puts a role-holder in the one state the bug lived in: SEATED, but
 * having never presented a token at all -- an old client, or one that never
 * implemented seat storage. This one models exactly that alongside ordinary
 * token-holding phones, and has some of them replay a DIFFERENT phone's live
 * or held token on a later join under their OWN peer id -- the relabel
 * attempt `seatedAlready` (reducer.ts) guards against regardless of whether
 * the role holder has a `seat` of its own to freeze `presentedSeat` with.
 *
 * Checked after every step: I14 (`checkSeatInvariants`, which also carries
 * I15's "presented a token -> holds a token" rule), a role holder's
 * `presentedSeat` and `role` never move except through a step that is
 * allowed to move them, and a real token-holder's own seat stays reclaimable
 * through the ordinary TV-approved route once it drops and comes back.
 */
describe("a tokenless role holder never relabels itself with another seat's token", () => {
  type PhoneId = "A" | "B" | "C" | "L";
  const PHONES: readonly PhoneId[] = ["A", "B", "C", "L"];
  const TOKEN: Record<PhoneId, string | undefined> = {
    A: "seat-A",
    B: "seat-B",
    C: "seat-C",
    // L never mints a token of its own -- every join from it is tokenless.
    L: undefined,
  };
  const OTHER_TOKENS: Record<PhoneId, string[]> = {
    A: ["seat-B", "seat-C"],
    B: ["seat-A", "seat-C"],
    C: ["seat-A", "seat-B"],
    L: ["seat-A", "seat-B", "seat-C"],
  };

  function run(seed: number, steps: number): { relabelAttempts: number; firstBinds: number } {
    const rng = mulberry32(seed);
    let state: GameState = createGame(`RELABEL-${seed}`);
    let clock = 0;
    let peerCounter = 0;
    let relabelAttempts = 0;
    let firstBinds = 0;
    // L starts permanently tokenless (`TOKEN.L` above), but an earlier version lets a
    // tokenless role holder bind its OWN first, non-colliding token. Once
    // this run's L does that (kind 4, below), every later join/reconnect for
    // L in this run presents that same token -- exactly like a real browser
    // that has since finished minting one.
    let mintedLToken: string | undefined;
    const effectiveToken = (phone: PhoneId): string | undefined =>
      phone === "L" ? mintedLToken : TOKEN[phone];
    const peerIdsByPhone: Record<PhoneId, string[]> = { A: [], B: [], C: [], L: [] };
    const connectedPeerIds = (phone: PhoneId): string[] =>
      peerIdsByPhone[phone].filter((id) => state.players.find((p) => p.peerId === id)?.connected);

    for (let step = 1; step <= steps; step++) {
      clock += 100 + Math.floor(rng() * 2_000);
      const phone = pick(rng, PHONES);
      const where = `seed ${seed}, step ${step} (${phone})`;
      const kind = Math.floor(rng() * 6);

      if (kind === 0) {
        // A fresh join or reconnect under a NEW peer id: presents its own
        // token if it has one (a real reconnect), nothing at all otherwise.
        const peerId = `${phone}-${peerCounter++}`;
        peerIdsByPhone[phone].push(peerId);
        const token = effectiveToken(phone);
        const heldBefore = state.players.find(
          (p) => p.seat === token && !p.connected && p.role !== null,
        );
        const want = rng() < 0.6 ? pick(rng, ["A", "B", "C"] as const) : undefined;
        state = reduceApp(state, {
          k: "phone_join",
          peerId,
          name: "",
          ...(token !== undefined ? { seat: token } : {}),
          ...(want !== undefined ? { want } : {}),
        });
        // Every held role comes straight back to the token that owns it: a
        // real token-holder's own return is given its role on the spot, never
        // silently turned away and never made to wait for a TV that has
        // nothing to decide. This covers L too, once it has minted its own
        // first token below -- the same immediate return under a brand new
        // peer id as any other token holder.
        if (heldBefore) {
          expect(
            state.players.find((p) => p.peerId === peerId)?.role,
            `${where}: ${phone}'s own held seat was not given back on its genuine return`,
          ).toBe(heldBefore.role);
        }
      } else if (kind === 1) {
        const ids = connectedPeerIds(phone);
        if (ids.length > 0) state = reduce(state, { k: "player_left", peerId: pick(rng, ids), at: clock });
      } else if (kind === 2) {
        const jump = rng() < 0.5 ? SEAT_GRACE_MS + 1_000 : 0;
        state = reduce(state, { k: "sweep_seats", at: clock + jump });
      } else if (kind === 3) {
        // The relabel attempt: the SAME connection re-joins presenting a
        // DIFFERENT phone's token -- live or held. Only meaningful for a
        // connection that already exists (a brand new peer id presenting a
        // foreign token is the ordinary claim path, covered elsewhere).
        const ids = connectedPeerIds(phone);
        const peerId = ids.length > 0 ? pick(rng, ids) : undefined;
        if (peerId !== undefined) {
          const before = playerByPeer(state, peerId)!;
          const foreign = pick(rng, OTHER_TOKENS[phone]);
          // Whether "foreign" is actually somebody ELSE's token right now --
          // an earlier version only refuses it while it still is. Its own phone may
          // since have dropped and been swept entirely, in which case
          // nobody owns it any more and a tokenless role holder presenting
          // it is exercising the very same first-token bind as kind 4, not
          // a relabel; the shared `foreign` pool just doubles as its source
          // of "some non-colliding token" once that happens.
          const stillOwnedByAnother = state.players.some(
            (p) =>
              p.peerId !== peerId &&
              p.role !== null &&
              (p.seat === foreign || p.presentedSeat === foreign),
          );
          const isFirstBind = before.role !== null && before.presentedSeat === null && !stillOwnedByAnother;
          if (isFirstBind) firstBinds += 1;
          else relabelAttempts += 1;
          state = reduceApp(state, { k: "phone_join", peerId, name: "", seat: foreign });
          const after = playerByPeer(state, peerId)!;
          if (before.role !== null) {
            expect(
              after.presentedSeat,
              isFirstBind
                ? `${where}: role holder ${peerId}'s own first, non-colliding token (${foreign}) was refused instead of adopted`
                : `${where}: role holder ${peerId}'s presentedSeat changed to a foreign token (${foreign})`,
            ).toBe(isFirstBind ? foreign : before.presentedSeat);
            expect(
              after.role,
              `${where}: role holder ${peerId}'s role changed after presenting a token`,
            ).toBe(before.role);
          }
          // Same bookkeeping as kind 4: once L has actually bound a token,
          // every later join/reclaim for it in this run must present that
          // same one to stay a faithful model of its browser's store.
          if (isFirstBind && phone === "L") mintedLToken = foreign;
        }
      } else if (kind === 4) {
        // L's browser finishes minting its own token and presents it on the
        // SAME connection, on its first opportunity: unlike kind 3, this
        // token collides with nobody (it is not any of A/B/C's), so an earlier version
        // requires it be adopted, not refused.
        if (phone === "L" && mintedLToken === undefined) {
          const ids = connectedPeerIds("L");
          const peerId = ids.length > 0 ? pick(rng, ids) : undefined;
          const before = peerId !== undefined ? playerByPeer(state, peerId) : undefined;
          if (peerId !== undefined && before !== undefined && before.role !== null) {
            const candidate = "seat-L";
            firstBinds += 1;
            state = reduceApp(state, { k: "phone_join", peerId, name: "", seat: candidate });
            const after = playerByPeer(state, peerId)!;
            expect(
              after.presentedSeat,
              `${where}: L's own first, non-colliding token was refused instead of adopted`,
            ).toBe(candidate);
            expect(after.role, `${where}: L's role changed while binding its first token`).toBe(
              before.role,
            );
            mintedLToken = candidate;
          }
        }
      } else {
        const request = state.pendingReclaim;
        if (request) {
          const approve = rng() < 0.7;
          state = reduce(
            state,
            approve
              ? { k: "approve_reclaim", requestId: request.id }
              : { k: "decline_reclaim", requestId: request.id },
          );
        }
      }

      const violations = checkSeatInvariants(state);
      expect(violations, `${where}: ${violations.join(" | ")}`).toEqual([]);
    }
    return { relabelAttempts, firstBinds };
  }

  it("holds across 60 seeded sequences of 30 steps, mixing tokenless and token-holding phones", () => {
    let relabelAttempts = 0;
    let firstBinds = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const counted = run(seed, 30);
      relabelAttempts += counted.relabelAttempts;
      firstBinds += counted.firstBinds;
    }
    // Proves the run actually exercised both the genuine relabel refusal and
    // L's own first-token bind, rather than passing because one of them
    // never happened.
    expect(relabelAttempts).toBeGreaterThan(50);
    expect(firstBinds).toBeGreaterThan(10);
  });
});
