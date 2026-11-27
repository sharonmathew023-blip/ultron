// ULTRON patch manager.
// Every write is: validate path -> capture a checkpoint -> apply once -> return a diff.
// Checkpoints live in memory per task, so undo never depends on git and never writes a
// second copy of secrets to disk.

import fsImpl from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_DIFF_LINES = 400;
const LCS_CELL_LIMIT = 250_000;

export function hashContent(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

function splitLines(text) {
  const value = String(text === undefined || text === null ? "" : text);
  if (!value.length) return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

// A compact unified diff. Large files fall back to a whole-block replacement.
export function unifiedDiff(before, after, filePath = "file") {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.join("\n") === b.join("\n")) return "";
  const header = "--- a/" + filePath + "\n+++ b/" + filePath + "\n@@ -1," + a.length + " +1," + b.length + " @@";
  if (a.length * b.length > LCS_CELL_LIMIT || a.length + b.length > MAX_DIFF_LINES * 4) {
    return header + "\n" + a.map((line) => "-" + line).join("\n") + "\n" + b.map((line) => "+" + line).join("\n");
  }
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => new Int32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      lines.push(" " + a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push("-" + a[i]);
      i += 1;
    } else {
      lines.push("+" + b[j]);
      j += 1;
    }
  }
  while (i < rows) { lines.push("-" + a[i]); i += 1; }
  while (j < cols) { lines.push("+" + b[j]); j += 1; }
  return header + "\n" + lines.slice(0, MAX_DIFF_LINES).join("\n");
}

function isBinary(text) {
  return typeof text === "string" && text.includes("\u0000");
}

