/**
 * Measurement harness. Two puzzle families, each with one scaling knob, so the
 * report can say "under 200 ms up to N actions" instead of "it felt fast".
 *
 *   branch(n)  a root action plus n independent leaves plus a join. The join
 *              needs every leaf, so the search has to enumerate all 2^n
 *              subsets. Worst case: exponential in the action count.
 *   chain(n)   a strictly ordered chain of n actions. Best case: linear.
 *
 * Both certify clean (one required role), so `certify` runs the full
 * solvability search plus one counterfactual search per role.
 */
import { type Puzzle, emptyState } from "./model";
import { applyPlan, solve } from "./solve";
import { certify, isCertificate, totalStates } from "./certify";
import { recompile } from "./recompile";
import { DEMO_CHANGE_CAPABILITIES, DEMO_CHANGE_ROLE, demoPuzzle } from "./demo";
import { now } from "./clock";

/**
 * One measurement of the whole pipeline on one puzzle.
 *
 * `statesExplored` is the initial solve only (it is what the solver reports);
 * `totalStates` is what the work actually costs -- the initial solve plus every
 * counterfactual search. Reporting the first as if it were the second
 * understates the work by a factor of roles + 1.
 */
export interface BenchRow {
  name: string;
  roles: number;
  actions: number;
  statesExplored: number;
  totalStates: number;
  truncated: boolean;
  certificateOk: boolean;
  solveMs: number;
  certifyMs: number;
}

export interface BenchOptions {
  /** Give up the sweep once a size takes longer than this. Default 400 ms. */
  budgetMs?: number;
  /** Repeats per size; the fastest run is reported. Default 3. */
  repeats?: number;
  /** Hard state cap handed to the solver. Default 1_500_000. */
  maxStates?: number;
}

const SOLO = "solo";

