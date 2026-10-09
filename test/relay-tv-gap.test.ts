/**
 * What a room with no TV in it says, and what it says when the TV comes back.
 *
 * A TV that drops off Wi-Fi leaves the room live: the phones in it are still
 * connected, and the relay still has a room for them. Everything they send to
 * the TV in that window is refused with `no_tv_yet` -- "no TV in this room
 * yet" -- which is the room waiting for its TV, not a refusal of the phone.
 *
 * That code is the whole of the distinction, and it is deliberately a code of
 * its own. `unknown_room` means the room does not exist: a relay that
 * restarted has forgotten it, and the phone that was in it has no seat to
 * wait on. While both were `unknown_room` a phone could not tell the two
 * apart from the wire, and a restarted relay looked exactly like a TV that
 * had stepped out -- so it waited for a room that was never coming back.
 *
 * What the phone does with a refusal is `app/phone/src/app.tsx`'s business;
 * what is pinned here is the relay behaviour it rests on, so the phone's own
 * reading of the wire cannot drift away from what the wire actually says.
 */
import { describe, expect, it } from "vitest";
import { Relay, type Socket } from "../app/relay/src/relay.ts";
import {
  PROTOCOL_VERSION,
  decodeRelayMessage,
  encode,
  type RelayToClient,
} from "../app/shared/protocol.ts";

const SEAT_B = "0123456789abcdef0123456789abcdef";

class FakeSocket implements Socket {
  readonly sent: RelayToClient[] = [];
  send(data: string): void {
    const decoded = decodeRelayMessage(data);
    if (!decoded.ok) throw new Error(`the relay sent something undecodable: ${decoded.reason}`);
    this.sent.push(decoded.message);
  }
  last(): RelayToClient | undefined {
    return this.sent[this.sent.length - 1];
  }
  types(): string[] {
    return this.sent.map((message) => message.t);
  }
}

/** A relay whose room codes are predictable: `random() == 0` names every room AAAA. */
function relay(): Relay {
  return new Relay({ random: () => 0 });
}

function hello(relay: Relay, socket: FakeSocket, body: Record<string, unknown>): string {
  const client = relay.add(socket);
  relay.receive(client.id, encode({ t: "hello", v: PROTOCOL_VERSION, ...body } as never));
  return client.id;
}

/** A room with a TV and two phones in it. */
function roomWithTwoPhones() {
  const relayInstance = relay();
  const tvSocket = new FakeSocket();
  const tv = hello(relayInstance, tvSocket, { kind: "tv" });
  const room = tvSocket.sent[0]!.t === "welcome" ? tvSocket.sent[0]!.room : "";
  const bSocket = new FakeSocket();
  const b = hello(relayInstance, bSocket, { kind: "phone", room });
  return { relay: relayInstance, tv, tvSocket, room, b, bSocket };
}

describe("a phone in a room whose TV has gone", () => {
  it("is refused with 'no TV in this room yet' -- not with a room that is gone", () => {
    const { relay: r, tv, room, b, bSocket } = roomWithTwoPhones();
    r.remove(tv);

    r.receive(b, encode({ t: "relay", to: "tv", payload: { t: "join", seat: SEAT_B } } as never));

    const refusal = bSocket.last();
    expect(refusal).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
    // The room is still there -- this phone is still in it -- so the refusal
    // can only be about the TV. Anything else would be a room to give up on,
    // and the code this arrives under is what says which of the two it is:
    // `unknown_room` here would be a phone sent to the join screen over a TV
    // that has only stepped out.
    expect(refusal?.t === "relay_error" ? refusal.code : "").not.toBe("unknown_room");
    expect(refusal?.t === "relay_error" ? refusal.detail : "").toContain("no TV in this room yet");
    expect(r.rooms_()).toEqual([room]);
  });

  it("is told a different code than a room that does not exist", () => {
    // The two refusals are the two states, and the code is the only thing
    // that carries the difference to the phone: this room is here and has no
    // TV, versus there is no such room at all. If both were one code the
    // phone would have to guess, and the guess it can make from its own side
    // -- "I was in a room once" -- is about its past, not the room's present.
    const { relay: r, tv, b, bSocket } = roomWithTwoPhones();
    r.remove(tv);
    r.receive(b, encode({ t: "relay", to: "tv", payload: { t: "join" } } as never));
    expect(bSocket.last()).toMatchObject({ code: "no_tv_yet" });

    const strangerSocket = new FakeSocket();
    hello(r, strangerSocket, { kind: "phone", room: "ZZZZ" });
    expect(strangerSocket.last()).toMatchObject({ code: "unknown_room" });
  });

  it("is still welcomed back into the room, with a peer list that names no TV", () => {
    const { relay: r, tv, room, b } = roomWithTwoPhones();
    r.remove(tv);
    // The phone reconnects on a fresh socket while the gap is still open. Its
    // hello names the room, and the room takes it: nothing about this is a
    // refusal, and the welcome is the phone's own evidence of that.
    const backSocket = new FakeSocket();
    const back = hello(r, backSocket, { kind: "phone", room });

    const welcome = backSocket.sent[0];
    expect(welcome?.t).toBe("welcome");
    expect(welcome?.t === "welcome" ? welcome.peers.filter((peer) => peer.kind === "tv") : [null]).toEqual([]);
    // And the `join` it sends on that welcome -- the same message a phone
    // always sends -- is refused exactly like the first one, because the
    // room still has no TV to deliver it to.
    r.receive(back, encode({ t: "relay", to: "tv", payload: { t: "join", seat: SEAT_B } } as never));
    expect(backSocket.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
  });

  it("tells the phones in the room when the TV comes back", () => {
    const { relay: r, tv, tvSocket, room, bSocket } = roomWithTwoPhones();
    const first = tvSocket.sent[0]!;
    expect(first.t).toBe("welcome");
    const credential = first.t === "welcome" ? first.hostToken : undefined;
    expect(credential).toBeDefined();
    // The TV's socket drops; its own room is still live, so it comes back to
    // the same code with the credential that room issued it.
    r.remove(tv);
    const returningSocket = new FakeSocket();
    hello(r, returningSocket, { kind: "tv", room, hostToken: credential });

    expect(returningSocket.types()).toContain("welcome");
    // This is the phone's signal that the gap is over: the TV is a peer in
    // the room again, announced on the ordinary peer list.
    const joined = bSocket.sent.filter((message) => message.t === "peer_joined");
    expect(joined.at(-1)).toMatchObject({ t: "peer_joined", peer: { kind: "tv" } });
  });
});
