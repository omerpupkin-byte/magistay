// ─── services/usage.js ─────────────────────────────────────────
// Counts what each search costs, so the bill is never a surprise:
// paid lookups, cache hits that avoided one, and Claude tokens.
// Since the last restart; shown in /health and in the check report.

const counters = Object.create(null);
const startedAt = Date.now();

export function count(name, n = 1) { counters[name] = (counters[name] || 0) + n; }

// Prices used for the estimate. Override to match the plan you are on.
const price = () => ({
  serpapiCall:   Number(process.env.SERPAPI_COST_PER_CALL) || 0.015,           // $75 / 5,000 searches
  claudeInPerM:  Number(process.env.CLAUDE_COST_IN_PER_M)  || 0.10,            // Haiku 5.5, $ per million tokens (prompts up to 100K)
  claudeOutPerM: Number(process.env.CLAUDE_COST_OUT_PER_M) || 0.50,
});

export function usageSnapshot() {
  const c = (k) => counters[k] || 0;
  const p = price();
  const serp   = c('serpapiCalls') * p.serpapiCall;
  const claude = c('claudeInputTokens') / 1e6 * p.claudeInPerM + c('claudeOutputTokens') / 1e6 * p.claudeOutPerM;
  const searches = c('searches');
  const round = (n) => Math.round(n * 10000) / 10000;
  return {
    sinceRestartMin: Math.round((Date.now() - startedAt) / 60000),
    searches,
    serpapiCalls: c('serpapiCalls'),
    paidLookupsAvoidedByCache: c('listingCacheHits') + c('priceCacheHits'),
    listingCacheHits: c('listingCacheHits'), priceCacheHits: c('priceCacheHits'),
    claudeCalls: c('claudeCalls'), claudeFailedCalls: c('claudeFailedCalls'), claudeInputTokens: c('claudeInputTokens'), claudeOutputTokens: c('claudeOutputTokens'),
    estimatedUsd: { serpapi: round(serp), claude: round(claude), total: round(serp + claude),
                    perSearch: searches ? round((serp + claude) / searches) : null },
  };
}

// A before/after pair gives the cost of one search.
export function usageDelta(before, after) {
  const d = (k) => (after[k] || 0) - (before[k] || 0);
  const p = price();
  const usd = d('serpapiCalls') * p.serpapiCall + d('claudeInputTokens') / 1e6 * p.claudeInPerM + d('claudeOutputTokens') / 1e6 * p.claudeOutPerM;
  return { serpapiCalls: d('serpapiCalls'), cacheHits: d('paidLookupsAvoidedByCache'),
           claudeInputTokens: d('claudeInputTokens'), claudeOutputTokens: d('claudeOutputTokens'),
           estimatedUsd: Math.round(usd * 10000) / 10000 };
}
