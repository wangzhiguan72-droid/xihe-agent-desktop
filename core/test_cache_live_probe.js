'use strict';
const assert = require('assert/strict');
const { selectedUsage, observeStream } = require('../scripts/cache_live_probe');
(async () => {
  const secret = 'NEVER_PERSIST_RESPONSE_TEXT_OR_AUTH';
  assert.deepEqual(selectedUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 },
    authorization: secret, message: secret, cache_hit_tokens: secret }), {
    prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 }, cache_hit_tokens: { invalid_type: 'string' },
  });
  const row = { started: Date.now(), raw_usage_events: [], first_stream_ms: null };
  const event = 'data: ' + JSON.stringify({ type: 'response.completed', response: {
    usage: { input_tokens: 100, output_tokens: 8, input_tokens_details: { cached_tokens: 64 } }, output_text: secret,
  }, system_fingerprint: secret }) + '\n\ndata: [DONE]\n\n';
  const parts = [Buffer.from(event.slice(0, 19)), Buffer.from(event.slice(19, 77)), Buffer.from(event.slice(77))];
  let seen = 0;
  for await (const part of observeStream(parts, row)) { assert.equal(part, parts[seen++]); }
  assert.equal(seen, parts.length);
  assert.equal(row.raw_usage_events.length, 1);
  assert.equal(row.raw_usage_events[0].usage.input_tokens_details.cached_tokens, 64);
  assert(!JSON.stringify(row).includes(secret));
  assert.equal(row.backend_fingerprint.length, 64);
  const interrupted = { started: Date.now(), raw_usage_events: [], first_stream_ms: null };
  const error = new Error('closed');
  const stream = { async *[Symbol.asyncIterator]() {
    yield Buffer.from('data: {"usage":{"prompt_tokens":40,"prompt_cache_hit_tokens":32}}\n\n');
    throw error;
  } };
  await assert.rejects(async () => { for await (const part of observeStream(stream, interrupted)) {} }, caught => caught === error);
  assert.equal(interrupted.raw_usage_events[0].usage.prompt_cache_hit_tokens, 32);
  console.log('manual live probe helpers: fragmented wire events, redaction and partial usage PASS; no network calls');
})().catch(error => { console.error(error); process.exitCode = 1; });
