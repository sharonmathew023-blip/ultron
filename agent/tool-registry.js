// ULTRON tool registry.
// An executor is registered per tool by name only. Calls are schema-validated first, then
// executed, then rebuilt into a clean result: unknown fields, huge strings and stray null
// bytes never reach the model or the UI.

import { TOOL_SPECS, isPlainObject, isTool, validateToolInput } from "../protocol/schemas.js";

const MAX_RESULT_CHARS = 24000;
const DROP_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeToolResult(result, { maxChars = MAX_RESULT_CHARS, redact } = {}) {
  if (result === undefined || result === null) return null;
  let text;
  try {
    text = JSON.stringify(result, (key, value) => (DROP_KEYS.has(key) ? undefined : value));
  } catch {
    return { ok: false, error: "Tool result was not serializable." };
  }
  if (typeof text !== "string") return null;
  let capped = text.length > maxChars ? text.slice(0, maxChars) : text;
  if (typeof redact === "function") capped = redact(capped);
  capped = capped.replace(/\u0000/g, "");
  try {
    const parsed = JSON.parse(text.length > maxChars ? text : capped);
    return text.length > maxChars ? { truncated: true, preview: capped } : parsed;
  } catch {
    return { truncated: true, preview: capped };
  }
}

export function createToolRegistry({ executors = {}, redact } = {}) {
  const registered = new Map();
  for (const [name, executor] of Object.entries(executors)) {
    if (!isTool(name)) throw new Error("Cannot register unknown tool: " + name);
    if (typeof executor !== "function") throw new Error("Executor for " + name + " must be a function.");
    registered.set(name, executor);
  }

  function available() {
    return [...registered.keys()].sort();
  }

  // Declarations handed to the model: names, risks and descriptions only.
  function declarations() {
    return [...registered.keys()].sort().map((name) => ({
      name,
      risk: TOOL_SPECS[name].risk,
      description: TOOL_SPECS[name].description,
      parameters: Object.keys(TOOL_SPECS[name].params),
    }));
  }

  async function execute(name, input, context = {}) {
    const checked = validateToolInput(name, input);
    if (!checked.ok) return { ok: false, error: checked.error, tool: name };
    const executor = registered.get(name);
    if (!executor) return { ok: false, error: "Tool is not enabled in this runtime.", tool: name };
    let result;
    try {
      result = await executor(checked.input, { ...context, tool: name });
    } catch (error) {
      return { ok: false, error: "Tool failed: " + String(error && error.message ? error.message : error).slice(0, 200), tool: name };
    }
    if (isPlainObject(result) && result.ok === false) {
      return { ok: false, error: String(result.error || "Tool failed.").slice(0, 500), tool: name };
    }
    return { ok: true, tool: name, result: sanitizeToolResult(result, { redact }) };
  }

  return Object.freeze({
    available,
    declarations,
    execute,
    has: (name) => registered.has(name),
    size: registered.size,
  });
}

// Tools that change the workspace. Used for diff and file_changed events.
export function isMutatingTool(name) {
  return isTool(name) && TOOL_SPECS[name].risk !== "read";
}
