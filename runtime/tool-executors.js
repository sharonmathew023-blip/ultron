// ULTRON tool executors.
// Real, workspace-bound implementations of the read and write tools. Every path goes
// through the path policy, every walk skips noise and protected files, and every command
// goes through the command policy before spawn.

import fsImpl from "node:fs";
import path from "node:path";
import { matchesPattern } from "../authorization/path-policy.js";
import { CONTEXT_LIMITS, isNoisePath } from "../agent/context-manager.js";
import { SANDBOX_LIMITS } from "./sandbox-policy.js";

const PROJECT_MARKERS = ["package.json", "pyproject.toml", "pytest.ini", "go.mod", "Cargo.toml", "Makefile"];

function isProtectedRelative(policy, relative) {
  return policy.isProtected(relative);
}

export function walkFiles({ policy, fs = fsImpl, maxFiles = 4000, maxDepth = 10 } = {}) {
  const found = [];
  const queue = [{ absolute: policy.root, relative: ".", depth: 0 }];
  while (queue.length && found.length < maxFiles) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = current.relative === "." ? entry.name : current.relative + "/" + entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isNoisePath(relative) || entry.name.startsWith(".git")) continue;
        if (current.depth + 1 > maxDepth) continue;
        queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isProtectedRelative(policy, relative)) continue;
      found.push(relative);
      if (found.length >= maxFiles) break;
    }
  }
  return found.sort();
}

