/**
 * `checkSeatInvariants` (reducer.ts) is the state machine's own written-down
 * contract -- I1 through I11, documented right above the function itself. I9's
 * own fuzz -- `runSwitchInterleaving`, below -- is kept separate from this one;
 * see its comment for the measured reason. This file is what actually holds the
 * contract to account: thousands of random intent sequences, over 3-5 peers,
 * with `assign_role`/`choose_role` as its own action kind, and
 * `checkSeatInvariants(state)` asserted empty after *every* single step, not
 * just at checkpoints.
 *
 * `test/seat-invariants-fuzz.test.ts` is untouched and still runs: its own
 * invariants (a strict subset of I1-I4, checked by hand rather than through the
 * exported function) and its own invariant 6 (only `approve_reclaim` moves a
 * role between peers) are a second, narrower sweep of the seat model, not
 * superseded by this file.
 *
 * A seeded PRNG keeps every run reproducible: a failure prints the seed and
 * step that found it, and re-running `runInterleaving(seed, steps)` alone
 * reproduces it.
 */
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  TV_PEER,
  asProtocolRole,
  availableActions,
  checkSeatInvariants,
  createGame,
  isConnected,
  reduce,
  reduceApp,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { seatRoles } from "../app/tv/src/game/mysteries.ts";

/** Mulberry32: small, fast, and deterministic for a given seed. */
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

const ALL_PHONES = ["A", "B", "C", "D", "E"] as const;
type PhoneId = (typeof ALL_PHONES)[number];
const TOKEN: Record<PhoneId, string> = { A: "seat-A", B: "seat-B", C: "seat-C", D: "seat-D", E: "seat-E" };
/** An id no request can carry: real ones always end in `:<digits>`. */
const STALE_REQUEST_ID = "not-the-request-on-screen";

/**
 * The TV answering the reclaim request on screen -- or, half the time, a press
 * aimed at a request that is not the one on screen (a stale id, or a press with
 * nothing waiting). Those must decide nothing at all: no role may move, and the
 * request that IS on screen must still be waiting for its answer.
 */
function decideReclaim(
  state: GameState,
  seed: number,
  step: number,
  rng: () => number,
  k: "approve_reclaim" | "decline_reclaim",
): GameState {
  const target = state.pendingReclaim;
  const aimed = target !== null && rng() < 0.5 ? target.id : STALE_REQUEST_ID;
  const before = state;
  const after = reduce(state, { k, requestId: aimed });
  if (target === null || aimed !== target.id) {
    expect(
      roleHolders(after),
      `seed ${seed}, step ${step}: a ${k} that named no request on screen still moved a role`,
    ).toEqual(roleHolders(before));
    expect(after.pendingReclaim).toBe(target);
  }
  return after;
}

const NAME: Record<PhoneId, string> = { A: "Ada", B: "Bo", C: "Cy", D: "Dee", E: "Eli" };

/**
 * Invariant 6's key: which peer id holds each ROLE, right now -- not which peer
 * id holds each SEAT TOKEN. This harness has `assign_role`, so keying by `seat`
 * would be wrong: a TV can hand any connected player any free role, unrelated
 * to whatever seat token it happens to carry from an unrelated earlier
 * collision. Keying by `seat` reads a SECOND, unrelated role newly landing on a
 * token-sharing peer as if the FIRST role had moved -- a false positive this
 * file's own first draft hit at seed 25, step 74 (D-8 was legitimately assigned
 * role B while D-3, unrelated, still held role C -- both merely happened to
 * share `seat-D` from an earlier collision). Keying by role is what I5 actually
 * claims.
 */
function roleHolders(state: GameState): Map<string, string> {
  const map = new Map<string, string>();
  for (const player of state.players) {
    if (player.role !== null) map.set(player.role, player.peerId);
  }
  return map;
}

/** The roles whose holder is CONNECTED right now -- the ones somebody is playing. */
function liveRoleHolders(state: GameState): Set<string> {
  const live = new Set<string>();
  for (const player of state.players) {
    if (player.role !== null && player.connected) live.add(player.role);
  }
  return live;
}

const ACTION_KINDS = 11;

