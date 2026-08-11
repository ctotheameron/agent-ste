#!/usr/bin/env bash
# Fails when dist/ is absent, empty or short of an entry point. `npm publish`
# must never ship an empty package, and `.gitignore` holds dist/, so no commit
# proves that the build ran. `build-dist.sh` runs this check at the end, and the
# release workflow runs it again before publish.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fail() {
  echo "check-dist: $1" >&2
  echo "Run ./scripts/build-dist.sh, then run this script again." >&2
  exit 1
}

if [ ! -d dist ]; then
  fail "dist/ is absent"
fi

files="$(find dist -type f | wc -l | tr -d ' ')"
if [ "$files" -eq 0 ]; then
  fail "dist/ holds no file"
fi

# The extension, the CLI and the host tests import these two files.
for entry in dist/prelude.mjs dist/ste/ste.mjs; do
  if [ ! -f "$entry" ]; then
    fail "$entry is absent"
  fi
done

# `gleam test` leaves a test entry point in the build output. A published dist
# carries no test code.
test_code="$(find dist \( -name "*.test.mjs" -o -name "*_test.mjs" \
  -o -name "gleam@@private_main_*.mjs" \) -print)"
if [ -n "$test_code" ]; then
  fail "dist/ holds test code: $(echo "$test_code" | tr '\n' ' ')"
fi

printf 'dist checked: %s files\n' "$files"
