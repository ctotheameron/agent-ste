/**
 * Reads a bash command, and routes a file to the rules that may see it.
 *
 * The routing itself lives in Gleam, in src/ste/select.gleam. A rule about
 * which text counts is a rule, so it sits beside the other rules. This file
 * keeps the shape a host expects. It also reads a bash command, which still
 * needs a regexp here.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import * as engine from "../../dist/ste/ste/select.mjs";

/**
 * The lintable view of a file, or undefined when the file holds no prose.
 *
 * Gleam answers with an empty string for a file it cannot read. A host tells
 * that apart from an empty file, so the two answers stay separate here.
 */
export function lintableText(path, content) {
  const text = engine.lintable_text(path, content);
  return text === "" ? undefined : text;
}

// Every way a message reaches `git commit`, except a file path. A quoted value
// wins, and a bare word is the fallback.
//
// `-[a-z]*m` catches a combined short flag such as `-am`. A long flag starts
// with two dashes, so the leading `(^|\s)-` cannot match it by mistake.
const SHORT_FLAG =
  /(?:^|\s)-[a-zA-Z]*m[ \t]*(?:(['"])([\s\S]*?)\1|([^\s'"][^\s]*))/g;
const LONG_FLAG =
  /--message(?:=|[ \t]+)(?:(['"])([\s\S]*?)\1|([^\s'"][^\s]*))/g;
const HEREDOC = /-F\s*-[^\n]*\n<<['"]?(\w+)['"]?\n([\s\S]*?)\n\1/;

/**
 * True when a value reads as prose rather than as a token.
 *
 * `-m` carries a commit message, and it also carries a file mode. `mkdir -m
 * 755` and `install -m 0644` must stay unread, so a value needs two words with
 * a letter in them, and one lowercase letter. A value this test rejects stays
 * unread, which also covers `-m "$MESSAGE"`.
 */
function readsAsProse(value) {
  const words = value.trim().split(/\s+/).filter((word) => /[a-zA-Z]/.test(word));
  return words.length >= 2 && /[a-z]/.test(value);
}

/**
 * Every message a bash command carries, whatever the command is.
 *
 * `git commit` is not the only command that sends prose to a person. A harness
 * posts a message with its own tool, and `-m` or `--message` names the text.
 * So the reader takes any such value that reads as prose.
 *
 * This covers a flag only. A body in a file stays unread. So do a heredoc that
 * writes a document, and a payload in JSON.
 */
export function bashMessage(command) {
  const found = [];
  for (const pattern of [SHORT_FLAG, LONG_FLAG]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(command);
    while (match) {
      const value = match[2] ?? match[3];
      if (value !== undefined && readsAsProse(value)) {
        found.push(value);
      }
      match = pattern.exec(command);
    }
  }

  const heredoc = command.match(HEREDOC);
  if (heredoc) {
    found.push(heredoc[2]);
  }

  const text = found.join("\n\n");
  return text.trim() === "" ? undefined : text;
}

/** The name for a message, so a block reason says where the text came from. */
export function bashMessageLabel(command) {
  return COMMIT_VERB.test(command) ? "the commit message" : "the message";
}

// `git commit`, and also `git -C /tmp commit`. A global flag can sit between the
// two words. A shell separator ends the search, so a later command is safe.
const COMMIT_VERB = /git\s+(?:[^\s;|&]+\s+)*?commit\b/;

/** Extracts every `git commit` message from a bash command, if there is one. */
export function commitMessage(command) {
  const at = command.search(COMMIT_VERB);
  if (at === -1) {
    return undefined;
  }
  const tail = command.slice(at);

  const found = [];
  for (const pattern of [SHORT_FLAG, LONG_FLAG]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(tail);
    while (match) {
      found.push(match[2] ?? match[3]);
      match = pattern.exec(tail);
    }
  }

  const heredoc = tail.match(HEREDOC);
  if (heredoc) {
    found.push(heredoc[2]);
  }

  // `git commit -m a -m b` makes one message of two paragraphs.
  const text = found.filter((part) => part !== undefined).join("\n\n");
  return text.trim() === "" ? undefined : text;
}

// --- prose in a `gh` command ---
//
// `gh pr create` and its kin send a title and a body to other people. The flag
// reader above cannot see them, because `gh` names them `--title` and `--body`,
// and a body often sits in a heredoc inside `$(...)`. So this reader splits the
// command into words first, the way a shell does, and it reads the flags of the
// few `gh` commands that post prose.
//
// A word that holds a command substitution or a backtick has no known value.
// The reader skips it. Skipping gives a miss, and a miss costs less than a
// false block.

// `$(cat <<'EOF' ... EOF)`, the form a model uses to pass a long body.
const CAT_HEREDOC =
  /^\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*\)/;

const MAX_BODY_FILE = 1_000_000;

/** The index after the `)` that closes the `$(` at `from`. */
function skipSubstitution(source, from) {
  let depth = 0;
  for (let at = from + 1; at < source.length; at += 1) {
    if (source[at] === "(") {
      depth += 1;
    } else if (source[at] === ")") {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
  }
  return source.length;
}

/**
 * Reads a double-quoted string that starts at `from`.
 *
 * Returns the word, and the index after the closing quote.
 */
function readDouble(source, from) {
  const word = { value: "", dynamic: false, heredoc: false };
  let at = from + 1;
  while (at < source.length && source[at] !== '"') {
    const rest = source.slice(at);
    const heredoc = rest.startsWith("$(") ? CAT_HEREDOC.exec(rest) : null;
    if (heredoc) {
      word.value += heredoc[3];
      word.heredoc = true;
      at += heredoc[0].length;
    } else if (rest.startsWith("$(")) {
      word.dynamic = true;
      at = skipSubstitution(source, at + 1);
    } else if (source[at] === "`") {
      word.dynamic = true;
      const close = source.indexOf("`", at + 1);
      at = close === -1 ? source.length : close + 1;
    } else if (source[at] === "\\" && '"\\$`\n'.includes(source[at + 1] ?? "x")) {
      word.value += source[at + 1] === "\n" ? "" : source[at + 1];
      at += 2;
    } else {
      word.value += source[at];
      at += 1;
    }
  }
  return { word, next: at + 1 };
}

/** Reads the heredoc bodies that wait at a newline, and returns the new index. */
function readHeredocs(source, from, pending) {
  let at = from;
  for (const { owner, delimiter, strip } of pending) {
    const lines = [];
    while (at < source.length) {
      const end = source.indexOf("\n", at);
      const line = source.slice(at, end === -1 ? source.length : end);
      at = end === -1 ? source.length : end + 1;
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
        break;
      }
      lines.push(line);
    }
    owner.stdin = lines.join("\n");
  }
  return at;
}

/**
 * Splits a bash command into simple commands, each a list of words.
 *
 * This is a small reader, not a shell. It knows quotes, operators, comments and
 * heredocs, which is what a `gh` call needs. A word it cannot read carries
 * `dynamic: true`.
 */
export function shellCommands(source) {
  const commands = [];
  const pending = [];
  let command;
  let word;

  const open = () => {
    command ??= { words: [], stdin: "" };
    if (!commands.includes(command)) {
      commands.push(command);
    }
    return command;
  };
  const endWord = () => {
    if (word !== undefined) {
      open().words.push(word);
      word = undefined;
    }
  };
  const endCommand = () => {
    endWord();
    command = undefined;
  };
  const extend = (text) => {
    word ??= { value: "", dynamic: false, heredoc: false };
    word.value += text;
  };

  let at = 0;
  while (at < source.length) {
    const char = source[at];
    const rest = source.slice(at);
    if (char === "\n") {
      endCommand();
      at = readHeredocs(source, at + 1, pending.splice(0));
    } else if (/[ \t]/.test(char)) {
      endWord();
      at += 1;
    } else if (char === "#" && word === undefined) {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
    } else if (/^(?:&&|\|\||[;|&])/.test(rest)) {
      endCommand();
      at += /^(?:&&|\|\|)/.test(rest) ? 2 : 1;
    } else if (/^<<(?!<)/.test(rest)) {
      const spec = /^<<(-?)[ \t]*(['"]?)(\w+)\2/.exec(rest);
      endWord();
      if (spec) {
        pending.push({ owner: open(), delimiter: spec[3], strip: spec[1] === "-" });
      }
      at += spec ? spec[0].length : 2;
    } else if (char === "'") {
      const close = source.indexOf("'", at + 1);
      extend(source.slice(at + 1, close === -1 ? source.length : close));
      at = close === -1 ? source.length : close + 1;
    } else if (char === '"') {
      const quoted = readDouble(source, at);
      extend(quoted.word.value);
      word.dynamic ||= quoted.word.dynamic;
      word.heredoc ||= quoted.word.heredoc;
      at = quoted.next;
    } else if (rest.startsWith("$(") || char === "`") {
      extend("");
      word.dynamic = true;
      const close = char === "`" ? source.indexOf("`", at + 1) : -2;
      at = char === "`" ? (close === -1 ? source.length : close + 1) : skipSubstitution(source, at + 1);
    } else if (char === "\\") {
      if (source[at + 1] !== "\n") {
        extend(source[at + 1] ?? "");
      }
      at += 2;
    } else {
      extend(char);
      at += 1;
    }
  }
  endCommand();
  return commands;
}

// What each `gh` command calls its fields. A body means a comment on `comment`
// and a review on `review`, so the block reason names the right thing.
const GH_COMMANDS = {
  pr: { create: "body", edit: "body", comment: "comment", review: "review" },
  issue: { create: "body", edit: "body", comment: "comment" },
};
const GH_NOUN = { pr: "PR", issue: "issue" };

const GH_FLAG = /^(?:--(title|body|body-file)(?:=([\s\S]*))?|-([tbF])(?:=?([\s\S]+))?)$/;
const GH_FIELD = { t: "title", b: "body", F: "body-file" };

/** The field and the inline value of a flag word, or undefined. */
function ghFlag(word) {
  const match = word.dynamic ? null : GH_FLAG.exec(word.value);
  if (match === null) {
    return undefined;
  }
  const field = match[1] ?? GH_FIELD[match[3]];
  return { field, value: match[1] ? match[2] : match[4] };
}

function readBodyFile(path, cwd) {
  try {
    const file = resolve(cwd ?? process.cwd(), path);
    return statSync(file).size > MAX_BODY_FILE ? undefined : readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The texts one `gh` command sends, each with its label. */
function ghTexts(command, cwd) {
  const words = [...command.words];
  while (words.length > 0 && /^\w+=/.test(words[0].value)) {
    words.shift();
  }
  const [program, noun, verb, ...args] = words.map((word, index) => (index < 3 ? word.value : word));
  if (!/(?:^|\/)gh$/.test(program ?? "") || GH_COMMANDS[noun]?.[verb] === undefined) {
    return [];
  }

  const found = [];
  const body = GH_COMMANDS[noun][verb];
  for (let at = 0; at < args.length; at += 1) {
    const flag = ghFlag(args[at]);
    const value = flag === undefined ? undefined : flag.value ?? args[(at += 1)];
    const word = typeof value === "string" ? { value, dynamic: false, heredoc: false } : value;
    if (flag === undefined || word === undefined || word.dynamic) {
      continue;
    }
    const label = (field) => `the ${GH_NOUN[noun]} ${field}`;
    if (flag.field === "title" && readsAsProse(word.value)) {
      found.push({ text: word.value, label: label("title") });
    } else if (flag.field === "body" && (word.heredoc || readsAsProse(word.value))) {
      found.push({ text: word.value, label: label(body) });
    } else if (flag.field === "body-file") {
      const text = word.value === "-" ? command.stdin : readBodyFile(word.value, cwd);
      if (text !== undefined && text.trim() !== "") {
        const source = word.value === "-" ? "" : ` (${basename(word.value)})`;
        found.push({ text, label: label(body) + source });
      }
    }
  }
  return found;
}

/**
 * Every prose field that `gh pr` and `gh issue` commands send in a bash command.
 *
 * Each entry holds `text` and a `label`, such as `the PR body`. A body file is
 * read from disk at `cwd`. The reader skips a file that is missing, too large
 * or unreadable. It also skips a value that is not prose, such as the `-b main`
 * of a list.
 */
export function ghMessages(command, cwd) {
  return shellCommands(command).flatMap((entry) => ghTexts(entry, cwd));
}
