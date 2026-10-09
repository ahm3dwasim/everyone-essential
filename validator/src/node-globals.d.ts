/**
 * The handful of Node globals `cli.ts` uses.
 *
 * Declared here rather than pulled in with `@types/node`, so the package needs no
 * `@types/node` dependency at all. A `.d.ts` file with no imports or exports declares
 * globals, so this is visible to every file in the program rather than only to `cli.ts`;
 * the list below is kept to exactly the globals `cli.ts` uses.
 */
declare const process: {
  argv: string[];
  exitCode: number | undefined;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};
