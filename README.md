# pi-ste

Simplified Technical English (ASD-STE100) enforcement for
[pi](https://github.com/earendil-works/pi-mono). The rule engine is Gleam. It
compiles to JavaScript, so the extension runs it in process.

## What it does

The extension works in three layers:

1. **It tells the model the rules.** The system prompt gains a rule list built
   from the same table the linter checks.
2. **It blocks a bad write.** A hard violation in a `write`, an `edit` or a
   `git commit` message stops the tool call. The reason names the line, the
   column and the fix.
3. **It checks the reply.** A status widget counts violations in the assistant
   text. A hard violation also returns as a note, so the model reads the rule
   it broke.

The note never rewrites prose, because a mechanical rewrite can change the
meaning. When the turn still holds a tool call, the note arrives before the next
model call. The last reply of a run has no tool call, so its note waits for the
next prompt.

## What it reads

| File | Text the linter sees |
| --- | --- |
| `.md`, `.mdx`, `.txt`, `.rst` | all of it, minus code fences and code spans |
| `.ts`, `.tsx`, `.js`, `.gleam`, `.go`, `.rs`, ... | `//` and `/* */` comments |
| `.sh`, `.py`, `.rb`, `.yml`, `.toml` | `#` comments |
| a `git commit -m` message in bash | the message |
| anything else | nothing |

An identifier is never a violation. `const utilize = ...` passes. The comment
`// We will utilize it.` does not.

## Install

`dist/` is a build artifact, so install from npm, where the release ships it:

```bash
pi install npm:pi-ste
```

To run it from a checkout, build `dist/` first:

```bash
gleam test
./scripts/build-dist.sh
pi -e ./extension.mjs
```

### Claude Code

The same engine runs as a Claude Code plugin. Add the repository as a
marketplace, then install the plugin:

```
/plugin marketplace add ctotheameron/pi-ste
/plugin install ste@pi-ste
```

The plugin needs node only. It has no build step, because the npm release ships
`dist/`. One hook covers each layer:

| Hook | Layer |
| --- | --- |
| `SessionStart` | the rule list joins the session context |
| `PreToolUse` on Write, Edit and Bash | a hard violation denies the call |
| `Stop` | a hard violation in the reply blocks the stop |

The `Stop` hook blocks, because a hook reaches the model only when it blocks.
Claude Code sets `stop_hook_active` on the retry, and the hook then keeps quiet.
One reply gets one block. `/ste strict off` stops the reply check.

A hook error never blocks. When `dist/` is absent, the hook reports the fix and
the event continues.

In Claude Code the command reads `/ste status` too, because a hook has no status
widget.

## Use

```
/ste             Toggle enforcement
/ste off         Disable it
/ste strict      Gate every reply through the say tool
/ste strict off  Leave strict mode
```

The model can also check its own text with the `ste_lint` tool.

## Strict mode

The pi API blocks a tool call only, so a plain reply stays out of reach. In
strict mode the model sends each reply through the `say` tool, and a hard
violation blocks that call. You never read the bad text.

The cost is one tool call for every reply. Use strict mode for a document
review, and leave it off for normal work.

## The CLI

```bash
ste-lint README.md docs/*.md   # exit code 1 on a hard violation
ste-lint --json src/**/*.ts
cat draft.md | ste-lint
```

Use it in a pre-commit hook or in CI.

## Rules

| Rule | Severity |
| --- | --- |
| `dictionary/not-approved-word` | hard |
| `length/sentence` | hard over 25 words, soft over 20 |
| `length/paragraph` | hard over 6 sentences |
| `verb/progressive` | hard |
| `verb/perfect` | hard |
| `verb/passive` | soft |
| `style/contraction` | hard |
| `style/semicolon` | hard |
| `style/phrasal-verb` | hard |
| `style/hedge` | soft |
| `style/marketing` | soft |

A `Hard` rule blocks a write. A `Soft` rule warns.

STE also caps a compound noun at 3 words. This linter does not check that rule.
A word-list heuristic gives too many false positives. An English third-person
verb has the same spelling as a plural noun. That check needs part-of-speech
tagging.

## Build

```bash
asdf install gleam 1.18.0
gleam test
./scripts/build-dist.sh
```

The script writes `dist/`, a build artifact that `.gitignore` holds. `npm
publish` runs the script first through `prepublishOnly`, so the release ships
`dist/`.

## Licence

MIT. See `AGENTS.md` for attribution and for the limits ASD places on the
dictionary.
