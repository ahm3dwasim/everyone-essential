/**
 * The wire's role vocabulary (A, B, C) is wider than any one mystery's own
 * seats -- a two-player mystery seats only A and B. `assign_role` (and the
 * phone-facing `choose_role` that maps to it) must refuse a role the current
 * mystery has no seat for, the same way it refuses one somebody else already
 * holds; without that check, a role outside the mystery's own seats can never
 * read as "already taken" (nobody can ever hold it), so it slips through as
 * if it were free. `phoneView`'s own `seatRoles` field is the phone's half of
 * the same fix: a role picker built from it never even offers the role.
 */
import { describe, expect, it } from "vitest";
import { createGame, phoneView, reduce, reduceApp } from "../app/tv/src/game/reducer.ts";
import { seatRoles } from "../app/tv/src/game/mysteries.ts";

const PEER_A = "phone-a";
const PEER_B = "phone-b";

describe("a role outside the current mystery's own seats is refused, never granted", () => {
  it("the-treehouse seats only A and B: choose_role C is refused, A stays required", () => {
    let state = createGame("ABCD", "the-treehouse");
    expect(seatRoles(state.puzzle)).toEqual(["A", "B"]);
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
    const before = state;
    state = reduce(state, { k: "assign_role", peerId: PEER_B, role: "C" });
    expect(state.players.find((p) => p.peerId === PEER_B)?.role).toBe("B");
    expect(state.players.find((p) => p.peerId === PEER_A)?.role).toBe("A");
    expect(state.notice?.peerId).toBe(PEER_B);
    expect(state.notice?.text).toContain("C");
    // Nothing about either seated player changed -- only a notice was added.
    expect(state.players).toEqual(before.players);
  });

  it("phoneView's seatRoles for a two-seat mystery is exactly its own seats, never the wire's full A/B/C", () => {
    let state = createGame("ABCD", "the-treehouse");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
    const view = phoneView(state, PEER_A);
    expect(view.seatRoles).toEqual(["A", "B"]);
  });

  it("a three-seat mystery's phoneView offers all three seats", () => {
    let state = createGame("ABCD", "the-locked-study");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
    const view = phoneView(state, PEER_A);
    expect(view.seatRoles).toEqual(["A", "B", "C"]);
  });
});
