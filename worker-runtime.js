// Request-scoped deadlines and privacy-safe lifecycle diagnostics. No environment bindings.
export const DEADLINE_MESSAGE = "The request exceeded its processing deadline. Please try again.";
export class RequestDeadlineError extends Error {
  constructor() { super(DEADLINE_MESSAGE); this.name = "RequestDeadlineError"; this.status = 504; }
}
export const isRequestDeadlineError = error => error instanceof RequestDeadlineError || error?.name === "RequestDeadlineError";
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const PROVIDERS = new Set(["gemini", "groq", "cloudflare-ai", "composio", "web"]);
const CATEGORIES = new Set(["health", "models", "chat", "browse", "account_access", "memory", "conversations", "composio_session", "composio_connect", "composio_status", "composio_unknown", "unknown"]);
const EVENTS = new Set(["request.received", "request.timeout", "provider.attempt_started", "provider.attempt_completed", "provider.fallback", "stream.first_byte", "provider.headers_received", "provider.response_received", "provider.attempt_failed", "provider.cooldown", "chat.started", "chat.gemini_failed", "stream.first_token", "stream.completed", "stream.failed", "chat.completed", "route.unknown"]);
const REASONS = new Set(["timeout", "upstream_error", "stream_error", "client_cancelled", "rate-limited", "not-found", "overloaded", "unreachable", "not_configured", "incompatible_input", "empty_response"]);
const NUMBERS = ["elapsedMs", "durationMs", "attempt", "status", "modelCount", "toolRound", "attemptId", "ttfbMs", "streamDurationMs", "totalDurationMs"];
const timeoutError = () => Object.assign(new Error("Provider attempt timed out."), { name: "TimeoutError" });
const unref = timer => timer?.unref?.();

// Categories are a closed vocabulary, never a redacted-but-still-identifying URL.
export function routeCategory(url) {
  let path;
  try { path = new URL(url).pathname.replace(/\/+$/, ""); } catch { return "unknown"; }
  if (path === "" || path === "/health") return "health";
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/models")) return "models";
  if (path === "/browse") return "browse";
  if (path === "/account/access") return "account_access";
  if (path === "/memory" || path === "/conversations") return path.slice(1);
  if (path === "/composio/session") return "composio_session";
  if (path === "/composio/connect") return "composio_connect";
  if (path === "/composio/status") return "composio_status";
  return path.startsWith("/composio/") ? "composio_unknown" : "unknown";
}

// Explicit allowlists also protect against accidentally passing an Error, request or prompt.
export function diagnosticRecord(event, fields = {}) {
  if (!EVENTS.has(event)) return null;
  const record = { service: "ultron", event, at: new Date().toISOString() };
  if (typeof fields.requestId === "string" && /^[0-9a-f-]{36}$/i.test(fields.requestId) && event !== "route.unknown") record.requestId = fields.requestId;
  if (event === "route.unknown" || event === "request.received") {
    record.method = METHODS.has(fields.method) ? fields.method : "OTHER";
    record.routeCategory = CATEGORIES.has(fields.routeCategory) ? fields.routeCategory : "unknown";
    return record;
  }
  if (PROVIDERS.has(fields.provider)) record.provider = fields.provider;
  if (PROVIDERS.has(fields.fromProvider)) record.fromProvider = fields.fromProvider;
  if (REASONS.has(fields.reason)) record.reason = fields.reason;
  for (const key of NUMBERS) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) record[key] = Math.round(value * 1000) / 1000;
  }
  return record;
}

// Register rejection handlers immediately so late, uncancellable binding results cannot
// produce unhandled rejections or start another provider after the caller has timed out.
function waitForSignal(factory, signal, check = () => {}) {
  check();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    let task;
    try { task = factory(); } catch (error) { cleanup(); reject(error); return; }
    Promise.resolve(task).then(value => {
      cleanup();
      try { check(); if (signal.aborted) throw signal.reason; resolve(value); } catch (error) { reject(error); }
    }, error => { cleanup(); reject(signal.aborted ? signal.reason : error); });
  });
}

