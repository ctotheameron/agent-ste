# Releasing agent-ste

This document tells you how a version of agent-ste reaches npm. It also lists the
steps that a person must do by hand.

## The flow, in six steps

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

A commit with another prefix, such as `refactor:` or `ci:`, changes no version.
It waits in the release pull request for the next `feat:` or `fix:`.

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

The publish step also passes `NODE_AUTH_TOKEN` from a `NPM_TOKEN` secret. The
npm CLI reads the OIDC token first, and it falls back to the secret. The step
works in both modes:

| Mode | What the owner does | What the owner accepts |
| --- | --- | --- |
| Trusted publishing | Adds a trusted publisher on npmjs.com | The first publish is manual. |
| `NPM_TOKEN` secret | Adds an automation token as a secret | A long-lived credential lives in the repository. |

Trusted publishing is the better default for this repository. The repository is
public, so npm attaches a provenance statement to the release. A token in a
secret needs manual rotation. A leak of that token gives an attacker write
access to the package. An OIDC token lives for one job only.

npm needs the package to exist before it accepts a trusted publisher. The first
publish of `agent-ste` is a manual publish from your machine. Every publish after
that one comes from CI.

## Manual steps for the owner

Do these steps one time each.

1. Create the `v0.1.0` tag on the current `main`, and push it. release-please
   then reads the history after that tag only.

   ```
   git tag v0.1.0 && git push origin v0.1.0
   ```

2. Open **Settings > Actions > General** in the GitHub repository. Under
   **Workflow permissions**, select **Allow GitHub Actions to create and approve
   pull requests**. release-please cannot open its release pull request without
   this permission.

3. Publish version 0.1.0 by hand, and create the package on npm.

   ```
   npm login
   npm publish --access public
   ```

4. Add the trusted publisher. Open the package settings on npmjs.com, find the
   **Trusted Publisher** section, and select **GitHub Actions**. Give these
   values:

   - Organization or user: `ctotheameron`
   - Repository: `agent-ste`
   - Workflow filename: `release.yml`
   - Environment name: empty
   - Allowed actions: `npm publish`

   The npm CLI does the same job. Run `npm trust github --help` for the flags.

5. Delete the `NPM_TOKEN` secret if the repository holds one. Trusted
   publishing makes it unnecessary.

Step 4 needs two-factor authentication on the npm account. npm compares the
`repository.url` field in `package.json` against the GitHub repository, so keep
that field correct.

If you prefer a token, do step 3 and then add an npm automation token as the
`NPM_TOKEN` secret. Skip step 4. The publish still attaches provenance, because
the job holds `id-token: write` and the repository is public.

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
