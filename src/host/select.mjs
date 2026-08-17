/**
 * Reads a bash command, and routes a file to the rules that may see it.
 *
 * The routing itself lives in Gleam, in src/ste/select.gleam. A rule about
 * which text counts is a rule, so it sits beside the other rules. This file
 * keeps the shape a host expects. It also reads a bash command, which still
 * needs a regexp here.
 */

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
