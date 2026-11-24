'use strict';
const assert = require('assert');
const pd = require('./prompt_diagnostics');

assert.equal(pd.estimateTokens('中文'), 2);
assert.equal(pd.estimateTokens('abcd'), 1);
assert.equal(pd.estimateTokens(''), 0);

const stats = pd.analyzePrompt({
  system: '系统提示',
  tools: [{ name: 'fs_read', description: 'read file' }],
  messages: [
    { role: 'user', content: '做这道题' },
    { role: 'assistant', content: '先看数据', reasoning_content: '思考很久', tool_calls: [{ id: 't', function: { arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 't', content: 'R'.repeat(400) },
  ],
  dynamic: ['本轮规则'],
  iter: 2,
});
const byKey = Object.fromEntries(stats.components.map(c => [c.key, c]));
for (const key of ['system', 'tools', 'user', 'assistant', 'reasoning', 'tool_calls', 'tool_results', 'dynamic']) {
  assert(byKey[key] && byKey[key].tokens > 0, `missing component ${key}`);
}
assert.equal(byKey.tool_results.tokens, 100);
assert(stats.total_tokens >= 100);
assert(stats.top.length <= 5);

const session = {};
pd.record(session, stats);
assert.equal(session.prompt_stats.length, 1);
assert(stats.at);
pd.finish(session, stats, { prompt_tokens: 1000, cache_hit_tokens: 970 });
assert.equal(session.prompt_stats[0].cache_rate, 0.97);
for (let i = 0; i < 40; i++) pd.record(session, { ...stats, at: undefined, iter: i });
assert.equal(session.prompt_stats.length, 30);

console.log('prompt diagnostics: estimation, component split, cache merge and 30-row cap PASS');