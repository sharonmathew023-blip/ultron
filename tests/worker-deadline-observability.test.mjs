import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import {
  createRequestRuntime,
  createAttempt,
  diagnosticRecord,
  routeCategory,
  wrapResponseStream,
  isRequestDeadlineError,
} from "../worker-runtime.js";

globalThis.crypto ??= webcrypto;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = path.join(root, ".worker.deadline-under-test.mjs");
let source = fs.readFileSync(path.join(root, "worker.js"), "utf8");
for (const [name, value] of Object.entries({
  CLIENT_DEADLINE_MS: 180,
  HEADERS_TIMEOUT_MS: 1000,
  TOTAL_BUDGET_MS: 1000,
  MIN_ATTEMPT_MS: 1,
  BACKOFF_BASE_MS: 1,
  BACKOFF_MAX_MS: 2,
})) {
  const pattern = new RegExp(`const ${name} = [0-9_]+;`);
  assert.match(source, pattern);
  source = source.replace(pattern, `const ${name} = ${value};`);
}
source +=
  "\nexport { callGemini, callGeminiJson, callGroqFallback, callCloudflareFallback, runComposioToolAgent, createComposioMcpClient };\nexport function resetTestState(){ memCooldowns.clear(); kvCooldownCache={at:0,map:{}}; googleJwksCache=null; googleJwksExpiresAt=0; googleJwksFetchedAt=0; googleJwksInflight=null; }\n";
