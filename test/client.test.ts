/**
 * The transport client: the handshake, and what it does when the wire drops.
 *
 * The socket is injected, so this is the real client code with a fake cable: no
 * port is opened and nothing is asynchronous.
 */
import { describe, expect, it, vi } from "vitest";
import { createRelayClient, type WebSocketLike } from "../app/shared/client.ts";
import { PROTOCOL_VERSION, decodeClientMessage, type GameMessage } from "../app/shared/protocol.ts";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** The game messages this socket was asked to send, decoded. */
  relays(): { to: string; payload: GameMessage }[] {
    return this.sent.flatMap((raw) => {
      const decoded = decodeClientMessage(raw);
      return decoded.ok && decoded.message.t === "relay"
        ? [{ to: String(decoded.message.to), payload: decoded.message.payload }]
        : [];
    });
  }
}

function connected(url = "ws://host:8787", kind: "tv" | "phone" = "phone", room?: string) {
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const client = createRelayClient({
    url,
    kind,
    ...(room !== undefined ? { room } : {}),
    socketFactory: (socketUrl) => {
      const socket = new FakeSocket(socketUrl);
      sockets.push(socket);
      return socket;
    },
    handlers: {
      onStatus: (status) => events.push(`status:${status}`),
      onWelcome: (welcome) => events.push(`welcome:${welcome.room}:${welcome.peerId}`),
      onPeerJoined: (peer) => events.push(`joined:${peer.peerId}`),
      onPeerLeft: (peerId) => events.push(`left:${peerId}`),
      onRelayError: (error) => events.push(`error:${error.code}`),
      onGame: (message, from) => events.push(`game:${from}:${message.t}`),
    },
  });
  const socket = sockets[0]!;
  return { client, socket, sockets, events };
}

