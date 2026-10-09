/**
 * The invariants this file checks, by fuzzing:
 *
 *   A. A phone's PERSISTED token -- what its browser's one IndexedDB store
 *      holds, what `mintFreshSeat` writes to -- equals the token its own
 *      current, live identity holds a role under.
 *   B. No role a phone holds is left backed by a token that phone's storage
 *      no longer has. Checked over EVERY identity of the phone, not just its
 *      most recent one.
 *   C. At most one role per phone, over all its identities at once.
 *
 * `checkSeatInvariants` (reducer.ts) cannot check A or B on its own -- it
 * only ever sees `GameState`, and storage lives on the phone, not the TV.
 * This file models storage explicitly, one entry per phone, and drives it
 * through exactly the sequence the phone itself performs.
 *
 * Name-based `reclaim_seat` is deliberately left out of this fuzz's action
 * mix (`test/seat-invariants-wider-fuzz.test.ts` already covers it under
 * I1-I15): approving one intentionally sets the claimant's `seat` to the
 * RECLAIMED role's own token, not the claimant's own browser's storage --
 * exactly the cross-device recovery the feature is for, and a case A was
 * never meant to hold across. Token-based collisions (an ordinary join whose
 * `seat` matches a live or held seat) stay in the mix: an approved token
 * reclaim there sets `seat` to the token the claimant's OWN storage already
 * held, so A holds straight through it.
 *
 * B IS WHERE A TEMPTING EXEMPTION GOES. It is easy to write this file so a
 * rotating phone is allowed to "abandon whatever other, still-live identity
 * this browser was using under the old token", and to check A against the
 * phone's most recent identity only. That exemption is not a design
 * decision, it is the defect: with a NAMELESS phone, the abandoned identity's
 * seat can then be reclaimed by nobody at all. So rotation is modeled the way
 * the phone actually performs it (`mayRotateSeat`, app.tsx) -- a token that
 * still backs a live or held seat is never rotated away -- and nothing is
 * exempt from B.
 */
