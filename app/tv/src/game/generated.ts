/**
 * The generated catalogue: proposals the generator earned, saved as files.
 *
 * A mystery reaches the TV the same way any other content does -- as a file in
 * the repository that a human vetted. Nothing here is generated at runtime
 * and nothing here calls a model: the Stick has no credentials, no network
 * budget and no business asking a language model for a puzzle mid-party.
 *
 * The provenance of each file is in its name -- the seed is in the id.
 * Regenerating one is exactly:
 *
 *     npm run gen -- --seed 7 --roles 3 --proposer local \
 *       --out app/tv/src/game/generated/the-lighthouse-braid-7.json
 *
 * and the result is byte-identical to what is committed, because the local
 * proposer is seeded and its output is canonically ordered.
 *
 * **Why these are not in `MYSTERIES` yet.** They are safe to *hold* -- every
 * one of them is held to the same acceptance table as the hand-written three
 * by `test/gen-catalogue.test.ts`, and each has a dependence graph distinct
 * from all of them -- but putting one in the live roster is a product decision
 * with two visible consequences: the lobby picker gains a fourth option, and
 * `test/smoke/mysteries.spec.ts` asserts the picker has exactly three. Going
 * live is therefore one line in `mysteries.ts` plus that one number, both of
 * which a person should choose deliberately rather than a generator doing it
 * quietly. Until then this file is the staging shelf.
 */
import { clonePuzzle } from "../../../../validator/src/api.ts";
import type { ProposedMystery } from "../../../gen/src/proposer.ts";
import type { Capability } from "../../../shared/protocol.ts";
import type { Mystery } from "./mysteries.ts";
import lighthouse from "./generated/the-lighthouse-braid-7.json";

/**
 * The saved proposals, as plain data.
 *
 * The JSON is cast rather than parsed: it was written by this repository's own
 * CLI, and `test/gen-catalogue.test.ts` re-derives it and compares, so a file
 * that drifted from what the generator produces is caught by a test rather
 * than by a runtime guard nobody would ever read.
 */
export const GENERATED_PROPOSALS: readonly ProposedMystery[] = [
  lighthouse as unknown as ProposedMystery,
];

/**
 * The same proposals in the shape the catalogue speaks.
 *
 * `build` clones, exactly as every hand-written mystery does, so a caller that
 * mutates the puzzle it was handed cannot corrupt the next caller's copy.
 */
export const GENERATED_MYSTERIES: readonly Mystery[] = GENERATED_PROPOSALS.map((proposal) => ({
  id: proposal.id,
  title: proposal.title,
  subtitle: proposal.subtitle,
  roles: [...proposal.roles] as Mystery["roles"],
  opening: proposal.opening,
  build: () => clonePuzzle(proposal.puzzle),
  headline: {
    role: proposal.headline.role as Mystery["headline"]["role"],
    capabilities: [...proposal.headline.capabilities] as Capability[],
  },
}));

export function generatedById(id: string): Mystery | undefined {
  return GENERATED_MYSTERIES.find((mystery) => mystery.id === id);
}