/** `branches` independent leaf actions behind one root, joined by one finish. */
export function makeBranchPuzzle(branches: number): Puzzle {
  const leafTokens = Array.from({ length: branches }, (_, i) => `leaf_${i}`);
  return {
    id: `branch-${branches}`,
    roles: [{ id: SOLO, capabilities: ["dpad"], privateTokens: ["root_hint"] }],
    primitives: [
      { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
    ],
    goalFlags: ["goal"],
    actions: [
      {
        id: "root",
        performer: SOLO,
        needs: "dpad",
        requiresTokens: ["root_hint"],
        requiresFlags: [],
        producesTokens: ["root"],
        setsFlags: [],
      },
      ...leafTokens.map((token, i) => ({
        id: `leaf_${i}`,
        performer: SOLO,
        needs: "dpad" as const,
        requiresTokens: ["root"],
        requiresFlags: [],
        producesTokens: [token],
        setsFlags: [],
      })),
      {
        id: "finish",
        performer: SOLO,
        needs: "dpad",
        requiresTokens: leafTokens,
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
}

/** `length` actions in a strict chain, the last one setting the goal. */
export function makeChainPuzzle(length: number): Puzzle {
  const actions = [];
  for (let i = 0; i < length; i++) {
    actions.push({
      id: `link_${i}`,
      performer: SOLO,
      needs: "dpad" as const,
      requiresTokens: [i === 0 ? "seed" : `link_${i - 1}`],
      requiresFlags: [],
      producesTokens: i === length - 1 ? [] : [`link_${i}`],
      setsFlags: i === length - 1 ? ["goal"] : [],
    });
  }
  return {
    id: `chain-${length}`,
    roles: [{ id: SOLO, capabilities: ["dpad"], privateTokens: ["seed"] }],
    primitives: [
      { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
    ],
    goalFlags: ["goal"],
    actions,
  };
}

/**
 * Sweep sizes until the budget is blown (or the list runs out) and return one
 * row per size. Stops at the first size over budget: past it the numbers stop
 * being useful and the memory cost of the exponential family gets real.
 */
export function benchFamily(
  name: string,
  make: (size: number) => Puzzle,
  sizes: number[],
  options: BenchOptions = {},
): BenchRow[] {
  const budgetMs = options.budgetMs ?? 400;
  const repeats = options.repeats ?? 3;
  const rows: BenchRow[] = [];

  for (const size of sizes) {
    const puzzle = make(size);
    let best: BenchRow | null = null;

    for (let run = 0; run < repeats; run++) {
      const t0 = now();
      const result = solve(puzzle, emptyState(), { maxStates: options.maxStates ?? 1_500_000 });
      const solveMs = now() - t0;

      const t1 = now();
      const certified = certify(puzzle, emptyState(), {
        maxStates: options.maxStates ?? 1_500_000,
      });
      const certifyMs = now() - t1;
      const certificate = isCertificate(certified) ? certified : null;

      const row: BenchRow = {
        name: `${name}-${size}`,
        roles: puzzle.roles.length,
        actions: puzzle.actions.length,
        statesExplored: result.statesExplored,
        totalStates: certificate ? totalStates(certificate) : result.statesExplored,
        truncated: result.truncated || (certificate?.solvable.truncated ?? false),
        certificateOk: certificate?.ok ?? false,
        solveMs: round(solveMs),
        certifyMs: round(certifyMs),
      };
      if (!best || row.certifyMs < best.certifyMs) best = row;
    }

    const row = best!;
    rows.push(row);
    if (row.certifyMs > budgetMs || row.truncated) break;
  }

  return rows;
}

const FAMILY_ROOT = "root";

/**
 * A family with one knob that actually moves the number of roles: `R` roles,
 * each holding a private seed and running a one-step errand, joined by a finish
 * that needs every role's output.
 *
 * Every role is necessary by construction (the join cannot run without its
 * token) and the goal is reachable, so `certify` runs a real search plus R real
 * counterfactuals -- which is the cost this family exists to measure. It is
 * also the cheapest possible shape: no role removal ever cascades, so the
 * numbers are a floor for R roles, not a worst case.
 */
export function makeRoleFamilyPuzzle(roles: number): Puzzle {
  const outputs = Array.from({ length: roles }, (_, i) => `${FAMILY_ROOT}_out_${i}`);
  return {
    id: `roles-${roles}`,
    roles: Array.from({ length: roles }, (_, i) => ({
      id: `${FAMILY_ROOT}_${i}`,
      capabilities: ["dpad" as const],
      privateTokens: [`${FAMILY_ROOT}_seed_${i}`],
    })),
    primitives: [
      { id: "dpad.button", capability: "dpad", maxOptions: 1, splittable: false, label: "press" },
    ],
    goalFlags: ["goal"],
    actions: [
      ...outputs.map((token, i) => ({
        id: `${FAMILY_ROOT}_work_${i}`,
        performer: `${FAMILY_ROOT}_${i}`,
        needs: "dpad" as const,
        requiresTokens: [`${FAMILY_ROOT}_seed_${i}`],
        requiresFlags: [],
        producesTokens: [token],
        setsFlags: [],
      })),
      {
        id: "join",
        performer: "any",
        needs: "dpad" as const,
        requiresTokens: outputs,
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["goal"],
      },
    ],
  };
}

export interface RoleBench {
  roles: number;
  actions: number;
  /** States in the initial solve. */
  solveStates: number;
  /** States in each role's counterfactual search, in role order. */
  counterfactualStates: number[];
  /** Initial solve plus every counterfactual: what certification really costs. */
  totalStates: number;
  certifyMs: number;
  ok: boolean;
}

/** Certify the role family at each size and report the whole cost, not just the first search. */
export function benchRoles(sizes: number[], repeats = 3): RoleBench[] {
  const out: RoleBench[] = [];
  for (const roles of sizes) {
    const puzzle = makeRoleFamilyPuzzle(roles);
    let best: RoleBench | null = null;
    for (let run = 0; run < repeats; run++) {
      const t0 = now();
      const certified = certify(puzzle, emptyState());
      const certifyMs = now() - t0;
      if (!isCertificate(certified)) {
        throw new Error(`role family ${roles} was refused: ${certified.reason}`);
      }
      const row: RoleBench = {
        roles,
        actions: puzzle.actions.length,
        solveStates: certified.solvable.statesExplored,
        counterfactualStates: puzzle.roles.map((r) => certified.necessity[r.id]?.statesExplored ?? 0),
        totalStates: totalStates(certified),
        certifyMs: round(certifyMs),
        ok: certified.ok,
      };
      if (!best || row.certifyMs < best.certifyMs) best = row;
    }
    out.push(best!);
  }
  return out;
}

export interface RecompileFamilyBench {
  roles: number;
  actions: number;
  kind: string;
  /** Candidates whose certificates were actually computed. */
  candidatesCertified: number;
  /**
   * Solver states spent across every candidate certified, as the recompiler
   * itself counted them. Non-zero even for a search that ends in a refusal --
   * the work happened either way.
   */
  totalStates: number;
  microseconds: number;
}

/**
 * The recompile cost for the role family at each size: how many candidates had
 * to be certified, and how many solver states that cost in total.
 *
 * `C`'s work is a chain of `length` dependent d-pad actions, so a repair has to
 * convert all of them -- a repair whose operator count grows with the puzzle,
 * which is what makes the depth bound and the candidate budget worth measuring.
 */
export function benchRecompileFamily(sizes: number[]): RecompileFamilyBench[] {
  const out: RecompileFamilyBench[] = [];
  for (const roles of sizes) {
    const puzzle = makeRoleFamilyPuzzle(roles);
    // Make the last role's errand a chain so that a repair needs several steps.
    const target = `${FAMILY_ROOT}_${roles - 1}`;
    const chainLength = Math.max(1, roles);
    const chained = withChainForRole(puzzle, target, chainLength);

    const t0 = now();
    const result = recompile(chained, emptyState(), target, ["scan"]);
    const micros = (now() - t0) * 1000;

    out.push({
      roles,
      actions: chained.actions.length,
      kind: result.kind,
      candidatesCertified: result.operatorsTried.length,
      totalStates: result.totalStatesExplored,
      microseconds: Math.round(micros),
    });
  }
  return out;
}

/** Replace `roleId`'s single errand with a chain of `length` dependent actions. */
function withChainForRole(puzzle: Puzzle, roleId: string, length: number): Puzzle {
  const role = puzzle.roles.find((r) => r.id === roleId);
  if (!role) return puzzle;
  const seed = role.privateTokens[0] ?? `${roleId}_seed`;
  const actions = puzzle.actions.filter((a) => a.performer !== roleId);
  const join = actions.find((a) => a.id === "join");
  const outputs = [seed];
  for (let i = 0; i < length; i++) {
    const token = i === length - 1 ? `${roleId}_final` : `${roleId}_chain_${i}`;
    actions.push({
      id: `${roleId}_link_${i}`,
      performer: roleId,
      needs: "dpad",
      requiresTokens: [outputs[outputs.length - 1]!],
      requiresFlags: [],
      producesTokens: [token],
      setsFlags: [],
    });
    outputs.push(token);
  }
  if (join) join.requiresTokens = [...join.requiresTokens.filter((t) => !t.startsWith(`${roleId}_out`)), `${roleId}_final`];
  return { ...puzzle, actions };
}

export interface RecompileBench {
  repeats: number;
  allOk: boolean;
  minMs: number;
  medianMs: number;
  maxMs: number;
  operatorsTried: number;
}

/**
 * The demo's own recompile, repeated. This is the number the 200 ms budget
 * refers to, and it is measured on the shipped demo puzzle rather than on
 * something convenient.
 */
export function benchDemoRecompile(repeats: number): RecompileBench {
  const puzzle = demoPuzzle();
  const start = emptyState();
  const plan = solve(puzzle, start).plan;
  const midpoint = applyPlan(puzzle, start, plan, Math.floor(plan.length / 2));

  const times: number[] = [];
  let allOk = true;
  let operatorsTried = 0;

  for (let i = 0; i < repeats; i++) {
    const result = recompile(puzzle, midpoint, DEMO_CHANGE_ROLE, [...DEMO_CHANGE_CAPABILITIES]);
    times.push(result.elapsedMs);
    operatorsTried = result.operatorsTried.length;
    if (result.kind !== "ok") allOk = false;
  }

  times.sort((a, b) => a - b);
  return {
    repeats,
    allOk,
    minMs: times[0] ?? 0,
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    maxMs: times[times.length - 1] ?? 0,
    operatorsTried,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
