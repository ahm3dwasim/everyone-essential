/**
 * A socket the client has replaced, or closed on purpose, stays silent.
 *
 * Two refusals make the client close the socket it is holding and dial again:
 * a phone's `no_tv_yet` before its welcome (the room it named is resting
 * between TVs) and a TV's `room_has_tv` (the relay has not yet noticed the
 * dead socket that still holds the room). Both dial from the refusal rather
 * than from `onclose`, so the retry does not depend on the close event
 * arriving -- and that is exactly what makes the close event dangerous.
 *
 * A browser's `close()` only STARTS the close handshake. The `close` event
 * lands later, and "later" can be after the retry timer has fired and a new
 * socket is open and in the room. The old socket still had every handler the
 * client gave it, and none of them asked whether it was still the connection
 * the client was using. So the late close of a socket nobody is using said
 * "the relay went away" about a socket that had just been welcomed, set the
 * status to closed, and dialled a third socket. The second was left open with
 * nobody driving it: the browser goes on answering the relay's heartbeats, so
 * the relay never reaps it, and the TV goes on seeing its peer as connected
 * and holding the seat.
 *
 * The repair is that a socket stops speaking the moment it stops being the
 * client's connection -- on every replace path, whichever one took it away.
 * These tests drive each of them with a socket the test opens, refuses and
 * closes by hand, so the order of events is the test's to choose rather than
 * the network's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayClient, type ConnectionStatus, type WebSocketLike } from "../app/shared/client.ts";
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encode,
  type HelloMessage,
  type RelayToClient,
} from "../app/shared/protocol.ts";

const ROOM = "ABCD";
const SEAT = "0123456789abcdef0123456789abcdef";

/** A welcome for a phone the relay has taken into `room`. */
function welcome(peerId: string, kind: "phone" | "tv", extra: Record<string, unknown> = {}): RelayToClient {
  return {
    t: "welcome",
    v: PROTOCOL_VERSION,
    room: ROOM,
    peerId,
    kind,
    peers: [{ peerId, kind }],
    ...extra,
  } as RelayToClient;
}

const refusedNoTv: RelayToClient = {
  t: "relay_error",
  code: "no_tv_yet",
  detail: "no TV in this room yet",
};

const roomHasTv: RelayToClient = {
  t: "relay_error",
  code: "room_has_tv",
  detail: "this room already has a TV",
};

/**
 * One socket the test drives by hand. Nothing happens on it -- opening,
 * frames, the close handshake finishing -- until the test says so, which is
 * what lets a close be delivered after the socket it belongs to has been
 * replaced.
 */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  /** Every frame this client wrote. */
  readonly sent: string[] = [];
  /**
   * Whether `close()` only starts the handshake, the way a browser's does.
   * The `close` event is then the test's to deliver, whenever it chooses.
   */
  deferClose = false;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error(`this client wrote to a socket in readyState ${this.readyState}`);
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    if (this.deferClose) {
      this.readyState = 2;
      return;
    }
    this.finishClose();
  }

  /** The close handshake finishing, however long after it was started. */
  finishClose(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  /** The dialled socket opening, as the browser opens it. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** A frame from the relay. */
  deliver(message: RelayToClient): void {
    this.onmessage?.({ data: encode(message) });
  }

  /** The hello this client opened with. */
  hello(): HelloMessage {
    const decoded = decodeClientMessage(this.sent[0] ?? "");
    if (!decoded.ok || decoded.message.t !== "hello") {
      throw new Error(`the client did not open with a hello: ${this.sent[0]}`);
    }
    return decoded.message;
  }
}

interface Harness {
  readonly sockets: FakeSocket[];
  readonly statuses: ConnectionStatus[];
  readonly rooms: string[];
  readonly status: () => ConnectionStatus;
}