export function createAttempt(runtime, timeoutMs, provider) {
  runtime?.check();
  const controller = new AbortController();
  const started = runtime ? runtime.now() : performance.now();
  const attemptId = runtime?.nextAttempt();
  let status, failedReason;
  runtime?.event("provider.attempt_started", { provider, attemptId });
  const remaining = runtime ? runtime.remaining() : timeoutMs;
  const limit = Math.min(timeoutMs, remaining);
  const abort = () => controller.abort(runtime.signal.reason);
  runtime?.signal.addEventListener("abort", abort, { once: true });
  // When the absolute deadline is the tighter limit, use its one timer rather
  // than a rounded duplicate that could expire early and trigger a tiny retry.
  let timer = runtime && remaining <= timeoutMs ? null : setTimeout(() => controller.abort(timeoutError()), Math.max(0, limit));
  // Standalone helper callers still need their attempt timer to keep Node alive.
  if (runtime) unref(timer);
  const stopTimer = () => { clearTimeout(timer); timer = null; };
  let released = false;
  const dispose = () => {
    if (released) return;
    released = true;
    if (runtime?.signal.aborted && !controller.signal.aborted) abort();
    stopTimer();
    runtime?.signal.removeEventListener("abort", abort);
    runtime?.cleanups.delete(dispose);
    const streamFailure = runtime?.streamFailure;
    const timedOut = isRequestDeadlineError(controller.signal.reason) || controller.signal.reason?.name === "TimeoutError";
    const reason = timedOut ? "timeout" : failedReason || streamFailure?.reason || (controller.signal.aborted ? "client_cancelled" : status >= 400 ? "upstream_error" : undefined);
    runtime?.event(reason ? "provider.attempt_failed" : "provider.attempt_completed", { provider, attemptId, status: timedOut ? 504 : streamFailure?.status || status, reason, durationMs: runtime.now() - started });
  };
  runtime?.cleanups.add(dispose);
  return {
    signal: controller.signal,
    wait: factory => waitForSignal(factory, controller.signal, () => runtime?.check()),
    headers(response) { status = response.status; runtime?.event("provider.headers_received", { provider, attemptId, durationMs: runtime.now() - started, status }); },
    response() { status = 200; runtime?.event("provider.response_received", { provider, attemptId, durationMs: runtime.now() - started }); },
    fail(code = 502, reason = "upstream_error") { status = code; failedReason = reason; },
    // The first-event/header timer is not a stream-duration metric. The request's
    // absolute deadline remains attached until the returned stream ends or is cancelled.
    streaming() { stopTimer(); if (!runtime) dispose(); },
    dispose,
  };
}

export function createRequestRuntime(request, { timeoutMs = 55_000, now = () => performance.now(), write = record => console.log(JSON.stringify(record)) } = {}) {
  const started = now();
  const requestId = crypto.randomUUID(); // Server-generated, never read from user headers.
  const deadlineAt = started + timeoutMs;
  const controller = new AbortController();
  let timer, disposed = false, provider = null, attempts = 0;
  const cleanups = new Set();
  const event = (name, fields = {}) => {
    const record = diagnosticRecord(name, { provider, elapsedMs: now() - started, ...fields, requestId });
    if (record) { try { write(record); } catch { /* Diagnostics must not break a response. */ } }
  };
  const expire = () => { if (!controller.signal.aborted) controller.abort(new RequestDeadlineError()); };
  const runtime = {
    signal: controller.signal, now, startedAt: started, cleanups, streamFailure: null,
    nextAttempt() { return ++attempts; },
    remaining() { return Math.max(0, deadlineAt - now()); },
    check() { if (now() >= deadlineAt) expire(); if (controller.signal.aborted) throw controller.signal.reason; },
    wait(factory) { return waitForSignal(factory, controller.signal, () => runtime.check()); },
    async sleep(ms) {
      runtime.check();
      let sleeper;
      try { return await runtime.wait(() => new Promise(resolve => { sleeper = setTimeout(resolve, Math.min(ms, runtime.remaining())); })); }
      finally { clearTimeout(sleeper); }
    },
    event,
    setProvider(value) { provider = PROVIDERS.has(value) ? value : null; },
    unknownRoute() { event("route.unknown", { method: request.method, routeCategory: routeCategory(request.url) }); },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      for (const cleanup of [...cleanups]) cleanup();
    },
    cancel() { if (!controller.signal.aborted) controller.abort(Object.assign(new Error("Client cancelled."), { name: "AbortError" })); runtime.dispose(); },
  };
  timer = setTimeout(expire, Math.max(0, timeoutMs));
  unref(timer);
  event("request.received", { method: request.method, routeCategory: routeCategory(request.url) });
  return runtime;
}

