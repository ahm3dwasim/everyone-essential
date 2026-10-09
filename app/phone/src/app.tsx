/**
 * The phone: join, then be one player.
 *
 * What this page can do is deliberately small. It renders the view the TV sent
 * for this role and nothing else -- it holds no puzzle, no state and no
 * history. Every tap turns into one of three intents, and the TV decides what
 * each one means. A phone that has been handed a view it does not understand
 * shows nothing rather than guessing.
 *
 * The three input modes:
 *   dpad   the TV remote is the controller; this page is the clue sheet.
 *   voice  say the name of what you want; the buttons are always there too.
 *   scan   one switch: tap moves the highlight, press-and-hold chooses. No
 *          timers, no auto-advance, adjustable threshold.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { createRelayClient, type RelayClient } from "../../shared/client.ts";
import { defaultRelayUrl, normalizeRoomCode, parseLaunchParams } from "../../shared/rooms.ts";
import {
  ROLE_IDS,
  type Capability,
  type Choice,
  type GameMessage,
  type Intent,
  type PeerId,
  type PeerSummary,
  type PhoneView,
  type RelayErrorMessage,
  type RoleId,
  type SwitchPhase,
} from "../../shared/protocol.ts";
import {
  DEFAULT_HOLD_MS,
  MAX_HOLD_MS,
  MIN_HOLD_MS,
  clampHoldMs,
  createScan,
  holdHint,
  holdProgress,
  scanReduce,
  type ScanEvent,
  type ScanState,
} from "./scan.ts";
import { listen, matchOption, type VoiceListener } from "./voice.ts";
import {
  hasIndexedDb,
  hasSecureRandom,
  mintFreshSeat,
  NO_SECURE_RANDOM_MESSAGE,
  SEAT_PERSISTENCE_MESSAGE,
  SeatPersistenceError,
  seatIdFor,
  STORAGE_BLOCKED_MESSAGE,
} from "./seat.ts";

const MODE_LABEL: Record<string, string> = {
  dpad: "the TV remote",
  voice: "voice",
  scan: "one-button scan",
  waiting: "waiting",
};

/** Shown on the join screen only until the phone knows which mystery the TV picked. */
const PRODUCT_TITLE = "Everyone Is Essential";

/**
 * Whether "This isn't my seat" may be offered -- and, on the handler's own
 * side, whether it may act.
 *
 * Rotation mints a fresh token into the ONE store every tab of this browser
 * reads, so it does not only change this tab's mind: it throws away the token
 * that any seat this browser holds is held under. A second tab rotating
 * leaves the first tab's nameless seat backed by a token no browser has any
 * more, and reopening the link can then never reclaim it.
 *
 * So the rule is possession: rotate only while this browser's token backs no
 * live or held seat (`otherTabRole === null`), and only from a phone with no
 * role of its own to lose. A tab whose browser is already playing gets the
 * plain sentence instead, and waits for the TV.
 */
export function mayRotateSeat(view: PhoneView | null | undefined): boolean {
  if (!view) return false;
  return view.role === null && view.claimingSeat && view.otherTabRole === null;
}

/**
 * A phone speaks with the TV's authority, never its own: every message that
 * changes what this phone shows or does -- `assigned`, `view`, `switch`,
 * `superseded` -- is TV -> phone, so it is accepted only from the room's TV.
 * `from` is the relay's own stamp on the envelope (`client.ts`'s `onGame`),
 * never anything a frame could claim about itself, and `tvPeerId` is this
 * phone's own record of which connection the relay told it holds the TV --
 * so a peer the relay lets into the room as a phone cannot pass for the TV
 * just by naming its payload `assigned` or `switch`.
 */
export function isFromRoomTv(from: PeerId | null, tvPeerId: PeerId | null): boolean {
  return tvPeerId !== null && from === tvPeerId;
}

/**
 * Whether a relay error is the room waiting for its TV rather than a refusal
 * of this phone.
 *
 * While a room has no TV in it, everything a phone addresses to the TV comes
 * back as `no_tv_yet` -- "no TV in this room yet" -- including the `join` this
 * phone sends the moment it is welcomed back. That is a state to sit out, not
 * to leave over: this phone is already in the room, and its seat is still held
 * for it. Reading it as fatal is how a short Wi-Fi blip that takes the phones
 * down before the TV pushes every one of them back to the join screen.
 *
 * It arrives in two shapes, and both are this wait. On a socket this phone has
 * already been welcomed on -- the ordinary case, a message addressed to a TV
 * that is not there -- the socket is in the room, and the room's own peer list
 * is what will say the TV is back. On a socket whose HELLO was refused (the
 * room has emptied and is resting inside its reconnect window), the socket is
 * in no room at all and nothing will ever be sent to it, so the client closes
 * it and dials again on the same growing wait the TV's own refusals use. Either
 * way this phone is told, and either way the wait looks the same on screen --
 * which is the whole of what this function decides.
 *
 * The code is the whole of the read, and deliberately so. The relay used to
 * answer this with `unknown_room`, so the phone had to bring its own evidence
 * that the room was still there -- its memory of having been admitted -- and
 * that memory says nothing about now: after the relay restarted, it was still
 * holding the code of a room that no longer existed, and the phone waited for
 * a TV that was never coming back. The relay now says which of the two it is.
 */
