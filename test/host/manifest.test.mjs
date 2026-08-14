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
