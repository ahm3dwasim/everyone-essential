/**
 * The TV remote, and where focus goes when you press it.
 *
 * Two jobs, both pure:
 *
 *   1. `keyIntent` maps a Fire TV key to what it means. The Fire TV's Silk
 *      browser reports the centre button as keyCode 23 and Back as 4, neither
 *      of which a desktop browser sends, so both the code and the key name are
 *      consulted -- which is also what makes the same code testable with a
 *      keyboard in desktop Chrome. Where a code means one thing on the device
 *      and another on a laptop -- Menu is 18 in Web App Tester, which is also
 *      the desktop Alt key -- the name has the last word.
 *   2. `nextFocus` decides which control an arrow key lands on, from the
 *      on-screen rectangles. Geometry rather than a hand-maintained grid,
 *      because the option board is 3 wide in one puzzle and 4 in another, and a
 *      hand-written neighbour table is a trap waiting for the first layout
 *      change: it points at something that is not on screen any more.
 *
 * The rule for the end of the board is that focus does not move. It never wraps
 * to a hidden element and never lands on nothing.
 */
export type KeyIntent =
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "back"
  | "menu"
  | "playpause";

const BY_CODE: Record<number, KeyIntent> = {
  4: "back", // Fire TV Back
  8: "back", // Backspace, for a desktop keyboard
  13: "select", // Enter
  19: "up", // Fire TV DPAD_UP
  20: "down",
  21: "left",
  22: "right",
  23: "select", // Fire TV DPAD_CENTER
  27: "back", // Escape
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  82: "menu", // Fire TV Menu
  85: "playpause", // Fire TV Play/Pause
  179: "playpause",
  461: "back", // some Fire OS builds report Escape as 461
};

const BY_KEY: Record<string, KeyIntent> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "select",
  " ": "select",
  Escape: "back",
  Backspace: "back",
  Back: "back",
  GoBack: "back",
  BrowserBack: "back",
  Menu: "menu",
  // Amazon Web App Tester reports the remote's Menu button as this, not as
  // `Menu` -- and it is the name that carries the meaning here (see below).
  ContextMenu: "menu",
  MediaPlayPause: "playpause",
  Play: "playpause",
};

/**
 * Codes that mean one thing on a Fire TV and something else on a desktop
 * keyboard, so the code alone must not decide.
 *
 * 18 is the one that matters: Amazon Web App Tester delivers the remote's Menu
 * button as keyCode 18 (`ContextMenu`), and 18 is also the legacy code for the
 * Alt key. A desktop browser sends `Alt`, so a name in `notWhenKey` vetoes the
 * code -- otherwise holding Alt during a desktop session would read as the Menu
 * button and be swallowed.
 */
const CODE_NEEDS_THE_NAME: Record<number, { intent: KeyIntent; notWhenKey: readonly string[] }> = {
  18: { intent: "menu", notWhenKey: ["Alt", "AltGraph"] },
};