/** Returns how many steps found a claimant to walk away from, so a run that never built one is visible. */
function runInterleaving(seed: number, steps: number): number {
  const rng = mulberry32(seed);
  // 3, 4 or 5 peers, chosen by the seed itself -- not a fixed three.
  const peerCount = 3 + (seed % 3);
  const phones: PhoneId[] = ALL_PHONES.slice(0, peerCount);

  let state = createGame(`ROOM-${seed}`);
  let clock = 0;
  let peerCounter = 0;
  let claimantSteps = 0;
  const peerIdsByPhone: Record<PhoneId, string[]> = { A: [], B: [], C: [], D: [], E: [] };

  const freshPeerId = (phone: PhoneId): string => {
    const id = `${phone}-${peerCounter++}`;
    peerIdsByPhone[phone].push(id);
    return id;
  };
  const connectedPeerIds = (phone: PhoneId): string[] =>
    peerIdsByPhone[phone].filter((id) => state.players.find((p) => p.peerId === id)?.connected);

  const roles = seatRoles(state.puzzle);

  const assertNow = (step: number) => {
    const violations = checkSeatInvariants(state);
    expect(violations, `seed ${seed}, step ${step}: ${violations.join(" | ")}`).toEqual([]);
  };

  assertNow(0);

  for (let step = 1; step <= steps; step++) {
    clock += 100 + Math.floor(rng() * 2_000);
    const phone = pick(rng, phones);
    const kind = Math.floor(rng() * ACTION_KINDS);
    const rolesBefore = roleHolders(state);
    const liveRolesBefore = liveRoleHolders(state);

    switch (kind) {
      case 0: {
        // A join -- a genuine newcomer, a grace-window reconnect under a new
        // peer id, a second tab, or a replayed token -- indistinguishable on
        // the wire, and all three are exactly what this fuzz is for.
        const peerId = freshPeerId(phone);
        const want = rng() < 0.5 ? pick(rng, roles) : undefined;
        state = reduceApp(state, {
          k: "phone_join",
          peerId,
          name: NAME[phone],
          seat: TOKEN[phone],
          ...(want !== undefined ? { want } : {}),
        });
        break;
      }
      case 1: {
        const ids = connectedPeerIds(phone);
        if (ids.length > 0) {
          state = reduce(state, { k: "player_left", peerId: pick(rng, ids), at: clock });
        }
        break;
      }
      case 2: {
        const jump = rng() < 0.5 ? SEAT_GRACE_MS + 1_000 : 0;
        state = reduce(state, { k: "sweep_seats", at: clock + jump });
        break;
      }
      case 3: {
        const holder = connectedPeerIds(phone).find(
          (id) => state.players.find((p) => p.peerId === id)?.role !== null,
        );
        if (holder) state = reduceApp(state, { k: "phone_release_role", peerId: holder });
        break;
      }
      case 4: {
        const roleless = connectedPeerIds(phone).find(
          (id) => state.players.find((p) => p.peerId === id)?.role === null,
        );
        if (roleless) {
          state = reduceApp(state, {
            k: "phone_reclaim_seat",
            peerId: roleless,
            name: pick(rng, Object.values(NAME)),
          });
        }
        break;
      }
      case 5:
        state = decideReclaim(state, seed, step, rng, "approve_reclaim");
        break;
      case 6:
        state = decideReclaim(state, seed, step, rng, "decline_reclaim");
        break;
      case 7: {
        // `assign_role`/`choose_role` sent to ANY connected peer,
        // whether or not it currently carries a live claim. The case that
        // matters -- landing on a claimant -- happens often enough on its own
        // across thousands of steps without needing to force it; the pinned
        // regressions below force it directly, once each.
        const ids = phones.flatMap((p) => connectedPeerIds(p));
        if (ids.length > 0) {
          const peerId = pick(rng, ids);
          const role = pick(rng, roles);
          state = reduce(state, { k: "assign_role", peerId, role });
        }
        break;
      }
      case 8: {
        const actions = availableActions(state.puzzle, state.play);
        if (actions.length > 0) {
          const entry = pick(rng, actions);
          const capabilities = state.puzzle.roles.find((r) => r.id === entry.performer)?.capabilities ?? [];
          const controller = capabilities.includes("dpad")
            ? TV_PEER
            : state.players.find((p) => p.role === entry.performer && p.connected)?.peerId;
          if (controller) {
            state = reduce(state, { k: "choose_action", peerId: controller, actionId: entry.actionId });
          }
        }
        break;
      }
      case 9: {
        // "This isn't my seat": a claimant saying the seat is not theirs. The
        // exit I12 requires, taken at random rather than only in the pinned
        // cases -- a claim that cannot be dropped is the whole defect, so the
        // fuzz has to try dropping one.
        const claimants = phones
          .flatMap((p) => connectedPeerIds(p))
          .filter((id) => state.players.find((p) => p.peerId === id)?.claimedSeat !== null);
        if (claimants.length > 0) {
          claimantSteps += 1;
          state = reduceApp(state, { k: "phone_release_claim", peerId: pick(rng, claimants) });
        }
        break;
      }
      default: {
        if (state.pending[TV_PEER]) {
          state = reduce(state, { k: "choose_option", peerId: TV_PEER, option: Math.floor(rng() * 4) });
        }
        break;
      }
    }

    // Invariant 6, held across the wider fuzz: a ROLE only ever moves to a
    // DIFFERENT peer id as the direct result of `approve_reclaim` (kind 5) or
    // an ordinary join (kind 0) -- never a drop, a sweep, or an
    // `assign_role`, which can only ever grant a role that is free (or a
    // no-op on the same peer). A join moves it in exactly two ways: taking a
    // role off a peer that is PLAYING it, which the TV must have named as
    // superseding that connection; or taking back a role whose holder had
    // gone, which supersedes nobody, because there is nobody to supersede.
    const rolesAfter = roleHolders(state);
    for (const [role, peerIdBefore] of rolesBefore) {
      const peerIdAfter = rolesAfter.get(role);
      if (peerIdAfter !== undefined && peerIdAfter !== peerIdBefore) {
        if (kind === 0) {
          if (liveRolesBefore.has(role)) {
            expect(
              state.superseded?.peerId,
              `seed ${seed}, step ${step}: role ${role} moved from ${peerIdBefore} to ${peerIdAfter} while ${peerIdBefore} was still playing it, without the TV naming that connection`,
            ).toBe(peerIdBefore);
          } else {
            expect(
              state.players.find((p) => p.peerId === peerIdBefore)?.role ?? null,
              `seed ${seed}, step ${step}: role ${role} moved to ${peerIdAfter} but ${peerIdBefore} was still holding it`,
            ).toBeNull();
          }
        } else {
          expect(
            kind,
            `seed ${seed}, step ${step}: role ${role} moved from ${peerIdBefore} to ${peerIdAfter} on a step that was neither approve_reclaim nor a live-supersede join (kind ${kind})`,
          ).toBe(5);
        }
      }
    }

    assertNow(step);
  }

  return claimantSteps;
}

