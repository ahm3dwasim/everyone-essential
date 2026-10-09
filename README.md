# Everyone Is Essential

A couch co-op mystery for a TV and up to three phones, where **every player's role is provably
necessary** -- even after someone's input mode changes mid-game (from a d-pad to switch-scanning,
mid-story, with progress kept).

The board lives on the TV; each player's clues and controls live on their phone. The game's proof
engine is [`puzzle-necessity`](https://github.com/ahm3dwasim/puzzle-necessity), a standalone, zero-dependency package that this
project is built on: it certifies that a puzzle is solvable, that every role is load-bearing, and
that both survive a player's capabilities changing mid-game.

This game does not install that package. It vendors the compiler's source under `validator/` and
builds it here, so nothing in this repository needs it. The install line is for using the compiler
on its own, in your own project:

```
npm install puzzle-necessity
```

## Layout

| Path | What |
| --- | --- |
| `app/tv` | The TV screen: authoritative game host, 10-foot UI. |
| `app/phone` | The phone controller: private clues and the player's own input mode. |
| `app/relay` | Room relay: forwards messages between the TV and the phones on the LAN. |
| `app/gen` | The mystery generator: a model proposes, the compiler decides. Its optional Bedrock proposer loads `@aws-sdk/client-bedrock-runtime`, which is not a dependency of this repository and is installed separately. |
| `app/android` | The Fire TV APK wrapper (native Back-key bridge, embedded server). |
| `app/shared` | Protocol, room codes and audit types shared by the above. |
| `validator/` | The puzzle compiler, a vendored copy of `puzzle-necessity` 0.1.0. |
| `test/` | Unit tests (`vitest`) and the Playwright smoke run. |
| `tools/devicebench` | A standalone page for timing the validator on a real device. `npm run check:devicebench` proves the bundle it loads is the build of the `validator/src` beside it. |

## Running it

```
npm install
npm test                          # unit tests
npm run typecheck
npx playwright install chromium   # one-time: the browser the smoke run drives
npm run smoke                     # build + a headless end-to-end run (Playwright)
npm run build                     # build the TV and phone bundles
npm run relay                     # in one terminal: the room relay the TV and phones talk through
npm run tv                        # in another terminal: serve the built bundles locally
```

Node >= 22.18, and not lower: `npm run relay` runs a `.ts` file with plain
`node`, which needs Node's built-in TypeScript type stripping. That is enabled
by default from Node 22.18.0 (LTS, 2025-07-31) --
<https://nodejs.org/en/blog/release/v22.18.0>, "Type stripping is enabled by
default". Node 20 reached end of life in April 2026.

## Fire TV

The game can be built as an Android APK for Fire TV Stick. See [`docs/APK_TEST_PLAN.md`](docs/APK_TEST_PLAN.md)
to build and test it on your own device.

## Licence

MIT. See [LICENSE](LICENSE).