export function createToolExecutors({ policy, patchManager, commandRunner, fs = fsImpl, limits = SANDBOX_LIMITS } = {}) {
  if (!policy) throw new Error("A path policy is required.");
  const executors = {};

  executors["workspace.list"] = ({ path: inputPath, depth = 1 }) => {
    const resolved = policy.resolveForListing(inputPath);
    if (!resolved.ok) return resolved;
    const results = [];
    const queue = [{ absolute: resolved.absolute, relative: resolved.relative, depth: 0 }];
    while (queue.length && results.length < limits.maxListEntries) {
      const current = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(current.absolute, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith(".git")) continue;
        const relative = current.relative === "." ? entry.name : current.relative + "/" + entry.name;
        if (isProtectedRelative(policy, relative)) continue;
        const type = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file";
        const item = { path: relative, type };
        if (type === "file") {
          try {
            item.size = fs.statSync(path.join(current.absolute, entry.name)).size;
          } catch {
            item.size = null;
          }
        }
        results.push(item);
        if (entry.isDirectory() && current.depth + 1 < Math.max(1, Math.min(4, depth))) {
          queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        }
        if (results.length >= limits.maxListEntries) break;
      }
    }
    return { path: resolved.relative, entries: results, truncated: results.length >= limits.maxListEntries };
  };

  executors["file.read"] = ({ path: inputPath, startLine = 1, maxLines = 2000 }) => {
    const resolved = policy.resolve(inputPath);
    if (!resolved.ok) return resolved;
    let stat;
    try {
      stat = fs.statSync(resolved.absolute);
    } catch {
      return { ok: false, error: "File does not exist." };
    }
    if (!stat.isFile()) return { ok: false, error: "Path is not a file." };
    if (stat.size > limits.maxReadBytes) return { ok: false, error: "File is too large to read." };
    const content = fs.readFileSync(resolved.absolute, "utf8");
    if (content.includes("\u0000")) return { ok: false, error: "File appears to be binary." };
    const lines = content.split("\n");
    const from = Math.max(0, Math.min(lines.length, startLine - 1));
    const slice = lines.slice(from, from + Math.max(1, Math.min(5000, maxLines)));
    return {
      path: resolved.relative,
      startLine: from + 1,
      endLine: from + slice.length,
      totalLines: lines.length,
      truncated: from + slice.length < lines.length,
      content: slice.join("\n"),
    };
  };

  executors["file.glob"] = ({ pattern, maxResults = 100 }) => {
    const files = walkFiles({ policy, fs });
    const matches = files.filter((relative) => matchesPattern(pattern, relative)
      || (!pattern.includes("/") && matchesPattern("**/" + pattern, relative)));
    return { pattern, matches: matches.slice(0, Math.min(200, maxResults)), truncated: matches.length > maxResults };
  };

  executors["file.search"] = ({ query, glob, maxResults = 50 }) => {
    const files = walkFiles({ policy, fs });
    const candidates = glob ? files.filter((relative) => matchesPattern(glob, relative)) : files;
    const results = [];
    for (const relative of candidates) {
      if (results.length >= Math.min(200, maxResults)) break;
      const resolved = policy.resolve(relative);
      if (!resolved.ok) continue;
      let stat;
      try {
        stat = fs.statSync(resolved.absolute);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > 512_000) continue;
      let content;
      try {
        content = fs.readFileSync(resolved.absolute, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes(query)) continue;
        results.push({ path: relative, line: index + 1, text: lines[index].trim().slice(0, 300) });
        if (results.length >= Math.min(200, maxResults)) break;
      }
    }
    return { query, matches: results, truncated: results.length >= Math.min(200, maxResults) };
  };

  const runReadCommand = async (command) => {
    if (!commandRunner) return { ok: false, error: "Command runner is not available." };
    const result = await commandRunner.run({ command, timeoutMs: 30000 });
    return {
      ok: result.ok === true,
      exitCode: result.exitCode,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: result.error,
    };
  };

  executors["git.status"] = () => runReadCommand("git status --porcelain=v1");

  executors["git.diff"] = ({ path: inputPath, staged = false }) => {
    let command = "git diff";
    if (staged) command += " --staged";
    if (inputPath) {
      const resolved = policy.resolve(inputPath);
      if (!resolved.ok) return resolved;
      if (/\s/.test(resolved.relative)) return { ok: false, error: "Diff paths cannot contain spaces." };
      command += " -- " + resolved.relative;
    }
    return runReadCommand(command);
  };

  executors["test.detect"] = () => {
    const files = walkFiles({ policy, fs });
    const markers = PROJECT_MARKERS.filter((marker) => files.includes(marker));
    const testFiles = files.filter((relative) => /(\.test\.|\.spec\.|^tests?\/|__tests__\/|_test\.(go|py|rb)$|^test_)/.test(relative));
    let command = null;
    let framework = null;
    if (markers.includes("package.json")) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(policy.root, "package.json"), "utf8"));
        const scripts = pkg && pkg.scripts ? pkg.scripts : {};
        if (typeof scripts.test === "string" && !/no test specified/i.test(scripts.test)) {
          command = "npm test";
          framework = "npm";
        }
        if (typeof scripts.lint === "string") framework = framework || "npm";
      } catch {
        // A malformed package.json is reported as undetected, never thrown at the UI.
      }
    }
    if (!command && markers.includes("pyproject.toml")) { command = "python -m pytest"; framework = "pytest"; }
    if (!command && markers.includes("pytest.ini")) { command = "pytest"; framework = "pytest"; }
    if (!command && markers.includes("go.mod")) { command = "go test ./..."; framework = "go"; }
    if (!command && markers.includes("Cargo.toml")) { command = "cargo test"; framework = "cargo"; }
    return { markers, command, framework, testFiles: testFiles.slice(0, 200), truncated: testFiles.length > 200 };
  };

  const write = (context, tool) => {
    if (!patchManager) return { ok: false, error: "Editing is not enabled in this runtime." };
    if (!context || typeof context.taskId !== "string" || !context.taskId) {
      return { ok: false, error: "A task id is required for edits." };
    }
    return null;
  };

  executors["file.write"] = ({ path: inputPath, content }, context) => {
    const guard = write(context, "file.write");
    if (guard) return guard;
    return patchManager.write(context.taskId, inputPath, content);
  };

  const editExecutor = ({ path: inputPath, find, replace = "" }, context) => {
    const guard = write(context, "file.edit");
    if (guard) return guard;
    return patchManager.edit(context.taskId, inputPath, find, replace);
  };
  executors["file.edit"] = editExecutor;
  executors["patch.apply"] = editExecutor;

  executors["file.delete"] = ({ path: inputPath }, context) => {
    const guard = write(context, "file.delete");
    if (guard) return guard;
    return patchManager.remove(context.taskId, inputPath);
  };

  const runCommand = async ({ command, cwd, timeoutMs }, context, fallbackCommand) => {
    if (!commandRunner) return { ok: false, error: "Command runner is not available." };
    const finalCommand = command || fallbackCommand;
    if (!finalCommand) return { ok: false, error: "No command was provided and none could be detected." };
    const result = await commandRunner.run({
      command: finalCommand,
      cwd,
      timeoutMs,
      onOutput: (chunk) => context && typeof context.onOutput === "function" ? context.onOutput(chunk) : undefined,
    });
    if (result.denied) return { ok: false, error: result.error };
    return result;
  };

  executors["shell.run"] = ({ command, cwd, timeoutMs }, context) => runCommand({ command, cwd, timeoutMs }, context, null);
  executors["test.run"] = ({ command, timeoutMs }, context) => runCommand({ command, timeoutMs }, context, null);
  executors["lint.run"] = ({ command, timeoutMs }, context) => runCommand({ command, timeoutMs }, context, null);
  executors["build.run"] = ({ command, timeoutMs }, context) => runCommand({ command, timeoutMs }, context, null);

  return executors;
}

// Bounded file listing used by the context manager when a task starts.
export function listWorkspacePaths(policy, fs = fsImpl) {
  return walkFiles({ policy, fs, maxFiles: CONTEXT_LIMITS.maxTreeEntries });
}