fs.writeFileSync(temporary, source);
const W = await import(pathToFileURL(temporary).href);
process.on("exit", () => {
  try {
    fs.unlinkSync(temporary);
  } catch {}
});
const enc = new TextEncoder();
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const token = (text) => event({ choices: [{ delta: { content: text } }] });
const done = "data: [DONE]\n\n";
const gemini = (text) =>
  event({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
  });
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const sse = (text) =>
  new Response(text, { headers: { "Content-Type": "text/event-stream" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const original = {
  fetch: globalThis.fetch,
  log: console.log,
  warn: console.warn,
  error: console.error,
};
let logs, keepAlive;
test.beforeEach(() => {
  W.resetTestState();
  logs = [];
  console.log = (value) => logs.push(value);
  console.warn = (value) => logs.push(value);
  console.error = (value) => logs.push(value);
  globalThis.fetch = async () => {
    throw new Error("Unexpected network access in isolated test");
  };
  keepAlive = setInterval(() => {}, 1000);
});
test.afterEach(() => {
  clearInterval(keepAlive);
  globalThis.fetch = original.fetch;
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
});
const records = () =>
  logs.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
function context(timeoutMs = 55_000) {
  let clock = 0;
  const events = [];
  const runtime = createRequestRuntime(
    new Request("https://worker.test/chat/completions", { method: "POST" }),
    { timeoutMs, now: () => clock, write: (record) => events.push(record) },
  );
  return {
    runtime,
    events,
    advance(ms) {
      clock += ms;
    },
    expire() {
      clock = timeoutMs;
      assert.throws(() => runtime.check(), isRequestDeadlineError);
    },
  };
}
const health = () => ({
  load: async () => {},
  order: (models) => models,
  isResting: () => false,
  mark: async () => {},
  clear: async () => {},
});
const textInput = { messages: [{ role: "user", content: "Hello" }] };
const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicKey = {
  ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwtHeader = b64({ alg: "RS256", kid: "test-key" });
const jwtPayload = b64({
  iss: "https://accounts.google.com",
  aud: "test-client",
  sub: "test-user",
  email: "owner@example.test",
  email_verified: true,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const signature = Buffer.from(
  await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    enc.encode(`${jwtHeader}.${jwtPayload}`),
  ),
).toString("base64url");
const credential = `${jwtHeader}.${jwtPayload}.${signature}`;
function fixture(handler, extra = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    if (address.includes("openid-configuration"))
      return json({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
    if (address === "https://www.googleapis.com/oauth2/v3/certs")
      return json({ keys: [publicKey] });
    calls.push({ url: address, init });
    return handler(address, init);
  };
  const env = {
    GOOGLE_CLIENT_ID: "test-client",
    GEMINI_API_KEY: "gemini-test-sentinel",
    GROQ_API_KEY: "groq-test-sentinel",
    DEFAULT_MODEL: "model-a",
    FALLBACK_MODELS: "model-b,model-c",
    ULTRON_OWNER_EMAIL: "owner@example.test",
    ALLOWED_ORIGINS: "https://app.example.test",
    ULTRON_USER_LIMITER: { limit: async () => ({ success: true }) },
    ULTRON_IP_LIMITER: { limit: async () => ({ success: true }) },
    ...extra,
  };
  const post = (body = {}, headers = {}) =>
    W.default.fetch(
      new Request("https://worker.test/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + credential,
          "Content-Type": "application/json",
          Origin: "https://app.example.test",
          ...headers,
        },
        body: JSON.stringify({ model: "model-a", ...textInput, ...body }),
      }),
      env,
      { waitUntil() {} },
    );
  return { env, calls, post };
}

test("one absolute 55-second budget is not reset by a new attempt", async () => {
  const c = context();
  try {
    c.advance(45_000);
    assert.equal(c.runtime.remaining(), 10_000);
    const scope = createAttempt(c.runtime, 22_000, "groq");
    const rejected = scope
      .wait(() => new Promise(() => {}))
      .catch((error) => error);
    c.expire();
    assert.ok(isRequestDeadlineError(await rejected));
    assert.equal(scope.signal.aborted, true);
    let started = false;
    assert.throws(
      () =>
        c.runtime.wait(() => {
          started = true;
        }),
      isRequestDeadlineError,
    );
    assert.equal(started, false);
  } finally {
    c.runtime.dispose();
  }
});

test("Gemini retries stop when the shared deadline expires", async () => {
  const c = context();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    c.expire();
    return new Response("unavailable", { status: 503 });
  };
  try {
    await assert.rejects(
      W.callGemini(["model-a", "model-b"], "{}", "test", health(), c.runtime),
      isRequestDeadlineError,
    );
    assert.equal(calls, 1);
  } finally {
    c.runtime.dispose();
  }
});

test("error-body reads remain inside the absolute deadline", async () => {
  const c = context();
  let signal;
  globalThis.fetch = async (url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream({ start() {} }), { status: 503 });
  };
  try {
    const rejected = W.callGemini(
      ["model-a", "model-b"],
      "{}",
      "test",
      health(),
      c.runtime,
    ).catch((error) => error);
    await tick();
    c.expire();
    assert.ok(isRequestDeadlineError(await rejected));
    assert.equal(signal.aborted, true);
  } finally {
    c.runtime.dispose();
  }
});

test("Groq cannot spend the same remaining budget again on Cloudflare AI", async () => {
  const c = context();
  let cfCalls = 0;
  globalThis.fetch = async () => new Promise(() => {});
  const env = {
    GROQ_API_KEY: "test",
    AI: {
      run: async () => {
        cfCalls++;
        return { response: "late" };
      },
    },
  };
  try {
    c.advance(45_000);
    const rejected = W.callGroqFallback(
      textInput,
      env,
      22_000,
      c.runtime,
    ).catch((error) => error);
    await tick();
    c.expire();
    assert.ok(isRequestDeadlineError(await rejected));
    await assert.rejects(
      W.callCloudflareFallback(textInput, env, 22_000, c.runtime),
      isRequestDeadlineError,
    );
    assert.equal(cfCalls, 0);
  } finally {
    c.runtime.dispose();
  }
});

test("uncancellable AI binding settlement is bounded and late rejections are observed", async () => {
  const c = context();
  let settle;
  try {
    const rejected = W.callCloudflareFallback(
      textInput,
      {
        AI: {
          run: () =>
            new Promise((resolve, reject) => {
              settle = reject;
            }),
        },
      },
      22_000,
      c.runtime,
    ).catch((error) => error);
    await tick();
    c.expire();
    assert.ok(isRequestDeadlineError(await rejected));
    settle(new Error("late test rejection"));
    await tick();
  } finally {
    c.runtime.dispose();
  }
});

test("tool rounds and web reads share the original deadline", async () => {
  const c = context();
  let modelCalls = 0,
    webCalls = 0,
    lastSignal;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generativelanguage")) {
      modelCalls++;
      if (modelCalls === 1) {
        c.advance(35_000);
        return json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "OPEN_PUBLIC_WEBPAGE",
                      args: { url: "https://example.com/page" },
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      lastSignal = init.signal;
      return new Promise(() => {});
    }
    webCalls++;
    c.advance(10_000);
    return new Response(
      "<html><title>Example</title><body>public page</body></html>",
      { headers: { "Content-Type": "text/html" } },
    );
  };
  try {
    const rejected = W.runComposioToolAgent(
      textInput,
      "model-a",
      { GEMINI_API_KEY: "test", FALLBACK_MODELS: "model-b" },
      { present: true, tools: ["web.read"] },
      {},
      c.runtime,
    ).catch((error) => error);
    await tick();
    assert.equal(modelCalls, 2);
    assert.equal(webCalls, 1);
    assert.equal(c.runtime.remaining(), 10_000);
    c.expire();
    assert.ok(isRequestDeadlineError(await rejected));
    assert.equal(lastSignal.aborted, true);
    assert.equal(modelCalls, 2);
  } finally {
    c.runtime.dispose();
  }
});

test("tool iteration limit remains five rounds and one final no-tools completion", async () => {
  const c = context();
  let models = 0,
    pages = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("generativelanguage")) {
      models++;
      const input = JSON.parse(init.body);
      return json({
        candidates: [
          {
            content: {
              parts: input.tools
                ? [
                    {
                      functionCall: {
                        name: "OPEN_PUBLIC_WEBPAGE",
                        args: { url: "https://example.com/page" },
                      },
                    },
                  ]
                : [{ text: "finished" }],
            },
          },
        ],
      });
    }
    pages++;
    return new Response("plain public page", {
      headers: { "Content-Type": "text/plain" },
    });
  };
  try {
    const result = await W.runComposioToolAgent(
      textInput,
      "model-a",
      { GEMINI_API_KEY: "test" },
      { present: true, tools: ["web.read"] },
      {},
      c.runtime,
    );
    assert.equal(result.text, "finished");
    assert.equal(pages, 5);
    assert.equal(models, 6);
  } finally {
    c.runtime.dispose();
  }
});

