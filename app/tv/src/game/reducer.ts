/**
 * The game, as a pure function.
 *
 * The TV is the authoritative host: it holds the puzzle, the state and the
 * history, it runs `certify` and `recompile` from the validator locally, and
 * every view a phone renders is derived here. A phone sends an intent; this
 * reducer decides whether that intent is legal, and the legality check is not
 * the last word -- the action is only committed if the validator's own
 * `certify` accepts the state it produces. Two independent answers, and the
 * stricter one wins.
 *
 * Everything in this file is pure. The only non-deterministic field anywhere in
 * the state is a timing (`elapsedMs`), exactly as in the validator's own demo
 * run; no test compares those.
 */
import type {
  Action,
  Capability,
  Certificate,
  DiffEntry,
  PlanStep,
  Puzzle,
  RoleId,
  State,
} from "./validator.ts";
import {
  certify,
  doneActionIds,
  emptyState,
  explainFailure,
  isCertificate,
  knownTokens,
  normalizeState,
  recompile,
  resolvePerformer,
  roleCapabilities,
  rolePrivateTokens,
  solve,
} from "./validator.ts";
import {
  CAPABILITY_LABEL,
  actionTitle,
  clueText,
  correctOptionIndex,
  factText,
  flagText,
  optionLabels,
  refusalCopy,
  wrongAttemptText,
} from "./presentation.ts";
import { badge, type Badge } from "./badge.ts";
import { DEFAULT_MYSTERY_ID, mysteryById, mysteryOrDefault, seatRoles } from "./mysteries.ts";
import {
  MORE_CHOICE_ID,
  SCAN_MAX_OPTIONS,
  isCapability,
  isRoleId,
  type Capability as WireCapability,
  type Choice,
  type DiffLine,
  type PhoneView,
  type RoleId as WireRoleId,
} from "../../../shared/protocol.ts";

/**
 * The wire vocabulary is narrower than the validator's (`RoleId` is a plain
 * string there, and a capability is a union that could grow). Everything that
 * leaves the TV goes through these two, so a new validator capability cannot
 * reach a phone that has never heard of it.
 */
export function asProtocolCapabilities(capabilities: readonly string[]): WireCapability[] {
  return capabilities.filter(isCapability);
}

export function asProtocolRole(role: string | null): WireRoleId | null {
  return isRoleId(role) ? role : null;
}

/** The TV remote is a controller too, and it acts under this pseudo-peer id. */
export const TV_PEER = "tv";

export type Phase = "lobby" | "playing" | "switching" | "ending";

/**
 * How long a seat is held for a phone that has dropped.
 *
 * A phone that comes back arrives on a new connection and therefore as a new
 * peer id, so the TV cannot tell "a reconnect" from "a different person" by the
 * wire alone. Holding the seat for this long is what makes a reconnect
 * survivable; after it, the role is freed so the room is not stuck waiting for
 * a phone that is not coming back.
 *
 * Three minutes, because the things this window has to cover are the ordinary
 * ones: a phone that was locked and picked up again, a browser reloaded, a
 * player who walked to the charger and back. A window shorter than any of those
 * is a window that frees a seat the room was never actually waiting on.
 */
export const SEAT_GRACE_MS = 180_000;

/**
 * The grace window in words, for the lines that tell the room about it. A
 * whole number of minutes when it is one, seconds otherwise -- this is the only
 * place the constant is turned into something a player reads.
 */