describe("checkSeatInvariants holds across a wider seeded fuzz", () => {
  // This ran on Vitest's 5 s default and measured 3.9-5.5 s across clean runs:
  // two full-suite runs timed out at 5.48 s and 5.05 s, and a passing run took
  // 4.997 s. That is a coin-flip on the machine's load, not a test. 30 s was
  // the first fix for it and 30 s was still not enough: under a full parallel
  // suite this test measured 8.7 s alone and 37.7 s contended, and timed out
  // against that cap. 120 s is ~3x the contended worst case: generous enough
  // that only a real slowdown trips it, and it still fails loudly instead of
  // hanging. The fuzz itself is unchanged.
  it(
    "survives 1000 seeded sequences of 150 steps each, 3-5 peers, assign_role included (150,000 steps)",
    { timeout: 120_000 },
    () => {
      let claimantSteps = 0;
      for (let seed = 1; seed <= 1000; seed++) {
        claimantSteps += runInterleaving(seed, 150);
      }
      // I12 is checked after every one of those steps, but an invariant that
      // is only ever checked against states with no claimant in them proves
      // nothing. This is the guard against that: the exit has to have been
      // taken, at random, many times over.
      expect(claimantSteps).toBeGreaterThan(100);
    },
  );
});

/**
 * The switch's own seeded fuzz, kept BESIDE the wider one above rather than
 * folded into it, for a measured reason. One `request_input_change` runs the
 * recompiler end to end -- 21.6 ms per request on this machine -- so at the
 * wider fuzz's 150,000 steps even a 1-in-60 share of
 * requests would add roughly a minute to the suite. This fuzz spends its
 * budget where the class actually lives (a request, a random perturbation to
 * the seat that made it, then a resolution) and runs an order of magnitude
 * fewer steps for it. It holds the SAME contract as the wider one: I1-I9,
 * asserted after every single step.
 */