export function waitsOutTvGap(relayError: RelayErrorMessage): boolean {
  return relayError.code === "no_tv_yet";
}

/**
 * Whether a relay error is this phone's game being over rather than a refusal
 * of this connection.
 *
 * `unknown_room` is a room that does not exist. For a phone the relay had
 * taken into one, that means the room it was playing in is gone -- the relay
 * restarted and forgot it, or its reconnect window closed -- and its seat went
 * with it. There is nothing on the other end to wait for and nothing to hold:
 * the game ended on the TV that made the room, and the way back in is the code
 * on that TV's screen now.
 *
 * `admitted` is whether the relay ever took THIS phone into a room -- the
 * `welcome` it was seated by, kept across the reconnects that follow so an
 * ordinary blip returns it to the same room. It is not evidence that the room
 * still exists, which is the reading that went wrong before; it decides only
 * which screen a refusal of a room that is gone belongs on. A first join at a
 * code that never named a room is not a game that ended, so it keeps the relay's
 * own sentence on the join form instead.
 */
export function endedOnTheTv(relayError: RelayErrorMessage, admitted: boolean): boolean {
  return admitted && relayError.code === "unknown_room";
}

/**
 * What a phone says when the room it was playing in is gone. The join form
 * comes back with it, and the browser keeps its seat token where it is: a
 * rejoin to whatever room the TV makes next is an ordinary join, under the
 * same token, and the TV decides what becomes of the seat as it always does.
 */
export const GAME_ENDED_MESSAGE = "This game has ended on the TV — scan the TV's code to join again";

/**
 * The error a refusal leaves on this phone's screen.
 *
 * A refusal is not always a fault of this phone's, and it is not always
 * something to put in front of the player as one. The one that is not is the
 * wait: a phone refused by a room whose TV is away is in no trouble at all --
 * its seat is being kept, and the phone is dialling again. That refusal comes
 * with a status line of its own, and `onStatus` above puts every closed
 * detail on screen, so this is what takes it back off: the wait has a screen
 * of its own ("Waiting for the TV…"), and a red sentence about the connection
 * over the top of it says the opposite of what the screen underneath is
 * promising. Nothing else is swallowed -- every other refusal keeps the
 * relay's own sentence, which is the one thing on screen that can say what
 * actually happened.
 */
export function errorAfterRefusal(relayError: RelayErrorMessage): string | null {
  return waitsOutTvGap(relayError) ? null : relayError.detail;
}

/**
 * How long a phone waits on a room with no TV before it stops promising the
 * wait will end by itself, and offers to leave instead.
 *
 * The same three minutes a seat is held for (`SEAT_GRACE_MS`, the TV's own
 * reducer), and deliberately the same number rather than a second opinion
 * about it: it is one fact, how long a chair is kept for somebody who has
 * stepped away. Waiting less and offering to leave would invite a player to
 * walk out on a seat that is still being kept for them; the test pins the two
 * together so a change to either has to be a change to both.
 */
export const WAITING_GRACE_MS = 180_000;

/**
 * What a phone shows while the room's TV is away: it stays joined, keeps its
 * seat, and says what it is waiting for. Deliberately not the join screen --
 * nothing about this phone's place in the room has changed.
 *
 * `waitedPastGrace` is the wait outliving the seat's own grace window. Past it
 * the sentence "this sorts itself out on its own" stops being true -- a TV
 * that has been away that long is off, or has been reloaded onto a different
 * game, and the room these phones are holding open is one nobody is coming
 * back to -- so the copy says so and the way out arrives with it. Both come
 * from the one flag: a button that leaves a room, next to a sentence promising
 * the room will sort itself out, is the screen arguing with itself.
 *
 * `onJoinDifferentGame` leaves this room and returns to the join form. It is
 * not giving up the seat: the browser keeps the token it minted, unrotated, so
 * rejoining whatever game the TV is showing now is an ordinary join under it.
 */
export function WaitingForTv({
  waitedPastGrace = false,
  onJoinDifferentGame,
}: {
  waitedPastGrace?: boolean;
  onJoinDifferentGame?: () => void;
}) {
  return (
    <div class="phone" data-testid="phone" data-role="" data-mode="waiting">
      <div class="waiting-card">
        <h1>Waiting for the TV…</h1>
        <p data-testid="waiting-for-tv">
          {waitedPastGrace
            ? "The room's TV has not come back, and it may have started a new game — this room is the old one. Join the game the TV is showing now."
            : "The room's TV is not here right now. Your seat is still yours — this sorts itself out on its own."}
        </p>
        {waitedPastGrace && onJoinDifferentGame ? (
          <button class="mini" data-testid="join-different-game" onClick={onJoinDifferentGame}>
            Join a different game
          </button>
        ) : null}
      </div>
    </div>
  );
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}


