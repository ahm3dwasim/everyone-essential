/**
 * A relay that dies and comes back: the phone is told the game ended, and can
 * walk back into the room the TV makes again.
 *
 * Restarting the relay is not a blip with a TV on the other side of it. The new
 * process has never heard of the room -- there is no TV away and coming back,
 * there is no room at all -- and it answers the phone's reconnect with
 * `unknown_room`. The phone is holding the code of a room that no longer
 * exists, which is exactly why its own memory cannot be the thing that decides:
 * before this round it read that refusal as the TV stepping out and sat on
 * "Waiting for the TV…" for good, while the TV came back and made a room it was
 * never a member of.
 *
 * So this run is the whole story end to end, through the real relay process and
 * the real pages: a phone is seated, the relay is killed and replaced, the
 * phone is told the game ended on the TV rather than left waiting, the TV comes
 * back and makes its room again, and the phone joins it and is seated again --
 * on the seat token its browser never lost.
 *
 * The TV's own wire is held down across the restart so the order is the one
 * that matters rather than the one that happens to happen: the phone has to
 * dial the new relay before the TV does, because a room is gone only until the
 * TV comes back and makes it. That is an instrument, not a behaviour -- the
 * held socket opens for real, dialling the real `WebSocket`, the moment the
 * test lets it go.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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

async function portOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
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
}

async function waitForPort(port: number, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await portOpen(port))) {
    if (Date.now() > deadline) throw new Error(`${label} never came up on port ${port}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Wait until nothing is listening: without this the replacement relay is a race. */
async function waitForPortClosed(port: number, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (await portOpen(port)) {
    if (Date.now() > deadline) throw new Error(`${label} kept port ${port} open`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function startRelay(): ChildProcess {
  const child = spawn(process.execPath, [join(ROOT, "app/relay/src/main.ts")], {
    env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(`[relay] ${chunk}`));
  return child;
}

/* ------------------------------------------------------------------ */
/* Holding the TV's wire                                               */
/* ------------------------------------------------------------------ */

interface TvWire {
  hold: boolean;
  held: { release(): void }[];
  sockets: { close(): void }[];
}

/**
 * Record what the TV dials, and let a test hold its dials down.
 *
 * While `hold` is set, a dial hands the page a socket that stays connecting --
 * the relay sees nothing, which is what "the TV is not back yet" has to mean
 * here -- and `release()` opens a real one in its place, rewiring the handlers
 * the page had already put on the stub. Nothing about the page's own code is
 * stubbed out: it dialled, it is waiting on that dial, and that dial connects.
 */
async function instrumentTv(tv: Page): Promise<void> {
  await tv.addInitScript(() => {
    const Native = window.WebSocket;
    const wire = { hold: false, held: [] as unknown[], sockets: [] as unknown[] };
    (window as unknown as { __tvWire: typeof wire }).__tvWire = wire;

    class Held {
      readyState = 0;
      onopen: ((event: unknown) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      private live: WebSocket | null = null;

      constructor(
        private readonly url: string,
        private readonly protocols?: string | string[],
      ) {
        wire.held.push(this);
      }

      /** Let the dial through: the real socket, and the handlers that were waiting. */
      release(): void {
        const live = new Native(this.url, this.protocols);
        this.live = live;
        live.onopen = (event) => {
          this.readyState = 1;
          this.onopen?.(event);
        };
        live.onclose = (event) => {
          this.readyState = 3;
          this.onclose?.(event);
        };
        live.onerror = (event) => this.onerror?.(event);
        live.onmessage = (event) => this.onmessage?.(event);
      }

      send(data: string): void {
        this.live?.send(data);
      }
      close(): void {
        this.readyState = 3;
        this.live?.close();
      }
    }

    const Dial = function (this: unknown, url: string, protocols?: string | string[]) {
      if (wire.hold) return new Held(url, protocols);
      const socket = new Native(url, protocols);
      wire.sockets.push(socket);
      return socket;
    } as unknown as typeof WebSocket;
    Object.defineProperty(window, "WebSocket", { value: Dial, writable: true, configurable: true });
  });
}

/* ------------------------------------------------------------------ */
/* Driving a phone                                                     */
/* ------------------------------------------------------------------ */

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
  relay = startRelay();
  server = spawn(process.execPath, [join(ROOT, "scripts/serve.mjs")], {
    env: { ...process.env, PORT: String(HTTP_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (chunk) => process.stderr.write(`[serve] ${chunk}`));
  await waitForPort(RELAY_PORT, "the relay");
  await waitForPort(HTTP_PORT, "the static server");
});

test.afterAll(async () => {
  relay?.kill("SIGKILL");
  server?.kill();
});

test("a relay restart ends the game on the phone, which joins the room the TV makes next", async ({
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
  expect(phoneUrl).toContain(`room=${room}`);

  // One player in, so the room has something to lose -- and so the phone's
  // browser has minted and kept a seat token for this room before the relay
  // goes.
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");

  /* -------- the TV's wire is held down, and the relay dies -------- */
  // Held first, so the TV cannot be the one that lands on the relay that comes
  // back: a room is gone only until its own TV makes it again, and this run is
  // about what the phone does in that window.
  await tv.evaluate(() => {
    const wire = (window as unknown as { __tvWire: TvWire }).__tvWire;
    wire.hold = true;
    for (const socket of wire.sockets) socket.close();
  });

  // SIGKILL: a relay asked to exit on its own waits for the connections it is
  // holding, and the point of this run is a process that is simply gone.
  relay.kill("SIGKILL");
  await once(relay, "exit");
  await waitForPortClosed(RELAY_PORT, "the killed relay");

  relay = startRelay();
  await waitForPort(RELAY_PORT, "the restarted relay");

  /* -------- the phone is told the game is over, not left waiting -------- */
  // It reconnects on its own, names the room it was in, and the new relay has
  // never heard of it.
  await expect(a.page.getByTestId("join-error")).toHaveText(
    "This game has ended on the TV — scan the TV's code to join again",
  );
  // The bug this replaces: the phone sitting on the waiting screen for a room
  // that is not there. Both halves are checked -- that screen is gone, and the
  // join form is back with the dead room's code out of the box.
  await expect(a.page.getByTestId("waiting-for-tv")).toHaveCount(0);
  await expect(a.page.getByTestId("join-form")).toBeVisible();
  await expect(a.page.getByTestId("room-input")).toHaveValue("");

  /* -------- the TV comes back and makes its room again -------- */
  await tv.evaluate(() => {
    const wire = (window as unknown as { __tvWire: TvWire }).__tvWire;
    wire.hold = false;
    for (const held of wire.held.splice(0)) held.release();
  });
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");
  // The room it made again is at the code the phones already have: a TV coming
  // back names the room it was in, and that is what makes the code on screen
  // still worth typing.
  await expect(tv.getByTestId("room-code")).toHaveText(room);

  /* -------- the phone joins it, on the token it never lost -------- */
  await a.page.getByTestId("room-input").fill(room);
  await a.page.getByTestId("join-button").click();
  // Seated again rather than merely connected, and that is the token evidence:
  // a phone presenting a seat the TV was holding for somebody else has to ask
  // for it and wait for the remote, while the browser that minted Ada's token
  // gets the seat back with nobody approving anything. So A coming back is
  // this browser's own token being presented again, not a fresh one.
  await expect(a.page.getByTestId("phone-role")).toHaveText("A");
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");

  await a.context.close();
  await context.close();
});