/** A client whose dialled sockets the test holds. */
function client(kind: "phone" | "tv", options: { room?: string } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const rooms: string[] = [];
  const relayClient = createRelayClient({
    url: "ws://relay.test",
    kind,
    ...(options.room !== undefined ? { room: options.room } : {}),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    handlers: {
      onStatus: (status) => statuses.push(status),
      onWelcome: (message) => rooms.push(message.room),
    },
  });
  return { sockets, statuses, rooms, status: () => relayClient.status };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a socket that has been replaced", () => {
  it("does not dial again when the refused socket's close handshake lands late", () => {
    vi.useFakeTimers();
    const h = client("phone", { room: ROOM });

    // What the relay does to this phone on the way back from a blip that took
    // the whole room down: the room is resting, so the hello is refused.
    const refused = h.sockets[0]!;
    refused.deferClose = true;
    refused.open();
    expect(refused.hello()).toMatchObject({ kind: "phone", room: ROOM });
    refused.deliver(refusedNoTv);
    expect(h.status()).toBe("closed");

    // The refusal put the phone back on the dial. The retry is welcomed: this
    // is the connection the phone is using now.
    vi.advanceTimersByTime(500);
    const good = h.sockets[1]!;
    expect(h.sockets).toHaveLength(2);
    good.open();
    good.deliver(welcome("p1", "phone"));
    expect(h.status()).toBe("open");
    expect(h.rooms).toEqual([ROOM]);

    // And now the refused socket's close finishes -- slower than the retry,
    // which is all it takes on the lossy link this whole path is for.
    refused.finishClose();

    // It is not the client's connection any more, so it says nothing: no
    // second close, no third dial, and the admitted socket left alone.
    expect(h.sockets).toHaveLength(2);
    expect(good.readyState).toBe(1);
    expect(h.status()).toBe("open");
    expect(h.statuses.filter((s) => s === "closed")).toHaveLength(1);

    // Nothing it could still do later, either.
    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.status()).toBe("open");
    // The seat this phone is holding goes out on the socket it is using.
    expect(good.sent.length).toBeGreaterThan(0);
  });

  it("does not dial again when a TV refused with room_has_tv has the same late close", () => {
    vi.useFakeTimers();
    const h = client("tv");

    // The relay still has the room's old TV socket, so this claim is refused
    // and dialled again -- the same shape as the phone's refusal above, and
    // the same socket left holding handlers it should not.
    const refused = h.sockets[0]!;
    refused.deferClose = true;
    refused.open();
    expect(refused.hello()).toMatchObject({ kind: "tv" });
    refused.deliver(roomHasTv);
    expect(h.status()).toBe("closed");

    vi.advanceTimersByTime(500);
    const good = h.sockets[1]!;
    expect(h.sockets).toHaveLength(2);
    good.open();
    good.deliver(welcome("t1", "tv", { hostToken: "token-1" }));
    expect(h.status()).toBe("open");

    refused.finishClose();

    expect(h.sockets).toHaveLength(2);
    expect(good.readyState).toBe(1);
    expect(h.status()).toBe("open");
    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("does not let a replaced socket's frames reach the caller", () => {
    vi.useFakeTimers();
    const h = client("phone", { room: ROOM });

    // The ordinary replace path: this socket drops on its own, the client
    // dials again, and the new socket is the one that is welcomed.
    const first = h.sockets[0]!;
    first.open();
    first.finishClose();
    vi.advanceTimersByTime(500);
    const second = h.sockets[1]!;
    second.open();
    second.deliver(welcome("p2", "phone"));
    expect(h.status()).toBe("open");
    expect(h.rooms).toEqual([ROOM]);

    // A frame the relay had already put on the wire when the old socket died
    // arrives after the replacement is in the room. Nothing about it is about
    // this connection: the room it names is the room the client left, and the
    // peer id is one the relay has already forgotten.
    first.deliver(welcome("p1", "phone", { room: "ZZZZ" }));
    // No second welcome, and no room renamed under the live connection.
    expect(h.rooms).toEqual([ROOM]);
    expect(h.status()).toBe("open");
  });

  it("does not let a replaced socket's error close the connection that replaced it", () => {
    vi.useFakeTimers();
    const h = client("phone", { room: ROOM });
    const first = h.sockets[0]!;
    first.open();
    first.finishClose();
    vi.advanceTimersByTime(500);
    const second = h.sockets[1]!;
    second.open();
    second.deliver(welcome("p2", "phone"));
    expect(h.status()).toBe("open");

    // A socket that has already closed can still report an error -- a browser
    // does, when the close it was asked for does not complete. It is not this
    // client's connection, so it cannot move the connection's state.
    first.onerror?.({});
    expect(h.status()).toBe("open");
    expect(second.readyState).toBe(1);
  });

  it("cannot speak after the caller has closed it", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const relayClient = createRelayClient({
      url: "ws://relay.test",
      kind: "phone",
      room: ROOM,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      handlers: {},
    });
    const only = sockets[0]!;
    only.deferClose = true;
    only.open();
    only.deliver(welcome("p1", "phone"));

    relayClient.close();
    expect(sockets).toHaveLength(1);

    // The close the caller asked for finishes afterwards, and the socket is
    // nobody's: it does not dial, and it does not reopen anything.
    only.finishClose();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(relayClient.status).toBe("open");
    // And the closed client is not a way to send anything any more.
    expect(relayClient.sendToTv({ t: "join", seat: SEAT })).toBe(false);
  });
});
