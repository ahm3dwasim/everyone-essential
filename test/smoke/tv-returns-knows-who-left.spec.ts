/**
 * A TV that comes back to its room finds out who left while it was away.
 *
 * The relay only tells the peers in a room that somebody left, and a TV whose
 * socket is down is not one of them. So a phone that goes during the gap is
 * news the TV only ever gets from its own `welcome`, and this run is the proof
 * that it reads it: the TV's wire is held down, a player closes their phone,
 * the wire is restored, and the room says out loud that it is waiting for her.
 *
 * Without that, the seat stays counted as present -- the room goes on claiming
 * it can finish together with an empty phone beside it -- and the same player
 * coming back has to be approved by hand on the remote instead of simply
 * sitting down again.
 *
 * The TV's socket is held by an init script that records what the page dials
 * and can hold its reconnects down. That is an instrument, not a behaviour:
 * the page still dials the real `WebSocket`, and holding it down is what makes
 * the gap real -- the relay has to have seen the real TV leave before the
 * player's own departure means anything to it.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HTTP_PORT = Number(process.env.SMOKE_HTTP_PORT ?? 8123);
const RELAY_PORT = Number(process.env.SMOKE_RELAY_PORT ?? 8790);

function relayUrl(): string {
  return `ws://127.0.0.1:${RELAY_PORT}`;
}

const TV_URL = `http://127.0.0.1:${HTTP_PORT}/?relay=${encodeURIComponent(relayUrl())}`;

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

/* ------------------------------------------------------------------ */
/* Holding the TV's wire                                               */
/* ------------------------------------------------------------------ */

interface TvWire {
  hold: boolean;
  sockets: { close(): void }[];
}

/** Record what the TV dials, and let a test hold its reconnects down. */
async function instrumentTv(tv: Page): Promise<void> {
  await tv.addInitScript(() => {
    const Native = window.WebSocket;
    const wire = { hold: false, sockets: [] as unknown[] };
    (window as unknown as { __tvWire: typeof wire }).__tvWire = wire;

    /**
     * A dial that fails at once, rather than one that sits inert: the client's
     * own reconnect schedule is then the only thing deciding when the TV comes
     * back, so restoring the wire is enough and the test never has to guess at
     * a timer.
     */
    class Held {
      readyState = 0;
      onopen: unknown = null;
      onclose: (() => void) | null = null;
      onerror: unknown = null;
      onmessage: unknown = null;
      constructor() {
        setTimeout(() => this.onclose?.(), 0);
      }
      send(): void {}
      close(): void {}
    }

    const Dial = function (this: unknown, url: string, protocols?: string | string[]) {
      if (wire.hold) return new Held();
      const socket = new Native(url, protocols);
      wire.sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;
    Object.defineProperty(window, "WebSocket", { value: Dial, writable: true, configurable: true });
  });
}

/**
 * Take the TV's wire down, or bring it back. Down closes the socket it is on
 * now as well as holding every reconnect after it -- a hold that only refused
 * new dials would leave the live socket up, the relay still counting the room
 * as having a TV, and the gap this run is about would never happen.
 */
async function holdWire(tv: Page, hold: boolean): Promise<void> {
  await tv.evaluate((next) => {
    const wire = (window as unknown as { __tvWire: TvWire }).__tvWire;
    wire.hold = next;
    if (next) for (const socket of wire.sockets) socket.close();
  }, hold);
}

async function openPhone(
  browser: Browser,
  url: string,
  role: string,
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(url);
  await page.getByTestId("name-input").fill(name);
  await page.getByTestId(`want-${role}`).click();
  await page.getByTestId("join-button").click();
  await expect(page.getByTestId("phone-role")).toHaveText(role);
  return { context, page };
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

test("a phone that leaves while the TV is away is waited for when the TV comes back", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const tv = await context.newPage();
  await instrumentTv(tv);
  await tv.goto(TV_URL);

  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");
  const room = ((await tv.getByTestId("room-code").textContent()) ?? "").trim();
  expect(room).toMatch(/^[A-Z]{4}$/);
  const phoneUrl = ((await tv.getByTestId("phone-url").textContent()) ?? "").trim();

  const ada = await openPhone(browser, phoneUrl, "A", "Ada");
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");
  await expect(tv.getByTestId("role-slot-A")).toContainText("Ada");

  /* -------- the TV's wire goes away and stays away -------- */
  await holdWire(tv, true);

  /* -------- Ada leaves while the TV cannot hear about it -------- */
  await ada.context.close();
  // The relay has to have seen her go before the TV is allowed back, or its
  // welcome would still list her and there would be nothing to reconcile.
  await tv.waitForTimeout(1_000);

  /* -------- the TV comes back -------- */
  await holdWire(tv, false);
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");
  // The same room, not a fresh one.
  await expect(tv.getByTestId("room-code")).toHaveText(room);

  // The news the TV could only have got from its own welcome: Ada is gone,
  // and the room says who it is waiting for rather than counting her seat as
  // filled. Her seat is held, not offered to somebody else.
  await expect(tv.getByTestId("latest-event")).toContainText("Ada dropped out");
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");

  await context.close();
});
