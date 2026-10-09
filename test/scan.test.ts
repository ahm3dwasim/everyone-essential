/**
 * The phone's one-button scan machine.
 *
 * Each rule has its own test: a tap moves the
 * highlight and commits nothing, a press-and-hold selects, nothing advances on a
 * timer, the threshold is adjustable within its range, and a selection fires
 * exactly once. Time is an argument, so none of this waits for a clock.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOLD_MS,
  MAX_HOLD_MS,
  MIN_HOLD_MS,
  clampHoldMs,
  createScan,
  highlighted,
  holdHint,
  holdProgress,
  scanReduce,
  type ScanEvent,
  type ScanState,
} from "../app/phone/src/scan.ts";
import { SCAN_MAX_OPTIONS } from "../app/shared/protocol.ts";

const ITEMS = ["act:a", "act:b", "act:c"];

function feed(state: ScanState, ...events: ScanEvent[]): ScanState {
  return events.reduce(scanReduce, state);
}

describe("the hold threshold", () => {
  it("defaults to 700 ms, and clamps to its allowed range", () => {
    expect(DEFAULT_HOLD_MS).toBe(700);
    expect(clampHoldMs(10)).toBe(MIN_HOLD_MS);
    expect(clampHoldMs(9000)).toBe(MAX_HOLD_MS);
    expect(clampHoldMs(650.4)).toBe(650);
    expect(clampHoldMs(Number.NaN)).toBe(DEFAULT_HOLD_MS);
  });

  it("is settable while scanning, and a nonsense setting does not disarm it", () => {
    const state = scanReduce(createScan(ITEMS), { t: "set_hold_ms", holdMs: 1200 });
    expect(state.holdMs).toBe(1200);
    expect(scanReduce(state, { t: "set_hold_ms", holdMs: 20 }).holdMs).toBe(MIN_HOLD_MS);
  });
});

describe("a tap", () => {
  it("moves the highlight on and commits nothing", () => {
    let state = createScan(ITEMS);
    expect(highlighted(state)).toBe("act:a");
    state = feed(state, { t: "press_start", at: 0 }, { t: "press_end", at: 120 });
    expect(highlighted(state)).toBe("act:b");
    expect(state.selections).toBe(0);
    expect(state.selected).toBeNull();
  });

  it("wraps around rather than stopping at the end", () => {
    let state = createScan(ITEMS);
    for (let i = 0; i < 3; i++) {
      state = feed(state, { t: "press_start", at: 0 }, { t: "press_end", at: 100 });
    }
    expect(highlighted(state)).toBe("act:a");
    expect(state.selections).toBe(0);
  });
});

describe("a press and hold", () => {
  it("selects the highlighted item, once the threshold is reached", () => {
    let state = feed(createScan(ITEMS), { t: "press_start", at: 1000 });
    expect(state.selections).toBe(0);
    // Under the threshold: still nothing.
    state = scanReduce(state, { t: "tick", at: 1600 });
    expect(state.selections).toBe(0);
    state = scanReduce(state, { t: "tick", at: 1700 });
    expect(state.selections).toBe(1);
    expect(state.selected).toBe("act:a");
  });

  it("fires exactly once, however long the press goes on", () => {
    let state = feed(createScan(ITEMS), { t: "press_start", at: 0 });
    state = feed(
      state,
      { t: "tick", at: 700 },
      { t: "tick", at: 1400 },
      { t: "tick", at: 2100 },
      { t: "press_end", at: 2200 },
    );
    expect(state.selections).toBe(1);
    // Letting go of a completed hold is not also a tap: the highlight stays put.
    expect(highlighted(state)).toBe("act:a");
  });

  it("completes on release even if no tick arrived to notice", () => {
    const state = feed(
      createScan(ITEMS),
      { t: "press_start", at: 0 },
      { t: "press_end", at: 900 },
    );
    expect(state.selections).toBe(1);
    expect(state.selected).toBe("act:a");
    expect(state.holding).toBe(false);
  });

  it("can select the same item again on a second deliberate hold", () => {
    let state = feed(createScan(ITEMS), { t: "press_start", at: 0 }, { t: "tick", at: 800 });
    state = feed(state, { t: "press_start", at: 5000 }, { t: "tick", at: 5800 });
    expect(state.selections).toBe(2);
  });
});

describe("no timing pressure", () => {
  it("never advances on its own, however many ticks go by", () => {
    const state = createScan(ITEMS);
    let ticked = state;
    for (let at = 0; at < 20_000; at += 250) ticked = scanReduce(ticked, { t: "tick", at });
    expect(ticked).toEqual(state);
    expect(highlighted(ticked)).toBe("act:a");
  });

  it("ignores a tick that arrives between presses", () => {
    const state = feed(
      createScan(ITEMS),
      { t: "press_start", at: 0 },
      { t: "press_end", at: 100 },
      { t: "tick", at: 100_000 },
    );
    expect(highlighted(state)).toBe("act:b");
    expect(state.selections).toBe(0);
  });

  it("reports hold progress so the ring can show the threshold coming", () => {
    const state = feed(createScan(ITEMS), { t: "press_start", at: 1000 });
    expect(holdProgress(state, 1000)).toBe(0);
    expect(holdProgress(state, 1350)).toBeCloseTo(0.5);
    expect(holdProgress(state, 9999)).toBe(1);
    expect(holdProgress(createScan(ITEMS), 5000)).toBe(0);
  });
});

describe("the item list", () => {
  it("never holds more than the model says can be scanned", () => {
    const state = createScan(["a", "b", "c", "d", "e", "f"]);
    expect(state.items).toEqual(["a", "b", "c", "d"]);
    expect(state.items).toHaveLength(SCAN_MAX_OPTIONS);
  });

  it("starts a new list at the top, with nothing selected", () => {
    let state = feed(
      createScan(ITEMS),
      { t: "press_start", at: 0 },
      { t: "press_end", at: 500 },
      { t: "press_start", at: 600 },
      { t: "press_end", at: 700 },
    );
    // Two taps: the highlight has walked off the end of the old list.
    expect(state.index).toBe(2);
    state = scanReduce(state, { t: "set_items", items: ["act:z"] });
    expect(state.index).toBe(0);
    expect(state.selected).toBeNull();
    expect(highlighted(state)).toBe("act:z");
  });

  it("leaves the highlight alone when the same list is re-sent", () => {
    let state = feed(createScan(ITEMS), { t: "press_start", at: 0 }, { t: "press_end", at: 100 });
    expect(state.index).toBe(1);
    state = scanReduce(state, { t: "set_items", items: [...ITEMS] });
    expect(state.index).toBe(1);
  });

  it("says why a press did nothing when there is nothing on screen", () => {
    const state = scanReduce(createScan([]), { t: "press_start", at: 0 });
    expect(state.holding).toBe(false);
    expect(state.lastRefusal).toBe("there is nothing to choose");
  });

  it("refuses to select when the highlight is past the end of a shrunken list", () => {
    // Only reachable if a list shrank without going through `set_items`; the
    // machine refuses to invent a selection rather than throwing.
    const state = scanReduce(
      { ...createScan(ITEMS), items: [], index: 5, holding: true, holdStartedAt: 0 },
      { t: "tick", at: 1000 },
    );
    expect(state.selections).toBe(0);
    expect(state.lastRefusal).toBe("there was nothing highlighted to select");
  });
});

/* ------------------------------------------------------------------ */
/* What the screen says                                                */
/* ------------------------------------------------------------------ */

