// Run with:  node --test tests/path-policy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createPathPolicy, inspectRelativePath, matchesPattern, DEFAULT_PROTECTED_PATTERNS } from "../authorization/path-policy.js";

const root = path.resolve("/tmp/ultron-workspace");
const policy = createPathPolicy({ root });

test("workspace-relative paths resolve inside the root", () => {
  const resolved = policy.resolve("src/auth/redirect.js");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.absolute, path.join(root, "src/auth/redirect.js"));
  assert.equal(resolved.relative, "src/auth/redirect.js");
  assert.equal(policy.resolve("./src/a.js").relative, "src/a.js");
  assert.equal(policy.resolve(".").relative, ".");
});

test("traversal, absolute paths and drive letters are rejected", () => {
  const attacks = [
    "../outside.txt", "src/../../outside.txt", "/etc/passwd", "//server/share", "C:/Windows/win.ini",
    "c:\\windows\\win.ini", "src\\a.js", "src//a.js", "", "a".repeat(2000),
  ];
  for (const attack of attacks) {
    const resolved = policy.resolve(attack);
    assert.equal(resolved.ok, false, JSON.stringify(attack));
  }
  assert.equal(policy.resolve("a\u0000b").ok, false);
});

test("inspectRelativePath normalizes dot segments but never allows parent traversal", () => {
  assert.deepEqual(inspectRelativePath("./a/./b.js"), { ok: true, path: "a/b.js" });
  assert.equal(inspectRelativePath("a/../b.js").ok, false);
  assert.equal(inspectRelativePath("..").ok, false);
  assert.equal(inspectRelativePath(5).ok, false);
});

test("protected files are refused even inside the workspace", () => {
  for (const file of [".env", ".env.local", "config/.env", ".git/config", ".ssh/id_rsa", "keys/server.pem", "a/b/id_ed25519", ".npmrc", "credentials.json", "service-account-prod.json"]) {
    assert.equal(policy.resolve(file).ok, false, file);
    assert.equal(policy.isProtected(file), true, file);
  }
  for (const file of ["src/index.js", "README.md", "config/app.json", "keys/public.txt", ".ultron/instructions.md"]) {
    assert.equal(policy.resolve(file).ok, true, file);
  }
  assert.ok(DEFAULT_PROTECTED_PATTERNS.includes(".env"));
});

test("symlinks that escape the root are rejected", () => {
  const linked = createPathPolicy({
    root,
    realpath: (absolute) => (absolute.endsWith("escape") ? "/etc" : absolute),
  });
  assert.equal(linked.resolve("escape").ok, false);
  assert.equal(linked.resolve("src/ok.js").ok, true);
  const missing = createPathPolicy({ root, realpath: () => { throw new Error("ENOENT"); } });
  assert.equal(missing.resolve("src/ok.js").ok, false);
});

test("glob matching supports directories, dotfiles and extensions", () => {
  assert.equal(matchesPattern("**/*.pem", "a/b/cert.pem"), true);
  assert.equal(matchesPattern("**/*.pem", "cert.pem"), true);
  assert.equal(matchesPattern("src/*.js", "src/a.js"), true);
  assert.equal(matchesPattern("src/*.js", "src/deep/a.js"), false);
  assert.equal(matchesPattern("src/**/a.js", "src/x/y/a.js"), true);
  assert.equal(matchesPattern(".env.*", ".env.local"), true);
  assert.equal(matchesPattern(".env.*", "src/.env.local"), false);
  assert.equal(matchesPattern("file?.txt", "file1.txt"), true);
  assert.equal(matchesPattern("a.b", "aXb"), false, "dots are literal");
});

test("listing cannot reach git internals or leave the workspace", () => {
  assert.equal(policy.resolveForListing("src").ok, true);
  assert.equal(policy.resolveForListing(".git").ok, false);
  assert.equal(policy.resolveForListing("../x").ok, false);
  assert.equal(policy.resolveForListing("").ok, true);
});

test("a root is required", () => {
  assert.throws(() => createPathPolicy({}), /root is required/);
  assert.throws(() => createPathPolicy({ root: "  " }), /root is required/);
});