test("MCP initialization cannot refresh the request deadline", async () => {
  const c = context();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Promise(() => {});
  };
  try {
    const rejected = W.createComposioMcpClient(
      "consumer-test-sentinel",
      c.runtime,
    ).catch((error) => error);
    await tick();
    c.expire();
    assert.ok(isRequestDeadlineError(await rejected));
    assert.equal(calls, 1);
  } finally {
    c.runtime.dispose();
  }
});

test("before-stream timeout is HTTP 504 with the existing JSON and CORS contract", async () => {
  let cfCalls = 0;
  const f = fixture(async () => new Promise(() => {}), {
    AI: {
      run: async () => {
        cfCalls++;
        return { response: "late" };
      },
    },
  });
  const response = await f.post();
  assert.equal(response.status, 504);
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://app.example.test",
  );
  const body = await response.json();
  assert.equal(body.error.code, 504);
  assert.equal(body.error.type, "server_error");
  assert.equal(f.calls.length, 1);
  assert.equal(cfCalls, 0);
  assert.equal(f.calls[0].init.signal.aborted, true);
});

test("deadline includes authentication and does not run rate limits or providers afterward", async () => {
  let limits = 0;
  const f = fixture(
    async () => {
      throw new Error("provider must not start");
    },
    {
      ULTRON_USER_LIMITER: {
        limit: async () => {
          limits++;
          return { success: true };
        },
      },
    },
  );
  globalThis.fetch = async () => new Promise(() => {});
  const response = await f.post();
  assert.equal(response.status, 504);
  assert.equal(limits, 0);
  assert.equal(f.calls.length, 0);
});

test("after-header timeout is exactly one controlled SSE 504 and never an early completion", async () => {
  let cancelled = false;
  const f = fixture(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(gemini("visible token")));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /text\/event-stream/);
  assert.equal(records().filter((x) => x.event === "chat.completed").length, 0);
  const text = await response.text();
  assert.match(text, /visible token/);
  assert.equal((text.match(/"code":504/g) || []).length, 1);
  assert.ok(text.endsWith(done));
  assert.equal(
    records().filter((x) => x.event === "stream.first_token").length,
    1,
  );
  assert.equal(records().filter((x) => x.event === "stream.failed").length, 1);
  assert.equal(
    records().filter(
      (x) => x.event === "stream.completed" || x.event === "chat.completed",
    ).length,
    0,
  );
  assert.equal(cancelled, true);
});

