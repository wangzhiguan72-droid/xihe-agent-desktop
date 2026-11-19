'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const providers = require('./providers');
providers.keyFor = () => 'offline-placeholder';
const { resolveReasoning } = require('./reasoning');
const { describeImage } = require('./vision');
const { compactHistory, runTurn, runSubagent } = require('./agent');
const { createDecision } = require('./decisions');
const { createSandbox } = require('./sandbox');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-aux-'));
const image = path.join(root, 'image.png'); fs.writeFileSync(image, 'offline fixture');
const original = global.fetch;
const requests = [], logs = [];
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body); requests.push({ url, body });
  if (String(url).endsWith('/messages')) return new Response(JSON.stringify({ content: [{ type: 'text', text: '图中42' }], stop_reason: 'end_turn', usage: { input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 4 } }));
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '摘要已核查' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 6 } }) + '\n\ndata: [DONE]\n\n');
};
(async () => {
  await describeImage({ kind: 'anthropic', base: 'https://offline.invalid', key: 'offline', model: 'claude-sonnet-5-5', imagePath: image,
    reasoningPlan: resolveReasoning({ model_reasoning: { 'anthropic:claude-sonnet-5-5': 'high' } }, 'anthropic', { kind: 'anthropic' }, 'claude-sonnet-5-5'), recordReasoning: r => logs.push(r) });
  assert.equal(requests[0].body.thinking.type, 'adaptive');
  assert.equal(requests[0].body.output_config.effort, 'high');
  assert.equal(logs.at(-1).status, 'api_accepted');
  const v = await describeImage({ kind: 'anthropic', base: 'https://offline.invalid', key: 'offline', model: 'x', imagePath: image });
  assert.equal(v.usage.prompt_tokens, 35, 'Anthropic cached inputs included once in vision');
  assert.equal(v.usage.cache_hit_tokens, 10);
  await describeImage({ base: 'https://offline.invalid/v1', key: 'offline', model: 'qwen3.8-flash', imagePath: image,
    reasoningPlan: resolveReasoning({ model_reasoning: { 'qwen:qwen3.8-flash': 'medium' } }, 'qwen', { kind: 'openai' }, 'qwen3.8-flash') });
  assert.equal(requests.at(-1).body.enable_thinking, true);
  assert.equal(requests.at(-1).body.thinking_budget, 4096);
  const settings = { summarize_model: 'relay:gpt-test', model_reasoning: { 'relay:gpt-test': 'high' },
    custom_providers: [{ id: 'relay', kind: 'openai', base: 'https://offline.invalid/v1', models: ['gpt-test'] }] };
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const sandbox = createSandbox(path.resolve(__dirname, '..'), { workspace });
  const session = { id: 'summary-test', messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '历史' + i })), memory: [] };
  let spent = 0;
  const ok = await compactHistory(session, { settings, appDir: root, sandbox, abort: new AbortController(), emit: r => logs.push(r) },
    'relay:gpt-test', 'offline', providers.resolveProvider('relay', settings), () => spent++, 'relay');
  assert.equal(ok, true); assert.equal(spent > 0, true);
  assert.equal(requests.at(-1).body.reasoning_effort, 'high');
  assert.equal(session.resolved_reasoning.kind, 'summarize');
  // 主循环保存并原样回放 Responses reasoning + function_call，不只测协议转换函数。
  let turns = 0;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, body });
    const output = turns++ === 0 ? [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'sealed' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_dir', arguments: '{"path":"."}' }]
      : [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '已检查' }] }];
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 2, output_tokens: 3 } } }) + '\n\n');
  };
  const rs = { id: 'responses-test', mode: 'free', model: 'relay:gpt-test', approval: 'full', messages: [], memory: [], todos: [], runs: [], contract: [], formulas: [], usage: { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, calls: 0, cost: 0 } };
  const responseSettings = { default_model: rs.model, role_models: { reviewer: rs.model }, provider_models: { relay: ['gpt-test'] }, provider_kinds: { relay: 'responses' }, provider_bases: { relay: 'https://offline.invalid/v1' }, custom_providers: [{ id: 'relay', kind: 'responses', base: 'https://offline.invalid/v1', models: ['gpt-test'] }] };
  await runTurn(rs, { appDir: root, settings: responseSettings, sandbox, abort: new AbortController(), stopper: { stop: false }, ledger: { costs: {} }, emit: () => {}, persist: () => {} }, { text: '查看目录并回答' });
  assert.equal(turns, 2);
  assert.equal(rs.messages.find(m => m.responses_items)?.responses_items[0].encrypted_content, 'sealed');
  assert(requests.at(-1).body.input.some(x => x.type === 'reasoning' && x.encrypted_content === 'sealed'));
  assert(requests.at(-1).body.input.some(x => x.type === 'function_call_output' && x.call_id === 'call_1'));
  const stats = require('./meter').usageStats(root, { period: 'all' });
  assert.equal(stats.totals.all.tokens, 10, 'real runTurn metering must include both Responses turns');
  assert.equal(stats.totals.all.calls, 2);
  assert.equal(rs.usage.prompt_tokens + rs.usage.completion_tokens, stats.totals.all.tokens);
  assert.equal(requests.find(r => r.body.input && r.url.endsWith('/responses')).url, 'https://offline.invalid/v1/responses');
  await describeImage({ kind: 'responses', base: 'https://offline.invalid/v1', key: 'offline', model: 'gpt-test', imagePath: image });
  const visionRequest = requests.at(-1);
  assert.equal(visionRequest.url, 'https://offline.invalid/v1/responses');
  assert(visionRequest.body.input.some(x => Array.isArray(x.content) && x.content.some(p => p.type === 'input_image')));
  rs.pendingQuestion = createDecision({ question: '选择路线', candidates: ['A', 'B', 'C'].map(id => ({ id, label: id, basis: 'mock', risk: '待检验' })), recommended_id: 'A', recommendation_reason: 'mock' });
  const clarifyBefore = requests.length;
  await runTurn(rs, { appDir: root, settings: responseSettings, sandbox, abort: new AbortController(), stopper: { stop: false }, ledger: { costs: {} }, emit: () => {}, persist: () => {} }, { action: 'clarify', decision_id: rs.pendingQuestion.decision_id, question: '为什么？' });
  assert(requests.length > clarifyBefore);
  assert.equal(requests.at(-1).url, 'https://offline.invalid/v1/responses');
  assert.equal(rs.resolved_reasoning.kind, 'clarify');
  const subCtx = { session: rs, settings: responseSettings, appDir: root, workspace, sandbox, resolvedModel: rs.model, emit: () => {} };
  const subBefore = requests.length;
  await runSubagent(subCtx, { appDir: root, settings: responseSettings, sandbox, abort: new AbortController(), stopper: { stop: false }, ledger: { costs: {} }, emit: () => {}, persist: () => {} }, 'reviewer', '只回复一句', {}, () => {});
  assert(requests.length > subBefore);
  assert.equal(requests.at(-1).url, 'https://offline.invalid/v1/responses');
  assert.equal(rs.resolved_reasoning.kind, 'sub');
  const compactSettings = { ...responseSettings, summarize_model: rs.model };
  const compactSession = { id: 'responses-summary', messages: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '历史' + i })), memory: [] };
  const summaryBefore = requests.length;
  const summaryOk = await compactHistory(compactSession, { settings: compactSettings, appDir: root, sandbox, abort: new AbortController(), emit: () => {} }, 'relay:gpt-test', 'offline', providers.resolveProvider('relay', compactSettings), () => {}, 'relay');
  assert.equal(summaryOk, true);
  assert(requests.length > summaryBefore);
  assert.equal(requests.at(-1).url, 'https://offline.invalid/v1/responses');
  console.log('PASS vision, cache accounting, summary reasoning and Responses runtime tool replay');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { global.fetch = original; fs.rmSync(root, { recursive: true, force: true }); });
