/**
 * "The Locked Study" -- the demo mystery, and the script the CLI replays.
 *
 * Three players, three input modes, one door:
 *   A  d-pad            holds the hint about where the safe is
 *   B  voice (phone)    holds the two spoken code digits
 *   C  d-pad            holds the drawer note; switches to scan-only mid-game
 *
 * Nothing here is hand-authored to look necessary. The certificate proves it:
 * delete any of the three and the solver cannot reach `study_unlocked`.
 */
import {
  type Puzzle,
  type RoleId,
  type State,
  doneActionIds,
  emptyState,
  normalizeState,
  sameSet,
} from "./model";
import { canonicalStringify } from "./hash";
import { type PlanStep, applyPlan, solve } from "./solve";
import { type Certificate, certify, explainFailure, isCertificate } from "./certify";
import { type RecompileResult, recompile } from "./recompile";

export const ROLE_A: RoleId = "A";
export const ROLE_B: RoleId = "B";
export const ROLE_C: RoleId = "C";

/** The primitives the puzzle's actions can be rebuilt from. */
export const DEMO_PRIMITIVES = [
  {
    id: "dpad.grid",
    capability: "dpad" as const,
    maxOptions: 9,
    splittable: false,
    label: "3x3 d-pad grid",
  },
  {
    id: "dpad.button",
    capability: "dpad" as const,
    maxOptions: 1,
    splittable: false,
    label: "single d-pad press",
  },
  {
    id: "scan.paged",
    capability: "scan" as const,
    maxOptions: 4,
    splittable: true,
    label: "switch-scan paged list",
  },
  {
    id: "voice.confirm",
    capability: "voice" as const,
    maxOptions: 1,
    splittable: false,
    label: "spoken confirmation",
  },
];

