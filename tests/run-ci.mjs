// Dependency-free local entry point for every CI check, using the current Node binary.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../", import.meta.url));
const checks = [
  ["--check", "worker.js"],
  ["--check", "worker-runtime.js"],
  ["--check", "tests/latency-benchmark.mjs"],
  ["tests/inline-scripts.test.mjs"],
  ["tests/skill-engine.test.mjs"],
  ["tests/security.test.mjs"],
  ["--test", "worker.test.mjs"],
  ["--test", "tests/composer-regression.test.mjs"],
  ["--test", "modes.test.mjs"],
  ["--test", "tests/client-timeout.test.mjs"],
  ["--test", "identity.test.mjs"],
  ["--test", "tests/worker-deadline-observability.test.mjs"],
];
for (const args of checks) {
  console.log(`\n> node ${args.join(" ")}`);
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`\nAll ${checks.length} CI checks passed.`);
