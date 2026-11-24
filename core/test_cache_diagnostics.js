'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const diagnostics = require('./cache_diagnostics');

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-cache-diagnostics-'));
const secret = 'PRIVATE_PROMPT_DO_NOT_WRITE_69887';
const apiKey = 'sk-test-dummy-key-not-real';
const endpoint = 'https://private-user:private-password@relay.invalid/v1/chat/completions?token=PRIVATE_URL_DO_NOT_WRITE_69887';
const context = { appDir, session_id: 'cache_case', project_id: 'project_a', lane: 'main', provider_key: 'relay' };
const messages = content => [{ role: 'system', content: 'Stable setup' }, { role: 'user', content }];
const body = (content, overrides = {}) => ({ model: 'gpt-6-astra', messages: messages(content),
  tools: [{ type: 'function', function: { name: 'read', description: secret, parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'write', parameters: { type: 'object' } } }],
  stream: true, ...overrides });
const start = (input, changes = {}) => diagnostics.beginTrace({ ...context, ...(changes.context || {}) },
  { protocol: changes.protocol || 'openai', url: changes.url || endpoint, body: input,
    serializedBody: JSON.stringify(input) });
const done = (trace, usage = { prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens: 9 },
  normalized = { prompt_tokens: 200, cache_hit_tokens: 100, completion_tokens: 9 }) => {
  trace.response(200, new Headers({ 'x-request-id': 'upstream-private-id', 'authorization': apiKey,
    'x-hidden': secret }));
  trace.observeUsage(usage);
  trace.finish(normalized, null, 'PRIVATE_RESPONSE_MODEL_DO_NOT_WRITE_69887');
};

