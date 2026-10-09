/**
 * The gate: the only door a proposal can go through.
 *
 * A proposal is not a mystery. It becomes one only here, and only if it clears
 * every claim below -- the same claims `test/mysteries.test.ts` holds the
 * hand-written catalogue to:
 *
 *   solvable                  `certify` from the initial state and from three
 *                             cut points along the puzzle's own witness plan,
 *                             so "mid-game" means a state the team can really
 *                             be in rather than one this file invented.
 *   every role necessary      and *proven* necessary: the counterfactual search
 *                             finished rather than hitting its state cap. A
 *                             truncated search proves nothing.
 *   every role meaningful     every role either acts on the witness plan or
 *                             holds a clue that plan consumes.
 *   accessible                no action asks for an input its performer lacks,
 *                             and no `scan` choice exceeds the model's own
 *                             bound of 4 alternatives.
 *   choices well-formed       every choice names the token that decides it and
 *                             holds that token.
 *   recompilable              for each role, changing its input to the narrower
 *                             mode is either repaired provably (the repair
 *                             certifies and the team's progress survives) or
 *                             definitively refused. A repair that throws is a
 *                             failure of this gate, not a shrug.
 *
 * Why the checks are separate named entries rather than one function
 * ----------------------------------------------------------------
 * Because "which claim failed" is the number this gate exists to produce. A
 * proposal rejected for a decorative role and a proposal rejected for a
 * five-option scan choice are different bugs in different parts of a
 * generator, and collapsing them into one boolean throws that away. The
 * decomposition is also what makes the mutation control in
 * `test/gen-gate.test.ts` possible: it disables exactly one named check and
 * shows the gate then accepts what it must reject.
 *
 * The gate never repairs, never retries and never widens a bound. Retrying is
 * `generate.ts`'s job; the gate's job is to say no with a reason.
 */
import {
  SCAN_MAX_OPTIONS,
  applyPlan,
  certify,
  checkProgressPreserved,
  emptyState,
  explainFailure,
  isCertificate,
  recompile,
  refusalIssues,
  solve,
  validatePuzzle,
  type Capability,
  type Certificate,
  type Puzzle,
  type RoleId,
  type State,
} from "../../../validator/src/api.ts";
import { SEAT_IDS, type ProposedMystery } from "./proposer.ts";

/** The claims the gate runs, in order. Every one of them is load-bearing. */
export type GateCheckName =
  | "roles_are_seatable"
  | "well_formed"
  | "solvable"
  | "every_role_necessary"
  | "every_role_meaningful"
  | "accessible"
  | "choices_well_formed"
  | "recompilable";

export interface GateCheck {
  name: GateCheckName;
  ok: boolean;
  /**
   * The validator's own words, or this gate's for the two checks the validator
   * has no opinion about. Empty when the check passed.
   */
  reason: string;
  /**
   * The validator's typed kind where it has one: a `ValidationIssue["kind"]`
   * for a malformed proposal, a `AccessibilityViolationKind` for an
   * accessibility failure, `null` for a claim the validator does not name.
   * This, not the prose, is what the rejection ledger counts.
   */
  kind: string | null;
}

export interface GateVerdict {
  accepted: boolean;
  checks: GateCheck[];
  /** The certificate the puzzle earned from the initial state, when it got one. */
  certificate: Certificate | null;
  /** The first failing check, so a retry loop has one reason to log. */
  rejection: { check: GateCheckName; kind: string; reason: string } | null;
  /** Evidence for the report: how much work the compiler actually did. */
  planLength: number;
  probes: number;
  /** States the certificate's own searches exhausted, summed. */
  statesExplored: number;
}

/** What each role's input becomes when it changes. The narrower mode, always. */
function changeTarget(capabilities: readonly Capability[]): Capability[] {
  return capabilities.includes("dpad") || capabilities.includes("voice") ? ["scan"] : ["dpad"];
}

class Checks {
  readonly rows: GateCheck[] = [];

  add(name: GateCheckName, ok: boolean, reason = "", kind: string | null = null): boolean {
    this.rows.push({ name, ok, reason, kind });
    return ok;
  }

  /** Fold a list of failures into one row: the first names the check, all are quoted. */
  addAll(name: GateCheckName, failures: { reason: string; kind: string | null }[]): boolean {
    if (failures.length === 0) return this.add(name, true);
    const first = failures[0]!;
    const reason =
      failures.length === 1 ? first.reason : `${first.reason} (+${failures.length - 1} more)`;
    return this.add(name, false, reason, first.kind);
  }
}

