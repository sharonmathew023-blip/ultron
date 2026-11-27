// ULTRON workspace path policy.
// A workspace is a capability boundary, not a UI selection: every path must resolve inside
// the approved root, and protected files are refused even when they are inside it.
//
// Pure except for the optional injected realpath function, so it is testable without a disk.

import path from "node:path";

export const DEFAULT_PROTECTED_PATTERNS = Object.freeze([
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".git/config",
  ".git/hooks/**",
  ".ssh/**",
  "**/.ssh/**",
  ".aws/**",
  "**/.aws/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.netrc",
  "**/credentials.json",
  "**/service-account*.json",
  "**/.ultron/checkpoints/**",
]);

export const DEFAULT_LIMITS = Object.freeze({
  maxPathChars: 1024,
  maxReadBytes: 1_000_000,
  maxWriteBytes: 2_000_000,
});

function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const slashNext = pattern[i + 2] === "/";
        if (slashNext) {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out + "$");
}

export function matchesPattern(pattern, value) {
  if (typeof pattern !== "string" || typeof value !== "string") return false;
  return globToRegExp(pattern).test(value);
}

function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

// Rejects anything that is not a plain relative path: absolute paths, drive letters, UNC,
// null bytes and traversal segments. This runs before resolution so ".." can never be used.
export function inspectRelativePath(input) {
  if (typeof input !== "string") return { ok: false, error: "Path must be a string." };
  if (!input.length) return { ok: false, error: "Path is empty." };
  if (input.length > DEFAULT_LIMITS.maxPathChars) return { ok: false, error: "Path is too long." };
  if (input.includes("\u0000")) return { ok: false, error: "Path contains a null byte." };
  if (input.includes("\\")) return { ok: false, error: "Use forward slashes in paths." };
  if (path.posix.isAbsolute(input) || isWindowsAbsolute(input) || input.startsWith("//")) {
    return { ok: false, error: "Absolute paths are not allowed. Use a workspace-relative path." };
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment === "..")) return { ok: false, error: "Path traversal is not allowed." };
  if (segments.some((segment) => segment.trim() === "")) return { ok: false, error: "Path has an empty segment." };
  return { ok: true, path: segments.filter((segment) => segment !== ".").join("/") };
}

export function createPathPolicy({ root, protectedPatterns = DEFAULT_PROTECTED_PATTERNS, realpath } = {}) {
  if (typeof root !== "string" || !root.trim()) throw new Error("A workspace root is required.");
  const absoluteRoot = path.resolve(root);
  const patterns = Object.freeze([...protectedPatterns]);
  const resolveReal = typeof realpath === "function" ? realpath : null;

  function isProtected(relativePath) {
    const target = String(relativePath || "").replace(/^\.\//, "");
    if (!target) return true;
    return patterns.some((pattern) => matchesPattern(pattern, target));
  }

  // Resolves a model-supplied path. Returns {ok, absolute, relative} or {ok:false, error}.
  // An injected realpath is used to catch symlinks that escape the root.
  function resolve(input) {
    const inspected = inspectRelativePath(input);
    if (!inspected.ok) return inspected;
    const relative = inspected.path || ".";
    const absolute = path.resolve(absoluteRoot, relative);
    if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + path.sep)) {
      return { ok: false, error: "Path resolves outside the workspace." };
    }
    if (relative === ".") return { ok: true, absolute, relative: "." };
    if (isProtected(relative)) return { ok: false, error: "Path is protected by policy." };
    if (resolveReal) {
      let real;
      try {
        real = resolveReal(absolute);
      } catch {
        return { ok: false, error: "Path does not exist." };
      }
      if (real !== absoluteRoot && !real.startsWith(absoluteRoot + path.sep)) {
        return { ok: false, error: "Path escapes the workspace through a link." };
      }
      if (relative !== "." && resolveReal === realpath && isProtected(path.relative(absoluteRoot, real).split(path.sep).join("/"))) {
        return { ok: false, error: "Path is protected by policy." };
      }
    }
    return { ok: true, absolute, relative };
  }

  // Paths for recursive listing: no protection check, but the same root boundary.
  function resolveForListing(input) {
    const inspected = inspectRelativePath(input === undefined || input === null || input === "" ? "." : input);
    if (!inspected.ok) return inspected;
    const relative = inspected.path || ".";
    const absolute = path.resolve(absoluteRoot, relative);
    if (absolute !== absoluteRoot && !absolute.startsWith(absoluteRoot + path.sep)) {
      return { ok: false, error: "Path resolves outside the workspace." };
    }
    if (relative !== "." && relative.split("/").some((segment) => segment.startsWith(".git"))) {
      return { ok: false, error: "Git internals are not listable." };
    }
    return { ok: true, absolute, relative };
  }

  return Object.freeze({ root: absoluteRoot, patterns, isProtected, resolve, resolveForListing, limits: DEFAULT_LIMITS });
}
