/**
 * Every appended log line advances the id counter.
 *
 * `cancelSwitch` appended its log line with `appendLog`, which stamps the line
 * with `state.nextLogId` -- but the case never incremented `nextLogId`
 * afterwards the way every other log-appending case does. The counter stayed
 * put, so the NEXT line written anywhere in the room reused the same id: a
 * cancelled switch after a disconnect, then another peer joining, both landed
 * on id `5`.
 *
 * The fix is a bookkeeping one (the counter advances exactly once per appended
 * line), and it is only trustworthy if something checks the property it exists
 * for, so this file does two things:
 *
 *  - pins the sequence above, and the two sibling paths that shared the same
 *    omission (`resolveSwitch`'s refusal and its success branch); and
 *  - holds log-id uniqueness as a standing invariant, I10 in
 *    `checkSeatInvariants`, which `test/seat-invariants-wider-fuzz.test.ts`
 *    then fuzzes across every step of tens of thousands of random sequences.
 */
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  TV_PEER,
  checkSeatInvariants,
  createGame,
  reduce,
  reduceApp,
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
  let state = createGame("ROOM-LOG");
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

/** The study's midpoint, which is the state the rebuild moment belongs to. */
function midway(): GameState {
  return playSteps(seated(), 5);
}

/** C's own phone asks for a scan-only control set; the request is accepted and on screen. */
function cAsks(state: GameState): GameState {
  const asked = reduce(state, { k: "request_input_change", role: "C", capabilities: ["scan"] });
  if (asked.pendingSwitch?.kind !== "ok") throw new Error("expected an accepted switch for this fixture");
  expect(asked.phase).toBe("switching");
  return asked;
}

/** Every log line's id, in order. */
function logIds(state: GameState): number[] {
  return state.log.map((line) => line.id);
}

/** What I10 asserts: no two log lines ever share an id. */
function duplicateLogIds(state: GameState): number[] {
  const seen = new Set<number>();
  const dupes = new Set<number>();
  for (const id of logIds(state)) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes].sort((a, b) => a - b);
}

/** The id of the reclaim request the TV is showing -- what a press on the overlay carries. */
function onScreenRequestId(state: GameState): string {
  if (!state.pendingReclaim) throw new Error("no reclaim request is on screen");
  return state.pendingReclaim.id;
}

describe("every appended log line advances the id counter", () => {
  it("a cancelled switch, then a join -- no two lines share an id", () => {
    let state = midway();
    state = cAsks(state);

    // C drops and is swept, which is what cancels the request.
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    expect(state.log[state.log.length - 1]?.text).toContain("cancelled");

    // The second half: another peer joins. Pre-fix, this line reused the
    // cancellation line's id.
    state = reduceApp(state, { k: "phone_join", peerId: "D-1", name: "Dee", want: "C", seat: "seat-D" });

    expect(duplicateLogIds(state)).toEqual([]);
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("the counter stays in step with the lines appended, cancellation included", () => {
    let state = midway();
    state = cAsks(state);
    const before = state.nextLogId;
    const linesBefore = state.log.length;

    // The drop and the sweep both log as well, so the honest property is not
    // "exactly one line" -- it is that `nextLogId` advanced by exactly as many
    // lines as the log actually grew by, which is what I10 depends on.
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });

    const added = state.log.length - linesBefore;
    expect(added).toBeGreaterThan(0);
    expect(state.log[state.log.length - 1]?.text).toContain("cancelled");
    expect(state.nextLogId).toBe(before + added);
    // And the line just written carries the id just below the counter: the
    // counter is ahead of every id it has handed out, never level with one.
    expect(state.log[state.log.length - 1]?.id).toBe(state.nextLogId - 1);
    expect(duplicateLogIds(state)).toEqual([]);
  });

  it("a refused switch (resolveSwitch's failure branch) advances it too", () => {
    let state = midway();
    // An empty control set is not something any repair can hold, so the record
    // comes back as a refusal rather than an `ok` one. A refusal never reaches
    // `switch_beat` (`reducer.ts` returns unchanged for a non-`ok` record) --
    // it is dismissed, which is what runs `resolveSwitch`'s failure branch.
    state = reduce(state, { k: "request_input_change", role: "C", capabilities: [] });
    const record = state.pendingSwitch;
    if (record === null || record.kind === "ok") {
      throw new Error("fixture no longer produces a refused switch -- pick another invalid input");
    }
    const before = state.nextLogId;

    state = reduce(state, { k: "switch_dismiss" });

    expect(state.phase).toBe("playing");
    expect(state.pendingSwitch).toBeNull();
    expect(state.log[state.log.length - 1]?.text).toContain("failed");
    expect(state.nextLogId).toBeGreaterThan(before);
    expect(duplicateLogIds(state)).toEqual([]);
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("an applied switch (resolveSwitch's success branch) advances it too", () => {
    let state = midway();
    state = cAsks(state);
    const before = state.nextLogId;

    while (state.phase === "switching") state = reduce(state, { k: "switch_beat" });
    expect(state.switches).toHaveLength(1);
    expect(state.switches[0]?.applied).toBe(true);
    expect(state.log[state.log.length - 1]?.text).toContain("rebuilt");

    expect(state.nextLogId).toBeGreaterThan(before);
    expect(duplicateLogIds(state)).toEqual([]);
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("I10 is the invariant, not this file's private helper: checkSeatInvariants reports a collision", () => {
    // A state the reducer can no longer produce -- two lines sharing an id --
    // has to be something the contract actually names, or the fuzz in
    // `test/seat-invariants-wider-fuzz.test.ts` would be asserting nothing.
    let state = midway();
    const forged: GameState = { ...state, log: [...state.log, { ...state.log[0]!, id: state.log[0]!.id }] };
    expect(checkSeatInvariants(forged).join(" ")).toContain("I10");
    // And the honest state is clean.
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("holds across a longer sequence of log-producing transitions, not just the one above", () => {
    let state = midway();
    state = cAsks(state);

    // Every transition that appends a line, in one run: the cancellation, a
    // drop, a sweep, two joins, an approval, a decline and a release. Both
    // properties are checked after every single step rather than at the end,
    // so a collision is attributed to the transition that caused it.
    const step = (next: GameState): GameState => {
      expect(checkSeatInvariants(next)).toEqual([]);
      expect(duplicateLogIds(next)).toEqual([]);
      return next;
    };

    state = step(reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 }));
    state = step(reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS }));
    state = step(reduceApp(state, { k: "phone_join", peerId: "C-2", name: "New", want: "C", seat: "seat-C2" }));
    state = step(reduceApp(state, { k: "phone_join", peerId: "D-1", name: "Dee", want: "A", seat: "seat-D" }));
    state = step(reduce(state, { k: "player_left", peerId: PEER_B, at: 5_000 }));
    state = step(reduce(state, { k: "sweep_seats", at: 5_000 + SEAT_GRACE_MS }));
    state = step(reduceApp(state, { k: "phone_join", peerId: "B-2", name: "Bo", seat: SEAT_B }));
    // B's seat was swept before this join, so nothing is waiting for the TV:
    // both presses name a request that is gone, and decide nothing.
    state = step(reduce(state, { k: "approve_reclaim", requestId: "a-request-that-is-no-longer-on-screen" }));
    state = step(reduce(state, { k: "decline_reclaim", requestId: "a-request-that-is-no-longer-on-screen" }));

    expect(state.log.length).toBeGreaterThan(5); // the run really did write lines
    expect(state.log.at(-1)?.id).toBe(state.nextLogId - 1);
  });
});
