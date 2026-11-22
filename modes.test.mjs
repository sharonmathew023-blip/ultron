// Run with:  node --test modes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { MODES, applyMode, forBackupProvider } from "./modes.js";

const base = () => ({ messages: [{ role: "user", content: "hi" }] });

test("chat and missing mode change nothing", () => {
  for (const mode of [undefined, "chat", ""]) {
    const input = { ...base(), mode };
    assert.equal(applyMode(input), null);
    assert.equal(input.messages.length, 1);
    assert.equal(input.web_search, undefined);
  }
});

test("unknown and inherited names are ignored", () => {
  for (const mode of ["admin", "__proto__", "constructor", "toString", 7, null, {}]) {
    const input = { ...base(), mode };
    assert.equal(applyMode(input), null);
    assert.equal(input.messages.length, 1);
  }
});

test("research adds its prompt first and turns on Google Search", () => {
  const input = { ...base(), mode: "research" };
  assert.equal(applyMode(input), "research");
  assert.equal(input.messages[0].role, "system");
  assert.equal(input.messages[0].content, MODES.research.system);
  assert.equal(input.messages[1].content, "hi");
  assert.equal(input.web_search, true);
});

test("only chat and research are supported modes", () => {
  assert.deepEqual(Object.keys(MODES), ["research"]);
  for (const mode of ["agent", "studio", "developer", "workspace", "voice"]) {
    const input = { ...base(), mode };
    assert.equal(applyMode(input), null);
    assert.equal(input.messages.length, 1);
    assert.equal(input.web_search, undefined);
  }
});

test("backup provider: research swaps its search prompt for a no-search one", () => {
  const input = { ...base(), mode: "research" };
  applyMode(input);
  const copy = forBackupProvider(input, "research");
  assert.equal(copy.messages[0].content, MODES.research.fallbackSystem);
  assert.doesNotMatch(copy.messages[0].content, /Use Google Search/);
  assert.match(copy.messages[0].content, /never invent sources/);
  assert.equal(copy.messages[1].content, "hi");
  assert.equal(input.messages[0].content, MODES.research.system, "the original request is not changed");
});

test("backup provider: the plain search toggle gets a no-search note", () => {
  const input = { ...base(), web_search: true };
  const copy = forBackupProvider(input, null);
  assert.equal(copy.messages.length, 2);
  assert.equal(copy.messages[0].role, "system");
  assert.match(copy.messages[0].content, /not available/);
  assert.equal(input.messages.length, 1);
});

test("backup provider: requests without search pass through untouched", () => {
  const input = { ...base(), mode: "chat" };
  assert.equal(applyMode(input), null);
  assert.equal(forBackupProvider(input, "chat"), input);
});
