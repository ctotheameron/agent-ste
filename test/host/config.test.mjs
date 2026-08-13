import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ConfigError,
  CONFIG_NAME,
  findConfig,
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

test("it reads a settings file", () => {
  const root = sandbox(`{ "rules": { "verb/passive": "off" } }`);
  assert.deepEqual(loadConfig(root, NAMES).rules, { "verb/passive": "off" });
});

test("it reports no settings when no file exists", () => {
  const root = sandbox();
  assert.deepEqual(loadConfig(root, NAMES), { rules: {}, path: undefined });
});

test("it finds the file in a parent directory", () => {
  const root = sandbox(`{ "rules": {} }`);
  const deep = join(root, "one", "two");
  mkdirSync(deep, { recursive: true });
  assert.equal(findConfig(deep), join(root, CONFIG_NAME));
});

test("it rejects a name that is no rule", () => {
  const root = sandbox(`{ "rules": { "no/such": "off" } }`);
  assert.throws(() => loadConfig(root, NAMES), ConfigError);
});

test("it rejects a setting that is no severity", () => {
  const root = sandbox(`{ "rules": { "verb/passive": "maybe" } }`);
  assert.throws(() => loadConfig(root, NAMES), ConfigError);
});

test("it rejects an unknown key", () => {
  const root = sandbox(`{ "rules": {}, "extra": 1 }`);
  assert.throws(() => loadConfig(root, NAMES), ConfigError);
});

test("it rejects text that is no JSON object", () => {
  assert.throws(() => readConfig(sandbox("not json") + `/${CONFIG_NAME}`, NAMES), ConfigError);
  const list = sandbox("[1, 2]");
  assert.throws(() => loadConfig(list, NAMES), ConfigError);
});

test("every name the engine reports passes the check", () => {
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
