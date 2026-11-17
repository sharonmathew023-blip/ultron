// Run with:  node --test worker.fallback.test.mjs   (Node 20+, worker.js in the same folder)
// End-to-end: the real fetch handler with Gemini down and the Groq backup.
// A real RS256 token is signed and its public key is served as Google's JWKS,
// so the handler's own sign-in check runs. Only Gemini and Groq are mocked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let source = fs.readFileSync(path.join(here, "worker.js"), "utf8");
for (const [name, value] of [["HEADERS_TIMEOUT_MS", 300], ["BACKOFF_BASE_MS", 20], ["BACKOFF_MAX_MS", 100], ["MIN_ATTEMPT_MS", 50], ["TOTAL_BUDGET_MS", 5000]]) {
  const re = new RegExp(`const ${name} = [0-9_]+;`);
  assert.ok(re.test(source), `constant ${name} not found in worker.js`);
  source = source.replace(re, `const ${name} = ${value};`);
}
source += `
export function __reset() { memCooldowns.clear(); kvCooldownCache = { at: 0, map: {} }; }
export function __resetJwks() { googleJwksCache = null; googleJwksExpiresAt = 0; googleJwksFetchedAt = 0; googleJwksInflight = null; }
`;
const tmpFile = path.join(here, ".worker.fallback-under-test.mjs");
fs.writeFileSync(tmpFile, source);
process.on("exit", () => { try { fs.unlinkSync(tmpFile); } catch {} });
const W = await import(pathToFileURL(tmpFile).href);

const CLIENT_ID = "test-client-id";
const FAKE_KEY = "AIzaSyD-FAKEFAKEFAKEFAKEFAKEFAKE12345";
const realFetch = globalThis.fetch;
const origWarn = console.warn, origError = console.error;
test.beforeEach(() => { console.warn = () => {}; console.error = () => {}; });
test.afterEach(() => { globalThis.fetch = realFetch; console.warn = origWarn; console.error = origError; });

const geminiBusy = () => new Response(JSON.stringify({ error: { code: 503, message: "The model is overloaded" } }), { status: 503, headers: { "Content-Type": "application/json" } });
const groqOk = () => new Response('data: {"choices":[{"delta":{"content":"from groq"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
const groqMustNotRun = () => { throw new Error("Groq must not be called"); };

async function setup({ groq }) {
  W.__resetJwks(); W.__reset();
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid: "k1" });
  const body = b64({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "user-1", email: "user@example.com", email_verified: true, iat: now, exp: now + 600 });
  const sig = Buffer.from(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, new TextEncoder().encode(head + "." + body))).toString("base64url");
  const seen = { gemini: 0, groq: 0, groqAuth: null };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("openid-configuration")) return new Response(JSON.stringify({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" }), { status: 200 });
    if (u.includes("googleapis.com/oauth2")) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { "Cache-Control": "public, max-age=3600" } });
    if (u.includes("generativelanguage.googleapis.com")) { seen.gemini++; return geminiBusy(); }
    if (u.includes("api.groq.com")) { seen.groq++; seen.groqAuth = init.headers && init.headers.Authorization; return groq(init); }
    throw new Error("unexpected fetch: " + u);
  };
  const limiter = { limit: async () => ({ success: true }) };
  const post = (extraEnv, messages = [{ role: "user", content: "Hi" }]) => W.default.fetch(
    new Request("https://worker.test/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${head}.${body}.${sig}` },
      body: JSON.stringify({ model: "model-a", messages }),
    }),
    { GOOGLE_CLIENT_ID: CLIENT_ID, GEMINI_API_KEY: FAKE_KEY, ULTRON_USER_LIMITER: limiter, ULTRON_IP_LIMITER: limiter, DEFAULT_MODEL: "model-a", FALLBACK_MODELS: "model-b", ...extraEnv },
    { waitUntil() {} });
  return { post, seen };
}

test("Gemini 503 everywhere: handler streams the Groq backup, not Gemini's error", async () => {
  const t = await setup({ groq: groqOk });
  const res = await t.post({ GROQ_API_KEY: "gsk-test" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-ULTRON-Fallback"), "provider");
  assert.match(res.headers.get("X-ULTRON-Model"), /^groq\//);
  assert.match(await res.text(), /from groq/);
  assert.ok(t.seen.gemini > 0, "Gemini is tried first");
  assert.equal(t.seen.groq, 1);
  assert.equal(t.seen.groqAuth, "Bearer gsk-test");
});

test("Gemini 503 and no GROQ_API_KEY: clear 'backup not configured' message", async () => {
  const t = await setup({ groq: groqMustNotRun });
  const res = await t.post({});
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Groq backup is not configured/);
  assert.equal(t.seen.groq, 0);
});

test("Gemini 503 and Groq 401: 502 naming the Groq failure, key not leaked", async () => {
  const t = await setup({ groq: () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }) });
  const res = await t.post({ GROQ_API_KEY: "gsk-secret-123" });
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.match(text, /Groq backup failed/);
  assert.ok(!text.includes("gsk-secret-123"));
});

test("Gemini 503 and an image attachment: Groq is skipped and the reason is reported", async () => {
  const t = await setup({ groq: groqMustNotRun });
  const res = await t.post({ GROQ_API_KEY: "gsk-test" },
    [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }]);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /image or document attachment/);
  assert.equal(t.seen.groq, 0);
});
