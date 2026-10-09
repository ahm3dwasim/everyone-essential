/**
 * A pending switch belongs to the seat that asked for it.
 *
 * A pending input switch recorded only the ROLE, never the seat that asked for
 * it. `resolveSwitch` then applied it without revalidating anything, so a
 * request outlived the seat that made it -- and `switch_dismiss` applied C's
 * old request even after C had been swept away, or after a different phone had
 * been seated as C, changing the newcomer's controls to a control set nobody
 * had asked for.
 *
 * Both sequences are pinned below, one `it` each, plus two boundary cases
 * decided rather than guessed:
 *
 *  - the same seat, back before the dismissal, keeps the rebuild it asked for
 *    (same peer + same seat => the switch still applies);
 *  - a seat still away *at* the dismissal does not (nothing to apply it to).
 *
 * The invariant this belongs to -- I9 in `checkSeatInvariants` -- is fuzzed
 * in `test/seat-invariants-wider-fuzz.test.ts`, beside the rest of the
 * seat model's contract.
 */
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  SWITCH_PHASES,
  TV_PEER,
  checkSeatInvariants,
  createGame,
  isConnected,
  reduce,
  reduceApp,
  roleOfPeer,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { correctOptionIndex } from "../app/tv/src/game/presentation.ts";
import { solve } from "../validator/src/api.ts";

const PEER_A = "A-1";
const PEER_B = "B-1";
const PEER_C = "C-1";
const SEAT_A = "seat-A";
const SEAT_B = "seat-B";
const SEAT_C = "seat-C";

/** Three phones joined and holding their own seat tokens, so play has started. */
function seated(): GameState {
  let state = createGame("ROOM-SWITCH");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A", seat: SEAT_A });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B", seat: SEAT_B });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C", seat: SEAT_C });
  return state;
}

/** Who presses the button for a role: its own phone, or the TV remote. */
function controllerFor(state: GameState, role: string): string {
  const capabilities = state.puzzle.roles.find((r) => r.id === role)?.capabilities ?? [];
  if (capabilities.includes("dpad")) return TV_PEER;
  return state.players.find((p) => p.role === role)?.peerId ?? TV_PEER;
}

/** The same script `test/game.test.ts` uses: the shortest witness plan, played forward. */
function playSteps(state: GameState, steps: number): GameState {
  let next = state;
  for (let i = 0; i < steps; i++) {
    const step = solve(next.puzzle, next.play).plan[0];
    if (!step) throw new Error(`the plan ran out after ${i} steps`);
    const action = next.puzzle.actions.find((a) => a.id === step.action);
    if (!action) throw new Error(`no action ${step.action}`);
    const peerId = controllerFor(next, step.performer);
    next = reduce(next, { k: "choose_action", peerId, actionId: step.action });
    if ((action.options ?? 1) > 1) {
      next = reduce(next, { k: "choose_option", peerId, option: correctOptionIndex(action) });
    }
  }
  return next;
}

/** The study's midpoint, which is the state the whole rebuild moment belongs to. */
function midway(): GameState {
  return playSteps(seated(), 5);
}

function cControls(state: GameState): readonly string[] {
  return state.puzzle.roles.find((r) => r.id === "C")?.capabilities ?? [];
}

/**
 * The precondition every test below shares: C's own phone asks for a
 * scan-only control set, and the request is accepted and on screen.
 */
function cAsks(state: GameState): GameState {
  const asked = reduce(state, { k: "request_input_change", role: "C", capabilities: ["scan"] });
  if (asked.pendingSwitch?.kind !== "ok") throw new Error("expected an accepted switch for this fixture");
  expect(asked.phase).toBe("switching");
  return asked;
}

