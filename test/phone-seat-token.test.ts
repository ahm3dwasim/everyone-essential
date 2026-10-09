/**
 * The seat id is an access credential (`reducer.ts`'s
 * `player_joined` hands a held role to whoever presents the matching
 * `seat`), so it has to come from a real CSPRNG rather than a timestamp and
 * `Math.random()` -- both narrow enough to guess or collide.
 *
 * These pages are served over plain HTTP on the LAN, so
 * `crypto.subtle` and `crypto.randomUUID` are not reliably available even in
 * a browser that has `crypto` at all -- `getRandomValues` is, in every
 * browser this app targets, so it is the only path `mintSeatId` takes. A
 * browser with no CSPRNG fails closed rather than falling back to the
 * weaker `Date.now()`/`Math.random()` scheme the an earlier version fix removed.
 */
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  hasIndexedDb,
  hasSecureRandom,
  mintFreshSeat,
  mintSeatId,
  NoSecureRandomError,
  SeatPersistenceError,
  seatIdFor,
} from "../app/phone/src/seat.ts";

describe("the seat token is minted from getRandomValues, and fails closed without it", () => {
  it("mints from crypto.getRandomValues, never Math.random() or randomUUID", () => {
    const valuesSpy = vi.spyOn(crypto, "getRandomValues");
    const randomUUIDSpy = vi.spyOn(crypto, "randomUUID");
    const randomSpy = vi.spyOn(Math, "random");
    try {
      const id = mintSeatId();
      expect(valuesSpy).toHaveBeenCalledTimes(1);
      expect(randomUUIDSpy).not.toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
      // 16 bytes, hex-encoded: 32 hex characters, nothing else.
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      valuesSpy.mockRestore();
      randomUUIDSpy.mockRestore();
      randomSpy.mockRestore();
    }
  });

  it("mints ids wide enough that two calls never collide across a real sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintSeatId());
    expect(seen.size).toBe(1000);
  });

  it("reports no secure random when crypto.getRandomValues is missing", () => {
    const original = crypto.getRandomValues;
    // @ts-expect-error -- deliberately hiding it to exercise the no-crypto path
    crypto.getRandomValues = undefined;
    try {
      expect(hasSecureRandom()).toBe(false);
    } finally {
      crypto.getRandomValues = original;
    }
  });

  it("fails closed -- never falls back to Date.now()/Math.random() -- when there is no CSPRNG", () => {
    const original = crypto.getRandomValues;
    const randomSpy = vi.spyOn(Math, "random");
    // @ts-expect-error -- deliberately hiding it to exercise the no-crypto path
    crypto.getRandomValues = undefined;
    try {
      expect(() => mintSeatId()).toThrow(NoSecureRandomError);
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      crypto.getRandomValues = original;
      randomSpy.mockRestore();
    }
  });

  it("fails closed even when crypto itself is entirely absent", () => {
    const original = globalThis.crypto;
    // @ts-expect-error -- deliberately removing the whole global
    delete globalThis.crypto;
    try {
      expect(hasSecureRandom()).toBe(false);
      expect(() => mintSeatId()).toThrow(NoSecureRandomError);
    } finally {
      globalThis.crypto = original;
    }
  });
});

/**
 * One browser, one token -- and the transaction that makes that true.
 *
 * Every test below drives the REAL `seatIdFor`/`mintFreshSeat` against a real
 * IndexedDB implementation (`fake-indexeddb`), one `IDBFactory` per modeled
 * browser. A "tab" is a call; two tabs of one browser are two calls against
 * the same factory, and a different browser is a different factory. Nothing
 * here scripts a storage mock into a particular interleaving: the ordering is
 * whatever the store's own transaction scheduling produces, which is exactly
 * the thing under test.
 */
