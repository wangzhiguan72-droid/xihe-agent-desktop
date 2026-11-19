'use strict';
// Real adapter serialization and streaming parsing, with offline HTTP replies.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { chatStream } = require('./providers');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-cache-transport-'));
const originalFetch = global.fetch;
const context = { appDir: root, session_id: 'cache-session', project_id: 'project', lane: 'main', provider_key: 'relay' };
const secret = 'PRIVATE-PROMPT-AND-API-KEY';
const replies = [];
const sent = [];
const events = values => values.map(value => Buffer.from('data: ' + JSON.stringify(value) + '\n\n'));
const chat = usage => ({ ok: true, status: 200, headers: new Headers({ 'x-request-id': secret }), body: events([
  { model: secret, choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) },
]) });
const common = { kind: 'openai', base: 'https://relay.invalid/v1?credential=' + secret, key: secret, model: 'gpt-test',
  messages: [{ role: 'system', content: secret }, { role: 'user', content: 'question' }],
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }], cacheDiagnostics: context };
global.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
  const reply = replies.shift();
  if (reply instanceof Error) throw reply;
  assert(reply, 'every HTTP reply must be supplied offline');
  return reply;
};

(async () => {
  try {
    replies.push(chat({ prompt_tokens: 10000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4096 } }));
    const first = await chatStream(common);
    assert.equal(first.usage.cache_hit_tokens, 4096);
    assert.deepEqual(Object.keys(sent[0].body).sort(), ['messages', 'model', 'stream', 'stream_options', 'tools']);
    assert.deepEqual(sent[0].body.messages, common.messages, 'diagnostics must not alter payload or attach cache hints');
    assert.equal(sent[0].headers.Authorization, 'Bearer ' + secret);
    replies.push(chat({ prompt_tokens: 10020, completion_tokens: 2 }));
    await chatStream({ ...common, messages: [...common.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] });
    replies.push(chat({ prompt_tokens: 10040, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } }));
    await chatStream({ ...common, messages: [...common.messages, { role: 'user', content: 'different' }] });

    replies.push({ ok: true, status: 200, body: events([
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 512 } } },
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { completion_tokens: 2 } },
    ]) });
    const split = await chatStream(common);
    assert.equal(split.usage.prompt_tokens, 1000, 'output-only usage cannot clear earlier input counters');
    assert.equal(split.usage.cache_hit_tokens, 512, 'output-only usage cannot erase an earlier reported cache hit');
    assert.equal(split.usage.completion_tokens, 2);
    replies.push({ ok: true, status: 200, body: events([
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_cache_hit_tokens: 512 } },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_cache_hit_tokens: 0, completion_tokens: 2 } },
    ]) });
    const explicitReset = await chatStream(common);
    assert.equal(explicitReset.usage.cache_hit_tokens, 0, 'an explicit zero must replace the earlier counter');

    replies.push({ ok: true, status: 200, body: events([{ type: 'response.completed', response: { model: secret, status: 'completed', output: [],
      usage: { input_tokens: 20, output_tokens: 2, input_tokens_details: { cached_tokens: 10 } } } }]) });
    await chatStream({ ...common, kind: 'responses', base: 'https://relay.invalid/v1', messages: [{ role: 'user', content: secret }] });
    assert(sent.at(-1).body.input, 'trace must observe actual Responses conversion');
    assert(!sent.at(-1).body.messages);

    replies.push({ ok: true, status: 200, body: events([
      { type: 'message_start', message: { model: secret, usage: { input_tokens: 12, cache_read_input_tokens: 30, cache_creation_input_tokens: 8, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    ]) });
    await chatStream({ ...common, kind: 'anthropic', base: 'https://relay.invalid', system: secret, messages: [{ role: 'user', content: 'question' }] });

    const interruption = new Error(secret); interruption.name = 'TimeoutError';
    replies.push({ ok: true, status: 200, body: { async *[Symbol.asyncIterator]() {
      yield Buffer.from('data: ' + JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 1, prompt_cache_hit_tokens: 64 }, choices: [] }) + '\n\n');
      throw interruption;
    } } });
    await assert.rejects(chatStream(common), error => error === interruption && error.usage.cache_hit_tokens === 64);
    replies.push({ ok: false, status: 429, headers: new Headers(), text: async () => secret });
    await assert.rejects(chatStream(common), error => error.status === 429);

    const { readSummary } = require('./cache_diagnostics');
    const report = readSummary(root, { session_id: context.session_id, limit: 20 });
    assert.equal(report.requests, 9, 'every HTTP attempt, including failures, is independently recorded');
    const rows = report.records;
    const firstTrace = rows.find(row => row.usage.raw_cache.tokens === 4096);
    assert.equal(firstTrace.request.wire.bytes, Buffer.byteLength(JSON.stringify(sent[0].body), 'utf8'), 'wire size is the exact outbound UTF-8 body, not JSON-encoded a second time');
    assert(rows.some(row => row.protocol === 'responses'));
    assert(rows.some(row => row.protocol === 'anthropic'));
    assert(rows.some(row => row.comparison.kind === 'append'));
    assert(rows.some(row => row.usage.raw_cache.state === 'missing'));
    assert(rows.some(row => row.usage.raw_cache.state === 'zero'));
    assert(rows.some(row => row.status === 429 && row.outcome === 'error'));
    assert(rows.some(row => row.usage.raw_cache.tokens === 64 && row.outcome === 'error'));
    const logs = fs.readdirSync(path.join(root, 'data', 'cache-diagnostics')).filter(name => name.endsWith('.jsonl'))
      .map(name => fs.readFileSync(path.join(root, 'data', 'cache-diagnostics', name), 'utf8')).join('');
    assert(!logs.includes(secret), 'prompt, credentials, error body, upstream model and header values stay private');
    assert(!logs.includes('relay.invalid'), 'full endpoint is not persisted');

    const blocked = path.join(root, 'not-a-directory'); fs.writeFileSync(blocked, 'x');
    replies.push(chat({ prompt_tokens: 1, completion_tokens: 1 }));
    const fallback = await chatStream({ ...common, cacheDiagnostics: { ...context, appDir: blocked } });
    assert.equal(fallback.content, 'ok', 'diagnostic I/O failures must never fail the model call');
    assert.equal(replies.length, 0);
    console.log('cache transport: actual wire bodies, three protocols, missing/zero cache, partial/HTTP failures and private logs PASS');
  } finally { global.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
