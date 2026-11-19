'use strict';

const assert = require('assert');
const { chatStream } = require('./providers');

const oldFetch = global.fetch;

function chunks(...items) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        if (item instanceof Error) throw item;
        yield Buffer.from(item);
      }
    },
  };
}

function sse(value) {
  return 'data: ' + JSON.stringify(value) + '\n\n';
}

async function rejectsWith(fn, check) {
  await assert.rejects(fn, err => {
    check(err);
    return true;
  });
}

async function main() {
  const cause = new Error('socket closed');
  const timeout = new Error('upstream timed out');
  timeout.name = 'TimeoutError';
  timeout.status = 598;
  timeout.cause = cause;

  global.fetch = async () => ({ ok: true, body: chunks(
    sse({ choices: [{ delta: { content: 'partial' } }] }),
    sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    timeout,
  ) });
  await rejectsWith(() => chatStream({ kind: 'openai', base: 'https://offline', key: 'x', model: 'gpt-5', messages: [] }), err => {
    assert.strictEqual(err, timeout);
    assert.strictEqual(err.name, 'TimeoutError');
    assert.strictEqual(err.status, 598);
    assert.strictEqual(err.cause, cause);
    assert.deepStrictEqual(err.usage, { prompt_tokens: 12, completion_tokens: 3, cache_hit_tokens: 0, completion_details: null });
    assert.strictEqual(err.usage_partial, true);
  });

  const anthropicTimeout = new Error('read timeout');
  anthropicTimeout.name = 'AbortError';
  global.fetch = async () => ({ ok: true, body: chunks(
    sse({ type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0 } } }),
    anthropicTimeout,
  ) });
  await rejectsWith(() => chatStream({ kind: 'anthropic', base: 'https://offline', key: 'x', model: 'claude-sonnet-4-5', messages: [] }), err => {
    assert.strictEqual(err, anthropicTimeout);
    assert.strictEqual(err.name, 'AbortError');
    assert.deepStrictEqual(err.usage, { prompt_tokens: 20, completion_tokens: 0 });
    assert.strictEqual(err.usage_partial, true);
  });

  global.fetch = async () => ({ ok: true, body: chunks(
    sse({ type: 'message_start', message: { usage: { input_tokens: 7, output_tokens: 0 } } }),
    sse({ type: 'error', error: { type: 'api_error', message: 'upstream failed' } }),
  ) });
  await rejectsWith(() => chatStream({ kind: 'anthropic', base: 'https://offline', key: 'x', model: 'claude-sonnet-4-5', messages: [] }), err => {
    assert.match(err.message, /Anthropic 流错误: upstream failed/);
    assert.strictEqual(err.status, 529);
    assert.deepStrictEqual(err.usage, { prompt_tokens: 7, completion_tokens: 0 });
    assert.strictEqual(err.usage_partial, true);
  });

  const responsesTimeout = new Error('iterator timeout');
  responsesTimeout.name = 'TimeoutError';
  global.fetch = async () => ({ ok: true, body: chunks(
    sse({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 31, output_tokens: 9, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 2 } } } }),
    responsesTimeout,
  ) });
  await rejectsWith(() => chatStream({ base: 'https://api.openai.com/v1', key: 'x', model: 'gpt-6.1-sol', messages: [] }), err => {
    assert.strictEqual(err, responsesTimeout);
    assert.strictEqual(err.name, 'TimeoutError');
    assert.deepStrictEqual(err.usage, { prompt_tokens: 31, completion_tokens: 9, cache_hit_tokens: 4, reasoning_tokens: 2 });
    assert.strictEqual(err.usage_partial, true);
  });

  console.log('PASS stream failure partial usage preservation');
}

main().finally(() => { global.fetch = oldFetch; }).catch(err => { console.error(err); process.exitCode = 1; });

