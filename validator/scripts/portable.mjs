/**
 * Portability check: the published package must run on plain Node.
 *
 * The claim under test is that the compiler is pure JavaScript: no Node
 * built-ins, no `process`, no `require`. Bundling `src/api.ts` -- which excludes
 * `cli.ts` and `bench.ts` -- into one ESM file and running it in a plain
 * `node --input-type=module` process proves the bundle is self-contained; the
 * import scan proves it never reached for a host API to get there.
 *
 * Exits non-zero with a diagnosis on any failure, so it works as a gate.
 */
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const OUT = "dist-portable/validator.mjs";

const result = await build({
  entryPoints: ["src/api.ts"],
  outfile: OUT,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2020",
  mainFields: ["module", "main"],
  logLevel: "warning",
});
if (result.errors.length > 0) {
  console.error("bundle failed");
  process.exit(1);
}

const bundled = readFileSync(OUT, "utf8");

// A bundle that imports a Node built-in would run here only because Node
// happens to provide it, and would silently break on any other runtime. That
// is exactly the failure this check exists to catch.
const forbidden = [
  { pattern: /\brequire\s*\(/, what: "a CommonJS require() call" },
  { pattern: /from\s*["']node:/, what: "a node: import" },
  { pattern: /\bfrom\s*["'](fs|path|os|util|child_process|events|stream)["']/, what: "a bare built-in import" },
  { pattern: /\bprocess\.(argv|env|exit|stdout|stderr|cwd|platform)\b/, what: "a process global" },
];
for (const { pattern, what } of forbidden) {
  const found = bundled.match(pattern);
  if (found) {
    console.error(`FAIL: the bundle contains ${what}: ${found[0]}`);
    process.exit(1);
  }
}

// A smoke script that uses nothing but dynamic import and console, so the only
// thing it can be exercising is the bundle itself.
const dir = mkdtempSync(join(tmpdir(), "validator-portable-"));
const smoke = join(dir, "smoke.mjs");
writeFileSync(
  smoke,
  `import { demoPuzzle, certify, recompile, emptyState, solve, isCertificate } from ${JSON.stringify(
    join(process.cwd(), OUT),
  )};

const puzzle = demoPuzzle();
const start = emptyState();
const certificate = certify(puzzle, start);
if (!isCertificate(certificate)) throw new Error("refused: " + certificate.reason);
if (!certificate.ok) throw new Error("demo puzzle did not certify");
if (certificate.solvable.plan.length !== 10) throw new Error("unexpected plan length");

const plan = solve(puzzle, start).plan;
const midpoint = { flags: [], tokens: [], history: [] };
const repaired = recompile(puzzle, midpoint, "C", ["scan"]);
if (repaired.kind !== "ok") throw new Error("recompile refused: " + repaired.kind);

console.log("portable bundle: certified the demo (" + certificate.hash + "), " + plan.length + " step plan, recompiled to " + repaired.kind);
`,
);

const run = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", readFileSync(smoke, "utf8")],
  { encoding: "utf8", cwd: dir },
);

if (run.status !== 0) {
  console.error("FAIL: the bundle did not run in a plain node --input-type=module process");
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
console.log(run.stdout.trim());
console.log(`portable: ${OUT} runs on its own, ${(bundled.length / 1024).toFixed(1)} kB, no Node built-ins`);
rmSync(dir, { recursive: true, force: true });
