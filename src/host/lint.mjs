/**
 * The one rule layer that every host calls.
 *
 * The pi extension and the Claude Code hook read different event shapes. Both
 * end at the same two questions. Which text does the linter see, and what does
 * a hard violation say. This module answers both, so no host holds a second
 * copy of the answer.
 *
 * A `Subject` is a record of `text` and `label`. The text goes to the engine.
 * The label names the source in the block reason, such as `notes.md` or
 * `the commit message`.
 */

import * as engine from "../../dist/ste/ste.mjs";
import { commitMessage, lintableText } from "./select.mjs";

/** Compiles every pattern and the dictionary once. */
export function newEngine() {
  const result = engine.new_engine();
  if (!result.isOk()) {
    throw new Error("ste: the rule engine failed to compile its patterns");
  }
  return result[0];
}

/** The rule list for a system prompt or for a session context block. */
export function promptText() {
  return engine.prompt_text();
}

export function lint(compiled, text) {
  return JSON.parse(engine.lint_json_with(compiled, text));
}

/** One line for each violation, with the line, the column and the fix. */
export function format(violations) {
  return violations
    .map((v) => `  ${v.line}:${v.column}  ${v.message}  [${v.ruleId}]`)
    .join("\n");
}

export function summarise(violations) {
  const hard = violations.filter((v) => v.severity === "hard").length;
  return { hard, soft: violations.length - hard };
}

/**
 * Lints one subject and reports what a host needs for a decision.
 *
 * `reason` holds the text a host shows when it blocks. The field stays empty
 * when no hard violation exists, so a host can test that one field.
 */
export function check(compiled, subject) {
  const violations = lint(compiled, subject.text);
  const hard = violations.filter((v) => v.severity === "hard");
  const soft = violations.filter((v) => v.severity === "soft");
  return {
    violations,
    hard,
    soft,
    reason: hard.length === 0 ? undefined : blockReason(subject.label, hard),
  };
}

/** The text a host shows when a hard violation stops the work. */
export function blockReason(label, hard) {
  return (
    `Simplified Technical English: ${hard.length} violation(s) in ` +
    `${label}.\n${format(hard)}\n` +
    "Rewrite the text and call the tool again."
  );
}

/** A warning for a soft violation. It never blocks. */
export function warnReason(label, soft) {
  return (
    `Simplified Technical English: ${soft.length} warning(s) in ` +
    `${label}.\n${format(soft)}`
  );
}

/** The subject for a whole new file, or undefined when the file has no prose. */
export function fileSubject(path, content) {
  const text = lintableText(path, content);
  return text === undefined ? undefined : { text, label: path };
}

/**
 * The subject for an edit. Only the new text counts, because the old text is
 * already on disk and its author is not the model.
 *
 * The host passes a list, since one pi edit call holds many replacements.
 */
export function editSubject(path, texts) {
  return fileSubject(path, texts.join("\n"));
}

/** The subject for a bash command, or undefined when it commits nothing. */
export function commitSubject(command) {
  const message = commitMessage(command);
  return message === undefined
    ? undefined
    : { text: message, label: "the commit message" };
}

/** The subject for assistant prose, or undefined when the text is blank. */
export function replySubject(text) {
  return text.trim() === "" ? undefined : { text, label: "the reply" };
}
