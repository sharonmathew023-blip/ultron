// ULTRON local companion runtime.
//
// A small Node.js daemon that runs on the developer's machine, is paired with ULTRON by a
// one-time code, and exposes only the validated tool registry over a token-authenticated
// HTTP API. The Worker stays the orchestrator: it never talks to the filesystem directly,
// and this daemon never calls a model and never holds a provider key.
//
// Deliberately absent: any route that runs a command the command policy did not approve,
// any route that reads outside the paired workspace, and any route the browser can call
// without the pairing token.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPathPolicy } from "../authorization/path-policy.js";
import { createCommandPolicy } from "../authorization/command-policy.js";
import { createApprovalStore } from "../authorization/approval-store.js";
import { createPermissionEngine } from "../agent/permission-engine.js";
import { createToolRegistry, isMutatingTool } from "../agent/tool-registry.js";
import { createEventLog } from "../agent/event-log.js";
import { canTransition, isTool, validateToolInput } from "../protocol/schemas.js";
import { formatSse, parseAfter, sseHeaders, sseHello } from "../protocol/task-events.js";
import { createWorkspaceManager } from "./workspace-manager.js";
import { createPatchManager } from "./patch-manager.js";
import { createCommandRunner } from "./command-runner.js";
import { createToolExecutors } from "./tool-executors.js";
import { SANDBOX_LIMITS } from "./sandbox-policy.js";

const MAX_BODY_BYTES = 2_000_000;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error).slice(0, 300);
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        resolve({ ok: false, error: "Request body is too large." });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({ ok: true, value: {} });
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return resolve({ ok: false, error: "Body must be a JSON object." });
        }
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, error: "Body is not valid JSON." });
      }
    });
    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: "Could not read the request body." });
      }
    });
  });
}

