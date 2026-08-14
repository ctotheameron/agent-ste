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
