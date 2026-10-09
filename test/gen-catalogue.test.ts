/**
 * The generated mystery, promoted to the live roster.
 *
 * `app/tv/src/game/generated.ts` holds proposals the generator earned, saved
 * as files. This file is what makes "saved as a file" mean something: the
 * committed JSON is held to the same acceptance table as the hand-written
 * three, its dependence graph has to be a shape the catalogue does not already
 * have, and it has to be *reproducible* -- regenerating from the seed in its
 * own id must produce the bytes that are committed. A file that no longer
 * matches its seed is a file nobody can re-derive or re-check.
 *
 * Promoting a generated mystery to the live roster, rather than leaving it
 * on the staging shelf, has two visible, deliberate consequences, which this
 * file asserts as the live shape.
 */
import { describe, expect, it } from "vitest";
import { auditMystery, roleDependencyGraph } from "../app/shared/audit.ts";
import { MYSTERIES, seatRoles } from "../app/tv/src/game/mysteries.ts";
import { GENERATED_MYSTERIES, GENERATED_PROPOSALS, generatedById } from "../app/tv/src/game/generated.ts";
import { composeLocal } from "../app/gen/src/local.ts";
import { gate } from "../app/gen/src/gate.ts";

const STAGED = GENERATED_MYSTERIES[0]!;
const STAGED_PROPOSAL = GENERATED_PROPOSALS[0]!;

describe("the staged generated mystery", () => {
  it("clears the same acceptance table the hand-written mysteries clear", () => {
    const audit = auditMystery(STAGED);
    expect(audit.failures.join("\n")).toBe("");
    expect(audit.changes.length).toBe(STAGED.roles.length);
    expect(audit.changes.every((c) => c.kind !== "threw")).toBe(true);
  });

  it("clears the generator's own gate, which is the same bar", () => {
    const verdict = gate(STAGED_PROPOSAL);
    expect(verdict.accepted).toBe(true);
    expect(verdict.checks.every((c) => c.ok)).toBe(true);
  });

  it("has a structure of dependence the hand-written mysteries do not already have", () => {
    const graph = roleDependencyGraph(STAGED.build());
    expect(graph.length).toBeGreaterThan(0);
    for (const mystery of MYSTERIES.filter((m) => m.id !== STAGED.id)) {
      expect(graph, `${STAGED.id} reskins ${mystery.id}`).not.toBe(roleDependencyGraph(mystery.build()));
    }
  });

  it("seats the roles the lobby would show, in the order it would show them", () => {
    expect(seatRoles(STAGED.build())).toEqual([...STAGED.roles]);
    expect(STAGED.roles).toEqual(["A", "B", "C"]);
  });

  it("hands out a fresh puzzle each time, so one caller cannot corrupt the next", () => {
    const first = STAGED.build();
    const second = STAGED.build();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    first.actions.pop();
    expect(STAGED.build().actions).toHaveLength(second.actions.length);
  });

  it("is exactly what the generator produces from the seed in its own id", () => {
    // The seed is the last segment of the id, which is what makes the file
    // re-derivable from its name alone.
    const seed = Number(STAGED.id.split("-").pop());
    expect(Number.isFinite(seed), STAGED.id).toBe(true);
    const regenerated = composeLocal({ seed, roles: STAGED.roles.length });
    expect(regenerated.id).toBe(STAGED.id);
    expect(JSON.stringify(regenerated, null, 2)).toBe(JSON.stringify(STAGED_PROPOSAL, null, 2));
  });

  it("is reachable by id through the generated catalogue", () => {
    expect(generatedById(STAGED.id)).toBe(STAGED);
    expect(generatedById("no-such-mystery")).toBeUndefined();
  });
});

describe("the promotion decision is explicit, not accidental", () => {
  it("is in the live roster, labelled as generated, and is a real fourth option", () => {
    expect(MYSTERIES.map((m) => m.id)).toContain(STAGED.id);
    expect(MYSTERIES).toHaveLength(4);
    expect(GENERATED_MYSTERIES).toHaveLength(1);
    const live = MYSTERIES.find((m) => m.id === STAGED.id);
    expect(live?.generated).toBe(true);
    // Distinct from every hand-written mystery, not a reskin.
    const graphs = MYSTERIES.map((m) => roleDependencyGraph(m.build()));
    expect(new Set(graphs).size).toBe(MYSTERIES.length);
  });
});
