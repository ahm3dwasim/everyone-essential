/**
 * The relay notices a socket that is gone but was never closed.
 *
 * A TV that drops off Wi-Fi without a TCP FIN leaves its socket registered:
 * the browser saw the close (or the page reloaded), the relay did not. The room
 * then still has a TV, so the real TV coming back is refused with
 * `room_has_tv` and the phones sit in a room nobody is serving. Nothing in the
 * WebSocket protocol closes that socket for the relay -- a TCP connection the
 * OS still believes in can stay open for as long as the OS keeps it -- so the
 * relay has to ask.
 *
 * The check is one ping per interval, and a socket that did not answer the
 * previous one is taken out of the relay and cut off. `terminate` is
 * deliberate rather than `close`: a half-open socket will not complete a
 * closing handshake, which is the whole reason it is still here.
 */
import { describe, expect, it, vi } from "vitest";
import { Relay } from "../app/relay/src/relay.ts";
import {
  HEARTBEAT_INTERVAL_MS,
  watchForDeadPeers,
  type HeartbeatSocket,
} from "../app/relay/src/main.ts";
import {
  PROTOCOL_VERSION,
  decodeRelayMessage,
  encode,
  type RelayToClient,
} from "../app/shared/protocol.ts";

class FakeRelaySocket {
  readonly sent: RelayToClient[] = [];
  send(data: string): void {
    const decoded = decodeRelayMessage(data);
    if (!decoded.ok) throw new Error(`the relay sent something undecodable: ${decoded.reason}`);
    this.sent.push(decoded.message);
  }
}

/** A connection as the check sees it, with the answers the test decides. */
class FakeHeartbeatSocket implements HeartbeatSocket {
  readyState = 1;
  pings = 0;
  terminated = false;
  private pong: (() => void) | null = null;

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  on(event: "pong", listener: () => void): unknown {
    if (event === "pong") this.pong = listener;
    return this;
  }

  /** The far end answers. */
  answers(): void {
    this.pong?.();
  }
}

function roomOf(tv: FakeRelaySocket): { room: string; hostToken: string } {
  const welcome = tv.sent[0];
  if (!welcome || welcome.t !== "welcome" || welcome.hostToken === undefined) {
    throw new Error("the TV's hello was not welcomed with a credential");
  }
  return { room: welcome.room, hostToken: welcome.hostToken };
}

describe("the relay's dead-peer check", () => {
  it("pings once an interval, and never cuts off a socket that answers", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeHeartbeatSocket();
      const stop = watchForDeadPeers(socket, () => {}, HEARTBEAT_INTERVAL_MS);

      for (let tick = 1; tick <= 21; tick += 1) {
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
        expect(socket.pings).toBe(tick);
        socket.answers();
      }
      // Every tick is answered, so every tick is only ever a ping.
      expect(socket.terminated).toBe(false);

      stop();
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
      expect(socket.pings).toBe(21);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuts off a socket that misses an interval, and says so once", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeHeartbeatSocket();
      let deaths = 0;
      watchForDeadPeers(socket, () => (deaths += 1), HEARTBEAT_INTERVAL_MS);

      // One interval goes by with no answer: the next tick is the deadline.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(socket.terminated).toBe(false);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(socket.terminated).toBe(true);
      expect(deaths).toBe(1);

      // And it is over: a socket already given up on is not cut off again.
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 10);
      expect(deaths).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the room of a TV whose socket went silent, so the real TV can come back", () => {
    vi.useFakeTimers();
    try {
      const relay = new Relay({ random: () => 0 });
      const tvSocket = new FakeRelaySocket();
      const tv = relay.add(tvSocket);
      relay.receive(tv.id, encode({ t: "hello", v: PROTOCOL_VERSION, kind: "tv" }));
      const { room, hostToken } = roomOf(tvSocket);

      // The TV drops off the network. The relay sees nothing: no close, no
      // error, just a socket that never answers again.
      const wire = new FakeHeartbeatSocket();
      watchForDeadPeers(wire, () => relay.remove(tv.id), HEARTBEAT_INTERVAL_MS);
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
      expect(wire.terminated).toBe(true);

      // The real TV comes back with the credential it was given. Before the
      // dead socket was cut off this hello was refused with `room_has_tv`;
      // now the room is free and it lands.
      const back = new FakeRelaySocket();
      const returning = relay.add(back);
      relay.receive(
        returning.id,
        encode({ t: "hello", v: PROTOCOL_VERSION, kind: "tv", room, hostToken }),
      );
      expect(back.sent.map((message) => message.t)).toContain("welcome");
      expect(back.sent[0]).toMatchObject({ t: "welcome", room });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a silent socket far longer than it gives a phone to reconnect", () => {
    // The point of the check is a socket the OS still believes in, not a
    // phone that stalled for a second. Three intervals is comfortably longer
    // than any blip the app already tolerates, and the room is usable again
    // well inside the time a family would wait.
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
    expect(HEARTBEAT_INTERVAL_MS * 3).toBeLessThanOrEqual(60_000);
  });
});
