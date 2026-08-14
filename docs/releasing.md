# Releasing agent-ste

This document tells you how a version of agent-ste reaches npm. It also lists the
steps that a person must do by hand.

## The flow, in seven steps

1. You merge a commit to `main`. The commit message starts with `feat:` or
   `fix:`.
2. The `release` workflow starts. release-please opens a release pull request,
   or it updates the open one. That pull request holds the next version in
   `CHANGELOG.md` and in each of the four version files below.
3. You merge the release pull request.
4. The `release` workflow starts again. release-please tags the commit, and it
   creates the GitHub release.
5. The `test` workflow runs against the tag. It builds `dist/`, and it runs the
   Gleam tests, the node tests and the prose lint.
6. The `publish` job builds `dist/` from Gleam, checks that `dist/` holds files,
   and runs `npm publish --provenance`.
7. Every agent that uses this package reads the new build:

   ```
   pi update npm:agent-ste
   ```

A commit with another prefix, such as `refactor:` or `ci:`, changes no version.
It waits in the release pull request for the next `feat:` or `fix:`.

Step 7 matters more than it looks. A host loads the rule engine one time, at the
start of a session. So an older session keeps the old rules until it ends, and
the linter can miss a fault it now knows about.

This repository holds its own rules, so run step 7 here first. Read the pi
package list with `pi list`. A checkout in that list loads the working tree
rather than the release, which is useful for a test and wrong for daily work.

## Why release-please

1. Four files hold the version. release-please updates each extra file through
   `extra-files`. It rewrites the annotated line in `gleam.toml`, and one JSON
   field in each plugin file. It leaves every other line alone.
2. It adds no file per change. changesets asks for a changeset file in each pull
   request, and it knows nothing about `gleam.toml`.
3. It reads the conventional commits that this repository already writes.
4. It writes the changelog, the tag and the GitHub release. A tag-triggered
   publish needs two manual version bumps and one hand-written changelog.
5. It costs one config file, one manifest file and one job.

## Four manifests, one version

Four files declare the version:

| File | Role |
| --- | --- |
| `package.json` | the npm package |
| `gleam.toml` | the Gleam project |
| `.claude-plugin/plugin.json` | the Claude Code plugin |
| `.claude-plugin/marketplace.json` | the entry that installs that plugin |

`scripts/check-version.sh` reads all four. It fails when any one of them
differs from `package.json`. Add a new version file to that script and to the
`extra-files` list in `release-please-config.json` in the same change.

The test job runs the script. `scripts/build-dist.sh` also runs it, and
`prepublishOnly` calls `build-dist.sh`. A mismatch stops a local build, a pull
request and a publish.

## How the publish authenticates

The workflow prefers npm trusted publishing with OIDC. The npm CLI reads an
OIDC token from the runner, and it exchanges that token for a short-lived
registry token. The repository holds no long-lived npm credential.

This repository holds a trusted publisher, and it holds no npm secret. The
publish step still reads `NODE_AUTH_TOKEN` from an `NPM_TOKEN` secret, which is
absent. The npm CLI reads the OIDC token first, so the step needs no secret.

The repository is public, so npm attaches a provenance statement to each
release. An OIDC token lives for one job. A secret would need rotation, and a
leak of one gives an attacker write access to the package.

A token is no longer a real second option. npm demands two-factor
authentication or a granular token with the 2FA bypass, and it restricts that
bypass. A classic automation token answers 403 on a new package.

npm needs the package to exist before it accepts a trusted publisher, so the
first publish came from a laptop. Every publish after that one comes from CI.

## Manual steps for the owner

Nobody needs to repeat these steps here. The record stays, because a fork or a
second package walks the same path. Each step hid a trap.

1. **The repository name.** `gh repo rename agent-ste` renames it and rewrites
   the git remote. GitHub redirects the old name, so an old clone keeps working.

2. **The pull request permission.** Actions cannot open a release pull request
   by default. release-please then fails, and it names the reason. Set the
   permission under **Settings > Actions > General**, or run:

   ```
   gh api -X PUT repos/ctotheameron/agent-ste/actions/permissions/workflow \
     -F can_approve_pull_request_reviews=true
   ```

3. **Two-factor authentication on the npm account.** npm refuses a publish
   without it. A passkey works, and so does an authenticator app.

4. **The first publish, from a laptop.** npm accepts no trusted publisher for a
   package that does not exist yet.

   ```
   npm login
   npm publish --access public
   ```

   Run this in a real terminal. A passkey opens a browser, and npm masks its own
   auth URL when stdout is a pipe. It then exits with `EOTP` rather than waiting.

5. **The trusted publisher.** Open the package settings on npmjs.com, find the
   **Trusted Publisher** section, and select **GitHub Actions**. Give the
   organization `ctotheameron`, the repository `agent-ste`, the workflow file
   `release.yml`, and an empty environment.

   Use the website. `npm trust github` answers `400 Bad Request` with no reason.
   Read the result back with `npm trust list agent-ste`.

6. **The secret.** Delete `NPM_TOKEN` if one exists. Trusted publishing needs no
   credential, and a dead secret only misleads a reader.

npm compares the `repository.url` field of `package.json` against the GitHub
repository, so keep that field correct.

## Limits to know

- A pull request from `GITHUB_TOKEN` starts no workflow. The `test` workflow
  does not run on the release pull request. The `release` workflow runs `test`
  against the tag before publish, so nothing reaches npm untested. A personal
  access token in the `token` input removes this limit.
- npm creates no provenance statement for a package in a private repository.
- Keep the `npm publish` step in `.github/workflows/release.yml`. npm reads the
  filename of the workflow that starts the run. A move of the step into a
  reusable workflow breaks the trusted publisher match.

## To release a specific version

Add a `Release-As` line to a commit message on `main`:

```
git commit --allow-empty -m "chore: release 1.0.0" -m "Release-As: 1.0.0"
```
