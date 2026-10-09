/**
 * The local proposer: a mystery composed from a library, with no network.
 *
 * This stands in for a model. It is deliberately *not* a puzzle solver that
 * works backwards from "what would pass the gate" -- it composes forward from
 * two independent libraries and hands the result over unexamined, exactly as a
 * language model would:
 *
 *   a THEME   supplies the fiction: place, title, the clues each seat holds,
 *             the wording of each action, the goal.
 *   a SHAPE   supplies the dependency skeleton: who needs whose output before
 *             they can act, and which action ends the story.
 *
 * The two are drawn independently, and some of the shapes in the library are
 * *wrong on purpose*. A generator that only ever emitted certifiable puzzles
 * would make the gate decorative, and the rejection ledger -- the number this
 * module exists to produce -- would be empty. The flaws are the kind a generator
 * actually makes: a clue that turns out to be convenient rather than required,
 * a choice with no answer token, a goal nothing sets. Naming them here, in the
 * library, is what lets the ledger say *which* mistake the compiler caught.
 *
 * Determinism: every draw comes from a seeded PRNG, and the output is plain
 * data, so the same seed produces byte-identical JSON (asserted in
 * `test/gen-local.test.ts` against `canonicalStringify`).
 */
import { canonicalStringify, type Capability, type Puzzle, type RoleId } from "../../../validator/src/api.ts";
import {
  seatCapabilities,
  seatIds,
  type ProposeResult,
  type ProposeSpec,
  type ProposedMystery,
  type PuzzleProposer,
} from "./proposer.ts";

/* ------------------------------------------------------------------ */
/* A seeded PRNG, so "the same seed" means the same bytes              */
/* ------------------------------------------------------------------ */

/** mulberry32. Small, fast, and exactly reproducible across engines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Draw {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  /** An integer in [0, bound). */
  int(bound: number): number {
    return Math.min(bound - 1, Math.floor(this.next() * bound));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
}

/* ------------------------------------------------------------------ */
/* The fiction library                                                 */
/* ------------------------------------------------------------------ */

interface ThemeSeat {
  /** Private clues this seat holds. At least two, so a shape can ask for two. */
  clues: readonly { id: string; label: string }[];
  /** Action wording, consumed in order by whichever shape is drawn. */
  acts: readonly string[];
}

interface Theme {
  id: string;
  title: string;
  subtitle: string;
  opening: string;
  goal: { flag: string; label: string };
  /** One entry per seat, in seat order (A, B, C). */
  seats: readonly ThemeSeat[];
}

