/**
 * The wire protocol: the transport envelope and the game messages inside it.
 *
 * The property under test is that every decoder is total -- it either produces a
 * fully-formed message or a reason it refused -- because the TV's trust model
 * rests on it: a phone can send anything, and what reaches the reducer must
 * already be a shape the reducer has a case for.
 */
import { describe, expect, it } from "vitest";
import {
  MORE_CHOICE_ID,
  PROTOCOL_VERSION,
  decodeClientMessage,
  decodeGameMessage,
  decodeIntent,
  decodeRelayMessage,
  encode,
  isCapability,
  isRoleId,
  paginateChoices,
  type Choice,
  type PhoneView,
} from "../app/shared/protocol.ts";

describe("vocabulary", () => {
  it("knows exactly the three roles and three input modes", () => {
    expect(isRoleId("A")).toBe(true);
    expect(isRoleId("D")).toBe(false);
    expect(isRoleId(7)).toBe(false);
    expect(isCapability("scan")).toBe(true);
    expect(isCapability("trackpad")).toBe(false);
  });
});

describe("client -> relay", () => {
  it("round-trips a hello, with the version filled in", () => {
    const raw = encode({ t: "hello", v: PROTOCOL_VERSION, kind: "phone", room: "ABCD" });
    const decoded = decodeClientMessage(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.message).toEqual({ t: "hello", v: PROTOCOL_VERSION, kind: "phone", room: "ABCD" });
  });

  it("gives a hello with no version the current one rather than refusing it", () => {
    const decoded = decodeClientMessage(JSON.stringify({ t: "hello", kind: "tv" }));
    expect(decoded.ok && decoded.message.t === "hello" && decoded.message.v).toBe(PROTOCOL_VERSION);
  });

  it("refuses a hello that does not say whether it is a TV or a phone", () => {
    const decoded = decodeClientMessage(JSON.stringify({ t: "hello", kind: "tablet" }));
    expect(decoded).toEqual({ ok: false, reason: "hello.kind" });
  });

  it("carries a room's host credential through a hello, and drops anything that is not one", () => {
    const token = "c".repeat(64);
    const decoded = decodeClientMessage(
      JSON.stringify({ t: "hello", kind: "tv", room: "ABCD", hostToken: token }),
    );
    expect(decoded.ok && decoded.message.t === "hello" && decoded.message.hostToken).toBe(token);

    // 32 random bytes as lowercase hex is the only thing the relay mints, so
    // it is the only thing a hello may carry. Anything else is dropped here
    // and the relay then sees no credential at all and refuses the claim --
    // fail-closed, not compared.
    const wrong = decodeClientMessage(
      JSON.stringify({ t: "hello", kind: "tv", room: "ABCD", hostToken: "not-a-credential" }),
    );
    expect(wrong.ok && wrong.message.t === "hello" && wrong.message.hostToken).toBeUndefined();
  });

  it("drops a client-supplied `from`: only the relay says who sent a frame", () => {
    const raw = JSON.stringify({
      t: "relay",
      from: "p1-someone-else",
      to: "tv",
      payload: { t: "join" },
    });
    const decoded = decodeClientMessage(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "relay") return;
    expect(decoded.message).not.toHaveProperty("from");
    expect(decoded.message).toEqual({ t: "relay", to: "tv", payload: { t: "join" } });
  });

  it("refuses junk, non-objects, and unknown types", () => {
    expect(decodeClientMessage("{not json")).toEqual({ ok: false, reason: "not JSON" });
    expect(decodeClientMessage("[]")).toEqual({ ok: false, reason: "not an object" });
    expect(decodeClientMessage(JSON.stringify({ t: "shout" }))).toEqual({
      ok: false,
      reason: 'unknown type "shout"',
    });
  });

  it("refuses a relay frame whose payload is not a game message", () => {
    const raw = JSON.stringify({ t: "relay", to: "tv", payload: { t: "nope" } });
    expect(decodeClientMessage(raw)).toEqual({
      ok: false,
      reason: 'relay.payload: unknown type "nope"',
    });
  });
});

