/**
 * Room codes: four letters, typed by a person off a TV screen.
 *
 * Letters only, so there is no `0`/`O` or `1`/`I` ambiguity to resolve -- the
 * normaliser strips anything that is not a letter rather than guessing what a
 * stray digit meant, because guessing a code wrong sends a phone to a room that
 * does not exist, which is a worse failure than asking again.
 */
import type { RoomCode } from "./protocol.ts";

export const ROOM_LENGTH = 4;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Uppercase, drop everything that is not a letter, and require exactly four.
 * Returns null when the input cannot be a room code.
 */
export function normalizeRoomCode(input: string): RoomCode | null {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length === ROOM_LENGTH ? letters : null;
}

/** A fresh code. `random` is injected so tests are deterministic. */
export function generateRoomCode(random: () => number = Math.random): RoomCode {
  let code = "";
  for (let i = 0; i < ROOM_LENGTH; i++) {
    const index = Math.max(
      0,
      Math.min(ALPHABET.length - 1, Math.floor(random() * ALPHABET.length)),
    );
    code += ALPHABET[index];
  }
  return code;
}

/**
 * The URL a phone opens. The room and the relay are in the fragment, so the
 * static server never sees them and the page can be cached. There is no
 * `mystery` field any more -- the join screen intentionally never trusts an
 * editable URL for a title.
 */
export function phoneUrl(base: string, room: RoomCode, relayUrl: string): string {
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}#room=${room}&relay=${encodeURIComponent(relayUrl)}`;
}

export interface LaunchParams {
  room: string | null;
  relay: string | null;
}

/** Read `#room=ABCD&relay=ws://…` (or the same in a query string). */
export function parseLaunchParams(search: string, hash: string): LaunchParams {
  const read = (key: string, source: string): string | null => {
    const params = new URLSearchParams(source);
    const value = params.get(key);
    return value && value.length > 0 ? value : null;
  };
  const hashBody = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryBody = search.startsWith("?") ? search.slice(1) : search;
  return {
    room: read("room", hashBody) ?? read("room", queryBody),
    relay: read("relay", hashBody) ?? read("relay", queryBody),
  };
}

/** The default relay address for a page served from `location`. */
export function defaultRelayUrl(location: { protocol: string; hostname: string }): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.hostname}:8787`;
}
