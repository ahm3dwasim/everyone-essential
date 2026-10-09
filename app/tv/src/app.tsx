/**
 * The TV: connection, keys, and which screen is on.
 *
 * The state lives in `game/reducer.ts` and this file only moves messages in and
 * out of it. Two things are worth knowing:
 *
 *   - The TV is the host, so it is the only place that runs `recompile`. When a
 *     phone asks to change its input, the request comes back here, and the
 *     answer -- repaired puzzle or an honest refusal -- goes out to every phone
 *     as it is decided.
 *   - A phone is only ever sent its own view. `phoneView` filters by role, so a
 *     phone cannot be shown another role's clues even by accident.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";
import { createRelayClient, type RelayClient } from "../../shared/client.ts";
import { defaultRelayUrl, parseLaunchParams, phoneUrl } from "../../shared/rooms.ts";
import type { GameMessage } from "../../shared/protocol.ts";
import {
  SEAT_GRACE_MS,
  SWITCH_PHASES,
  TV_PEER,
  asProtocolCapabilities,
  createGame,
  diffToWire,
  finalBadge,
  finalCertificate,
  heldRolesIn,
  isConnected,
  phoneView,
  reduceApp,
  vacantRolesIn,
} from "./game/reducer.ts";
import {
  INITIAL_CONNECTION,
  connectionOnRelayError,
  connectionOnStatus,
  relayIsOpen,
  type TvConnection,
} from "./connection.ts";
import { badge, type Badge } from "./game/badge.ts";
import { ROLE_LABEL } from "./game/presentation.ts";
import {
  collectTargets,
  findFocusTarget,
  keyIntent,
  nextFocus,
  reclaimControlId,
  reclaimDecision,
  reclaimFocusTarget,
  RECLAIM_APPROVE,
  RECLAIM_DECLINE,
  type KeyIntent,
} from "./remote.ts";
import {
  ActionBoard,
  CluesFound,
  Ending,
  HeldSeats,
  HowWeChecked,
  LeavePrompt,
  Lobby,
  PlayersHelp,
  ReclaimApproval,
  RebuildMoment,
  RoomGone,
  Scene,
  SwitchRefusal,
} from "./screens.tsx";
import { mysteryById } from "./game/mysteries.ts";

/**
 * How long each of the rebuild moment's four beats holds the screen, in order:
 * held stationary, revealed beside the old control, the payoff, back to play.
 * Sums to 8.0 s.
 */
export const PHASE_MS = [1200, 2200, 2200, 2400];
/** How long a "that did not work" line stays up. */
const NOTICE_MS = 4000;

/**
 * The product's neutral name -- the same string `app/phone/src/app.tsx` uses
 * for its join heading, and the one `index.html` ships before this script
 * runs. Never a mystery title: the tab should name the mystery the room
 * actually selected, not whichever one happens to be baked into the document.
 */
const PRODUCT_TITLE = "Everyone Is Essential";

/**
 * What the browser tab says for a given mystery: the selected mystery's own
 * title, or the neutral product name if this is not a mystery we know. Kept
 * separate from the effect that assigns it so the wording is testable without
 * a DOM.
 */
export function tabTitle(puzzleId: string): string {
  const mystery = mysteryById(puzzleId);
  return mystery ? `${mystery.title} — ${PRODUCT_TITLE}` : PRODUCT_TITLE;
}

/**
 * The footer's hint, contextual rather than a fixed desktop-flavoured line:
 * it describes Back only for the screen it actually closes.
 */
function footerHint(state: ReturnType<typeof createGame>, leaveOpen: boolean): string {
  if (leaveOpen) return "D-pad: move · Centre: choose · Back: stay";
  if (state.phase === "switching") return "D-pad: move · Centre: choose · Back: dismiss";
  if (state.pending["tv"]) return "D-pad: move · Centre: choose · Back: close";
  return "D-pad: move · Centre: choose";
}

