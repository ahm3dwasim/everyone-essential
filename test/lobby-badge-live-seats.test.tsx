/**
 * The lobby badge is live-gated, not just the puzzle's own proof.
 *
 * The lobby must not claim a role is essential -- a green `data-ok="true"`
 * badge line -- until that seat is actually connected. The puzzle's own
 * necessity proof (`state.startCertificate`) is unconditionally true the
 * instant the game is created, before anyone has joined at all, and `Lobby` is
 * the one screen that renders it that early: on a fresh `createGame()`, all
 * three "essential" lines read `data-ok="true"`.
 */
import { h } from "preact";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { badge } from "../app/tv/src/game/badge.ts";
import { createGame, isConnected, reduceApp, type GameState } from "../app/tv/src/game/reducer.ts";
import { Lobby } from "../app/tv/src/screens.tsx";

const PEER_A = "phone-a";
const PEER_B = "phone-b";
const PEER_C = "phone-c";

function lobbyHtml(state: GameState): string {
  return render(
    h(Lobby, {
      state,
      phoneAddress: "http://example.test/phone",
      badge: state.startCertificate ? badge(state.startCertificate, (role) => isConnected(state, role)) : null,
      status: "connected",
      focusId: null,
      onChooseMystery: () => {},
    }),
  );
}

describe("the lobby badge is live-gated, not just the puzzle's own proof", () => {
  it("does not mark any role essential -- or the badge itself ok -- with nobody seated (reducer.ts screens.tsx:514)", () => {
    const state = createGame("ABCD");
    const html = lobbyHtml(state);
    expect(html).toContain('data-testid="lobby-badge" data-ok="false"');
    // The label text still names what the mystery needs -- only the tick
    // that claims it holds right now is gated.
    expect(html).toContain("A essential");
    expect(html).toMatch(/data-testid="badge-line-a-essential" data-ok="false"/);
    expect(html).toMatch(/data-testid="badge-line-b-essential" data-ok="false"/);
    expect(html).toMatch(/data-testid="badge-line-c-essential" data-ok="false"/);
    expect(html).toContain("A has not joined yet");
  });

  it("marks only the connected roles' lines ok, with one seated and two waiting", () => {
    let state = createGame("ABCD");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
    const html = lobbyHtml(state);
    expect(html).toMatch(/data-testid="badge-line-a-essential" data-ok="true"/);
    expect(html).toMatch(/data-testid="badge-line-b-essential" data-ok="false"/);
    expect(html).toMatch(/data-testid="badge-line-c-essential" data-ok="false"/);
    expect(html).toContain('data-testid="lobby-badge" data-ok="false"'); // not everyone yet
  });

  it("reads fully ok only once every seat this mystery needs is actually connected", () => {
    let state = createGame("ABCD");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
    const html = lobbyHtml(state);
    expect(html).toContain('data-testid="lobby-badge" data-ok="true"');
    expect(html).toMatch(/data-testid="badge-line-a-essential" data-ok="true"/);
    expect(html).toMatch(/data-testid="badge-line-b-essential" data-ok="true"/);
    expect(html).toMatch(/data-testid="badge-line-c-essential" data-ok="true"/);
  });

  it("never states 'Everyone is essential' as a bare present-tense claim in the subtitle (screens.tsx:473)", () => {
    const html = lobbyHtml(createGame("ABCD"));
    expect(html).not.toContain("Everyone is essential");
  });

  it("makes no essential claim at all while the TV is not in the room", () => {
    // What `app.tsx` hands the lobby while its own socket is down: the badge
    // is withheld, not gated role by role, because the reducer's per-seat
    // connectivity is whatever the TV last heard -- with the socket down it
    // can still call a seat present, and a green "A essential" line is a
    // claim about a room this TV is not in.
    let state = createGame("ABCD");
    state = reduceApp(state, { k: "phone_join", peerId: PEER_A, want: "A" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_B, want: "B" });
    state = reduceApp(state, { k: "phone_join", peerId: PEER_C, want: "C" });
    const html = render(
      h(Lobby, {
        state,
        phoneAddress: "http://example.test/phone",
        badge: null,
        status: "closed",
        focusId: null,
        onChooseMystery: () => {},
      }),
    );
    expect(html).toContain('data-testid="lobby-badge" data-ok="false"');
    expect(html).toContain("no certificate yet");
    // Not one role line and not one tick: the whole proof is withheld rather
    // than half-stated. (The subtitle's "designed so everyone is essential"
    // is the puzzle's own description, not a claim about who is here, and is
    // not what this is about.)
    expect(html).not.toContain('data-testid="badge-line-');
    expect(html).not.toContain("✓");
  });
});
