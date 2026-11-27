// ULTRON task events: construction, Server-Sent Events framing, and payload caps.
// The browser reconnects with Last-Event-ID; the runtime replays everything after it.

import { EVENT_TYPES, isPlainObject, validateEvent } from "./schemas.js";

export const EVENT_LIMITS = Object.freeze({
  maxPayloadChars: 24000,
  maxFieldChars: 8000,
  sseRetryMs: 3000,
});

const DROP_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function capValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, EVENT_LIMITS.maxFieldChars);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= 4) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => capValue(item, depth + 1));
  if (isPlainObject(value)) {
    const clean = {};
    for (const key of Object.keys(value)) {
      if (DROP_KEYS.has(key)) continue;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
      clean[key] = capValue(value[key], depth + 1);
    }
    return clean;
  }
  return null;
}

// Builds one event. The caller supplies the sequence, so ordering is decided by the log.
export function createEvent({ taskId, sequence, type, timestamp, ...rest }) {
  const base = {
    protocol: 1,
    taskId,
    sequence,
    type,
    timestamp: timestamp || new Date().toISOString(),
  };
  const payload = capValue(rest);
  const event = payload && Object.keys(payload).length ? { ...base, ...payload } : base;
  const checked = validateEvent(event);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (JSON.stringify(event).length > EVENT_LIMITS.maxPayloadChars) {
    return { ok: false, error: "Event payload too large." };
  }
  return { ok: true, event };
}

export function isEventType(type) {
  return typeof type === "string" && EVENT_TYPES.includes(type);
}

// SSE frame. "id" is the sequence so Last-Event-ID replay works without extra fields.
export function formatSse(event) {
  const checked = validateEvent(event);
  if (!checked.ok) return "";
  return "id: " + event.sequence + "\nevent: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n";
}

export function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
}

export function sseHello() {
  return "retry: " + EVENT_LIMITS.sseRetryMs + "\n\n";
}

// Parses a Last-Event-ID or ?after= value into a non-negative integer.
export function parseAfter(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}
