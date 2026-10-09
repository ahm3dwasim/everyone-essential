/**
 * The rebuild moment's claim screens know whether the TV is connected.
 *
 * An earlier version taught `claimHoldsLive` to refuse a positive claim while the TV's
 * own socket is down, and threaded `relayOpen` into two of the three
 * `HowWeChecked` render sites. The third -- beat 2 of the rebuild moment, the
 * one screen a switch puts its certificate on -- kept the default `true`, so
 * the screen went on saying "You can finish together" and "still needs every
 * role" through a Wi-Fi blip.
 *
 * The window is short (`PHASE_MS[2]`, 2.2 s) but the claim is unconditional:
 * a TV that is away is not told about a phone that drops in the same blip, so
 * `waitingFor` is empty and nothing else on the screen corrects it. What the
 * TV knows at that moment is that it is not connected, so what it may say is
 * that it is reconnecting.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  createGame,
  reduceApp,
  switchRecord,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { RebuildMoment } from "../app/tv/src/screens.tsx";
import { RECONNECTING_LINE } from "../app/tv/src/game/certificate-presenter.ts";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";
const ASKED_BY_C = { peerId: PEER_C, seat: null };

function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

function acceptedRecord() {
  const before = started();
  const record = switchRecord(before.puzzle, before.play, "C", ["scan"], ASKED_BY_C);
  if (record.kind !== "ok") throw new Error("expected an accepted switch for this fixture");
  return record;
}

describe("the rebuild moment while the TV's own connection is down", () => {
  it("refuses the claim at beat 2 rather than only hiding it", () => {
    const record = acceptedRecord();
    const html = render(
      h(RebuildMoment, {
        record,
        beat: 2,
        focusId: null,
        onContinue: () => {},
        waitingFor: [],
        vacantFor: [],
        relayOpen: false,
      }),
    );
    // The attribute is the machine-readable form of the claim: anything that
    // reads the screen rather than the words reads this.
    expect(html).toContain('data-ok="false"');
    expect(html).not.toContain("You can finish together.");
    expect(html).toContain(RECONNECTING_LINE);
  });

  it("says the room is reconnecting at beat 2 while it is away instead of nothing", () => {
    const record = acceptedRecord();
    const html = render(
      h(RebuildMoment, {
        record,
        beat: 2,
        focusId: null,
        onContinue: () => {},
        waitingFor: [],
        vacantFor: [],
        relayOpen: false,
      }),
    );
    // Not silence: a player looking at the screen has to be able to tell a
    // rebuild that is being checked from one whose checking cannot be heard.
    expect(html).toContain("Reconnecting");
  });

  it("still makes the claim when the TV is connected, so the gate is the socket and not the screen", () => {
    const record = acceptedRecord();
    const html = render(
      h(RebuildMoment, {
        record,
        beat: 2,
        focusId: null,
        onContinue: () => {},
        waitingFor: [],
        vacantFor: [],
        relayOpen: true,
      }),
    );
    expect(html).toContain('data-ok="true"');
    expect(html).toContain("You can finish together.");
  });

  it("withholds beat 3's next-action instruction while the TV is away", () => {
    const record = acceptedRecord();
    const disconnected = render(
      h(RebuildMoment, {
        record,
        beat: 3,
        focusId: null,
        onContinue: () => {},
        waitingFor: [],
        vacantFor: [],
        relayOpen: false,
      }),
    );
    const connected = render(
      h(RebuildMoment, {
        record,
        beat: 3,
        focusId: null,
        onContinue: () => {},
        waitingFor: [],
        vacantFor: [],
        relayOpen: true,
      }),
    );
    // "On your phone" is an instruction to act on a board this TV can no
    // longer hear. The seat is not absent -- nothing arrived to say so -- so
    // `seatAbsent` cannot be what withholds it; the connection is.
    expect(connected).toContain("On your phone");
    expect(disconnected).not.toContain("On your phone");
    expect(disconnected).toContain(RECONNECTING_LINE);
  });
});