const SWITCH_KINDS = 9;

function runSwitchInterleaving(seed: number, steps: number): void {
  const rng = mulberry32(seed);
  const peerCount = 3 + (seed % 3);
  const phones: PhoneId[] = ALL_PHONES.slice(0, peerCount);

  let state = createGame(`SWITCH-${seed}`);
  let clock = 0;
  let peerCounter = 0;
  const peerIdsByPhone: Record<PhoneId, string[]> = { A: [], B: [], C: [], D: [], E: [] };

  const freshPeerId = (phone: PhoneId): string => {
    const id = `${phone}-${peerCounter++}`;
    peerIdsByPhone[phone].push(id);
    return id;
  };
  const connectedPeerIds = (phone: PhoneId): string[] =>
    peerIdsByPhone[phone].filter((id) => state.players.find((p) => p.peerId === id)?.connected);

  const roles = seatRoles(state.puzzle);

  const assertNow = (step: number) => {
    const violations = checkSeatInvariants(state);
    expect(violations, `seed ${seed}, step ${step}: ${violations.join(" | ")}`).toEqual([]);
  };

  // Seated up front: `request_input_change` is playing-only, so a fuzz that
  // starts in the lobby would spend its first steps
  // discovering that rather than exercising I9.
  for (const phone of phones) {
    state = reduceApp(state, {
      k: "phone_join",
      peerId: freshPeerId(phone),
      name: NAME[phone],
      seat: TOKEN[phone],
    });
  }
  expect(state.phase).toBe("playing");

  assertNow(0);

  for (let step = 1; step <= steps; step++) {
    clock += 100 + Math.floor(rng() * 2_000);
    const phone = pick(rng, phones);
    const kind = Math.floor(rng() * SWITCH_KINDS);

    switch (kind) {
      case 0: {
        // The request itself, mirrored after the reducer's own gate: only a
        // role holder that is connected right now can ask, so the fuzz spends
        // its recompiles on sequences that really do raise a switch.
        const holder = state.players.find((p) => p.connected && p.role !== null);
        const role = holder ? asProtocolRole(holder.role) : null;
        if (holder && role && state.phase === "playing") {
          state = reduce(state, {
            k: "request_input_change",
            role,
            capabilities: [pick(rng, ["scan", "voice", "dpad"] as const)],
          });
        }
        break;
      }
      case 1:
        state = reduce(state, { k: "switch_dismiss" });
        break;
      case 2:
        state = reduce(state, { k: "switch_beat" });
        break;
      case 3: {
        // Only the asking role's own phone may skip its moment.
        const pending = state.pendingSwitch;
        const peerId = pending
          ? state.players.find((p) => p.role === pending.role && p.connected)?.peerId
          : undefined;
        if (peerId) state = reduceApp(state, { k: "phone_continue_switch", peerId });
        break;
      }
      case 4: {
        const ids = phones.flatMap((p) => connectedPeerIds(p));
        if (ids.length > 1) state = reduce(state, { k: "player_left", peerId: pick(rng, ids), at: clock });
        break;
      }
      case 5: {
        const jump = rng() < 0.5 ? SEAT_GRACE_MS + 1_000 : 0;
        state = reduce(state, { k: "sweep_seats", at: clock + jump });
        break;
      }
      case 6: {
        // A reconnect (same token, new peer id), a second tab, or a genuine
        // newcomer -- indistinguishable on the wire, and all three matter to
        // who ends up holding the role a switch is pending for.
        const want = rng() < 0.5 ? pick(rng, roles) : undefined;
        state = reduceApp(state, {
          k: "phone_join",
          peerId: freshPeerId(phone),
          name: NAME[phone],
          seat: TOKEN[phone],
          ...(want !== undefined ? { want } : {}),
        });
        break;
      }
      case 7:
        state = decideReclaim(state, seed, step, rng, "approve_reclaim");
        break;
      default:
        state = decideReclaim(state, seed, step, rng, "decline_reclaim");
        break;
    }

    assertNow(step);
  }
}

