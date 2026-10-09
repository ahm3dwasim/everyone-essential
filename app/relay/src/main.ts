/**
 * `npm run relay` — the room relay, on the LAN, for v0.
 *
 * No cloud, no accounts: this process is the whole server side of the demo.
 * It prints the addresses to type (or scan) on the other devices, because a
 * host should never have to go looking for this machine's IP mid-demo.
 */
import { realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Relay } from "./relay.ts";
import { PROTOCOL_VERSION } from "../../shared/protocol.ts";

/**
 * `RELAY_PORT` first so a test run can put the relay somewhere other than the
 * static server's port, which is what `PORT` means to `scripts/serve.mjs`.
 */
const port = Number(process.env.RELAY_PORT ?? process.env.PORT ?? 8787);

export function lanAddresses(): string[] {
  const out: string[] = [];
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/**
 * How often every connection on the room's wire is asked to prove it is still
 * there. Ten seconds, and the deadline for an answer is the next tick -- so a
 * socket that has really gone is given up on between ten and twenty seconds
 * after it went.
 *
 * Why those numbers, and not something tighter or looser:
 *
 *   - What is being caught is a socket the OS still believes in, not a phone
 *     that stalled. A Stick busy painting the room, or a phone that was just
 *     backgrounded and handed back, both answer well inside ten seconds -- and
 *     a check that gave up on either of those would be a check that invented
 *     disconnects.
 *   - Twenty seconds is well inside the room's own seat grace
 *     (`SEAT_GRACE_MS`, three minutes), so a phone given up on here finds its
 *     seat still held when it reconnects. That is what makes giving up on a
 *     dead socket safe rather than merely tidy.
 *   - It is short enough that a room whose TV went silent is usable again
 *     while the family is still sitting in front of it: until the dead socket
 *     is cut off the room still has a TV, so the real TV coming back is
 *     refused and the phones are left in a room nobody is serving.
 *
 * Mirrors `HEARTBEAT_INTERVAL_MS` in the Fire TV's own relay.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** The slice of a `ws` socket the dead-peer check uses. */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
}

/**
 * Watch one connection, and give up on it when it stops answering.
 *
 * A server cannot tell a quiet connection from a gone one by waiting: a dead
 * socket can stay open for as long as the OS keeps its TCP connection, which
 * can be forever. So the server asks, every `intervalMs`, and a connection
 * that did not answer the previous ask is taken out of the room -- `onDead`
 * first, so the room's TV slot is free before anything else happens -- and
 * then terminated. `terminate` rather than `close`: a half-open socket will
 * not complete a closing handshake, which is the entire reason it is still
 * here.
 *
 * The returned function stops the check, and is what the server calls when the
 * connection closes properly -- a socket that closed is not one to watch.
 */
export function watchForDeadPeers(
  socket: HeartbeatSocket,
  onDead: () => void,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      // Two intervals with no answer: nothing on the other end can answer,
      // and the room should stop counting this connection.
      clearInterval(timer);
      onDead();
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, intervalMs);
  return () => clearInterval(timer);
}

export function createRelayServer(port_: number): WebSocketServer {
  const relay = new Relay();
  const server = new WebSocketServer({ port: port_ });
  server.on("connection", (socket: WebSocket) => {
    const client = relay.add({
      send: (data: string) => {
        if (socket.readyState === socket.OPEN) socket.send(data);
      },
    });
    socket.on("message", (data: unknown) => {
      relay.receive(client.id, String(data));
    });
    // A connection the OS still believes in but nothing is behind is what
    // keeps a room holding a TV that is not there, so every connection is
    // watched from the moment it arrives.
    const stopWatching = watchForDeadPeers(socket, () => relay.remove(client.id));
    socket.on("close", () => {
      stopWatching();
      relay.remove(client.id);
    });
    socket.on("error", () => relay.remove(client.id));
  });
  return server;
}

/** True when this file is the process entry point, not an import. */
export function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const server = createRelayServer(port);
  server.on("listening", () => {
    console.log(`relay: listening on port ${port} (protocol v${PROTOCOL_VERSION})`);
    for (const address of lanAddresses()) console.log(`relay:   ws://${address}:${port}`);
    console.log("relay: keep this running while the game is on screen");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
