/**
 * A TV that drops comes back to the room it made, and nobody else can take it.
 *
 * The room code is public -- it is on the TV screen, in the QR code, and in the
 * join link -- so a room full of phones cannot be protected by the code being
 * hard to guess. What protects it is that the relay issued the room's own TV a
 * credential and will only let that credential back in. This run is the proof
 * end to end, through the real relay process and the real TV page: the TV's
 * socket is closed, a socket that knows the code tries to take its place and is
 * refused, the real TV comes back, and a phone that joins afterwards lands in
 * the same room and is served by it.
 *
 * The TV's own socket is held by an init script that records what the page
 * dials and can hold its reconnects down. That is an instrument, not a
 * behaviour: the page still dials the real `WebSocket`, and holding it down is
 * what makes the impostor attempt deterministic -- the relay has to have seen
 * the real TV leave before a claim to replace it means anything.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../app/shared/protocol.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HTTP_PORT = Number(process.env.SMOKE_HTTP_PORT ?? 8123);
const RELAY_PORT = Number(process.env.SMOKE_RELAY_PORT ?? 8790);

function relayUrl(): string {
  return `ws://127.0.0.1:${RELAY_PORT}`;
}

const TV_URL = `http://127.0.0.1:${HTTP_PORT}/?relay=${encodeURIComponent(relayUrl())}`;
const ORIGIN_URL = `http://127.0.0.1:${HTTP_PORT}/phone/`;

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

    /** A socket that dials and never opens: the relay sees a room with no TV. */
    class Held {
      readyState = 0;
      onopen: unknown = null;
      onclose: unknown = null;
      onerror: unknown = null;
      onmessage: unknown = null;
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

async function tvWire(tv: Page): Promise<TvWire> {
  return (await tv.evaluate(() => (window as unknown as { __tvWire: TvWire }).__tvWire)) as TvWire;
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

test("the TV comes back to its own room, and a socket that only knows the code cannot take it", async ({
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

  // One player in, so the room has something to lose when its TV blinks.
  const a = await openPhone(browser, phoneUrl, "A", "Ada");
  await expect(tv.getByTestId("role-slot-A")).toHaveAttribute("data-joined", "true");

  /* -------- the TV's wire goes away, and stays away for a moment -------- */
  await tv.evaluate(() => {
    const wire = (window as unknown as { __tvWire: TvWire }).__tvWire;
    wire.hold = true;
    for (const socket of wire.sockets) socket.close();
  });

  /* -------- a socket that knows the code tries to be the TV -------- */
  // It has the code -- the same four letters the QR link carries -- and that is
  // all it has. The impostor runs from its own page, dialling the relay's own
  // `WebSocket`, so nothing about the TV under test is in its path.
  const impostorContext = await browser.newContext();
  const impostor = await impostorContext.newPage();
  await impostor.goto(ORIGIN_URL);
  const heard = await impostor.evaluate(
    async ({ url, room, version }) =>
      await new Promise<string>((resolve) => {
        const socket = new WebSocket(url);
        let first = "";
        socket.onopen = () =>
          socket.send(JSON.stringify({ t: "hello", v: version, kind: "tv", room }));
        socket.onmessage = (event) => {
          first = String(event.data);
          socket.close();
          resolve(first);
        };
        socket.onerror = () => resolve("error");
        setTimeout(() => resolve(first), 5_000);
      }),
    { url: relayUrl(), room, version: PROTOCOL_VERSION },
  );
  expect(heard).toContain("relay_error");
  expect(heard).not.toContain("welcome");
  // Refused for what it is missing, not for speaking a version the relay does
  // not: this run is the proof that the code alone is not the TV's proof, so
  // it has to be answered on the credential.
  expect(heard).toContain("not_the_tv");
  // Nothing it sent reached the room either. The room has no TV while the real
  // one's wire is down, and a phone in a room is not thrown out by that: Ada
  // is still joined, still holding A, and waiting for the TV rather than
  // asked to join again. That screen -- and the join form's absence from it --
  // is what says the impostor took nothing from her.
  await expect(a.page.getByTestId("waiting-for-tv")).toBeVisible();
  await expect(a.page.getByTestId("join-button")).toHaveCount(0);

  /* -------- the real TV comes back, with what the relay gave it -------- */
  await tv.evaluate(() => {
    (window as unknown as { __tvWire: TvWire }).__tvWire.hold = false;
  });
  await expect(tv.getByTestId("relay-status")).toHaveText("relay: open");
  // The same room, not a fresh one: the code on screen is the one the phones
  // in this room already have.
  await expect(tv.getByTestId("room-code")).toHaveText(room);

  // Ada waited the gap out rather than being sent back to the join form, so
  // the TV arriving ends it: her phone is on its play screen with A again,
  // and nobody pressed anything to put it there.
  await expect(a.page.getByTestId("waiting-for-tv")).toHaveCount(0);
  await expect(a.page.getByTestId("phone-role")).toHaveText("A");

  // And the proof that it is the same room rather than a coincidentally
  // identical code: a phone joining the code from before the drop appears on
  // this TV, and is served by it -- which is the TV's own message reaching a
  // phone, after the TV left and came back.
  const b = await openPhone(browser, phoneUrl, "B", "Bo");
  await expect(tv.getByTestId("role-slot-B")).toHaveAttribute("data-joined", "true");
  await expect(tv.getByTestId("role-slot-B")).toContainText("Bo");
  await expect(b.page.getByTestId("phone-role")).toHaveText("B");

  await a.context.close();
  await b.context.close();
  await impostorContext.close();
  await context.close();
});
