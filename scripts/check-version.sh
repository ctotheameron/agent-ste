#!/usr/bin/env bash
# Fails when package.json and gleam.toml hold different versions. The npm
# package and the Gleam project ship as one unit, so the two manifests must
# agree. `build-dist.sh` runs this check, and CI runs it too.
#
# The script reads both files with sed. It needs no node and no toml parser, so
# it also runs before a build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# The first `"version": "..."` line of a JSON file.
json_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

# The first `version = "..."` line of a TOML file. A dependency line names the
# package first, such as `gleam_stdlib = "..."`, so this pattern skips it.
toml_version() {
  sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

npm_version="$(json_version package.json)"
gleam_version="$(toml_version gleam.toml)"

if [ -z "$npm_version" ]; then
  echo "check-version: package.json declares no version" >&2
  exit 1
fi

if [ -z "$gleam_version" ]; then
  echo "check-version: gleam.toml declares no version" >&2
  exit 1
fi

if [ "$npm_version" != "$gleam_version" ]; then
  {
    echo "check-version: the two manifests disagree"
    echo "  package.json: $npm_version"
    echo "  gleam.toml:   $gleam_version"
    echo "Set both files to the same version, then run this script again."
  } >&2
  exit 1
fi

printf 'version in step: %s\n' "$npm_version"
