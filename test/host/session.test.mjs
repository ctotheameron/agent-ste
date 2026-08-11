import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_STATE,
  apply,
  describe,
  readState,
  statePath,
  writeState,
} from "../../src/host/session.mjs";

const ON = { enabled: true, strict: true };

test("it starts on, and strict", () => {
  assert.deepEqual(DEFAULT_STATE, { enabled: true, strict: true });
});

test("off stops every check, and clears strict mode", () => {
  assert.deepEqual(apply(ON, "off"), { enabled: false, strict: false });
});

test("on holds the strict flag it finds", () => {
  assert.deepEqual(apply(ON, "on"), { enabled: true, strict: true });
  assert.deepEqual(apply({ enabled: false, strict: false }, "on"), {
    enabled: true,
    strict: false,
  });
});

test("an empty word toggles", () => {
  assert.deepEqual(apply(ON, ""), { enabled: false, strict: false });
  assert.deepEqual(apply({ enabled: false, strict: false }, ""), {
    enabled: true,
    strict: false,
  });
});

test("strict turns enforcement on too", () => {
  assert.deepEqual(apply({ enabled: false, strict: false }, "strict"), ON);
  assert.deepEqual(apply(ON, "strict on"), ON);
  assert.deepEqual(apply(ON, "strict off"), { enabled: true, strict: false });
});

test("status changes nothing", () => {
  const state = { enabled: false, strict: false };
  assert.deepEqual(apply(state, "status"), state);
  assert.deepEqual(apply(ON, " STATUS "), ON);
});

test("it reports one line for each state", () => {
  assert.match(describe(ON), /^STE on, strict on\./);
  assert.match(describe({ enabled: true, strict: false }), /^STE on, strict off\./);
  assert.match(describe({ enabled: false, strict: false }), /^STE off\./);
});

test("it reads the default state for a session it never saw", () => {
  assert.deepEqual(readState("test-absent-session"), DEFAULT_STATE);
});

test("it reads back the state it saved", (t) => {
  const id = "test-round-trip";
  t.after(() => rmSync(statePath(id), { force: true }));
  writeState(id, { enabled: false, strict: false });
  assert.deepEqual(readState(id), { enabled: false, strict: false });
});

test("a damaged state file gives the default", (t) => {
  const id = "test-damaged";
  t.after(() => rmSync(statePath(id), { force: true }));
  writeState(id, ON);
  writeFileSync(statePath(id), "{ not json");
  assert.deepEqual(readState(id), DEFAULT_STATE);
});

test("a session id with a path in it cannot escape the directory", () => {
  assert.equal(
    dirname(statePath("../../etc/passwd")),
    dirname(statePath("plain")),
  );
  assert.match(statePath(undefined), /unknown\.json$/);
});
