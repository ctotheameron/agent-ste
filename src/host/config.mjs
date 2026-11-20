/**
 * Reads the project settings for the linter.
 *
 * A project chooses the severity of each rule in a `.ste.json` file at its
 * root. A rule reads `hard`, `soft` or `off`. Two more keys steer Claude Code.
 * `enabled` says if a new session starts with checks on. `replies` says if the
 * Stop hook reads replies. An unknown key is an error, so a
 * typo cannot pass in silence.
 *
 * The loader owns no rule. It checks each name against the roster the engine
 * reports, so the engine stays the one source of truth.
 *
 * Two files can apply. A global file gives a machine or an image its default,
 * and a project file refines it. The project wins for each rule it names.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { env } from "node:process";

export const CONFIG_NAME = ".ste.json";

const KEYS = ["rules", "enabled", "replies"];

/**
 * The global file, which holds the default for every session on a machine.
 *
 * `STE_CONFIG` names it outright, which suits an image or a fleet. Without that
 * variable the path follows the XDG directory, and a relative `XDG_CONFIG_HOME`
 * does not count.
 */
export function globalPath() {
  if (env.STE_CONFIG) {
    return { path: env.STE_CONFIG, named: true };
  }
  const base = env.XDG_CONFIG_HOME;
  const root = base && isAbsolute(base) ? base : join(homedir(), ".config");
  return { path: join(root, "ste", "config.json"), named: false };
}

const SETTINGS = ["hard", "soft", "off"];
const SWITCHES = ["on", "off"];
const TRUE_WORDS = ["1", "true", "on", "yes"];
const FALSE_WORDS = ["0", "false", "off", "no"];

/** An error the caller reports to a user. It names the file and the fault. */
export class ConfigError extends Error {}

/** The path of the nearest config file, or undefined when no parent holds one. */
export function findConfig(from) {
  let directory = resolve(from);
  for (;;) {
    const path = join(directory, CONFIG_NAME);
    try {
      readFileSync(path);
      return path;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
    }
  }
}

function parse(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`${path}: the file failed to open. ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: the file holds no valid JSON. ${error.message}`);
  }
}

function checkRules(path, rules, names) {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) {
    throw new ConfigError(`${path}: "rules" must be an object.`);
  }
  for (const [name, setting] of Object.entries(rules)) {
    if (names !== undefined && !names.includes(name)) {
      throw new ConfigError(
        `${path}: "${name}" is no rule. The rules are: ${names.join(", ")}.`,
      );
    }
    if (!SETTINGS.includes(setting)) {
      throw new ConfigError(
        `${path}: "${name}" reads "${setting}". Write "hard", "soft" or "off".`,
      );
    }
  }
  return rules;
}

/**
 * Reads and checks one config file.
 *
 * `names` holds every rule the engine reports. The caller reads it from the
 * engine, so this module never repeats the roster. A caller that holds no
 * roster passes nothing, and then only the severities get checked.
 */
export function readConfig(path, names) {
  const value = parse(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path}: the file must hold a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (!KEYS.includes(key)) {
      throw new ConfigError(
        `${path}: "${key}" is no setting. Write ${KEYS.map((k) => `"${k}"`).join(", ")}.`,
      );
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new ConfigError(`${path}: "enabled" must be true or false.`);
  }
  if (value.replies !== undefined && !SWITCHES.includes(value.replies)) {
    throw new ConfigError(`${path}: "replies" reads "${value.replies}". Write "on" or "off".`);
  }
  return {
    rules: checkRules(path, value.rules ?? {}, names),
    enabled: value.enabled,
    replies: value.replies,
    path,
  };
}

/**
 * Reads a switch from the environment, or undefined when it is empty.
 *
 * A word that means neither yes nor no is an error. A session that starts with
 * checks off because of a typo would hide every fault.
 */
function readSwitch(name, words) {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const [on, off] = words;
  if (on.includes(raw) || off.includes(raw)) {
    return on.includes(raw);
  }
  throw new ConfigError(
    `${name} reads "${env[name]}". Write ${on.join(", ")} or ${off.join(", ")}.`,
  );
}

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The settings for a directory, or empty settings when no file exists.
 *
 * A fault in either file throws. A linter that reads broken settings and
 * carries on gives the author a false pass. An absent global file is normal,
 * unless `STE_CONFIG` named it, because an operator who names a file wants it.
 *
 * `enabled` and `replies` follow one order. The environment wins, then the
 * project file, then the global file. Each stays absent when nothing sets it,
 * and the caller then keeps its own default. The `STE_ENABLED` and
 * `STE_REPLIES` variables hold the environment values.
 */
export function loadConfig(from, names) {
  const global = globalPath();
  const paths = [];
  const files = [];

  if (global.named && !exists(global.path)) {
    throw new ConfigError(
      `${global.path}: STE_CONFIG names this file, and it does not open.`,
    );
  }
  if (exists(global.path)) {
    files.push(readConfig(global.path, names));
    paths.push(global.path);
  }

  const project = findConfig(from);
  if (project !== undefined) {
    files.push(readConfig(project, names));
    paths.push(project);
  }

  // The project wins for each rule it names, and it keeps the rest.
  const rules = Object.assign({}, ...files.map((file) => file.rules));
  const latest = (key) => files.map((file) => file[key]).findLast((v) => v !== undefined);
  const replies = env.STE_REPLIES?.trim().toLowerCase();
  if (replies && !SWITCHES.includes(replies)) {
    throw new ConfigError(`STE_REPLIES reads "${env.STE_REPLIES}". Write on or off.`);
  }

  const enabled = readSwitch("STE_ENABLED", [TRUE_WORDS, FALSE_WORDS]) ?? latest("enabled");
  const reply = replies || latest("replies");
  return {
    rules,
    // A key that nothing sets stays absent, so a caller sees the plain default.
    ...(enabled === undefined ? {} : { enabled }),
    ...(reply === undefined ? {} : { replies: reply }),
    paths,
    path: paths[paths.length - 1],
  };
}
