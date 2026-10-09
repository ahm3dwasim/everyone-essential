/**
 * The mystery picker, driven with the remote.
 *
 * The unit table (`test/mysteries.test.ts`) proves every mystery is a real
 * mystery. This proves the other half of the claim: that a person on a couch
 * can *choose* between them with a D-pad, that the ring reaches the choice, and
 * that switching mystery leaves the room code and the QR flow exactly where
 * they were. A picker nothing can reach is the same ceiling as one mystery.
 *
 * Kept separate from `demo.spec.ts`, which is the frozen end-to-end demo run and
 * must keep passing unchanged -- it drives the whole three-phone game, and this
 * needs none of that.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HTTP_PORT = Number(process.env.SMOKE_HTTP_PORT ?? 8123);
const RELAY_PORT = Number(process.env.SMOKE_RELAY_PORT ?? 8790);
const TV_URL = `http://127.0.0.1:${HTTP_PORT}/?relay=${encodeURIComponent(`ws://127.0.0.1:${RELAY_PORT}`)}`;

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
  await waitForPort(RELAY_PORT, "the relay");
  await waitForPort(HTTP_PORT, "the static server");
});

test.afterAll(() => {
  relay?.kill();
  server?.kill();
});

/* ------------------------------------------------------------------ */
/* The remote                                                          */
/* ------------------------------------------------------------------ */

async function focusedId(tv: Page): Promise<string> {
  return (await tv.locator('[data-testid="tv"]').getAttribute("data-focus")) ?? "";
}

async function boxOf(tv: Page, id: string) {
  return tv
    .locator(`[data-focus-id="${id}"]`)
    .boundingBox({ timeout: 500 })
    .catch(() => null);
}

/**
 * Walk the ring to `id` with arrow keys, the way a thumb would.
 *
 * Not greedy: the shortest way to a control is often not the dominant axis.
 * From the first mystery, the second is to the *right* and the third is
 * *below* -- a walker that always presses toward the larger offset reaches the
 * second, then has nowhere right to go. So when a press does not move the ring
 * at all, this tries the perpendicular axis instead, which is exactly the
 * correction a person makes when a press does nothing.
 */
async function focusOn(tv: Page, id: string): Promise<void> {
  const horizontal = (dx: number, dy: number) =>
    Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "ArrowRight" : "ArrowLeft") : dy > 0 ? "ArrowDown" : "ArrowUp";
  const flip = (key: string, dx: number, dy: number) =>
    key === "ArrowRight" || key === "ArrowLeft"
      ? dy > 0
        ? "ArrowDown"
        : dy < 0
          ? "ArrowUp"
          : key
      : Math.abs(dx) < 4
        ? key
        : dx > 0
          ? "ArrowRight"
          : "ArrowLeft";

  for (let step = 0; step < 24; step++) {
    const want = await boxOf(tv, id);
    if (!want) {
      await tv.waitForTimeout(120);
      continue;
    }
    const current = await focusedId(tv);
    if (current === id) return;
    const have = current ? await boxOf(tv, current) : null;
    let key = "ArrowRight";
    let dx = 1;
    let dy = 0;
    if (have) {
      dx = want.x + want.width / 2 - (have.x + have.width / 2);
      dy = want.y + want.height / 2 - (have.y + have.height / 2);
      key = horizontal(dx, dy);
    }
    await tv.keyboard.press(key);
    await tv.waitForTimeout(60);
    if (have && (await focusedId(tv)) === current) {
      // That press went nowhere. Try the other axis before moving on.
      const other = flip(key, dx, dy);
      if (other !== key) {
        await tv.keyboard.press(other);
        await tv.waitForTimeout(60);
      }
    }
  }
  throw new Error(`the focus ring never reached ${id}`);
}

/* ------------------------------------------------------------------ */
/* The tests                                                           */
/* ------------------------------------------------------------------ */

test("the lobby offers the painted mysteries, and the remote can reach the choice", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(TV_URL);
  await expect(page.getByTestId("lobby")).toBeVisible();

  // One real, focusable control per mystery -- the three painted, hand-written
  // ones. The generated fourth has no painted plates and shows a black screen
  // if picked, so the picker a family actually sees leaves it out.
  const options = page.locator('[data-testid="mystery-picker"] [data-focus-id^="mystery:"]');
  await expect(options).toHaveCount(3);
  await expect(page.getByTestId("mystery-generated-the-lighthouse-braid-7")).toHaveCount(0);
  await expect(page.getByTestId("mystery-the-locked-study")).toHaveAttribute(
    "data-current",
    "true",
  );

  // The ring reaches the third option by arrow keys alone, and the CSS ring is
  // the same 8px outline every other control uses -- asserted through the same
  // `data-focused` attribute the app already exposes.
  await focusOn(page, "mystery:the-treehouse");
  await expect(page.getByTestId("mystery-the-treehouse")).toHaveAttribute(
    "data-focused",
    "true",
  );
});

