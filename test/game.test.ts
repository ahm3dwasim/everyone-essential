/**
 * The TV's game reducer: the authoritative half of the app.
 *
 * Everything here is a pure function call -- no sockets, no timers, no DOM.
 * Three groups cover it: an action that is legal is applied, an action that
 * is not is refused with a reason, and the
 * input switch runs `recompile`, applies what it returns, and records it in the
 * history the ending screen reads back.
 */
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  SWITCH_PHASES,
  TV_PEER,
  applyAction,
  applyPhoneChoice,
  atMidpoint,
  availableActions,
  checkSeatInvariants,
  createGame,
  claimHolds,
  finalBadge,
  heldRolesIn,
  historyLines,
  isConnected,
  outstandingRoles,
  pageChoices,
  phoneMode,
  phoneView,
  playerByPeer,
  reduce,
  reduceApp,
  roleOfPeer,
  switchRecord,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { demoPuzzle, emptyState, solve } from "../validator/src/api.ts";
import { MORE_CHOICE_ID, type PhoneView } from "../app/shared/protocol.ts";
import { correctOptionIndex, refusalCopy } from "../app/tv/src/game/presentation.ts";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

/**
 * A `SwitchRecord` names the SEAT that asked for the change
 * (`requester`), so a hand-built record has to say who asked. These fixtures
 * all ask as C's own connection, which joined without minting a seat token.
 */
const ASKED_BY_C = { peerId: PEER_C, seat: null };

/** A game with all three phones joined, which is what starts play. */
function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C" });
  return state;
}

/** Who presses the button for a role: its own phone, or the TV remote. */
function controllerFor(state: GameState, role: string): string {
  const capabilities = state.puzzle.roles.find((r) => r.id === role)?.capabilities ?? [];
  if (capabilities.includes("dpad")) return TV_PEER;
  const player = state.players.find((p) => p.role === role);
  return player?.peerId ?? TV_PEER;
}

/**
 * Play `steps` moves of the shortest witness plan, taking the one option the
 * app's fiction says is correct wherever an action offers a choice -- the
 * app refuses a wrong one (see "the answer must matter" below), so a
 * script that always took option 0 would stall on any choice whose answer
 * isn't index 0.
 */
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

function choiceIds(view: PhoneView): string[] {
  return view.choices.map((choice) => choice.id);
}

