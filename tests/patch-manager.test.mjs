// Run with:  node --test tests/patch-manager.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPathPolicy } from "../authorization/path-policy.js";
import { createPatchManager, unifiedDiff, hashContent } from "../runtime/patch-manager.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultron-patch-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "const a = 1;\nconst b = 2;\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "GEMINI_API_KEY=fake\n", "utf8");
  const policy = createPathPolicy({ root });
  return { root, policy, patcher: createPatchManager({ policy }) };
}

test("exact-once edit writes, returns a diff and keeps a checkpoint", () => {
  const { root, patcher } = fixture();
  const result = patcher.edit("task_1", "src/app.js", "const b = 2;", "const b = 3;");
  assert.equal(result.ok, true);
  assert.equal(result.path, "src/app.js");
  assert.match(result.diff, /^-const b = 2;$/m);
  assert.match(result.diff, /^\+const b = 3;$/m);
  assert.equal(fs.readFileSync(path.join(root, "src/app.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
  assert.deepEqual(patcher.changedPaths("task_1"), ["src/app.js"]);
});

test("zero or multiple matches are rejected and never touch disk", () => {
  const { root, patcher } = fixture();
  assert.equal(patcher.edit("task_1", "src/app.js", "not there", "x").ok, false);
  fs.writeFileSync(path.join(root, "src/dup.js"), "x\nx\n", "utf8");
  const multiple = patcher.edit("task_1", "src/dup.js", "x", "y");
  assert.equal(multiple.ok, false);
  assert.match(multiple.error, /more than once/);
  assert.equal(fs.readFileSync(path.join(root, "src/dup.js"), "utf8"), "x\nx\n");
});

test("writes create files and refuse protected, escaping and binary targets", () => {
  const { root, patcher } = fixture();
  const created = patcher.write("task_1", "src/new.js", "export const x = 1;\n");
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(fs.existsSync(path.join(root, "src/new.js")), true);
  assert.equal(patcher.write("task_1", ".env", "x").ok, false);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), "GEMINI_API_KEY=fake\n");
  assert.equal(patcher.write("task_1", "../escape.js", "x").ok, false);
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
  assert.equal(patcher.write("task_1", "blob.bin", "text").ok, false);
  assert.equal(patcher.write("task_1", "src/huge.js", "a".repeat(3_000_000)).ok, false);
});

test("undo restores edits, deletes created files and is idempotent afterwards", () => {
  const { root, patcher } = fixture();
  patcher.edit("task_1", "src/app.js", "const a = 1;", "const a = 99;");
  patcher.write("task_1", "src/extra.js", "new\n");
  const undone = patcher.undo("task_1");
  assert.equal(undone.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "src/app.js"), "utf8"), "const a = 1;\nconst b = 2;\n");
  assert.equal(fs.existsSync(path.join(root, "src/extra.js")), false);
  assert.equal(patcher.undo("task_1").ok, false, "nothing left to undo");
});

test("delete is checkpointed and undo brings the file back", () => {
  const { root, patcher } = fixture();
  const removed = patcher.remove("task_1", "src/app.js");
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(path.join(root, "src/app.js")), false);
  assert.match(removed.diff, /^-const a = 1;$/m);
  patcher.undo("task_1");
  assert.equal(fs.existsSync(path.join(root, "src/app.js")), true);
});

test("an outside change to a file blocks a later edit, so edits cannot clobber each other", () => {
  const { root, patcher } = fixture();
  patcher.edit("task_1", "src/app.js", "const b = 2;", "const b = 3;");
  fs.writeFileSync(path.join(root, "src/app.js"), "const a = 1;\nconst b = 42;\n", "utf8");
  const second = patcher.edit("task_1", "src/app.js", "const b = 42;", "const b = 5;");
  assert.equal(second.ok, false);
  assert.match(second.error, /changed outside this task/);
  assert.equal(fs.readFileSync(path.join(root, "src/app.js"), "utf8"), "const a = 1;\nconst b = 42;\n");
});

test("a missing file is reported, not created by edit", () => {
  const { patcher } = fixture();
  const result = patcher.edit("task_1", "src/missing.js", "x", "y");
  assert.equal(result.ok, false);
  assert.equal(result.missing, true);
});

test("unified diff is minimal and empty when nothing changed", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n", "f"), "");
  const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f");
  assert.match(diff, /^--- a\/f\n\+\+\+ b\/f/);
  assert.ok(diff.includes("-b"));
  assert.ok(diff.includes("+B"));
  assert.ok(diff.includes(" a"), "unchanged context is kept");
});

test("content hashing is stable and distinct", () => {
  assert.equal(hashContent("abc"), hashContent("abc"));
  assert.notEqual(hashContent("abc"), hashContent("abd"));
  assert.equal(hashContent("abc").length, 64);
});
