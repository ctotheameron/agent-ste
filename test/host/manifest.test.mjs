// Checks the parts of package.json that only a publish would test.
//
// npm rewrites a manifest as it publishes, and it reports the change as a
// warning. A warning in a release log is easy to miss, so these run in CI.

import assert from "node:assert/strict";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../../", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("no bin path opens with ./", () => {
  // npm deletes such an entry and says "script name ... was invalid and
  // removed". A global install then holds no command at all.
  for (const [name, path] of Object.entries(manifest.bin ?? {})) {
    assert.ok(
      !path.startsWith("./"),
      `bin.${name} reads "${path}". Write it without the leading ./`,
    );
  }
});

test("every bin path names a file that runs", () => {
  for (const [name, path] of Object.entries(manifest.bin ?? {})) {
    const full = join(root, path);
    assert.ok(statSync(full).isFile(), `bin.${name} names no file`);
    accessSync(full, constants.X_OK);
  }
});

test("every path in files exists", () => {
  for (const entry of manifest.files ?? []) {
    // `dist` is a build artifact. The build runs before a publish, and a test
    // run may hold no build.
    if (entry === "dist") {
      continue;
    }
    statSync(join(root, entry));
  }
});

test("the pi entry point exists", () => {
  for (const entry of manifest.pi?.extensions ?? []) {
    statSync(join(root, entry));
  }
});

const hooks = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8"));

// A matcher such as `Write|Edit` fires for the first name only, and it drops
// the rest in silence. So each tool takes its own entry, and this test stops a
// future edit from folding them back together.
test("no hook matcher holds an alternation", () => {
  for (const [name, entries] of Object.entries(hooks.hooks)) {
    for (const entry of entries) {
      assert.ok(
        !(entry.matcher ?? "").includes("|"),
        `${name} holds the matcher "${entry.matcher}". Write one entry per tool.`,
      );
    }
  }
});

test("every gated tool holds an entry", () => {
  const gated = hooks.hooks.PreToolUse.map((entry) => entry.matcher).sort();
  assert.deepEqual(gated, ["Bash", "Edit", "Write"]);
});

test("every hook runs the same command", () => {
  const commands = Object.values(hooks.hooks)
    .flat()
    .flatMap((entry) => entry.hooks.map((one) => one.command));
  assert.equal(new Set(commands).size, 1, "one entry point serves every event");
  assert.match(commands[0], /ste-hook\.mjs/);
});
