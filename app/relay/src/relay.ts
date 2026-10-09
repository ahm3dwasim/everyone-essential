/**
 * The relay: rooms, and routing between the TV and the phones in them.
 *
 * It is deliberately stupid. It does not know what a puzzle is, it does not
 * read a game message, and it cannot decide anything about play -- it decodes
 * the transport envelope, checks that the sender is allowed to address the
 * target, and forwards the payload untouched. The TV is the authority; the
 * relay is the wire.
 *
 * The socket is injected rather than imported, so the whole of this file is
 * testable without a network, and `main.ts` is the only part that knows `ws`
 * exists.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  HOST_TOKEN_BYTES,
  PROTOCOL_VERSION,
  ROOM_TOMBSTONE_MS,
  decodeClientMessage,
  encode,
  type PeerId,
  type PeerSummary,
  type PlayerKind,
  type RelayErrorMessage,
  type RelayErrorCode,
  type RelayTarget,
  type RelayToClient,
  type RoomCode,
  type HelloMessage,
} from "../../shared/protocol.ts";
import { generateRoomCode, normalizeRoomCode } from "../../shared/rooms.ts";

/**
 * A room's host credential: `HOST_TOKEN_BYTES` bytes from the OS CSPRNG, as
 * lowercase hex. Deliberately not `options.random` -- that one is injected so
 * room codes are predictable under test, and a room code is public anyway (it
 * is on the TV screen and in the join link). This is the only secret a room
 * has, so it comes from the one source that cannot be predicted.
 */
export function mintHostToken(): string {
  return randomBytes(HOST_TOKEN_BYTES).toString("hex");
}

/**
 * What the relay keeps of a credential: its digest, and never the credential
 * itself. A mint is written once -- into the welcome of the one connection it
 * was minted for -- and what stays behind is the digest, which is all a later
 * hello is ever compared against. Nothing can be read back out of a digest,
 * so a relay that is asked for everything it holds has no credential to give.
 */
function credentialDigest(credential: string): Buffer {
  return createHash("sha256").update(credential, "utf8").digest();
}

/**
 * Whether a connection presented the credential a room is currently known by,
 * without the time taken saying where the two first differ. Both sides are
 * hashed first, so the comparison is over a fixed number of bytes whatever was
 * presented -- including nothing at all, which is every hello from a
 * connection that is not this room's TV.
 */
function sameCredential(presented: string | undefined, known: Buffer): boolean {
  return timingSafeEqual(credentialDigest(presented ?? ""), known);
}

export interface Socket {
  send(data: string): void;
}

export interface Client {
  id: PeerId;
  socket: Socket;
  kind: PlayerKind | null;
  room: RoomCode | null;
  name?: string;
}

export interface RelayOptions {
  /** Injected so room codes are deterministic under test. */
  random?: () => number;
  maxPeersPerRoom?: number;
  /** How many times to retry a colliding room code before giving up. */
  roomCodeAttempts?: number;
  /** Injected so the reconnect window can be spent without waiting it out. */
  now?: () => number;
}

interface Room {
  code: RoomCode;
  /**
   * The digest of the one credential that currently makes a connection this
   * room's TV. It is minted with the room, put in the welcome of the
   * connection that made it, and minted again for every welcome a TV gets
   * after that -- so the credential a TV holds is always the newest one, and
   * the one it presented a moment ago is spent.
   */
  credential: Buffer;
  tv: PeerId | null;
  peers: Map<PeerId, Client>;
}

/**
 * What an emptied room leaves behind. The room stops routing the moment its
 * last peer goes, but deleting it would delete the only record of what its TV
 * holds -- and a room code is public, so a room that can be made again by
 * anyone who read four letters off a screen is a room anyone can be the TV of.
 * Until `until`, the code belongs to this room: only the credential whose
 * digest is here opens it, and it is not a code a new room can be given.
 */
interface Tombstone {
  code: RoomCode;
  credential: Buffer;
  until: number;
}

export interface Delivery {
  to: PeerId;
  message: RelayToClient;
}

