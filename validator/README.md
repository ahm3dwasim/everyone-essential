# @everyone-is-essential/validator

A deterministic puzzle compiler. It proves three things about a co-op puzzle and refuses to
guess about anything else:

1. **Solvable** — a witness plan exists from the given state.
2. **Every role is necessary** — remove any one role and the goal becomes unreachable. This is a
   counterfactual search, not a heuristic.
3. **Both survive an input mode change** — when a player switches from d-pad to scan mid-game, the
   recompiler repairs the puzzle, keeps the progress the team already made, and re-proves that
   nobody was quietly demoted to decorative.

Node >= 20. Dev dependencies: `typescript` and `esbuild`. Zero runtime dependencies.

```
npm test        # typecheck + the test suite (node:test)
npm run demo    # replay "The Locked Study" end to end
npm run bench   # scaling families, role-count costs, recompile cost
npm run portable # bundle src/ to one ESM file and run it with no Node built-ins
```

## What the model is

A puzzle is a finite **monotone action graph**:

- A **role** has a set of input **capabilities** (`dpad`, `scan`, `voice`) and a set of private
  **tokens** — knowledge only that player starts with.
- An **action** is performed by one role (or by `"any"`, meaning any role with the needed
  capability), requires tokens and flags, and produces tokens and flags. It fires at most once.
- A **state** is the set of flags, tokens and done actions the team has reached.
- The **goal** is a set of flags.

Nothing is ever taken away inside a plan: no action consumes a token, unsets a flag, or locks
anything out. That is what makes the search exact and cheap — the visited set is a set of
monotone states, so breadth-first search finds a shortest witness plan and "unsolvable" is a
proof rather than a timeout.

### The limits, stated plainly

This model is a *planning* abstraction, and it is honest only inside its own assumptions. It does
**not** model:

- **Consumables.** A token is never spent. A key that opens one door and is then used up is not a
  key this model can represent; it would be modelled as knowledge, which is permanent.
- **Lockouts or failure.** There is no losing move. A wrong choice is not punished, it simply
  cannot be made (see below), and no action can make the goal permanently unreachable.
- **Real choice outcomes.** A choice does not branch the world. `options: n` means "there are n
  ways to do this, and only a team holding `answerToken` can tell which one is right". A team
  without the answer token cannot perform the action **at all** — that is the honest monotone
  encoding, and it is why a choice never has a wrong-but-performed outcome.
- **Timing, concurrency, hidden information, per-player state.** Tokens are team knowledge once
  produced; the model does not track who has heard what beyond a role's private starting tokens.
- **Puzzle *quality*.** The certificate says a puzzle is well-formed, solvable and load-bearing
  for every role. It says nothing about whether the puzzle is *fun*.

`validatePuzzle` and `validateState` reject the shapes this model cannot speak about — reserved
or duplicate ids, missing required fields, unknown capabilities, unproduced knowledge, options
that are not a positive integer, a choice with no answer token — with a typed refusal rather than
a certificate. `validateState` replays `state.history` from scratch and requires the replay to
land exactly where the puzzle says: every role's capability set at the END of the replay must
equal that role's capabilities in the supplied puzzle, or the state describes a puzzle that isn't
this one, even if every individual event in the history was itself legal.

## The certificate

`certify(puzzle, state)` returns either a `Certificate` or a typed `ValidationError`. It never
returns a partial certificate: `ok` is true only when solvability, accessibility, meaningfulness
**and** every role's necessity all hold, each with its search finished rather than truncated. The
certificate body carries the canonical key of the whole puzzle (`puzzleKey`) and the normalised
state, so two puzzles sharing an id cannot produce the same hash.

Necessity is a counterfactual: remove the role — its private tokens and its ability to act — and
the goal must become unreachable. `state.tokens` counts as **knowledge already shared**: a
private token in the state has been said out loud, so the counterfactual keeps it and removes
only the role's future actions and its not-yet-shared private tokens.

## Bounded search is reported as bounded

The recompiler searches a bounded operator space (`convert`, `reassign`, `handoff`) and says which
of these happened:

