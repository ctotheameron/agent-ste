import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { env } from "node:process";
import {
  ConfigError,
  CONFIG_NAME,
  findConfig,
  globalPath,
  loadConfig,
  readConfig,
} from "../../src/host/config.mjs";
import { lint, newEngine, promptText, ruleNames } from "../../src/host/lint.mjs";

const NAMES = ["style/semicolon", "verb/passive", "dictionary/not-approved-word"];

function sandbox(text) {
  const root = mkdtempSync(join(tmpdir(), "ste-config-"));
  if (text !== undefined) {
    writeFileSync(join(root, CONFIG_NAME), text);
  }
  return root;
}

// A test must not read the config file of the person who runs it. Each test
// points the global lookup at an empty directory, and restores the environment.
function isolate(t, values = {}) {
  const saved = { STE_CONFIG: env.STE_CONFIG, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  });
  delete env.STE_CONFIG;
  env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ste-xdg-"));
  Object.assign(env, values);
}

test("it reads a settings file", (t) => {
  isolate(t);
  const root = sandbox(`{ "rules": { "verb/passive": "off" } }`);
  assert.deepEqual(loadConfig(root, NAMES).rules, { "verb/passive": "off" });
});

test("it reports no settings when no file exists", (t) => {
  isolate(t);
  const root = sandbox();
  assert.deepEqual(loadConfig(root, NAMES), {
    rules: {},
    paths: [],
    path: undefined,
  });
});

// One file in an image gives a whole fleet its default, and no repository needs
// to carry a copy.
test("a global file applies with no project file", (t) => {
  const global = join(sandbox(), "fleet.json");
  writeFileSync(global, `{ "rules": { "verb/passive": "off" } }`);
  isolate(t, { STE_CONFIG: global });
  assert.deepEqual(loadConfig(sandbox(), NAMES).rules, { "verb/passive": "off" });
});

test("a project file wins for each rule it names", (t) => {
  const global = join(sandbox(), "fleet.json");
  writeFileSync(
    global,
    `{ "rules": { "verb/passive": "off", "style/semicolon": "soft" } }`,
  );
  isolate(t, { STE_CONFIG: global });
  const project = sandbox(`{ "rules": { "style/semicolon": "hard" } }`);
  const loaded = loadConfig(project, NAMES);
  assert.deepEqual(loaded.rules, {
    "verb/passive": "off",
    "style/semicolon": "hard",
  });
  assert.equal(loaded.paths.length, 2);
});

test("STE_CONFIG that names a missing file is an error", (t) => {
  isolate(t, { STE_CONFIG: join(sandbox(), "absent.json") });
  assert.throws(() => loadConfig(sandbox(), NAMES), ConfigError);
});

test("the global path follows XDG, and ignores a relative one", (t) => {
  isolate(t, { XDG_CONFIG_HOME: "relative/path" });
  assert.ok(globalPath().path.endsWith(join(".config", "ste", "config.json")));
  assert.equal(globalPath().named, false);

  const absolute = sandbox();
  env.XDG_CONFIG_HOME = absolute;
  assert.equal(globalPath().path, join(absolute, "ste", "config.json"));
});

test("a fault in the global file stops the run", (t) => {
  const global = join(sandbox(), "broken.json");
  writeFileSync(global, `{ "rules": { "no/such": "off" } }`);
  isolate(t, { STE_CONFIG: global });
  assert.throws(() => loadConfig(sandbox(), NAMES), ConfigError);
});

test("it finds the file in a parent directory", (t) => {
  isolate(t);
  const root = sandbox(`{ "rules": {} }`);
  const deep = join(root, "one", "two");
  mkdirSync(deep, { recursive: true });
  assert.equal(findConfig(deep), join(root, CONFIG_NAME));
});

test("it rejects a name that is no rule", (t) => {
  isolate(t);
  const root = sandbox(`{ "rules": { "no/such": "off" } }`);
  assert.throws(() => loadConfig(root, NAMES), ConfigError);
});

test("it rejects a setting that is no severity", (t) => {
  isolate(t);
  const root = sandbox(`{ "rules": { "verb/passive": "maybe" } }`);
  assert.throws(() => loadConfig(root, NAMES), ConfigError);
});

test("it rejects an unknown key", (t) => {
  isolate(t);
  const root = sandbox(`{ "rules": {}, "extra": 1 }`);
  assert.throws(() => loadConfig(root, NAMES), ConfigError);
});

test("it rejects text that is no JSON object", (t) => {
  isolate(t);
  assert.throws(() => readConfig(sandbox("not json") + `/${CONFIG_NAME}`, NAMES), ConfigError);
  const list = sandbox("[1, 2]");
  assert.throws(() => loadConfig(list, NAMES), ConfigError);
});

test("every name the engine reports passes the check", (t) => {
  isolate(t);
  const names = ruleNames();
  const rules = Object.fromEntries(names.map((name) => [name, "soft"]));
  const root = sandbox(JSON.stringify({ rules }));
  assert.deepEqual(loadConfig(root, names).rules, rules);
});

test("a rule set to off reports nothing", () => {
  const text = "We must utilize it; and stop.";
  const plain = newEngine();
  const off = newEngine({ rules: { "style/semicolon": "off" } });
  assert.equal(
    lint(plain, text).filter((v) => v.ruleId === "style/semicolon").length,
    1,
  );
  assert.equal(
    lint(off, text).filter((v) => v.ruleId === "style/semicolon").length,
    0,
  );
});

test("a setting overrides the severity the engine reports", () => {
  const text = "We must utilize it.";
  const soft = newEngine({
    rules: { "dictionary/not-approved-word": "soft" },
  });
  const found = lint(soft, text);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "soft");
});

test("the prompt drops a rule that is off", () => {
  const off = newEngine({ rules: { "verb/passive": "off" } });
  assert.ok(promptText(newEngine()).includes("verb/passive"));
  assert.ok(!promptText(off).includes("verb/passive"));
});
