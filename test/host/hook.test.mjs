import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execPath } from "node:process";
import { failOpen, respond } from "../../src/host/hook.mjs";
import { statePath, writeState } from "../../src/host/session.mjs";

const HOOK = new URL("../../bin/ste-hook.mjs", import.meta.url).pathname;

const ON = { enabled: true, strict: true };
const LOOSE = { enabled: true, strict: false };
const OFF = { enabled: false, strict: false };

/** One event as Claude Code sends it, as a JSON string. */
function event(fields) {
  return JSON.stringify({
    session_id: "test-session",
    cwd: "/tmp",
    transcript_path: "/tmp/transcript.jsonl",
    ...fields,
  });
}

function write(file_path, content) {
  return event({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path, content },
  });
}

function decisionOf(result) {
  return result.hookSpecificOutput?.permissionDecision;
}

/** Runs the real binary, so the stdin path and the exit code count too. */
function runHook(input) {
  const stdout = execFileSync(execPath, [HOOK], { input, encoding: "utf8" });
  return JSON.parse(stdout);
}

test("SessionStart returns the rule list as context", async () => {
  const result = await respond(event({ hook_event_name: "SessionStart" }), ON);
  const output = result.hookSpecificOutput;
  assert.equal(output.hookEventName, "SessionStart");
  assert.match(output.additionalContext, /Simplified Technical English/);
  assert.match(output.additionalContext, /dictionary\/not-approved-word/);
});

test("Claude Code context excludes Pi tool-routing instructions", async () => {
  for (const mode of [ON, LOOSE]) {
    const result = await respond(event({ hook_event_name: "SessionStart" }), mode);
    assert.doesNotMatch(
      result.hookSpecificOutput.additionalContext,
      /codemode|`say`|`ste_lint`/,
    );
  }
});

test("PreToolUse denies a write that breaks a hard rule", async () => {
  const result = await respond(write("notes.md", "We will initiate it."), ON);
  assert.equal(decisionOf(result), "deny");
  const reason = result.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /Use "start", not "initiate"/);
  assert.match(reason, /notes\.md/);
});

test("PreToolUse allows a clean write, and adds no context", async () => {
  const result = await respond(write("notes.md", "Start the release now."), ON);
  assert.equal(decisionOf(result), "allow");
  assert.equal(result.hookSpecificOutput.additionalContext, undefined);
});

test("PreToolUse allows a soft violation, and warns", async () => {
  const result = await respond(write("notes.md", "The bolt was removed."), ON);
  assert.equal(decisionOf(result), "allow");
  assert.match(result.hookSpecificOutput.additionalContext, /verb\/passive/);
});

test("PreToolUse reads a code comment, and not an identifier", async () => {
  const clean = await respond(write("a.ts", "const utilize = (x) => x;"), ON);
  assert.equal(decisionOf(clean), "allow");

  const bad = await respond(write("a.ts", "// We will utilize it."), ON);
  assert.equal(decisionOf(bad), "deny");
});

test("PreToolUse allows a file with no prose", async () => {
  const result = await respond(write("a.bin", "initiate initiate"), ON);
  assert.equal(decisionOf(result), "allow");
  assert.equal(result.hookSpecificOutput.additionalContext, undefined);
});

test("PreToolUse reads the new text of an edit only", async () => {
  const bad = await respond(
    event({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "notes.md",
        old_string: "We will initiate it.",
        new_string: "We will utilize it.",
      },
    }),
    ON,
  );
  assert.equal(decisionOf(bad), "deny");
  const reason = bad.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /Use "use", not "utilize"/);
  assert.doesNotMatch(reason, /initiate/, "the old text belongs to the file");
});

test("PreToolUse denies a bad git commit message", async () => {
  const result = await respond(
    event({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `git commit -m "feat: initiate the rollout"` },
    }),
    ON,
  );
  assert.equal(decisionOf(result), "deny");
  assert.match(
    result.hookSpecificOutput.permissionDecisionReason,
    /the commit message/,
  );
});

test("PreToolUse allows a bash command that commits nothing", async () => {
  const result = await respond(
    event({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "echo initiate the rollout" },
    }),
    ON,
  );
  assert.equal(decisionOf(result), "allow");
});

test("PreToolUse allows a tool it does not know", async () => {
  const result = await respond(
    event({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "notes.md" },
    }),
    ON,
  );
  assert.equal(decisionOf(result), "allow");
});