export class Relay {
  private readonly clients = new Map<PeerId, Client>();
  private readonly rooms = new Map<RoomCode, Room>();
  /** Rooms that have emptied, and stop being rooms this relay knows about. */
  private readonly tombstones = new Map<RoomCode, Tombstone>();
  private readonly random: () => number;
  private readonly maxPeers: number;
  private readonly codeAttempts: number;
  private readonly now: () => number;
  private counter = 0;

  constructor(options: RelayOptions = {}) {
    this.random = options.random ?? Math.random;
    this.maxPeers = options.maxPeersPerRoom ?? 8;
    this.codeAttempts = options.roomCodeAttempts ?? 50;
    this.now = options.now ?? Date.now;
  }

  add(socket: Socket): Client {
    this.counter += 1;
    const client: Client = {
      id: `p${this.counter}-${Math.floor(this.random() * 1e9).toString(36)}`,
      socket,
      kind: null,
      room: null,
    };
    this.clients.set(client.id, client);
    return client;
  }

  remove(clientId: PeerId): Delivery[] {
    const client = this.clients.get(clientId);
    if (!client) return [];
    this.clients.delete(clientId);
    if (!client.room) return [];
    const room = this.rooms.get(client.room);
    if (!room) return [];
    room.peers.delete(clientId);
    if (room.tv === clientId) room.tv = null;
    const deliveries = this.deliver(this.broadcast(room, clientId, { t: "peer_left", peerId: clientId }));
    if (room.peers.size === 0) {
      this.rooms.delete(room.code);
      // Not forgotten, just no longer live: the room's own TV can still come
      // back to it, and until the window closes nobody else can make it.
      this.tombstones.set(room.code, {
        code: room.code,
        credential: room.credential,
        until: this.now() + ROOM_TOMBSTONE_MS,
      });
    }
    return deliveries;
  }

  /** Handle one raw frame. Returns what was delivered, for tests and for logging. */
  receive(clientId: PeerId, raw: string): Delivery[] {
    const client = this.clients.get(clientId);
    if (!client) return [];
    this.forgetExpired();
    const decoded = decodeClientMessage(raw);
    if (!decoded.ok) return this.fail(client, "malformed", decoded.reason);
    if (decoded.message.t === "hello") return this.hello(client, decoded.message);
    return this.route(client, decoded.message.to, decoded.message.payload);
  }

  /** The rooms that are live right now. An emptied one is not one of these. */
  rooms_(): RoomCode[] {
    this.forgetExpired();
    return [...this.rooms.keys()];
  }

  /** The emptied rooms still inside their window. */
  tombstones_(): RoomCode[] {
    this.forgetExpired();
    return [...this.tombstones.keys()];
  }

  /**
   * Forget the emptied rooms whose window has closed. Checked where the
   * answer can change rather than on a timer: the relay has no scheduler of
   * its own, and a room nobody ever asks about costs nothing to keep.
   */
  private forgetExpired(): void {
    const at = this.now();
    for (const [code, tombstone] of this.tombstones) {
      if (tombstone.until <= at) this.tombstones.delete(code);
    }
  }

