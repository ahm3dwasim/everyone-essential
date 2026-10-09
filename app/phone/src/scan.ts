/**
 * One-button step scanning, as a state machine.
 *
 * The rules that matter, and why:
 *
 *   - **Tap moves the highlight. Press-and-hold selects.** Never the other way
 *     round: a stray tap must not commit anything.
 *   - **No auto-advance.** The highlight moves when the player taps, and not
 *     otherwise. A scanner that walks the list on a timer is a scanner with a
 *     deadline in it, and the point of this input mode is that there is none.
 *   - **The hold threshold is adjustable, 400-1500 ms, default 700.** Slow
 *     presses are not mistakes.
 *   - **A selection fires once.** After the hold completes, letting go does not
 *     also count as a tap, and a second hold on the same item does not fire
 *     again.
 *
 * Time is passed in, never read from a clock, so the whole machine is
 * testable without waiting for anything.
 */
import { SCAN_MAX_OPTIONS, type Choice, type PhoneView } from "../../shared/protocol.ts";

export const DEFAULT_HOLD_MS = 700;
export const MIN_HOLD_MS = 400;
export const MAX_HOLD_MS = 1500;

export function clampHoldMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HOLD_MS;
  return Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, Math.round(value)));
}

export interface ScanState {
  /** Choice ids, in order. At most `SCAN_MAX_OPTIONS`. */
  items: string[];
  index: number;
  holdMs: number;
  holding: boolean;
  holdStartedAt: number | null;
  /** The id selected by the last completed hold; cleared when the items change. */
  selected: string | null;
  /** Monotonic count of selections, so a UI can fire its effect exactly once. */
  selections: number;
  /** Why the last event was ignored, when it was. */
  lastRefusal: string | null;
}

export type ScanEvent =
  | { t: "set_items"; items: string[] }
  | { t: "set_hold_ms"; holdMs: number }
  | { t: "press_start"; at: number }
  | { t: "press_end"; at: number }
  | { t: "tick"; at: number };

export function createScan(items: string[] = [], holdMs = DEFAULT_HOLD_MS): ScanState {
  return {
    items: items.slice(0, SCAN_MAX_OPTIONS),
    index: 0,
    holdMs: clampHoldMs(holdMs),
    holding: false,
    holdStartedAt: null,
    selected: null,
    selections: 0,
    lastRefusal: null,
  };
}

/**
 * Fire a selection and drop the press. Clearing `holding` here is what makes a
 * completed hold fire exactly once: the `press_end` that follows sees no press
 * in progress and does nothing, so letting go cannot also count as a tap.
 */
function select(state: ScanState): ScanState {
  const id = state.items[state.index];
  if (id === undefined) {
    return {
      ...state,
      holding: false,
      holdStartedAt: null,
      lastRefusal: "there was nothing highlighted to select",
    };
  }
  return {
    ...state,
    selected: id,
    selections: state.selections + 1,
    holding: false,
    holdStartedAt: null,
    lastRefusal: null,
  };
}

export function scanReduce(state: ScanState, event: ScanEvent): ScanState {
  switch (event.t) {
    case "set_items": {
      const items = event.items.slice(0, SCAN_MAX_OPTIONS);
      const same = items.length === state.items.length && items.every((id, i) => id === state.items[i]);
      if (same) return state;
      return {
        ...state,
        items,
        // A new list is a new question: the highlight starts at the top, and
        // whatever was selected before is no longer on the table.
        index: 0,
        holding: false,
        holdStartedAt: null,
        selected: null,
        lastRefusal: null,
      };
    }

    case "set_hold_ms":
      return { ...state, holdMs: clampHoldMs(event.holdMs) };

    case "press_start":
      if (state.items.length === 0) {
        return { ...state, lastRefusal: "there is nothing to choose" };
      }
      return { ...state, holding: true, holdStartedAt: event.at, lastRefusal: null };

    case "tick": {
      if (!state.holding || state.holdStartedAt === null) return state;
      if (event.at - state.holdStartedAt < state.holdMs) return state;
      return select(state);
    }

    case "press_end": {
      // A press that already turned into a selection: nothing left to do.
      if (!state.holding || state.holdStartedAt === null) return state;
      const held = event.at - state.holdStartedAt;
      if (held >= state.holdMs) return select(state);
      // A short press: move the highlight, commit nothing.
      if (state.items.length === 0) {
        return { ...state, holding: false, holdStartedAt: null };
      }
      return {
        ...state,
        index: (state.index + 1) % state.items.length,
        holding: false,
        holdStartedAt: null,
        lastRefusal: null,
      };
    }

    default:
      return state;
  }
}

/** 0..1 for the hold ring, so the player can see the threshold coming. */
export function holdProgress(state: ScanState, at: number): number {
  if (!state.holding || state.holdStartedAt === null) return 0;
  const held = at - state.holdStartedAt;
  return Math.max(0, Math.min(1, held / state.holdMs));
}

export function highlighted(state: ScanState): string | null {
  return state.items[state.index] ?? null;
}

/* ------------------------------------------------------------------ */
/* What the scan screen says                                           */
/* ------------------------------------------------------------------ */

export interface HoldHint {
  /** The line above the list, e.g. "hold to choose · step 1 of 2". */
  line: string;
  /** How many holds this move takes, and which one this is. */
  step: number;
  steps: number;
  /** What a tap does, and what a hold does. */
  tap: string;
  hold: string;
}

const TAP = "tap — move the highlight";
const HOLD = "hold — choose it";

/**
 * A move in this input mode can take two holds, and this screen says which:
 * the first picks the action, the second answers the question that
 * action asks. A player who does not know that reads the second screen as a
 * fresh start, so the step is counted out loud.
 *
 * Which step it is follows from what the TV sent, not from a guess: an option
 * list *is* the second half of a move, and an action list is the first half
 * only when one of the actions opens a second question (the TV marks those with
 * a hint saying how many answers it offers).
 */
export function holdHint(
  choiceKind: PhoneView["choiceKind"],
  choices: readonly Choice[],
): HoldHint {
  if (choiceKind === "option") {
    return { line: "hold to choose · step 2 of 2", step: 2, steps: 2, tap: TAP, hold: HOLD };
  }
  if (choiceKind === "action" && choices.some((choice) => choice.hint !== undefined)) {
    return { line: "hold to choose · step 1 of 2", step: 1, steps: 2, tap: TAP, hold: HOLD };
  }
  return { line: "hold to choose", step: 1, steps: 1, tap: TAP, hold: HOLD };
}
