/**
 * The audit: the bar every mystery must clear, as one function.
 *
 * This lives outside the test that reports it because it has two callers that
 * must not be allowed to drift: `test/mysteries.test.ts`, which holds the
 * hand-written catalogue to it, and the generator's acceptance gate
 * (`app/gen/src/gate.ts`), which holds every proposal to it. Importing the
 * test module would re-register its suites, so the table lives here and both
 * of them read the same code.
 *
 * Nothing here is a second implementation of a validator check. Every verdict
 * below is the validator's own: `certify` for solvability, accessibility,
 * meaningfulness and necessity, `recompile` for the repair after an input
 * change. This file never re-implements a check and never reads a puzzle's
 * intent -- a mystery that cannot pass is a bug in the mystery.
 *
 * The states checked are the initial state plus three cut points along the
 * puzzle's own witness plan, so "mid-game" means a state the team can actually
 * be in rather than one this file invented. The capability change is taken at
 * the app's own midpoint (`floor(plan.length / 2)`), which is the moment the
 * TV offers the switch.
 */
import type { Mystery } from "../tv/src/game/mysteries.ts";
import {
  SCAN_MAX_OPTIONS,
  applyPlan,
  certify,
  checkAccessibility,
  checkProgressPreserved,
  emptyState,
  explainFailure,
  isCertificate,
  recompile,
  solve,
  type Capability,
  type Puzzle,
  type RecompileResult,
  type State,
} from "../../validator/src/api.ts";

/* ------------------------------------------------------------------ */
/* The audit                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every recompile outcome the compiler can return. A returned result is one of
 * these, and a result outside the list would mean the compiler invented a sixth
 * answer; a throw instead of a result is caught at the call site below.
 */
const TYPED_OUTCOMES: readonly RecompileResult["kind"][] = [
  "ok",
  "invalid_input",
  "no_valid_recompile",
  "search_exhausted",
  "operator_error",
];

/** What each role's input becomes when it changes. The narrower mode, always. */
function changeTarget(capabilities: readonly Capability[]): Capability[] {
  // Neither dpad nor voice is available on a one-button switch, so this is the
  // change the whole project is about: the widest mode falling to the narrowest.
  return capabilities.includes("dpad") || capabilities.includes("voice") ? ["scan"] : ["dpad"];
}

export interface StateProbe {
  label: string;
  steps: number;
  state: State;
}

export interface Audit {
  mystery: Mystery;
  puzzle: Puzzle;
  planLength: number;
  /** The states the certificate was re-proved from. */
  probes: StateProbe[];
  /** One row per role: what its input change did. */
  changes: {
    role: string;
    from: Capability[];
    to: Capability[];
    kind: RecompileResult["kind"] | "threw";
    certified: boolean;
    progressPreserved: boolean;
    detail: string;
  }[];
  /** Every claim that failed. Empty means the mystery clears the bar. */
  failures: string[];
  /** Claims checked and passed, for the report's counts. */
  checks: number;
}

/**
 * Hold one mystery to the whole bar and report every claim that failed.
 *
 * Collecting every failure into the returned `Audit` is what lets the mutation
 * controls below assert "this is red, and red for the right reason" rather than
 * just "something threw".
 */
