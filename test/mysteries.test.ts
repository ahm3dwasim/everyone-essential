/**
 * The bar every mystery must clear -- one table, every mystery.
 *
 * The point of this file is that mystery #4 costs nothing to check: the table
 * is a function of the mystery, not a list of hand-written expectations per
 * puzzle. If a mystery is added to the catalogue and it is not provably
 * solvable, not load-bearing for every role, inaccessible to somebody who has
 * to play it, or not recompilable when an input mode changes, this file goes
 * red -- and the failure names the claim, not the assertion.
 *
 * Nothing here edits the validator. Every verdict below is the validator's own:
 * `certify` for solvability, accessibility, meaningfulness and necessity,
 * `recompile` for the repair after an input change. The test never re-implements
 * a check and never reads a puzzle's intent -- a mystery that cannot pass is a
 * bug in the mystery, and the honest fix is to change the mystery.
 *
 * The states checked are the initial state plus three cut points along the
 * puzzle's own witness plan, so "mid-game" means a state the team can actually
 * be in rather than one this file invented. The capability change is taken at
 * the app's own midpoint (`floor(plan.length / 2)`), which is the moment the TV
 * offers the switch.
 */
import { describe, expect, it } from "vitest";
import { MYSTERIES, mysteryById, type Mystery } from "../app/tv/src/game/mysteries.ts";
import { auditMystery, roleDependencyGraph } from "../app/shared/audit.ts";
import { endingTitle } from "../app/tv/src/game/presentation.ts";

/**
 * The table itself -- `auditMystery` -- lives in `app/shared/audit.ts` rather
 * than in this file, so that the generator's acceptance gate can hold every
 * proposal to exactly the same function. Importing *this* module from the gate
 * would re-register the suites below; sharing the implementation is what keeps
 * the two callers from drifting. Re-exported here so this file's public
 * surface is unchanged.
 */
export { auditMystery, roleDependencyGraph } from "../app/shared/audit.ts";
export type { Audit, StateProbe } from "../app/shared/audit.ts";

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

const audited = MYSTERIES.map((mystery) => ({ mystery, audit: auditMystery(mystery) }));

