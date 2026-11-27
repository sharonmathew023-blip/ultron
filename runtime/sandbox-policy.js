// ULTRON sandbox policy: environment allowlist, output caps and secret redaction.
// Child processes inherit nothing by default. Provider keys never enter a runtime environment.

export const SANDBOX_LIMITS = Object.freeze({
  maxOutputBytes: 200_000,
  maxReadBytes: 1_000_000,
  maxWriteBytes: 2_000_000,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 120_000,
  maxListEntries: 2000,
  maxSearchResults: 100,
});

// Only these variables are passed to a child process, and only when they already exist.
export const SAFE_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
  "SHELL", "USER", "LOGNAME", "TERM", "SYSTEMROOT", "COMSPEC", "PATHEXT",
]);

const SECRET_KEY = /(key|token|secret|password|passwd|credential|authorization|cookie|session)/i;
const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk|ck)_[A-Za-z0-9_-]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export function redactSecrets(text, extraSecrets = []) {
  let value = String(text === undefined || text === null ? "" : text);
  for (const secret of Array.isArray(extraSecrets) ? extraSecrets : []) {
    if (typeof secret === "string" && secret.length >= 6) value = value.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) value = value.replace(pattern, "[redacted]");
  return value;
}

// Strips secret-looking keys from an object before it is logged or shown.
export function redactObject(value, depth = 0) {
  if (depth > 4) return "[depth limit]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactObject(item, depth + 1));
  if (value && typeof value === "object") {
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      clean[key] = SECRET_KEY.test(key) ? "[redacted]" : redactObject(item, depth + 1);
    }
    return clean;
  }
  return value === undefined ? null : value;
}

export function buildEnvironment(baseEnv = {}, extra = {}) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (baseEnv && typeof baseEnv[key] === "string") env[key] = baseEnv[key];
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) continue;
    if (SECRET_KEY.test(key)) continue;
    if (typeof value !== "string") continue;
    env[key] = value;
  }
  env.CI = "1";
  env.NO_COLOR = "1";
  return env;
}

// Truncates a byte buffer to a string without splitting a multi-byte character.
// forceTruncated marks a stream that was capped while it was being collected, where the
// kept bytes already fill the budget and no extra byte is available for the marker.
export function capOutput(buffer, maxBytes = SANDBOX_LIMITS.maxOutputBytes, forceTruncated = false) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ""), "utf8");
  const marker = "\n… [output truncated at " + maxBytes + " bytes]";
  if (source.length <= maxBytes && !forceTruncated) return { text: source.toString("utf8"), truncated: false };
  const slice = source.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
  return { text: slice + marker, truncated: true };
}

export function clampTimeout(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return SANDBOX_LIMITS.defaultTimeoutMs;
  return Math.min(SANDBOX_LIMITS.maxTimeoutMs, Math.max(1000, Math.floor(number)));
}
