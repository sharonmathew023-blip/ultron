// Run with:  node --test tests/approval-store.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalStore, APPROVAL_TTL_MS } from "../authorization/approval-store.js";

function storeAt(clock) {
  return createApprovalStore({ now: () => clock.value, newId: (() => { let n = 0; return () => "ap_" + (++n); })() });
}

test("an approval is bound to its task and user", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const { approval } = store.request({ taskId: "task_1", userId: "user_a", tool: "file.edit", input: { path: "a.js", find: "x" }, reason: "Fix the test." });
  assert.equal(approval.status, "pending");
  assert.equal(approval.reason, "Fix the test.");
  assert.equal(store.decide(approval.id, { userId: "user_b", decision: "once" }).ok, false);
  assert.equal(store.get(approval.id).status, "pending", "a foreign decision changes nothing");
  assert.equal(store.decide(approval.id, { userId: "user_a", decision: "once" }).ok, true);
});

test("allow-once approves a single call and cannot be replayed", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const { approval } = store.request({ taskId: "task_1", userId: "user_a", tool: "shell.run", input: { command: "npm test" } });
  const decided = store.decide(approval.id, { userId: "user_a", decision: "once" });
  assert.equal(decided.ok, true);
  assert.equal(decided.decision, "once");
  assert.equal(store.hasTaskGrant("task_1", "shell.run"), false);
  assert.equal(store.decide(approval.id, { userId: "user_a", decision: "once" }).ok, false, "already decided");
});

test("allow-for-this-task grants repeat calls of that tool only", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const { approval } = store.request({ taskId: "task_1", userId: "user_a", tool: "shell.run", input: { command: "npm test" } });
  store.decide(approval.id, { userId: "user_a", decision: "task" });
  assert.equal(store.hasTaskGrant("task_1", "shell.run"), true);
  assert.equal(store.hasTaskGrant("task_2", "shell.run"), false);
  assert.equal(store.hasTaskGrant("task_1", "file.delete"), false);
});

test("deny is final and records the decision", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const { approval } = store.request({ taskId: "task_1", userId: "user_a", tool: "file.delete", input: { path: "a.js" } });
  const decided = store.decide(approval.id, { userId: "user_a", decision: "deny" });
  assert.equal(decided.decision, "deny");
  assert.equal(store.hasTaskGrant("task_1", "file.delete"), false);
  assert.equal(store.get(approval.id), null);
});

test("unknown decisions and approvals are rejected", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const { approval } = store.request({ taskId: "task_1", userId: "user_a", tool: "file.edit", input: {} });
  assert.equal(store.decide(approval.id, { userId: "user_a", decision: "always" }).ok, false);
  assert.equal(store.decide("missing", { userId: "user_a", decision: "once" }).ok, false);
  assert.equal(store.decide(approval.id, { userId: undefined, decision: "once" }).ok, false);
});

test("approvals expire and cannot be approved later", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const { approval } = store.request({ taskId: "task_1", userId: "user_a", tool: "file.edit", input: {} });
  clock.value += APPROVAL_TTL_MS + 1;
  assert.equal(store.get(approval.id), null);
  assert.equal(store.decide(approval.id, { userId: "user_a", decision: "once" }).ok, false);
});

test("an identical pending request is reused instead of duplicated", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const first = store.request({ taskId: "task_1", userId: "user_a", tool: "file.edit", input: { path: "a.js", find: "x" } });
  const second = store.request({ taskId: "task_1", userId: "user_a", tool: "file.edit", input: { path: "a.js", find: "x" } });
  assert.equal(first.approval.id, second.approval.id);
  assert.equal(second.reused, true);
  const third = store.request({ taskId: "task_1", userId: "user_a", tool: "file.edit", input: { path: "b.js", find: "x" } });
  assert.notEqual(third.approval.id, first.approval.id);
});

test("cancelling a task drops its approvals and grants", () => {
  const clock = { value: 1000 };
  const store = storeAt(clock);
  const { approval } = store.request({ taskId: "task_1", userId: "user_a", tool: "shell.run", input: { command: "npm test" } });
  store.grantForTask("task_1", "shell.run", "user_a");
  assert.equal(store.listForTask("task_1").length, 1);
  store.dropForTask("task_1");
  assert.equal(store.listForTask("task_1").length, 0);
  assert.equal(store.hasTaskGrant("task_1", "shell.run"), false);
  assert.equal(store.decide(approval.id, { userId: "user_a", decision: "once" }).ok, false);
});
