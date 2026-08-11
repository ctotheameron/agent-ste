/**
 * The on and off state of one Claude Code session.
 *
 * The pi extension keeps this state in memory, because the extension lives for
 * the whole session. Claude Code starts a new process for every hook event, so
 * the state needs a file. The file sits in the system temporary directory,
 * under the session id, and holds two flags.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Both flags start on.
 *
 * `strict` starts on here, and off in the pi extension. The reason is the
 * channel. pi can steer a note into the same run, so the extension does not
 * need to block a reply. A Claude Code hook reaches the model only when it
 * blocks, and `stop_hook_active` limits that block to one retry.
 */
export const DEFAULT_STATE = { enabled: true, strict: true };

const DIRECTORY = join(tmpdir(), "ste-session");

/** Holds a session id to the characters a file name accepts. */
function fileName(sessionId) {
  const safe = String(sessionId ?? "").replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${safe === "" ? "unknown" : safe.slice(0, 80)}.json`;
}

export function statePath(sessionId) {
  return join(DIRECTORY, fileName(sessionId));
}

/**
 * Reads the state of a session.
 *
 * Every error gives the default. A missing file is the normal first read, and a
 * damaged file must not stop the linter.
 */
export function readState(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(statePath(sessionId), "utf8"));
    return { enabled: raw.enabled !== false, strict: raw.strict !== false };
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeState(sessionId, state) {
  mkdirSync(DIRECTORY, { recursive: true });
  writeFileSync(statePath(sessionId), JSON.stringify(state));
}

/**
 * Applies one `/ste` word to a state.
 *
 * The words match the pi command in extension.mjs. An empty word toggles, and
 * `off` also clears strict mode. `status` is the one word that changes nothing,
 * because a hook has no other way to report the state.
 */
export function apply(state, word) {
  const trimmed = word.trim().toLowerCase();
  if (trimmed === "strict" || trimmed === "strict on") {
    return { enabled: true, strict: true };
  }
  if (trimmed === "strict off") {
    return { enabled: state.enabled, strict: false };
  }
  if (trimmed === "status") {
    return state;
  }
  const enabled = trimmed === "" ? !state.enabled : trimmed !== "off";
  return { enabled, strict: enabled && state.strict };
}

/** One line for the user, and for the model that reads the command output. */
export function describe(state) {
  if (!state.enabled) {
    return "STE off. No hook checks a write, a commit message or a reply.";
  }
  const reply = state.strict
    ? "A hard violation in a reply blocks the stop, one time."
    : "A reply goes through, and only a write or a commit message blocks.";
  return `STE on, strict ${state.strict ? "on" : "off"}. ${reply}`;
}