/** The id of the reclaim request the TV is showing -- what a press on the overlay carries. */
function onScreenRequestId(state: GameState): string {
  if (!state.pendingReclaim) throw new Error("no reclaim request is on screen");
  return state.pendingReclaim.id;
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */


describe("the game as it starts", () => {
  it("opens in the lobby with a real certificate for the untouched puzzle", () => {
    const state = createGame("ABCD");
    expect(state.phase).toBe("lobby");
    expect(state.room).toBe("ABCD");
    expect(state.certificate?.ok).toBe(true);
    expect(state.startCertificate?.ok).toBe(true);
    expect(finalBadge(state).lines.map((line) => line.label)).toEqual([
      "solvable",
      "A essential",
      "B essential",
      "C essential",
    ]);
  });

  it("knows where halfway is from the witness plan, not from a guess", () => {
    const state = createGame();
    expect(state.plan).toHaveLength(10);
    expect(state.midpointSteps).toBe(5);
    expect(atMidpoint(state)).toBe(false);
  });

  it("offers only what the team can already do", () => {
    const state = createGame();
    expect(availableActions(state.puzzle, state.play).map((a) => a.actionId).sort()).toEqual([
      "a_read_painting_hint",
      "b_describe_symbols",
      "b_dictate_code",
      "c_read_drawer_note",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Joining                                                             */
/* ------------------------------------------------------------------ */

describe("joining", () => {
  it("gives each phone the role it asked for, and starts play once all three are in", () => {
    let state = reduceApp(createGame("ABCD"), { k: "phone_join", peerId: PEER_A, want: "A" });
    expect(state.phase).toBe("lobby");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
    expect(state.phase).toBe("playing");
    expect(state.players.map((p) => p.role)).toEqual(["A", "B", "C"]);
  });

  it("hands out a free role when the one asked for is taken", () => {
    let state = started();
    state = reduceApp(state, { k: "phone_join", peerId: "phone-d", want: "A" });
    const fourth = state.players.find((p) => p.peerId === "phone-d");
    // Every role is taken, so there is nothing to hand out -- and the phone is
    // told so rather than being given somebody else's role.
    expect(fourth?.role).toBeNull();
    expect(state.phase).toBe("playing");
  });

  it("keeps a player's role when they drop out, and stops waiting on them", () => {
    let state = started();
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    expect(state.players.find((p) => p.peerId === PEER_B)?.connected).toBe(false);
    expect(outstandingRoles(state)).toContain("B");
    // The board still lists B's work: an absent player is information, not an error.
    expect(availableActions(state.puzzle, state.play).some((a) => a.performer === "B")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Applying and refusing                                               */
/* ------------------------------------------------------------------ */

describe("applying an action", () => {
  it("adds what the action produces, and credits the right role", () => {
    const state = createGame();
    const result = applyAction(state.puzzle, state.play, "a_read_painting_hint");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.performer).toBe("A");
    expect(result.state.tokens).toContain("safe_location");
    expect(result.state.history).toHaveLength(1);
  });

  it("refuses an action whose prerequisites are not met, and says which", () => {
    const state = createGame();
    const result = applyAction(state.puzzle, state.play, "c_dial_safe");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("needs");
    expect(result.reason).toContain("the two code digits");
  });

  it("refuses an action that has already been done", () => {
    const state = playSteps(started(), 1);
    const again = applyAction(state.puzzle, state.play, "a_read_painting_hint");
    expect(again).toEqual({
      ok: false,
      reason: '"read the note taped behind the painting" has already been done',
    });
  });

  it("refuses an action that is not in the puzzle at all", () => {
    const state = createGame();
    expect(applyAction(state.puzzle, state.play, "open_the_vault")).toEqual({
      ok: false,
      reason: 'there is no action "open_the_vault" in this puzzle',
    });
  });
});

describe("refusing a move at the table", () => {
  it("will not let a phone act for another role", () => {
    const state = started();
    const next = reduce(state, {
      k: "choose_action",
      peerId: PEER_B,
      actionId: "a_read_painting_hint",
    });
    expect(next.notice?.text).toBe("that action belongs to A, not to B");
    expect(next.play.history).toHaveLength(0);
  });

  it("will not run an action whose prerequisites nobody has met yet", () => {
    const state = started();
    const next = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "c_dial_safe" });
    expect(next.notice?.text).toContain("not available right now");
    expect(next.play.history).toHaveLength(0);
  });

  it("will not act for a role whose phone has not joined", () => {
    // Nobody has joined at all: the remote is the right controller for a d-pad
    // role, but the role is not at the table yet.
    const next = reduce(createGame(), {
      k: "choose_action",
      peerId: TV_PEER,
      actionId: "a_read_painting_hint",
    });
    expect(next.notice?.text).toContain("has not joined yet");
    expect(next.play.history).toHaveLength(0);
  });

  it("refuses a choice the TV never put on that phone's screen", () => {
    const state = started();
    const forged = applyPhoneChoice(state, PEER_B, "act:any_enter_study");
    expect(forged.notice?.text).toBe("that choice is not on your screen any more");
    expect(forged.play.history).toHaveLength(0);
  });

  it("refuses an option number that is not on the card", () => {
    let state = started();
    state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_read_painting_hint" });
    state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_shift_painting" });
    expect(state.pending[TV_PEER]?.options).toBe(4);
    const next = reduce(state, { k: "choose_option", peerId: TV_PEER, option: 9 });
    expect(next.notice?.text).toBe("there is no option 10");
    expect(next.play.flags).not.toContain("painting_moved");
  });

  it("does not advance the game on a wrong answer-gated choice, and lets the chooser try again", () => {
    let state = playSteps(started(), 1); // A has read the painting hint
    state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_shift_painting" });
    // A's clue (painting_hint) says "hinged on the left" -- option 0 is right,
    // option 1 ("lift the right edge") contradicts it.
    const wrong = reduce(state, { k: "choose_option", peerId: TV_PEER, option: 1 });
    expect(wrong.play.flags).not.toContain("painting_moved");
    expect(wrong.play.history).toHaveLength(1); // nothing committed
    expect(wrong.certificate?.hash).toBe(state.certificate?.hash); // certificate untouched
    // Kind, not punishing: the choice is still open, ready to try again.
    expect(wrong.pending[TV_PEER]).toEqual({ actionId: "a_shift_painting", options: 4 });
    expect(wrong.notice?.text).toContain("the frame does not lift that way");
    expect(wrong.notice?.text).toContain("A knows it");

    const right = reduce(wrong, { k: "choose_option", peerId: TV_PEER, option: 0 });
    expect(right.play.flags).toContain("painting_moved");
    expect(right.pending[TV_PEER]).toBeUndefined();
  });

  describe("a pending pick must recheck its performer, not trust the picker that opened it", () => {
    // A dpad picker lives at `pending["tv"]`,
    // a controller the TV remote keeps working whether or not the role
    // behind it is still connected -- opened C's `c_match_symbol`, dropped
    // C, picked the right answer on the remote, and it committed anyway.
    // A's `a_shift_painting` is the same shape (dpad, answer-gated, A's own
    // performer) and exercises the same gap.
    it("clears the picker rather than committing it once its performer has dropped", () => {
      let state = seated();
      state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_read_painting_hint" });
      state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_shift_painting" });
      expect(state.pending[TV_PEER]).toEqual({ actionId: "a_shift_painting", options: 4 });
      state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
      // Still sitting right where it was -- the TV remote does not know A
      // dropped -- and the correct answer, pressed anyway, must not commit.
      const next = reduce(state, { k: "choose_option", peerId: TV_PEER, option: 0 });
      expect(next.play.flags).not.toContain("painting_moved");
      expect(next.play.history).toHaveLength(1); // only the read, nothing committed for an absent A
      expect(next.pending[TV_PEER]).toBeUndefined(); // cleared, not left dangling
      expect(next.notice?.text).toContain("A is not connected any more");
    });

    it("still commits normally once the performer is connected again", () => {
      let state = seated();
      state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_read_painting_hint" });
      state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_shift_painting" });
      state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
      state = reduce(state, { k: "choose_option", peerId: TV_PEER, option: 0 }); // cleared, not committed
      expect(state.pending[TV_PEER]).toBeUndefined();
      state = reduceApp(state, { k: "phone_join", peerId: "phone-a-2", name: "Ada", seat: "seat-a" });
      expect(roleOfPeer(state, "phone-a-2")).toBe("A");
      state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_shift_painting" });
      state = reduce(state, { k: "choose_option", peerId: TV_PEER, option: 0 });
      expect(state.play.flags).toContain("painting_moved");
    });
  });

  it("holds the same table for every mystery: at least one choice is answer-gated and coverable both ways", () => {
    for (const id of ["the-locked-study", "the-midnight-bakery", "the-treehouse"]) {
      const state = reduceApp(reduceApp(reduceApp(reduceApp(createGame("ABCD", id), {
        k: "phone_join",
        peerId: PEER_A,
        want: "A",
      }), { k: "phone_join", peerId: PEER_B, want: "B" }), { k: "phone_join", peerId: PEER_C, want: "C" }), {
        k: "room",
        room: "ABCD",
      });
      const choiceActions = state.puzzle.actions.filter((a) => (a.options ?? 1) > 1 && a.answerToken);
      expect(choiceActions.length).toBeGreaterThan(0);
      for (const action of choiceActions) {
        const correct = correctOptionIndex(action);
        expect(correct).toBeGreaterThanOrEqual(0);
        expect(correct).toBeLessThan(action.options ?? 1);
      }
    }
  });

  for (const mysteryId of ["the-locked-study", "the-midnight-bakery", "the-treehouse"]) {
    it(`${mysteryId}: a wrong answer-gated choice is covered end to end -- refused, then the right one advances`, () => {
      let state = createGame("ABCD", mysteryId);
      state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
      state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
      if (mysteryId !== "the-treehouse") {
        state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
      }
      // Walk the witness plan up to (not including) the first choice action.
      let choiceStep: { action: string; performer: string } | null = null;
      for (;;) {
        const step = solve(state.puzzle, state.play).plan[0];
        if (!step) throw new Error(`${mysteryId}: no choice action reachable in the whole plan`);
        const action = state.puzzle.actions.find((a) => a.id === step.action)!;
        if ((action.options ?? 1) > 1) {
          choiceStep = step;
          break;
        }
        const peerId = controllerFor(state, step.performer);
        state = reduce(state, { k: "choose_action", peerId, actionId: step.action });
      }
      const action = state.puzzle.actions.find((a) => a.id === choiceStep!.action)!;
      const peerId = controllerFor(state, choiceStep!.performer);
      const beforeHistory = state.play.history.length;
      const beforeCertHash = state.certificate?.hash;

      state = reduce(state, { k: "choose_action", peerId, actionId: action.id });
      const correct = correctOptionIndex(action);
      const wrongOption = (correct + 1) % (action.options ?? 1);

      const wrong = reduce(state, { k: "choose_option", peerId, option: wrongOption });
      expect(wrong.play.history).toHaveLength(beforeHistory); // refused: no advance
      expect(wrong.certificate?.hash).toBe(beforeCertHash); // certificate untouched
      expect(wrong.pending[peerId]).toEqual({ actionId: action.id, options: action.options }); // try again
      expect(wrong.notice?.text).toBeTruthy();

      const right = reduce(wrong, { k: "choose_option", peerId, option: correct });
      expect(right.play.history.length).toBe(beforeHistory + 1); // the right one advances
      expect(right.pending[peerId]).toBeUndefined();
    });
  }
});

describe("committing a move", () => {
  it("re-certifies after every move, so the badge on screen is never stale", () => {
    const before = started();
    const after = playSteps(before, 1);
    expect(after.certificate?.ok).toBe(true);
    expect(after.certificate?.hash).not.toBe(before.certificate?.hash);
    expect(after.log[after.log.length - 1]?.text).toBe("read the note taped behind the painting");
  });

  it("asks for an option before committing an action that has alternatives", () => {
    let state = playSteps(started(), 1);
    state = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_shift_painting" });
    expect(state.play.flags).not.toContain("painting_moved");
    expect(state.pending[TV_PEER]).toEqual({ actionId: "a_shift_painting", options: 4 });
    state = reduce(state, { k: "choose_option", peerId: TV_PEER, option: 0 });
    expect(state.play.flags).toContain("painting_moved");
    expect(state.pending[TV_PEER]).toBeUndefined();
    // The log names the alternative that was picked, not just the action.
    expect(state.log[state.log.length - 1]?.text).toBe(
      "swing the painting aside (4 ways to lift it) — lift the left edge",
    );
  });

  it("ends the game only when the goal flag is actually set", () => {
    let state = started();
    expect(state.phase).toBe("playing");
    state = playSteps(state, 10);
    expect(state.play.flags).toContain("study_unlocked");
    expect(state.phase).toBe("ending");
    expect(finalBadge(state).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* What a phone is shown                                               */
/* ------------------------------------------------------------------ */

describe("a phone's view", () => {
  it("shows a role its own private clues and nobody else's", () => {
    const state = started();
    expect(phoneView(state, PEER_A).clues.map((c) => c.id)).toEqual(["painting_hint"]);
    expect(phoneView(state, PEER_B).clues.map((c) => c.id)).toEqual([
      "code_digit_1",
      "code_digit_2",
    ]);
    expect(phoneView(state, PEER_C).clues.map((c) => c.id)).toEqual(["desk_drawer_note"]);
  });

  it("tells a d-pad role to use the TV remote, and offers it no list", () => {
    const view = phoneView(started(), PEER_A);
    expect(view.mode).toBe("dpad");
    expect(view.choices).toEqual([]);
    expect(view.prompt).toBe("Use the TV remote — the d-pad is your controller");
  });

  it("gives a voice role the actions it may take, and never more than four", () => {
    const view = phoneView(started(), PEER_B);
    expect(view.mode).toBe("voice");
    // Puzzle order, so the order is the puzzle's and not a ranking this app made up.
    expect(choiceIds(view)).toEqual(["act:b_dictate_code", "act:b_describe_symbols"]);
    expect(view.choices.length).toBeLessThanOrEqual(4);
  });

  it("says nothing at all to a phone that has no role yet", () => {
    // Four phones, three roles: the fourth is told to wait rather than shown
    // somebody else's clues.
    const state = reduceApp(started(), { k: "phone_join", peerId: "phone-d" });
    const view = phoneView(state, "phone-d");
    expect(view.role).toBeNull();
    expect(view.clues).toEqual([]);
    expect(view.mode).toBe("waiting");
    expect(view.badge).toBeNull();
  });

  it("carries the badge, so a phone can show the same proof the TV does", () => {
    const state = started();
    const view = phoneView(state, PEER_C);
    expect(view.badge?.ok).toBe(true);
    expect(view.badge?.hash).toBe(state.certificate?.hash);
    expect(view.badge?.lines[0]?.label).toBe("solvable");
  });

  it("sends a notice only to the phone it is about", () => {
    const state = reduce(started(), {
      k: "choose_action",
      peerId: PEER_B,
      actionId: "a_read_painting_hint",
    });
    expect(phoneView(state, PEER_B).notice).toBe("that action belongs to A, not to B");
    expect(phoneView(state, PEER_A).notice).toBeUndefined();
  });

  it("mid-play, does not mark an absent role's line essential on a phone's own badge", () => {
    // Same shape as the lobby bug (screens.tsx:514), one layer down: A's
    // phone carries the badge the moment A joins, before B/C have -- their
    // lines must not read `ok: true` just because the puzzle needs them.
    let state = createGame("ABCD");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
    const view = phoneView(state, PEER_A);
    expect(view.badge?.ok).toBe(false);
    const aLine = view.badge?.lines.find((l) => l.label === "A essential");
    const bLine = view.badge?.lines.find((l) => l.label === "B essential");
    expect(aLine?.ok).toBe(true); // A really is here
    expect(bLine?.ok).toBe(false); // B is not, whatever the puzzle needs
    expect(bLine?.detail).toBe("B has not joined yet");
  });
});

describe("phoneMode", () => {
  it("reads a multi-capability role as the one-button mode, which is the stricter input", () => {
    expect(phoneMode(["dpad"])).toBe("dpad");
    expect(phoneMode(["voice"])).toBe("voice");
    expect(phoneMode(["dpad", "scan"])).toBe("scan");
    expect(phoneMode(["scan", "voice"])).toBe("scan");
    expect(phoneMode([])).toBe("waiting");
  });
});

describe("pageChoices", () => {
  it("hands a short list over whole", () => {
    const all = [{ id: "a", label: "a" }, { id: "b", label: "b" }];
    expect(pageChoices(all, 0)).toEqual(all);
  });

  it("pages a long list behind a More that says where you are", () => {
    const all = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, label: `a${i}` }));
    const first = pageChoices(all, 0);
    expect(first).toHaveLength(4);
    expect(first[3]?.id).toBe(MORE_CHOICE_ID);
    expect(first[3]?.label).toBe("More… (1/4)");
    const second = pageChoices(all, 1);
    expect(second[0]?.id).toBe("a3");
    // The page number wraps rather than falling off the end.
    expect(pageChoices(all, 4)[0]?.id).toBe("a0");
  });
});

/* ------------------------------------------------------------------ */
/* The switch                                                          */
/* ------------------------------------------------------------------ */

describe("the switch", () => {
  it("repairs the puzzle, keeps everything earned, and records the change", () => {
    const before = playSteps(started(), 5);
    expect(atMidpoint(before)).toBe(true);
    const tokensBefore = [...before.play.tokens];

    const asked = reduceApp(before, {
      k: "phone_input_change",
      peerId: PEER_C,
      capabilities: ["scan"],
    });
    expect(asked.phase).toBe("switching");
    expect(asked.pendingSwitch?.kind).toBe("ok");
    // The structured diff, not a rendered sentence: at least the capability
    // change itself, and a certificate to show "How we checked".
    expect(asked.pendingSwitch?.diff.length).toBeGreaterThan(0);
    expect(asked.pendingSwitch?.certificate?.ok).toBe(true);

    // The animation: one beat per tick until the four-phase script runs out.
    let state = asked;
    let ticks = 0;
    while (state.phase === "switching" && ticks < 50) {
      state = reduce(state, { k: "switch_beat" });
      ticks += 1;
    }
    expect(state.phase).toBe("playing");
    expect(ticks).toBe(SWITCH_PHASES);

    // Repaired: C now scans, and everything the team already had is still there.
    expect(state.puzzle.roles.find((r) => r.id === "C")?.capabilities).toEqual(["scan"]);
    expect(state.play.tokens).toEqual(tokensBefore);
    expect(state.certificate?.ok).toBe(true);
    expect(state.switches).toHaveLength(1);
    expect(state.switches[0]?.applied).toBe(true);
    expect(state.play.history.some((e) => e.kind === "capability_change")).toBe(true);
  });

  it("names the capability the role actually switched to, not a hardcoded one", () => {
    // A switched to voice, not scan -- but a fresh reassignment can carry
    // A's undone work onto whichever other d-pad role can still do it. So this
    // asks C, who has nowhere else to go, to isolate the announcement itself.
    let state = playSteps(started(), 1); // A has read the painting hint
    state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["voice"] });
    expect(state.pendingSwitch?.kind).toBe("ok");
    while (state.phase === "switching") state = reduce(state, { k: "switch_beat" });
    const last = state.log[state.log.length - 1]!;
    expect(last.text).toContain("voice");
    expect(last.text).not.toContain("one-button scan");
  });

  it("tells the whole story on the ending screen, switch included", () => {
    let state = playSteps(started(), 5);
    state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    while (state.phase === "switching") state = reduce(state, { k: "switch_beat" });
    state = playSteps(state, solve(state.puzzle, state.play).plan.length);

    expect(state.phase).toBe("ending");
    const lines = historyLines(state);
    expect(lines).toHaveLength(state.play.history.length);
    const switchLine = lines.find((line) => line.kind === "switch");
    expect(switchLine?.role).toBe("C");
    expect(switchLine?.text).toBe("changed input: dpad → scan");
    expect(finalBadge(state).ok).toBe(true);
  });

  it("moves C's remaining work onto C's phone, and off the TV remote", () => {
    let state = playSteps(started(), 5);
    state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    while (state.phase === "switching") state = reduce(state, { k: "switch_beat" });

    const view = phoneView(state, PEER_C);
    expect(view.mode).toBe("scan");
    expect(view.choices.length).toBeGreaterThan(0);
    expect(view.choices.length).toBeLessThanOrEqual(4);

    // The remote is a d-pad, and C no longer has one.
    const next = reduce(state, {
      k: "choose_action",
      peerId: TV_PEER,
      actionId: view.choices[0]?.id.replace(/^act:/, "") ?? "c_read_drawer_note",
    });
    expect(next.notice?.text ?? "").toMatch(/does not use the remote any more|not available/);
  });

  it("refuses a second rebuild while one is on screen, and says so to the phone that asked", () => {
    let state = playSteps(started(), 5);
    state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    const again = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    expect(again.pendingSwitch).toBe(state.pendingSwitch);
    expect(again.switches).toEqual(state.switches);
    expect(phoneView(again, PEER_C).notice).toBe("a rebuild is already on screen");
  });

  it("says no honestly when no repair holds, and leaves the old input alone", () => {
    // Six moves in, the puzzle is far enough along that C cannot be re-seated at
    // the microphone without breaking what the other two still have to do.
    const before = playSteps(started(), 6);
    const asked = reduceApp(before, {
      k: "phone_input_change",
      peerId: PEER_C,
      capabilities: ["voice"],
    });
    expect(asked.pendingSwitch?.kind).toBe("no_valid_recompile");
    expect(asked.pendingSwitch?.certificate).toBeNull();
    // A refusal does not auto-advance -- `switch_beat` is a no-op for it, so it
    // stays on screen until dismissed.
    const stillUp = reduce(asked, { k: "switch_beat" });
    expect(stillUp.phase).toBe("switching");
    const state = reduce(asked, { k: "switch_dismiss" });

    expect(state.phase).toBe("playing");
    expect(state.puzzle.roles.find((r) => r.id === "C")?.capabilities).toEqual(["dpad"]);
    expect(state.switches[0]?.applied).toBe(false);
    expect(state.notice?.text).toContain("keeps the old input");
    expect(state.log[state.log.length - 1]?.text).toContain("the switch failed");
  });

  it("reports a search that hit its bound as unsettled rather than as a no", () => {
    // A bound of 1 forces an incomplete search regardless of the app's own
    // (deeper) default -- this test is about the honesty of the "unsettled"
    // outcome, not about where the default happens to sit.
    const before = playSteps(started(), 5);
    const record = switchRecord(before.puzzle, before.play, "C", ["voice"], ASKED_BY_C, false, 1);
    expect(record.kind).toBe("search_exhausted");
    expect(record.certificate).toBeNull();
    expect(record.reason).toContain("search hit the");
    expect(record.reason).not.toContain("no repair holds");
  });

  it("never shows the solver's own words on the family TV, only in the record it keeps", () => {
    // The refusal carries the real technical reason (used only by the
    // collapsed "Details" on the refusal sheet) -- but the banner and the
    // permanent log line, which every player sees without opening anything,
    // must be plain words, never "maxDepth", "states" or "bound".
    const before = playSteps(started(), 5);
    const record = switchRecord(before.puzzle, before.play, "C", ["voice"], ASKED_BY_C, false, 1);
    expect(record.kind).toBe("search_exhausted");
    expect(record.reason).toMatch(/maxDepth|states/);
    const pending: GameState = { ...before, phase: "switching", pendingSwitch: record, switchBeat: 0 };
    const state = reduce(pending, { k: "switch_dismiss" });
    const jargon = /maxDepth|totalStatesExplored|candidate|search hit|states explored/i;
    expect(state.notice?.text).not.toMatch(jargon);
    expect(state.log[state.log.length - 1]?.text).not.toMatch(jargon);
  });

  it("raises its own default recompile depth past the validator's, and turns an unsettled case into a proven no", () => {
    // Collapsing C to voice at this exact midpoint hits the validator's
    // default depth (5) and comes back unsettled. The app asks for a deeper
    // search (see `APP_MAX_DEPTH`'s own comment in reducer.ts), so this same
    // input is a *proven* no, not a shrug.
    const before = playSteps(started(), 5);
    const atDefault = switchRecord(before.puzzle, before.play, "C", ["voice"], ASKED_BY_C, false, 5);
    const atAppDepth = switchRecord(before.puzzle, before.play, "C", ["voice"], ASKED_BY_C);
    expect(atDefault.kind).toBe("search_exhausted");
    expect(atAppDepth.kind).toBe("no_valid_recompile");
  });

  it("speaks a rebuilder error as unsettled, never as \"no repair exists\"", () => {
    // `operator_error` is the compiler reporting its own bug: nothing was shown
    // impossible, so the TV must not tell the room that no repair exists.
    const before = playSteps(started(), 5);
    const record = switchRecord(before.puzzle, before.play, "C", ["scan"], ASKED_BY_C);
    const broken = { ...record, kind: "operator_error" as const, puzzle: null, play: null };
    const pending: GameState = { ...before, phase: "switching", pendingSwitch: broken, switchBeat: 0 };
    // A refusal never auto-advances; it is dismissed explicitly.
    const state = reduce(pending, { k: "switch_dismiss" });

    expect(state.notice?.text).toContain("nothing is proven either way");
    expect(state.notice?.text).not.toContain("no repair holds");
    expect(state.puzzle.roles.find((r) => r.id === "C")?.capabilities).toEqual(["dpad"]);
    expect(state.switches[0]?.applied).toBe(false);
  });

  it("refuses an empty capability set as invalid input", () => {
    const before = playSteps(started(), 5);
    const record = switchRecord(before.puzzle, before.play, "C", [], ASKED_BY_C);
    expect(record.kind).toBe("invalid_input");
    expect(record.certificate).toBeNull();
  });

  it("will not switch a role the puzzle does not have", () => {
    const state = reduce(started(), {
      k: "request_input_change",
      role: "Z" as never,
      capabilities: ["scan"],
    });
    expect(state.phase).toBe("playing");
    expect(state.pendingSwitch).toBeNull();
  });

  it("a repeat change for the same role skips straight to the static summary", () => {
    let state = playSteps(started(), 5);
    state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    while (state.phase === "switching") state = reduce(state, { k: "switch_beat" });
    expect(state.switches.filter((s) => s.kind === "ok")).toHaveLength(1);

    // C changes their mind again -- back to dpad. This is C's second applied
    // switch this run, so it should not replay the eight-second sequence.
    const second = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["dpad"] });
    expect(second.pendingSwitch?.repeat).toBe(true);
    expect(second.switchBeat).toBe(SWITCH_PHASES - 1);
  });

  describe("Continue: a skip control, never a game move", () => {
    it("consumes the dismissal without also acting on any pending puzzle choice", () => {
      let state = playSteps(started(), 5);
      state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
      expect(state.phase).toBe("switching");
      // Continue is its own reducer action, distinct from choose_option/choose_action:
      // it cannot be spelled as one, so it cannot double as a puzzle answer.
      const continued = reduce(state, { k: "switch_dismiss" });
      expect(continued.phase).toBe("playing");
      expect(continued.pending).toEqual({});
    });

    it("only the changed player's own phone may continue their switch", () => {
      const before = playSteps(started(), 5);
      const asked = reduceApp(before, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
      // B's phone tries to dismiss C's moment: refused, nothing changes.
      const attempted = reduceApp(asked, { k: "phone_continue_switch", peerId: PEER_B });
      expect(attempted.phase).toBe("switching");
      expect(attempted.pendingSwitch).toBe(asked.pendingSwitch);

      const byC = reduceApp(asked, { k: "phone_continue_switch", peerId: PEER_C });
      expect(byC.phase).toBe("playing");
    });

    it("dismisses a refusal on demand, and never auto-resolves one on its own", () => {
      const before = playSteps(started(), 6);
      const asked = reduceApp(before, { k: "phone_input_change", peerId: PEER_C, capabilities: ["voice"] });
      expect(asked.pendingSwitch?.kind).toBe("no_valid_recompile");
      // switch_beat (the timed tick) is a no-op for a refusal.
      expect(reduce(asked, { k: "switch_beat" }).phase).toBe("switching");
      expect(reduce(asked, { k: "switch_dismiss" }).phase).toBe("playing");
    });
  });
});

/* ------------------------------------------------------------------ */
/* Every intent is valid only in the phase it belongs to */
/* ------------------------------------------------------------------ */

/**
 * The phase x intent acceptance table `PLAYING_ONLY_INTENTS` and
 * `BLOCKED_WHILE_SWITCHING` (reducer.ts) encode, walked cell by cell against
 * the four representative phases below -- this is what keeps those two sets
 * honest.
 *
 * Two gaps let a stale board keep acting on a puzzle that was about to move
 * out from under it: `request_input_change` was refused
 * only while a rebuild was already on screen, so it could still be raised
 * from the lobby (reducer.ts:1636); `choose_action`/`choose_option` carried
 * no phase check of their own at all, so a rebuild in flight did not stop a
 * puzzle move from landing mid-repair (reducer.ts:1186).
 */
describe("the phase x intent table", () => {
  /** Only A has joined -- the lobby is genuinely still open. */
  function lobbyWithA(): GameState {
    let state = createGame("ABCD");
    return reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A" });
  }

  function switching(): GameState {
    const state = playSteps(started(), 5);
    const asked = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    expect(asked.phase).toBe("switching");
    return asked;
  }

  function ending(): GameState {
    const state = playSteps(started(), solve(started().puzzle, started().play).plan.length);
    expect(state.phase).toBe("ending");
    return state;
  }

  describe("request_input_change: accepted only while playing", () => {
    it("lobby: refused with a courteous notice, not silence", () => {
      const state = lobbyWithA();
      const asked = reduceApp(state, { k: "phone_input_change", peerId: PEER_A, capabilities: ["voice"] });
      expect(asked.phase).toBe("lobby");
      expect(asked.pendingSwitch).toBeNull();
      expect(phoneView(asked, PEER_A).notice).toBe("wait for everyone to join before changing input");
    });

    it("playing: accepted, moves to switching", () => {
      const state = playSteps(started(), 5);
      const asked = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
      expect(asked.phase).toBe("switching");
    });

    it("switching: refused, a second request does not replace the first", () => {
      const state = switching();
      const again = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["voice"] });
      expect(again.pendingSwitch).toBe(state.pendingSwitch);
      expect(phoneView(again, PEER_C).notice).toBe("a rebuild is already on screen");
    });

    it("ending: refused with a courteous notice, not silence", () => {
      const state = ending();
      const asked = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["voice"] });
      expect(asked.phase).toBe("ending");
      expect(asked.pendingSwitch).toBeNull();
      expect(phoneView(asked, PEER_C).notice).toBe("input can only change while the game is on");
    });

    it("the raw intent, sent directly, is refused identically outside playing (reducer.ts:1636)", () => {
      const lobby = lobbyWithA();
      const asked = reduce(lobby, { k: "request_input_change", role: "A", capabilities: ["voice"] });
      expect(asked).toBe(lobby); // the entry gate leaves it untouched
    });

    it("phoneView never offers the change outside playing", () => {
      expect(phoneView(lobbyWithA(), PEER_A).canChangeInput).toBe(false);
      expect(phoneView(playSteps(started(), 5), PEER_A).canChangeInput).toBe(true);
      expect(phoneView(switching(), PEER_A).canChangeInput).toBe(false);
      expect(phoneView(ending(), PEER_A).canChangeInput).toBe(false);
    });
  });

  describe("choose_action / choose_option / cancel_choice: refused only mid-rebuild (reducer.ts:1186)", () => {
    it("switching: the entry gate leaves the state untouched, for all three intents", () => {
      const state = switching();
      expect(reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_read_painting_hint" })).toBe(
        state,
      );
      expect(reduce(state, { k: "choose_option", peerId: TV_PEER, option: 0 })).toBe(state);
      expect(reduce(state, { k: "cancel_choice", peerId: TV_PEER })).toBe(state);
    });

    it("switching: a phone is not shown a choice that is certain to be refused", () => {
      const state = switching();
      const view = phoneView(state, PEER_A);
      expect(view.choices).toEqual([]);
      expect(view.choiceKind).toBe("none");
    });

    it("lobby: still reachable, so a d-pad press for an unjoined role gets a reason, not silence", () => {
      const state = createGame(); // nobody joined at all
      const next = reduce(state, { k: "choose_action", peerId: TV_PEER, actionId: "a_read_painting_hint" });
      expect(next).not.toBe(state);
      expect(next.notice?.text).toContain("has not joined yet");
    });

    it("ending: still reachable, and finds nothing left to do", () => {
      const state = ending();
      const next = reduce(state, {
        k: "choose_action",
        peerId: TV_PEER,
        actionId: "a_read_painting_hint",
      });
      expect(next).not.toBe(state);
      expect(next.notice?.text).toContain("not available right now");
    });

    it("playing: unaffected -- covered throughout 'the switch' and 'refusing a move at the table' above", () => {
      const state = playSteps(started(), 1);
      expect(state.play.history.length).toBeGreaterThan(0);
    });
  });

  it("resolveSwitch is reached only through switch_beat/switch_dismiss, which are themselves no-ops without a pendingSwitch -- so it never jumps phase from anything but switching", () => {
    for (const state of [lobbyWithA(), playSteps(started(), 5), ending()]) {
      expect(state.pendingSwitch).toBeNull();
      expect(reduce(state, { k: "switch_beat" })).toBe(state);
      expect(reduce(state, { k: "switch_dismiss" })).toBe(state);
    }
  });
});

describe("a certificate cannot go green while the switching seat is absent", () => {
  it("refuses a phone's own input-change request once its seat has disconnected", () => {
    let state = playSteps(started(), 5);
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    expect(isConnected(state, "C")).toBe(false);
    const asked = reduceApp(state, {
      k: "phone_input_change",
      peerId: PEER_C,
      capabilities: ["scan"],
    });
    expect(asked.phase).toBe("playing");
    expect(asked.pendingSwitch).toBeNull();
    expect(asked.switches).toHaveLength(0);
  });

  it("refuses the raw request_input_change action too, for the same disconnected role", () => {
    let state = playSteps(started(), 5);
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    const asked = reduce(state, { k: "request_input_change", role: "C", capabilities: ["scan"] });
    expect(asked.phase).toBe("playing");
    expect(asked.pendingSwitch).toBeNull();
  });

  it("does not let the claim read green once the switching seat drops before dismissal", () => {
    let state = playSteps(started(), 5);
    state = reduceApp(state, { k: "phone_input_change", peerId: PEER_C, capabilities: ["scan"] });
    expect(state.phase).toBe("switching");
    // C drops while their own rebuild is still pending on screen.
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    state = reduce(state, { k: "switch_dismiss" });

    expect(state.phase).toBe("playing");
    // The proof itself still holds for the roles -- nothing here is a false
    // negative about the puzzle.
    expect(state.certificate?.ok).toBe(true);
    expect(heldRolesIn(state)).toEqual(["C"]);
    // But it is not safe to tell the room "you can finish together" while C
    // is held: the claim must say who it is waiting for instead.
    expect(claimHolds(state)).toBe(false);
  });

  it("reads true once more when everyone named in the certificate is actually connected", () => {
    const state = playSteps(started(), 5);
    expect(claimHolds(state)).toBe(true);
  });
});

describe("the four refusal kinds stay visibly different", () => {
  it("gives each of the four kinds its own heading, body and next action", () => {
    const kinds = ["no_valid_recompile", "search_exhausted", "invalid_input", "operator_error"] as const;
    const copies = kinds.map((kind) => refusalCopy(kind));
    expect(new Set(copies.map((c) => c.heading)).size).toBe(kinds.length);
    expect(new Set(copies.map((c) => c.body)).size).toBe(kinds.length);
    for (const copy of copies) {
      expect(copy.heading).not.toMatch(/no repair holds/i);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Seats: a phone that drops, and a phone that comes back              */
/* ------------------------------------------------------------------ */

/** The same three phones, each carrying the seat it minted for itself. */
function seated(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A", seat: "seat-a" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B", seat: "seat-b" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C", seat: "seat-c" });
  return state;
}

describe("a seat held for a phone that has gone", () => {
  it("keeps the role while the grace period runs, and says it is being held", () => {
    const state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    expect(roleOfPeer(state, PEER_B)).toBe("B");
    expect(isConnected(state, "B")).toBe(false);
    expect(state.log.at(-1)?.text).toContain("B is held for 3 minutes");
  });

  it("holds the seat for three minutes, not thirty seconds", () => {
    // The whole point of the hold is a phone that comes back: a locked phone
    // picked up again, a browser reloaded, a walk to the charger and back.
    // Thirty seconds is shorter than any of those.
    expect(SEAT_GRACE_MS).toBe(180_000);
  });

  it("frees the role when the grace period is up, and says so in the log", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS - 1 });
    expect(roleOfPeer(state, PEER_B)).toBe("B"); // a second short of the deadline
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    expect(state.players.some((player) => player.peerId === PEER_B)).toBe(false);
    expect(state.players.some((player) => player.role === "B")).toBe(false);
    expect(state.log.at(-1)?.text).toContain("B is free again");
  });

  it("hands the seat back, with nothing to answer on the TV, to a phone that comes back inside the grace period on a new peer id", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    // The relay gives the reconnecting phone a new peer id, and the only
    // thing that says which browser the seat belongs to is the token it
    // carries. Nobody is sitting at B, so the seat comes back with the join:
    // the remote's OK is for taking a seat somebody is playing right now.
    state = reduceApp(state, { k: "phone_join", peerId: "phone-b-2", name: "Bo", seat: "seat-b" });
    expect(roleOfPeer(state, "phone-b-2")).toBe("B");
    expect(state.pendingReclaim).toBeNull();
    // The seat is still backed by exactly one record and one token: the
    // returning connection took the held record over rather than sitting
    // down beside it.
    expect(state.players.filter((player) => player.seat === "seat-b")).toHaveLength(1);
    expect(state.players.some((player) => player.peerId === PEER_B)).toBe(false);
    expect(heldRolesIn(state)).toEqual([]);
  });

  it("still raises a TV approval for a token that names a seat somebody is playing right now", () => {
    // The other half of the rule: while Bo is connected, a token presented
    // on a different connection is a live-seat contest, and a seat is never
    // handed over without the room seeing the question.
    let state = seated();
    state = reduceApp(state, { k: "phone_join", peerId: "phone-b-2", name: "Bo", seat: "seat-b" });
    expect(roleOfPeer(state, "phone-b-2")).toBeNull(); // not seated yet
    expect(state.pendingReclaim).toMatchObject({ peerId: "phone-b-2", name: "Bo", role: "B", via: "token" });
    // The token stays on exactly ONE record while the TV's OK is pending --
    // the live original. A claimant records what it is claiming in
    // `claimedSeat` and never copies it into `seat`, so there is no window
    // in which two records carry one token at all.
    expect(state.players.filter((player) => player.seat === "seat-b")).toHaveLength(1);
    expect(state.players.find((player) => player.seat === "seat-b")?.role).toBe("B");
    const requester = state.players.find((player) => player.peerId === "phone-b-2")!;
    expect(requester.claimedSeat).toBe("seat-b");
    expect(requester.seat).toBeNull();
    // One press on the TV remote is what actually hands it over.
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "phone-b-2")).toBe("B");
    expect(state.players.filter((player) => player.seat === "seat-b")).toHaveLength(1);
    // A token is a bearer token, so the log says what actually happened -- the
    // seat was moved to another phone and the earlier connection closed --
    // rather than asserting the returning phone is the same one that left.
    expect(state.log.at(-1)?.text).toContain("moved B's seat to another phone");
    expect(state.log.at(-1)?.text).not.toContain("is theirs again");
    expect(state.superseded).toMatchObject({ peerId: PEER_B });
  });

  it("keeps the token merge automatic when it is the seat's own live connection re-announcing itself, not a reconnect", () => {
    // Nothing dropped here -- same peer id, still connected -- so this is the
    // relay resending `join`, or a phone picking a role right after minting
    // its token, never a reconnect. It must stay exactly as automatic as it
    // always was.
    let state = seated();
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", seat: "seat-b" });
    expect(roleOfPeer(state, PEER_B)).toBe("B");
    expect(state.pendingReclaim).toBeNull();
  });

  it("no longer merges by name on an ordinary join -- it lands as a stranger, same as any newcomer", () => {
    // A locked phone that lost its seat token has no proof it is Bo, only the
    // name it types -- and a name is public, not a secret. Typing it on the
    // ordinary join form must not silently hand the seat back any more; the
    // deliberate `reclaim_seat` box (below) is the only way back, and even
    // that now waits on the TV's own OK.
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-b-3", name: "Bo" });
    expect(roleOfPeer(state, "phone-b-3")).toBeNull();
    expect(state.players).toHaveLength(4); // a genuine newcomer, not merged into Bo's held seat
    expect(state.log.at(-1)?.text).toContain("held for someone who stepped away");
    expect(phoneView(state, "phone-b-3").heldRoles).toEqual(["B"]);
  });

  it("says a seat is held, not that the room blames the newcomer, when a stranger arrives during someone's hold", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    // A genuine stranger -- no seat, no matching name -- while B's seat is
    // still held: the room is not actually full, one seat is just waiting.
    state = reduceApp(state, { k: "phone_join", peerId: "phone-d", name: "Dee" });
    expect(roleOfPeer(state, "phone-d")).toBeNull();
    expect(state.log.at(-1)?.text).toContain("held for someone who stepped away");
    expect(state.log.at(-1)?.text).not.toContain("every role is taken");
    // The picker this stranger is shown agrees with the TV: B still reads as
    // taken (held), never offered as free during the hold.
    expect(phoneView(state, "phone-d").takenRoles).toContain("B");
  });

  it("never hands a name match a role that is still connected under someone else", () => {
    // A name is not a secret and is not unique -- it must only ever match a
    // seat that is actually being HELD (disconnected), never steal a live one.
    const state = reduceApp(seated(), { k: "phone_join", peerId: "phone-impostor", name: "Bo" });
    expect(roleOfPeer(state, "phone-impostor")).toBeNull();
    expect(roleOfPeer(state, PEER_B)).toBe("B"); // Bo's real, connected seat is untouched
  });

  describe("reclaim_seat: the way back for a phone that reopened the join link", () => {
    // The mid-game case: a phone reopens the join link (a fresh tab, so a
    // fresh seat and no name typed at Join) after B dropped. That first
    // `join` cannot match anything -- so it lands as a genuine stranger, role
    // null, exactly like `phone-d` above -- and the join form is gone by
    // then. `reclaim_seat` is the way back from that screen: it is checked
    // against `state.players` directly, independent of `player_joined`'s
    // seat/name heuristics, so a stranger already registered under this
    // peer id can still say "I'm actually Bo" without a new connection.
    function strangerDuringHold(): GameState {
      let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
      state = reduceApp(state, { k: "phone_join", peerId: "phone-returning", name: "" });
      return state;
    }

    it("tells a role-less phone which seat is being held, so it knows there is something to do", () => {
      const state = strangerDuringHold();
      expect(phoneView(state, "phone-returning").heldRoles).toEqual(["B"]);
    });

    it("raises a request for the TV, but does not hand the seat over on the name alone", () => {
      let state = strangerDuringHold();
      state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
      expect(roleOfPeer(state, "phone-returning")).toBeNull();
      expect(state.pendingReclaim).toMatchObject({ peerId: "phone-returning", name: "Bo", role: "B" });
      expect(phoneView(state, "phone-returning").heldRoles).toEqual(["B"]); // still just held, not theirs yet
    });

    it("gives the seat back to the same peer id that was just a stranger, once the TV says OK", () => {
      let state = strangerDuringHold();
      state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
      state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
      expect(roleOfPeer(state, "phone-returning")).toBe("B");
      expect(state.players).toHaveLength(3); // merged into Bo's held seat, not a fourth player
      expect(state.pendingReclaim).toBeNull();
      expect(state.log.at(-1)?.text).toContain("is back");
      expect(phoneView(state, "phone-returning").heldRoles).toEqual([]);
    });

    it("the TV can decline instead: the seat stays held, not handed to the requester", () => {
      let state = strangerDuringHold();
      state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
      state = reduce(state, { k: "decline_reclaim", requestId: onScreenRequestId(state) });
      expect(state.pendingReclaim).toBeNull();
      expect(roleOfPeer(state, "phone-returning")).toBeNull();
      expect(state.players.some((p) => p.role === "B" && !p.connected)).toBe(true); // still held
    });

    it("refuses a blank name rather than guessing", () => {
      const state = reduceApp(strangerDuringHold(), {
        k: "phone_reclaim_seat",
        peerId: "phone-returning",
        name: "   ",
      });
      expect(roleOfPeer(state, "phone-returning")).toBeNull();
    });

    it("refuses a name nothing is held for", () => {
      const state = reduceApp(strangerDuringHold(), {
        k: "phone_reclaim_seat",
        peerId: "phone-returning",
        name: "Nobody",
      });
      expect(roleOfPeer(state, "phone-returning")).toBeNull();
    });

    it("never lets a reclaim take a role that is still connected under someone else", () => {
      const state = reduceApp(strangerDuringHold(), {
        k: "phone_reclaim_seat",
        peerId: "phone-returning",
        name: "Ada", // A is connected and playing, not held
      });
      expect(roleOfPeer(state, "phone-returning")).toBeNull();
      expect(roleOfPeer(state, PEER_A)).toBe("A"); // untouched
    });

    it("refuses a reclaim from a phone that already holds a role of its own", () => {
      // C's seat really is held here -- the guard has to be "you already have
      // a role", not just "nothing to reclaim".
      let state = reduce(seated(), { k: "player_left", peerId: PEER_C, at: 1_000 });
      state = reduceApp(state, { k: "phone_reclaim_seat", peerId: PEER_A, name: "Cy" });
      expect(roleOfPeer(state, PEER_A)).toBe("A"); // unchanged, not silently swapped to C
      expect(state.players.some((p) => p.role === "C" && !p.connected)).toBe(true); // still held
    });
  });

  it("frees the role for somebody else once the grace period has passed", () => {
    let state = createGame("ABCD");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B" });
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-c", name: "Cy", want: "B" });
    expect(roleOfPeer(state, "phone-c")).toBe("B");
  });

  it("does not restart the clock when the relay reports the drop twice", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 20_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    expect(state.players.some((player) => player.role === "B")).toBe(false);
  });

  it("carries a half-made choice across a reconnect, keyed to the new peer id the join moved it to", () => {
    // The TV keys a pending choice by peer id, and the relay hands a returning
    // phone a NEW one. A seat nobody is playing hands back on the token alone,
    // so the join that takes the seat is the step the choice has to move in --
    // the phone comes back to the pick it had open, not to a blank screen.
    let state = seated();
    state = reduce(state, { k: "choose_action", peerId: PEER_A, actionId: "a_read_painting_hint" });
    state = reduce(state, { k: "choose_action", peerId: PEER_A, actionId: "a_shift_painting" });
    expect(state.pending[PEER_A]?.actionId).toBe("a_shift_painting");
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-a-2", name: "Ada", seat: "seat-a" });
    expect(roleOfPeer(state, "phone-a-2")).toBe("A");
    expect(state.pending["phone-a-2"]?.actionId).toBe("a_shift_painting");
    expect(state.pending[PEER_A]).toBeUndefined();
    state = reduce(state, { k: "choose_option", peerId: "phone-a-2", option: 0 });
    expect(state.play.flags).toContain("painting_moved");
  });

  it("drops what was keyed to a phone whose seat it sweeps", () => {
    let state = seated();
    state = reduce(state, { k: "choose_action", peerId: PEER_A, actionId: "a_read_painting_hint" });
    state = reduce(state, { k: "choose_action", peerId: PEER_A, actionId: "a_shift_painting" });
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    expect(state.players.some((player) => player.peerId === PEER_A)).toBe(false);
    expect(state.pending[PEER_A]).toBeUndefined();
    expect(state.pages[PEER_A]).toBeUndefined();
  });

  it("sweeps nothing at all while everybody is connected", () => {
    const state = seated();
    expect(reduce(state, { k: "sweep_seats", at: 10 ** 9 })).toBe(state);
  });
});

/* ------------------------------------------------------------------ */
/* Changing role                                                       */
/* ------------------------------------------------------------------ */

describe("changing role", () => {
  it("gives the role back and returns the phone to the picker", () => {
    let state = started();
    state = reduceApp(state, { k: "phone_release_role", peerId: PEER_B });
    expect(roleOfPeer(state, PEER_B)).toBeNull();
    const view = phoneView(state, PEER_B);
    expect(view.role).toBeNull();
    expect(view.mode).toBe("waiting");
    expect(view.prompt).toBe("You are not holding a role — pick one");
    // Nothing of the role it left comes with it.
    expect(view.clues).toEqual([]);
    expect(view.canChangeRole).toBe(false);
    expect(state.log.at(-1)?.text).toContain("gave up B");
  });

  it("lists the roles somebody is sitting in, so the picker can disable them", () => {
    const state = started();
    expect(phoneView(state, PEER_A).takenRoles).toEqual(["A", "B", "C"]);
    let released = reduce(state, { k: "release_role", peerId: PEER_B });
    expect(phoneView(released, PEER_B).takenRoles).toEqual(["A", "C"]);
  });

  it("refuses a role somebody else is in, and says which", () => {
    let state = reduce(started(), { k: "release_role", peerId: PEER_B });
    state = reduce(state, { k: "assign_role", peerId: PEER_B, role: "C" });
    expect(roleOfPeer(state, PEER_B)).toBeNull();
    expect(phoneView(state, PEER_B).notice).toBe("C is already taken");
  });

  it("moves a phone onto another role, and leaves the one it left free", () => {
    let state = started();
    state = reduce(state, { k: "release_role", peerId: PEER_B });
    state = reduce(state, { k: "release_role", peerId: PEER_A });
    state = reduce(state, { k: "assign_role", peerId: PEER_B, role: "A" });
    expect(roleOfPeer(state, PEER_B)).toBe("A");
    expect(phoneView(state, PEER_A).takenRoles).toEqual(["A", "C"]);
    state = reduce(state, { k: "assign_role", peerId: PEER_A, role: "B" });
    expect(roleOfPeer(state, PEER_A)).toBe("B");
    expect(state.log.at(-1)?.text).toContain("took B");
  });

  it("lets a phone that was waiting take a role that has just been given up", () => {
    let state = reduceApp(started(), { k: "phone_join", peerId: "phone-d", name: "Di", seat: "seat-d" });
    expect(roleOfPeer(state, "phone-d")).toBeNull();
    state = reduceApp(state, { k: "phone_release_role", peerId: PEER_B });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-d", name: "Di", seat: "seat-d", want: "B" });
    expect(roleOfPeer(state, "phone-d")).toBe("B");
  });

  it("drops anything the phone had half-picked when it gives its role up", () => {
    let state = started();
    state = reduce(state, { k: "choose_action", peerId: PEER_B, actionId: "b_dictate_code" });
    state = reduce(state, { k: "release_role", peerId: PEER_B });
    expect(state.pending[PEER_B]).toBeUndefined();
  });

  it("says so rather than throwing when a phone with no role gives one up", () => {
    const state = reduce(started(), { k: "release_role", peerId: "phone-d" });
    expect(state.players.some((player) => player.peerId === "phone-d")).toBe(false);
    expect(state.log.at(-1)?.text).not.toContain("gave up");
  });

  it("offers the change while the game is on, and not mid-rebuild", () => {
    const playing = started();
    expect(phoneView(playing, PEER_A).canChangeRole).toBe(true);
    const switching = reduce(playing, {
      k: "request_input_change",
      role: "C",
      capabilities: ["scan"],
    });
    expect(switching.phase).toBe("switching");
    expect(phoneView(switching, PEER_C).canChangeRole).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Board helpers                                                       */
/* ------------------------------------------------------------------ */

describe("the board", () => {
  it("lists who still has something to do, in role order", () => {
    const state = started();
    expect(outstandingRoles(state)).toEqual(["A", "B", "C"]);
  });

  it("has a puzzle whose untouched state is the validator's own demo", () => {
    const state = createGame();
    expect(state.puzzle.id).toBe(demoPuzzle().id);
    expect(state.play).toEqual(emptyState());
  });
});

/* ------------------------------------------------------------------ */
/* Seat claims: a name, a token, and what the TV must decide   */
/* ------------------------------------------------------------------ */

describe("the claim must not go green over a role nobody occupies", () => {
  it("does not restore the green claim when a held role is swept away entirely", () => {
    let state = playSteps(started(), 5);
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    expect(claimHolds(state)).toBe(false);
    state = reduce(state, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
    expect(state.players.some((p) => p.role === "B")).toBe(false);
    expect(heldRolesIn(state)).toEqual([]); // the bug: swept away, so no longer "held"
    expect(claimHolds(state)).toBe(false);
  });

  it("does not restore the green claim after a connected player releases a required role", () => {
    let state = playSteps(started(), 5);
    state = reduce(state, { k: "release_role", peerId: PEER_B });
    expect(roleOfPeer(state, PEER_B)).toBeNull();
    expect(heldRolesIn(state)).toEqual([]); // the bug: released, so no longer "held" either
    expect(claimHolds(state)).toBe(false);
  });
});

describe("a public name must not grant a seat on its own", () => {
  function strangerDuringHold(): GameState {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-returning", name: "" });
    return state;
  }

  it("does not immediately grant the seat from the ordinary reclaim box, with no TV say-so", () => {
    let state = reduceApp(strangerDuringHold(), {
      k: "phone_reclaim_seat",
      peerId: "phone-returning",
      name: "Bo",
    });
    // The bug: this already hands the role over, with nobody on the TV having
    // approved anything -- a public name was the whole credential.
    expect(roleOfPeer(state, "phone-returning")).toBeNull();
  });

  it("does not let a peer that never joined claim a held seat by typing its public name", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, {
      k: "phone_reclaim_seat",
      peerId: "never-joined",
      name: "Bo",
    });
    // The bug: `reclaim_seat` is checked against `state.players` and never
    // asks whether the requesting peer id has ever joined at all.
    expect(roleOfPeer(state, "never-joined")).toBeNull();
    expect(roleOfPeer(state, PEER_B)).toBe("B");
  });
});

describe("a held-seat token is the whole of the proof, and a live one is only a request", () => {
  // B drops. The seat is a chair nobody is sitting in, kept warm only so its
  // owner can come back to it -- and the 32-hex token is the only thing that
  // says whose chair it is. Nothing on the wire can tell the owner's own phone
  // reopening apart from somebody who intercepted the token, so the token is
  // taken at its word: a walk to the remote for a player who did nothing but
  // reload is a cost the room pays on every reconnect, for a secret an
  // attacker would have to have stolen first. The moment anybody IS playing
  // the seat, the same token stops being proof and becomes a request -- see
  // "the TV's approval is the only thing that supersedes a live connection".
  it("hands the seat straight back to whoever presents the token, once nobody is playing it", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "never-joined-replay", seat: "seat-b" });
    expect(roleOfPeer(state, "never-joined-replay")).toBe("B");
    expect(state.pendingReclaim).toBeNull(); // nothing for the TV to answer
    // The seat moved rather than being copied: one record holds B, and B's
    // old connection is not left sitting on the role as well.
    expect(state.players.filter((p) => p.role === "B")).toHaveLength(1);
    expect(checkSeatInvariants(state)).toEqual([]);
  });

  it("the TV can still decline a reclaim by NAME of a held seat -- a name is public, and proves nothing", () => {
    // The deliberate route back to a seat whose token is gone. A name is on
    // the join form and on the TV screen, so it only ever raises a question.
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-returning", name: "" });
    state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
    expect(state.pendingReclaim).toMatchObject({ peerId: "phone-returning", name: "Bo", role: "B" });
    expect(state.pendingReclaim?.via).toBeUndefined(); // the by-name route, not a token
    state = reduce(state, { k: "decline_reclaim", requestId: onScreenRequestId(state) });
    expect(state.pendingReclaim).toBeNull();
    expect(roleOfPeer(state, "phone-returning")).toBeNull();
    expect(state.players.some((p) => p.role === "B" && !p.connected)).toBe(true); // still held
  });

  it("does not let a seat handed back on a token clobber a name reclaim already waiting for the TV", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduce(state, { k: "player_left", peerId: PEER_C, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-returning", name: "" });
    state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
    expect(state.pendingReclaim?.peerId).toBe("phone-returning");
    // A token for the OTHER held seat arrives while that one is still
    // waiting. It settles on its own -- there is no question to queue for --
    // and the request on the TV is left exactly where it was.
    state = reduceApp(state, { k: "phone_join", peerId: "replay-for-c", seat: "seat-c" });
    expect(state.pendingReclaim?.peerId).toBe("phone-returning"); // unchanged
    expect(roleOfPeer(state, "replay-for-c")).toBe("C");
  });

  it("stays automatic when the token belongs to a role nobody ever held (a roleless seat is not a reclaim)", () => {
    // Only a seat that actually HELD a role raises the TV's approval --
    // a token that never carried one merges the same quiet way it always did.
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-returning", name: "", seat: "no-role-token" });
    state = reduce(state, { k: "player_left", peerId: "phone-returning", at: 2_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-returning-2", name: "", seat: "no-role-token" });
    expect(state.pendingReclaim).toBeNull();
    expect(roleOfPeer(state, "phone-returning-2")).toBeNull();
  });
});

describe("a colliding seat token is never stored on a stray, uninvolved record", () => {
  it("a colliding token still leaves exactly one player carrying it -- the connection actually playing under it", () => {
    const state = reduceApp(seated(), {
      k: "phone_join",
      peerId: "second-tab",
      name: "Mallory",
      seat: "seat-b",
    });
    const holders = state.players.filter((p) => p.seat === "seat-b");
    expect(holders).toHaveLength(1);
    expect(holders[0]!.peerId).toBe(PEER_B); // the live seat, untouched by the arrival
    // The newcomer records what it is asking for, and carries no token of
    // anybody's -- the TV is what decides whether it ever gets one.
    expect(state.players.find((p) => p.peerId === "second-tab")!.seat).toBeNull();
    expect(state.players.find((p) => p.peerId === "second-tab")!.claimedSeat).toBe("seat-b");
  });

  it("never lets an already-seated player overwrite its own seat by re-joining with someone else's token", () => {
    const state = reduceApp(seated(), { k: "phone_join", peerId: PEER_A, name: "Ada", seat: "seat-b" });
    expect(state.players.find((p) => p.peerId === PEER_A)!.seat).toBe("seat-a"); // immutable, untouched
    const bTokenHolders = state.players.filter((p) => p.seat === "seat-b");
    expect(bTokenHolders).toHaveLength(1);
    expect(bTokenHolders[0]!.peerId).toBe(PEER_B);
    expect(roleOfPeer(state, PEER_A)).toBe("A"); // A's own role is untouched too
  });

  it("still lets the real B reconnect with seat-b after A tried to overwrite it with that token", () => {
    let state = reduceApp(seated(), { k: "phone_join", peerId: PEER_A, name: "Ada", seat: "seat-b" });
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-b-2", name: "Bo", seat: "seat-b" });
    // Not blocked by A's earlier attempt, and not held up by it either: the
    // seat is nobody's while B is away, so the token takes it on the spot.
    expect(roleOfPeer(state, "phone-b-2")).toBe("B");
    expect(state.pendingReclaim).toBeNull();
  });

  it("never lets an already-seated but TOKENLESS legacy player relabel itself with someone else's live token", () => {
    // Same shape as the token-holding case above, except the seated player
    // never minted a seat token of its own -- an old client, or one that
    // never implemented seat storage. The immutable-presentedSeat rule
    // applies here too: this connection must not copy B's live token onto
    // itself just because it has no `seat` of its own to guard it.
    let state = reduceApp(createGame("ABCD"), { k: "phone_join", peerId: "legacy-a", want: "A" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B", seat: "seat-b" });
    state = reduceApp(state, { k: "phone_join", peerId: "legacy-a", want: "A", seat: "seat-b" });

    expect(playerByPeer(state, "legacy-a")?.presentedSeat).toBeNull(); // untouched
    expect(roleOfPeer(state, "legacy-a")).toBe("A"); // A's own role is untouched too
    expect(checkSeatInvariants(state)).toEqual([]); // no I14 violation

    // The real holder can still drop and come back on its own token --
    // legacy-a's attempt must not have locked it out.
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-b-returned", seat: "seat-b" });
    expect(roleOfPeer(state, "phone-b-returned")).toBe("B");
    expect(state.pendingReclaim).toBeNull();
  });

  it("lets a tokenless role holder bind its own first, non-colliding token, and reclaim with it after dropping", () => {
    // legacy-a joins nameless and tokenless, same as the relabel test above --
    // then, on that SAME connection, its browser finishes minting a token of
    // its own and presents it. Nobody else owns or has presented "seat-a": it
    // is legacy-a's first genuine token, not a foreign relabel, so it must be
    // adopted -- unlike the an earlier version test just above, where "seat-b" was
    // already live under B.
    let state = reduceApp(createGame("ABCD"), { k: "phone_join", peerId: "legacy-a", want: "A" });
    state = reduceApp(state, { k: "phone_join", peerId: "legacy-a", seat: "seat-a" });

    expect(playerByPeer(state, "legacy-a")?.presentedSeat).toBe("seat-a"); // adopted, not refused
    expect(playerByPeer(state, "legacy-a")?.seat).toBe("seat-a");
    expect(roleOfPeer(state, "legacy-a")).toBe("A");
    expect(checkSeatInvariants(state)).toEqual([]);

    // It drops, and comes back under a brand new peer id (a fresh tab/relay
    // connection) presenting that same token -- the seat is nobody's while it
    // is away, so it comes straight back, not stuck for the full grace window
    // the way a genuinely tokenless holder would be.
    state = reduce(state, { k: "player_left", peerId: "legacy-a", at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "legacy-a-returned", seat: "seat-a" });
    expect(roleOfPeer(state, "legacy-a-returned")).toBe("A");
    expect(state.pendingReclaim).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Every cross-peer token event ends in a TV decision */
/* ------------------------------------------------------------------ */

describe("a live-token collision waits for the TV, and then hands the newcomer exactly the older connection's own role", () => {
  /** A seated, B and C free, and a second connection presenting seat-a's own live token. */
  function collided(): GameState {
    return reduceApp(
      reduceApp(createGame("ABCD"), { k: "phone_join", peerId: PEER_A, want: "A", seat: "seat-a" }),
      { k: "phone_join", peerId: "phone-a-2", seat: "seat-a" }, // no `want`, but seat-a is A's own live seat token
    );
  }

  it("leaves the live seat exactly where it is, and asks the TV about it", () => {
    const state = collided();
    expect(roleOfPeer(state, PEER_A)).toBe("A"); // still playing, still connected
    expect(roleOfPeer(state, "phone-a-2")).toBeNull();
    expect(state.superseded).toBeNull(); // nothing is superseded without the TV saying so
    expect(state.pendingReclaim).toMatchObject({ peerId: "phone-a-2", role: "A", via: "token" });
  });

  it("hands over A's own role on approval, not a different free one, whatever else is open", () => {
    let state = collided();
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "phone-a-2")).toBe("A"); // A's exact role, never a free B or C
    expect(state.players.some((p) => p.peerId === PEER_A)).toBe(false); // renamed, not a stray record
    expect(state.superseded).toMatchObject({ peerId: PEER_A });
    expect(state.log.at(-1)?.text).toContain("the earlier connection was closed");
  });

  it("the superseded peer id's own later drop is a no-op -- it is already gone", () => {
    let state = collided();
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    state = reduce(state, { k: "player_left", peerId: PEER_A, at: 1_000 });
    expect(roleOfPeer(state, "phone-a-2")).toBe("A"); // untouched by the stale drop
    expect(state.pendingReclaim).toBeNull();
  });

  it("never costs an already-seated player its own role, even colliding with a live seat under a free role", () => {
    // Combines both fixes: A resends `join` carrying B's live token while a
    // third role is still free -- A must keep A, not be forced roleless.
    let state = reduceApp(started(), { k: "phone_join", peerId: PEER_A, seat: "seat-c" });
    expect(roleOfPeer(state, PEER_A)).toBe("A");
  });
});

describe("token reclaims queue, FIFO", () => {
  /** All three joined with a seat token each, so a later token reclaim has something to match. */
  function startedWithSeats(): GameState {
    let state = createGame("ABCD");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, name: "Ada", want: "A", seat: "seat-a" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, name: "Bo", want: "B", seat: "seat-b" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_C, name: "Cy", want: "C", seat: "seat-c" });
    return state;
  }

  /**
   * A and B are both PLAYING. This is the only shape that can queue any more:
   * a seat nobody is sitting in hands itself back on the token alone, so a
   * contest needs a live holder for the newcomer to be asking about.
   */
  function bothPlaying(): GameState {
    return startedWithSeats();
  }

  it("queues a second genuine claimant instead of dropping it, and raises it once the first is approved", () => {
    let state = bothPlaying();
    state = reduceApp(state, { k: "phone_join", peerId: "a2", name: "Ada", seat: "seat-a" });
    expect(state.pendingReclaim?.peerId).toBe("a2");
    // B2 arrives while A2's reclaim is still on screen.
    state = reduceApp(state, { k: "phone_join", peerId: "b2", name: "Bo", seat: "seat-b" });
    expect(state.pendingReclaim?.peerId).toBe("a2"); // unchanged, still A2's turn
    expect(state.players.find((p) => p.peerId === "b2")?.claimedSeat).toBe("seat-b");
    expect(phoneView(state, "b2").notice).toBe("another reclaim is already waiting for the TV");

    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "a2")).toBe("A");
    // B2's own request is raised the instant A2's slot frees up.
    expect(state.pendingReclaim?.peerId).toBe("b2");
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "b2")).toBe("B");
  });

  it("also raises the queued claimant when the first is declined, not just approved", () => {
    let state = bothPlaying();
    state = reduceApp(state, { k: "phone_join", peerId: "a2", name: "Ada", seat: "seat-a" });
    state = reduceApp(state, { k: "phone_join", peerId: "b2", name: "Bo", seat: "seat-b" });
    state = reduce(state, { k: "decline_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "a2")).toBeNull(); // A2's own decline holds
    expect(state.pendingReclaim?.peerId).toBe("b2");
  });

  it("a third genuine claimant for the SAME seat queues behind the second rather than displacing it", () => {
    let state = bothPlaying();
    state = reduceApp(state, { k: "phone_join", peerId: "a2", name: "Ada", seat: "seat-a" });
    state = reduceApp(state, { k: "phone_join", peerId: "a3", name: "Ada", seat: "seat-a" });
    // a2 carries no token of its own (only `claimedSeat`), so a3 finds the
    // LIVE seat, not a2 -- it is a second claimant on the same seat, and the
    // queue is FIFO. Nobody is superseded: a claimant holds nothing to take.
    expect(roleOfPeer(state, "a3")).toBeNull();
    expect(state.players.some((p) => p.peerId === "a2")).toBe(true);
    expect(state.pendingReclaim?.peerId).toBe("a2"); // still the first claimant's turn
    expect(state.players.find((p) => p.peerId === "a3")?.claimedSeat).toBe("seat-a");
    expect(state.superseded).toBeNull();

    // Declining a2 raises a3 -- the seat still has exactly one taker at a time.
    state = reduce(state, { k: "decline_reclaim", requestId: onScreenRequestId(state) });
    expect(state.pendingReclaim?.peerId).toBe("a3");
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "a3")).toBe("A");
    expect(roleOfPeer(state, "a2")).toBeNull();
  });
});

describe("the TV's approval is the only thing that supersedes a live connection", () => {
  // The TV cannot tell a reopened tab apart from a replayed token on the wire
  // alone, so it does not try to -- and it does not guess either. The older
  // connection keeps the seat, the newcomer waits, and one press on the
  // remote is what closes the older connection and moves the role. Nothing
  // else in the room ever supersedes anybody.

  /** B is seated and playing; a second connection presents seat-b's own live token. */
  function collidedOnB(): GameState {
    return reduceApp(seated(), { k: "phone_join", peerId: "second-tab", name: "Bo", seat: "seat-b" });
  }

  it("hands the role over only once the TV approves, and names the older peer id in state.superseded", () => {
    let state = collidedOnB();
    // Before the press: nothing moved, and nobody was told anything.
    expect(roleOfPeer(state, PEER_B)).toBe("B");
    expect(roleOfPeer(state, "second-tab")).toBeNull();
    expect(state.superseded).toBeNull();
    expect(state.pendingReclaim).toMatchObject({ peerId: "second-tab", role: "B", via: "token" });

    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(roleOfPeer(state, "second-tab")).toBe("B");
    expect(isConnected(state, "B")).toBe(true);
    expect(state.players.some((p) => p.peerId === PEER_B)).toBe(false); // renamed, not a stray record
    expect(state.superseded).toMatchObject({ peerId: PEER_B });
    expect(state.log.at(-1)?.text).toContain("the earlier connection was closed");
  });

  it("the older connection's own later player_left is a no-op -- its peer id is already gone", () => {
    let state = collidedOnB();
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    expect(roleOfPeer(state, "second-tab")).toBe("B"); // untouched by the stale drop
    expect(isConnected(state, "B")).toBe(true);
  });

  it("carries a half-picked choice from the older connection onto the newer one when the TV approves", () => {
    let state = seated();
    state = reduce(state, { k: "choose_action", peerId: PEER_A, actionId: "a_read_painting_hint" });
    state = reduce(state, { k: "choose_action", peerId: PEER_A, actionId: "a_shift_painting" });
    expect(state.pending[PEER_A]).toEqual({ actionId: "a_shift_painting", options: 4 });
    state = reduceApp(state, { k: "phone_join", peerId: "second-tab", name: "Ada", seat: "seat-a" });
    // Still A's own half-made choice while the question is on screen.
    expect(state.pending[PEER_A]).toEqual({ actionId: "a_shift_painting", options: 4 });
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    expect(state.pending[PEER_A]).toBeUndefined();
    expect(state.pending["second-tab"]).toEqual({ actionId: "a_shift_painting", options: 4 });
    state = reduce(state, { k: "choose_option", peerId: "second-tab", option: 0 });
    expect(state.play.flags).toContain("painting_moved");
  });

  it("a seat the newer connection then drops still holds through the ordinary grace period, under the newer peer id", () => {
    let state = collidedOnB();
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    state = reduce(state, { k: "player_left", peerId: "second-tab", at: 500 });
    // The older peer id (PEER_B) is long gone -- this is the same stale drop
    // the earlier test checks is a no-op, not a second, meaningful one.
    state = reduce(state, { k: "player_left", peerId: PEER_B, at: 1_000 });
    expect(roleOfPeer(state, "second-tab")).toBe("B");
    expect(isConnected(state, "second-tab")).toBe(false); // ordinary held-seat grace period
  });

  it("never supersedes an already-seated player, even if its own token happens to collide with somebody else's live seat", () => {
    let state = reduceApp(seated(), { k: "phone_join", peerId: PEER_A, name: "Ada", seat: "seat-b" });
    expect(roleOfPeer(state, PEER_A)).toBe("A"); // A kept its own role, never took over B's
    expect(isConnected(state, "B")).toBe(true); // B's seat is untouched -- no supersede happened
    expect(state.superseded).toBeNull(); // and B was never told otherwise
    expect(state.pendingReclaim).toBeNull(); // nor was the room asked about a seat A already has
  });

  it("stamps each supersede with its own, strictly increasing seq -- app.tsx's own dedup, keyed on it, must never see two events collapse into one", () => {
    let state = reduceApp(seated(), { k: "phone_join", peerId: "b-second-tab", name: "Bo", seat: "seat-b" });
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    const firstSeq = state.superseded!.seq;
    expect(state.superseded).toMatchObject({ peerId: PEER_B, seq: firstSeq });

    state = reduceApp(state, { k: "phone_join", peerId: "c-second-tab", name: "Cy", seat: "seat-c" });
    state = reduce(state, { k: "approve_reclaim", requestId: onScreenRequestId(state) });
    const secondSeq = state.superseded!.seq;
    expect(secondSeq).toBeGreaterThan(firstSeq);
    expect(state.superseded).toMatchObject({ peerId: PEER_C, seq: secondSeq });
  });
});

describe("a reclaim requires a requester connected right now", () => {
  it("clears a pending reclaim the instant its own requester disconnects, so a later approval cannot reach it", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-returning", name: "" });
    state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
    expect(state.pendingReclaim).not.toBeNull();
    state = reduce(state, { k: "player_left", peerId: "phone-returning", at: 2_000 });
    expect(state.pendingReclaim).toBeNull();
    // Nothing is on screen any more, so the press names a request that is gone.
    state = reduce(state, { k: "approve_reclaim", requestId: "a-request-that-is-no-longer-on-screen" });
    expect(state.players.some((p) => p.peerId === "phone-returning" && p.role === "B")).toBe(false);
    expect(state.players.some((p) => p.role === "B" && !p.connected)).toBe(true); // still genuinely held
  });

  it("never grants a role to a disconnected requester even if approval somehow still fires on stale state", () => {
    // A defence-in-depth check independent of the player_left cleanup above:
    // approve_reclaim itself must refuse a requester that is not connected,
    // not only rely on the request having already been cleared.
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, { k: "phone_join", peerId: "phone-returning", name: "" });
    state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
    const withStaleRequest: GameState = {
      ...reduce(state, { k: "player_left", peerId: "phone-returning", at: 2_000 }),
      pendingReclaim: state.pendingReclaim,
    };
    const approved = reduce(withStaleRequest, { k: "approve_reclaim", requestId: onScreenRequestId(withStaleRequest) });
    expect(approved.players.some((p) => p.role === "B" && p.connected)).toBe(false);
    expect(approved.pendingReclaim).toBeNull();
  });

  it("does not let a stale request reach a dead peer id once the requester reconnects under a new one", () => {
    let state = reduce(seated(), { k: "player_left", peerId: PEER_B, at: 1_000 });
    state = reduceApp(state, {
      k: "phone_join",
      peerId: "phone-returning",
      name: "",
      seat: "returning-token",
    });
    state = reduceApp(state, { k: "phone_reclaim_seat", peerId: "phone-returning", name: "Bo" });
    expect(state.pendingReclaim?.peerId).toBe("phone-returning");
    state = reduce(state, { k: "player_left", peerId: "phone-returning", at: 2_000 });
    state = reduceApp(state, {
      k: "phone_join",
      peerId: "phone-returning-2",
      name: "",
      seat: "returning-token",
    });
    expect(state.pendingReclaim).toBeNull(); // cancelled, not silently carried to the new peer id
    expect(state.players.some((p) => p.peerId === "phone-returning")).toBe(false); // old id is gone
    // Nothing is waiting any more, so the press names a request that is gone.
    state = reduce(state, { k: "approve_reclaim", requestId: "a-request-that-is-no-longer-on-screen" });
    expect(roleOfPeer(state, "phone-returning-2")).toBeNull(); // has to ask again
  });
});