describe("every mystery clears the bar", () => {
  it("has at least three mysteries, so the ceiling is not one hand-written puzzle", () => {
    expect(MYSTERIES.length).toBeGreaterThanOrEqual(3);
  });

  it("seats the sizes it claims, and the two-player mystery really seats two", () => {
    const sizes = Object.fromEntries(MYSTERIES.map((m) => [m.id, m.roles.length]));
    expect(sizes["the-locked-study"]).toBe(3);
    expect(MYSTERIES.filter((m) => m.roles.length === 2)).toHaveLength(1);
    for (const mystery of MYSTERIES) {
      const puzzle = mystery.build();
      expect(puzzle.roles.map((r) => r.id).sort()).toEqual([...mystery.roles].sort());
    }
  });

  for (const { mystery, audit } of audited) {
    it(`${mystery.id}: solvable, every role necessary, accessible, recompilable`, () => {
      // One assertion, but the failure message is the audit's own list: which
      // state, which claim, and what the certificate said about it.
      expect(audit.failures.join("\n")).toBe("");
    });

    it(`${mystery.id}: the dependency graph is not a reskin of another mystery`, () => {
      // Two mysteries that differ only in wording would produce the same graph
      // of which role feeds which. Compared as a set of role pairs, derived
      // from the puzzle's own tokens and flags -- never hand-declared.
      const graph = roleDependencyGraph(mystery.build());
      const others = MYSTERIES.filter((m) => m.id !== mystery.id).map((m) => ({
        id: m.id,
        graph: roleDependencyGraph(m.build()),
      }));
      for (const other of others) {
        expect(
          graph,
          `${mystery.id} and ${other.id} have the same structure of dependence (${graph})`,
        ).not.toBe(other.graph);
      }
    });
  }

  it("reports what each role's input change actually did", () => {
    // Not an assertion about the outcome -- it is the evidence line the report
    // quotes, and it fails only if a mystery produced no row at all.
    for (const { mystery, audit } of audited) {
      expect(audit.changes.length, `${mystery.id} produced no capability-change rows`).toBe(
        mystery.roles.length,
      );
      for (const change of audit.changes) {
        expect(change.kind, `${mystery.id}/${change.role}`).not.toBe("threw");
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Mutation controls                                                   */
/* ------------------------------------------------------------------ */

/**
 * The table is only worth anything if it can go red. Two controls, and the
 * difference between them is the point:
 *
 * M1 is a negative control -- give a role a clue nobody needs. It
 *    does NOT break necessity, and the table stays green. A spare private token
 *    is not a defect `certify` claims to catch: the role is still load-bearing
 *    through its actions, and the certificate promises nothing about whether a
 *    puzzle wastes a clue -- confirming that "green" means something.
 * M2 is a real break: one extra action that lets a role reach the goal alone.
 *    The other role is demoted to decorative and the table goes red on
 *    necessity -- the exact failure the certificate exists to catch.
 *
 * Neither control mutates the catalogue: both build a throwaway puzzle, and the
 * restore assertion re-audits the real mystery through the same function.
 */
describe("mutation controls: the table can go red", () => {
  const treehouse = mysteryById("the-treehouse")!;

  it("M1 (negative control): a clue nobody needs does not break necessity", () => {
    const mutated: Mystery = {
      ...treehouse,
      id: "mutation-unneeded-clue",
      // A clue no action in the puzzle ever requires.
      build: () => {
        const puzzle = treehouse.build();
        return {
          ...puzzle,
          roles: puzzle.roles.map((role) =>
            role.id === "A"
              ? { ...role, privateTokens: [...role.privateTokens, "spare_note_nobody_needs"] }
              : role,
          ),
        };
      },
    };
    const audit = auditMystery(mutated);
    // Green, and green for the documented reason: an unused clue is not a
    // necessity defect. If this ever starts failing, the claim in the report
    // is wrong and the report must change with it.
    expect(audit.failures.join("\n")).toBe("");
    expect(audit.changes.every((c) => c.kind !== "threw")).toBe(true);
  });

  it("M2 (real break): one bypass action demotes a role to decorative, and the table says so", () => {
    const mutated: Mystery = {
      ...treehouse,
      id: "mutation-bypass-action",
      build: () => {
        const puzzle = treehouse.build();
        return {
          ...puzzle,
          // A can now raise the platform alone, once the planks are counted:
          // B's rope code and rigged-rope flag are no longer needed for the
          // goal, so B is decorative.
          actions: [
            ...puzzle.actions,
            {
              id: "a_haul_alone",
              performer: "A",
              needs: "dpad" as const,
              requiresTokens: ["plank_count"],
              requiresFlags: [],
              producesTokens: [],
              setsFlags: ["platform_up"],
              label: "haul the platform up alone",
            },
          ],
        };
      },
    };
    const audit = auditMystery(mutated);
    expect(audit.failures.length).toBeGreaterThan(0);
    // And red for the right reason: B's necessity, named by the certificate.
    expect(audit.failures.join("\n")).toMatch(/B: goal still reachable without B/);
  });

  it("restores: the real catalogue still clears the bar through the same function", () => {
    for (const mystery of MYSTERIES) {
      expect(auditMystery(mystery).failures.join("\n")).toBe("");
    }
  });
});

/* ------------------------------------------------------------------ */
/* Per-mystery endings                                                 */
/* ------------------------------------------------------------------ */

describe("the ending is mystery-specific, not the study's for everyone", () => {
  it("gives every mystery its own ending title", () => {
    const titles = MYSTERIES.map((m) => endingTitle(m.id));
    expect(new Set(titles).size).toBe(MYSTERIES.length);
  });

  it("gives each named mystery its own exact ending title", () => {
    expect(endingTitle("the-locked-study")).toBe("The study is open.");
    expect(endingTitle("the-midnight-bakery")).toBe("The morning loaf is ready.");
    expect(endingTitle("the-treehouse")).toBe("The platform is up.");
  });

  it("falls back honestly for a puzzle id no table entry names", () => {
    expect(endingTitle("some-future-mystery")).not.toBe("The study is open.");
  });
});