export function PhoneApp() {
  const params = useMemo(() => parseLaunchParams(window.location.search, window.location.hash), []);
  const relayUrl = params.relay ?? defaultRelayUrl(window.location);
  const [room, setRoom] = useState(params.room ?? "");
  const [name, setName] = useState("");
  const [want, setWant] = useState<RoleId | "any">("any");
  const [joined, setJoined] = useState(false);
  // Bumped by "Use this one instead" to force the connection effect to open
  // a fresh socket and re-announce the same seat token -- the effect's own
  // dependencies otherwise never change on a supersede, since the room,
  // name and role wanted are exactly what they were.
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [status, setStatus] = useState("connecting");
  // True while this phone knows the room has no TV in it -- either because the
  // welcome it just read named none, or because something it sent to the TV
  // came back refused. The phone stays joined throughout; this only decides
  // what it shows, and it goes away the moment a TV is announced.
  const [waitingForTv, setWaitingForTv] = useState(false);
  // True once that wait has outlived the seat's own grace window: the point
  // at which "the TV is stepping out" stops being the likely story and "the
  // TV is showing a different game" starts being it. See `WaitingForTv`.
  const [waitedOutTv, setWaitedOutTv] = useState(false);
  const [view, setView] = useState<PhoneView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holdMs, setHoldMs] = useState(DEFAULT_HOLD_MS);
  const [showClues, setShowClues] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [ring, setRing] = useState(0);
  // What this phone types into the "get my seat back" box -- kept separate
  // from `name`, which is only ever sent on an ordinary `join` (design
  // direction, section 1: reclaiming is its own deliberate action, never an
  // implicit side effect of retyping a name into the join form).
  const [reclaimName, setReclaimName] = useState("");
  // Set as soon as this tab's own seat is known (`seatIdFor`, `onWelcome`
  // below) -- the one place this tab's in-memory idea of its own token lives.
  const seatRef = useRef<string | null>(null);
  // Set when this browser cannot mint or keep a seat token at all -- no
  // IndexedDB, or it refused. There is no fallback: the phone shows why and
  // a way to retry, rather than joining on a token only this tab could ever
  // read back.
  const [storageBlocked, setStorageBlocked] = useState(false);
  // True only for the short span between "This isn't my seat" and this tab's
  // own fresh token landing in storage and being re-announced -- role
  // selection stays off for that span so a tap cannot land under the token
  // that is about to be replaced.
  const [rotatingSeat, setRotatingSeat] = useState(false);
  // Set when the TV reports that the seat this connection was playing has
  // been moved to another connection (`superseded`, below) -- it holds no
  // role here any more. The screen it falls back to offers the one move that
  // still makes sense: present the same seat token again. That is a REQUEST,
  // not a win-back -- it goes through the same TV approval as any other
  // presented token, and the tab now playing keeps the seat until the remote
  // answers.
  const [superseded, setSuperseded] = useState(false);
  // The rebuild moment, tracked only so THIS phone can offer its own stable
  // "Continue" target when it is the one whose controls are changing (design
  // direction, section 1). Cleared as soon as the player dismisses it.
  const [switchState, setSwitchState] = useState<{ role: RoleId; phase: SwitchPhase } | null>(null);
  const clientRef = useRef<RelayClient | null>(null);
  const voiceRef = useRef<VoiceListener | null>(null);
  // This tab's own record of which connection the relay says is the room's
  // TV -- the one thing `isFromRoomTv` checks a game message's stamped
  // `from` against. Set from `welcome.peers` and kept in step by
  // `peer_joined`/`peer_left`, never from anything a game message itself
  // claims.
  const tvPeerIdRef = useRef<PeerId | null>(null);

  /* ---------------- scan machine ---------------- */

  const scanRef = useRef<ScanState>(createScan([], holdMs));
  const [scanView, setScanView] = useState<ScanState>(scanRef.current);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringFrame = useRef<number | null>(null);

  const sendIntent = useCallback((intent: Intent) => {
    const client = clientRef.current;
    if (!client) return;
    client.sendToTv({ t: "intent", intent });
  }, []);

  const applyScan = useCallback(
    (event: ScanEvent) => {
      const previous = scanRef.current;
      const next = scanReduce(previous, event);
      scanRef.current = next;
      setScanView(next);
      if (next.selections > previous.selections && next.selected) {
        sendIntent({ k: "choose", choiceId: next.selected });
      }
    },
    [sendIntent],
  );

  /**
   * "This isn't my seat": release the claim, then rotate this browser's
   * persisted token before anything else can pick a role under it.
   *
   * Order still matters. A claimant carries no `seat` of its own on the TV
   * (`reducer.ts`'s `player_joined` keeps the contested token in
   * `claimedSeat` alone), so the rotation is not undoing a borrowed identity
   * any more -- but a `join` sent while `claimedSeat` is still set is treated
   * as the same claimant repeating itself and never adopts the new token
   * (that stickiness is what stops a claimant being handed a role before the
   * TV decides). So `release_claim` goes first, and the fresh token's
   * announcement follows it.
   *
   * The rotation itself is a transaction, so it cannot interleave with
   * another tab's first mint into two different answers.
   *
   * `mayRotateSeat` is checked here and not only at the button, so a stale
   * render cannot rotate away a token a seat is still held under: the view
   * this reads is the one the TV last sent.
   */
  const handleReleaseClaim = useCallback(() => {
    if (!mayRotateSeat(view)) return;
    sendIntent({ k: "release_claim" });
    setRotatingSeat(true);
    void (async () => {
      try {
        const fresh = await mintFreshSeat(room);
        seatRef.current = fresh.token;
        const client = clientRef.current;
        if (client) client.sendToTv({ t: "join", ...(name ? { name } : {}), seat: fresh.token });
      } catch (err) {
        setError(err instanceof SeatPersistenceError ? SEAT_PERSISTENCE_MESSAGE : NO_SECURE_RANDOM_MESSAGE);
      } finally {
        setRotatingSeat(false);
      }
    })();
  }, [room, name, sendIntent, view]);

  /* ---------------- connection ---------------- */

  useEffect(() => {
    if (!joined) return;
    const client = createRelayClient({
      url: relayUrl,
      kind: "phone",
      room,
      ...(name ? { name } : {}),
      handlers: {
        onStatus: (next, detail) => {
          setStatus(next);
          if (detail && next === "closed") setError(detail);
        },
        onWelcome: (welcome) => {
          const roomTv = welcome.peers.find((peer) => peer.kind === "tv")?.peerId ?? null;
          tvPeerIdRef.current = roomTv;
          // The welcome is the relay's own word on who is in the room at this
          // instant, so a room with no TV in it is known before this phone
          // sends anything -- the `join` below is still sent (the TV may have
          // arrived in between), but there is nothing on screen to change
          // until it does.
          setWaitingForTv(roomTv === null);
          // Settling the token is a transaction, so this is async -- and the
          // `join` must not go out before it resolves, or this tab would
          // announce a token its own browser is about to disagree with.
          // `onJoin` below already refuses to connect at all without a
          // CSPRNG; this is defense in depth against `crypto` changing shape
          // between that check and the relay's `welcome` arriving.
          void (async () => {
            try {
              const seat = await seatIdFor(room);
              seatRef.current = seat.token;
              setError(null);
              client.sendToTv({
                t: "join",
                ...(name ? { name } : {}),
                ...(want === "any" ? {} : { want }),
                seat: seat.token,
              });
            } catch (err) {
              if (err instanceof SeatPersistenceError) setStorageBlocked(true);
              else setError(NO_SECURE_RANDOM_MESSAGE);
              setJoined(false);
              client.close();
            }
          })();
        },
        onPeerJoined: (peer: PeerSummary) => {
          if (peer.kind !== "tv") return;
          tvPeerIdRef.current = peer.peerId;
          // A TV arriving in the room is the end of the gap. Everything this
          // phone sent while the room had none was refused, so the join goes
          // again -- the token is the one this browser has always carried, and
          // what becomes of the seat is the TV's call either way. On a room
          // that never had a gap this is the harmless repeat of a join the
          // seat's own live connection is already known by.
          setWaitingForTv(false);
          const seat = seatRef.current;
          if (seat === null) return;
          client.sendToTv({
            t: "join",
            ...(name ? { name } : {}),
            ...(want === "any" ? {} : { want }),
            seat,
          });
        },
        onPeerLeft: (peerId: PeerId) => {
          if (peerId === tvPeerIdRef.current) {
            tvPeerIdRef.current = null;
            setWaitingForTv(true);
          }
        },
        onRelayError: (relayError) => {
          // The room's TV is away and this phone is still in the room. That is
          // not a refusal of this phone -- its seat is held for it -- so it
          // waits the gap out rather than going back to the join screen.
          if (waitsOutTvGap(relayError)) {
            setWaitingForTv(true);
            // The refusal arrived with a status line of its own, and `onStatus`
            // has just put that line on screen as an error. The wait is not
            // one, so it is taken back off here -- after that line, in the same
            // frame, which is the only place that can do it.
            setError(errorAfterRefusal(relayError));
            return;
          }
          // The room does not exist. `client.room` is this phone's memory of
          // having been admitted, kept on purpose so a blip returns it to the
          // same room -- what it says is that this phone WAS in a room, not
          // that the room is still there. When it was, the room that is gone
          // is the one the game was being played in: the relay restarted, or
          // the room's window closed. Nothing here is worth waiting on, so the
          // phone stops being joined -- which closes this connection, so it
          // stops dialling the dead room -- and offers the join form with the
          // seat token still in the browser for whatever room comes next.
          if (endedOnTheTv(relayError, client.room !== null)) {
            setWaitingForTv(false);
            setError(GAME_ENDED_MESSAGE);
            setRoom("");
            setJoined(false);
            return;
          }
          setError(errorAfterRefusal(relayError));
          setJoined(false);
        },
        onGame: (message: GameMessage, from: PeerId | null) => {
          // Every message here changes what this phone shows or does, so it
          // is trusted only when the relay itself says it came from the
          // room's TV -- never a peer that merely joined as a phone.
          if (!isFromRoomTv(from, tvPeerIdRef.current)) return;
          if (message.t === "view") setView(message.view);
          if (message.t === "assigned" && message.role === null) {
            setError(message.reason ?? "the TV has no free role for you");
          }
          if (message.t === "switch") {
            setSwitchState({ role: message.role, phase: message.phase });
          }
          // The TV kept a newer connection presenting this same seat's
          // token -- this one holds no role here any more, and the peer id
          // it arrived on is gone from the TV's own state, so it closes
          // itself rather than sit on a socket the TV has already moved
          // past. `superseded` renders the fallback screen; "Use this one
          // instead" re-announces the same seat token, becoming the newest
          // connection in turn.
          if (message.t === "superseded") {
            setSuperseded(true);
            client.close();
          }
        },
      },
    });
    clientRef.current = client;
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [joined, relayUrl, room, name, want, reconnectAttempt]);

  const handleUseThisOneInstead = useCallback(() => {
    setSuperseded(false);
    setReconnectAttempt((n) => n + 1);
  }, []);

  /* ---------------- the wait that has gone on too long ---------------- */

  /**
   * A room stays live while anything is in it, so a TV that is never coming
   * back leaves the phones in it waiting for something nothing on the other
   * end will ever send. The grace window is the honest deadline -- the same
   * one the TV keeps the seat for -- and it is measured from the moment the
   * gap opened, so a phone that drops in and out of the wait restarts it, the
   * same way a seat's own hold restarts when its holder drops again.
   */
  useEffect(() => {
    if (!waitingForTv) {
      setWaitedOutTv(false);
      return;
    }
    const timer = setTimeout(() => setWaitedOutTv(true), WAITING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [waitingForTv]);

  /**
   * "Join a different game": leave this room and go back to the join form.
   *
   * The seat token is not rotated and not given up -- leaving a room is not
   * giving up a seat, and the browser keeps the token it minted so rejoining
   * whatever the TV is showing now is an ordinary join under it. Clearing
   * `joined` closes the socket, which is what stops this phone dialling a
   * room that is not there any more; clearing the room code is what makes the
   * form start empty rather than pre-filled with the code it is leaving.
   * Nothing is sent to the relay: there is no TV to hear it.
   */
  const handleJoinDifferentGame = useCallback(() => {
    setWaitingForTv(false);
    setRoom("");
    setJoined(false);
  }, []);

  /* ---------------- keep the scan machine in step with the view ---------------- */

  const choices: Choice[] = view?.choices ?? [];
  const choiceKey = choices.map((choice) => choice.id).join("|");
  const mode = view?.mode ?? "waiting";

  useEffect(() => {
    if (mode !== "scan") return;
    applyScan({ t: "set_items", items: choices.map((choice) => choice.id) });
    // Re-syncing is keyed on the ids themselves: a redrawn list with the same
    // entries must not knock the highlight back to the top.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choiceKey, mode]);

  useEffect(() => {
    applyScan({ t: "set_hold_ms", holdMs });
  }, [holdMs, applyScan]);

  /* ---------------- voice ---------------- */

  useEffect(() => {
    if (mode !== "voice" || choices.length === 0) {
      voiceRef.current?.stop();
      voiceRef.current = null;
      return;
    }
    const listener = listen(
      (transcript) => {
        const index = matchOption(
          transcript,
          choices.map((choice) => choice.label),
        );
        if (index === null) {
          setVoiceNote(`didn't catch “${transcript}” — tap it instead`);
          return;
        }
        setVoiceNote(null);
        const choice = choices[index];
        if (choice) sendIntent({ k: "choose", choiceId: choice.id });
      },
      (problem) => setVoiceNote(problem),
    );
    voiceRef.current = listener;
    return () => {
      listener.stop();
      voiceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, choiceKey, sendIntent]);

  const voiceSupported = useMemo(() => {
    const scope = globalThis as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    return Boolean(scope.SpeechRecognition ?? scope.webkitSpeechRecognition);
  }, []);

  /* ---------------- press handling (scan mode) ---------------- */

  const endHold = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (ringFrame.current !== null) {
      cancelAnimationFrame(ringFrame.current);
      ringFrame.current = null;
    }
    setRing(0);
  }, []);

  const pressStart = useCallback(() => {
    const at = now();
    applyScan({ t: "press_start", at });
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null;
      applyScan({ t: "tick", at: now() });
      endHold();
    }, scanRef.current.holdMs);
    const loop = () => {
      setRing(holdProgress(scanRef.current, now()));
      ringFrame.current = requestAnimationFrame(loop);
    };
    ringFrame.current = requestAnimationFrame(loop);
  }, [applyScan, endHold]);

  const pressEnd = useCallback(() => {
    applyScan({ t: "press_end", at: now() });
    endHold();
  }, [applyScan, endHold]);

  useEffect(
    () => () => {
      endHold();
    },
    [endHold],
  );

  /* ---------------- render ---------------- */

  if (storageBlocked) {
    return (
      <div class="phone" data-testid="phone" data-role="" data-mode="waiting">
        <div class="waiting-card">
          <h1>Storage blocked</h1>
          <p data-testid="storage-blocked-notice">{STORAGE_BLOCKED_MESSAGE}</p>
          <button
            class="join-button"
            data-testid="storage-blocked-retry"
            onClick={() => setStorageBlocked(false)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!joined) {
    return (
      <JoinScreen
        room={room}
        setRoom={setRoom}
        name={name}
        setName={setName}
        want={want}
        setWant={setWant}
        error={error}
        status={status}
        relayUrl={relayUrl}
        // No URL field ever carried a mystery title -- this screen has no
        // connection yet to check one against, and a stale link or an edited
        // fragment could have claimed any title. The neutral product name is
        // the only thing this screen can say for certain.
        mysteryTitle={PRODUCT_TITLE}
        onJoin={() => {
          const normalized = normalizeRoomCode(room);
          if (!normalized) {
            setError("a room code is four letters");
            return;
          }
          // Fail closed before ever opening a connection: a seat token minted
          // without a CSPRNG is guessable, so a browser with none does not
          // get to try.
          if (!hasSecureRandom()) {
            setError(NO_SECURE_RANDOM_MESSAGE);
            return;
          }
          // Same idea for the store the token has to live in -- IndexedDB
          // missing entirely is known synchronously, before a socket opens.
          // A present-but-broken IndexedDB is only found once actually
          // opened (`onWelcome`'s own catch, below), since opening it is
          // asynchronous.
          if (!hasIndexedDb()) {
            setStorageBlocked(true);
            return;
          }
          setRoom(normalized);
          setError(null);
          setJoined(true);
        }}
      />
    );
  }

  if (waitingForTv) {
    return <WaitingForTv waitedPastGrace={waitedOutTv} onJoinDifferentGame={handleJoinDifferentGame} />;
  }

  if (superseded) {
    return (
      <div class="phone" data-testid="phone" data-role="" data-mode="waiting">
        <div class="waiting-card">
          <h1>Superseded</h1>
          <p data-testid="superseded-notice">This seat is now open on another tab or phone.</p>
          <button class="join-button" data-testid="use-this-one-instead" onClick={handleUseThisOneInstead}>
            Use this one instead
          </button>
        </div>
      </div>
    );
  }

  if (!view || view.role === null) {
    const heldRoles = view?.heldRoles ?? [];
    return (
      <div class="phone" data-testid="phone" data-role="" data-mode="waiting">
        <div class="waiting-card">
          <h1>{view ? "Pick a role" : "Waiting"}</h1>
          <p>{error ?? view?.prompt ?? "the TV has not given you a role yet"}</p>
          {/* No picker until the TV has said which roles are taken: offering
              one that is already somebody's is a button that only refuses.
              Nor while this tab's own token is being rotated (`rotatingSeat`)
              -- a tap that lands mid-rotation could choose a role under the
              token that is about to be replaced. Nor when this browser is
              already playing in another tab: one browser is one player, so
              every role here would be refused, and saying so once beats a
              screen of buttons that all say no. */}
          {view && !rotatingSeat && view.otherTabRole === null ? (
            <RolePicker
              roles={view.seatRoles}
              taken={view.takenRoles}
              onPick={(role) => sendIntent({ k: "choose_role", role })}
            />
          ) : null}
          {view?.notice ? (
            <p class="notice" data-testid="phone-notice">
              {view.notice}
            </p>
          ) : null}
          {/* This browser is already playing, on a tab this one cannot see.
              There is nothing to choose and nothing to undo from here: the
              seat moves only if the person with the remote moves it, and
              rotating this browser's token would strand the seat rather than
              free it. So the phone says the one true sentence and stops. */}
          {view?.otherTabRole ? (
            <div class="reclaim" data-testid="other-tab">
              <p class="dim" data-testid="other-tab-notice">
                This phone is already playing as {view.otherTabRole} in another tab.
              </p>
              <p class="dim">
                {view.claimingSeat
                  ? "The TV has been asked whether to move that seat to this tab."
                  : "Only the TV can move that seat to this tab."}
              </p>
            </div>
          ) : null}
          {/* A phone holding a seat code for a seat that nothing live or held
              stands behind: the wait cannot be ended by the TV, because there
              is no seat for it to decide about. This is the way out from the
              phone's own side -- the claim goes, this browser's token is
              rotated, and the player is an ordinary new arrival again. The
              rotation is safe exactly here and nowhere else (`mayRotateSeat`):
              no seat is held under the token being replaced. */}
          {mayRotateSeat(view) ? (
            <div class="reclaim" data-testid="release-claim">
              <p class="dim">
                This phone is carrying a seat code for a seat that is already in play on another
                screen. Nothing here will change until you say what to do — if that seat is not
                yours, say so and pick any free role.
              </p>
              <button
                class="join-button"
                data-testid="release-claim-button"
                disabled={rotatingSeat}
                onClick={handleReleaseClaim}
              >
                This isn't my seat
              </button>
            </div>
          ) : null}
          {/* A phone that reopens the join link mid-game is a stranger to the
              TV (a fresh tab has no seat of its own), so a role held for a
              dropped player just reads "taken" -- with nothing to do about it
              until the hold runs out. This is the something to do: the same
              name that was joined with, typed here, reclaims that exact seat
              -- and only that seat, never one somebody is still actively
              playing (`reduceApp`'s `reclaim_seat`). */}
          {view && heldRoles.length > 0 ? (
            <div class="reclaim" data-testid="reclaim-seat">
              <p class="dim">
                {heldRoles.join(" and ")} {heldRoles.length > 1 ? "are" : "is"} held for someone who
                dropped, for up to 3 minutes. If that was you, enter the name you joined with to get
                your seat back:
              </p>
              <input
                class="name-input"
                data-testid="reclaim-name-input"
                value={reclaimName}
                maxLength={24}
                placeholder="the name you joined with"
                onInput={(event) => setReclaimName((event.target as HTMLInputElement).value)}
              />
              <button
                class="join-button"
                data-testid="reclaim-button"
                onClick={() => sendIntent({ k: "reclaim_seat", name: reclaimName })}
              >
                That's my seat — get it back
              </button>
            </div>
          ) : null}
          <p class="dim">room {room || "—"} · relay {status}</p>
        </div>
      </div>
    );
  }

  const highlighted = scanView.items[scanView.index] ?? null;
  const canChangeInput = view.canChangeInput;
  const hint = holdHint(view.choiceKind, choices);

  return (
    <div class="phone" data-testid="phone" data-role={view.role} data-mode={view.mode} data-status={status}>
      <header class="bar">
        <span class="role" data-testid="phone-role">
          {view.role}
        </span>
        <span class="mode" data-testid="phone-mode">
          {MODE_LABEL[view.mode] ?? view.mode}
        </span>
        <button class="mini" data-testid="clues-button" onClick={() => setShowClues((v) => !v)}>
          My clues
        </button>
        {canChangeInput ? (
          <button class="mini" data-testid="change-input-button" onClick={() => setShowInput((v) => !v)}>
            Change input
          </button>
        ) : null}
        {view.canChangeRole ? (
          <button
            class="mini"
            data-testid="change-role-button"
            onClick={() => setConfirmRelease(true)}
          >
            Change role
          </button>
        ) : null}
      </header>

      {confirmRelease ? (
        <div class="sheet" data-testid="confirm-release-sheet">
          <h2>Give up {view.role}?</h2>
          <p class="dim">You will leave the game until you pick a role again.</p>
          <div class="confirm-buttons">
            <button
              class="mini"
              data-testid="confirm-release-cancel"
              onClick={() => setConfirmRelease(false)}
            >
              Stay as {view.role}
            </button>
            <button
              class="mini"
              data-testid="confirm-release-confirm"
              onClick={() => {
                setConfirmRelease(false);
                sendIntent({ k: "release_role" });
              }}
            >
              Give up {view.role}
            </button>
          </div>
        </div>
      ) : null}

      {switchState && switchState.role === view.role ? (
        <div class="switch-banner" data-testid="phone-switch-banner" data-phase={switchState.phase}>
          <p>
            {switchState.phase === "refused"
              ? "That change was refused. Your previous controls are still selected."
              : "Your controls are being rebuilt around you."}
          </p>
          <button
            class="mini"
            data-testid="phone-switch-continue"
            onClick={() => {
              sendIntent({ k: "continue_switch" });
              setSwitchState(null);
            }}
          >
            Continue
          </button>
        </div>
      ) : null}

      {view.badge ? (
        <div class="badge-mini" data-testid="phone-badge" data-ok={String(view.badge.ok)}>
          {view.badge.lines.map((line) => (
            <span class={`badge-chip ${line.ok ? "ok" : "bad"}`}>{`${line.ok ? "✓" : "✗"} ${line.label}`}</span>
          ))}
        </div>
      ) : null}

      {view.notice ? (
        <div class="notice" data-testid="phone-notice">
          {view.notice}
        </div>
      ) : null}

      {showClues ? (
        <div class="sheet" data-testid="clues-sheet">
          <h2>Only you can see this</h2>
          {view.clues.map((clue) => (
            <p class="clue" data-testid={`clue-${clue.id}`}>
              {clue.text}
            </p>
          ))}
          {view.clues.length === 0 ? <p class="dim">No private clues for this role.</p> : null}
          <button class="mini" onClick={() => setShowClues(false)}>
            Close
          </button>
        </div>
      ) : null}

      {showInput ? (
        <div class="sheet" data-testid="input-sheet">
          <h2>Change my input</h2>
          <p class="dim">The TV rebuilds the rest of the puzzle around your new input.</p>
          {(["dpad", "voice", "scan"] as Capability[]).map((capability) => (
            <button
              class="mode-pick"
              data-testid={`pick-mode-${capability}`}
              data-current={String(view.capabilities.includes(capability))}
              onClick={() => {
                setShowInput(false);
                sendIntent({ k: "request_input_change", capabilities: [capability] });
              }}
            >
              {MODE_LABEL[capability]}
            </button>
          ))}
          <label class="hold-control">
            Hold time: {(holdMs / 1000).toFixed(2)}s
            <input
              type="range"
              data-testid="hold-slider"
              min={MIN_HOLD_MS}
              max={MAX_HOLD_MS}
              step={50}
              value={holdMs}
              onInput={(event) => setHoldMs(clampHoldMs(Number((event.target as HTMLInputElement).value)))}
            />
          </label>
          <button class="mini" onClick={() => setShowInput(false)}>
            Close
          </button>
        </div>
      ) : null}

      {view.mode === "dpad" ? (
        <main class="dpad-body">
          <h1 data-testid="dpad-prompt">Use the TV remote</h1>
          <p class="dim">
            You play with the d-pad. The TV is showing what you can do — arrows move, the centre button
            chooses.
          </p>
          <h2>What only you know</h2>
          {view.clues.map((clue) => (
            <p class="clue" data-testid={`clue-${clue.id}`}>
              {clue.text}
            </p>
          ))}
        </main>
      ) : (
        <main class="choices">
          <p class="prompt" data-testid="prompt">
            {view.prompt}
          </p>
          {view.mode === "scan" ? (
            <>
              {/* A move can take two holds, and the phone has to say so: the
                  first picks the action, the second answers the question that
                  action asks. */}
              <p
                class="dim small"
                data-testid="scan-hint"
                data-step={hint.step}
                data-steps={hint.steps}
              >
                {hint.line}
              </p>
              <p class="dim small" data-testid="scan-tap-hold">
                {hint.tap} · {hint.hold}
              </p>
              <div
                class="scan-surface"
                data-testid="scan-surface"
                onPointerDown={(event) => {
                  event.preventDefault();
                  pressStart();
                }}
                onPointerUp={pressEnd}
                onPointerCancel={pressEnd}
                onPointerLeave={pressEnd}
                onKeyDown={(event) => {
                  if (event.key === " " || event.key === "Enter") {
                    event.preventDefault();
                    if (!scanRef.current.holding) pressStart();
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === " " || event.key === "Enter") pressEnd();
                }}
                tabIndex={0}
              >
                {choices.map((choice) => {
                  const isHighlighted = highlighted === choice.id;
                  return (
                    <div
                      class="choice"
                      data-testid={`choice-${choice.id}`}
                      data-choice-id={choice.id}
                      data-highlighted={String(isHighlighted)}
                    >
                      <span class="choice-label">{choice.label}</span>
                      {choice.hint ? <span class="choice-hint">{choice.hint}</span> : null}
                      {isHighlighted ? (
                        <span
                          class="ring"
                          data-testid="scan-ring"
                          style={{ transform: `scaleX(${ring.toFixed(3)})` }}
                        />
                      ) : null}
                    </div>
                  );
                })}
                {choices.length === 0 ? <div class="empty">nothing to choose right now</div> : null}
              </div>
            </>
          ) : (
            <div class="voice-list" data-testid="voice-list">
              {choices.map((choice) => (
                <button
                  class="choice voice"
                  data-testid={`choice-${choice.id}`}
                  data-choice-id={choice.id}
                  onClick={() => sendIntent({ k: "choose", choiceId: choice.id })}
                >
                  <span class="choice-label">{choice.label}</span>
                  {choice.hint ? <span class="choice-hint">{choice.hint}</span> : null}
                </button>
              ))}
              <p class="dim small" data-testid="voice-status">
                {voiceSupported
                  ? "Listening. Say one of the names above — or tap it."
                  : "This browser has no speech recognition, so tap instead."}
              </p>
              {voiceNote ? <p class="notice">{voiceNote}</p> : null}
            </div>
          )}
        </main>
      )}
    </div>
  );
}

/**
 * The roles this phone may take.
 *
 * A role somebody else is sitting in is shown, disabled and marked -- not
 * hidden. A player who cannot see that B is taken learns nothing from a button
 * that is simply missing, and the TV would refuse the pick anyway. A role the
 * current mystery has no seat for at all is left off the list entirely,
 * rather than shown as if picking it could ever succeed: the wire's own A/B/C
 * vocabulary is wider than any one mystery's own seats (`roles`, from the
 * TV's `seatRoles`).
 */
function RolePicker({
  roles,
  taken,
  onPick,
}: {
  roles: readonly RoleId[];
  taken: readonly RoleId[];
  onPick: (role: RoleId) => void;
}) {
  return (
    <div class="role-picks" data-testid="role-picker">
      {roles.map((role) => {
        const isTaken = taken.includes(role);
        return (
          <button
            class="role-pick"
            data-testid={`pick-role-${role}`}
            data-taken={String(isTaken)}
            disabled={isTaken}
            onClick={() => onPick(role)}
          >
            {role}
            {isTaken ? <span class="dim"> taken</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function JoinScreen(props: {
  room: string;
  setRoom: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  want: RoleId | "any";
  setWant: (value: RoleId | "any") => void;
  error: string | null;
  status: string;
  relayUrl: string;
  /** The TV's currently selected mystery, or the neutral product title if not yet known. */
  mysteryTitle: string;
  onJoin: () => void;
}) {
  return (
    <div class="phone join" data-testid="join-form">
      <h1 data-testid="join-heading">{props.mysteryTitle}</h1>
      <p class="dim">Room code from the TV:</p>
      <input
        class="code-input"
        data-testid="room-input"
        value={props.room}
        maxLength={8}
        autocapitalize="characters"
        autocomplete="off"
        onInput={(event) => props.setRoom((event.target as HTMLInputElement).value.toUpperCase())}
      />
      <p class="dim">Your name (optional):</p>
      <input
        class="name-input"
        data-testid="name-input"
        value={props.name}
        maxLength={24}
        onInput={(event) => props.setName((event.target as HTMLInputElement).value)}
      />
      <p class="dim">Which role?</p>
      <div class="role-picks">
        {(["any", ...ROLE_IDS] as const).map((role) => (
          <button
            class="role-pick"
            data-testid={`want-${role}`}
            data-selected={String(props.want === role)}
            onClick={() => props.setWant(role as RoleId | "any")}
          >
            {role === "any" ? "any" : role}
          </button>
        ))}
      </div>
      <button class="join-button" data-testid="join-button" onClick={props.onJoin}>
        Join
      </button>
      {props.error ? (
        <p class="notice" data-testid="join-error">
          {props.error}
        </p>
      ) : null}
      <p class="dim small">
        relay {props.relayUrl} · {props.status}
      </p>
    </div>
  );
}