export function auditMystery(mystery: Mystery): Audit {
  const puzzle = mystery.build();
  const start = emptyState();
  const failures: string[] = [];
  let checks = 0;

  const solved = solve(puzzle, start);
  if (solved.status !== "solvable") {
    failures.push(`${mystery.id}: not solvable from the initial state (${solved.status})`);
    return {
      mystery,
      puzzle,
      planLength: 0,
      probes: [],
      changes: [],
      failures,
      checks,
    };
  }
  const planLength = solved.plan.length;
  const midStep = Math.floor(planLength / 2);

  // The initial state plus three points along the witness plan. A plan of n
  // steps has n+1 states; cut at a third, a half and two thirds of it.
  const cuts = [...new Set([0, Math.floor(planLength / 3), midStep, Math.floor((2 * planLength) / 3)])]
    .filter((steps) => steps >= 0 && steps <= planLength)
    .sort((a, b) => a - b);
  const probes: StateProbe[] = cuts.map((steps) => ({
    label: steps === 0 ? "initial" : `${steps}/${planLength} of the plan`,
    steps,
    state: applyPlan(puzzle, start, solved.plan, steps),
  }));

  /* ---- 1. certify from every probe: ok, necessary, meaningful, accessible ---- */

  for (const probe of probes) {
    const result = certify(puzzle, probe.state);
    checks += 1;
    if (!isCertificate(result)) {
      failures.push(`${mystery.id} @ ${probe.label}: refused, not certified (${explainFailure(result)})`);
      continue;
    }
    if (!result.ok) {
      failures.push(`${mystery.id} @ ${probe.label}: certificate is not ok (${explainFailure(result)})`);
      continue;
    }

    // 2. Every role is necessary -- and the certificate says so, not the author.
    for (const role of puzzle.roles) {
      checks += 1;
      const proof = result.necessity[role.id];
      if (!proof) {
        failures.push(`${mystery.id} @ ${probe.label}: no necessity proof for ${role.id}`);
        continue;
      }
      if (!proof.proven) {
        failures.push(
          `${mystery.id} @ ${probe.label}: necessity of ${role.id} is unproven (${proof.reason})`,
        );
      }
      if (!proof.necessary) {
        failures.push(
          `${mystery.id} @ ${probe.label}: ${role.id} is decorative -- ${proof.reason}`,
        );
      }
    }

    // The certificate must not name a role the puzzle does not seat, or a
    // "proof" about a role nobody plays would be silently ignored above.
    checks += 1;
    const proofRoles = Object.keys(result.necessity).sort().join(",");
    const seatRoles = puzzle.roles.map((r) => r.id).sort().join(",");
    if (proofRoles !== seatRoles) {
      failures.push(
        `${mystery.id} @ ${probe.label}: necessity is keyed by [${proofRoles}], puzzle seats [${seatRoles}]`,
      );
    }

    checks += 1;
    for (const role of puzzle.roles) {
      const meaningful = result.meaningful[role.id];
      if (!meaningful || !meaningful.meaningful) {
        failures.push(
          `${mystery.id} @ ${probe.label}: ${role.id} contributes nothing to the witness plan (${meaningful?.reason ?? "no proof"})`,
        );
      }
    }

    checks += 1;
    if (!result.accessibility.ok) {
      for (const violation of result.accessibility.violations) {
        failures.push(`${mystery.id} @ ${probe.label}: accessibility -- ${violation.detail}`);
      }
    }
  }

  /* ---- 3. Access on its own terms, over every state and every action ---- */

  for (const probe of probes) {
    const accessibility = checkAccessibility(puzzle, probe.state);
    const done = new Set(
      probe.state.history.filter((e) => e.kind === "action").map((e) => e.actionId),
    );
    for (const action of puzzle.actions) {
      checks += 1;
      // No action asks for an input its performer lacks. `checkAccessibility`
      // covers this, but only for actions still ahead of the team -- every
      // action is checked here against the role that would perform it.
      const performer = action.performer;
      const eligible =
        performer === "any"
          ? puzzle.roles.some((r) => r.capabilities.includes(action.needs))
          : (puzzle.roles.find((r) => r.id === performer)?.capabilities.includes(action.needs) ??
            false);
      if (!eligible) {
        failures.push(
          `${mystery.id} @ ${probe.label}: "${action.id}" needs "${action.needs}" and nobody who can perform it has it`,
        );
      }
      // No scan choice exceeds 4 options -- the model's own bound, not a
      // number this file chose.
      checks += 1;
      const options = action.options ?? 1;
      if (action.needs === "scan" && options > SCAN_MAX_OPTIONS) {
        failures.push(
          `${mystery.id} @ ${probe.label}: scan choice "${action.id}" offers ${options} options, over the ${SCAN_MAX_OPTIONS} bound`,
        );
      }
      // Every choice names the token that decides it, and holds that token.
      checks += 1;
      if (options > 1) {
        if (!action.answerToken) {
          failures.push(`${mystery.id}: choice "${action.id}" names no answer token`);
        } else if (!action.requiresTokens.includes(action.answerToken)) {
          failures.push(
            `${mystery.id}: choice "${action.id}" answers with "${action.answerToken}", which it does not require`,
          );
        }
      }
    }
    checks += 1;
    if (!accessibility.ok && done.size === 0) {
      for (const violation of accessibility.violations) {
        failures.push(`${mystery.id} @ ${probe.label}: ${violation.detail}`);
      }
    }
  }

  /* ---- 4. A capability change for EACH role, at the midpoint ---- */

  const midProbe = probes.find((p) => p.steps === midStep) ?? probes[probes.length - 1]!;
  const changes: Audit["changes"] = [];

  for (const role of puzzle.roles) {
    checks += 1;
    const to = changeTarget(role.capabilities);
    let result: RecompileResult;
    try {
      result = recompile(puzzle, midProbe.state, role.id, to);
    } catch (error) {
      // A throw is the operator library reporting its own bug, and the table
      // must say so rather than losing it.
      changes.push({
        role: role.id,
        from: [...role.capabilities],
        to,
        kind: "threw",
        certified: false,
        progressPreserved: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      failures.push(`${mystery.id}: recompile threw for ${role.id}: ${String(error)}`);
      continue;
    }

    if (!TYPED_OUTCOMES.includes(result.kind)) {
      failures.push(`${mystery.id}: recompile(${role.id}) returned an untyped kind "${result.kind}"`);
      changes.push({
        role: role.id,
        from: [...role.capabilities],
        to,
        kind: result.kind,
        certified: false,
        progressPreserved: false,
        detail: "untyped outcome",
      });
      continue;
    }

    let certified = false;
    let progressPreserved = false;
    let detail: string = result.kind;

    if (result.kind === "ok") {
      // Where a repair exists, the new certificate must be ok...
      checks += 1;
      const repaired = certify(result.puzzle, result.state);
      certified = isCertificate(repaired) && repaired.ok;
      if (!certified) {
        failures.push(
          `${mystery.id}: repaired puzzle for ${role.id} does not certify (${explainFailure(repaired)})`,
        );
      }
      // ...and the progress the team already made must still be there.
      checks += 1;
      const progress = checkProgressPreserved(midProbe.state, result.state, result.puzzle);
      progressPreserved = progress.preserved;
      if (!progressPreserved) {
        failures.push(
          `${mystery.id}: repair for ${role.id} lost progress (facts ${progress.factsUnchanged}, history prefix ${progress.historyIsPrefix}, vanished ${progress.vanishedActions.join(",") || "none"})`,
        );
      }
      detail = `${result.kind} (${result.operatorsTried.length} operators, ${result.totalStatesExplored} states)`;
    } else if (result.kind === "no_valid_recompile") {
      // A definitive "no repair exists" is a claim about the mystery, and it is
      // only honest if every candidate was *proven* invalid rather than capped.
      detail = `${result.kind} (${result.operatorsTried.length} operators tried)`;
    } else {
      detail = `${result.kind} (${"reason" in result ? result.reason : ""})`;
    }

    changes.push({
      role: role.id,
      from: [...role.capabilities],
      to,
      kind: result.kind,
      certified,
      progressPreserved,
      detail,
    });
  }

  // The recompile path must be live for this mystery: at least one role's
  // change has to actually repair, or the table above is vacuous for it.
  checks += 1;
  if (!changes.some((c) => c.kind === "ok")) {
    failures.push(
      `${mystery.id}: no role's input change is repairable, so the recompile claim is untested here`,
    );
  }

  return { mystery, puzzle, planLength, probes, changes, failures, checks };
}

/* ------------------------------------------------------------------ */
/* The structure of dependence, derived rather than declared           */
/* ------------------------------------------------------------------ */

/**
 * Which roles a role depends on: an edge `X->Y` means Y cannot act until X has
 * produced something -- a token Y's action requires, or a flag Y's action
 * requires. Derived from the puzzle, so it cannot drift from the content.
 *
 * Private tokens count as an edge from their holder, which is what makes the
 * study's shape visible: A's `painting_hint` feeds only A's own actions in the
 * plan's first step, and nothing any other role needs is gated on A's output
 * until the very end.
 */
export function roleDependencyGraph(puzzle: Puzzle): string {
  const producerOf = new Map<string, Set<string>>();
  for (const role of puzzle.roles) {
    for (const token of role.privateTokens) {
      const set = producerOf.get(token) ?? new Set<string>();
      set.add(role.id);
      producerOf.set(token, set);
    }
  }
  for (const action of puzzle.actions) {
    for (const token of action.producesTokens) {
      const set = producerOf.get(token) ?? new Set<string>();
      set.add(action.performer);
      producerOf.set(token, set);
    }
    for (const flag of action.setsFlags) {
      const set = producerOf.get(flag) ?? new Set<string>();
      set.add(action.performer);
      producerOf.set(flag, set);
    }
  }

  const edges = new Set<string>();
  for (const action of puzzle.actions) {
    const consumer = action.performer;
    for (const needed of [...action.requiresTokens, ...action.requiresFlags]) {
      for (const producer of producerOf.get(needed) ?? []) {
        if (consumer === "any" || producer === consumer) continue;
        edges.add(`${producer}->${consumer}`);
      }
    }
  }
  return [...edges].sort().join(",");
}

