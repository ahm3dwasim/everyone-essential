/**
 * The three pure pieces behind the phone and the lobby: voice matching, the
 * words the model's ids get on screen, and the QR code.
 *
 * None of these needs a browser: the speech recogniser is behind an interface,
 * the labels are lookup tables, and the QR encoder is a pure function of the
 * string it is given.
 */
import { describe, expect, it } from "vitest";
import { matchOption, normalizePhrase, speechRecognition } from "../app/phone/src/voice.ts";
import {
  actionTitle,
  baseActionId,
  clueText,
  generatedStep,
  isGeneratedId,
  optionLabels,
} from "../app/tv/src/game/presentation.ts";
import { qrMatrix, qrPath } from "../app/tv/src/qr.tsx";
import { demoPuzzle, recompile, emptyState, applyPlan, solve } from "../validator/src/api.ts";

describe("voice", () => {
  const options = ["the sun family", "the river family", "the tower family", "the eye family"];

  it("normalises case and punctuation away", () => {
    expect(normalizePhrase("  The RIVER family! ")).toBe("the river family");
  });

  it("matches an option that was said exactly", () => {
    expect(matchOption("the river family", options)).toBe(1);
  });

  it("matches an option that was said approximately", () => {
    expect(matchOption("river family", options)).toBe(1);
  });

  it("refuses a transcript that names nothing on the list", () => {
    // Refusing is the only honest answer: the buttons are always there, and a
    // coin toss would commit a move the player did not ask for.
    expect(matchOption("open the door", options)).toBeNull();
    expect(matchOption("", options)).toBeNull();
    expect(matchOption("the family", options)).toBeNull();
  });

  it("refuses when two options fit equally well", () => {
    expect(matchOption("family", ["the sun family", "the river family"])).toBeNull();
  });

  it("has no recogniser in a browser that has none, rather than pretending", () => {
    expect(speechRecognition()).toBeNull();
  });
});

describe("the words the model's ids get", () => {
  const puzzle = demoPuzzle();

  it("prefers the puzzle's own label for an action", () => {
    const action = puzzle.actions.find((a) => a.id === "a_read_painting_hint");
    expect(action && actionTitle(action)).toBe("read the note taped behind the painting");
  });

  it("names the four ways to lift the painting, because the count matches", () => {
    const action = puzzle.actions.find((a) => a.id === "a_shift_painting");
    const labels = action ? optionLabels(action, puzzle) : [];
    expect(labels).toHaveLength(4);
    expect(labels[0]).toBe("lift the left edge");
  });

  it("numbers the options of a generated step rather than inventing names", () => {
    const start = emptyState();
    const midpoint = applyPlan(puzzle, start, solve(puzzle, start).plan, 5);
    const repaired = recompile(puzzle, midpoint, "C", ["scan"]);
    expect(repaired.kind).toBe("ok");
    if (repaired.kind !== "ok") return;
    const step = repaired.puzzle.actions.find((a) => isGeneratedId(a.id));
    expect(step).toBeDefined();
    if (!step) return;
    const labels = optionLabels(step, repaired.puzzle);
    expect(labels).toHaveLength(step.options ?? 1);
    expect(labels[0]).toMatch(/^choice 1 of \d+ \(step \d+ of \d+\)$/);
    // The generated id is never shown to a player as-is.
    expect(actionTitle(step)).not.toContain("§");
  });

  it("reads a reserved id back to the action it was generated from", () => {
    expect(isGeneratedId("§c_dial_safe__step2")).toBe(true);
    expect(baseActionId("§c_dial_safe__step2")).toBe("c_dial_safe");
    expect(generatedStep("§c_dial_safe__step2")).toEqual({ step: 2, of: null });
    expect(generatedStep("c_dial_safe")).toBeNull();
  });

  it("falls back to the raw id rather than inventing a clue nobody has", () => {
    expect(clueText("some_new_token")).toBe("some new token");
  });
});

describe("the QR code", () => {
  it("is a square matrix of the right size for a phone URL", () => {
    const matrix = qrMatrix("http://192.0.2.20:8080/phone/#room=ABCD&relay=ws%3A%2F%2F192.0.2.20%3A8787");
    expect(matrix.size).toBeGreaterThan(20);
    expect(matrix.dark).toHaveLength(matrix.size);
    expect(matrix.dark[0]).toHaveLength(matrix.size);
  });

  it("finds the three position markers, which is what a scanner looks for first", () => {
    const { dark, size } = qrMatrix("http://host/phone/#room=ABCD");
    const corner = (row: number, column: number) => dark[row]?.[column];
    // Each marker is a 7x7 dark ring: dark at the corner, light one in, dark at the centre.
    for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      expect(corner(row, column)).toBe(true);
      expect(corner(row + 1, column + 1)).toBe(false);
      expect(corner(row + 3, column + 3)).toBe(true);
    }
  });

  it("is deterministic: the same URL draws the same code", () => {
    expect(qrMatrix("http://host/phone/#room=ABCD")).toEqual(qrMatrix("http://host/phone/#room=ABCD"));
    expect(qrMatrix("http://host/phone/#room=ABCD")).not.toEqual(
      qrMatrix("http://host/phone/#room=WXYZ"),
    );
  });

  it("renders as one path whose runs stay inside the matrix", () => {
    const matrix = qrMatrix("http://host/phone/#room=ABCD");
    const path = qrPath(matrix);
    expect(path.startsWith("M")).toBe(true);
    const coordinates = [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)];
    expect(coordinates.length).toBeGreaterThan(50);
    for (const [, x, y, width] of coordinates) {
      expect(Number(x) + Number(width)).toBeLessThanOrEqual(matrix.size);
      expect(Number(y)).toBeLessThan(matrix.size);
    }
  });
});
