/**
 * The plate is the screen, and no UI text is ever laid over the painting.
 *
 * The shell's claim is geometric: every plate has an identical flat
 * right-hand reserve starting at raster x=800 of a 1280 master, and
 * `object-fit: cover` puts that boundary at exactly 62.5% of viewport width
 * at any landscape viewport -- the 1920x1080 output and the Stick's
 * 960x480 Silk CSS viewport alike.
 * `.rail-shell` in `styles.css` is everything right of that line; nothing this
 * app renders should ever have a box that starts to the left of it.
 *
 * This is checked per element, not just for the rail's own outer box, because
 * an outer box passing proves nothing about a child with a stray negative
 * margin or absolute position escaping it: nudging `--rail-x` to 55vw (7.5%
 * of the viewport, into the painting) fails both assertions below at both
 * viewports, which is the scenario a per-element check catches and a
 * rail-only check would miss.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
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

/**
 * Every element with a `data-testid` or a `data-focus-id` inside `container`
 * must have a box that starts at or right of the painting/rail boundary --
 * 62.5% of the viewport's own width, not the container's, because the whole
 * point is where things land on the physical screen the plate fills.
 */
async function assertNothingOnThePainting(
  page: Page,
  containerTestId: string,
  viewportWidth: number,
): Promise<void> {
  const boundaryPx = viewportWidth * 0.625;
  const tolerancePx = 2; // sub-pixel rounding across browser layout engines
  const container = page.getByTestId(containerTestId);
  await expect(container).toBeVisible();
  const containerBox = await container.boundingBox();
  if (!containerBox) throw new Error(`${containerTestId} has no box at ${viewportWidth}px wide`);
  expect(
    containerBox.x,
    `${containerTestId}'s own box starts inside the painting at ${viewportWidth}px wide`,
  ).toBeGreaterThanOrEqual(boundaryPx - tolerancePx);

  const nodes = await page
    .locator(
      `[data-testid="${containerTestId}"] [data-testid], [data-testid="${containerTestId}"] [data-focus-id]`,
    )
    .all();
  expect(nodes.length, `${containerTestId} has nothing to check`).toBeGreaterThan(0);
  for (const node of nodes) {
    const box = await node.boundingBox();
    if (!box || (box.width === 0 && box.height === 0)) continue; // not on screen right now
    const label = (await node.getAttribute("data-testid")) ?? (await node.getAttribute("data-focus-id"));
    expect(
      box.x,
      `"${label}" inside ${containerTestId} crosses into the painting at ${viewportWidth}px wide (box.x=${box.x}, boundary=${boundaryPx})`,
    ).toBeGreaterThanOrEqual(boundaryPx - tolerancePx);
  }
}

const VIEWPORTS = [
  { width: 1920, height: 1080, label: "1920x1080 output" },
  { width: 960, height: 480, label: "960x480 Silk (DPR 4)" },
];

for (const viewport of VIEWPORTS) {
  test(`no text lands on the painting: the lobby, at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(TV_URL);
    await expect(page.getByTestId("lobby")).toBeVisible();
    await assertNothingOnThePainting(page, "lobby", viewport.width);
  });

  test(`no text lands on the painting: ordinary play, at ${viewport.label}`, async ({ page, browser }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(TV_URL);
    await expect(page.getByTestId("lobby")).toBeVisible();
    const phoneUrl = (await page.getByTestId("phone-url").textContent())?.trim() ?? "";
    const phones = [];
    // Each phone gets its own browser context -- a real phone's own storage,
    // shared with nothing else. The join seat is one IndexedDB entry per room
    // code (`app/phone/src/seat.ts`), so three tabs of one context would all
    // read the same token and count as one player.
    const contexts = [];
    for (const [role, name] of [
      ["A", "Ada"],
      ["B", "Bo"],
      ["C", "Cy"],
    ] as const) {
      const phoneContext = await browser.newContext();
      const phone = await phoneContext.newPage();
      await phone.setViewportSize({ width: 412, height: 915 });
      await phone.goto(phoneUrl);
      await phone.getByTestId("name-input").fill(name);
      await phone.getByTestId(`want-${role}`).click();
      await phone.getByTestId("join-button").click();
      await expect(phone.getByTestId("phone-role")).toHaveText(role);
      phones.push(phone);
      contexts.push(phoneContext);
    }
    // Phones stay connected through the check, then close together: a closed
    // page reads as a dropped seat and would hold the room in "lobby".
    await expect(page.getByTestId("tv")).toHaveAttribute("data-phase", "playing");
    await assertNothingOnThePainting(page, "play-rail", viewport.width);
    for (const phoneContext of contexts) await phoneContext.close();
  });

  /**
   * The rebuild moment renders as `.rail-shell`, like every other surface, so
   * the same painting-free check applies here too: putting an `overlay
   * rebuild-moment` class on the element (a deliberately misplaced surface,
   * `inset: 0` instead of confined to the rail) fails this check's own
   * container assertion at both viewports (box.x lands at 0, not >= the rail
   * boundary), which is exactly the mistake this test exists to catch.
   */
  test(`no text lands on the painting: the rebuild moment, at ${viewport.label}`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(TV_URL);
    await expect(page.getByTestId("lobby")).toBeVisible();
    const phoneUrl = (await page.getByTestId("phone-url").textContent())?.trim() ?? "";
    const phones: { role: string; page: Page; context: BrowserContext }[] = [];
    // One browser context per phone -- see the "ordinary play" test above for
    // why sharing one no longer works now that the join seat lives in one
    // IndexedDB entry, keyed by room code.
    for (const [role, name] of [
      ["A", "Ada"],
      ["B", "Bo"],
      ["C", "Cy"],
    ] as const) {
      const phoneContext = await browser.newContext();
      const phone = await phoneContext.newPage();
      await phone.setViewportSize({ width: 412, height: 915 });
      await phone.goto(phoneUrl);
      await phone.getByTestId("name-input").fill(name);
      await phone.getByTestId(`want-${role}`).click();
      await phone.getByTestId("join-button").click();
      await expect(phone.getByTestId("phone-role")).toHaveText(role);
      phones.push({ role, page: phone, context: phoneContext });
    }
    await expect(page.getByTestId("tv")).toHaveAttribute("data-phase", "playing");

    const c = phones.find((p) => p.role === "C")!.page;
    await c.getByTestId("change-input-button").click();
    await expect(c.getByTestId("input-sheet")).toBeVisible();
    await c.getByTestId("pick-mode-scan").click();

    const moment = page.getByTestId("rebuild-moment");
    await expect(moment).toBeVisible();
    await assertNothingOnThePainting(page, "rebuild-moment", viewport.width);

    for (const phone of phones) await phone.context.close();
  });
}