describe("the hold hint", () => {
  // A move in this mode can take two holds, and the phone has to say so:
  // without it, a first-time player cannot tell what to do.
  it("says step 1 of 2 when the action list can open a second question", () => {
    const actions = [
      { id: "act:a", label: "Read the note" },
      { id: "act:b", label: "Turn the dial", hint: "3 choices" },
    ];
    const hint = holdHint("action", actions);
    expect(hint.line).toBe("hold to choose · step 1 of 2");
    expect([hint.step, hint.steps]).toEqual([1, 2]);
  });

  it("says step 2 of 2 when the TV has sent the answers to pick between", () => {
    const hint = holdHint("option", [{ id: "opt:0", label: "the river" }]);
    expect(hint.line).toBe("hold to choose · step 2 of 2");
    expect([hint.step, hint.steps]).toEqual([2, 2]);
  });

  it("promises one hold when nothing on the screen opens another question", () => {
    const hint = holdHint("action", [{ id: "act:a", label: "Read the note" }]);
    expect(hint.line).toBe("hold to choose");
    expect([hint.step, hint.steps]).toEqual([1, 1]);
  });

  it("still says what each gesture does, and says one hold when there is nothing", () => {
    const hint = holdHint("none", []);
    expect(hint.tap).toContain("tap");
    expect(hint.hold).toContain("hold");
    expect(hint.steps).toBe(1);
  });
});
