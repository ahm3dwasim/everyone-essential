/**
 * Just enough of `node:test` and `node:assert/strict` for the test suite.
 * Same reason as `src/node-globals.d.ts`: keep `typescript` the only dev
 * dependency.
 */
declare module "node:test" {
  export interface TestContext {
    name: string;
    diagnostic(message: string): void;
  }
  export type TestFn = (t: TestContext) => void | Promise<void>;
  export function test(name: string, fn: TestFn): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
