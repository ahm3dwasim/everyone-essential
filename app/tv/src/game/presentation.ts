/**
 * Words for the model.
 *
 * The validator knows ids; the screen needs English. Every table here maps an
 * id the puzzle uses to a line a person can read, and every lookup falls back to
 * the raw id rather than inventing something. `actionTitle` prefers the action's
 * own `label` -- the puzzle authors those -- so a new action shows up on the TV
 * without anyone editing this file.
 *
 * The one place the model gives us less than the screen wants is option labels:
 * an action carries `options: 4` and no names for the four. For an action whose
 * `options` count matches a hand-written list, the list is used. For a step of a
 * chain the recompiler invented (the reserved `§` namespace), the count is all
 * we have, so the options are numbered and labelled with which step they belong
 * to. Nothing is guessed about what the underlying alternative *was*.
 */
import type { Action, Capability, Puzzle, RoleId, State } from "./validator.ts";
import { RESERVED_PREFIX } from "./validator.ts";

export const ROLE_LABEL: Record<RoleId, string> = {
  A: "A",
  B: "B",
  C: "C",
};

/**
 * What a role is for, in the words of the mystery being played.
 *
 * Keyed by puzzle id, because the same seat means something different in each
 * mystery -- A holds the painting hint in the study and the recipe card in the
 * bakery. A puzzle with no entry falls back to the study's wording, which is
 * the only one that has ever been on screen.
 */
const ROLE_BLURB_BY_MYSTERY: Record<string, Record<RoleId, string>> = {
  "the-locked-study": {
    A: "holds the hint about the painting",
    B: "reads the code aloud",
    C: "matches the dial against the drawer note",
  },
  "the-midnight-bakery": {
    A: "holds the recipe card",
    B: "reads the sack, the dial and the starter jar",
    C: "holds the delivery note",
  },
  "the-treehouse": {
    A: "holds the note about the planks",
    B: "holds the rope code and the nail tin",
    C: "",
  },
  // The Dark Lighthouse -- generated, and in the lobby. Without an entry
  // here every role would fall back to the study's own blurbs, which name
  // the wrong objects entirely.
  "the-lighthouse-braid-7": {
    A: "holds the torn log page",
    B: "holds the foghorn pattern",
    C: "holds the oil drum label",
  },
};

/** The study's blurbs, for a puzzle id this table has never heard of. */
export const ROLE_BLURB: Record<RoleId, string> = ROLE_BLURB_BY_MYSTERY["the-locked-study"]!;

export function roleBlurb(puzzleId: string, role: RoleId): string {
  return ROLE_BLURB_BY_MYSTERY[puzzleId]?.[role] ?? ROLE_BLURB[role] ?? "";
}

/**
 * The ending's own headline, per mystery -- triggered from the mystery's goal
 * flag, never a universal "The study is open.": every mystery names its own
 * room and ending, because a screen that contradicts the selected story
 * cannot feel real.
 */
const ENDING_TITLE_BY_MYSTERY: Record<string, string> = {
  "the-locked-study": "The study is open.",
  "the-midnight-bakery": "The morning loaf is ready.",
  "the-treehouse": "The platform is up.",
  "the-lighthouse-braid-7": "The lamp is lit.",
};

export function endingTitle(puzzleId: string): string {
  return ENDING_TITLE_BY_MYSTERY[puzzleId] ?? "The puzzle is solved.";
}

/**
 * The four refusal kinds, kept visibly different: a capped search, a bad
 * request, a compiler bug and "nothing in the bounded operator space works"
 * must never collapse into one sentence.
 */
export type RefusalKind = "no_valid_recompile" | "search_exhausted" | "invalid_input" | "operator_error";

export interface RefusalCopy {
  heading: string;
  body: string;
  action: string;
}

const REFUSAL_COPY: Record<RefusalKind, RefusalCopy> = {
  no_valid_recompile: {
    heading: "This puzzle has no supported change for those controls.",
    body: "We checked the changes this game supports. None kept a way to finish with every role needed.",
    action: "Choose different controls",
  },
  search_exhausted: {
    heading: "We couldn't finish checking this change.",
    body: "The check reached its limit. We don't yet know whether these controls can work.",
    action: "Choose different controls",
  },
  invalid_input: {
    heading: "We couldn't read this change request.",
    body: "The request or game data wasn't valid, so the check did not run.",
    action: "Choose controls again",
  },
  operator_error: {
    heading: "The game hit an error while making this change.",
    body: "Something went wrong in the game. We couldn't complete the check.",
    action: "Back to the game",
  },
};

export function refusalCopy(kind: RefusalKind): RefusalCopy {
  return REFUSAL_COPY[kind];
}

