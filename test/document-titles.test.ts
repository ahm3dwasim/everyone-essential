/**
 * The documents name the product, not a mystery.
 *
 * Both documents used to ship a `<title>` hard-coded to "The Locked Study" --
 * the default mystery -- so a room playing The Treehouse or The Midnight Bakery
 * left the wrong mystery's name in the browser chrome, even though the visible
 * join heading was already neutral.
 *
 * Two obligations, tested separately:
 *   - the static `<title>` in both documents is the neutral product name, and
 *     never a mystery title; and
 *   - the TV's tab names the mystery the room ACTUALLY selected once it knows
 *     one (`tabTitle`, the pure half of the effect that assigns it -- a DOM is
 *     not available in this suite's node environment, so the wording is kept
 *     in a function rather than inline in the effect).
 *
 * The phone is deliberately left static: `app/phone/src/app.tsx` passes
 * `PRODUCT_TITLE` to its join heading and never learns the TV's mystery, so
 * there is no authoritative state for it to name.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MYSTERIES } from "../app/tv/src/game/mysteries.ts";
import { tabTitle } from "../app/tv/src/app.tsx";

const PRODUCT_TITLE = "Everyone Is Essential";

function documentTitle(relativePath: string): string {
  const html = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
  const match = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) throw new Error(`no <title> in ${relativePath}`);
  return match[1]!.trim();
}

const DOCUMENTS = [
  ["phone", "../app/phone/index.html"],
  ["tv", "../app/tv/index.html"],
] as const;

describe("the documents name the product, not a mystery", () => {
  for (const [surface, path] of DOCUMENTS) {
    it(`${surface}: the static <title> is the neutral product name`, () => {
      expect(documentTitle(path)).toBe(PRODUCT_TITLE);
    });

    it(`${surface}: the static <title> never names a mystery`, () => {
      const title = documentTitle(path);
      for (const mystery of MYSTERIES) {
        expect(title).not.toContain(mystery.title);
      }
      // The one that was actually wrong, named explicitly so the regression is
      // unmistakable if the neutral title is ever reverted.
      expect(title).not.toContain("The Locked Study");
    });
  }

  it("the TV's tab names the mystery actually selected", () => {
    for (const mystery of MYSTERIES) {
      expect(tabTitle(mystery.id)).toBe(`${mystery.title} — ${PRODUCT_TITLE}`);
    }
  });

  it("falls back to the neutral name when the mystery is not one we know", () => {
    expect(tabTitle("no-such-mystery")).toBe(PRODUCT_TITLE);
  });

  it("the three mysteries really do have distinct titles, so this test can fail", () => {
    const titles = MYSTERIES.map((m) => m.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toContain("The Treehouse");
    expect(titles).toContain("The Midnight Bakery");
  });
});