describe("relay -> client", () => {
  it("round-trips a welcome with its peer list", () => {
    const raw = encode({
      t: "welcome",
      v: PROTOCOL_VERSION,
      room: "ABCD",
      peerId: "p1",
      kind: "tv",
      peers: [{ peerId: "p1", kind: "tv" }, { peerId: "p2", kind: "phone", name: "Sam" }],
    });
    const decoded = decodeRelayMessage(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "welcome") return;
    expect(decoded.message.room).toBe("ABCD");
    expect(decoded.message.peers).toHaveLength(2);
    expect(decoded.message.peers[1]?.name).toBe("Sam");
  });

  it("refuses a welcome whose peers are not peers", () => {
    const raw = JSON.stringify({
      t: "welcome",
      room: "ABCD",
      peerId: "p1",
      kind: "tv",
      peers: [{ peerId: "p2", kind: "toaster" }],
    });
    expect(decodeRelayMessage(raw)).toEqual({ ok: false, reason: "welcome.peers[].kind" });
  });

  it("requires a sender on a relay envelope", () => {
    const raw = JSON.stringify({ t: "relay", to: "tv", payload: { t: "join" } });
    expect(decodeRelayMessage(raw)).toEqual({ ok: false, reason: "relay.from" });
  });

  it("carries the stamped sender through to the game message", () => {
    const raw = JSON.stringify({
      t: "relay",
      from: "p7",
      to: "tv",
      payload: { t: "intent", intent: { k: "choose", choiceId: "act:b_dictate_code" } },
    });
    const decoded = decodeRelayMessage(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "relay") return;
    expect(decoded.message.from).toBe("p7");
    expect(decoded.message.payload).toEqual({
      t: "intent",
      intent: { k: "choose", choiceId: "act:b_dictate_code" },
    });
  });

  it("round-trips the relay's refusals", () => {
    const raw = encode({ t: "relay_error", code: "room_has_tv", detail: "room ABCD already has a TV" });
    const decoded = decodeRelayMessage(raw);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "relay_error") return;
    expect(decoded.message.code).toBe("room_has_tv");
  });
});

describe("intents", () => {
  it("accepts a choice id and refuses an empty or oversized one", () => {
    expect(decodeIntent({ k: "choose", choiceId: "opt:2" })).toEqual({
      ok: true,
      message: { k: "choose", choiceId: "opt:2" },
    });
    expect(decodeIntent({ k: "choose", choiceId: "" })).toEqual({
      ok: false,
      reason: "choose.choiceId",
    });
    expect(decodeIntent({ k: "choose", choiceId: "x".repeat(201) })).toEqual({
      ok: false,
      reason: "choose.choiceId too long",
    });
  });

  it("de-duplicates a capability request and refuses an empty or unknown one", () => {
    expect(decodeIntent({ k: "request_input_change", capabilities: ["scan", "scan"] })).toEqual({
      ok: true,
      message: { k: "request_input_change", capabilities: ["scan"] },
    });
    expect(decodeIntent({ k: "request_input_change", capabilities: [] })).toEqual({
      ok: false,
      reason: "request_input_change.capabilities",
    });
    expect(decodeIntent({ k: "request_input_change", capabilities: ["scan", "smell"] })).toEqual({
      ok: false,
      reason: "request_input_change.capabilities",
    });
  });

  it("will not let a phone choose a role the puzzle does not have", () => {
    expect(decodeIntent({ k: "choose_role", role: "Z" })).toEqual({
      ok: false,
      reason: "choose_role.role",
    });
  });

  it("takes a phone's own seat, and refuses to invent one", () => {
    expect(decodeIntent({ k: "release_role" })).toEqual({ ok: true, message: { k: "release_role" } });
    // The shape `mintSeatId` produces, and the only one the wire carries.
    const token = "0123456789abcdef0123456789abcdef";
    const decoded = decodeGameMessage({ t: "join", seat: token });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "join") return;
    expect(decoded.message.seat).toBe(token);
    // A join with no seat at all is every phone's first message, and stays legal.
    expect(decodeGameMessage({ t: "join", name: "Ada" }).ok).toBe(true);
  });

  it("refuses a seat that is not the shape the phone mints", () => {
    for (const seat of ["seat-7", "0123456789ABCDEF0123456789abcdef", "0123456789abcdef", 7, null]) {
      expect(decodeGameMessage({ t: "join", seat })).toEqual({ ok: false, reason: "join.seat" });
    }
  });

  it("says it isn't my seat, and takes nothing with it", () => {
    expect(decodeIntent({ k: "release_claim" })).toEqual({ ok: true, message: { k: "release_claim" } });
  });

  it("takes a name to reclaim a held seat, and refuses a blank one", () => {
    expect(decodeIntent({ k: "reclaim_seat", name: "Bo" })).toEqual({
      ok: true,
      message: { k: "reclaim_seat", name: "Bo" },
    });
    expect(decodeIntent({ k: "reclaim_seat", name: "  " })).toEqual({
      ok: false,
      reason: "reclaim_seat.name",
    });
    expect(decodeIntent({ k: "reclaim_seat", name: "x".repeat(50) })).toEqual({
      ok: true,
      message: { k: "reclaim_seat", name: "x".repeat(24) },
    });
  });

  it("has no way to say \"I performed this action\"", () => {
    // The whole trust model in one assertion: a phone picks from what it was
    // shown, and the TV decides what the pick means.
    const forged = decodeIntent({ k: "perform", actionId: "any_enter_study" });
    expect(forged.ok).toBe(false);
  });
});

