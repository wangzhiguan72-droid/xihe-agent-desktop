'use strict';
const assert = require('node:assert/strict');
const { summarize, classify, TARGET_PERCENT } = require('./cache_governor');

const row = (over = {}) => ({
  t: Date.now(), request_seq: 1, lane: 'main', model: 'deepseek-flash', provider_key: 'deepseek',
  outcome: 'complete', status: 200, error: null, comparison: { kind: 'append' },
  usage: { raw_input_tokens: 200_000, raw_cache: { state: 'reported', tokens: 194_000 }, warnings: [] },
  ...over,
});

// Cold start and prefix resets are not warm requests.
assert.equal(classify(row({ comparison: { kind: 'first' } })).kind, 'cold');
assert.equal(classify(row({ comparison: { kind: 'route_change' } })).kind, 'cold');
assert.equal(classify(row({ comparison: { kind: 'rewrite' } })).kind, 'cold');
assert.equal(classify(row({ comparison: { kind: 'append' } })).kind, 'warm');
assert.equal(classify(row({ comparison: { kind: 'unchanged' } })).kind, 'warm');

// A channel with no reported cache cannot be counted as a 95% success.
assert.equal(classify(row({ provider_key: 'relay', usage: { raw_input_tokens: 100_000,
  raw_cache: { state: 'zero', tokens: 0 }, warnings: [] } })).kind, 'uncacheable');
assert.equal(classify(row({ usage: { raw_input_tokens: 100_000,
  raw_cache: { state: 'missing', tokens: null }, warnings: [] } })).kind, 'unverified');

// Weighted warm rate is the target; one small below-target call does not
// invalidate a session that is otherwise 99% cached.
const summary = summarize([
  row({ request_seq: 1, comparison: { kind: 'first' },
    usage: { raw_input_tokens: 20_000, raw_cache: { state: 'zero', tokens: 0 }, warnings: [] } }),
  row({ request_seq: 2, usage: { raw_input_tokens: 50_000,
    raw_cache: { state: 'reported', tokens: 42_000 }, warnings: [] } }),
  row({ request_seq: 3, usage: { raw_input_tokens: 1_000_000,
    raw_cache: { state: 'reported', tokens: 995_000 }, warnings: [] } }),
]);
assert.equal(summary.threshold_percent, 95);
assert.equal(summary.warm.requests, 2);
assert.equal(summary.warm.rate, 98.76);
assert.equal(summary.status, 'met');
assert.equal(summary.warm.below_requests, 1);
assert.equal(summary.cold.requests, 1);
assert.equal(summary.overall.rate, 96.92);
assert.equal(summary.warm.tail_spikes, 1);
assert.equal(summary.warm.tail_details[0].request_seq, 2);
assert.equal(summary.cold.prefix_resets, 0);

const reset = summarize([
  row({ request_seq: 1, comparison: { kind: 'append' } }),
  row({ request_seq: 2, comparison: { kind: 'route_change' },
    usage: { raw_input_tokens: 200_000, raw_cache: { state: 'zero', tokens: 0 }, warnings: [] } }),
]);
assert.equal(reset.cold.requests, 1);
assert.equal(reset.cold.prefix_resets, 1);
assert.equal(reset.warm.requests, 1);
assert.equal(reset.status, 'met');

const unknown = summarize([row({ provider_key: 'relay', usage: { raw_input_tokens: 100_000,
  raw_cache: { state: 'zero', tokens: 0 }, warnings: [] } })]);
assert.equal(unknown.status, 'unverified');
assert.equal(unknown.uncacheable.requests, 1);
assert.equal(unknown.warm.requests, 0);

const truncated = summarize([row()], { truncated: true });
assert.equal(truncated.status, 'unverified');

assert.equal(TARGET_PERCENT, 95);
console.log('cache governor: cold/warm/uncacheable, weighted 95, tail spikes and truncation PASS');