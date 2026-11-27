// ULTRON command runner.
// No shell, no inherited secrets, a fixed timeout and a byte cap. Only policy-approved
// commands reach spawn, and the whole process group is killed when time runs out.

import { spawn as spawnImpl } from "node:child_process";
import path from "node:path";
import { buildEnvironment, capOutput, clampTimeout, redactSecrets, SANDBOX_LIMITS } from "./sandbox-policy.js";

export function createCommandRunner({ policy, spawn = spawnImpl, env = process.env, limits = SANDBOX_LIMITS } = {}) {
  if (!policy || typeof policy.resolve !== "function") throw new Error("A path policy is required.");
  const commandPolicy = policy.commandPolicy || null;

  // Resolves and validates the working directory; it must stay inside the workspace.
  function resolveCwd(cwd) {
    if (cwd === undefined || cwd === null || cwd === "" || cwd === ".") {
      return { ok: true, absolute: policy.root };
    }
    const resolved = policy.resolveForListing ? policy.resolveForListing(cwd) : policy.resolve(cwd);
    if (!resolved.ok) return resolved;
    return { ok: true, absolute: resolved.absolute };
  }

  function run({ command, cwd, timeoutMs, extraEnv = {}, onOutput } = {}) {
    const checked = commandPolicy ? commandPolicy.check(command) : { action: "deny", reason: "No command policy configured." };
    if (checked.action === "deny") return Promise.resolve({ ok: false, error: checked.reason, denied: true });
    const dir = resolveCwd(cwd);
    if (!dir.ok) return Promise.resolve({ ok: false, error: dir.error });
    const timeout = clampTimeout(timeoutMs);
    const stdio = ["ignore", "pipe", "pipe"];

    return new Promise((resolve) => {
      let child;
      const startedAt = Date.now();
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let truncated = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;

      try {
        child = spawn(checked.file, checked.args, {
          cwd: dir.absolute,
          env: buildEnvironment(env, extraEnv),
          shell: false,
          detached: true,
          stdio,
        });
      } catch (error) {
        resolve({ ok: false, error: "Could not start command: " + String(error && error.message ? error.message : error).slice(0, 200) });
        return;
      }

      const collect = (chunks, chunk, stream) => {
        const size = chunk.length;
        const used = stream === "stdout" ? stdoutBytes : stderrBytes;
        const room = limits.maxOutputBytes - used;
        if (room <= 0) {
          truncated = true;
          if (stream === "stdout") stdoutTruncated = true;
          else stderrTruncated = true;
          return;
        }
        const slice = size > room ? chunk.subarray(0, room) : chunk;
        if (size > room) {
          truncated = true;
          if (stream === "stdout") stdoutTruncated = true;
          else stderrTruncated = true;
        }
        chunks.push(slice);
        if (stream === "stdout") stdoutBytes += slice.length;
        else stderrBytes += slice.length;
        if (typeof onOutput === "function" && slice.length) {
          try {
            onOutput({ stream, text: redactSecrets(slice.toString("utf8")).slice(0, 4000) });
          } catch {
            // Streaming is best-effort; it must not fail the command.
          }
        }
      };

      if (child.stdout) child.stdout.on("data", (chunk) => collect(stdout, chunk, "stdout"));
      if (child.stderr) child.stderr.on("data", (chunk) => collect(stderr, chunk, "stderr"));

      const killGroup = (signal) => {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try { child.kill(signal); } catch { /* already gone */ }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 1500).unref?.();
      }, timeout);

      const finish = (exitCode, signal, errorMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = capOutput(Buffer.concat(stdout), limits.maxOutputBytes, stdoutTruncated);
        const err = capOutput(Buffer.concat(stderr), limits.maxOutputBytes, stderrTruncated);
        resolve({
          ok: errorMessage ? false : timedOut ? false : exitCode === 0,
          error: errorMessage || (timedOut ? "Command timed out after " + timeout + "ms." : undefined),
          command: command.trim(),
          cwd: dir.absolute,
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          signal: signal || null,
          timedOut,
          truncated: truncated || out.truncated || err.truncated,
          durationMs: Date.now() - startedAt,
          stdout: redactSecrets(out.text),
          stderr: redactSecrets(err.text),
        });
      };

      child.on("error", (error) => finish(null, null, String(error && error.message ? error.message : error).slice(0, 200)));
      child.on("close", (code, signal) => finish(code, signal, null));
    });
  }

  return Object.freeze({ run, resolveCwd });
}

// Splits a policy result into the argv a caller would spawn, for tests and diagnostics.
export function describeCommand(checked) {
  if (!checked || !checked.file) return { file: null, args: [], cwd: null };
  return { file: path.basename(checked.file), args: checked.args.slice(), cwd: checked.cwd || null };
}
