// Run with:  node --test tests/task-events.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createEventLog } from "../agent/event-log.js";
import { validateEvent } from "../protocol/schemas.js";

test("events are sequenced, valid and timestamped", () => {
  const log = createEventLog({ taskId: "task_1", now: () => "2026-11-27T10:00:00.000Z" });
  const first = log.append("task_created", { goal: "fix tests" });
  const second = log.append("tool_started", { tool: "file.read", input: { path: "a.js" } });
  assert.equal(first.ok, true);
  assert.equal(first.event.sequence, 1);
  assert.equal(second.event.sequence, 2);
  assert.equal(second.event.timestamp, "2026-11-27T10:00:00.000Z");
  for (const event of log.all()) assert.equal(validateEvent(event).ok, true);
});

test("replay from a sequence supports Last-Event-ID reconnect", () => {
  const log = createEventLog({ taskId: "task_1" });
  for (let i = 0; i < 5; i += 1) log.append("assistant_message", { message: "m" + i });
  assert.equal(log.since(0).length, 5);
  assert.deepEqual(log.since(3).map((event) => event.sequence), [4, 5]);
  assert.equal(log.since(99).length, 0);
  assert.equal(log.lastSequence(), 5);
});

test("an invalid event type is refused without consuming a sequence", () => {
  const log = createEventLog({ taskId: "task_1" });
  const bad = log.append("exec_shell", { command: "rm -rf /" });
  assert.equal(bad.ok, false);
  const good = log.append("tool_started", { tool: "file.read" });
  assert.equal(good.event.sequence, 1);
  assert.equal(log.all().length, 1);
});

test("the log keeps a bounded window and reports what it dropped", () => {
  const log = createEventLog({ taskId: "task_1", limit: 3 });
  for (let i = 0; i < 6; i += 1) log.append("tool_output", { text: "line" + i });
  assert.equal(log.all().length, 3);
  assert.equal(log.dropped(), 3);
  assert.equal(log.lastSequence(), 6);
  assert.deepEqual(log.since(4).map((event) => event.sequence), [5, 6]);
});

test("subscribers receive events in order and can unsubscribe", () => {
  const log = createEventLog({ taskId: "task_1" });
  const seen = [];
  const unsubscribe = log.subscribe((event) => seen.push(event.sequence));
  log.append("tool_started", { tool: "file.read" });
  log.append("tool_finished", { tool: "file.read", ok: true });
  unsubscribe();
  log.append("task_completed", {});
  assert.deepEqual(seen, [1, 2]);
  const broken = log.subscribe(() => { throw new Error("listener failed"); });
  assert.equal(log.append("task_paused", {}).ok, true, "a broken listener cannot break the task");
  broken();
});

test("oversized payloads are refused instead of flooding the stream", () => {
  const log = createEventLog({ taskId: "task_1" });
  const result = log.append("tool_output", { text: "x".repeat(100_000), blob: "y".repeat(100_000), extra: "z".repeat(100_000) });
  assert.equal(result.ok, false);
  assert.equal(log.all().length, 0);
});