export function demoPuzzle(): Puzzle {
  return {
    id: "the-locked-study",
    roles: [
      { id: ROLE_A, capabilities: ["dpad"], privateTokens: ["painting_hint"] },
      { id: ROLE_B, capabilities: ["voice"], privateTokens: ["code_digit_1", "code_digit_2"] },
      { id: ROLE_C, capabilities: ["dpad"], privateTokens: ["desk_drawer_note"] },
    ],
    primitives: DEMO_PRIMITIVES.map((p) => ({ ...p })),
    goalFlags: ["study_unlocked"],
    actions: [
      {
        id: "a_read_painting_hint",
        performer: ROLE_A,
        needs: "dpad",
        requiresTokens: ["painting_hint"],
        requiresFlags: [],
        producesTokens: ["safe_location"],
        setsFlags: [],
        label: "read the note taped behind the painting",
      },
      {
        id: "a_shift_painting",
        performer: ROLE_A,
        needs: "dpad",
        // A can only lift the painting the right way once the hint is known --
        // and the hint is A's own private token, so A has to say it out loud.
        requiresTokens: ["safe_location", "painting_hint"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["painting_moved"],
        options: 4,
        // Four ways to lift it, and only the hint says which. A player who has
        // not heard the hint cannot pick correctly, so the action cannot fire.
        answerToken: "painting_hint",
        label: "swing the painting aside (4 ways to lift it)",
      },
      {
        id: "b_dictate_code",
        performer: ROLE_B,
        needs: "voice",
        requiresTokens: ["code_digit_1", "code_digit_2"],
        requiresFlags: [],
        producesTokens: ["safe_code"],
        setsFlags: [],
        label: "read the two code digits out loud",
      },
      {
        id: "b_describe_symbols",
        performer: ROLE_B,
        needs: "voice",
        requiresTokens: [],
        requiresFlags: [],
        producesTokens: ["symbol_names"],
        setsFlags: [],
        label: "name the nine symbols on the dial",
      },
      {
        id: "c_read_drawer_note",
        performer: ROLE_C,
        needs: "dpad",
        requiresTokens: ["desk_drawer_note"],
        requiresFlags: [],
        producesTokens: ["dial_rule"],
        setsFlags: [],
        label: "read the drawer note about the dial",
      },
      {
        id: "c_match_symbol",
        performer: ROLE_C,
        needs: "dpad",
        requiresTokens: ["dial_rule", "symbol_names"],
        requiresFlags: [],
        producesTokens: ["dial_symbol"],
        setsFlags: [],
        options: 4,
        // Four symbol families; the drawer note is what says which one.
        answerToken: "dial_rule",
        label: "match the rule to one of four symbol families",
      },
      {
        id: "c_dial_safe",
        performer: ROLE_C,
        needs: "dpad",
        // safe_code is both the dial's answer and B's dictated digits: the
        // choice is only makeable by someone who has heard them.
        requiresTokens: ["safe_code", "safe_location", "dial_symbol"],
        requiresFlags: ["painting_moved"],
        producesTokens: [],
        setsFlags: ["safe_open"],
        options: 9,
        // Nine grid positions; B's dictated digits are the only way to know
        // which. This is the action C has to re-earn after switching to scan.
        answerToken: "safe_code",
        label: "dial the safe on the 3x3 grid",
      },
      {
        id: "a_reach_into_safe",
        performer: ROLE_A,
        needs: "dpad",
        requiresTokens: [],
        requiresFlags: ["safe_open"],
        producesTokens: ["study_key"],
        setsFlags: [],
        label: "feel around inside the safe for the key",
      },
      {
        id: "b_listen_for_tumblers",
        performer: ROLE_B,
        needs: "voice",
        requiresTokens: ["dial_symbol"],
        requiresFlags: ["safe_open"],
        producesTokens: [],
        setsFlags: ["tumblers_heard"],
        label: "listen to the tumblers settle",
      },
      {
        id: "any_enter_study",
        performer: "any",
        needs: "dpad",
        requiresTokens: ["study_key"],
        requiresFlags: ["tumblers_heard"],
        producesTokens: [],
        setsFlags: ["study_unlocked"],
        label: "unlock the study door",
      },
    ],
  };
}

/** The capability change the demo exercises. */
export const DEMO_CHANGE_ROLE: RoleId = ROLE_C;
export const DEMO_CHANGE_CAPABILITIES = ["scan"] as const;

export interface ProgressCheck {
  preserved: boolean;
  /** Neither `flags` nor `tokens` changed. */
  factsUnchanged: boolean;
  /** `before`'s history is a prefix of `after`'s -- nothing recorded was altered. */
  historyIsPrefix: boolean;
  /** Every already-performed action still exists in the repaired puzzle. */
  doneActionsStillExist: boolean;
  vanishedActions: string[];
}

export interface DemoRun {
  puzzle: Puzzle;
  initialCertificate: Certificate;
  initialPlan: PlanStep[];
  solveStates: number;
  /** How many plan steps the team has already performed at the midpoint. */
  midpointSteps: number;
  midpointState: State;
  midpointCertificate: Certificate;
  changeRole: RoleId;
  changeFrom: string[];
  changeTo: string[];
  recompile: RecompileResult;
  progress: ProgressCheck;
  finalCertificate: Certificate | null;
  finalPlan: PlanStep[];
  timings: {
    solveMs: number;
    certifyMs: number;
    certifyAfterRecompileMs: number;
    recompileMs: number;
    totalMs: number;
  };
}

/**
 * Replay the whole demo deterministically. Timings are the only
 * non-deterministic field; everything else is a pure function of the puzzle.
 */
export function runDemo(): DemoRun {
  const t0 = performanceNow();
  const puzzle = demoPuzzle();
  const start = emptyState();

  const solveStart = performanceNow();
  const initialSolve = solve(puzzle, start);
  const solveMs = round(performanceNow() - solveStart);

  const certifyStart = performanceNow();
  const initialResult = certify(puzzle, start);
  const certifyMs = round(performanceNow() - certifyStart);

  if (!isCertificate(initialResult) || !initialResult.ok || initialSolve.status !== "solvable") {
    throw new Error(
      `demo puzzle does not certify at the start: ${JSON.stringify(initialResult, null, 2)}`,
    );
  }
  const initialCertificate: Certificate = initialResult;

  // "Halfway": follow the witness plan for the first half of its steps.
  const midpointSteps = Math.floor(initialSolve.plan.length / 2);
  const midpointState = applyPlan(puzzle, start, initialSolve.plan, midpointSteps);
  const midpointResult = certify(puzzle, midpointState);
  if (!isCertificate(midpointResult)) {
    throw new Error(`demo midpoint state rejected: ${explainFailure(midpointResult)}`);
  }
  const midpointCertificate: Certificate = midpointResult;

  const recompileResult = recompile(puzzle, midpointState, DEMO_CHANGE_ROLE, [
    ...DEMO_CHANGE_CAPABILITIES,
  ]);

  let finalCertificate: Certificate | null = null;
  let finalPlan: PlanStep[] = [];
  let certifyAfterRecompileMs = 0;
  // No recompile happened (yet), so there is nothing for progress to have lost.
  let progress: ProgressCheck = checkProgressPreserved(midpointState, midpointState, puzzle);

  if (recompileResult.kind === "ok") {
    const repaired = recompileResult.puzzle;
    // The state to certify and solve from now on: `recompileResult.state`, which
    // carries the `capability_change` event the repaired puzzle's roles now
    // depend on. Certifying against the old `midpointState` would replay C's
    // already-performed actions against a capability C appears, from the
    // puzzle alone, to have held from the very start.
    const repairedState = recompileResult.state;
    const afterStart = performanceNow();
    // The repair's synthetic ids live in the reserved namespace, but that
    // namespace is legal input in exactly this shape, so the same `certify`
    // every other caller uses re-proves the repaired puzzle.
    const repairedCertificate = certify(repaired, repairedState);
    certifyAfterRecompileMs = round(performanceNow() - afterStart);
    // The recompiler's own certificate already passed; a refusal here would mean
    // the repaired puzzle is not a puzzle, which is worth failing loudly on.
    if (!isCertificate(repairedCertificate)) {
      throw new Error(`repaired puzzle rejected: ${explainFailure(repairedCertificate)}`);
    }
    finalCertificate = repairedCertificate;
    finalPlan = solve(repaired, repairedState).plan;
    progress = checkProgressPreserved(midpointState, repairedState, repaired);
  }

  const changeRole = puzzle.roles.find((r) => r.id === DEMO_CHANGE_ROLE);
  return {
    puzzle,
    initialCertificate,
    initialPlan: initialSolve.plan,
    solveStates: initialSolve.statesExplored,
    midpointSteps,
    midpointState,
    midpointCertificate,
    changeRole: DEMO_CHANGE_ROLE,
    changeFrom: changeRole ? [...changeRole.capabilities] : [],
    changeTo: [...DEMO_CHANGE_CAPABILITIES],
    recompile: recompileResult,
    progress,
    finalCertificate,
    finalPlan,
    timings: {
      solveMs,
      certifyMs,
      certifyAfterRecompileMs,
      recompileMs: recompileResult.elapsedMs,
      totalMs: round(performanceNow() - t0),
    },
  };
}

/**
 * Progress is preserved only if the facts are untouched, `before`'s history is
 * a prefix of `after`'s (recompile only ever APPENDS a `capability_change`
 * event; it never rewrites or drops one already there), and every action the
 * team already performed still exists in the repaired puzzle. Replacing a
 * half-finished action with a rewritten version would silently lose progress
 * even though the state's facts look identical.
 *
 * `before` and `after` are compared rather than assumed identical so the check
 * stays meaningful whether or not a recompile actually happened.
 */
export function checkProgressPreserved(
  before: State,
  after: State,
  repaired: Puzzle,
): ProgressCheck {
  const a = normalizeState(before);
  const b = normalizeState(after);
  const present = new Set(repaired.actions.map((x) => x.id));
  const vanishedActions = doneActionIds(a.history).filter((id) => !present.has(id));

  const factsUnchanged = sameSet(a.flags, b.flags) && sameSet(a.tokens, b.tokens);
  const historyIsPrefix =
    b.history.length >= a.history.length &&
    a.history.every((event, i) => canonicalStringify(event) === canonicalStringify(b.history[i]));
  const doneActionsStillExist = vanishedActions.length === 0;

  return {
    preserved: factsUnchanged && historyIsPrefix && doneActionsStillExist,
    factsUnchanged,
    historyIsPrefix,
    doneActionsStillExist,
    vanishedActions,
  };
}

function performanceNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return perf && typeof perf.now === "function" ? perf.now() : Date.now();
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
