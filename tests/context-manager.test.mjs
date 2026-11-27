// Run with:  node --test tests/context-manager.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildTree, compactContext, isNoisePath, selectRelevantPaths, snippet, summarizeOutput, tokenize } from "../agent/context-manager.js";

test("the compact tree drops noise directories and deduplicates", () => {
  const tree = buildTree([
    "src/auth/redirect.js", "./src/auth/redirect.js", "node_modules/x/index.js",
    "dist/bundle.js", ".git/config", "tests/auth.test.mjs", "src/app.js",
  ]);
  assert.deepEqual(tree, ["src/app.js", "src/auth/redirect.js", "tests/auth.test.mjs"]);
  assert.equal(isNoisePath("node_modules/a/b.js"), true);
  assert.equal(isNoisePath("src/app.js"), false);
});

test("retrieval ranks paths by goal overlap", () => {
  const paths = ["src/auth/redirect.js", "src/auth/session.js", "src/ui/button.js", "tests/auth.test.mjs", "README.md"];
  const selected = selectRelevantPaths("fix the failing auth redirect test", paths, 3);
  assert.equal(selected[0], "src/auth/redirect.js");
  assert.ok(selected.includes("tests/auth.test.mjs"));
  assert.equal(selected.includes("src/ui/button.js"), false);
  assert.deepEqual(selectRelevantPaths("", paths), []);
});

test("tokenize ignores stopwords and short tokens", () => {
  const tokens = tokenize("Fix the failing authentication test, please");
  assert.equal(tokens.has("the"), false);
  assert.equal(tokens.has("fix"), false, "generic task words are stopwords");
  assert.equal(tokens.has("authentication"), true);
});

test("snippets keep the head and tail with a marker", () => {
  const text = "a".repeat(100) + "b".repeat(500);
  const result = snippet(text, { maxChars: 100 });
  assert.ok(result.length < text.length);
  assert.match(result, /chars omitted/);
  assert.equal(snippet("short", { maxChars: 100 }), "short");
  assert.equal(snippet(null), "");
});

test("output summaries distinguish passed, failed and timed out", () => {
  const passed = summarizeOutput({ exitCode: 0, stdout: "24 tests passed" });
  assert.equal(passed.status, "passed");
  assert.equal(passed.exitCode, 0);
  const failed = summarizeOutput({ exitCode: 1, stdout: "test failed: auth redirect", stderr: "error: expected 302" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorLines.length, 2);
  assert.match(failed.errorLines[0], /failed/);
  const timedOut = summarizeOutput({ exitCode: null, timedOut: true });
  assert.equal(timedOut.status, "timed_out");
});

test("long output is capped with a line count marker", () => {
  const lines = Array.from({ length: 500 }, (_, i) => "line " + i).join("\n");
  const summary = summarizeOutput({ exitCode: 0, stdout: lines });
  assert.match(summary.stdout, /lines omitted/);
  assert.ok(summary.stdout.split("\n").length < 100);
});

test("compacted context respects its budget and never includes extra file fields", () => {
  const context = compactContext({
    goal: "Fix auth",
    tree: ["src/a.js", "src/b.js"],
    files: [{ path: "src/a.js", content: "export const a = 1;", secret: "should not appear" }],
    notes: ["test.run passed"],
  });
  assert.match(context, /### Goal\nFix auth/);
  assert.match(context, /### File: src\/a\.js/);
  assert.match(context, /test\.run passed/);
  assert.equal(context.includes("should not appear"), false);
});
