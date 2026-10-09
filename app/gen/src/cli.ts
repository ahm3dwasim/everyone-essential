/**
 * `npm run gen` -- generate one mystery, or measure a batch of proposals.
 *
 *   npm run gen -- --seed 7 --roles 3 --proposer local
 *   npm run gen -- --seed 1 --roles 2,3 --ledger 60
 *   npm run gen -- --proposer bedrock --out app/tv/src/game/generated/x.json
 *
 * Nothing here validates anything: the gate does that, and this file only
 * prints what the gate said. Output is deterministic for a given seed and
 * proposer -- no timestamps, no ordering that depends on a hash map, and the
 * mystery itself is written with the validator's own `canonicalStringify`, so
 * two runs of the same command diff to nothing.
 *
 * `--proposer bedrock` needs credentials and the AWS SDK; it never needs
 * either for `local`, which is the point of the whole arrangement.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stableHash } from "../../../validator/src/api.ts";
import { BedrockProposer, configFromEnv, credentialsPresent, defaultTransport } from "./bedrock.ts";
import { generateMystery, runLedger, type Ledger } from "./generate.ts";
import { gate } from "./gate.ts";
import { LocalProposer, mysteryJson } from "./local.ts";
import type { ProposedMystery, PuzzleProposer } from "./proposer.ts";

interface Args {
  seed: number;
  roles: number[];
  proposer: string;
  attempts: number;
  ledger: number | null;
  out: string | null;
  json: boolean;
  help: boolean;
}

const USAGE = `npm run gen -- [options]

  --seed <n>          deterministic seed (default 7)
  --roles <n[,n]>     how many roles to seat, 2 or 3 (default 3)
  --proposer <name>   local | bedrock (default local)
  --attempts <n>      proposals to make before giving up (default 8)
  --ledger <n>        make n proposals and report the rejection ledger
  --out <path>        also write the accepted mystery's JSON to this file
  --json              machine-readable output
  --help              this text

Exit codes: 0 accepted or ledger produced, 1 the generator gave up.`;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    seed: 7,
    roles: [3],
    proposer: "local",
    attempts: 8,
    ledger: null,
    out: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--seed":
        args.seed = Number(next());
        break;
      case "--roles":
        args.roles = next()
          .split(",")
          .map((part) => Number(part.trim()));
        break;
      case "--proposer":
        args.proposer = next();
        break;
      case "--attempts":
        args.attempts = Number(next());
        break;
      case "--ledger":
        args.ledger = Number(next());
        break;
      case "--out":
        args.out = next();
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  for (const roles of args.roles) {
    if (roles !== 2 && roles !== 3) throw new Error(`--roles must be 2 or 3, got ${roles}`);
  }
  if (!Number.isFinite(args.seed)) throw new Error("--seed must be a number");
  if (args.ledger !== null && (!Number.isFinite(args.ledger) || args.ledger < 1)) {
    throw new Error("--ledger must be a positive number");
  }
  return args;
}

function proposerFor(name: string): PuzzleProposer {
  if (name === "local") return new LocalProposer();
  if (name === "bedrock") {
    return new BedrockProposer({
      transport: defaultTransport(),
      config: configFromEnv(),
      hasCredentials: credentialsPresent(),
    });
  }
  throw new Error(`unknown proposer "${name}"; expected "local" or "bedrock"`);
}

/** What the gate proved about an accepted mystery, in the words of the proof. */
function certificateSummary(mystery: ProposedMystery): string[] {
  const verdict = gate(mystery);
  const lines: string[] = [];
  const certificate = verdict.certificate;
  lines.push(`accepted:        ${verdict.accepted}`);
  lines.push(`plan length:     ${verdict.planLength} steps`);
  lines.push(`probes certified:${verdict.probes}`);
  lines.push(`states explored: ${verdict.statesExplored}`);
  lines.push(`certificate hash:${certificate ? ` ${certificate.hash}` : " (none)"}`);
  // The puzzle key is the canonical whole-puzzle identity; the digest is what
  // is worth reading, not the several kilobytes behind it.
  lines.push(`puzzle key hash: ${certificate ? stableHash(certificate.puzzleKey) : "(none)"}`);
  lines.push("checks:");
  for (const check of verdict.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name}${check.ok ? "" : ` -- ${check.reason}`}`);
  }
  if (certificate) {
    lines.push("necessity, as the certificate proves it:");
    for (const role of mystery.puzzle.roles) {
      const proof = certificate.necessity[role.id];
      lines.push(
        `  ${role.id}: necessary=${proof?.necessary} proven=${proof?.proven} -- ${proof?.reason ?? "no proof"}`,
      );
    }
  }
  return lines;
}

function printLedger(ledger: Ledger): void {
  console.log(`proposer:    ${ledger.proposer}`);
  console.log(`seeds:       ${ledger.seeds.from}..${ledger.seeds.to}`);
  console.log(`seat counts: ${ledger.seatCounts.join(", ")}`);
  console.log(`proposals:   ${ledger.proposals}`);
  console.log(`accepted:    ${ledger.accepted}`);
  console.log(`rejected:    ${ledger.rejected}`);
  console.log(`proposer failures: ${ledger.proposerFailures}`);
  console.log("rejections by the validator's own reason:");
  for (const row of ledger.byReason) {
    console.log(`  ${String(row.count).padStart(4)}  ${row.check} :: ${row.kind}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const proposer = proposerFor(args.proposer);

  if (args.ledger !== null) {
    const ledger = await runLedger(proposer, { seed: args.seed, roles: args.roles[0]! }, args.ledger, args.roles);
    if (args.json) console.log(JSON.stringify(ledger, null, 2));
    else printLedger(ledger);
    return 0;
  }

  const roles = args.roles[0]!;
  const result = await generateMystery(proposer, { seed: args.seed, roles }, { maxAttempts: args.attempts });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          accepted: result.accepted,
          mystery: result.mystery,
          ledger: result.ledger,
        },
        null,
        2,
      ),
    );
  } else {
    if (result.mystery) {
      console.log(mysteryJson(result.mystery));
      console.log("");
      for (const line of certificateSummary(result.mystery)) console.log(line);
    } else {
      console.log("the generator gave up: no proposal cleared the gate.");
    }
    console.log("");
    console.log("attempts:");
    for (const record of result.ledger) {
      console.log(
        `  #${record.attempt} seed=${record.seed} ${record.outcome}` +
          (record.check ? ` :: ${record.check} :: ${record.kind} -- ${record.reason}` : "") +
          (record.failure ? ` :: ${record.failure} -- ${record.reason}` : ""),
      );
    }
  }

  if (args.out && result.mystery) {
    const path = resolve(process.cwd(), args.out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(result.mystery, null, 2)}\n`);
    console.log(`\nwrote ${path}`);
  }

  return result.accepted ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A bad flag is an operator error, not a generator failure: say so plainly
    // and do not dress it up as a typed proposal failure.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