function bearer(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

export function createDaemon({
  root,
  owner,
  mode = "manual",
  permissions = {},
  commandPolicy = createCommandPolicy(),
  protectedPatterns,
  fs,
  now = () => Date.now(),
} = {}) {
  if (!root) throw new Error("A workspace root is required.");
  if (!owner) throw new Error("A workspace owner is required.");

  const workspaces = createWorkspaceManager({ now });
  const pathPolicy = createPathPolicy({ root, protectedPatterns });
  const policy = Object.freeze({ ...pathPolicy, commandPolicy });
  const patchManager = createPatchManager({ policy, ...(fs ? { fs } : {}) });
  const commandRunner = createCommandRunner({ policy, limits: SANDBOX_LIMITS });
  const executors = createToolExecutors({ policy, patchManager, commandRunner, ...(fs ? { fs } : {}) });
  const registry = createToolRegistry({ executors });
  const engine = createPermissionEngine({ mode, rules: permissions, commandPolicy });
  const approvals = createApprovalStore({ now });
  const tasks = new Map();
  const clock = () => new Date(now()).toISOString();

  const registration = workspaces.register({ root, owner });

  function authenticate(req) {
    const authorized = workspaces.authorize(bearer(req));
    if (!authorized.ok) return authorized;
    return authorized;
  }

  function emit(task, type, payload) {
    const result = task.log.append(type, payload);
    return result.ok ? result.event : null;
  }

  function taskState(task, next) {
    if (task.state === next) return;
    if (!canTransition(task.state, next)) return;
    task.state = next;
  }

  // A task in this gateway starts executing at its first tool call.
  function ensureRunning(task) {
    if (task.state === "queued") taskState(task, "planning");
    if (task.state === "planning") taskState(task, "running");
  }

  function taskBody(task) {
    return {
      taskId: task.id,
      goal: task.goal,
      state: task.state,
      mode: task.mode,
      owner: task.owner,
      createdAt: task.createdAt,
      pendingApprovals: approvals.listForTask(task.id).map((approval) => ({
        id: approval.id,
        tool: approval.tool,
        input: approval.input,
        reason: approval.reason,
        expiresAt: approval.expiresAt,
      })),
      changedPaths: patchManager.changedPaths(task.id),
      lastSequence: task.log.lastSequence(),
    };
  }

  async function executeCall(task, tool, input, reason, { bypassApproval = false } = {}) {
    ensureRunning(task);
    const decision = engine.evaluate({ tool, input, taskMode: task.mode });
    if (decision.action === "deny") return { status: 403, body: { ok: false, error: decision.reason } };
    if (decision.action === "ask" && !bypassApproval) {
      const requested = approvals.request({ taskId: task.id, userId: task.owner, tool, input, reason: reason || decision.reason });
      if (!requested.ok) return { status: 500, body: { ok: false, error: "Could not record approval request." } };
      emit(task, "tool_approval_required", {
        approvalId: requested.approval.id,
        tool,
        input,
        reason: requested.approval.reason,
        expiresAt: requested.approval.expiresAt,
      });
      taskState(task, "waiting_for_approval");
      return { status: 202, body: { ok: true, state: "waiting_for_approval", approval: { id: requested.approval.id, tool, reason: requested.approval.reason, expiresAt: requested.approval.expiresAt } } };
    }

    emit(task, "tool_started", { tool, input });
    const outcome = await registry.execute(tool, input, {
      taskId: task.id,
      userId: task.owner,
      onOutput: (chunk) => emit(task, "tool_output", { tool, stream: chunk.stream, text: chunk.text }),
    });
    if (outcome.ok && isMutatingTool(tool)) {
      const detail = outcome.result || {};
      if (typeof detail.diff === "string" && detail.diff) {
        emit(task, "diff_available", { tool, path: detail.path || null, diff: detail.diff });
      }
      emit(task, "file_changed", { tool, path: detail.path || null, created: Boolean(detail.created) });
    }
    emit(task, "tool_finished", { tool, ok: outcome.ok, error: outcome.ok ? undefined : outcome.error });
    if (task.state !== "cancelled") taskState(task, "running");
    return { status: outcome.ok ? 200 : 400, body: outcome };
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const route = url.pathname;
    const method = req.method || "GET";

    if (method === "GET" && route === "/health") {
      return json(res, 200, { ok: true, protocol: 1, paired: true, tools: registry.available() });
    }

    // Pairing is the only unauthenticated route besides /health. It needs the one-time code.
    if (method === "POST" && route === "/pair") {
      const body = await readBody(req);
      if (!body.ok) return json(res, 400, { ok: false, error: body.error });
      const paired = workspaces.pair({
        workspaceId: typeof body.value.workspaceId === "string" ? body.value.workspaceId : registration.workspaceId,
        code: typeof body.value.code === "string" ? body.value.code : body.value.pairingCode,
      });
      if (!paired.ok) return json(res, 403, { ok: false, error: paired.error });
      return json(res, 200, { ok: true, workspaceId: paired.workspaceId, token: paired.token, expiresAt: paired.expiresAt });
    }

    const authorized = authenticate(req);
    if (!authorized.ok) return json(res, 401, { ok: false, error: authorized.error });
    const workspace = authorized.workspace;

    if (method === "GET" && route === "/workspace") {
      return json(res, 200, {
        ok: true,
        workspace: { id: workspace.id, label: workspace.label, root: workspace.root, owner: workspace.owner, network: workspace.network },
        tools: registry.declarations(),
        mode: engine.mode,
      });
    }

    if (method === "POST" && route === "/tasks") {
      const body = await readBody(req);
      if (!body.ok) return json(res, 400, { ok: false, error: body.error });
      const goal = typeof body.value.goal === "string" ? body.value.goal.trim() : "";
      if (!goal) return json(res, 400, { ok: false, error: "A goal is required." });
      const taskId = "task_" + randomUUID();
      const task = {
        id: taskId,
        owner: workspace.owner,
        goal: goal.slice(0, 4000),
        mode: ["plan", "manual", "accept-edits", "restricted"].includes(body.value.mode) ? body.value.mode : engine.mode,
        state: "queued",
        createdAt: now(),
        log: createEventLog({ taskId, now: clock }),
      };
      tasks.set(taskId, task);
      emit(task, "task_created", { goal: task.goal, owner: task.owner, mode: task.mode });
      return json(res, 201, { ok: true, task: taskBody(task) });
    }

    const taskMatch = /^\/tasks\/([A-Za-z0-9_-]{1,128})(\/.*)?$/.exec(route);
    if (!taskMatch) return json(res, 404, { ok: false, error: "Not found." });
    const task = tasks.get(taskMatch[1]);
    if (!task) return json(res, 404, { ok: false, error: "Unknown task." });
    if (task.owner !== workspace.owner) return json(res, 403, { ok: false, error: "Task belongs to another account." });
    const rest = taskMatch[2] || "";

    if (method === "GET" && rest === "") return json(res, 200, { ok: true, task: taskBody(task) });

    if (method === "GET" && rest === "/events") {
      const after = parseAfter(url.searchParams.get("after") || req.headers["last-event-id"]);
      res.writeHead(200, sseHeaders());
      res.write(sseHello());
      for (const event of task.log.since(after)) res.write(formatSse(event));
      const unsubscribe = task.log.subscribe((event) => {
        try { res.write(formatSse(event)); } catch { /* the client went away */ }
      });
      const heartbeat = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { /* closed */ }
      }, 20000);
      heartbeat.unref?.();
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      };
      req.on("close", close);
      req.on("error", close);
      return;
    }

    if (method === "POST" && rest.startsWith("/tools/")) {
      const tool = decodeURIComponent(rest.slice("/tools/".length));
      if (!isTool(tool)) return json(res, 404, { ok: false, error: "Unknown tool." });
      const body = await readBody(req);
      if (!body.ok) return json(res, 400, { ok: false, error: body.error });
      const checked = validateToolInput(tool, body.value.input);
      if (!checked.ok) return json(res, 400, { ok: false, error: checked.error });
      if (task.state === "cancelled") return json(res, 409, { ok: false, error: "Task is cancelled." });
      const outcome = await executeCall(task, tool, checked.input, body.value.reason, {
        bypassApproval: Boolean(body.value.approvalId) && approvals.hasTaskGrant(task.id, tool),
      });
      return json(res, outcome.status, outcome.body);
    }

    if (method === "POST" && rest.startsWith("/approvals/")) {
      const approvalId = decodeURIComponent(rest.slice("/approvals/".length));
      const body = await readBody(req);
      if (!body.ok) return json(res, 400, { ok: false, error: body.error });
      const approval = approvals.get(approvalId);
      if (!approval || approval.taskId !== task.id) return json(res, 404, { ok: false, error: "Unknown approval." });
      const decided = approvals.decide(approvalId, { userId: task.owner, decision: body.value.decision });
      if (!decided.ok) return json(res, 400, { ok: false, error: decided.error });
      emit(task, "tool_approval_decided", { approvalId, decision: decided.decision });
      emit(task, "task_resumed", { approvalId, decision: decided.decision });
      if (decided.decision === "deny") {
        emit(task, "tool_finished", { tool: approval.tool, ok: false, error: "Denied by the user." });
        taskState(task, "running");
        return json(res, 200, { ok: true, decision: "deny", task: taskBody(task) });
      }
      taskState(task, "running");
      const outcome = await executeCall(task, approval.tool, approval.input, approval.reason, { bypassApproval: true });
      return json(res, 200, { ok: true, decision: decided.decision, result: outcome.body, task: taskBody(task) });
    }

    if (method === "POST" && rest === "/cancel") {
      taskState(task, "cancelled");
      approvals.dropForTask(task.id);
      emit(task, "task_cancelled", {});
      return json(res, 200, { ok: true, task: taskBody(task) });
    }

    if (method === "POST" && rest === "/undo") {
      const undone = patchManager.undo(task.id);
      return json(res, undone.ok ? 200 : 400, undone);
    }

    return json(res, 404, { ok: false, error: "Not found." });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { ok: false, error: errorMessage(error) });
      else res.end();
    });
  });

  return Object.freeze({
    server,
    workspaceId: registration.workspaceId,
    pairingCode: registration.pairingCode,
    root: registration.root,
    mode: engine.mode,
    tools: registry.available(),
    registration,
    listen(port = 4319, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  });
}

// CLI: node runtime/local-daemon.js --root . --owner you@example.com [--port 4319]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg.startsWith("--")) args.set(arg.slice(2), process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[++i] : "");
  }
  const owner = args.get("owner") || process.env.ULTRON_DAEMON_OWNER || "";
  const root = args.get("root") || process.cwd();
  const port = Number(args.get("port") || 4319);
  if (!owner) {
    console.error("ULTRON runtime: --owner is required so tasks are bound to one account.");
    process.exit(1);
  }
  try {
    const daemon = createDaemon({ root, owner, mode: args.get("mode") || "manual" });
    const address = await daemon.listen(port);
    console.log("ULTRON coding runtime");
    console.log("  workspace : " + daemon.root);
    console.log("  workspace : " + daemon.workspaceId);
    console.log("  listening : http://" + address.address + ":" + address.port);
    console.log("  tools     : " + daemon.tools.join(", "));
    console.log("");
    console.log("Pair this runtime in ULTRON with this one-time code: " + daemon.pairingCode);
    console.log("The code expires in 10 minutes. Nothing outside " + daemon.root + " is reachable.");
  } catch (error) {
    console.error("ULTRON runtime failed to start: " + errorMessage(error));
    process.exit(1);
  }
}
