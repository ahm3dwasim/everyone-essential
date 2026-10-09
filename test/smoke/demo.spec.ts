/**
 * The whole demo, headless, on four pages: the TV at 1920x1080 and three
 * phones.
 *
 * What this run is for is the parts that only exist once the pieces are wired
 * together: that a phone can join a room the TV made, that A and C act from the
 * TV remote while B acts from a phone, that C can switch to one-button scan
 * mid-game and the puzzle really is rebuilt around them, and that the ending
 * shows the certificate `ok` with the switch in the history.
 *
 * The TV is driven with the keyboard, which is the same code path the Fire TV
 * remote takes (`keyIntent` reads keyCode 23 for the centre button; Enter is the
 * desktop equivalent). C's scan surface is driven with real pointer presses,
 * because the tap-versus-hold distinction is the whole input mode.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * How long to give the TV to free a dropped player's seat: the reducer's own
 * `SEAT_GRACE_MS` (`app/tv/src/game/reducer.ts`, three minutes) plus room for
 * the sweep's arming (`app.tsx` arms it for the deadline plus 25ms) and for a
 * browser slow enough to fire that timer late.
 *
 * The number is spelled here rather than imported, and the reason is worth
 * recording so the next person does not retry it: `reducer.ts`'s module graph
 * reaches `game/generated.ts`, which imports a `.json` bundle without an
 * import attribute, and Playwright's ESM loader refuses that outright
 * ("needs an import attribute of type: json") before a single test is listed.
 * The unit suite imports the constant and asserts on its exact boundary
 * (`test/game.test.ts`); this spec is the outside-in half, and it drives the
 * built app through a browser rather than through the module. If the window
 * moves again, this is the one line that has to move with it -- and a spec
 * that disagrees with the product fails loudly rather than passing quietly.
 */
const SEAT_GRACE_WAIT_MS = 180_000 + 30_000;
const HTTP_PORT = Number(process.env.SMOKE_HTTP_PORT ?? 8123);
const RELAY_PORT = Number(process.env.SMOKE_RELAY_PORT ?? 8790);
const TV_URL = `http://127.0.0.1:${HTTP_PORT}/?relay=${encodeURIComponent(relayUrl())}`;

function relayUrl(): string {
  return `ws://127.0.0.1:${RELAY_PORT}`;
}

let relay: ChildProcess;
let server: ChildProcess;

