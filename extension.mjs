// Every rule call goes through src/host/lint.mjs. The hook in bin/ste-hook.mjs
// calls the same module, so the two hosts cannot drift apart.
import {
  check,
  commitSubject,
  editSubject,
  fileSubject,
  format,
  lint,
  newEngine,
  promptText,
  replySubject,
  summarise,
} from "./src/host/lint.mjs";

// Strict mode text for layer 1. The `say` tool is a tool call. A tool call is
// the one thing this API can block, and prose in a plain reply is not.
const STRICT_NOTE = [
  "## Simplified Technical English: strict mode",
  "",
  "Send every user-facing reply through the `say` tool.",
  "Write no prose outside that tool.",
  "A hard violation blocks the call before the user reads the text.",
  "Read the reason, rewrite the text, then call the tool again.",
].join("\n");

// A cap on same-run notes. Each note needs a new violation, and the cap stops a
// long run from filling the context with notes.
const NOTE_CAP = 3;

export default function steExtension(pi) {
  const compiled = newEngine();
  let enabled = true;
  let strict = false;

  function report(ctx, violations) {
    const { hard, soft } = summarise(violations);
    ctx.ui.setStatus(
      "ste",
      hard + soft === 0 ? "STE ✓" : `STE ${hard} hard / ${soft} soft`,
    );
  }

  pi.registerCommand("ste", {
    description: "Toggle STE enforcement. Use \"strict\" to gate every reply.",
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase();
      if (word === "strict" || word === "strict on") {
        enabled = true;
        strict = true;
        ctx.ui.notify("STE strict: send every reply through the say tool", "info");
        return;
      }
      if (word === "strict off") {
        strict = false;
        ctx.ui.notify("STE strict off", "info");
        return;
      }
      enabled = word === "" ? !enabled : word !== "off";
      if (!enabled) {
        strict = false;
        ctx.ui.setStatus("ste", undefined);
      }
      ctx.ui.notify(`STE ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerTool({
    name: "ste_lint",
    label: "STE lint",
    description:
      "Check text against Simplified Technical English. Use this before you " +
      "write prose, a comment, or a commit message.",
    // A TypeBox schema is a plain JSON Schema object at runtime. Writing it out
    // drops the `typebox` import, which pi supplies but a local test runner does
    // not.
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to check" },
      },
      required: ["text"],
    },
    async execute(_id, params) {
      const violations = lint(compiled, params.text);
      const { hard, soft } = summarise(violations);
      return {
        content: [
          {
            type: "text",
            text:
              violations.length === 0
                ? "No violation."
                : `${hard} hard, ${soft} soft:\n${format(violations)}`,
          },
        ],
        details: { violations },
      };
    },
  });

  // The gate for strict mode. The text goes back to the user unchanged, so a
  // clean call reads as a normal reply.
  pi.registerTool({
    name: "say",
    label: "Say",
    description:
      "Send prose to the user. In STE strict mode, use this for every reply. " +
      "A hard Simplified Technical English violation blocks the call.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "The reply text" } },
      required: ["text"],
    },
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.text ?? "" }] };
    },
  });

  // Layer 1: the rules reach the model, built from the same table the linter uses.
  pi.on("before_agent_start", (event) => {
    if (!enabled) {
      return undefined;
    }
    const parts = [event.systemPrompt, promptText()];
    if (strict) {
      parts.push(STRICT_NOTE);
    }
    return { systemPrompt: parts.join("\n\n") };
  });

  // Layer 2: a hard violation blocks the write, and the reason tells the model
  // exactly what to change.
  pi.on("tool_call", (event, ctx) => {
    if (!enabled) {
      return undefined;
    }

    const target = subjectOf(event);
    if (!target) {
      return undefined;
    }

    const result = check(compiled, target);
    report(ctx, result.violations);
    return result.reason === undefined
      ? undefined
      : { block: true, reason: result.reason };
  });

  // Layer 3: check my own replies.
  //
  // It does not rewrite the text, because a mechanical rewrite of prose can
  // change the meaning. It does not block either, because message_end cannot
  // force a retry. Instead it feeds the violations back into context, so the
  // next turn sees exactly what was wrong.
  let pending = [];
  let notes = 0;

  // A custom message is not an assistant message, so a note is never linted and
  // cannot answer itself. Each note needs a new violation, and NOTE_CAP bounds
  // the count for one run.
  function flush(mode) {
    if (pending.length === 0) {
      return;
    }
    if (mode === "steer" && notes >= NOTE_CAP) {
      return;
    }
    const violations = pending;
    pending = [];
    if (mode === "steer") {
      notes += 1;
    }
    pi.sendMessage(
      {
        customType: "ste-violation",
        content:
          `Your previous reply broke Simplified Technical English ` +
          `${violations.length} time(s):\n${format(violations)}\n` +
          "Correct this in your next reply. Do not apologise for it.",
        display: true,
        details: { violations },
      },
      { deliverAs: mode },
    );
  }

  pi.on("message_end", (event, ctx) => {
    if (!enabled || event.message.role !== "assistant") {
      return undefined;
    }
    const parts = event.message.content ?? [];
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.trim() !== "") {
      const violations = lint(compiled, text);
      report(ctx, violations);
      pending.push(...violations.filter((v) => v.severity === "hard"));
    }

    // A message that calls a tool keeps the run alive. "steer" then lands before
    // the next model call, so the same run corrects itself.
    if (parts.some((part) => part.type === "toolCall")) {
      flush("steer");
    }
    return undefined;
  });

  // The last prose reply of a run has no tool call, so nothing follows it in the
  // same run. "nextTurn" holds that note for the next prompt.
  pi.on("agent_settled", () => {
    if (!enabled) {
      return undefined;
    }
    flush("nextTurn");
    notes = 0;
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("ste", undefined);
    pending = [];
  });
}

/** What, if anything, the linter should read from this tool call. */
function subjectOf(event) {
  const input = event.input ?? {};
  if (event.toolName === "write") {
    return fileSubject(input.path ?? "", input.content ?? "");
  }
  if (event.toolName === "edit") {
    const edits = input.edits ?? [];
    return editSubject(
      input.path ?? "",
      edits.map((edit) => edit.newText ?? ""),
    );
  }
  if (event.toolName === "say") {
    return replySubject(input.text ?? "");
  }
  if (event.toolName === "bash") {
    return commitSubject(input.command ?? "");
  }
  return undefined;
}
