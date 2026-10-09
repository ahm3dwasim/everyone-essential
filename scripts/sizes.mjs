/**
 * What the TV actually has to download.
 *
 * The number that matters is the gzipped JavaScript of the TV bundle, because
 * that bundle contains the validator -- the puzzle compiler, the solver and the
 * certifier all run on the TV set. Gzip is what a static server sends, so gzip
 * is what is reported. Source maps are excluded: they are fetched only when a
 * developer opens devtools.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function measure(label, dir) {
  if (!existsSync(dir)) {
    console.log(`${label}: not built (npm run build)`);
    return null;
  }
  let rawTotal = 0;
  let gzipTotal = 0;
  let jsGzip = 0;
  const rows = [];
  for (const file of walk(dir).sort()) {
    const extension = extname(file);
    if (extension === ".map") continue;
    const bytes = readFileSync(file);
    const gzipped = gzipSync(bytes).length;
    rawTotal += bytes.length;
    gzipTotal += gzipped;
    if (extension === ".js") jsGzip += gzipped;
    rows.push({ file: file.slice(dir.length + 1), raw: bytes.length, gzip: gzipped });
  }
  console.log(`\n${label}`);
  for (const row of rows) {
    console.log(
      `  ${row.file.padEnd(28)} ${String(row.raw).padStart(8)} B raw  ${String(row.gzip).padStart(8)} B gzip`,
    );
  }
  console.log(`  ${"TOTAL".padEnd(28)} ${String(rawTotal).padStart(8)} B raw  ${String(gzipTotal).padStart(8)} B gzip`);
  console.log(`  javascript only (gzip): ${jsGzip} B = ${(jsGzip / 1024).toFixed(1)} kB`);
  return { rawTotal, gzipTotal, jsGzip };
}

const tv = measure("TV  (app/tv/dist)", join(ROOT, "app", "tv", "dist"));
const phone = measure("phone  (app/phone/dist)", join(ROOT, "app", "phone", "dist"));

if (tv) {
  const budget = 250 * 1024;
  const ok = tv.jsGzip < budget;
  console.log(
    `\nTV javascript budget: ${(tv.jsGzip / 1024).toFixed(1)} kB of ${(budget / 1024).toFixed(0)} kB gzipped — ${ok ? "OK" : "OVER"}`,
  );
  if (!ok) process.exitCode = 1;
}
if (phone) {
  console.log(`phone javascript (gzip): ${(phone.jsGzip / 1024).toFixed(1)} kB`);
}