  /** The decoded hello, minus its `t`, which the caller has already read. */
  private hello(client: Client, hello: Omit<HelloMessage, "t">): Delivery[] {
    if (client.room) return this.fail(client, "malformed", "already joined a room");
    if (hello.v !== PROTOCOL_VERSION) {
      return this.fail(client, "version", `this relay speaks version ${PROTOCOL_VERSION}`);
    }
    const name = hello.name?.slice(0, 24);

    let room: Room;
    /** The credential this connection is being handed, when it is a TV's. */
    let issued: string | null = null;
    if (hello.kind === "tv") {
      // A TV that names a room is either claiming one that exists or making a
      // new one at a code it chose; one that names nothing is handed a fresh
      // code. Only the first is a claim about who is asking.
      let code: RoomCode | null = null;
      if (hello.room !== undefined) {
        code = normalizeRoomCode(hello.room);
        if (!code) return this.fail(client, "bad_room", "a room code is four letters");
      }
      const existing = code === null ? undefined : this.rooms.get(code);
      const emptied = code === null ? undefined : this.tombstones.get(code);
      if (existing) {
        if (existing.tv !== null) {
          return this.fail(client, "room_has_tv", `room ${existing.code} already has a TV`);
        }
        // The one gate a room code cannot open. A code is public by design --
        // it is on the TV screen and in the join link -- so knowing it can
        // never be what makes a connection the TV. Only the room's own
        // credential can, and a room whose TV has gone leaves that room, and
        // the phones in it, waiting for the one connection that holds it.
        if (!sameCredential(hello.hostToken, existing.credential)) {
          return this.fail(client, "not_the_tv", `room ${existing.code} is not taking a new TV`);
        }
        room = existing;
      } else if (emptied) {
        // A room whose last peer left a moment ago. It is still its own TV's
        // room until the window closes: the credential that was live when it
        // emptied is the only thing that opens it, and the code is not a code
        // a claim can be made at. Coming back through here is coming back to
        // the room the phones in it knew, not making a room that looks like it.
        if (!sameCredential(hello.hostToken, emptied.credential)) {
          return this.fail(client, "not_the_tv", `room ${emptied.code} is not taking a new TV`);
        }
        this.tombstones.delete(emptied.code);
        const made = this.newRoom(emptied.code);
        room = made.room;
        issued = made.credential;
        this.rooms.set(room.code, room);
      } else {
        const made = code === null ? this.createRoom() : this.newRoom(code);
        if (!made) return this.fail(client, "bad_room", "could not allocate a room code");
        room = made.room;
        issued = made.credential;
        this.rooms.set(room.code, room);
      }
      if (room.peers.size >= this.maxPeers) {
        return this.fail(client, "too_many_peers", `room ${room.code} is full`);
      }
      // A room that was already live keeps routing on the credential it has
      // until here: the next one is minted only once this hello is known to be
      // accepted, so a connection that is refused spends nothing -- a refused
      // TV that had spent the room's credential without being handed the new
      // one would have locked the room's own TV out of it.
      if (issued === null) issued = this.rotate(room);
      client.kind = "tv";
      client.room = room.code;
      client.name = name;
      room.tv = client.id;
      room.peers.set(client.id, client);
    } else {
      const wanted = hello.room === undefined ? null : normalizeRoomCode(hello.room);
      if (!wanted) return this.fail(client, "bad_room", "a room code is four letters");
      const found = this.rooms.get(wanted);
      if (!found) {
        // An emptied room is not a room a phone can be SEATED in: nobody is
        // there to answer it, and seating it would be seating it next to
        // whoever makes the room again. But it is not a room that is GONE, not
        // while its tombstone is still here. Its own TV can come back to it
        // inside that window with the credential it holds, and a phone
        // reconnecting inside the same window is the ordinary case: one
        // network loss closes every socket in the room, so the phones and the
        // TV come back from the same blip.
        //
        // So it is told what a phone is told about a room that is there and
        // has no TV in it: wait. A room resting until its TV returns and a
        // room waiting for a TV that stepped out are the same wait from a
        // phone's side, and one word for both is what keeps the phone from
        // having to guess which it is looking at. It read `unknown_room` here
        // for one round, and that is the code a phone reads as "the game has
        // ended on the TV": a Wi-Fi blip took the whole room down and every
        // phone in it cleared its room and left, and the TV then came back to
        // a room with nobody in it.
        //
        // `unknown_room` goes back to meaning what it says: a code that names
        // nothing here at all.
        if (this.tombstones.has(wanted)) {
          return this.fail(client, "no_tv_yet", `room ${wanted} is waiting for its TV`);
        }
        return this.fail(client, "unknown_room", `no room ${wanted} — check the code on the TV`);
      }
      room = found;
      if (room.peers.size >= this.maxPeers) {
        return this.fail(client, "too_many_peers", `room ${room.code} is full`);
      }
      client.kind = "phone";
      client.room = room.code;
      client.name = name;
      room.peers.set(client.id, client);
    }

    const summary = this.summary(client);
    const deliveries: Delivery[] = [
      {
        to: client.id,
        message: {
          t: "welcome",
          v: PROTOCOL_VERSION,
          room: room.code,
          peerId: client.id,
          kind: hello.kind,
          // The credential this TV is to hold from here on, to the connection
          // that is this room's TV and to no one else. Whatever it presented
          // to get here is spent by this welcome. It is not in `peers` below
          // and not in any broadcast: the summary a room is told about another
          // peer is built by `summary`, which has nowhere to put it.
          ...(issued !== null ? { hostToken: issued } : {}),
          peers: [...room.peers.values()].map((peer) => this.summary(peer)),
        },
      },
    ];
    deliveries.push(...this.broadcast(room, client.id, { t: "peer_joined", peer: summary }));
    return this.deliver(deliveries);
  }

