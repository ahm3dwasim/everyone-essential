/**
 * The relay: rooms, and who is allowed to send what to whom.
 *
 * It is driven through an injected socket, so nothing here opens a port. What is
 * being tested is the routing table and the refusals -- in particular that the
 * sender of a forwarded payload is stamped from the connection and never read
 * off the frame.
 */
import { describe, expect, it } from "vitest";
import { Relay, type Socket } from "../app/relay/src/relay.ts";
import {
  PROTOCOL_VERSION,
  ROOM_TOMBSTONE_MS,
  decodeRelayMessage,
  encode,
  type RelayToClient,
} from "../app/shared/protocol.ts";

class FakeSocket implements Socket {
  readonly sent: RelayToClient[] = [];
  /** The frames exactly as they went out. Decoding drops what it does not
   * know, so a field the relay leaks but this protocol has no name for would
   * be invisible in `sent` -- and a leak is the thing some of these cases are
   * looking for. */
  readonly raw: string[] = [];
  send(data: string): void {
    const decoded = decodeRelayMessage(data);
    if (!decoded.ok) throw new Error(`the relay sent something undecodable: ${decoded.reason}`);
    this.raw.push(data);
    this.sent.push(decoded.message);
  }
  last(): RelayToClient | undefined {
    return this.sent[this.sent.length - 1];
  }
  types(): string[] {
    return this.sent.map((message) => message.t);
  }
}

/**
 * A relay whose room codes are predictable: `random` is also spent on peer ids,
 * so the only value that gives a fixed code without also fixing the ids is 0,
 * which names every room AAAA.
 */
function fixedCodes(): () => number {
  return () => 0;
}

function hello(relay: Relay, socket: FakeSocket, body: Record<string, unknown>): string {
  const client = relay.add(socket);
  relay.receive(client.id, encode({ t: "hello", v: PROTOCOL_VERSION, ...body } as never));
  return client.id;
}

describe("joining", () => {
  it("gives a TV that names no room a fresh code, and tells it who is there", () => {
    const relay = new Relay({ random: fixedCodes() });
    const socket = new FakeSocket();
    hello(relay, socket, { kind: "tv" });
    const welcome = socket.sent[0];
    expect(welcome?.t).toBe("welcome");
    if (welcome?.t !== "welcome") return;
    expect(welcome.room).toBe("AAAA");
    expect(welcome.peers).toEqual([{ peerId: welcome.peerId, kind: "tv" }]);
  });

  it("tells the TV when a phone arrives, and the phone who else is there", () => {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    hello(relay, tv, { kind: "tv" });
    const room = tv.sent[0]?.t === "welcome" ? tv.sent[0].room : "";

    const phone = new FakeSocket();
    const phoneId = hello(relay, phone, { kind: "phone", room, name: "Sam" });
    const welcome = phone.sent[0];
    expect(welcome?.t === "welcome" && welcome.peers).toHaveLength(2);
    expect(tv.types()).toEqual(["welcome", "peer_joined"]);
    const joined = tv.last();
    expect(joined?.t === "peer_joined" && joined.peer).toEqual({
      peerId: phoneId,
      kind: "phone",
      name: "Sam",
    });
  });

  it("refuses a second TV in the same room", () => {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    hello(relay, tv, { kind: "tv" });
    const room = tv.sent[0]?.t === "welcome" ? tv.sent[0].room : "";

    const other = new FakeSocket();
    hello(relay, other, { kind: "tv", room });
    const error = other.last();
    expect(error?.t).toBe("relay_error");
    expect(error?.t === "relay_error" && error.code).toBe("room_has_tv");
  });

  it("sends a phone to a room that does not exist back to the TV to read the code again", () => {
    const relay = new Relay({ random: fixedCodes() });
    const phone = new FakeSocket();
    hello(relay, phone, { kind: "phone", room: "ZZZZ" });
    const error = phone.last();
    expect(error?.t === "relay_error" && error.code).toBe("unknown_room");
  });

  it("refuses a code that is not four letters", () => {
    const relay = new Relay({ random: fixedCodes() });
    const phone = new FakeSocket();
    hello(relay, phone, { kind: "phone", room: "AB" });
    expect(phone.last()?.t === "relay_error" && phone.last()).toMatchObject({ code: "bad_room" });
  });

  it("refuses a client that speaks a different version", () => {
    const relay = new Relay({ random: fixedCodes() });
    const socket = new FakeSocket();
    hello(relay, socket, { kind: "tv", v: PROTOCOL_VERSION + 1 });
    expect(socket.last()).toMatchObject({ t: "relay_error", code: "version" });
  });

  it("refuses a hello from the version this protocol has left behind", () => {
    const relay = new Relay({ random: fixedCodes() });
    const socket = new FakeSocket();
    // Version 1 is the one where a hello's credential was not read at all: a
    // relay that answers it would be handing a room to whoever named it.
    hello(relay, socket, { kind: "tv", v: PROTOCOL_VERSION - 1 });
    expect(socket.last()).toMatchObject({ t: "relay_error", code: "version" });
    expect(socket.types()).not.toContain("welcome");
    expect(relay.rooms_()).toEqual([]);
  });

  it("refuses a second hello from the same connection", () => {
    const relay = new Relay({ random: fixedCodes() });
    const socket = new FakeSocket();
    const id = hello(relay, socket, { kind: "tv" });
    relay.receive(id, encode({ t: "hello", v: PROTOCOL_VERSION, kind: "phone", room: "AAAA" }));
    expect(socket.last()).toMatchObject({ t: "relay_error", code: "malformed" });
  });

  it("refuses to route for a client that has not said hello yet", () => {
    const relay = new Relay({ random: fixedCodes() });
    const socket = new FakeSocket();
    const client = relay.add(socket);
    relay.receive(client.id, encode({ t: "relay", to: "tv", payload: { t: "join" } }));
    expect(socket.last()).toMatchObject({ t: "relay_error", code: "malformed" });
  });
});

