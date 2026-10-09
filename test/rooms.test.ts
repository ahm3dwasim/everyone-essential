/**
 * Room codes and launch URLs: the join path, which is the one thing a person
 * has to get right on the night.
 */
import { describe, expect, it } from "vitest";
import {
  defaultRelayUrl,
  generateRoomCode,
  normalizeRoomCode,
  parseLaunchParams,
  phoneUrl,
} from "../app/shared/rooms.ts";

describe("normalizeRoomCode", () => {
  it("accepts a code typed in any case, with stray punctuation", () => {
    expect(normalizeRoomCode("a b c d")).toBe("ABCD");
    expect(normalizeRoomCode("ab-cd")).toBe("ABCD");
  });

  it("refuses anything that is not four letters", () => {
    // Guesswork here would send a phone to a room that does not exist, which is
    // a worse failure than asking the player to type it again.
    expect(normalizeRoomCode("ABCDE")).toBeNull();
    expect(normalizeRoomCode("ABC")).toBeNull();
    expect(normalizeRoomCode("AB1D")).toBeNull();
    expect(normalizeRoomCode("")).toBeNull();
  });
});

describe("generateRoomCode", () => {
  it("uses the injected randomness, so a test can predict it", () => {
    expect(generateRoomCode(() => 0)).toBe("AAAA");
    expect(generateRoomCode(() => 0.999999)).toBe("ZZZZ");
  });

  it("stays inside the alphabet even if the generator misbehaves", () => {
    expect(generateRoomCode(() => 1)).toBe("ZZZZ");
    expect(generateRoomCode(() => -5)).toBe("AAAA");
  });
});

describe("phoneUrl", () => {
  it("puts the room and the relay in the fragment, where the server never sees them", () => {
    const url = phoneUrl("http://192.0.2.20:8080/phone/", "ABCD", "ws://192.0.2.20:8787");
    expect(url).toBe("http://192.0.2.20:8080/phone/#room=ABCD&relay=ws%3A%2F%2F192.0.2.20%3A8787");
    expect(new URL(url).search).toBe("");
  });

  it("adds the separating slash when the base has none", () => {
    expect(phoneUrl("http://host/phone", "ABCD", "ws://host:8787")).toContain("/phone/#room=ABCD");
  });

  it("never carries a mystery title -- the field was removed; nothing on the phone ever read it", () => {
    expect(phoneUrl("http://host/phone/", "ABCD", "ws://host:8787")).not.toContain("mystery=");
  });
});

describe("parseLaunchParams", () => {
  it("reads the fragment the QR code carries", () => {
    const params = parseLaunchParams("", "#room=ABCD&relay=ws%3A%2F%2Fhost%3A8787");
    expect(params).toEqual({ room: "ABCD", relay: "ws://host:8787" });
  });

  it("falls back to the query string, and treats an empty value as absent", () => {
    const params = parseLaunchParams("?room=WXYZ&relay=", "");
    expect(params).toEqual({ room: "WXYZ", relay: null });
  });

  it("returns nulls for a page opened with nothing", () => {
    expect(parseLaunchParams("", "")).toEqual({ room: null, relay: null });
  });

  it("ignores an editable mystery= fragment -- the field is gone, not merely unread", () => {
    const params = parseLaunchParams("", "#room=ABCD&relay=ws%3A%2F%2Fhost&mystery=The%20Treehouse");
    expect(params).toEqual({ room: "ABCD", relay: "ws://host" });
    expect(Object.keys(params)).not.toContain("mystery");
  });
});

describe("defaultRelayUrl", () => {
  it("points at the same host as the page, on the relay's port", () => {
    expect(defaultRelayUrl({ protocol: "http:", hostname: "192.0.2.20" })).toBe(
      "ws://192.0.2.20:8787",
    );
    expect(defaultRelayUrl({ protocol: "https:", hostname: "example.test" })).toBe(
      "wss://example.test:8787",
    );
  });
});
