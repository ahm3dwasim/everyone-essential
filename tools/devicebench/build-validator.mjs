#!/usr/bin/env node
// Rebuilds validator.mjs -- the standalone bundle of the puzzle compiler that index.html
// imports -- from the compiler source that ships beside it, and, with --check, proves the
// committed file is byte for byte what this build produces.
//
// The bundle is a committed build output, so nothing notices when it goes stale: the page
// keeps working, it just times a compiler from months earlier than the source next to it.
// This script is the answer to that. It is the only intended writer of the file, and CI or a
// release check can run it in --check mode, so a stale bundle fails the check instead of
// shipping.
//
//   node tools/devicebench/build-validator.mjs                 rewrite the bundle
//   node tools/devicebench/build-validator.mjs --check         fail if the file differs
//   node tools/devicebench/build-validator.mjs --check --root <tree>
//   node tools/devicebench/build-validator.mjs --print         write the build to stdout
//
// From the repository root: `npm run build:devicebench` and `npm run check:devicebench`.
//
// --root defaults to the tree this script sits in. Pointing it at another tree checks THAT
// tree's `validator/src` against THAT tree's committed bundle, which is how a copy of this
// tree that carries its own `validator/` is checked.
//
// Determinism. esbuild's output is a pure function of (source bytes, options, esbuild
// version), so the version is pinned in EXPECTED_ESBUILD_VERSION below and asserted at run
// time. A caret range in package.json would let a newer esbuild rewrite this file's bytes
// with no source change at all, which would turn "the committed bundle is the build of the
// committed source" into a claim about whatever esbuild happened to be installed.
//
// The bundle's own `// src/hash.ts` banners come from esbuild printing entry-relative paths,
// so the build always runs with `validator/` as its working directory.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");
const EXPECTED_ESBUILD_VERSION = "0.28.2";
const BUNDLE_REL = path.join("tools", "devicebench", "validator.mjs");

const USAGE = `usage: build-validator.mjs [--check] [--print] [--root <tree>]`;

function fail(message) {
  process.stderr.write(`build-validator: ${message}\n`);
  process.exit(2);
}

let mode = "write";
let root = DEFAULT_ROOT;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--check") mode = "check";
  else if (arg === "--print") mode = "print";
  else if (arg === "--root") {
    const value = argv[i + 1];
    if (!value) fail(`--root needs a directory\n${USAGE}`);
    root = path.resolve(value);
    i += 1;
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else {
    fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
  }
}

const validatorDir = path.join(root, "validator");
const entryRel = path.join("src", "api.ts");
const entryAbs = path.join(validatorDir, entryRel);
const outfile = path.join(root, BUNDLE_REL);

// esbuild is resolved from this script's own install, so the same command works from the
// source tree and from the game repo it is copied into.
const require = createRequire(import.meta.url);
let esbuildEntry;
try {
  esbuildEntry = require.resolve("esbuild");
} catch {
  fail(
    `esbuild is not installed, so ${BUNDLE_REL} cannot be rebuilt or checked.\n` +
      `Install the pinned version from this tree: npm install`,
  );
}
const esbuildVersion = JSON.parse(
  readFileSync(path.join(path.dirname(esbuildEntry), "..", "package.json"), "utf8"),
).version;
if (esbuildVersion !== EXPECTED_ESBUILD_VERSION) {
  fail(
    `esbuild ${esbuildVersion} is installed; this file's bundle is built with ${EXPECTED_ESBUILD_VERSION} ` +
      `and esbuild's output differs between versions.\n` +
      `Install the pinned version (\`npm ci\`), or change EXPECTED_ESBUILD_VERSION and regenerate ` +
      `${BUNDLE_REL} in the same commit.`,
  );
}

// esbuild is CommonJS, so it is loaded through the same resolver that found it.
let esbuild;
try {
  esbuild = require("esbuild");
} catch (error) {
  fail(`could not load esbuild from ${esbuildEntry}: ${error?.message ?? error}`);
}

// No trailing newline: esbuild writes its own after the banner, and two of them would leave
// a blank line at the top of every build.
const banner =
  `// Built from validator/src/api.ts by tools/devicebench/build-validator.mjs, esbuild ` +
  `${EXPECTED_ESBUILD_VERSION}.\n` +
  `// Generated file: do not edit it by hand. Run \`npm run build:devicebench\` from the ` +
  `repository root.`;

let built;
try {
  const result = await esbuild.build({
    absWorkingDir: validatorDir,
    entryPoints: [entryRel],
    bundle: true,
    format: "esm",
    banner: { js: banner },
    outfile,
    write: false,
    logLevel: "silent",
  });
  built = result.outputFiles[0].text;
} catch (error) {
  fail(`esbuild failed to bundle ${entryAbs}:\n${error?.message ?? error}`);
}

if (mode === "print") {
  process.stdout.write(built);
} else if (mode === "write") {
  writeFileSync(outfile, built, "utf8");
  process.stdout.write(`build-validator: wrote ${path.relative(root, outfile)} (${built.length} bytes)\n`);
} else {
  let committed;
  try {
    committed = readFileSync(outfile, "utf8");
  } catch {
    fail(
      `${path.relative(root, outfile)} is missing.\n` +
        `Run \`npm run build:devicebench\` from the repository root to write it.`,
    );
  }
  if (committed === built) {
    process.stdout.write(
      `build-validator: OK -- ${path.relative(root, outfile)} is byte for byte the build of ` +
        `${path.relative(root, entryAbs)} (${built.length} bytes)\n`,
    );
  } else {
    const committedLines = committed.split("\n");
    const builtLines = built.split("\n");
    const firstDiff = committedLines.findIndex((line, i) => line !== builtLines[i]);
    const at = firstDiff === -1 ? Math.min(committedLines.length, builtLines.length) : firstDiff;
    process.stderr.write(
      `build-validator: STALE -- ${path.relative(root, outfile)} is not the build of the ` +
        `${path.relative(root, entryAbs)} beside it.\n` +
        `  committed: ${committedLines.length} lines, ${committed.length} bytes\n` +
        `  rebuilt:   ${builtLines.length} lines, ${built.length} bytes\n` +
        `  first difference at line ${at + 1}:\n` +
        `    committed: ${JSON.stringify(committedLines[at] ?? "<end of file>")}\n` +
        `    rebuilt:   ${JSON.stringify(builtLines[at] ?? "<end of file>")}\n` +
        `Run \`npm run build:devicebench\` from the repository root and commit the result.\n`,
    );
    process.exit(1);
  }
}
