#!/usr/bin/env bash
# Copies the Gleam JavaScript output into dist/. `dist/` is a build artifact,
# so `.gitignore` holds it. `npm publish` runs this first through
# `prepublishOnly`, so the npm release ships dist/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

gleam build --target javascript

out="build/dev/javascript"
rm -rf dist
mkdir -p dist

cp "$out/prelude.mjs" dist/
for package in ste gleam_stdlib gleam_json gleam_regexp; do
  cp -R "$out/$package" "dist/$package"
done

# Test-only code and build artefacts have no place in a published dist. Gleam
# copies every .mjs under test/, so the host tests arrive here too.
rm -rf dist/ste/_gleam_artefacts dist/ste/ste_test.mjs
find dist -name "*.cache*" -delete
find dist -name "*.test.mjs" -delete

printf 'dist built: %s files, %s\n' \
  "$(find dist -type f | wc -l | tr -d ' ')" \
  "$(du -sh dist | cut -f1)"
