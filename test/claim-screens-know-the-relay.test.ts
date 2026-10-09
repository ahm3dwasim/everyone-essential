/**
 * Every claim screen in the application names the TV's own connection.
 *
 * `claimHoldsLive` refuses a positive claim while the TV's socket is down, and
 * an earlier version threaded `relayOpen` into two of the three `HowWeChecked` render
 * sites. The third kept a default of `true` and made the claim through a Wi-Fi
 * blip for a whole round, and the reason it could is the shape of the mistake:
 * a missing argument is invisible. `tsc` now makes `relayOpen` required, so
 * the application's own render sites cannot omit it -- but `tsconfig.json`
 * type-checks the `.ts` files under `test/` and not the `.tsx` ones, so a
 * future render site added to either directory would only be caught if
 * somebody happened to run the right thing.
 *
 * So the sweep itself is a test. It reads the application's own
 * source and asserts that every JSX element which renders a claim-bearing
 * component passes `relayOpen` -- and that the list of components it knows
 * about is the list that actually exists, so a new claim screen cannot be
 * added to `app/` without this file noticing.
 *
 * The lobby's badge is the same family of claim built as data rather than as
 * a component (`app.tsx` computes it and hands it down), so the last test here
 * guards that computation instead of a render site.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Components that make, or pass through, a claim about the room finishing together. */
const CLAIM_COMPONENTS = [
  "HowWeChecked",
  "Ending",
  "RebuildMoment",
  "RebuildBeat2",
  "RebuildBeat3",
  "RebuildWaitingLine",
] as const;

const SOURCES = ["app/tv/src/app.tsx", "app/tv/src/screens.tsx"];

/**
 * Every JSX element in `source` whose tag is one of `names`, as the raw text
 * from `<Tag` to the `>` that closes the opening tag. Self-closing tags are
 * the only ones these components are used as, and their props contain no `>`
 * outside of nested braces this codebase does not write -- the scan stops at
 * the first `>` that is not inside braces or quotes, which is exactly where
 * the opening tag ends.
 */
function elements(source: string, names: readonly string[]): { tag: string; text: string }[] {
  const found: { tag: string; text: string }[] = [];
  for (const tag of names) {
    let from = 0;
    for (;;) {
      const start = source.indexOf(`<${tag}`, from);
      if (start === -1) break;
      // `<HowWeCheckedFoo` is not `<HowWeChecked`.
      const after = source[start + tag.length + 1];
      if (after !== undefined && /[A-Za-z0-9_]/.test(after)) {
        from = start + 1;
        continue;
      }
      let depth = 0;
      let quote: string | null = null;
      let end = -1;
      for (let i = start; i < source.length; i++) {
        const ch = source[i]!;
        if (quote !== null) {
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        else if (ch === ">" && depth === 0) {
          end = i;
          break;
        }
      }
      if (end === -1) throw new Error(`unterminated <${tag} in the source`);
      found.push({ tag, text: source.slice(start, end + 1) });
      from = end + 1;
    }
  }
  return found;
}

describe("every claim screen names the TV's own connection", () => {
  it("passes relayOpen at every render site in the application", () => {
    const missing: string[] = [];
    for (const path of SOURCES) {
      const source = readFileSync(path, "utf8");
      for (const element of elements(source, CLAIM_COMPONENTS)) {
        if (!/\brelayOpen=/.test(element.text)) {
          const line = source.slice(0, source.indexOf(element.text)).split("\n").length;
          missing.push(`${path}:${line} <${element.tag}>`);
        }
      }
    }
    expect(missing, `claim screens rendered without the TV's connection: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("finds the render sites it is supposed to be guarding", () => {
    // A guard that silently finds nothing guards nothing: the day a component
    // is renamed out of `CLAIM_COMPONENTS`, this is what says so.
    const app = elements(readFileSync(SOURCES[0]!, "utf8"), CLAIM_COMPONENTS);
    const screens = elements(readFileSync(SOURCES[1]!, "utf8"), CLAIM_COMPONENTS);
    expect(app.map((e) => e.tag).sort()).toEqual(["Ending", "HowWeChecked", "RebuildMoment"]);
    // Two: the rebuild moment's beat 2, and the ending's own certificate --
    // the site that was already gated, kept here so the pair cannot drift.
    expect(screens.filter((e) => e.tag === "HowWeChecked")).toHaveLength(2);
    expect(screens.filter((e) => e.tag === "RebuildWaitingLine")).toHaveLength(1);
    // Both beat components, which is the pair an earlier gate missed.
    expect(screens.filter((e) => e.tag === "RebuildBeat2")).toHaveLength(1);
    expect(screens.filter((e) => e.tag === "RebuildBeat3")).toHaveLength(1);
  });

  it("has no render site left where a claim is made on a defaulted connection", () => {
    // The declaration itself: `relayOpen` may not be given a default in the
    // components that decide the claim, because the default is the whole
    // mechanism by which a missing argument became a false claim.
    const source = readFileSync("app/tv/src/game/certificate-presenter.ts", "utf8");
    expect(source).toContain("relayOpen: boolean,");
    expect(source).not.toMatch(/relayOpen\s*=\s*true/);
    for (const path of SOURCES) {
      const file = readFileSync(path, "utf8");
      expect(file, `${path} defaults relayOpen`).not.toMatch(/relayOpen\s*=\s*true/);
    }
  });

  it("withholds the lobby's certificate while the TV is not in the room", () => {
    // The lobby badge is the same family of claim as the ending's headline --
    // a green "A essential" line says A is here -- and its per-role half is
    // the reducer's own per-seat connectivity, which is frozen at whatever
    // the TV last heard. The statement that computes it therefore has to name
    // the connection too, so a tick cannot outlive the room it is about.
    const app = readFileSync(SOURCES[0]!, "utf8");
    const start = app.indexOf("const startBadge");
    expect(start, "app.tsx no longer computes the lobby's badge").toBeGreaterThan(-1);
    const statement = app.slice(start, app.indexOf(";", start));
    expect(statement, "the lobby's badge is computed without the TV's own connection").toMatch(
      /relayLive|relayIsOpen\(connection\)/,
    );
  });
});
