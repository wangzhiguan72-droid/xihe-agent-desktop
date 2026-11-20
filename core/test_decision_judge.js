'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { judgeDecision, disposition, extractJson, shouldAutoJudge } = require('./decision_judge');

const candidates = [
  { id: 'a', label: '保守基线', basis: '数据少', tradeoff: '精度一般', risk: '创新弱' },
  { id: 'b', label: '约束回归', basis: '样本适配', tradeoff: '解释性好', risk: '需要检验' },
  { id: 'c', label: '深度模型', basis: '表达力强', tradeoff: '精度潜力高', risk: '易过拟合' },
];
const args = { question: '选择样本少时的建模方案', candidates, recommended_id: 'b', recommendation_reason: '样本量有限，优先稳健与可解释。' };
const settings = {
  decision_judge: { enabled: true, provider: 'tokenrhythm', model: 'neohorse-1-9b', min_confidence: 0.82 },
  custom_providers: [{ id: 'tokenrhythm', name: 'TokenRhythm', base: 'https://tokenrhythm.test/v1', kind: 'openai', models: ['neohorse-1-9b'] }],
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-judge-'));
fs.mkdirSync(path.join(root, 'config'));
fs.writeFileSync(path.join(root, 'config', 'custom_tokenrhythm.key'), 'test-key', 'utf8');

const response = (content, usage = { prompt_tokens: 10, completion_tokens: 8 }) => ({
  ok: true,
  status: 200,
  async json() { return { choices: [{ message: { content } }], usage }; },
});

(async () => {
  assert.deepEqual(extractJson('```json\n{"choice_id":"b","confidence":0.9}\n```'), { choice_id: 'b', confidence: 0.9 });
  assert.equal(shouldAutoJudge(args, { decision_judge: { enabled: true, trigger: 'on_demand' } }).use, false);
  assert.equal(shouldAutoJudge(args, { decision_judge: { enabled: true, trigger: 'smart' } }).use, false);
  assert.equal(shouldAutoJudge({ ...args, question: '选择一个工具路由方式', candidates: [{ id: 'a', label: '工具路由A', basis: '简单' }, { id: 'b', label: '工具路由B', basis: '稳定' }, { id: 'c', label: '工具路由C', basis: '快速' }] }, { decision_judge: { enabled: true, trigger: 'smart' } }).use, true);
  assert.equal(shouldAutoJudge({ ...args, question: '选择最终模型与核心假设' }, { decision_judge: { enabled: true, trigger: 'smart' } }).use, false);
  const accepted = await judgeDecision({ args, settings, appDir: root, fetchImpl: async () => response('{"choice_id":"b","confidence":0.9,"reason":"稳健"}') });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.choice_id, 'b');
  assert.equal(disposition(accepted, args, settings).status, 'accepted');
  const conflict = await judgeDecision({ args, settings, appDir: root, fetchImpl: async () => response('{"choice_id":"c","confidence":0.99,"reason":"表达力"}') });
  assert.equal(disposition(conflict, args, settings).status, 'escalate');
  const malformed = await judgeDecision({ args, settings, appDir: root, fetchImpl: async () => response('not json') });
  assert.equal(malformed.ok, false);
  const disabled = await judgeDecision({ args, settings: { ...settings, decision_judge: { enabled: false } }, appDir: root, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(disabled.skipped, true);
  const tools = require('./tools');
  assert(tools.READ_ONLY.has('decision_judge'));
  assert(tools.TOOLS.some(t => t.name === 'decision_judge'));
  const oldFetch = global.fetch;
  global.fetch = async () => response('{"choice_id":"b","confidence":0.91,"reason":"工具入口复核"}');
  const toolResult = await tools.TOOLS.find(t => t.name === 'decision_judge').run({ settings, appDir: root, abort: new AbortController(), spend() {} }, args);
  global.fetch = oldFetch;
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.disposition.status, 'accepted');

  // 交换顺序双评（swap_check）：一致才采信，置信度取小，usage 合并；不一致或复判失败都升级。
  const swapSettings = { ...settings, decision_judge: { ...settings.decision_judge, swap_check: true } };
  const swapCalls = [];
  const swapFetch = impl => async (url, init) => { swapCalls.push(JSON.parse(init.body)); return impl(swapCalls.length); };
  const okBody = (choice, conf) => response(`{"choice_id":"${choice}","confidence":${conf},"reason":"复核"}`,
    { prompt_tokens: 10, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 6 } });
  swapCalls.length = 0;
  const consistent = await judgeDecision({ args, settings: swapSettings, appDir: root, fetchImpl: swapFetch(n => okBody('b', n === 1 ? 0.9 : 0.85)) });
  assert.equal(swapCalls.length, 2);
  assert.equal(consistent.ok, true);
  assert.equal(consistent.swap_checked, true);
  assert.equal(consistent.swap_consistent, true);
  assert.equal(consistent.confidence, 0.85);
  assert.equal(consistent.usage.prompt_tokens, 20);
  assert.equal(consistent.usage.completion_tokens, 16);
  assert.equal(consistent.usage.prompt_tokens_details.cached_tokens, 12);
  const secondPrompt = swapCalls[1].messages[1].content;
  assert(secondPrompt.indexOf('c |') >= 0 && secondPrompt.indexOf('c |') < secondPrompt.indexOf('a |'), '第二次调用必须倒序列出候选');
  assert.equal(disposition(consistent, args, swapSettings).status, 'accepted');
  swapCalls.length = 0;
  const inconsistent = await judgeDecision({ args, settings: swapSettings, appDir: root, fetchImpl: swapFetch(n => okBody(n === 1 ? 'b' : 'c', 0.95)) });
  assert.equal(inconsistent.ok, false);
  assert.equal(inconsistent.swap_consistent, false);
  assert.deepEqual(inconsistent.choices, ['b', 'c']);
  assert.equal(disposition(inconsistent, args, swapSettings).status, 'escalate');
  assert.equal(disposition(inconsistent, args, swapSettings).reason, '交换顺序双评不一致（疑似位置偏差）');
  swapCalls.length = 0;
  const secondFailed = await judgeDecision({ args, settings: swapSettings, appDir: root, fetchImpl: swapFetch(n => n === 1 ? okBody('b', 0.9) : { ok: false, status: 500, async json() { return {}; } }) });
  assert.equal(swapCalls.length, 2);
  assert.equal(secondFailed.ok, false);
  assert.equal(secondFailed.swap_checked, true);
  assert(/交换顺序复判失败/.test(secondFailed.error));
  swapCalls.length = 0;
  const firstFailed = await judgeDecision({ args, settings: swapSettings, appDir: root, fetchImpl: swapFetch(() => ({ ok: false, status: 402, async json() { return {}; } })) });
  assert.equal(swapCalls.length, 1, '首评失败不得再花第二次调用');
  assert.equal(firstFailed.ok, false);
  swapCalls.length = 0;
  const single = await judgeDecision({ args, settings, appDir: root, fetchImpl: swapFetch(() => okBody('b', 0.9)) });
  assert.equal(swapCalls.length, 1);
  assert.equal(single.ok, true);
  assert.equal(single.swap_checked, undefined);

  fs.rmSync(root, { recursive: true, force: true });
  console.log('decision judge tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
