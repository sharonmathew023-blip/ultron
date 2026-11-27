// Run with:  node --test tests/agent-loop.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentLoop } from "../agent/agent-loop.js";
import { createToolRegistry } from "../agent/tool-registry.js";
import { createPermissionEngine } from "../agent/permission-engine.js";
import { createApprovalStore } from "../authorization/approval-store.js";
import { validateEvent } from "../protocol/schemas.js";

const readExecutor = (input) => ({ path: input.path, content: "export const a = 1;" });
const editExecutor = (input) => ({ ok: true, path: input.path, created: false, diff: "--- a/" + input.path + "\n+++ b/" + input.path + "\n-a\n+b" });

function harness({ mode = "manual", calls, rules = {}, plan = ["Inspect the code"], message = "All checks passed." } = {}) {
  const registry = createToolRegistry({ executors: { "file.read": readExecutor, "file.edit": editExecutor, "file.delete": editExecutor } });
  const permissions = createPermissionEngine({ mode, rules });
  const approvals = createApprovalStore();
  const planner = async ({ phase }) => (phase === "plan"
    ? { plan, calls }
    : { message, verification: [{ check: "file.read", status: "passed" }] });
  const loop = createAgentLoop({ registry, permissions, approvals, planner });
  const record = loop.create({ taskId: "task_1", userId: "user_a", workspaceId: "ws_1", goal: "Fix the test", mode });
  return { loop, record, approvals, registry };
}

test("an allowed read run plans, executes, summarizes and completes", async () => {
  const { loop, record } = harness({ calls: [{ tool: "file.read", input: { path: "src/a.js" } }] });
  const result = await loop.start(record);
  assert.equal(result.ok, true);
  assert.equal(result.state, "completed");
  assert.equal(record.task.state, "completed");
  const types = record.log.all().map((event) => event.type);
  assert.deepEqual(types[0], "task_created");
  assert.ok(types.includes("plan_created"));
  assert.ok(types.includes("tool_started"));
  assert.ok(types.includes("tool_finished"));
  assert.equal(types[types.length - 1], "task_completed");
  for (const event of record.log.all()) assert.equal(validateEvent(event).ok, true);
  assert.equal(record.results.length, 1);
  assert.equal(record.results[0].ok, true);
});

test("an edit pauses for approval, then resumes and completes", async () => {
  const { loop, record, approvals } = harness({
    calls: [{ tool: "file.edit", input: { path: "src/auth.js", find: "a", replace: "b" }, reason: "Fix the redirect." }],
  });
  const paused = await loop.start(record);
  assert.equal(paused.state, "waiting_for_approval");
  assert.equal(record.task.state, "waiting_for_approval");
  assert.equal(approvals.listForTask("task_1").length, 1);
  const approvalEvent = record.log.all().find((event) => event.type === "tool_approval_required");
  assert.equal(approvalEvent.reason, "Fix the redirect.");
  assert.equal(approvalEvent.tool, "file.edit");

  const denied = await loop.resume(record, { approvalId: paused.approvalId, userId: "user_b", decision: "once" });
  assert.equal(denied.ok, false, "another account cannot approve");

  const resumed = await loop.resume(record, { approvalId: paused.approvalId, userId: "user_a", decision: "once" });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state, "completed");
  const types = record.log.all().map((event) => event.type);
  assert.ok(types.includes("tool_approval_decided"));
  assert.ok(types.includes("diff_available"));
  assert.ok(types.includes("file_changed"));
});

test("denying the edit skips it, still summarizes, and records the denial", async () => {
  const { loop, record } = harness({ calls: [{ tool: "file.edit", input: { path: "src/a.js", find: "a" } }] });
  const paused = await loop.start(record);
  const resumed = await loop.resume(record, { approvalId: paused.approvalId, userId: "user_a", decision: "deny" });
  assert.equal(resumed.ok, true);
  assert.equal(record.task.state, "completed");
  assert.equal(record.results.some((entry) => entry.denied === true), true);
});

test("allow-for-task covers repeat calls without a second prompt", async () => {
  const { loop, record } = harness({
    calls: [
      { tool: "file.edit", input: { path: "src/a.js", find: "a" } },
      { tool: "file.edit", input: { path: "src/b.js", find: "b" } },
    ],
  });
  const paused = await loop.start(record);
  const resumed = await loop.resume(record, { approvalId: paused.approvalId, userId: "user_a", decision: "task" });
  assert.equal(resumed.state, "completed");
  assert.equal(record.results.filter((entry) => entry.ok).length, 2);
});

test("plan mode never runs an edit without approval", async () => {
  const { loop, record } = harness({ mode: "plan", calls: [{ tool: "file.edit", input: { path: "src/a.js", find: "a" } }] });
  const result = await loop.start(record);
  assert.equal(result.state, "waiting_for_approval");
  assert.equal(record.results.length, 0);
});

test("a denied tool is refused by the engine and never reaches the registry", async () => {
  const { loop, record, registry } = harness({
    mode: "restricted",
    calls: [{ tool: "file.read", input: { path: "src/a.js" } }],
  });
  let executed = 0;
  const spy = createToolRegistry({ executors: { "file.read": (input) => { executed += 1; return readExecutor(input); } } });
  assert.equal(registry.has("file.read"), true);
  assert.equal(spy.has("file.read"), true);
  const result = await loop.start(record);
  assert.equal(result.ok, true);
  assert.equal(record.results[0].denied, true);
  assert.equal(record.results[0].ok, false);
});

test("unknown and malformed tool calls are recorded as failures, not crashes", async () => {
  const { loop, record } = harness({
    calls: [
      { tool: "shell.exec", input: { command: "rm -rf /" } },
      { tool: "file.read", input: { path: "a.js", shell: "id" } },
      { tool: "file.read" },
    ],
  });
  const result = await loop.start(record);
  assert.equal(result.state, "completed");
  assert.equal(record.results.length, 3);
  assert.ok(record.results.every((entry) => entry.ok === false));
  assert.ok(record.log.all().some((event) => event.type === "tool_finished" && event.ok === false));
});

test("cancelling a queued task is terminal and emits one event", async () => {
  const { loop, record } = harness({ calls: [] });
  const cancelled = loop.cancel(record);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(record.task.state, "cancelled");
  assert.equal(record.log.all().filter((event) => event.type === "task_cancelled").length, 1);
  assert.equal((await loop.start(record)).ok, false, "a cancelled task cannot be started");
});

test("a planner failure marks the task failed, never complete", async () => {
  const registry = createToolRegistry({ executors: { "file.read": readExecutor } });
  const loop = createAgentLoop({
    registry,
    permissions: createPermissionEngine({ mode: "manual" }),
    approvals: createApprovalStore(),
    planner: async () => { throw new Error("model unavailable"); },
  });
  const record = loop.create({ taskId: "task_9", userId: "user_a", goal: "Do work" });
  const result = await loop.start(record);
  assert.equal(result.ok, false);
  assert.equal(record.task.state, "failed");
  assert.match(record.task.error, /model unavailable/);
  assert.equal(record.log.all().some((event) => event.type === "task_completed"), false);
});

test("publicTask exposes state without leaking internal records", async () => {
  const { loop, record } = harness({ calls: [] });
  await loop.start(record);
  const view = loop.publicTask(record);
  assert.equal(view.id, "task_1");
  assert.equal(view.state, "completed");
  assert.equal(view.owner, "user_a");
  assert.equal(view.pendingApproval, null);
  assert.equal(Object.prototype.hasOwnProperty.call(view, "log"), false);
});
