// ULTRON modes. Server-side prompts for each mode.
// The browser sends { mode: "research" } with a normal /chat/completions request.
// Auth, rate limits, model fallback, streaming and Sources all stay in worker.js.
// "chat" is the default and adds nothing.

// Told to backup models that cannot search, so they never invent sources.
const NO_SEARCH_NOTE =
  "Web search is not available for this answer. Answer from what you already know, " +
  "say once that you could not check live sources, and never invent sources, links or quotes.";

export const MODES = {
  research: {
    webSearch: true,
    system:
      "You are ULTRON in Research mode. Use Google Search, compare sources, and answer with facts. " +
      "Lead with the answer, then give key points as short bullets. Say so when sources disagree.",
    fallbackSystem:
      "You are ULTRON in Research mode, but web search is down right now. " + NO_SEARCH_NOTE + " " +
      "Lead with the answer, then give key points as short bullets.",
  },
};

// Mutates the request: adds the mode prompt first, turns on Google Search when the mode wants it.
// Returns the mode name, or null for chat and for anything unknown.
export function applyMode(input) {
  const key = input && typeof input.mode === "string" ? input.mode : "";
  if (!Object.prototype.hasOwnProperty.call(MODES, key)) return null;
  const cfg = MODES[key];
  input.messages = [{ role: "system", content: cfg.system }, ...input.messages];
  if (cfg.webSearch) input.web_search = true;
  return key;
}

// Backup providers (Groq) cannot use Google Search. When the request asked for search,
// swap the Research prompt for a no-search one, or add the note for the plain search toggle.
// Returns a copy and never changes the original request.
export function forBackupProvider(input, mode) {
  if (!input || input.web_search !== true) return input;
  const messages = Array.isArray(input.messages) ? input.messages.slice() : [];
  const cfg = typeof mode === "string" && Object.prototype.hasOwnProperty.call(MODES, mode) ? MODES[mode] : null;
  if (cfg && cfg.webSearch && cfg.fallbackSystem && messages[0] && messages[0].content === cfg.system) {
    messages[0] = { ...messages[0], content: cfg.fallbackSystem };
  } else {
    messages.unshift({ role: "system", content: NO_SEARCH_NOTE });
  }
  return { ...input, messages };
}