describe("game messages", () => {
  it("decodes `superseded`, a bare notice with no payload of its own", () => {
    const decoded = decodeGameMessage({ t: "superseded" });
    expect(decoded).toEqual({ ok: true, message: { t: "superseded" } });
  });

  it("trims a name and drops a role that is not one", () => {
    const decoded = decodeGameMessage({ t: "join", name: "x".repeat(50), want: "Q" });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "join") return;
    expect(decoded.message.name).toHaveLength(24);
    expect(decoded.message.want).toBeUndefined();
  });

  it("turns an unusable role on `assigned` into null rather than guessing", () => {
    const decoded = decodeGameMessage({ t: "assigned", role: "D", reason: "every role is taken" });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "assigned") return;
    expect(decoded.message.role).toBeNull();
    expect(decoded.message.reason).toBe("every role is taken");
  });

  it("refuses a phone view with more choices than the model can scan", () => {
    const view = phoneViewFixture();
    const decoded = decodeGameMessage({
      t: "view",
      view: { ...view, choices: fiveChoices() },
    });
    expect(decoded).toEqual({ ok: false, reason: "view: too many choices" });
  });

  it("accepts a phone view at the bound and strips what it cannot vouch for", () => {
    const view = phoneViewFixture();
    const decoded = decodeGameMessage({ t: "view", view: { ...view, canChangeInput: "yes" } });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "view") return;
    expect(decoded.message.view.choices).toHaveLength(4);
    expect(decoded.message.view.canChangeInput).toBe(false);
  });

  it("keeps the roles a phone may not take, and drops anything that is not one", () => {
    const view = phoneViewFixture();
    const decoded = decodeGameMessage({
      t: "view",
      view: { ...view, takenRoles: ["A", "Q", 7, "C"] },
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "view") return;
    expect(decoded.message.view.takenRoles).toEqual(["A", "C"]);
    expect(decoded.message.view.canChangeRole).toBe(true);
  });

  it("treats a missing role list as no role being taken, not as a refusal", () => {
    const view = phoneViewFixture();
    const { takenRoles: _dropped, ...withoutList } = view;
    const decoded = decodeGameMessage({ t: "view", view: { ...withoutList, canChangeRole: "yes" } });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "view") return;
    expect(decoded.message.view.takenRoles).toEqual([]);
    expect(decoded.message.view.canChangeRole).toBe(false);
  });

  it("keeps the roles that are held, not just taken, and drops anything that is not one", () => {
    const view = phoneViewFixture();
    const decoded = decodeGameMessage({
      t: "view",
      view: { ...view, heldRoles: ["B", "Q", 7] },
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "view") return;
    expect(decoded.message.view.heldRoles).toEqual(["B"]);
  });

  it("treats a missing held-role list as nothing being held, not as a refusal", () => {
    const view = phoneViewFixture();
    const { heldRoles: _dropped, ...withoutList } = view;
    const decoded = decodeGameMessage({ t: "view", view: withoutList });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.message.t !== "view") return;
    expect(decoded.message.view.heldRoles).toEqual([]);
  });

  it("refuses a switch whose diff is not a list of lines", () => {
    const decoded = decodeGameMessage({
      t: "switch",
      phase: "start",
      role: "C",
      capabilities: ["scan"],
      diff: [{ op: "capability_change" }],
    });
    expect(decoded).toEqual({ ok: false, reason: "switch.diff" });
  });
});

describe("paginateChoices", () => {
  const choices: Choice[] = Array.from({ length: 6 }, (_, i) => ({
    id: `act:a${i}`,
    label: `action ${i}`,
  }));

  it("leaves a short list exactly as it is", () => {
    expect(paginateChoices(choices.slice(0, 4))).toEqual(choices.slice(0, 4));
  });

  it("spends the last slot on More rather than dropping options silently", () => {
    const page = paginateChoices(choices);
    expect(page).toHaveLength(4);
    expect(page[3]?.id).toBe(MORE_CHOICE_ID);
    expect(page[3]?.hint).toBe("3 more");
  });

  it("returns nothing when there is no room for anything", () => {
    expect(paginateChoices(choices, 0)).toEqual([]);
  });
});

function fiveChoices(): Choice[] {
  return Array.from({ length: 5 }, (_, i) => ({ id: `act:x${i}`, label: `x${i}` }));
}

function phoneViewFixture(): PhoneView {
  return {
    role: "C",
    capabilities: ["scan"],
    mode: "scan",
    prompt: "Your move",
    clues: [{ id: "desk_drawer_note", text: "The dial only turns for one family: the river." }],
    choices: fiveChoices().slice(0, 4),
    choiceKind: "action",
    badge: null,
    takenRoles: ["A", "B"],
    heldRoles: [],
    seatRoles: ["A", "B", "C"],
    canChangeInput: true,
    canChangeRole: true,
    claimingSeat: false,
    otherTabRole: null,
  };
}
