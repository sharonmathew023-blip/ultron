// Run with:  node --test tests/runtime-daemon.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../runtime/local-daemon.js";

async function startDaemon() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ultron-daemon-"));
  fs.writeFileSync(path.join(root, "app.js"), "export const answer = 42;\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "GEMINI_API_KEY=fake-sentinel\n", "utf8");
  const daemon = createDaemon({ root, owner: "owner@example.com", mode: "manual" });
  const address = await daemon.listen(0);
  const base = "http://127.0.0.1:" + address.port;
  const paired = await post(base + "/pair", { workspaceId: daemon.workspaceId, code: daemon.pairingCode });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  const token = paired.body.token;
  const call = (method, route, body) => fetch(base + route, {
    method,
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null), headers: response.headers }));
  return { root, daemon, base, token, call, close: async () => { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

async function post(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("the daemon requires a pairing token for every task route", async () => {
  const env = await startDaemon();
  try {
    assert.equal((await fetch(env.base + "/workspace")).status, 401);
    assert.equal((await fetch(env.base + "/tasks", { method: "POST", body: "{}" })).status, 401);
    const wrong = await post(env.base + "/pair", { workspaceId: env.daemon.workspaceId, code: "BADCODE" });
    assert.equal(wrong.status, 403);
    const workspace = await env.call("GET", "/workspace");
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.workspace.owner, "owner@example.com");
    assert.ok(workspace.body.tools.some((tool) => tool.name === "file.read"));
    assert.equal(workspace.body.tools.some((tool) => tool.risk === "external"), false);
    assert.equal(workspace.body.workspace.network, "disabled-by-default");
  } finally {
    await env.close();
  }
});

test("read tools work inside the workspace and refuse everything outside it", async () => {
  const env = await startDaemon();
  try {
    const task = await env.call("POST", "/tasks", { goal: "Inspect the project" });
    assert.equal(task.status, 201);
    const taskId = task.body.task.taskId;

    const read = await env.call("POST", "/tasks/" + taskId + "/tools/file.read", { input: { path: "app.js" } });
    assert.equal(read.status, 200);
    assert.match(read.body.result.content, /answer = 42/);

    for (const bad of [{ path: "../outside.txt" }, { path: "/etc/passwd" }, { path: ".env" }, { path: ".ssh/id_rsa" }]) {
      const refused = await env.call("POST", "/tasks/" + taskId + "/tools/file.read", { input: bad });
      assert.equal(refused.status, 400, JSON.stringify(bad));
      assert.equal(refused.body.ok, false);
    }

    const unknown = await env.call("POST", "/tasks/" + taskId + "/tools/shell.exec", { input: {} });
    assert.equal(unknown.status, 404);
    const extraField = await env.call("POST", "/tasks/" + taskId + "/tools/file.read", { input: { path: "app.js", shell: "id" } });
    assert.equal(extraField.status, 400);
  } finally {
    await env.close();
  }
});

test("a write pauses for approval, applies only after approval, and can be undone", async () => {
  const env = await startDaemon();
  try {
    const task = await env.call("POST", "/tasks", { goal: "Add a file" });
    const taskId = task.body.task.taskId;
    const write = await env.call("POST", "/tasks/" + taskId + "/tools/file.write", {
      input: { path: "src/new.js", content: "export const added = true;\n" },
      reason: "Create the new module.",
    });
    assert.equal(write.status, 202);
    assert.equal(fs.existsSync(path.join(env.root, "src/new.js")), false, "nothing touches disk before approval");
    const approvalId = write.body.approval.id;

    const pending = await env.call("GET", "/tasks/" + taskId);
    assert.equal(pending.body.task.state, "waiting_for_approval");
    assert.equal(pending.body.task.pendingApprovals.length, 1);

    const approved = await env.call("POST", "/tasks/" + taskId + "/approvals/" + approvalId, { decision: "once" });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.result.ok, true);
    assert.equal(fs.readFileSync(path.join(env.root, "src/new.js"), "utf8"), "export const added = true;\n");

    const undone = await env.call("POST", "/tasks/" + taskId + "/undo");
    assert.equal(undone.status, 200);
    assert.equal(fs.existsSync(path.join(env.root, "src/new.js")), false);
  } finally {
    await env.close();
  }
});

test("commands are policy-checked in the daemon, and an approval is bound to its task", async () => {
  const env = await startDaemon();
  try {
    const first = await env.call("POST", "/tasks", { goal: "Run the tests" });
    const firstId = first.body.task.taskId;
    const denied = await env.call("POST", "/tasks/" + firstId + "/tools/shell.run", { input: { command: "sudo rm -rf /" } });
    assert.equal(denied.status, 403);

    const allowed = await env.call("POST", "/tasks/" + firstId + "/tools/shell.run", { input: { command: "node --version" } });
    assert.equal(allowed.status, 202);
    const approvalId = allowed.body.approval.id;

    const second = await env.call("POST", "/tasks", { goal: "Other work" });
    const secondId = second.body.task.taskId;
    const foreign = await env.call("POST", "/tasks/" + secondId + "/approvals/" + approvalId, { decision: "once" });
    assert.equal(foreign.status, 404, "an approval cannot be used from another task");

    const approved = await env.call("POST", "/tasks/" + firstId + "/approvals/" + approvalId, { decision: "once" });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.result.ok, true);
    assert.equal(approved.body.result.result.exitCode, 0);
  } finally {
    await env.close();
  }
});

test("cancelling a task is terminal and blocks further tool calls", async () => {
  const env = await startDaemon();
  try {
    const task = await env.call("POST", "/tasks", { goal: "Cancel me" });
    const taskId = task.body.task.taskId;
    const cancelled = await env.call("POST", "/tasks/" + taskId + "/cancel");
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task.state, "cancelled");
    const blocked = await env.call("POST", "/tasks/" + taskId + "/tools/file.read", { input: { path: "app.js" } });
    assert.equal(blocked.status, 409);
  } finally {
    await env.close();
  }
});

test("the event stream replays from the beginning as Server-Sent Events", async () => {
  const env = await startDaemon();
  try {
    const task = await env.call("POST", "/tasks", { goal: "Stream events" });
    const taskId = task.body.task.taskId;
    const controller = new AbortController();
    const response = await fetch(env.base + "/tasks/" + taskId + "/events?after=0", {
      headers: { authorization: "Bearer " + env.token },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    const chunk = await reader.read();
    controller.abort();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /event: task_created/);
    assert.match(text, /^id: 1$/m);
  } finally {
    await env.close();
  }
});