export function TvApp() {
  const [state, dispatch] = useReducer(reduceApp, undefined, () => createGame());
  // The socket's state and the last refusal the relay sent, kept apart on
  // purpose: only the socket decides whether a claim may be made, and a
  // refusal decides only what to say about it. See `connection.ts`.
  const [connection, setConnection] = useState<TvConnection>(INITIAL_CONNECTION);
  // Set when the relay refuses this connection as this room's TV. There is no
  // way back into the game the family was playing from here, so the board is
  // replaced by the one thing that can be done about it.
  const [roomGone, setRoomGone] = useState(false);
  const [focusId, setFocusIdState] = useState<string | null>(null);
  const clientRef = useRef<RelayClient | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Where the ring is right now, readable from the keydown listener. The
  // listener is registered once, so it cannot close over `focusId`: a press
  // delivered in the window between the ring moving and the effect
  // re-registering would act on the control the ring just left.
  const focusRef = useRef<string | null>(null);
  // Whether the "leave the game?" question is on screen, readable from the same
  // keydown listener and for the same reason: the listener is registered once.
  const leaveRef = useRef(false);
  const [leaveOpen, setLeaveOpenState] = useState(false);
  // "Players & help" and "Clues found" are sheets reached from the board, not
  // permanent header furniture: the room-chip and the full facts inventory
  // both move here.
  const [playersHelpOpen, setPlayersHelpOpen] = useState(false);
  const [cluesFoundOpen, setCluesFoundOpen] = useState(false);
  const [howWeCheckedOpen, setHowWeCheckedOpen] = useState(false);
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = playersHelpOpen || cluesFoundOpen || howWeCheckedOpen;

  const setFocusId = useCallback((next: string | null) => {
    focusRef.current = next;
    setFocusIdState(next);
  }, []);

  const setLeaveOpen = useCallback((next: boolean) => {
    leaveRef.current = next;
    setLeaveOpenState(next);
  }, []);

  const params = useMemo(
    () => parseLaunchParams(window.location.search, window.location.hash),
    [],
  );
  const relayUrl = params.relay ?? defaultRelayUrl(window.location);
  // The Fire TV APK loads this page from `file:///android_asset/tv/`, where
  // `window.location.href` cannot be turned into an address a phone can reach
  // -- so the wrapper hands the real LAN address in `base`, read directly
  // (deliberately not through `parseLaunchParams`/`LaunchParams`, whose shape
  // is asserted exactly by test/rooms.test.ts). A page with no wrapper, or a
  // Stick with no usable network, has no `base` and falls back to `location`.
  const phoneBaseOverride = useMemo(() => {
    const read = (source: string): string | null => {
      const body = source.startsWith("?") || source.startsWith("#") ? source.slice(1) : source;
      return new URLSearchParams(body).get("base");
    };
    return read(window.location.hash) ?? read(window.location.search);
  }, []);
  const networkNotice = useMemo(() => {
    const read = (source: string): string | null => {
      const body = source.startsWith("?") || source.startsWith("#") ? source.slice(1) : source;
      return new URLSearchParams(body).get("nolan");
    };
    const flagged = (read(window.location.hash) ?? read(window.location.search)) === "1";
    return flagged
      ? "This Fire TV Stick has no Wi-Fi or Ethernet address right now — connect it to a network to add players."
      : null;
  }, []);
  // The generated mystery has no painted plates yet: it stays out
  // of the picker a family actually sees, but this flag keeps it reachable
  // for a demo, and the generator's own tests never go through this UI at all.
  const showGenerated = useMemo(() => {
    const read = (source: string): string | null => {
      const body = source.startsWith("?") || source.startsWith("#") ? source.slice(1) : source;
      return new URLSearchParams(body).get("generated");
    };
    return (read(window.location.hash) ?? read(window.location.search)) === "1";
  }, []);

  /* ---------------- connection ---------------- */

  useEffect(() => {
    const client = createRelayClient({
      url: relayUrl,
      kind: "tv",
      handlers: {
        onStatus: (next) => setConnection((current) => connectionOnStatus(current, next)),
        onWelcome: (welcome) => {
          dispatch({ k: "room", room: welcome.room });
          // The welcome's peer list is the relay's word on who is in the room
          // right now, and it is the only word this TV gets about a phone that
          // left while its own socket was down: a drop is announced to the
          // peers in the room, and a TV that is away is not one of them. Every
          // welcome is a chance to be told, so every welcome is spent asking.
          dispatch({
            k: "peers_present",
            peerIds: welcome.peers.map((peer) => peer.peerId),
            at: Date.now(),
          });
        },
        onPeerLeft: (peerId) => dispatch({ k: "player_left", peerId, at: Date.now() }),
        onRelayError: (error) => {
          // This TV named its room with a credential the relay would not take,
          // so it is not this room's TV and dialling again cannot change that.
          // The client has already stopped presenting the dead credential;
          // what is left is to stop pretending the game is still here.
          if (error.code === "not_the_tv") setRoomGone(true);
          setConnection((current) => connectionOnRelayError(current, error));
        },
        onGame: (message: GameMessage, from) => {
          if (from === null) return;
          handlePhoneMessage(from, message);
        },
      },
    });
    clientRef.current = client;
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [relayUrl]);

  const handlePhoneMessage = useCallback((peerId: string, message: GameMessage) => {
    switch (message.t) {
      case "join":
        dispatch({
          k: "phone_join",
          peerId,
          ...(message.name ? { name: message.name } : {}),
          ...(message.want ? { want: message.want } : {}),
          ...(message.seat ? { seat: message.seat } : {}),
        });
        break;
      case "intent":
        switch (message.intent.k) {
          case "choose":
            dispatch({ k: "phone_choice", peerId, choiceId: message.intent.choiceId });
            break;
          case "request_input_change":
            dispatch({ k: "phone_input_change", peerId, capabilities: message.intent.capabilities });
            break;
          case "choose_role":
            dispatch({ k: "assign_role", peerId, role: message.intent.role });
            break;
          case "release_role":
            dispatch({ k: "phone_release_role", peerId });
            break;
          case "reclaim_seat":
            dispatch({ k: "phone_reclaim_seat", peerId, name: message.intent.name });
            break;
          case "release_claim":
            dispatch({ k: "phone_release_claim", peerId });
            break;
          case "continue_switch":
            dispatch({ k: "phone_continue_switch", peerId });
            break;
        }
        break;
      default:
        break;
    }
  }, []);

  /* ---------------- outbound views ---------------- */

  const sentRef = useRef(new Map<string, string>());
  useEffect(() => {
    const client = clientRef.current;
    if (!client || client.status !== "open") return;
    for (const player of state.players) {
      if (!player.connected) continue;
      const view = phoneView(state, player.peerId);
      const encoded = JSON.stringify(view);
      if (sentRef.current.get(player.peerId) === encoded) continue;
      sentRef.current.set(player.peerId, encoded);
      client.sendTo(player.peerId, { t: "view", view });
    }
    // The switch, as it happens, so a phone can say what the TV is doing.
    // Delivery is deduped per connected peer, not globally: a player who
    // rejoins under a new peer id mid-beat has never received this beat's
    // encoding under their own key, so it goes out again rather than being
    // swallowed by an unrelated peer's earlier delivery.
    if (state.phase === "switching" && state.pendingSwitch) {
      const record = state.pendingSwitch;
      const encoded = `switch:${record.role}:${state.switchBeat}:${record.kind}`;
      const message: GameMessage = {
        t: "switch",
        phase: record.kind !== "ok" ? "refused" : state.switchBeat + 1 >= SWITCH_PHASES ? "ok" : "start",
        role: record.role,
        capabilities: asProtocolCapabilities(record.to),
        diff: diffToWire(record.diff),
        ...(record.reason ? { reason: record.reason } : {}),
      };
      for (const player of state.players) {
        if (!player.connected) continue;
        const key = `switch:${player.peerId}`;
        if (sentRef.current.get(key) === encoded) continue;
        sentRef.current.set(key, encoded);
        client.sendTo(player.peerId, message);
      }
    }
    // The superseded peer id is already gone from `state.players` by the
    // time this runs -- `state.superseded` is its only remaining address.
    // Deduped on `seq` rather than the encoded message (which never
    // changes), the same reason `Notice` bumps its own: a second, unrelated
    // supersede landing on a DIFFERENT peer id still has to go out, and a
    // repeat send to the SAME peer id (a re-render with no new supersede)
    // must not.
    if (state.superseded) {
      const key = `superseded:${state.superseded.peerId}`;
      const encoded = `seq:${state.superseded.seq}`;
      if (sentRef.current.get(key) !== encoded) {
        sentRef.current.set(key, encoded);
        client.sendTo(state.superseded.peerId, { t: "superseded" });
      }
    }
  }, [state]);

  /* ---------------- the switch animation ---------------- */

  // Reduced motion, a repeat change, and any refusal all skip the timed
  // sequence and land straight on a screen that waits for "Continue" instead.
  const reducedMotion = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    [],
  );
  useEffect(() => {
    if (state.phase !== "switching" || !state.pendingSwitch) return;
    if (state.pendingSwitch.kind !== "ok") return;
    if (reducedMotion || state.pendingSwitch.repeat) return;
    const duration = PHASE_MS[state.switchBeat] ?? PHASE_MS[PHASE_MS.length - 1];
    const timer = setTimeout(() => dispatch({ k: "switch_beat" }), duration);
    return () => clearTimeout(timer);
  }, [state.phase, state.pendingSwitch, state.switchBeat, reducedMotion]);

  /* ---------------- seats come back, or they do not ---------------- */

  // A phone that drops keeps its role for `SEAT_GRACE_MS`. Re-arming a timer at
  // the earliest deadline is what turns that promise into the log line that
  // says the seat is free again -- the reducer is pure, so something has to
  // hand it the clock.
  useEffect(() => {
    const waiting = state.players.filter((player) => player.disconnectedAt !== null);
    if (waiting.length === 0) return;
    const earliest = Math.min(...waiting.map((player) => player.disconnectedAt ?? 0));
    const delay = Math.max(0, earliest + SEAT_GRACE_MS - Date.now());
    const timer = setTimeout(() => dispatch({ k: "sweep_seats", at: Date.now() }), delay + 25);
    return () => clearTimeout(timer);
  }, [state.players]);

  /* ---------------- notices fade ---------------- */

  useEffect(() => {
    if (!state.notice) return;
    const seq = state.notice.seq;
    const timer = setTimeout(() => dispatch({ k: "clear_notice", seq }), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state.notice]);

  /* ---------------- the tab names the mystery actually selected ---------------- */

  // The browser tab is the one surface that stays legible when the TV is not
  // the focused window, so it follows the room's own mystery: the neutral
  // product name until one is chosen, "Mystery — Everyone Is Essential" after.
  // `state.puzzle.id` is the same authoritative source the header's brand
  // reads.
  useEffect(() => {
    document.title = tabTitle(state.puzzle.id);
  }, [state.puzzle.id]);

  /* ---------------- focus ---------------- */

  const moveFocus = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      // A reclaim request is modal and renders on top of whatever the TV had
      // open locally -- collecting targets from the whole document would let
      // an arrow press walk focus off the overlay and onto a control it is
      // covering. Scoped to the overlay's
      // own subtree, `nextFocus` has nothing else to land on.
      const root = stateRef.current.pendingReclaim
        ? (document.querySelector<HTMLElement>('[data-testid="reclaim-approval"]') ?? document)
        : document;
      const targets = collectTargets(root);
      const next = nextFocus(targets, focusRef.current, direction);
      // `nextFocus` returns null only when there is nothing that way. Focus
      // stays where it is: the ring never disappears and never lands on a
      // control that is not on screen.
      setFocusId(next ?? focusRef.current ?? targets[0]?.id ?? null);
    },
    [setFocusId],
  );

  const activate = useCallback(
    (id: string | null) => {
      if (!id) return;
      if (id === "start-new-room") {
        // The one way on from a room this TV can no longer serve. A fresh page
        // and nothing less: the room code, the credential and the board this
        // family was playing all belong to the game that cannot be resumed.
        // Read before anything else, because the ring is on this control and a
        // request that arrived underneath it must not decide what a press means.
        window.location.reload();
        return;
      }
      // The answer this id names, if it is one of the overlay's two controls.
      // The id carries the request it decides, so what runs below is always
      // a decision about that exact request -- never about whatever happens to
      // be on screen when the reducer sees it.
      const decision = reclaimDecision(id);
      // The overlay is modal: while it is up, nothing it covers may run,
      // whatever the focus ring happens to be on (a stale id left over from
      // before the reclaim arrived, or one `moveFocus`'s own scoping missed).
      // Only the overlay's own two controls ever reach the reducer here.
      if (stateRef.current.pendingReclaim && decision === null) {
        return;
      }
      if (decision !== null) {
        dispatch(
          decision.control === RECLAIM_APPROVE
            ? { k: "approve_reclaim", requestId: decision.requestId }
            : { k: "decline_reclaim", requestId: decision.requestId },
        );
        return;
      }
      if (id === "stay") {
        setLeaveOpen(false);
        return;
      }
      if (id === "continue") {
        // Consumed here and nowhere else: the same input that dismisses the
        // rebuild moment must never also be read as a puzzle answer.
        dispatch({ k: "switch_dismiss" });
        return;
      }
      if (id === "players-help") {
        setPlayersHelpOpen(true);
        return;
      }
      if (id === "close-players-help") {
        setPlayersHelpOpen(false);
        return;
      }
      if (id === "clues-found") {
        setCluesFoundOpen(true);
        return;
      }
      if (id === "close-clues-found") {
        setCluesFoundOpen(false);
        return;
      }
      if (id === "how-we-checked") {
        setHowWeCheckedOpen(true);
        return;
      }
      if (id === "close-how-we-checked") {
        setHowWeCheckedOpen(false);
        return;
      }
      if (id === "leave") {
        // The only thing in this app that lets the game go: a second, deliberate
        // press on Leave. Back on its own never gets here.
        //
        // The Fire TV APK bridges its own Back key into a DOM keydown here (see
        // app/android's MainActivity) and expects the page, not the wrapper, to
        // decide when the app actually closes -- so a confirmed Leave calls back
        // into the wrapper via `window.Android.leave()` when it is present.
        // Outside the wrapper -- a browser tab with no such bridge -- Leave
        // walks back out of history.
        const bridge = (window as unknown as { Android?: { leave?: () => void } }).Android;
        if (bridge && typeof bridge.leave === "function") {
          bridge.leave();
        } else {
          window.history.back();
        }
        return;
      }
      if (id.startsWith("act:")) {
        dispatch({ k: "choose_action", peerId: TV_PEER, actionId: id.slice(4) });
        return;
      }
      if (id.startsWith("mystery:")) {
        // Idempotent in the reducer, which matters: a focused button gets both
        // this and a DOM click from the same Enter press, and the second
        // action must be a no-op rather than a rebuild.
        dispatch({ k: "choose_mystery", mysteryId: id.slice("mystery:".length) });
        return;
      }
      if (id.startsWith("opt:")) {
        dispatch({ k: "choose_option", peerId: TV_PEER, option: Number(id.slice(4)) });
      }
    },
    [setLeaveOpen],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const intent: KeyIntent | null = keyIntent(event.key, event.keyCode);
      if (!intent) return;
      event.preventDefault();
      const current = stateRef.current;
      switch (intent) {
        case "up":
        case "down":
        case "left":
        case "right":
          moveFocus(intent);
          break;
        case "select":
          activate(focusRef.current);
          break;
        case "back":
          // Back must never end the game by itself. On a Fire TV the WebView
          // treats an unhandled Back as "close me", so it is answered here
          // whatever is on screen:
          //   1. a reclaim request is up   -> Back declines it
          //   2. the leave question is up  -> Back means Stay
          //   3. a sheet is open           -> Back closes it
          //   4. a refusal is on screen    -> Back dismisses it, never approves
          //      a different change on its own
          //   5. a picker is open         -> Back closes it
          //   6. nothing to close         -> ask, and leave only on a confirm
          //
          // A reclaim request goes first, not last: it renders on top of
          // every other overlay here (`.overlay` is opaque, and its JSX comes
          // after Leave's and every sheet's), and it can arrive at any time
          // -- a phone's `join` or `reclaim_seat` reaches the reducer
          // whatever the TV happens to have open locally. Checking it last
          // would leave Back answering whatever was open underneath instead
          // of the approval actually on screen.
          if (current.pendingReclaim) {
            // Declining is the safe, reversible side -- the requester can
            // always ask again -- so that is what an unhandled Back means
            // here, same as it always has. It names the request on screen, so
            // a queue that moved in the meantime is not answered by mistake.
            dispatch({ k: "decline_reclaim", requestId: current.pendingReclaim.id });
            break;
          }
          if (leaveRef.current) {
            setLeaveOpen(false);
            break;
          }
          if (sheetOpenRef.current) {
            setPlayersHelpOpen(false);
            setCluesFoundOpen(false);
            setHowWeCheckedOpen(false);
            break;
          }
          if (current.pendingSwitch && current.pendingSwitch.kind !== "ok") {
            dispatch({ k: "switch_dismiss" });
            break;
          }
          if (current.pending[TV_PEER]) {
            dispatch({ k: "cancel_choice", peerId: TV_PEER });
            break;
          }
          setLeaveOpen(true);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveFocus, activate, setLeaveOpen]);

  // Keep the ring on something that exists: after the board changes, a stale id
  // would leave nothing highlighted at all. A pending reclaim goes first, not
  // last, for the same reason Back checks it first above: it can arrive and
  // render on top of the leave question or a sheet, whatever the TV had open
  // locally, and the ring has to be on the overlay actually on screen. It
  // defaults to the safe side -- Not now.
  useEffect(() => {
    const targets = collectTargets();
    // The end of the road takes precedence over everything under it: the board
    // is covered, so the ring belongs on the one control that is left.
    if (roomGone) {
      setFocusId(targets.some((target) => target.id === "start-new-room") ? "start-new-room" : null);
      return;
    }
    if (state.pendingReclaim) {
      // Scoped to the request on screen: its controls are the only ones whose
      // ids name it, so a ring left on the request this one replaced lands on
      // nothing and falls back to the safe answer.
      setFocusId(
        reclaimFocusTarget(
          targets.map((target) => target.id),
          focusRef.current,
          state.pendingReclaim.id,
        ),
      );
      return;
    }
    // The leave question is modal too, and it opens on Stay.
    if (leaveOpen) {
      const inside =
        focusRef.current === "stay" || focusRef.current === "leave"
          ? targets.some((target) => target.id === focusRef.current)
          : false;
      if (!inside) setFocusId(targets.some((target) => target.id === "stay") ? "stay" : null);
      return;
    }
    if (targets.length === 0) {
      if (focusRef.current !== null) setFocusId(null);
      return;
    }
    if (focusRef.current === null || !targets.some((target) => target.id === focusRef.current)) {
      setFocusId(targets[0]?.id ?? null);
    }
  }, [state, leaveOpen, playersHelpOpen, cluesFoundOpen, howWeCheckedOpen, roomGone, setFocusId]);

  useEffect(() => {
    if (!focusId) return;
    // Looked up by comparing ids, never by building a selector out of one --
    // a reclaim control's id carries the seat token its request is about.
    findFocusTarget(focusId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusId]);

  /* ---------------- screen ---------------- */

  // The request the overlay is showing, if any. Its `id` is what the two
  // controls below carry and what a press hands back to the reducer.
  const reclaim = state.pendingReclaim;

  // The board's certificate is the live one -- what is still needed from
  // here. The ending's is the run's claim: at the goal nobody is needed any
  // more, which is the one thing that must not be read as a failed proof.
  const currentBadge: Badge | null =
    state.phase === "ending" ? finalBadge(state) : state.certificate ? badge(state.certificate) : null;
  // Whether this TV is in the room right now, read once from the socket's own
  // state. Every claim below that says something about the room as it stands
  // is gated on it: a tick for a seat is a claim about a room the TV can see,
  // and a TV that is not in the room cannot see one.
  const relayLive = relayIsOpen(connection);
  // The lobby shows this proof before anyone has joined at
  // all, so unlike every other badge in this file, "X essential" here must
  // also say whether X is actually here -- a live gate, not just the
  // puzzle's own design (`badgeFromCertificate`'s new `isRoleConnected`).
  // The gate has two halves, and the connection is the first: the reducer's
  // per-seat connectivity is frozen at whatever it last heard, so with this
  // TV's own socket down it can still call a seat present and green a line
  // over a room nothing is being heard from. Not in the room, no certificate
  // -- `BadgeRow` says so in its own words rather than naming a reason it
  // cannot know.
  const startBadge: Badge | null =
    state.startCertificate && relayLive
      ? badge(state.startCertificate, (role) => isConnected(state, role))
      : null;
  // Labels for whoever "How we checked" must say it is waiting for, rather
  // than let the sheet claim the room can finish together while a seat the
  // certificate counts on is held.
  const waitingForLabels = heldRolesIn(state).map((role) => ROLE_LABEL[role] ?? role);
  const vacantForLabels = vacantRolesIn(state).map((role) => ROLE_LABEL[role] ?? role);
  const phoneAddress = state.room
    ? phoneUrl(
        phoneBaseOverride ?? new URL("/phone/", window.location.href).toString(),
        state.room,
        relayUrl,
      )
    : "";

  const lastLog = state.log[state.log.length - 1] ?? null;
  // The lobby has no dedicated notice box, so its own `latest-event` line
  // still falls back to the active notice. The playing footer does have one
  // (`.notice`, below) and must not print the same sentence a second time
  // right above it -- see `footerLatestLine`.
  const latestLine = state.notice ? state.notice.text : lastLog?.text ?? "";
  const footerLatestLine = lastLog?.text ?? "";
  // A sheet covers the whole screen (`.overlay` is opaque), but the board
  // underneath stays in the DOM -- so its focus targets are hidden here too,
  // rather than left for the ring to stray onto through an opaque sheet.
  const sheetOpen = playersHelpOpen || cluesFoundOpen || howWeCheckedOpen;

  return (
    <div
      class="tv"
      data-phase={state.phase}
      data-room={state.room}
      data-focus={focusId ?? ""}
      data-history={state.play.history.length}
      data-switches={state.switches.length}
      data-testid="tv"
    >
      {/*
        The painted room, full-bleed and fixed behind everything (`plate.css`).
        One call for every phase: at "lobby" `state.play` is still empty, so
        this is the mystery's own opening plate; at "ending" the surface flips
        to the ending crop once the goal is actually met. Nothing else in this
        file positions it -- `.rail-shell` below leaves it uncovered on the
        left, which is the whole point.
      */}
      <Scene
        puzzleId={state.puzzle.id}
        flags={state.play.flags}
        tokens={state.play.tokens}
        surface={state.phase === "ending" ? "ending" : "play"}
      />

      {/*
        `<main>` comes before `<header>` in source order, on purpose: focus
        targets are picked up in DOM order (`collectTargets`), and a header
        utility button must never be where the ring defaults to when the
        board itself has something to act on.
      */}
      {state.phase !== "lobby" && state.phase !== "ending" ? (
        <div class="rail-shell playing" data-testid="play-rail">
          <main class="stage">
            <section class="right">
              <HeldSeats state={state} />
              <ActionBoard
                state={state}
                focusId={sheetOpen ? null : focusId}
                disabled={sheetOpen}
                onPick={(id) => {
                  if (id.startsWith("opt:")) activate(id);
                  else dispatch({ k: "choose_action", peerId: TV_PEER, actionId: id });
                }}
              />
              {state.phase === "playing" && !sheetOpen ? (
                <div class="rail-utility">
                  <button
                    class="mini how-we-checked-open"
                    data-focus-id="how-we-checked"
                    data-testid="open-how-we-checked"
                    data-focused={String(focusId === "how-we-checked")}
                    onClick={() => setHowWeCheckedOpen(true)}
                  >
                    How we checked
                  </button>
                  <button
                    class="mini clues-found-open"
                    data-focus-id="clues-found"
                    data-testid="open-clues-found"
                    data-focused={String(focusId === "clues-found")}
                    onClick={() => setCluesFoundOpen(true)}
                  >
                    Clues found
                  </button>
                </div>
              ) : null}
            </section>
          </main>

          <header class="topbar">
            <span class="brand">{mysteryById(state.puzzle.id)?.title ?? state.puzzle.id}</span>
            {state.phase === "playing" && !sheetOpen ? (
              <button
                class="mini players-help-open"
                data-focus-id="players-help"
                data-testid="open-players-help"
                data-focused={String(focusId === "players-help")}
                onClick={() => setPlayersHelpOpen(true)}
              >
                Players &amp; help
              </button>
            ) : null}
          </header>

          <footer class="footer">
            <div class="latest-event" data-testid="latest-event">
              {footerLatestLine}
            </div>
            {state.notice ? (
              <div class="notice" data-testid="notice">
                {state.notice.text}
              </div>
            ) : (
              <div class="footer-hint" data-testid="footer-hint">
                {footerHint(state, leaveOpen)}
              </div>
            )}
          </footer>
        </div>
      ) : null}

      {state.phase === "lobby" ? (
        <Lobby
          state={state}
          phoneAddress={phoneAddress}
          badge={startBadge}
          status={connection.notice ?? connection.status}
          networkNotice={networkNotice}
          focusId={focusId}
          latestLine={latestLine}
          showGenerated={showGenerated}
          onChooseMystery={(mysteryId) => dispatch({ k: "choose_mystery", mysteryId })}
        />
      ) : null}
      {state.phase === "switching" && state.pendingSwitch ? (
        state.pendingSwitch.kind === "ok" ? (
          <RebuildMoment
            record={state.pendingSwitch}
            beat={state.switchBeat}
            focusId={focusId}
            onContinue={() => dispatch({ k: "switch_dismiss" })}
            waitingFor={waitingForLabels}
            vacantFor={vacantForLabels}
            relayOpen={relayLive}
          />
        ) : (
          <SwitchRefusal
            record={state.pendingSwitch}
            focusId={focusId}
            onDismiss={() => dispatch({ k: "switch_dismiss" })}
          />
        )
      ) : null}
      {state.phase === "ending" ? (
        <Ending
          state={state}
          badge={currentBadge}
          certificate={finalCertificate(state)}
          onReplay={() => window.location.reload()}
          waitingFor={waitingForLabels}
          vacantFor={vacantForLabels}
          relayOpen={relayLive}
        />
      ) : null}
      {playersHelpOpen ? (
        <PlayersHelp state={state} focusId={focusId} onClose={() => setPlayersHelpOpen(false)} />
      ) : null}
      {cluesFoundOpen ? (
        <CluesFound state={state} focusId={focusId} onClose={() => setCluesFoundOpen(false)} />
      ) : null}
      {howWeCheckedOpen ? (
        <div class="overlay how-we-checked-sheet" data-testid="how-we-checked-sheet">
          <div class="how-we-checked-panel">
            <HowWeChecked
              certificate={state.certificate}
              contextLine={
                state.switches.some((s) => s.kind === "ok")
                  ? "Checked as the game stands right now."
                  : "At the start, the puzzle needed every role."
              }
              waitingFor={waitingForLabels}
              vacantFor={vacantForLabels}
              relayOpen={relayLive}
            />
            <button
              class="mini"
              data-focus-id="close-how-we-checked"
              data-testid="close-how-we-checked"
              data-focused={String(focusId === "close-how-we-checked")}
              onClick={() => setHowWeCheckedOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
      {roomGone ? (
        <RoomGone focusId={focusId} onStartNewRoom={() => activate("start-new-room")} />
      ) : null}
      {leaveOpen ? (
        <LeavePrompt
          focusId={focusId}
          onStay={() => setLeaveOpen(false)}
          onLeave={() => activate("leave")}
        />
      ) : null}
      {reclaim ? (
        <ReclaimApproval
          request={reclaim}
          // Whether the seat being asked for is one somebody is playing right
          // now, rather than one held for a player who dropped. Read off the
          // room's own state, never off the request: the seat can go live or
          // drop while the question is on screen.
          live={state.players.some((p) => p.connected && p.role === reclaim.role)}
          focusId={focusId}
          onApprove={() => activate(reclaimControlId(RECLAIM_APPROVE, reclaim.id))}
          onDecline={() => activate(reclaimControlId(RECLAIM_DECLINE, reclaim.id))}
        />
      ) : null}
    </div>
  );
}