describe("a pending switch belongs to the seat that asked for it", () => {
  it("(a) C asks, drops, is swept, and the dismissal cancels instead of applying", () => {
    const before = midway();
    let state = cAsks(before);
    expect(cControls(state)).toEqual(["dpad"]); // nothing has moved yet

    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    expect(state.players.some((p) => p.role === "C")).toBe(false); // vacant, not held

    // The switch is cancelled the moment C's seat is gone -- not at some later
    // dismissal that no longer means anything. The dismissal below is a no-op.
    expect(state.pendingSwitch).toBeNull();
    expect(state.phase).toBe("playing");
    state = reduce(state, { k: "switch_dismiss" });

    expect(state.phase).toBe("playing");
    expect(state.pendingSwitch).toBeNull();
    expect(cControls(state)).toEqual(["dpad"]); // the controls are untouched
    expect(state.play).toEqual(before.play); // and so is the board
    expect(state.switches).toEqual([]); // nothing was applied, so nothing is recorded
    expect(state.notice?.text).toContain("cancelled");
    expect(state.log[state.log.length - 1]?.text).toContain("cancelled");
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("(b) the same, but a new phone is seated as C -- the newcomer's controls are untouched", () => {
    const before = midway();
    let state = cAsks(before);
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });

    // A genuinely different phone -- its own token, never C's -- takes the
    // freed seat. This is the second sequence: the pre-fix dismissal
    // applied C's old request and handed THIS phone a control set nobody
    // had asked for.
    state = reduceApp(state, {
      k: "phone_join",
      peerId: "C-2",
      name: "New",
      want: "C",
      seat: "seat-C2",
    });
    expect(roleOfPeer(state, "C-2")).toBe("C");
    expect(state.pendingSwitch).toBeNull();

    state = reduce(state, { k: "switch_dismiss" });
    expect(state.pendingSwitch).toBeNull();
    expect(cControls(state)).toEqual(["dpad"]); // the newcomer's controls are unchanged
    expect(state.play).toEqual(before.play);
    expect(state.switches).toEqual([]);
    expect(state.notice?.text).toContain("cancelled");
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("the same seat, back before the dismissal, keeps the rebuild it asked for", () => {
    const before = midway();
    let state = cAsks(before);
    const asked = state.pendingSwitch;

    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    // Still inside the grace window, so the request waits with the seat it
    // belongs to -- it is NOT cancelled just because the phone stepped out.
    expect(state.pendingSwitch).toBe(asked);

    // The same phone comes back on a new peer id, presenting the seat token it
    // minted, and the seat is handed back on the token alone -- nobody is
    // playing it, so there is nothing for the TV to answer.
    state = reduceApp(state, { k: "phone_join", peerId: "C-2", name: "Cy", seat: SEAT_C });
    expect(state.pendingReclaim).toBeNull();
    expect(roleOfPeer(state, "C-2")).toBe("C");
    expect(isConnected(state, "C")).toBe(true);
    expect(state.pendingSwitch).toBe(asked);

    state = reduce(state, { k: "switch_dismiss" });
    expect(state.phase).toBe("playing");
    expect(cControls(state)).toEqual(["scan"]); // applied, as asked
    expect(state.switches).toHaveLength(1);
    expect(state.switches[0]?.applied).toBe(true);
    expect(state.switches[0]?.requester).toEqual({ peerId: PEER_C, seat: SEAT_C });
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("cancels at the dismissal when the asking seat is still away (the grace window is not a licence to apply it)", () => {
    const before = midway();
    let state = cAsks(before);
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    // Held, not gone: I9 is satisfied, so the request is still pending here.
    expect(state.pendingSwitch).not.toBeNull();
    expect(checkSeatInvariants(state)).toEqual([]);

    state = reduce(state, { k: "switch_dismiss" });
    expect(state.phase).toBe("playing");
    expect(state.pendingSwitch).toBeNull();
    expect(cControls(state)).toEqual(["dpad"]);
    expect(state.play).toEqual(before.play);
    expect(state.notice?.text).toContain("cancelled");
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("still applies, and still records who asked, when the asking seat never left", () => {
    const before = midway();
    let state = cAsks(before);
    const carried = state.switchBeat;
    while (state.phase === "switching") state = reduce(state, { k: "switch_beat" });
    expect(state.phase).toBe("playing");
    expect(cControls(state)).toEqual(["scan"]);
    expect(state.switches).toHaveLength(1);
    expect(state.switches[0]?.applied).toBe(true);
    expect(state.switches[0]?.requester).toEqual({ peerId: PEER_C, seat: SEAT_C });
    expect(carried).toBeLessThan(SWITCH_PHASES);
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("refuses the request outright from a seat that is not connected (unchanged, but now the reason nothing is bound)", () => {
    let state = midway();
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    const asked = reduce(state, { k: "request_input_change", role: "C", capabilities: ["scan"] });
    expect(asked.phase).toBe("playing");
    expect(asked.pendingSwitch).toBeNull();
  });
});