test("provider order, fallback headers and Cloudflare AI text contract are preserved", async () => {
  const order = [];
  const f = fixture(
    async (url) => {
      order.push(url.includes("api.groq") ? "groq" : "gemini");
      return new Response(
        JSON.stringify({ error: { message: "test unavailable" } }),
        { status: url.includes("api.groq") ? 503 : 429 },
      );
    },
    {
      AI: {
        run: async () => {
          order.push("cloudflare-ai");
          return { response: "fallback answer" };
        },
      },
    },
  );
  const response = await f.post();
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-ULTRON-Fallback"), "provider");
  assert.match(response.headers.get("X-ULTRON-Model"), /^cloudflare\//);
  assert.deepEqual(order, [
    "gemini",
    "gemini",
    "gemini",
    "groq",
    "cloudflare-ai",
  ]);
  assert.match(body, /fallback answer/);
  assert.ok(body.endsWith(done));
});

test("first token, upstream headers and completion are independent lifecycle events", async () => {
  const c = context();
  let upstream;
  const stream = new ReadableStream({
    start(controller) {
      upstream = controller;
    },
  });
  const scope = createAttempt(c.runtime, 20_000, "gemini");
  c.advance(10);
  scope.headers(new Response(""));
  scope.streaming();
  const response = wrapResponseStream(sse(stream), c.runtime);
  const reader = response.body.getReader();
  try {
    upstream.enqueue(
      enc.encode(event({ choices: [{ delta: { role: "assistant" } }] })),
    );
    await reader.read();
    assert.equal(
      c.events.filter((x) => x.event === "stream.first_token").length,
      0,
    );
    c.advance(10);
    const bytes = enc.encode(token("visible ✓"));
    const split = bytes.indexOf(0xe2) + 1;
    upstream.enqueue(bytes.slice(0, split));
    await reader.read();
    c.advance(10);
    upstream.enqueue(bytes.slice(split));
    await reader.read();
    assert.equal(
      c.events.filter((x) => x.event === "stream.first_token").length,
      1,
    );
    assert.equal(
      c.events.find((x) => x.event === "stream.first_token").elapsedMs,
      30,
    );
    assert.equal(
      c.events.filter((x) => x.event === "chat.completed").length,
      0,
    );
    c.advance(15);
    upstream.enqueue(enc.encode(done));
    await reader.read();
    assert.equal(
      c.events.filter((x) => x.event === "stream.completed").length,
      0,
    );
    upstream.close();
    assert.equal((await reader.read()).done, true);
    assert.equal(
      c.events.filter((x) => x.event === "stream.completed").length,
      1,
    );
    assert.equal(
      c.events.filter((x) => x.event === "chat.completed").length,
      1,
    );
    assert.equal(
      c.events.find((x) => x.event === "provider.headers_received").elapsedMs,
      10,
    );
    assert.equal(
      c.events.find((x) => x.event === "stream.completed").elapsedMs,
      45,
    );
    assert.equal(c.runtime.cleanups.size, 0);
  } finally {
    c.runtime.dispose();
  }
});

test("upstream SSE errors do not count as successful completions", async () => {
  const c = context();
  const response = wrapResponseStream(
    sse(
      token("partial") +
        event({ error: { code: 503, message: "test failure" } }) +
        done,
    ),
    c.runtime,
  );
  await response.text();
  assert.equal(c.events.filter((x) => x.event === "stream.failed").length, 1);
  assert.equal(c.events.find((x) => x.event === "stream.failed").status, 503);
  assert.equal(
    c.events.filter(
      (x) => x.event === "stream.completed" || x.event === "chat.completed",
    ).length,
    0,
  );
});

test("EOF without the completion marker is a controlled stream failure", async () => {
  const c = context();
  const text = await wrapResponseStream(
    sse(token("partial")),
    c.runtime,
  ).text();
  assert.match(text, /"code":502/);
  assert.ok(text.endsWith(done));
  assert.equal(c.events.filter((x) => x.event === "stream.failed").length, 1);
  assert.equal(c.events.filter((x) => x.event === "chat.completed").length, 0);
});

test("client cancellation stops upstream work and records one failure", async () => {
  const c = context();
  let cancelled = false;
  const response = wrapResponseStream(
    sse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(token("partial")));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
    c.runtime,
  );
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await tick();
  assert.equal(cancelled, true);
  assert.equal(c.runtime.signal.aborted, true);
  assert.equal(c.events.filter((x) => x.event === "stream.failed").length, 1);
  assert.equal(
    c.events.filter((x) => x.event === "stream.failed")[0].reason,
    "client_cancelled",
  );
  assert.equal(c.events.filter((x) => x.event === "chat.completed").length, 0);
});

