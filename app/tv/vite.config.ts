import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

/**
 * The TV bundle. Base is `./` so the built page can be served from any path on
 * the LAN. No source map: the release ships nothing that maps a shipped byte
 * back to a private source line.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
});
