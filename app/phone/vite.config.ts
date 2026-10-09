import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath } from "node:url";

/** The phone bundle. Same origin as the TV page, under `/phone/`. */
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