test("Stop blocks a reply that breaks a hard rule", async () => {
  const result = await respond(
    event({
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "We will initiate the rollout.",
    }),
    ON,
  );
  assert.equal(result.decision, "block");
  assert.match(result.reason, /Use "start", not "initiate"/);
  assert.match(result.reason, /Write the reply again/);
});

test("Stop passes a clean reply", async () => {
  const result = await respond(
    event({
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "Start the release. Test it now.",
    }),
    ON,
  );
  assert.deepEqual(result, {});
});

test("Stop blocks one time only, so it cannot loop", async () => {
  const result = await respond(
    event({
      hook_event_name: "Stop",
      stop_hook_active: true,
      last_assistant_message: "We will initiate the rollout.",
    }),
    ON,
  );
  assert.deepEqual(result, {});
});

// The pi extension counts the faults of a reply and sends them back as a note.
// Claude Code has no note channel, so the hook keeps them until the next prompt.
test("Stop records a reply, and the next prompt carries the faults", async (t) => {
  const session = "test-feedback-loop";
  t.after(() => rmSync(statePath(session), { force: true }));
  const reply = { hook_event_name: "Stop", last_assistant_message: "We will initiate it." };

  // No state argument, so the hook reads the file and finds the default.
  assert.deepEqual(await respond(event({ ...reply, session_id: session })), {});

  const delivered = await respond(
    event({ hook_event_name: "UserPromptSubmit", session_id: session }),
  );
  const text = delivered.hookSpecificOutput.additionalContext;
  assert.match(text, /broke Simplified Technical English 1 time/);
  assert.match(text, /Use "start", not "initiate"/);

  // One reply gives one report. A second prompt adds nothing.
  assert.deepEqual(
    await respond(event({ hook_event_name: "UserPromptSubmit", session_id: session })),
    {},
  );
});

test("the same Stop twice reports one time", async (t) => {
  const session = "test-feedback-repeat";
  t.after(() => rmSync(statePath(session), { force: true }));
  const reply = event({
    hook_event_name: "Stop",
    session_id: session,
    last_assistant_message: "We will initiate it.",
  });

  await respond(reply);
  await respond(reply);
  const delivered = await respond(
    event({ hook_event_name: "UserPromptSubmit", session_id: session }),
  );
  assert.match(
    delivered.hookSpecificOutput.additionalContext,
    /1 time\(s\)/,
  );
});

test("a clean reply leaves nothing for the next prompt", async (t) => {
  const session = "test-feedback-clean";
  t.after(() => rmSync(statePath(session), { force: true }));
  await respond(
    event({
      hook_event_name: "Stop",
      session_id: session,
      last_assistant_message: "Start the release. Test it now.",
    }),
  );
  assert.deepEqual(
    await respond(event({ hook_event_name: "UserPromptSubmit", session_id: session })),
    {},
  );
});

test("a disabled session reports no reply fault", async () => {
  const delivered = await respond(
    event({ hook_event_name: "UserPromptSubmit" }),
    { ...OFF, pending: [{ ruleId: "style/semicolon", message: "x", line: 1, column: 1 }] },
  );
  assert.deepEqual(delivered, {});
});

test("Stop passes an empty reply and a reply it cannot read", async () => {
  const blank = { hook_event_name: "Stop", stop_hook_active: false };
  assert.deepEqual(await respond(event(blank), ON), {});
  assert.deepEqual(
    await respond(event({ ...blank, last_assistant_message: "  " }), ON),
    {},
  );
});

test("Stop passes every reply when strict mode is off", async () => {
  const result = await respond(
    event({
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "We will initiate the rollout.",
    }),
    LOOSE,
  );
  assert.deepEqual(result, {});
});

test("an event kind with no rule asks for no action", async () => {
  const result = await respond(event({ hook_event_name: "UserPromptSubmit" }), ON);
  assert.deepEqual(result, {});
});

test("an off session checks nothing", async () => {
  assert.equal(decisionOf(await respond(write("a.md", "Initiate it."), OFF)), "allow");
  assert.deepEqual(await respond(event({ hook_event_name: "SessionStart" }), OFF), {});
  assert.deepEqual(
    await respond(
      event({
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "We will initiate it.",
      }),
      OFF,
    ),
    {},
  );
});

test("it fails open on empty input", async () => {
  for (const raw of ["", "   \n", undefined]) {
    const result = await respond(raw, ON);
    assert.equal(result.continue, true);
    assert.match(result.systemMessage, /empty/);
  }
});

