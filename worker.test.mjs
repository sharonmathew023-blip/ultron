// Run with:  node --test worker.test.mjs
// Needs worker.js and skill-rules.js in the same folder. Node 20+.
//
// worker.js is loaded as-is, except the timing constants are shrunk in a temporary
// copy so the timeout and backoff tests take milliseconds instead of seconds.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let source = fs.readFileSync(path.join(here, "worker.js"), "utf8");
const shrink = (name, value) => {
  const re = new RegExp(`const ${name} = [0-9_]+;`);
  assert.ok(re.test(source), `constant ${name} not found in worker.js`);
  source = source.replace(re, `const ${name} = ${value};`);
};
shrink("HEADERS_TIMEOUT_MS", 300);
shrink("BACKOFF_BASE_MS", 20);
shrink("BACKOFF_MAX_MS", 100);
shrink("MIN_ATTEMPT_MS", 50);
shrink("TOTAL_BUDGET_MS", 5000);
source += `
export { callGemini, callGeminiJson, callGroqFallback, makeHealth, memCooldowns, redact, errorBody, toOpenAIStream, buildModelChain, readStreamTextLimited, verifyGoogleIdToken, detectImageGenerationRequest, detectImageEditRequest };
export function __reset() { memCooldowns.clear(); kvCooldownCache = { at: 0, map: {} }; }
export function __resetJwks() { googleJwksCache = null; googleJwksExpiresAt = 0; googleJwksFetchedAt = 0; googleJwksInflight = null; }
`;
const tmpFile = path.join(here, ".worker.under-test.mjs");
fs.writeFileSync(tmpFile, source);
process.on("exit", () => { try { fs.unlinkSync(tmpFile); } catch {} });
const W = await import(pathToFileURL(tmpFile).href);

