/**
 * The painted plates, and the rule that decides which one a room is showing.
 *
 * A plate is *not* decoration chosen by a screen: it is a claim about the
 * world, gated on the same facts the validator reasons over. `study-safe-open`
 * is on screen when `safe_open` is in `State.flags` and for no other reason, so
 * a plate can never show a room in a state the team has not actually reached.
 * That is the whole design: the art is a second, wordless read-out of the same
 * state the log and the certificate report, and it cannot disagree with them.
 *
 * Gating is by flag and token id rather than by action id because a flag is
 * what an action *achieves*. The recompiler may split one authored action into
 * a `§` chain of several, and the rebuilt chain sets the same flags -- so a
 * plate keyed on a flag survives a recompile, where a plate keyed on an action
 * id would go dark exactly when the game is making its point.
 *
 * Generated mysteries invent their own flag names and therefore match nothing
 * here. That is the intended outcome, not a gap: `plateFor` returns `null` and
 * the screen renders its painted-free layout. A missing plate must never be a
 * missing room.
 */

/** A plate and the facts that have to hold for it to be the room on screen. */
export interface Plate {
  /** File stem under `/art/`, and the plate's id. */
  readonly id: string;
  /** Every one of these flags must be held. */
  readonly flags: readonly string[];
  /** Every one of these tokens must be held. */
  readonly tokens: readonly string[];
  /**
   * True when the plate belongs to the ending surface only. The goal flag is
   * held for the last beat of play as well as for the report, and the ending
   * plate should not pre-empt the moment it is the reward for.
   */
  readonly ending: boolean;
  /** What a screen reader is told, since a plate carries real information. */
  readonly alt: string;
}

/**
 * Plates per mystery, ordered from the empty room forward. `plateFor` takes the
 * LAST entry whose facts all hold, so a later plate always wins over an earlier
 * one and the table reads as a timeline.
 */
export const PLATES: Readonly<Record<string, readonly Plate[]>> = {
  "the-locked-study": [
    {
      id: "study-room",
      flags: [],
      tokens: [],
      ending: false,
      alt: "The locked study from the hallway: a shut door, a painting hung straight, a writing desk.",
    },
    {
      id: "study-revealed",
      flags: ["painting_moved"],
      tokens: [],
      ending: false,
      alt: "The painting has been swung aside on its hinge, uncovering a closed wall safe with a brass dial.",
    },
    {
      id: "study-safe-open",
      flags: ["safe_open"],
      tokens: [],
      ending: false,
      alt: "The wall safe behind the painting stands open, a key on its shelf; the study door is still shut.",
    },
    {
      id: "study-open",
      flags: ["study_unlocked"],
      tokens: [],
      ending: true,
      alt: "The safe stands open and the study door is ajar, warm lamplight falling through it onto the floor.",
    },
  ],
  "the-midnight-bakery": [
    {
      id: "bakery-room",
      flags: [],
      tokens: [],
      ending: false,
      alt: "A dark bakery before the shift: cold oven, scale, a sack of flour, the night outside.",
    },
    {
      id: "bakery-loaded",
      flags: ["loaf_in"],
      tokens: [],
      ending: false,
      alt: "The oven is lit and loaded, the loaf inside, the dial set.",
    },
    {
      id: "bakery-ready",
      flags: ["bakery_ready"],
      tokens: [],
      ending: true,
      alt: "The bake is done: a finished loaf out on the bench, the bakery warm.",
    },
  ],
  "the-treehouse": [
    {
      id: "treehouse-yard",
      flags: [],
      tokens: [],
      ending: false,
      alt: "A back yard at dusk: a big tree, a heap of uncut planks, a coil of rope.",
    },
    {
      id: "treehouse-cut",
      flags: [],
      tokens: ["cut_planks"],
      ending: false,
      alt: "The planks are cut to length and stacked square beside the tree.",
    },
    {
      id: "treehouse-rigged",
      flags: ["rope_rigged"],
      tokens: [],
      ending: false,
      alt: "The rope is rigged over the branch and knotted to the stacked planks.",
    },
    {
      id: "treehouse-up",
      flags: ["platform_up"],
      tokens: [],
      ending: true,
      alt: "The platform is up in the tree, level and roped off, the yard below it.",
    },
  ],
};

/** The facts a plate is chosen against. Structural, so any state shape fits. */
export interface PlateFacts {
  readonly flags: readonly string[];
  readonly tokens: readonly string[];
}

/**
 * The plate a mystery is showing, or `null` when it has no art -- which is the
 * normal case for a generated mystery and must never be treated as an error.
 *
 * `surface` says which screen is asking. The ending plate is reachable only
 * from `"ending"`; every other surface stops at the last non-ending plate whose
 * facts hold.
 */
export function plateFor(
  mysteryId: string,
  facts: PlateFacts,
  surface: "play" | "ending" = "play",
): Plate | null {
  const table = PLATES[mysteryId];
  if (!table) return null;

  const flags = new Set(facts.flags);
  const tokens = new Set(facts.tokens);

  let chosen: Plate | null = null;
  for (const plate of table) {
    if (plate.ending && surface !== "ending") continue;
    if (!plate.flags.every((f) => flags.has(f))) continue;
    if (!plate.tokens.every((t) => tokens.has(t))) continue;
    chosen = plate;
  }
  return chosen;
}

/** Where the bundle serves a plate from. `base: "./"` keeps this path-relative. */
export function plateSrc(plate: Plate): string {
  return `art/${plate.id}.webp`;
}

/** Every plate id in the catalogue, for the size and reachability tests. */
export function allPlates(): readonly Plate[] {
  return Object.values(PLATES).flat();
}