test("it fails open on malformed JSON", async () => {
  const result = await respond("{ not json", ON);
  assert.equal(result.continue, true);
  assert.match(result.systemMessage, /not valid JSON/);
  assert.match(result.systemMessage, /The event goes through/);
});

test("it fails open on JSON that is not an event object", async () => {
  for (const raw of ["[]", "42", '"Stop"', "null"]) {
    const result = await respond(raw, ON);
    assert.equal(result.continue, true);
    assert.match(result.systemMessage, /not a JSON object/);
  }
});

test("it fails open when the event names no kind", async () => {
  const result = await respond('{"session_id":"x"}', ON);
  assert.equal(result.continue, true);
  assert.match(result.systemMessage, /hook_event_name/);
});

test("failOpen never blocks", () => {
  assert.deepEqual(failOpen("the disk broke"), {
    continue: true,
    systemMessage: "ste hook: the disk broke. The event goes through.",
  });
});

test("the binary answers a real event on stdin", () => {
  const result = runHook(write("notes.md", "We will initiate it."));
  assert.equal(decisionOf(result), "deny");
});

test("the binary fails open on empty stdin", () => {
  const result = runHook("");
  assert.equal(result.continue, true);
  assert.match(result.systemMessage, /empty/);
});

// --- gh text, the reply switch and the start state ---

import { env } from "node:process";

function bash(command, cwd = "/tmp") {
  return event({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    cwd,
  });
}

// Each test sets its own environment, and restores it. A config file on the
// machine of the person who runs the tests must not change the result.
function isolate(t, values = {}) {
  const keys = ["STE_CONFIG", "STE_ENABLED", "STE_REPLIES", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(keys.map((key) => [key, env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete env[key];
      } else {
        env[key] = saved[key];
      }
    }
  });
  for (const key of keys) {
    delete env[key];
  }
  env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ste-xdg-"));
  Object.assign(env, values);
}

test("PreToolUse denies a bad pull request body, and names it", async (t) => {
  isolate(t);
  const result = await respond(
    bash(`gh pr create --title "feat: add it" --body "We utilize the cache."`),
    ON,
  );
  assert.equal(decisionOf(result), "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /the PR body/);
});

test("PreToolUse denies a bad title, and a bad body in a heredoc", async (t) => {
  isolate(t);
  const title = await respond(bash(`gh pr create --title "feat: initiate the rollout" -b "ok then"`), ON);
  assert.match(title.hookSpecificOutput.permissionDecisionReason, /the PR title/);
  const body = await respond(
    bash(`gh issue create -t "a fine title" -F - <<'EOF'\nWe will initiate it.\nEOF`),
    ON,
  );
  assert.equal(decisionOf(body), "deny");
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /the issue body/);
});

test("PreToolUse reads a body file", async (t) => {
  isolate(t);
  const root = mkdtempSync(join(tmpdir(), "ste-body-"));
  writeFileSync(join(root, "body.md"), "We will initiate it.\n");
  const result = await respond(bash("gh pr comment 3 --body-file body.md", root), ON);
  assert.equal(decisionOf(result), "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /the PR comment \(body\.md\)/);
});

test("PreToolUse reports every faulty field in one block", async (t) => {
  isolate(t);
  const result = await respond(
    bash(`gh pr create --title "feat: initiate it" --body "We will initiate it."`),
    ON,
  );
  const reason = result.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /the PR title/);
  assert.match(reason, /the PR body/);
});

test("PreToolUse allows a clean pull request and a flag that is no prose", async (t) => {
  isolate(t);
  const clean = await respond(
    bash(`gh pr create --title "feat: add the cache" --body "It stores each result."`),
    ON,
  );
  assert.equal(decisionOf(clean), "allow");
  assert.equal(clean.hookSpecificOutput.additionalContext, undefined);
  assert.equal(decisionOf(await respond(bash("gh pr list -b main"), ON)), "allow");
});

test("PreToolUse warns about a soft fault in a pull request body", async (t) => {
  isolate(t);
  const result = await respond(
    bash(`gh pr create --title "feat: add the cache" --body "The cache was added by me."`),
    ON,
  );
  assert.equal(decisionOf(result), "allow");
  assert.match(result.hookSpecificOutput.additionalContext, /the PR body/);
});

