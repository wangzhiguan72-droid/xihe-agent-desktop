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
  fs.rmSync(root, { recursive: true, force: true });
  console.log('decision judge tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
