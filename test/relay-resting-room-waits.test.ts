/**
 * A room resting in its tombstone window is a WAIT, not a room that is gone.
 *
 * An emptied room is not deleted: it is remembered for `ROOM_TOMBSTONE_MS` so
 * its own TV can come back to it with the credential it holds, and so nobody
 * else can make the room at a code that is on a screen the whole family can
 * read. The TV coming back through that window is the ordinary case the
 * window exists for -- and the phone that was in the room reconnects inside
 * the same window, because one network loss closed every socket in it.
 *
 * A phone refused `unknown_room` here is told the same thing the relay says
 * for a code that names nothing at all, and it cannot tell the two apart from
 * its own memory: it keeps the room code it was admitted with, exactly so an
 * ordinary blip returns it to the same room. Its only reading of
 * `unknown_room` is "the game has ended on the TV", so it clears its room and
 * leaves -- while the TV comes back to the room, with that player's seat still
 * held, and plays on without them.
 *
 * The code on the wire is the only thing that can carry the difference, and
 * it already has a word for it: `no_tv_yet` is the room waiting for its TV.
 * A resting room is exactly that. `unknown_room` goes back to meaning what it
 * says -- a code that names nothing.
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

function relay(): Relay {
  return new Relay({ random: () => 0 });
}

function hello(relay: Relay, socket: FakeSocket, body: Record<string, unknown>): string {
  const client = relay.add(socket);
  relay.receive(client.id, encode({ t: "hello", v: PROTOCOL_VERSION, ...body } as never));
  return client.id;
}

/** A room with a TV and one phone in it, and everything needed to empty it. */
function occupied(relay: Relay) {
  const tvSocket = new FakeSocket();
  const tv = hello(relay, tvSocket, { kind: "tv" });
  const welcome = tvSocket.sent[0];
  if (welcome?.t !== "welcome") throw new Error("the TV was not given a room");
  const phoneSocket = new FakeSocket();
  const phone = hello(relay, phoneSocket, { kind: "phone", room: welcome.room });
  return { tv, phone, room: welcome.room, hostToken: welcome.hostToken! };
}

describe("a phone that comes back while its room rests in its tombstone window", () => {
  it("is told the room has no TV yet, not that the room is gone", () => {
    const r = relay();
    const { tv, phone, room } = occupied(r);
    // One network loss closes every socket in the room, so the room empties
    // and rests. Its TV can still come back to it; so can this phone.
    r.remove(tv);
    r.remove(phone);
    expect(r.rooms_()).toEqual([]);
    expect(r.tombstones_()).toEqual([room]);

    const back = new FakeSocket();
    hello(r, back, { kind: "phone", room });
    expect(back.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
    // It is still not seated -- there is nobody in the room to seat it next
    // to, and seating it would be seating it next to whoever makes the room
    // again. Waiting is what it is told to do, and waiting is what it does.
    expect(back.types()).not.toContain("welcome");
  });

  it("is seated again, in the same room, once the room's own TV comes back", () => {
    const r = relay();
    const { tv, phone, room, hostToken } = occupied(r);
    r.remove(tv);
    r.remove(phone);

    const returningTv = new FakeSocket();
    hello(r, returningTv, { kind: "tv", room, hostToken });
    expect(returningTv.last()).toMatchObject({ t: "welcome", room });

    const back = new FakeSocket();
    hello(r, back, { kind: "phone", room });
    expect(back.last()).toMatchObject({ t: "welcome", room });
  });

  it("is told the room is gone once the window has passed, because then it is", () => {
    let now = 1_000_000;
    const r = new Relay({ random: () => 0, now: () => now });
    const { tv, phone, room } = occupied(r);
    r.remove(tv);
    r.remove(phone);

    now += ROOM_TOMBSTONE_MS + 1;

    const late = new FakeSocket();
    hello(r, late, { kind: "phone", room });
    expect(late.last()).toMatchObject({ t: "relay_error", code: "unknown_room" });
  });

  it("still calls a code that never named a room unknown", () => {
    const r = relay();
    occupied(r);
    const stranger = new FakeSocket();
    hello(r, stranger, { kind: "phone", room: "ZZZZ" });
    expect(stranger.last()).toMatchObject({ t: "relay_error", code: "unknown_room" });
  });

  it("sends the very code a live room with no TV sends, so the phone has one word to wait on", () => {
    const r = relay();
    const { tv, room } = occupied(r);
    r.remove(tv);
    // The live room, with its TV away: the phone is seated, and everything it
    // addresses to the TV comes back `no_tv_yet`. That is the code a resting
    // room now answers its hello with, and deliberately the same one: a phone
    // does the same thing for both -- waits -- so it needs one word, not two.
    const waiting = new FakeSocket();
    const waitingId = hello(r, waiting, { kind: "phone", room });
    expect(waiting.types()).toContain("welcome");
    r.receive(waitingId, encode({ t: "relay", to: "tv", payload: { t: "join" } }));
    expect(waiting.last()).toMatchObject({ t: "relay_error", code: "no_tv_yet" });
  });
});
