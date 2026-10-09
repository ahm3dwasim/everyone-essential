/**
 * The static server for the two built pages.
 *
 * The TV is served at `/` and the phone at `/phone/`, from one origin, because
 * the QR code the TV draws points at the phone page on the LAN and a phone that
 * has to reach a different host than the TV did would be a second thing to get
 * wrong on the night. The relay is a separate process (`npm run relay`).
 *
 * No dependencies: `node:http` plus a small extension-to-type table. It serves
 * only files inside the two dist directories, and it says so loudly if they are
 * missing rather than serving a 404 for the whole app.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TV_DIR = join(ROOT, "app", "tv", "dist");
const PHONE_DIR = join(ROOT, "app", "phone", "dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Every non-internal IPv4 address this Mac has, best guess first. */
export function lanAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      // The Wi-Fi / Ethernet interfaces people actually use come first.
      const rank = /^en\d/.test(name) ? 0 : /^(bridge|utun)/.test(name) ? 2 : 1;
      found.push({ name, address: address.address, rank });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((entry) => entry.address);
}

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  if (clean === "/" || clean === "") return { file: join(TV_DIR, "index.html"), base: TV_DIR };
  if (clean === "/phone" || clean === "/phone/") {
    return { file: join(PHONE_DIR, "index.html"), base: PHONE_DIR };
  }
  if (clean.startsWith("/phone/")) {
    const rest = normalize(clean.slice("/phone/".length));
    if (rest.startsWith("..") || rest.includes(`..${sep}`)) return null;
    return { file: join(PHONE_DIR, rest), base: PHONE_DIR };
  }
  const rest = normalize(clean.slice(1));
  if (rest.startsWith("..") || rest.includes(`..${sep}`)) return null;
  return { file: join(TV_DIR, rest), base: TV_DIR };
}

export function createStaticServer() {
  return createServer((request, response) => {
    const target = resolveFile(request.url ?? "/");
    if (!target) {
      response.writeHead(403).end("forbidden");
      return;
    }
    const file = existsSync(target.file) && statSync(target.file).isDirectory()
      ? join(target.file, "index.html")
      : target.file;
    if (!existsSync(file)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end(`not found: ${request.url}\n`);
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  });
}

function main() {
  const missing = [TV_DIR, PHONE_DIR].filter((dir) => !existsSync(join(dir, "index.html")));
  if (missing.length > 0) {
    console.error("build first: npm run build");
    for (const dir of missing) console.error(`  missing ${join(dir, "index.html")}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8080);
  const server = createStaticServer();
  server.listen(port, () => {
    const [lan] = lanAddresses();
    console.log(`TV      http://localhost:${port}/`);
    console.log(`phone   http://localhost:${port}/phone/`);
    if (lan) {
      console.log("");
      console.log(`on the LAN:  http://${lan}:${port}/`);
      console.log(`             point the TV browser at that, then scan the QR.`);
    }
    console.log("");
    console.log(`relay must be running too:  npm run relay`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
