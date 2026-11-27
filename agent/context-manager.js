// ULTRON context manager.
// Repositories are bigger than any context window. This keeps a compact tree, retrieves
// relevant files, and turns long command output into a bounded summary with a log reference.

export const CONTEXT_LIMITS = Object.freeze({
  maxTreeEntries: 400,
  maxSnippetChars: 4000,
  maxFilesInContext: 12,
  maxContextChars: 40000,
  maxOutputLines: 200,
});

const NOISE_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "coverage", ".next", ".cache",
  "__pycache__", ".venv", "venv", "vendor",
]);

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "you", "your", "are", "was", "were",
  "have", "has", "had", "how", "what", "when", "where", "why", "can", "could", "would",
  "should", "about", "into", "make", "give", "show", "help", "please", "want", "need",
  "like", "just", "its", "our", "their", "them", "then", "than", "not", "but", "all", "any",
  "also", "use", "using", "does", "did", "will", "now", "file", "files", "code", "fix", "test",
]);

export function isNoisePath(relativePath) {
  return String(relativePath || "").split("/").some((segment) => NOISE_DIRECTORIES.has(segment));
}

export function tokenize(value) {
  return new Set(
    String(value || "").toLowerCase().replace(/[^a-z0-9_.-]+/g, " ").split(/\s+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

// Compact tree: one line per entry, noise directories removed, bounded count.
export function buildTree(paths, { maxEntries = CONTEXT_LIMITS.maxTreeEntries } = {}) {
  const seen = new Set();
  const lines = [];
  for (const entry of Array.isArray(paths) ? paths : []) {
    const clean = String(entry || "").replace(/^\.\//, "");
    if (!clean || isNoisePath(clean) || seen.has(clean)) continue;
    seen.add(clean);
    lines.push(clean);
    if (lines.length >= maxEntries) break;
  }
  return lines.sort();
}

// Scores repository paths against the goal. Path tokens beat extension-only matches.
export function selectRelevantPaths(query, paths, limit = CONTEXT_LIMITS.maxFilesInContext) {
  const queryTokens = tokenize(query);
  if (!queryTokens.size) return [];
  const scored = [];
  for (const entry of Array.isArray(paths) ? paths : []) {
    const clean = String(entry || "").replace(/^\.\//, "");
    if (!clean || isNoisePath(clean)) continue;
    const pathTokens = tokenize(clean.replace(/[/._-]+/g, " "));
    let score = 0;
    for (const token of queryTokens) {
      if (pathTokens.has(token)) score += 2;
      else if (clean.toLowerCase().includes(token)) score += 1;
    }
    if (score > 0) scored.push({ path: clean, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, Math.max(1, Math.min(50, limit)))
    .map((item) => item.path);
}

export function snippet(text, { maxChars = CONTEXT_LIMITS.maxSnippetChars } = {}) {
  const value = String(text === undefined || text === null ? "" : text);
  if (value.length <= maxChars) return value;
  const head = value.slice(0, Math.floor(maxChars * 0.7));
  const tail = value.slice(-Math.floor(maxChars * 0.25));
  return head + "\n… [" + (value.length - head.length - tail.length) + " chars omitted] …\n" + tail;
}

// Command output summary: exit status, error lines, then head and tail of the log.
export function summarizeOutput({ exitCode, stdout = "", stderr = "", timedOut = false, logRef = null } = {}) {
  const stdoutLines = String(stdout).split("\n");
  const stderrLines = String(stderr).split("\n");
  const errorLines = [...stdoutLines, ...stderrLines]
    .filter((line) => /(error|failed|failure|fatal|cannot|not found|exception)/i.test(line))
    .slice(0, 20)
    .map((line) => line.trim().slice(0, 300));
  const cap = (lines) => {
    if (lines.length <= CONTEXT_LIMITS.maxOutputLines) return lines.join("\n");
    const head = lines.slice(0, 40);
    const tail = lines.slice(-40);
    return [...head, "… [" + (lines.length - 80) + " lines omitted] …", ...tail].join("\n");
  };
  return {
    status: timedOut ? "timed_out" : exitCode === 0 ? "passed" : "failed",
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    timedOut: Boolean(timedOut),
    errorLines,
    stdout: cap(stdoutLines),
    stderr: cap(stderrLines),
    logRef,
  };
}

// Assembles the context block handed to the model, bounded by a total character budget.
export function compactContext({ goal, tree = [], files = [], notes = [] } = {}) {
  const blocks = [];
  let budget = CONTEXT_LIMITS.maxContextChars;
  const take = (label, text) => {
    if (budget <= 0) return;
    const body = String(text || "").slice(0, Math.min(CONTEXT_LIMITS.maxSnippetChars, budget));
    if (!body) return;
    blocks.push("### " + label + "\n" + body);
    budget -= body.length;
  };
  take("Goal", goal);
  if (tree.length) take("Repository tree", tree.slice(0, CONTEXT_LIMITS.maxTreeEntries).join("\n"));
  for (const entry of files.slice(0, CONTEXT_LIMITS.maxFilesInContext)) {
    if (!entry || typeof entry.path !== "string") continue;
    take("File: " + entry.path, entry.content);
  }
  for (const note of notes.slice(0, 10)) take("Note", note);
  return blocks.join("\n\n");
}
