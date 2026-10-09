/**
 * A phone refused by a room that is resting between TVs dials again until its
 * TV is back.
 *
 * A room whose last peer goes is not deleted: it is remembered for
 * `ROOM_TOMBSTONE_MS` so its own TV can come back to it with the credential the
 * room issued it, and so nobody else can make the room at a code that is on a
 * screen the whole family can read. A phone that was in the room reconnects
 * inside the same window, because one network loss closes every socket in it.
 *
 * That phone's hello is refused -- the room has no TV in it yet -- and that
 * refusal is a WAIT rather than a departure, so the phone stays and shows the
 * waiting screen. But a socket whose hello was refused is a socket in no room,
 * and the relay announces a TV's return only to the peers of the room it
 * returned to. Nothing is sent to a connection that is not in one, and a
 * browser answers the relay's heartbeats, so this socket is never reaped
 * either: the phone waits on a connection that can never carry the news it is
 * waiting for.
 *
 * The wait can therefore only end on a fresh hello, which means the refusal has
 * to put the phone back on the dial. This is the same shape as the TV's own
 * `room_has_tv` -- a claim refused because the relay has not caught up yet,
 * where dialling again is the whole repair -- and the same growing wait between
 * attempts, so the phone does not hammer a room that stays empty.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Relay, type Socket } from "../app/relay/src/relay.ts";
import { createRelayClient, type WebSocketLike } from "../app/shared/client.ts";
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  decodeRelayMessage,
  encode,
  type HelloMessage,
  type RelayErrorMessage,
  type RelayToClient,
} from "../app/shared/protocol.ts";

const SEAT = "0123456789abcdef0123456789abcdef";

/** The relay's end of a connection that is not the client under test: the TV's. */
class TvSide implements Socket {
  readonly received: RelayToClient[] = [];

  send(data: string): void {
    const decoded = decodeRelayMessage(data);
    if (!decoded.ok) throw new Error(`the relay sent something undecodable: ${decoded.reason}`);
    this.received.push(decoded.message);
  }

  last(): RelayToClient | undefined {
    return this.received[this.received.length - 1];
  }

  /** The credential the room was issued, read off the welcome that carried it. */
  credential(): string {
    const welcome = this.received.find((message) => message.t === "welcome");
    if (welcome?.t !== "welcome" || welcome.hostToken === undefined) {
      throw new Error("this socket was never welcomed as a TV");
    }
    return welcome.hostToken;
  }

  room(): string {
    const welcome = this.received.find((message) => message.t === "welcome");
    if (welcome?.t !== "welcome") throw new Error("this socket was never welcomed");
    return welcome.room;
  }
}

/**
 * One phone connection, wired to the relay on both sides: a `WebSocketLike` for
 * the client under test, and the relay's own `Socket` for the relay. A real
 * socket is both of those at once -- what one side writes the other reads -- so
 * this is one object rather than two.
 */
class WiredSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** The relay's id for this connection, from the moment it has one. */
  clientId: string | null = null;
  /** Every frame this client wrote to the relay. */
  readonly wrote: string[] = [];
  /** Every frame the relay sent this connection. */
  readonly received: RelayToClient[] = [];

  private readonly relay: Relay;
  /** The relay's view: a `send` is the network toward this client. */
  readonly socket: Socket = {
    send: (data: string) => {
      const decoded = decodeRelayMessage(data);
      if (!decoded.ok) throw new Error(`the relay sent something undecodable: ${decoded.reason}`);
      this.received.push(decoded.message);
      // A closed socket is not told anything: the relay's own bookkeeping is
      // what stops it sending to one, and this is the same silence a browser
      // gives a frame that arrives after the close.
      if (this.readyState !== 3) this.onmessage?.({ data });
    },
  };

  constructor(relay: Relay) {
    this.relay = relay;
  }

  /** What the client writes: a frame the relay reads. */
  send(data: string): void {
    if (this.clientId === null) throw new Error("this client wrote before the relay knew the socket");
    this.wrote.push(data);
    this.relay.receive(this.clientId, data);
  }

  /** A dialled socket opening, as the browser opens it: the relay learns of it here. */
  open(): void {
    this.readyState = 1;
    this.clientId = this.relay.add(this.socket).id;
    this.onopen?.({});
  }

  /**
   * The connection going away -- the client closing it, or the network taking
   * it. Both ends notice, which is what empties a room.
   */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.clientId !== null) this.relay.remove(this.clientId);
    this.onclose?.({});
  }

  hello(): HelloMessage {
    const decoded = decodeClientMessage(this.wrote[0] ?? "");
    if (!decoded.ok || decoded.message.t !== "hello") {
      throw new Error(`the client did not open with a hello: ${this.wrote[0]}`);
    }
    return decoded.message;
  }

  last(): RelayToClient | undefined {
    return this.received[this.received.length - 1];
  }
}

function relay(): Relay {
  return new Relay({ random: () => 0 });
}

/** A TV joining by hand, so the room and its credential are the test's to hold. */
function tvJoins(r: Relay, body: Record<string, unknown> = {}): { id: string; socket: TvSide; room: string } {
  const socket = new TvSide();
  const id = r.add(socket).id;
  r.receive(id, encode({ t: "hello", v: PROTOCOL_VERSION, kind: "tv", ...body } as never));
  return { id, socket, room: socket.room() };
}