describe("one browser, one seat token, settled in a transaction", () => {
  function browser(): IDBFactory {
    return new IDBFactory();
  }

  async function inBrowser<T>(factory: IDBFactory, fn: () => Promise<T>): Promise<T> {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = factory;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
      else (globalThis as { indexedDB?: unknown }).indexedDB = original;
    }
  }

  it("mints a well-formed token on first use", async () => {
    const seat = await inBrowser(browser(), () => seatIdFor("ABCD"));
    expect(seat.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("gives the same token back on every later call", async () => {
    const one = browser();
    const first = await inBrowser(one, () => seatIdFor("ABCD"));
    const second = await inBrowser(one, () => seatIdFor("ABCD"));
    const third = await inBrowser(one, () => seatIdFor("ABCD"));
    expect(second.token).toBe(first.token);
    expect(third.token).toBe(first.token);
  });

  /**
   * The an earlier version reproduction at the storage layer: two tabs opening the join
   * link at the same moment. Under the old read-then-write scheme they could
   * each walk away with their own token, and the browser was two players.
   */
  it("two tabs racing to mint at the same moment settle on ONE token", async () => {
    const one = browser();
    const [tabA, tabB] = await inBrowser(one, () =>
      Promise.all([seatIdFor("ABCD"), seatIdFor("ABCD")]),
    );
    expect(tabA.token).toBe(tabB.token);
    // And a third tab opening afterwards agrees with both.
    const tabC = await inBrowser(one, () => seatIdFor("ABCD"));
    expect(tabC.token).toBe(tabA.token);
  });

  it("holds for many tabs racing at once, not just two", async () => {
    const one = browser();
    const tabs = await inBrowser(one, () =>
      Promise.all(Array.from({ length: 12 }, () => seatIdFor("ABCD"))),
    );
    expect(new Set(tabs.map((t) => t.token)).size).toBe(1);
  });

  it("keeps one browser's rooms apart, and one room's browsers apart", async () => {
    const one = browser();
    const roomA = await inBrowser(one, () => seatIdFor("ABCD"));
    const roomB = await inBrowser(one, () => seatIdFor("WXYZ"));
    expect(roomB.token).not.toBe(roomA.token);

    const other = await inBrowser(browser(), () => seatIdFor("ABCD"));
    expect(other.token).not.toBe(roomA.token);
  });

  it("replaces a kept value that is not the shape this app mints", async () => {
    // Hand-edited storage, a leftover format, or plain corruption. The wire
    // refuses it forever (`isSeatToken`), so keeping it would mean every
    // future join fails the same way with no route out.
    const one = browser();
    const corrupt = "not-a-seat-token";
    await inBrowser(one, async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = (globalThis as { indexedDB: IDBFactory }).indexedDB.open(
          "everyone-essential-seats",
          1,
        );
        request.onupgradeneeded = () => request.result.createObjectStore("seats");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("seats", "readwrite");
        tx.objectStore("seats").put(corrupt, "ABCD");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });

    const seat = await inBrowser(one, () => seatIdFor("ABCD"));
    expect(seat.token).not.toBe(corrupt);
    expect(seat.token).toMatch(/^[0-9a-f]{32}$/);
    // And it stuck: the corrupt value is gone, not read again next time.
    const again = await inBrowser(one, () => seatIdFor("ABCD"));
    expect(again.token).toBe(seat.token);
  });

  it("fails closed with NoSecureRandomError, never a guessable token", async () => {
    const original = crypto.getRandomValues;
    // @ts-expect-error -- deliberately hiding it to exercise the no-crypto path
    crypto.getRandomValues = undefined;
    try {
      await expect(inBrowser(browser(), () => seatIdFor("ABCD"))).rejects.toThrow(NoSecureRandomError);
    } finally {
      crypto.getRandomValues = original;
    }
  });
});

/**
 * "This isn't my seat" rotates this browser's token -- in the same kind of
 * transaction, so a rotation and another tab's read cannot interleave into two
 * different answers either.
 */
describe("mintFreshSeat rotates the browser's token, never returns what was kept", () => {
  function browser(): IDBFactory {
    return new IDBFactory();
  }

  async function inBrowser<T>(factory: IDBFactory, fn: () => Promise<T>): Promise<T> {
    const original = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = factory;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
      else (globalThis as { indexedDB?: unknown }).indexedDB = original;
    }
  }

  it("always mints, and the whole browser adopts the rotation", async () => {
    const one = browser();
    const before = await inBrowser(one, () => seatIdFor("ABCD"));
    const rotated = await inBrowser(one, () => mintFreshSeat("ABCD"));
    expect(rotated.token).not.toBe(before.token);
    // Another tab reading afterwards sees the rotation, not the old token.
    const otherTab = await inBrowser(one, () => seatIdFor("ABCD"));
    expect(otherTab.token).toBe(rotated.token);
  });

  it("two rotations in a row give two different tokens, and the last one sticks", async () => {
    const one = browser();
    const first = await inBrowser(one, () => mintFreshSeat("ABCD"));
    const second = await inBrowser(one, () => mintFreshSeat("ABCD"));
    expect(second.token).not.toBe(first.token);
    expect((await inBrowser(one, () => seatIdFor("ABCD"))).token).toBe(second.token);
  });

  it("fails closed with NoSecureRandomError, never a rotation with no CSPRNG behind it", async () => {
    const original = crypto.getRandomValues;
    // @ts-expect-error -- deliberately hiding it to exercise the no-crypto path
    crypto.getRandomValues = undefined;
    try {
      await expect(inBrowser(browser(), () => mintFreshSeat("ABCD"))).rejects.toThrow(
        NoSecureRandomError,
      );
    } finally {
      crypto.getRandomValues = original;
    }
  });
});

