import test from "node:test";
import assert from "node:assert/strict";
import { applyUltronIdentity, ULTRON_IDENTITY_PROMPT } from "./identity.js";
import { applyMode, forBackupProvider } from "./modes.js";

test("core identity is injected once and remains server-owned", () => {
  const input = { messages: [{ role: "user", content: "Who are you?" }] };
  applyUltronIdentity(input);
  applyUltronIdentity(input);
  assert.equal(input.messages.filter((m) => m.role === "system" && m.content === ULTRON_IDENTITY_PROMPT).length, 1);
  assert.match(input.messages.at(-1).content, /Sharon Mathew/);
  assert.match(input.messages.at(-1).content, /OpenClaude/);
  assert.match(input.messages.at(-1).content, /Vibecoded it 🫩🥀/);
  assert.match(ULTRON_IDENTITY_PROMPT, /Claude, ChatGPT, Gemini, and Freebuff/);
  assert.match(ULTRON_IDENTITY_PROMPT, /substantial, clearly sectioned introduction/i);
  assert.match(ULTRON_IDENTITY_PROMPT, /Cloudflare KV/);
});

test("ULTRON includes its custom inappropriate-content and large-task catchphrases", () => {\n  assert.match(ULTRON_IDENTITY_PROMPT, /Ninte uddesham enikku manassilayi, ath ivide nadakilla/);\n  assert.match(ULTRON_IDENTITY_PROMPT, /Ith ennekond koottiyal koodilla mone, nee ChatGPT aduth choyich nokk/);\n  assert.match(ULTRON_IDENTITY_PROMPT, /Do not use that catchphrase for legitimate sexual-health/i);\n});\n\ntest("identity composes with server-owned modes and survives Groq backup conversion", () => {
  const input = { mode: "research", messages: [{ role: "user", content: "Explain ULTRON" }] };
  assert.equal(applyMode(input), "research");
  applyUltronIdentity(input);
  const backup = forBackupProvider(input, "research");
  const systemText = backup.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(systemText, /Sharon Mathew/);
  assert.match(systemText, /OpenClaude/);
  assert.match(systemText, /not available for this answer|Web search is not available/i);
  assert.equal(input.messages.filter((m) => m.role === "system" && m.content === ULTRON_IDENTITY_PROMPT).length, 1);
});

test("professional artifacts and sensitive conversations are explicitly protected from forced snark", () => {
  assert.match(ULTRON_IDENTITY_PROMPT, /professional writing/i);
  assert.match(ULTRON_IDENTITY_PROMPT, /Do not force jokes into sensitive conversations/i);
  assert.match(ULTRON_IDENTITY_PROMPT, /never cruelty/i);
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
test("Cloudflare Worker injects the core identity after its mode prompt", () => {
  const worker = fs.readFileSync(path.join(here, "worker.js"), "utf8");
  assert.match(worker, /import \{ applyUltronIdentity \} from \"\.\/identity\.js\"/);
  assert.match(worker, /const activeMode = applyMode\(input\);\s*applyUltronIdentity\(input\)/);
});
