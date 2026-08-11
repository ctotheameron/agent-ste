#!/usr/bin/env node
//
// The Claude Code hook. It reads one event as JSON on stdin, and it writes one
// result as JSON on stdout.
//
// The exit code is always 0, and the output is always one JSON object. Claude
// Code reads the object for the decision, so an exit code adds nothing.
//
// src/host/hook.mjs holds the map from an event to a result. It loads the rule
// engine on demand, so this file starts even when dist/ is absent.

import { stdin, stdout } from "node:process";
import { failOpen, respond } from "../src/host/hook.mjs";

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", reject);
  });
}

const result = await readStdin().then(respond, (error) =>
  failOpen(`stdin failed to read: ${error.message}`),
);

stdout.write(`${JSON.stringify(result)}\n`);
