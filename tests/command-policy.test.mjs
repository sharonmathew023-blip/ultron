// Run with:  node --test tests/command-policy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { checkCommand, createCommandPolicy, DEFAULT_COMMAND_POLICY } from "../authorization/command-policy.js";

test("allowlisted build, test and read commands are allowed", () => {
  for (const command of ["npm test", "npm run lint", "npm run build", "node", "pytest", "git status", "git diff", "ls -la"]) {
    const checked = checkCommand(command);
    assert.equal(checked.action, "allow", command);
  }
  assert.deepEqual(checkCommand("npm test").tokens, ["npm", "test"]);
  assert.deepEqual(checkCommand("npm test").args, ["test"]);
});

test("installs and commits need approval", () => {
  for (const command of ["npm install left-pad", "npm ci", "pip install requests", "git commit -m x", "yarn add zod"]) {
    assert.equal(checkCommand(command).action, "ask", command);
  }
});

test("dangerous commands are denied outright", () => {
  for (const command of [
    "sudo npm test", "rm -rf /", "git push origin main", "chmod 777 file", "curl https://example.com",
    "ssh host", "docker ps", "npm publish", "wrangler deploy", "kill 1", "sh -c ls",
  ]) {
    assert.equal(checkCommand(command).action, "deny", command);
  }
});

test("shell operators and substitution are denied", () => {
  const attacks = [
    "npm test; rm -rf /", "npm test && whoami", "npm test || whoami", "npm test | tee x",
    "npm test > out.txt", "npm test < input", "node $(whoami)", "node `id`", "npm test\nrm -rf /",
    "npm test &", "node ${HOME}",
  ];
  for (const attack of attacks) {
    assert.equal(checkCommand(attack).action, "deny", attack);
  }
});

test("eval-style arguments are denied even under an allowed binary", () => {
  for (const command of ["node -e process.exit(1)", "node --eval x", "python -c print(1)"]) {
    assert.equal(checkCommand(command).action, "deny", command);
  }
});

test("unknown commands ask, never silently run", () => {
  const checked = checkCommand("frobnicate --all");
  assert.equal(checked.action, "ask");
  assert.equal(checked.file, "frobnicate");
});

test("empty, oversized and malformed commands are denied", () => {
  for (const command of ["", "   ", null, undefined, 42, "a".repeat(600), "echo 'unbalanced"]) {
    assert.equal(checkCommand(command).action, "deny", JSON.stringify(command));
  }
});

test("deny wins over a matching allow and ask", () => {
  const policy = createCommandPolicy({ allow: ["npm publish"], ask: ["npm publish"], deny: ["npm publish"] });
  assert.equal(policy.check("npm publish").action, "deny");
});

test("a broader allow does not override a narrower ask", () => {
  const policy = createCommandPolicy({ allow: ["npm"], ask: ["npm install"], deny: [] });
  assert.equal(policy.check("npm install lodash").action, "ask");
  assert.equal(policy.check("npm test").action, "allow");
});

test("quoted arguments are kept as one token and quoting is not a bypass", () => {
  const policy = createCommandPolicy({ allow: ["echo"], ask: [], deny: [] });
  const checked = policy.check('echo "hello world"');
  assert.equal(checked.action, "allow");
  assert.deepEqual(checked.tokens, ["echo", "hello world"]);
  assert.equal(policy.check('echo "; rm -rf /"').action, "deny");
});

test("a wildcard rule matches the rest of the argv", () => {
  const policy = createCommandPolicy({ allow: ["git status"], ask: [], deny: ["rm *", "sudo *", "git push*"] });
  assert.equal(policy.check("rm -rf src").action, "deny");
  assert.equal(policy.check("rm").action, "deny");
  assert.equal(policy.check("sudo apt update").action, "deny");
  assert.equal(policy.check("git push --force origin main").action, "deny");
  assert.equal(policy.check("git status").action, "allow");
  assert.equal(policy.check("git status --short").action, "allow");
});

test("the default policy is frozen", () => {
  assert.ok(Object.isFrozen(DEFAULT_COMMAND_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_COMMAND_POLICY.deny));
});
