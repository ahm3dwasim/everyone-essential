/**
 * The rebuild certificate must not go green over an absent seat.
 *
 * `RebuildMoment`'s beat 2 (`HowWeChecked` underneath it) must not say "You can
 * finish together" while the switching player -- or any other required role --
 * is not actually connected. The reducer already knows this
 * (`heldRolesIn`/`claimHolds`); this is the render-time wiring that has to
 * carry it through to the one screen this run puts it on.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  createGame,
  heldRolesIn,
  reduce,
  reduceApp,
  switchRecord,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { RebuildMoment } from "../app/tv/src/screens.tsx";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

/**
 * A `SwitchRecord` names the SEAT that asked for the change (`requester`), so
 * a hand-built record has to say who asked. These fixtures ask as C's own
 * connection, which joined without minting a seat token.
 */
const ASKED_BY_C = { peerId: PEER_C, seat: null };

function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

describe("the rebuild certificate must not go green over an absent seat", () => {
  it("does not say 'You can finish together' at beat 2 after the switching phone drops", () => {
    const before = started();
    const record = switchRecord(before.puzzle, before.play, "C", ["scan"], ASKED_BY_C);
    if (record.kind !== "ok") throw new Error("expected an accepted switch for this fixture");

    // C -- the role this very switch is about -- disconnects before beat 2
    // renders. The reducer already knows it: `heldRolesIn` names C. This is
    // exactly what `app.tsx` reads and passes down as `waitingFor`.
    const afterDrop = reduce(before, { k: "player_left", peerId: PEER_C, at: 1_000 });
    expect(heldRolesIn(afterDrop)).toEqual(["C"]);

    const html = render(
      h(RebuildMoment, {
        record,
        beat: 2,
        focusId: null,
        onContinue: () => {},
        waitingFor: heldRolesIn(afterDrop),
        relayOpen: true,
      }),
    );
    expect(html).not.toContain("You can finish together.");
    expect(html).toContain("Waiting for C to come back.");
  });

  it("still says nothing is wrong when the switching phone stays connected", () => {
    const before = started();
    const record = switchRecord(before.puzzle, before.play, "C", ["scan"], ASKED_BY_C);
    if (record.kind !== "ok") throw new Error("expected an accepted switch for this fixture");

    const html = render(
      h(RebuildMoment, {
        record,
        beat: 2,
        focusId: null,
        onContinue: () => {},
        waitingFor: [],
        relayOpen: true,
      }),
    );
    expect(html).toContain("You can finish together.");
  });
});