const frame = (code, message) => new TextEncoder().encode(`data: ${JSON.stringify({ error: { message, type: "server_error", code } })}\n\ndata: [DONE]\n\n`);

// Observe SSE envelopes, not raw text: role-only, reasoning and empty frames do not
// count as a visible token. Bounded parsing never changes or logs response bytes.
function observeSse(onToken, onError, onDone) {
  const decoder = new TextDecoder();
  let pending = "", oversized = false;
  const limit = 128 * 1024;
  return bytes => {
    pending += decoder.decode(bytes, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const text = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      if (!oversized && text.length <= limit) {
        const data = text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data === "[DONE]") onDone();
        else if (data) {
          try {
            const value = JSON.parse(data);
            if (value.error) { onError(); continue; }
            const content = value.choices?.[0]?.delta?.content ?? value.choices?.[0]?.message?.content ?? value.choices?.[0]?.text;
            if (typeof content === "string" && content.trim()) onToken();
          } catch { /* Non-JSON keepalives are not tokens or failures. */ }
        }
      }
      oversized = false;
    }
    if (pending.length > limit) { pending = pending.slice(-2); oversized = true; }
  };
}

export function wrapResponseStream(response, runtime) {
  runtime.check();
  if (!response.body || !/\btext\/event-stream\b/i.test(response.headers.get("Content-Type") || "")) {
    runtime.dispose();
    return response;
  }
  const reader = response.body.getReader();
  let terminal = false, failed = false, firstToken = false, firstByte = false, sawDone = false, output;
  const streamStarted = runtime.now();
  const streamTiming = () => ({ streamDurationMs: runtime.now() - streamStarted });
  const markFailed = (reason, status) => { if (!failed) { failed = true; runtime.streamFailure = { reason, status }; runtime.event("stream.failed", { reason, status, ...streamTiming() }); } };
  const observe = observeSse(() => {
    if (!firstToken) { firstToken = true; runtime.event("stream.first_token"); }
  }, () => markFailed("upstream_error"), () => { sawDone = true; });
  const cleanup = () => { runtime.signal.removeEventListener("abort", timeout); runtime.dispose(); };
  const fail = (reason, timeoutFailure) => {
    if (terminal) return;
    terminal = true;
    markFailed(reason, timeoutFailure ? 504 : 502);
    if (!firstByte) { firstByte = true; runtime.event("stream.first_byte", { ttfbMs: runtime.now() - runtime.startedAt }); }
    output.enqueue(frame(timeoutFailure ? 504 : 502, timeoutFailure ? DEADLINE_MESSAGE : "The response stream was interrupted. Please try again."));
    output.close();
    Promise.resolve(reader.cancel()).catch(() => {});
    cleanup();
  };
  const timeout = () => fail("timeout", true);
  const body = new ReadableStream({
    start(controller) {
      output = controller;
      runtime.signal.addEventListener("abort", timeout, { once: true });
      if (runtime.signal.aborted) timeout();
    },
    async pull(controller) {
      if (terminal) return;
      try {
        const part = await runtime.wait(() => reader.read());
        if (terminal) return;
        if (part.done) {
          if (!sawDone && !failed) { fail("stream_error", false); return; }
          terminal = true;
          controller.close();
          if (!failed) { runtime.event("stream.completed", streamTiming()); runtime.event("chat.completed", streamTiming()); }
          cleanup();
        } else {
          if (!firstByte && part.value.byteLength) { firstByte = true; runtime.event("stream.first_byte", { ttfbMs: runtime.now() - runtime.startedAt }); }
          observe(part.value); controller.enqueue(part.value);
        }
      } catch (error) { fail(isRequestDeadlineError(error) ? "timeout" : "stream_error", isRequestDeadlineError(error)); }
    },
    cancel(reason) {
      if (terminal) return;
      terminal = true;
      if (sawDone && !failed) { runtime.event("stream.completed", streamTiming()); runtime.event("chat.completed", streamTiming()); }
      else markFailed("client_cancelled");
      runtime.cancel();
      runtime.signal.removeEventListener("abort", timeout);
      Promise.resolve(reader.cancel(reason)).catch(() => {});
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