const FAKE_KEY = "AIzaSyD-FAKEFAKEFAKEFAKEFAKEFAKE12345";
const enc = new TextEncoder();
const sse = (text, extra = {}) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, ...extra }] })}\n\n`;

// --- mock Gemini -----------------------------------------------------------
const realFetch = globalThis.fetch;
let calls = [];
let script = {};
const logs = [];
const origWarn = console.warn, origError = console.error;

function okStream(parts) {
  let i = 0;
  return new Response(new ReadableStream({
    async pull(ctl) {
      if (i >= parts.length) { ctl.close(); return; }
      await new Promise((r) => setTimeout(r, 5));
      ctl.enqueue(enc.encode(parts[i++]));
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const ok = (...texts) => () => okStream(texts.map((t, i) => sse(t, i === texts.length - 1 ? { finishReason: "STOP" } : {})));
const httpError = (status, message, { headers = {}, extra = {} } = {}) => () =>
  new Response(JSON.stringify({ error: { code: status, message, ...extra } }), { status, headers: { "Content-Type": "application/json", ...headers } });
const hang = () => (init) => new Promise((_, reject) =>
  init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
const errorFrameIn200 = (code, message) => () => okStream([`data: ${JSON.stringify({ error: { code, message } })}\n\n`]);

function install(map) {
  script = map;
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const model = /models\/([^:]+):/.exec(String(url))[1];
    calls.push(model);
    const steps = script[model];
    assert.ok(steps, `unexpected call to ${model}`);
    const n = calls.filter((m) => m === model).length - 1;
    const step = Array.isArray(steps) ? steps[Math.min(n, steps.length - 1)] : steps;
    return step(init);
  };
}
const count = (model) => calls.filter((m) => m === model).length;

async function drain(result) {
  assert.ok(result.res, "expected an answer, got: " + JSON.stringify(result.error));
  const reader = W.toOpenAIStream(result.res.body, result.model).getReader();
  const dec = new TextDecoder();
  let raw = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; raw += dec.decode(value, { stream: true }); }
  return raw.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(5))).map((o) => o.choices?.[0]?.delta?.content || "").join("");
}

const chain = ["model-a", "model-b", "model-c"];
const run = (c = chain) => W.callGemini(c, "{}", FAKE_KEY, W.makeHealth({}, undefined));
const cooldownSeconds = (m) => Math.round(((W.memCooldowns.get(m) || 0) - Date.now()) / 1000);

test.beforeEach(() => {
  W.__reset();
  logs.length = 0;
  console.warn = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
});
test.afterEach(() => { globalThis.fetch = realFetch; console.warn = origWarn; console.error = origError; });

// --- the happy path --------------------------------------------------------
test("healthy: first model answers, nothing rests, text streams through", async () => {
  install({ "model-a": ok("Hello", " world") });
  const r = await run();
  assert.equal(r.model, "model-a");
  assert.deepEqual(r.tried, ["model-a"]);
  assert.equal(await drain(r), "Hello world");
  assert.equal(W.memCooldowns.size, 0);
});

// --- 429 -------------------------------------------------------------------
test("429: skips to the next model with no retries, and the model rests for Google's hinted delay", async () => {
  install({
    "model-a": httpError(429, "Quota exceeded", { extra: { details: [{ retryDelay: "34s" }] } }),
    "model-b": ok("from b"),
  });
  // put the hint in the body shape Google really uses
  script["model-a"] = () => new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded", details: [{ "@type": "RetryInfo", "retryDelay": "34s" }] } }), { status: 429 });
  const r = await run();
  assert.equal(r.model, "model-b");
  assert.equal(count("model-a"), 1, "429 must not be retried on the same model");
  const s = cooldownSeconds("model-a");
  assert.ok(s >= 30 && s <= 35, `cooldown was ${s}s, expected about 34s`);
  assert.equal(await drain(r), "from b");

  // next request never touches the resting model
  install({ "model-a": ok("should not be called"), "model-b": ok("from b again") });
  const again = await run();
  assert.equal(again.model, "model-b");
  assert.equal(count("model-a"), 0, "a resting model must be skipped");
});

test("429 with a Retry-After header uses that header", async () => {
  install({ "model-a": httpError(429, "slow down", { headers: { "Retry-After": "42" } }), "model-b": ok("b") });
  await run();
  const s = cooldownSeconds("model-a");
  assert.ok(s >= 40 && s <= 43, `cooldown was ${s}s`);
});

test("429 with no hint falls back to the 60s default", async () => {
  install({ "model-a": httpError(429, "slow down"), "model-b": ok("b") });
  await run();
  const s = cooldownSeconds("model-a");
  assert.ok(s >= 58 && s <= 61, `cooldown was ${s}s`);
});

// --- 503 -------------------------------------------------------------------
test("503: retries with exponential backoff, then falls back and rests the model", async () => {
  install({ "model-a": httpError(503, "The model is overloaded"), "model-b": ok("from b") });
  const t0 = Date.now();
  const r = await run();
  const elapsed = Date.now() - t0;
  assert.equal(r.model, "model-b");
  assert.equal(count("model-a"), 3, "503 gets three attempts");
  assert.ok(elapsed >= 25, `expected backoff pauses, only ${elapsed}ms passed`);
  const s = cooldownSeconds("model-a");
  assert.ok(s >= 28 && s <= 31, `cooldown was ${s}s, expected about 30s`);

  install({ "model-a": ok("nope"), "model-b": ok("b2") });
  await run();
  assert.equal(count("model-a"), 0);
});

test("503 that recovers on retry stays on the same model and sets no cooldown", async () => {
  install({ "model-a": [httpError(503, "busy"), ok("recovered")], "model-b": ok("b") });
  const r = await run();
  assert.equal(r.model, "model-a");
  assert.equal(count("model-a"), 2);
  assert.equal(count("model-b"), 0);
  assert.equal(W.memCooldowns.size, 0);
  assert.equal(await drain(r), "recovered");
});

test("503 error frame inside a 200 stream is treated like a 503", async () => {
  install({ "model-a": errorFrameIn200(503, "The model is overloaded"), "model-b": ok("from b") });
  const r = await run();
  assert.equal(r.model, "model-b");
  assert.equal(count("model-a"), 3);
  assert.equal(await drain(r), "from b");
});

test("backoff waits grow: attempt 2 waits at least as long as attempt 1's ceiling floor", async () => {
  const stamps = [];
  install({ "model-a": () => { stamps.push(Date.now()); return httpError(503, "busy")(); }, "model-b": ok("b") });
  await run();
  const gap1 = stamps[1] - stamps[0], gap2 = stamps[2] - stamps[1];
  assert.ok(gap1 >= 8, `first pause ${gap1}ms`);
  assert.ok(gap2 >= 18, `second pause ${gap2}ms should be longer than the first ceiling floor`);
});

// --- timeout ---------------------------------------------------------------
test("timeout: aborts a stalled model, moves on without retrying it, and rests it", async () => {
  install({ "model-a": hang(), "model-b": ok("from b") });
  const t0 = Date.now();
  const r = await run();
  const elapsed = Date.now() - t0;
  assert.equal(r.model, "model-b");
  assert.equal(count("model-a"), 1, "a stalled model is not retried");
  assert.ok(elapsed >= 280 && elapsed < 2000, `elapsed ${elapsed}ms`);
  const s = cooldownSeconds("model-a");
  assert.ok(s >= 18 && s <= 21, `cooldown was ${s}s, expected about 20s`);
});

test("timeout while waiting for the first stream event also counts", async () => {
  // headers arrive, but no event ever follows
  const stall = (init) => new Promise((resolve) => {
    const body = new ReadableStream({
      start(ctl) { init.signal.addEventListener("abort", () => ctl.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); },
    });
    resolve(new Response(body, { status: 200 }));
  });
  install({ "model-a": () => stall, "model-b": ok("from b") });
  script["model-a"] = (init) => stall(init);
  const r = await run();
  assert.equal(r.model, "model-b");
  assert.equal(count("model-a"), 1);
});

// --- invalid key -----------------------------------------------------------
for (const [label, status, message] of [
  ["400 API key not valid", 400, `API key not valid. Please pass a valid API key. (key=${FAKE_KEY})`],
  ["401 unauthorized", 401, "Request had invalid authentication credentials."],
  ["403 permission denied", 403, `Your API key was reported as leaked: ${FAKE_KEY}`],
]) {
  test(`invalid key (${label}): clear server-setup error, no other model tried, no cooldown, no secret leaked`, async () => {
    const extra = status === 400 ? { details: [{ reason: "API_KEY_INVALID" }] } : {};
    install({ "model-a": httpError(status, message, { extra }), "model-b": ok("must not run") });
    const r = await run();
    assert.ok(r.error, "should be an error");
    assert.equal(r.error.status, 503);
    assert.match(r.error.message, /GEMINI_API_KEY/);
    assert.ok(!r.error.message.includes(FAKE_KEY), "key must not appear in the client message");
    assert.ok(!/not valid|leaked/i.test(r.error.message), "upstream wording must not be echoed");
    assert.equal(calls.length, 1, "switching models cannot fix a bad key");
    assert.equal(W.memCooldowns.size, 0, "a bad key must not rest healthy models");
    assert.ok(!logs.join("\n").includes(FAKE_KEY), "key must not appear in logs");
  });
}

test("a normal 400 (bad request) is returned as is and does not fall through to other models", async () => {
  install({ "model-a": httpError(400, "Invalid JSON payload received."), "model-b": ok("must not run") });
  const r = await run();
  assert.equal(r.error.status, 400);
  assert.equal(calls.length, 1);
  assert.equal(W.memCooldowns.size, 0);
});

// --- retired model ---------------------------------------------------------
test("404 retired model: next model immediately, long rest", async () => {
  install({ "model-a": httpError(404, "models/model-a is not found"), "model-b": ok("from b") });
  const r = await run();
  assert.equal(r.model, "model-b");
  assert.equal(count("model-a"), 1);
  const s = cooldownSeconds("model-a");
  assert.ok(s >= 595 && s <= 601, `cooldown was ${s}s`);
});

// --- everything fails ------------------------------------------------------
test("all models fail: one clear busy error, every model named, no secrets in the message or logs", async () => {
  install({
    "model-a": httpError(503, `overloaded (https://x.test/v1?key=${FAKE_KEY})`),
    "model-b": httpError(429, "quota"),
    "model-c": httpError(503, `still overloaded, header x-goog-api-key: ${FAKE_KEY}`),
  });
  const r = await run();
  assert.ok(r.error);
  assert.equal(r.error.status, 503);
  for (const m of chain) assert.match(r.error.message, new RegExp(m));
  assert.ok(!r.error.message.includes(FAKE_KEY));
  assert.ok(!logs.join("\n").includes(FAKE_KEY));
  assert.ok(r.error.retryAfter);
});

