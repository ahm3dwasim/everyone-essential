/**
 * The wire protocol, in one place.
 *
 * Three processes speak it: the relay (which routes), the TV (which is the
 * authoritative host) and the phones (which send intents and render what the
 * TV sends them). Nothing here imports the validator: the relay is a dumb pipe
 * and must not grow a dependency on the puzzle model, so the vocabulary the
 * transport needs is declared locally and `app/tv/src/game/validator.ts` holds
 * a compile-time assertion that it still matches the validator's.
 *
 * Two layers, deliberately separate:
 *
 *   client <-> relay   `hello` / `welcome` / `peer_joined` / `peer_left` /
 *                      `relay_error`, plus `relay` envelopes that carry a game
 *                      message to `"tv"`, `"all"` or one peer id.
 *   TV <-> phone       the game messages inside those envelopes.
 *
 * Every decoder here is total: it either returns a fully-formed message or a
 * reason it refused. Nothing downstream ever sees a half-parsed object, which
 * matters because the TV trusts nothing a phone says -- the phone sends an
 * *intent*, and the TV decides.
 */

/**
 * The version both ends of the wire have to agree on before anything is
 * routed. It is read at the two moments it decides something: the relay
 * refuses a hello that does not speak it, and a client refuses a welcome that
 * does not. Version 2 is the one where a hello may carry a room's host
 * credential and a welcome for a TV always answers with a fresh one. A
 * version-1 relay ignores that credential entirely, so carrying on against
 * one would put a TV and its phones in a room with no gate on it at all --
 * which is why an old component meets a refusal here rather than a silent
 * fallback to the weaker handshake.
 */
export const PROTOCOL_VERSION = 2;

export type PlayerKind = "tv" | "phone";
export type PeerId = string;
export type RoomCode = string;

