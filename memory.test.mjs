import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { selectRelevantFacts, searchRelevantFacts, tokenize } = require("./memory.js");

test("tokenizer ignores common words and keeps useful terms", () => {
  const tokens = tokenize("How can I make this photo warm in Lightroom?");
  assert.ok(tokens.has("photo"));
  assert.ok(tokens.has("warm"));
  assert.ok(tokens.has("lightroom"));
  assert.ok(!tokens.has("this"));
});

test("relevance scoring prioritizes matching preferences and omits unrelated notes", () => {
  const now = Date.now();
  const warm = { text: "I prefer warm color grading in Lightroom", updatedAt: now };
  const concise = { text: "I like concise answers", updatedAt: now };
  const bike = { text: "I ride a 125cc motorcycle", updatedAt: now };
  const selected = selectRelevantFacts("Make this photo warm with Lightroom color grading", [concise, bike, warm], 12);
  assert.equal(selected[0], warm);
  assert.ok(!selected.includes(bike));
  assert.ok(!selected.includes(concise));
});

test("relevance result is bounded and does not mutate stored facts", () => {
  const facts = Array.from({ length: 20 }, (_, i) => ({ text: `I prefer cinematic editing style ${i}`, updatedAt: Date.now() - i }));
  const before = JSON.stringify(facts);
  assert.equal(selectRelevantFacts("cinematic editing style", facts, 5).length, 5);
  assert.equal(JSON.stringify(facts), before);
});

test("unmatched and empty queries fall back to a small recent set", () => {
  const facts = Array.from({ length: 10 }, (_, i) => ({ text: `Preference ${i}`, updatedAt: i }));
  assert.deepEqual(selectRelevantFacts("no matching terms qwerty", facts, 12).map(f => f.text), ["Preference 9", "Preference 8", "Preference 7", "Preference 6"]);
  assert.equal(selectRelevantFacts("", facts, 12).length, 5);
});

test("memory search returns only matching facts", () => {
  const facts = [{ text: "I prefer warm color grading" }, { text: "I like concise answers" }, { text: "I edit photos in Lightroom" }];
  assert.deepEqual(searchRelevantFacts("warm grading", facts).map(f => f.text), ["I prefer warm color grading"]);
  assert.deepEqual(searchRelevantFacts("no match", facts), []);
});
