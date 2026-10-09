/**
 * "How we checked": every line must be derived from a real certificate, never
 * guessed and never a false negative when a search only hit its bound.
 */
import { describe, expect, it } from "vitest";
import { certify, demoPuzzle, emptyState, isCertificate } from "../validator/src/api.ts";
import {
  checkedHeadline,
  neededRoleCount,
  neededRolesPhrase,
  presentCertificate,
  roleEvidence,
  roleLabel,
  solvableEvidence,
  solvableLabel,
  stillNeedsLine,
} from "../app/tv/src/game/certificate-presenter.ts";
import { mysteryById } from "../app/tv/src/game/mysteries.ts";

describe("certificate-presenter: a healthy certificate", () => {
  const puzzle = demoPuzzle();
  const result = certify(puzzle, emptyState());
  if (!isCertificate(result)) throw new Error("the demo puzzle must certify at the start");
  const view = presentCertificate(result);

  it("requires solvable.ok AND solvable.proven for 'a way to finish', never ok alone", () => {
    expect(view.solvable.state).toBe("yes");
    expect(solvableLabel(view.solvable.state)).toBe("With everyone: a way to finish.");
    expect(solvableEvidence(view.solvable.statesExplored)).toBe(
      `${view.solvable.statesExplored} puzzle states checked.`,
    );
  });

  it("requires necessary AND proven for a positive role claim", () => {
    for (const line of view.roles) {
      expect(line.state).toBe("yes");
      expect(roleLabel(line)).toBe(`Without ${line.label}'s role: no way to finish.`);
    }
  });

  it("uses singular/plural evidence correctly: 'the only' for 1, 'All N' otherwise", () => {
    expect(roleEvidence(1)).toBe("The only reachable puzzle state checked.");
    expect(roleEvidence(5)).toBe("All 5 reachable puzzle states checked.");
  });

  it("the group headline requires the full certificate.ok, and says so", () => {
    expect(view.ok).toBe(result.ok);
    expect(view.ok).toBe(true);
    expect(checkedHeadline(view)).toBe("You can finish together.");
    expect(stillNeedsLine(view)).toBe("The puzzle still needs all three roles.");
  });

  it("carries the certificate's own hash as a checkable reference, not a trust seal", () => {
    expect(view.hash).toBe(result.hash);
  });

  it("does not claim the room can finish together while a role it counts on is held", () => {
    expect(checkedHeadline(view, ["C"])).toBe("Waiting for C to come back.");
    expect(checkedHeadline(view, ["B", "C"])).toBe("Waiting for B and C to come back.");
    expect(checkedHeadline(view, [])).toBe("You can finish together.");
  });

  it("gives a vacant role its own copy, distinct from a held one", () => {
    expect(checkedHeadline(view, [], ["B"])).toBe(
      "B's seat is empty — someone needs to join as B.",
    );
    expect(checkedHeadline(view, [], ["B"])).not.toBe("You can finish together.");
    expect(checkedHeadline(view, ["C"], ["B"])).toContain("Waiting for C to come back.");
  });
});

/**
 * "All three roles" was hard-coded, so a two-player mystery (the Treehouse)
 * rendered a headline that could never
 * match its own certificate. `neededRolesPhrase`/`neededRoleCount` are the
 * one place this wording is derived from now -- `stillNeedsLine` and the
 * ending's own context line both go through them.
 */
describe("certificate-presenter: the role count is derived, never hard-coded", () => {
  it("pluralises 1/2/3+ correctly, and says 'both', never 'all two'", () => {
    expect(neededRolesPhrase(1)).toBe("1 role");
    expect(neededRolesPhrase(2)).toBe("both roles");
    expect(neededRolesPhrase(3)).toBe("all three roles");
    expect(neededRolesPhrase(4)).toBe("all four roles");
  });

  it("counts only roles this certificate actually proved necessary", () => {
    const puzzle = demoPuzzle();
    const result = certify(puzzle, emptyState());
    if (!isCertificate(result)) throw new Error("the demo puzzle must certify at the start");
    const view = presentCertificate(result);
    expect(neededRoleCount(view)).toBe(3);
    expect(stillNeedsLine(view)).toBe("The puzzle still needs all three roles.");
  });

  it("the Treehouse (two players) proves two roles, not three", () => {
    const treehouse = mysteryById("the-treehouse")!;
    const puzzle = treehouse.build();
    const result = certify(puzzle, emptyState());
    if (!isCertificate(result)) throw new Error("the Treehouse must certify at the start");
    const view = presentCertificate(result);
    expect(neededRoleCount(view)).toBe(2);
    expect(stillNeedsLine(view)).toBe("The puzzle still needs both roles.");
  });
});

describe("certificate-presenter: a capped search", () => {
  const puzzle = demoPuzzle();
  // A one-state budget cannot even reach the goal, so the solvability search
  // itself is truncated rather than proven either way.
  const result = certify(puzzle, emptyState(), { maxStates: 1 });
  if (!isCertificate(result)) throw new Error("a capped search is still a certificate, just unproven");
  const view = presentCertificate(result);

  it("reads 'Not fully checked', never a false 'No way to finish'", () => {
    expect(result.solvable.truncated).toBe(true);
    expect(view.solvable.state).toBe("unknown");
    expect(solvableLabel(view.solvable.state)).toBe("Not fully checked.");
    expect(solvableLabel(view.solvable.state)).not.toBe("No way to finish.");
  });

  it("never claims the group can finish when the search did not prove it", () => {
    expect(view.ok).toBe(false);
    expect(checkedHeadline(view)).not.toBe("You can finish together.");
  });
});

describe("certificate-presenter: a role whose necessity search hit its own cap", () => {
  const puzzle = demoPuzzle();
  // The initial solve gets a normal budget; the per-role counterfactual gets
  // one state, which cannot finish any of the three counterfactual searches.
  const result = certify(puzzle, emptyState(), { maxCounterfactualStates: 1 });
  if (!isCertificate(result)) throw new Error("expected a certificate");
  const view = presentCertificate(result);

  it("reads every role's capped counterfactual as 'Not fully checked', not as decorative", () => {
    for (const line of view.roles) {
      expect(line.state).toBe("unknown");
      expect(roleLabel(line)).toBe("Not fully checked.");
      expect(roleLabel(line)).not.toBe("This role is no longer required from here.");
    }
  });
});

describe("certificate-presenter: a role proven no longer necessary", () => {
  it("distinguishes 'no longer required' from both a positive claim and an unproven one", () => {
    const puzzle = demoPuzzle();
    const witness = certify(puzzle, emptyState());
    if (!isCertificate(witness)) throw new Error("expected a certificate");
    // At the goal, nobody is necessary any more: every role's counterfactual
    // search proves the goal is STILL reachable without them.
    const plan = witness.solvable.plan;
    let state = emptyState();
    for (const step of plan) {
      const action = puzzle.actions.find((a) => a.id === step.action)!;
      state = {
        flags: [...new Set([...state.flags, ...action.setsFlags])].sort(),
        tokens: [...new Set([...state.tokens, ...action.producesTokens])].sort(),
        history: [...state.history, { kind: "action", actionId: action.id, performer: step.performer, capability: action.needs }],
      };
    }
    const finalResult = certify(puzzle, state);
    if (!isCertificate(finalResult)) throw new Error("expected a certificate at the goal");
    const view = presentCertificate(finalResult);
    for (const line of view.roles) {
      expect(line.state).toBe("no");
      expect(roleLabel(line)).toBe("This role is no longer required from here.");
    }
  });
});
