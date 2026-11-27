// ULTRON event log.
// Append-only, sequenced per task, replayable from Last-Event-ID. Subscribers are notified
// synchronously so the SSE relay can flush in order.

import { createEvent } from "../protocol/task-events.js";

export const EVENT_LOG_LIMIT = 500;

export function createEventLog({ taskId, limit = EVENT_LOG_LIMIT, now = () => new Date().toISOString() } = {}) {
  if (typeof taskId !== "string" || !taskId) throw new Error("Event log needs a task id.");
  const events = [];
  const subscribers = new Set();
  let sequence = 0;
  let dropped = 0;

  function notify(event) {
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {
        // A broken listener must never break the task.
      }
    }
  }

  function append(type, payload = {}) {
    sequence += 1;
    const built = createEvent({ taskId, sequence, type, timestamp: now(), ...payload });
    if (!built.ok) {
      sequence -= 1;
      return { ok: false, error: built.error };
    }
    events.push(built.event);
    while (events.length > limit) {
      events.shift();
      dropped += 1;
    }
    notify(built.event);
    return { ok: true, event: built.event };
  }

  function since(after) {
    const from = Number.isFinite(Number(after)) ? Math.max(0, Math.floor(Number(after))) : 0;
    return events.filter((event) => event.sequence > from);
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  return Object.freeze({
    taskId,
    append,
    since,
    subscribe,
    all: () => events.slice(),
    lastSequence: () => sequence,
    dropped: () => dropped,
  });
}
