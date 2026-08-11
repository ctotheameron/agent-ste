# agent-ste

Your coding agent writes clear English, or it does not write at all.

`agent-ste` holds a coding agent to ASD-STE100 Simplified Technical English.
That is the writing standard the aerospace industry uses for a maintenance
manual. See the [ASD-STE100 site](https://www.asd-ste100.org/).

It runs in [pi](https://github.com/earendil-works/pi-mono), in
[Claude Code](https://docs.anthropic.com/en/docs/claude-code), and on its own as
a command.

## Why

A coding agent writes prose all day. It writes your commit messages, your code
comments, your README and your reply. Left alone, it writes like this:

```md
It is important to note that this module leverages a robust caching strategy
in order to facilitate seamless performance improvements; it is being utilized
by the majority of our services. We have implemented a comprehensive approach
that will ensure optimal throughput.
```

Four lines. 12 hard faults and 4 soft ones. Nobody asked for that prose, and
every reader pays for it.

`agent-ste` blocks the write and names each fault:

```
3:42  error  Use "use", not "leverages".            [dictionary/not-approved-word]
4:1   error  Use "to", not "in order to".           [dictionary/not-approved-word]
4:57  error  Do not use a semicolon. Write two sentences.        [style/semicolon]
4:62  error  Use a simple tense. Do not use the progressive.  [verb/progressive]
5:37  error  Use the simple past. Do not use the perfect tense.   [verb/perfect]
3:1   error  This sentence has 30 words. Write no more than 25.  [length/sentence]
3:1   warn   Delete "it is important to note".                     [style/hedge]
3:54  warn   Delete "robust".                                  [style/marketing]
```

The agent reads the reasons and writes it again:

```md
This module caches a result, so a service reads it faster. Most of our
services use it. The cache holds the best throughput we measured.
```

Same meaning. Half the words. Zero faults.

## What you get

**A standard, not an opinion.** ASD-STE100 exists because a mechanic in a hangar
must read a procedure one time and get it right. Every rule earns its place. One
word means one thing. A sentence stops at 20 words. The reader never guesses.

**Enforcement at the keystroke, not at review.** A hard fault blocks the tool
call before the file changes. The agent never argues, because the block names the
line, the column and the word to use. Review time drops, because the prose
arrives correct.

**No rewriting.** The tool never edits your prose for you. A mechanical rewrite
can change what a sentence means, and only the author knows the intent. It
reports, and the author decides.

**Prose only.** Your code is safe. An identifier such as `utilize` passes
untouched. The same word in a comment does not.

**No false comfort.** A rule that cries wolf teaches you to ignore it. So a
heuristic warns and never blocks. Only a deterministic check can stop a write.

## What it checks

| Rule | Severity | It reports |
| --- | --- | --- |
| `dictionary/not-approved-word` | hard | a word with an approved replacement |
| `length/sentence` | hard over 25, soft over 20 | a sentence a reader must read twice |
| `length/paragraph` | hard over 6 sentences | a wall of text |
| `verb/progressive` | hard | `is removing`, for `removes` |
| `verb/perfect` | hard | `we have received`, for `we received` |
| `verb/passive` | soft | a hidden actor |
| `style/contraction` | hard | `do not`, never the short form |
| `style/semicolon` | hard | two sentences in one coat |
| `style/phrasal-verb` | hard | `spin up`, for `start` |
| `style/hedge` | soft | `it is important to note` |
| `style/marketing` | soft | `seamless`, `robust` |

Hard blocks a write. Soft warns and lets it through.

## Where it looks

| File | Text it reads |
| --- | --- |
| `.md`, `.mdx`, `.txt`, `.rst` | all prose, minus code fences and code spans |
| `.ts`, `.js`, `.gleam`, `.go`, `.rs`, ... | `//` and `/* */` comments |
| `.sh`, `.py`, `.rb`, `.yml`, `.toml` | `#` comments |
| a `git commit -m` message | the message |
| the reply to you | the prose the agent sends |
| anything else | nothing |

## Install

### pi

```bash
pi install npm:agent-ste
```

The package also appears in the [pi gallery](https://pi.dev/packages).

### Claude Code

```
/plugin marketplace add ctotheameron/agent-ste
/plugin install ste@agent-ste
```

### On its own

```bash
npm install --global agent-ste
ste-lint README.md docs/*.md
cat draft.md | ste-lint
```

Exit code 1 means a hard fault. Use it in a pre-commit hook or in CI.

## Control it

```
/ste             Toggle enforcement
/ste off         Disable it
/ste strict      Gate every reply
/ste strict off  Leave strict mode
```

Normal mode blocks a write, and it counts the faults in each reply.

Strict mode goes further. The agent sends every reply through one tool, and a
hard fault blocks that call. You never read the bad text. Strict mode costs one
tool call per reply. Turn it on for a document review, and off for normal work.

The agent can also check a draft itself, with the `ste_lint` tool.

## One rule it skips

STE caps a compound noun at 3 words. This tool does not check that cap. An
English verb and a plural noun share a spelling, so a word-list test reports too
many false alarms. That check needs a part-of-speech tagger, and a tagger costs
more than the rule returns.

## Under the hood

The rule engine is Gleam, compiled to JavaScript, and every host runs it in
process. There is no daemon, no service and no network call.

`AGENTS.md` holds the design, the measurements and the rules for a change.
`docs/releasing.md` holds the release flow.

## Licence

MIT. See [LICENSE](LICENSE). `AGENTS.md` names the sources of the word lists,
and the limits ASD places on its dictionary.
