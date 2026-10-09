/**
 * The art has to be a read-out of the game, not a slideshow beside it.
 *
 * Three claims are checked here, and each one is a way the art could quietly
 * become a lie:
 *
 *   1. **No dead plate.** Every plate in the table is selected at some state
 *      along the mystery's own witness plan -- the plan the *solver* produces,
 *      not a sequence this file invented. A plate gated on a flag no action
 *      sets would never appear in play, and nothing else in the repo would ever
 *      notice; this test is the only thing that would.
 *   2. **No blank shipped room.** Every mystery in the catalogue has a plate at
 *      the initial state, so a player never meets a shipped mystery as an empty
 *      panel. Generated mysteries are deliberately exempt and must return null.
 *   3. **The timeline is monotone.** A plate never shows a room in a state the
 *      team has not reached, and a later plate never becomes unreachable
 *      because an earlier one's facts are a superset of its own.
 *
 * The byte ceiling is checked too, because the budget is enforced at build time
 * on a device with ~94 MB free and a forgotten 2 MB master would fit right in.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyPlan, emptyState, solve } from "../validator/src/api.ts";
import { MYSTERIES } from "../app/tv/src/game/mysteries.ts";
import { goalReached } from "../app/tv/src/game/reducer.ts";
import { PLATES, allPlates, plateFor, plateSrc } from "../app/tv/src/art/plates.ts";
import { render } from "preact-render-to-string";
import { Scene } from "../app/tv/src/screens.tsx";

const ART_DIR = fileURLToPath(new URL("../app/tv/public/art/", import.meta.url));

/** The built puzzle and every state along its witness plan, initial state first. */
function statesAlongThePlan(mysteryId: string) {
  const mystery = MYSTERIES.find((m) => m.id === mysteryId);
  if (!mystery) throw new Error(`no such mystery: ${mysteryId}`);
  const puzzle = mystery.build();
  const start = emptyState();
  const solved = solve(puzzle, start);
  if (solved.status !== "solvable") {
    throw new Error(`${mysteryId} is not solvable, so no plate can be reachable`);
  }
  const states = Array.from({ length: solved.plan.length + 1 }, (_, steps) =>
    applyPlan(puzzle, start, solved.plan, steps),
  );
  return { puzzle, states };
}

/**
 * The surface a state actually reaches the screen on, per the reducer's own
 * rule: `commitAction`/`resolveSwitch` flip `phase` to `"ending"` in the same
 * step that sets the goal flags, so a goal-reached state is never rendered on
 * the play surface -- only the ending surface ever shows it. Asking `plateFor`
 * for the surface the state cannot reach is how a dead play-surface plate
 * (gated on the goal flag) would wrongly pass as "reachable".
 */
function surfaceShown(puzzle: Parameters<typeof goalReached>[0], state: Parameters<typeof goalReached>[1]) {
  return goalReached(puzzle, state) ? "ending" : "play";
}

describe("every plate is a state the team can actually reach", () => {
  for (const mysteryId of Object.keys(PLATES)) {
    it(`${mysteryId}: no plate is dead art`, () => {
      const { puzzle, states } = statesAlongThePlan(mysteryId);
      const seen = new Set<string>();
      for (const state of states) {
        // Only the surface a state can actually reach counts towards
        // reachability -- see `surfaceShown`.
        const plate = plateFor(mysteryId, state, surfaceShown(puzzle, state));
        if (plate) seen.add(plate.id);
      }
      const table = PLATES[mysteryId] ?? [];
      const unreachable = table.map((p) => p.id).filter((id) => !seen.has(id));
      expect(unreachable, `plates never shown during real play: ${unreachable.join(", ")}`).toEqual([]);
    });

    it(`${mysteryId}: the ending plate is the ending's alone`, () => {
      const { puzzle, states } = statesAlongThePlan(mysteryId);
      const endings = (PLATES[mysteryId] ?? []).filter((p) => p.ending).map((p) => p.id);
      for (const state of states) {
        if (goalReached(puzzle, state)) continue;
        const inPlay = plateFor(mysteryId, state, "play");
        expect(endings).not.toContain(inPlay?.id);
      }
      // ...and it does arrive once the goal is met.
      const last = states[states.length - 1];
      expect(last).toBeDefined();
      expect(goalReached(puzzle, last!)).toBe(true);
      const atEnd = plateFor(mysteryId, last!, "ending");
      expect(endings).toContain(atEnd?.id);
    });

    it(`${mysteryId}: the room only ever moves forward`, () => {
      const { puzzle, states } = statesAlongThePlan(mysteryId);
      const table = PLATES[mysteryId] ?? [];
      const rank = new Map(table.map((p, i) => [p.id, i]));
      let high = -1;
      for (const state of states) {
        const plate = plateFor(mysteryId, state, surfaceShown(puzzle, state));
        if (!plate) continue;
        const at = rank.get(plate.id) ?? -1;
        expect(at, `${plate.id} came after a later plate`).toBeGreaterThanOrEqual(high);
        high = at;
      }
    });
  }
});

