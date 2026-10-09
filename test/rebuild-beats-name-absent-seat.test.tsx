/**
 * The rebuild moment names an absent seat on every beat.
 *
 * `waitingFor`/`vacantFor` reached `RebuildMoment`'s beat 2 only -- and only
 * inside `HowWeChecked`'s own headline. Beats 0, 1 and 3 rendered with no idea
 * a seat was missing, so the room's last beat before real input reads
 * "C · Scan — On your phone" for a phone that had just dropped. The pinned
 * case: render beat 3 after C disconnects.
 *
 * Two separate obligations, tested separately:
 *   - the waiting/vacant sentence is on every beat, not just beat 2; and
 *   - a next action belonging to an absent seat is never pointed at a phone
 *     that is not there.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  SEAT_GRACE_MS,
  createGame,
  heldRolesIn,
  reduce,
  reduceApp,
  switchRecord,
  vacantRolesIn,
  type GameState,
  type SwitchRecord,
} from "../app/tv/src/game/reducer.ts";
import { RebuildMoment } from "../app/tv/src/screens.tsx";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

/**
 * A `SwitchRecord` names the SEAT that asked for the change (`requester`), so
 * a hand-built record has to say who asked. These fixtures ask as the role's
 * own connection, which joined without minting a seat token.
 */
const ASKED_BY_C = { peerId: PEER_C, seat: null };
const ASKED_BY_A = { peerId: PEER_A, seat: null };

function started(): GameState {
  let state = createGame("ABCD");
  state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
  state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
  return state;
}

/** C's accepted switch to a scan-only control set -- the fixture these tests use. */
function acceptedSwitch(): SwitchRecord {
  const before = started();
  const record = switchRecord(before.puzzle, before.play, "C", ["scan"], ASKED_BY_C);
  if (record.kind !== "ok") throw new Error("expected an accepted switch for this fixture");
  return record;
}

function renderBeat(
  record: SwitchRecord,
  beat: number,
  waitingFor: readonly string[] = [],
  vacantFor: readonly string[] = [],
): string {
  return render(
    h(RebuildMoment, {
      record,
      beat,
      focusId: null,
      onContinue: () => {},
      waitingFor,
      vacantFor,
      relayOpen: true,
    }),
  );
}

/** C drops, inside the grace window: held, not gone. */
function cDrops(): { waitingFor: string[]; vacantFor: string[] } {
  const afterDrop = reduce(started(), { k: "player_left", peerId: PEER_C, at: 1_000 });
  expect(heldRolesIn(afterDrop)).toEqual(["C"]);
  return {
    waitingFor: heldRolesIn(afterDrop).map((role) => role),
    vacantFor: vacantRolesIn(afterDrop).map((role) => role),
  };
}

/** C drops and never comes back: past the grace window the seat is swept. */
function cIsSwept(): { waitingFor: string[]; vacantFor: string[] } {
  let afterSweep = reduce(started(), { k: "player_left", peerId: PEER_C, at: 1_000 });
  afterSweep = reduce(afterSweep, { k: "sweep_seats", at: 1_000 + SEAT_GRACE_MS });
  expect(vacantRolesIn(afterSweep)).toEqual(["C"]);
  return {
    waitingFor: heldRolesIn(afterSweep).map((role) => role),
    vacantFor: vacantRolesIn(afterSweep).map((role) => role),
  };
}

describe("the rebuild moment names an absent seat on every beat", () => {
  it("says 'Waiting for C to come back.' on every beat, not only beat 2", () => {
    const record = acceptedSwitch();
    const { waitingFor, vacantFor } = cDrops();
    for (const beat of [0, 1, 2, 3]) {
      expect(renderBeat(record, beat, waitingFor, vacantFor), `beat ${beat}`).toContain(
        "Waiting for C to come back.",
      );
    }
    // Beat 2 carries that sentence through `HowWeChecked`'s own headline
    // (`checkedHeadline` is the same `waitingOrVacantLine` string); the other
    // three carry it as the rebuild moment's own
    // line, so the sentence is never printed twice on one screen.
    for (const beat of [0, 1, 3]) {
      expect(renderBeat(record, beat, waitingFor, vacantFor), `beat ${beat}`).toContain(
        'data-testid="rebuild-waiting"',
      );
      expect(renderBeat(record, beat, waitingFor, vacantFor), `beat ${beat}`).not.toContain(
        'data-testid="rebuild-checked"',
      );
    }
    expect(renderBeat(record, 2, waitingFor, vacantFor)).toContain('data-testid="rebuild-checked"');
    expect(renderBeat(record, 2, waitingFor, vacantFor)).not.toContain('data-testid="rebuild-waiting"');
  });

  it("says the vacant sentence (not the held one) on every beat when the seat was swept", () => {
    const record = acceptedSwitch();
    const { waitingFor, vacantFor } = cIsSwept();
    for (const beat of [0, 1, 2, 3]) {
      expect(renderBeat(record, beat, waitingFor, vacantFor), `beat ${beat}`).toContain(
        "C's seat is empty — someone needs to join as C.",
      );
    }
  });

  it("says nothing about waiting on any beat while everyone is still here", () => {
    const record = acceptedSwitch();
    for (const beat of [0, 1, 2, 3]) {
      const html = renderBeat(record, beat, [], []);
      expect(html, `beat ${beat}`).not.toContain("Waiting for");
      expect(html, `beat ${beat}`).not.toContain("rebuild-waiting");
    }
  });
});

describe("no 'On your phone' for a seat that is not there", () => {
  it("never points beat 3's next action at a phone that has dropped", () => {
    const record = acceptedSwitch();
    const { waitingFor, vacantFor } = cDrops();
    const html = renderBeat(record, 3, waitingFor, vacantFor);
    // The fixture's next action really does belong to C, and C's new control
    // set is scan-only -- so the pre-fix copy here was literally
    // "C · read the drawer note about the dial — On your phone".
    expect(html).toContain("C · read the drawer note about the dial");
    expect(html).not.toContain("On your phone");
    expect(html).toContain("Waiting for C to come back.");
  });

  it("never points beat 3's next action at a phone that was swept either", () => {
    const record = acceptedSwitch();
    const { waitingFor, vacantFor } = cIsSwept();
    const html = renderBeat(record, 3, waitingFor, vacantFor);
    expect(html).not.toContain("On your phone");
    expect(html).toContain("C's seat is empty — someone needs to join as C.");
  });

  it("still says 'On your phone' when that seat is actually there", () => {
    // The control for the two above: with nobody absent, beat 3's copy is
    // unchanged -- this fix suppresses stale copy, it does not remove it.
    const html = renderBeat(acceptedSwitch(), 3, [], []);
    expect(html).toContain("On your phone");
  });

  it("keeps 'On the remote' for a role the remote can actually drive", () => {
    // Only the "On your phone" branch is suppressed: a dpad role is played
    // from the TV remote, which is a real control surface whether or not that
    // phone has come back.
    const before = started();
    const record = switchRecord(before.puzzle, before.play, "A", ["dpad"], ASKED_BY_A);
    if (record.kind !== "ok") throw new Error("expected an accepted dpad switch for this fixture");
    const html = renderBeat(record, 3, ["A"], []);
    expect(html).toContain("On the remote");
  });
});
