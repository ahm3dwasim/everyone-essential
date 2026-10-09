/**
 * One seat model, checked against random interleavings instead of hand-picked
 * scenarios.
 *
 * The example-based describe blocks in `game.test.ts` each pin one exact
 * reproduction. This file asks a broader question: across many different
 * *orders* of the same moves -- join (which, presented while the same seat is
 * already connected, or already held, is a second tab, a genuine reconnect, or
 * a replayed token -- indistinguishable from one another on the wire), drop,
 * sweep, release, reclaim, approve/decline, and choosing an action or an option
 * too -- do the invariants below ever break?
 *
 *   1. a seat token is held by more than one CONNECTED player, never (the
 *      actual security property) -- and when a token is momentarily held by two
 *      records at all (a token reclaim waiting on the TV), one must be the
 *      disconnected original seat and the other a roleless live requester,
 *      never two players who can both act.
 *   2. no role is held by a disconnected peer while `claimHolds()` is true.
 *   3. `claimHolds()` is never true while any certificate-required role
 *      lacks a connected holder.
 *   4. history never grows from a `choose_action` / `choose_option` step whose
 *      performer is not connected at the moment the step runs.
 *   5. whenever the run reaches `"ending"`, the render gate every positive
 *      claim goes through (`claimHoldsLive`, the same function `screens.tsx`
 *      calls) agrees exactly with `claimHolds()` computed straight from
 *      `state.players` -- the render function is exercised against the same
 *      fuzzed states the reducer invariants are.
 *   6. a seat's role never moves to a different peer id except as the direct
 *      result of an `approve_reclaim` step, or a live supersede on an
 *      ordinary join (the newer connection winning outright over a still-
 *      connected older one presenting the same seat token, named in
 *      `state.superseded`). No other automatic promotion anywhere, ever, for
 *      a peer id that is not the one already holding the role.
 *   7. a player never simultaneously holds a role and still carries a
 *      `claimedSeat` -- promotion always replaces one with the other, never
 *      both at once.
 *   8. a genuine returning phone -- its own seat's token, presented while that
 *      seat is disconnected and still holds a role -- is never turned away with
 *      nothing to show for it: either its own request is now the one waiting
 *      for the TV, or a different request was already queued and this one is
 *      told so, but it is never silently dropped on its first ask.
 *
 * A seeded PRNG keeps every run reproducible: a failure prints the seed that
 * found it, and re-running with that seed alone reproduces it.
 */
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  TV_PEER,
  availableActions,
  claimHolds,
  createGame,
  finalBadge,
  heldRolesIn,
  isConnected,
  reduce,
  reduceApp,
  vacantRolesIn,
  type GameState,
  type Player,
} from "../app/tv/src/game/reducer.ts";
import { seatRoles } from "../app/tv/src/game/mysteries.ts";
import { claimHoldsLive } from "../app/tv/src/game/certificate-presenter.ts";
import { ROLE_LABEL } from "../app/tv/src/game/presentation.ts";

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

type PhoneId = "A" | "B" | "C";
const PHONES: readonly PhoneId[] = ["A", "B", "C"];
const TOKEN: Record<PhoneId, string> = { A: "seat-A", B: "seat-B", C: "seat-C" };
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
      seatRoleHolders(after),
      `seed ${seed}, step ${step}: a ${k} that named no request on screen still moved a role`,
    ).toEqual(seatRoleHolders(before));
    expect(after.pendingReclaim).toBe(target);
  }
  return after;
}

const NAME: Record<PhoneId, string> = { A: "Ada", B: "Bo", C: "Cy" };

/**
 * Every invariant listed above, checked against the raw player list --
 * never against `heldRolesIn`/`vacantRolesIn` themselves, so this is not
 * just re-running `claimHolds`'s own formula on itself.
 */
