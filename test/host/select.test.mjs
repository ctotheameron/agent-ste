import assert from "node:assert/strict";
import { test } from "node:test";
import { commitMessage } from "../../src/host/select.mjs";

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
