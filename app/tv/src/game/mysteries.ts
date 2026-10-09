/**
 * The mysteries the TV can host.
 *
 * A mystery is *data*, not code: a `Puzzle` in exactly the grammar the frozen
 * validator speaks (see `validator/README.md`), plus the few strings the screen
 * needs that the model does not carry (a title, a subtitle, the opening log
 * line). Nothing here widens the grammar and nothing here re-implements the
 * proof -- every claim a mystery makes is made by `certify`, and
 * `test/mysteries.test.ts` holds every mystery in this catalogue to the same
 * table.
 *
 * The demo -- "The Locked Study" -- is imported from the validator rather than
 * copied, so there is exactly one definition of it and its certificate hashes
 * cannot drift. The other two are authored here because the validator package
 * owns the model, not the content.
 *
 * All three share one primitive set, so the recompiler's operator space is the
 * same for each and a difference in whether a repair exists is a difference in
 * the mystery, never in the tools available to repair it.
 */
import {
  type Capability,
  type Puzzle,
  type RoleId,
  DEMO_PRIMITIVES,
  demoPuzzle,
} from "../../../../validator/src/api.ts";
import { ROLE_IDS, type RoleId as WireRoleId } from "../../../shared/protocol.ts";
import { GENERATED_MYSTERIES } from "./generated.ts";

export interface Mystery {
  id: string;
  title: string;
  subtitle: string;
  /** The roles this mystery seats, in the order the lobby should show them. */
  roles: WireRoleId[];
  /** The line the TV opens with, before anyone has done anything. */
  opening: string;
  build: () => Puzzle;
  /** The input change the mystery's own story is about. */
  headline: { role: WireRoleId; capabilities: Capability[] };
  /**
   * True for a mystery the generator produced, rather than hand-authored.
   * The lobby labels it as such -- a shipped
   * feature nobody can tell apart from the hand-written three would be a
   * different kind of dishonesty than not shipping it at all.
   */
  generated?: boolean;
}

/* ------------------------------------------------------------------ */
/* The Locked Study -- the demo, unchanged                             */
/* ------------------------------------------------------------------ */

const LOCKED_STUDY: Mystery = {
  id: "the-locked-study",
  title: "The Locked Study",
  // Rephrased from "Everyone is essential" -- a present-tense
  // claim the empty lobby rendered with nobody seated -- to a claim about the
  // mystery's own design, same framing as the other two subtitles below.
  subtitle: "A couch mystery for three, designed so everyone is essential — and the puzzle can prove it.",
  roles: ["A", "B", "C"],
  opening: "The study door is locked. Three people, three ways in.",
  build: demoPuzzle,
  headline: { role: "C", capabilities: ["scan"] },
};

/* ------------------------------------------------------------------ */
/* The Midnight Bakery -- a second three-role mystery                  */
/* ------------------------------------------------------------------ */

/**
 * Every role is fed by both of the others.
 *
 * A has the recipe; C has the flour delivery note; B holds the sack label, the
 * oven dial setting and the starter-jar note -- a 1/3/1 split of private
 * knowledge. The three chains are mutually entangled and close a cycle:
 *
 *   C -> A   C's `flour_brand` is what lets A weigh the flour at all.
 *   A -> B   A's `weighed_flour` is what makes B's sack label mean anything.
 *   B -> C   B's `proof_time` is a prerequisite of C proving the dough.
 *   B -> A   B's `flour_grade` gates A loading the oven.
 *   A -> B   A's `loaf_in` flag is what B times the bake against.
 *   C -> A   C's `proved_dough` is what A loads.
 *
 * The ending is an interlock shape: `c_open_oven` is C's action, and
 * it cannot fire until A has both loaded the oven (`loaf_in`) and B has both
 * set the dial (`oven_set`) and timed the bake (`bake_timed`). Two roles must
 * act before the third can finish, where "The Locked Study" ends on a single
 * shared action any role could take.
 *
 * There is no source role: in the study, A only ever feeds other people and is
 * fed by nobody, while here every role strictly depends on both others, so the
 * dependence graph is strongly connected rather than a diamond.
 */
