/**
 * The eight-second rebuild moment: a before/after comparison built from the
 * repair's own structured diff, never from re-parsed prose.
 *
 * The rebuild moment has four beats: the old control held still, the new one
 * revealed beside it, the payoff line, then back to live play. This module
 * derives the DATA for those beats from a
 * `SwitchRecord`; `screens.tsx` only lays it out.
 */
import { CAPABILITY_LABEL, ROLE_LABEL, actionTitle, baseActionId, generatedStep, isGeneratedId } from "./presentation.ts";
import type { DiffEntry, Puzzle } from "./validator.ts";
import type { SwitchRecord } from "./reducer.ts";

export interface MomentAction {
  /** The action id(s) this covers: one id normally, several for a split chain. */
  actionIds: string[];
  label: string;
  steps: number;
  /** Options offered per step (the same on every step of a split chain). */
  optionsPerStep: number;
}

export interface PrimaryChange {
  before: MomentAction;
  after: MomentAction;
}

export interface RebuildMoment {
  role: string;
  toCapabilityLabel: string;
  /** The action the eight-second sequence dramatizes, or null when nothing changed shape. */
  primary: PrimaryChange | null;
  /** One line per OTHER action the switch also touched, already worded for the screen. */
  secondary: string[];
  /** True only when the changed role still performs everything it owned before. */
  ownershipRetained: boolean;
  /** Set when an action moved to a different role instead. */
  newOwner: string | null;
  /** True when the switch changed nothing about the action shape at all. */
  noOpChange: boolean;
}

function actionById(puzzle: Puzzle, id: string) {
  return puzzle.actions.find((a) => a.id === id);
}

/** One convert `DiffEntry`, turned into the before/after action pair it describes. */
function convertToMomentAction(
  entry: DiffEntry,
  beforePuzzle: Puzzle,
  afterPuzzle: Puzzle,
): PrimaryChange | null {
  const ids = entry.actionIds;
  if (ids.length === 0) return null;
  const first = ids[0]!;
  const origId = isGeneratedId(first) ? baseActionId(first) : first;
  const before = actionById(beforePuzzle, origId);
  if (!before) return null;
  const afterActions = ids.map((id) => actionById(afterPuzzle, id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  if (afterActions.length === 0) return null;
  // `convertAction` orders a chain's steps by `__step<i>`; sort defensively so
  // display order matches play order even if the diff array ever did not.
  afterActions.sort((a, b) => {
    const sa = generatedStep(a.id)?.step ?? 0;
    const sb = generatedStep(b.id)?.step ?? 0;
    return sa - sb;
  });
  return {
    before: {
      actionIds: [before.id],
      label: actionTitle(before),
      steps: 1,
      optionsPerStep: before.options ?? 1,
    },
    after: {
      actionIds: afterActions.map((a) => a.id),
      label: actionTitle(before),
      steps: afterActions.length,
      optionsPerStep: afterActions[0]?.options ?? 1,
    },
  };
}

/**
 * Build the rebuild moment's data from an applied switch record.
 *
 * Returns null for a record that never produced a repaired puzzle (a
 * refusal): refusals get their own honest screen, not this one.
 */
export function buildRebuildMoment(record: SwitchRecord): RebuildMoment | null {
  if (record.kind !== "ok" || !record.puzzle) return null;
  const afterPuzzle = record.puzzle;
  const beforePuzzle = record.beforePuzzle;

  const convertEntries = record.diff.filter((e) => e.op === "convert");
  const reassignEntries = record.diff.filter((e) => e.op === "reassign");
  const handoffEntries = record.diff.filter((e) => e.op === "handoff");

  const changes = convertEntries
    .map((entry) => ({ entry, change: convertToMomentAction(entry, beforePuzzle, afterPuzzle) }))
    .filter((x): x is { entry: DiffEntry; change: PrimaryChange } => x.change !== null);

  // The most dramatic change (most steps added) leads the sequence; every
  // other convert becomes one honest summary line.
  changes.sort((a, b) => b.change.after.steps - a.change.after.steps);
  const primaryEntry = changes[0] ?? null;
  const secondary: string[] = [];
  for (const { change } of changes.slice(1)) {
    secondary.push(
      `${change.before.label} also uses ${shortCapabilityPhrase(CAPABILITY_LABEL[record.to[0] ?? "scan"] ?? record.to.join(" + "))}.`,
    );
  }
  for (const entry of reassignEntries) {
    secondary.push(entry.summary);
  }
  for (const entry of handoffEntries) {
    secondary.push(entry.summary);
  }

  const reassignedAway = reassignEntries.find((e) => e.roleIds[0] === record.role);
  const ownershipRetained = !reassignedAway;
  const newOwner = reassignedAway ? ROLE_LABEL[reassignedAway.roleIds[1] ?? ""] ?? reassignedAway.roleIds[1] ?? null : null;

  const noOpChange = record.diff.length <= 1;

  return {
    role: ROLE_LABEL[record.role] ?? record.role,
    toCapabilityLabel: record.to.map((c) => CAPABILITY_LABEL[c] ?? c).join(" + ") || "no input",
    primary: primaryEntry?.change ?? null,
    secondary,
    ownershipRetained,
    newOwner,
    noOpChange,
  };
}

/**
 * The payoff headline: conditional on ownership actually being retained --
 * "Still your move" is conditional on retained ownership, not a universal
 * success slogan.
 */
export function rebuildHeadline(moment: RebuildMoment): string {
  if (moment.noOpChange) return "Your new controls already fit.";
  if (moment.ownershipRetained) {
    return `${shortCapabilityPhrase(moment.toCapabilityLabel, true)}. Still your move.`;
  }
  return moment.newOwner ? `That action now belongs to ${moment.newOwner}.` : `${moment.role}'s part changed.`;
}

/**
 * "one-button scan" reads naturally as "one button" in a short sentence
 * ("C now plays with one button.") -- this app's own copy for that case.
 * Every other capability label is used as-is.
 */
export function shortCapabilityPhrase(label: string, capitalize = false): string {
  const phrase = label === "one-button scan" ? "one button" : label;
  return capitalize ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
}