test("unknown route diagnostics contain method and category, not request data", async () => {
  const request = new Request(
    "https://worker.test/alice@example.test/private?key=QUERY-SECRET",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer AUTH-SECRET",
        Cookie: "PRIVATE-COOKIE",
        "CF-Connecting-IP": "192.0.2.123",
      },
      body: "PRIVATE-PROMPT",
    },
  );
  const response = await W.default.fetch(request, {}, {});
  assert.equal(response.status, 404);
  const record = records().find((x) => x.event === "route.unknown");
  assert.deepEqual(Object.keys(record).sort(), [
    "at",
    "event",
    "method",
    "routeCategory",
    "service",
  ]);
  assert.equal(record.method, "POST");
  assert.equal(record.routeCategory, "unknown");
  const serialized = JSON.stringify(records());
  for (const secret of [
    "alice",
    "QUERY-SECRET",
    "AUTH-SECRET",
    "PRIVATE-COOKIE",
    "PRIVATE-PROMPT",
    "192.0.2.123",
  ])
    assert.equal(serialized.includes(secret), false);
});

test("diagnostic allowlists reject arbitrary strings, model names, error text and custom methods", () => {
  const secret = "PERSONAL-SECRET";
  const route = diagnosticRecord("route.unknown", {
    method: secret,
    routeCategory: secret,
    url: secret,
    body: secret,
    provider: secret,
  });
  assert.equal(route.method, "OTHER");
  assert.equal(route.routeCategory, "unknown");
  const record = diagnosticRecord("provider.headers_received", {
    provider: secret,
    model: secret,
    error: secret,
    status: 200,
    durationMs: 5,
    request: { body: secret },
  });
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(diagnosticRecord(secret, { body: secret }), null);
  assert.equal(
    routeCategory("https://worker.test/composio/alice@example.test?key=secret"),
    "composio_unknown",
  );
});

test("authentication and rate limiting still run before provider work", async () => {
  const f = fixture(async () => {
    throw new Error("provider must not be called");
  });
  let response = await f.post({}, { Authorization: "" });
  assert.equal(response.status, 401);
  assert.equal(f.calls.length, 0);
  f.env.ULTRON_USER_LIMITER = { limit: async () => ({ success: false }) };
  response = await f.post();
  assert.equal(response.status, 429);
  assert.equal(f.calls.length, 0);
});

test("tool-enabled requests retain owner-only authorization", async () => {
  const f = fixture(
    async () => {
      throw new Error("provider must not be called");
    },
    { ULTRON_OWNER_EMAIL: "another-owner@example.test" },
  );
  const response = await f.post({ enableTools: true });
  assert.equal(response.status, 403);
  assert.equal(f.calls.length, 0);
});

test("fractional remaining budgets do not break late web-tool AbortSignals", async () => {
  const c = context();
  let models = 0,
    pages = 0;
  c.advance(54_500.5);
  globalThis.fetch = async (url) => {
    if (String(url).includes("generativelanguage")) {
      models++;
      return json({
        candidates: [
          {
            content: {
              parts:
                models === 1
                  ? [
                      {
                        functionCall: {
                          name: "OPEN_PUBLIC_WEBPAGE",
                          args: { url: "https://example.com/page" },
                        },
                      },
                    ]
                  : [{ text: "finished" }],
            },
          },
        ],
      });
    }
    pages++;
    return new Response("public page", {
      headers: { "Content-Type": "text/plain" },
    });
  };
  try {
    const result = await W.runComposioToolAgent(
      textInput,
      "model-a",
      { GEMINI_API_KEY: "test" },
      { present: true, tools: ["web.read"] },
      {},
      c.runtime,
    );
    assert.equal(result.text, "finished");
    assert.equal(pages, 1);
    assert.equal(models, 2);
  } finally {
    c.runtime.dispose();
  }
});