/**
 * Hold one proposal to every claim and report each one separately.
 *
 * Total by construction: a puzzle malformed enough to make a later check
 * meaningless is rejected at `well_formed` and the checks that would have
 * crashed are recorded as not-run rather than skipped silently. That is why
 * the early return below fills in the remaining rows.
 */
export function gate(proposal: ProposedMystery): GateVerdict {
  const checks = new Checks();
  const puzzle = proposal.puzzle;

  /* ---- 0. The metadata the lobby reads must match the puzzle ---- */

  const seatFailures: { reason: string; kind: string | null }[] = [];
  const puzzleRoles = puzzle.roles.map((r) => r.id);
  const declared = [...proposal.roles];
  if (declared.length !== puzzleRoles.length) {
    seatFailures.push({
      reason: `the proposal declares ${declared.length} role(s) but the puzzle seats ${puzzleRoles.length}`,
      kind: null,
    });
  }
  const unknown = declared.filter((id: RoleId) => !SEAT_IDS.includes(id));
  for (const id of unknown) {
    seatFailures.push({ reason: `"${id}" is not a role the wire protocol knows`, kind: null });
  }
  const missing = puzzleRoles.filter((id) => !declared.includes(id));
  for (const id of missing) {
    seatFailures.push({ reason: `the puzzle seats "${id}" but the proposal does not declare it`, kind: null });
  }
  if (seatFailures.length === 0 && declared.join(",") !== puzzleRoles.join(",")) {
    seatFailures.push({
      reason: `the lobby would show [${declared.join(",")}] but the puzzle seats [${puzzleRoles.join(",")}]`,
      kind: null,
    });
  }
  checks.addAll("roles_are_seatable", seatFailures);

  /* ---- 1. The validator's own gate on the puzzle's shape ---- */

  const validation = validatePuzzle(puzzle);
  if (!validation.ok) {
    checks.addAll(
      "well_formed",
      validation.errors.map((e) => ({ reason: e.detail, kind: e.kind })),
    );
    // Nothing below can be trusted about a puzzle that is not well formed, and
    // saying so is more honest than reporting a cascade of derived failures.
    for (const name of NOT_RUN_AFTER_WELL_FORMED) {
      checks.add(name, false, "not run: the puzzle is not well formed", "not_run");
    }
    return finish(proposal, checks, null, 0, 0, 0);
  }
  checks.add("well_formed", true);

  /* ---- 2. The witness plan, and the states the certificate is re-proved from ---- */

  const start = emptyState();
  const solved = solve(puzzle, start);
  if (solved.status !== "solvable") {
    checks.add("solvable", false, `no witness plan exists (${solved.status})`, solved.status);
    for (const name of NOT_RUN_AFTER_UNSOLVABLE) {
      checks.add(name, false, "not run: there is no witness plan to reason about", "not_run");
    }
    return finish(proposal, checks, null, 0, 0, 0);
  }

  const planLength = solved.plan.length;
  const midStep = Math.floor(planLength / 2);
  const cuts = [...new Set([0, Math.floor(planLength / 3), midStep, Math.floor((2 * planLength) / 3)])]
    .filter((steps) => steps >= 0 && steps <= planLength)
    .sort((a, b) => a - b);
  const probes: { label: string; steps: number; state: State }[] = cuts.map((steps) => ({
    label: steps === 0 ? "initial" : `${steps}/${planLength} of the plan`,
    steps,
    state: applyPlan(puzzle, start, solved.plan, steps),
  }));

  /* ---- 3. certify from every probe: solvable, necessary, meaningful, accessible ---- */

  const solvableFailures: { reason: string; kind: string | null }[] = [];
  const necessityFailures: { reason: string; kind: string | null }[] = [];
  const meaningfulFailures: { reason: string; kind: string | null }[] = [];
  const accessibilityFailures: { reason: string; kind: string | null }[] = [];

  let certificate: Certificate | null = null;
  let truncatedAnywhere = false;

  for (const probe of probes) {
    const result = certify(puzzle, probe.state);
    if (!isCertificate(result)) {
      // A refusal is the validator declining to speak about the input at all --
      // an unreachable state, most often. It is not a solvability verdict.
      for (const issue of refusalIssues(result)) {
        solvableFailures.push({ reason: `@ ${probe.label}: ${issue.detail}`, kind: issue.kind });
      }
      continue;
    }
    if (probe.steps === 0) certificate = result;

    if (!result.solvable.ok) {
      truncatedAnywhere ||= result.solvable.truncated;
      solvableFailures.push({
        reason: `@ ${probe.label}: ${explainFailure(result)}`,
        kind: result.solvable.truncated ? "truncated" : "unreachable_goal",
      });
      // Necessity and meaningfulness are statements about reaching the goal;
      // with the goal unreachable they are vacuous, exactly as `explainFailure`
      // treats them.
      continue;
    }

    for (const role of puzzle.roles) {
      const proof = result.necessity[role.id];
      if (!proof) {
        necessityFailures.push({
          reason: `@ ${probe.label}: no necessity proof for ${role.id}`,
          kind: "missing_proof",
        });
        continue;
      }
      if (!proof.proven) {
        necessityFailures.push({
          reason: `@ ${probe.label}: necessity of ${role.id} is unproven (${proof.reason})`,
          kind: "unproven",
        });
        continue;
      }
      if (!proof.necessary) {
        necessityFailures.push({
          reason: `@ ${probe.label}: ${role.id} is decorative -- ${proof.reason}`,
          kind: "decorative_role",
        });
      }
    }

    // The certificate must not name a role the puzzle does not seat: a "proof"
    // about a role nobody plays would be silently ignored above.
    const proofRoles = Object.keys(result.necessity).sort().join(",");
    const seatRoles = puzzle.roles
      .map((r) => r.id)
      .sort()
      .join(",");
    if (proofRoles !== seatRoles) {
      necessityFailures.push({
        reason: `@ ${probe.label}: necessity is keyed by [${proofRoles}], puzzle seats [${seatRoles}]`,
        kind: "proof_role_mismatch",
      });
    }

    for (const role of puzzle.roles) {
      const meaningful = result.meaningful[role.id];
      if (!meaningful?.meaningful) {
        meaningfulFailures.push({
          reason: `@ ${probe.label}: ${role.id} contributes nothing (${meaningful?.reason ?? "no proof"})`,
          kind: "decorative_role",
        });
      }
    }

    if (!result.accessibility.ok) {
      for (const violation of result.accessibility.violations) {
        accessibilityFailures.push({
          reason: `@ ${probe.label}: ${violation.detail}`,
          kind: violation.kind,
        });
      }
    }
  }

  checks.addAll("solvable", solvableFailures);
  if (truncatedAnywhere) {
    // A capped search is not a refutation. Say so separately from a real one.
    checks.add("solvable", false, "a search hit the state cap, so nothing was proven", "truncated");
  }
  checks.addAll("every_role_necessary", necessityFailures);
  checks.addAll("every_role_meaningful", meaningfulFailures);
  checks.addAll("accessible", accessibilityFailures);

  /* ---- 4. Choice shapes, over every action, at every probe ---- */

  const choiceFailures: { reason: string; kind: string | null }[] = [];
  for (const probe of probes) {
    for (const action of puzzle.actions) {
      // No action asks for an input its performer lacks. `checkAccessibility`
      // covers the actions still ahead of the team; this covers every action
      // against the role that would actually perform it.
      const performer = action.performer;
      const eligible =
        performer === "any"
          ? puzzle.roles.some((r) => r.capabilities.includes(action.needs))
          : (puzzle.roles.find((r) => r.id === performer)?.capabilities.includes(action.needs) ??
            false);
      if (!eligible) {
        choiceFailures.push({
          reason: `@ ${probe.label}: "${action.id}" needs "${action.needs}" and nobody who can perform it has it`,
          kind: "no_eligible_performer",
        });
      }
      const options = action.options ?? 1;
      if (action.needs === "scan" && options > SCAN_MAX_OPTIONS) {
        choiceFailures.push({
          reason: `@ ${probe.label}: scan choice "${action.id}" offers ${options} options, over the ${SCAN_MAX_OPTIONS} bound`,
          kind: "scan_too_many_options",
        });
      }
      if (options > 1) {
        if (!action.answerToken) {
          choiceFailures.push({
            reason: `choice "${action.id}" names no answer token`,
            kind: "missing_answer_token",
          });
        } else if (!action.requiresTokens.includes(action.answerToken)) {
          choiceFailures.push({
            reason: `choice "${action.id}" answers with "${action.answerToken}", which it does not require`,
            kind: "missing_answer_token",
          });
        }
      }
    }
  }
  checks.addAll("choices_well_formed", choiceFailures);

  /* ---- 5. A capability change for EACH role, at the midpoint ---- */

  const midProbe = probes.find((p) => p.steps === midStep) ?? probes[probes.length - 1]!;
  const recompileFailures: { reason: string; kind: string | null }[] = [];
  let repairedRoles = 0;

  for (const role of puzzle.roles) {
    const to = changeTarget(role.capabilities);
    let result;
    try {
      result = recompile(puzzle, midProbe.state, role.id, to);
    } catch (error) {
      // A throw is the operator library reporting its own bug and it must not
      // pass the gate.
      recompileFailures.push({
        reason: `recompile threw for ${role.id}: ${error instanceof Error ? error.message : String(error)}`,
        kind: "threw",
      });
      continue;
    }

    if (result.kind === "ok") {
      repairedRoles += 1;
      const repaired = certify(result.puzzle, result.state);
      if (!isCertificate(repaired) || !repaired.ok) {
        recompileFailures.push({
          reason: `the repair for ${role.id} does not certify (${explainFailure(repaired)})`,
          kind: "repair_uncertified",
        });
        continue;
      }
      const progress = checkProgressPreserved(midProbe.state, result.state, result.puzzle);
      if (!progress.preserved) {
        recompileFailures.push({
          reason: `the repair for ${role.id} lost progress (vanished: ${progress.vanishedActions.join(",") || "none"})`,
          kind: "progress_lost",
        });
      }
    } else if (result.kind === "invalid_input") {
      recompileFailures.push({
        reason: `recompile refused the input for ${role.id} (${result.kind})`,
        kind: "invalid_input",
      });
    }
    // `no_valid_recompile` and `search_exhausted` are answers, not failures:
    // the first is a proof that no repair exists, the second an honest cap.
    // Neither is a bug in the proposal, so neither fails this gate -- the
    // "at least one repairable" rule below is what keeps it from being vacuous.
  }

  if (repairedRoles === 0) {
    recompileFailures.push({
      reason: "no role's input change is repairable, so the recompile claim is untested here",
      kind: "no_repairable_role",
    });
  }
  checks.addAll("recompilable", recompileFailures);

  const statesExplored = certificate
    ? certificate.solvable.statesExplored +
      Object.values(certificate.necessity).reduce((sum, proof) => sum + proof.statesExplored, 0)
    : 0;

  return finish(proposal, checks, certificate, planLength, probes.length, statesExplored);
}

