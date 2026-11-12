import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import steExtension from "../../extension.mjs";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { ToolExecutionComponent } = await import(
  new URL("./modes/interactive/components/tool-execution.js", piEntry)
);
const { initTheme } = await import(
  new URL("./modes/interactive/theme/theme.js", piEntry)
);
const { loadExtensions } = await import(
  new URL("./core/extensions/loader.js", piEntry)
);
initTheme("dark", false);

function host() {
  const tools = new Map();
  const handlers = new Map();
  steExtension({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: () => {},
  });
  return {
    say: tools.get("say"),
    lint: tools.get("ste_lint"),
    gate: handlers.get("tool_call"),
    context: { ui: { setStatus: () => {} } },
  };
}

function viewFor(say, input, result) {
  const view = new ToolExecutionComponent(
    "say",
    "say-render-test",
    input,
    {},
    say,
    { requestRender: () => {} },
    process.cwd(),
  );
  view.markExecutionStarted();
  view.setArgsComplete();
  if (result) view.updateResult(result);
  return view;
}

function outputOf(view, width = 100) {
  return view.render(width)
    .map(stripVTControlCharacters)
    .join("\n");
}

test("Pi loads the say renderers without a local override", async () => {
  const path = fileURLToPath(new URL("../../extension.mjs", import.meta.url));
  const loaded = await loadExtensions([path], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.equal(extension.toolRenderers?.length ?? 0, 0);
  const say = extension.tools.get("say").definition;
  const input = { text: "The check passed." };
  const result = await say.execute("1", input);
  assert.equal(outputOf(viewFor(say, input, result)).split(input.text).length - 1, 1);
});

test("say displays one reply in collapsed and expanded views", async () => {
  const { say } = host();
  const input = { text: "The check passed. No files changed." };
  const result = await say.execute("1", input);
  const view = viewFor(say, input, result);
  for (const expanded of [false, true]) {
    view.setExpanded(expanded);
    assert.equal(outputOf(view).split(input.text).length - 1, 1);
  }
  assert.equal(say.renderShell, "self");
});

test("say formats Markdown at narrow and normal widths", async () => {
  const { say } = host();
  const input = { text: "The **check passed**. No files changed." };
  const result = await say.execute("1", input);
  const view = viewFor(say, input, result);
  for (const width of [40, 100]) {
    const output = outputOf(view, width).replace(/\s+/g, " ");
    assert.equal(output.split("The check passed. No files changed.").length - 1, 1);
    assert.ok(!output.includes("**"));
    assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("say hides the draft before a tool result exists", () => {
  const { say } = host();
  const view = viewFor(say, { text: "Private draft." });
  assert.equal(outputOf(view).trim(), "");
});

test("say hides partial results", () => {
  const { say } = host();
  const view = viewFor(say, { text: "Private draft." });
  view.updateResult({ content: [{ type: "text", text: "Partial result." }] }, true);
  assert.equal(outputOf(view).trim(), "");
});

test("say shows the blocking reason without the full draft", () => {
  const { say, gate, context } = host();
  const input = { text: "Private draft: utilize this tool." };
  const blocked = gate({ toolName: "say", input }, context);
  assert.equal(blocked.block, true);
  const result = {
    content: [{ type: "text", text: blocked.reason }],
    isError: true,
  };
  const output = outputOf(viewFor(say, input, result));
  assert.ok(output.includes("dictionary/not-approved-word"));
  assert.ok(output.includes("Rewrite the text and call the tool again."));
  assert.ok(!output.includes(input.text));
});

test("say keeps plain-text errors", () => {
  const { say } = host();
  const message = "The tool failed: **details**.";
  const result = { content: [{ type: "text", text: message }], isError: true };
  const output = outputOf(viewFor(say, { text: "Private draft." }, result));
  assert.ok(output.includes(message));
  assert.ok(!output.includes("Private draft."));
});

test("say keeps the full reply when the tool view is collapsed", async () => {
  const { say } = host();
  const input = {
    text: Array.from({ length: 20 }, (_, index) => `- Item ${index + 1}.`).join("\n"),
  };
  const result = await say.execute("1", input);
  const view = viewFor(say, input, result);
  view.setExpanded(false);
  assert.ok(outputOf(view).includes("Item 20."));
});

test("say rendering leaves the model-facing result unchanged", async () => {
  const { say, gate, context } = host();
  const input = { text: "The **check passed**." };
  assert.equal(gate({ toolName: "say", input }, context), undefined);
  const result = await say.execute("1", input);
  const expected = { content: [{ type: "text", text: input.text }] };
  outputOf(viewFor(say, input, result));
  assert.deepEqual(result, expected);
});

test("say rendering does not change the lint tool display", () => {
  const { lint } = host();
  assert.equal(lint.renderCall, undefined);
  assert.equal(lint.renderResult, undefined);
});
