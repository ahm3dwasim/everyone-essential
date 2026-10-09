/**
 * CLI. The only file in this package allowed to touch Node-specific globals.
 *
 *   node dist/cli.js demo     replay "The Locked Study" end to end
 *   node dist/cli.js bench    measure solving/certifying against puzzle size
 *
 * Everything printed except the `timing.*` lines and the bench millisecond
 * columns is a pure function of the puzzle, so two runs diff clean once those
 * lines are filtered out.
 */
import { type Certificate } from "./certify";
import { type State, doneActionIds } from "./model";
import { type PlanStep } from "./solve";
import {
  type BenchRow,
  benchDemoRecompile,
  benchFamily,
  benchRecompileFamily,
  benchRoles,
  makeBranchPuzzle,
  makeChainPuzzle,
} from "./bench";
import { runDemo } from "./demo";

function main(argv: string[]): number {
  const command = argv[0] ?? "demo";
  switch (command) {
    case "demo":
      process.stdout.write(demoOutput());
      return 0;
    case "bench":
      process.stdout.write(benchOutput());
      return 0;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write("usage: node dist/cli.js [demo|bench]\n");
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\nusage: node dist/cli.js [demo|bench]\n`);
      return 2;
  }
}

/* ------------------------------------------------------------------ */
/* demo                                                                */
/* ------------------------------------------------------------------ */

function demoOutput(): string {
  const run = runDemo();
  const lines: string[] = [];

  lines.push("=== The Locked Study ===");
  lines.push(
    `roles: ${run.puzzle.roles
      .map((r) => `${r.id}(${r.capabilities.join("+")})`)
      .join(", ")}`,
  );
  lines.push(`actions: ${run.puzzle.actions.length}`);
  lines.push("");

  lines.push("--- 1. initial certificate ---");
  lines.push(...certificateLines(run.initialCertificate));
  lines.push("");
  lines.push(`witness plan (${run.initialPlan.length} steps):`);
  lines.push(...planLines(run.initialPlan));
  lines.push("");

  lines.push(
    `--- 2. midpoint: ${run.midpointSteps} of ${run.initialPlan.length} plan steps already done ---`,
  );
  lines.push(...stateLines(run.midpointState));
  lines.push(`certificate at midpoint still ok: ${run.midpointCertificate.ok}`);
  lines.push("");

  lines.push("--- 3. input mode change ---");
  lines.push(`${run.changeRole}: [${run.changeFrom.join(", ")}] -> [${run.changeTo.join(", ")}]`);
  lines.push("");

  lines.push("--- 4. recompile diff (what a display shows) ---");
  if (run.recompile.kind === "ok") {
    for (const entry of run.recompile.diff) lines.push(`  [${entry.op}] ${entry.summary}`);
  } else {
    lines.push(`  NO_VALID_RECOMPILE: ${run.recompile.reason}`);
    for (const entry of run.recompile.diff) lines.push(`  [${entry.op}] ${entry.summary}`);
  }
  lines.push("");
  const byDepth = new Map<number, number>();
  for (const attempt of run.recompile.operatorsTried) {
    byDepth.set(attempt.depth, (byDepth.get(attempt.depth) ?? 0) + 1);
  }
  const depthSummary = [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, count]) => `depth ${depth}: ${count}`)
    .join(", ");
  lines.push(`operators tried: ${run.recompile.operatorsTried.length} (${depthSummary})`);
  if (run.recompile.kind === "ok") {
    // On success only the winning operators matter on screen; the full tried
    // list is on the result object for anyone who wants it.
    for (const attempt of run.recompile.operatorsTried) {
      if (attempt.ok) lines.push(`  ACCEPTED depth ${attempt.depth} ${attempt.op}: ${attempt.detail}`);
    }
  } else {
    // On failure every attempt is the evidence, so print them all, one line each.
    for (const attempt of run.recompile.operatorsTried) {
      lines.push(
        `  depth ${attempt.depth} ${attempt.op}: ${attempt.detail} -> rejected (${firstClause(
          attempt.rejectedBecause,
        )})`,
      );
    }
  }
  lines.push("");

  lines.push("--- 5. certificate after recompile ---");
  if (run.finalCertificate) {
    lines.push(...certificateLines(run.finalCertificate));
    lines.push("");
    lines.push(`remaining plan from the midpoint (${run.finalPlan.length} steps):`);
    lines.push(...planLines(run.finalPlan));
  } else {
    lines.push("(no valid recompile, so no certificate)");
  }
  lines.push("");

  lines.push("--- 6. progress preserved ---");
  lines.push(`facts unchanged: ${run.progress.factsUnchanged}`);
  lines.push(`history is a prefix: ${run.progress.historyIsPrefix}`);
  lines.push(`already-performed actions still exist: ${run.progress.doneActionsStillExist}`);
  lines.push(`vanished actions: ${run.progress.vanishedActions.length}`);
  lines.push(`progress preserved: ${run.progress.preserved}`);
  lines.push("");

  lines.push("--- 7. timings (the only non-deterministic lines) ---");
  lines.push(`timing.solve_ms ${run.timings.solveMs}`);
  lines.push(`timing.certify_ms ${run.timings.certifyMs}`);
  lines.push(`timing.recompile_ms ${run.timings.recompileMs}`);
  lines.push(`timing.certify_after_recompile_ms ${run.timings.certifyAfterRecompileMs}`);
  lines.push(`timing.total_ms ${run.timings.totalMs}`);
  lines.push(`timing.solve_states_explored ${run.solveStates}`);
  lines.push("");

  return lines.join("\n");
}

function certificateLines(certificate: Certificate): string[] {
  const lines: string[] = [];
  lines.push(`puzzle: ${certificate.puzzleId}`);
  lines.push(`ok: ${certificate.ok}`);
  lines.push(`hash: ${certificate.hash}`);
  lines.push(
    `solvable: ${certificate.solvable.ok} (proven ${certificate.solvable.proven}, ${certificate.solvable.statesExplored} states explored, truncated ${certificate.solvable.truncated})`,
  );
  for (const role of Object.keys(certificate.necessity).sort()) {
    const proof = certificate.necessity[role]!;
    lines.push(
      `necessity.${role}: ${proof.necessary} (proven ${proof.proven}, ${proof.statesExplored} states explored) -- ${proof.reason}`,
    );
  }
  lines.push(`accessibility: ${certificate.accessibility.ok}`);
  for (const violation of certificate.accessibility.violations) {
    lines.push(`  violation: ${violation.detail}`);
  }
  for (const role of Object.keys(certificate.meaningful).sort()) {
    const proof = certificate.meaningful[role]!;
    lines.push(`meaningful.${role}: ${proof.meaningful} -- ${proof.reason}`);
  }
  return lines;
}

function planLines(plan: readonly PlanStep[]): string[] {
  if (plan.length === 0) return ["  (already solved)"];
  const width = Math.max(...plan.map((s) => s.action.length));
  return plan.map(
    (s) => `  ${String(s.step).padStart(2)}. ${s.performer}  ${s.action.padEnd(width)}  ${s.label}`,
  );
}

/** First clause of a rejection reason, so one attempt fits on one line. */
function firstClause(reason: string): string {
  const cut = reason.split(";")[0] ?? reason;
  return cut.trim();
}

function stateLines(state: State): string[] {
  return [
    `flags: [${state.flags.join(", ")}]`,
    `tokens: [${state.tokens.join(", ")}]`,
    `doneActions: [${doneActionIds(state.history).join(", ")}]`,
  ];
}

/* ------------------------------------------------------------------ */
/* bench                                                               */
/* ------------------------------------------------------------------ */

function benchOutput(): string {
  const lines: string[] = [];
  lines.push("=== scaling: certify() vs puzzle size ===");
  lines.push("family        roles  actions   solve_st  total_st  solve_ms  certify_ms  ok");
  const rows: BenchRow[] = [
    ...benchFamily("branch", makeBranchPuzzle, [8, 10, 12, 14, 15, 16, 17, 18]),
    ...benchFamily("chain", makeChainPuzzle, [10, 50, 200, 1000, 1500, 2000, 3000, 5000]),
  ];
  for (const row of rows) {
    lines.push(
      [
        row.name.padEnd(13),
        String(row.roles).padStart(5),
        String(row.actions).padStart(8),
        String(row.statesExplored).padStart(9),
        String(row.totalStates).padStart(9),
        String(row.solveMs).padStart(9),
        String(row.certifyMs).padStart(11),
        row.truncated ? "TRUNCATED" : String(row.certificateOk),
      ].join("  "),
    );
  }

  lines.push("");
  lines.push("=== the whole cost of one certificate, by role count ===");
  lines.push("roles  actions  solve_st  counterfactual_states        total_st  certify_ms  ok");
  for (const row of benchRoles([1, 2, 3, 4])) {
    lines.push(
      [
        String(row.roles).padStart(5),
        String(row.actions).padStart(8),
        String(row.solveStates).padStart(9),
        row.counterfactualStates.join("+").padEnd(24),
        String(row.totalStates).padStart(9),
        String(row.certifyMs).padStart(11),
        String(row.ok),
      ].join("  "),
    );
  }

  lines.push("");
  lines.push("=== recompile: candidates certified and their total state cost ===");
  lines.push("roles  actions  kind               candidates  total_st  microseconds");
  for (const row of benchRecompileFamily([1, 2, 3, 4])) {
    lines.push(
      [
        String(row.roles).padStart(5),
        String(row.actions).padStart(8),
        row.kind.padEnd(18),
        String(row.candidatesCertified).padStart(10),
        String(row.totalStates).padStart(9),
        String(row.microseconds).padStart(14),
      ].join("  "),
    );
  }

  const demo = benchDemoRecompile(25);
  lines.push("");
  lines.push("=== the demo's own recompile (the 200 ms performance budget) ===");
  lines.push(`repeats: ${demo.repeats}`);
  lines.push(`every run returned ok: ${demo.allOk}`);
  lines.push(`operators tried per run: ${demo.operatorsTried}`);
  lines.push(`min_ms ${demo.minMs}`);
  lines.push(`median_ms ${demo.medianMs}`);
  lines.push(`max_ms ${demo.maxMs}`);

  return lines.join("\n") + "\n";
}

process.exitCode = main(process.argv.slice(2));