export const CAPABILITY_LABEL: Record<Capability, string> = {
  dpad: "TV remote",
  scan: "one-button scan",
  voice: "voice",
};

/** Private tokens, in the holder's own words. */
const CLUE_TEXT: Record<string, string> = {
  painting_hint: "The painting is hinged on the left — it swings toward the window.",
  code_digit_1: "First digit of the safe code: it points to the middle row of the grid.",
  code_digit_2: "Second digit of the safe code: it points to the middle column of the grid.",
  desk_drawer_note: "The dial only turns for one family: the river.",
  // The Midnight Bakery
  recipe_card: "The card says the loaf wants a long, cool proof — not a quick one.",
  flour_sack_label:
    "Your sack is stamped with a grade — the third mark on the dial matches it — but the grade only means something once it is on the scale.",
  oven_dial_setting: "The dial has four marks, and the shop's oven has only ever liked one of them.",
  starter_jar_note: "The jar note says the starter needs a long, cool proof — leave it on the cold shelf.",
  delivery_note:
    "Four brands came off the pallet, and the note names the one the shop actually ordered — the river brand.",
  // The Treehouse
  plank_note: "The note counts what is left in the pile — there are more planks than you would guess: three pulls will do it.",
  rope_code: "The rope is marked in four lengths, and one of them reaches the branch — tie the bowline, it will hold.",
  nail_tin_label:
    "The tin is labelled with one nail size — the middle length matches it — and the planks have to be cut to match it.",
  // The Dark Lighthouse (generated)
  keeper_log_page: "The torn page from the keeper's log.",
  foghorn_pattern: "The foghorn pattern chalked by the door.",
  oil_drum_label: "The label on the oil drum.",
};

/** Facts the whole team can see once someone says them out loud. */
const TOKEN_TEXT: Record<string, string> = {
  safe_location: "where the safe is",
  safe_code: "the two code digits",
  symbol_names: "the nine symbol names",
  dial_rule: "the rule from the drawer note",
  dial_symbol: "the chosen symbol family",
  study_key: "the study key",
  // The Midnight Bakery
  dough_recipe: "the recipe",
  flour_brand: "the brand the shop ordered",
  weighed_flour: "the flour, weighed out",
  flour_grade: "the flour's grade",
  proof_time: "how long the dough needs",
  proved_dough: "the proved dough",
  // The Treehouse
  plank_count: "how many planks are left",
  nail_size: "the nail size",
  cut_planks: "the planks, cut to length",
  rope_length: "the rope length",
};

const FLAG_TEXT: Record<string, string> = {
  painting_moved: "the painting is aside",
  safe_open: "the safe is open",
  tumblers_heard: "the tumblers have settled",
  study_unlocked: "the study is unlocked",
  // The Midnight Bakery
  oven_set: "the oven is set",
  loaf_in: "the loaf is in the oven",
  bake_timed: "the bake is timed",
  bakery_ready: "the morning loaf is out",
  // The Treehouse
  rope_rigged: "the rope is rigged",
  platform_up: "the platform is up",
};

const OPTION_TEXT: Record<string, string[]> = {
  a_shift_painting: [
    "lift the left edge",
    "lift the right edge",
    "tilt the top edge",
    "swing it inward",
  ],
  c_match_symbol: ["the sun family", "the river family", "the tower family", "the eye family"],
  c_dial_safe: [
    "top left",
    "top middle",
    "top right",
    "middle left",
    "the centre",
    "middle right",
    "bottom left",
    "bottom middle",
    "bottom right",
  ],
  // The Midnight Bakery
  a_weigh_flour: ["the mill brand", "the river brand", "the hill brand", "the harbour brand"],
  c_proof_dough: ["the cold shelf", "the warm shelf", "by the window", "next to the oven"],
  b_set_oven_dial: ["the first mark", "the second mark", "the third mark", "the fourth mark"],
  // The Treehouse
  a_cut_planks: ["the short length", "the middle length", "the long length", "the longest length"],
  a_tie_the_rope: ["the slip knot", "the reef knot", "the figure-eight", "the bowline"],
  b_haul_the_rope: ["one pull", "two pulls", "three pulls", "four pulls"],
};

/**
 * Which of an action's options is the one its answer token actually points to.
 *
 * The validator's model does not carry this -- `options: n` only says how many
 * alternatives there are, and `answerToken` only gates whether the action can
 * fire at all (see `validator/README.md`). Telling alternatives apart is a
 * property of the *fiction*, so it lives here, keyed to the hand-authored
 * option list above rather than to the validator's grammar. A generated or
 * chain-split action has no fictional option list to be right or wrong about,
 * so `correctOptionIndex` falls back to 0 for those -- deterministic, and
 * `wrongChoice` in the reducer still refuses every other index.
 */
