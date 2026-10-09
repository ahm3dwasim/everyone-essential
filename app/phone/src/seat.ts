/**
 * One browser, one seat token -- minted atomically, over plain HTTP.
 *
 * The seat token is this browser's own identity for one room, and it outlives
 * the connection: the relay gives every new socket a fresh peer id, so a phone
 * that comes back mid-game looks like a stranger to the TV unless it carries
 * something of its own. Everything the TV can do for a player who dropped --
 * hold the role, offer it back, let the room approve the handover -- hangs off
 * that token being the SAME one every time, in every tab.
 *
 * ## Why this is a transaction and not a read followed by a write
 *
 * `localStorage` cannot promise that. Two tabs opening the join link at the
 * same moment both read "nothing kept yet", both mint, and the second write
 * lands on top of the first: the two tabs walk away with two different answers
 * to "what is my seat", and this browser is two players as far as the TV can
 * tell. Reading the key back after writing it does not close that race -- it
 * only narrows it, because tab A's read-back can complete before tab B's write
 * ever happens. The consequence is reproducible and not theoretical: one
 * browser holds two roles, and the tab that lost the race comes back on the
 * survivor's token and lands in the wrong seat.
 *
 * Web Locks would be the obvious answer and is not available here: these pages
 * are served over plain HTTP on the LAN (a Fire TV's own relay has no TLS
 * certificate to offer), and `navigator.locks` is gated to secure contexts.
 *
 * IndexedDB is not. A `readwrite` transaction over one object store is
 * serialised against every other same-origin transaction on that store, across
 * every tab of the browser, with no secure context required. So the read and
 * the write happen as ONE step: inside a single transaction this reads the
 * room's token, writes a freshly minted one only if nothing valid is kept, and
 * returns whatever the store holds at the end. Whichever tab's transaction
 * runs second sees the first tab's token and adopts it. Every tab of one
 * browser therefore holds the same token, by construction rather than by
 * timing -- and the TV's own rule (`reducer.ts`'s `player_joined`) never has
 * to arbitrate between two tokens that should have been one.
 *
 * ## When IndexedDB is not there at all
 *
 * A private window can forbid it outright, and this fails the join rather
 * than working around it (`SeatPersistenceError`). The fallback this used to
 * take -- a per-tab `sessionStorage` token -- traded the one property the
 * whole scheme above exists for: two tabs of ONE browser minting into two
 * separate per-tab stores walk away with two different tokens, and the
 * reducer's "one browser, one seat" rule (`reducer.ts`'s `player_joined`) has
 * no way to tell that apart from two different browsers. A token nobody can
 * read back outside this one tab is a seat this phone could never reclaim by
 * itself either way, so there is nothing a fallback here buys that is worth
 * that hole being open again.
 */
import { isSeatToken } from "../../shared/protocol.ts";

/** Thrown by `mintSeatId` when this browser has no CSPRNG at all. */
export class NoSecureRandomError extends Error {}

/** The message this phone shows when it cannot mint a seat token securely. */
export const NO_SECURE_RANDOM_MESSAGE = "this browser can't join securely — use another browser";

/** Thrown when IndexedDB will not keep this browser's token. */
export class SeatPersistenceError extends Error {}

/**
 * The message this phone shows when a seat token it already minted stops
 * being keepable mid-session (the rotation behind "This isn't my seat").
 * Joining anyway on an ephemeral, in-memory token is not an acceptable
 * fallback: a token nobody can read back is a seat this phone can never
 * reclaim by itself -- closing the tab, or the TV granting a rebuild that
 * reloads it, strands the player behind a fresh, unrelated token with no way
 * back to the role they held.
 */
export const SEAT_PERSISTENCE_MESSAGE =
  "this browser won't let the game remember your seat — turn on storage for this site (or leave private/incognito mode) and try again";

/**
 * The message this phone shows instead of joining at all when IndexedDB is
 * missing or fails -- most often a private window. There is no fallback
 * store any more (see the file comment): a browser that cannot keep this
 * browser-wide token does not get a per-tab substitute, it gets told why and
 * a way to retry.
 */
export const STORAGE_BLOCKED_MESSAGE =
  "This browser is blocking the storage the game needs (often a private window). Open the link in a normal browser tab to play.";

export interface SeatToken {
  token: string;
}

/**
 * True only when `crypto.getRandomValues` is actually callable. These pages
 * are served over plain HTTP on the LAN, so `crypto.subtle` and
 * `crypto.randomUUID` are NOT reliably available even in a browser that
 * otherwise has `crypto` -- both are gated to secure contexts in some
 * engines. `getRandomValues` is not: it is present in every browser this app
 * targets, secure context or not.
 */
export function hasSecureRandom(): boolean {
  const globalCrypto = typeof crypto !== "undefined" ? crypto : undefined;
  return typeof globalCrypto?.getRandomValues === "function";
}

