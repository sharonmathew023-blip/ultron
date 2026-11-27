// ULTRON approval store.
// Approvals are bound to one task and one user. A browser cannot approve its own request
// for another account, and a stale approval can never be replayed.

import { randomUUID } from "node:crypto";
import { APPROVAL_DECISIONS } from "../protocol/schemas.js";

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export function createApprovalStore({ now = () => Date.now(), newId = randomUUID, ttlMs = APPROVAL_TTL_MS } = {}) {
  const pending = new Map();
  const taskGrants = new Map();

  function prune() {
    const at = now();
    for (const [id, approval] of pending) {
      if (approval.expiresAt <= at) {
        pending.delete(id);
        approval.status = "expired";
      }
    }
    for (const [key, expiresAt] of taskGrants) {
      if (expiresAt <= at) taskGrants.delete(key);
    }
  }

  // Called by the runtime when the permission engine answers "ask".
  function request({ taskId, userId, tool, input, reason }) {
    prune();
    for (const approval of pending.values()) {
      if (approval.taskId === taskId && approval.userId === userId && approval.tool === tool
        && JSON.stringify(approval.input) === JSON.stringify(input || {}) && approval.status === "pending") {
        return { ok: true, approval, reused: true };
      }
    }
    const approval = {
      id: newId(),
      taskId,
      userId,
      tool,
      input: input || {},
      reason: typeof reason === "string" ? reason.slice(0, 500) : "Approval required.",
      status: "pending",
      createdAt: now(),
      expiresAt: now() + ttlMs,
      decision: null,
    };
    pending.set(approval.id, approval);
    return { ok: true, approval, reused: false };
  }

  // A task-scoped grant covers repeat calls of the same tool for the same task.
  function grantForTask(taskId, tool, userId) {
    taskGrants.set(taskId + "\u0000" + tool, now() + ttlMs);
    return { taskId, tool, grantedBy: userId, expiresAt: now() + ttlMs };
  }

  function hasTaskGrant(taskId, tool) {
    prune();
    return taskGrants.has(taskId + "\u0000" + tool);
  }

  // Decisions are only accepted from the user the approval was issued to.
  function decide(approvalId, { userId, decision }) {
    prune();
    if (!APPROVAL_DECISIONS.includes(decision)) return { ok: false, error: "Unknown decision." };
    const approval = pending.get(approvalId);
    if (!approval) return { ok: false, error: "Approval not found." };
    if (approval.userId !== userId) return { ok: false, error: "Approval belongs to another user." };
    if (approval.status !== "pending") return { ok: false, error: "Approval is already " + approval.status + "." };
    approval.status = decision === "deny" ? "denied" : "approved";
    approval.decision = decision;
    approval.decidedAt = now();
    if (decision === "task") grantForTask(approval.taskId, approval.tool, userId);
    pending.delete(approvalId);
    return { ok: true, approval, decision };
  }

  function get(approvalId) {
    prune();
    return pending.get(approvalId) || null;
  }

  function listForTask(taskId) {
    prune();
    return [...pending.values()].filter((approval) => approval.taskId === taskId);
  }

  function dropForTask(taskId) {
    for (const [id, approval] of pending) if (approval.taskId === taskId) pending.delete(id);
    for (const key of [...taskGrants.keys()]) if (key.startsWith(taskId + "\u0000")) taskGrants.delete(key);
  }

  return Object.freeze({ request, decide, get, listForTask, dropForTask, hasTaskGrant, grantForTask, prune });
}