export function keyIntent(key: string, keyCode: number): KeyIntent | null {
  const shared = CODE_NEEDS_THE_NAME[keyCode];
  if (shared) {
    if (shared.notWhenKey.includes(key)) return null;
    return shared.intent;
  }
  return BY_CODE[keyCode] ?? BY_KEY[key] ?? null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FocusTarget {
  id: string;
  rect: Rect;
}

function centre(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The next focus target in `direction`, or null when there is nothing that way.
 *
 * Candidates must lie at least a little in the pressed direction (so a control
 * that merely overlaps cannot be picked), and among them the one with the
 * smallest perpendicular offset wins; distance along the axis breaks ties. That
 * is what makes "down" from a 3-wide row land on the control below rather than
 * the one diagonally across the screen.
 */
export function nextFocus(
  targets: readonly FocusTarget[],
  currentId: string | null,
  direction: "up" | "down" | "left" | "right",
): string | null {
  if (targets.length === 0) return null;
  const current = currentId ? targets.find((t) => t.id === currentId) : undefined;
  if (!current) return targets[0]?.id ?? null;
  const from = centre(current.rect);

  // Straight ahead beats close-but-off-to-the-side: the across-axis offset is
  // weighted far above the along-axis distance, so "down" from a 3-wide row
  // lands on the control below rather than the one diagonally across.
  const ACROSS_WEIGHT = 10_000;
  let best: { id: string; score: number } | null = null;
  for (const target of targets) {
    if (target.id === current.id) continue;
    const to = centre(target.rect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let along: number;
    let across: number;
    switch (direction) {
      case "up":
        if (dy > -4) continue;
        along = -dy;
        across = Math.abs(dx);
        break;
      case "down":
        if (dy < 4) continue;
        along = dy;
        across = Math.abs(dx);
        break;
      case "left":
        if (dx > -4) continue;
        along = -dx;
        across = Math.abs(dy);
        break;
      case "right":
        if (dx < 4) continue;
        along = dx;
        across = Math.abs(dy);
        break;
    }
    const score = across * ACROSS_WEIGHT + along;
    if (best === null || score < best.score) best = { id: target.id, score };
  }
  return best?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* The reclaim overlay's two controls                                  */
/* ------------------------------------------------------------------ */

/**
 * The two answers the TV can give a seat-reclaim request. Both ids carry the
 * fingerprint of the request they answer (`approve-reclaim:<request id>`,
 * `decline-reclaim:<request id>`), so a focus id, a key press and the action it
 * triggers all name the same request. When the queue moves on, the overlay
 * re-renders under the new request's ids: the id the ring was on is no longer
 * on screen anywhere, so the ring cannot stay on a control that now means a
 * different decision.
 */
export const RECLAIM_APPROVE = "approve-reclaim";
export const RECLAIM_DECLINE = "decline-reclaim";

export type ReclaimDecision = {
  control: typeof RECLAIM_APPROVE | typeof RECLAIM_DECLINE;
  requestId: string;
};

export function reclaimControlId(control: ReclaimDecision["control"], requestId: string): string {
  return `${control}:${requestId}`;
}

/** The decision a focus id names, or null when it is not one of the overlay's controls. */
export function reclaimDecision(id: string | null): ReclaimDecision | null {
  if (id === null) return null;
  const cut = id.indexOf(":");
  if (cut < 0) return null;
  const control = id.slice(0, cut);
  if (control !== RECLAIM_APPROVE && control !== RECLAIM_DECLINE) return null;
  return { control, requestId: id.slice(cut + 1) };
}

/**
 * Where the ring belongs while the overlay is up: on one of THIS request's two
 * controls if it is already there, otherwise on the safe one -- never on "Hand
 * it over". `Not now` is the answer that costs nothing to take back, and a
 * request that has just replaced another must not inherit the ring the remote
 * had walked to for the one before it.
 */
export function reclaimFocusTarget(
  availableIds: readonly string[],
  focusId: string | null,
  requestId: string,
): string | null {
  const safe = reclaimControlId(RECLAIM_DECLINE, requestId);
  const current = focusId === null ? null : reclaimDecision(focusId);
  if (
    current !== null &&
    current.requestId === requestId &&
    availableIds.includes(focusId as string)
  ) {
    return focusId;
  }
  return availableIds.includes(safe) ? safe : null;
}

/** Read the on-screen rectangles of everything currently focusable. */
export function collectTargets(root: ParentNode = document): FocusTarget[] {
  const nodes = root.querySelectorAll<HTMLElement>("[data-focus-id]");
  const targets: FocusTarget[] = [];
  nodes.forEach((node) => {
    const id = node.dataset.focusId;
    if (!id) return;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    targets.push({ id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  });
  return targets;
}

/**
 * The element carrying a given focus id, found by reading the ids that are
 * already in the DOM rather than by spelling one into a selector.
 *
 * A focus id is not always a constant of this file: the reclaim overlay's two
 * controls carry the fingerprint of the request they answer, and that
 * fingerprint carries the seat token the request is about. Building
 * `[data-focus-id="${id}"]` out of it puts whatever arrived on the wire into
 * the middle of a selector -- where a quote, a bracket or a backslash is
 * syntax rather than a character, and the lookup throws instead of returning
 * nothing. Comparing the attribute as a string cannot be anything but a
 * comparison, so a hostile token is simply an id that matches nothing.
 */
export function findFocusTarget(id: string, root: ParentNode = document): HTMLElement | null {
  if (!id) return null;
  const nodes = root.querySelectorAll<HTMLElement>("[data-focus-id]");
  let found: HTMLElement | null = null;
  nodes.forEach((node) => {
    // The first match wins, so a duplicate id resolves the way the focus ring
    // itself does -- in document order.
    if (found === null && node.dataset.focusId === id) found = node;
  });
  return found;
}