/**
 * A private window can refuse IndexedDB outright, or IndexedDB can exist and
 * still fail to open. Either way the join now fails closed rather than
 * falling back to a per-tab `sessionStorage` token: that fallback minted a
 * SEPARATE token per tab, so two tabs of one browser -- exactly the case the
 * transaction above exists to unify -- walked away with two tokens and the
 * reducer's "one browser, one seat" rule could not tell them apart from two
 * different browsers. There is no substitute store to fall back to any more,
 * only a refusal the phone can act on.
 */
describe("no working IndexedDB: the join fails closed, never a per-tab token", () => {
  async function withoutIndexedDb<T>(fn: () => Promise<T>): Promise<T> {
    const globals = globalThis as { indexedDB?: unknown };
    const original = globals.indexedDB;
    delete globals.indexedDB;
    try {
      return await fn();
    } finally {
      if (original === undefined) delete globals.indexedDB;
      else globals.indexedDB = original;
    }
  }

  async function withBrokenIndexedDb<T>(fn: () => Promise<T>): Promise<T> {
    const globals = globalThis as { indexedDB?: unknown };
    const original = globals.indexedDB;
    globals.indexedDB = {
      open: () => {
        throw new Error("SecurityError");
      },
    };
    try {
      return await fn();
    } finally {
      if (original === undefined) delete globals.indexedDB;
      else globals.indexedDB = original;
    }
  }

  it("hasIndexedDb reports false when indexedDB is entirely missing", async () => {
    await withoutIndexedDb(async () => {
      expect(hasIndexedDb()).toBe(false);
    });
  });

  it("throws SeatPersistenceError -- never an ephemeral or per-tab token -- when indexedDB is missing", async () => {
    await expect(withoutIndexedDb(() => seatIdFor("ABCD"))).rejects.toThrow(SeatPersistenceError);
  });

  it("throws SeatPersistenceError when indexedDB is present but refuses to open", async () => {
    await expect(withBrokenIndexedDb(() => seatIdFor("ABCD"))).rejects.toThrow(SeatPersistenceError);
  });

  it("mintFreshSeat also fails closed, never a per-tab rotation", async () => {
    await expect(withoutIndexedDb(() => mintFreshSeat("ABCD"))).rejects.toThrow(SeatPersistenceError);
  });
});