describe("I9 (a pending switch still belongs to the seat that asked) across a seeded fuzz", () => {
  // 100 x 30 is a size chosen from measurement, not a round number: this
  // machine timed 150 x 30 at 6638 ms and 100 x 30 at 5271 ms (one run each,
  // `npx vitest run test/seat-invariants-wider-fuzz.test.ts`). This
  // file dominates the suite's wall-clock either way, and a second of suite
  // wall-clock has to buy coverage to be worth it -- 100 independent
  // sequences is where that trade stopped paying. Measured 6.7 s alone and
  // 12.9 s under a full parallel suite, so it gets the same kind of headroom
  // as the fuzz above rather than the 5 s default.
  it(
    "survives 100 seeded sequences of 30 steps each, requests interleaved with drops, sweeps and re-seats",
    { timeout: 60_000 },
    () => {
      for (let seed = 1; seed <= 100; seed++) {
        runSwitchInterleaving(seed, 30);
      }
    },
  );
});

/**
 * The five pinned regressions.
 *
 * Distinct from the fuzz above: these are the exact scenarios that used to
 * break, walked step by step, not just scenarios the random search happens to
 * cover.
 */
describe("the five pinned regressions", () => {
  it("reducer.ts:887 -- a claimant's repeated join never duplicates the contested token into a second seat", () => {
    let state = createGame("ROOM-887");
    state = reduceApp(state, { k: "phone_join", peerId: "A-1", name: "Ada", seat: "seat-A" });
    state = reduceApp(state, { k: "phone_join", peerId: "B-1", name: "Bo", seat: "seat-B" });
    // B's live seat collides -- a second tab presenting the same token while
    // the original is still connected. It takes nothing: B-1 keeps the role
    // and B-2 waits on the TV, which then hands it over.
    state = reduceApp(state, { k: "phone_join", peerId: "B-2", name: "Bo", seat: "seat-B" });
    expect(state.players.find((p) => p.peerId === "B-2")?.role).toBeNull();
    expect(state.players.find((p) => p.peerId === "B-1")?.role).toBe("B");
    expect(state.players.filter((p) => p.seat === "seat-B")).toHaveLength(1);
    // The claimant replays the SAME join again, mid-claim -- idempotent,
    // never a second record and never a duplicated token.
    state = reduceApp(state, { k: "phone_join", peerId: "B-2", name: "Bo", seat: "seat-B" });
    expect(state.players.filter((p) => p.seat === "seat-B")).toHaveLength(1);
    expect(state.players.filter((p) => p.claimedSeat === "seat-B")).toHaveLength(1);
    expect(checkSeatInvariants(state)).toEqual([]);

    state = reduce(state, { k: "approve_reclaim", requestId: state.pendingReclaim!.id });
    expect(state.players.find((p) => p.peerId === "B-2")?.role).toBe("B");
    expect(state.players.some((p) => p.peerId === "B-1")).toBe(false);
    // And again once it actually holds the seat -- still idempotent.
    state = reduceApp(state, { k: "phone_join", peerId: "B-2", name: "Bo", seat: "seat-B" });
    expect(state.players.filter((p) => p.seat === "seat-B")).toHaveLength(1);
    expect(state.players.find((p) => p.peerId === "B-2")?.role).toBe("B");
    // B-2's own connection then goes, and a third connection presents the
    // same token. Nobody is playing B any more, so the seat hands itself
    // back -- and the join replayed again must be idempotent, which is the
    // duplication this pins: no second record under the token, no second
    // holder of the role, and no claimant record left over from the contest
    // that has just ended.
    state = reduce(state, { k: "player_left", peerId: "B-2", at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "B-3", name: "Bo", seat: "seat-B" });
    expect(state.players.find((p) => p.peerId === "B-3")?.role).toBe("B");
    expect(state.pendingReclaim).toBeNull(); // nobody is playing it, so nothing to answer
    state = reduceApp(state, { k: "phone_join", peerId: "B-3", name: "Bo", seat: "seat-B" });
    expect(state.players.filter((p) => p.seat === "seat-B")).toHaveLength(1);
    expect(state.players.filter((p) => p.role === "B")).toHaveLength(1);
    expect(state.players.filter((p) => p.claimedSeat === "seat-B")).toHaveLength(0);
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("reducer.ts:1135 -- assign_role (choose_role) refuses a player with a live claimedSeat", () => {
    let state = createGame("ROOM-1135");
    state = reduceApp(state, { k: "phone_join", peerId: "A-1", name: "Ada", seat: "seat-A" });
    state = reduceApp(state, { k: "phone_join", peerId: "B-1", name: "Bo", seat: "seat-B" });
    state = reduceApp(state, { k: "phone_join", peerId: "C-1", name: "Cy", seat: "seat-C" });
    // B is PLAYING; a claimant presents B's token and is left roleless,
    // waiting on the TV.
    state = reduceApp(state, { k: "phone_join", peerId: "B-2", name: "Bo", seat: "seat-B" });
    expect(state.players.find((p) => p.peerId === "B-2")?.claimedSeat).toBe("seat-B");
    // The repro: send choose_role (assign_role) straight at the
    // claimant, mid-collision, before the TV has decided anything.
    state = reduce(state, { k: "assign_role", peerId: "B-2", role: "B" });
    expect(state.players.find((p) => p.peerId === "B-2")?.role).toBeNull();
    expect(state.notice?.peerId).toBe("B-2");
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("reducer.ts:1031 -- the front reclaim requester dropping re-raises the next queued claimant, not nobody", () => {
    let state = createGame("ROOM-1031");
    state = reduceApp(state, { k: "phone_join", peerId: "A-1", name: "Ada", seat: "seat-A" });
    state = reduceApp(state, { k: "phone_join", peerId: "B-1", name: "Bo", seat: "seat-B" });
    state = reduceApp(state, { k: "phone_join", peerId: "C-1", name: "Cy", seat: "seat-C" });
    // A and B are both playing, so each newcomer is asking about a seat
    // somebody is using.
    // A2 raises the front request; B2 queues behind it.
    state = reduceApp(state, { k: "phone_join", peerId: "A-2", name: "Ada", seat: "seat-A" });
    state = reduceApp(state, { k: "phone_join", peerId: "B-2", name: "Bo", seat: "seat-B" });
    expect(state.pendingReclaim?.peerId).toBe("A-2");
    // The front requester (A2) drops before the TV ever acts -- the exact
    // repro: the queue used to go stranded here, leaving B2 connected,
    // roleless, and with nothing raised for the TV.
    state = reduce(state, { k: "player_left", peerId: "A-2", at: 2_000 });
    expect(state.pendingReclaim?.peerId).toBe("B-2");
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("reducer.ts:1105 -- sweep_seats expiring the front reclaim re-raises the next queued claimant for a DIFFERENT still-held seat", () => {
    let state = createGame("ROOM-1105");
    state = reduceApp(state, { k: "phone_join", peerId: "A-1", name: "Ada", seat: "seat-A" });
    state = reduceApp(state, { k: "phone_join", peerId: "B-1", name: "Bo", seat: "seat-B" });
    state = reduceApp(state, { k: "phone_join", peerId: "C-1", name: "Cy", seat: "seat-C" });
    // A drops (which starts its grace window); B keeps playing, so the two
    // requests below are about two different kinds of seat.
    state = reduce(state, { k: "player_left", peerId: "A-1", at: 0 });
    // A2 asks for A's held seat by name and becomes the front request; B2
    // presents B's token against B's LIVE seat and queues behind it.
    state = reduceApp(state, { k: "phone_join", peerId: "A-2", name: "" });
    state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "A-2", name: "Ada" });
    state = reduceApp(state, { k: "phone_join", peerId: "B-2", name: "Bo", seat: "seat-B" });
    expect(state.pendingReclaim?.peerId).toBe("A-2");
    // A's hold expires (B's seat is live, so nothing about it changes) -- the
    // exact repro: the front reclaim closes, but the queued claimant for B's
    // DIFFERENT, still-held seat was never promoted.
    state = reduce(state, { k: "sweep_seats", at: SEAT_GRACE_MS + 1 });
    expect(state.players.find((p) => p.peerId === "A-1")).toBeUndefined(); // the held original was swept, not the claimant
    expect(state.players.find((p) => p.peerId === "A-2")?.claimedSeat).toBeNull(); // its target seat is gone, so the claim itself clears
    expect(state.pendingReclaim?.peerId).toBe("B-2");
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("normalizeReclaimQueue -- two TOKEN-based claims for the same seat never let the loser act on its own (seed 668, step 113)", () => {
    // Found by the wider fuzz, not written by hand first: two independent
    // collisions on one seat -- two connections each presenting the same
    // seat's own token -- can both be in flight at once, since only one
    // request fits on the TV at a time. Only one of them can ever be
    // granted. The original defect was that the loser's claim went on
    // carrying the contested token in its own `seat`; a claimant now carries
    // nothing but `claimedSeat`, so the seat cannot be duplicated whichever
    // way the TV decides.
    //
    // (A name-based reclaim can no longer reach the same seat as a token
    // claim: `reclaim_seat` only ever names a seat whose holder has GONE,
    // and a token claim is only ever raised against a seat somebody is
    // PLAYING. The two routes are disjoint by construction, which is why
    // this pins the token-vs-token contest instead.)
    let state = createGame("ROOM-668");
    // Every ROLE is taken and connected first, so the newcomers below land
    // roleless rather than picking up a free role by default.
    state = reduceApp(state, { k: "phone_join", peerId: "B-1", name: "Bo", seat: "seat-B" });
    state = reduceApp(state, { k: "phone_join", peerId: "C-1", name: "Cy", seat: "seat-C" });
    state = reduceApp(state, { k: "phone_join", peerId: "E-1", name: "Eli", seat: "seat-E" });
    const heldRole = state.players.find((p) => p.peerId === "E-1")!.role!;
    // E-2 presents E's own persisted seat token while E-1 is still playing
    // it, and becomes the front (and only) request.
    state = reduceApp(state, { k: "phone_join", peerId: "E-2", name: "Eli", seat: "seat-E" });
    expect(state.pendingReclaim?.peerId).toBe("E-2");
    // E-3 -- a different connection presenting the same token -- collides
    // with the same seat too, queued behind E-2's already-standing request:
    // roleless, claimedSeat pointing at seat-E, but never promoted to
    // `pendingReclaim` while E-2's is still valid.
    state = reduceApp(state, { k: "phone_join", peerId: "E-3", seat: "seat-E" });
    expect(state.players.find((p) => p.peerId === "E-3")?.claimedSeat).toBe("seat-E");
    expect(state.pendingReclaim?.peerId).toBe("E-2"); // unchanged -- E-3 only queued behind it
    // The TV approves E-2's request, which supersedes E-1's connection and
    // moves the seat. E-3 is still asking about it, because somebody is
    // playing it again the moment E-2 is -- what that must NOT be is a
    // second way into the same seat.
    state = reduce(state, { k: "approve_reclaim", requestId: state.pendingReclaim!.id });
    expect(state.players.find((p) => p.peerId === "E-2")?.role).toBe(heldRole);
    const stray = state.players.find((p) => p.peerId === "E-3")!;
    expect(stray.role).toBeNull();
    expect(stray.seat).toBeNull(); // never carried the contested token at all
    expect(state.players.filter((p) => p.seat === "seat-E")).toHaveLength(1);
    expect(state.pendingReclaim?.peerId).toBe("E-3"); // asked, never granted
    expect(checkSeatInvariants(state)).toEqual([]);

    // Declining it closes the whole thing out: one holder, no claim left.
    state = reduce(state, { k: "decline_reclaim", requestId: state.pendingReclaim!.id });
    expect(state.players.find((p) => p.peerId === "E-2")?.role).toBe(heldRole);
    expect(state.players.find((p) => p.peerId === "E-3")?.claimedSeat).toBeNull();
    expect(state.pendingReclaim).toBeNull();
    expect(checkSeatInvariants(state)).toEqual([]);
  });
});