test("when every model is resting, they are all still tried (soonest to wake first) with one attempt each", async () => {
  const now = Date.now();
  W.memCooldowns.set("model-a", now + 50_000);
  W.memCooldowns.set("model-b", now + 10_000);
  W.memCooldowns.set("model-c", now + 30_000);
  install({ "model-a": httpError(503, "busy"), "model-b": httpError(503, "busy"), "model-c": ok("from c") });
  const r = await run();
  assert.deepEqual(calls, ["model-b", "model-c"].slice(0, calls.length));
  assert.equal(r.model, "model-c");
  assert.equal(count("model-b"), 1, "resting models get a single attempt");
});

test("a rested model that answers again is released from cooldown", async () => {
  W.memCooldowns.set("model-a", Date.now() + 20_000);
  install({ "model-a": ok("back"), "model-b": ok("b") });
  const r = await run(["model-a"]);
  assert.equal(r.model, "model-a");
  assert.ok(!W.memCooldowns.has("model-a"));
});

// --- persistent cooldown ---------------------------------------------------
function fakeKV() {
  const store = new Map();
  return {
    store, puts: 0,
    async get(key, type) { const v = store.get(key); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { this.puts++; store.set(key, value); },
  };
}

test("persistent cooldown: a new isolate learns about a resting model from KV", async () => {
  const kv = fakeKV();
  const env = { ULTRON_STATE: kv };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  await W.makeHealth(env, ctx).mark("model-a", 45_000, "rate-limited");
  await Promise.all(waits);
  assert.equal(kv.puts, 1);

  W.__reset(); // simulates a fresh Worker isolate: memory is empty
  assert.equal(W.memCooldowns.size, 0);
  const health = W.makeHealth(env, ctx);
  await health.load();
  assert.deepEqual(health.order(chain), ["model-b", "model-c", "model-a"]);
});

test("persistent cooldown: KV failures never break chat", async () => {
  const broken = { async get() { throw new Error("kv down"); }, async put() { throw new Error("kv down"); } };
  install({ "model-a": httpError(503, "busy"), "model-b": ok("still works") });
  const r = await W.callGemini(chain, "{}", FAKE_KEY, W.makeHealth({ ULTRON_STATE: broken }, undefined));
  assert.equal(r.model, "model-b");
  assert.equal(await drain(r), "still works");
});

test("without KV the Worker uses memory and says so", () => {
  assert.equal(W.makeHealth({}, undefined).persistent, false);
  assert.equal(W.makeHealth({ ULTRON_STATE: fakeKV() }, undefined).persistent, true);
});

// --- redaction -------------------------------------------------------------
test("redact removes API keys, key= params, goog headers, bearer tokens and ck_ keys", () => {
  const dirty = `a ${FAKE_KEY} b https://h/x?key=${FAKE_KEY}&z=1 x-goog-api-key: ${FAKE_KEY} Authorization: Bearer abcdefghijklmnop1234 ck_abcdefghij12345`;
  const clean = W.redact(dirty);
  assert.ok(!clean.includes(FAKE_KEY));
  assert.ok(!clean.includes("abcdefghijklmnop1234"));
  assert.ok(!clean.includes("ck_abcdefghij12345"));
  assert.match(clean, /z=1/);
});

test("every error body is redacted", () => {
  const body = W.errorBody(502, `boom ${FAKE_KEY}`);
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
  assert.equal(body.error.code, 502);
});

// --- tool-agent path (JSON calls) -----------------------------------------
const jsonOk = (text) => () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
const jsonUrlModel = (url) => /models\/([^:]+):/.exec(String(url))[1];

test("agent path: 429 falls to the next model, rests it, and invalid key is handled the same way", async () => {
  globalThis.fetch = async (url) => {
    const m = jsonUrlModel(url);
    return m === "model-a" ? httpError(429, "quota")() : jsonOk("hi")();
  };
  const health = W.makeHealth({}, undefined);
  const r = await W.callGeminiJson(chain, {}, FAKE_KEY, health);
  assert.equal(r.model, "model-b");
  assert.ok(W.memCooldowns.has("model-a"));

  W.__reset();
  globalThis.fetch = async () => httpError(403, `leaked ${FAKE_KEY}`)();
  const bad = await W.callGeminiJson(chain, {}, FAKE_KEY, W.makeHealth({}, undefined));
  assert.equal(bad.error.status, 503);
  assert.ok(!bad.error.message.includes(FAKE_KEY));
  assert.match(bad.error.message, /GEMINI_API_KEY/);
});

// --- bounded UTF-8 stream reader -------------------------------------------
test("bounded stream reader counts UTF-8 bytes, not JavaScript characters", async () => {
  const emoji = enc.encode("🙂");
  const split = new ReadableStream({ start(controller) { controller.enqueue(emoji.slice(0, 2)); controller.enqueue(emoji.slice(2)); controller.close(); } });
  assert.equal(await W.readStreamTextLimited(split, 4), "🙂");
  await assert.rejects(W.readStreamTextLimited(new Response("🙂").body, 3), { code: "PAYLOAD_TOO_LARGE" });
});

test("bounded stream reader cancels an oversized upstream response", async () => {
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(enc.encode("123456")); },
    cancel() { canceled = true; },
  });
  await assert.rejects(W.readStreamTextLimited(stream, 5), { code: "PAYLOAD_TOO_LARGE" });
  assert.equal(canceled, true);
});

