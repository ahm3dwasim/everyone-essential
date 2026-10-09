/**
 * The eight-second rebuild moment's DATA, derived from a real `SwitchRecord`
 * -- never a rendered sentence re-parsed back into numbers. This is the exact
 * scenario the rebuild moment covers: the study midpoint, C asking for
 * one-button scan.
 */
import { describe, expect, it } from "vitest";
import {
  TV_PEER,
  createGame,
  reduce,
  reduceApp,
  switchRecord,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { buildRebuildMoment, rebuildHeadline } from "../app/tv/src/game/moment.ts";
import { correctOptionIndex } from "../app/tv/src/game/presentation.ts";
import { solve } from "../validator/src/api.ts";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

/**
 * A `SwitchRecord` names the SEAT that asked for the change
 * (`requester`), so a hand-built record has to say who asked. This fixture
 * asks as C's own connection, which joined without minting a seat token.
 */
const ASKED_BY_C = { peerId: PEER_C, seat: null };

function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

function controllerFor(state: GameState, role: string): string {
  const capabilities = state.puzzle.roles.find((r) => r.id === role)?.capabilities ?? [];
  if (capabilities.includes("dpad")) return TV_PEER;
  const player = state.players.find((p) => p.role === role);
  return player?.peerId ?? TV_PEER;
}

/** Same script `test/game.test.ts` uses: the shortest witness plan, played forward. */
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

describe("the rebuild moment's data, at the study's real midpoint", () => {
  const before = playSteps(started(), 5);
  const record = switchRecord(before.puzzle, before.play, "C", ["scan"], ASKED_BY_C);

  it("splits the nine-choice dial into two three-choice scan steps -- the primary change", () => {
    expect(record.kind).toBe("ok");
    const moment = buildRebuildMoment(record)!;
    expect(moment.primary).not.toBeNull();
    expect(moment.primary!.before.steps).toBe(1);
    expect(moment.primary!.before.optionsPerStep).toBe(9);
    expect(moment.primary!.after.steps).toBe(2);
    expect(moment.primary!.after.optionsPerStep).toBe(3);
  });

  it("keeps the four-choice symbol match as a one-line secondary change, not the headline", () => {
    const moment = buildRebuildMoment(record)!;
    expect(moment.secondary.length).toBeGreaterThan(0);
    expect(moment.secondary.join(" ")).toMatch(/one button/);
  });

  it("says 'One button. Still your move.' only because ownership is actually retained", () => {
    const moment = buildRebuildMoment(record)!;
    expect(moment.ownershipRetained).toBe(true);
    expect(moment.newOwner).toBeNull();
    expect(rebuildHeadline(moment)).toBe("One button. Still your move.");
  });
});

describe("the headline is conditional on retained ownership, not a universal slogan", () => {
  it("does not say 'still your move' when the change is a no-op", () => {
    const before = playSteps(started(), 5);
    // C already has dpad; asking for dpad again changes nothing.
    const record = switchRecord(before.puzzle, before.play, "C", ["dpad"], ASKED_BY_C);
    expect(record.kind).toBe("ok");
    const moment = buildRebuildMoment(record)!;
    expect(moment.noOpChange).toBe(true);
    expect(rebuildHeadline(moment)).toBe("Your new controls already fit.");
  });

  it("returns null for a refusal: refusals get their own screen, not this one", () => {
    const before = playSteps(started(), 6);
    const record = switchRecord(before.puzzle, before.play, "C", ["voice"], ASKED_BY_C);
    expect(record.kind).not.toBe("ok");
    expect(buildRebuildMoment(record)).toBeNull();
  });
});