const CORRECT_OPTION: Record<string, number> = {
  a_shift_painting: 0, // "lift the left edge" -- painting_hint says hinged left
  c_match_symbol: 1, // "the river family" -- desk_drawer_note names the river
  c_dial_safe: 4, // "the centre" -- middle row, middle column
  a_weigh_flour: 1, // "the river brand" -- delivery_note names it
  c_proof_dough: 0, // "the cold shelf" -- starter_jar_note names it
  b_set_oven_dial: 2, // "the third mark" -- flour_sack_label names it
  a_cut_planks: 1, // "the middle length" -- nail_tin_label names it
  a_tie_the_rope: 3, // "the bowline" -- rope_code names it
  b_haul_the_rope: 2, // "three pulls" -- plank_note names it
};

/** What the TV says, in the fiction, when the wrong option was tried. */
const WRONG_ATTEMPT_TEXT: Record<string, string> = {
  a_shift_painting: "the frame does not lift that way",
  c_match_symbol: "the dial will not turn for that family",
  c_dial_safe: "the tumblers do not catch on that number",
  a_weigh_flour: "that is not the brand on the note",
  c_proof_dough: "the dough will not prove there",
  b_set_oven_dial: "the oven does not answer to that mark",
  a_cut_planks: "the plank comes out the wrong size",
  a_tie_the_rope: "the knot slips",
  b_haul_the_rope: "the rope does not move that way",
};

/**
 * The one correct alternative for a choice action, by the app's own fiction --
 * not by the validator, which does not distinguish them (see the README's "a
 * wrong choice is a no-op"). Every other index is wrong. Options whose count
 * does not match a hand-authored list (a generated action, or a chain the
 * recompiler split) have no fiction to be right about, so index 0 is the fixed,
 * documented answer for those.
 */
export function correctOptionIndex(action: Action): number {
  const base = baseActionId(action.id);
  const count = action.options ?? 1;
  const table = OPTION_TEXT[base];
  if (table && table.length === count) return CORRECT_OPTION[base] ?? 0;
  return 0;
}

/** What the TV says when a wrong option was tried: fiction first, never a rule number. */
export function wrongAttemptText(action: Action): string {
  const base = baseActionId(action.id);
  return WRONG_ATTEMPT_TEXT[base] ?? "that is not it";
}

export function isGeneratedId(id: string): boolean {
  return id.startsWith(RESERVED_PREFIX);
}

/** `§c_dial_safe__step2` -> `c_dial_safe`. Deterministic, no guessing. */
export function baseActionId(id: string): string {
  if (!isGeneratedId(id)) return id;
  const cut = id.indexOf("__");
  return cut < 0 ? id.slice(RESERVED_PREFIX.length) : id.slice(RESERVED_PREFIX.length, cut);
}

/** `§c_dial_safe__step2` -> 2. Null when the id is not a generated step. */
export function generatedStep(id: string): { step: number; of: number | null } | null {
  const match = /__step(\d+)$/.exec(id);
  if (!match) return null;
  return { step: Number(match[1]), of: null };
}

export function actionTitle(action: Action): string {
  if (action.label) return action.label;
  if (isGeneratedId(action.id)) {
    const base = baseActionId(action.id);
    return base.replace(/_/g, " ");
  }
  return action.id.replace(/_/g, " ");
}

/**
 * Labels for the alternatives an action presents. Returns exactly `options`
 * strings, or an empty list when the action is not a choice.
 */
export function optionLabels(action: Action, puzzle: Puzzle): string[] {
  const count = action.options ?? 1;
  if (count <= 1) return [];
  const base = baseActionId(action.id);
  const table = OPTION_TEXT[base];
  if (table && table.length === count) return [...table];
  if (isGeneratedId(action.id)) {
    const info = generatedStep(action.id);
    const total = puzzle.actions.filter((a) => isGeneratedId(a.id) && baseActionId(a.id) === base).length;
    const stepOf = info && total > 0 ? `step ${info.step} of ${total}` : "this step";
    return Array.from({ length: count }, (_, i) => `choice ${i + 1} of ${count} (${stepOf})`);
  }
  return Array.from({ length: count }, (_, i) => `choice ${i + 1} of ${count}`);
}

export function clueText(tokenId: string): string {
  return CLUE_TEXT[tokenId] ?? tokenId.replace(/_/g, " ");
}

export function factText(tokenId: string): string {
  return TOKEN_TEXT[tokenId] ?? tokenId.replace(/_/g, " ");
}

export function flagText(flagId: string): string {
  return FLAG_TEXT[flagId] ?? flagId.replace(/_/g, " ");
}

/** The facts the team has, as one line each, for the shared clue board. */
export function factLine(id: string, state: State): string {
  return state.flags.includes(id) ? flagText(id) : factText(id);
}
