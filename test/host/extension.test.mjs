import assert from "node:assert/strict";
import { test } from "node:test";
import steExtension from "../../extension.mjs";

/** A minimal stand-in for ExtensionAPI, enough to drive the hooks. */
function mockPi() {
  const handlers = new Map();
  const sent = [];
  const tools = [];
  const commands = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: (message, options) => sent.push({ message, options }),
    registerTool: (definition) => tools.push(definition),
    registerCommand: (name, options) => commands.push({ name, options }),
  };
  const status = {};
  const ctx = {
    ui: {
      setStatus: (key, value) => {
        status[key] = value;
      },
      notify: () => {},
    },
  };
  const emit = (event, payload) => handlers.get(event)?.(payload, ctx);
  return { pi, ctx, emit, sent, tools, commands, status, handlers };
}

function assistantMessage(text) {
  return { message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** An assistant message that also calls a tool, so the run stays alive. */
function assistantCall(text) {
  return {
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "toolCall", id: "1", name: "bash", arguments: {} },
      ],
    },
  };
}

test("registers the toggle and the self-check tool", () => {
  const host = mockPi();
  steExtension(host.pi);
  assert.deepEqual(
    host.commands.map((c) => c.name),
    ["ste"],
  );
  assert.deepEqual(
    host.tools.map((t) => t.name),
    ["ste_lint", "say"],
  );
});

test("layer 1 appends the rules to the system prompt", () => {
  const host = mockPi();
  steExtension(host.pi);
  const result = host.handlers.get("before_agent_start")({
    systemPrompt: "BASE",
  });
  assert.ok(result.systemPrompt.startsWith("BASE"));
  assert.ok(result.systemPrompt.includes("Simplified Technical English"));
  assert.ok(result.systemPrompt.includes("dictionary/not-approved-word"));
});

test("layer 2 blocks a write that breaks a hard rule", () => {
  const host = mockPi();
  steExtension(host.pi);
  const result = host.handlers.get("tool_call")(
    {
      toolName: "write",
      input: { path: "notes.md", content: "We will initiate the rollout." },
    },
    host.ctx,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /Use "start", not "initiate"/);
});

test("layer 2 allows a clean write", () => {
  const host = mockPi();
  steExtension(host.pi);
  const result = host.handlers.get("tool_call")(
    {
      toolName: "write",
      input: { path: "notes.md", content: "Start the release. Test it now." },
    },
    host.ctx,
  );
  assert.equal(result, undefined);
});

test("layer 2 warns on a hyphen part, and lets the write through", () => {
  const host = mockPi();
  steExtension(host.pi);
  const result = host.handlers.get("tool_call")(
    {
      toolName: "write",
      input: { path: "notes.md", content: "The job will auto-initiate." },
    },
    host.ctx,
  );
  assert.equal(result, undefined, "a hyphen part is Soft, so it cannot block");
  assert.match(host.status.ste, /0 hard \/ 1 soft/);
});

test("layer 2 ignores an identifier in code", () => {
  const host = mockPi();
  steExtension(host.pi);
  const result = host.handlers.get("tool_call")(
    {
      toolName: "write",
      input: { path: "a.ts", content: "const utilize = (x: string) => x;" },
    },
    host.ctx,
  );
  assert.equal(result, undefined);
});

test("layer 2 checks a git commit message in bash", () => {
  const host = mockPi();
  steExtension(host.pi);
  const result = host.handlers.get("tool_call")(
    {
      toolName: "bash",
      input: { command: `git commit -m "feat: initiate the rollout"` },
    },
    host.ctx,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /commit message/);
});

test("layer 3 feeds a violation back into context", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("We will initiate the rollout."));
  host.emit("agent_settled", {});

  assert.equal(host.sent.length, 1);
  const { message, options } = host.sent[0];
  assert.equal(message.customType, "ste-violation");
  assert.equal(options.deliverAs, "nextTurn", "must not trigger a turn");
  assert.match(message.content, /Use "start", not "initiate"/);
  assert.equal(message.details.violations.length, 1);
});

test("layer 3 sends nothing for a clean reply", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("Start the release. Test it now."));
  host.emit("agent_settled", {});
  assert.equal(host.sent.length, 0);
});