function midnightBakery(): Puzzle {
  return {
    id: "the-midnight-bakery",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["recipe_card"] },
      {
        id: "B",
        capabilities: ["voice"],
        privateTokens: ["flour_sack_label", "oven_dial_setting", "starter_jar_note"],
      },
      { id: "C", capabilities: ["dpad"], privateTokens: ["delivery_note"] },
    ],
    primitives: DEMO_PRIMITIVES.map((p) => ({ ...p })),
    goalFlags: ["bakery_ready"],
    actions: [
      {
        id: "a_read_recipe",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["recipe_card"],
        requiresFlags: [],
        producesTokens: ["dough_recipe"],
        setsFlags: [],
        label: "read the recipe card taped inside the cupboard",
      },
      {
        id: "c_read_delivery_note",
        performer: "C",
        needs: "dpad",
        requiresTokens: ["delivery_note"],
        requiresFlags: [],
        producesTokens: ["flour_brand"],
        setsFlags: [],
        label: "read the delivery note on the flour pallet",
      },
      {
        id: "a_weigh_flour",
        performer: "A",
        needs: "dpad",
        // A cannot pick the right sack without C's delivery note, and the
        // recipe only says how much, not which.
        requiresTokens: ["dough_recipe", "flour_brand"],
        requiresFlags: [],
        producesTokens: ["weighed_flour"],
        setsFlags: [],
        options: 4,
        answerToken: "flour_brand",
        label: "weigh out the flour (4 brands on the pallet)",
      },
      {
        id: "b_read_flour_label",
        performer: "B",
        needs: "voice",
        // B's own sack label means nothing until A has put flour on the scale.
        requiresTokens: ["flour_sack_label", "weighed_flour"],
        requiresFlags: [],
        producesTokens: ["flour_grade"],
        setsFlags: [],
        label: "read the grade off the sack label",
      },
      {
        id: "b_announce_proof",
        performer: "B",
        needs: "voice",
        requiresTokens: ["starter_jar_note"],
        requiresFlags: [],
        producesTokens: ["proof_time"],
        setsFlags: [],
        label: "say how long the starter needs to proof",
      },
      {
        id: "c_proof_dough",
        performer: "C",
        needs: "dpad",
        // C needs A's recipe for the dough and B's spoken proofing time.
        requiresTokens: ["dough_recipe", "proof_time"],
        requiresFlags: [],
        producesTokens: ["proved_dough"],
        setsFlags: [],
        options: 4,
        answerToken: "proof_time",
        label: "leave the dough to proof (4 resting spots)",
      },
      {
        id: "b_set_oven_dial",
        performer: "B",
        needs: "voice",
        requiresTokens: ["oven_dial_setting", "flour_grade"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["oven_set"],
        options: 4,
        answerToken: "flour_grade",
        label: "set the oven dial (4 marks on the dial)",
      },
      {
        id: "a_load_oven",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["proved_dough", "flour_grade"],
        requiresFlags: ["oven_set"],
        producesTokens: [],
        setsFlags: ["loaf_in"],
        label: "slide the proved dough into the oven",
      },
      {
        id: "b_time_the_bake",
        performer: "B",
        needs: "voice",
        requiresTokens: ["oven_dial_setting"],
        requiresFlags: ["loaf_in"],
        producesTokens: [],
        setsFlags: ["bake_timed"],
        label: "count the bake down out loud",
      },
      {
        id: "c_open_oven",
        performer: "C",
        needs: "dpad",
        // The interlock: A's loaf and B's timing must both already be in hand.
        requiresTokens: ["proved_dough", "flour_brand"],
        requiresFlags: ["loaf_in", "bake_timed"],
        producesTokens: [],
        setsFlags: ["bakery_ready"],
        label: "open the oven and bring out the morning loaf",
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* The Treehouse -- the two-player mystery                             */
/* ------------------------------------------------------------------ */

/**
 * Two people, and neither is optional.
 *
 * A has the plank note, B has the rope code and the nail-tin label: a 1/2
 * split. The dependence is a plain two-cycle, and it is tight in both
 * directions --
 *
 *   B -> A   B's `nail_size` is needed to cut the planks, and B's
 *            `rope_length` is needed to rig them.
 *   A -> B   A's `plank_count` and A's `rope_rigged` flag are both needed
 *            before B can haul the platform up.
 *
 * The study assumes three; this shows the claim is not an artefact of that
 * number. It is also the household the game is most likely to meet: one parent
 * and one child, two phones, no third person to wait for.
 */
function treehouse(): Puzzle {
  return {
    id: "the-treehouse",
    roles: [
      { id: "A", capabilities: ["dpad"], privateTokens: ["plank_note"] },
      { id: "B", capabilities: ["voice"], privateTokens: ["rope_code", "nail_tin_label"] },
    ],
    primitives: DEMO_PRIMITIVES.map((p) => ({ ...p })),
    goalFlags: ["platform_up"],
    actions: [
      {
        id: "a_read_plank_note",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["plank_note"],
        requiresFlags: [],
        producesTokens: ["plank_count"],
        setsFlags: [],
        label: "read the note about how many planks are left",
      },
      {
        id: "b_read_nail_label",
        performer: "B",
        needs: "voice",
        requiresTokens: ["nail_tin_label"],
        requiresFlags: [],
        producesTokens: ["nail_size"],
        setsFlags: [],
        label: "read the nail size off the tin",
      },
      {
        id: "a_cut_planks",
        performer: "A",
        needs: "dpad",
        // A knows how many planks, but only B can say what size to cut them.
        requiresTokens: ["plank_count", "nail_size"],
        requiresFlags: [],
        producesTokens: ["cut_planks"],
        setsFlags: [],
        options: 4,
        answerToken: "nail_size",
        label: "cut the planks to length (4 lengths marked)",
      },
      {
        id: "b_call_the_code",
        performer: "B",
        needs: "voice",
        requiresTokens: ["rope_code"],
        requiresFlags: [],
        producesTokens: ["rope_length"],
        setsFlags: [],
        label: "call out the rope code",
      },
      {
        id: "a_tie_the_rope",
        performer: "A",
        needs: "dpad",
        requiresTokens: ["cut_planks", "rope_length"],
        requiresFlags: [],
        producesTokens: [],
        setsFlags: ["rope_rigged"],
        options: 4,
        answerToken: "rope_length",
        label: "rig the rope (4 knots, only one holds)",
      },
      {
        id: "b_haul_the_rope",
        performer: "B",
        needs: "voice",
        // A's plank count and A's rigged rope, both, before the platform moves.
        requiresTokens: ["plank_count", "rope_length"],
        requiresFlags: ["rope_rigged"],
        producesTokens: [],
        setsFlags: ["platform_up"],
        options: 4,
        answerToken: "plank_count",
        label: "haul the platform up (4 counts to pull on)",
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

export const MYSTERIES: readonly Mystery[] = [LOCKED_STUDY, {
  id: "the-midnight-bakery",
  title: "The Midnight Bakery",
  subtitle: "A couch mystery for three, and no role is a spare pair of hands.",
  roles: ["A", "B", "C"],
  opening: "The shop opens at dawn. Three people, and the oven is cold.",
  build: midnightBakery,
  headline: { role: "C", capabilities: ["scan"] },
}, {
  id: "the-treehouse",
  title: "The Treehouse",
  subtitle: "A couch mystery for two — one grown-up, one child, no third needed.",
  roles: ["A", "B"],
  opening: "The platform is on the ground. Two people, and it takes both.",
  build: treehouse,
  headline: { role: "A", capabilities: ["scan"] },
}, {
  ...GENERATED_MYSTERIES[0]!,
  generated: true,
}];

export const DEFAULT_MYSTERY_ID = LOCKED_STUDY.id;

export function mysteryById(id: string): Mystery | undefined {
  return MYSTERIES.find((m) => m.id === id);
}

/** The mystery with this id, or the default. Never throws on a stale id. */
export function mysteryOrDefault(id: string | null | undefined): Mystery {
  return (id ? mysteryById(id) : undefined) ?? MYSTERIES[0]!;
}

/**
 * The roles a puzzle seats, narrowed to the ones the wire protocol knows.
 *
 * The protocol's `ROLE_IDS` is a fixed vocabulary (`A`, `B`, `C`); a mystery
 * picks a subset of it rather than inventing names, so a two-player mystery
 * seats A and B and the relay, the seat picker and the phone need no changes.
 */
export function seatRoles(puzzle: Puzzle): WireRoleId[] {
  const seated = new Set(puzzle.roles.map((r) => r.id));
  return ROLE_IDS.filter((role) => seated.has(role));
}

/** A puzzle's role ids in puzzle order, for callers that want the model's own order. */
export function puzzleRoleIds(puzzle: Puzzle): RoleId[] {
  return puzzle.roles.map((r) => r.id);
}
