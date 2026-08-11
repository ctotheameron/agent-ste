#!/usr/bin/env bash
# Fails when the manifests hold different versions. The npm package, the Gleam
# project and the Claude Code plugin ship as one unit, so every manifest must
# agree. `build-dist.sh` runs this check, and CI runs it too.
#
# The script reads each file with sed. It needs no node and no toml parser, so
# it also runs before a build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# The first `"version": "..."` line of a JSON file. The marketplace holds one
# plugin, so its first version line is that plugin's version.
json_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

# The first `version = "..."` line of a TOML file. A dependency line names the
# package first, such as `gleam_stdlib = "..."`, so this pattern skips it.
toml_version() {
  sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1
}

# Reads one holder. Prints the version, or nothing when the file is absent.
read_version() {
  local file="$1"

  if [ ! -f "$file" ]; then
    return 0
  fi

  case "$file" in
  *.toml) toml_version "$file" ;;
  *) json_version "$file" ;;
  esac
}

# Every file that declares the version. release-please writes all four through
# `extra-files`. Add a new holder here and in release-please-config.json.
holders=(
  package.json                    # the npm package
  gleam.toml                      # the Gleam project
  .claude-plugin/plugin.json      # the Claude Code plugin
  .claude-plugin/marketplace.json # the entry that installs that plugin
)

# Read every holder once. The report below shows the values the check compared.
# A second read could see a different file on disk.
versions=()
for holder in "${holders[@]}"; do
  versions+=("$(read_version "$holder")")
done

expected="${versions[0]}"
disagree=0

for version in "${versions[@]}"; do
  if [ -z "$version" ] || [ "$version" != "$expected" ]; then
    disagree=1
  fi
done

if [ "$disagree" -eq 1 ]; then
  {
    echo "check-version: the manifests disagree"
    for index in "${!holders[@]}"; do
      printf '  %-32s %s\n' "${holders[index]}" "${versions[index]:-(no version found)}"
    done
    echo "Set every file to the same version, then run this script again."
  } >&2
  exit 1
fi

printf 'version in step: %s\n' "$expected"
