# agent-ste

## Language choice

The rule engine is Gleam. This is a decision for this project only. Do not apply
it to another repository.

Reasons:

- A lint rule is a pure function from text to a list of violations. Gleam gives
  pattern matching, exhaustive `case` checks and no `null`.
- Gleam compiles to JavaScript, so the pi extension imports the engine in
  process. There is no daemon and no IPC.
- The same pure source can compile to Erlang later, for a repo-wide sweep or an
  LSP daemon. Keep the core pure to hold that option open.

The host layer is JavaScript, in `src/host/` and `extension.mjs`. It owns file
routing and pi events. It owns no rules.

## Gleam style

Follow gleam_stdlib. Read `build/packages/gleam_stdlib/src/gleam/` for examples.

- Pass at most 3 arguments. Bundle a repeated pair into a record, such as
  `source.Line`, or the `Search` value in `dictionary.gleam`.
- Nest no deeper than 2 levels. Replace a nested `case` with a multi-subject
  `case`, a small named function, or an early return.
- Use `use` for an early return and for a chain that can fail. `bool.guard`
  ends a function early, and `result.try` chains a step that can fail.
- Prefer a pipeline over a temporary variable. `list.map_fold` threads state and
  keeps the order, so it removes a manual `list.reverse`.
- Map over a container rather than unwrap it. `result.map`, `option.map` and
  `result.unwrap` replace a `case` on `Ok` and `Error`.
- Name a tail-recursive helper with a `_loop` suffix, as the stdlib does.
- A call takes one argument hole only. Write `f(_, line)`. Write a closure when
  a call needs two.

The stdlib itself calls no `use`. It supplies the functions that `use` needs,
and this project calls them.

## Rules of the build

- `gleam.toml` sets `target = "javascript"`.
- Run `./scripts/build-dist.sh` after any change to `src/`. It writes `dist/`.
- `dist/` is a build artifact, not a source file. `.gitignore` holds it, so do
  not commit it. `npm publish` builds it first through `prepublishOnly`, so the
  npm release still ships it.
- Add no target-specific FFI. It closes the Erlang option.

## Where a rule lives

A rule needs two parts, and both live in Gleam:

1. A variant in `rule.Id` in `src/ste/rule.gleam`. The compiler then asks for
   its name, its severity and its prompt line. That line reaches the model
   through the system prompt.
2. A check that emits the same `rule.Id`.

The test `every_declared_rule_is_implemented_test` compares the roster against
the ids the engine emits, in both directions. This stops the prompt from asking
for a check the linter never makes.

Most word and phrase rules need no new code. Add an `Entry` to the table in
`src/ste/dictionary.gleam` with a `rule.Id`. The rule gives the severity, and
the n-gram lookup handles words and phrases in the same pass.

## Measuring a new word

Test a candidate against real prose first. A word with a second, technical sense
reports a false positive on correct writing.

These candidates failed that test and stay out:

| Candidate | Why it stays out |
| --- | --- |
| `component`, `execute`, `abort`, `invoke` | Normal API vocabulary. |
| `navigate`, `unlock`, `mitigate`, `essential` | Correct in place. |
| `leading` | It marks the start of a string. |
| `rather` | It pairs with "than". Our own docs use it. |
| `underscores` | The `_` character. |
| `work out` | It starts "works out of the box". |
| `elevated` | It describes permissions. |
| `unmatched` | It describes pairs and brackets. |
| `realm` | An auth realm. |

Cost differs by severity. A Soft word costs nothing in the prompt. The word
table lists a word only when it has an approved replacement. A Hard word adds
one line to every request.

## Severity

- `Hard` blocks a write. Use it only for a deterministic check.
- `Soft` warns. Use it for a heuristic, such as passive voice.

A false positive on `Hard` stops real work. When in doubt, choose `Soft`.

**A noisy `Soft` rule is worse than no rule.** It teaches a reader to ignore the
output. We removed `style/noun-cluster` for this reason at an 80%
false-positive rate. Measure a new heuristic against this repo's own prose
before you keep it.

## Performance

Measured on a 200-line document, with a reused engine:

| Stage | Cost |
| --- | --- |
| whole lint | 5.8 ms |
| tokenize | 4.5 ms |
| mask code | 0.9 ms |
| dictionary lookup | 0.2 ms |

Three lessons paid for in this repo:

- Split sentences per BLOCK, never per line. A per-line split counts one
  hard-wrapped sentence twice. That over-reports paragraph length and
  under-reports sentence length. Join a block, split it, then map each offset
  back to a line and a column.


- `string.to_graphemes` is slow on the JavaScript target. It cost 86% of lint
  time. One native regexp pass replaced it.
- Build the engine once. `new_engine` compiles every regexp and the dictionary.
  A rebuild per call costs more than the whole scan.

Measure before you optimise. Two guesses in this repo were both wrong.

## Test commands

```
gleam test                    # the rule engine
./bin/ste-lint.mjs README.md  # the CLI, and a check on our own prose
pi -nc -e ./extension.mjs -p "..."   # the extension, end to end
```

## Attribution

The phrasal-verb, hedge, marketing and irregular-participle lists come from
[Ryuketsukami/ste-plain-writing](https://github.com/Ryuketsukami/ste-plain-writing)
(MIT). The rule summary comes from
[danyuchn/asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill) (MIT).

ASD owns ASD-STE100. The specification is free to download, and ASD limits
redistribution. Ship no full dictionary here. The table holds widely-cited pairs
only.
