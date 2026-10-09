/**
 * The painted room behind the screen, and the memory discipline it owes.
 *
 * The Stick this is built for -- an AFTMM with about 94 MB of free RAM -- does
 * not get to hold eleven decoded 1280x720 frames. A decoded plate costs roughly
 * 3.7 MB of bitmap regardless of the 30 kB it weighs on disk, so the budget is
 * spent in *decoded* frames, not in file bytes, and it is spent whether or not
 * the frame is on screen. Hence two rules, both enforced here rather than
 * trusted to the browser's cache:
 *
 *   1. At most `MAX_DECODED` plates are held decoded at any time (3 -- the one
 *      showing, the one fading out, and one preloaded next beat: ~11 MB).
 *   2. Changing mystery drops every plate of the old one immediately, because
 *      nothing in the new mystery will ever ask for them again.
 *
 * Dropping means clearing the element's `src` as well as releasing the handle:
 * a detached `HTMLImageElement` with a live `src` is still a decoded bitmap
 * Chromium is entitled to keep. Letting it fall out of scope is not eviction.
 *
 * The fade is two stacked layers rather than a swapped `src` so a beat never
 * shows an empty frame while the next plate decodes -- on the Stick that gap is
 * visible, and a blank room reads as a bug in the game rather than a slow load.
 *
 * The plate takes the scene slot in flow (see `plate.css`), replacing the flat
 * SVG scene rather than sitting behind the whole screen: art with no type on it
 * needs no scrim, and a scrim heavy enough to protect body contrast is heavy
 * enough to flatten the painting.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { type Plate, plateSrc } from "./plates.ts";
import "./plate.css";

/** Decoded frames held at once. Three is ~11 MB, inside the 16 MiB budget. */
const MAX_DECODED = 3;

/** id -> the element holding the decoded frame, in insertion order. */
const decoded = new Map<string, HTMLImageElement>();
/** Which mystery the cache currently belongs to. */
let cachedMystery: string | null = null;

function release(id: string): void {
  const img = decoded.get(id);
  decoded.delete(id);
  if (img) img.src = "";
}

function dropAll(): void {
  for (const id of [...decoded.keys()]) release(id);
}

/**
 * Decode a plate and keep it, evicting the oldest beyond the cap. Resolves once
 * the frame is usable; rejects nothing -- a plate that fails to load is a plate
 * the screen renders without, never an error the game has to handle.
 */
function warm(mysteryId: string, plate: Plate): Promise<void> {
  if (cachedMystery !== mysteryId) {
    dropAll();
    cachedMystery = mysteryId;
  }
  const held = decoded.get(plate.id);
  if (held) {
    // Refresh recency: delete and re-insert so eviction stays least-recent.
    decoded.delete(plate.id);
    decoded.set(plate.id, held);
    return Promise.resolve();
  }
  const img = new Image();
  decoded.set(plate.id, img);
  while (decoded.size > MAX_DECODED) {
    const oldest = decoded.keys().next();
    if (oldest.done || oldest.value === plate.id) break;
    release(oldest.value);
  }
  return new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.onerror = () => {
      release(plate.id);
      resolve();
    };
    img.src = plateSrc(plate);
  });
}

/** Test seam: how many frames are held right now, and for which mystery. */
export function plateCacheState(): { size: number; mystery: string | null; ids: string[] } {
  return { size: decoded.size, mystery: cachedMystery, ids: [...decoded.keys()] };
}

/** Test seam: forget everything, as a fresh boot would have it. */
export function resetPlateCache(): void {
  dropAll();
  cachedMystery = null;
}

export interface PlateViewProps {
  /** The mystery the plate belongs to; a change to it drops the old plates. */
  mysteryId: string;
  /** The plate to show, or `null` for a mystery with no art (generated ones). */
  plate: Plate | null;
}

/**
 * The room behind the panels. Renders nothing at all when `plate` is null, so a
 * mystery without art loses a picture and nothing else.
 */
export function PlateView({ mysteryId, plate }: PlateViewProps) {
  // The FIRST plate is shown straight away rather than after its decode. There
  // is nothing to cross-fade from, so waiting would open the scene slot empty
  // for as long as the decode takes -- which on the Stick is visible, and reads
  // as a broken room. Only a CHANGE of plate waits, because there the old room
  // is on screen and holding it one more beat is better than a gap.
  const [shown, setShown] = useState<Plate | null>(plate);
  const [previous, setPrevious] = useState<Plate | null>(null);
  const pending = useRef<string | null>(plate ? plate.id : null);

  useEffect(() => {
    if (!plate) {
      setPrevious(null);
      setShown(null);
      return;
    }
    pending.current = plate.id;
    if (!shown) {
      // First paint, or coming back from a mystery with no art at all.
      setShown(plate);
      void warm(mysteryId, plate);
      return;
    }
    if (shown.id === plate.id) {
      void warm(mysteryId, plate);
      return;
    }
    let live = true;
    void warm(mysteryId, plate).then(() => {
      // A faster beat may have asked for a different plate while this decoded.
      if (!live || pending.current !== plate.id) return;
      setPrevious(shown);
      setShown(plate);
    });
    return () => {
      live = false;
    };
  }, [mysteryId, plate?.id]);

  useEffect(() => {
    if (!previous) return;
    const t = setTimeout(() => setPrevious(null), 700);
    return () => clearTimeout(t);
  }, [previous?.id]);

  useEffect(() => () => {
    // Leaving the screen entirely: the frames are nobody's any more.
    dropAll();
    cachedMystery = null;
  }, []);

  if (!shown && !previous) return null;

  return (
    <div class="plate" aria-hidden={shown ? undefined : "true"}>
      {previous ? (
        <img class="plate-layer plate-out" src={plateSrc(previous)} alt="" />
      ) : null}
      {shown ? (
        <img class="plate-layer plate-in" src={plateSrc(shown)} alt={shown.alt} />
      ) : null}
    </div>
  );
}
