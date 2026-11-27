// Run with:  node --test tests/protocol.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION, TASK_STATES, TERMINAL_TASK_STATES, EVENT_TYPES, TOOL_SPECS,
  canTransition, isTaskState, isTool, toolRisk, validateToolInput, validateEvent, ruleTool, ruleTarget,
} from "../protocol/schemas.js";
import { createEvent, formatSse, parseAfter, sseHeaders } from "../protocol/task-events.js";

test("protocol version and tool registry are declared and frozen", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.ok(Object.isFrozen(TOOL_SPECS));
  for (const [name, spec] of Object.entries(TOOL_SPECS)) {
    assert.ok(["read", "write", "command", "external"].includes(spec.risk), name);
    assert.ok(spec.description.length > 10, name);
    assert.ok(Object.isFrozen(spec.params), name);
  }
});

test("there is no unrestricted shell or external tool in the first registry", () => {
  assert.equal(isTool("shell.exec"), false);
  assert.equal(isTool("shell.run"), true);
  assert.equal(toolRisk("shell.run"), "command");
  assert.equal(isTool("github.create_pull_request"), false);
  assert.equal(isTool("mcp.call"), false);
  assert.equal(toolRisk("nope"), null);
});

test("file.read accepts only declared fields and rebuilds the input", () => {
  const ok = validateToolInput("file.read", { path: "src/auth.js", maxLines: 50 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.input, { path: "src/auth.js", maxLines: 50 });
  assert.equal(validateToolInput("file.read", { path: "a.js", shell: "id" }).ok, false);
  assert.equal(validateToolInput("file.read", {}).ok, false);
  assert.equal(validateToolInput("file.read", { path: "/etc/passwd" }).ok, true, "policy rejects absolutes later");
  assert.equal(validateToolInput("file.read", { path: "a".repeat(2000) }).ok, false);
  assert.equal(validateToolInput("file.read", { path: "a\u0000b" }).ok, false);
  assert.equal(validateToolInput("file.read", { path: "a.js", maxLines: 0 }).ok, false);
  assert.equal(validateToolInput("file.read", { path: "a.js", maxLines: 1.5 }).ok, false);
  assert.equal(validateToolInput("file.read", ["a.js"]).ok, false);
  assert.equal(validateToolInput("file.read", "a.js").ok, false);
});

test("write and command tools require their critical field", () => {
  assert.equal(validateToolInput("file.write", { path: "a.js", content: "x" }).ok, true);
  assert.equal(validateToolInput("file.write", { path: "a.js" }).ok, false);
  assert.equal(validateToolInput("shell.run", { command: "npm test" }).ok, true);
  assert.equal(validateToolInput("shell.run", {}).ok, false);
  assert.equal(validateToolInput("patch.apply", { path: "a.js", find: "x" }).ok, true);
});

test("unknown tools are rejected before any executor runs", () => {
  for (const name of ["__proto__", "constructor", "toString", "", null, undefined, 7, "file.read; rm"]) {
    assert.equal(isTool(name), false, String(name));
    assert.equal(validateToolInput(name, {}).ok, false, String(name));
  }
});

test("task state machine only allows declared transitions", () => {
  assert.deepEqual([...TASK_STATES], [
    "queued", "planning", "running", "waiting_for_approval", "waiting_for_user",
    "paused", "completed", "failed", "cancelled",
  ]);
  assert.equal(canTransition("queued", "planning"), true);
  assert.equal(canTransition("planning", "running"), true);
  assert.equal(canTransition("running", "waiting_for_approval"), true);
  assert.equal(canTransition("waiting_for_approval", "running"), true);
  for (const terminal of TERMINAL_TASK_STATES) {
    assert.equal(canTransition(terminal, "running"), false, terminal);
    assert.equal(isTaskState(terminal), true, terminal);
  }
  assert.equal(canTransition("queued", "completed"), false);
  assert.equal(canTransition("nonsense", "running"), false);
});

test("event types cover the roadmap and are frozen", () => {
  assert.ok(Object.isFrozen(EVENT_TYPES));
  for (const type of ["task_created", "plan_created", "tool_approval_required", "file_changed", "diff_available", "task_completed"]) {
    assert.ok(EVENT_TYPES.includes(type), type);
  }
  assert.equal(EVENT_TYPES.includes("exec"), false);
});

test("event envelopes are validated", () => {
  const base = { taskId: "task_1", sequence: 1, type: "tool_started", timestamp: "2026-11-27T10:00:00.000Z" };
  assert.equal(validateEvent(base).ok, true);
  assert.equal(validateEvent({ ...base, taskId: "" }).ok, false);
  assert.equal(validateEvent({ ...base, sequence: 0 }).ok, false);
  assert.equal(validateEvent({ ...base, sequence: "1" }).ok, false);
  assert.equal(validateEvent({ ...base, type: "made_up" }).ok, false);
  assert.equal(validateEvent({ ...base, timestamp: "not a date" }).ok, false);
  for (const junk of [null, undefined, "x", 5, []]) assert.equal(validateEvent(junk).ok, false);
});

test("createEvent caps long strings and drops dangerous keys", () => {
  const built = createEvent({
    taskId: "task_1", sequence: 3, type: "tool_output",
    text: "a".repeat(20000), "__proto__": { polluted: true }, nested: { "bad key!": 1, ok: true },
  });
  assert.equal(built.ok, true);
  assert.equal(built.event.text.length, 8000);
  assert.equal(built.event.nested.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(built.event, "bad key!"), false);
  assert.equal({}.polluted, undefined);
});

test("SSE framing uses the sequence as the event id and refuses invalid events", () => {
  const built = createEvent({ taskId: "task_1", sequence: 12, type: "file_changed", path: "src/a.js" });
  const frame = formatSse(built.event);
  assert.match(frame, /^id: 12\nevent: file_changed\ndata: \{/);
  assert.ok(frame.endsWith("\n\n"));
  assert.equal(JSON.parse(frame.split("data: ")[1].trim()).path, "src/a.js");
  assert.equal(formatSse({ taskId: "", sequence: 0, type: "nope" }), "");
  assert.equal(sseHeaders()["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(parseAfter("7"), 7);
  assert.equal(parseAfter("-2"), 0);
  assert.equal(parseAfter("abc"), 0);
});

test("rule helpers split tool from target without injecting", () => {
  assert.equal(ruleTool("file.read"), "file.read");
  assert.equal(ruleTool("file.read:src/**"), "file.read");
  assert.equal(ruleTarget("file.read"), "");
  assert.equal(ruleTarget("file.read:src/**"), "src/**");
  assert.equal(ruleTool(7), null);
  assert.equal(ruleTool(""), null);
});