describe("the handshake", () => {
  it("says hello the moment the socket opens, naming its room", () => {
    const { socket } = connected("ws://host:8787", "phone", "ABCD");
    socket.open();
    const hello = decodeClientMessage(socket.sent[0] ?? "");
    expect(hello.ok).toBe(true);
    if (!hello.ok || hello.message.t !== "hello") return;
    expect(hello.message).toMatchObject({ v: PROTOCOL_VERSION, kind: "phone", room: "ABCD" });
  });

  it("is not open until the relay's welcome arrives", () => {
    const { client, socket, events } = connected();
    socket.open();
    expect(client.status).toBe("connecting");
    socket.deliver({
      t: "welcome",
      v: PROTOCOL_VERSION,
      room: "ABCD",
      peerId: "p1",
      kind: "phone",
      peers: [{ peerId: "p1", kind: "phone" }],
    });
    expect(client.status).toBe("open");
    expect(client.room).toBe("ABCD");
    expect(client.peerId).toBe("p1");
    expect(events).toContain("welcome:ABCD:p1");
  });

  it("does not proceed on a welcome from a relay that speaks the version this protocol has left behind", () => {
    vi.useFakeTimers();
    try {
      const { client, socket, sockets, events } = connected();
      socket.open();
      socket.deliver({
        t: "welcome",
        v: PROTOCOL_VERSION - 1,
        room: "ABCD",
        peerId: "p1",
        kind: "phone",
        peers: [{ peerId: "p1", kind: "phone" }],
      });
      // An older relay takes a TV's word for a named room and never reads a
      // credential, so a client that carried on here would be sitting in a
      // room with no gate on it at all. Refused, and the client stays shut.
      expect(client.status).toBe("closed");
      expect(client.room).toBeNull();
      expect(client.peerId).toBeNull();
      expect(events).not.toContain("welcome:ABCD:p1");
      // Not retried either: the version belongs to the relay, so every
      // attempt at this address would be refused in exactly the same way.
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the room coming and going, and hands up the stamped sender", () => {
    const { socket, events } = connected();
    socket.open();
    socket.deliver({ t: "peer_joined", peer: { peerId: "p2", kind: "phone" } });
    socket.deliver({ t: "peer_left", peerId: "p2" });
    socket.deliver({ t: "relay_error", code: "unknown_room", detail: "no room" });
    socket.deliver({
      t: "relay",
      from: "p2",
      to: "tv",
      payload: { t: "intent", intent: { k: "choose", choiceId: "act:x" } },
    });
    expect(events).toEqual([
      "status:connecting",
      "joined:p2",
      "left:p2",
      "error:unknown_room",
      "game:p2:intent",
    ]);
  });

  it("ignores a frame it cannot read, without tearing the connection down", () => {
    const { client, socket } = connected();
    socket.open();
    socket.deliver({ t: "shrug" });
    socket.onmessage?.({ data: "not json" });
    expect(client.status).toBe("connecting");
  });
});

describe("sending", () => {
  it("refuses to send before the socket is open, rather than dropping it silently", () => {
    const { client, socket } = connected();
    expect(client.sendToTv({ t: "join" })).toBe(false);
    socket.open();
    expect(client.sendToTv({ t: "join" })).toBe(true);
    expect(socket.relays()).toEqual([{ to: "tv", payload: { t: "join" } }]);
  });

  it("addresses one peer, the TV, or the room", () => {
    const { client, socket } = connected();
    socket.open();
    client.sendTo("p9", { t: "assigned", role: "A" });
    client.sendToTv({ t: "join" });
    client.sendToAll({ t: "switch", phase: "start", role: "C", capabilities: ["scan"], diff: [] });
    expect(socket.relays().map((relay) => relay.to)).toEqual(["p9", "tv", "all"]);
  });
});

describe("superseded", () => {
  it("a peer told it is superseded receives the message, and closing on it actually tears the socket down", () => {
    const { client, socket, events } = connected("ws://host:8787", "phone", "ABCD");
    socket.open();
    socket.deliver({
      t: "welcome",
      v: PROTOCOL_VERSION,
      room: "ABCD",
      peerId: "p1",
      kind: "phone",
      peers: [{ peerId: "p1", kind: "phone" }],
    });
    // The TV addresses this exact peer, the same way `app.tsx`'s outbound-view
    // effect does -- delivered as an ordinary relay frame, not a special one.
    socket.deliver({ t: "relay", from: "tv", to: "p1", payload: { t: "superseded" } });
    expect(events).toContain("game:tv:superseded");
    // The one thing a superseded connection is for: closing itself. This is
    // the real transport socket, not a stub -- its own `readyState` proves
    // the close actually reached the wire, not just the client's own status.
    client.close();
    expect(socket.readyState).toBe(3);
  });
});

describe("when the wire drops", () => {
  it("says so, and comes back on its own", () => {
    vi.useFakeTimers();
    try {
      const { client, socket, sockets, events } = connected();
      socket.open();
      socket.onclose?.({});
      expect(client.status).toBe("closed");
      expect(events).toContain("status:closed");
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(2);
      expect(client.status).toBe("connecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings a TV back to the room it was given, presenting the room's own credential", () => {
    vi.useFakeTimers();
    try {
      const { socket, sockets } = connected("ws://host:8787", "tv");
      socket.open();
      socket.deliver({
        t: "welcome",
        v: PROTOCOL_VERSION,
        room: "ABCD",
        peerId: "tv-1",
        kind: "tv",
        hostToken: "a".repeat(64),
        peers: [{ peerId: "tv-1", kind: "tv" }],
      });
      socket.onclose?.({});
      vi.advanceTimersByTime(600);
      // The reconnect dials a new socket; the hello is the wire's answer to it
      // opening, exactly as it was the first time.
      sockets[1]?.open();

      const hello = decodeClientMessage(sockets[1]?.sent[0] ?? "");
      expect(hello.ok).toBe(true);
      if (!hello.ok || hello.message.t !== "hello") return;
      // The room, not the option it was constructed with: the TV is given its
      // room by the relay, so it has nothing to name until the first welcome.
      expect(hello.message.room).toBe("ABCD");
      expect(hello.message.hostToken).toBe("a".repeat(64));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the newest credential a returning TV is handed, not the one the room was opened with", () => {
    vi.useFakeTimers();
    try {
      const { socket, sockets } = connected("ws://host:8787", "tv");
      socket.open();
      socket.deliver({
        t: "welcome",
        v: PROTOCOL_VERSION,
        room: "ABCD",
        peerId: "tv-1",
        kind: "tv",
        hostToken: "a".repeat(64),
        peers: [{ peerId: "tv-1", kind: "tv" }],
      });
      socket.onclose?.({});
      vi.advanceTimersByTime(600);
      sockets[1]?.open();

      // The relay spends what that hello presented and puts a new one in the
      // welcome it answers with: what the TV holds is the newest, or the next
      // return would present a credential the room has already retired.
      sockets[1]?.deliver({
        t: "welcome",
        v: PROTOCOL_VERSION,
        room: "ABCD",
        peerId: "tv-2",
        kind: "tv",
        hostToken: "b".repeat(64),
        peers: [{ peerId: "tv-2", kind: "tv" }],
      });
      sockets[1]?.onclose?.({});
      vi.advanceTimersByTime(600);
      sockets[2]?.open();

      const hello = decodeClientMessage(sockets[2]?.sent[0] ?? "");
      expect(hello.ok).toBe(true);
      if (!hello.ok || hello.message.t !== "hello") return;
      expect(hello.message.hostToken).toBe("b".repeat(64));
    } finally {
      vi.useRealTimers();
    }
  });

  it("brings a phone back to the room it named, presenting no credential", () => {
    vi.useFakeTimers();
    try {
      const { socket, sockets } = connected("ws://host:8787", "phone", "ABCD");
      socket.open();
      socket.deliver({
        t: "welcome",
        v: PROTOCOL_VERSION,
        room: "ABCD",
        peerId: "p1",
        kind: "phone",
        // A credential is issued to a room's TV alone. Handing one to a phone
        // is not something the relay does -- and if it ever did, the phone
        // still must not carry it back, because the next hello is a claim
        // about who this connection is.
        hostToken: "b".repeat(64),
        peers: [{ peerId: "p1", kind: "phone" }],
      });
      socket.onclose?.({});
      vi.advanceTimersByTime(600);
      // The reconnect dials a new socket; the hello is the wire's answer to it
      // opening, exactly as it was the first time.
      sockets[1]?.open();

      const hello = decodeClientMessage(sockets[1]?.sent[0] ?? "");
      expect(hello.ok).toBe(true);
      if (!hello.ok || hello.message.t !== "hello") return;
      expect(hello.message.room).toBe("ABCD");
      expect(hello.message.hostToken).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays down once the caller has closed it", () => {
    vi.useFakeTimers();
    try {
      const { client, socket, sockets } = connected();
      socket.open();
      client.close();
      socket.onclose?.({});
      vi.advanceTimersByTime(10_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