async function waitForPort(port: number, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`${label} never came up on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test.beforeAll(async () => {
  relay = spawn(process.execPath, [join(ROOT, "app/relay/src/main.ts")], {
    env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server = spawn(process.execPath, [join(ROOT, "scripts/serve.mjs")], {
    env: { ...process.env, PORT: String(HTTP_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout?.on("data", (chunk) => process.stdout.write(`[relay] ${chunk}`));
  relay.stderr?.on("data", (chunk) => process.stderr.write(`[relay] ${chunk}`));
  server.stdout?.on("data", (chunk) => process.stdout.write(`[serve] ${chunk}`));
  // The server's real diagnostic (e.g. "build first: npm run build") goes to
  // stderr, which a pipe nobody reads makes invisible -- the timeout below
  // then reads as "the server is slow" instead of "the server refused to
  // start". `npm run smoke` builds first (see package.json), so this
  // should never fire, but it stays loud if it ever does.
  server.stderr?.on("data", (chunk) => process.stderr.write(`[serve] ${chunk}`));
  await waitForPort(RELAY_PORT, "the relay");
  await waitForPort(HTTP_PORT, "the static server");
});

test.afterAll(() => {
  relay?.kill();
  server?.kill();
});

/* ------------------------------------------------------------------ */
/* Driving the TV with the remote                                      */
/* ------------------------------------------------------------------ */

/**
 * Opt-in beat capture. `SMOKE_SHOTS=<dir> npm run smoke` writes a PNG at each
 * named beat of the run below. Off by default and asserting nothing -- this is
 * how the demo's own screenshots are produced from the same path a first-time player takes,
 * rather than from a hand-posed page that may not match what the app does.
 */
const SHOTS = process.env.SMOKE_SHOTS ?? "";
async function beat(tv: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await tv.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function focusedId(tv: Page): Promise<string> {
  return (await tv.locator('[data-testid="tv"]').getAttribute("data-focus")) ?? "";
}

/**
 * The current phase, read from the root's `data-phase` attribute. There is
 * no always-visible phase-chip -- the visible board already communicates
 * this -- so this is the one place the phase is still exposed for a test to
 * read.
 */
function phaseIs(tv: Page, phase: string) {
  return expect(tv.getByTestId("tv")).toHaveAttribute("data-phase", phase);
}

/**
 * Where a control is, or null if it is not on screen. The short timeout is
 * deliberate: a control being absent is ordinary here -- the board redraws
 * between presses -- and the walk recovers from it. Waiting the full action
 * timeout to be told so would turn a recoverable step into a failure.
 */
async function boxOf(tv: Page, id: string) {
  return tv
    .locator(`[data-focus-id="${id}"]`)
    .boundingBox({ timeout: 500 })
    .catch(() => null);
}

/**
 * Walk the focus ring to `id` with the arrow keys, exactly as a person with a
 * remote would: press toward the target, look at where the ring went, repeat.
 * A thrown error here is a real failure -- it means the ring cannot reach a
 * control that is on screen.
 *
 * The pause after each press is a person's thumb, not a workaround: reading the
 * ring faster than the screen can move it is not something a remote can do, and
 * a walk that did it would be testing the driver rather than the app.
 */
async function focusOn(tv: Page, id: string): Promise<void> {
  let everOnScreen = false;
  for (let step = 0; step < 24; step++) {
    const want = await boxOf(tv, id);
    if (!want) {
      // The board is redrawing: the control is not on screen this instant.
      // Wait for it rather than spending a press on it.
      await tv.waitForTimeout(120);
      continue;
    }
    everOnScreen = true;
    const current = await focusedId(tv);
    if (current === id) return;
    const have = current ? await boxOf(tv, current) : null;
    let key: string;
    if (!have) {
      // Nothing is focused yet: the first arrow press lands on the first
      // control in the ring, and the walk continues from there.
      key = "ArrowRight";
    } else {
      const dx = want.x + want.width / 2 - (have.x + have.width / 2);
      const dy = want.y + want.height / 2 - (have.y + have.height / 2);
      key =
        Math.abs(dx) > Math.abs(dy)
          ? dx > 0
            ? "ArrowRight"
            : "ArrowLeft"
          : dy > 0
            ? "ArrowDown"
            : "ArrowUp";
    }
    await tv.keyboard.press(key);
    await tv.waitForTimeout(60);
  }
  throw new Error(
    everOnScreen
      ? `the focus ring never reached ${id}`
      : `nothing on screen has the focus id ${id}`,
  );
}

/** Press the centre button on a control, the way the remote does. */
async function pressOnRemote(tv: Page, id: string): Promise<void> {
  await focusOn(tv, id);
  // The ring is drawn where the press will land: the button the viewer sees
  // highlighted is the one that acts.
  await expect(tv.locator(`[data-focus-id="${id}"]`)).toHaveAttribute("data-focused", "true");
  await tv.keyboard.press("Enter");
}

/**
 * Answer the reclaim request on screen. Each control's focus id carries the id
 * of the request it decides, so the exact id is read off the overlay rather
 * than assumed.
 */
async function answerReclaim(
  tv: Page,
  control: "approve-reclaim" | "decline-reclaim",
): Promise<void> {
  const button = tv.locator(`[data-focus-id^="${control}:"]`).first();
  await expect(button).toBeVisible();
  const id = await button.getAttribute("data-focus-id");
  if (!id) throw new Error(`the ${control} control carries no focus id`);
  await pressOnRemote(tv, id);
}

async function historyLength(tv: Page): Promise<number> {
  return Number(await tv.locator('[data-testid="tv"]').getAttribute("data-history"));
}

async function expectHistory(tv: Page, length: number): Promise<void> {
  await expect(tv.locator('[data-testid="tv"]')).toHaveAttribute("data-history", String(length));
}

/* ------------------------------------------------------------------ */
/* Driving a phone                                                     */
/* ------------------------------------------------------------------ */

interface Phone {
  page: Page;
  /** This phone's own browser context -- a real phone's own storage, shared
   * with nothing else, the way a different family member's device would be. */
  context: BrowserContext;
  role: string;
  /** Tap: move the scan highlight. Commits nothing. */
  tap(): Promise<void>;
  /** Press and hold: select whatever is highlighted. */
  hold(): Promise<void>;
  choiceCount(): Promise<number>;
  mode(): Promise<string>;
}

/**
 * A phone is its own browser context, not just another tab of the TV's --
 * real phones do not share storage, and the join seat is one IndexedDB entry
 * per room code, so two tabs of one context read the SAME token and are one
 * player as far as the TV is concerned.
 */
async function openPhone(browser: Browser, url: string, role: string, name: string): Promise<Phone> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(url);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId(`want-${role}`).click();
  await page.getByTestId("join-button").click();
  await expect(page.getByTestId("phone-role")).toHaveText(role);

  const surface = page.getByTestId("scan-surface");
  const choices = page.locator('[data-testid="scan-surface"] [data-choice-id]');
  const press = async (holdMs: number) => {
    const box = await surface.boundingBox();
    if (!box) throw new Error("the scan surface is not on screen");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(holdMs);
    await page.mouse.up();
  };

  return {
    page,
    context,
    role,
    tap: () => press(120),
    hold: () => press(900),
    choiceCount: () => choices.count(),
    mode: async () => (await page.getByTestId("phone").getAttribute("data-mode")) ?? "",
  };
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

test("the whole demo, from lobby to certificate, including the switch", async ({ browser }) => {
  // The seat-grace beat below waits out three real minutes, which is longer
  // than the default per-test budget on its own. Raised to fit that one wait
  // and the ordinary work around it, and no further.
  test.setTimeout(SEAT_GRACE_WAIT_MS + 120_000);
  const context = await browser.newContext();
  const tv = await context.newPage();
  await tv.goto(TV_URL);

  /* -------- lobby -------- */
  const roomCode = tv.getByTestId("room-code");
  await expect(roomCode).toHaveText(/^[A-Z]{4}$/);
  const room = (await roomCode.textContent())?.trim() ?? "";
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");
  // The lobby badge is live-gated -- with nobody seated
  // yet, "X essential" is a claim about the puzzle's design, not about
  // people who are here, so it reads false until every seat is filled.
  await expect(tv.getByTestId("lobby-badge")).toHaveAttribute("data-ok", "false");

  const phoneUrl = (await tv.getByTestId("phone-url").textContent())?.trim() ?? "";
  expect(phoneUrl).toContain(`room=${room}`);
  expect(phoneUrl).toContain(`relay=${encodeURIComponent(relayUrl())}`);

  /* -------- three phones join -------- */
  // The lobby fills in one slot at a time, and gives way to the board once the
  // third phone is in -- so the slots are checked as each phone arrives.
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "false");
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");
  await expect(tv.getByTestId("role-slot-A")).toContainText("Ada");
  let b = await openPhone(browser, phoneUrl, "B", "Bo");
  await expect(tv.getByTestId("role-slot-B")).toHaveAttribute("data-joined", "true");

  /* -------- a phone changes its mind about the role -------- */
  // A gives A back and picks again: without this, a player who tapped the
  // wrong role would have to reset the room. A single tap only asks -- a
  // confirm is required before the seat is actually given up, so one
  // accidental tap can never eject a player without confirmation.
  await a.page.getByTestId("change-role-button").click();
  const confirmSheet = a.page.getByTestId("confirm-release-sheet");
  await expect(confirmSheet).toBeVisible();
  // Stay backs out: A still holds the role.
  await a.page.getByTestId("confirm-release-cancel").click();
  await expect(confirmSheet).toBeHidden();
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");
  await expect(a.page.getByTestId("phone-role")).toHaveText("A");

  await a.page.getByTestId("change-role-button").click();
  await expect(confirmSheet).toBeVisible();
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true"); // not yet given up
  await a.page.getByTestId("confirm-release-confirm").click();
  await expect(confirmSheet).toBeHidden();
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "false");
  const picker = a.page.getByTestId("role-picker");
  await expect(picker).toBeVisible();
  // The roles other people are sitting in are shown and disabled, not hidden.
  await expect(a.page.getByTestId("pick-role-B")).toBeDisabled();
  await expect(a.page.getByTestId("pick-role-A")).toBeEnabled();
  await a.page.getByTestId("pick-role-A").click();
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");
  await expect(a.page.getByTestId("phone-role")).toHaveText("A");
  await phaseIs(tv, "lobby");

  /* -------- a phone drops: the seat is held, then freed -------- */
  // B's phone goes away. Its role is kept for the grace period -- so a phone
  // that reconnects lands back on it -- and then freed, so the room is not
  // stuck waiting for a phone that is not coming back. The window is three
  // minutes (`SEAT_GRACE_MS`) -- long enough to cover a phone that was locked
  // and picked up again, a reload, or a walk to the charger -- and the wait
  // below is sized for it (`SEAT_GRACE_WAIT_MS`, at the top of this file): the end
  // of the window is the thing being checked here, and only the clock can
  // show it. The wait is a deadline, not a licence to hang -- a sweep that
  // never fires still fails, one margin later.
  await b.page.close();
  await expect(tv.getByTestId("latest-event")).toContainText("B is held for 3 minutes");
  await expect(tv.getByTestId("role-slot-B")).toHaveAttribute("data-joined", "true");
  await expect(tv.getByTestId("role-slot-B")).toHaveAttribute("data-joined", "false", {
    timeout: SEAT_GRACE_WAIT_MS,
  });
  await expect(tv.getByTestId("latest-event")).toContainText("B is free again");
  b = await openPhone(browser, phoneUrl, "B", "Bo");
  await expect(tv.getByTestId("role-slot-B")).toHaveAttribute("data-joined", "true");

  const c = await openPhone(browser, phoneUrl, "C", "Cy");
  await phaseIs(tv, "playing");

  // A phone is shown its own clues and nobody else's: A has the painting hint,
  // and nothing anywhere on A's page is one of B's spoken digits.
  await a.page.getByTestId("clues-button").click();
  const cluesSheet = a.page.getByTestId("clues-sheet");
  await expect(cluesSheet.getByTestId("clue-painting_hint")).toBeVisible();
  await expect(cluesSheet.getByTestId("clue-code_digit_1")).toHaveCount(0);
  await expect(a.page.getByTestId("phone")).not.toContainText("First digit of the safe code");
  await cluesSheet.getByRole("button", { name: "Close" }).click();
  await expect(cluesSheet).toBeHidden();

  // A and C play with the remote; B plays at the microphone.
  await expect(a.page.getByTestId("dpad-prompt")).toBeVisible();
  await expect(c.page.getByTestId("dpad-prompt")).toBeVisible();
  await expect(b.page.getByTestId("phone-mode")).toHaveText("voice");

  /* -------- five moves, to the midpoint -------- */
  await pressOnRemote(tv, "act:a_read_painting_hint"); // 1  A
  await expectHistory(tv, 1);
  await beat(tv, "01-opening");
  await pressOnRemote(tv, "act:a_shift_painting"); // 2  A, a four-way choice
  await expect(tv.getByTestId("tv-option-0")).toBeVisible();

  /* -------- Back: it closes what is open, and asks before it leaves -------- */
  // On a Fire TV the WebView treats an unhandled Back as "close this WebView",
  // which would end the game for the whole table. So Back is answered here:
  // with a picker open it closes the picker, and with nothing open it asks
  // -- and opens on Stay.
  await tv.keyboard.press("Backspace");
  await expect(tv.getByTestId("tv-options")).toBeHidden();
  await phaseIs(tv, "playing");
  await expectHistory(tv, 1); // the picker closed; nothing was committed

  await tv.keyboard.press("Backspace");
  const leave = tv.getByTestId("leave-prompt");
  await expect(leave).toBeVisible();
  await expect(tv.getByTestId("leave-stay")).toHaveAttribute("data-focused", "true");
  await phaseIs(tv, "playing");

  // Back on the question is Stay. The game is still on screen and still at
  // move one, which is the whole point: a stray Back cannot end the run.
  await tv.keyboard.press("Backspace");
  await expect(leave).toBeHidden();
  await phaseIs(tv, "playing");
  await expectHistory(tv, 1);

  // ...and the move it was about to make is still there to be made.
  await pressOnRemote(tv, "act:a_shift_painting");
  await expect(tv.getByTestId("tv-option-0")).toBeVisible();

  /* -------- a deliberate wrong pick: the refusal prints once, not twice -------- */
  // "lift the right edge" (option 1) is wrong -- option 0 is the one the
  // painting hint supports. The refusal must not advance history, and its
  // sentence must be on screen exactly once: `state.notice.text` must render
  // in only one of `latest-event` or the bordered `notice` box -- rendering
  // in both, at two metres, reads as the game stuttering rather than a
  // deliberate refusal.
  await pressOnRemote(tv, "opt:1");
  await expectHistory(tv, 1);
  const refusal = (await tv.getByTestId("notice").textContent())?.trim() ?? "";
  expect(refusal.length).toBeGreaterThan(0);
  await expect(tv.getByText(refusal, { exact: true })).toHaveCount(1);

  await pressOnRemote(tv, "opt:0");
  await expectHistory(tv, 2);
  await b.page.locator('[data-choice-id="act:b_dictate_code"]').click(); // 3  B
  await expectHistory(tv, 3);
  await b.page.locator('[data-choice-id="act:b_describe_symbols"]').click(); // 4  B
  await expectHistory(tv, 4);
  await pressOnRemote(tv, "act:c_read_drawer_note"); // 5  C
  await expectHistory(tv, 5);
  await beat(tv, "02-safe-open");
  // Ordinary play carries neither the always-on badge nor the "Halfway…"
  // banner; "How we checked" is the entry point.
  await expect(tv.getByTestId("open-how-we-checked")).toBeVisible();
  await tv.getByTestId("open-how-we-checked").click();
  await expect(tv.getByTestId("how-we-checked")).toHaveAttribute("data-ok", "true");
  await tv.getByTestId("close-how-we-checked").click();

  /* -------- the switch: C asks for one-button scan -------- */
  await c.page.getByTestId("change-input-button").click();
  await expect(c.page.getByTestId("input-sheet")).toBeVisible();
  await expect(c.page.getByTestId("hold-slider")).toBeVisible();
  await c.page.getByTestId("pick-mode-scan").click();

  const moment = tv.getByTestId("rebuild-moment");
  await expect(moment).toBeVisible();
  await expect(moment).toHaveAttribute("data-kind", "ok");
  // The moment plays through its four beats and lands on the same thing real
  // play would show next: C's next action, ready to be taken.
  await expect(moment.getByTestId("rebuild-next-action")).toBeVisible({ timeout: 10_000 });
  await expect(moment.getByTestId("rebuild-next-action")).toContainText("C");
  // "Continue" is the stable skip target, on the remote and on the changed
  // player's phone alike.
  await pressOnRemote(tv, "continue");
  await expect(moment).toBeHidden();

  // The switch is recorded, C is re-seated on scan, and the badge re-checked.
  await expect(tv.locator('[data-testid="tv"]')).toHaveAttribute("data-switches", "1");
  await expectHistory(tv, 6); // five actions plus the recorded capability change
  await beat(tv, "03-after-the-switch");
  await expect(c.page.getByTestId("phone-mode")).toHaveText("one-button scan");
  // A scan move can take two holds, and the phone says so: the first picks
  // the action, the second answers the question it asks. Without that hint
  // a first-time player cannot tell what to do.
  await expect(c.page.getByTestId("scan-hint")).toContainText("hold to choose");
  await expect(c.page.getByTestId("scan-tap-hold")).toContainText("tap");
  await expect(c.page.getByTestId("scan-tap-hold")).toContainText("hold");
  // The dial is a two-hold move here, so the first screen C sees is step 1.
  await expect(c.page.getByTestId("scan-hint")).toContainText("step 1 of 2");
  await expect(c.page.getByTestId("scan-hint")).toHaveAttribute("data-steps", "2");
  await tv.getByTestId("open-how-we-checked").click();
  await expect(tv.getByTestId("how-we-checked-role-c")).toHaveAttribute("data-state", "yes");
  await tv.getByTestId("close-how-we-checked").click();
  await expect(c.page.getByTestId("phone-badge")).toHaveAttribute("data-ok", "true");

  /* -------- C plays the rest by scanning -------- */

  // Tap moves the highlight and commits nothing; press-and-hold chooses. So a
  // two-hold move is the normal shape here: one to pick the action, one to pick
  // the alternative it offers.
  const tapMovesNothing = async (): Promise<void> => {
    const before = await historyLength(tv);
    expect(await c.choiceCount()).toBeGreaterThan(0);
    await c.tap();
    await c.page.waitForTimeout(400);
    expect(await historyLength(tv)).toBe(before);
  };

  /**
   * Hold until the TV has recorded `target` events, or give up loudly.
   *
   * A hold on the wrong alternative is a no-op (the answer must matter), so
   * a hold that does not advance the history means "wrong pick": tap once
   * to move the highlight to the next alternative and hold again, rather
   * than holding on the same spot forever.
   */
  let sawSecondStep = false;
  const scanUntil = async (target: number): Promise<void> => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if ((await historyLength(tv)) >= target) return;
      // A hold that opens a question does not move the history on, so this is
      // where the second half of a two-hold move is on screen.
      if ((await c.page.getByTestId("scan-hint").getAttribute("data-step")) === "2") {
        sawSecondStep = true;
      }
      const before = await historyLength(tv);
      await c.hold();
      await c.page.waitForTimeout(400);
      if ((await historyLength(tv)) === before) await c.tap();
    }
    throw new Error(`the one-button scan never got the game to ${target} events`);
  };

  await tapMovesNothing();
  await scanUntil(9); // C's three remaining moves: match the symbol, then two dial steps

  // The second half of a move is announced as such rather than looking like
  // a fresh start, which a player could otherwise mistake it for.
  expect(sawSecondStep, "the phone never showed step 2 of 2").toBe(true);
  await expect(c.page.getByTestId("scan-hint")).toContainText("hold to choose");

  // C's last move is in, and "How we checked" immediately says C is no longer
  // needed: from here the study opens without them. That is the real
  // `certify` talking -- necessity is a property of a state, and this state
  // no longer needs C -- and it is the reason the ending shows the run's
  // claim rather than the finished board. What must not happen is the check
  // claiming otherwise.
  await tv.getByTestId("open-how-we-checked").click();
  await expect(tv.getByTestId("how-we-checked-solvable")).toHaveAttribute("data-state", "yes");
  await expect(tv.getByTestId("how-we-checked-role-c")).toHaveAttribute("data-state", "no");
  await tv.getByTestId("close-how-we-checked").click();

  await pressOnRemote(tv, "act:a_reach_into_safe"); // 10 A
  await expectHistory(tv, 10);
  await b.page.locator('[data-choice-id="act:b_listen_for_tumblers"]').click(); // 11 B
  await expectHistory(tv, 11);
  await pressOnRemote(tv, "act:any_enter_study"); // 12 A
  await expectHistory(tv, 12);
  await beat(tv, "04-door-open");

  /* -------- the ending -------- */
  const ending = tv.getByTestId("ending");
  await expect(ending).toBeVisible();
  await beat(tv, "05-ending");
  await expect(ending).toContainText("The study is open.");
  await expect(tv.getByTestId("ending-certificate-line")).toHaveAttribute("data-ok", "true");
  await expect(tv.getByTestId("ending-certificate-line")).toContainText("You did that together.");
  // Three concise, sourced-from-real-play credits -- not a twelve-row
  // transcript -- as the ending's main content.
  await expect(tv.getByTestId("ending-credit-a")).toBeVisible();
  await expect(tv.getByTestId("ending-credit-b")).toBeVisible();
  await expect(tv.getByTestId("ending-credit-c")).toBeVisible();

  // "How we checked" is one tap away, and the run's claim, role by role: the
  // finished board has no necessary role left in it, so the ending certifies
  // the puzzle as the team met it.
  await tv.getByTestId("ending-how-we-checked-open").click();
  const finalCertificate = tv.getByTestId("final-certificate");
  await expect(finalCertificate).toHaveAttribute("data-ok", "true");
  for (const role of ["a", "b", "c"]) {
    await expect(finalCertificate.getByTestId(`final-certificate-role-${role}`)).toHaveAttribute(
      "data-state",
      "yes",
    );
  }

  // The full history is behind "See our moves", one tap away rather than the
  // ending's main content: every move, and the switch in the middle of it. The
  // dial is two steps after the rebuild where it was one action before, which
  // is the repair showing up in the record rather than being hidden by it.
  //
  // Five moves, the switch, then C matches the symbol and dials in two steps,
  // then A, B and A again: twelve lines, the sixth of them the repair.
  await tv.getByTestId("see-our-moves-open").click();
  const history = tv.locator('[data-testid="history"] li');
  await expect(history).toHaveCount(12);
  await expect(tv.getByTestId("history-5")).toContainText("changed input: dpad → scan");
  await expect(tv.getByTestId("history-6")).toContainText("match the rule");
  await expect(tv.getByTestId("history-7")).toContainText("step 1 of 2");
  await expect(tv.getByTestId("history-8")).toContainText("step 2 of 2");
  await expect(tv.getByTestId("history-11")).toContainText("unlock the study door");

  // The step numbers, all twelve of them, are part of the row and say what
  // they are, not left to the browser's own list marker: a marker laid out
  // outside the row loses "10"'s leading digit once the list can scroll,
  // reading as "0".
  for (let step = 0; step < 12; step++) {
    await expect(tv.getByTestId(`history-num-${step}`)).toHaveText(String(step + 1));
  }
  // ...and it is drawn inside the list rather than beside it.
  const listBox = await tv.getByTestId("history").boundingBox();
  const tenthBox = await tv.getByTestId("history-num-9").boundingBox();
  expect(tenthBox?.x ?? 0).toBeGreaterThanOrEqual(listBox?.x ?? 0);
  await expect(tv.getByTestId("switch-summary")).toContainText("C: dpad → scan");
  await expect(tv.getByTestId("switch-summary")).toContainText("rebuilt and re-proven");
  // The ending's summary carries no raw compiler-effort line ("9 operators
  // certified, 57 states searched").
  await expect(tv.getByTestId("switch-summary")).not.toContainText("states searched");

  await a.context.close();
  await b.context.close();
  await c.context.close();
  await context.close();
});

/**
 * The mid-game counterpart to the lobby reconnect above. The lobby case
 * reconnects into the still-open name/role/Join form; this one closes a
 * phone's tab mid-game and reopens the join link on a genuinely different
 * device -- a fresh browser context, sharing nothing with the one B joined
 * from -- and the join form is gone by the time a role would be assigned.
 * Every role reads "taken", including B's, which is only *held*, and the
 * screen must say so and offer a way back, or this is a dead end.
 */
test("mid-game reconnect from a different device: the named reclaim gets a held seat back", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tv = await context.newPage();
  await tv.goto(TV_URL);
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");

  const phoneUrl = (await tv.getByTestId("phone-url").textContent())?.trim() ?? "";
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  const b = await openPhone(browser, phoneUrl, "B", "Bo");
  const c = await openPhone(browser, phoneUrl, "C", "Cy");
  await phaseIs(tv, "playing");

  // A move first, so the footer's one-line "latest event" has something to
  // overwrite the drop notice with.
  await pressOnRemote(tv, "act:a_read_painting_hint");
  await expectHistory(tv, 1);

  /* -------- B's phone drops mid-game -------- */
  // The seat is held, and stays held for the whole of this test: the window
  // is three minutes (`SEAT_GRACE_MS`), which is why the reclaim below is a
  // request for a held seat rather than a plain join -- and why the assertion
  // that the held line has gone is about the footer being overwritten, not
  // about the seat expiring.
  await b.page.close();
  await expect(tv.getByTestId("latest-event")).toContainText("B is held for 3 minutes");
  await expect(tv.getByTestId("held-seat-B")).toBeVisible();

  // A second move overwrites the footer line; the persistent rail badge must
  // not go with it.
  await pressOnRemote(tv, "act:a_shift_painting");
  await expect(tv.getByTestId("tv-option-0")).toBeVisible();
  await pressOnRemote(tv, "opt:0");
  await expectHistory(tv, 2);
  await expect(tv.getByTestId("latest-event")).not.toContainText("B is held for 3 minutes");
  await expect(tv.getByTestId("held-seat-B")).toBeVisible();

  /* -------- the dead end: a different device, the join link, no name typed -------- */
  // A separate browser context shares no storage with B's own -- the real
  // shape of "a different phone", not a same-browser reopen (that path is
  // `demo.spec.ts`'s "same browser" test below, and it does not need a name).
  const otherDevice = await browser.newContext();
  const returning = await otherDevice.newPage();
  await returning.setViewportSize({ width: 412, height: 915 });
  await returning.goto(phoneUrl);
  await returning.getByTestId("want-B").click();
  await returning.getByTestId("join-button").click();

  // The dead-end symptom itself, confirmed: no role, and B reads as taken
  // exactly like A and C -- and a reclaim option, not nothing else, is what
  // must be on this screen.
  await expect(returning.getByTestId("pick-role-A")).toBeDisabled();
  await expect(returning.getByTestId("pick-role-B")).toBeDisabled();
  await expect(returning.getByTestId("pick-role-C")).toBeDisabled();
  const reclaim = returning.getByTestId("reclaim-seat");
  await expect(reclaim).toBeVisible();
  await expect(reclaim).toContainText("B");

  /* -------- the way back: the name it was joined under, typed here -------- */
  // A public name only ever raises the request now --
  // the seat is not actually handed back until the TV remote says OK.
  await returning.getByTestId("reclaim-name-input").fill("Bo");
  await returning.getByTestId("reclaim-button").click();
  await expect(returning.getByTestId("phone")).toHaveAttribute("data-role", ""); // not seated yet
  await expect(tv.getByTestId("reclaim-approval")).toBeVisible();
  await expect(tv.getByTestId("reclaim-approval")).toContainText("B");
  await answerReclaim(tv, "approve-reclaim");
  await expect(tv.getByTestId("reclaim-approval")).toBeHidden();
  await expect(returning.getByTestId("phone-role")).toHaveText("B");
  await expect(tv.getByTestId("held-seat-B")).toHaveCount(0);

  // B is really back, not just cosmetically seated: the phone can still act,
  // and it is the same team of three, not a fourth player.
  await returning.locator('[data-choice-id="act:b_dictate_code"]').click();
  await expectHistory(tv, 3);

  await a.context.close();
  await c.context.close();
  await returning.close();
  await otherDevice.close();
  await context.close();
});

/**
 * The same-browser counterpart: a player who joined with no name at all has
 * no name to type into the reclaim form above, so the way back is the seat
 * token itself, kept in IndexedDB under the room code
 * (`app/phone/src/seat.ts`'s `seatIdFor`), which a new tab in the same
 * browser reads before it ever sends a `join`. `sessionStorage` could not do
 * this: it is isolated per tab, so a closed-and-reopened tab always minted a
 * stranger's seat. Nor could `localStorage`, quite: a read followed by a
 * write is not one step, so two tabs opening at the same moment could each
 * walk away with a token of their own. One IndexedDB transaction is one step,
 * so they cannot.
 *
 * The token takes an absent seat on its own, with no press on the remote:
 * a seat token is the whole of the proof for a seat
 * nobody is playing. The replay objection that would otherwise make this a
 * request -- a bearer token presented by a brand-new peer id is exactly as
 * replayable as a typed name -- is answered by what the seat is doing, not by
 * who is asking: a seat nobody is playing is worth taking and costs the room
 * nothing, while a seat somebody IS playing is a request and still needs the
 * remote's OK. That live-seat route is the different-device test above.
 */
test("mid-game reconnect, same browser, no name: the seat token takes the absent seat on its own", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tv = await context.newPage();
  await tv.goto(TV_URL);
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");

  const phoneUrl = (await tv.getByTestId("phone-url").textContent())?.trim() ?? "";
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  const c = await openPhone(browser, phoneUrl, "C", "Cy");

  // B joins with no name -- the form calls it optional, and this is the case
  // that makes it actually optional: nothing typed here to reclaim with later.
  const b = await context.newPage();
  await b.setViewportSize({ width: 412, height: 915 });
  await b.goto(phoneUrl);
  await b.getByTestId("want-B").click();
  await b.getByTestId("join-button").click();
  await expect(b.getByTestId("phone-role")).toHaveText("B");
  await phaseIs(tv, "playing");

  await pressOnRemote(tv, "act:a_read_painting_hint");
  await pressOnRemote(tv, "act:a_shift_painting");
  await expect(tv.getByTestId("tv-option-0")).toBeVisible();
  await pressOnRemote(tv, "opt:0");
  await expectHistory(tv, 2);

  /* -------- B's phone drops mid-game -------- */
  await b.close();
  await expect(tv.getByTestId("held-seat-B")).toBeVisible();

  /* -------- the way back: the same link, a new tab, same browser -------- */
  const returning = await context.newPage();
  await returning.setViewportSize({ width: 412, height: 915 });
  await returning.goto(phoneUrl);
  await returning.getByTestId("want-B").click();
  await returning.getByTestId("join-button").click();

  // No reclaim form, no picking a role that reads "taken", and no press on
  // the remote -- the seat token this tab already carries (from this
  // browser's one IndexedDB entry for the room) is the whole of the proof
  // while B's seat is absent. The TV says so in its own words, which is the
  // positive half of the claim: the seat came back to the token, rather than
  // the TV having been asked and having agreed.
  await expect(returning.getByTestId("phone-role")).toHaveText("B");
  await expect(tv.getByTestId("latest-event")).toContainText("they still have B");
  await expect(tv.getByTestId("held-seat-B")).toHaveCount(0);

  await returning.locator('[data-choice-id="act:b_dictate_code"]').click();
  await expectHistory(tv, 3);

  await a.context.close();
  await c.context.close();
  await returning.close();
  await context.close();
});

/**
 * The TV can say no. Declining leaves the requester
 * without the seat, and the original name still reads as held, not silently
 * reassigned either way.
 */
test("a named reclaim the TV declines does not hand the seat over", async ({ browser }) => {
  const context = await browser.newContext();
  const tv = await context.newPage();
  await tv.goto(TV_URL);
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");

  const phoneUrl = (await tv.getByTestId("phone-url").textContent())?.trim() ?? "";
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  const b = await openPhone(browser, phoneUrl, "B", "Bo");
  const c = await openPhone(browser, phoneUrl, "C", "Cy");
  await phaseIs(tv, "playing");

  await b.page.close();
  await expect(tv.getByTestId("held-seat-B")).toBeVisible();

  const otherDevice = await browser.newContext();
  const returning = await otherDevice.newPage();
  await returning.setViewportSize({ width: 412, height: 915 });
  await returning.goto(phoneUrl);
  await returning.getByTestId("want-B").click();
  await returning.getByTestId("join-button").click();
  await returning.getByTestId("reclaim-name-input").fill("Bo");
  await returning.getByTestId("reclaim-button").click();

  await expect(tv.getByTestId("reclaim-approval")).toBeVisible();
  await answerReclaim(tv, "decline-reclaim");
  await expect(tv.getByTestId("reclaim-approval")).toBeHidden();
  await expect(returning.getByTestId("phone")).toHaveAttribute("data-role", ""); // never seated
  // B's own seat is still held, not silently vacated either.
  await expect(tv.getByTestId("held-seat-B")).toBeVisible();

  await a.context.close();
  await c.context.close();
  await returning.close();
  await otherDevice.close();
  await context.close();
});

/**
 * The reclaim overlay is modal, but the
 * board it covers stays mounted underneath it (that is how `.overlay`
 * layers on top at all) -- an unscoped `moveFocus` could walk the ring off
 * the overlay's own two buttons and onto one of those underlying controls,
 * which a Select press would then actually run. The overlay's targets are
 * now everything the ring can reach while `pendingReclaim` is up.
 */
test("a reclaim overlay traps the remote: arrow keys never walk focus onto a control it covers", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tv = await context.newPage();
  await tv.goto(TV_URL);
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");

  const phoneUrl = (await tv.getByTestId("phone-url").textContent())?.trim() ?? "";
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  const b = await openPhone(browser, phoneUrl, "B", "Bo");
  const c = await openPhone(browser, phoneUrl, "C", "Cy");
  await phaseIs(tv, "playing");

  await b.page.close();
  await expect(tv.getByTestId("held-seat-B")).toBeVisible();

  const otherDevice = await browser.newContext();
  const returning = await otherDevice.newPage();
  await returning.setViewportSize({ width: 412, height: 915 });
  await returning.goto(phoneUrl);
  await returning.getByTestId("want-B").click();
  await returning.getByTestId("join-button").click();
  await returning.getByTestId("reclaim-name-input").fill("Bo");
  await returning.getByTestId("reclaim-button").click();

  await expect(tv.getByTestId("reclaim-approval")).toBeVisible();

  // Every arrow direction, repeatedly, against a board that is still mounted
  // (and would still offer real action/Leave targets) underneath.
  for (let i = 0; i < 12; i++) {
    await tv.keyboard.press(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"][i % 4]!);
    await tv.waitForTimeout(30);
    const focusedOutside = await tv
      .locator(
        '[data-focused="true"]:not([data-testid="reclaim-approval-decline"]):not([data-testid="reclaim-approval-approve"])',
      )
      .count();
    expect(focusedOutside, `step ${i}: focus escaped the reclaim overlay`).toBe(0);
  }
  await expect(tv.getByTestId("reclaim-approval")).toBeVisible(); // never dismissed by the arrow spam

  await answerReclaim(tv, "decline-reclaim");
  await expect(tv.getByTestId("reclaim-approval")).toBeHidden();

  await a.context.close();
  await c.context.close();
  await returning.close();
  await otherDevice.close();
  await context.close();
});

/**
 * The switch broadcast is deduped per connected peer, not
 * globally -- a player who reconnects under a new peer id mid-beat has never
 * received this beat's encoding under their own key, so it goes out again
 * rather than leaving their new phone silent until the next beat happens to
 * tick over on its own. Reduced motion holds the TV on beat 0 indefinitely,
 * so the reconnect happens inside a real, non-flaky window rather than a race
 * against the 8-second timer.
 */
test("a player who reconnects mid-switch still gets the rebuild moment on their new phone", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const tv = await context.newPage();
  await tv.goto(TV_URL);
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");

  const phoneUrl = (await tv.getByTestId("phone-url").textContent())?.trim() ?? "";
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  const b = await openPhone(browser, phoneUrl, "B", "Bo");
  const c = await openPhone(browser, phoneUrl, "C", "Cy");
  await phaseIs(tv, "playing");

  /* -------- C asks for one-button scan; reduced motion holds beat 0 -------- */
  await c.page.getByTestId("change-input-button").click();
  await expect(c.page.getByTestId("input-sheet")).toBeVisible();
  await c.page.getByTestId("pick-mode-scan").click();
  await expect(tv.getByTestId("rebuild-moment")).toBeVisible();
  await expect(tv.getByTestId("rebuild-moment")).toHaveAttribute("data-beat", "0");
  // C's own phone got this beat's broadcast once, before dropping.
  await expect(c.page.getByTestId("phone-switch-banner")).toBeVisible();

  /* -------- C's phone drops mid-beat, and reopens under a new peer id -------- */
  await c.page.close();
  await expect(tv.getByTestId("held-seat-C")).toBeVisible();
  const returning = await c.context.newPage();
  await returning.setViewportSize({ width: 412, height: 915 });
  await returning.goto(phoneUrl);
  await returning.getByTestId("want-C").click();
  await returning.getByTestId("join-button").click();
  // Same browser, absent seat: the seat token this tab already carries takes
  // C's place on its own, with no press on the remote. The new page still
  // arrives as a peer id the room has never seen, which is what this test is
  // about.
  await expect(returning.getByTestId("phone-role")).toHaveText("C");
  await expect(tv.getByTestId("held-seat-C")).toHaveCount(0);

  // The rebuild moment on the TV never moved off beat 0 (reduced motion), so
  // this is the SAME beat C's old peer id already received -- the new phone
  // must still be told, under its own key, not left silent.
  await expect(tv.getByTestId("rebuild-moment")).toHaveAttribute("data-beat", "0");
  await expect(returning.getByTestId("phone-switch-banner")).toBeVisible({ timeout: 5_000 });

  await pressOnRemote(tv, "continue");
  await a.context.close();
  await b.context.close();
  await c.context.close();
  await context.close();
});
