// ULTRON agent loop.
// One observable loop: plan -> named tool -> permission check -> approval if needed ->
// execute -> sanitize -> record -> summarize. The loop never runs a command itself; it
// only calls the registry.
//
// The planner is injected, so the same loop is driven by the Worker, a test double, or a
// subagent without giving the model any direct execution path.

import { createEventLog } from "./event-log.js";
import { addPlanStep, addStepResult, createTask, isTerminal, transition } from "./task-state.js";
import { isMutatingTool } from "./tool-registry.js";
import { validateToolInput } from "../protocol/schemas.js";

export const LOOP_LIMITS = Object.freeze({ maxToolCalls: 40, maxResultsInContext: 20 });

function errorText(error) {
  return String(error && error.message ? error.message : error).slice(0, 300);
}

export function createAgentLoop({
  registry,
  permissions,
  approvals,
  planner,
  now = () => Date.now(),
  clock = () => new Date().toISOString(),
  limits = LOOP_LIMITS,
} = {}) {
  if (!registry) throw new Error("A tool registry is required.");
  if (!permissions) throw new Error("A permission engine is required.");
  if (!approvals) throw new Error("An approval store is required.");
  if (typeof planner !== "function") throw new Error("A planner function is required.");

  const records = new Map();

  function emit(record, type, payload) {
    const result = record.log.append(type, payload);
    return result.ok ? result.event : null;
  }

  function setState(record, next, patch) {
    const result = transition(record.task, next, { now, patch });
    if (!result.ok) return result;
    record.task = result.task;
    return result;
  }

  function create({ taskId, userId, workspaceId, goal, mode }) {
    const task = createTask({ id: taskId, userId, workspaceId, goal, mode, now });
    const record = {
      taskId,
      log: createEventLog({ taskId, now: clock }),
      task,
      pending: null,
      results: [],
      cancelRequested: false,
      finished: false,
    };
    records.set(taskId, record);
    emit(record, "task_created", { goal: task.goal, userId, workspaceId: workspaceId || null, mode: task.mode });
    return record;
  }

  function publicTask(record) {
    return {
      id: record.task.id,
      goal: record.task.goal,
      state: record.task.state,
      mode: record.task.mode,
      plan: record.task.plan,
      steps: record.task.steps,
      error: record.task.error,
      owner: record.task.userId,
      workspaceId: record.task.workspaceId,
      createdAt: record.task.createdAt,
      updatedAt: record.task.updatedAt,
      pendingApproval: record.pending ? record.pending.approvalId || null : null,
    };
  }

  async function runCall(record, call) {
    const tool = call && call.tool;
    const input = call && call.input;
    const checked = validateToolInput(tool, input);
    if (!checked.ok) {
      emit(record, "tool_finished", { tool: String(tool || "unknown"), ok: false, error: checked.error });
      record.results.push({ tool: String(tool || "unknown"), ok: false, error: checked.error });
      return { ok: false, error: checked.error };
    }
    if (!registry.has(tool)) {
      const error = "Tool is not enabled in this runtime.";
      emit(record, "tool_finished", { tool, ok: false, error });
      record.results.push({ tool, ok: false, error });
      return { ok: false, error };
    }
    emit(record, "tool_started", { tool, input: checked.input });
    const outcome = await registry.execute(tool, checked.input, {
      taskId: record.taskId,
      workspaceId: record.task.workspaceId,
      userId: record.task.userId,
      onOutput: (chunk) => emit(record, "tool_output", { tool, stream: chunk.stream, text: chunk.text }),
    });
    record.results.push({ tool, ok: outcome.ok, result: outcome.ok ? outcome.result : undefined, error: outcome.error });
    if (outcome.ok && isMutatingTool(tool)) {
      const diff = outcome.result && typeof outcome.result.diff === "string" ? outcome.result.diff : "";
      if (diff) emit(record, "diff_available", { tool, path: outcome.result.path || null, diff });
      emit(record, "file_changed", {
        tool,
        path: outcome.result && outcome.result.path ? outcome.result.path : null,
        created: Boolean(outcome.result && outcome.result.created),
      });
    }
    emit(record, "tool_finished", {
      tool,
      ok: outcome.ok,
      error: outcome.ok ? undefined : outcome.error,
      preview: outcome.ok ? undefined : undefined,
    });
    return outcome;
  }

  async function executeCalls(record, calls, startIndex = 0) {
    for (let index = startIndex; index < calls.length; index += 1) {
      if (record.cancelRequested) return { status: "cancelled" };
      const call = calls[index];
      const checked = validateToolInput(call && call.tool, call && call.input);
      if (!checked.ok) {
        await runCall(record, call);
        continue;
      }
      const decision = permissions.evaluate({ tool: checked.tool, input: checked.input, taskMode: record.task.mode });
      if (decision.action === "deny") {
        emit(record, "tool_finished", { tool: checked.tool, ok: false, error: decision.reason });
        record.results.push({ tool: checked.tool, ok: false, error: decision.reason, denied: true });
        continue;
      }
      if (decision.action === "ask" && !approvals.hasTaskGrant(record.taskId, checked.tool)) {
        const reason = typeof call.reason === "string" && call.reason.trim()
          ? call.reason.trim().slice(0, 300)
          : decision.reason;
        const requested = approvals.request({
          taskId: record.taskId,
          userId: record.task.userId,
          tool: checked.tool,
          input: checked.input,
          reason,
        });
        if (!requested.ok) return { status: "failed", error: "Could not record approval request." };
        emit(record, "tool_approval_required", {
          approvalId: requested.approval.id,
          tool: checked.tool,
          input: checked.input,
          reason,
          expiresAt: requested.approval.expiresAt,
        });
        const moved = setState(record, "waiting_for_approval");
        if (!moved.ok) return { status: "failed", error: moved.error };
        record.pending = { calls, index, approvalId: requested.approval.id };
        return { status: "waiting_for_approval", approvalId: requested.approval.id };
      }
      await runCall(record, call);
      if (record.results.length >= limits.maxToolCalls) break;
    }
    return { status: "ran" };
  }

  async function summarize(record) {
    let summary;
    try {
      summary = await planner({
        phase: "summarize",
        task: publicTask(record),
        results: record.results.slice(-limits.maxResultsInContext),
      });
    } catch (error) {
      const result = setState(record, "failed", { error: errorText(error) });
      emit(record, "task_failed", { error: errorText(error) });
      return { ok: false, error: errorText(error), state: result.ok ? result.task.state : "failed" };
    }
    const message = summary && typeof summary.message === "string" ? summary.message : "";
    const verified = summary && Array.isArray(summary.verification) ? summary.verification : [];
    emit(record, "assistant_message", { message, verification: verified });
    const done = setState(record, "completed");
    emit(record, "task_completed", { message, verification: verified });
    record.finished = true;
    return { ok: true, state: done.ok ? done.task.state : "failed", message, verification: verified, results: record.results };
  }

  async function start(record) {
    if (!record) return { ok: false, error: "Unknown task." };
    if (isTerminal(record.task)) return { ok: false, error: "Task is already " + record.task.state + "." };
    let moved = setState(record, record.task.state === "queued" ? "planning" : record.task.state);
    if (!moved.ok) return { ok: false, error: moved.error };

    let plan;
    try {
      plan = await planner({
        phase: "plan",
        task: publicTask(record),
        tools: registry.declarations(),
      });
    } catch (error) {
      setState(record, "failed", { error: errorText(error) });
      emit(record, "task_failed", { error: errorText(error) });
      return { ok: false, error: errorText(error) };
    }

    const steps = plan && Array.isArray(plan.plan) ? plan.plan.slice(0, 40) : [];
    for (const step of steps) {
      const added = addPlanStep(record.task, step);
      if (added.ok) record.task = added.task;
    }
    emit(record, "plan_created", { plan: record.task.plan });
    if (plan && typeof plan.message === "string" && plan.message.trim()) {
      emit(record, "assistant_message", { message: plan.message.slice(0, 8000) });
    }

    const calls = plan && Array.isArray(plan.calls) ? plan.calls.slice(0, limits.maxToolCalls) : [];
    moved = setState(record, "running");
    if (!moved.ok) return { ok: false, error: moved.error };

    const outcome = await executeCalls(record, calls, 0);
    if (outcome.status === "waiting_for_approval") return { ok: true, state: "waiting_for_approval", approvalId: outcome.approvalId };
    if (outcome.status === "cancelled") return cancel(record);
    if (outcome.status === "failed") {
      setState(record, "failed", { error: outcome.error });
      emit(record, "task_failed", { error: outcome.error });
      return { ok: false, error: outcome.error };
    }
    const finished = await summarize(record);
    record.task = addStepResult(record.task, { tool: "loop", ok: finished.ok });
    return finished;
  }

  // Applies one approval decision and continues from the paused call.
  async function resume(record, { approvalId, userId, decision } = {}) {
    if (!record) return { ok: false, error: "Unknown task." };
    if (record.task.state !== "waiting_for_approval" || !record.pending) {
      return { ok: false, error: "Task is not waiting for approval." };
    }
    if (record.pending.approvalId !== approvalId) return { ok: false, error: "Approval does not belong to this pause." };
    const decided = approvals.decide(approvalId, { userId, decision });
    if (!decided.ok) return decided;
    emit(record, "tool_approval_decided", { approvalId, decision });
    emit(record, "task_resumed", { approvalId, decision });
    const { calls, index } = record.pending;
    record.pending = null;
    const moved = setState(record, "running");
    if (!moved.ok) return moved;

    if (decision === "deny") {
      const tool = calls[index] && calls[index].tool;
      record.results.push({ tool: String(tool || "unknown"), ok: false, error: "Denied by the user.", denied: true });
      emit(record, "tool_finished", { tool: String(tool || "unknown"), ok: false, error: "Denied by the user." });
      const outcome = await executeCalls(record, calls, index + 1);
      if (outcome.status === "waiting_for_approval") return { ok: true, state: "waiting_for_approval", approvalId: outcome.approvalId };
      if (outcome.status === "cancelled") return cancel(record);
      return summarize(record);
    }

    await runCall(record, calls[index]);
    const outcome = await executeCalls(record, calls, index + 1);
    if (outcome.status === "waiting_for_approval") return { ok: true, state: "waiting_for_approval", approvalId: outcome.approvalId };
    if (outcome.status === "cancelled") return cancel(record);
    if (outcome.status === "failed") {
      setState(record, "failed", { error: outcome.error });
      emit(record, "task_failed", { error: outcome.error });
      return { ok: false, error: outcome.error };
    }
    return summarize(record);
  }

  function cancel(record) {
    if (!record) return { ok: false, error: "Unknown task." };
    if (isTerminal(record.task)) return { ok: false, error: "Task is already " + record.task.state + "." };
    record.cancelRequested = true;
    approvals.dropForTask(record.taskId);
    record.pending = null;
    setState(record, "cancelled");
    emit(record, "task_cancelled", {});
    return { ok: true, state: "cancelled" };
  }

  function get(taskId) {
    return records.get(taskId) || null;
  }

  return Object.freeze({ create, start, resume, cancel, get, publicTask, records });
}