test("layer 3 coalesces many messages into one note", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("We will initiate this."));
  host.emit("message_end", assistantMessage("Then we utilize that."));
  host.emit("message_end", assistantMessage("Also modify the file."));
  host.emit("agent_settled", {});

  assert.equal(host.sent.length, 1, "one note per settled run");
  assert.equal(host.sent[0].message.details.violations.length, 3);
});

test("layer 3 cannot loop, because it clears its buffer", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("We will initiate this."));
  host.emit("agent_settled", {});
  host.emit("agent_settled", {});
  host.emit("agent_settled", {});
  assert.equal(host.sent.length, 1);
});

// A severity decides whether a write blocks. A note blocks nothing, so it
// carries every fault. A rule set to `off` reports nothing, and that is the way
// to quiet one. So a fleet that sets every rule to `soft` still reads its faults.
test("layer 3 reports a soft violation too", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("The bolt was removed."));
  host.emit("agent_settled", {});
  assert.equal(host.sent.length, 1);
  assert.match(host.sent[0].message.content, /verb\/passive/);
});

test("a rule set to off reports nothing", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("Start it now."));
  host.emit("agent_settled", {});
  assert.equal(host.sent.length, 0, "clean prose must not nag");
});

test("layer 3 ignores a user message", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", {
    message: { role: "user", content: [{ type: "text", text: "initiate it" }] },
  });
  host.emit("agent_settled", {});
  assert.equal(host.sent.length, 0);
});

test("the status widget reports the count", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("We will initiate the rollout."));
  assert.match(host.status.ste, /1 hard/);
});

test("layer 3 steers a note when the run continues", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantCall("We will initiate the rollout."));

  assert.equal(host.sent.length, 1, "the note lands inside the same run");
  assert.equal(host.sent[0].options.deliverAs, "steer");
  assert.match(host.sent[0].message.content, /Use "start", not "initiate"/);
});

test("layer 3 holds the last prose reply for the next prompt", () => {
  const host = mockPi();
  steExtension(host.pi);
  host.emit("message_end", assistantMessage("We will initiate the rollout."));
  assert.equal(host.sent.length, 0, "nothing follows it in this run");
  host.emit("agent_settled", {});
  assert.equal(host.sent[0].options.deliverAs, "nextTurn");
});

test("layer 3 caps the notes for one run", () => {
  const host = mockPi();
  steExtension(host.pi);
  for (let index = 0; index < 6; index += 1) {
    host.emit("message_end", assistantCall("We will initiate this."));
  }
  assert.equal(host.sent.length, 3, "NOTE_CAP bounds one run");

  host.emit("agent_settled", {});
  host.emit("message_end", assistantCall("We will initiate this."));
  assert.equal(host.sent.length, 5, "the cap resets, and the tail flushes");
});

test("strict mode blocks a reply through the say tool", () => {
  const host = mockPi();
  steExtension(host.pi);
  const result = host.handlers.get("tool_call")(
    { toolName: "say", input: { text: "We will initiate the rollout." } },
    host.ctx,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /in the reply/);
});

test("strict mode passes a clean reply, and the text is unchanged", async () => {
  const host = mockPi();
  steExtension(host.pi);
  const clean = { toolName: "say", input: { text: "Start the release now." } };
  assert.equal(host.handlers.get("tool_call")(clean, host.ctx), undefined);

  const say = host.tools.find((t) => t.name === "say");
  const output = await say.execute("1", clean.input);
  assert.equal(output.content[0].text, "Start the release now.");
});

test("the strict note reaches the model only after /ste strict", async () => {
  const host = mockPi();
  steExtension(host.pi);
  const prompt = () => host.handlers.get("before_agent_start")({ systemPrompt: "BASE" });
  assert.ok(!prompt().systemPrompt.includes("strict mode"));

  const command = host.commands.find((c) => c.name === "ste").options;
  await command.handler("strict", host.ctx);
  assert.ok(prompt().systemPrompt.includes("`say` tool"));

  await command.handler("strict off", host.ctx);
  assert.ok(!prompt().systemPrompt.includes("strict mode"));

  await command.handler("off", host.ctx);
  assert.equal(prompt(), undefined, "off disables every layer");
});
