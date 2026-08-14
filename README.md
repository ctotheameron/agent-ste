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

**A standard, not an opinion.** ASD-STE100 exists for a reason. A mechanic in a
hangar must read a procedure one time and get it right. Every rule earns its place. One
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
| `suppress/invalid-directive` | hard | a silence comment that silences nothing |

Hard blocks a write. Soft warns and lets it through.

## When a rule is wrong

No linter reads intent. When a rule reports text that is right, silence that one
rule on that one line:

```md
<!-- ste-disable-next-line style/marketing -->
The robust estimator holds for this sample.
```

Use the comment marker of the file in source code:

```ts
// ste-disable-next-line dictionary/not-approved-word
// The leverage ratio stays below two.
```

A space or a comma separates two rule ids. The comment covers the next line and
no other, so it cannot silence a file. A comment that names no rule, or names a
rule that does not exist, reports `suppress/invalid-directive`. A silent typo
would read as a working comment.

## Settings

A whole rule is too blunt for one line, and a project sometimes wants a
different line. Put a `.ste.json` file at the root of the project:

```json
{
  "rules": {
    "verb/passive": "off",
    "style/marketing": "hard",
    "length/paragraph": "soft"
  }
}
```

Each rule reads `hard`, `soft` or `off`. Every host reads the file: pi, Claude
Code and the command. The command also takes `--config <path>` for one file.

### One default for a whole machine

A fleet of headless agents carries no repository file. So a global file holds
the default, and a project file refines it:

| Source | Path |
| --- | --- |
| the environment | `STE_CONFIG=/etc/ste.json` |
| the config directory | `$XDG_CONFIG_HOME/ste/config.json`, else `~/.config/ste/config.json` |
| the project | `.ste.json`, found from the working directory upward |

The project wins for each rule it names, and it keeps the rest. `STE_CONFIG`
replaces the config directory path. A missing file there is an error, because an
operator who names a file wants it.

This pairs well with a warn-only fleet. Set every rule to `soft` in the global
file, and no write ever blocks. The agent still reads each fault and corrects
the next line it writes.

A rule set to `off` also leaves the rule list the model reads. It then wastes no
context on a rule that nothing checks.

Each severity does one job:

| Setting | A write | A reply |
| --- | --- | --- |
| `hard` | blocks | reports |
| `soft` | warns | reports |
| `off` | nothing | nothing |

A reply note blocks nothing, so it carries every fault at either severity. Use
`off` to quiet a rule. A fleet that sets every rule to `soft` then blocks no
write, and it still reads every fault.

A bad name, a bad severity, or any other key stops the command with exit code 2.
A linter that reads broken settings and reports a pass gives a false result.

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
/plugin install ste@ctotheameron
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

Both hosts start the same way. Normal mode blocks a write and a commit message.
It reads each reply too, and it hands the faults to the agent before its next
answer. It hides nothing and blocks no reply.

Strict mode goes further, and the two hosts differ here. In pi the agent sends
every reply through one tool, and a hard fault blocks that call. You never read
the bad text. Claude Code streams a reply before any hook runs. A block there
asks for a rewrite, and you read the first answer anyway. Turn strict on for a
document review, and leave it off for normal work.

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
