/**
 * The transport client, shared by the TV and the phones.
 *
 * It owns the connection, the `hello` handshake and reconnection; it does not
 * own any game state. When it reconnects it says so and lets the caller rebuild
 * -- a phone that comes back mid-game re-announces itself and is handed a fresh
 * view, rather than pretending nothing happened.
 *
 * What it does hold on to is where it is: the room a `welcome` named, and, for
 * a TV, the credential that room's relay issued it. A reconnect is a return to
 * that room rather than the start of a new one, which is the difference between
 * a TV that blinks and a room full of phones left behind.
 */
import {
  PROTOCOL_VERSION,
  decodeRelayMessage,
  encode,
  type GameMessage,
  type PeerId,
  type PeerSummary,
  type PlayerKind,
  type RelayErrorMessage,
  type RelayTarget,
  type RoomCode,
  type WelcomeMessage,
} from "./protocol.ts";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface RelayClientHandlers {
  onGame?: (message: GameMessage, from: PeerId | null) => void;
  onWelcome?: (message: WelcomeMessage) => void;
  onPeerJoined?: (peer: PeerSummary) => void;
  onPeerLeft?: (peerId: PeerId) => void;
  onRelayError?: (error: RelayErrorMessage) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
}

export interface RelayClientOptions {
  url: string;
  kind: PlayerKind;
  /** Phones name a room. A TV omits it and is given one. */
  room?: string;
  name?: string;
  handlers?: RelayClientHandlers;
  /** Milliseconds between reconnect attempts, capped. Defaults to 500 → 4000. */
  reconnectMs?: number;
  socketFactory?: (url: string) => WebSocketLike;
}

