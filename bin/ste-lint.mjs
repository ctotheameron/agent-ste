#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { argv, cwd, exit, stdin } from "node:process";
import { ConfigError, loadConfig, readConfig } from "../src/host/config.mjs";

// The rule layer loads on demand, not at the top of the file. A static import
// fails before the first line runs, and the reason never reaches the user.
// `dist/` is a build artifact, so an absent engine is a normal state in a fresh
// checkout. Exit code 2 names that state, and it never means bad prose.
async function ruleLayer(configPath) {
  let module;
  try {
    module = await import("../src/host/lint.mjs");
  } catch (error) {
    console.error(
      "ste-lint: the rule engine failed to load. Run ./scripts/build-dist.sh, " +
        `or install agent-ste from npm.\n  ${error.message}`,
    );
    return exit(2);
  }

  // A broken config file stops the run. A command that reads bad settings and
  // reports a pass gives the author a false result.
  try {
    const names = module.ruleNames();
    const config =
      configPath === undefined
        ? loadConfig(cwd(), names)
        : readConfig(configPath, names);
    return { ...module, engine: module.newEngine(config) };
  } catch (error) {
    const label = error instanceof ConfigError ? "config" : "failure";
    console.error(`ste-lint: ${label}: ${error.message}`);
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

Settings:
  A .ste.json file in this directory or a parent sets the severity of a rule.
  Each rule reads "hard", "soft" or "off". Use --config <path> for one file.

Exit code 1 means at least one hard violation. Exit code 0 means none.
Exit code 2 means the command read no prose, because the engine or the config
failed to load.`;

async function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  const json = args.includes("--json");
  const at = args.indexOf("--config");
  const configPath = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && configPath === undefined) {
    console.error("ste-lint: --config needs a path");
    return 2;
  }

  // The value of `--config` is a path, and it is not a file to lint. Without
  // the flag, `at` is -1, and `at + 1` would drop the first real path.
  const paths = args.filter(
    (arg, index) => !arg.startsWith("-") && !(at !== -1 && index === at + 1),
  );
  const rules = await ruleLayer(configPath);

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
