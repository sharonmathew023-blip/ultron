// Run with:  node --test tests/workspace-policy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceManager, hashToken, PAIRING_CODE_TTL_MS, WORKSPACE_TOKEN_TTL_MS } from "../runtime/workspace-manager.js";

function manager(clock) {
  let counter = 0;
  let tokens = 0;
  return createWorkspaceManager({
    now: () => clock.value,
    newId: () => "ws_" + (++counter),
    newToken: () => "token_" + (++tokens) + "_secret",
    newCode: () => "ABCD1234",
  });
}

test("registering a workspace returns a one-time pairing code, never a token", () => {
  const clock = { value: 1000 };
  const ws = manager(clock);
  const registered = ws.register({ root: "/tmp/project", owner: "user_a", label: "project" });
  assert.equal(registered.ok, true);
  assert.equal(registered.workspaceId, "ws_1");
  assert.equal(registered.pairingCode, "ABCD1234");
  assert.equal(registered.root, "/tmp/project");
  assert.equal(Object.prototype.hasOwnProperty.call(registered, "token"), false);
});

test("pairing requires the right code and is single use", () => {
  const clock = { value: 1000 };
  const ws = manager(clock);
  const { workspaceId } = ws.register({ root: "/tmp/project", owner: "user_a" });
  assert.equal(ws.pair({ workspaceId, code: "WRONG" }).ok, false);
  const paired = ws.pair({ workspaceId, code: "ABCD1234" });
  assert.equal(paired.ok, true);
  assert.match(paired.token, /token_/);
  assert.equal(ws.pair({ workspaceId, code: "ABCD1234" }).ok, false, "the code cannot be replayed");
});

test("tokens authorize only their own workspace and can be revoked", () => {
  const clock = { value: 1000 };
  const ws = manager(clock);
  const first = ws.register({ root: "/tmp/one", owner: "user_a" });
  const second = ws.register({ root: "/tmp/two", owner: "user_b" });
  const tokenOne = ws.pair({ workspaceId: first.workspaceId, code: first.pairingCode }).token;
  const tokenTwo = ws.pair({ workspaceId: second.workspaceId, code: second.pairingCode }).token;
  assert.equal(ws.authorize(tokenOne).workspace.root, "/tmp/one");
  assert.equal(ws.authorize(tokenTwo).workspace.root, "/tmp/two");
  assert.equal(ws.authorize("made-up").ok, false);
  assert.equal(ws.authorize("").ok, false);
  assert.equal(ws.revoke(tokenOne).ok, true);
  assert.equal(ws.authorize(tokenOne).ok, false);
  assert.equal(ws.authorize(tokenTwo).ok, true);
});

test("a workspace cannot be paired by another account", () => {
  const clock = { value: 1000 };
  const ws = manager(clock);
  const { workspaceId, pairingCode } = ws.register({ root: "/tmp/project", owner: "user_a" });
  const attempt = ws.pair({ workspaceId, code: pairingCode, owner: "user_b" });
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /another account/);
});

test("pairing codes and tokens expire", () => {
  const clock = { value: 1000 };
  const ws = manager(clock);
  const stale = ws.register({ root: "/tmp/a", owner: "user_a" });
  clock.value += PAIRING_CODE_TTL_MS + 1;
  assert.equal(ws.pair({ workspaceId: stale.workspaceId, code: stale.pairingCode }).ok, false);

  const fresh = ws.register({ root: "/tmp/b", owner: "user_a" });
  const token = ws.pair({ workspaceId: fresh.workspaceId, code: fresh.pairingCode }).token;
  clock.value += WORKSPACE_TOKEN_TTL_MS + 1;
  assert.equal(ws.authorize(token).ok, false);
});

test("owner listings never expose tokens or code hashes", () => {
  const clock = { value: 1000 };
  const ws = manager(clock);
  const { workspaceId, pairingCode } = ws.register({ root: "/tmp/project", owner: "user_a", label: "My app" });
  ws.register({ root: "/tmp/other", owner: "user_b" });
  const before = ws.listForOwner("user_a");
  assert.equal(before.length, 1);
  assert.equal(before[0].paired, false);
  assert.equal(before[0].label, "My app");
  assert.equal(JSON.stringify(before).includes("pairingCodeHash"), false);
  ws.pair({ workspaceId, code: pairingCode });
  assert.equal(ws.listForOwner("user_a")[0].paired, true);
});

test("token hashing is stable and tokens are not stored in plain text", () => {
  assert.equal(hashToken("abc"), hashToken("abc"));
  assert.notEqual(hashToken("abc"), hashToken("abd"));
  assert.equal(hashToken("abc").length, 64);
});