test("replies=off in the environment leaves the Stop hook silent", async (t) => {
  isolate(t, { STE_REPLIES: "off" });
  const stop = event({
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "We will initiate it.",
  });
  assert.deepEqual(await respond(stop, ON), {});
  assert.deepEqual(await respond(stop, LOOSE), {});
  const faults = [{ ruleId: "style/semicolon", message: "x", line: 1, column: 1 }];
  assert.deepEqual(
    await respond(event({ hook_event_name: "UserPromptSubmit" }), { ...LOOSE, pending: faults }),
    {},
  );
});

test("replies=off keeps the write, commit and gh checks on", async (t) => {
  isolate(t, { STE_REPLIES: "off" });
  assert.equal(decisionOf(await respond(write("a.md", "We will initiate it."), ON)), "deny");
  assert.equal(
    decisionOf(await respond(bash(`git commit -m "feat: initiate the rollout"`), ON)),
    "deny",
  );
  assert.equal(
    decisionOf(await respond(bash(`gh pr create --body "We will initiate it."`), ON)),
    "deny",
  );
});

test("replies=on is the default, and a global file can turn replies off", async (t) => {
  isolate(t);
  const stop = event({
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "We will initiate it.",
  });
  assert.equal((await respond(stop, ON)).decision, "block");

  const dir = mkdtempSync(join(tmpdir(), "ste-global-"));
  writeFileSync(join(dir, "c.json"), `{ "replies": "off" }`);
  env.STE_CONFIG = join(dir, "c.json");
  assert.deepEqual(await respond(stop, ON), {});
  env.STE_REPLIES = "on";
  assert.equal((await respond(stop, ON)).decision, "block");
});

test("STE_ENABLED=0 starts a session with every check off", async (t) => {
  isolate(t, { STE_ENABLED: "0" });
  const id = "test-start-off";
  t.after(() => rmSync(statePath(id), { force: true }));
  const input = (fields) => event({ session_id: id, ...fields });

  assert.deepEqual(await respond(input({ hook_event_name: "SessionStart" })), {});
  const denied = await respond(
    input({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.md", content: "We will initiate it." } }),
  );
  assert.equal(decisionOf(denied), "allow");
  const gh = await respond(
    input({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `gh pr create --body "We will initiate it."` },
    }),
  );
  assert.equal(decisionOf(gh), "allow");
});

test("a global config with enabled=false starts off, and the opposite setting turns it on", async (t) => {
  isolate(t);
  const dir = mkdtempSync(join(tmpdir(), "ste-global-"));
  writeFileSync(join(dir, "c.json"), `{ "enabled": false }`);
  env.STE_CONFIG = join(dir, "c.json");
  const id = "test-config-off";
  t.after(() => rmSync(statePath(id), { force: true }));
  const bad = (fields) => event({ session_id: id, ...fields });
  const draft = { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.md", content: "We will initiate it." } };

  assert.equal(decisionOf(await respond(bad(draft))), "allow");
  env.STE_ENABLED = "1";
  assert.equal(decisionOf(await respond(bad(draft))), "deny");
  delete env.STE_ENABLED;
  writeFileSync(join(dir, "c.json"), `{ "enabled": true }`);
  assert.equal(decisionOf(await respond(bad(draft))), "deny");
});

test("a session file from /ste wins over the start setting", async (t) => {
  isolate(t, { STE_ENABLED: "off" });
  const id = "test-ste-on";
  t.after(() => rmSync(statePath(id), { force: true }));
  writeState(id, { ...LOOSE, pending: [], replied: "" });
  const result = await respond(
    event({
      session_id: id,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "a.md", content: "We will initiate it." },
    }),
  );
  assert.equal(decisionOf(result), "deny");
});

test("a bad switch value never blocks the hook, and it never turns checks off", async (t) => {
  isolate(t, { STE_ENABLED: "maybe" });
  const result = await respond(write("a.md", "We will initiate it."), undefined);
  assert.equal(decisionOf(result), "deny");
});

// A saved fault must not freeze the start setting. Otherwise a session that
// began on, because of the environment, stays on after the environment changes.
test("recording a reply fault leaves the start setting unfrozen", async (t) => {
  isolate(t, { STE_ENABLED: "1" });
  const id = "test-no-freeze";
  t.after(() => rmSync(statePath(id), { force: true }));
  await respond(
    event({
      session_id: id,
      hook_event_name: "Stop",
      last_assistant_message: "We will initiate it.",
    }),
  );
  assert.equal(JSON.parse(readFileSync(statePath(id), "utf8")).enabled, undefined);
  env.STE_ENABLED = "0";
  assert.deepEqual(
    await respond(event({ session_id: id, hook_event_name: "UserPromptSubmit" })),
    {},
  );
});