function phoneClient(r: Relay, room: string) {
  const sockets: WiredSocket[] = [];
  const welcomes: string[] = [];
  const errors: RelayErrorMessage[] = [];
  const client = createRelayClient({
    url: "ws://relay.test",
    kind: "phone",
    room,
    socketFactory: () => {
      const socket = new WiredSocket(r);
      sockets.push(socket);
      return socket;
    },
    handlers: {
      onWelcome: (welcome) => welcomes.push(welcome.room),
      onRelayError: (error) => errors.push(error),
    },
  });
  return { client, sockets, welcomes, errors };
}

/**
 * The clock moving forward, with the sockets it dialled opened -- a browser
 * opens a WebSocket by itself, so a connection the client asked for is one the
 * relay hears about without anyone else's help. The relay answers
 * synchronously, so a socket is refused or welcomed by the time this returns.
 */
function dial(sockets: WiredSocket[], ms: number): WiredSocket[] {
  vi.advanceTimersByTime(ms);
  const fresh = sockets.filter((socket) => socket.clientId === null && socket.readyState === 0);
  for (const socket of fresh) socket.open();
  return fresh;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a phone whose hello is refused by a room resting between TVs", () => {
  it("closes the refused socket, dials again, and is seated the moment its TV is back", () => {
    vi.useFakeTimers();
    const r = relay();
    const tv = tvJoins(r);
    const room = tv.room;

    const { sockets, welcomes, errors } = phoneClient(r, room);
    const joined = sockets[0]!;
    joined.open();
    expect(welcomes).toEqual([room]);
    // The ordinary join a phone sends once it is in a room: this is what puts
    // its seat in the TV's hands, and it is the message the wait is about.
    joined.send(encode({ t: "relay", to: "tv", payload: { t: "join", seat: SEAT } } as never));
    expect(tv.socket.last()).toMatchObject({ t: "relay", from: joined.clientId, payload: { t: "join", seat: SEAT } });

    // One network loss closes every socket in the room with it. The room
    // empties and rests; its own TV can still come back to it.
    r.remove(tv.id);
    joined.close();
    expect(r.rooms_()).toEqual([]);
    expect(r.tombstones_()).toEqual([room]);

    // The phone dials first, while the room is still resting: it names the
    // room it was admitted to, and the relay answers with the wait.
    const refused = dial(sockets, 500)[0]!;
    expect(refused.hello()).toMatchObject({ kind: "phone", room });
    expect(refused.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
    expect(welcomes).toEqual([room]); // not seated: there is no TV to be seated next to
    expect(errors.map((error) => error.code)).toEqual(["no_tv_yet"]);

    // The refusal is not a socket to sit on. It is in no room, so nothing will
    // ever be sent to it again -- not the peer list that would name the
    // returning TV, and not a heartbeat, which a browser answers anyway.
    expect(refused.readyState).toBe(3);

    // And so the phone dials again, still naming the room, still refused.
    const again = dial(sockets, 1_000)[0]!;
    expect(again.hello()).toMatchObject({ kind: "phone", room });
    expect(again.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
    expect(again.readyState).toBe(3);

    // The room's own TV comes back to it, with the credential that room issued
    // it -- the one thing that ends the resting window.
    const returning = tvJoins(r, { room, hostToken: tv.socket.credential() });
    expect(returning.socket.last()).toMatchObject({ t: "welcome", room });
    expect(r.rooms_()).toEqual([room]);

    // The phone's next hello is a hello to a room with a TV in it, so it is
    // taken -- the same room, and the seat it presents is the TV's to hand
    // back. This is the news the parked socket could never have carried.
    const back = dial(sockets, 1_500)[0]!;
    expect(back.last()).toMatchObject({ t: "welcome", room });
    expect(welcomes).toEqual([room, room]);

    back.send(encode({ t: "relay", to: "tv", payload: { t: "join", seat: SEAT } } as never));
    expect(returning.socket.last()).toMatchObject({
      t: "relay",
      from: back.clientId,
      payload: { t: "join", seat: SEAT },
    });
  });

  it("keeps a message to a TV that stepped out non-fatal, because that socket is in the room", () => {
    vi.useFakeTimers();
    const r = relay();
    const tv = tvJoins(r);
    const { sockets, errors } = phoneClient(r, tv.room);
    const joined = sockets[0]!;
    joined.open();
    // The TV steps out of a room that is still live: this phone is still in it,
    // and everything it addresses to the TV is refused with the same word. The
    // difference is that this socket is in the room, so the TV's return is
    // announced on it -- there is nothing to redial for, and nothing is.
    r.remove(tv.id);
    joined.send(encode({ t: "relay", to: "tv", payload: { t: "join", seat: SEAT } } as never));

    expect(joined.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
    expect(joined.readyState).toBe(1);
    expect(joined.clientId).not.toBeNull();
    expect(errors.map((error) => error.code)).toEqual(["no_tv_yet"]);

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);

    // The TV coming back is announced on this very socket, which is what the
    // phone waits for instead of dialling.
    tvJoins(r, { room: tv.room, hostToken: tv.socket.credential() });
    expect(joined.received.filter((message) => message.t === "peer_joined")).toHaveLength(1);
  });
});