test("concurrent requests never share deadlines or abort controllers", async () => {
  const first = context(),
    second = context();
  try {
    const a = createAttempt(first.runtime, 20_000, "gemini");
    const b = createAttempt(second.runtime, 20_000, "gemini");
    first.expire();
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false);
    assert.equal(second.runtime.remaining(), 55_000);
    assert.equal(await b.wait(() => Promise.resolve("healthy")), "healthy");
  } finally {
    first.runtime.dispose();
    second.runtime.dispose();
  }
});

test("a consumer closing after DONE is completion, not a cancellation failure", async () => {
  const c = context();
  const response = wrapResponseStream(
    sse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(token("finished") + done));
        },
      }),
    ),
    c.runtime,
  );
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(
    c.events.filter((x) => x.event === "stream.completed").length,
    1,
  );
  assert.equal(c.events.filter((x) => x.event === "chat.completed").length, 1);
  assert.equal(c.events.filter((x) => x.event === "stream.failed").length, 0);
});

test("every provider attempt has its own ID and independent header/total timings", () => {
  const c = context();
  try {
    const a = createAttempt(c.runtime, 20_000, "gemini");
    c.advance(10);
    a.headers(new Response("busy", { status: 503 }));
    c.advance(5);
    a.dispose();
    const b = createAttempt(c.runtime, 20_000, "groq");
    c.advance(2);
    b.headers(new Response("ok"));
    c.advance(3);
    b.dispose();
    const starts = c.events.filter(
      (x) => x.event === "provider.attempt_started",
    );
    assert.deepEqual(
      starts.map((x) => x.attemptId),
      [1, 2],
    );
    assert.equal(
      c.events.find((x) => x.event === "provider.headers_received").durationMs,
      10,
    );
    const failed = c.events.filter(
      (x) => x.event === "provider.attempt_failed",
    );
    assert.equal(failed.length, 1);
    assert.equal(failed[0].durationMs, 15);
    const completed = c.events.find(
      (x) => x.event === "provider.attempt_completed",
    );
    assert.equal(completed.attemptId, 2);
    assert.equal(completed.durationMs, 5);
    assert.ok(completed.requestId);
    assert.equal(completed.requestId, starts[0].requestId);
  } finally {
    c.runtime.dispose();
  }
});

test("first byte is separate from first visible token and total stream duration", async () => {
  const c = context();
  let upstream;
  const response = wrapResponseStream(
    sse(
      new ReadableStream({
        start(ctl) {
          upstream = ctl;
        },
      }),
    ),
    c.runtime,
  );
  const reader = response.body.getReader();
  c.advance(5);
  upstream.enqueue(
    enc.encode(event({ choices: [{ delta: { role: "assistant" } }] })),
  );
  await reader.read();
  c.advance(10);
  upstream.enqueue(enc.encode(token("visible")));
  await reader.read();
  c.advance(20);
  upstream.enqueue(enc.encode(done));
  await reader.read();
  upstream.close();
  await reader.read();
  assert.equal(c.events.find((x) => x.event === "stream.first_byte").ttfbMs, 5);
  assert.equal(
    c.events.find((x) => x.event === "stream.first_token").elapsedMs,
    15,
  );
  assert.equal(
    c.events.find((x) => x.event === "stream.completed").streamDurationMs,
    35,
  );
});

test("provider fallback logs use names and reason categories without upstream error text", async () => {
  const f = fixture(
    async () =>
      new Response(
        JSON.stringify({ error: { message: "PRIVATE-PROMPT-SECRET" } }),
        { status: 429 },
      ),
    { AI: { run: async () => ({ response: "answer" }) } },
  );
  await (await f.post()).text();
  const fallback = records().filter((x) => x.event === "provider.fallback");
  assert.ok(
    fallback.some(
      (x) =>
        x.fromProvider === "gemini" &&
        x.provider === "groq" &&
        x.reason === "rate-limited",
    ),
  );
  assert.ok(
    fallback.some(
      (x) =>
        x.fromProvider === "groq" &&
        x.provider === "cloudflare-ai" &&
        x.reason === "rate-limited",
    ),
  );
  assert.equal(
    JSON.stringify(records()).includes("PRIVATE-PROMPT-SECRET"),
    false,
  );
});
