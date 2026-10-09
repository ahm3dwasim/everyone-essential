/**
 * The persistent action board never points an absent seat at a phone.
 *
 * The board's absent-performer branch used to fall through to the *present*
 * branch's copy, so a card whose phone had dropped -- or whose hold had already
 * expired -- still read "C · On your phone". The board is the one surface that
 * stays on screen for the rest of the game, so it went on pointing at a phone
 * that does not exist and carried no waiting/join instruction at all.
 *
 * Two obligations, tested separately:
 *   - a seat that is HELD (inside its grace window) reads the shared waiting
 *     sentence, in the same words the rebuild beats use; and
 *   - a seat that is VACANT (hold expired) reads the shared vacant/join
 *     sentence, again the same words.
 * Both come from `waitingOrVacantLine` -- one helper, one wording, no second
 * copy of either sentence in `screens.tsx`.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  createGame,
  heldRolesIn,
  reduce,
  reduceApp,
  vacantRolesIn,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { ActionBoard } from "../app/tv/src/screens.tsx";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

/**
 * The path that used to hide the bug, in three steps: C changes input (the
 * rebuild opens), C drops inside the grace window, the rebuild is dismissed --
 * so play resumes with C's seat held and the board back on screen.
 */
function afterRebuildDismissed(): GameState {
  let state = started();
  state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
  expect(state.phase).toBe("switching");
  state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
  state = reduce(state, { k: "switch_dismiss" });
  expect(state.phase).toBe("playing");
  expect(heldRolesIn(state)).toEqual(["C"]);
  return state;
}

/** The same path, then C never comes back: past the grace window the seat is swept. */
function afterHoldExpires(): GameState {
  const state = reduce(afterRebuildDismissed(), { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
  expect(vacantRolesIn(state)).toEqual(["C"]);
  expect(heldRolesIn(state)).toEqual([]);
  return state;
}

function board(state: GameState): string {
  return render(h(ActionBoard, { state, focusId: null, onPick: () => {} }));
}

/** One card's own markup, so a negative assertion is about that card only. */
function cardForRole(html: string, role: string): string {
  const start = html.indexOf(`data-performer="${role}"`);
  if (start < 0) throw new Error(`no card for role ${role} in: ${html}`);
  const next = html.indexOf('class="card"', start);
  return html.slice(start, next < 0 ? html.length : next);
}

describe("the action board never points an absent seat at a phone", () => {
  it("says 'Waiting for C to come back.' on C's card while C's grace window is live", () => {
    const state = afterRebuildDismissed();
    const card = cardForRole(board(state), "C");
    // Pre-fix this card read "C · On your phone" -- a phone that had just
    // dropped, with nothing on the board saying C was gone.
    expect(card).toContain("Waiting for C to come back.");
    expect(card).not.toContain("On your phone");
    expect(card).toContain('data-waiting="true"');
  });

  it("says the vacant/join sentence on C's card once the hold expires", () => {
    const state = afterHoldExpires();
    const card = cardForRole(board(state), "C");
    // Same sentence the rebuild beats use (`RebuildWaitingLine`), word for word.
    expect(card).toContain("C's seat is empty — someone needs to join as C.");
    expect(card).not.toContain("On your phone");
    expect(card).toContain('data-waiting="true"');
  });

  it("still says 'C · On your phone' for a phone that is actually there", () => {
    // The control for the two above: with C connected, dismissal and all, the
    // card's copy is unchanged -- this fix suppresses stale copy, it does not
    // remove the line.
    let state = started();
    state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    state = reduce(state, { k: "switch_dismiss" });
    expect(heldRolesIn(state)).toEqual([]);
    const card = cardForRole(board(state), "C");
    expect(card).toContain("C · On your phone");
    expect(card).not.toContain("Waiting for");
  });

  it("keeps 'on the remote' for a connected dpad role", () => {
    const card = cardForRole(board(started()), "A");
    expect(card).toContain("on the remote");
    expect(card).not.toContain("On your phone");
  });

  it("names the absent seat even when that seat is played from the TV remote", () => {
    // A dpad role's card is the one place the board would otherwise say
    // "on the remote" for a seat nobody is holding. The card is not actionable
    // either way (`data-waiting` is true, it is not a focus target and it has
    // no click handler), so the honest line here is the same waiting sentence
    // -- the rebuild moment's beat 3 keeps "On the remote" because that beat is
    // about the control surface, while this board is about who can act at all.
    const state = reduce(started(), { k: "player_left", peerId: PEER_A, at: 1_000 });
    expect(heldRolesIn(state)).toEqual(["A"]);
    const card = cardForRole(board(state), "A");
    expect(card).toContain("Waiting for A to come back.");
    expect(card).not.toContain("on the remote");
  });

  it("says nothing about waiting while every seat is connected", () => {
    const html = board(started());
    expect(html).not.toContain("Waiting for");
    expect(html).not.toContain("seat is empty");
  });
});
