/**
 * The Claude Code hook adapter.
 *
 * Claude Code sends one event as JSON on stdin and reads one result as JSON on
 * stdout. This module maps an event to a result. It holds no rule, and it calls
 * ./lint.mjs for every check, which is the module the pi extension calls.
 *
 * Three events matter:
 *
 * - `SessionStart` returns the rule list as session context. This is layer 1.
 * - `PreToolUse` on Write, Edit or Bash denies a hard violation. This is
 *   layer 2.
 * - `Stop` blocks a reply that breaks a hard rule. This is layer 3.
 *
 * Every other event returns an empty object, which asks for no action.
 *
 * The module never blocks on an error of its own. A linter that stops the work
 * of a user is worse than a linter that stays quiet. Each error path returns a
 * fail-open result.
 */

import { loadConfig } from "./config.mjs";
import { identify, readState, writeState } from "./session.mjs";

/** The tail of a block reason. A reply needs no second tool call. */
const REPLY_TAIL = "Write the reply again in Simplified Technical English.";

/** An empty result asks Claude Code for no action. */
function nothing() {
  return {};
}

/**
 * The result for an error of our own. `continue: true` holds the session on
 * course, and `systemMessage` tells the user what broke.
 */
export function failOpen(message) {
  return {
    continue: true,
    systemMessage: `ste hook: ${message}. The event goes through.`,
  };
}

function allow(warning) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      ...(warning === undefined ? {} : { additionalContext: warning }),
    },
  };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function context(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

/**
 * Loads the rule layer once for this process.
 *
 * `dist/` is a build artifact that `.gitignore` holds, so a checkout can miss
 * it. The import then fails, and the message names the fix.
 */
let rules;

/**
 * Reads `.ste.json` from the session directory, if one exists.
 *
 * A broken file gives the built-in severities and one warning. A gate that
 * blocks every write over a setting file helps nobody.
 */
function settings(module, cwd) {
  try {
    return { config: loadConfig(cwd ?? process.cwd(), module.ruleNames()) };
  } catch (error) {
    return { config: { rules: {} }, fault: error.message };
  }
}

async function ruleLayer(cwd) {
  if (rules === undefined) {
    const module = await import("./lint.mjs").catch((cause) => {
      throw new Error(
        "the rule engine failed to load, and dist/ is the usual reason. " +
          "Run ./scripts/build-dist.sh, or install agent-ste from npm",
        { cause },
      );
    });
    const { config, fault } = settings(module, cwd);
    rules = { module, engine: module.newEngine(config), fault };
  }
  return rules;
}

/** What, if anything, the linter reads from a Claude Code tool call. */
function subjectOf(module, toolName, input) {
  if (toolName === "Write") {
    return module.fileSubject(input.file_path ?? "", input.content ?? "");
  }
  if (toolName === "Edit") {
    // The hook lints the new text only. The old text is on disk already, and
    // its author is not the model. This matches the pi extension.
    return module.editSubject(input.file_path ?? "", [input.new_string ?? ""]);
  }
  if (toolName === "Bash") {
    return module.commitSubject(input.command ?? "");
  }
  return undefined;
}

function gate({ module, engine }, event) {
  const subject = subjectOf(module, event.tool_name, event.tool_input ?? {});
  if (subject === undefined) {
    return allow();
  }
  const result = module.check(engine, subject);
  if (result.reason !== undefined) {
    return deny(result.reason);
  }
  return result.soft.length === 0
    ? allow()
    : allow(module.warnReason(subject.label, result.soft));
}

/**
 * Records the faults of a reply, and blocks nothing.
 *
 * This is the layer the pi extension runs by default. pi sends the faults back
 * as a note, and Claude Code has no note channel. So the hook keeps them, and
 * the next prompt carries them to the model.
 *
 * A repeat of the same Stop event changes nothing, because the name of the
 * reply already sits in the state.
 */
function recordReply({ module, engine }, event, state) {
  const text = event.last_assistant_message;
  if (typeof text !== "string") {
    return nothing();
  }
  const subject = module.replySubject(text);
  const name = identify(text);
  if (subject === undefined || name === state.replied) {
    return nothing();
  }

  // `replyReport` in the settings picks the severity this note carries. A fleet
  // that sets every rule to `soft` reads nothing without it.
  writeState(event.session_id, {
    ...state,
    replied: name,
    pending: module.replyFaults(engine, subject),
  });
  return nothing();
}

/**
 * Hands the faults of the last reply to the model, and clears them.
 *
 * A report reaches the model one time. A second prompt with no new fault adds
 * nothing to the context.
 */
function deliverReply(event, state) {
  const pending = state.pending ?? [];
  if (pending.length === 0) {
    return nothing();
  }
  writeState(event.session_id, { ...state, pending: [] });
  return context(
    "UserPromptSubmit",
    `Your previous reply broke Simplified Technical English ${pending.length} ` +
      `time(s):\n${formatOf(pending)}\nCorrect this in your next reply. Do not ` +
      "apologise for it.",
  );
}

// The formatter lives in the rule layer, and this module loads that layer on
// demand. A recorded fault already holds its text, so read it from the report.
function formatOf(violations) {
  return violations
    .map((v) => `  ${v.line}:${v.column}  ${v.message}  [${v.ruleId}]`)
    .join("\n");
}

function checkReply({ module, engine }, event) {
  // `stop_hook_active` marks a stop that a hook blocked already. A second block
  // on the same stop can loop, so the reply goes through.
  const text = event.last_assistant_message;
  if (event.stop_hook_active === true || typeof text !== "string") {
    return nothing();
  }
  const subject = module.replySubject(text);
  if (subject === undefined) {
    return nothing();
  }
  const hard = module.check(engine, subject).hard;
  return hard.length === 0
    ? nothing()
    : {
        decision: "block",
        reason: module.blockReason(subject.label, hard, REPLY_TAIL),
      };
}

async function answer(event, state) {
  if (event.hook_event_name === "SessionStart") {
    const { module, engine, fault } = await ruleLayer(event.cwd);
    const text = module.promptText(engine);
    return context(
      "SessionStart",
      fault === undefined ? text : `${text}\n\nste config: ${fault}`,
    );
  }
  if (event.hook_event_name === "PreToolUse") {
    return gate(await ruleLayer(event.cwd), event);
  }
  if (event.hook_event_name === "Stop") {
    const rules = await ruleLayer(event.cwd);
    return state.strict
      ? checkReply(rules, event)
      : recordReply(rules, event, state);
  }
  if (event.hook_event_name === "UserPromptSubmit") {
    return deliverReply(event, state);
  }
  return nothing();
}

function parseEvent(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "the event on stdin was empty";
  }
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return "the event on stdin was not a JSON object";
    }
    if (typeof value.hook_event_name !== "string") {
      return "the event on stdin holds no hook_event_name";
    }
    return value;
  } catch (error) {
    return `the event on stdin was not valid JSON: ${error.message}`;
  }
}

/**
 * Maps one raw event to one result. The state argument is for a test. In normal
 * use the state comes from the session file.
 */
export async function respond(raw, state) {
  const event = parseEvent(raw);
  if (typeof event === "string") {
    return failOpen(event);
  }
  const current = state ?? readState(event.session_id);
  if (!current.enabled) {
    return event.hook_event_name === "PreToolUse" ? allow() : nothing();
  }
  try {
    return await answer(event, current);
  } catch (error) {
    return failOpen(error.message);
  }
}