/** The slice of `WebSocket` this client uses, so tests can supply their own. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RelayClient {
  readonly peerId: PeerId | null;
  readonly room: RoomCode | null;
  readonly status: ConnectionStatus;
  sendTo(target: RelayTarget, message: GameMessage): boolean;
  sendToTv(message: GameMessage): boolean;
  sendToAll(message: GameMessage): boolean;
  close(): void;
}

const OPEN = 1;

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const handlers = options.handlers ?? {};
  const factory =
    options.socketFactory ??
    ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const maxBackoff = options.reconnectMs ?? 500;

  let socket: WebSocketLike | null = null;
  let peerId: PeerId | null = null;
  let room: RoomCode | null = null;
  /**
   * A room's credential, kept from a TV's `welcome` and presented on every
   * later hello. A TV is given its room by the relay rather than naming one,
   * so without this every reconnect introduced itself as a brand-new TV and
   * was handed a different room, leaving the phones that had joined the first
   * one talking to nobody. Phones never hold one: the relay issues it to a
   * room's own TV, so a phone that presented it would be claiming to be that
   * TV.
   */
  let hostToken: string | null = null;
  let status: ConnectionStatus = "connecting";
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(next: ConnectionStatus, detail?: string): void {
    status = next;
    handlers.onStatus?.(next, detail);
  }

  /**
   * Give up the current socket on purpose: it stops being this client's
   * connection, and it stops speaking.
   *
   * Every deliberate close goes through here, because a socket's events are
   * not the client's to schedule. A browser's `close()` only starts the close
   * handshake -- the `close` event lands later, and "later" can be after the
   * retry timer has already dialled a new socket and had it welcomed. The old
   * socket would then report that the relay went away, about a connection
   * nobody was using, and drive the client that had moved on: a status set to
   * closed on an open connection, and another dial, leaving the admitted
   * socket open with nobody driving it -- which the relay never reaps, because
   * the browser goes on answering its heartbeats.
   *
   * Detaching the handlers is what makes that impossible at the source rather
   * than by inspection: a socket with no handlers cannot say anything, whether
   * the event arrives in a millisecond or a minute. The `socket !== next`
   * checks in `connect`'s own handlers cover the other half -- a socket the
   * client never closed, replaced because it dropped or refused.
   */
  function retire(): void {
    const dead = socket;
    socket = null;
    if (dead === null) return;
    dead.onopen = null;
    dead.onclose = null;
    dead.onerror = null;
    dead.onmessage = null;
    dead.close();
  }

  function connect(): void {
    if (closed) return;
    setStatus("connecting");
    const next = factory(options.url);
    socket = next;
    /**
     * Whether THIS socket was taken into a room. The hello can be refused, and
     * a refusal that arrives before the welcome is a refusal of the connection
     * itself rather than a message carried on it -- which is the difference
     * between a client that has to dial again and one that is simply in a room
     * whose TV is away. Kept per socket, because a welcome on the last one says
     * nothing about this one.
     */
    let admitted = false;

    /**
     * Every handler below opens with the same question -- is this socket still
     * the one this client is using -- because none of these events is the
     * client's to time. A replace can happen between the event being queued
     * and it running: the refusal branches close a socket and dial from the
     * refusal itself, so a retry can be admitted before the refused socket's
     * close handshake has finished, and a socket that dropped can have a frame
     * still in flight toward it. A socket that is not the current one is over,
     * whatever it has to say, and letting it through is how a client ends up
     * with two connections where it thinks it has one.
     */
    next.onopen = () => {
      if (socket !== next) return;
      // `attempt` is deliberately NOT reset here. A socket opening is not a
      // connection landing: a TV refused with `room_has_tv` opens a new socket
      // every time while the relay has not noticed the dead one, and resetting
      // on open turned every one of those into a fresh half-second retry --
      // forty connect-and-refuse rounds across the ten to twenty seconds that
      // takes, each one a connection the relay has to watch. The wait grows
      // until something is actually accepted, and a `welcome` (below) is what
      // being accepted looks like.
      // The room this client is actually in beats the one it was asked for:
      // a phone names a room up front and is told the same one back, but a TV
      // names nothing and is given one, so only the welcome can say which room
      // it belongs to. Every hello after the first is a return to it.
      const named = room ?? options.room;
      next.send(
        encode({
          t: "hello",
          v: PROTOCOL_VERSION,
          kind: options.kind,
          ...(named !== undefined && named !== null ? { room: named } : {}),
          ...(hostToken !== null ? { hostToken } : {}),
          ...(options.name !== undefined ? { name: options.name } : {}),
        }),
      );
    };

    next.onmessage = (event) => {
      if (socket !== next) return;
      const decoded = decodeRelayMessage(String(event.data));
      if (!decoded.ok) {
        handlers.onStatus?.(status, `ignored a malformed frame: ${decoded.reason}`);
        return;
      }
      const message = decoded.message;
      switch (message.t) {
        case "welcome":
          // The version is checked here, before anything in the welcome is
          // believed, because this is the one frame that decides which relay
          // this client is in a room with. An older relay is one that takes a
          // TV's word for a named room and never reads a credential, so
          // carrying on would be carrying on into a room with no gate on it.
          // Refused, and not retried: the version belongs to the relay, so
          // every attempt would be refused the same way.
          if (message.v !== PROTOCOL_VERSION) {
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
            setStatus("closed", `the relay speaks version ${message.v}, not ${PROTOCOL_VERSION}`);
            retire();
            return;
          }
          // The one thing that resets the reconnect wait: this connection was
          // taken into a room, so whatever went wrong before it is over.
          attempt = 0;
          admitted = true;
          peerId = message.peerId;
          room = message.room;
          // Only a TV is issued one, so only a TV keeps it -- and a phone
          // handed one anyway still must not carry it back, because the next
          // hello is a claim about who this connection is.
          if (options.kind === "tv" && message.hostToken !== undefined) {
            hostToken = message.hostToken;
          }
          setStatus("open");
          handlers.onWelcome?.(message);
          break;
        case "peer_joined":
          handlers.onPeerJoined?.(message.peer);
          break;
        case "peer_left":
          handlers.onPeerLeft?.(message.peerId);
          break;
        case "relay_error":
          // Two refusals a TV can get for the claim it makes, and they call
          // for opposite answers. Neither is ever a phone's: a phone names a
          // room and presents no credential, so neither can be about it.
          //
          // `room_has_tv`: the relay still has a TV for this room -- the
          // socket that was the TV is gone but the relay has not noticed yet,
          // which is what the relay's own dead-peer check is for. Nothing was
          // spent here (a credential is only spent by a `welcome`), so naming
          // the room again with the same credential is exactly the claim that
          // will land once the dead socket is cut off. Close and dial again.
          if (options.kind === "tv" && message.code === "room_has_tv") {
            setStatus("closed", "the room still has a TV — trying again");
            retire();
            // Dialled again from here rather than from `onclose`, so the
            // retry does not depend on the close event arriving: the timer
            // guard in `scheduleReconnect` makes a second call harmless.
            scheduleReconnect();
            handlers.onRelayError?.(message);
            break;
          }
          // `not_the_tv`: this connection is not this room's TV and never will
          // be. Presenting that credential again could only be refused again,
          // so it is forgotten, and so is the room it named -- which is what
          // stops this client sitting on a dead credential, on a socket with
          // no room, forever. Nothing is dialled again on its own: every later
          // hello would make the same refused claim about the same room.
          if (options.kind === "tv" && message.code === "not_the_tv") {
            hostToken = null;
            room = null;
            closed = true;
            if (timer) clearTimeout(timer);
            timer = null;
            setStatus("closed", "this game cannot be resumed — a new room is needed");
            retire();
            handlers.onRelayError?.(message);
            break;
          }
          // `no_tv_yet` before this socket's `welcome`: the room this phone
          // named is waiting for its TV. Either it has emptied and is resting
          // inside its reconnect window until its own TV comes back with the
          // credential that room issued it, or it is live with the TV stepped
          // out of it. A phone reads both as the same wait, and this refusal is
          // the one it gets for the hello it sends as it comes back from a
          // blip that took the whole room down.
          //
          // Waiting is right, but NOT on this socket: a refused hello leaves it
          // in no room, and the relay announces a returning TV only to the
          // peers of the room it returned to. Nothing else is ever sent to a
          // connection that is not in one -- and a browser answers the relay's
          // heartbeats, so nothing reaps it either. The wait can therefore only
          // end on a fresh hello, which makes this the phone's own version of
          // the TV's `room_has_tv`: close, and dial again on the same growing
          // wait (capped, so a room that stays empty is not hammered). The
          // caller is still told, so it can say on screen that this is a wait.
          //
          // After a `welcome` the same code is a message to a TV that is not
          // there, on a socket that IS in the room -- and that room's peer list
          // is exactly what will carry the TV's return, so that one stays
          // non-fatal and nothing is dialled.
          if (options.kind === "phone" && message.code === "no_tv_yet" && !admitted) {
            setStatus("closed", "the room is waiting for its TV — trying again");
            retire();
            // Dialled again from here rather than from `onclose`, so the retry
            // does not depend on the close event arriving: the timer guard in
            // `scheduleReconnect` makes a second call harmless.
            scheduleReconnect();
            handlers.onRelayError?.(message);
            break;
          }
          handlers.onRelayError?.(message);
          break;
        case "relay":
          handlers.onGame?.(message.payload, message.from);
          break;
      }
    };

    next.onclose = () => {
      if (socket !== next) return;
      if (closed) return;
      setStatus("closed", "the relay went away");
      scheduleReconnect();
    };

    next.onerror = () => {
      if (socket !== next) return;
      setStatus("closed", "the relay could not be reached");
    };
  }

  function scheduleReconnect(): void {
    if (closed || timer) return;
    attempt += 1;
    const delay = Math.min(maxBackoff * attempt, 4000);
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    get peerId() {
      return peerId;
    },
    get room() {
      return room;
    },
    get status() {
      return status;
    },
    sendTo(target, message) {
      if (!socket || socket.readyState !== OPEN) return false;
      socket.send(encode({ t: "relay", to: target, payload: message }));
      return true;
    },
    sendToTv(message) {
      return this.sendTo("tv", message);
    },
    sendToAll(message) {
      return this.sendTo("all", message);
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      retire();
    },
  };
}
