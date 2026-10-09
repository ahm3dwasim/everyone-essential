/**
 * The TV screen: lobby, the study, the rebuild moment, the ending.
 *
 * Presentation only -- every number and every tick here comes from state the
 * reducer derived, or from a real `certify`/`recompile` result carried on the
 * state. Nothing in this file decides anything about the game, and nothing
 * here re-parses a rendered sentence back into data: option counts, ownership
 * and check counts all come from the validator's own structured fields (see
 * `game/moment.ts` and `game/certificate-presenter.ts`).
 */
import type { ComponentChildren } from "preact";
import type { Credit, GameState, LogLine, PendingReclaim, SwitchRecord } from "./game/reducer.ts";
import {
  availableActions,
  endingCredits,
  heldRolesIn,
  historyLines,
  isConnected,
  phoneMode,
  sharedFacts,
  vacantRolesIn,
} from "./game/reducer.ts";
import type { Badge } from "./game/badge.ts";
import { CAPABILITY_LABEL, ROLE_LABEL, endingTitle, optionLabels, refusalCopy, roleBlurb } from "./game/presentation.ts";
import { MYSTERIES, mysteryById, seatRoles } from "./game/mysteries.ts";
import { RECLAIM_APPROVE, RECLAIM_DECLINE, reclaimControlId } from "./remote.ts";
import type { RoleId as WireRoleId } from "../../shared/protocol.ts";
import { QrView } from "./qr-view.tsx";
import { PlateView } from "./art/plate.tsx";
import { plateFor } from "./art/plates.ts";
import type { Certificate } from "./game/validator.ts";
import {
  RECONNECTING_LINE,
  checkedHeadline,
  claimHoldsLive,
  endingClaimLine,
  neededRoleCount,
  neededRolesPhrase,
  presentCertificate,
  roleEvidence,
  roleLabel,
  solvableEvidence,
  solvableLabel,
  stillNeedsLine,
  waitingOrVacantLine,
} from "./game/certificate-presenter.ts";
import {
  buildRebuildMoment,
  rebuildHeadline,
  shortCapabilityPhrase,
  type RebuildMoment as RebuildMomentData,
} from "./game/moment.ts";

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function badgeLineTestId(label: string): string {
  return `badge-line-${slug(label)}`;
}

/**
 * The live badge, reduced to ✓/✗ lines. Used only for the phone wire payload
 * and a "technical details" panel -- ordinary play shows "How we checked"
 * instead.
 */
