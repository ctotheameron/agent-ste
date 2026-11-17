import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import steExtension from "../../extension.mjs";

async function withSession(mode, run) {
  const directory = await mkdtemp(join(tmpdir(), "agent-ste-exposure-"));
  let session;
  try {
    const settingsManager = SettingsManager.inMemory({
      defaultTools: ["codemode", "say", "ste_lint"],
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [steExtension, createCodemodeExtension({ mode })],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
    }));
    await run(session);
  } finally {
    session?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

async function callCodemode(session, id, code) {
  const input = { code };
  session.agent.state.messages.push({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "codemode", arguments: input }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode");
  const result = await codemode.execute(id, input);
  return { ...result, text: result.content.map((part) => part.text ?? "").join("\n") };
}

for (const mode of ["on", "only"]) {
  test(`say stays direct and outside codemode in ${mode} mode`, async () => {
    await withSession(mode, async (session) => {
      assert.ok(session.getActiveToolNames().includes("say"));
      assert.ok(!session.getCallableToolNames().includes("say"));
      const say = session.agent.state.tools.find((tool) => tool.name === "say");
      const input = { text: "The check passed.", final: true };
      const result = await say.execute("say-direct", input);
      assert.deepEqual(result.content, [{ type: "text", text: input.text }]);
      assert.equal(result.terminate, true);

      const catalog = await callCodemode(
        session,
        "say-catalog",
        'text(ALL_TOOLS.some((tool) => tool.name === "say"));',
      );
      assert.notEqual(catalog.isError, true, catalog.text);
      assert.match(catalog.text, /\bfalse\b/);
      const nested = await callCodemode(
        session,
        "say-nested",
        'await tools.say({ text: "The check passed.", final: true });',
      );
      assert.equal(nested.isError, true);
      assert.match(nested.text, /tools\.say does not exist/);
    });
  });

  test(`ste_lint stays callable directly and through codemode in ${mode} mode`, async () => {
    await withSession(mode, async (session) => {
      assert.ok(session.getActiveToolNames().includes("ste_lint"));
      assert.ok(session.getCallableToolNames().includes("ste_lint"));
      const lint = session.agent.state.tools.find((tool) => tool.name === "ste_lint");
      const result = await lint.execute("lint-direct", { text: "The check passed." });
      assert.equal(result.content[0].text, "No violation.");

      const nested = await callCodemode(
        session,
        "lint-nested",
        'text(await tools.ste_lint({ text: "The check passed." }));',
      );
      assert.notEqual(nested.isError, true, nested.text);
      assert.match(nested.text, /No violation\./);
    });
  });
}