/** The three roles the demo puzzle has. The validator calls these `RoleId`. */
export const ROLE_IDS = ["A", "B", "C"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** The input capabilities the validator's model knows. */
export const CAPABILITIES = ["dpad", "scan", "voice"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Hard limit from the validator's model: a scan choice offers at most 4 alternatives. */
export const SCAN_MAX_OPTIONS = 4;

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value);
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * How many bytes of randomness a seat token carries. The phone mints exactly
 * this many (`mintSeatId`), so the wire accepts exactly this shape back.
 */
export const SEAT_TOKEN_BYTES = 16;

/**
 * The one shape a seat token is allowed to be: the phone mints it as 16 random
 * bytes written out as lowercase hex, and the wire takes that and nothing
 * else. A token is a credential, but it is also a string that ends up inside
 * an attribute of the TV's own markup -- so "any string up to N characters" is
 * the wrong rule. Length and alphabet together leave nothing in a token that
 * could be anything but a token.
 */
export const SEAT_TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${SEAT_TOKEN_BYTES * 2}}$`);

export function isSeatToken(value: unknown): value is string {
  return typeof value === "string" && SEAT_TOKEN_PATTERN.test(value);
}

/**
 * How many bytes of randomness a room's host credential carries. The relay
 * mints exactly this many, so the wire accepts exactly this shape back.
 *
 * This is the credential a room's own TV keeps and presents when it comes
 * back to the room it made. Nothing about a room code is secret -- it is on
 * the TV screen and in the join link -- so the code can never be what makes a
 * connection the TV. This can.
 */
export const HOST_TOKEN_BYTES = 32;

/**
 * The one shape a host credential is allowed to be: 32 random bytes written
 * out as lowercase hex, and nothing else. It is the single field a connection
 * presents as a claim about who it is, so the rule is the narrowest one that
 * admits the mint -- a dropped credential leaves the relay refusing the
 * claim, which is the fail-closed direction.
 */
export const HOST_TOKEN_PATTERN = new RegExp(`^[0-9a-f]{${HOST_TOKEN_BYTES * 2}}$`);

export function isHostToken(value: unknown): value is string {
  return typeof value === "string" && HOST_TOKEN_PATTERN.test(value);
}

/**
 * How long an emptied room is remembered before it is forgotten.
 *
 * When the last peer leaves a room the relay stops routing in it, but it does
 * not forget it: it keeps the code and the digest of the credential that was
 * live, so the room's own TV can come back to the room it made, and so nobody
 * else can make that room again in the meantime. The window only has to
 * outlast a network blip -- a client comes back on a backoff that caps at four
 * seconds, so a minute is fifteen consecutive failed attempts, far past a
 * dropped socket -- and it should not be much longer than that, because for as
 * long as it lasts the code is not a code a new room can be given.
 */
export const ROOM_TOMBSTONE_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Transport layer                                                     */
/* ------------------------------------------------------------------ */

export interface PeerSummary {
  peerId: PeerId;
  kind: PlayerKind;
  name?: string;
}

/** Client -> relay: the first message, and the only one before routing starts. */
export interface HelloMessage {
  t: "hello";
  v: number;
  kind: PlayerKind;
  /** Phones must name a room. A TV may omit it and be given a fresh one. */
  room?: string;
  /**
   * The credential the relay handed this connection when it made the room it
   * names. Only a TV ever has one, and only to come back to its own room with
   * it: a room code is public, so naming one is not a claim about who you are.
   */
  hostToken?: string;
  name?: string;
}

/** Relay -> client: the connection is established and the room is known. */
export interface WelcomeMessage {
  t: "welcome";
  v: number;
  room: RoomCode;
  peerId: PeerId;
  kind: PlayerKind;
  /** Everyone already in the room, this client included. */
  peers: PeerSummary[];
  /**
   * The room's credential, present only in a TV's own welcome -- never in a
   * phone's, and never in a peer list or a broadcast. It is what lets this TV
   * come back to this room, and it is the one thing in a welcome that is a
   * secret.
   */
  hostToken?: string;
}

export interface PeerJoinedMessage {
  t: "peer_joined";
  peer: PeerSummary;
}

export interface PeerLeftMessage {
  t: "peer_left";
  peerId: PeerId;
}

export type RelayErrorCode =
  | "malformed"
  | "version"
  | "bad_room"
  /** No room with that code exists here. The code names nothing. */
  | "unknown_room"
  /**
   * The room exists and this connection is in it, but it has no TV right now:
   * everything addressed to the TV while the TV is away is refused with this.
   *
   * Deliberately its own code rather than `unknown_room`, which it used to
   * share. The two are the same refusal to the relay and opposite states to a
   * phone: a room waiting for its TV is a gap to sit out with the seat still
   * held, while a room that does not exist -- a relay that restarted has
   * forgotten it -- is a game that is over. A phone cannot tell them apart
   * from its own side, because it keeps the room code it was admitted with on
   * purpose (that is what returns it to the same room after a blip), so the
   * code on the wire is the only thing that can.
   */
  | "no_tv_yet"
  | "room_has_tv"
  | "too_many_peers"
  /** A `kind: "tv"` hello named a room whose TV is not this connection. */
  | "not_the_tv";

export interface RelayErrorMessage {
  t: "relay_error";
  code: RelayErrorCode;
  detail: string;
}

/** Where a game message is addressed. The relay resolves `"tv"` to the TV peer. */
export type RelayTarget = "tv" | "all" | PeerId;

/**
 * Client -> relay: forward this payload. Note there is no `from`: a client
 * cannot say who it is. The relay stamps the sender's own id on the way
 * through, so the TV knows which phone an intent came from and no phone can
 * claim to be another.
 */
export interface ClientRelayRequest {
  t: "relay";
  to: RelayTarget;
  payload: GameMessage;
}

/** Relay -> client: a forwarded payload, stamped with its real sender. */
export interface RelayEnvelope {
  t: "relay";
  from: PeerId;
  to: RelayTarget;
  payload: GameMessage;
}

export type ClientToRelay = HelloMessage | ClientRelayRequest;
export type RelayToClient =
  | WelcomeMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | RelayErrorMessage
  | RelayEnvelope;

/* ------------------------------------------------------------------ */
/* Game layer (TV <-> phone)                                           */
/* ------------------------------------------------------------------ */

/** One line of the certificate badge, phrased for a 10-foot screen. */
export interface BadgeLine {
  label: string;
  ok: boolean;
  detail: string;
}

export interface BadgeView {
  ok: boolean;
  /** The certificate's own digest. Shown so the claim is checkable, not decorative. */
  hash: string;
  lines: BadgeLine[];
}

/** A clue only the holder can see. Private tokens never leave the TV except here. */
export interface PhoneClue {
  id: string;
  text: string;
}

/** One selectable thing on a phone: an action, or one alternative of a choice. */
export interface Choice {
  id: string;
  label: string;
  hint?: string;
}

export interface PhoneView {
  /** Null until the TV has assigned a role. */
  role: RoleId | null;
  capabilities: Capability[];
  mode: "waiting" | "dpad" | "voice" | "scan";
  /** What the TV wants this phone to do, in one line. */
  prompt: string;
  /** This role's private clues, and only this role's. */
  clues: PhoneClue[];
  /** At most `SCAN_MAX_OPTIONS`, always. */
  choices: Choice[];
  choiceKind: "none" | "action" | "option";
  badge: BadgeView | null;
  /**
   * Roles somebody is already sitting in. A phone offering a role picker must
   * disable these rather than let a player choose one and be refused.
   */
  takenRoles: RoleId[];
  /**
   * Roles among `takenRoles` whose phone has dropped and is inside its grace
   * window: nobody is there right now, but the seat is not free either. A
   * phone with no role of its own is told which these are so it can explain
   * what is happening, rather than just showing "taken" for a seat that is
   * actually recoverable.
   */
  heldRoles: RoleId[];
  /**
   * The roles the current mystery actually seats -- a subset of the wire's
   * own A/B/C vocabulary. A role picker must offer only these: one outside
   * this list is never taken (nobody can hold a seat the puzzle has no role
   * for), so it would otherwise look free rather than simply not existing.
   */
  seatRoles: RoleId[];
  /** One line of context, e.g. that the TV is rebuilding the puzzle. */
  notice?: string;
  canChangeInput: boolean;
  /** True when this phone may give its role back and pick another. */
  canChangeRole: boolean;
  /**
   * True when this phone is waiting on a seat it presented a token for and has
   * no role of its own. The wait it names is against a seat somebody is
   * PLAYING, so the TV is what ends it -- except that a seat whose holder has
   * since dropped is a chair nobody is in, and a token is what claims one of
   * those, so that seat comes back on this phone's next join -- a reconnect,
   * or the TV returning and this phone re-announcing itself -- without
   * anybody being asked. The join is the part that matters: nothing sends one
   * on the phone's behalf the moment the holder drops, so a phone already
   * connected waits on its own next join rather than on the drop. Either way
   * the phone is told it is in this state, and offers the one move that ends
   * the wait from its own side: say it isn't your seat.
   */
  claimingSeat: boolean;
  /**
   * The role this phone's own BROWSER is already playing, on another tab --
   * null in the ordinary case where it is not.
   *
   * One token per browser means two tabs of one browser are one player, so
   * the second tab is not offered a role at all: the TV would refuse every
   * one of them, and a seat somebody is playing right now is only ever moved
   * by the TV's own approval. (A seat whose holder has dropped is a chair
   * nobody is in, and that one does come back on the token alone.) It is also
   * what tells the phone NOT to rotate its token: a token still backing a
   * live or held seat is the only thing that seat can be reclaimed with.
   */
  otherTabRole: RoleId | null;
}

/** A capability change, with the diff the TV is about to animate. */
export interface DiffLine {
  op: string;
  summary: string;
}

export type SwitchPhase = "start" | "ok" | "refused";

/**
 * What a phone is allowed to say. Note what is missing: there is no "I did
 * this" message. A phone picks one of the choices the TV put on its screen and
 * says which; the TV decides what that means. A phone cannot name an action it
 * was not offered, and cannot act for a role that is not its own.
 */
export type Intent =
  | { k: "choose"; choiceId: string }
  | { k: "request_input_change"; capabilities: Capability[] }
  | { k: "choose_role"; role: RoleId }
  /** give my role back, so I can pick another one */
  | { k: "release_role" }
  /**
   * I am the same player who was holding a seat that dropped, come back on a
   * connection the relay does not recognise (a fresh tab has no seat of its
   * own). `name` is the name I joined with before -- the TV only ever grants
   * this to a seat that is actually being held (disconnected), and never to
   * one somebody is still actively playing.
   */
  | { k: "reclaim_seat"; name: string }
  /**
   * This isn't my seat. A phone that arrived carrying a token for a seat
   * somebody else is playing on -- a second tab, a shared link, a token
   * minted twice in the same browser at the same moment -- is left roleless
   * while it waits for a decision that may never come, because the seat it
   * names is not held by anybody. It says so here, and the TV drops the
   * claim: the phone is an ordinary new arrival again and can pick a role.
   */
  | { k: "release_claim" }
  /**
   * Skip the rebuild moment, or dismiss a refusal. Deliberately its own
   * intent, never folded into `choose`: the dismissal must never also pick a
   * puzzle answer.
   */
  | { k: "continue_switch" };

export type GameMessage =
  /**
   * phone -> tv: I am here; give me a role (or the one I asked for).
   *
   * `seat` is the phone's own identity, and it is the only thing that survives
   * a reconnect: the relay hands out a fresh peer id to every new connection,
   * so without a seat the TV cannot tell a phone coming back from a phone
   * arriving for the first time.
   */
  | { t: "join"; name?: string; want?: RoleId; seat?: string }
  /** tv -> phone: you are this role (or null, with a reason). */
  | { t: "assigned"; role: RoleId | null; reason?: string }
  /** tv -> phone: everything this phone should render, and nothing else. */
  | { t: "view"; view: PhoneView }
  /** phone -> tv: what the player did. The TV decides whether it is legal. */
  | { t: "intent"; intent: Intent }
  /** tv -> phones: the switch moment, start to finish. */
  | {
      t: "switch";
      phase: SwitchPhase;
      role: RoleId;
      capabilities: Capability[];
      diff: DiffLine[];
      reason?: string;
    }
  /**
   * tv -> phone: a newer connection presented this seat's own token while
   * this one was still live, and the TV kept the newer one. This connection
   * is done -- it holds no role here any more, and the peer id it arrived on
   * is gone from the TV's own state -- so it closes itself rather than sit on
   * a socket the TV has already moved past.
   */
  | { t: "superseded" };

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

export type Decoded<T> = { ok: true; message: T } | { ok: false; reason: string };

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function encode(message: ClientToRelay | RelayToClient | GameMessage): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRoom(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Relay -> client. Used by the relay's own tests and by both clients. */
export function decodeRelayMessage(raw: string): Decoded<RelayToClient> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("not JSON");
  }
  if (!isRecord(parsed)) return refuse("not an object");
  switch (parsed.t) {
    case "welcome": {
      if (typeof parsed.room !== "string") return refuse("welcome.room");
      if (typeof parsed.peerId !== "string") return refuse("welcome.peerId");
      if (parsed.kind !== "tv" && parsed.kind !== "phone") return refuse("welcome.kind");
      if (!Array.isArray(parsed.peers)) return refuse("welcome.peers");
      const peers: PeerSummary[] = [];
      for (const entry of parsed.peers) {
        if (!isRecord(entry) || typeof entry.peerId !== "string") return refuse("welcome.peers[]");
        if (entry.kind !== "tv" && entry.kind !== "phone") return refuse("welcome.peers[].kind");
        peers.push({
          peerId: entry.peerId,
          kind: entry.kind,
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        });
      }
      // Only a TV's welcome carries one, and nothing here decides that -- the
      // relay sends it or does not. Where it is present it is normalised to
      // the mint's own shape, so a client never keeps something a later hello
      // would only have dropped.
      const hostToken = isHostToken(parsed.hostToken) ? parsed.hostToken : undefined;
      return {
        ok: true,
        message: {
          t: "welcome",
          v: typeof parsed.v === "number" ? parsed.v : PROTOCOL_VERSION,
          room: parsed.room,
          peerId: parsed.peerId,
          kind: parsed.kind,
          peers,
          ...(hostToken !== undefined ? { hostToken } : {}),
        },
      };
    }
    case "peer_joined": {
      const peer = parsed.peer;
      if (!isRecord(peer) || typeof peer.peerId !== "string") return refuse("peer_joined.peer");
      if (peer.kind !== "tv" && peer.kind !== "phone") return refuse("peer_joined.peer.kind");
      return {
        ok: true,
        message: {
          t: "peer_joined",
          peer: {
            peerId: peer.peerId,
            kind: peer.kind,
            ...(typeof peer.name === "string" ? { name: peer.name } : {}),
          },
        },
      };
    }
    case "peer_left": {
      if (typeof parsed.peerId !== "string") return refuse("peer_left.peerId");
      return { ok: true, message: { t: "peer_left", peerId: parsed.peerId } };
    }
    case "relay_error": {
      if (typeof parsed.code !== "string") return refuse("relay_error.code");
      return {
        ok: true,
        message: {
          t: "relay_error",
          code: parsed.code as RelayErrorCode,
          detail: typeof parsed.detail === "string" ? parsed.detail : "",
        },
      };
    }
    case "relay": {
      if (typeof parsed.from !== "string" || parsed.from.length === 0) return refuse("relay.from");
      if (parsed.to !== "tv" && parsed.to !== "all" && typeof parsed.to !== "string") {
        return refuse("relay.to");
      }
      const payload = decodeGameMessage(parsed.payload);
      if (!payload.ok) return refuse(`relay.payload: ${payload.reason}`);
      return {
        ok: true,
        message: { t: "relay", from: parsed.from, to: parsed.to, payload: payload.message },
      };
    }
    default:
      return refuse(`unknown type ${JSON.stringify(parsed.t)}`);
  }
}

/** Client -> relay. The relay refuses anything that does not decode. */
export function decodeClientMessage(raw: string): Decoded<ClientToRelay> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("not JSON");
  }
  if (!isRecord(parsed)) return refuse("not an object");
  if (parsed.t === "hello") {
    if (parsed.kind !== "tv" && parsed.kind !== "phone") return refuse("hello.kind");
    const room = readRoom(parsed.room);
    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    // Dropped rather than refused when it is not the shape the relay mints:
    // the relay compares against what it issued, so a credential that did not
    // survive this line is a credential the hello does not have -- refused as
    // a stranger, which is where that ends up anyway.
    const hostToken = isHostToken(parsed.hostToken) ? parsed.hostToken : undefined;
    return {
      ok: true,
      message: {
        t: "hello",
        v: typeof parsed.v === "number" ? parsed.v : PROTOCOL_VERSION,
        kind: parsed.kind,
        ...(room !== undefined ? { room } : {}),
        ...(hostToken !== undefined ? { hostToken } : {}),
        ...(name !== undefined ? { name } : {}),
      },
    };
  }
  if (parsed.t === "relay") {
    if (parsed.to !== "tv" && parsed.to !== "all" && typeof parsed.to !== "string") {
      return refuse("relay.to");
    }
    // `from` is deliberately ignored if present: the relay stamps it.
    const payload = decodeGameMessage(parsed.payload);
    if (!payload.ok) return refuse(`relay.payload: ${payload.reason}`);
    return { ok: true, message: { t: "relay", to: parsed.to, payload: payload.message } };
  }
  return refuse(`unknown type ${JSON.stringify(parsed.t)}`);
}

export function decodeGameMessage(value: unknown): Decoded<GameMessage> {
  if (!isRecord(value)) return refuse("not an object");
  switch (value.t) {
    case "join": {
      const want = isRoleId(value.want) ? value.want : undefined;
      const name = typeof value.name === "string" ? value.name.slice(0, 24) : undefined;
      // A seat is a credential, and it is also copied into the TV's markup --
      // the fingerprint of a reclaim request carries it, and the remote's own
      // focus ring is a set of ids built from that fingerprint. So it is
      // accepted only in the exact shape the phone mints (`isSeatToken`) and
      // refused at the door otherwise: truncating an arbitrary string to 64
      // characters would still leave quotes, brackets and newlines in it, and
      // the reducer would still be handed them.
      if (value.seat !== undefined && !isSeatToken(value.seat)) return refuse("join.seat");
      const seat = isSeatToken(value.seat) ? value.seat : undefined;
      return {
        ok: true,
        message: {
          t: "join",
          ...(name !== undefined ? { name } : {}),
          ...(want !== undefined ? { want } : {}),
          ...(seat !== undefined ? { seat } : {}),
        },
      };
    }
    case "assigned": {
      const role = isRoleId(value.role) ? value.role : null;
      return {
        ok: true,
        message: {
          t: "assigned",
          role,
          ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
        },
      };
    }
    case "view": {
      const view = decodePhoneView(value.view);
      if (!view.ok) return refuse(`view: ${view.reason}`);
      return { ok: true, message: { t: "view", view: view.view } };
    }
    case "intent": {
      const intent = decodeIntent(value.intent);
      if (!intent.ok) return refuse(`intent: ${intent.reason}`);
      return { ok: true, message: { t: "intent", intent: intent.message } };
    }
    case "switch": {
      if (!isRoleId(value.role)) return refuse("switch.role");
      if (value.phase !== "start" && value.phase !== "ok" && value.phase !== "refused") {
        return refuse("switch.phase");
      }
      const capabilities = decodeCapabilities(value.capabilities);
      if (capabilities === null) return refuse("switch.capabilities");
      const diff = decodeDiff(value.diff);
      if (diff === null) return refuse("switch.diff");
      return {
        ok: true,
        message: {
          t: "switch",
          phase: value.phase,
          role: value.role,
          capabilities,
          diff,
          ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
        },
      };
    }
    case "superseded":
      return { ok: true, message: { t: "superseded" } };
    default:
      return refuse(`unknown type ${JSON.stringify(value.t)}`);
  }
}

export function decodeIntent(value: unknown): Decoded<Intent> {
  if (!isRecord(value)) return refuse("not an object");
  switch (value.k) {
    case "choose": {
      if (typeof value.choiceId !== "string" || value.choiceId.length === 0) {
        return refuse("choose.choiceId");
      }
      if (value.choiceId.length > 200) return refuse("choose.choiceId too long");
      return { ok: true, message: { k: "choose", choiceId: value.choiceId } };
    }
    case "request_input_change": {
      const capabilities = decodeCapabilities(value.capabilities);
      if (capabilities === null || capabilities.length === 0) {
        return refuse("request_input_change.capabilities");
      }
      return { ok: true, message: { k: "request_input_change", capabilities } };
    }
    case "choose_role": {
      if (!isRoleId(value.role)) return refuse("choose_role.role");
      return { ok: true, message: { k: "choose_role", role: value.role } };
    }
    case "release_role":
      return { ok: true, message: { k: "release_role" } };
    case "reclaim_seat": {
      if (typeof value.name !== "string" || value.name.trim() === "") {
        return refuse("reclaim_seat.name");
      }
      return { ok: true, message: { k: "reclaim_seat", name: value.name.slice(0, 24) } };
    }
    case "release_claim":
      return { ok: true, message: { k: "release_claim" } };
    case "continue_switch":
      return { ok: true, message: { k: "continue_switch" } };
    default:
      return refuse(`unknown intent ${JSON.stringify(value.k)}`);
  }
}

function decodeCapabilities(value: unknown): Capability[] | null {
  if (!Array.isArray(value)) return null;
  const out: Capability[] = [];
  for (const entry of value) {
    if (!isCapability(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function decodeDiff(value: unknown): DiffLine[] | null {
  if (!Array.isArray(value)) return null;
  const out: DiffLine[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.op !== "string" || typeof entry.summary !== "string") return null;
    out.push({ op: entry.op, summary: entry.summary });
  }
  return out;
}

function decodePhoneView(value: unknown): { ok: true; view: PhoneView } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "not an object" };
  const role = isRoleId(value.role) ? value.role : null;
  const capabilities = decodeCapabilities(value.capabilities);
  if (capabilities === null) return { ok: false, reason: "capabilities" };
  const clues = decodeClues(value.clues);
  if (clues === null) return { ok: false, reason: "clues" };
  const choices = decodeChoices(value.choices);
  if (choices === null) return { ok: false, reason: "choices" };
  // The 4-option bound is a property of the model, not a UI preference: a phone
  // that renders a 5-item scan list would be showing a choice the validator says
  // cannot be scanned. Refuse it at the door rather than render it.
  if (choices.length > SCAN_MAX_OPTIONS) return { ok: false, reason: "too many choices" };
  const badge = value.badge === null || value.badge === undefined ? null : decodeBadge(value.badge);
  if (value.badge !== null && value.badge !== undefined && badge === null) {
    return { ok: false, reason: "badge" };
  }
  const mode = value.mode;
  if (mode !== "waiting" && mode !== "dpad" && mode !== "voice" && mode !== "scan") {
    return { ok: false, reason: "mode" };
  }
  const choiceKind = value.choiceKind;
  if (choiceKind !== "none" && choiceKind !== "action" && choiceKind !== "option") {
    return { ok: false, reason: "choiceKind" };
  }
  if (value.takenRoles !== undefined && !Array.isArray(value.takenRoles)) {
    return { ok: false, reason: "takenRoles" };
  }
  const takenRoles = Array.isArray(value.takenRoles)
    ? value.takenRoles.filter(isRoleId)
    : ([] as RoleId[]);
  const heldRoles = Array.isArray(value.heldRoles)
    ? value.heldRoles.filter(isRoleId)
    : ([] as RoleId[]);
  const seatRoles = Array.isArray(value.seatRoles)
    ? value.seatRoles.filter(isRoleId)
    : ([] as RoleId[]);
  return {
    ok: true,
    view: {
      role,
      capabilities,
      mode,
      prompt: typeof value.prompt === "string" ? value.prompt : "",
      clues,
      choices,
      choiceKind,
      badge,
      takenRoles,
      heldRoles,
      seatRoles,
      ...(typeof value.notice === "string" ? { notice: value.notice } : {}),
      canChangeInput: value.canChangeInput === true,
      canChangeRole: value.canChangeRole === true,
      claimingSeat: value.claimingSeat === true,
      otherTabRole: isRoleId(value.otherTabRole) ? value.otherTabRole : null,
    },
  };
}

function decodeClues(value: unknown): PhoneClue[] | null {
  if (!Array.isArray(value)) return null;
  const out: PhoneClue[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.id !== "string" || typeof entry.text !== "string") return null;
    out.push({ id: entry.id, text: entry.text });
  }
  return out;
}

function decodeChoices(value: unknown): Choice[] | null {
  if (!Array.isArray(value)) return null;
  const out: Choice[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.id !== "string" || typeof entry.label !== "string") return null;
    out.push({
      id: entry.id,
      label: entry.label,
      ...(typeof entry.hint === "string" ? { hint: entry.hint } : {}),
    });
  }
  return out;
}

function decodeBadge(value: unknown): BadgeView | null {
  if (!isRecord(value)) return null;
  if (typeof value.ok !== "boolean" || typeof value.hash !== "string") return null;
  if (!Array.isArray(value.lines)) return null;
  const lines: BadgeLine[] = [];
  for (const entry of value.lines) {
    if (!isRecord(entry)) return null;
    if (typeof entry.label !== "string" || typeof entry.ok !== "boolean") return null;
    lines.push({
      label: entry.label,
      ok: entry.ok,
      detail: typeof entry.detail === "string" ? entry.detail : "",
    });
  }
  return { ok: value.ok, hash: value.hash, lines };
}

/* ------------------------------------------------------------------ */
/* Choices                                                             */
/* ------------------------------------------------------------------ */

export const MORE_CHOICE_ID = "__more";

/**
 * Trim a list to at most `max` choices, using the last slot for "more" when
 * something had to be left out. The bound is the model's, so this is the only
 * place that is allowed to shorten a list -- and it never hides the fact that
 * it did.
 */
export function paginateChoices(choices: readonly Choice[], max = SCAN_MAX_OPTIONS): Choice[] {
  if (max < 1) return [];
  if (choices.length <= max) return [...choices];
  return [
    ...choices.slice(0, max - 1),
    { id: MORE_CHOICE_ID, label: "More…", hint: `${choices.length - (max - 1)} more` },
  ];
}