try {
  assert.equal(diagnostics.readSummary(appDir, { session_id: context.session_id }).available, false);
  const first = start(body(secret));
  assert(first);
  done(first);
  let summary = diagnostics.readSummary(appDir, { session_id: context.session_id });
  assert.equal(summary.available, true);
  assert.equal(summary.new_requests_only, true);
  assert.equal(summary.records[0].comparison.kind, 'first');
  assert.equal(summary.known_rate, 50);
  assert.deepEqual({ met: summary.cache_target.met, below: summary.cache_target.below,
    unverified: summary.cache_target.unverified, status: summary.cache_target.status },
  { met: 0, below: 1, unverified: 0, status: 'below' });
  assert.equal(summary.window_days, 7);
  const sent = JSON.stringify(body(secret));
  assert.equal(summary.records[0].request.wire.bytes, Buffer.byteLength(sent, 'utf8'));
  const utf8Body = body('中文“引号” and \'single quotes\'');
  const utf8Wire = JSON.stringify(utf8Body);
  const utf8Trace = start(utf8Body, { context: { lane: 'utf8-wire' } });
  done(utf8Trace);
  assert.equal(diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0].request.wire.bytes,
    Buffer.byteLength(utf8Wire, 'utf8'));
  const escapedWire = utf8Wire.replace('中文', '\\u4e2d\\u6587');
  const escapedTrace = diagnostics.beginTrace({ ...context, lane: 'utf8-wire' },
    { protocol: 'openai', url: endpoint, body: utf8Body, serializedBody: escapedWire });
  done(escapedTrace);
  const wireRows = diagnostics.readSummary(appDir, { session_id: context.session_id }).records;
  assert.equal(wireRows[0].request.wire.bytes, Buffer.byteLength(escapedWire, 'utf8'));
  assert.notEqual(wireRows[0].request.wire.hash, wireRows[1].request.wire.hash);

  const append = start(body(secret, { messages: [...messages(secret), { role: 'assistant', content: 'last result' }] }));
  done(append);
  summary = diagnostics.readSummary(appDir, { session_id: context.session_id });
  assert.equal(summary.records[0].comparison.kind, 'append');
  assert.equal(summary.records[0].comparison.common_messages, 1);
  assert.deepEqual(summary.records[0].comparison.changed_parts, ['conversation']);

  const rewrite = start(body(secret + '!'));
  done(rewrite);
  let row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.comparison.kind, 'rewrite');
  assert.equal(row.comparison.first_changed.index, 0);
  assert.equal(row.comparison.first_changed.field, 'content');
  assert(Number.isSafeInteger(row.comparison.first_changed.shared_bytes_lower_bound));
  assert(!Object.values(row.comparison).includes(secret));

  const reversed = start(body(secret + '!', { tools: [...body(secret).tools].reverse() }));
  done(reversed);
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.deepEqual(row.comparison.changed_parts, ['tools']);
  assert.equal(row.comparison.kind, 'structure_change');
  const modelSwitch = start(body(secret, { model: 'gpt-6-sol' }));
  done(modelSwitch);
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.comparison.kind, 'route_change');
  const endpointSwitch = start(body(secret), { url: 'https://another.invalid/v1/chat/completions' });
  done(endpointSwitch);
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.comparison.kind, 'route_change');
  const otherLane = start(body(secret), { context: { lane: 'sub:worker' } });
  done(otherLane);
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.comparison.kind, 'first');

  const taskA = start(body('task A'), { context: { lane: 'sub:worker', task_id: 'child_A' } });
  const taskB = start(body('task B'), { context: { lane: 'sub:worker', task_id: 'child_B' } });
  const taskASecond = start(body('task A', { messages: [...messages('task A'), { role: 'assistant', content: 'next' }] }),
    { context: { lane: 'sub:worker', task_id: 'child_A' } });
  done(taskASecond); done(taskB); done(taskA);
  let taskRows = diagnostics.readSummary(appDir, { session_id: context.session_id, limit: 5 }).records;
  assert.equal(taskRows.find(r => r.trace_id === taskB.trace_id).comparison.kind, 'first');
  assert.equal(taskRows.find(r => r.trace_id === taskASecond.trace_id).comparison.kind, 'append');
  assert.notEqual(taskRows.find(r => r.trace_id === taskA.trace_id).task_scope_hash,
    taskRows.find(r => r.trace_id === taskB.trace_id).task_scope_hash);

  // Request order, not completion order, defines the predecessor.
  const pendingA = start(body('parallel A'), { context: { lane: 'parallel' } });
  const pendingB = start(body('parallel B'), { context: { lane: 'parallel' } });
  done(pendingB);
  done(pendingA);
  row = diagnostics.readSummary(appDir, { session_id: context.session_id, limit: 2 }).records.find(r => r.trace_id === pendingB.trace_id);
  assert.equal(row.comparison.kind, 'rewrite');
  assert.equal(row.comparison.first_changed.index, 0);

  const missing = start(body(secret), { context: { lane: 'usage' } });
  missing.observeUsage({ prompt_tokens: 100 });
  missing.finish({ prompt_tokens: 100, cache_hit_tokens: 0 });
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.usage.raw_cache.state, 'missing');
  const zero = start(body(secret), { context: { lane: 'usage' } });
  zero.observeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 0 });
  zero.finish({ prompt_tokens: 100, cache_hit_tokens: 0 });
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.usage.raw_cache.state, 'zero');
  const conflict = start(body(secret), { context: { lane: 'usage' } });
  conflict.observeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 30,
    prompt_tokens_details: { cached_tokens: 31 } });
  conflict.finish({ prompt_tokens: 100, cache_hit_tokens: 30 });
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.usage.raw_cache.state, 'conflicting');
  const invalid = start(body(secret), { context: { lane: 'usage' } });
  invalid.observeUsage({ prompt_tokens: NaN, prompt_cache_hit_tokens: Infinity });
  invalid.finish({ prompt_tokens: NaN, cache_hit_tokens: Infinity });
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.usage.raw_cache.state, 'invalid');
  assert.equal(row.usage.raw_cache.tokens, null);

  const overInput = start(body(secret), { context: { lane: 'usage', session_id: 'over_input_case' } });
  overInput.observeUsage({ prompt_tokens: 1, prompt_cache_hit_tokens: 5 });
  overInput.finish({ prompt_tokens: 1, cache_hit_tokens: 5 });
  const overSummary = diagnostics.readSummary(appDir, { session_id: 'over_input_case' });
  row = overSummary.records[0];
  assert(row.usage.warnings.includes('cache_exceeds_input'));
  assert.equal(overSummary.known_rate, null);
  assert.equal(overSummary.unknown_count, 1);

  const interrupted = start(body(secret), { context: { lane: 'usage' } });
  interrupted.response(200, { get: name => name === 'x-request-id' ? 'opaque-upstream' : null });
  interrupted.observeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } });
  interrupted.observeUsage({ completion_tokens: 7 }); // A later partial event must not erase the cache report.
  const streamError = new Error(secret);
  streamError.name = 'TimeoutError'; streamError.status = 598; streamError.usage_partial = true;
  interrupted.finish({ prompt_tokens: 100, cache_hit_tokens: 0, completion_tokens: 7 }, streamError);
  interrupted.finish({ prompt_tokens: 0, cache_hit_tokens: 0 }, new Error('duplicate'));
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.outcome, 'error');
  assert.equal(row.status, 200);
  assert.equal(row.usage.raw_cache.state, 'reported');
  assert.equal(row.usage.raw_cache.tokens, 50);
  assert(row.usage.warnings.includes('adapter_cache_mismatch'));
  assert.equal(row.error.name, 'TimeoutError');
  assert.equal(row.error.status, 598);
  assert.equal(row.error.usage_partial, true);

  const responses = start({ model: 'gpt-6-astra', input: [{ role: 'system', content: 'setup' },
    { role: 'user', content: secret }], stream: true }, { context: { lane: 'responses' }, protocol: 'responses' });
  responses.observeUsage({ input_tokens: 80, input_tokens_details: { cached_tokens: 40 }, output_tokens: 5 });
  responses.finish({ prompt_tokens: 80, cache_hit_tokens: 40, completion_tokens: 5 });
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.usage.raw_cache.source, 'input_tokens_details.cached_tokens');

  const anthropic = start({ model: 'claude-test', system: 'setup', messages: [{ role: 'user', content: secret }],
    tools: [] }, { context: { lane: 'anthropic' }, protocol: 'anthropic' });
  anthropic.observeUsage({ input_tokens: 20, cache_read_input_tokens: 60,
    cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 15,
      ephemeral_1h_input_tokens: 5 } });
  anthropic.finish({ prompt_tokens: 100, cache_hit_tokens: 60 });
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.usage.raw_cache.tokens, 60);
  assert.equal(row.usage.raw_input_tokens, 100);

  const contents = fs.readdirSync(path.join(appDir, 'data', 'cache-diagnostics'))
    .map(name => fs.readFileSync(path.join(appDir, 'data', 'cache-diagnostics', name), 'utf8')).join('\n');
  for (const forbidden of [secret, apiKey, 'private-user', 'private-password', 'PRIVATE_URL',
    'upstream-private-id', 'opaque-upstream', 'PRIVATE_RESPONSE_MODEL']) assert(!contents.includes(forbidden), forbidden);
  assert(!contents.includes('parallel A'));
  assert(!contents.includes('parallel B'));
  assert(!contents.includes(streamError.message));
  const allRows = contents.trim().split('\n').map(JSON.parse);
  assert(allRows.every(r => !Object.prototype.hasOwnProperty.call(r, 'messages')));
  assert.equal(diagnostics.readSummary(appDir, { session_id: context.session_id, limit: 3 }).records.length, 3);

  const huge = body('X'.repeat(4 * 1024 * 1024 + 10));
  const hugeWire = JSON.stringify(huge);
  const hugeTrace = start(huge, { context: { lane: 'oversize' } });
  done(hugeTrace);
  row = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0];
  assert.equal(row.comparison.kind, 'skipped_large_request');
  assert.equal(row.request.skipped_large_request, true);
  assert.equal(row.request.wire.bytes, Buffer.byteLength(hugeWire, 'utf8'));
  assert.equal(row.usage.raw_cache.state, 'reported');
  const afterHuge = start(body('small again'), { context: { lane: 'oversize' } });
  done(afterHuge);
  const afterHugeComparison = diagnostics.readSummary(appDir, { session_id: context.session_id }).records[0].comparison;
  assert.equal(afterHugeComparison.kind,
    'first', 'large request cannot become a misleading comparison baseline');
  assert.equal(afterHugeComparison.reason, 'previous_large_request');

  const unwritable = path.join(appDir, 'unwritable-root');
  fs.writeFileSync(unwritable, 'file, not directory');
  const probe = diagnostics.beginTrace({ ...context, appDir: unwritable },
    { protocol: 'openai', url: endpoint, body: body(secret), serializedBody: JSON.stringify(body(secret)) });
  assert(probe);
  assert.doesNotThrow(() => { probe.response(500, {}); probe.finish(null, new Error(secret)); });
  const failedSummary = diagnostics.readSummary(unwritable, { session_id: context.session_id });
  assert.equal(failedSummary.available, false);
  assert.equal(failedSummary.dropped_count, 1);
  assert.equal(failedSummary.recording_errors, 1);
  assert.equal(failedSummary.recording_status, 'degraded');
  assert.equal(failedSummary.truncated, true);
  assert.equal(failedSummary.diagnostic_error, 'records_dropped');
  const otherSession = diagnostics.readSummary(unwritable, { session_id: 'another-session' });
  assert.equal(otherSession.recording_errors, 0, 'write failures from one session must not be attributed to another');
  assert.equal(otherSession.dropped_count, 0);
  assert.equal(otherSession.recording_status, 'ok');
  assert.equal(diagnostics.beginTrace({ appDir, session_id: '../escape', lane: 'main' },
    { protocol: 'openai', url: endpoint, body: body(secret) }), null);

  const targetSession = 'cache_target_case';
  const targetTrace = (input, cached, options = {}) => {
    const trace = start(body('target'), { context: { session_id: targetSession, lane: 'target' } });
    if (options.status !== null) trace.response(options.status || 200, {});
    trace.observeUsage({ prompt_tokens: input, completion_tokens: 1,
      ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }) });
    trace.finish({ prompt_tokens: input, cache_hit_tokens: options.normalizedCache ?? cached ?? 0 },
      options.error || null);
    return trace;
  };
  targetTrace(100_000, 95_000);
  summary = diagnostics.readSummary(appDir, { session_id: targetSession });
  assert.equal(summary.cache_target.status, 'met');
  assert.equal(summary.cache_target.met, 1);
  targetTrace(100_000, 94_995); // 94.995% is strictly below 95%, regardless of display rounding.
  targetTrace(1_000_000, 1_000_000); // The weighted aggregate now exceeds 95%.
  const missingTarget = targetTrace(100, undefined);
  targetTrace(100, 0);
  const failedTarget = targetTrace(100, 100, { error: new Error('interrupted') });
  const mismatchTarget = targetTrace(100, 90, { normalizedCache: 89 });
  const noResponseTarget = targetTrace(100, 100, { status: null });
  const zeroInputTarget = targetTrace(0, 0);
  const httpErrorTarget = targetTrace(100, 100, { status: 500 });
  summary = diagnostics.readSummary(appDir, { session_id: targetSession });
  assert(summary.known_rate > 95, 'weighted aggregate can mask a low individual request');
  assert.deepEqual({ met: summary.cache_target.met, below: summary.cache_target.below,
    unverified: summary.cache_target.unverified, status: summary.cache_target.status },
  { met: 2, below: 2, unverified: 6, status: 'below' });
  assert.equal(summary.cache_target.below_requests.find(r => r.cached_tokens === 94_995).input_tokens, 100_000);
  for (const trace of [missingTarget, failedTarget, mismatchTarget, noResponseTarget,
    zeroInputTarget, httpErrorTarget]) {
    assert.equal(summary.records.find(r => r.trace_id === trace.trace_id)?.cache_target_status,
      'unverified', 'an incomplete or inconsistent request must not pass');
  }
  const targetLog = path.join(appDir, 'data', 'cache-diagnostics',
    fs.readdirSync(path.join(appDir, 'data', 'cache-diagnostics')).find(name => name.endsWith('.jsonl')));
  const passingRow = summary.records.find(r => r.cache_target_status === 'met');
  fs.appendFileSync(targetLog, 'x'.repeat(1024 * 1024 + 1) + '\n' + JSON.stringify(passingRow) + '\n');
  const truncatedSummary = diagnostics.readSummary(appDir, { session_id: targetSession });
  assert.equal(truncatedSummary.truncated, true);
  assert.equal(truncatedSummary.cache_target.met, 1);
  assert.equal(truncatedSummary.cache_target.status, 'unverified', 'a partial diagnostic window cannot pass');

  console.log('cache diagnostics: prefix comparison, raw usage, redaction and honest 95% target PASS');
} finally {
  const resolved = path.resolve(appDir);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('xihe-cache-diagnostics-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