  private route(client: Client, to: RelayTarget, payload: unknown): Delivery[] {
    if (!client.room) return this.fail(client, "malformed", "join a room first");
    const room = this.rooms.get(client.room);
    if (!room) return this.fail(client, "unknown_room", "the room is gone");

    // A phone speaks with the TV's authority, never its own: every game
    // message a phone is allowed to send is addressed to the TV, so a phone
    // that names any other target -- a peer id, or "all" -- is dropped here
    // rather than forwarded. Without this, a phone could address another
    // phone directly (a forged `superseded`, closing it) or broadcast to the
    // whole room, and the receiving phones have no way to tell that from the
    // TV's own authority once it is on the wire.
    if (client.kind === "phone" && to !== "tv") {
      return this.fail(client, "malformed", "a phone may only address the TV");
    }

    // The sender is stamped here, from the connection, never from the frame.
    const message = { t: "relay" as const, from: client.id, to, payload: payload as never };
    if (to === "all") {
      return this.deliver(this.broadcast(room, client.id, message));
    }
    if (to === "tv") {
      // Not `unknown_room`: this room exists and this phone is in it. The
      // code is what lets a phone tell the TV stepping out from the room
      // being gone, which are a wait and a departure respectively.
      if (room.tv === null) return this.fail(client, "no_tv_yet", "no TV in this room yet");
      // A phone addressing the TV is the normal path; a TV addressing itself is not.
      if (room.tv === client.id) return this.fail(client, "malformed", "the TV cannot address itself");
      return this.deliver([{ to: room.tv, message }]);
    }
    // A direct peer id: only within this room, and never to yourself.
    const target = room.peers.get(to);
    if (!target) return this.fail(client, "malformed", `no peer ${to} in this room`);
    if (target.id === client.id) return this.fail(client, "malformed", "cannot address yourself");
    return this.deliver([{ to: target.id, message }]);
  }

  /**
   * The one place a room is built, so the credential is minted with it. The
   * credential itself is returned rather than kept: it goes into the welcome
   * of the connection that made the room, and the room holds only its digest.
   */
  private newRoom(code: RoomCode): { room: Room; credential: string } {
    const credential = mintHostToken();
    return {
      room: { code, credential: credentialDigest(credential), tv: null, peers: new Map() },
      credential,
    };
  }

  /** Mint the next credential for a live room, and remember only its digest. */
  private rotate(room: Room): string {
    const credential = mintHostToken();
    room.credential = credentialDigest(credential);
    return credential;
  }

  private createRoom(): { room: Room; credential: string } | undefined {
    for (let attempt = 0; attempt < this.codeAttempts; attempt++) {
      const code = generateRoomCode(this.random);
      // A code an emptied room is still remembered by is not a free code: it
      // is the code that room's own TV will come back to.
      if (!this.rooms.has(code) && !this.tombstones.has(code)) return this.newRoom(code);
    }
    return undefined;
  }

  private summary(client: Client): PeerSummary {
    return {
      peerId: client.id,
      kind: client.kind ?? "phone",
      ...(client.name ? { name: client.name } : {}),
    };
  }

  private broadcast(room: Room, exceptId: PeerId, message: RelayToClient): Delivery[] {
    const deliveries: Delivery[] = [];
    for (const peer of room.peers.values()) {
      if (peer.id === exceptId) continue;
      deliveries.push({ to: peer.id, message });
    }
    return deliveries;
  }

  private fail(client: Client, code: RelayErrorCode, detail: string): Delivery[] {
    const message: RelayErrorMessage = { t: "relay_error", code, detail };
    return this.deliver([{ to: client.id, message }]);
  }

  private deliver(deliveries: Delivery[]): Delivery[] {
    for (const delivery of deliveries) {
      const target = this.clients.get(delivery.to);
      if (!target) continue;
      target.socket.send(encode(delivery.message));
    }
    return deliveries;
  }
}
