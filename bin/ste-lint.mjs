#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { argv, exit, stdin } from "node:process";
import * as engine from "../dist/ste/ste.mjs";
import { lintableText } from "../src/host/select.mjs";

function buildEngine() {
  const result = engine.new_engine();
  if (!result.isOk()) {
    console.error("ste-lint: the rule engine failed to compile its patterns");
    exit(2);
  }
  return result[0];
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function lintOne(compiled, path, content) {
  const text = lintableText(path, content);
  if (text === undefined) {
    return [];
  }
  return JSON.parse(engine.lint_json_with(compiled, text)).map((violation) => ({
    ...violation,
    path,
  }));
}

const HELP = `ste-lint — check text against Simplified Technical English

Usage:
  ste-lint <file>...        Lint each file. Prose files whole, code comments only.
  ste-lint --json <file>... Report JSON.
  cat x.md | ste-lint       Lint stdin as prose.

Exit code 1 means at least one hard violation. Exit code 0 means none.`;

async function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  const json = args.includes("--json");
  const paths = args.filter((arg) => !arg.startsWith("-"));
  const compiled = buildEngine();

  const violations =
    paths.length === 0
      ? lintOne(compiled, "stdin.md", await readStdin())
      : paths.flatMap((path) =>
          lintOne(compiled, path, readFileSync(path, "utf8")),
        );

  if (json) {
    console.log(JSON.stringify(violations, undefined, 2));
  } else {
    for (const violation of violations) {
      const mark = violation.severity === "hard" ? "error" : "warn ";
      console.log(
        `${violation.path}:${violation.line}:${violation.column}: ${mark} ${violation.message} [${violation.ruleId}]`,
      );
    }
    const hard = violations.filter((v) => v.severity === "hard").length;
    console.log(
      `\n${hard} hard, ${violations.length - hard} soft, in ${paths.length || 1} file(s)`,
    );
  }

  return violations.some((v) => v.severity === "hard") ? 1 : 0;
}

exit(await main(argv.slice(2)));