test("the generated mystery stays reachable behind ?generated=1, for a demo", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${TV_URL}&generated=1`);
  await expect(page.getByTestId("lobby")).toBeVisible();

  const options = page.locator('[data-testid="mystery-picker"] [data-focus-id^="mystery:"]');
  await expect(options).toHaveCount(4);
  await expect(page.getByTestId("mystery-generated-the-lighthouse-braid-7")).toBeVisible();
});

test("choosing a mystery keeps the room and the QR flow, and reseats the room", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(TV_URL);
  await expect(page.getByTestId("lobby")).toBeVisible();

  const roomBefore = await page.getByTestId("room-code").textContent();
  expect(roomBefore?.trim().length).toBeGreaterThan(0);

  // The three-role study seats three roles.
  await expect(page.getByTestId("role-slot-A")).toBeVisible();
  await expect(page.getByTestId("role-slot-B")).toBeVisible();
  await expect(page.getByTestId("role-slot-C")).toBeVisible();

  // Choose the two-player mystery by remote.
  await focusOn(page, "mystery:the-treehouse");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("mystery-the-treehouse")).toHaveAttribute("data-current", "true");
  await expect(page.getByTestId("mystery-the-locked-study")).toHaveAttribute(
    "data-current",
    "false",
  );

  // Two seats, not three: C is gone from the lobby entirely.
  await expect(page.getByTestId("role-slot-A")).toBeVisible();
  await expect(page.getByTestId("role-slot-B")).toBeVisible();
  await expect(page.getByTestId("role-slot-C")).toHaveCount(0);

  // The room code and the QR are untouched by the choice.
  await expect(page.getByTestId("room-code")).toHaveText(roomBefore?.trim() ?? "");
  await expect(page.getByTestId("qr")).toBeVisible();
  // Live-gated -- nobody has joined this room.
  await expect(page.getByTestId("lobby-badge")).toHaveAttribute("data-ok", "false");

  // And back again: the study still seats three.
  await focusOn(page, "mystery:the-locked-study");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("role-slot-C")).toBeVisible();
  await expect(page.getByTestId("room-code")).toHaveText(roomBefore?.trim() ?? "");
});

test("a two-player mystery starts when its own two seats are filled", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(TV_URL);
  await expect(page.getByTestId("lobby")).toBeVisible();

  await focusOn(page, "mystery:the-treehouse");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("mystery-the-treehouse")).toHaveAttribute("data-current", "true");

  // A and B join; nobody takes a third seat, because there is not one. The
  // phone URL comes off the TV exactly as a person would scan it -- room code
  // and relay included -- so this is the real join path, not a shortcut.
  const phoneUrl = (await page.getByTestId("phone-url").textContent())?.trim() ?? "";
  expect(phoneUrl).toContain("room=");
  const contexts = [];
  // Each phone is its own browser context: the join seat lives in one
  // IndexedDB entry, keyed by room code, and two tabs sharing one context
  // would read that one token and count as one player.
  for (const [role, name] of [
    ["A", "grown-up"],
    ["B", "child"],
  ] as const) {
    const phoneContext = await browser.newContext();
    const phone = await phoneContext.newPage();
    await phone.setViewportSize({ width: 412, height: 915 });
    await phone.goto(phoneUrl);
    await phone.getByTestId("name-input").fill(name);
    await phone.getByTestId(`want-${role}`).click();
    await phone.getByTestId("join-button").click();
    await expect(phone.getByTestId("phone-role")).toHaveText(role);
    contexts.push(phoneContext);
  }

  // Two seats filled is a full room *for this mystery*: the game starts rather
  // than waiting forever for a role that does not exist. There is no visible
  // phase-chip -- the visible board already communicates this -- so the
  // phase is read from the same `data-phase` attribute the app always
  // carries on its root.
  await expect(page.getByTestId("tv")).toHaveAttribute("data-phase", "playing");
  for (const phoneContext of contexts) await phoneContext.close();
});

/**
 * The join screen has no connection yet, so it cannot
 * check the URL's own `mystery=` against anything real -- a stale link or an
 * edited fragment could claim any title. It shows the neutral product name
 * instead, whatever the TV has actually picked.
 */
test("the phone's join screen never trusts the URL for the mystery title", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(TV_URL);
  await expect(page.getByTestId("lobby")).toBeVisible();

  // Pick a mystery that is not the default -- proving the heading does NOT
  // follow the TV's live pick is the whole point here.
  await focusOn(page, "mystery:the-treehouse");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("mystery-the-treehouse")).toHaveAttribute("data-current", "true");

  const phoneUrl = (await page.getByTestId("phone-url").textContent())?.trim() ?? "";
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 412, height: 915 });
  await phone.goto(phoneUrl);
  await expect(phone.getByTestId("join-heading")).toHaveText("Everyone Is Essential");
  await expect(phone.getByTestId("join-heading")).not.toHaveText("The Treehouse");
});

test("the phone's join screen ignores a forged mystery in the URL fragment", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(TV_URL);
  await expect(page.getByTestId("lobby")).toBeVisible();

  const realUrl = (await page.getByTestId("phone-url").textContent())?.trim() ?? "";
  // There is no `mystery=` field to swap any more -- so this now forges one that was never
  // there at all: the "stale link, or an edited fragment" case, one step
  // further. The room and relay stay real; only the appended title is forged.
  expect(realUrl).not.toContain("mystery=");
  const forgedUrl = `${realUrl}&mystery=${encodeURIComponent("Anything At All")}`;

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 412, height: 915 });
  await phone.goto(forgedUrl);
  await expect(phone.getByTestId("join-heading")).toHaveText("Everyone Is Essential");
  await expect(phone.getByTestId("join-heading")).not.toHaveText("Anything At All");
});