| Result | Means |
| --- | --- |
| `ok` | A repaired puzzle certified, and the diff is what changed. |
| `invalid_input` | The **input** is not something the compiler can speak about — a malformed or invalid puzzle, a state no order of play reaches, an unknown role, an unknown or empty capability list, or a search bound (`maxDepth`, `maxCandidates`, `maxStates`, `maxCounterfactualStates`) that is not a positive finite integer. Nothing was searched, so nothing is claimed about the operator space. `errors` carries the issues; `operatorsTried` is empty. |
| `no_valid_recompile` | The operator space was **exhausted** — every candidate within the bound was certified, each one **proven** invalid (never truncated), and none holds. A claim about the puzzle. |
| `search_exhausted` | A **bound** stopped the search (`maxDepth`, `maxCandidates`, or a candidate's own `maxStates`/`maxCounterfactualStates`). No repair is shown to exist, and none is shown not to. |
| `operator_error` | A candidate could not be **evaluated** at all: building it, or certifying it, threw. Nothing was shown invalid, so this is not a claim about the operator space — it is the operator library reporting its own bug (`reason` carries the operator and the message). |

The four unfavourable outcomes answer four different questions and are not
interchangeable: `invalid_input` is about what was handed in, `no_valid_recompile`
is a claim about the puzzle, `search_exhausted` is a claim about the search
bound, and `operator_error` is a claim about this compiler. An exception raised
while a candidate is built or certified is caught at the search loop and becomes
`operator_error`, rather than propagating out of the call.

`operator_error` is a belt, not a plan. Every operator that builds a candidate
replaces whole actions or whole generated chains, so none of them can produce a
puzzle `validatePuzzle` refuses — if one ever does, that is a bug in this
library, and the honest answer is to say so rather than to throw out of a public
function or to dress it up as `no_valid_recompile` (a claim the search did not
establish). Both known counterexamples return `invalid_input` and `ok`
respectively with every belt guard removed — the base candidate, the operator
listing, `apply`, and each candidate's certificate. The mutation control in the
test suite checks this directly.

`no_valid_recompile` is only returned when every candidate's failure was a **proven**
one. A candidate whose own solvability search or necessity counterfactual hit its
`maxStates` cap failed with an *unproven* "no" — the search stopped, it did not
refute the candidate — so that candidate cannot be used to declare the whole
operator space exhausted. If even one candidate along the way was only
state-capped, the honest outcome is `search_exhausted` with `bound: "maxStates"`,
not the definitive `no_valid_recompile`.

A second capability change can land on a role that already owns a generated split
chain from an earlier recompile (see the next section). `convert` never rewrites
one step of that chain on its own — doing so would leave its siblings pointing at
progress tokens the replacement no longer produces, an incomplete chain
`validatePuzzle` would then refuse. The whole chain is converted (or collapsed
back to a single step) as one candidate instead, so a chain can be re-split by a
second, third, or later capability change without ever producing an invalid
puzzle. `reassign` treats a chain the same way, for the same reason: one step at a
time would leave the chain performed by two roles, which is not a shape
`convertAction` emits, so the whole chain moves to one other role that can perform
**every** link — one candidate, not one per step. Whole-chain conversion asks
whether *every* link is still performable rather than reading the first link as
the chain, and recovers the logical action it converts the same way
`validatePuzzle`'s round trip does — link 1's requirements, flags and label,
link N's effects — so the two can never disagree about what a chain means.
Recovering it is an input to the round trip, not a substitute for it: a value
changed on a *middle* link is not folded into the recovered action at all, it is
caught by the round trip's own per-step, per-field comparison of the regenerated
chain against the real one.

`maxCandidates` is enforced *before* each certification, and every result reports
`totalStatesExplored` — the solver states spent on every candidate, not just the winner.

Conversion tries **every** primitive the puzzle declares for the target capability,
smallest capacity first, so a choice the largest primitive cannot express is still
reachable through a smaller splittable one. The operator order is total, so the
search is reproducible.

## Generated ids live in a reserved namespace — and there is exactly one `certify`

`convertAction` invents action ids and progress tokens when it splits a wide choice into chained
steps: `§<id>__step<k>` for the chained actions, `§<id>__progress<k>` for the synthetic tokens
that make each step unskippable. Author ids may never start with `§` (`RESERVED_PREFIX`).

A `§`-prefixed id is legal input, but **only** in exactly the shape the generator emits: the step
chain for `<id>` is complete and consecutive from 1 (and at least two steps — the generator never
emits a one-step "chain"), `<id>` does not also exist as an un-split action, each progress token is
produced by exactly the step before it and required by exactly the step after it — and, past all of
that, **the chain round-trips**: recovering the logical action it stands for and re-running the
real `convertAction` with it, against every primitive this puzzle declares, reproduces the chain
exactly, field for field. Anything `§`-prefixed that does not match this exactly is refused,
whether it looks close or not.

The alternative — hand-listing each specific way a chain could disagree with itself and still be
accepted, one performer, one capability, one answer token — never terminated; every list missed
another way. A chain whose steps needed different capabilities (a whole-chain conversion then
skipped a link the role could no longer perform and reported `no_valid_recompile` for a puzzle the
same operator library repairs by hand); a chain whose only choice sat on its last link (whole-chain
reconstruction rebuilt a two-option action with no answer token at all, which `certificateFor` then
threw on); a chain that smuggled an extra requirement or flag onto a middle link, which a
whole-chain reconstruction that only reads link 1's requirements and link N's effects either
silently dropped or used to falsely report no repair exists. So there is no list: no per-field rule
is left to fall behind the next counterexample, because acceptance is "produces this chain when
re-run," not "agrees with itself on the fields someone thought to check."

There is exactly one certification function, `certify`, and no flag that disables this check for
a caller-selected "generated" mode. A repaired puzzle's ids are ordinary, verifiable input, so the
recompiler certifies its own candidates through the same `certify` every other caller uses. This
closes a door that is otherwise easy to leave open: a second, weaker-gated certification path
(`certifyGenerated`, then `certifyGeneratedInternal`) that any caller of the emitted package could
reach directly, bypassing the reserved-namespace check for an author-supplied `§`-namespace
puzzle. `package.json`'s `exports` field also restricts the emitted package to its public entry
point (`.`) and its own manifest (`./package.json`) — no subpath into `dist/` is importable.

## Known limitations

Three known gaps remain open. Each is real and none is fixed yet. One line each, with the
scenario that reaches it. All three are malformed *fields inside* an otherwise well-formed puzzle
or state; they are not a statement about malformed *arguments*, which are a separate question with
the separate answer given below:

- **A malformed choice can reach `validateChoice` before its own field is shape-checked.** An
  action with `options: 2`, `answerToken: "ans"`, `requiresTokens: 7` throws
  `TypeError: (action.requiresTokens ?? []).includes is not a function` out of `validatePuzzle`,
  `certify`, and `recompile` instead of a typed refusal; `options: Symbol("2")` throws the same way
  evaluating `options <= 1`.
- **A malformed state can escape validation through array normalization.** On an otherwise-valid
  puzzle, `{ flags: [Symbol("x")], tokens: [], history: [] }` (or the same with a `Symbol` in
  `tokens`) throws `TypeError: Cannot convert a Symbol value to a string` during array sorting, in
  `validateState`, `certify`, and `recompile` alike.
- **The first recorded `capability_change` in a state's history is trusted on its own `from`, with
  no independent anchor to what a role's capabilities were before any recompile.** A state can
  claim role C's history opened with a voice-only action, then a first change from
  `["voice", "dpad"]` to `["scan"]`, even when no supplied pre-recompile puzzle ever gave C
  `voice` — `validateState` and `certify` return `ok: true` regardless. Restated here because it is
  the same shape of gap as the array-normalization gap above: an internal invariant
  (self-consistency, in this case) is checked without an outside anchor to check it against.

## What a malformed argument does

Pass well-formed values of the documented types. The library validates puzzles, states and options
where it says so in each function's documentation, and may throw on malformed input.