describe("the catalogue and the table agree", () => {
  it("every authored mystery opens on a painted room", () => {
    const blank = MYSTERIES.filter((m) => !m.generated)
      .filter((m) => !plateFor(m.id, emptyState(), "play"))
      .map((m) => m.id);
    expect(blank, `authored mysteries with no opening plate: ${blank.join(", ")}`).toEqual([]);
  });

  /**
   * A generated mystery invents its own flag names, so it matches no plate and
   * plays unpainted. That is the honest outcome and it is asserted rather than
   * merely tolerated: painting one would mean either a plate that lies about a
   * room it was not drawn for, or eleven more plates per generated mystery.
   * The lobby already labels a generated mystery as generated, so the missing
   * painting reads as what it is.
   */
  it("a generated mystery has no plate, and that is deliberate", () => {
    const generated = MYSTERIES.filter((m) => m.generated);
    for (const mystery of generated) {
      expect(
        plateFor(mystery.id, emptyState(), "play"),
        `${mystery.id} is generated but matched a hand-painted plate`,
      ).toBeNull();
    }
    expect(plateFor("§generated-whatever", emptyState(), "play")).toBeNull();
    expect(plateFor("§generated-whatever", { flags: ["anything"], tokens: [] }, "ending")).toBeNull();
  });

  /**
   * Two plates gated on exactly the same facts are indistinguishable, and the
   * later one wins forever -- the earlier is bytes nothing can show. The
   * comparison is *within a surface*: `study-door-open` and `study-revealed`
   * are both gated on `study_unlocked` and are told apart by which screen is
   * asking, which is a real distinction and not a collision.
   */
  it("no two plates on one surface are gated on the same facts", () => {
    for (const [mysteryId, table] of Object.entries(PLATES)) {
      for (const surface of [false, true]) {
        const onSurface = table.filter((p) => p.ending === surface);
        const seen = new Map<string, string>();
        for (const plate of onSurface) {
          const key = [...plate.flags, ...plate.tokens].slice().sort().join("+");
          const clash = seen.get(key);
          expect(
            clash,
            `${mysteryId}: ${clash} and ${plate.id} are gated on the same facts`,
          ).toBeUndefined();
          seen.set(key, plate.id);
        }
      }
    }
  });
});

describe("the plates fit on the device", () => {
  it("every plate in the table exists as a file", () => {
    const missing = allPlates()
      .map((p) => plateSrc(p).replace(/^art\//, ""))
      .filter((name) => {
        try {
          return !statSync(ART_DIR + name).isFile();
        } catch {
          return true;
        }
      });
    expect(missing, `plates in the table with no file: ${missing.join(", ")}`).toEqual([]);
  });

  it("no file in art/ is missing from the table", () => {
    const onDisk = readdirSync(ART_DIR).filter((n) => n.endsWith(".webp"));
    const inTable = new Set(allPlates().map((p) => `${p.id}.webp`));
    const orphans = onDisk.filter((n) => !inTable.has(n));
    expect(orphans, `shipped bytes nothing can ever show: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the whole set stays under the 550 kB art budget", () => {
    const total = readdirSync(ART_DIR)
      .filter((n) => n.endsWith(".webp"))
      .reduce((sum, n) => sum + readFileSync(ART_DIR + n).byteLength, 0);
    expect(total).toBeLessThanOrEqual(550 * 1024);
  });

  it("every plate says what it shows, for a player who cannot see it", () => {
    for (const plate of allPlates()) {
      expect(plate.alt.length, `${plate.id} has no usable alt text`).toBeGreaterThan(20);
    }
  });
});

/**
 * A mystery the table has no plate for must render nothing: a fallback
 * would show the locked study's safe and painting while the log describes a
 * different puzzle -- a surface asserting something the state does not
 * support. Nothing else in the suite covers this.
 */
describe("a mystery never wears another mystery's room", () => {
  it("an unrecognised mystery renders no scene at all", () => {
    const html = render(<Scene puzzleId="§generated-1" flags={[]} tokens={[]} />);
    expect(html).toBe("");
  });

  it("a generated mystery in the catalogue does not render the study", () => {
    for (const mystery of MYSTERIES.filter((m) => m.generated)) {
      const html = render(<Scene puzzleId={mystery.id} flags={[]} tokens={[]} />);
      expect(html, `${mystery.id} rendered a scene drawn for another puzzle`).not.toContain(
        "the locked study",
      );
    }
  });

  it("each authored mystery renders its own plate and not another's", () => {
    for (const mystery of MYSTERIES.filter((m) => !m.generated)) {
      const html = render(<Scene puzzleId={mystery.id} flags={[]} tokens={[]} />);
      const mine = plateFor(mystery.id, emptyState(), "play");
      expect(mine).not.toBeNull();
      expect(html).toContain(`art/${mine!.id}.webp`);
      for (const other of allPlates()) {
        if (other.id === mine!.id) continue;
        expect(html, `${mystery.id} showed ${other.id}`).not.toContain(`art/${other.id}.webp`);
      }
    }
  });
});