export function BadgeRow({
  badge: value,
  testId = "badge",
  showHash = false,
}: {
  badge: Badge | null;
  testId?: string;
  showHash?: boolean;
}) {
  if (!value) {
    return (
      <div class="badge" data-testid={testId} data-ok="false">
        <span class="badge-line">
          <span class="tick">?</span>
          <span class="label">no certificate yet</span>
        </span>
      </div>
    );
  }
  return (
    <div class="badge" data-testid={testId} data-ok={String(value.ok)} data-hash={value.hash}>
      {value.lines.map((line) => (
        <span
          class="badge-line"
          data-testid={badgeLineTestId(line.label)}
          data-ok={String(line.ok)}
          title={line.detail}
        >
          <span class="tick">{line.ok ? "✓" : "✗"}</span>
          <span class="label">{line.label}</span>
        </span>
      ))}
      {showHash && value.hash ? (
        <span class="check-reference" data-testid="check-reference">
          Check reference: {value.hash}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* How we checked                                                      */
/* ------------------------------------------------------------------ */

/**
 * The certificate, worded for a player: "How we checked". Every line comes
 * from `presentCertificate`, which reads `proven` before `ok`/`necessary` --
 * a capped search reads "Not fully checked", never a false negative (design
 * direction, section 3).
 */
export function HowWeChecked({
  certificate,
  contextLine,
  waitingFor = [],
  vacantFor = [],
  relayOpen,
  testId = "how-we-checked",
}: {
  certificate: Certificate | null;
  contextLine: string;
  /** Labels of any role the certificate counts on that is currently held. */
  waitingFor?: readonly string[];
  /** Labels of any role the certificate counts on that nobody occupies at all. */
  vacantFor?: readonly string[];
  /**
   * Whether the TV's own connection to the room is up right now. Every line
   * below is a statement about what the room can do at this moment, and the
   * only thing that knows the room's current state is the socket. With it
   * down, the state on screen is the last thing that arrived, so the claim
   * is not made at all.
   *
   * Required, and deliberately so. `waitingFor` and `vacantFor` default to
   * empty because "nothing is known to be absent" is the truth for a caller
   * with no room to look at; there is no such truth for the connection. A
   * default of `true` is a claim made on behalf of a socket nobody asked, and
   * the an earlier version rebuild screen made exactly that claim for a whole round --
   * it rendered this component without a `relayOpen` and went on saying the
   * room could finish together while the TV's own socket was down. A caller
   * that has no connection of its own is a caller that knows which one it is
   * saying, so it says.
   */
  relayOpen: boolean;
  testId?: string;
}) {
  if (!certificate) {
    return (
      <div class="how-we-checked" data-testid={testId}>
        <p class="checked-headline">No certificate yet.</p>
      </div>
    );
  }
  const view = presentCertificate(certificate);
  const claimHolds = claimHoldsLive(view.ok, waitingFor, vacantFor, relayOpen);
  return (
    <div class="how-we-checked" data-testid={testId} data-ok={String(claimHolds)}>
      <p class="checked-headline" data-testid={`${testId}-headline`}>
        {relayOpen ? checkedHeadline(view, waitingFor, vacantFor) : RECONNECTING_LINE}
      </p>
      <p class="checked-context">{contextLine}</p>
      {claimHolds ? <p class="checked-still-needs">{stillNeedsLine(view)}</p> : null}
      <div class="checked-line" data-testid={`${testId}-solvable`} data-state={view.solvable.state}>
        <span class="checked-label">{solvableLabel(view.solvable.state)}</span>
        <span class="checked-evidence">{solvableEvidence(view.solvable.statesExplored)}</span>
      </div>
      {view.roles.map((line) => (
        <div
          class="checked-line"
          data-testid={`${testId}-role-${line.role.toLowerCase()}`}
          data-state={line.state}
        >
          <span class="checked-label">{roleLabel(line)}</span>
          <span class="checked-evidence">
            {line.state === "yes" ? roleEvidence(line.statesExplored) : line.evidence}
          </span>
        </div>
      ))}
      {view.caveats.length > 0 ? (
        <p class="checked-caveats" data-testid={`${testId}-caveats`}>
          {view.caveats.join(" ")}
        </p>
      ) : null}
      <p class="checked-explain">
        We checked the puzzle from the moment your controls changed, then checked it with each role
        removed in turn.
      </p>
      <p class="checked-explain-more">These checks use the puzzle's rules and the controls you selected.</p>
      <p class="check-reference" data-testid={`${testId}-reference`}>
        Check reference: {view.hash || "—"}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scenes -- one per mystery, mystery-specific                         */
/* ------------------------------------------------------------------ */

function StudyScene({ flags }: { flags: readonly string[] }) {
  const has = (flag: string) => flags.includes(flag);
  return (
    <svg class="scene" viewBox="0 0 480 300" role="img" aria-label="the locked study">
      <rect x="0" y="0" width="480" height="300" fill="#141C28" />
      <rect x="0" y="228" width="480" height="72" fill="#1B2534" />
      <rect x="0" y="222" width="480" height="6" fill="#2a3242" />
      <circle cx="238" cy="70" r="30" fill="#F2CF7A" opacity="0.16" />
      <rect x="232" y="24" width="12" height="26" rx="6" fill="#2f3a4d" />
      <rect x="212" y="48" width="52" height="10" rx="5" fill="#F2CF7A" opacity="0.8" />
      <g transform={has("painting_moved") ? "rotate(-16 120 120)" : ""}>
        <rect x="78" y="80" width="84" height="96" rx="4" fill="#3a2f2a" />
        <rect x="86" y="88" width="68" height="80" fill="#5b4a3a" />
        <circle cx="120" cy="118" r="16" fill="#c9a227" opacity="0.75" />
        <path d="M86 152 L120 124 L154 152 Z" fill="#2f4f43" opacity="0.9" />
      </g>
      {has("painting_moved") ? (
        <rect x="76" y="176" width="88" height="34" fill="#233042" stroke="#3d4c63" />
      ) : null}
      {/* the safe: the mystery's one useful object, kept large */}
      <rect x="176" y="96" width="132" height="132" rx="4" fill="#202D3D" stroke="#8294AD" stroke-width="3" />
      {has("safe_open") ? (
        <rect x="176" y="96" width="58" height="132" fill="#12161d" stroke="#8294AD" stroke-width="3" />
      ) : (
        <circle cx="242" cy="162" r="30" fill="#2b3341" stroke="#8294AD" stroke-width="3" />
      )}
      {has("tumblers_heard") ? (
        <circle cx="242" cy="162" r="40" fill="none" stroke="#92D5BE" stroke-dasharray="4 6" />
      ) : null}
      <rect
        x="336"
        y="66"
        width="104"
        height="162"
        rx="3"
        fill={has("study_unlocked") ? "#F2CF7A" : "#2a2f3a"}
        stroke="#4a5568"
      />
      {has("study_unlocked") ? (
        <rect x="336" y="66" width="104" height="162" fill="#F2CF7A" opacity="0.35" />
      ) : (
        <circle cx="424" cy="150" r="7" fill="#6b7890" />
      )}
      <rect x="30" y="196" width="120" height="12" rx="3" fill="#3b3026" />
      <rect x="38" y="208" width="104" height="46" fill="#31281f" />
      <rect x="52" y="220" width="76" height="10" rx="3" fill="#4a3c2e" />
    </svg>
  );
}

function BakeryScene({ flags }: { flags: readonly string[] }) {
  const has = (flag: string) => flags.includes(flag);
  return (
    <svg class="scene" viewBox="0 0 480 300" role="img" aria-label="the midnight bakery">
      <rect x="0" y="0" width="480" height="300" fill="#141C28" />
      <rect x="0" y="228" width="480" height="72" fill="#1B2534" />
      <rect x="0" y="222" width="480" height="6" fill="#2a3242" />
      {/* the oven: the mystery's one useful object, kept large */}
      <rect x="176" y="86" width="140" height="142" rx="6" fill="#202D3D" stroke="#8294AD" stroke-width="3" />
      <circle
        cx="246"
        cy="164"
        r="46"
        fill={has("loaf_in") ? "#3a2f2a" : "#12161d"}
        stroke="#8294AD"
        stroke-width="3"
      />
      {has("loaf_in") ? <ellipse cx="246" cy="168" rx="26" ry="16" fill="#c9a227" opacity="0.8" /> : null}
      {has("oven_set") ? (
        <circle cx="300" cy="100" r="10" fill="#F2CF7A" opacity="0.9" />
      ) : (
        <circle cx="300" cy="100" r="10" fill="none" stroke="#8294AD" stroke-width="2" />
      )}
      {has("bake_timed") ? (
        <circle cx="246" cy="164" r="58" fill="none" stroke="#92D5BE" stroke-dasharray="4 6" />
      ) : null}
      {has("bakery_ready") ? (
        <rect x="196" y="70" width="100" height="14" rx="4" fill="#F2CF7A" opacity="0.8" />
      ) : null}
      <rect x="30" y="196" width="120" height="12" rx="3" fill="#3b3026" />
      <rect x="38" y="208" width="104" height="46" fill="#31281f" />
    </svg>
  );
}

function TreehouseScene({ flags }: { flags: readonly string[] }) {
  const has = (flag: string) => flags.includes(flag);
  return (
    <svg class="scene" viewBox="0 0 480 300" role="img" aria-label="the treehouse">
      <rect x="0" y="0" width="480" height="300" fill="#141C28" />
      <rect x="0" y="228" width="480" height="72" fill="#1B2534" />
      <rect x="0" y="222" width="480" height="6" fill="#2a3242" />
      {/* the trunk */}
      <rect x="60" y="30" width="40" height="270" fill="#3b3026" />
      {/* the platform: the mystery's one useful object, kept large */}
      <rect
        x="150"
        y={has("platform_up") ? "90" : "196"}
        width="220"
        height="24"
        rx="4"
        fill="#202D3D"
        stroke="#8294AD"
        stroke-width="3"
      />
      {has("rope_rigged") ? (
        <line x1="100" y1="60" x2="150" y2={has("platform_up") ? "100" : "206"} stroke="#92D5BE" stroke-width="4" />
      ) : (
        <line x1="100" y1="60" x2="150" y2="206" stroke="#8294AD" stroke-width="2" stroke-dasharray="4 6" />
      )}
      {has("platform_up") ? (
        <rect x="150" y="90" width="220" height="6" fill="#F2CF7A" opacity="0.6" />
      ) : null}
      <rect x="330" y="196" width="60" height="16" rx="3" fill="#3b3026" />
    </svg>
  );
}

/**
 * The room, as the team has actually made it.
 *
 * A painted plate when the mystery has one, and the flat SVG only as the
 * fallback for the mystery it was drawn for. An unrecognised mystery shows
 * nothing rather than another puzzle's room: falling back to the study
 * would show a generated mystery the locked study's painting, safe and all,
 * while its own log talked about something else -- no picture is honest,
 * the wrong picture is not.
 */
export function Scene({
  puzzleId,
  flags,
  tokens = [],
  surface = "play",
}: {
  puzzleId: string;
  flags: readonly string[];
  tokens?: readonly string[];
  surface?: "play" | "ending";
}) {
  const plate = plateFor(puzzleId, { flags, tokens }, surface);
  if (plate) return <PlateView mysteryId={puzzleId} plate={plate} />;
  if (puzzleId === "the-locked-study") return <StudyScene flags={flags} />;
  if (puzzleId === "the-midnight-bakery") return <BakeryScene flags={flags} />;
  if (puzzleId === "the-treehouse") return <TreehouseScene flags={flags} />;
  return null;
}

/* ------------------------------------------------------------------ */
/* Lobby                                                               */
/* ------------------------------------------------------------------ */

function RoleSlot({ state, role }: { state: GameState; role: WireRoleId }) {
  const player = state.players.find((p) => p.role === role);
  const capabilities = state.puzzle.roles.find((r) => r.id === role)?.capabilities ?? [];
  return (
    <div class="slot" data-testid={`role-slot-${role}`} data-joined={String(Boolean(player))}>
      <div class="slot-role">{ROLE_LABEL[role] ?? role}</div>
      <div class="slot-who">{player ? player.name || "joined" : "waiting…"}</div>
      <div class="slot-mode">
        {capabilities.map((capability) => CAPABILITY_LABEL[capability] ?? capability).join(" + ")}
      </div>
      <div class="slot-blurb">{roleBlurb(state.puzzle.id, role)}</div>
    </div>
  );
}

/**
 * A dropped teammate's seat, on screen for as long as it is actually held --
 * not just the one footer line the very next event overwrites, so a player
 * who looks away for a few seconds after a drop still has a way to know.
 * Sourced straight from `state.players`, so it disappears the moment the
 * seat is back or the grace period frees it, and never says more than the
 * reducer actually knows.
 */
export function HeldSeats({ state }: { state: GameState }) {
  const held = state.players.filter((p) => !p.connected && p.role !== null);
  if (held.length === 0) return null;
  return (
    <div class="held-seats" data-testid="held-seats">
      {held.map((player) => (
        <div class="held-seat" data-testid={`held-seat-${player.role}`}>
          <span class="held-seat-role">{player.role}</span>
          <span class="held-seat-text">
            {player.name || player.role} dropped — their seat is held. Reopen the join link in the
            same browser, then approve it here.
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Which mystery the room will play.
 *
 * A picker rather than a setting: it is the first thing on the lobby screen, it
 * is what makes "one hand-written puzzle" stop being the ceiling, and it costs
 * a team nothing -- the room code and the QR flow below it are unchanged, and
 * the choice is locked the moment the room starts.
 *
 * Each option is a real button with a `data-focus-id`, so the remote's D-pad
 * reaches it through the same `nextFocus` geometry as every other control and
 * the ring is the same 8px outline. It is deliberately not a listbox: on a Fire
 * TV remote, "press centre on the thing the ring is on" is the whole
 * interaction vocabulary, and a listbox would add a mode.
 */
function MysteryPicker({
  state,
  focusId,
  showGenerated = false,
  onChoose,
}: {
  state: GameState;
  focusId: string | null;
  /** `?generated=1` only -- the generated mystery has no painted plates yet
   *, so the picker a family actually
   *  sees offers only the painted mysteries. The generator still runs and its
   *  own tests still cover it; this hides one entry point, not the feature. */
  showGenerated?: boolean;
  onChoose: (mysteryId: string) => void;
}) {
  const offered = MYSTERIES.filter((mystery) => !mystery.generated || showGenerated);
  return (
    <div class="mysteries" data-testid="mystery-picker">
      <div class="mysteries-label">Tonight's mystery</div>
      <div class="mystery-options">
        {offered.map((mystery) => {
          const current = mystery.id === state.puzzle.id;
          return (
            <button
              class="mystery-option"
              data-testid={`mystery-${mystery.id}`}
              data-focus-id={`mystery:${mystery.id}`}
              data-focused={String(focusId === `mystery:${mystery.id}`)}
              data-current={String(current)}
              aria-pressed={current}
              onClick={() => {
                if (!current) onChoose(mystery.id);
              }}
            >
              <span class="mystery-name">{mystery.title}</span>
              {mystery.generated ? (
                <span class="mystery-generated" data-testid={`mystery-generated-${mystery.id}`}>
                  generated
                </span>
              ) : null}
              <span class="mystery-size">
                {mystery.roles.length} player{mystery.roles.length === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Lobby({
  state,
  phoneAddress,
  badge: startBadge,
  status,
  networkNotice,
  focusId,
  latestLine = "",
  showGenerated = false,
  onChooseMystery,
}: {
  state: GameState;
  phoneAddress: string;
  badge: Badge | null;
  status: string;
  /** Set when the host (the Fire TV wrapper) found no usable LAN address: a QR
   *  code would just be a dead end, so this replaces it with a plain message. */
  networkNotice?: string | null;
  focusId: string | null;
  /** The same latest-event line ordinary play shows -- seating and reconnect
   *  events happen here too (a phone held, then freed, before the room ever
   *  reaches "playing"), so this must not go dark just because the lobby's
   *  own rail replaces the base chrome while its phase is on screen. */
  latestLine?: string;
  /** `?generated=1` -- see `MysteryPicker`. */
  showGenerated?: boolean;
  onChooseMystery: (mysteryId: string) => void;
}) {
  const mystery = mysteryById(state.puzzle.id);
  const title = mystery?.title ?? state.puzzle.id;
  const subtitle = mystery?.subtitle ?? "";
  const seats = seatRoles(state.puzzle);
  return (
    <div class="rail-shell lobby" data-testid="lobby">
      <h1 class="title">{title}</h1>
      <p class="subtitle">{subtitle}</p>
      <MysteryPicker state={state} focusId={focusId} showGenerated={showGenerated} onChoose={onChooseMystery} />
      <div class="room">
        <div class="room-label">Room code</div>
        <div class="room-code" data-testid="room-code">
          {state.room || "····"}
        </div>
      </div>
      <div class="slots">
        {seats.map((role) => (
          <RoleSlot state={state} role={role} />
        ))}
      </div>
      <p class="change-role-hint" data-testid="change-role-hint">
        Seated on the wrong role? Change it any time from your own phone.
      </p>
      <div class="latest-event" data-testid="latest-event">
        {latestLine}
      </div>
      <div class="join-block">
        <h2 class="join-heading">Scan to join</h2>
        <p class="join-sub">
          {seats.length} player{seats.length === 1 ? "" : "s"}. One phone each.
        </p>
        <div class="qr-frame" data-testid="qr">
          {networkNotice ? (
            <div class="qr-unavailable" data-testid="qr-unavailable">
              {networkNotice}
            </div>
          ) : phoneAddress ? (
            <QrView text={phoneAddress} size={220} />
          ) : (
            <div class="qr" />
          )}
        </div>
        <div class="phone-address" data-testid="phone-url">
          {networkNotice ?? (phoneAddress || "starting the relay…")}
        </div>
        <p class="hint">Same Wi-Fi as this TV. Scan, or open that address and type the room code.</p>
        {/* the hash is removed from this player-facing row; it stays reachable
            under technical details (see `BadgeRow`'s `showHash`) */}
        <BadgeRow badge={startBadge} testId="lobby-badge" />
        <div class="status" data-testid="relay-status">
          relay: {status}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The rebuild moment -- "One button. Still your move."                */
/* ------------------------------------------------------------------ */

/** "1 step · 9 choices" / "2 steps · 3 choices each" */
function shapeLine(prefix: string, steps: number, options: number, each: boolean): string {
  const stepWord = steps === 1 ? "1 step" : `${steps} steps`;
  const optionWord = options === 1 ? "1 choice" : `${options} choices`;
  return `${prefix}: ${stepWord} · ${optionWord}${each && steps > 1 ? " each" : ""}.`;
}

function RebuildBeat0({ moment, record }: { moment: RebuildMomentData; record: SwitchRecord }) {
  return (
    <div class="rebuild-beat" data-testid="rebuild-beat" data-beat="0">
      <div class="rebuild-marker" data-testid="rebuild-marker">
        {moment.role}
      </div>
      <h2 class="rebuild-headline" data-testid="rebuild-headline">
        {moment.role} now plays with {shortCapabilityPhrase(moment.toCapabilityLabel)}.
      </h2>
      {moment.primary ? (
        <>
          <div class="rebuild-task-title">{moment.primary.before.label}</div>
          <div class="rebuild-old-shape" data-testid="rebuild-before">
            {Array.from({ length: Math.min(moment.primary.before.optionsPerStep, 9) }).map(() => (
              <span class="rebuild-cell" />
            ))}
          </div>
          <p class="rebuild-shape-line">
            {shapeLine("Before", moment.primary.before.steps, moment.primary.before.optionsPerStep, false)}
          </p>
        </>
      ) : (
        <p class="rebuild-shape-line">Nothing changed shape.</p>
      )}
    </div>
  );
}

function RebuildBeat1({ moment }: { moment: RebuildMomentData }) {
  return (
    <div class="rebuild-beat" data-testid="rebuild-beat" data-beat="1">
      {moment.primary ? (
        <>
          <div class="rebuild-task-title">{moment.primary.before.label}</div>
          <div class="rebuild-compare" data-testid="rebuild-compare">
            <div class="rebuild-old-shape faded">
              {Array.from({ length: Math.min(moment.primary.before.optionsPerStep, 9) }).map(() => (
                <span class="rebuild-cell" />
              ))}
            </div>
            <div class="rebuild-new-stacks" data-testid="rebuild-after">
              {Array.from({ length: moment.primary.after.steps }).map((_, stepIndex) => (
                <div class="rebuild-stack" data-testid={`rebuild-after-step-${stepIndex}`}>
                  {Array.from({ length: Math.min(moment.primary!.after.optionsPerStep, 4) }).map(() => (
                    <span class="rebuild-cell small" />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <p class="rebuild-shape-line">
            {shapeLine("Now", moment.primary.after.steps, moment.primary.after.optionsPerStep, true)}
          </p>
        </>
      ) : null}
      {moment.secondary.map((line) => (
        <p class="rebuild-secondary">{line}</p>
      ))}
    </div>
  );
}

function RebuildBeat2({
  moment,
  record,
  waitingFor,
  vacantFor,
  relayOpen,
}: {
  moment: RebuildMomentData;
  record: SwitchRecord;
  waitingFor: readonly string[];
  vacantFor: readonly string[];
  relayOpen: boolean;
}) {
  return (
    <div class="rebuild-beat" data-testid="rebuild-beat" data-beat="2">
      <h2 class="rebuild-payoff" data-testid="rebuild-payoff">
        {rebuildHeadline(moment)}
      </h2>
      {record.certificate ? (
        <HowWeChecked
          certificate={record.certificate}
          contextLine={`Checked after ${moment.role} changed to ${shortCapabilityPhrase(moment.toCapabilityLabel)}.`}
          testId="rebuild-checked"
          waitingFor={waitingFor}
          vacantFor={vacantFor}
          relayOpen={relayOpen}
        />
      ) : null}
    </div>
  );
}

/**
 * The waiting/vacant sentence, on every beat that does not already carry it.
 *
 * Beat 2 alone carries it directly, inside `HowWeChecked`'s own headline,
 * from `checkedHeadline` (the same `waitingOrVacantLine` string); the other
 * three get it here, so the sentence is on every beat and never printed
 * twice on one.
 */
function RebuildWaitingLine({
  waitingFor,
  vacantFor,
  relayOpen,
}: {
  waitingFor: readonly string[];
  vacantFor: readonly string[];
  relayOpen: boolean;
}) {
  // Said before the waiting/vacant line, because it is the stronger fact: a
  // TV that is away has not been told about a seat that went absent, so the
  // absence list on screen is the last one that arrived, and naming it would
  // be reporting a room this TV cannot currently see. What it does know is
  // that it is not connected, and that is the one thing it may say.
  if (!relayOpen) {
    return (
      <p class="rebuild-waiting" data-testid="rebuild-waiting">
        {RECONNECTING_LINE}
      </p>
    );
  }
  if (waitingFor.length === 0 && vacantFor.length === 0) return null;
  return (
    <p class="rebuild-waiting" data-testid="rebuild-waiting">
      {waitingOrVacantLine(waitingFor, vacantFor)}
    </p>
  );
}

function RebuildBeat3({
  record,
  waitingFor,
  vacantFor,
  relayOpen,
}: {
  record: SwitchRecord;
  waitingFor: readonly string[];
  vacantFor: readonly string[];
  relayOpen: boolean;
}) {
  if (!record.puzzle || !record.play) return null;
  const nextAction = availableActions(record.puzzle, record.play).find((a) => a.performer === record.role);
  const capabilities = record.puzzle.roles.find((r) => r.id === record.role)?.capabilities ?? [];
  const onRemote = capabilities.includes("dpad");
  const roleLabel = ROLE_LABEL[record.role] ?? record.role;
  // This next action belongs to `record.role`, so that
  // seat's own absence is what decides the copy. A phone that is not there
  // must not be told to act -- the waiting/vacant line above says why instead.
  // Only the "On your phone" branch goes: a `dpad` role is played from the TV
  // remote, which is a real control surface whether or not its phone is back.
  const seatAbsent = waitingFor.includes(roleLabel) || vacantFor.includes(roleLabel);
  return (
    <div class="rebuild-beat" data-testid="rebuild-beat" data-beat="3">
      <p class="rebuild-status">Controls changed. Your progress is kept.</p>
      {/* With the TV's own socket down, there is no board to instruct: an
          action named here is an instruction this TV cannot hear the answer
          to, and "On the remote" is worse -- it sends a player to a control
          surface whose presses go nowhere. `RebuildWaitingLine` below says
          the one thing that is true instead. */}
      {relayOpen ? (
        nextAction ? (
          <div class="rebuild-next-action" data-testid="rebuild-next-action">
            <span class="rebuild-next-role">
              {roleLabel} · {nextAction.label}
            </span>
            {onRemote || !seatAbsent ? (
              <span class="rebuild-next-where">{onRemote ? "On the remote" : "On your phone"}</span>
            ) : null}
          </div>
        ) : (
          <p class="rebuild-next-action" data-testid="rebuild-next-action">
            Nothing left for {roleLabel} right now.
          </p>
        )
      ) : null}
    </div>
  );
}

/**
 * The eight-second rebuild moment: C (or whoever changed) held at fixed
 * coordinates while the controls around them change, an honest before/after,
 * the payoff, then a live board ready for real input. Skippable at any beat with
 * "Continue".
 */
export function RebuildMoment({
  record,
  beat,
  focusId,
  onContinue,
  waitingFor = [],
  vacantFor = [],
  relayOpen,
}: {
  record: SwitchRecord;
  beat: number;
  focusId: string | null;
  onContinue: () => void;
  /** Labels of any role the certificate counts on that is currently held, live right now. */
  waitingFor?: readonly string[];
  /** Labels of any role the certificate counts on that nobody occupies at all, live right now. */
  vacantFor?: readonly string[];
  /** Whether the TV is in the room right now; see `HowWeChecked`'s `relayOpen`. */
  relayOpen: boolean;
}) {
  const moment = buildRebuildMoment(record);
  if (!moment) return null;
  return (
    <div class="rail-shell rebuild-moment" data-testid="rebuild-moment" data-kind="ok" data-beat={beat}>
      {beat <= 0 ? <RebuildBeat0 moment={moment} record={record} /> : null}
      {beat === 1 ? <RebuildBeat1 moment={moment} /> : null}
      {beat === 2 ? (
        <RebuildBeat2
          moment={moment}
          record={record}
          waitingFor={waitingFor}
          vacantFor={vacantFor}
          relayOpen={relayOpen}
        />
      ) : null}
      {beat >= 3 ? (
        <RebuildBeat3
          record={record}
          waitingFor={waitingFor}
          vacantFor={vacantFor}
          relayOpen={relayOpen}
        />
      ) : null}
      {/* Every beat but 2 says who the room is waiting for -- beat 2 leads
          with the identical sentence already, through `HowWeChecked`. See
          `RebuildWaitingLine` just above. */}
      {beat !== 2 ? (
        <RebuildWaitingLine waitingFor={waitingFor} vacantFor={vacantFor} relayOpen={relayOpen} />
      ) : null}
      <button
        class="rebuild-continue"
        data-focus-id="continue"
        data-testid="switch-continue"
        data-focused={String(focusId === "continue")}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}

/**
 * The four refusal kinds, kept visibly different -- never a single collapsed
 * "no repair holds" sentence. Stays on screen until dismissed; it never
 * auto-retries or auto-resolves.
 */
export function SwitchRefusal({
  record,
  focusId,
  onDismiss,
}: {
  record: SwitchRecord;
  focusId: string | null;
  onDismiss: () => void;
}) {
  if (record.kind === "ok") return null;
  const copy = refusalCopy(record.kind);
  return (
    <div class="overlay switch-refusal" data-testid="switch-refusal" data-kind={record.kind}>
      <h2 class="refusal-heading" data-testid="refusal-heading">
        {copy.heading}
      </h2>
      <p class="refusal-body">{copy.body}</p>
      <p class="refusal-progress">Your progress is unchanged. Your previous controls are still selected.</p>
      <details class="refusal-details" data-testid="refusal-details">
        <summary>Details</summary>
        <p>
          {record.kind}: {record.reason}
        </p>
      </details>
      <button
        class="refusal-action"
        data-focus-id="continue"
        data-testid="switch-continue"
        data-focused={String(focusId === "continue")}
        onClick={onDismiss}
      >
        {copy.action}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ending                                                              */
/* ------------------------------------------------------------------ */

export function Ending({
  state,
  badge: finalBadgeValue,
  certificate,
  onReplay,
  waitingFor = [],
  vacantFor = [],
  relayOpen,
}: {
  state: GameState;
  badge: Badge | null;
  certificate: Certificate | null;
  onReplay: () => void;
  /** Labels of any role the run's claim counts on that is currently held, live right now. */
  waitingFor?: readonly string[];
  /** Labels of any role the run's claim counts on that nobody occupies at all, live right now. */
  vacantFor?: readonly string[];
  /** Whether the TV is in the room right now; see `HowWeChecked`'s `relayOpen`. */
  relayOpen: boolean;
}) {
  const lines: LogLine[] = historyLines(state);
  const credits: Credit[] = endingCredits(state);
  const switches = state.switches.filter((s) => s.kind === "ok");
  const claimOk = finalBadgeValue?.ok === true;
  const claimHolds = claimHoldsLive(claimOk, waitingFor, vacantFor, relayOpen);
  const lastSwitchRole = switches.length > 0
    ? ROLE_LABEL[switches[switches.length - 1]!.role] ?? switches[switches.length - 1]!.role
    : null;
  // A claim about how many roles the puzzle needed is a positive claim like
  // any other -- it goes through the same `claimHoldsLive` gate as the
  // headline and `stillNeedsLine`, never asserted while a role this
  // certificate counts on is not actually there right now. The role count itself comes from the certificate's
  // own proven set, never a hardcoded number (Treehouse proves two, not
  // three).
  const view = certificate ? presentCertificate(certificate) : null;
  const contextLine =
    claimHolds && view
      ? lastSwitchRole
        ? `After ${lastSwitchRole} changed controls, the remaining puzzle still needed ${neededRolesPhrase(
            neededRoleCount(view),
          )}.`
        : `At the start, the puzzle needed ${neededRolesPhrase(neededRoleCount(view))}.`
      : lastSwitchRole
        ? `After ${lastSwitchRole} changed controls, here is what we checked.`
        : "At the start, here is what we checked.";
  return (
    <div class="rail-shell ending" data-testid="ending">
      {/* The ending's plate is the shared full-bleed background (app.tsx
          switches it to the "ending" surface once `state.phase` gets here) --
          the room as the team left it, shown as the screen itself rather than
          boxed beside this column. */}
      <h2 class="ending-title">{endingTitle(state.puzzle.id)}</h2>
      <p class="ending-sub" data-testid="ending-certificate-line" data-ok={String(claimHolds)}>
        {relayOpen ? endingClaimLine(claimOk, waitingFor, vacantFor) : RECONNECTING_LINE}
      </p>
      <div class="ending-credits" data-testid="ending-credits">
        {credits.map((credit) => (
          <p class="ending-credit" data-testid={`ending-credit-${credit.role.toLowerCase()}`}>
            {ROLE_LABEL[credit.role] ?? credit.role} — {credit.text}
          </p>
        ))}
      </div>
      <div class="ending-buttons">
        <button class="again" data-focus-id="again" data-testid="play-again" onClick={onReplay}>
          Play again
        </button>
        <EndingDetails
          label="See our moves"
          testId="see-our-moves"
          focusId="see-our-moves"
        >
          <ol class="history" data-testid="history">
            {lines.map((line, index) => (
              <li class={`history-line history-${line.kind}`} data-testid={`history-${line.id}`}>
                <span class="history-num" data-testid={`history-num-${line.id}`}>
                  {index + 1}
                </span>
                <span class="history-role">{line.role ?? "—"}</span>
                <span class="history-text">{line.text}</span>
              </li>
            ))}
          </ol>
        </EndingDetails>
        <EndingDetails label="How we checked" testId="ending-how-we-checked" focusId="ending-how-we-checked">
          <HowWeChecked
            certificate={certificate}
            contextLine={contextLine}
            testId="final-certificate"
            waitingFor={waitingFor}
            vacantFor={vacantFor}
            relayOpen={relayOpen}
          />
        </EndingDetails>
      </div>
      <div class="switch-summary" data-testid="switch-summary">
        {switches.length === 0
          ? "no input changes this run"
          : switches.map((record) => (
              <div class="switch-summary-line">
                {ROLE_LABEL[record.role] ?? record.role}: {record.from.join(" + ") || "nothing"} →{" "}
                {record.to.join(" + ") || "nothing"} — rebuilt and re-proven
              </div>
            ))}
      </div>
    </div>
  );
}

/** A secondary detail one tap away, opened with its own focus target. */
function EndingDetails({
  label,
  testId,
  focusId,
  children,
}: {
  label: string;
  testId: string;
  focusId: string;
  children: ComponentChildren;
}) {
  return (
    <details class="ending-details" data-testid={testId}>
      <summary class="ending-details-summary" data-focus-id={focusId} data-testid={`${testId}-open`}>
        {label}
      </summary>
      {children}
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Leaving                                                             */
/* ------------------------------------------------------------------ */

/**
 * The question the Back button asks.
 *
 * On a Fire TV the remote's Back is also "close this WebView", so the only safe
 * answer to an unhandled Back is to handle it. Nothing here leaves on its own:
 * the ring starts on Stay, and Back itself is Stay. Leaving takes a deliberate
 * press on Leave.
 */
export function LeavePrompt({
  focusId,
  onStay,
  onLeave,
}: {
  focusId: string | null;
  onStay: () => void;
  onLeave: () => void;
}) {
  return (
    <div class="overlay leave" data-testid="leave-prompt">
      <h2 class="leave-title">Leave the game?</h2>
      <p class="leave-sub">
        The study is still locked, and the TV is running the table. Leaving closes the game here.
      </p>
      <div class="leave-buttons">
        <button
          class="leave-stay"
          data-focus-id="stay"
          data-testid="leave-stay"
          data-focused={String(focusId === "stay")}
          onClick={onStay}
        >
          Stay
        </button>
        <button
          class="leave-go"
          data-focus-id="leave"
          data-testid="leave-leave"
          data-focused={String(focusId === "leave")}
          onClick={onLeave}
        >
          Leave
        </button>
      </div>
    </div>
  );
}

/**
 * The end of the road for a TV that cannot get back into its room.
 *
 * A TV returns to its room by naming it with the credential the relay issued
 * that room. When the relay refuses that -- the credential was spent by
 * another connection, or the room is not this TV's any more -- there is no way
 * back into the game the family was playing: the phones in it are in a room
 * this TV can no longer serve, whatever is still drawn on the board behind
 * this. So this says that plainly, and offers the only thing that is actually
 * still possible.
 */
export function RoomGone({
  focusId,
  onStartNewRoom,
}: {
  focusId: string | null;
  onStartNewRoom: () => void;
}) {
  return (
    <div class="overlay leave" data-testid="room-gone">
      <h2 class="leave-title">This game can't be picked up again</h2>
      <p class="leave-sub">
        The room this TV was serving has gone, so the phones that were playing have nothing left to
        come back to. Starting a new room gives everyone a fresh code to scan.
      </p>
      <div class="leave-buttons">
        <button
          class="leave-go start-new-room"
          data-focus-id="start-new-room"
          data-testid="start-new-room"
          data-focused={String(focusId === "start-new-room")}
          onClick={onStartNewRoom}
        >
          Start a new room
        </button>
      </div>
    </div>
  );
}

/**
 * A name is public, not a secret -- it can only ever raise this request, never
 * grant the seat on its own. Only a deliberate press on the TV remote hands
 * the role over; declining, or Back, refuses it.
 *
 * Neither is a seat token proof of identity: a token is a bearer credential,
 * so presenting one shows only that whoever holds it can present it. The
 * token branch therefore says so plainly and leaves the judgement to the
 * person holding the remote, rather than telling them their player is back.
 *
 * `live` is the case this round adds, and it is the one that most needs
 * saying: the seat being asked for is not a held one, it is being played
 * right now. Approving does not restore anybody -- it takes the game off the
 * phone currently holding it, which is exactly the consequence the person
 * with the remote has to weigh. The usual reason is the harmless one (the
 * same player reopened the link in another tab), so this is a question, not a
 * warning, but it must not read as "somebody is coming back".
 */
export function ReclaimApproval({
  request,
  live = false,
  focusId,
  onApprove,
  onDecline,
}: {
  request: PendingReclaim;
  live?: boolean;
  focusId: string | null;
  onApprove: () => void;
  onDecline: () => void;
}) {
  const roleLabelText = ROLE_LABEL[request.role] ?? request.role;
  const viaToken = request.via === "token";
  // Both controls name the request they answer (`remote.ts`), so the overlay a
  // press acts on is always the one the remote was looking at.
  const declineId = reclaimControlId(RECLAIM_DECLINE, request.id);
  const approveId = reclaimControlId(RECLAIM_APPROVE, request.id);
  return (
    <div
      class="overlay reclaim-approval"
      data-testid="reclaim-approval"
      data-via={request.via ?? "name"}
      data-live={String(live)}
    >
      <h2 class="reclaim-approval-title">
        A phone wants {roleLabelText}'s seat
      </h2>
      <p class="reclaim-approval-sub">
        {live
          ? `Another phone presented ${roleLabelText}'s reconnect code, but ${roleLabelText} is being played right now. Move the seat to it? The phone playing ${roleLabelText} will be closed.`
          : viaToken
            ? `A phone presented ${roleLabelText}'s reconnect code. Let it take ${roleLabelText}'s seat? Only if this is ${roleLabelText}.`
            : `${request.name || "Someone"} typed the name ${roleLabelText} joined under, and is asking for the seat back.`}
      </p>
      <div class="reclaim-approval-buttons">
        <button
          class="reclaim-approval-decline"
          data-focus-id={declineId}
          data-testid="reclaim-approval-decline"
          data-focused={String(focusId === declineId)}
          onClick={onDecline}
        >
          Not now
        </button>
        <button
          class="reclaim-approval-approve"
          data-focus-id={approveId}
          data-testid="reclaim-approval-approve"
          data-focused={String(focusId === approveId)}
          onClick={onApprove}
        >
          Hand it over
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Players & help -- where the room code and roster live during play   */
/* ------------------------------------------------------------------ */

/**
 * The persistent room-chip is not in the header during play: the join
 * credential is useful in setup, not alongside every move. This is where
 * it lives instead, reachable any time.
 */
export function PlayersHelp({
  state,
  focusId,
  onClose,
}: {
  state: GameState;
  focusId: string | null;
  onClose: () => void;
}) {
  const seats = seatRoles(state.puzzle);
  return (
    <div class="overlay players-help" data-testid="players-help">
      <h2>Players &amp; help</h2>
      <div class="room">
        <div class="room-label">Room code</div>
        <div class="room-code" data-testid="players-help-room">
          {state.room || "····"}
        </div>
      </div>
      <div class="slots">
        {seats.map((role) => (
          <RoleSlot state={state} role={role} />
        ))}
      </div>
      <button
        class="mini"
        data-focus-id="close-players-help"
        data-testid="close-players-help"
        data-focused={String(focusId === "close-players-help")}
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Clues found -- the full factual inventory, one tap away              */
/* ------------------------------------------------------------------ */

export function CluesFound({
  state,
  focusId,
  onClose,
}: {
  state: GameState;
  focusId: string | null;
  onClose: () => void;
}) {
  const facts = sharedFacts(state.puzzle, state.play).filter((f) => f.done);
  return (
    <div class="overlay clues-found" data-testid="clues-found">
      <h2>Clues found</h2>
      <div class="facts" data-testid="clue-board">
        {facts.length === 0 ? (
          <div class="facts-empty">Nobody has said anything out loud yet.</div>
        ) : (
          facts.map((fact) => (
            <span class="fact" data-testid={`fact-${fact.id}`}>
              {fact.text}
            </span>
          ))
        )}
      </div>
      <button
        class="mini"
        data-focus-id="close-clues-found"
        data-testid="close-clues-found"
        data-focused={String(focusId === "close-clues-found")}
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

export function ActionBoard({
  state,
  focusId,
  onPick,
  disabled = false,
}: {
  state: GameState;
  focusId: string | null;
  onPick: (actionId: string) => void;
  /** True while a full-screen sheet covers the board: its controls stop being focus targets. */
  disabled?: boolean;
}) {
  const actions = availableActions(state.puzzle, state.play);
  const pending = state.pending["tv"];
  if (pending) {
    const action = state.puzzle.actions.find((a) => a.id === pending.actionId);
    const labels = action ? optionLabels(action, state.puzzle) : [];
    // The TV remote is the controller for a dpad picker, and it keeps
    // working whether or not the role behind it is still connected -- so
    // this is the one board that has to ask on its own.
    // The reducer refuses the pick either way; this just stops the ring
    // from landing on a control certain to be refused.
    const performer = actions.find((entry) => entry.actionId === pending.actionId)?.performer ?? null;
    const performerPresent = performer !== null && isConnected(state, performer);
    return (
      <div class="board">
        <div class="board-title">
          {action ? action.label ?? action.id : pending.actionId} — pick one
        </div>
        {performerPresent ? (
          <div class="options" data-testid="tv-options">
            {labels.map((label, index) => (
              <div
                class="option"
                data-focus-id={disabled ? undefined : `opt:${index}`}
                data-testid={`tv-option-${index}`}
                data-focused={String(focusId === `opt:${index}`)}
                onClick={() => onPick(`opt:${index}`)}
              >
                {label}
              </div>
            ))}
          </div>
        ) : (
          <div class="options-waiting" data-testid="tv-options-waiting">
            {performer ?? "That role"} is not connected right now — waiting for them to come back.
          </div>
        )}
        <div class="board-hint">Back returns to the board.</div>
      </div>
    );
  }

  // Which of the two kinds of absence each seat is in,
  // read from the reducer rather than guessed from `present`. A seat is absent
  // because it is held (its phone dropped, inside the grace window) or because
  // it is vacant (the hold expired and the seat was swept); the room needs a
  // different sentence for each, and the sentences themselves live once, in
  // `waitingOrVacantLine`.
  const held = new Set<string>(heldRolesIn(state));
  const vacant = new Set<string>(vacantRolesIn(state));
  return (
    <div class="board" data-count={actions.length}>
      <div class="cards" data-testid="action-board">
        {actions.map((entry) => {
          const capabilities = state.puzzle.roles.find((r) => r.id === entry.performer)?.capabilities ?? [];
          const mode = phoneMode(capabilities);
          const remote = mode === "dpad";
          const present = isConnected(state, entry.performer);
          const label = ROLE_LABEL[entry.performer] ?? entry.performer;
          return (
            <div
              class="card"
              data-testid={`action-${entry.actionId}`}
              data-performer={entry.performer}
              data-input={mode}
              data-on-remote={String(remote)}
              data-waiting={String(!present)}
              data-focused={String(focusId === `act:${entry.actionId}`)}
              data-focus-id={!disabled && remote && present ? `act:${entry.actionId}` : undefined}
              onClick={remote && present ? () => onPick(`act:${entry.actionId}`) : undefined}
            >
              <div class="card-role">{entry.performer}</div>
              <div class="card-label">{entry.label}</div>
              {/*
                The absent branch used to fall through to the present
                branch's copy, so this card read "C · On your phone" for a
                phone that had dropped -- and went on saying it after C's
                hold expired and no C phone existed at all. An
                absent seat now says which kind of absence it is, in the same
                words the rebuild beats use; a seat that is really there keeps
                the control-surface line it always had.
              */}
              <div class="card-meta">
                {present
                  ? remote
                    ? "on the remote"
                    : `${label} · On your phone`
                  : held.has(entry.performer)
                    ? waitingOrVacantLine([label], [])
                    : vacant.has(entry.performer)
                      ? waitingOrVacantLine([], [label])
                      : ""}
              </div>
            </div>
          );
        })}
        {actions.length === 0 ? <div class="empty">nothing left to do here</div> : null}
      </div>
    </div>
  );
}

export { slug };
