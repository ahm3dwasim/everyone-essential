import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

/**
 * Unit tests only. No network, no browsers: the relay is driven through an
 * injected socket, the phone's scan machine is driven with a fake clock, and
 * the TV's game reducer is a pure function. The browser end-to-end run is
 * Playwright's job (`npm run smoke`), not this one's.
 */
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "node",
    // .tsx as well as .ts: a test that renders a TV component is still a unit
    // test, and a pattern that silently skips one is worse than no test -- the
    // suite goes GREENER when the file stops being collected.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    reporters: ["default"],
  },
});
