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
import { DEFAULT_STATE, identify, patchState, readState } from "./session.mjs";

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
function subjectOf(module, toolName, input, cwd) {
  if (toolName === "Write") {
    return module.fileSubject(input.file_path ?? "", input.content ?? "");
  }
  if (toolName === "Edit") {
    // The hook lints the new text only. The old text is on disk already, and
    // its author is not the model. This matches the pi extension.
    return module.editSubject(input.file_path ?? "", [input.new_string ?? ""]);
  }
  if (toolName === "Bash") {
    return module.bashSubjects(input.command ?? "", cwd);
  }
  return undefined;
}

function gate({ module, engine }, event) {
  const found = subjectOf(module, event.tool_name, event.tool_input ?? {}, event.cwd);
  // A write has one subject, and a bash command has a list of them.
  const subjects = [found].flat().filter((subject) => subject !== undefined);
  const results = subjects.map((subject) => ({
    subject,
    result: module.check(engine, subject),
  }));

  const hard = results.filter(({ result }) => result.reason !== undefined);
  if (hard.length > 0) {
    return deny(hard.map(({ result }) => result.reason).join("\n\n"));
  }
  const warnings = results
    .filter(({ result }) => result.soft.length > 0)
    .map(({ subject, result }) => module.warnReason(subject.label, result.soft));
  return warnings.length === 0 ? allow() : allow(warnings.join("\n\n"));
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
  patchState(event.session_id, {
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
  patchState(event.session_id, { pending: [] });
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

async function answer(event, state, replies) {
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
    if (replies === "off") {
      return nothing();
    }
    const rules = await ruleLayer(event.cwd);
    return state.strict
      ? checkReply(rules, event)
      : recordReply(rules, event, state);
  }
  if (event.hook_event_name === "UserPromptSubmit") {
    return replies === "off" ? nothing() : deliverReply(event, state);
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
 * What a session starts with, when no `/ste` word is in force.
 *
 * The config and the environment can switch checks off for a whole machine.
 * They can also switch the reply layer off. With nothing set, the default
 * holds, and it is on. A broken config gives the default too. The SessionStart
 * context names the fault, so a typo never blocks the work.
 */
export function startSettings(cwd) {
  try {
    const { enabled, replies } = loadConfig(cwd ?? process.cwd());
    return {
      defaults: { ...DEFAULT_STATE, enabled: enabled ?? DEFAULT_STATE.enabled },
      replies: replies ?? "on",
    };
  } catch {
    return { defaults: DEFAULT_STATE, replies: "on" };
  }
}

/**
 * Maps one raw event to one result. The state argument is for a test. In normal
 * use the state comes from the session file, or from the start settings.
 */
export async function respond(raw, state) {
  const event = parseEvent(raw);
  if (typeof event === "string") {
    return failOpen(event);
  }
  const start = startSettings(event.cwd);
  const current = state ?? readState(event.session_id, start.defaults);
  if (!current.enabled) {
    return event.hook_event_name === "PreToolUse" ? allow() : nothing();
  }
  try {
    return await answer(event, current, start.replies);
  } catch (error) {
    return failOpen(error.message);
  }
}
