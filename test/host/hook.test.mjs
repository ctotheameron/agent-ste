import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { execPath } from "node:process";
import { failOpen, respond } from "../../src/host/hook.mjs";
import { statePath } from "../../src/host/session.mjs";

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
