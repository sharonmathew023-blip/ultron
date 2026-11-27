// ULTRON command policy.
// There is no unrestricted shell. A command is tokenized without a shell, rejected if it
// contains shell operators, then matched against deny -> ask -> allow rules.
//
// Precedence is fixed: a broad deny can never be overridden by a narrower allow.

export const DEFAULT_COMMAND_POLICY = Object.freeze({
  allow: Object.freeze([
    "node", "npm test", "npm run test", "npm run lint", "npm run build", "npm run typecheck",
    "npx tsc", "python -m pytest", "pytest", "go test", "cargo test", "cargo build",
    "git status", "git diff", "git log", "git show", "ls", "pwd", "cat", "head", "tail",
  ]),
  ask: Object.freeze(["npm install", "npm ci", "npm run", "yarn", "pnpm", "pip install", "git add", "git commit"]),
  deny: Object.freeze([
    "sudo", "su", "doas", "sh", "bash", "zsh", "fish", "eval", "exec", "ssh", "scp", "nc", "ncat",
    "telnet", "curl", "wget", "rm", "rmdir", "dd", "mkfs", "shutdown", "reboot", "kill", "killall",
    "chmod", "chown", "mount", "umount", "crontab", "systemctl", "docker", "kubectl", "terraform",
    "aws", "gcloud", "az", "git push", "git reset", "git checkout --", "git clean", "npm publish",
    "npm run deploy", "wrangler deploy", "python -c", "node -e", "node --eval",
  ]),
  maxCommandChars: 500,
  maxArgs: 24,
});

const SHELL_METACHARACTERS = [";", "&", "|", "`", "$(", "${", ">", "<", "\n", "\r", "\\"];
// Arguments are passed to spawn as an argv array (never a shell), so spaces are safe.
// What is not safe is an argument that turns the binary into an interpreter.
const BANNED_ARG_PATTERNS = [/^-{0,2}(?:-?eval|exec|script|-c)$/];

function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let sawToken = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      sawToken = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current || sawToken) tokens.push(current);
      current = "";
      sawToken = false;
      continue;
    }
    current += char;
    sawToken = true;
  }
  if (quote) return { ok: false, error: "Unbalanced quotes in command." };
  if (current || sawToken) tokens.push(current);
  if (!tokens.length) return { ok: false, error: "Command is empty." };
  return { ok: true, tokens };
}

// Rules are command prefixes. A "*" token matches one argument, and a trailing "*" matches
// the rest (including nothing), so "rm *", "sudo *" and "git push*" behave as expected.
function matchesPrefix(rule, tokens) {
  const ruleTokens = rule.trim().split(/\s+/).filter(Boolean);
  if (!ruleTokens.length) return false;
  let index = 0;
  for (let ruleIndex = 0; ruleIndex < ruleTokens.length; ruleIndex += 1) {
    const ruleToken = ruleTokens[ruleIndex];
    if (ruleToken === "*") {
      if (ruleIndex === ruleTokens.length - 1) return true;
      if (index >= tokens.length) return false;
      index += 1;
      continue;
    }
    if (index >= tokens.length) return false;
    if (ruleToken.endsWith("*")) {
      if (!tokens[index].startsWith(ruleToken.slice(0, -1))) return false;
    } else if (tokens[index] !== ruleToken) {
      return false;
    }
    index += 1;
  }
  return true;
}

// Returns {action:"allow"|"ask"|"deny", reason, tokens, file, args}.
export function checkCommand(command, policy = DEFAULT_COMMAND_POLICY) {
  if (typeof command !== "string" || !command.trim()) return { action: "deny", reason: "Command is empty." };
  if (command.length > (policy.maxCommandChars || 500)) return { action: "deny", reason: "Command is too long." };
  for (const meta of SHELL_METACHARACTERS) {
    if (command.includes(meta)) return { action: "deny", reason: "Shell operators are not allowed: " + meta };
  }
  const parsed = tokenize(command);
  if (!parsed.ok) return { action: "deny", reason: parsed.error };
  const tokens = parsed.tokens;
  if (tokens.length > (policy.maxArgs || 24)) return { action: "deny", reason: "Too many arguments." };
  for (const token of tokens) {
    if (BANNED_ARG_PATTERNS.some((pattern) => pattern.test(token))) {
      return { action: "deny", reason: "Unsafe argument: " + token };
    }
  }

  const deny = (policy.deny || []).find((rule) => matchesPrefix(rule, tokens));
  if (deny) return { action: "deny", reason: "Command is denied by policy: " + deny, tokens };
  const allow = (policy.allow || []).find((rule) => matchesPrefix(rule, tokens));
  const ask = (policy.ask || []).find((rule) => matchesPrefix(rule, tokens));
  const base = { tokens, file: tokens[0], args: tokens.slice(1) };
  if (ask && !allow) return { action: "ask", reason: "Command needs approval: " + ask, ...base };
  if (allow) {
    // An allow prefix that is broader than the ask rule must not bypass approval.
    if (ask && allow.length < ask.length) return { action: "ask", reason: "Command needs approval: " + ask, ...base };
    return { action: "allow", reason: "Command is allowed: " + allow, ...base };
  }
  return { action: "ask", reason: "Command is not allowlisted.", ...base };
}

export function createCommandPolicy(overrides = {}) {
  const merged = {
    ...DEFAULT_COMMAND_POLICY,
    ...overrides,
    allow: Object.freeze([...(overrides.allow || DEFAULT_COMMAND_POLICY.allow)]),
    ask: Object.freeze([...(overrides.ask || DEFAULT_COMMAND_POLICY.ask)]),
    deny: Object.freeze([...(overrides.deny || DEFAULT_COMMAND_POLICY.deny)]),
  };
  return Object.freeze({
    ...merged,
    check: (command) => checkCommand(command, merged),
  });
}
