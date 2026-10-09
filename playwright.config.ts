import { defineConfig, devices } from "@playwright/test";

/**
 * The headless end-to-end run: one TV at 1920x1080 and three phones, playing
 * the whole demo including the input switch.
 *
 * A single thread, no parallelism: the four pages share one relay and one room, and
 * the point of the run is the sequence, not the speed. The servers are started
 * by the spec itself (`test/smoke/demo.spec.ts`) so the ports and the process
 * lifetimes are visible in one place.
 *
 * The waits are env-overridable because "the point is the sequence, not the speed"
 * cuts both ways: on an idle machine these specs finish in seconds, and on a busy
 * one the same specs have taken fifteen times longer and timed out waiting for a
 * phone to be seated. That is a statement about the machine, not about the app, so
 * a slower machine should be given more patience rather than a false failure. The
 * defaults are unchanged; set `PLAYWRIGHT_WAIT_MS` to raise them.
 */
const WAIT_MS = Number(process.env.PLAYWRIGHT_WAIT_MS ?? 20_000);

export default defineConfig({
  testDir: "test/smoke",
  timeout: Math.max(180_000, WAIT_MS * 9),
  expect: { timeout: WAIT_MS },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    headless: true,
    actionTimeout: WAIT_MS,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
      },
    },
  ],
});