/**
 * A fresh seat id. This is a credential -- a peer presenting the matching
 * value only ever RAISES a request for the role that value holds; the TV
 * remote's own `approve_reclaim` is what actually hands the role over, and
 * nothing is ever taken from a connection that is still playing. It still has
 * to come from a real CSPRNG, never a timestamp and `Math.random()`: those are
 * guessable enough that a stranger could mint or predict somebody else's seat
 * and raise that request in their place. A browser with no CSPRNG at all fails
 * closed rather than falling back to that weaker scheme.
 */
export function mintSeatId(): string {
  if (!hasSecureRandom()) throw new NoSecureRandomError(NO_SECURE_RANDOM_MESSAGE);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const DB_NAME = "everyone-essential-seats";
const STORE_NAME = "seats";

function indexedDbFactory(): IDBFactory | null {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  } catch {
    // Merely READING `indexedDB` throws in some locked-down configurations.
    return null;
  }
}

/**
 * Whether this browser looks like it will let a seat token be minted at all.
 * A synchronous, best-effort check -- IndexedDB can still refuse or fail once
 * a transaction is actually opened, which `seatIdFor`/`mintFreshSeat` fail
 * closed on regardless. This is only for the join screen to avoid opening a
 * connection it already knows cannot mint a token.
 */
export function hasIndexedDb(): boolean {
  return indexedDbFactory() !== null;
}

function openSeatDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
    // Another tab holding an older version open would block an upgrade
    // forever. There is only ever version 1, so this cannot happen in
    // practice -- but waiting for a callback that never comes would hang the
    // join screen, so it is refused rather than awaited.
    request.onblocked = () => reject(new Error("indexedDB open blocked"));
  });
}

/**
 * The whole of the atomicity: ONE `readwrite` transaction that reads the
 * room's token and, only if nothing usable is kept, writes `candidate`. The
 * value this resolves to is whatever the store holds when the transaction
 * commits, so two tabs racing here converge on one token -- the first
 * transaction to commit is the one both adopt.
 *
 * `candidate` is minted BEFORE the transaction opens, deliberately: minting
 * inside the `onsuccess` callback would let a `NoSecureRandomError` abort the
 * transaction and come back as an opaque abort, losing the one thing the join
 * screen needs to say.
 *
 * A kept value that is not the exact shape this app mints cannot be anyone's
 * token -- hand-edited storage, a leftover from a format no longer written, or
 * plain corruption. The wire refuses it forever regardless (`isSeatToken`,
 * `protocol.ts`'s `join` decoder), so returning it would just mean every
 * future join fails the same way with no route out. It is treated as if
 * nothing were kept.
 */
function settleInTransaction(
  db: IDBDatabase,
  room: string,
  candidate: string,
  rotate: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled: string | null = null;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readwrite");
    } catch (err) {
      reject(err);
      return;
    }
    const store = tx.objectStore(STORE_NAME);
    const read = store.get(room);
    read.onsuccess = () => {
      const kept = typeof read.result === "string" ? read.result : null;
      if (!rotate && kept !== null && isSeatToken(kept)) {
        settled = kept;
        return;
      }
      store.put(candidate, room);
      settled = candidate;
    };
    read.onerror = () => reject(read.error ?? new Error("indexedDB read failed"));
    // Resolved on COMMIT, never on the read's own callback: until the
    // transaction commits, the write this tab just made is not yet the thing
    // another tab's transaction would see.
    tx.oncomplete = () =>
      settled !== null ? resolve(settled) : reject(new Error("indexedDB transaction kept nothing"));
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB transaction failed"));
  });
}

async function settleSeat(room: string, rotate: boolean): Promise<SeatToken> {
  // Fail closed before anything is written anywhere: a seat token minted
  // without a CSPRNG is guessable.
  const candidate = mintSeatId();
  const factory = indexedDbFactory();
  if (factory === null) throw new SeatPersistenceError(SEAT_PERSISTENCE_MESSAGE);
  let db: IDBDatabase | null = null;
  try {
    db = await openSeatDb(factory);
    return { token: await settleInTransaction(db, room, candidate, rotate) };
  } catch {
    // Refused, blocked, or aborted -- there is no fallback store any more
    // (see the file comment): a token this browser's other tabs could not
    // also read is a seat this phone could never reclaim by itself, so the
    // join fails instead of quietly narrowing to one tab.
    throw new SeatPersistenceError(SEAT_PERSISTENCE_MESSAGE);
  } finally {
    db?.close();
  }
}

/**
 * This browser's token for `room`, minted on first use and identical in every
 * tab. The one call the join path makes.
 */
export function seatIdFor(room: string): Promise<SeatToken> {
  return settleSeat(room, false);
}

/**
 * Always mints a fresh token, ignoring whatever is kept -- the rotation behind
 * "This isn't my seat", never the ordinary read path. It runs in the same kind
 * of transaction, so a rotation and a second tab's first mint cannot interleave
 * into two different answers either.
 */
export function mintFreshSeat(room: string): Promise<SeatToken> {
  return settleSeat(room, true);
}
