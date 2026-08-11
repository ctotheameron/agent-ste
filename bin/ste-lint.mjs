#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { argv, exit, stdin } from "node:process";

// The rule layer loads on demand, not at the top of the file. A static import
// fails before the first line runs, and the reason never reaches the user.
// `dist/` is a build artifact, so an absent engine is a normal state in a fresh
// checkout. Exit code 2 names that state, and it never means bad prose.
async function ruleLayer() {
  try {
    const module = await import("../src/host/lint.mjs");
    return { ...module, engine: module.newEngine() };
  } catch (error) {
    console.error(
      "ste-lint: the rule engine failed to load. Run ./scripts/build-dist.sh, " +
        `or install agent-ste from npm.\n  ${error.message}`,
    );
    return exit(2);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function lintOne(rules, path, content) {
  const subject = rules.fileSubject(path, content);
  if (subject === undefined) {
    return [];
  }
  return rules
    .lint(rules.engine, subject.text)
    .map((violation) => ({ ...violation, path }));
}

const HELP = `ste-lint — check text against Simplified Technical English

Usage:
  ste-lint <file>...        Lint each file. Prose files whole, code comments only.
  ste-lint --json <file>... Report JSON.
  cat x.md | ste-lint       Lint stdin as prose.

Exit code 1 means at least one hard violation. Exit code 0 means none.
Exit code 2 means the engine failed to load, so no prose was read.`;

async function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  const json = args.includes("--json");
  const paths = args.filter((arg) => !arg.startsWith("-"));
  const rules = await ruleLayer();

  const violations =
    paths.length === 0
      ? lintOne(rules, "stdin.md", await readStdin())
      : paths.flatMap((path) =>
        lintOne(rules, path, readFileSync(path, "utf8")),
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
