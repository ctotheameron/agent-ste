/**
 * The on and off state of one Claude Code session.
 *
 * The pi extension keeps this state in memory, because the extension lives for
 * the whole session. Claude Code starts a new process for every hook event, so
 * the state needs a file. The file sits in the system temporary directory,
 * under the session id, and holds two flags.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Enforcement starts on, and the reply gate starts off.
 *
 * The pi extension starts the same way. A reply gate is the one layer a host
 * cannot hide. Claude Code streams the text before a Stop hook runs.
 * So the default reports a reply rather than blocking it, and `/ste strict`
 * asks for the block.
 */
export const DEFAULT_STATE = {
  enabled: true,
  strict: false,
  pending: [],
  replied: "",
};

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
    return {
      enabled: raw.enabled !== false,
      strict: raw.strict === true,
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      replied: typeof raw.replied === "string" ? raw.replied : "",
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/**
 * A short name for one reply.
 *
 * Claude Code can send the same Stop event twice. The name tells a repeat from
 * a new reply, so one reply gives one report.
 */
export function identify(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
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
  const carry = { pending: state.pending ?? [], replied: state.replied ?? "" };
  if (trimmed === "strict" || trimmed === "strict on") {
    return { ...carry, enabled: true, strict: true };
  }
  if (trimmed === "strict off") {
    return { ...carry, enabled: state.enabled, strict: false };
  }
  if (trimmed === "status") {
    return state;
  }
  const enabled = trimmed === "" ? !state.enabled : trimmed !== "off";
  return { ...carry, enabled, strict: enabled && state.strict };
}

/** One line for the user, and for the model that reads the command output. */
export function describe(state) {
  if (!state.enabled) {
    return "STE off. No hook checks a write, a commit message or a reply.";
  }
  const reply = state.strict
    ? "A hard violation in a reply blocks the stop, one time."
    : "A reply goes through, and its faults reach the model at your next prompt.";
  return `STE on, strict ${state.strict ? "on" : "off"}. ${reply}`;
}