test("Groq provider fallback sends compatible text chat and returns its stream", async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    captured = { headers: init.headers, body: JSON.parse(init.body) };
    return new Response("data: [DONE]\\n\\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const result = await W.callGroqFallback({
    messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Hello" }],
    temperature: 0.4, max_tokens: 120,
  }, { GROQ_API_KEY: "gsk-test", GROQ_MODEL: "llama-3.3-70b-versatile" });
  assert.equal(result.model, "openai/gpt-oss-120b");
  assert.ok(result.res && result.res.body);
  assert.equal(captured.headers.Authorization, "Bearer gsk-test");
  assert.deepEqual(captured.body.messages, [
    { role: "system", content: "Be concise" }, { role: "user", content: "Hello" },
  ]);
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.temperature, 0.4);
  assert.equal(captured.body.max_tokens, 120);
});

test("Groq provider fallback skips image requests instead of dropping attachments", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not call"); };
  const result = await W.callGroqFallback({
    messages: [{ role: "user", content: [{ type: "text", text: "Describe this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }],
  }, { GROQ_API_KEY: "gsk-test" });
  assert.match(result.message, /image or document attachment/);
  assert.equal(called, false);
});

test("Groq provider fallback reports upstream errors without leaking credentials", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "invalid request" } }), { status: 400 });
  const result = await W.callGroqFallback({ messages: [{ role: "user", content: "Hi" }] }, { GROQ_API_KEY: "gsk-test" });
  assert.equal(result.status, 400);
  assert.match(result.message, /invalid request/);
});