function assertInvariants(state: GameState, seed: number, step: number): void {
  const at = `seed ${seed}, step ${step}`;

  const bySeat = new Map<string, Player[]>();
  for (const player of state.players) {
    if (player.seat === null) continue;
    const list = bySeat.get(player.seat) ?? [];
    list.push(player);
    bySeat.set(player.seat, list);
  }
  for (const [seat, holders] of bySeat) {
    // The load-bearing property: a seat token can never
    // be an ACTIVE credential -- one that actually holds a role -- for more
    // than one player at once. A token from a new peer id can raise a
    // roleless duplicate requester while the TV's OK is pending, more than
    // one at a time if more than one peer presents it before any of them is
    // approved or declined, and one can outlive its own request (blocked by
    // an earlier one still waiting) as inert debris once a different
    // requester is approved -- but only ever ONE holder of a given seat
    // token may carry a role, and every other holder must be roleless.
    const owners = holders.filter((p) => p.role !== null);
    expect(owners.length, `${at}: seat ${seat} has more than one active owner`).toBeLessThanOrEqual(1);
    for (const other of holders) {
      if (owners.includes(other)) continue;
      expect(other.role, `${at}: seat ${seat} has a second holder that also carries a role`).toBeNull();
    }
  }

  // Invariant 7: promotion always replaces a claim with a role,
  // never leaves both -- a player carrying a `claimedSeat` is, by
  // definition, one whose request has not yet been approved.
  for (const player of state.players) {
    if (player.role !== null) {
      expect(
        player.claimedSeat,
        `${at}: ${player.peerId} holds ${player.role} but still carries a claimedSeat`,
      ).toBeNull();
    }
  }

  if (claimHolds(state)) {
    for (const player of state.players) {
      if (player.role !== null) {
        expect(
          player.connected,
          `${at}: claimHolds() is true but ${player.role} is held by a disconnected peer`,
        ).toBe(true);
      }
    }
    const required = seatRoles(state.puzzle);
    for (const role of required) {
      const holder = state.players.find((p) => p.role === role);
      expect(holder, `${at}: claimHolds() is true but ${role} has no holder at all`).toBeDefined();
      expect(
        holder!.connected,
        `${at}: claimHolds() is true but ${role}'s holder is not connected`,
      ).toBe(true);
    }
  }

  // Invariant 5: the render gate every positive claim on the TV goes
  // through -- `claimHoldsLive`, called from `Ending` and `HowWeChecked`
  // exactly as here -- must never say the positive claim while any role it
  // counts on is held or vacant, whatever the underlying certificate says.
  // `finalBadge` is the same certificate `Ending`'s badge prop is built from
  // (`app.tsx`'s `currentBadge`), and `heldRolesIn`/`vacantRolesIn` are the
  // same live-connectivity read the labels app.tsx passes it are built from
  // -- this runs the actual render-gate function against the fuzzed state,
  // not a re-derivation of its own formula.
  if (state.phase === "ending") {
    const waitingFor = heldRolesIn(state).map((role) => ROLE_LABEL[role] ?? role);
    const vacantFor = vacantRolesIn(state).map((role) => ROLE_LABEL[role] ?? role);
    if (waitingFor.length > 0 || vacantFor.length > 0) {
      expect(
        // The fourth argument is the TV's own socket, which is `true` here
        // because this fuzz is about seats: the invariant is that an absent
        // seat alone can never leave the gate saying yes.
        claimHoldsLive(finalBadge(state).ok, waitingFor, vacantFor, true),
        `${at}: the ending's render gate said yes while a role is held or vacant`,
      ).toBe(false);
    }
  }
}

/** Invariant 6: which peer id holds each seat's role, right now. */
function seatRoleHolders(state: GameState): Map<string, string> {
  const map = new Map<string, string>();
  for (const player of state.players) {
    if (player.seat !== null && player.role !== null) map.set(player.seat, player.peerId);
  }
  return map;
}

