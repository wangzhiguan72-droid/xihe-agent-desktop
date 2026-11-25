'use strict';
// Honest cache accounting. The 95% target is applied to warm, cacheable
// requests by token weight. Cold starts, prefix resets and channels that do not
// report cache are shown separately; they are never silently folded into a
// "met" claim. No prompt content is changed or dropped here.
const TARGET_PERCENT = 95;
const TAIL_PERCENT = 5;

const PROVIDER_CACHE_MODE = {
  deepseek: 'prefix',
  openai: 'prefix',
  anthropic: 'explicit',
  glm: 'unknown',
  moonshot: 'unknown',
  qwen: 'unknown',
  xai: 'unknown',
};

function cacheMode(providerKey) {
  return PROVIDER_CACHE_MODE[providerKey] || 'unknown';
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function usable(row) {
  const u = row && row.usage;
  return row && row.outcome === 'complete' && !row.error
    && Number.isSafeInteger(row.status) && row.status >= 200 && row.status < 300
    && ['reported', 'zero'].includes(u && u.raw_cache && u.raw_cache.state)
    && validCount(u.raw_input_tokens) && u.raw_input_tokens > 0
    && validCount(u.raw_cache.tokens) && u.raw_cache.tokens <= u.raw_input_tokens
    && !(u.warnings || []).length;
}

function classify(row) {
  if (!usable(row)) return { kind: 'unverified', reason: 'incomplete_or_missing_cache' };
  const input = row.usage.raw_input_tokens, cached = row.usage.raw_cache.tokens;
  const comparison = row.comparison || {};
  const mode = cacheMode(row.provider_key);
  if (cached === 0 && mode !== 'prefix' && mode !== 'explicit') {
    return { kind: 'uncacheable', reason: 'provider_cache_unverified', input, cached };
  }
  const kind = comparison.kind;
  if (kind === 'first') return { kind: 'cold', reason: 'first_request', input, cached };
  if (kind === 'route_change') return { kind: 'cold', reason: 'route_change', input, cached };
  if (kind === 'structure_change') return { kind: 'cold', reason: 'prefix_structure_change', input, cached };
  if (kind === 'rewrite') return { kind: 'cold', reason: 'prefix_rewrite', input, cached };
  if (kind === 'shorter') return { kind: 'cold', reason: 'prefix_shorter', input, cached };
  if (kind === 'skipped_large_request') return { kind: 'unverified', reason: 'request_too_large_to_compare' };
  if (kind === 'append' || kind === 'unchanged') return { kind: 'warm', reason: '', input, cached };
  return { kind: 'unverified', reason: 'unknown_prefix_comparison' };
}

function add(bucket, row) {
  bucket.requests++;
  bucket.input_tokens += row.usage.raw_input_tokens;
  bucket.cached_tokens += row.usage.raw_cache.tokens;
}

function rateOf(bucket) {
  return bucket.input_tokens ? +(100 * bucket.cached_tokens / bucket.input_tokens).toFixed(2) : null;
}

function summarize(rows, { truncated = false } = {}) {
  const overall = { requests: 0, input_tokens: 0, cached_tokens: 0, rate: null };
  const warm = { requests: 0, input_tokens: 0, cached_tokens: 0, rate: null,
    met_requests: 0, below_requests: 0, tail_spikes: 0, below_details: [], tail_details: [] };
  const cold = { requests: 0, input_tokens: 0, cached_tokens: 0, prefix_resets: 0 };
  const uncacheable = { requests: 0, input_tokens: 0, cached_tokens: 0 };
  const unverified = { requests: 0, reasons: {} };
  const byProvider = new Map();
  for (const row of rows || []) {
    const c = classify(row);
    const provider = String(row.provider_key || 'unknown');
    const p = byProvider.get(provider) || { provider_key: provider, mode: cacheMode(provider),
      requests: 0, input_tokens: 0, cached_tokens: 0, rate: null };
    p.requests++;
    if (c.input != null) {
      add(overall, row);
      p.input_tokens += c.input;
      p.cached_tokens += c.cached;
    }
    byProvider.set(provider, p);
    if (c.kind === 'warm') {
      add(warm, row);
      const input = c.input, cached = c.cached;
      if (input > 0 && cached * 100 >= input * TARGET_PERCENT) warm.met_requests++;
      else {
        warm.below_requests++;
        if (warm.below_details.length < 5) warm.below_details.push({
          t: row.t, request_seq: row.request_seq, lane: row.lane, model: row.model,
          input_tokens: input, cached_tokens: cached, uncached_tokens: input - cached,
          reason: 'new_tail_or_small_prefix',
        });
      }
      const uncached = input - cached;
      if (input > 0 && uncached * 100 > input * TAIL_PERCENT) {
        warm.tail_spikes++;
        if (warm.tail_details.length < 5) warm.tail_details.push({
          t: row.t, request_seq: row.request_seq, lane: row.lane, model: row.model,
          input_tokens: input, cached_tokens: cached, uncached_tokens: uncached,
        });
      }
    } else if (c.kind === 'cold') {
      cold.requests++;
      cold.input_tokens += c.input || 0;
      cold.cached_tokens += c.cached || 0;
      if (c.reason !== 'first_request') cold.prefix_resets++;
    } else if (c.kind === 'uncacheable') {
      uncacheable.requests++;
      uncacheable.input_tokens += c.input || 0;
      uncacheable.cached_tokens += c.cached || 0;
    } else {
      unverified.requests++;
      unverified.reasons[c.reason] = (unverified.reasons[c.reason] || 0) + 1;
    }
  }
  overall.rate = rateOf(overall);
  warm.rate = rateOf(warm);
  cold.rate = rateOf(cold);
  uncacheable.rate = rateOf(uncacheable);
  const providers = [...byProvider.values()].map(p => ({ ...p, rate: rateOf(p) }));
  let status = 'unverified';
  if (warm.requests > 0) status = warm.rate != null && warm.rate >= TARGET_PERCENT ? 'met' : 'below';
  if (truncated) status = 'unverified';
  return {
    threshold_percent: TARGET_PERCENT,
    tail_threshold_percent: TAIL_PERCENT,
    status,
    overall,
    warm,
    cold,
    uncacheable,
    unverified,
    providers,
    truncated: !!truncated,
    note: '只对热请求（追加/未变前缀且缓存字段可用）按 token 加权计算；冷启动、前缀重置、不可缓存和无法核验请求单列，不删上下文、不改分母。',
  };
}

module.exports = { TARGET_PERCENT, TAIL_PERCENT, PROVIDER_CACHE_MODE, cacheMode, classify, summarize };