test("Groq provider fallback gives up at the timeout it is handed", async () => {
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  // AbortSignal.timeout timers are unref'd, so hold the event loop open until the abort fires.
  const keepAlive = setTimeout(() => {}, 5000);
  const started = Date.now();
  try {
    const result = await W.callGroqFallback({ messages: [{ role: "user", content: "Hi" }] }, { GROQ_API_KEY: "gsk-test" }, 40);
    assert.match(result.message, /timed out/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    clearTimeout(keepAlive);
  }
});

function mockGoogleKeys(counter) {
  globalThis.fetch = async (url) => {
    counter.calls++;
    if (String(url).includes("openid-configuration")) {
      return new Response(JSON.stringify({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" }), { status: 200 });
    }
    return new Response(JSON.stringify({ keys: [{ kid: "real", alg: "RS256", use: "sig", kty: "RSA", n: "AQAB", e: "AQAB" }] }),
      { status: 200, headers: { "Cache-Control": "public, max-age=3600" } });
  };
}
const fakeToken = (kid) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid })}.${b64({ sub: "1" })}.AAAA`;
};

test("made-up key ids cannot force a Google key refresh on every request", async () => {
  W.__resetJwks();
  const counter = { calls: 0 };
  mockGoogleKeys(counter);
  for (let i = 0; i < 25; i++) assert.equal(await W.verifyGoogleIdToken(fakeToken("bogus-" + i), "client-id"), null);
  assert.equal(counter.calls, 2, "one discovery fetch and one key fetch, however many bad tokens arrive");
});

test("requests that arrive together share one Google key fetch", async () => {
  W.__resetJwks();
  const counter = { calls: 0 };
  mockGoogleKeys(counter);
  const results = await Promise.all(Array.from({ length: 10 }, () => W.verifyGoogleIdToken(fakeToken("bogus"), "client-id")));
  assert.deepEqual(results, Array(10).fill(null));
  assert.equal(counter.calls, 2);
});


// --- end-to-end: the real fetch handler, Gemini down, Groq backup ------------
const CLIENT_ID = "test-client-id";
async function e2eSetup({ gemini, groq }) {
  W.__resetJwks();
  W.__reset();
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
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
    if (u.includes("generativelanguage.googleapis.com")) { seen.gemini++; return gemini(init); }
    if (u.includes("api.groq.com")) { seen.groq++; seen.groqAuth = init.headers && init.headers.Authorization; return groq(init); }
    throw new Error("unexpected fetch: " + u);
  };
  const limiter = { limit: async () => ({ success: true }) };
  const env = (extra = {}) => ({ GOOGLE_CLIENT_ID: CLIENT_ID, GEMINI_API_KEY: FAKE_KEY, ULTRON_USER_LIMITER: limiter, ULTRON_IP_LIMITER: limiter, ...extra });
  const post = (envVars, messages = [{ role: "user", content: "Hi" }]) => W.default.fetch(
    new Request("https://worker.test/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + head + "." + body + "." + sig },
      body: JSON.stringify({ model: "model-a", messages }),
    }), envVars, { waitUntil() {} });
  return { env, post, seen };
}
const groqOk = () => new Response('data: {"choices":[{"delta":{"content":"from groq"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
const allBusy = () => httpError(503, "The model is overloaded")();

test("e2e: Gemini 503 everywhere -> handler streams the Groq backup, not Gemini's error", async () => {
  const t = await e2eSetup({ gemini: allBusy, groq: groqOk });
  const res = await t.post(t.env({ GROQ_API_KEY: "gsk-test", DEFAULT_MODEL: "model-a", FALLBACK_MODELS: "model-b" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-ULTRON-Fallback"), "provider");
  assert.match(res.headers.get("X-ULTRON-Model"), /^groq\//);
  assert.match(await res.text(), /from groq/);
  assert.ok(t.seen.gemini > 0, "Gemini was tried first");
  assert.equal(t.seen.groq, 1);
  assert.equal(t.seen.groqAuth, "Bearer gsk-test");
});

test("e2e: Gemini 503 and no GROQ_API_KEY -> clear 'backup not configured' message", async () => {
  const t = await e2eSetup({ gemini: allBusy, groq: () => { throw new Error("must not call"); } });
  const res = await t.post(t.env({ DEFAULT_MODEL: "model-a", FALLBACK_MODELS: "model-b" }));
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Groq backup is not configured/);
  assert.equal(t.seen.groq, 0);
});

test("e2e: Gemini 503 and Groq 401 -> 502 naming the Groq failure, key not leaked", async () => {
  const t = await e2eSetup({ gemini: allBusy, groq: () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }) });
  const res = await t.post(t.env({ GROQ_API_KEY: "gsk-secret-123", DEFAULT_MODEL: "model-a", FALLBACK_MODELS: "model-b" }));
  const text = await res.text();
  assert.equal(res.status, 502);
  assert.match(text, /Groq backup failed/);
  assert.ok(!text.includes("gsk-secret-123"));
});

test("e2e: Gemini 503 and an image attachment -> Groq is skipped, reason reported", async () => {
  const t = await e2eSetup({ gemini: allBusy, groq: () => { throw new Error("must not call"); } });
  const res = await t.post(t.env({ GROQ_API_KEY: "gsk-test", DEFAULT_MODEL: "model-a", FALLBACK_MODELS: "model-b" }),
    [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }]);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /image or document attachment/);
  assert.equal(t.seen.groq, 0);
});


// --- FLUX image generation --------------------------------------------------
test("image edit intent: attached images plus edit instructions route to Klein", () => {
  const image = { type: "image_url", image_url: { url: "data:image/jpeg;base64,AQID" } };
  assert.equal(W.detectImageEditRequest([{ role: "user", content: [{ type: "text", text: "Make this photo cinematic" }, image] }]).images.length, 1);
  assert.equal(W.detectImageEditRequest([{ role: "user", content: [{ type: "text", text: "What is in this picture?" }, image] }]), null);
  assert.equal(W.detectImageEditRequest([{ role: "user", content: "Make this photo cinematic" }]), null);
});

test("e2e: image edit uses FLUX.2 Klein multipart and returns an edited image", async () => {
  const t = await e2eSetup({ gemini: () => { throw new Error("Gemini must not run for image editing"); }, groq: () => { throw new Error("Groq must not run for image editing"); } });
  let called = null;
  const ai = { run: async (model, options) => { called = { model, options }; return { image: "AQIDBA==" }; } };
  const messages = [{ role: "user", content: [{ type: "text", text: "Make this photo cinematic" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AQID" } }] }];
  const res = await t.post(t.env({ AI: ai }), messages);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-ULTRON-Image-Model"), "flux-2-klein-4b");
  assert.equal(res.headers.get("X-ULTRON-Image-Action"), "edit");
  assert.equal(called.model, "@cf/black-forest-labs/flux-2-klein-4b");
  assert.ok(called.options.multipart.body);
  assert.match(called.options.multipart.contentType, /multipart\/form-data; boundary=/);
  assert.equal(t.seen.gemini, 0);
  assert.equal(t.seen.groq, 0);
});

test("image intent: explicit create/draw requests are detected, explanations and code are not", () => {
  assert.deepEqual(W.detectImageGenerationRequest([{ role: "user", content: "Create an image of a horse in a misty forest" }]), { prompt: "Create an image of a horse in a misty forest" });
  assert.deepEqual(W.detectImageGenerationRequest([{ role: "user", content: "Draw a cinematic Kerala monsoon wallpaper" }]), { prompt: "Draw a cinematic Kerala monsoon wallpaper" });
  assert.deepEqual(W.detectImageGenerationRequest([{ role: "user", content: "Generate a logo for my video editing brand" }]), { prompt: "Generate a logo for my video editing brand" });
  const detailed = "Create an ultra-realistic cinematic image of a Kerala monsoon forest. " + "Detailed lighting, composition, atmosphere and realistic textures. ".repeat(45);
  const longResult = W.detectImageGenerationRequest([{ role: "user", content: detailed }]);
  assert.ok(longResult, "long image prompts must still route to FLUX");
  assert.equal(longResult.prompt.length, 2048, "only the prompt sent to FLUX is capped at 2048 characters");
  assert.ok(longResult.prompt.startsWith("Create an ultra-realistic cinematic image"));
  assert.equal(W.detectImageGenerationRequest([{ role: "user", content: "What is image generation and how does FLUX work?" }]), null);
  assert.equal(W.detectImageGenerationRequest([{ role: "user", content: "Create a website about horses" }]), null);
  assert.equal(W.detectImageGenerationRequest([{ role: "user", content: "Describe this image" }]), null);
});

test("e2e: explicit image request returns binary JPEG from the Workers AI binding", async () => {
  const t = await e2eSetup({ gemini: () => { throw new Error("Gemini must not be called for image generation"); }, groq: () => { throw new Error("Groq must not be called for image generation"); } });
  let called = null;
  const ai = { run: async (model, options) => { called = { model, options }; return { image: "AQIDBA==" }; } };
  const res = await t.post(t.env({ AI: ai }), [{ role: "user", content: "Create an image of a horse in a misty forest" }]);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal(res.headers.get("X-ULTRON-Image-Model"), "flux-1-schnell");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3, 4]);
  assert.equal(called.model, "@cf/black-forest-labs/flux-1-schnell");
  assert.equal(called.options.steps, 4);
  assert.equal(called.options.prompt, "Create an image of a horse in a misty forest");
  assert.equal(t.seen.gemini, 0);
  assert.equal(t.seen.groq, 0);
});


test("e2e: ordinary text chat stays on Gemini even when Workers AI is available", async () => {
  const t = await e2eSetup({ gemini: () => okStream([sse("normal chat response", { finishReason: "STOP" })]), groq: () => { throw new Error("Groq must not be called"); } });
  let aiCalls = 0;
  const res = await t.post(t.env({ AI: { run: async () => { aiCalls++; return { image: "AQID" }; } }, DEFAULT_MODEL: "model-a" }), [{ role: "user", content: "Explain what a diffusion model is" }]);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /text\/event-stream/);
  assert.match(await res.text(), /normal chat response/);
  assert.equal(aiCalls, 0);
  assert.equal(t.seen.gemini, 1);
});