/** Checks that cannot mean anything if the puzzle is malformed or unsolvable. */
const NOT_RUN_AFTER_WELL_FORMED: readonly GateCheckName[] = [
  "solvable",
  "every_role_necessary",
  "every_role_meaningful",
  "accessible",
  "choices_well_formed",
  "recompilable",
];
const NOT_RUN_AFTER_UNSOLVABLE: readonly GateCheckName[] = [
  "every_role_necessary",
  "every_role_meaningful",
  "accessible",
  "choices_well_formed",
  "recompilable",
];

function finish(
  _proposal: ProposedMystery,
  checks: Checks,
  certificate: Certificate | null,
  planLength: number,
  probes: number,
  statesExplored: number,
): GateVerdict {
  const firstFailure = checks.rows.find((row) => !row.ok);
  return {
    accepted: firstFailure === undefined,
    checks: checks.rows,
    certificate,
    rejection: firstFailure
      ? {
          check: firstFailure.name,
          kind: firstFailure.kind ?? "unnamed",
          reason: firstFailure.reason,
        }
      : null,
    planLength,
    probes,
    statesExplored,
  };
}

/**
 * Every check the gate runs, so a caller can assert the list itself rather
 * than trusting that a passing proposal was checked for the right things.
 */
export const GATE_CHECKS: readonly GateCheckName[] = [
  "roles_are_seatable",
  "well_formed",
  "solvable",
  "every_role_necessary",
  "every_role_meaningful",
  "accessible",
  "choices_well_formed",
  "recompilable",
];

/** The gate's verdict for a bare `Puzzle`, for callers that have no metadata. */
export function gatePuzzle(puzzle: Puzzle): GateVerdict {
  return gate({
    id: puzzle.id,
    title: puzzle.id,
    subtitle: "",
    opening: "",
    roles: puzzle.roles.map((r) => r.id),
    headline: { role: puzzle.roles[0]?.id ?? "A", capabilities: ["scan"] },
    puzzle,
  });
}
