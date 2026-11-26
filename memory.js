(function (root) {
  "use strict";
  const STOPWORDS = new Set(["the","and","for","with","that","this","from","you","your","are","was","were","have","has","had","how","what","when","where","why","can","could","would","should","about","into","make","give","show","help","please","want","need","like","just","its","our","their","them","then","than","not","but","all","any","also","use","using","does","did","will","now"]);
  function tokenize(value) {
    return new Set(String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter(token => token.length >= 3 && !STOPWORDS.has(token)));
  }
  function selectRelevantFacts(query, facts, limit = 12) {
    if (!Array.isArray(facts) || !facts.length) return [];
    const cap = Math.max(1, Math.min(30, Math.floor(Number(limit) || 12)));
    const valid = facts.map((fact, index) => ({ fact, index, updatedAt: Number(fact && fact.updatedAt) || 0 }))
      .filter(item => item.fact && typeof item.fact.text === "string" && item.fact.text.trim());
    if (!valid.length) return [];
    const queryTokens = tokenize(query);
    if (!queryTokens.size) return valid.sort((a, b) => b.updatedAt - a.updatedAt || b.index - a.index).slice(0, Math.min(cap, 5)).map(item => item.fact);
    const scored = valid.map(item => {
      const factTokens = tokenize(item.fact.text);
      let overlap = 0;
      for (const token of queryTokens) if (factTokens.has(token)) overlap += token.length >= 7 ? 1.25 : 1;
      const ageDays = Math.max(0, (Date.now() - item.updatedAt) / 86400000);
      const recency = item.updatedAt ? 0.12 * Math.exp(-ageDays / 365) : 0;
      return { ...item, overlap, score: overlap / Math.sqrt(queryTokens.size) + recency };
    }).filter(item => item.overlap > 0);
    if (!scored.length) return valid.sort((a, b) => b.updatedAt - a.updatedAt || b.index - a.index).slice(0, Math.min(cap, 4)).map(item => item.fact);
    return scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || b.index - a.index).slice(0, cap).map(item => item.fact);
  }
  function searchRelevantFacts(query, facts, limit = 20) {
    const queryTokens = tokenize(query);
    if (!queryTokens.size || !Array.isArray(facts)) return [];
    const matches = facts.filter(fact => fact && typeof fact.text === "string" && [...queryTokens].some(token => tokenize(fact.text).has(token)));
    return matches.length ? selectRelevantFacts(query, matches, limit) : [];
  }
  const api = Object.freeze({ tokenize, selectRelevantFacts, searchRelevantFacts });
  root.ULTRONMemory = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
