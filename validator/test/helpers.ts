/**
 * Shared test-only helpers.
 *
 * `historyFor` builds a `history` array the same way `applyPlan` would, for
 * fixtures that just need "these actions happened, in this order" without
 * hand-writing the performer/capability on every event. It resolves `"any"`
 * exactly as `solve`/`applyPlan` do, so a history it builds always replays
 * cleanly against the puzzle it was built from.
 */
import { type ActionId, type HistoryEvent, type Puzzle } from "../src/model";
import { resolvePerformer } from "../src/solve";

export function historyFor(puzzle: Puzzle, actionIds: readonly ActionId[]): HistoryEvent[] {
  return actionIds.map((actionId) => {
    const action = puzzle.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`historyFor: unknown action "${actionId}"`);
    const performer = action.performer === "any" ? resolvePerformer(puzzle, action) : action.performer;
    if (!performer) throw new Error(`historyFor: no eligible performer for "${actionId}"`);
    return { kind: "action", actionId, performer, capability: action.needs };
  });
}