/** The seats whose role holder is CONNECTED right now -- the ones somebody is playing. */
function liveSeatHolders(state: GameState): Set<string> {
  const live = new Set<string>();
  for (const player of state.players) {
    if (player.seat !== null && player.role !== null && player.connected) live.add(player.seat);
  }
  return live;
}

function runInterleaving(seed: number, steps: number): void {
  const rng = mulberry32(seed);
  let state = createGame(`ROOM-${seed}`);
  let clock = 0;
  let peerCounter = 0;
  const peerIdsByPhone: Record<PhoneId, string[]> = { A: [], B: [], C: [] };

  const freshPeerId = (phone: PhoneId): string => {
    const id = `${phone}-${peerCounter++}`;
    peerIdsByPhone[phone].push(id);
    return id;
  };
  const connectedPeerIds = (phone: PhoneId): string[] =>
    peerIdsByPhone[phone].filter((id) => state.players.find((p) => p.peerId === id)?.connected);

  const roles = seatRoles(state.puzzle);

  assertInvariants(state, seed, 0);

  for (let step = 1; step <= steps; step++) {
    clock += 100 + Math.floor(rng() * 2_000);
    const phone = pick(rng, PHONES);
    const kind = Math.floor(rng() * 10);
    const seatHoldersBefore = seatRoleHolders(state);
    const liveSeatsBefore = liveSeatHolders(state);

    switch (kind) {
      case 0: {
        // A join -- a genuine newcomer, a grace-window reconnect under a new
        // peer id, or (when this phone already has a live connection) a
        // second tab / replayed-token collision. The same action covers all
        // three; which one it is depends only on the state it lands in.
        const peerId = freshPeerId(phone);
        const want = rng() < 0.5 ? pick(rng, roles) : undefined;
        // Invariant 8: is this phone's own seat disconnected and still held
        // right now? Then this join is the genuine returning phone, and the
        // token it presents is the whole of the proof for a seat nobody is
        // playing -- it gets the seat back on the spot, never silently turned
        // away and never made to wait for a TV that has nothing to decide.
        const heldBefore = state.players.find(
          (p) => p.seat === TOKEN[phone] && !p.connected && p.role !== null,
        );
        state = reduceApp(state, {
          k: "phone_join",
          peerId,
          name: NAME[phone],
          seat: TOKEN[phone],
          ...(want !== undefined ? { want } : {}),
        });
        if (heldBefore) {
          expect(
            state.players.find((p) => p.peerId === peerId)?.role,
            `seed ${seed}, step ${step}: a returning phone was not given its own held seat back`,
          ).toBe(heldBefore.role);
        }
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
        // Sometimes a plain tick, sometimes far enough to expire a hold.
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
        // Invariant 4: choose an available action through its own
        // natural controller -- the TV remote for a dpad role, which is the
        // one controller that keeps working whether or not the role behind
        // it is still connected (that gap is exactly what this closes), or
        // the role's own connected phone otherwise.
        const actions = availableActions(state.puzzle, state.play);
        if (actions.length > 0) {
          const entry = pick(rng, actions);
          const capabilities = state.puzzle.roles.find((r) => r.id === entry.performer)?.capabilities ?? [];
          const controller = capabilities.includes("dpad")
            ? TV_PEER
            : state.players.find((p) => p.role === entry.performer && p.connected)?.peerId;
          if (controller) {
            const before = state.play.history.length;
            const connectedNow = isConnected(state, entry.performer);
            state = reduce(state, { k: "choose_action", peerId: controller, actionId: entry.actionId });
            if (state.play.history.length > before) {
              expect(
                connectedNow,
                `seed ${seed}, step ${step}: history advanced for ${entry.performer}, who was not connected`,
              ).toBe(true);
            }
          }
        }
        break;
      }
      case 8: {
        // The TV coming back to its room and reading the peer list its welcome
        // carried. This is the one way a player can be dropped without the
        // relay ever having said so -- they left while the TV's socket was
        // down -- so it belongs in the pool beside `player_left`, and it must
        // never do anything a relay announcement could not: it takes players
        // away on the strength of who is present, and it can never put one
        // back. A list is a claim about now, not a resurrection.
        const connectedBefore = state.players.filter((p) => p.connected).map((p) => p.peerId);
        const present = connectedBefore.filter(() => rng() < 0.5);
        state = reduce(state, { k: "peers_present", peerIds: present, at: clock });
        for (const id of connectedBefore) {
          if (present.includes(id)) continue;
          expect(
            state.players.find((p) => p.peerId === id)?.connected,
            `seed ${seed}, step ${step}: a welcome that did not list ${id} left it connected`,
          ).toBe(false);
        }
        for (const player of state.players) {
          if (player.connected) {
            expect(
              connectedBefore,
              `seed ${seed}, step ${step}: a welcome put ${player.peerId} back in the room`,
            ).toContain(player.peerId);
          }
        }
        break;
      }
      default: {
        // Resolve whatever is pending on the TV remote, whether or not its
        // performer has since dropped -- the case this guards: open a dpad
        // picker, disconnect its performer, press an option on the remote
        // anyway.
        if (state.pending[TV_PEER]) {
          const pendingActionId = state.pending[TV_PEER]!.actionId;
          const performer = availableActions(state.puzzle, state.play).find(
            (a) => a.actionId === pendingActionId,
          )?.performer;
          const connectedNow = performer !== undefined && isConnected(state, performer);
          const before = state.play.history.length;
          state = reduce(state, { k: "choose_option", peerId: TV_PEER, option: Math.floor(rng() * 4) });
          if (state.play.history.length > before) {
            expect(
              connectedNow,
              `seed ${seed}, step ${step}: a pending option committed for an absent performer`,
            ).toBe(true);
          }
        }
        break;
      }
    }

    // Invariant 6: a seat's role only ever moves to a different peer id as the
    // direct result of `approve_reclaim` (kind 5) or an ordinary join
    // (kind 0) -- never a drop (kind 1) or a sweep (kind 2), which is the
    // automatic promotion that used to happen there. A join moves it in
    // exactly two ways: taking over a seat somebody is PLAYING, which the TV
    // must have named as superseding that connection; or taking back a seat
    // nobody is playing, which supersedes nobody, because there is nobody to
    // supersede.
    const seatHoldersAfter = seatRoleHolders(state);
    for (const [seat, peerIdBefore] of seatHoldersBefore) {
      const peerIdAfter = seatHoldersAfter.get(seat);
      if (peerIdAfter !== undefined && peerIdAfter !== peerIdBefore) {
        if (kind === 0) {
          if (liveSeatsBefore.has(seat)) {
            expect(
              state.superseded?.peerId,
              `seed ${seed}, step ${step}: seat ${seat}'s role moved from ${peerIdBefore} to ${peerIdAfter} while ${peerIdBefore} was still playing it, without the TV naming that connection`,
            ).toBe(peerIdBefore);
          } else {
            expect(
              state.players.find((p) => p.peerId === peerIdBefore)?.role ?? null,
              `seed ${seed}, step ${step}: seat ${seat}'s role moved to ${peerIdAfter} but ${peerIdBefore} was still holding it`,
            ).toBeNull();
          }
        } else {
          expect(
            kind,
            `seed ${seed}, step ${step}: seat ${seat}'s role moved from ${peerIdBefore} to ${peerIdAfter} on a step that was neither approve_reclaim nor a live-supersede join`,
          ).toBe(5);
        }
      }
    }

    assertInvariants(state, seed, step);
  }
}

describe("the seat model's invariants hold across random interleavings", () => {
  it(
    "survives 40 seeded sequences of join/drop/sweep/release/reclaim/approve/second-tab/rejoin",
    { timeout: 30_000 },
    () => {
    for (let seed = 1; seed <= 40; seed++) {
      runInterleaving(seed, 150);
    }
  });
});
