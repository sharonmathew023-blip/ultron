// Offline, scaled before/after replay. Usage: node tests/latency-benchmark.mjs <baseline-worktree>
// All provider calls, identity keys and rate limiters are local fixtures; no API traffic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const self = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(self));
if (process.argv[2] !== "--child") {
  const baseline = process.argv[2];
  if (!baseline || !fs.existsSync(path.join(baseline, "worker.js")))
    throw new Error(
      "Provide a baseline worktree containing worker.js; this benchmark never fetches or deploys code.",
    );
  const samples = [];
  for (const scenario of ["healthy-stream", "exhausted-fallback"])
    for (const [version, source] of [
      ["before", baseline],
      ["after", root],
    ]) {
      for (let sample = 0; sample < 3; sample++) {
        const folder = fs.mkdtempSync(
          path.join(os.tmpdir(), "ultron-latency-"),
        );
        for (const name of [
          "worker.js",
          "worker-runtime.js",
          "skill-rules.js",
          "modes.js",
          "identity.js",
        ]) {
          const file = path.join(source, name);
          if (fs.existsSync(file))
            fs.copyFileSync(file, path.join(folder, name));
        }
        let text = fs.readFileSync(path.join(folder, "worker.js"), "utf8");
        for (const [name, value] of Object.entries({
          CLIENT_DEADLINE_MS: 550,
          HEADERS_TIMEOUT_MS: 200,
          TOTAL_BUDGET_MS: 450,
          MIN_ATTEMPT_MS: 20,
          BACKOFF_BASE_MS: 4,
          BACKOFF_MAX_MS: 30,
        })) {
          const pattern = new RegExp(`const ${name} = [0-9_]+;`);
          if (!pattern.test(text))
            throw new Error(`Missing benchmark timing constant ${name}`);
          text = text.replace(pattern, `const ${name} = ${value};`);
        }
        text = text.replace(/\b22_000\b/g, "220").replace(/\b4_000\b/g, "40");
        fs.writeFileSync(path.join(folder, "worker.js"), text);
        fs.writeFileSync(
          path.join(folder, "package.json"),
          '{"type":"module"}',
        );
        const child = spawnSync(
          process.execPath,
          [self, "--child", folder, scenario],
          { encoding: "utf8", timeout: 5000 },
        );
        if (child.status !== 0)
          throw new Error(
            child.stderr || child.stdout || "Benchmark child failed",
          );
        samples.push({
          version,
          scenario,
          sample: sample + 1,
          ...JSON.parse(child.stdout),
        });
      }
    }
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = ["healthy-stream", "exhausted-fallback"].flatMap((scenario) =>
    ["before", "after"].map((version) => {
      const group = samples.filter(
        (x) => x.scenario === scenario && x.version === version,
      );
      return {
        scenario,
        version,
        status: group[0].status,
        ttfbMs: median(group.map((x) => x.ttfbMs)),
        totalMs: median(group.map((x) => x.totalMs)),
        streamDurationMs: median(group.map((x) => x.streamDurationMs)),
        cloudflareCalls: group.map((x) => x.calls.cloudflare),
      };
    }),
  );
  process.stdout.write(
    JSON.stringify(
      {
        methodology:
          "Isolated local replay; timing policy scaled 1:100 (55s -> 550ms); three runs per scenario/version; no real providers, deployment, or production latency claim.",
        node: process.version,
        summary,
        samples,
      },
      null,
      2,
    ) + "\n",
  );
} else {
  const folder = process.argv[3],
    scenario = process.argv[4];
  const metrics = [];
  console.log = (value) => {
    try {
      metrics.push(JSON.parse(value));
    } catch {}
  };
  console.warn = () => {};
  console.error = () => {};
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const h = b64({ alg: "RS256", kid: "fixture" });
  const p = b64({
    iss: "https://accounts.google.com",
    aud: "benchmark",
    sub: "fixture",
    email: "fixture@example.test",
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const sig = Buffer.from(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(h + "." + p),
    ),
  ).toString("base64url");
  const calls = { gemini: 0, groq: 0, cloudflare: 0 };
  const json = (value) => new Response(JSON.stringify(value));
  const enc = new TextEncoder();
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    if (address.includes("openid-configuration"))
      return json({ jwks_uri: "https://www.googleapis.com/oauth2/v3/certs" });
    if (address.includes("googleapis.com/oauth2")) return json({ keys: [jwk] });
    if (address.includes("generativelanguage")) {
      calls.gemini++;
      if (scenario === "exhausted-fallback") {
        await delay(145);
        return new Response('{"error":{"message":"fixture unavailable"}}', {
          status: 503,
        });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(
              () =>
                controller.enqueue(
                  enc.encode(
                    'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n',
                  ),
                ),
              15,
            );
            setTimeout(() => {
              controller.enqueue(
                enc.encode(
                  'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}]}\n\n',
                ),
              );
              controller.close();
            }, 55);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (address.includes("api.groq")) {
      calls.groq++;
      return new Promise((resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
      });
    }
    throw new Error("Unexpected network request in benchmark");
  };
  const worker = (await import(pathToFileURL(path.join(folder, "worker.js"))))
    .default;
  const limiter = { limit: async () => ({ success: true }) };
  const env = {
    GOOGLE_CLIENT_ID: "benchmark",
    GEMINI_API_KEY: "fixture-key",
    GROQ_API_KEY: "fixture-key",
    DEFAULT_MODEL: "model-a",
    FALLBACK_MODELS: "model-a",
    ULTRON_USER_LIMITER: limiter,
    ULTRON_IP_LIMITER: limiter,
    AI: {
      run: async () => {
        calls.cloudflare++;
        await delay(80);
        return { response: "fixture answer" };
      },
    },
  };
  const request = new Request("https://worker.test/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + h + "." + p + "." + sig,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const started = performance.now();
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const headers = performance.now();
    const reader = response.body.getReader();
    let firstByte;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (firstByte === undefined && item.value.byteLength)
        firstByte = performance.now();
    }
    const ended = performance.now();
    const round = (value) => Math.round(value * 1000) / 1000;
    process.stdout.write(
      JSON.stringify({
        status: response.status,
        ttfbMs: round(firstByte - started),
        totalMs: round(ended - started),
        streamDurationMs: round(ended - headers),
        calls,
        observedAttemptRecords: metrics.filter(
          (x) =>
            x.event === "provider.attempt_completed" ||
            x.event === "provider.attempt_failed",
        ).length,
      }),
    );
  } finally {
    clearInterval(keepAlive);
  }
}
