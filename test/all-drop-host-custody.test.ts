/**
 * Host custody across the moment a room has nobody left in it.
 *
 * The an earlier version fix made a room code stop being proof of being the TV, but only
 * while there was still a room to hold: `remove` deleted an empty room, and a
 * session that knows the four letters off the screen could make that room
 * again and be welcomed as its TV. These are the two probes that showed it,
 * kept as the standing regression.
 *
 * Both run against the injected socket, so nothing here opens a port, and both
 * read the relay's own return value rather than a log line.
 */
import { describe, expect, it } from "vitest";
import { Relay, type Socket } from "../app/relay/src/relay.ts";
import {
  PROTOCOL_VERSION,
  decodeRelayMessage,
  encode,
  type RelayToClient,
} from "../app/shared/protocol.ts";

class FakeSocket implements Socket {
  readonly sent: RelayToClient[] = [];
  send(data: string): void {
    const decoded = decodeRelayMessage(data);
    if (!decoded.ok) throw new Error(decoded.reason);
    this.sent.push(decoded.message);
  }
  last(): RelayToClient | undefined {
    return this.sent[this.sent.length - 1];
  }
  types(): string[] {
    return this.sent.map((message) => message.t);
  }
}

function join(relay: Relay, socket: FakeSocket, body: Record<string, unknown>): string {
  const client = relay.add(socket);
  relay.receive(client.id, encode({ t: "hello", v: PROTOCOL_VERSION, ...body } as never));
  return client.id;
}

describe("a room that empties does not become anyone's to take", () => {
  it("a public room code cannot become a new host credential after every peer drops", () => {
    const relay = new Relay({ random: () => 0 });
    const tv = new FakeSocket();
    const tvId = join(relay, tv, { kind: "tv" });
    const welcome = tv.last();
    expect(welcome?.t).toBe("welcome");
    if (welcome?.t !== "welcome") return;

    const phone = new FakeSocket();
    const phoneId = join(relay, phone, { kind: "phone", room: welcome.room });

    // One network loss closes every socket. Nothing is left in the room, and
    // the room is not live any more -- but what it was is not forgotten yet.
    relay.remove(tvId);
    relay.remove(phoneId);
    expect(relay.rooms_()).toEqual([]);

    // A peer that knows only the public code races the real TV back.
    const impostor = new FakeSocket();
    const impostorId = join(relay, impostor, { kind: "tv", room: welcome.room });
    const toTheImpostor = impostor.last();

    // The original credential must remain the only way to restore this room.
    const returning = new FakeSocket();
    join(relay, returning, { kind: "tv", room: welcome.room, hostToken: welcome.hostToken });
    const toTheReturningTv = returning.last();
    const returnedPhone = new FakeSocket();
    const returnedPhoneId = join(relay, returnedPhone, { kind: "phone", room: welcome.room });

    // Whatever it asks for now, the impostor was never in this room.
    relay.receive(
      impostorId,
      encode({ t: "relay", to: returnedPhoneId, payload: { t: "superseded" } }),
    );
    expect(impostor.types()).not.toContain("welcome");

    expect({
      impostor: toTheImpostor,
      returningTv: toTheReturningTv,
      returnedPhone: returnedPhone.last(),
    }).toMatchObject({
      impostor: { t: "relay_error", code: "not_the_tv" },
      returningTv: { t: "welcome", room: welcome.room },
      returnedPhone: { t: "welcome", room: welcome.room },
    });
  });

  it("a credential captured off the wire is dead once the TV has resumed with it", () => {
    const relay = new Relay({ random: () => 0 });
    const tv = new FakeSocket();
    const tvId = join(relay, tv, { kind: "tv" });
    const first = tv.last();
    expect(first?.t).toBe("welcome");
    if (first?.t !== "welcome") return;
    const captured = first.hostToken;
    expect(captured).toMatch(/^[0-9a-f]{64}$/);

    const phone = new FakeSocket();
    join(relay, phone, { kind: "phone", room: first.room });
    relay.remove(tvId);

    // The room's own TV comes back first, presenting what it holds, and is
    // handed something else. That is the moment the captured one dies.
    const returning = new FakeSocket();
    const returningId = join(relay, returning, { kind: "tv", room: first.room, hostToken: captured });
    const resumed = returning.last();
    expect(resumed?.t).toBe("welcome");
    if (resumed?.t !== "welcome") return;
    const live = resumed.hostToken;
    expect(live).toMatch(/^[0-9a-f]{64}$/);
    expect(live).not.toBe(captured);
    // That TV goes away again; the room lives on with the phone in it, so the
    // only thing a replayed hello can be refused for is the credential itself.
    relay.remove(returningId);

    // Now the captured credential is spent, from any connection.
    const replay = new FakeSocket();
    join(relay, replay, { kind: "tv", room: first.room, hostToken: captured });
    expect(replay.last()).toMatchObject({ t: "relay_error", code: "not_the_tv" });
    expect(replay.types()).not.toContain("welcome");
  });
});
