// ULTRON agent protocol: tool schemas, task states and event contracts.
// Pure data and validation. No filesystem, no network, no secrets.
//
// Rules this file enforces:
//  - The model can only name a tool that exists in TOOL_SPECS.
//  - Inputs are rebuilt field by field, so stray keys never reach an executor.
//  - Unknown tools are rejected here, not inside an executor.
//  - Task states and transitions are declared once and shared by the runtime and the UI.

export const PROTOCOL_VERSION = 1;

export const RISK = Object.freeze({
  READ: "read",
  WRITE: "write",
  COMMAND: "command",
  EXTERNAL: "external",
});

export const TASK_STATES = Object.freeze([
  "queued",
  "planning",
  "running",
  "waiting_for_approval",
  "waiting_for_user",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const TERMINAL_TASK_STATES = Object.freeze(["completed", "failed", "cancelled"]);

const TASK_TRANSITIONS = Object.freeze({
  queued: ["planning", "cancelled", "failed"],
  planning: ["running", "waiting_for_approval", "waiting_for_user", "cancelled", "failed"],
  running: ["planning", "waiting_for_approval", "waiting_for_user", "paused", "completed", "failed", "cancelled"],
  waiting_for_approval: ["running", "waiting_for_user", "paused", "cancelled", "failed"],
  waiting_for_user: ["running", "planning", "paused", "cancelled", "failed"],
  paused: ["running", "planning", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
});

export function isTaskState(value) {
  return typeof value === "string" && TASK_STATES.includes(value);
}

export function canTransition(from, to) {
  if (!isTaskState(from) || !isTaskState(to)) return false;
  return TASK_TRANSITIONS[from].includes(to);
}

export const EVENT_TYPES = Object.freeze([
  "task_created",
  "plan_created",
  "assistant_message",
  "tool_approval_required",
  "tool_approval_decided",
  "tool_started",
  "tool_output",
  "tool_finished",
  "file_changed",
  "diff_available",
  "test_started",
  "test_finished",
  "subagent_started",
  "subagent_finished",
  "task_paused",
  "task_resumed",
  "task_completed",
  "task_failed",
  "task_cancelled",
]);

export const APPROVAL_DECISIONS = Object.freeze(["once", "task", "deny"]);

const str = (max) => ({ kind: "string", max, required: true });
const optStr = (max) => ({ kind: "string", max, required: false });
const int = (min, max) => ({ kind: "int", min, max, required: true });
const optInt = (min, max) => ({ kind: "int", min, max, required: false });
const optBool = () => ({ kind: "boolean", required: false });

// The first registry. It is intentionally small and explicit.
// External tools (github.*, deploy.*, mcp.*) are absent until approvals and auditing exist.
export const TOOL_SPECS = Object.freeze({
  "workspace.list": Object.freeze({
    risk: RISK.READ,
    description: "List directory entries inside the approved workspace.",
    params: Object.freeze({ path: optStr(1024), depth: optInt(1, 4) }),
  }),
  "file.read": Object.freeze({
    risk: RISK.READ,
    description: "Read a text file inside the approved workspace, with line bounds.",
    params: Object.freeze({ path: str(1024), startLine: optInt(1, 1000000), maxLines: optInt(1, 5000) }),
  }),
  "file.glob": Object.freeze({
    risk: RISK.READ,
    description: "Find workspace-relative paths by glob pattern.",
    params: Object.freeze({ pattern: str(200), maxResults: optInt(1, 200) }),
  }),
  "file.search": Object.freeze({
    risk: RISK.READ,
    description: "Search workspace text files for a literal string.",
    params: Object.freeze({ query: str(200), glob: optStr(200), maxResults: optInt(1, 200) }),
  }),
  "git.status": Object.freeze({
    risk: RISK.READ,
    description: "Read git status for the workspace.",
    params: Object.freeze({}),
  }),
  "git.diff": Object.freeze({
    risk: RISK.READ,
    description: "Read a git diff, optionally for one path or the staged set.",
    params: Object.freeze({ path: optStr(1024), staged: optBool() }),
  }),
  "test.detect": Object.freeze({
    risk: RISK.READ,
    description: "Detect test files and the project's test command.",
    params: Object.freeze({}),
  }),
  "file.write": Object.freeze({
    risk: RISK.WRITE,
    description: "Create or replace a file inside the approved workspace.",
    params: Object.freeze({ path: str(1024), content: str(200000) }),
  }),
  "file.edit": Object.freeze({
    risk: RISK.WRITE,
    description: "Replace one exact occurrence of text in a workspace file.",
    params: Object.freeze({ path: str(1024), find: str(20000), replace: optStr(20000) }),
  }),
  "file.delete": Object.freeze({
    risk: RISK.WRITE,
    description: "Delete a file inside the approved workspace.",
    params: Object.freeze({ path: str(1024) }),
  }),
  "patch.apply": Object.freeze({
    risk: RISK.WRITE,
    description: "Apply one validated find/replace patch and return its diff.",
    params: Object.freeze({ path: str(1024), find: str(20000), replace: optStr(20000) }),
  }),
  "shell.run": Object.freeze({
    risk: RISK.COMMAND,
    description: "Run one policy-approved command in the workspace root.",
    params: Object.freeze({ command: str(500), cwd: optStr(1024), timeoutMs: optInt(1000, 120000) }),
  }),
  "test.run": Object.freeze({
    risk: RISK.COMMAND,
    description: "Run the project's test command.",
    params: Object.freeze({ command: optStr(500), timeoutMs: optInt(1000, 120000) }),
  }),
  "lint.run": Object.freeze({
    risk: RISK.COMMAND,
    description: "Run the project's lint command.",
    params: Object.freeze({ command: optStr(500), timeoutMs: optInt(1000, 120000) }),
  }),
  "build.run": Object.freeze({
    risk: RISK.COMMAND,
    description: "Run the project's build command.",
    params: Object.freeze({ command: optStr(500), timeoutMs: optInt(1000, 120000) }),
  }),
});

export const READ_ONLY_TOOLS = Object.freeze(
  Object.keys(TOOL_SPECS).filter((name) => TOOL_SPECS[name].risk === RISK.READ),
);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function isTool(name) {
  return typeof name === "string" && hasOwn(TOOL_SPECS, name);
}

export function toolRisk(name) {
  return isTool(name) ? TOOL_SPECS[name].risk : null;
}

// Returns a short, safe reason string. Never echoes arbitrary model text.
function checkField(spec, key, value) {
  switch (spec.kind) {
    case "string":
      if (typeof value !== "string") return "invalid type: " + key;
      if (!value.length) return "empty value: " + key;
      if (value.length > spec.max) return "value too long: " + key;
      if (value.includes("\u0000")) return "invalid character: " + key;
      return null;
    case "int":
      if (!Number.isInteger(value)) return "invalid type: " + key;
      if (value < spec.min || value > spec.max) return "out of range: " + key;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "invalid type: " + key;
    default:
      return "unknown field kind: " + key;
  }
}

// Validates and rebuilds a tool call's input from declared fields only.
export function validateToolInput(name, input) {
  if (!isTool(name)) return { ok: false, error: "Unknown tool." };
  const params = TOOL_SPECS[name].params;
  const raw = input === undefined || input === null ? {} : input;
  if (!isPlainObject(raw)) return { ok: false, error: "Tool input must be an object." };
  for (const key of Object.keys(raw)) {
    if (!hasOwn(params, key)) return { ok: false, error: "Unexpected field: " + key };
  }
  const clean = {};
  for (const key of Object.keys(params)) {
    const spec = params[key];
    const present = hasOwn(raw, key) && raw[key] !== undefined && raw[key] !== null;
    if (!present) {
      if (spec.required) return { ok: false, error: "Missing field: " + key };
      continue;
    }
    const problem = checkField(spec, key, raw[key]);
    if (problem) return { ok: false, error: problem };
    clean[key] = raw[key];
  }
  return { ok: true, tool: name, input: clean };
}

// Validates the envelope of one task event. Payload fields are type-specific and are
// bounded separately by the event log, so this only checks the shared contract.
export function validateEvent(event) {
  if (!isPlainObject(event)) return { ok: false, error: "Event must be an object." };
  if (typeof event.taskId !== "string" || !event.taskId.length || event.taskId.length > 128) {
    return { ok: false, error: "Invalid task id." };
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) return { ok: false, error: "Invalid sequence." };
  if (typeof event.type !== "string" || !EVENT_TYPES.includes(event.type)) {
    return { ok: false, error: "Unknown event type." };
  }
  if (typeof event.timestamp !== "string" || Number.isNaN(Date.parse(event.timestamp))) {
    return { ok: false, error: "Invalid timestamp." };
  }
  return { ok: true };
}

// Accepts either a bare string or {tool, value} and returns the raw string or null.
export function ruleTarget(rule) {
  if (typeof rule !== "string") return null;
  const trimmed = rule.trim();
  if (!trimmed) return null;
  const at = trimmed.indexOf(":");
  return at === -1 ? "" : trimmed.slice(at + 1).trim();
}

export function ruleTool(rule) {
  if (typeof rule !== "string") return null;
  const trimmed = rule.trim();
  if (!trimmed) return null;
  const at = trimmed.indexOf(":");
  return (at === -1 ? trimmed : trimmed.slice(0, at)).trim() || null;
}