function gracePhrase(): string {
  const seconds = SEAT_GRACE_MS / 1000;
  if (seconds % 60 !== 0) return `${seconds}s`;
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export interface Player {
  peerId: string;
  name: string;
  role: RoleId | null;
  connected: boolean;
  /**
   * The phone's own identity, chosen by the phone and stable across reconnects
   * (the peer id is not: it belongs to the connection). Null only for a client
   * that did not send one, which then cannot be recognised coming back.
   */
  seat: string | null;
  /** When this player's connection dropped, or null while they are here. */
  disconnectedAt: number | null;
  /**
   * A seat token this (roleless) connection presented that collided with a
   * seat somebody else already holds -- typically a second tab of the same
   * phone, reading the same browser-wide token out of the same IndexedDB
   * store. Never trusted as this player's own identity (that stays `seat`,
   * above): it only records that this connection is WAITING on that seat, so
   * the TV can be asked whether to move it (`approve_reclaim`). Nothing here
   * is ever granted automatically. Cleared when the TV answers, when the
   * phone says the seat is not its own, or when the seat stops being held at
   * all (`normalizeReclaimQueue`).
   */
  claimedSeat: string | null;
  /**
   * The token this connection PRESENTED, whoever the room decides owns the
   * seat behind it. `seat` is ownership; this is possession -- what the
   * phone's own browser store held when it joined.
   *
   * The two differ in exactly one situation, and it is the one this field
   * exists for: a second tab of a browser that is already playing. That tab
   * presents its browser's token, is refused the seat, and carries no `seat`
   * of its own -- but it is still the same browser as the tab holding the
   * role, and must never be handed a second role. `seat` cannot say that
   * (it is null, and stays null once a claim is declined), so this does:
   * every grant path reads it to ask "is this browser already playing?"
   * (`seatBusyFor`). It is set once from the first token this peer id
   * presents and then only ever REPLACED by a later presented token, never
   * cleared -- a claim ending is not the browser forgetting what is in its
   * own store.
   */
  presentedSeat: string | null;
}

export interface LogLine {
  id: number;
  kind: "system" | "action" | "switch";
  role: RoleId | null;
  text: string;
}

export type SwitchKind =
  | "ok"
  | "no_valid_recompile"
  | "search_exhausted"
  | "invalid_input"
  // The compiler reporting its own bug, not a claim about the puzzle: a
  // candidate could not be evaluated at all. It keeps the old input, like the
  // other refusals, but it must never be spoken as "no repair exists".
  | "operator_error";

/**
 * The seat a switch was asked BY, captured at request time. A pending switch is a request from a *seat*, and the
 * rebuild moment it animates outlives that seat's connection easily: the role
 * can be dropped, swept away, or handed to a different phone while the eight
 * seconds play. `seat` is the phone's own stable identity -- the peer id is
 * not, a reconnect always arrives on a new one -- so a phone that stepped out
 * and came back to the SAME seat still owns the request it made, while a
 * different phone seated in the same role does not.
 */
export interface SwitchRequester {
  peerId: string;
  seat: string | null;
}

/**
 * How many operators applied to reach this candidate, and what they did -- read
 * straight from the recompiler's own `DiffEntry`, never re-parsed from a
 * rendered sentence: this retains the structured `result.diff` identifiers
 * rather than recovering ownership, option counts, or check counts by parsing
 * rendered text.
 */
export interface SwitchRecord {
  role: WireRoleId;
  /** Who asked for this change. See `SwitchRequester`. */
  requester: SwitchRequester;
  from: WireCapability[];
  to: WireCapability[];
  kind: SwitchKind;
  /** True only when a repaired puzzle was produced and applied. */
  applied: boolean;
  diff: DiffEntry[];
  reason: string;
  /** The puzzle as it stood immediately before this switch was requested. */
  beforePuzzle: Puzzle;
  /** The full certificate for the repaired puzzle. Null for a refusal. */
  certificate: Certificate | null;
  operatorsTried: number;
  totalStatesExplored: number;
  elapsedMs: number;
  /** Present only when `kind === "ok"`: the repaired puzzle and the state to carry on from. */
  puzzle: Puzzle | null;
  play: State | null;
  /**
   * True when this role already had an applied switch this run. A repeat
   * change goes straight to the static summary rather than replaying the
   * eight-second sequence.
   */
  repeat: boolean;
}

export interface PendingChoice {
  actionId: string;
  options: number;
}

export interface Notice {
  peerId: string;
  text: string;
  /** Bumped on every notice so the UI can restart its own dismissal timer. */
  seq: number;
}

/**
 * A connection the TV has just dropped in favour of a newer one presenting
 * the same live seat's token. Named by peer id, not by seat, because the
 * peer id is gone from `players` by the time this is set -- it is the only
 * address left to tell that connection it is done. `seq` is bumped on every
 * occurrence so the TV's own outbound effect can tell a repeat delivery from
 * a fresh one, the same reason `Notice` bumps its own.
 */
export interface Superseded {
  peerId: string;
  seq: number;
}

/**
 * A phone has typed the name of a held seat and is waiting for the TV to say
 * OK. A name is public, not a secret, so it can never grant a seat on its
 * own -- only the TV remote's own approval completes it.
 * At most one of these at a time: a second request while one is pending is
 * refused rather than queued.
 */
export interface PendingReclaim {
  /**
   * The fingerprint of exactly this request: the requester's peer id, the
   * seat token being claimed, and a number that only ever moves forward. The
   * TV decides on an id, never on "whatever the overlay happens to be showing
   * now", so a press aimed at a request that has since been replaced is
   * refused instead of landing on its successor (`approve_reclaim` below).
   */
  id: string;
  peerId: string;
  name: string;
  role: RoleId;
  /**
   * The seat token this request is about, when it was raised by one
   * (`via: "token"`). It is what identifies the record the seat will move
   * FROM -- `reclaimTarget`, below -- rather than the role-and-name pair a
   * typed-name request has to settle for. Kept on the TV only; it is never
   * put on the wire, because a token is a credential and the phones have no
   * use for anybody else's.
   */
  seat: string | null;
  /**
   * How this request was raised: a typed name (the ordinary `reclaim_seat`
   * case, and the default when this is absent) or a seat token presented by
   * a peer id that has never held this role before. Only
   * changes the wording -- the approval itself is identical either way, but
   * the two are not the same claim: a typed name at least asserts a person,
   * while a token asserts only possession, so `approve_reclaim` logs the
   * token case as the TV letting a phone take the seat.
   */
  via?: "name" | "token";
}

export interface GameState {
  phase: Phase;
  room: string;
  players: Player[];
  /** The puzzle in play: the demo's, until a switch repairs it. */
  puzzle: Puzzle;
  play: State;
  /** Badge for the puzzle as it stands now. */
  certificate: Certificate | null;
  certificateError: string | null;
  /** Badge for the untouched puzzle, always shown in the lobby. */
  startCertificate: Certificate | null;
  /**
   * What "everyone is essential" is a claim *about*: a puzzle, and the state it
   * was in when the team met it. Necessity is a property of a puzzle from a
   * state, and the goal state is the one state where nobody is needed any more
   * -- so the ending certifies this pair, not the finished board.
   */
  claim: { puzzle: Puzzle; state: State };
  plan: PlanStep[];
  midpointSteps: number;
  switches: SwitchRecord[];
  pendingSwitch: SwitchRecord | null;
  switchBeat: number;
  /** Per controller (peer id, or `TV_PEER`) the action awaiting an option pick. */
  pending: Record<string, PendingChoice>;
  /** Per controller, which page of a long choice list they are on. */
  pages: Record<string, number>;
  log: LogLine[];
  notice: Notice | null;
  nextLogId: number;
  nextNoticeSeq: number;
  pendingReclaim: PendingReclaim | null;
  /** The number the next reclaim request's fingerprint will carry. Only ever moves forward, so no two requests can share an id. */
  nextReclaimSeq: number;
  superseded: Superseded | null;
  nextSupersededSeq: number;
}

export type GameAction =
  | { k: "room"; room: string }
  /** Pick which mystery the room will play. Lobby only; see `chooseMystery`. */
  | { k: "choose_mystery"; mysteryId: string }
  | { k: "player_joined"; peerId: string; name?: string; want?: RoleId; seat?: string }
  /** `at` is the wall clock, passed in: the reducer never reads one. */
  | { k: "player_left"; peerId: string; at: number }
  /**
   * Who the relay says is in this room, from the TV's own `welcome`.
   *
   * A drop is announced to the peers in the room, and a TV whose socket is
   * down is not one of them: a phone that leaves during that gap is news the
   * TV only ever gets from this list. So the TV reconciles on every welcome,
   * and every phone it is still counting as connected but that the relay does
   * not list is treated exactly as if its `player_left` had arrived -- same
   * grace window, same sweep, same seat still held for whoever comes back.
   *
   * It only ever takes players away. The list is the relay's word on who is
   * present, not a way to bring a seat back: a seat the grace window let go,
   * or one a player gave back, stays gone until that player joins again.
   */
  | { k: "peers_present"; peerIds: string[]; at: number }
  /** Free the seats of phones that have been gone longer than `SEAT_GRACE_MS`. */
  | { k: "sweep_seats"; at: number }
  | { k: "assign_role"; peerId: string; role: WireRoleId }
  /** A phone giving its role back, so it can pick again. */
  | { k: "release_role"; peerId: string }
  /**
   * The same player, back on a connection the relay does not recognise,
   * naming the seat they held before. Only ever matches a role that is
   * currently disconnected (see `reduce`'s `reclaim_seat` case) -- a name is
   * not a secret, so this never grants the seat itself; it only raises a
   * request the TV must approve (`approve_reclaim`/`decline_reclaim`).
   */
  | { k: "reclaim_seat"; peerId: string; name: string }
  /**
   * This phone is not the seat it presented a token for. Drops the claim
   * `player_joined` recorded, so the phone is an ordinary roleless arrival
   * again: it may pick a free role, or raise a named reclaim, exactly like
   * anybody else. Without it a claim is a one-way door -- a phone that
   * collided with a live seat waits for a decision that cannot come, and is
   * refused every other route in the meantime.
   */
  | { k: "release_claim"; peerId: string }
  /**
   * The TV remote's OK to a pending `reclaim_seat` request. TV-only: no phone
   * intent maps to it. `requestId` is the fingerprint of the request the
   * remote was answering; a decision that names any other request is refused.
   */
  | { k: "approve_reclaim"; requestId: string }
  /** The TV remote declines a pending `reclaim_seat` request. TV-only. Names its request the same way. */
  | { k: "decline_reclaim"; requestId: string }
  | { k: "choose_action"; peerId: string; actionId: string }
  | { k: "choose_option"; peerId: string; option: number }
  | { k: "cancel_choice"; peerId: string }
  | { k: "request_input_change"; role: WireRoleId; capabilities: WireCapability[] }
  | { k: "switch_beat" }
  /** Skip the rebuild moment (the "Continue" control) or dismiss a refusal. */
  | { k: "switch_dismiss" }
  | { k: "clear_notice"; seq: number };

/** The rebuild moment's four beats: before, after, payoff, back to play. */
export const SWITCH_PHASES = 4;

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export function createGame(room = "", mysteryId: string = DEFAULT_MYSTERY_ID): GameState {
  const mystery = mysteryOrDefault(mysteryId);
  const puzzle = mystery.build();
  const play = emptyState();
  const result = certify(puzzle, play);
  const witness = solve(puzzle, play);
  return {
    phase: "lobby",
    room,
    players: [],
    puzzle,
    play,
    certificate: isCertificate(result) ? result : null,
    certificateError: isCertificate(result) ? null : explainFailure(result),
    startCertificate: isCertificate(result) ? result : null,
    claim: { puzzle, state: play },
    plan: witness.plan,
    midpointSteps: Math.floor(witness.plan.length / 2),
    switches: [],
    pendingSwitch: null,
    switchBeat: 0,
    pending: {},
    pages: {},
    log: [
      {
        id: 0,
        kind: "system",
        role: null,
        text: mystery.opening,
      },
    ],
    notice: null,
    nextLogId: 1,
    nextNoticeSeq: 1,
    pendingReclaim: null,
    nextReclaimSeq: 1,
    superseded: null,
    nextSupersededSeq: 1,
  };
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

/**
 * Swap the room onto a different mystery, before it starts.
 *
 * This is the only thing that changes which puzzle is in play, and it is
 * deliberately confined to the lobby: once a team is playing, the puzzle in
 * play is the thing every certificate on screen is a claim about, and changing
 * it mid-game would silently invalidate all of them. The room code, the relay
 * and every phone connection are untouched -- only the puzzle, its plan and the
 * fresh certificate change.
 *
 * A player holding a role the new mystery does not seat gives that role back
 * rather than being carried into a seat that no longer exists. A player who had
 * not chosen yet stays exactly where they are.
 */
export function chooseMystery(state: GameState, mysteryId: string): GameState {
  if (state.phase !== "lobby") return state;
  const mystery = mysteryById(mysteryId);
  if (!mystery || mystery.id === state.puzzle.id) return state;

  const next = createGame(state.room, mystery.id);
  const seats = new Set<string>(seatRoles(next.puzzle));
  const players = state.players.map((player) =>
    player.role !== null && !seats.has(player.role) ? { ...player, role: null } : player,
  );
  return { ...next, players };
}

export interface AvailableAction {
  actionId: string;
  label: string;
  performer: RoleId;
  options: number;
}

/**
 * Every action the team could take right now: not already done, prerequisites
 * met, and somebody in the puzzle able to perform it. Whether that somebody is
 * *connected* is a separate question -- the board shows both, because a card
 * waiting on an absent player is information, not an error.
 */
export function availableActions(puzzle: Puzzle, play: State): AvailableAction[] {
  const done = new Set(doneActionIds(play.history));
  const known = knownTokens(puzzle, play);
  const out: AvailableAction[] = [];
  for (const action of puzzle.actions) {
    if (done.has(action.id)) continue;
    if (!action.requiresTokens.every((token) => known.has(token))) continue;
    if (!action.requiresFlags.every((flag) => play.flags.includes(flag))) continue;
    const performer = resolvePerformer(puzzle, action);
    if (!performer) continue;
    out.push({
      actionId: action.id,
      label: actionTitle(action),
      performer,
      options: action.options ?? 1,
    });
  }
  return out;
}

export function playerByPeer(state: GameState, peerId: string): Player | undefined {
  return state.players.find((p) => p.peerId === peerId);
}

export function playerByRole(state: GameState, role: RoleId): Player | undefined {
  return state.players.find((p) => p.role === role);
}

export function roleOfPeer(state: GameState, peerId: string): RoleId | null {
  return playerByPeer(state, peerId)?.role ?? null;
}

export function isConnected(state: GameState, role: RoleId): boolean {
  const player = playerByRole(state, role);
  return player !== undefined && player.connected;
}

/** How a role's input mode reads on a phone. `dpad` means "use the TV remote". */
export function phoneMode(capabilities: readonly string[]): PhoneView["mode"] {
  if (capabilities.includes("scan")) return "scan";
  if (capabilities.includes("voice")) return "voice";
  if (capabilities.includes("dpad")) return "dpad";
  return "waiting";
}

/** A role's private clues, and only that role's. */
export function cluesFor(puzzle: Puzzle, role: RoleId): { id: string; text: string }[] {
  return rolePrivateTokens(puzzle, role).map((id) => ({ id, text: clueText(id) }));
}

/** The shared clue board: everything the team has said out loud. */
export function sharedFacts(puzzle: Puzzle, play: State): { id: string; text: string; done: boolean }[] {
  const facts: { id: string; text: string; done: boolean }[] = [];
  for (const token of play.tokens) facts.push({ id: token, text: factText(token), done: true });
  for (const flag of play.flags) facts.push({ id: flag, text: flagText(flag), done: true });
  const known = new Set([...play.tokens, ...play.flags]);
  const outstanding = new Set<string>();
  for (const action of puzzle.actions) {
    for (const token of action.producesTokens) if (!known.has(token)) outstanding.add(token);
    for (const flag of action.setsFlags) if (!known.has(flag)) outstanding.add(flag);
  }
  for (const id of outstanding) {
    facts.push({
      id,
      text: puzzle.actions.some((a) => a.setsFlags.includes(id)) ? flagText(id) : factText(id),
      done: false,
    });
  }
  return facts;
}

/**
 * The whole play so far, in words, straight from the validator's own history --
 * the same log the certificate is computed from, so the ending screen cannot
 * tell a story the certificate does not support.
 */
export function historyLines(state: GameState): LogLine[] {
  const lines: LogLine[] = [];
  let id = 0;
  for (const event of state.play.history) {
    if (event.kind === "action") {
      const action = state.puzzle.actions.find((a) => a.id === event.actionId);
      lines.push({
        id: id++,
        kind: "action",
        role: event.performer,
        text: action ? actionTitle(action) : event.actionId,
      });
      continue;
    }
    lines.push({
      id: id++,
      kind: "switch",
      role: event.role,
      text: `changed input: ${event.from.join(" + ") || "nothing"} → ${event.to.join(" + ") || "nothing"}`,
    });
  }
  return lines;
}

export interface Credit {
  role: RoleId;
  text: string;
}

/**
 * Three concise contributions for the ending, one per seated role, each the
 * LAST action that role actually performed -- sourced from the real history,
 * never from the witness plan.
 */
export function endingCredits(state: GameState): Credit[] {
  const credits: Credit[] = [];
  for (const role of seatRoles(state.puzzle)) {
    const performed = state.play.history.filter(
      (event): event is Extract<typeof event, { kind: "action" }> =>
        event.kind === "action" && event.performer === role,
    );
    const last = performed[performed.length - 1];
    if (!last) continue;
    const action = state.puzzle.actions.find((a) => a.id === last.actionId);
    credits.push({ role, text: action ? actionTitle(action) : last.actionId });
  }
  return credits;
}

/**
 * The badge that stands for the whole run: the puzzle as it ended up, certified
 * from the state the team found it in. After a switch that is the repaired
 * puzzle from the repaired midpoint -- the same pair the validator's own demo
 * certifies -- so the ending's claim is the same shape as the lobby's.
 *
 * `isRoleConnected` is the same live-role gate the lobby
 * badge and the phone's mid-play badge already take (`badgeFromCertificate`).
 * It stays optional, and defaults to "everyone is here", because of what the
 * TV's ending screen actually does with this badge: it reads `finalBadge(state).ok`
 * and nothing else (`screens.tsx`'s `Ending`, `claimOk`), feeding it to
 * `endingClaimLine`, which already goes through `claimHoldsLive`. The per-role
 * lines this function builds reach no TV surface at all -- the ending's one
 * `BadgeRow` was replaced by `HowWeChecked` in `8dc00e1`, so the lobby's
 * `BadgeRow` (`screens.tsx:517`) is the only one left in the app -- and the
 * single `ok` the TV does read is never rendered raw: `Ending` folds it
 * through `claimHoldsLive` (with the live held/vacant labels) before any line
 * states it. A phone has no such headline: its badge is the whole claim, ticks
 * included, so `phoneView` passes the gate.
 *
 * The TV's ending does not render this badge at all: not underneath a
 * headline, and not anywhere else.
 */
export function finalBadge(
  state: GameState,
  isRoleConnected?: (role: string) => boolean,
): Badge {
  return badge(certify(state.claim.puzzle, state.claim.state), isRoleConnected);
}

/** The full certificate the run's claim stands on, for "How we checked". */
export function finalCertificate(state: GameState): Certificate | null {
  const result = certify(state.claim.puzzle, state.claim.state);
  return isCertificate(result) ? result : null;
}

/* ------------------------------------------------------------------ */
/* Legality                                                            */
/* ------------------------------------------------------------------ */

export interface Refusal {
  reason: string;
}

/**
 * Apply one action for one performer, if it is legal from this state.
 *
 * This is the same rule the validator replays histories with, written forwards:
 * every required token must be known to the team (a private token counts once
 * its holder is present), every required flag must be set, and the action must
 * not have been performed already.
 */
export function applyAction(
  puzzle: Puzzle,
  play: State,
  actionId: string,
): { ok: true; state: State; performer: RoleId } | { ok: false; reason: string } {
  const action = puzzle.actions.find((a) => a.id === actionId);
  if (!action) return { ok: false, reason: `there is no action "${actionId}" in this puzzle` };
  if (doneActionIds(play.history).includes(actionId)) {
    return { ok: false, reason: `"${actionTitle(action)}" has already been done` };
  }
  const known = knownTokens(puzzle, play);
  const missingTokens = action.requiresTokens.filter((token) => !known.has(token));
  if (missingTokens.length > 0) {
    return {
      ok: false,
      reason: `"${actionTitle(action)}" needs ${missingTokens.map(factText).join(", ")}, which the team does not have yet`,
    };
  }
  const missingFlags = action.requiresFlags.filter((flag) => !play.flags.includes(flag));
  if (missingFlags.length > 0) {
    return {
      ok: false,
      reason: `"${actionTitle(action)}" needs ${missingFlags.map(flagText).join(", ")} first`,
    };
  }
  const performer = resolvePerformer(puzzle, action);
  if (!performer) {
    return { ok: false, reason: `nobody in this puzzle can perform "${actionTitle(action)}"` };
  }
  const normalized = normalizeState(play);
  return {
    ok: true,
    performer,
    state: {
      flags: [...new Set([...normalized.flags, ...action.setsFlags])].sort(),
      tokens: [...new Set([...normalized.tokens, ...action.producesTokens])].sort(),
      history: [
        ...normalized.history,
        { kind: "action", actionId: action.id, performer, capability: action.needs },
      ],
    },
  };
}

/** Who is allowed to press the button for this action, on which controller. */
function controllerMayAct(
  state: GameState,
  peerId: string,
  performer: RoleId,
): Refusal | null {
  if (peerId === TV_PEER) {
    // The remote is a d-pad. A role that no longer has one cannot act from it.
    return roleCapabilities(state.puzzle, performer).includes("dpad")
      ? null
      : { reason: `${performer} does not use the remote any more — that action is on their phone` };
  }
  const role = roleOfPeer(state, peerId);
  if (!role) return { reason: "you do not have a role yet" };
  if (role !== performer) {
    return { reason: `that action belongs to ${performer}, not to ${role}` };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The switch                                                          */
/* ------------------------------------------------------------------ */

/** The full `DiffEntry[]` reduced to the wire's `{op, summary}` shape for phones. */
export function diffToWire(diff: DiffEntry[]): DiffLine[] {
  return diff.map((entry) => ({ op: entry.op, summary: entry.summary }));
}

/**
 * Deeper than the validator's own default (5), against every shipped
 * mystery's hardest case: collapsing every d-pad role to voice, one at a
 * time, which times out as `search_exhausted` at the default depth, while 8
 * turns that same case into a proven `no_valid_recompile` (a definitive "no"
 * instead of "unknown") at no measurable extra cost -- worst case ~57ms on
 * this machine, unchanged all the way to depth 12. This app-side default is
 * a `recompile` option, not a change to the frozen validator.
 */
const APP_MAX_DEPTH = 8;

export function switchRecord(
  puzzle: Puzzle,
  play: State,
  role: WireRoleId,
  capabilities: WireCapability[],
  requester: SwitchRequester,
  repeat = false,
  maxDepth = APP_MAX_DEPTH,
): SwitchRecord {
  const from = asProtocolCapabilities(roleCapabilities(puzzle, role));
  const result = recompile(puzzle, play, role, capabilities, { maxDepth });

  if (result.kind === "ok") {
    return {
      role,
      requester,
      from,
      to: [...capabilities],
      kind: "ok",
      applied: false,
      diff: result.diff,
      reason: "",
      beforePuzzle: puzzle,
      certificate: result.certificate,
      operatorsTried: result.operatorsTried.length,
      totalStatesExplored: result.totalStatesExplored,
      elapsedMs: result.elapsedMs,
      puzzle: result.puzzle,
      play: result.state,
      repeat,
    };
  }

  return {
    role,
    requester,
    from,
    to: [...capabilities],
    kind: result.kind,
    applied: false,
    diff: result.diff,
    reason: result.reason,
    beforePuzzle: puzzle,
    certificate: null,
    operatorsTried: result.operatorsTried.length,
    totalStatesExplored: result.totalStatesExplored,
    elapsedMs: result.elapsedMs,
    puzzle: null,
    play: null,
    repeat,
  };
}

/** What a capability set reads as on screen -- never a literal, so it cannot say the wrong one. */
function capabilityLabel(capabilities: readonly WireCapability[]): string {
  return capabilities.map((c) => CAPABILITY_LABEL[c]).join(" + ") || "no input";
}

/**
 * Is `player` the same seat as `requester` -- the connection that asked for
 * something, or, for a phone that reconnected on a new peer id, the same seat
 * token it presented? A phone that never minted a token cannot be recognised
 * coming back, so only its own peer id counts for it.
 */
function sameSeat(player: { peerId: string; seat: string | null }, requester: SwitchRequester): boolean {
  if (player.peerId === requester.peerId) return true;
  return requester.seat !== null && player.seat === requester.seat;
}

/**
 * Does the seat that asked for this switch still hold the role it is about?
 * Identity is `sameSeat`: the asking connection, or -- for a phone that
 * reconnected on a new peer id -- the same seat token.
 *
 * Being *disconnected* is deliberately not a mismatch here. A phone inside its
 * grace window still holds its role, and its own request waits with it, which
 * is what lets a phone that stepped out and came straight back keep the
 * rebuild it asked for. That last step
 * belongs to `resolveSwitch`, not to this predicate.
 */
function switchIsStillOurs(state: GameState, record: SwitchRecord): boolean {
  const owner = playerByRole(state, record.role);
  return owner !== undefined && sameSeat(owner, record.requester);
}

/**
 * Cancel a pending switch whose asking seat no longer holds the role it asked
 * about. The pre-request state IS the
 * state being cancelled in -- `BLOCKED_WHILE_SWITCHING` is what stops the
 * board moving under a rebuild -- so there is nothing to restore here; this
 * only has to put the phase back and say why, in words true of the case that
 * actually happened: the phone stepped out and stayed out (`left`), or the
 * seat is somebody else's now (`changed`).
 *
 * The record is deliberately NOT appended to `switches`. It never applied, and
 * a later genuine attempt for the same role must still get the full rebuild
 * moment rather than being read as a repeat of a switch that never happened.
 */
function cancelSwitch(state: GameState, record: SwitchRecord, why: "left" | "changed"): GameState {
  const reason =
    why === "left"
      ? `${record.role} left before it could be applied`
      : `the seat that asked for it does not hold ${record.role} any more`;
  return {
    ...withNotice(state, TV_PEER, `the change to ${record.role}'s input was cancelled — ${reason}`),
    phase: "playing",
    pendingSwitch: null,
    switchBeat: 0,
    log: appendLog(state, {
      kind: "switch",
      role: record.role,
      text: `the switch was cancelled — ${reason}`,
    }),
    // `appendLog` stamps the line with `nextLogId`; every other case that
    // appends also advances it, and this one did not -- so the NEXT line written anywhere in the room reused
    // this line's id. I10 in `checkSeatInvariants` now holds every appending
    // path to it.
    nextLogId: state.nextLogId + 1,
  };
}

/** Apply the switch that has finished animating, and re-certify from the new state. */
function resolveSwitch(state: GameState): GameState {
  const record = state.pendingSwitch;
  if (!record) return state;

  // 679`: the eight seconds this moment runs for
  // easily outlive the connection that asked for it, and a request is only
  // ever the asking seat's to make. `normalizePendingSwitch` is what keeps
  // this true step to step; it is checked once more here, immediately before a
  // request is actually applied, for the same reason `approve_reclaim`
  // re-checks its own requester.
  if (!switchIsStillOurs(state, record)) return cancelSwitch(state, record, "changed");
  // The one thing the normalisation above waits for: a seat that is still
  // inside its grace window at the dismissal never came back, so there is
  // nobody to apply the change for.
  if (!isConnected(state, record.role)) return cancelSwitch(state, record, "left");

  if (record.kind !== "ok" || !record.puzzle || !record.play) {
    // Plain words only: `record.reason` is the validator's own technical
    // explanation (search bounds, candidate counts) and belongs only in the
    // refusal sheet's collapsed "Details" -- never in the banner every player
    // sees, or in the permanent log.
    // `record.kind === "ok"` cannot reach here in practice -- an "ok" record
    // always carries `puzzle` and `play` -- but the `||` above is about that
    // invariant, not the type, so TS cannot narrow it away on its own.
    const copy = refusalCopy(record.kind as Exclude<SwitchKind, "ok">);
    const spoken =
      record.kind === "invalid_input"
        ? `the change was refused as invalid input. ${copy.body}`
        : record.kind === "search_exhausted"
          ? `${copy.heading} ${copy.body}`
          : record.kind === "operator_error"
            ? "something went wrong while making this change, so nothing is proven either way."
            : `no repair holds, so ${record.role} keeps the old input.`;
    return {
      ...state,
      phase: "playing",
      pendingSwitch: null,
      switchBeat: 0,
      switches: [...state.switches, { ...record }],
      notice: { peerId: TV_PEER, text: spoken, seq: state.nextNoticeSeq },
      nextNoticeSeq: state.nextNoticeSeq + 1,
      log: appendLog(state, { kind: "switch", role: record.role, text: `the switch failed — ${spoken}` }),
      // Same omission as `cancelSwitch`:
      // the refusal's own log line never advanced the id counter either.
      nextLogId: state.nextLogId + 1,
    };
  }

  const puzzle = record.puzzle;
  const play = record.play;
  const result = certify(puzzle, play);
  const applied: SwitchRecord = { ...record, applied: true };

  const next: GameState = {
    ...state,
    phase: "playing",
    puzzle,
    play,
    // The claim moves with the puzzle: from here on, "everyone is essential"
    // is a claim about the repaired puzzle from the state it was repaired in.
    claim: { puzzle, state: play },
    certificate: isCertificate(result) ? result : state.certificate,
    certificateError: isCertificate(result) ? null : explainFailure(result),
    pendingSwitch: null,
    switchBeat: 0,
    switches: [...state.switches, applied],
    pending: {},
    pages: {},
  };
  next.log = appendLog(next, {
    kind: "switch",
    role: record.role,
    text: `the puzzle is rebuilt — ${record.role} now plays with ${capabilityLabel(record.to)}`,
  });
  // And the applied path too -- the same
  // counter, the same omission, one line further along.
  return {
    ...next,
    nextLogId: next.nextLogId + 1,
    phase: goalReached(next.puzzle, next.play) ? "ending" : "playing",
  };
}

/**
 * True once every goal flag the puzzle names is held. Exported so anything
 * that needs to know which surface a state is shown on -- the art plate
 * table's own test, in particular -- asks this rule instead of copying it.
 */
export function goalReached(puzzle: Puzzle, play: State): boolean {
  return puzzle.goalFlags.every((flag) => play.flags.includes(flag));
}

function appendLog(state: GameState, line: Omit<LogLine, "id">): LogLine[] {
  return [...state.log, { ...line, id: state.nextLogId }];
}

/* ------------------------------------------------------------------ */
/* The reducer                                                         */
/* ------------------------------------------------------------------ */

function withNotice(state: GameState, peerId: string, text: string): GameState {
  return {
    ...state,
    notice: { peerId, text, seq: state.nextNoticeSeq },
    nextNoticeSeq: state.nextNoticeSeq + 1,
  };
}

/**
 * A decision aimed at a request that is not the one on screen. Nothing moves:
 * the request waiting for an answer stays waiting, and the room is told why the
 * press did nothing, because the request the remote was answering is gone and
 * the overlay in front of it is a different one.
 */
function staleReclaimDecision(state: GameState): GameState {
  return withNotice(state, TV_PEER, "that request is not the one on the TV any more — look, then decide");
}

function freeRoles(state: GameState): RoleId[] {
  const taken = new Set(state.players.map((p) => p.role).filter((r): r is RoleId => r !== null));
  return seatRoles(state.puzzle).filter((role) => !taken.has(role));
}

/**
 * Token reclaims queue, FIFO. Only one `pendingReclaim`
 * can be on screen at a time, but that used to mean a second genuine
 * matching-token claimant -- one blocked only because someone else's request
 * got there first -- was refused and then simply forgotten, with no way back
 * short of a reload or the hold expiring. Its
 * `claimedSeat` is what survives the block, and it is only ever set against a
 * seat somebody is PLAYING -- a seat nobody is sitting in hands itself back on
 * the token alone, without asking anybody. This walks `players` in join order
 * -- which is queue order, since nothing here ever reorders the array -- for
 * the first connected, still roleless claimant whose claimed seat is still
 * held right now. `exceptPeerId` is the request that just resolved, so a
 * decline does not immediately re-raise the very claim it just closed.
 */
function nextTokenReclaim(state: GameState, exceptPeerId?: string): PendingReclaim | null {
  for (const claimant of state.players) {
    if (claimant.peerId === exceptPeerId) continue;
    if (claimant.role !== null || !claimant.connected || claimant.claimedSeat === null) continue;
    const held = state.players.find(
      (p) => p.peerId !== claimant.peerId && p.role !== null && p.seat === claimant.claimedSeat,
    );
    if (held) {
      return mintReclaim(state, {
        peerId: claimant.peerId,
        name: held.name,
        role: held.role!,
        seat: held.seat,
        via: "token",
      });
    }
  }
  return null;
}

/**
 * Stamps a request with the fingerprint the TV decides on: who is asking, the
 * seat token they are asking for, and the room's next request number. The
 * number is what makes the two requests distinct even when the same phone asks
 * for the same seat twice in a row -- which is exactly the case a decision has
 * to be able to tell apart (`approve_reclaim`).
 */
function mintReclaim(
  state: GameState,
  request: { peerId: string; name: string; role: RoleId; seat: string | null; via?: "name" | "token" },
): PendingReclaim {
  return {
    id: `${request.peerId}:${request.seat ?? "no-seat"}:${state.nextReclaimSeq}`,
    ...request,
  };
}

/**
 * The record a request is actually about: whoever holds that role right now,
 * found by the very thing that was presented. A TOKEN request is keyed on the
 * token, which is stable across the holder's own drops and reconnections -- it
 * is raised only while somebody is playing the seat, since a token for a seat
 * nobody holds merges on the join instead. A NAME request has only the held
 * name to go on, and `reclaim_seat` raises one solely against a seat that is
 * already disconnected.
 *
 * The target is therefore CONNECTED in the token case -- that is the live-seat
 * contest this exists for -- and disconnected in the name case. Neither case
 * grants the seat on its own: `approve_reclaim` is the only thing that moves a
 * role, and for a live target it supersedes that connection rather than leaving
 * two peers under one seat.
 */
function reclaimTarget(state: GameState, request: PendingReclaim): Player | undefined {
  if (request.via === "token") {
    return state.players.find(
      (p) => p.role === request.role && p.seat !== null && p.seat === request.seat,
    );
  }
  return state.players.find(
    (p) => !p.connected && p.role === request.role && p.name === request.name,
  );
}

/** True while `request` still names someone who could actually be handed the seat right now: a connected, roleless requester, and a role somebody still holds for `reclaimTarget` to find. */
function reclaimIsValid(state: GameState, request: PendingReclaim): boolean {
  const requester = playerByPeer(state, request.peerId);
  if (!requester || !requester.connected || requester.role !== null) return false;
  return reclaimTarget(state, request) !== undefined;
}

/**
 * The seat this connection's own browser is ALREADY playing in, if any: a
 * different record that holds a role under the very token this connection
 * presented.
 *
 * This is the whole of "one browser, one role". The seat token is
 * browser-wide -- every tab of one browser reads the same token out of one
 * IndexedDB store -- which means two tabs presenting one token are not two
 * players who happen to collide, they are the same player twice. So a tab
 * whose token already backs a role is never given a second one: not by the
 * picker, not by a rejoin's automatic grant, not by a named reclaim. The only
 * way for it to end up holding that seat is the TV moving the seat to it
 * (`approve_reclaim`), which closes the older tab in the same step, so the
 * browser still holds exactly one role afterwards.
 *
 * `role !== null` is the whole of "live or held": a seat whose grace window
 * has run out is swept out of `players` entirely, so any record still
 * carrying a role is either connected or inside its grace window.
 *
 * A player with no `presentedSeat` -- a client that sent no token at all --
 * is nobody's second tab and is left alone.
 */
function seatBusyFor(
  state: GameState,
  player: { peerId: string; presentedSeat: string | null },
): Player | undefined {
  if (player.presentedSeat === null) return undefined;
  return state.players.find(
    (p) =>
      p.peerId !== player.peerId && p.role !== null && p.presentedSeat === player.presentedSeat,
  );
}

/**
 * The token a player should own, given what its phone has just presented.
 *
 * A role and a durable identity are granted together, never apart: a live
 * role on a record nothing can recognise coming back is a role reclaimable by
 * nobody. So ownership follows the browser's own store -- the presented token
 * -- whenever nothing else carries it.
 *
 * "Whenever nothing else carries it" is the whole of the caution. A claimant
 * presents a token another record already holds; it must stay empty-handed
 * while it waits, and keeps whatever it had. And a record that has been
 * sitting roleless under a token its browser has since ROTATED AWAY FROM must
 * not keep that stale token either. The storage-and-reducer property fuzz
 * pins that one (seed 84): such a record was later given a role, and the seat
 * it then held was backed by a token no browser's store had any more -- a
 * held role nothing could ever reclaim.
 */
function durableSeatFor(
  state: GameState,
  player: { peerId: string; seat: string | null },
  presentedSeat: string | null,
  alsoSelf?: string,
): string | null {
  if (presentedSeat === null) return player.seat;
  // Only a record that HOLDS A ROLE under this token blocks it. A roleless
  // record carrying it is another tab of the same browser with nothing
  // staked on it, and `releaseSeatToken` (below) takes it off that record in
  // the same step -- otherwise the tab that actually got the role would end
  // up holding it under nothing, which is a role nobody can reclaim.
  const heldByAnother = state.players.some(
    (p) =>
      p.peerId !== player.peerId &&
      p.peerId !== alsoSelf &&
      p.role !== null &&
      p.seat === presentedSeat,
  );
  return heldByAnother ? player.seat : presentedSeat;
}

/**
 * Takes a token off every OTHER roleless record that was carrying it, so at
 * most one record ever does (I13, and the "one live connection per seat"
 * rule it states). Always paired with `durableSeatFor` granting that same
 * token to `keeper`: between them, adopting a token is a move, never a copy.
 * A record holding a ROLE is never touched here -- `durableSeatFor` refuses
 * to hand out a token one of those is using in the first place.
 */
function releaseSeatToken(players: Player[], token: string | null, keeper: string): Player[] {
  if (token === null) return players;
  if (!players.some((p) => p.peerId !== keeper && p.role === null && p.seat === token)) {
    return players;
  }
  return players.map((p) =>
    p.peerId !== keeper && p.role === null && p.seat === token ? { ...p, seat: null } : p,
  );
}

/**
 * Clears a player's claim -- and, defensively, its own `seat` if that has
 * somehow come to equal the very token being claimed.
 *
 * `player_joined` never writes a contested token into a claimant's own `seat`
 * (the claim lives in `claimedSeat` alone), so the second half is a
 * belt-and-braces guard rather than a path anything reaches. It
 * stays because the failure it prevents is silent and expensive: a `seat`
 * left pointing at somebody else's token makes this record a false match for
 * a future presentation of it, so a genuine reconnect could resolve against
 * this stale, unrelated player instead of the seat that is really held.
 * A `seat` of the player's own is untouched.
 */
function releaseClaim(p: Player): Player {
  if (p.claimedSeat === null) return p;
  return p.seat === p.claimedSeat ? { ...p, claimedSeat: null, seat: null } : { ...p, claimedSeat: null };
}

/**
 * One normalisation step -- every action passes through this,
 * unconditionally, after `reduceIntent` runs (see `reduce`, above). Two
 * jobs, always in this order:
 *
 * 1. Clear a `claimedSeat` whose target is no longer there to contest.
 *    `player_joined`'s own `claimedSeat` is deliberately sticky (a
 *    repeated `join` from an active claimant must not silently drop or
 *    overwrite it) -- nothing sets it back to `null` at the
 *    site that resolves the contest, on purpose, so this is the one place
 *    that actually clears it: once the seat it names has been approved,
 *    swept, never existed, or -- the case a name-based and a token-based
 *    claim landing on the very same seat used to miss -- is now held by
 *    nobody at all, the claim is stale and the player is freed to pick an
 *    ordinary role again. A claim is only ever raised against a seat somebody
 *    is playing (a seat nobody is playing hands itself back on the token
 *    alone, without a request), so the seat going still -- by approval, by a
 *    sweep, or by the holder's own token-return moving it -- is what ends the
 *    contest; a seat still played by anyone is a live contest, and every
 *    OTHER stray claim naming the same token is moot, never a second seat to
 *    hand out.
 *
 *    A holder that has DROPPED still counts as holding: a seat inside its
 *    grace window is kept for whoever comes back to it, and its record is
 *    still the one a token matches. So a claim against it is not stale, and
 *    this step leaves it standing. Only the TV's answer or the claimant's own
 *    next presentation of the token can end it: a role moves between peer ids
 *    on a join or an approval, never on a drop (I5).
 * 2. Recompute `pendingReclaim` from that (possibly just-cleared) state:
 *    keep it if it still names a connected, roleless requester and a
 *    still-held seat (`reclaimIsValid`, invariant I4); otherwise raise the
 *    next queued token claimant, in join order, if one exists. This is what
 *    closes two holes directly: a dropped front requester and a swept
 *    front reclaim both leave `pendingReclaim` invalid, and this step -- run after *every*
 *    action, not just those two -- is what notices and re-raises the queue
 *    behind them without either call site having to remember to.
 */
function normalizeReclaimQueue(state: GameState): GameState {
  let playersChanged = false;
  const players = state.players.map((p) => {
    if (p.claimedSeat === null) return p;
    const stillHeld = state.players.some(
      (h) => h.peerId !== p.peerId && h.seat === p.claimedSeat && h.role !== null,
    );
    if (stillHeld) return p;
    playersChanged = true;
    return releaseClaim(p);
  });
  const cleared: GameState = playersChanged ? { ...state, players } : state;

  const current = cleared.pendingReclaim;
  const pendingReclaim =
    current !== null && reclaimIsValid(cleared, current) ? current : nextTokenReclaim(cleared);
  if (pendingReclaim === current) return cleared;
  // A request raised here is a NEW request, whatever it is for: it takes the
  // next fingerprint, so the id the TV was showing a moment ago names the
  // request that just went away and nothing else.
  return {
    ...cleared,
    pendingReclaim,
    nextReclaimSeq: pendingReclaim === null ? cleared.nextReclaimSeq : cleared.nextReclaimSeq + 1,
  };
}

/**
 * Every intent is valid only in the phase it belongs to.
 * These two sets are only the columns that actually restrict anything; the
 * full phase x intent table is walked cell by cell in the tests.
 *
 * A puzzle action, an option pick, and cancelling a pending one are refused
 * once a rebuild is in flight: the board a phone or the remote is looking at
 * is about to be replaced by `resolveSwitch`'s request-time snapshot, so
 * acting on it now would either vanish or
 * -- for a picker already open -- resolve against a puzzle that is no longer
 * current. They are otherwise phase-independent: a d-pad press with nobody
 * seated yet still deserves "not joined yet", not silence (`describe(
 * "refusing a move at the table")`), and the goal state naturally has
 * nothing left to offer.
 *
 * `request_input_change` is stricter still -- it only ever makes sense while
 * the game is actually on, lobby included, not just outside a rebuild: one
 * connected player could otherwise request a rebuild straight from the lobby,
 * before anyone else had even joined.
 *
 * Everything else the reducer accepts -- players joining, leaving, being
 * swept, picking or giving up a role, a name/token reclaim and the TV's
 * decision on one, the switch's own beats, choosing a mystery, and clearing
 * a notice -- is phase-independent by design: a connection's own lifecycle
 * and the TV's seat bookkeeping do not wait for the puzzle to be in any
 * particular state, and each already carries its own narrower guard inside
 * its case (a stale reclaim, an already-taken role, a picker whose performer
 * dropped, and so on).
 */
const BLOCKED_WHILE_SWITCHING: ReadonlySet<GameAction["k"]> = new Set([
  "choose_action",
  "choose_option",
  "cancel_choice",
  "request_input_change",
]);

const PLAYING_ONLY_INTENTS: ReadonlySet<GameAction["k"]> = new Set(["request_input_change"]);

/** The one predicate the two sets above back -- exported so the table-driven test can walk it against every phase without duplicating the lists. */
export function phaseAcceptsIntent(phase: Phase, intent: GameAction["k"]): boolean {
  if (PLAYING_ONLY_INTENTS.has(intent)) return phase === "playing";
  if (BLOCKED_WHILE_SWITCHING.has(intent)) return phase !== "switching";
  return true;
}

/**
 * The reclaim queue kept going stale because recomputing it was spread
 * across every site that could invalidate it -- a drop, a sweep, an
 * approval, a decline -- and patching those sites one at a time only ever
 * closed the one that had just been noticed. `reduce` now runs every action
 * through `reduceIntent` -- the switch below -- and then through this ONE
 * normalisation step, unconditionally, so no call site has to remember to do
 * it itself again.
 */
export function reduce(state: GameState, action: GameAction): GameState {
  // The single gate every intent passes through before its own case runs
  // -- a phase this table rejects for this intent leaves
  // the state exactly as it was, never reaching the case below.
  if (!phaseAcceptsIntent(state.phase, action.k)) return state;
  const result = reduceIntent(state, action);
  return result === state ? state : normalizePendingSwitch(normalizeReclaimQueue(result));
}

/**
 * The reclaim queue's own lesson, applied to the
 * switch. A pending switch is valid only while the seat that asked for it
 * still holds the role (I9); that can stop being true when a grace window
 * expires, when a role is let go, or when a seat is handed to a different
 * phone -- and patching those sites one at a time is exactly how the reclaim
 * queue went stale three rounds running. So every action's result goes through
 * this, unconditionally, and `resolveSwitch` is left to decide only the one
 * thing this deliberately tolerates: a seat still inside its grace window,
 * whose request waits with it.
 */
function normalizePendingSwitch(state: GameState): GameState {
  const record = state.pendingSwitch;
  if (!record || switchIsStillOurs(state, record)) return state;
  return cancelSwitch(state, record, "changed");
}

function reduceIntent(state: GameState, action: GameAction): GameState {
  switch (action.k) {
    case "room":
      return { ...state, room: action.room };

    case "choose_mystery":
      return chooseMystery(state, action.mysteryId);

    case "player_joined": {
      // A phone that dropped and came back is a *new peer id* on the same seat,
      // so the seat is what identifies it. Without that, "reconnecting" would
      // silently mean "joining as somebody else" and the grace period below
      // would have nothing to hold the role for.
      //
      // A seat's own record is the one that HOLDS A ROLE under this token.
      // I2 makes at most one of those exist, so this is unambiguous, and
      // preferring it means a stray roleless record carrying the same token
      // can never stand in for the seat the token is actually about.
      const bySeatCandidate =
        action.seat === undefined
          ? undefined
          : state.players.find((p) => p.seat !== null && p.seat === action.seat && p.role !== null) ??
            state.players.find((p) => p.seat !== null && p.seat === action.seat && p.connected) ??
            state.players.find((p) => p.seat !== null && p.seat === action.seat);
      const byOtherPeer = bySeatCandidate !== undefined && bySeatCandidate.peerId !== action.peerId;
      // A token that a DIFFERENT peer id holds a role under WHILE THAT
      // CONNECTION IS STILL THERE is somebody's seat, and a seat being played
      // right now is never handed over on the strength of a frame. Nothing on
      // the wire can tell "the same browser, reopened" apart from a token
      // replayed by somebody who intercepted it, so this does not guess: it
      // asks. The live connection keeps the role, this one is roleless with a
      // claim, and the TV remote's own approval is the only thing that moves
      // the seat (`approve_reclaim`, below), superseding the older connection
      // in the same step.
      //
      // `connected` is what separates that from a RETURN. A seat whose holder
      // has dropped is a chair nobody is sitting in, held only so its owner
      // can come back to it -- and the token this connection just presented is
      // the one thing that says whose chair it is. Asking the TV to approve
      // that is asking it to answer a question the token already answered, at
      // the cost of a walk to the remote for a player who did nothing but
      // reload. So a return merges below, exactly as an ordinary reconnect
      // does. What this cannot be is a way to TAKE a seat: the token still has
      // to be the seat's own, and while anyone is playing it this branch is
      // unreachable.
      //
      // The peer id that is ALREADY this seat's own connection (the relay
      // resending `join`, a phone picking a role right after minting its
      // token) is not presenting anybody else's token and stays automatic
      // through `playerByPeer` below.
      const seatHeldByOtherPeer =
        byOtherPeer && bySeatCandidate!.role !== null && bySeatCandidate!.connected;
      // A record carrying this token that holds NO role is not a seat: there
      // is nothing to take from it and nothing for the TV to decide, so a
      // newer connection replaces it outright rather than queueing for an
      // answer that could never come. That is what keeps I13 -- one
      // connected player per token -- true for the two-tabs-of-one-browser
      // case that never reaches a role. The older connection is told, so it
      // stops sitting on a socket the TV has already moved past.
      const supersedes = byOtherPeer && bySeatCandidate!.role === null && bySeatCandidate!.connected;
      const bySeat = seatHeldByOtherPeer ? undefined : bySeatCandidate;
      // A name typed on the ordinary join form is never enough on its own to
      // take a held seat any more -- a name is public, not a secret, and
      // silently granting it let anyone who knew (or forged) it steal a
      // dropped role. Recovering a seat by name is now its own deliberate
      // action (`reclaim_seat`) that the TV must approve; a plain join with
      // a name that happens to collide just lands this peer in the ordinary
      // "pick a role" flow, same as any other newcomer.
      const ownRecord = playerByPeer(state, action.peerId);
      // A claim is a contest with somebody who is PLAYING the seat. Once that
      // holder has gone there is nothing left to contest: the chair is empty,
      // and the token this connection is presenting is the one thing that says
      // whose chair it is. So a claimant whose seat's holder has dropped is not
      // reclaiming any more -- it is RETURNING, and a return merges into the
      // seat's own record exactly as a phone that merely reloaded does.
      //
      // This is needed at all only because `claimedSeat` is sticky: without it
      // a claimant's repeated `join` reads as an ordinary reconnect and the
      // claim it is carrying stays open against a seat nobody is playing, so
      // the room waits on the remote to answer a question the token already
      // answered. The holder has to be the very record this join's token names
      // -- a claim is for one seat, and a drop somewhere else hands this
      // connection nothing.
      //
      // What moves is a role whose holder has gone, taken back on a JOIN: the
      // only thing besides the TV's own approval that may move one (I5), and
      // it supersedes nobody, because the connection it moves from is already
      // gone.
      const claimIsReturn =
        ownRecord !== undefined &&
        ownRecord.claimedSeat !== null &&
        bySeat !== undefined &&
        bySeat.role !== null &&
        bySeat.seat === ownRecord.claimedSeat &&
        !bySeat.connected;
      const existing = (claimIsReturn ? bySeat : undefined) ?? ownRecord ?? bySeat;
      // Adopting the seat's own record leaves this connection's claimant
      // record behind. It holds no role, its claim is the thing being
      // resolved, and it is the same peer id as the record taking over -- so
      // it goes, rather than sitting there as a second record under one id.
      const adoptingOwnRecord = claimIsReturn && ownRecord !== undefined ? ownRecord.peerId : null;
      // Whether this join actually TAKES OVER a live seat, as opposed to
      // merely colliding with one while this connection already has its own
      // identity: an already-seated peer's own token happening to match
      // somebody else's live seat changes nothing about either seat, and
      // must never tell that somebody else's connection it has been
      // superseded when it plainly has not.
      const supersedesOther = ownRecord === undefined && supersedes;
      const rejoined = existing !== undefined && existing.connected === false;
      const free = freeRoles(state);
      const wanted = action.want && free.includes(action.want) ? action.want : undefined;
      // A token match on a LIVE ROLE waits for the TV's OK, below -- it does
      // not fall through to an unrelated free role in the meantime, and it is
      // never superseded automatically: `seatHeldByOtherPeer` (above) is what
      // keeps `bySeat` empty for it. What DOES merge through `bySeat` like an
      // ordinary reconnect is a token for a seat nobody is playing -- the
      // RETURN case, where there is no TV decision to wait on -- and, on the
      // `supersedes` branch, a ROLELESS duplicate of the presenting
      // connection's own browser, which has no role to take and so nothing to
      // ask about either. `ownRecord` is this exact connection's own prior
      // identity, and colliding with somebody else's seat must never cost an
      // already-seated player its own role.
      const crossPeerCollision = ownRecord === undefined && seatHeldByOtherPeer;
      // `claimedSeat` is sticky: once this peer is a claimant -- whether from
      // a brand new collision just below, or one carried over from an
      // earlier `join` under this same peer id -- it survives every later
      // `join` untouched until `normalizeReclaimQueue` (below `reduce`)
      // decides the contest is actually over. Without this, a claimant's
      // *repeated* `join` reads as an ordinary reconnect (`ownRecord` is
      // already defined, so `crossPeerCollision` is false) and would fall
      // through to the same free-role grant and seat assignment an
      // uncontested newcomer gets -- handing a claimant a role before the TV
      // ever decided, and copying the contested token into this player's own
      // `seat`, which is exactly the one-live-holder-per-token rule (I13).
      const claimedSeat = crossPeerCollision ? action.seat! : (existing?.claimedSeat ?? null);
      const blockedClaim = claimedSeat !== null;
      // What this connection's own browser store held when it joined, kept
      // whether or not the room decides this peer owns the seat behind it.
      // A join that carries no token at all leaves whatever this peer id
      // presented before untouched: a reconnect is the same browser, and
      // forgetting that is how a second tab used to come back as a stranger.
      //
      // A player already SEATED under a token of its own never re-labels
      // itself, for the same reason its `seat` is immutable: a later join
      // carrying somebody else's token proves nothing except that this
      // connection can send it. Letting it through would let any phone
      // relabel itself as the victim's browser and, through the one-role rule
      // below, lock the victim out of reconnecting to its own seat.
      const existingSeat = existing?.seat ?? null;
      // A role holder that already has a token -- its own `presentedSeat`,
      // bound once and never since -- never re-labels itself: a later join
      // carrying somebody else's token proves nothing except that this
      // connection can send it. One with NEITHER a seat NOR a presented
      // token yet -- a legacy or scripted peer that has always joined
      // tokenless -- may still bind the very first genuine token it
      // presents, but only when that token is not already owned or
      // presented by any OTHER role holder, live or held: anything
      // colliding is refused, same as a foreign relabel attempt, and
      // leaves this holder tokenless rather than handing it a seat nobody
      // else can tell apart from theft.
      const seatedAlready = existing?.role != null;
      const boundToken = existing?.presentedSeat ?? null;
      const firstToken =
        seatedAlready && boundToken === null && action.seat !== undefined ? action.seat : null;
      const firstTokenTaken =
        firstToken !== null &&
        state.players.some(
          (p) =>
            p.peerId !== action.peerId &&
            p.role !== null &&
            (p.seat === firstToken || p.presentedSeat === firstToken),
        );
      const presentedSeat = seatedAlready
        ? (firstToken !== null && !firstTokenTaken ? firstToken : boundToken)
        : (action.seat ?? existing?.presentedSeat ?? null);
      // One browser, one role (`seatBusyFor`). `existing` is excluded because
      // an ordinary reconnect finds its OWN seat this way -- that record is
      // this connection, not another tab of it.
      const browserPlaying =
        presentedSeat === null
          ? undefined
          : state.players.find(
              (p) =>
                p.peerId !== action.peerId &&
                p.peerId !== existing?.peerId &&
                p.role !== null &&
                p.presentedSeat === presentedSeat,
            );
      // A role already held is never taken away by this rule -- it only ever
      // withholds a NEW one. An already-seated peer whose token happens to
      // collide with somebody else's seat keeps what it has; what it does not
      // get is a second seat on top.
      const role = blockedClaim
        ? null
        : (existing?.role ?? (browserPlaying !== undefined ? null : (wanted ?? free[0] ?? null)));
      const name = action.name?.slice(0, 24) ?? existing?.name ?? "";
      // A seat, once minted, is this player's permanent identity -- it is
      // never replaced by whatever a later `join` happens to carry, so an
      // identity this room already knows keeps the token it already had.
      // A connection that is merely CLAIMING somebody else's seat carries
      // nothing: the contested token is recorded in `claimedSeat` alone, and
      // never copied into `seat`. That is what makes I13 -- one connected
      // player per token -- hold while the claim is pending, which an earlier version
      // could only manage by taking the seat outright; it is also what lets
      // a further connection presenting the same token find the SEAT rather
      // than the claimant, and so queue behind it instead of displacing it.
      // `approve_reclaim` hands the token over with the role, from the
      // record that actually had it.
      // A player HOLDING A ROLE UNDER A TOKEN keeps that token, full stop:
      // moving it would be moving the only thing that can reclaim the role.
      // Everyone else follows their own browser's store (`durableSeatFor`) --
      // so a roleless record never drags a token its browser has rotated away
      // from into a later role, and a role that somehow has no token at all
      // picks one up rather than staying unreclaimable.
      const seat =
        existing?.role != null && existingSeat !== null
          ? existingSeat
          : durableSeatFor(
              state,
              { peerId: action.peerId, seat: existingSeat },
              presentedSeat,
              existing?.peerId,
            );
      const survivors =
        adoptingOwnRecord === null
          ? state.players
          : state.players.filter((p) => p.peerId !== adoptingOwnRecord);
      const joinedPlayers = existing
        ? survivors.map((p) =>
            p.peerId === existing.peerId
              ? {
                  ...p,
                  peerId: action.peerId,
                  name,
                  role,
                  connected: true,
                  seat,
                  claimedSeat,
                  presentedSeat,
                  disconnectedAt: null,
                }
              : p,
          )
        : [
            ...survivors,
            {
              peerId: action.peerId,
              name,
              role,
              connected: true,
              seat,
              claimedSeat,
              presentedSeat,
              disconnectedAt: null,
            },
          ];
      // Adopting a token is a move, not a copy: whatever roleless record was
      // carrying it lets go in the same step.
      const players = releaseSeatToken(joinedPlayers, seat, action.peerId);
      // A returning phone is a new peer id, so anything keyed by the old one --
      // a half-made choice and which page of options it was on -- has to move
      // with it, or the phone comes back to a choice the TV no longer knows
      // about and the old entry never goes away.
      const pending = { ...state.pending };
      const pages = { ...state.pages };
      if (existing && existing.peerId !== action.peerId) {
        const heldChoice = pending[existing.peerId];
        if (heldChoice !== undefined) {
          pending[action.peerId] = heldChoice;
          delete pending[existing.peerId];
        }
        const heldPage = pages[existing.peerId];
        if (heldPage !== undefined) {
          pages[action.peerId] = heldPage;
          delete pages[existing.peerId];
        }
      }
      // A claimant record that has just been absorbed leaves its own entries
      // behind: this connection is the seat's record now, and a half-made
      // choice keyed by an id that no longer exists is an entry nothing will
      // ever clear.
      if (adoptingOwnRecord !== null && adoptingOwnRecord !== action.peerId) {
        delete pending[adoptingOwnRecord];
        delete pages[adoptingOwnRecord];
      }
      // When nobody could be seated, say why rather than just that they
      // weren't: a role held for someone who stepped away is not the same
      // fact as a room that is genuinely full, and the difference is exactly
      // what a returning player -- or the family reading the TV -- needs to
      // hear. A refused join says why, and never blames the player.
      const heldForSomeoneElse = state.players.some((p) => !p.connected && p.role !== null);
      // A token matching a LIVE seat raises the request automatically -- nobody
      // has to type anything -- but it never displaces a reclaim already
      // waiting for a different requester; that one keeps its place in line
      // and this peer is told so, below. The actual raising is
      // `normalizeReclaimQueue`'s job now -- this join only needs to know
      // whether to tell THIS peer it is waiting behind someone else, which
      // `heldTokenFromNewcomer` and `tokenReclaimBlocked` are still the right
      // read of the PRE-join state for. Same guard as `crossPeerCollision`
      // above: an already-seated peer resending `join` with a live seat's
      // token is not a reconnect for THAT seat either, and must not raise a
      // reclaim offering its own connection somebody else's role.
      const heldTokenFromNewcomer = ownRecord === undefined && seatHeldByOtherPeer;
      const tokenReclaimBlocked =
        heldTokenFromNewcomer && state.pendingReclaim !== null && state.pendingReclaim.peerId !== action.peerId;
      const next: GameState = {
        ...state,
        players,
        pending,
        pages,
        log: appendLog(state, {
          kind: "system",
          role,
          text: supersedesOther
            ? `${name || "a player"} came back on a newer connection — the earlier one was closed`
            : rejoined
              ? role
                ? `${name || "a player"} is back — they still have ${role}`
                : `${name || "a player"} is back, but their role was let go`
              : role
                ? `${name || "a player"} joined as ${role} (${roleCapabilities(state.puzzle, role)
                    .join(" + ")})`
                : heldForSomeoneElse
                  ? `${name || "a player"} arrived, but every seat is taken — one is being held for someone who stepped away`
                  : `${name || "a player"} joined, but every role is taken`,
        }),
        nextLogId: state.nextLogId + 1,
        // The OLD peer id is gone from `players` the instant this merge runs
        // (its record was renamed onto `action.peerId` above), so this is
        // its only remaining address: the TV's own outbound effect reads
        // this to tell that connection it is done.
        ...(supersedesOther
          ? {
              superseded: { peerId: bySeatCandidate!.peerId, seq: state.nextSupersededSeq },
              nextSupersededSeq: state.nextSupersededSeq + 1,
            }
          : {}),
      };
      const result: GameState = { ...next, phase: nextPhase(next) };
      if (tokenReclaimBlocked) {
        return withNotice(result, action.peerId, "another reclaim is already waiting for the TV");
      }
      return result;
    }

    case "player_left": {
      const player = playerByPeer(state, action.peerId);
      if (!player) return state;
      // A relay that says "gone" twice must not restart the clock.
      if (!player.connected) return state;
      // A reclaim the TV has not yet acted on is a request FROM this
      // connection -- once it drops, approving it would hand the role to a
      // peer id nobody is behind any more. Whether that
      // leaves the queue stranded is
      // `normalizeReclaimQueue`'s job now, not this case's -- it runs on every
      // action's result and reads `pendingReclaim` fresh either way, so a
      // stale requester here (this drop is theirs) or an already-waiting
      // claimant for the seat that just went held (a connected, roleless
      // `claimedSeat` match, same as `player_joined`'s `heldByOtherPeer`)
      // both resolve the same way whether this case decides them explicitly
      // or `normalizeReclaimQueue` does. It does not have to sit through the grace
      // window to be raised: `normalizeReclaimQueue` reads `players` as they stand
      // right after this drop, and the seat becomes `!connected` in the very
      // same update below.
      return {
        ...state,
        players: state.players.map((p) =>
          p.peerId === action.peerId
            ? { ...p, connected: false, disconnectedAt: action.at }
            : p,
        ),
        log: appendLog(state, {
          kind: "system",
          role: player.role,
          text: `${player.name || player.role || "a player"} dropped out${
            player.role ? ` — ${player.role} is held for ${gracePhrase()}` : ""
          }`,
        }),
        nextLogId: state.nextLogId + 1,
      };
    }

    case "peers_present": {
      // Every phone this TV is counting as connected but the relay does not
      // list is not in the room any more, whatever this TV last heard. The
      // repair is deliberately the ordinary drop, run once per phone, rather
      // than a second way to leave: the grace window, the sweep and the log
      // line are the ones a `player_left` gets, so a seat that goes absent
      // this way comes back exactly like any other.
      const present = new Set(action.peerIds);
      let missing = state;
      for (const player of state.players) {
        if (!player.connected || present.has(player.peerId)) continue;
        missing = reduce(missing, { k: "player_left", peerId: player.peerId, at: action.at });
      }
      return missing;
    }

    case "sweep_seats": {
      const expired = state.players.filter(
        (p) =>
          !p.connected &&
          p.disconnectedAt !== null &&
          action.at - p.disconnectedAt >= SEAT_GRACE_MS,
      );
      if (expired.length === 0) return state;
      const gone = new Set(expired.map((p) => p.peerId));
      // The player goes with the seat: what is left is not a player any more,
      // just a connection the relay has already forgotten.
      // The seat goes, and so does everything that was keyed to that phone.
      const sweptPending = { ...state.pending };
      const sweptPages = { ...state.pages };
      for (const peerId of gone) {
        delete sweptPending[peerId];
        delete sweptPages[peerId];
      }
      // A reclaim waiting for the TV's OK is asking for a seat that no longer
      // exists once its hold expires -- `normalizeReclaimQueue` (below `reduce`)
      // is what actually closes it now. This case only has to remove the expired players
      // themselves; the swept seat's own record is gone from `players`
      // either way, which is what `normalizeReclaimQueue` reads to tell a stale
      // reclaim from a live one.
      const next: GameState = {
        ...state,
        players: state.players.filter((p) => !gone.has(p.peerId)),
        pending: sweptPending,
        pages: sweptPages,
      };
      let logged = next;
      for (const player of expired) {
        if (!player.role) continue;
        logged = {
          ...logged,
          log: appendLog(logged, {
            kind: "system",
            role: player.role,
            text: `${player.name || player.role} was away for ${gracePhrase()}, so ${
              player.role
            } is free again`,
          }),
          nextLogId: logged.nextLogId + 1,
        };
      }
      return logged;
    }

    case "assign_role": {
      const player = playerByPeer(state, action.peerId);
      if (!player) return state;
      if (player.role === action.role) return state;
      // A player with a live claim on someone else's seat is not free to
      // pick a role of their own until the TV decides that claim.
      // `assign_role` (and the phone-facing `choose_role` that maps to it,
      // app.tsx:192) would otherwise grant a role to a claimant mid-collision
      // or mid-reclaim just like an ordinary player, letting it act before
      // the TV ever ruled. Invariant I1 says a
      // `claimedSeat` player never holds a role; this is the other half of
      // that -- `player_joined` never grants one either, so nothing that reaches a live game with a role
      // gets there while still contested.
      if (player.claimedSeat !== null) {
        return withNotice(state, action.peerId, "wait for the TV to resolve your reclaim first");
      }
      // The wire's role vocabulary (A/B/C) is wider than any one mystery's
      // own seats -- a two-seat mystery seats only A and B, and `state.puzzle`
      // is the only place that is known. Without this, a role outside the
      // current mystery's own seats would pass every other check here (nobody
      // else can ever hold it, so it never reads as "already taken") and land
      // a player in a seat the puzzle has no role for at all.
      if (!seatRoles(state.puzzle).includes(action.role)) {
        return withNotice(state, action.peerId, `${action.role} is not a role in this mystery`);
      }
      if (state.players.some((p) => p.role === action.role && p.peerId !== action.peerId)) {
        return withNotice(state, action.peerId, `${action.role} is already taken`);
      }
      // One browser, one role. A declined claim clears `claimedSeat` above,
      // so the check that let this peer through is no longer enough on its
      // own: the browser it belongs to can still be playing in another tab,
      // and this is the picker that used to hand it a second seat.
      const busy = seatBusyFor(state, player);
      if (busy) {
        return withNotice(
          state,
          action.peerId,
          `this phone is already playing as ${busy.role} in another tab`,
        );
      }
      // A role and a durable identity are granted together, never apart. A
      // claimant carries no `seat` of its own while it waits (the contested
      // token lives in `claimedSeat` alone), so seating one without this
      // would leave a live role on a record nothing can recognise coming
      // back -- and that role would then be reclaimable by nobody. The token
      // taken here is the one this phone's own store already holds, and
      // `busy` above has just established that no seat stands behind it.
      const adopted = durableSeatFor(state, player, player.presentedSeat);
      const next: GameState = {
        ...state,
        players: releaseSeatToken(
          state.players.map((p) =>
            p.peerId === action.peerId ? { ...p, role: action.role, seat: adopted } : p,
          ),
          adopted,
          action.peerId,
        ),
      };
      return {
        ...next,
        log: appendLog(next, {
          kind: "system",
          role: action.role,
          text: player.role
            ? `${player.name || player.role} moved from ${player.role} to ${action.role}`
            : `${player.name || "a player"} took ${action.role}`,
        }),
        nextLogId: next.nextLogId + 1,
      };
    }

    case "release_role": {
      const player = playerByPeer(state, action.peerId);
      if (!player) return withNotice(state, action.peerId, "you have not joined yet");
      if (!player.role) return withNotice(state, action.peerId, "you do not have a role to give up");
      const pending = { ...state.pending };
      delete pending[action.peerId];
      const pages = { ...state.pages };
      delete pages[action.peerId];
      const next: GameState = {
        ...state,
        players: state.players.map((p) =>
          p.peerId === action.peerId ? { ...p, role: null } : p,
        ),
        pending,
        pages,
      };
      return {
        ...next,
        log: appendLog(next, {
          kind: "system",
          role: player.role,
          text: `${player.name || player.role} gave up ${player.role} to pick again`,
        }),
        nextLogId: next.nextLogId + 1,
      };
    }

    case "release_claim": {
      const mine = playerByPeer(state, action.peerId);
      if (!mine) return withNotice(state, action.peerId, "you have not joined yet");
      if (mine.claimedSeat === null) {
        return withNotice(state, action.peerId, "you are not waiting on a seat");
      }
      // The claim goes, and so does the request it raised -- if the seat it
      // names is still held and this phone was the one at the front of the
      // queue, that request is now about a phone that has said it is not
      // coming. Leaving it up would ask the TV to hand a seat to somebody who
      // has just walked away from it.
      const players = state.players.map((p) =>
        p.peerId === action.peerId ? releaseClaim(p) : p,
      );
      const next: GameState = {
        ...state,
        players,
        pendingReclaim:
          state.pendingReclaim?.peerId === action.peerId ? null : state.pendingReclaim,
      };
      return withNotice(
        next,
        action.peerId,
        "that seat is not yours any more — pick a role, or reclaim one by name",
      );
    }

    case "reclaim_seat": {
      const name = action.name.slice(0, 24).trim();
      if (name === "") {
        return withNotice(state, action.peerId, "enter the name you joined with to reclaim a seat");
      }
      // A peer the room has never heard from is not a returning player, just
      // a bare credential -- reclaiming is something an arrived player does,
      // never a stranger's first message.
      const mine = playerByPeer(state, action.peerId);
      if (!mine) {
        return withNotice(state, action.peerId, "join the room before you can reclaim a seat");
      }
      if (mine.role !== null) {
        return withNotice(state, action.peerId, "give up your current role before taking another one");
      }
      // A player already mid a TOKEN claim (`claimedSeat`) must settle that
      // one before raising an unrelated NAME claim on a different seat --
      // found by fuzzing (seed 158, step 41): nothing here checked this, so a
      // token-collision claimant could raise a second, unrelated
      // `reclaim_seat` for a different held role, and if the TV approved
      // THAT one, `approve_reclaim`'s merge kept the requester's own
      // (still-contested) `seat`, landing a live role on a player who still
      // carried the same token as the seat it was originally colliding
      // with -- two role-holders sharing one seat token, I2's own
      // violation. Same rule `assign_role` already enforces (reducer.ts
      // "wait for the TV to resolve your reclaim first"), extended here.
      if (mine.claimedSeat !== null) {
        return withNotice(state, action.peerId, "wait for the TV to resolve your reclaim first");
      }
      // One browser, one role, on this route too. A name is how a phone that
      // has lost its token asks for a seat back -- but a tab whose browser is
      // still playing has not lost anything, and a reclaim approved here
      // would seat the same browser twice under two different tokens.
      const busySeat = seatBusyFor(state, mine);
      if (busySeat) {
        return withNotice(
          state,
          action.peerId,
          `this phone is already playing as ${busySeat.role} in another tab`,
        );
      }
      // Only a role that is actually being held right now -- disconnected,
      // inside its grace window -- can be claimed this way. A live role, and
      // a role nobody has touched, both fall through to "no held seat" below.
      const held = state.players.find((p) => !p.connected && p.role !== null && p.name === name);
      if (!held) {
        return withNotice(
          state,
          action.peerId,
          `no held seat is waiting for "${name}" — pick a role instead`,
        );
      }
      if (state.pendingReclaim && state.pendingReclaim.peerId !== action.peerId) {
        return withNotice(state, action.peerId, "another reclaim is already waiting for the TV");
      }
      // A name is public, not proof -- it only ever raises a request now. The
      // TV remote's own OK is what actually hands the seat back
      // (`approve_reclaim`, below).
      return withNotice(
        {
          ...state,
          pendingReclaim: mintReclaim(state, {
            peerId: action.peerId,
            name: held.name,
            role: held.role!,
            seat: held.seat,
          }),
          nextReclaimSeq: state.nextReclaimSeq + 1,
        },
        action.peerId,
        `waiting for the TV to hand ${held.role} back to you`,
      );
    }

    case "approve_reclaim": {
      const request = state.pendingReclaim;
      if (!request) return state;
      // The decision is about the request the remote was SHOWN, by id. If the
      // queue has moved on since -- the request this press was aimed at was
      // replaced, most often because the phone that raised it dropped and a
      // queued claimant was promoted into its place -- then the press decides
      // nothing. Applying it to whoever the queue promoted instead is how a
      // stale press used to hand a held seat to a phone the TV never judged.
      if (request.id !== action.requestId) return staleReclaimDecision(state);
      const held = reclaimTarget(state, request);
      const requester = playerByPeer(state, request.peerId);
      // The hold could have expired, or the role could have been let go,
      // while the TV's approval was still on screen -- there is nothing left
      // to hand over, so the request just closes. Same when the requester
      // itself is no longer there: `player_left` already clears a pending
      // reclaim the instant its own peer drops, but a stale requester is
      // checked again here too, so approval can never hand a role to a peer
      // id nobody is behind. And defensively, a requester that somehow already holds a
      // role -- `assign_role` is supposed to refuse that while `claimedSeat`
      // is set, but this is the last gate before a role actually moves --
      // is treated exactly the same as a stale one, never handed a second
      // role on top of its own.
      if (!held || !requester || !requester.connected || requester.role !== null) {
        return { ...state, pendingReclaim: null };
      }
      // One browser, one role, checked again HERE rather than only where the
      // request was raised: an approval sits on the TV until somebody presses
      // it, and in between, another tab of the requester's own browser can
      // have taken a seat. The seat this request is FOR is the one exception,
      // and it is the whole point of the handoff -- that record is removed in
      // the same step, so the browser still ends up holding exactly one role.
      const alreadyPlaying = seatBusyFor(state, requester);
      if (alreadyPlaying && alreadyPlaying.peerId !== held.peerId) {
        return { ...state, pendingReclaim: null };
      }
      // Whatever the held seat had half-picked before it dropped moves with
      // it, same as an ordinary reconnect and same as a live second-tab
      // promotion -- an approved reclaim must not be the one path that
      // silently drops it.
      const pending = { ...state.pending };
      const pages = { ...state.pages };
      const heldChoice = pending[held.peerId];
      delete pending[held.peerId];
      delete pending[requester.peerId];
      if (heldChoice !== undefined) pending[requester.peerId] = heldChoice;
      const heldPage = pages[held.peerId];
      delete pages[held.peerId];
      delete pages[requester.peerId];
      if (heldPage !== undefined) pages[requester.peerId] = heldPage;
      // The seat's own token comes with it (that is what a reclaim hands
      // over), and where the seat never had one -- a client that joined
      // without a token at all -- the requester's own store supplies it, so
      // the role is never left standing on a record nothing can recognise
      // coming back (I15).
      const seat =
        requester.seat ??
        held.seat ??
        durableSeatFor(state, requester, requester.presentedSeat, held.peerId);
      // The merged record IS the requester's connection now, so what it has
      // presented is the requester's own browser token -- never the token of
      // the phone this seat is moving FROM. Carrying that one across
      // would make this record read as a second tab of a browser it has
      // nothing to do with (I14).
      const presentedSeat = requester.presentedSeat ?? held.presentedSeat;
      const players = releaseSeatToken(
        state.players
          .filter((p) => p.peerId !== held.peerId && p.peerId !== requester.peerId)
          .concat([
            {
              ...held,
              peerId: requester.peerId,
              connected: true,
              disconnectedAt: null,
              seat,
              presentedSeat,
            },
          ]),
        seat,
        requester.peerId,
      );
      // A claimant queued behind this one is raised the
      // instant this slot frees up -- `normalizeReclaimQueue` does it now,
      // reading the fresh `players` below, not this case remembering to.
      //
      // When the seat was LIVE, the connection that was playing under it has
      // just been superseded -- by the TV's own decision, which is the only
      // thing that supersedes anything now. Its record was renamed onto the
      // requester's peer id above, so it is already gone from `players` and
      // this is its only remaining address: the TV's outbound effect reads
      // it to tell that phone it is done, and the phone closes its own
      // socket rather than sit on one the room has moved past. There is
      // never a moment where both connections hold the seat.
      const next: GameState = {
        ...state,
        players,
        pending,
        pages,
        pendingReclaim: null,
        ...(held.connected
          ? {
              superseded: { peerId: held.peerId, seq: state.nextSupersededSeq },
              nextSupersededSeq: state.nextSupersededSeq + 1,
            }
          : {}),
      };
      // The wording follows `via`, because the two are not the same claim. A
      // typed name at least asserts a person; a seat token is a bearer token,
      // so presenting it proves only that whoever holds it can present it --
      // never that this is the same phone.
      // The log says what actually happened: the TV let a phone take the seat.
      return {
        ...next,
        log: appendLog(next, {
          kind: "system",
          role: held.role,
          text: held.connected
            ? `the TV moved ${held.role}'s seat to another phone — the earlier connection was closed`
            : request.via === "token"
              ? `the TV let a phone take ${held.role}'s seat`
              : `${held.name || held.role} is back — ${held.role} is theirs again`,
        }),
        nextLogId: next.nextLogId + 1,
      };
    }

    case "decline_reclaim": {
      const request = state.pendingReclaim;
      if (!request) return state;
      // Same rule as an approval: a decision only ever applies to the request
      // it names. A stale "Not now" must not close a request it was not
      // answering either -- that would silently throw away somebody's place in
      // the queue, which is the mirror of handing the seat over.
      if (request.id !== action.requestId) return staleReclaimDecision(state);
      // A claimant queued behind this one is raised now,
      // same as an approval -- `normalizeReclaimQueue` does it, reading
      // `players` below. But `normalizeReclaimQueue` only clears a `claimedSeat`
      // once its target seat is no longer held by anyone -- and the seat
      // this decline is about is usually still held (by the very player
      // this requester was asking for), so without clearing it explicitly
      // HERE, `normalizeReclaimQueue` would read this requester as still a
      // qualified claimant and immediately re-raise the exact request the
      // TV just said no to. A decline is a real answer, not a slot freed by
      // circumstance -- this is the one place that has to let the claim go.
      // `releaseClaim` also lets go of the borrowed `seat` token itself,
      // not just `claimedSeat` -- see its own comment.
      return withNotice(
        {
          ...state,
          players: state.players.map((p) => (p.peerId === request.peerId ? releaseClaim(p) : p)),
          pendingReclaim: null,
        },
        request.peerId,
        "the TV said not this time — pick a role instead",
      );
    }

    case "choose_action": {
      const chosen = availableActions(state.puzzle, state.play).find(
        (a) => a.actionId === action.actionId,
      );
      if (!chosen) {
        return withNotice(
          state,
          action.peerId,
          "that action is not available right now (its prerequisites are not met, or it is already done)",
        );
      }
      const refusal = controllerMayAct(state, action.peerId, chosen.performer);
      if (refusal) return withNotice(state, action.peerId, refusal.reason);
      if (!isConnected(state, chosen.performer)) {
        return withNotice(
          state,
          action.peerId,
          `${chosen.performer} has not joined yet — that action needs their phone`,
        );
      }
      if (chosen.options > 1) {
        return {
          ...state,
          pending: {
            ...state.pending,
            [action.peerId]: { actionId: chosen.actionId, options: chosen.options },
          },
          notice: null,
        };
      }
      return commitAction(state, action.peerId, chosen.actionId, undefined);
    }

    case "choose_option": {
      const pending = state.pending[action.peerId];
      if (!pending) return withNotice(state, action.peerId, "nothing is waiting to be chosen");
      const chosenAction = state.puzzle.actions.find((a) => a.id === pending.actionId);
      const performer = chosenAction ? resolvePerformer(state.puzzle, chosenAction) : null;
      // A picker stays on screen exactly as it was opened -- it is not told
      // when its own performer drops, so the pick itself must recheck
      // everything `choose_action` checked before opening it: the action still
      // exists, the controller is still allowed to act for that performer, and
      // the performer is connected NOW. A dpad picker lives at `pending["tv"]`,
      // a seat the TV remote keeps working whether or not the role behind it
      // is still there, so this is the one place that gap can be reached.
      const refusal = performer ? controllerMayAct(state, action.peerId, performer) : { reason: "that action is no longer available" };
      if (!chosenAction || !performer || refusal || !isConnected(state, performer)) {
        const clearedPending = { ...state.pending };
        delete clearedPending[action.peerId];
        return withNotice(
          { ...state, pending: clearedPending },
          action.peerId,
          performer && !isConnected(state, performer)
            ? `${performer} is not connected any more, so that pick was cleared`
            : (refusal?.reason ?? "that action is no longer available"),
        );
      }
      if (action.option < 0 || action.option >= pending.options) {
        return withNotice(state, action.peerId, `there is no option ${action.option + 1}`);
      }
      if ((chosenAction.options ?? 1) > 1 && action.option !== correctOptionIndex(chosenAction)) {
        return wrongChoice(state, action.peerId, chosenAction);
      }
      return commitAction(state, action.peerId, pending.actionId, action.option);
    }

    case "cancel_choice": {
      if (!state.pending[action.peerId]) return state;
      const pending = { ...state.pending };
      delete pending[action.peerId];
      return { ...state, pending };
    }

    case "request_input_change": {
      // The entry gate above already proves `state.phase === "playing"`;
      // `requestInputChange` (below) gives its own courteous notice for a
      // phone-originated request outside play before it ever reaches here.
      if (!state.puzzle.roles.some((r) => r.id === action.role)) {
        return withNotice(state, TV_PEER, `${action.role} is not in this puzzle`);
      }
      // Same gate as `requestInputChange`, for whatever reaches this raw
      // action directly rather than through a phone's own request.
      if (!isConnected(state, action.role)) {
        return withNotice(state, TV_PEER, `${action.role} is not connected, so their input cannot change`);
      }
      // A repeat change for a role that has already rebuilt once this run goes
      // straight to the static summary.
      const repeat = state.switches.some((s) => s.role === action.role && s.kind === "ok");
      // 679`: the record names WHO asked, not
      // just which role -- the `isConnected` gate just above is what makes
      // that owner well defined (it is the only way this case is reached with
      // a role anybody holds), and `normalizePendingSwitch`/`resolveSwitch`
      // are what then hold the request to it.
      const owner = playerByRole(state, action.role)!;
      const record = switchRecord(
        state.puzzle,
        state.play,
        action.role,
        action.capabilities,
        { peerId: owner.peerId, seat: owner.seat },
        repeat,
      );
      return {
        ...state,
        phase: "switching",
        pendingSwitch: record,
        switchBeat: record.kind === "ok" && repeat ? SWITCH_PHASES - 1 : 0,
      };
    }

    case "switch_beat": {
      if (!state.pendingSwitch || state.pendingSwitch.kind !== "ok") return state;
      const nextBeat = state.switchBeat + 1;
      if (nextBeat < SWITCH_PHASES) {
        return { ...state, switchBeat: nextBeat };
      }
      return resolveSwitch(state);
    }

    case "switch_dismiss":
      return state.pendingSwitch ? resolveSwitch(state) : state;

    case "clear_notice":
      return state.notice && state.notice.seq === action.seq ? { ...state, notice: null } : state;

    default:
      return state;
  }
}

function nextPhase(state: GameState): Phase {
  // The roles *this mystery seats*, not every role the protocol knows: a
  // two-player mystery would otherwise wait forever for a third seat nobody can
  // take. `seatRoles` narrows the puzzle's own roles to the wire vocabulary.
  if (state.phase === "lobby" && seatRoles(state.puzzle).every((role) => isConnected(state, role))) {
    return "playing";
  }
  return state.phase;
}

/**
 * Who to nudge when a choice comes back wrong: the role whose private token
 * this is, or -- for a token nobody starts with -- whoever performs the action
 * that produces it. Best-effort by design: this only names who to ask to say
 * it out loud again, it never gates anything the validator itself decides.
 */
function answerHolder(puzzle: Puzzle, answerToken: string | undefined): RoleId | null {
  if (!answerToken) return null;
  const owner = puzzle.roles.find((r) => r.privateTokens.includes(answerToken));
  if (owner) return owner.id;
  const producer = puzzle.actions.find((a) => a.producesTokens.includes(answerToken));
  return producer ? resolvePerformer(puzzle, producer) : null;
}

/**
 * A wrong answer-gated choice: kind, not punishing. Nothing is applied, no
 * history line is written and the certificate does not move -- the chooser's
 * pending choice is left exactly as it was, so the very next press can try
 * again. The TV says what happened in the fiction, and nudges whoever holds
 * the answer to say it out loud.
 */
function wrongChoice(state: GameState, peerId: string, action: Action): GameState {
  const holder = answerHolder(state.puzzle, action.answerToken);
  const flavor = wrongAttemptText(action);
  const nudge = holder ? `${holder} knows it — say it out loud, then try again` : "try again";
  return withNotice(state, peerId, `${flavor}. ${nudge}.`);
}

function commitAction(
  state: GameState,
  peerId: string,
  actionId: string,
  option: number | undefined,
): GameState {
  const result = applyAction(state.puzzle, state.play, actionId);
  if (!result.ok) return withNotice(state, peerId, result.reason);

  // The local check said yes. The validator gets the last word: `certify`
  // replays the whole history against the puzzle, so a state this app got
  // wrong cannot reach the screen as a green badge.
  const verified = certify(state.puzzle, result.state);
  if (!isCertificate(verified)) {
    return withNotice(
      state,
      peerId,
      `the validator refused that move, so it was not made: ${explainFailure(verified)}`,
    );
  }

  const action = state.puzzle.actions.find((a) => a.id === actionId)!;
  const labels = optionLabels(action, state.puzzle);
  const picked = option !== undefined && labels[option] ? ` — ${labels[option]}` : "";
  const pending = { ...state.pending };
  delete pending[peerId];

  const next: GameState = {
    ...state,
    play: result.state,
    certificate: verified,
    certificateError: null,
    notice: null,
    pending,
    nextLogId: state.nextLogId + 1,
    log: [
      ...state.log,
      {
        id: state.nextLogId,
        kind: "action",
        role: result.performer,
        text: `${actionTitle(action)}${picked}`,
      },
    ],
  };
  return { ...next, phase: goalReached(next.puzzle, next.play) ? "ending" : next.phase };
}

/* ------------------------------------------------------------------ */
/* Phone intents, routed                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything a phone can cause, in one place. A phone's message is decoded into
 * one of these and nothing else reaches the reducer, so the set of things a
 * phone can do is exactly this list.
 */
export type AppAction =
  | GameAction
  | { k: "phone_join"; peerId: string; name?: string; want?: RoleId; seat?: string }
  | { k: "phone_choice"; peerId: string; choiceId: string }
  | { k: "phone_input_change"; peerId: string; capabilities: Capability[] }
  | { k: "phone_release_role"; peerId: string }
  | { k: "phone_reclaim_seat"; peerId: string; name: string }
  | { k: "phone_release_claim"; peerId: string }
  | { k: "phone_continue_switch"; peerId: string };

export function reduceApp(state: GameState, action: AppAction): GameState {
  switch (action.k) {
    case "phone_join":
      return reduce(state, {
        k: "player_joined",
        peerId: action.peerId,
        ...(action.name !== undefined ? { name: action.name } : {}),
        ...(action.want !== undefined ? { want: action.want } : {}),
        ...(action.seat !== undefined ? { seat: action.seat } : {}),
      });
    case "phone_choice":
      return applyPhoneChoice(state, action.peerId, action.choiceId);
    case "phone_input_change":
      return requestInputChange(state, action.peerId, action.capabilities);
    case "phone_continue_switch": {
      // Only the changed player's own phone may skip their moment -- another
      // role's phone pressing Continue must not dismiss it for them.
      const role = roleOfPeer(state, action.peerId);
      if (!state.pendingSwitch || role !== state.pendingSwitch.role) return state;
      return reduce(state, { k: "switch_dismiss" });
    }
    case "phone_release_role":
      return reduce(state, { k: "release_role", peerId: action.peerId });
    case "phone_reclaim_seat":
      return reduce(state, { k: "reclaim_seat", peerId: action.peerId, name: action.name });
    case "phone_release_claim":
      return reduce(state, { k: "release_claim", peerId: action.peerId });
    default:
      return reduce(state, action);
  }
}

/* ------------------------------------------------------------------ */
/* What a phone sees                                                   */
/* ------------------------------------------------------------------ */

/**
 * One page of choices: at most `max`, and when the list is longer the last slot
 * is a "More…" that advances the page. The 4-item bound is the validator's, so
 * the TV never sends a phone a list it could not legally scan.
 */
export function pageChoices(all: Choice[], page: number, max = SCAN_MAX_OPTIONS): Choice[] {
  if (all.length <= max) return all;
  const perPage = max - 1;
  const pages = Math.ceil(all.length / perPage);
  const index = ((page % pages) + pages) % pages;
  const slice = all.slice(index * perPage, index * perPage + perPage);
  return [...slice, { id: MORE_CHOICE_ID, label: `More… (${index + 1}/${pages})` }];
}

export function phoneView(state: GameState, peerId: string): PhoneView {
  const role = roleOfPeer(state, peerId);
  const wireRole = asProtocolRole(role);
  // A role a phone may not pick is one somebody else is sitting in. The phone
  // is told which those are so it can disable them rather than let a player
  // choose one and be refused.
  const takenRoles = takenRolesIn(state);
  const heldRoles = heldRolesIn(state);
  const seats = seatRoles(state.puzzle);
  if (!role || !wireRole) {
    const known = playerByPeer(state, peerId) !== undefined;
    return {
      role: null,
      capabilities: [],
      mode: "waiting",
      prompt: known
        ? "You are not holding a role — pick one"
        : "Waiting for the TV to give you a role",
      clues: [],
      choices: [],
      choiceKind: "none",
      badge: null,
      takenRoles,
      heldRoles,
      seatRoles: seats,
      ...(state.notice && state.notice.peerId === peerId ? { notice: state.notice.text } : {}),
      canChangeInput: false,
      canChangeRole: false,
      // A phone waiting on a seat it presented a token for, with no role of
      // its own. A claim is only ever raised against a seat somebody is
      // PLAYING, so that wait is the TV's to end -- with one ending the phone
      // does not have to ask for: a seat whose holder has dropped is a chair
      // nobody is in, and the token this phone is carrying is what claims it,
      // so it comes back on that token alone -- on the phone's own next
      // `join` (`claimIsReturn`), never by the drop itself. While the wait is
      // on, the phone is told it is in that state and can say it is the wrong
      // seat.
      claimingSeat: known ? playerByPeer(state, peerId)!.claimedSeat != null : false,
      // The role THIS BROWSER is already playing, in another tab. Sent so the
      // phone can say so plainly instead of showing a role picker every tap
      // of which the TV will refuse -- and so it knows not to offer the
      // rotation, which would throw away the token that seat is held under.
      otherTabRole: known
        ? asProtocolRole(seatBusyFor(state, playerByPeer(state, peerId)!)?.role ?? null)
        : null,
    };
  }

  const capabilities = asProtocolCapabilities(roleCapabilities(state.puzzle, role));
  const mode = phoneMode(capabilities);
  const pending = state.pending[peerId];
  let choices: Choice[] = [];
  let choiceKind: PhoneView["choiceKind"] = "none";

  if (pending) {
    const action = state.puzzle.actions.find((a) => a.id === pending.actionId);
    const labels = action ? optionLabels(action, state.puzzle) : [];
    choices = labels.map((label, index) => ({ id: `opt:${index}`, label }));
    choiceKind = "option";
  } else if (mode !== "dpad" && mode !== "waiting" && state.phase !== "switching") {
    // A puzzle action is never offered mid-rebuild -- the
    // reducer already refuses it there (`BLOCKED_WHILE_SWITCHING`, above),
    // and a phone should not be shown a control certain to be refused.
    const all = availableActions(state.puzzle, state.play)
      .filter((a) => a.performer === role && isConnected(state, a.performer))
      .map((a) => ({
        id: `act:${a.actionId}`,
        label: a.label,
        ...(a.options > 1 ? { hint: `${a.options} choices` } : {}),
      }));
    choices = pageChoices(all, state.pages[peerId] ?? 0);
    choiceKind = choices.length > 0 ? "action" : "none";
  }

  // At the goal nobody is needed any more -- that is what finishing means -- so
  // the ending hands the phones the run's claim instead of the finished board.
  // Mid-play, this is the same "X essential" tick the lobby
  // badge makes (badge.ts), so it gets the same live gate -- a phone must not
  // see a role marked essential-and-proven while that role has not joined.
  // The ending's branch was the one producer on this path
  // still built from an ungated `finalBadge`, so a phone kept reading
  // "✓ A essential" -- the whole claim, on a screen with no headline beside it
  // to say otherwise -- after A had already dropped. Same gate on both.
  const isRoleHere = (role: string) => isConnected(state, role);
  const badgeNow =
    state.phase === "ending"
      ? finalBadge(state, isRoleHere)
      : state.certificate
        ? badge(state.certificate, isRoleHere)
        : null;
  const prompt =
    mode === "dpad"
      ? "Use the TV remote — the d-pad is your controller"
      : pending
        ? "Pick one"
        : choices.length > 0
          ? "Your move"
          : "Nothing for you to do yet";

  return {
    role: wireRole,
    capabilities,
    mode,
    prompt,
    clues: cluesFor(state.puzzle, role),
    choices,
    choiceKind,
    badge: badgeNow ? { ok: badgeNow.ok, hash: badgeNow.hash, lines: badgeNow.lines } : null,
    takenRoles,
    heldRoles,
    seatRoles: seats,
    ...(state.notice && state.notice.peerId === peerId ? { notice: state.notice.text } : {}),
    // Input only changes while the game is actually on --
    // the same phase the reducer itself requires (`PLAYING_ONLY_INTENTS`).
    canChangeInput: state.phase === "playing",
    // Giving a role up mid-rebuild would leave the repair describing a table
    // that no longer exists, so the offer waits for the puzzle to settle.
    canChangeRole: state.phase === "lobby" || state.phase === "playing",
    // This branch is a phone that HOLDS a role, so it is not waiting on one.
    claimingSeat: false,
    // A player holding a role is never another tab's second seat: at most one
    // record ever holds a role under a given token (I2/I14).
    otherTabRole: null,
  };
}

/** The roles somebody is holding right now. */
export function takenRolesIn(state: GameState): WireRoleId[] {
  return seatRoles(state.puzzle).filter((role) => playerByRole(state, role) !== undefined);
}

/** Among those, the ones whose phone has dropped and is inside its grace window. */
export function heldRolesIn(state: GameState): WireRoleId[] {
  return seatRoles(state.puzzle).filter((role) => {
    const player = playerByRole(state, role);
    return player !== undefined && !player.connected;
  });
}

/**
 * A required role nobody currently occupies at all -- not merely held, but
 * genuinely empty: its hold expired and `sweep_seats` removed it, or its
 * player released it. Distinct from `heldRolesIn` because the room needs a
 * different instruction for each ("wait" versus "somebody has to join") --
 * see `checkedHeadline`.
 */
export function vacantRolesIn(state: GameState): WireRoleId[] {
  return seatRoles(state.puzzle).filter((role) => playerByRole(state, role) === undefined);
}

/**
 * Whether "everyone is essential" is safe to say out loud right now: the
 * certificate has to hold AND every role it counts on has to be both taken
 * AND connected. The certificate itself never learns about connectivity --
 * it is a claim about the puzzle and the play, not about phones -- so this is
 * the one place a screen should ask before it says the claim holds. A `false`
 * here does not mean the proof is wrong; it means say who we are waiting for
 * instead (`heldRolesIn`, `vacantRolesIn`), not "you can finish together".
 */
export function claimHolds(state: GameState): boolean {
  return (
    state.certificate !== null &&
    state.certificate.ok &&
    heldRolesIn(state).length === 0 &&
    vacantRolesIn(state).length === 0
  );
}

/**
 * The seat-claim state machine's own invariants, written down once instead
 * of re-derived from a scattered handful of `if`s. Every one of these is
 * checked against a single `GameState` snapshot -- true of *every* reachable
 * state, not just the ones a hand-built fixture happens to construct -- and
 * the
 * fuzz test in `test/seat-invariants-wider-fuzz.test.ts` calls this after
 * every step of thousands of random intent sequences.
 *
 * I1. A player with a live claim -- `claimedSeat !== null`, or named as the
 *     requester of `pendingReclaim` -- never holds a role. Nothing here says WHEN
 *     a claim is cleared -- see I3 for that -- only that for as long as it
 *     exists, the claimant stays exactly as roleless as the day it was
 *     raised. A claimant's own `seat` never equals the token it is
 *     claiming either: `player_joined` records the contested token in
 *     `claimedSeat` and nowhere else, and a repeat `join` from the same
 *     connection finds its claim through its own peer id. That is what
 *     lets I13 hold while a claim against a LIVE seat is pending -- the
 *     case an earlier version could only handle by taking the seat outright.
 * I2. A seat token is carried by at most one player that actually holds a
 *     role (connected or held) at a time -- the property `seat` bookkeeping
 *     exists to protect. With claimants carrying nothing (I1), a token in
 *     fact sits on exactly one record at a time; this is the weaker
 *     statement that still has to hold however that bookkeeping changes.
 * I3. If any connected, roleless player carries a `claimedSeat` naming a
 *     seat that is still held (present in `players`, disconnected, with a
 *     role) -- then `pendingReclaim` is not null. The queue is never
 *     stranded: the front requester dropping, and `sweep_seats` expiring
 *     the hold it was waiting on, would both leave exactly this claimant
 *     waiting with nothing raised for the TV.
 * I4. Whenever `pendingReclaim` is not null, it names a requester that is
 *     currently connected and roleless, and a seat that is genuinely still
 *     held (a disconnected player of the matching role and name) -- never a
 *     stale request left pointing at a peer id or a seat that is already
 *     gone.
 * I5. Only `approve_reclaim` ever moves a role from one peer id to a
 *     DIFFERENT one -- a transition property, not a fact about one snapshot,
 *     so it cannot be checked here; `test/seat-invariants-fuzz.test.ts`
 * checks it directly by comparing consecutive states, and
 *     `test/seat-invariants-wider-fuzz.test.ts` does the same across the
 *     wider fuzz this round adds (more peers, `assign_role` as its own
 *     action kind).
 * I6. Every player's `peerId` is unique -- a basic
 *     bookkeeping sanity check nothing above assumes without it.
 * I7. At most one player holds any given non-null role --
 *     `assign_role`'s own "already taken" guard is the only thing that is
 *     supposed to make this true; this is what actually proves it stays
 *     true through every other intent too, including this round's own
 *     changes to `player_joined` and `approve_reclaim`.
 * I8. `connected` and `disconnectedAt` never disagree: a
 *     connected player's `disconnectedAt` is always `null`, and a
 *     disconnected player's is always set.
 * I9. A pending switch names a role that is still held by
 *     the SEAT that asked for the change -- `requester.peerId`, or, for a
 *     reconnect on a new peer id, `requester.seat`. It never names a role
 *     that has been swept away, given up, or handed to a different phone.
 *     Being *disconnected* is deliberately NOT a
 *     violation: a phone inside its grace window still holds its role and
 *     still owns its own request, which is what lets a phone that stepped out
 *     and came straight back keep the rebuild it asked for. `resolveSwitch`
 *     is where that grace finally runs out -- see `switchIsStillOurs`.
 * I10. No two log lines share an id. `nextLogId` is the only
 *     thing that makes the log usable as one ordered record, and every case
 *     that appends is supposed to advance it -- but `appendLog` stamps a line
 *     with the CURRENT counter and does not advance it itself, so a case that
 *     forgets leaves the counter where it was and the next line written
 *     anywhere in the room reuses the id -- which is what a missing advance
 *     at `cancelSwitch` did, with the same omission sitting on
 *     `resolveSwitch`'s refusal and success branches beside it. This is the
 *     invariant that makes the class of bug detectable rather than merely
 *     fixed once.
 * I11. A reclaim decision only applies to the request it names. Every request
 *     carries an `id` -- its requester, the seat token it asks for, and a
 *     counter that only moves forward -- and `approve_reclaim` /
 *     `decline_reclaim` refuse any id but the one on screen. The behavioural
 *     half of this is a transition property, checked where the fuzz presses
 *     (see `decideReclaim` in the seat-invariant suites); what is checkable in
 *     one snapshot, and checked here, is that the request on screen carries a
 *     well-formed fingerprint of itself.
 * I12. Every claimant has an exit. A phone carrying a `claimedSeat` is
 *     refused every other route -- it cannot be assigned a role, and it cannot
 *     raise a named reclaim -- so the claim has to be something the phone
 *     itself can drop. A claim on a LIVE seat does reach the TV now, but the
 *     answer may be "no", and a phone that has simply picked up somebody
 *     else's token should not have to wait for the room to notice it.
 *     `release_claim` is that exit, and this checks it exists for every
 *     claimant in the state rather than trusting that the one scenario
 *     anybody thought of still works.
 * I13. At most one CONNECTED player carries any given seat token. This is
 *     what "one live connection per seat" means at the state level. With no
 *     client-side gate any more, two things hold it up: a claimant never
 *     copies the contested token onto itself (I1), and the only transition
 *     that hands a token to a different connection -- `approve_reclaim` --
 *     removes the record it took it from in the same step.
 * I14. ONE BROWSER, ONE ROLE. At most one record holds a role under any given
 *     PRESENTED token. The seat token is browser-wide -- every tab of one
 *     browser reads the same token out of one IndexedDB store -- so
 *     two records presenting the same token are one player twice, and two
 *     roles between them is one household seat counted as two. I2 says the
 *     same thing about `seat` (ownership); this says it about what the phones
 *     actually presented, which is the only thing that stays true after a
 *     claim is declined and its `claimedSeat` is gone.
 * I15. A role comes with a durable identity. A player that holds a role and
 *     presented a token holds a token of its own -- never a live role on a
 *     record nothing can recognise coming back, which is a role reclaimable
 *     by nobody. (A client that presented no token at all is exempt: the
 *     reducer cannot invent one.)
 */
export function checkSeatInvariants(state: GameState): string[] {
  const violations: string[] = [];

  // I14 / I15: one browser, one role -- and never a role without the token
  // that can ask for it back.
  const roleByPresented = new Map<string, Player>();
  for (const p of state.players) {
    if (p.role === null) continue;
    if (p.presentedSeat !== null) {
      const already = roleByPresented.get(p.presentedSeat);
      if (already) {
        violations.push(
          `I14: ${already.peerId} (${already.role}) and ${p.peerId} (${p.role}) both hold a role under presented token ${p.presentedSeat}`,
        );
      } else {
        roleByPresented.set(p.presentedSeat, p);
      }
      if (p.seat === null) {
        violations.push(`I15: ${p.peerId} holds role ${p.role} with no seat token of its own`);
      }
    }
  }

  // I6: unique peer ids.
  const seenPeerIds = new Set<string>();
  for (const p of state.players) {
    if (seenPeerIds.has(p.peerId)) violations.push(`I6: peerId ${p.peerId} appears more than once in players`);
    seenPeerIds.add(p.peerId);
  }

  // I7: at most one holder per role.
  const roleHolders = new Map<RoleId, string[]>();
  for (const p of state.players) {
    if (p.role === null) continue;
    roleHolders.set(p.role, [...(roleHolders.get(p.role) ?? []), p.peerId]);
  }
  for (const [role, holders] of roleHolders) {
    if (holders.length > 1) violations.push(`I7: role ${role} is held by more than one player: ${holders.join(", ")}`);
  }

  // I8: connected/disconnectedAt agree.
  for (const p of state.players) {
    if (p.connected && p.disconnectedAt !== null) {
      violations.push(`I8: ${p.peerId} is connected but disconnectedAt is set`);
    }
    if (!p.connected && p.disconnectedAt === null) {
      violations.push(`I8: ${p.peerId} is disconnected but disconnectedAt is null`);
    }
  }

  // I1: a claimant (or a pending requester) never holds a role.
  for (const p of state.players) {
    if (p.claimedSeat === null) continue;
    if (p.role !== null) {
      violations.push(`I1: ${p.peerId} holds role ${p.role} while claimedSeat ${p.claimedSeat} is still set`);
    }
  }
  if (state.pendingReclaim) {
    const requester = playerByPeer(state, state.pendingReclaim.peerId);
    if (requester && requester.role !== null) {
      violations.push(
        `I1: pendingReclaim's requester ${requester.peerId} already holds role ${requester.role}`,
      );
    }
  }

  // I2: a seat token is carried by at most one ROLE-HOLDING player.
  const roleHoldersBySeat = new Map<string, string[]>();
  for (const p of state.players) {
    if (p.seat === null || p.role === null) continue;
    roleHoldersBySeat.set(p.seat, [...(roleHoldersBySeat.get(p.seat) ?? []), p.peerId]);
  }
  for (const [seat, holders] of roleHoldersBySeat) {
    if (holders.length > 1) {
      violations.push(`I2: seat token ${seat} is held by more than one role-holding player: ${holders.join(", ")}`);
    }
  }

  // I3: a stranded connected, roleless claimant -- its target still held,
  // but nothing raised for the TV.
  for (const p of state.players) {
    if (!p.connected || p.role !== null || p.claimedSeat === null) continue;
    const held = state.players.find(
      (h) => h.peerId !== p.peerId && h.role !== null && h.seat === p.claimedSeat,
    );
    if (held && state.pendingReclaim === null) {
      violations.push(
        `I3: ${p.peerId} is connected, roleless and claims seat ${p.claimedSeat} (held by ${held.peerId} as ${held.role}), but pendingReclaim is null`,
      );
    }
  }

  // I4: pendingReclaim always names a live requester and a still-held seat.
  if (state.pendingReclaim) {
    const request = state.pendingReclaim;
    const requester = playerByPeer(state, request.peerId);
    if (!requester) {
      violations.push(`I4: pendingReclaim names peerId ${request.peerId}, which is not in players`);
    } else if (!requester.connected) {
      violations.push(`I4: pendingReclaim's requester ${request.peerId} is not connected`);
    } else if (requester.role !== null) {
      violations.push(`I4: pendingReclaim's requester ${request.peerId} already holds role ${requester.role}`);
    }
    if (!reclaimTarget(state, request)) {
      violations.push(
        `I4: pendingReclaim names role ${request.role}/name "${request.name}"/seat ${request.seat ?? "none"}, which nobody holds any more`,
      );
    }
  }

  // I9: a pending switch still belongs to the seat that asked for it.
  const pending = state.pendingSwitch;
  if (pending) {
    const owner = playerByRole(state, pending.role);
    if (!owner) {
      violations.push(
        `I9: pendingSwitch names role ${pending.role}, which nobody holds -- asked for by ${describeSeat(pending.requester)}`,
      );
    } else if (!sameSeat(owner, pending.requester)) {
      violations.push(
        `I9: pendingSwitch for role ${pending.role} was asked for by ${describeSeat(pending.requester)}, but the role is now held by ${describeSeat(owner)}`,
      );
    }
  }

  // I10: no two log lines share an id.
  const seenLogIds = new Set<number>();
  const reused = new Set<number>();
  for (const line of state.log) {
    if (seenLogIds.has(line.id)) reused.add(line.id);
    seenLogIds.add(line.id);
  }
  for (const id of [...reused].sort((a, b) => a - b)) {
    violations.push(`I10: more than one log line carries id ${id}`);
  }

  // I11: the request on screen carries a well-formed fingerprint of itself.
  if (state.pendingReclaim) {
    const request = state.pendingReclaim;
    if (!request.id.startsWith(`${request.peerId}:`)) {
      violations.push(
        `I11: pendingReclaim for ${request.peerId} carries the fingerprint "${request.id}", which does not name that requester`,
      );
    }
    const seq = Number(request.id.slice(request.id.lastIndexOf(":") + 1));
    if (!Number.isInteger(seq) || seq < 1) {
      violations.push(`I11: pendingReclaim's fingerprint "${request.id}" does not end in a request number`);
    }
  }

  // I12: every claimant has an exit. Checked by TAKING it, not by reading the
  // state: the exit counts only if the phone that says "this isn't my seat" is
  // actually free of the claim afterwards, and left able to pick a role rather
  // than handed one by the way out.
  for (const p of state.players) {
    if (p.claimedSeat === null) continue;
    const freed = reduce(state, { k: "release_claim", peerId: p.peerId });
    const after = playerByPeer(freed, p.peerId);
    if (!after || after.claimedSeat !== null) {
      violations.push(
        `I12: ${p.peerId} claims seat ${p.claimedSeat} and saying so does not clear it`,
      );
      continue;
    }
    if (after.role !== null) {
      violations.push(`I12: ${p.peerId} was handed role ${after.role} on the way out of a claim`);
    }
    // The borrowed token goes back with the claim; a seat of the phone's own
    // is left exactly where it was.
    if (after.seat !== null && after.seat !== p.seat) {
      violations.push(
        `I12: ${p.peerId} came out of claim ${p.claimedSeat} carrying seat ${after.seat}, which was neither its own nor the claim`,
      );
    }
  }

  // I13: at most one connected player per seat token.
  const connectedBySeat = new Map<string, string[]>();
  for (const p of state.players) {
    if (p.seat === null || !p.connected) continue;
    connectedBySeat.set(p.seat, [...(connectedBySeat.get(p.seat) ?? []), p.peerId]);
  }
  for (const [seat, holders] of connectedBySeat) {
    if (holders.length > 1) {
      violations.push(`I13: seat token ${seat} is carried by more than one connected player: ${holders.join(", ")}`);
    }
  }

  return violations;
}

/** A seat as a violation message names it: the peer id, plus the token when it has one. */
function describeSeat(player: { peerId: string; seat: string | null }): string {
  return player.seat === null ? player.peerId : `${player.peerId} (seat ${player.seat})`;
}

/**
 * A phone's picked choice id, resolved against the view the TV last built for
 * that phone. A choice the TV never put on that screen -- stale, forged, or from
 * another role's board -- resolves to nothing and is refused with a notice.
 */
export function applyPhoneChoice(state: GameState, peerId: string, choiceId: string): GameState {
  const offered = phoneView(state, peerId).choices;
  if (!offered.some((choice) => choice.id === choiceId)) {
    return withNotice(state, peerId, "that choice is not on your screen any more");
  }
  if (choiceId === MORE_CHOICE_ID) {
    return { ...state, pages: { ...state.pages, [peerId]: (state.pages[peerId] ?? 0) + 1 } };
  }
  if (choiceId.startsWith("opt:")) {
    const option = Number(choiceId.slice(4));
    if (!Number.isInteger(option) || option < 0) {
      return withNotice(state, peerId, "that is not one of the options");
    }
    return reduce(state, { k: "choose_option", peerId, option });
  }
  if (choiceId.startsWith("act:")) {
    return reduce(state, { k: "choose_action", peerId, actionId: choiceId.slice(4) });
  }
  return withNotice(state, peerId, "that is not something you can pick");
}

/** Roles that still have something to do. Kept for callers that need the set; not rendered as a "waiting on" line, which would blame the slower player. */
export function outstandingRoles(state: GameState): RoleId[] {
  const roles = new Set<RoleId>();
  for (const action of availableActions(state.puzzle, state.play)) roles.add(action.performer);
  return seatRoles(state.puzzle).filter((role) => roles.has(role));
}

/** True once the team is at or past the demo's halfway point. */
export function atMidpoint(state: GameState): boolean {
  return state.play.history.filter((e) => e.kind === "action").length >= state.midpointSteps;
}

/** A phone asking to change its input, routed through the one switch path. */
export function requestInputChange(
  state: GameState,
  peerId: string,
  capabilities: Capability[],
): GameState {
  const rawRole = roleOfPeer(state, peerId);
  const role = asProtocolRole(rawRole);
  if (!role) return withNotice(state, peerId, "you do not have a role yet");
  // A dropped seat cannot ask for a rebuild on its own behalf: an input
  // change is only accepted from a seat that is actually connected right now.
  if (!isConnected(state, rawRole!)) {
    return withNotice(state, peerId, "your seat is not connected right now, so it cannot ask for a change");
  }
  if (capabilities.length === 0) return withNotice(state, peerId, "that is not an input mode");
  // Input only changes while the game is actually on --
  // the entry gate in `reduce` would refuse this silently either way, but a
  // phone that asked deserves to be told why, not just ignored.
  if (state.phase === "switching") {
    return withNotice(state, peerId, "a rebuild is already on screen");
  }
  if (state.phase === "lobby") {
    return withNotice(state, peerId, "wait for everyone to join before changing input");
  }
  if (state.phase !== "playing") {
    return withNotice(state, peerId, "input can only change while the game is on");
  }
  return reduce(state, { k: "request_input_change", role, capabilities });
}
