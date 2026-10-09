/**
 * The TV's connection state is what the socket says, not what a refusal says.
 *
 * An earlier version gave the claim screens `relayOpen`, and `app.tsx` answered it with
 * `status === "open"` -- but `status` was also where `onRelayError` wrote
 * `relay error: …` for ANY refusal. So a refusal that is not about the
 * connection at all -- `malformed`, which the relay sends for things like a
 * phone addressing somebody other than the TV, and which the TV keeps
 * receiving while it is perfectly well connected -- turned every positive
 * claim on the screen into "Reconnecting…". Nothing sets it back: the string
 * is only replaced by the next `onStatus`, and the socket may not change
 * state again for the rest of the session.
 *
 * So the two are kept apart here. `status` is written by `onStatus` and by
 * nothing else; a refusal is a NOTICE, kept for the diagnostic line, and a
 * refusal never moves the connection. Being taken into a room again retires
 * the notice, because a welcome is the relay's own word that the last refusal
 * is behind us.
 */
import { describe, expect, it } from "vitest";
import {
  INITIAL_CONNECTION,
  connectionOnRelayError,
  connectionOnStatus,
  relayIsOpen,
} from "../app/tv/src/connection.ts";

describe("the TV's own connection state", () => {
  it("is open once the relay has welcomed this TV, and not before", () => {
    expect(relayIsOpen(INITIAL_CONNECTION)).toBe(false);
    expect(relayIsOpen(connectionOnStatus(INITIAL_CONNECTION, "open"))).toBe(true);
    expect(relayIsOpen(connectionOnStatus(connectionOnStatus(INITIAL_CONNECTION, "open"), "closed"))).toBe(
      false,
    );
  });

  it("does not move for a refusal that is not about the connection", () => {
    // The case this guards: the TV is connected, and the relay refuses
    // one frame. The claim screens must go on making claims.
    const open = connectionOnStatus(INITIAL_CONNECTION, "open");
    const after = connectionOnRelayError(open, { code: "malformed", detail: "no peer p3-x in this room" });
    expect(relayIsOpen(after)).toBe(true);
    expect(after.status).toBe("open");
    // And the refusal is still on the record, so the lobby's diagnostic line
    // can say what happened.
    expect(after.notice).toBe("relay error: no peer p3-x in this room");
  });

  it("does not open for a refusal either -- a refusal is never a connection", () => {
    const after = connectionOnRelayError(INITIAL_CONNECTION, { code: "bad_room", detail: "a room code is four letters" });
    expect(relayIsOpen(after)).toBe(false);
    expect(after.status).toBe("connecting");
  });

  it("retires the last refusal when the relay takes this TV into a room again", () => {
    const refused = connectionOnRelayError(
      connectionOnStatus(INITIAL_CONNECTION, "open"),
      { code: "malformed", detail: "the TV cannot address itself" },
    );
    expect(refused.notice).not.toBeNull();
    // A welcome is the relay accepting this connection; the refusal it is
    // carrying is about a frame the relay has already moved past.
    expect(connectionOnStatus(refused, "open")).toEqual({ status: "open", notice: null });
  });

  it("keeps the notice across a close, so a refusal is not lost by a blip", () => {
    const refused = connectionOnRelayError(
      connectionOnStatus(INITIAL_CONNECTION, "open"),
      { code: "malformed", detail: "no peer p3-x in this room" },
    );
    expect(connectionOnStatus(refused, "closed").notice).toBe("relay error: no peer p3-x in this room");
  });
});
