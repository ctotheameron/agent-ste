import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bashMessage,
  bashMessageLabel,
  commitMessage,
} from "../../src/host/select.mjs";

// --- a message in any command, not only in git commit ---

// A harness posts prose with its own command, and `-m` or `--message` names the
// text. `git commit` holds no monopoly on a sentence.
test("it reads a message from a command that is not git", () => {
  assert.equal(
    bashMessage(`sky action slack-post --message "we ship it today"`),
    "we ship it today",
  );
  assert.equal(
    bashMessage(`gh pr comment 12 --message "it reads well"`),
    "it reads well",
  );
});

// `-m` also carries a file mode, a memory limit and a shell variable. None of
// those is prose, and a false report on one would block real work.
test("it reads no message from a value that is not prose", () => {
  for (const command of [
    "mkdir -m 755 /tmp/x",
    "install -m 0644 a b",
    "docker run -m 512m image",
    "chmod -m u+rwx file",
    `git commit -m "$MESSAGE"`,
    "git tag -m v1.2.3",
    "ls -la",
  ]) {
    assert.equal(bashMessage(command), undefined, command);
  }
});

test("it names the source of the message", () => {
  assert.equal(bashMessageLabel(`git commit -m "we ship it"`), "the commit message");
  assert.equal(bashMessageLabel(`slack-post -m "we ship it"`), "the message");
});

test("it reads a quoted -m message", () => {
  assert.equal(commitMessage(`git commit -m "feat: start it"`), "feat: start it");
  assert.equal(commitMessage(`git commit -m 'feat: start it'`), "feat: start it");
});

test("it reads a bare -m message", () => {
  assert.equal(commitMessage("git commit -m start-it"), "start-it");
});

test("it reads a combined short flag", () => {
  assert.equal(commitMessage(`git commit -am "feat: start it"`), "feat: start it");
  assert.equal(commitMessage(`git commit -sam "feat: start it"`), "feat: start it");
});

test("it reads the long flag, with or without an equals sign", () => {
  assert.equal(commitMessage(`git commit --message="start it"`), "start it");
  assert.equal(commitMessage(`git commit --message 'start it'`), "start it");
  assert.equal(commitMessage("git commit --message=start-it"), "start-it");
});

test("it joins several -m flags", () => {
  assert.equal(
    commitMessage(`git commit -m "first" -m "second"`),
    "first\n\nsecond",
  );
});

test("it reads a heredoc message", () => {
  const command = "git commit -F -\n<<'EOF'\nfeat: start it\nEOF";
  assert.equal(commitMessage(command), "feat: start it");
});

test("it reads a message after other flags", () => {
  assert.equal(
    commitMessage(`git -C /tmp commit --no-verify -m "feat: start it"`),
    "feat: start it",
  );
});

test("it ignores a command with no message", () => {
  assert.equal(commitMessage("git commit --amend --no-edit"), undefined);
  assert.equal(commitMessage("git commit"), undefined);
  assert.equal(commitMessage("git status"), undefined);
  assert.equal(commitMessage("echo commit -m hi"), undefined);
});

test("it ignores a message flag before the commit verb", () => {
  assert.equal(commitMessage(`git tag -m "start it" v1`), undefined);
});

// --- prose in gh pr and gh issue commands ---

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghMessages } from "../../src/host/select.mjs";

test("gh reads the title and the body of a new pull request", () => {
  assert.deepEqual(
    ghMessages(`gh pr create --title "feat: add the cache" --body "It stores each result."`),
    [
      { text: "feat: add the cache", label: "the PR title" },
      { text: "It stores each result.", label: "the PR body" },
    ],
  );
});

test("gh reads the short flags, the joined forms and a single quote", () => {
  assert.deepEqual(ghMessages(`gh pr create -t 'fix: the bug is gone' -b="it works now"`), [
    { text: "fix: the bug is gone", label: "the PR title" },
    { text: "it works now", label: "the PR body" },
  ]);
  assert.equal(ghMessages(`gh issue create --title="a real title"`)[0].label, "the issue title");
});

test("gh names a comment and a review for what they are", () => {
  assert.equal(ghMessages(`gh pr comment 4 -b "we ship it today"`)[0].label, "the PR comment");
  assert.equal(ghMessages(`gh issue comment 4 -b "we ship it today"`)[0].label, "the issue comment");
  assert.equal(ghMessages(`gh pr review 4 --approve -b "it reads well"`)[0].label, "the PR review");
  assert.equal(ghMessages(`gh pr edit 4 --body "it reads well"`)[0].label, "the PR body");
});

// The usual form for a long body. The quotes inside the heredoc must not end
// the word, and the text of the body is what the linter should read.
test("gh reads a body in $(cat <<EOF) and keeps its quotes", () => {
  const command = [
    `gh pr create --title "feat: add it" --body "$(cat <<'EOF'`,
    `## Summary`,
    `It says "hello" and it (still) works.`,
    `EOF`,
    `)"`,
  ].join("\n");
  const [title, body] = ghMessages(command);
  assert.equal(title.text, "feat: add it");
  assert.equal(body.text, `## Summary\nIt says "hello" and it (still) works.`);
});

test("gh reads a body from a heredoc on stdin", () => {
  const command = `gh pr create -t "feat: add it" -F - <<'EOF'\nThe body is here.\nEOF\n`;
  assert.equal(ghMessages(command)[1].text, "The body is here.");
  const long = `gh issue comment 3 --body-file - <<EOF\nA line.\nEOF`;
  assert.equal(ghMessages(long)[0].text, "A line.");
});

test("gh reads a body file, and skips a file that is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "ste-gh-"));
  writeFileSync(join(root, "body.md"), "The body is in a file.\n");
  const [body] = ghMessages(`gh pr create --body-file body.md`, root);
  assert.equal(body.text, "The body is in a file.\n");
  assert.equal(body.label, "the PR body (body.md)");
  assert.deepEqual(ghMessages(`gh pr create -F nothing.md`, root), []);
  assert.deepEqual(ghMessages(`gh pr create -F "$FILE"`, root), []);
});

// A flag that means something else, a command that posts no prose, and a value
// that is no prose must all stay unread. A false block stops real work.
test("gh reads nothing that is not prose", () => {
  for (const command of [
    "gh pr list -b main",
    "gh pr list --base main --search 'is:open'",
    "gh pr view 5 -t",
    "gh pr create --fill",
    "gh pr create -t x",
    `gh pr create --body "$BODY"`,
    `gh pr create --body "$(cat notes.md)"`,
    "gh pr create -B main -H feature",
    "gh pr merge 5 --squash -b main",
    `gh api repos/a/b/issues -f body="we ship it today"`,
    `echo "gh pr create --body 'we ship it today'"`,
    `grep -t "two words" file`,
  ]) {
    assert.deepEqual(ghMessages(command), [], command);
  }
});

test("gh reads a command that follows another command", () => {
  const text = `git push -u origin x && gh pr create -t "feat: add it" ; echo done`;
  assert.equal(ghMessages(text)[0].text, "feat: add it");
  assert.equal(ghMessages(`GH_TOKEN=abc gh pr create -t "feat: add it"`).length, 1);
});
