// Run with:  node --test tests/permission-engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createPermissionEngine, permissionEngineFromSettings, modeBaseline, PERMISSION_MODES } from "../agent/permission-engine.js";
import { createCommandPolicy } from "../authorization/command-policy.js";

test("manual mode allows reads and asks for everything else", () => {
  const engine = createPermissionEngine({ mode: "manual" });
  assert.equal(engine.evaluate({ tool: "file.read", input: { path: "a.js" } }).action, "allow");
  assert.equal(engine.evaluate({ tool: "file.search", input: { query: "x" } }).action, "allow");
  assert.equal(engine.evaluate({ tool: "file.edit", input: { path: "a.js", find: "x" } }).action, "ask");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "npm test" } }).action, "ask");
});

test("plan mode allows reads only", () => {
  const engine = createPermissionEngine({ mode: "plan" });
  for (const tool of ["file.read", "file.glob", "git.diff", "workspace.list"]) {
    assert.equal(modeBaseline("plan", tool).action, "allow", tool);
  }
  assert.equal(engine.evaluate({ tool: "file.write", input: { path: "a", content: "x" } }).action, "ask");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "npm test" } }).action, "ask");
});

test("accept-edits allows workspace writes and still asks for commands", () => {
  const engine = createPermissionEngine({ mode: "accept-edits" });
  assert.equal(engine.evaluate({ tool: "file.edit", input: { path: "a.js", find: "x" } }).action, "allow");
  assert.equal(engine.evaluate({ tool: "file.write", input: { path: "a.js", content: "x" } }).action, "allow");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "npm test" } }).action, "ask");
  assert.equal(engine.evaluate({ tool: "file.delete", input: { path: "a.js" } }).action, "ask", "delete is always destructive");
});

test("restricted mode denies unless a rule allows", () => {
  const engine = createPermissionEngine({ mode: "restricted" });
  assert.equal(engine.evaluate({ tool: "file.read", input: { path: "a.js" } }).action, "deny");
  const narrowed = createPermissionEngine({ mode: "restricted", rules: { allow: ["file.read:src/**"], ask: [], deny: [] } });
  assert.equal(narrowed.evaluate({ tool: "file.read", input: { path: "src/a.js" } }).action, "allow");
  assert.equal(narrowed.evaluate({ tool: "file.read", input: { path: "lib/a.js" } }).action, "deny");
});

test("deny always beats allow and ask", () => {
  const engine = createPermissionEngine({
    mode: "accept-edits",
    rules: { allow: ["shell.run", "file.write"], ask: ["shell.run:git *"], deny: ["shell.run:npm publish*"] },
  });
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "npm publish --access public" } }).action, "deny");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "git status" } }).action, "ask");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "npm test" } }).action, "allow");
});

test("ask beats a matching allow", () => {
  const engine = createPermissionEngine({ rules: { allow: ["file.edit"], ask: ["file.edit:src/secret/**"], deny: [] } });
  assert.equal(engine.evaluate({ tool: "file.edit", input: { path: "src/secret/key.js", find: "a" } }).action, "ask");
  assert.equal(engine.evaluate({ tool: "file.edit", input: { path: "src/app.js", find: "a" } }).action, "allow");
});

test("a bare rule applies to the whole tool", () => {
  const engine = createPermissionEngine({ mode: "restricted", rules: { allow: ["file.read"], ask: [], deny: [] } });
  assert.equal(engine.evaluate({ tool: "file.read", input: { path: "a.js" } }).action, "allow");
  assert.equal(engine.evaluate({ tool: "file.read", input: { path: "b.js" } }).action, "allow");
});

test("command rules match the command, not the tool name only", () => {
  const engine = createPermissionEngine({ rules: { allow: [], ask: [], deny: ["shell.run:rm *"] } });
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "mkdir -p out" } }).action, "ask");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "rm -rf src" } }).action, "deny");
});

test("a command the command policy denies is denied before any approval prompt", () => {
  const commandPolicy = createCommandPolicy({ allow: ["npm test"], ask: [], deny: ["sudo *", "rm *"] });
  const engine = createPermissionEngine({ mode: "accept-edits", commandPolicy });
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "sudo rm -rf /" } }).action, "deny");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "rm -rf src" } }).action, "deny");
  assert.equal(engine.evaluate({ tool: "shell.run", input: { command: "npm test" } }).action, "ask");
  const restricted = createPermissionEngine({ mode: "restricted", commandPolicy });
  assert.equal(restricted.evaluate({ tool: "shell.run", input: { command: "rm -rf src" } }).action, "deny");
});

test("unknown tools and task-level mode override are handled", () => {
  const engine = createPermissionEngine({ mode: "manual" });
  assert.equal(engine.evaluate({ tool: "shell.exec", input: {} }).action, "deny");
  assert.equal(engine.evaluate({ tool: "file.write", input: { path: "a", content: "x" }, taskMode: "accept-edits" }).action, "allow");
  assert.equal(engine.evaluate({ tool: "file.read", input: { path: "a" }, taskMode: "bogus" }).action, "allow");
  assert.ok(PERMISSION_MODES.includes("restricted"));
});

test("settings are read without trusting extra keys", () => {
  const engine = permissionEngineFromSettings({
    mode: "plan",
    permissions: { allow: ["file.read:src/**", 42, null], ask: ["file.edit"], deny: ["shell.run"] },
    injected: "ignore me",
  });
  assert.equal(engine.mode, "plan");
  assert.deepEqual(engine.rules.allow, ["file.read:src/**"]);
  assert.equal(engine.evaluate({ tool: "file.edit", input: { path: "a.js", find: "x" }, taskMode: "plan" }).action, "ask");
  assert.equal(permissionEngineFromSettings(null).mode, "manual");
});
