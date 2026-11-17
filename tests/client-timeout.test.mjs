import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const body = (name) => {
  const start = html.indexOf("async function " + name + "(");
  assert.ok(start > -1, name + " exists");
  const next = html.indexOf("\nasync function ", start + 10);
  return html.slice(start, next > -1 ? next : undefined);
};
test("the 60s browser timer is an idle timer that every chunk restarts", () => {
  const once = body("requestOnce");
  assert.match(once, /const arm = \(\) =>/);
  assert.match(once, /readWorkerReply\(res, onChunk, arm\)/);
  const read = body("readWorkerReply");
  assert.match(read, /readWorkerReply\(response, onChunk, onActivity\)|async function readWorkerReply\(response, onChunk, onActivity\)/);
  assert.match(read, /reader\.read\(\);\s*if \(onActivity\) onActivity\(\);/);
});
test("the browser asks the Worker for one model, because the Worker owns the fallback chain", () => {
  const reply = body("requestWorkerReply");
  assert.match(reply, /const models = \[modelChain\(\)\[0\]\];/);
  assert.doesNotMatch(reply, /const models = modelChain\(\);/);
  assert.doesNotMatch(reply, /break; \/\/ this model is out/);
});
