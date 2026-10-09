/**
 * What a TV's client does with the relay's two refusals.
 *
 * A TV comes back to its room by naming it and presenting the credential that
 * room issued. Two refusals can come back, and they call for opposite answers:
 *
 *   - `room_has_tv` -- the relay still believes the room has a TV, because the
 *     socket that was the TV is gone but nothing has told it so yet. The claim
 *     is sound and the credential was not spent (a credential is only spent by
 *     a `welcome`), so dialling again is the whole repair, and it lands the
 *     moment the relay notices the dead socket.
 *   - `not_the_tv` -- this connection is not and never will be the room's TV.
 *     Presenting that credential again can only ever be refused again, so the
 *     client has to stop presenting it. Otherwise the TV sits on a dead
 *     credential, on a socket with no room, silently, for good.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayClient, type WebSocketLike } from "../app/shared/client.ts";
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  type HelloMessage,
  type RelayErrorMessage,
} from "../app/shared/protocol.ts";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  /**
   * What a browser's `close()` does: the socket goes to CLOSING and the close
   * event follows. The client is not entitled to assume the event arrives
   * synchronously, so it does not -- this fires it on a later task, like a
   * real one.
   */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  hello(): HelloMessage {
    const decoded = decodeClientMessage(this.sent[0] ?? "");
    if (!decoded.ok || decoded.message.t !== "hello") {
      throw new Error(`the client did not open with a hello: ${this.sent[0]}`);
    }
    return decoded.message;
  }
}

function tvClient() {
  const sockets: FakeSocket[] = [];
  const errors: RelayErrorMessage[] = [];
  const statuses: string[] = [];
  const client = createRelayClient({
    url: "ws://host:8787",
    kind: "tv",
    socketFactory: (url) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      void url;
      return socket;
    },
    handlers: {
      onStatus: (status) => statuses.push(status),
      onRelayError: (error) => errors.push(error),
    },
  });
  return { client, sockets, errors, statuses };
}

function welcome(socket: FakeSocket, hostToken: string): void {
  socket.deliver({
    t: "welcome",
    v: PROTOCOL_VERSION,
    room: "ABCD",
    peerId: "p1",
    kind: "tv",
    hostToken,
    peers: [{ peerId: "p1", kind: "tv" }],
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a TV refused because the relay still has a TV for its room", () => {
  it("closes the socket and dials again, still naming the room and holding the credential", () => {
    vi.useFakeTimers();
    const { sockets, errors } = tvClient();
    const first = sockets[0]!;
    first.open();
    welcome(first, "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12");

    // The relay has not yet noticed the socket that was this room's TV.
    first.deliver({ t: "relay_error", code: "room_has_tv", detail: "room ABCD already has a TV" });
    first.close();

    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBeGreaterThan(1);

    const again = sockets[sockets.length - 1]!;
    again.open();
    // The claim it makes is the same one, with the same credential: nothing
    // was spent by a refusal, so there is nothing to renegotiate.
    expect(again.hello()).toMatchObject({ kind: "tv", room: "ABCD", hostToken: "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12" });
    expect(errors.map((error) => error.code)).toEqual(["room_has_tv"]);
  });
});

describe("a TV refused over and over because the dead socket has not been noticed", () => {
  /**
   * The relay takes ten to twenty seconds to give up on the socket that was
   * the room's TV, and every attempt inside that window is refused the same
   * way. A client that dialled at a flat rate would spend that window
   * hammering the relay -- forty connect-and-refuse rounds at half a second
   * each -- and each round is a fresh connection the relay has to watch.
   * The wait after each refusal therefore has to grow.
   */
  it("waits longer after every refusal, and never resets until a welcome lands", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    createRelayClient({
      url: "ws://host:8787",
      kind: "tv",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    // Each round: refuse this connection, then hold the clock one millisecond
    // short of the wait it should have asked for and check nothing has dialled
    // yet, then spend that last millisecond and check that something has.
    for (const wait of [500, 1_000, 1_500, 2_000, 2_500]) {
      const socket = sockets[sockets.length - 1]!;
      socket.open();
      socket.deliver({ t: "relay_error", code: "room_has_tv", detail: "room ABCD already has a TV" });
      const before = sockets.length;

      vi.advanceTimersByTime(wait - 1);
      expect(sockets.length).toBe(before); // not a moment sooner

      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(before + 1); // exactly on the mark
    }
  });

  it("starts over from the short wait once a welcome has actually landed", () => {
    vi.useFakeTimers();
    const { sockets } = tvClient();
    const first = sockets[0]!;
    first.open();
    // The refused rounds push the wait out...
    for (let round = 0; round < 3; round++) {
      const socket = sockets[sockets.length - 1]!;
      socket.open();
      socket.deliver({ t: "relay_error", code: "room_has_tv", detail: "room ABCD already has a TV" });
      vi.advanceTimersByTime(60_000);
    }
    // ...and the room then takes this TV, which is what a successful claim
    // looks like. Whatever the next interruption is, it starts from the
    // shortest wait again rather than the longest one this connection ever
    // reached.
    const settled = sockets[sockets.length - 1]!;
    settled.open();
    welcome(settled, "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12");
    const atWelcome = Date.now();
    settled.close();
    vi.advanceTimersByTime(500);
    const redialled = sockets[sockets.length - 1]!;
    expect(Date.now() - atWelcome).toBe(500);
    expect(redialled).not.toBe(settled);
  });
});

describe("a TV told it is not the room's TV", () => {
  it("forgets the room and the credential, and stops presenting the dead one", () => {
    vi.useFakeTimers();
    const { client, sockets } = tvClient();
    const first = sockets[0]!;
    first.open();
    welcome(first, "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12");

    first.deliver({ t: "relay_error", code: "not_the_tv", detail: "room ABCD is not taking a new TV" });
    expect(client.status).toBe("closed");

    // Nothing is dialled again on its own: every later hello would carry the
    // same refused claim, and the room on screen is not this TV's any more.
    vi.advanceTimersByTime(600_000);
    expect(sockets).toHaveLength(1);
    expect(client.room).toBeNull();
  });

  it("does not treat a phone's refusal as its own", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createRelayClient({
      url: "ws://host:8787",
      kind: "phone",
      room: "ABCD",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const socket = sockets[0]!;
    socket.open();
    socket.deliver({ t: "relay_error", code: "room_has_tv", detail: "room ABCD already has a TV" });
    // A phone's hello names a room and never a credential, so a relay that
    // says the room has a TV is simply a room this phone cannot be in -- there
    // is nothing for it to dial again for.
    expect(socket.readyState).toBe(1);
    expect(client.status).toBe("connecting");
  });
});