export function createPatchManager({ policy, fs = fsImpl, maxWriteBytes = 2_000_000 } = {}) {
  if (!policy || typeof policy.resolve !== "function") throw new Error("A path policy is required.");
  // taskId -> Map(relativePath -> { absolute, before })
  const checkpoints = new Map();
  // taskId + path -> hash of last content this task wrote or read.
  const lastHash = new Map();

  function checkpointFor(taskId) {
    if (!checkpoints.has(taskId)) checkpoints.set(taskId, new Map());
    return checkpoints.get(taskId);
  }

  function readResolved(resolved) {
    let stat;
    try {
      stat = fs.statSync(resolved.absolute);
    } catch {
      return { ok: false, error: "File does not exist.", missing: true };
    }
    if (!stat.isFile()) return { ok: false, error: "Path is not a file." };
    if (stat.size > maxWriteBytes) return { ok: false, error: "File is too large." };
    return { ok: true, content: fs.readFileSync(resolved.absolute, "utf8") };
  }

  function guardConcurrent(taskId, resolved) {
    const key = taskId + "\u0000" + resolved.relative;
    const recorded = lastHash.get(key);
    if (!recorded) return { ok: true };
    const current = readResolved(resolved);
    if (!current.ok) return { ok: true };
    if (hashContent(current.content) !== recorded) {
      return { ok: false, error: "File changed outside this task. Re-read it before editing." };
    }
    return { ok: true };
  }

  function remember(taskId, resolved, content) {
    lastHash.set(taskId + "\u0000" + resolved.relative, hashContent(content === null ? "" : content));
  }

  function capture(taskId, resolved, before) {
    const store = checkpointFor(taskId);
    if (!store.has(resolved.relative)) store.set(resolved.relative, { absolute: resolved.absolute, before });
  }

  function write(taskId, inputPath, content) {
    if (typeof content !== "string") return { ok: false, error: "Content must be text." };
    if (Buffer.byteLength(content, "utf8") > maxWriteBytes) return { ok: false, error: "Content is too large." };
    const resolved = policy.resolve(inputPath);
    if (!resolved.ok) return resolved;
    if (resolved.relative === ".") return { ok: false, error: "Path must name a file." };
    const concurrent = guardConcurrent(taskId, resolved);
    if (!concurrent.ok) return concurrent;
    const existing = readResolved(resolved);
    const before = existing.ok ? existing.content : null;
    if (existing.ok && isBinary(before)) return { ok: false, error: "Refusing to overwrite a binary file." };
    capture(taskId, resolved, before);
    fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
    fs.writeFileSync(resolved.absolute, content, "utf8");
    remember(taskId, resolved, content);
    return {
      ok: true,
      path: resolved.relative,
      created: before === null,
      bytes: Buffer.byteLength(content, "utf8"),
      diff: unifiedDiff(before === null ? "" : before, content, resolved.relative),
    };
  }

  // Exact-once replacement. Zero or multiple matches are rejected, never guessed at.
  function edit(taskId, inputPath, find, replace = "") {
    if (typeof find !== "string" || !find.length) return { ok: false, error: "Search text is empty." };
    if (typeof replace !== "string") return { ok: false, error: "Replacement must be text." };
    const resolved = policy.resolve(inputPath);
    if (!resolved.ok) return resolved;
    const existing = readResolved(resolved);
    if (!existing.ok) return existing;
    if (isBinary(existing.content)) return { ok: false, error: "Refusing to edit a binary file." };
    const concurrent = guardConcurrent(taskId, resolved);
    if (!concurrent.ok) return concurrent;
    const first = existing.content.indexOf(find);
    if (first === -1) return { ok: false, error: "Search text not found." };
    if (existing.content.indexOf(find, first + 1) !== -1) {
      return { ok: false, error: "Search text appears more than once. Include more context." };
    }
    const next = existing.content.slice(0, first) + replace + existing.content.slice(first + find.length);
    if (Buffer.byteLength(next, "utf8") > maxWriteBytes) return { ok: false, error: "Result is too large." };
    capture(taskId, resolved, existing.content);
    fs.writeFileSync(resolved.absolute, next, "utf8");
    remember(taskId, resolved, next);
    return { ok: true, path: resolved.relative, diff: unifiedDiff(existing.content, next, resolved.relative) };
  }

  function remove(taskId, inputPath) {
    const resolved = policy.resolve(inputPath);
    if (!resolved.ok) return resolved;
    const existing = readResolved(resolved);
    if (!existing.ok) return existing;
    const concurrent = guardConcurrent(taskId, resolved);
    if (!concurrent.ok) return concurrent;
    capture(taskId, resolved, existing.content);
    fs.unlinkSync(resolved.absolute);
    lastHash.delete(taskId + "\u0000" + resolved.relative);
    return { ok: true, path: resolved.relative, diff: unifiedDiff(existing.content, "", resolved.relative) };
  }

  // Restores every path this task touched, newest first.
  function undo(taskId) {
    const store = checkpoints.get(taskId);
    if (!store || !store.size) return { ok: false, error: "Nothing to undo for this task." };
    const restored = [];
    const failed = [];
    for (const [relative, entry] of [...store.entries()].reverse()) {
      try {
        if (entry.before === null) {
          if (fs.existsSync(entry.absolute)) fs.unlinkSync(entry.absolute);
          restored.push({ path: relative, action: "deleted" });
        } else {
          fs.mkdirSync(path.dirname(entry.absolute), { recursive: true });
          fs.writeFileSync(entry.absolute, entry.before, "utf8");
          restored.push({ path: relative, action: "restored" });
        }
      } catch (error) {
        failed.push({ path: relative, error: String(error && error.message ? error.message : error).slice(0, 200) });
      }
    }
    for (const relative of store.keys()) lastHash.delete(taskId + "\u0000" + relative);
    store.clear();
    return { ok: true, restored, failed };
  }

  function changedPaths(taskId) {
    const store = checkpoints.get(taskId);
    return store ? [...store.keys()].sort() : [];
  }

  return Object.freeze({ write, edit, remove, undo, changedPaths, hashContent });
}
