// Run with:  node --test tests/command-runner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPathPolicy } from "../authorization/path-policy.js";
import { createCommandPolicy } from "../authorization/command-policy.js";
import { createCommandRunner } from "../runtime/command-runner.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultron-run-"));
  fs.writeFileSync(path.join(root, "big.js"), "process.stdout.write('x'.repeat(300000));\n", "utf8");
  const policy = {
    ...createPathPolicy({ root }),
    commandPolicy: createCommandPolicy({ allow: ["node", "sleep", "echo"], ask: [], deny: ["rm *", "curl *"] }),
  };
  const runner = createCommandRunner({ policy, limits: { maxOutputBytes: 1000, defaultTimeoutMs: 20000, maxTimeoutMs: 30000 } });
  return { root, policy, runner };
}

test("an allowed command runs without a shell and reports its exit code", async () => {
  const { runner } = fixture();
  const result = await runner.run({ command: "node --version" });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.trim(), /^v\d+\./);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test("denied commands never reach spawn", async () => {
  const { runner } = fixture();
  const result = await runner.run({ command: "rm -rf /" });
  assert.equal(result.ok, false);
  assert.equal(result.denied, true);
  const injected = await runner.run({ command: "node --version; rm -rf /" });
  assert.equal(injected.denied, true);
});

test("output is capped and marked as truncated", async () => {
  const { runner } = fixture();
  const result = await runner.run({ command: "node big.js" });
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.match(result.stdout, /output truncated at 1000 bytes/);
  assert.ok(result.stdout.length < 2000);
});

test("a timed-out command is killed and reports the timeout", async () => {
  const { runner } = fixture();
  const started = Date.now();
  const result = await runner.run({ command: "sleep 30", timeoutMs: 1000 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error, /timed out/);
  assert.ok(elapsed < 8000, "the process was terminated, not awaited: " + elapsed + "ms");
});

test("the working directory cannot escape the workspace", async () => {
  const { runner } = fixture();
  const escaped = await runner.run({ command: "node --version", cwd: "../" });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /traversal|outside/);
  const absolute = await runner.run({ command: "node --version", cwd: "/etc" });
  assert.equal(absolute.ok, false);
});

test("no command policy means nothing runs", async () => {
  const { policy } = fixture();
  const runner = createCommandRunner({ policy: { ...policy, commandPolicy: null } });
  const result = await runner.run({ command: "node --version" });
  assert.equal(result.result, undefined);
  assert.equal(result.ok, false);
  assert.match(result.error, /No command policy/);
});
