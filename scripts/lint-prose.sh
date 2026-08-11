#!/usr/bin/env bash
# Runs our own linter over every tracked file it can read.
#
# AGENTS.md asks for Simplified Technical English in every comment, not only in
# a document. So this script feeds the linter each tracked file with a known
# extension, rather than a hand-written list that drifts.
#
# `manifest.toml` stays out. Gleam writes that file, so its prose is not ours.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Every extension src/host/select.mjs reads, as prose or as comments.
readable='\.(md|mdx|markdown|txt|rst|ts|tsx|js|mjs|cjs|jsx|gleam|go|rs|swift|kt|java|c|h|cpp|sh|bash|zsh|py|rb|yml|yaml|toml|just)$'

mapfile -t files < <(git ls-files | grep -E "$readable" | grep -v '^manifest\.toml$')

if [ "${#files[@]}" -eq 0 ]; then
  echo "lint-prose: no tracked file matched" >&2
  exit 1
fi

printf 'lint-prose: %s file(s)\n' "${#files[@]}"
exec ./bin/ste-lint.mjs "${files[@]}"
