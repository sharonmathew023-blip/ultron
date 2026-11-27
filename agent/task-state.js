// ULTRON task state.
// One task is one durable unit of work. Transitions are validated, so a failed runtime can
// never mark a task complete and a cancelled task can never be resumed.

import { TERMINAL_TASK_STATES, canTransition, isTaskState } from "../protocol/schemas.js";

export const TASK_LIMITS = Object.freeze({
  maxGoalChars: 4000,
  maxStepChars: 500,
  maxSteps: 40,
});

export function createTask({ id, userId, workspaceId, goal, mode = "manual", now = () => Date.now() }) {
  if (typeof id !== "string" || !id) throw new Error("Task id is required.");
  if (typeof userId !== "string" || !userId) throw new Error("Task owner is required.");
  if (typeof goal !== "string" || !goal.trim()) throw new Error("Task goal is required.");
  return Object.freeze({
    id,
    userId,
    workspaceId: workspaceId || null,
    goal: goal.trim().slice(0, TASK_LIMITS.maxGoalChars),
    mode,
    state: "queued",
    plan: [],
    steps: [],
    createdAt: now(),
    updatedAt: now(),
    error: null,
    cancelRequested: false,
  });
}

export function isTerminal(task) {
  return Boolean(task) && TERMINAL_TASK_STATES.includes(task.state);
}

// Returns {ok:true, task} with a new frozen object, or {ok:false, error}. Never mutates.
export function transition(task, next, { now = () => Date.now(), patch = {} } = {}) {
  if (!task || !isTaskState(task.state)) return { ok: false, error: "Unknown task." };
  if (!isTaskState(next)) return { ok: false, error: "Unknown task state." };
  if (isTerminal(task) && task.state !== next) {
    return { ok: false, error: "Task is already " + task.state + "." };
  }
  if (task.state !== next && !canTransition(task.state, next)) {
    return { ok: false, error: "Cannot move from " + task.state + " to " + next + "." };
  }
  const safePatch = {};
  for (const key of ["plan", "error", "cancelRequested"]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) safePatch[key] = patch[key];
  }
  return { ok: true, task: Object.freeze({ ...task, ...safePatch, state: next, updatedAt: now() }) };
}

export function addPlanStep(task, step) {
  if (typeof step !== "string" || !step.trim()) return { ok: false, error: "Plan step is empty." };
  if (task.plan.length >= TASK_LIMITS.maxSteps) return { ok: false, error: "Plan is too long." };
  return { ok: true, task: Object.freeze({ ...task, plan: [...task.plan, step.trim().slice(0, TASK_LIMITS.maxStepChars)] }) };
}

export function addStepResult(task, step, now = () => Date.now()) {
  if (task.steps.length >= TASK_LIMITS.maxSteps * 4) return task;
  return Object.freeze({ ...task, steps: [...task.steps, step], updatedAt: now() });
}
