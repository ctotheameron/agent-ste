/**
 * Reads the project settings for the linter.
 *
 * A project chooses the severity of each rule in a `.ste.json` file at its
 * root. A rule reads `hard`, `soft` or `off`. Nothing else belongs in the file
 * yet. An unknown key is an error, so a typo cannot pass in silence.
 *
 * The loader owns no rule. It checks each name against the roster the engine
 * reports, so the engine stays the one source of truth.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_NAME = ".ste.json";

const SETTINGS = ["hard", "soft", "off"];

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
    if (!names.includes(name)) {
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
 * engine, so this module never repeats the roster.
 */
export function readConfig(path, names) {
  const value = parse(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path}: the file must hold a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "rules") {
      throw new ConfigError(`${path}: "${key}" is no setting. Write "rules".`);
    }
  }
  return { rules: checkRules(path, value.rules ?? {}, names), path };
}

/**
 * The settings for a directory, or empty settings when no file exists.
 *
 * A fault in the file throws. A linter that reads broken settings and carries
 * on gives the author a false pass.
 */
export function loadConfig(from, names) {
  const path = findConfig(from);
  return path === undefined ? { rules: {}, path: undefined } : readConfig(path, names);
}