import { describe, expect, it } from "vitest";
import {
  checkSeatInvariants,
  createGame,
  phoneView,
  reduce,
  reduceApp,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { mayRotateSeat } from "../app/phone/src/app.tsx";
import { mintSeatId } from "../app/phone/src/seat.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

const PHONES = ["A", "B", "C"] as const;
type PhoneId = (typeof PHONES)[number];
/**
 * C joins NAMELESS. A phone with a name has a second way back to a held seat
 * (`reclaim_seat`), which is exactly what hid the an earlier version defect: with every
 * modeled phone named, a seat stranded by a rotation still looked reachable.
 */
const NAME: Record<PhoneId, string> = { A: "Ada", B: "Bo", C: "" };
const KIND_COUNT = 8;

/**
 * One seeded run. Returns how many rotations it actually exercised, so a run
 * that never rotated is visible rather than silently proving nothing.
 */
function runInterleaving(seed: number, steps: number): number {
  const rng = mulberry32(seed);
  let state: GameState = createGame(`STORE-${seed}`);
  let clock = 0;
  let peerCounter = 0;
  let rotations = 0;

  // The model under test: what each phone's browser storage currently holds.
  const storage: Record<PhoneId, string> = { A: mintSeatId(), B: mintSeatId(), C: mintSeatId() };
  // Which peer id is this phone's CURRENT identity -- the one its own next
  // join or rotation acts through. A phone that drops and later rejoins gets
  // a fresh peer id, same as a real reload.
  const currentPeerId: Record<PhoneId, string | null> = { A: null, B: null, C: null };
  const peerToPhone = new Map<string, PhoneId>();

  const freshPeerId = (phone: PhoneId): string => {
    const id = `${phone}-${peerCounter++}`;
    peerToPhone.set(id, phone);
    currentPeerId[phone] = id;
    return id;
  };

  const assertInvariant = (step: number) => {
    const stored = new Set(PHONES.map((phone) => storage[phone]));
    for (const phone of PHONES) {
      // A. this phone's CURRENT identity holds its role under the token its
      //    own storage holds.
      const peerId = currentPeerId[phone];
      if (peerId !== null) {
        const player = state.players.find((p) => p.peerId === peerId);
        if (player && player.connected && player.role !== null) {
          expect(
            player.seat,
            `seed ${seed}, step ${step}: ${phone}'s current identity (${peerId}) holds role ` +
              `${player.role} under seat ${player.seat}, but its browser's own storage holds ${storage[phone]}`,
          ).toBe(storage[phone]);
        }
      }
      // C. one phone, one role -- counted over EVERY identity this phone has
      //    ever used, not just the newest. Counting only the newest is how a
      //    rotation gets to leave a second role behind unnoticed.
      const mine = state.players.filter(
        (p) => p.role !== null && peerToPhone.get(p.peerId) === phone,
      );
      expect(
        mine.length,
        `seed ${seed}, step ${step}: phone ${phone} holds ${mine.length} roles at once (${mine
          .map((p) => `${p.peerId}:${p.role}`)
          .join(", ")})`,
      ).toBeLessThanOrEqual(1);
    }
    // B. no role is left backed by a token no phone's storage has any more.
    //    A token an approved NAME reclaim moved to another device is out of
    //    scope (see the file comment) -- this fuzz raises none.
    for (const player of state.players) {
      if (player.role === null || player.seat === null) continue;
      expect(
        stored.has(player.seat),
        `seed ${seed}, step ${step}: ${player.peerId} holds ${player.role} under seat ` +
          `${player.seat}, which no phone's storage has any more`,
      ).toBe(true);
    }
    const violations = checkSeatInvariants(state);
    expect(violations, `seed ${seed}, step ${step}: ${violations.join(" | ")}`).toEqual([]);
  };

  assertInvariant(0);

  for (let step = 1; step <= steps; step++) {
    clock += 100 + Math.floor(rng() * 2_000);
    const phone = pick(rng, PHONES);
    const kind = Math.floor(rng() * KIND_COUNT);

    switch (kind) {
      case 0: {
        // An ordinary join -- a newcomer, a reconnect, or a second tab of the
        // same browser -- always carries whatever THIS phone's storage
        // currently holds, exactly what `acquireSeat` reads.
        const peerId = freshPeerId(phone);
        const want = rng() < 0.5 ? pick(rng, ["A", "B", "C"] as const) : undefined;
        state = reduceApp(state, {
          k: "phone_join",
          peerId,
          name: NAME[phone],
          seat: storage[phone],
          ...(want !== undefined ? { want } : {}),
        });
        break;
      }
      case 1: {
        const peerId = currentPeerId[phone];
        if (peerId && state.players.find((p) => p.peerId === peerId)?.connected) {
          state = reduce(state, { k: "player_left", peerId, at: clock });
        }
        break;
      }
      case 2: {
        const jump = rng() < 0.5 ? 30_001 : 0;
        state = reduce(state, { k: "sweep_seats", at: clock + jump });
        break;
      }
      case 3: {
        const peerId = currentPeerId[phone];
        const player = peerId ? state.players.find((p) => p.peerId === peerId) : undefined;
        if (player?.connected && player.role !== null) {
          state = reduceApp(state, { k: "phone_release_role", peerId: player.peerId });
        }
        break;
      }
      case 4:
        // Deliberately not name-based `reclaim_seat` -- see the file
        // comment. Re-rolled as another ordinary join so the kind space
        // stays the same width and every other kind's odds are unchanged.
        state = reduceApp(state, {
          k: "phone_join",
          peerId: freshPeerId(phone),
          name: NAME[phone],
          seat: storage[phone],
        });
        break;
      case 5:
        if (state.pendingReclaim) {
          state = reduce(state, { k: "approve_reclaim", requestId: state.pendingReclaim.id });
        }
        break;
      case 6:
        if (state.pendingReclaim) {
          state = reduce(state, { k: "decline_reclaim", requestId: state.pendingReclaim.id });
        }
        break;
      default: {
        // "This isn't my seat", rotated: release_claim, mint a fresh token
        // (the real `mintSeatId`) into this phone's OWN storage entry, then
        // re-announce -- the exact sequence `handleReleaseClaim` performs.
        //
        // Gated exactly as `mayRotateSeat` gates it: this phone has no role
        // of its own, and no seat anywhere is held under the token about to
        // be replaced. Rotating whenever a claim exists would be precisely
        // backwards -- the token a claim is about is, by definition, one a
        // live or held seat stands behind.
        const peerId = currentPeerId[phone];
        const player = peerId ? state.players.find((p) => p.peerId === peerId) : undefined;
        const tokenBacksASeat = state.players.some(
          (p) => p.role !== null && p.seat === storage[phone],
        );
        if (player?.connected && player.role === null && !tokenBacksASeat) {
          rotations += 1;
          state = reduceApp(state, { k: "phone_release_claim", peerId: player.peerId });
          const fresh = mintSeatId();
          storage[phone] = fresh;
          state = reduceApp(state, { k: "phone_join", peerId: player.peerId, name: NAME[phone], seat: fresh });
        }
        break;
      }
    }

    assertInvariant(step);
  }

  return rotations;
}

describe("a phone's persisted token equals the token its current identity holds a role under", () => {
  // 400 seeds (up from 300, see below) measured at 1.0-1.8s on this machine
  // under a clean run, but Vitest's 5s default is a coin-flip under this
  // machine's actual load (many concurrent sessions) rather than a real
  // regression signal. 30s is generous enough that only a genuine slowdown
  // trips it, matching the pattern `seat-invariants-wider-fuzz.test.ts`
  // already uses for its own heaviest run.
  it(
    "holds across 400 seeded sequences of 60 steps each, storage modeled explicitly",
    { timeout: 60_000 },
    () => {
      let rotations = 0;
      for (let seed = 1; seed <= 400; seed++) {
        rotations += runInterleaving(seed, 60);
      }
      // Checked after every step, but only proves something if rotation --
      // this file's own mechanism under test -- was actually exercised many
      // times. A live collision now supersedes outright instead of leaving a
      // roleless claimant to rotate away from, so rotation fires less often
      // than it used to -- 400 seeds (up from 300) restores the same margin.
      expect(rotations).toBeGreaterThan(50);
    },
  );

  it("the pinned case: a phone whose token is being played elsewhere is not offered the rotation, and that seat still comes back to it", () => {
    let state = createGame("PINNED-COLLISION-ROTATE");
    const storage: Record<PhoneId, string> = { A: mintSeatId(), B: mintSeatId(), C: "unused" };
    // A and B join and are seated live -- C is the room's only free role. A
    // is NAMELESS, so its token is the only thing that can ever get its seat
    // back.
    state = reduceApp(state, { k: "phone_join", peerId: "A-1", name: "", seat: storage.A });
    state = reduceApp(state, { k: "phone_join", peerId: "B-1", name: "Bo", seat: storage.B });
    // A second tab of A's OWN browser opens while A-1 is still playing,
    // presenting the same storage token: a live-seat collision, which waits
    // on the TV.
    state = reduceApp(state, { k: "phone_join", peerId: "A-2", name: "", seat: storage.A });
    expect(state.players.find((p) => p.peerId === "A-2")?.role).toBeNull();
    expect(state.players.find((p) => p.peerId === "A-2")?.claimedSeat).toBe(storage.A);

    // This tab cannot say "This isn't my seat" and rotate: the token it would
    // replace is the one A's held seat is held under, and a nameless seat has
    // nothing else to be reclaimed by. The phone is told what is actually
    // true instead, and is offered no rotation at all.
    expect(phoneView(state, "A-2").otherTabRole).toBe("A");
    expect(mayRotateSeat(phoneView(state, "A-2"))).toBe(false);

    // Even walking away from the claim leaves the browser's one token where
    // it was, and leaves this tab roleless: it is the same phone as the seat
    // it collided with, and C is not a second seat for it.
    state = reduceApp(state, { k: "phone_release_claim", peerId: "A-2" });
    state = reduceApp(state, { k: "phone_join", peerId: "A-2", name: "", want: "C" });
    expect(state.players.find((p) => p.peerId === "A-2")?.role).toBeNull();
    expect(state.players.find((p) => p.peerId === "A-1")).toMatchObject({
      role: "A",
      connected: true,
      seat: storage.A,
    });

    // A-1's own connection then goes, and the seat is nobody's. The only
    // thing that can reach it is the token this browser still has, and that
    // is enough on its own: the seat comes back to it.
    state = reduce(state, { k: "player_left", peerId: "A-1", at: 500 });
    state = reduceApp(state, { k: "phone_join", peerId: "A-3", name: "", seat: storage.A });
    expect(state.pendingReclaim).toBeNull();
    expect(state.players.find((p) => p.peerId === "A-3")).toMatchObject({ role: "A", seat: storage.A });
    // And the browser still holds exactly one role.
    expect(state.players.filter((p) => p.role !== null && p.presentedSeat === storage.A)).toHaveLength(1);
  });
});

/**
 * The TV is the sole authority for "one live connection per seat" -- there is
 * no client-side gate any more (no Web Locks, no heartbeat lease, no
 * `waitForFreePlayerSlot`), so every tab a phone's browser opens is modeled as
 * a real `join` sent straight at the reducer, live or not, exactly as an
 * actual second tab or a replayed token would arrive on the wire. This fuzz
 * asks the question the old client-side gate used to answer by construction:
 * with EVERY tab actually reaching the reducer, does it still hold that only
 * one CONNECTED player ever carries a given seat token (I13), and does the
 * newest one always win?
 */
describe("every tab reaches the reducer -- the TV alone enforces one live connection per seat", () => {
  /**
   * One seeded run. Every `case 0` opens ANOTHER tab for the picked phone and
   * sends its `join` unconditionally -- no gate, no check of whether this
   * phone already has a live tab open. `liveTab[phone]` tracks only which
   * peer id the fuzz itself last saw win the seat (the newest join, or a
   * TV-approved reclaim), so its own drop/reclaim steps still act through a
   * real, currently-connected identity; it is bookkeeping for the fuzz, not a
   * gate the reducer is ever told about.
   */
  function runTabsInterleaving(seed: number, steps: number): { overlaps: number } {
    const rng = mulberry32(seed);
    let state: GameState = createGame(`TABS-${seed}`);
    let clock = 0;
    let peerCounter = 0;
    let overlaps = 0; // a join fired while a DIFFERENT connected peer already held this phone's own token.

    const storage: Record<PhoneId, string> = { A: mintSeatId(), B: mintSeatId(), C: mintSeatId() };
    const liveTab: Record<PhoneId, string | null> = { A: null, B: null, C: null };

    for (let step = 1; step <= steps; step++) {
      clock += 100 + Math.floor(rng() * 2_000);
      const phone = pick(rng, PHONES);
      const kind = Math.floor(rng() * 6);

      switch (kind) {
        case 0: {
          // Another tab opens for this phone's room and joins unconditionally --
          // whether or not a previous tab of the same browser is still live.
          // A still-connected prior tab makes this a live collision: the
          // reducer, not the fuzz, decides what happens to it.
          const priorPeerId = liveTab[phone];
          const priorWasConnected =
            priorPeerId !== null && state.players.find((p) => p.peerId === priorPeerId)?.connected === true;
          if (priorWasConnected) overlaps += 1;
          const peerId = `${phone}-${peerCounter++}`;
          const want = rng() < 0.5 ? pick(rng, PHONES) : undefined;
          state = reduceApp(state, {
            k: "phone_join",
            peerId,
            name: NAME[phone],
            seat: storage[phone],
            ...(want !== undefined ? { want } : {}),
          });
          // The newer tab is always the one the fuzz tracks going forward,
          // whether it just superseded a live sibling or is simply the
          // latest reconnect of an already-held seat.
          liveTab[phone] = peerId;
          break;
        }
        case 1: {
          // The tracked tab closes (or drops) -- an ordinary disconnect.
          const peerId = liveTab[phone];
          if (peerId && state.players.find((p) => p.peerId === peerId)?.connected) {
            state = reduce(state, { k: "player_left", peerId, at: clock });
          }
          break;
        }
        case 2: {
          const jump = rng() < 0.5 ? 30_001 : 0;
          state = reduce(state, { k: "sweep_seats", at: clock + jump });
          break;
        }
        case 3: {
          const peerId = liveTab[phone];
          const player = peerId ? state.players.find((p) => p.peerId === peerId) : undefined;
          if (player?.connected && player.role !== null) {
            state = reduceApp(state, { k: "phone_release_role", peerId: player.peerId });
          }
          break;
        }
        default:
          if (state.pendingReclaim) {
            const requesterId = state.pendingReclaim.peerId;
            state = reduce(
              state,
              rng() < 0.5
                ? { k: "approve_reclaim", requestId: state.pendingReclaim.id }
                : { k: "decline_reclaim", requestId: state.pendingReclaim.id },
            );
            const requesterPhone = PHONES.find((p) => liveTab[p] === requesterId);
            if (requesterPhone) liveTab[requesterPhone] = requesterId;
          }
          break;
      }

      // I13, straight from the reducer's own written-down contract: at most
      // one CONNECTED player ever carries a given seat token. This is the
      // property the removed client-side gate used to enforce by never
      // letting the reducer see the second join at all -- now the reducer
      // enforces it itself, against every tab this fuzz actually sends.
      const violations = checkSeatInvariants(state);
      expect(violations, `seed ${seed}, step ${step}: ${violations.join(" | ")}`).toEqual([]);
      // A supersede always names the peer id it replaced, and that peer id
      // is gone from `state.players` -- never left behind as a second,
      // still-connected record under the same token.
      if (state.superseded) {
        expect(
          state.players.some((p) => p.peerId === state.superseded!.peerId),
          `seed ${seed}, step ${step}: superseded peer id ${state.superseded.peerId} is still a player record`,
        ).toBe(false);
      }
    }

    return { overlaps };
  }

  it(
    "holds across 200 seeded sequences of 60 steps each, every tab live: I13 never breaks, and supersede always clears the loser",
    { timeout: 30_000 },
    () => {
    let overlaps = 0;
    for (let seed = 1; seed <= 200; seed++) {
      overlaps += runTabsInterleaving(seed, 60).overlaps;
    }
    // Proves this fuzz is actually exercising overlapping tabs -- unlike the
    // gated model this replaces, where a live collision could never occur at
    // all because the second tab never reached the reducer.
    expect(overlaps).toBeGreaterThan(50);
  });

  it("pinned: a live second tab takes nothing until the TV says so, and a seat nobody is playing comes straight back once the browser reopens", () => {
    let state = createGame("PINNED-ONE-PLAYER");
    const token = mintSeatId();
    // The browser's first tab joins and is seated.
    state = reduceApp(state, { k: "phone_join", peerId: "A-1", name: "Ada", seat: token });
    expect(state.players.find((p) => p.peerId === "A-1")?.role).toBe("A");

    // A second tab of the SAME browser opens WHILE the first is still live,
    // presenting the same persisted token -- sent straight to the reducer,
    // no client-side gate in the way. The first tab keeps the seat, and the
    // room is asked before anything moves.
    state = reduceApp(state, { k: "phone_join", peerId: "A-2", name: "Ada", seat: token });
    expect(state.players.find((p) => p.peerId === "A-2")?.role).toBeNull();
    expect(state.players.find((p) => p.peerId === "A-1")?.role).toBe("A");
    expect(state.superseded).toBeNull();
    expect(state.pendingReclaim).toMatchObject({ peerId: "A-2", role: "A", via: "token" });

    // The TV hands it over -- and only then is the first tab closed.
    state = reduce(state, { k: "approve_reclaim", requestId: state.pendingReclaim!.id });
    expect(state.players.find((p) => p.peerId === "A-2")?.role).toBe("A");
    expect(state.players.some((p) => p.peerId === "A-1")).toBe(false);
    expect(state.superseded).toMatchObject({ peerId: "A-1" });

    // The second tab closes: the role drops into its grace window.
    state = reduce(state, { k: "player_left", peerId: "A-2", at: 1_000 });
    expect(state.players.find((p) => p.role === "A")?.connected).toBe(false);

    // A third tab -- now the only one open -- claims the slot and presents
    // the SAME persisted token, under a new peer id (an ordinary reconnect
    // after a reload).
    state = reduceApp(state, { k: "phone_join", peerId: "A-3", name: "Ada", seat: token });
    const reclaiming = state.players.find((p) => p.peerId === "A-3");
    // A seat nobody is playing hands itself back on the token alone -- it is
    // the seat this browser always held, and nothing else stands behind the
    // token, so there is no question for the TV to answer.
    expect(reclaiming?.claimedSeat).toBeNull();
    expect(reclaiming?.role).toBe("A");
    expect(state.pendingReclaim).toBeNull();
  });
});
