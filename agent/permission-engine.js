// ULTRON permission engine.
// The model asks; this decides. Precedence is always deny -> ask -> allow, and a mode only
// supplies the baseline that explicit rules can tighten or loosen.
//
// Rules look like "file.read", "file.read:src/**", "shell.run:git push *".
// A broad deny ("file.edit:**/.env") cannot be overridden by a narrow allow.

import { RISK, isPlainObject, ruleTarget, ruleTool, toolRisk, isTool } from "../protocol/schemas.js";
import { matchesPattern } from "../authorization/path-policy.js";

export const PERMISSION_MODES = Object.freeze(["plan", "manual", "accept-edits", "restricted"]);

export const DEFAULT_MODE = "manual";

// Tools that delete or overwrite without a recoverable diff always need approval.
const DESTRUCTIVE_TOOLS = Object.freeze(["file.delete"]);

export function modeBaseline(mode, tool) {
  const risk = toolRisk(tool);
  if (!risk) return { action: "deny", reason: "Unknown tool." };
  switch (mode) {
    case "plan":
      return risk === RISK.READ
        ? { action: "allow", reason: "Read-only plan mode." }
        : { action: "ask", reason: "Plan mode: edits and commands need approval." };
    case "accept-edits":
      if (risk === RISK.READ) return { action: "allow", reason: "Read is allowed." };
      if (risk === RISK.WRITE) return { action: "allow", reason: "Accept-edits mode allows workspace edits." };
      return { action: "ask", reason: "Commands and external tools need approval." };
    case "restricted":
      return { action: "deny", reason: "Restricted mode allows only explicit rules." };
    case "manual":
    default:
      return risk === RISK.READ
        ? { action: "allow", reason: "Read is allowed in manual mode." }
        : { action: "ask", reason: "Needs approval in manual mode." };
  }
}

// The string a rule's pattern is compared against: a path for file tools, a command for
// command tools. Anything else only matches the bare "tool" rule.
export function ruleSubject(tool, input) {
  if (!isPlainObject(input)) return "";
  const risk = toolRisk(tool);
  if (risk === RISK.COMMAND && typeof input.command === "string") return input.command.trim();
  if (typeof input.path === "string") return input.path.replace(/^\.\//, "");
  return "";
}

function matchRules(rules, tool, subject) {
  const hits = { allow: [], ask: [], deny: [] };
  if (!isPlainObject(rules)) return hits;
  for (const action of ["allow", "ask", "deny"]) {
    const list = Array.isArray(rules[action]) ? rules[action] : [];
    for (const rule of list) {
      if (ruleTool(rule) !== tool) continue;
      const target = ruleTarget(rule);
      if (!target) {
        hits[action].push(rule);
        continue;
      }
      if (subject && matchesPattern(target, subject)) hits[action].push(rule);
    }
  }
  return hits;
}

export function createPermissionEngine({ rules = {}, mode = DEFAULT_MODE, commandPolicy = null } = {}) {
  const settings = Object.freeze({ allow: [...(rules.allow || [])], ask: [...(rules.ask || [])], deny: [...(rules.deny || [])] });

  function evaluate({ tool, input, taskMode }) {
    const effectiveMode = PERMISSION_MODES.includes(taskMode) ? taskMode : (PERMISSION_MODES.includes(mode) ? mode : DEFAULT_MODE);
    if (!isTool(tool)) return { action: "deny", reason: "Unknown tool.", mode: effectiveMode };
    // A command the command policy denies is denied here too, before any approval prompt
    // or mode baseline can soften it. This is the single decision the model cannot bypass.
    if (toolRisk(tool) === RISK.COMMAND && commandPolicy && typeof commandPolicy.check === "function") {
      const command = input && typeof input.command === "string" ? input.command.trim() : "";
      if (command) {
        const checked = commandPolicy.check(command);
        if (checked.action === "deny") return { action: "deny", reason: checked.reason, mode: effectiveMode };
      }
    }
    const subject = ruleSubject(tool, input);
    const hits = matchRules(settings, tool, subject);
    if (hits.deny.length) return { action: "deny", reason: "Denied by rule: " + hits.deny[0], mode: effectiveMode, rule: hits.deny[0] };
    if (DESTRUCTIVE_TOOLS.includes(tool)) {
      return { action: "ask", reason: "Destructive tools always need approval.", mode: effectiveMode };
    }
    if (hits.ask.length) return { action: "ask", reason: "Approval required by rule: " + hits.ask[0], mode: effectiveMode, rule: hits.ask[0] };
    if (hits.allow.length) return { action: "allow", reason: "Allowed by rule: " + hits.allow[0], mode: effectiveMode, rule: hits.allow[0] };
    return { ...modeBaseline(effectiveMode, tool), mode: effectiveMode };
  }

  return Object.freeze({ evaluate, rules: settings, mode });
}

// Builds the engine from a .ultron/settings.json-shaped object without trusting extra keys.
export function permissionEngineFromSettings(settings) {
  const permissions = isPlainObject(settings) && isPlainObject(settings.permissions) ? settings.permissions : {};
  const mode = isPlainObject(settings) && PERMISSION_MODES.includes(settings.mode) ? settings.mode : DEFAULT_MODE;
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  return createPermissionEngine({
    mode,
    rules: {
      allow: list(permissions.allow),
      ask: list(permissions.ask),
      deny: list(permissions.deny),
    },
  });
}
