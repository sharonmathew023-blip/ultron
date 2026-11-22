import fs from "node:fs";
import assert from "node:assert/strict";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const frontendPaths = ["../index.html", "../skill-engine.js", "../skill-rules.js", "../builtin-skills.js"];
const frontend = frontendPaths.map(read).join("\n");
const worker = read("../worker.js");
const skillEngine = read("../skill-engine.js");
const wrangler = read("../wrangler.toml");

// Never commit recognizable provider credentials or provider model IDs into browser-delivered files.
const credentialPatterns = [
  /AIza[0-9A-Za-z_-]{30,}/,
  /gsk_[0-9A-Za-z]{20,}/,
  /sk-[0-9A-Za-z]{24,}/,
  /xox[baprs]-[0-9A-Za-z-]{20,}/
];
for (const pattern of credentialPatterns) {
  assert.equal(pattern.test(frontend), false, `browser bundle contains a credential matching ${pattern}`);
}

// The private Worker admin token must not be present in the browser UI or requests.
for (const fragment of ["accessTokenInput", "state.accessToken", "X-ULTRON-Admin-Token"]) {
  assert.equal(frontend.includes(fragment), false, `browser code must not contain ${fragment}`);
}
assert.match(frontend, /delete restored\.accessToken/, "legacy stored admin tokens are scrubbed on restore");
assert.ok(skillEngine.includes("if (!/\\.(md|txt)$/i.test(file.name))"), "direct skill uploads accept only .md and .txt");
assert.ok(skillEngine.includes("if (!/\\.(md|txt)$/i.test(fileName))"), "skill-pack entries accept only .md and .txt");
assert.doesNotMatch(skillEngine, /\\.\(md\|txt\|markdown\)/, "legacy .markdown extension is not accepted");
assert.match(frontend, /accept="\.md,\.txt,text\/markdown,text\/plain"/, "file picker matches the supported extensions");
assert.doesNotMatch(frontend, /localStorage\.setItem\(STORAGE_KEY,\s*JSON\.stringify\(state\)\)/, "raw state must never be persisted");
assert.doesNotMatch(frontend, /gemini-[a-z0-9.-]+|openai\\//i, "provider model IDs must remain server-side");
assert.match(frontend, /model: \'auto\'/, "browser defaults to an abstract model tier");
assert.match(worker, /requestedModel === \"reasoning\"[\\s\\S]*requestedModel === \"fast\"/, "Worker resolves abstract tiers using server configuration");

// Worker secrets remain environment bindings; privileged routes use verified Google identity.
assert.match(worker, /env\.GEMINI_API_KEY/);
assert.match(worker, /env\.AI\.run/ , "FLUX uses the server-side Workers AI binding");
assert.match(worker, /@cf\/black-forest-labs\/flux-1-schnell/ , "image requests use FLUX Schnell");
assert.match(worker, /env\.COMPOSIO_API_KEY/);
assert.match(worker, /https:\/\/connect\.composio\.dev\/mcp/, "Composio uses the consumer MCP endpoint");
assert.match(worker, /"x-consumer-api-key": apiKey/, "consumer keys use the consumer authentication header");
assert.doesNotMatch(worker, /backend\.composio\.dev\/api\/v3\.1|["']x-api-key["']/, "consumer keys are never sent to the Platform REST API");
assert.match(worker, /COMPOSIO_MANAGE_CONNECTIONS/, "consumer MCP manages app connections");
assert.match(worker, /readOnlyPattern/, "connected-app execution remains read-only");
assert.doesNotMatch(worker, /env\.ACCESS_TOKEN|X-ULTRON-Admin-Token/);
assert.match(worker, /function authenticateGoogleRequest\(/);
assert.match(worker, /function isUltronOwner\(/);
assert.match(worker, /path === "\/browse"[\s\S]*?isUltronOwner\(auth\.identity, env\)/);
assert.ok((worker.match(/isUltronOwner\(/g) || []).length >= 3, "Composio routes and tool execution must enforce owner identity");
assert.match(worker, /env\.ULTRON_OWNER_EMAIL/);

// Wrangler contains public configuration only, never secret assignments.
assert.doesNotMatch(wrangler, /(?:GEMINI_API_KEY|COMPOSIO_API_KEY|ACCESS_TOKEN|ULTRON_OWNER_EMAIL)\s*=/);
assert.match(wrangler, /\[ai\]\s+binding = "AI"/, "Workers AI binding is declared for deployments");

// Verify the configured default chain and that the chain builder preserves order.
assert.match(wrangler, /DEFAULT_MODEL = "gemini-3\.5-flash"/);
assert.match(wrangler, /FALLBACK_MODELS = "gemini-3\.6-flash,gemini-flash-lite-latest"/);
assert.match(worker, /const DEFAULT_MODEL = "gemini-3\.5-flash"/);
assert.match(worker, /const DEFAULT_FALLBACKS = "gemini-3\.6-flash,gemini-flash-lite-latest"/);
assert.match(worker, /add\(env\.FALLBACK_MODEL\)[\s\S]*FALLBACK_MODELS[^\n]*split\(\",\"\)/);

console.log("security self-check: browser secret boundary, owner authorization, Wrangler secret hygiene, and model fallback order passed");
