/**
 * One browser is one player, and a seat only ever moves when the room says so.
 *
 * Two tabs of the SAME browser context -- which is to say the same IndexedDB,
 * the same storage a real second tab would open onto. This is the end-to-end
 * half of a rule the unit tests check in pieces: that both tabs mint the same
 * seat token, that the second one presenting it takes nothing, that the TV is
 * asked before anything moves, and that the phone that loses the seat is
 * actually closed out and told why rather than left believing it is still
 * playing.
 *
 * Then the way back: "Use this one instead" on the superseded tab goes through
 * exactly the same rule -- it asks, it does not take.
 *
 * The other half of "one browser is one player" is here too: while it waits,
 * the second tab is shown the plain sentence and no role picker at all,
 * because a second role for the same browser is not something the TV would
 * ever grant.
 *
 * Kept separate from `demo.spec.ts`, which is the frozen end-to-end demo run
 * and needs none of this.
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
  relay.stderr?.on("data", (chunk) => process.stderr.write(`[relay] ${chunk}`));
  server.stderr?.on("data", (chunk) => process.stderr.write(`[serve] ${chunk}`));
  await waitForPort(RELAY_PORT, "the relay");
  await waitForPort(HTTP_PORT, "the static server");
});

test.afterAll(() => {
  relay?.kill();
  server?.kill();
});

/**
 * Answer the request on screen. Each control's focus id carries the id of the
 * request it decides, so the exact id is read off the overlay rather than
 * assumed -- a press can only ever land on the request the TV was showing.
 */
async function approveOnRemote(tv: Page): Promise<void> {
  const button = tv.locator('[data-focus-id^="approve-reclaim:"]').first();
  await expect(button).toBeVisible();
  await button.click();
}

/** This tab's own view of the browser's stored seat token, read out of IndexedDB. */
async function storedSeatToken(page: Page, room: string): Promise<string | null> {
  return page.evaluate(
    (roomCode) =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open("everyone-essential-seats", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("seats");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const read = db.transaction("seats", "readonly").objectStore("seats").get(roomCode);
          read.onsuccess = () => {
            resolve(typeof read.result === "string" ? read.result : null);
            db.close();
          };
          read.onerror = () => {
            reject(read.error);
            db.close();
          };
        };
      }),
    room,
  );
}

test("two tabs of one browser: the second asks for the seat, the TV moves it, the first is told", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tv = await context.newPage();
  await tv.goto(TV_URL);
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");

  const phoneUrl = (await tv.getByTestId("phone-url").textContent())?.trim() ?? "";
  const room = (await tv.getByTestId("room-code").textContent())?.trim() ?? "";
  expect(room).toMatch(/^[A-Z]{4}$/);

  /* -------- tab 1 joins and is seated -------- */
  const tab1 = await context.newPage();
  await tab1.setViewportSize({ width: 412, height: 915 });
  await tab1.goto(phoneUrl);
  await tab1.getByTestId("want-B").click();
  await tab1.getByTestId("join-button").click();
  await expect(tab1.getByTestId("phone-role")).toHaveText("B");

  /* -------- tab 2 opens onto the same storage -------- */
  const tab2 = await context.newPage();
  await tab2.setViewportSize({ width: 412, height: 915 });
  await tab2.goto(phoneUrl);
  await tab2.getByTestId("join-button").click();

  // One browser, one token: both tabs are looking at the same stored value,
  // which is the whole reason the TV sees this as a contest for ONE seat
  // rather than two players arriving.
  const token = await storedSeatToken(tab1, room);
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  expect(await storedSeatToken(tab2, room)).toBe(token);

  /* -------- the TV is asked, and until it answers nothing moves -------- */
  const overlay = tv.getByTestId("reclaim-approval");
  await expect(overlay).toBeVisible();
  // The seat being asked for is one somebody is playing, and the question
  // says so rather than suggesting a player is coming back.
  await expect(overlay).toHaveAttribute("data-live", "true");
  await expect(overlay).toContainText("being played right now");
  // Tab 1 is still B, and tab 2 still has nothing.
  await expect(tab1.getByTestId("phone-role")).toHaveText("B");
  await expect(tab2.getByTestId("phone-role")).toHaveCount(0);
  // And tab 2 is told whose phone this is, in one sentence, with no role
  // picker: one browser is one player, so every role on that picker would be
  // refused. The seat can still reach this tab -- but only if the TV moves it.
  await expect(tab2.getByTestId("other-tab-notice")).toHaveText(
    "This phone is already playing as B in another tab.",
  );
  await expect(tab2.getByTestId("role-picker")).toHaveCount(0);
  await expect(tab2.getByTestId("release-claim-button")).toHaveCount(0);

  /* -------- one press moves it, and closes the older connection -------- */
  await approveOnRemote(tv);
  await expect(overlay).toBeHidden();
  await expect(tab2.getByTestId("phone-role")).toHaveText("B");
  await expect(tab1.getByTestId("superseded-notice")).toHaveText(
    "This seat is now open on another tab or phone.",
  );

  /* -------- "Use this one instead" asks the same question back -------- */
  await tab1.getByTestId("use-this-one-instead").click();
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("data-live", "true");
  // Still nothing taken: tab 2 keeps the seat until the remote answers.
  await expect(tab2.getByTestId("phone-role")).toHaveText("B");

  await approveOnRemote(tv);
  await expect(overlay).toBeHidden();
  await expect(tab1.getByTestId("phone-role")).toHaveText("B");
  await expect(tab2.getByTestId("superseded-notice")).toHaveText(
    "This seat is now open on another tab or phone.",
  );

  // And the room never thought there were two Bs: one seat, one holder.
  await expect(tv.locator('[data-testid="held-seat-B"]')).toHaveCount(0);

  await tab1.close();
  await tab2.close();
  await context.close();
});
