import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_STATE,
  apply,
  describe,
  identify,
  readState,
  statePath,
  writeState,
} from "../../src/host/session.mjs";

const empty = { pending: [], replied: "" };
const ON = { ...empty, enabled: true, strict: true };
const OFF = { ...empty, enabled: false, strict: false };
const SOFT = { ...empty, enabled: true, strict: false };

// The pi extension starts the same way. Claude Code cannot hide a reply, so
// the gate stays off until a user asks for it.
test("it starts on, with the reply gate off", () => {
  assert.deepEqual(DEFAULT_STATE, {
    enabled: true,
    strict: false,
    pending: [],
    replied: "",
  });
});

test("off stops every check, and clears strict mode", () => {
  assert.deepEqual(apply(ON, "off"), OFF);
});

test("on holds the strict flag it finds", () => {
  assert.deepEqual(apply(ON, "on"), ON);
  assert.deepEqual(apply(OFF, "on"), SOFT);
});

test("an empty word toggles", () => {
  assert.deepEqual(apply(ON, ""), OFF);
  assert.deepEqual(apply(OFF, ""), SOFT);
});

test("strict turns enforcement on too", () => {
  assert.deepEqual(apply(OFF, "strict"), ON);
  assert.deepEqual(apply(ON, "strict on"), ON);
  assert.deepEqual(apply(ON, "strict off"), SOFT);
});

test("status changes nothing", () => {
  assert.deepEqual(apply(OFF, "status"), OFF);
  assert.deepEqual(apply(ON, " STATUS "), ON);
});

// A user runs /ste in the middle of a turn. The report of the reply before it
// must survive that command.
test("a command keeps the pending report", () => {
  const waiting = { ...ON, pending: [{ ruleId: "style/semicolon" }], replied: "abc" };
  assert.deepEqual(apply(waiting, "strict off").pending, waiting.pending);
  assert.equal(apply(waiting, "strict off").replied, "abc");
});

test("it reports one line for each state", () => {
  assert.match(describe(ON), /^STE on, strict on\./);
  assert.match(describe(SOFT), /^STE on, strict off\./);
  assert.match(describe(OFF), /^STE off\./);
});

test("it reads the default state for a session it never saw", () => {
  assert.deepEqual(readState("test-absent-session"), DEFAULT_STATE);
});

test("it reads back the state it saved", (t) => {
  const id = "test-round-trip";
  t.after(() => rmSync(statePath(id), { force: true }));
  writeState(id, OFF);
  assert.deepEqual(readState(id), OFF);
});

// An old state file holds no `strict` key. It must read as off, not on. An
// upgrade must not switch the reply gate on behind a user.
test("an absent strict flag reads as off", (t) => {
  const id = "test-old-file";
  t.after(() => rmSync(statePath(id), { force: true }));
  writeState(id, { enabled: true });
  assert.deepEqual(readState(id), { ...empty, enabled: true, strict: false });
});

test("one reply gives one name, and two replies give two", () => {
  assert.equal(identify("a reply"), identify("a reply"));
  assert.notEqual(identify("a reply"), identify("a different reply"));
  assert.equal(identify("a reply").length, 16);
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
