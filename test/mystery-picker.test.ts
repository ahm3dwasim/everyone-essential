/**
 * Choosing a mystery: the reducer's half of the picker.
 *
 * The end-to-end half lives in `test/smoke/mysteries.spec.ts` (a real D-pad
 * reaching the choice). What is worth pinning here is the set of rules the
 * screen cannot see: that the choice is locked once the room starts, that a
 * stale or forged id changes nothing, and that a player holding a seat the new
 * mystery does not seat gives it back instead of being carried into a role that
 * no longer exists.
 */
import { describe, expect, it } from "vitest";
import {
  chooseMystery,
  createGame,
  reduce,
  type GameState,
} from "../app/tv/src/game/reducer.ts";
import { MYSTERIES, mysteryById, seatRoles } from "../app/tv/src/game/mysteries.ts";

const TREEHOUSE = "the-treehouse";
const BAKERY = "the-midnight-bakery";

function joined(mysteryId: string, roles: string[]): GameState {
  const state = createGame("ROOM1", mysteryId);
  return {
    ...state,
    players: roles.map((role, index) => ({
      peerId: `phone-${index}`,
      name: role,
      role: role as GameState["players"][number]["role"],
      connected: true,
      seat: `seat-${index}`,
      presentedSeat: `seat-${index}`,
      claimedSeat: null,
      disconnectedAt: null,
    })),
  };
}

describe("the mystery a room starts on", () => {
  it("defaults to the study, so every existing caller is unchanged", () => {
    expect(createGame().puzzle.id).toBe("the-locked-study");
    expect(seatRoles(createGame().puzzle)).toEqual(["A", "B", "C"]);
  });

  it("seats exactly the roles the chosen mystery declares", () => {
    expect(seatRoles(createGame("R", TREEHOUSE).puzzle)).toEqual(["A", "B"]);
    expect(seatRoles(createGame("R", BAKERY).puzzle)).toEqual(["A", "B", "C"]);
  });

  it("refuses an id it does not know, rather than inventing a puzzle", () => {
    const state = chooseMystery(createGame("R"), "no-such-mystery");
    expect(state.puzzle.id).toBe("the-locked-study");
  });

  it("is a no-op when the mystery is already the one in play", () => {
    const before = joined(BAKERY, []);
    expect(chooseMystery(before, BAKERY)).toBe(before);
  });
});

describe("choosing a mystery", () => {
  it("swaps the puzzle, the plan and the certificate together", () => {
    const before = createGame("ROOM1");
    const after = chooseMystery(before, TREEHOUSE);

    expect(after.puzzle.id).toBe(TREEHOUSE);
    // The plan is the new puzzle's, and the fresh certificate is about the new
    // puzzle -- proven, not carried over.
    expect(after.plan.length).toBe(mysteryById(TREEHOUSE)!.build().actions.length);
    expect(after.certificate?.ok).toBe(true);
    expect(after.certificate?.puzzleId).toBe(TREEHOUSE);
    expect(after.startCertificate?.puzzleId).toBe(TREEHOUSE);
    // The claim every badge on screen is about moves with the puzzle.
    expect(after.claim.puzzle.id).toBe(TREEHOUSE);
    // The room is the room: only the mystery changes.
    expect(after.room).toBe("ROOM1");
    expect(after.phase).toBe("lobby");
  });

  it("starts the log with the new mystery's own opening line", () => {
    const after = chooseMystery(createGame("R"), TREEHOUSE);
    expect(after.log[0]?.text).toBe(mysteryById(TREEHOUSE)!.opening);
    expect(after.log[0]?.text).not.toBe(mysteryById("the-locked-study")!.opening);
  });

  it("gives back a seat the new mystery does not have", () => {
    const before = joined("the-locked-study", ["A", "B", "C"]);
    const after = chooseMystery(before, TREEHOUSE);
    const byRole = Object.fromEntries(after.players.map((p) => [p.role ?? "none", p.name]));
    // A and B keep their seats...
    expect(byRole["A"]).toBe("A");
    expect(byRole["B"]).toBe("B");
    // ...C is released rather than left holding a role nobody can play.
    expect(after.players.find((p) => p.name === "C")?.role).toBeNull();
    expect(after.players).toHaveLength(3);
  });

  it("keeps a player who had not chosen a role yet exactly where they were", () => {
    const before = joined("the-locked-study", []);
    const waiting: GameState = {
      ...before,
      players: [
        {
          peerId: "p",
          name: "undecided",
          role: null,
          connected: true,
          seat: "s",
          presentedSeat: "s",
          claimedSeat: null,
          disconnectedAt: null,
        },
      ],
    };
    const after = chooseMystery(waiting, TREEHOUSE);
    expect(after.players[0]?.role).toBeNull();
    expect(after.players[0]?.name).toBe("undecided");
  });

  it("is locked once the room is playing", () => {
    const playing: GameState = { ...createGame("R"), phase: "playing" };
    expect(chooseMystery(playing, TREEHOUSE)).toBe(playing);
    // The same through the action, which is the path the TV actually takes.
    expect(reduce(playing, { k: "choose_mystery", mysteryId: TREEHOUSE }).puzzle.id).toBe(
      "the-locked-study",
    );
  });

  it("reaches the reducer through the action the TV sends", () => {
    const after = reduce(createGame("R"), { k: "choose_mystery", mysteryId: BAKERY });
    expect(after.puzzle.id).toBe(BAKERY);
    expect(after.certificate?.ok).toBe(true);
  });

  it("carries every mystery in the catalogue, not just the ones named here", () => {
    for (const mystery of MYSTERIES) {
      const state = chooseMystery(createGame("R"), mystery.id);
      expect(state.puzzle.id, mystery.id).toBe(mystery.id);
      expect(state.certificate?.ok, mystery.id).toBe(true);
      expect(seatRoles(state.puzzle), mystery.id).toEqual(mystery.roles);
    }
  });
});