const THEMES: readonly Theme[] = [
  {
    id: "lighthouse",
    title: "The Dark Lighthouse",
    subtitle: "A couch mystery, and the lamp stays out until everyone has spoken.",
    opening: "The lamp went out at dusk. The stair is dark and the log book is missing.",
    goal: { flag: "lamp_lit", label: "light the lamp and bring the beam back round" },
    seats: [
      {
        clues: [
          { id: "keeper_log_page", label: "the torn page from the keeper's log" },
          { id: "brass_key_tag", label: "the tag on the brass key" },
        ],
        acts: ["read the torn log page", "fit the lens into its cradle", "wind the lamp mechanism"],
      },
      {
        clues: [
          { id: "foghorn_pattern", label: "the foghorn pattern chalked by the door" },
          { id: "tide_table", label: "the tide table pinned above the sink" },
        ],
        acts: ["call out the foghorn pattern", "read the tide table aloud", "count the turns on the winch"],
      },
      {
        clues: [
          { id: "oil_drum_label", label: "the label on the oil drum" },
          { id: "spare_wick_note", label: "the note wrapped round the spare wick" },
        ],
        acts: ["read the oil drum label", "trim the spare wick", "set the burner collar"],
      },
    ],
  },
  {
    id: "observatory",
    title: "The Closed Observatory",
    subtitle: "A couch mystery, and the dome stays shut until the numbers agree.",
    opening: "The dome is jammed and the almanac is open at the wrong page.",
    goal: { flag: "dome_open", label: "open the dome and let the telescope see sky" },
    seats: [
      {
        clues: [
          { id: "almanac_page", label: "the almanac page left open on the desk" },
          { id: "counterweight_tag", label: "the tag wired to the counterweight" },
        ],
        acts: ["read the almanac page", "balance the counterweight", "release the dome brake"],
      },
      {
        clues: [
          { id: "weather_bulletin", label: "the weather bulletin read over the radio" },
          { id: "clock_card", label: "the card taped inside the clock case" },
        ],
        acts: ["announce the weather bulletin", "read the clock card aloud", "call the hour"],
      },
      {
        clues: [
          { id: "lens_crate_label", label: "the label stencilled on the lens crate" },
          { id: "grease_tin_note", label: "the note under the grease tin" },
        ],
        acts: ["read the lens crate label", "grease the runner rail", "seat the lens cap"],
      },
    ],
  },
  {
    id: "signalbox",
    title: "The Last Signal Box",
    subtitle: "A couch mystery for the end of the line, where every lever has a name on it.",
    opening: "The signal is stuck at danger and the timetable has gone from the wall.",
    goal: { flag: "line_cleared", label: "pull the home signal off and clear the line" },
    seats: [
      {
        clues: [
          { id: "timetable_slip", label: "the timetable slip in the lever frame" },
          { id: "brass_plate_note", label: "the note behind the brass plate" },
        ],
        acts: ["read the timetable slip", "set the distant lever", "pull the home signal off"],
      },
      {
        clues: [
          { id: "bell_code", label: "the bell code written on the block shelf" },
          { id: "lamp_oil_note", label: "the note on the lamp oil tin" },
        ],
        acts: ["ring out the bell code", "read the lamp oil note aloud", "call the block clear"],
      },
      {
        clues: [
          { id: "point_lever_label", label: "the label on the point lever" },
          { id: "fuse_cupboard_note", label: "the card inside the fuse cupboard" },
        ],
        acts: ["read the point lever label", "change the fuse", "throw the point lever"],
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* The dependency-shape library                                        */
/* ------------------------------------------------------------------ */

interface ShapeOut {
  puzzleId: string;
  goal: { flag: string; label: string };
  roles: { id: RoleId; capability: Capability; clues: ThemeSeat["clues"]; acts: readonly string[] }[];
}

interface Shape {
  id: string;
  /** Seats this shape needs. */
  seats: number;
  /**
   * Non-null when the shape is expected to fail the gate. The string is the
   * mistake a generator made, in the generator's own words -- the gate has its
   * own, and the ledger records the gate's.
   */
  flaw: string | null;
  build: (out: ShapeOut) => Puzzle;
}

const primitives = () =>
  [
    { id: "dpad.grid", capability: "dpad" as const, maxOptions: 9, splittable: false, label: "3x3 d-pad grid" },
    { id: "dpad.button", capability: "dpad" as const, maxOptions: 1, splittable: false, label: "single d-pad press" },
    { id: "scan.paged", capability: "scan" as const, maxOptions: 4, splittable: true, label: "switch-scan paged list" },
    { id: "voice.confirm", capability: "voice" as const, maxOptions: 1, splittable: false, label: "spoken confirmation" },
  ];

/**
 * A tightly braided ring: every seat needs the seat before it, and the goal
 * needs every seat's work. Nothing here is decorative -- remove any seat and
 * the ring is cut.
 */
const BRAID: Shape = {
  id: "braid",
  seats: 0, // any
  flaw: null,
  build: ({ puzzleId, goal, roles }) => {
    const n = roles.length;
    const actions: Puzzle["actions"] = [];
    roles.forEach((role, i) => {
      const previous = roles[(i - 1 + n) % n]!;
      const fact = `${role.id.toLowerCase()}_fact`;
      const part = `${role.id.toLowerCase()}_part`;
      actions.push({
        id: `${role.id.toLowerCase()}_read`,
        performer: role.id,
        needs: role.capability,
        requiresTokens: [role.clues[0]!.id],
        requiresFlags: [],
        producesTokens: [fact],
        setsFlags: [],
        label: `${role.acts[0]} (${role.clues[0]!.label})`,
      });
      actions.push({
        id: `${role.id.toLowerCase()}_work`,
        performer: role.id,
        needs: role.capability,
        requiresTokens: [fact, `${previous.id.toLowerCase()}_fact`],
        requiresFlags: [],
        producesTokens: [part],
        setsFlags: [],
        options: 4,
        answerToken: `${previous.id.toLowerCase()}_fact`,
        label: `${role.acts[1]} (4 settings marked)`,
      });
    });
    const finisher = roles[0]!;
    actions.push({
      id: `${finisher.id.toLowerCase()}_finish`,
      performer: finisher.id,
      needs: finisher.capability,
      // The ending needs every seat's work *and* every seat's own clue. The
      // clue half is not decoration: a private fact exists only while its
      // holder is present, so requiring it is what keeps a seat load-bearing
      // at a mid-game cut where it has already finished its own actions. A
      // shape whose ending needs only produced tokens goes decorative the
      // moment the last of those tokens lands, so the ending also requires
      // every seat's own private clue.
      requiresTokens: [
        ...roles.map((r) => `${r.id.toLowerCase()}_part`),
        ...roles.map((r) => r.clues[0]!.id),
      ],
      requiresFlags: [],
      producesTokens: [],
      setsFlags: [goal.flag],
      options: 4,
      answerToken: `${roles[roles.length - 1]!.id.toLowerCase()}_part`,
      label: `${goal.label} (4 ways to try)`,
    });
    return { id: puzzleId, roles: roles.map((r) => ({ id: r.id, capabilities: [r.capability], privateTokens: [r.clues[0]!.id] })), primitives: primitives(), goalFlags: [goal.flag], actions };
  },
};

/**
 * A keystone: two seats feed each other and then the third, and the third
 * cannot finish until both have. The dependence graph is a three-cycle with a
 * shared end, which is a different shape from the braid's uniform ring.
 */
const KEYSTONE: Shape = {
  id: "keystone",
  seats: 3,
  flaw: null,
  build: ({ puzzleId, goal, roles }) => {
    const [a, b, c] = roles as [ShapeOut["roles"][number], ShapeOut["roles"][number], ShapeOut["roles"][number]];
    const low = (r: ShapeOut["roles"][number]) => r.id.toLowerCase();
    return {
      id: puzzleId,
      roles: roles.map((r) => ({ id: r.id, capabilities: [r.capability], privateTokens: [r.clues[0]!.id] })),
      primitives: primitives(),
      goalFlags: [goal.flag],
      actions: [
        { id: `${low(a)}_read`, performer: a.id, needs: a.capability, requiresTokens: [a.clues[0]!.id], requiresFlags: [], producesTokens: [`${low(a)}_fact`], setsFlags: [], label: `${a.acts[0]} (${a.clues[0]!.label})` },
        { id: `${low(b)}_read`, performer: b.id, needs: b.capability, requiresTokens: [b.clues[0]!.id], requiresFlags: [], producesTokens: [`${low(b)}_fact`], setsFlags: [], label: `${b.acts[0]} (${b.clues[0]!.label})` },
        // Each of the first two needs the other's fact before it can work.
        { id: `${low(a)}_work`, performer: a.id, needs: a.capability, requiresTokens: [`${low(a)}_fact`, `${low(b)}_fact`], requiresFlags: [], producesTokens: [`${low(a)}_part`], setsFlags: [], options: 4, answerToken: `${low(b)}_fact`, label: `${a.acts[1]} (4 settings marked)` },
        { id: `${low(b)}_work`, performer: b.id, needs: b.capability, requiresTokens: [`${low(b)}_fact`, `${low(a)}_fact`], requiresFlags: [], producesTokens: [`${low(b)}_part`], setsFlags: [], options: 4, answerToken: `${low(a)}_fact`, label: `${b.acts[1]} (4 settings marked)` },
        { id: `${low(c)}_read`, performer: c.id, needs: c.capability, requiresTokens: [c.clues[0]!.id], requiresFlags: [], producesTokens: [`${low(c)}_fact`], setsFlags: [], label: `${c.acts[0]} (${c.clues[0]!.label})` },
        // The keystone: the third seat needs its own clue, both parts, and --
        // for the same reason as the braid -- every seat's private clue, so
        // that a seat which has already done its work is still required.
        { id: `${low(c)}_finish`, performer: c.id, needs: c.capability, requiresTokens: [`${low(c)}_fact`, `${low(a)}_part`, `${low(b)}_part`, ...roles.map((r) => r.clues[0]!.id)], requiresFlags: [], producesTokens: [], setsFlags: [goal.flag], options: 4, answerToken: `${low(b)}_part`, label: `${goal.label} (4 ways to try)` },
      ],
    };
  },
};

/**
 * FLAW: a shortcut that reads a clue belonging to another seat.
 *
 * The story reaches its end in one step because one seat's private clue is
 * enough -- but that clue is only *convenient*. Cut that seat out and a longer
 * route still gets there, so the seat is decorative. It is still *meaningful*
 * (the witness plan consumes the clue it holds), which is precisely the case
 * that separates the two claims: this proposal fails necessity and nothing
 * else. That is why it is the fixture the mutation control uses.
 */
const SPARE_CLUE: Shape = {
  id: "spare-clue",
  seats: 2,
  flaw: "a shortcut consumed another seat's clue, so that seat is convenient rather than required",
  build: ({ puzzleId, goal, roles }) => {
    const [a, b] = roles as [ShapeOut["roles"][number], ShapeOut["roles"][number]];
    const low = (r: ShapeOut["roles"][number]) => r.id.toLowerCase();
    return {
      id: puzzleId,
      roles: roles.map((r) => ({ id: r.id, capabilities: [r.capability], privateTokens: [r.clues[0]!.id] })),
      primitives: primitives(),
      goalFlags: [goal.flag],
      actions: [
        // The shortcut: one step, and it leans on the other seat's clue.
        { id: `${low(a)}_shortcut`, performer: a.id, needs: a.capability, requiresTokens: [b.clues[0]!.id], requiresFlags: [], producesTokens: [], setsFlags: [goal.flag], label: `${goal.label} (off the ${b.clues[0]!.label})` },
        // The long way round, which is why the other seat is not required.
        { id: `${low(a)}_slow_one`, performer: a.id, needs: a.capability, requiresTokens: [a.clues[0]!.id], requiresFlags: [], producesTokens: [`${low(a)}_slow_one`], setsFlags: [], label: a.acts[1]! },
        { id: `${low(a)}_slow_two`, performer: a.id, needs: a.capability, requiresTokens: [`${low(a)}_slow_one`], requiresFlags: [], producesTokens: [`${low(a)}_slow_two`], setsFlags: [], label: a.acts[2]! },
        { id: `${low(a)}_slow_three`, performer: a.id, needs: a.capability, requiresTokens: [`${low(a)}_slow_two`], requiresFlags: [], producesTokens: [], setsFlags: [goal.flag], label: `${goal.label} (the long way round)` },
        // The other seat acts too -- nothing consumes what it makes.
        { id: `${low(b)}_read`, performer: b.id, needs: b.capability, requiresTokens: [b.clues[0]!.id], requiresFlags: [], producesTokens: [], setsFlags: [], label: `${b.acts[0]} (${b.clues[0]!.label})` },
      ],
    };
  },
};

/** FLAW: a choice that never says which token decides it. */
const ANSWERLESS_CHOICE: Shape = {
  id: "answerless-choice",
  seats: 0,
  flaw: "a choice with three options names no answer token",
  build: ({ puzzleId, goal, roles }) => {
    const base = BRAID.build({ puzzleId, goal, roles });
    const target = base.actions.find((a) => a.options === 4)!;
    return {
      ...base,
      actions: base.actions.map((a) => (a.id === target.id ? { ...a, answerToken: undefined } : a)),
    };
  },
};

/** FLAW: nothing in the story ever sets the goal. */
const OPEN_GOAL: Shape = {
  id: "open-goal",
  seats: 0,
  flaw: "no action sets the goal flag",
  build: ({ puzzleId, goal, roles }) => {
    const base = BRAID.build({ puzzleId, goal, roles });
    return {
      ...base,
      actions: base.actions.map((a) =>
        a.setsFlags.includes(goal.flag) ? { ...a, setsFlags: [], producesTokens: [`${a.id}_unused`] } : a,
      ),
    };
  },
};

/**
 * FLAW: an action asks for an input no seat has.
 *
 * A generator that writes actions first and assigns capabilities afterwards
 * will do this, and it is the failure a *player* would feel: the action is on
 * the board and nobody at the table can ever fire it. The extra action is a
 * red herring rather than a required step, which is deliberate -- the story is
 * still solvable without it, so this shape is rejected for *accessibility*
 * and not for solvability. Collapsing the two would hide which mistake the
 * generator made.
 */
const WRONG_CAPABILITY: Shape = {
  id: "wrong-capability",
  seats: 0,
  flaw: "an action needs an input no seat has, so nobody can ever fire it",
  build: ({ puzzleId, goal, roles }) => {
    const base = BRAID.build({ puzzleId, goal, roles });
    const seat = roles[0]!;
    return {
      ...base,
      actions: [
        ...base.actions,
        {
          id: `${seat.id.toLowerCase()}_scan_hatch`,
          performer: seat.id,
          // No seat in this library is ever given `scan`, so this action has
          // no eligible performer and never can have one.
          needs: "scan",
          requiresTokens: [],
          requiresFlags: [],
          producesTokens: [],
          setsFlags: [],
          label: "open the hatch on the scanner",
        },
      ],
    };
  },
};

const SHAPES: readonly Shape[] = [
  BRAID,
  KEYSTONE,
  SPARE_CLUE,
  ANSWERLESS_CHOICE,
  OPEN_GOAL,
  WRONG_CAPABILITY,
];

/* ------------------------------------------------------------------ */
/* The proposer                                                        */
/* ------------------------------------------------------------------ */

/** The shapes the local library can draw, and which of them are wrong on purpose. */
export const LOCAL_SHAPES: readonly { id: string; seats: number; flaw: string | null }[] = SHAPES.map(
  (shape) => ({ id: shape.id, seats: shape.seats, flaw: shape.flaw }),
);

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Compose one mystery from the libraries. Pure: same spec, same result.
 *
 * The two libraries are drawn independently -- a theme first, then a shape --
 * which is exactly how a generator ends up with a shape whose seats do not
 * match the fiction it was dressed in. Nothing reconciles them here; the gate
 * is what decides whether the result was any good.
 */
export function composeLocal(spec: ProposeSpec): ProposedMystery {
  const draw = new Draw(spec.seed);
  const theme = draw.pick(THEMES);
  const seats = Math.max(2, Math.min(3, Math.floor(spec.roles)));
  const eligible = SHAPES.filter((shape) => shape.seats === 0 || shape.seats === seats);
  const shape = draw.pick(eligible);
  return composeWith(shape, theme.id, spec);
}

/**
 * Compose from one *named* shape rather than from the seeded draw.
 *
 * A seam for the two callers that need to talk about a specific mistake: the
 * mutation control in `test/gen-gate.test.ts`, which has to hold up the one
 * shape that fails necessity and nothing else, and the report, which quotes
 * the library shape by shape. The seed still drives the fiction, so a named
 * composition is as reproducible as any other.
 */
export function composeFromShape(spec: ProposeSpec, shapeId: string, themeId?: string): ProposedMystery {
  const shape = SHAPES.find((s) => s.id === shapeId);
  if (!shape) throw new Error(`unknown shape "${shapeId}"; known: ${SHAPES.map((s) => s.id).join(", ")}`);
  const theme = themeId ? THEMES.find((t) => t.id === themeId) : THEMES[0];
  if (!theme) throw new Error(`unknown theme "${themeId}"`);
  return composeWith(shape, theme.id, spec);
}

function composeWith(shape: Shape, themeId: string, spec: ProposeSpec): ProposedMystery {
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0]!;
  const seats = Math.max(2, Math.min(3, Math.floor(spec.roles)));

  const ids = seatIds(seats);
  const capabilities = seatCapabilities(seats);
  const roles = ids.map((id, i) => ({
    id,
    capability: capabilities[i]!,
    clues: theme.seats[i]!.clues,
    acts: theme.seats[i]!.acts,
  }));

  const puzzleId = `the-${theme.id}-${shape.id}-${spec.seed}`;
  const puzzle = shape.build({ puzzleId, goal: theme.goal, roles });

  // The story's headline is the seat whose input the mystery is about: the
  // last d-pad seat, matching how the hand-written catalogue picks its own.
  const dpadSeats = roles.filter((r) => r.capability === "dpad");
  const headlineRole = (dpadSeats[dpadSeats.length - 1] ?? roles[roles.length - 1]!).id;

  return {
    id: puzzleId,
    title: theme.title,
    subtitle: theme.subtitle,
    opening: theme.opening,
    roles: ids,
    headline: { role: headlineRole, capabilities: ["scan"] },
    puzzle,
  };
}

/**
 * The deterministic proposer.
 *
 * It cannot fail: composing from a fixed library with a seeded PRNG always
 * produces a value. Whether that value is any *good* is not this class's
 * question -- it is the gate's, and a `LocalProposer` that pre-filtered its own
 * output would hide the rejections the ledger exists to count.
 */
export class LocalProposer implements PuzzleProposer {
  readonly name = "local";

  async propose(spec: ProposeSpec): Promise<ProposeResult> {
    return { kind: "proposed", mystery: composeLocal(spec) };
  }
}

/** The bytes a run should be reproducible against, for tests and the CLI. */
export function mysteryJson(mystery: ProposedMystery): string {
  return canonicalStringify(mystery);
}

export { slug as slugify };