describe("routing", () => {
  function room() {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    const tvId = hello(relay, tv, { kind: "tv" });
    const code = tv.sent[0]?.t === "welcome" ? tv.sent[0].room : "";
    const a = new FakeSocket();
    const aId = hello(relay, a, { kind: "phone", room: code });
    const b = new FakeSocket();
    const bId = hello(relay, b, { kind: "phone", room: code });
    return { relay, tv, tvId, a, aId, b, bId };
  }

  it("forwards to the TV and stamps the real sender", () => {
    const { relay, tv, aId, a } = room();
    relay.receive(aId, encode({ t: "relay", to: "tv", payload: { t: "intent", intent: { k: "choose", choiceId: "act:x" } } }));
    const envelope = tv.last();
    expect(envelope?.t).toBe("relay");
    if (envelope?.t !== "relay") return;
    expect(envelope.from).toBe(aId);
    expect(envelope.payload).toEqual({ t: "intent", intent: { k: "choose", choiceId: "act:x" } });
    expect(a.types()).toEqual(["welcome", "peer_joined"]);
  });

  it("ignores a sender the frame claims, and uses the connection's own id", () => {
    const { relay, tv, aId } = room();
    relay.receive(
      aId,
      JSON.stringify({
        t: "relay",
        from: "somebody-else",
        to: "tv",
        payload: { t: "join" },
      }),
    );
    const envelope = tv.last();
    expect(envelope?.t === "relay" && envelope.from).toBe(aId);
  });

  it("broadcasts the TV's message to everyone but itself", () => {
    const { relay, tvId, a, b } = room();
    relay.receive(tvId, encode({ t: "relay", to: "all", payload: { t: "join" } }));
    expect(a.last()).toMatchObject({ t: "relay", from: tvId });
    expect(b.last()).toMatchObject({ t: "relay", from: tvId });
  });

  it("delivers the TV's direct message to one peer in the room, and to nobody else", () => {
    const { relay, tvId, b, a, bId } = room();
    const before = a.sent.length;
    relay.receive(tvId, encode({ t: "relay", to: bId, payload: { t: "join" } }));
    expect(a.sent).toHaveLength(before);
    expect(b.last()).toMatchObject({ t: "relay", from: tvId, to: bId });
  });

  it("delivers the TV's superseded notice to exactly the peer it names, never broadcast to the room", () => {
    const { relay, tvId, a, aId, b, bId } = room();
    relay.receive(tvId, encode({ t: "relay", to: aId, payload: { t: "superseded" } }));
    expect(a.last()).toMatchObject({ t: "relay", from: tvId, to: aId, payload: { t: "superseded" } });
    // B, the peer this notice does not name, never sees it at all.
    expect(b.sent.some((m) => m.t === "relay" && m.payload.t === "superseded")).toBe(false);
  });

  it("refuses a TV that addresses itself, and a peer that addresses itself", () => {
    const { relay, tvId, tv, aId, a } = room();
    relay.receive(tvId, encode({ t: "relay", to: "tv", payload: { t: "join" } }));
    expect(tv.last()).toMatchObject({ t: "relay_error", code: "malformed" });
    relay.receive(aId, encode({ t: "relay", to: aId, payload: { t: "join" } }));
    expect(a.last()).toMatchObject({ t: "relay_error", code: "malformed" });
  });

  it("refuses an address that is not in this room", () => {
    const { relay, tvId, tv } = room();
    relay.receive(tvId, encode({ t: "relay", to: "p99-nobody", payload: { t: "join" } }));
    expect(tv.last()).toMatchObject({ t: "relay_error", code: "malformed" });
  });

  it("refuses a phone that addresses another phone directly -- a forged superseded included", () => {
    const { relay, aId, a, b, bId } = room();
    const before = b.sent.length;
    relay.receive(aId, encode({ t: "relay", to: bId, payload: { t: "superseded" } }));
    expect(b.sent).toHaveLength(before);
    expect(a.last()).toMatchObject({ t: "relay_error", code: "malformed" });
  });

  it("refuses a phone that broadcasts to the room", () => {
    const { relay, aId, a, b, tv } = room();
    const beforeB = b.sent.length;
    const beforeTv = tv.sent.length;
    relay.receive(aId, encode({ t: "relay", to: "all", payload: { t: "join" } }));
    expect(b.sent).toHaveLength(beforeB);
    expect(tv.sent).toHaveLength(beforeTv);
    expect(a.last()).toMatchObject({ t: "relay_error", code: "malformed" });
  });

  it("tells a phone there is no TV yet rather than dropping the message, under a code of its own", () => {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    hello(relay, tv, { kind: "tv" });
    const code = tv.sent[0]?.t === "welcome" ? tv.sent[0].room : "";
    const phone = new FakeSocket();
    const phoneId = hello(relay, phone, { kind: "phone", room: code });
    // The TV drops out; the phone keeps talking.
    relay.remove(tv.sent[0]?.t === "welcome" ? tv.sent[0].peerId : "");
    relay.receive(phoneId, encode({ t: "relay", to: "tv", payload: { t: "join" } }));
    // Not `unknown_room`: the room is live and this phone is in it. The code
    // is what lets a phone tell the TV stepping out from the room being gone.
    expect(phone.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
  });
});

describe("leaving", () => {
  it("tells the room, and forgets a room once it is empty", () => {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    const tvId = hello(relay, tv, { kind: "tv" });
    const code = tv.sent[0]?.t === "welcome" ? tv.sent[0].room : "";
    const phone = new FakeSocket();
    const phoneId = hello(relay, phone, { kind: "phone", room: code });

    relay.remove(phoneId);
    expect(tv.last()).toEqual({ t: "peer_left", peerId: phoneId });
    expect(relay.rooms_()).toEqual([code]);

    relay.remove(tvId);
    expect(relay.rooms_()).toEqual([]);
  });

  it("does nothing for a client that was never there", () => {
    const relay = new Relay({ random: fixedCodes() });
    expect(relay.remove("p0-ghost")).toEqual([]);
  });
});

describe("capacity", () => {
  it("refuses the peer after the cap", () => {
    const relay = new Relay({ random: fixedCodes(), maxPeersPerRoom: 2 });
    const tv = new FakeSocket();
    hello(relay, tv, { kind: "tv" });
    const code = tv.sent[0]?.t === "welcome" ? tv.sent[0].room : "";
    const first = new FakeSocket();
    hello(relay, first, { kind: "phone", room: code });
    const second = new FakeSocket();
    hello(relay, second, { kind: "phone", room: code });
    expect(second.last()).toMatchObject({ t: "relay_error", code: "too_many_peers" });
  });

  it("gives up honestly when every code it tries is taken", () => {
    const relay = new Relay({ random: () => 0, roomCodeAttempts: 2 });
    const first = new FakeSocket();
    hello(relay, first, { kind: "tv" });
    const second = new FakeSocket();
    hello(relay, second, { kind: "tv" });
    expect(second.last()).toMatchObject({ t: "relay_error", code: "bad_room" });
  });
});

/**
 * Host custody: a room belongs to the connection that made it, not to whoever
 * can read the four letters off the TV screen.
 *
 * The room code is public by design -- it is on the screen and in the join
 * link -- so knowing it can never be what makes a socket the TV. When a room
 * is created the relay mints an opaque credential for it and puts it in that
 * TV's own `welcome`, and a later `kind: "tv"` hello naming an existing room
 * is accepted only from a connection that presents it. Without this a TV that
 * dropped left `tv = null` behind, and any socket that knew the code could
 * take the room, inherit the phones' trust and drive them.
 */
describe("host custody", () => {
  /** A room with a live TV and one phone in it, and the TV's own welcome. */
  function hosted() {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    const tvId = hello(relay, tv, { kind: "tv" });
    const welcome = tv.sent[0];
    if (welcome?.t !== "welcome") throw new Error("the TV was not given a room");
    const phone = new FakeSocket();
    const phoneId = hello(relay, phone, { kind: "phone", room: welcome.room });
    return { relay, tv, tvId, welcome, phone, phoneId };
  }

  it("refuses a replacement TV that presents no credential, and the phones hear nothing from it", () => {
    const { relay, tvId, welcome, phone, phoneId } = hosted();
    // The real TV's connection goes away, and the room stays behind with no TV.
    relay.remove(tvId);

    const attacker = new FakeSocket();
    const attackerId = hello(relay, attacker, { kind: "tv", room: welcome.room });
    expect(attacker.last()).toMatchObject({ t: "relay_error" });
    expect(attacker.types()).not.toContain("welcome");

    // Refused a welcome means no room, so the forged TV-only control has no
    // standing to travel on either.
    const before = phone.sent.length;
    relay.receive(attackerId, encode({ t: "relay", to: phoneId, payload: { t: "superseded" } }));
    expect(phone.sent).toHaveLength(before);
  });

  it("refuses a replacement TV that presents a credential the room never issued", () => {
    const { relay, tvId, welcome, phone, phoneId } = hosted();
    relay.remove(tvId);

    const attacker = new FakeSocket();
    const attackerId = hello(relay, attacker, {
      kind: "tv",
      room: welcome.room,
      hostToken: "0".repeat(64),
    });
    expect(attacker.last()).toMatchObject({ t: "relay_error" });
    expect(attacker.types()).not.toContain("welcome");

    const before = phone.sent.length;
    relay.receive(attackerId, encode({ t: "relay", to: phoneId, payload: { t: "superseded" } }));
    expect(phone.sent).toHaveLength(before);
  });

  it("lets the room's own TV come back with the credential it was given, and the phones take it back", () => {
    const { relay, tv, tvId, welcome, phone, phoneId } = hosted();
    expect(welcome.hostToken).toMatch(/^[0-9a-f]{64}$/);
    const token = welcome.hostToken as string;

    relay.remove(tvId);
    expect(phone.last()).toMatchObject({ t: "peer_left", peerId: tvId });

    const again = new FakeSocket();
    const againId = hello(relay, again, { kind: "tv", room: welcome.room, hostToken: token });
    const back = again.sent[0];
    expect(back?.t).toBe("welcome");
    if (back?.t !== "welcome") return;
    // The same room, so the phones that stayed are the TV's own again.
    expect(back.room).toBe(welcome.room);
    // The return spends what it presented: the welcome for a TV always
    // carries a fresh credential, so what the room is known by from here on
    // is not what was on the wire a moment ago.
    expect(back.hostToken).toMatch(/^[0-9a-f]{64}$/);
    expect(back.hostToken).not.toBe(token);
    // And the phones are told, in the one field a phone cannot forge.
    expect(phone.last()).toMatchObject({ t: "peer_joined", peer: { kind: "tv", peerId: againId } });

    const before = phone.sent.length;
    relay.receive(againId, encode({ t: "relay", to: phoneId, payload: { t: "superseded" } }));
    expect(phone.sent).toHaveLength(before + 1);
    expect(phone.last()).toMatchObject({ t: "relay", from: againId, payload: { t: "superseded" } });
  });

  it("never shows the room's credential in any message a phone receives", () => {
    const { relay, tvId, welcome, phone } = hosted();
    const token = welcome.hostToken as string;
    expect(typeof token).toBe("string");

    // Every path a phone can be on the receiving end of: the TV arriving,
    // leaving, coming back, and addressing the room.
    relay.remove(tvId);
    const again = new FakeSocket();
    const againId = hello(relay, again, { kind: "tv", room: welcome.room, hostToken: token });
    relay.receive(againId, encode({ t: "relay", to: "all", payload: { t: "superseded" } }));

    expect(phone.raw.length).toBeGreaterThan(0);
    for (const frame of phone.raw) expect(frame).not.toContain(token);
    // The other direction too: the room's own peers list never carries it.
    for (const peer of welcome.peers) expect(JSON.stringify(peer)).not.toContain(token);
  });
});

/**
 * A room that empties is not a room that is gone.
 *
 * Deleting it outright deleted the only copy of its credential with it, so the
 * four letters off the screen were enough to make the room again and be
 * welcomed as its TV -- which is the an earlier version fix undone by a network blip
 * rather than by a mistake in it. What an emptied room leaves behind is a
 * tombstone: the code, the digest of the credential that was live when the
 * last peer left, and a deadline. Inside that window the room is still its
 * own TV's to come back to and nobody else's to make; after it, the room is
 * forgotten and the code is a free code again.
 */
describe("a room that empties is remembered while its people come back", () => {
  /** A relay whose clock this test owns, so the window can be spent. */
  function clocked() {
    let now = 1_000_000;
    const relay = new Relay({ random: fixedCodes(), now: () => now });
    return {
      relay,
      spend: (ms: number) => {
        now += ms;
      },
    };
  }

  /** A room with a live TV and one phone in it, and the credential the TV was handed. */
  function occupied(relay: Relay) {
    const tv = new FakeSocket();
    const tvId = hello(relay, tv, { kind: "tv" });
    const welcome = tv.sent[0];
    if (welcome?.t !== "welcome" || welcome.hostToken === undefined) {
      throw new Error("the TV was not given a room");
    }
    const phone = new FakeSocket();
    const phoneId = hello(relay, phone, { kind: "phone", room: welcome.room });
    return { tvId, welcome, hostToken: welcome.hostToken, phoneId };
  }

  it("refuses a code-only impostor after the last peer drops, and reaches nobody in the room", () => {
    const { relay } = clocked();
    const { tvId, phoneId, welcome, hostToken } = occupied(relay);
    // One network loss closes every socket in the room.
    relay.remove(tvId);
    relay.remove(phoneId);
    expect(relay.rooms_()).toEqual([]);

    const impostor = new FakeSocket();
    const impostorId = hello(relay, impostor, { kind: "tv", room: welcome.room });
    expect(impostor.last()).toMatchObject({ t: "relay_error", code: "not_the_tv" });
    expect(impostor.types()).not.toContain("welcome");

    // The room's own TV comes back first, and is told about nobody else --
    // there is no impostor in the room to be told about.
    const returning = new FakeSocket();
    hello(relay, returning, { kind: "tv", room: welcome.room, hostToken });
    expect(returning.types()).toEqual(["welcome"]);

    // And the impostor, refused a welcome, has no room to speak from, so
    // nothing it sends reaches the phones that come back.
    const returningPhone = new FakeSocket();
    const returningPhoneId = hello(relay, returningPhone, { kind: "phone", room: welcome.room });
    const before = returningPhone.sent.length;
    relay.receive(
      impostorId,
      encode({ t: "relay", to: returningPhoneId, payload: { t: "superseded" } }),
    );
    expect(returningPhone.sent).toHaveLength(before);
  });

  it("refuses a returning phone while the room waits for its TV", () => {
    const { relay } = clocked();
    const { tvId, phoneId, welcome } = occupied(relay);
    relay.remove(tvId);
    relay.remove(phoneId);

    const phone = new FakeSocket();
    hello(relay, phone, { kind: "phone", room: welcome.room });
    // Still not seated -- a welcome here would put the phone in a room whose
    // only other occupant would be whoever asks next, which is the thing being
    // refused. But the room is not gone: it is resting, and its own TV can
    // still come back to it. So the phone is told what a phone is told when a
    // room has no TV in it, which is what it is: wait.
    expect(phone.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
    expect(phone.types()).not.toContain("welcome");
  });

  it("lets the room's own TV come back with its credential after the last peer drops", () => {
    const { relay } = clocked();
    const { tvId, phoneId, welcome, hostToken } = occupied(relay);
    relay.remove(tvId);
    relay.remove(phoneId);

    const again = new FakeSocket();
    hello(relay, again, { kind: "tv", room: welcome.room, hostToken });
    const back = again.sent[0];
    expect(back?.t).toBe("welcome");
    if (back?.t !== "welcome") return;
    expect(back.room).toBe(welcome.room);

    // The room is a room again: a phone that had the code all along lands in
    // the one its TV is in, rather than being told there is no such room.
    const phone = new FakeSocket();
    hello(relay, phone, { kind: "phone", room: welcome.room });
    expect(phone.last()).toMatchObject({ t: "welcome", room: welcome.room });
  });

  it("forgets the room once the reconnect window has passed", () => {
    const { relay, spend } = clocked();
    const { tvId, phoneId, welcome, hostToken } = occupied(relay);
    relay.remove(tvId);
    relay.remove(phoneId);
    expect(relay.tombstones_()).toEqual([welcome.room]);

    spend(ROOM_TOMBSTONE_MS + 1);

    expect(relay.tombstones_()).toEqual([]);
    const phone = new FakeSocket();
    hello(relay, phone, { kind: "phone", room: welcome.room });
    expect(phone.last()).toMatchObject({ t: "relay_error", code: "unknown_room" });

    // And the credential stands for nothing any more: the code is a free code
    // again, and the room a TV is given at it is a new room with a new
    // credential rather than the room this TV left behind.
    const fresh = new FakeSocket();
    hello(relay, fresh, { kind: "tv", room: welcome.room, hostToken });
    const made = fresh.sent[0];
    expect(made?.t).toBe("welcome");
    if (made?.t !== "welcome") return;
    expect(made.hostToken).not.toBe(hostToken);
  });

  it("does not give a remembered code to a new room", () => {
    const { relay } = clocked();
    const { tvId, phoneId, welcome } = occupied(relay);
    expect(welcome.room).toBe("AAAA");
    relay.remove(tvId);
    relay.remove(phoneId);

    // Every code this relay generates is `AAAA` (see `fixedCodes`), so a TV
    // asking to be given a room and getting one would mean the remembered
    // code had been handed to a room that is not the one it belongs to.
    const other = new FakeSocket();
    hello(relay, other, { kind: "tv" });
    expect(other.last()).toMatchObject({ t: "relay_error", code: "bad_room" });
    expect(relay.rooms_()).toEqual([]);
  });
});

/**
 * One credential, one use.
 *
 * A room's credential is the only thing that makes a connection its TV, and a
 * welcome for a TV is the one place it travels. If the same one came back
 * every time, a credential read off the wire would keep working for as long as
 * the room lived. Instead every welcome a TV gets carries a new one and the
 * relay keeps only the digest of the newest, so the one that was just spent
 * stops opening the room at the moment the room's own TV resumes with it.
 */
describe("the room's credential is single-use", () => {
  it("hands a returning TV a fresh credential every time, and retires the one it presented", () => {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    const tvId = hello(relay, tv, { kind: "tv" });
    const first = tv.sent[0];
    if (first?.t !== "welcome" || first.hostToken === undefined) {
      throw new Error("the TV was not given a room");
    }
    const retired = first.hostToken;
    const phone = new FakeSocket();
    hello(relay, phone, { kind: "phone", room: first.room });
    relay.remove(tvId);

    const again = new FakeSocket();
    const againId = hello(relay, again, { kind: "tv", room: first.room, hostToken: retired });
    const second = again.sent[0];
    if (second?.t !== "welcome" || second.hostToken === undefined) {
      throw new Error("the returning TV was not given its room");
    }
    expect(second.hostToken).not.toBe(retired);

    // That TV goes away, and the room lives on with its phone in it, so the
    // next claim to be its TV is answered on the credential alone.
    relay.remove(againId);

    // The one that opened this room a moment ago is spent.
    const spent = new FakeSocket();
    hello(relay, spent, { kind: "tv", room: first.room, hostToken: retired });
    expect(spent.last()).toMatchObject({ t: "relay_error", code: "not_the_tv" });
    expect(spent.types()).not.toContain("welcome");

    // And the newest is live, and is itself spent by being used.
    const third = new FakeSocket();
    hello(relay, third, { kind: "tv", room: first.room, hostToken: second.hostToken });
    const back = third.sent[0];
    expect(back?.t).toBe("welcome");
    if (back?.t !== "welcome") return;
    expect(back.hostToken).not.toBe(second.hostToken);
  });

  it("never shows either credential to a phone", () => {
    const relay = new Relay({ random: fixedCodes() });
    const tv = new FakeSocket();
    const tvId = hello(relay, tv, { kind: "tv" });
    const first = tv.sent[0];
    if (first?.t !== "welcome" || first.hostToken === undefined) {
      throw new Error("the TV was not given a room");
    }
    const retired = first.hostToken;
    const phone = new FakeSocket();
    const phoneId = hello(relay, phone, { kind: "phone", room: first.room });
    relay.remove(tvId);

    const again = new FakeSocket();
    const againId = hello(relay, again, { kind: "tv", room: first.room, hostToken: retired });
    const second = again.sent[0];
    if (second?.t !== "welcome" || second.hostToken === undefined) {
      throw new Error("the returning TV was not given its room");
    }
    const live = second.hostToken;
    relay.receive(againId, encode({ t: "relay", to: "all", payload: { t: "superseded" } }));
    relay.receive(againId, encode({ t: "relay", to: phoneId, payload: { t: "superseded" } }));

    // Every frame a phone is on the receiving end of, as it went out: the
    // welcome that seated it, the room's news that its TV came back, and the
    // TV's own messages. Neither credential is in any of them.
    expect(phone.raw.length).toBeGreaterThan(2);
    for (const frame of phone.raw) {
      expect(frame).not.toContain(retired);
      expect(frame).not.toContain(live);
    }
  });
});
