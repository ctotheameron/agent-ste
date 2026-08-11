#!/usr/bin/env node
//
// The state command behind the /ste slash command in Claude Code.
//
// Usage: ste-session <session-id> [word...]
//
// It applies the word to the state of the session, saves the state, and prints
// one line. An empty word toggles. The words match the /ste command of the pi
// extension, which src/host/session.mjs documents.

import { argv, stdout } from "node:process";
import { apply, describe, readState, writeState } from "../src/host/session.mjs";

const [sessionId, ...words] = argv.slice(2);
const state = apply(readState(sessionId), words.join(" "));

try {
  writeState(sessionId, state);
} catch (error) {
  // A state that cannot save is not a reason to stop the session. The next
  // event reads the default state, and the line below says what broke.
  stdout.write(`ste: the state failed to save: ${error.message}\n`);
}

stdout.write(`${describe(state)}\n`);
