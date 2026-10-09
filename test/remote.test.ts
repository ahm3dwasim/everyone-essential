/**
 * The TV remote: what a key means, and where focus goes.
 *
 * The Fire TV's Silk browser does not send the key names a desktop browser
 * sends -- the centre button is keyCode 23 and Back is 4 -- so both the code and
 * the name are consulted, which is also what makes the same code testable from a
 * laptop keyboard. The focus rule that matters is the last group: focus never
 * disappears and never traps.
 */
import { describe, expect, it } from "vitest";
import { keyIntent, nextFocus, type FocusTarget } from "../app/tv/src/remote.ts";

describe("keyIntent", () => {
  it("knows the Fire TV remote's key codes", () => {
    expect(keyIntent("", 19)).toBe("up");
    expect(keyIntent("", 20)).toBe("down");
    expect(keyIntent("", 21)).toBe("left");
    expect(keyIntent("", 22)).toBe("right");
    expect(keyIntent("", 23)).toBe("select"); // DPAD_CENTER
    expect(keyIntent("", 4)).toBe("back");
    expect(keyIntent("", 82)).toBe("menu");
    expect(keyIntent("", 85)).toBe("playpause");
    expect(keyIntent("", 179)).toBe("playpause");
    expect(keyIntent("", 461)).toBe("back");
  });

  it("knows a desktop keyboard, which is how the same build is driven in tests", () => {
    expect(keyIntent("ArrowUp", 0)).toBe("up");
    expect(keyIntent("Enter", 0)).toBe("select");
    expect(keyIntent(" ", 0)).toBe("select");
    expect(keyIntent("Escape", 0)).toBe("back");
    expect(keyIntent("Backspace", 0)).toBe("back");
  });

  it("prefers the code when both are present, because the code is the device's", () => {
    expect(keyIntent("Enter", 4)).toBe("back");
  });

  it("knows the Menu button in Amazon Web App Tester, which is not keyCode 82", () => {
    // Amazon Web App Tester sends the Menu button as `ContextMenu`/18, where
    // Silk and a desktop browser would send `Menu`/82. Both are the menu key.
    expect(keyIntent("ContextMenu", 18)).toBe("menu");
    expect(keyIntent("ContextMenu", 0)).toBe("menu");
    expect(keyIntent("Menu", 82)).toBe("menu");
  });

  it("does not read the desktop Alt key as the menu key", () => {
    // 18 is ContextMenu on the device and Alt on a laptop; the name decides,
    // because swallowing Alt would break the browser's own shortcuts.
    expect(keyIntent("Alt", 18)).toBeNull();
    expect(keyIntent("AltGraph", 18)).toBeNull();
  });

  it("ignores a key that means nothing", () => {
    expect(keyIntent("q", 81)).toBeNull();
  });
});

/* A 10-foot layout: the clue board on the left, a 2x2 board of actions on the
 * right, and a row of footer controls underneath. */
const BOARD: FocusTarget[] = [
  { id: "act:a", rect: { x: 1000, y: 200, width: 300, height: 120 } },
  { id: "act:b", rect: { x: 1320, y: 200, width: 300, height: 120 } },
  { id: "act:c", rect: { x: 1000, y: 360, width: 300, height: 120 } },
  { id: "act:d", rect: { x: 1320, y: 360, width: 300, height: 120 } },
  { id: "again", rect: { x: 1320, y: 900, width: 200, height: 80 } },
];

describe("nextFocus", () => {
  it("starts somewhere sensible when nothing is focused yet", () => {
    expect(nextFocus(BOARD, null, "down")).toBe("act:a");
    expect(nextFocus(BOARD, "gone", "down")).toBe("act:a");
  });

  it("moves right along a row, and down a column", () => {
    expect(nextFocus(BOARD, "act:a", "right")).toBe("act:b");
    expect(nextFocus(BOARD, "act:a", "down")).toBe("act:c");
    expect(nextFocus(BOARD, "act:d", "left")).toBe("act:c");
  });

  it("lands on the control below rather than the one diagonally across", () => {
    // From the right-hand column, "down" must find act:d -- directly below --
    // and not act:c, which is nearer in a straight-line sense but off to the side.
    expect(nextFocus(BOARD, "act:b", "down")).toBe("act:d");
  });

  it("stays where it is when there is nothing that way", () => {
    expect(nextFocus(BOARD, "act:a", "up")).toBeNull();
    expect(nextFocus(BOARD, "act:a", "left")).toBeNull();
    expect(nextFocus(BOARD, "again", "down")).toBeNull();
    expect(nextFocus(BOARD, "act:d", "right")).toBeNull();
  });

  it("does not jump to a control that only overlaps slightly", () => {
    const targets: FocusTarget[] = [
      { id: "here", rect: { x: 0, y: 0, width: 100, height: 100 } },
      // Two pixels of vertical overlap: not "below" in any useful sense.
      { id: "barely", rect: { x: 0, y: 102, width: 100, height: 100 } },
      { id: "clear", rect: { x: 400, y: 300, width: 100, height: 100 } },
    ];
    expect(nextFocus(targets, "here", "right")).toBe("clear");
  });

  it("has nowhere to go in an empty layout rather than throwing", () => {
    expect(nextFocus([], null, "down")).toBeNull();
  });

  it("never traps: from any control, some direction always leaves", () => {
    // Every control in this layout has at least one neighbour, so a player who
    // is lost can always get somewhere else.
    for (const target of BOARD) {
      const exits = (["up", "down", "left", "right"] as const).filter(
        (direction) => nextFocus(BOARD, target.id, direction) !== null,
      );
      expect(exits.length, `${target.id} has no way out`).toBeGreaterThan(0);
    }
  });
});
