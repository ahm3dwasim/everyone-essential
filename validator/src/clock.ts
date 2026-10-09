/**
 * Wall-clock helper. `performance.now()` where it exists (browsers, Node >= 16,
 * React Native), `Date.now()` otherwise. No Node-only APIs.
 */
const perf = (globalThis as { performance?: { now?: () => number } }).performance;

export function now(): number {
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
}

/** Milliseconds elapsed since `startedAt`, rounded to 3 decimals. */
export function since(startedAt: number): number {
  return Math.round((now() - startedAt) * 1000) / 1000;
}
