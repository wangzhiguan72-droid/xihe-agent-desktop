'use strict';
const assert = require('assert/strict');
const { createDecision, validateResponse, validateClarification, decisionRecord, recommendedChoice,
  textDecision, isVagueContinuation, continuationState } = require('./decisions');
for (const prompt of [
  '请选择问题四的主模型路线：A（一维）、B（二维）或 C（质点）。',
  '当前路线卡仍有效，请直接回复 A、B、C 或自定义方案。',
  '已发出路线卡，目前等待你选择 A、B、C。',
  '请选择推荐项后我再继续。',
]) assert.equal(textDecision(prompt), prompt);
for (const answer of [
  'AUC 为 0.81，ABC 算法已经运行。',
  '回顾：此前请用户选择 A/B/C，现已选择 A。',
  '已经选择 A，正在生成图件。',
  'A/B/C 三组数据的差异见表 2。',
  '当前路线评估报告已经完成。',
]) assert.equal(textDecision(answer), null, answer);
for (const prompt of ['继续', '请继续推进任务', '请继续推进任务书中要求的所有工作，四个产物全部生成。',
  '请继续推进任务书，直到四个产物全部生成。', 'continue', 'Proceed with the task.']) {
  assert.equal(isVagueContinuation(prompt), true, prompt);
}
for (const prompt of ['继续按 A 方案执行', '请选择 A', '继续分析第二问样本差异', '请继续核查 AUC', '介绍完整模型']) {
  assert.equal(isVagueContinuation(prompt), false, prompt);
}
assert.deepEqual(continuationState({ status: 'idle' }), { can_continue: true, reason: 'ready', action: 'continue' });
assert.deepEqual(continuationState({ status: 'idle', pendingQuestion: { decision_id: 'x' } }),
  { can_continue: false, reason: 'waiting_for_decision', action: 'answer_decision' });
assert.deepEqual(continuationState({ status: 'idle', wait_reason: { kind: 'decision_text' } }),
  { can_continue: false, reason: 'waiting_for_decision', action: 'answer_decision' });
assert.deepEqual(continuationState({ status: 'waiting_input' }),
  { can_continue: false, reason: 'waiting_for_decision', action: 'answer_decision' });
assert.deepEqual(continuationState({ status: 'idle', pendingApproval: { id: 'approval' } }),
  { can_continue: false, reason: 'waiting_for_approval', action: 'approve' });
assert.deepEqual(continuationState({ status: 'waiting_jobs' }),
  { can_continue: false, reason: 'waiting_for_jobs', action: 'wait' });
assert.deepEqual(continuationState({ status: 'waiting_external' }),
  { can_continue: false, reason: 'waiting_external', action: 'wait' });
assert.deepEqual(continuationState({ status: 'idle', last_error: { reason: 'model failed' } }),
  { can_continue: false, reason: 'blocked', action: 'review_error' });
assert.deepEqual(continuationState({ status: 'running', last_error: { reason: 'old' } }),
  { can_continue: false, reason: 'running', action: 'wait' });
const candidates = ['a', 'b', 'c'].map(id => ({ id, label: '方案' + id, basis: '基线实验', tradeoff: '精度与时间', risk: '数据不足' }));
const recommendation_reason = '题目数据可支持方案b，赛时计算与验证工作量可控；a数据要求更高，c精度不足。';
const q = createDecision({ question: '选择路线', candidates, recommended_id: 'b', recommendation_reason });
assert.equal(q.candidates.length, 3);
assert.equal(q.recommendation_reason, recommendation_reason);
assert.equal(recommendedChoice(q).id, 'b');
assert.throws(() => createDecision({ question: 'x', candidates, recommended_id: 'b' }), /推荐判断/);
assert.throws(() => createDecision({ question: 'x', candidates, recommended_id: 'b', recommendation_reason: ' ' }), /推荐判断/);
assert.throws(() => createDecision({ question: 'x', candidates: candidates.slice(1), recommended_id: 'b' }), /3/);
assert.throws(() => createDecision({ question: 'x', candidates, recommended_id: 'missing' }), /recommended_id/);
assert.throws(() => createDecision({ question: 'x', candidates: candidates.map(c => ({ ...c, id: 'a' })), recommended_id: 'a' }), /id/);
assert.throws(() => createDecision({ question: 'x', candidates: candidates.map(c => ({ ...c, label: '同一方案' })), recommended_id: 'b', recommendation_reason }), /区别/);
assert.throws(() => validateResponse(q, { decision_id: 'old', selected_id: 'a' }), /过期/);
assert.throws(() => validateResponse(q, { decision_id: q.decision_id, selected_id: 'custom', custom_text: '新方法' }), /理由/);
assert.throws(() => validateResponse(q, { decision_id: q.decision_id, selected_id: 'missing' }), /选项/);
assert.deepEqual(validateClarification(q, { action: 'clarify', decision_id: q.decision_id, question: '为什么不选a？' }), { question: '为什么不选a？' });
assert.throws(() => validateClarification(q, { action: 'clarify', decision_id: 'old', question: '为什么？' }), /过期/);
assert.throws(() => validateClarification(q, { action: 'clarify', decision_id: q.decision_id, question: ' ' }), /问题/);
const answer = validateResponse(q, { decision_id: q.decision_id, selected_id: 'custom', custom_text: '新方法', rationale: '数据分布改变', source: 'system_auto' });
assert.equal(answer.source, undefined);
const custom = decisionRecord(q, answer, 'human');
assert.equal(custom.rationale, '数据分布改变');
assert.equal(custom.source, 'human');
assert.equal(custom.custom_text, '新方法');
const automatic = decisionRecord(q, { selected_id: 'b', rationale: '遵循推荐' }, 'system_auto');
assert.equal(automatic.chosen_option, '方案b');
assert.equal(automatic.basis, '基线实验');
assert.equal(automatic.status, 'auto');
assert.equal(automatic.recommendation_reason, recommendation_reason);
assert.equal(createDecision({ question: '确认？', options: ['是', '否'] }).options.length, 2);
// Exercise the real run loop and ask_user tool without a paid provider call.
let responses = [], providerCalls = 0, lastProviderArgs;
function stub(name, exports) {
  const id = require.resolve('./' + name);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('providers', {
  chatStream: async args => { lastProviderArgs = args; providerCalls++; if (!responses.length) throw new Error('unexpected provider call'); return responses.shift(); },
  keyFor: () => 'offline-placeholder', providerForModel: model => String(model).startsWith('tokenrhythm:') ? 'tokenrhythm' : 'deepseek',
  resolveProvider: pk => pk === 'tokenrhythm' ? ({ name: 'TokenRhythm', kind: 'openai', base: 'https://tokenrhythm.test/v1' }) : ({ name: 'offline', kind: 'openai' }), PROVIDERS: {},
});
stub('skills', { loadSkill: () => { throw new Error('offline'); } });
stub('pricing', { costOf: () => 0 });
stub('external', { dayKey: () => 'offline', saveLedger() {} });
const { classifyDecision, stateBlock, runTurn } = require('./agent');
assert.equal(classifyDecision('不要方案a', ['方案a', '方案b']).rejected_option, '方案a');
assert.match(stateBlock({ decisions: [custom], formulas: [], contract: [] }), /数据分布改变/);
(async () => {
  const session = { pendingQuestion: q, messages: [], status: 'waiting_input' };
  const before = JSON.stringify(session);
  await assert.rejects(runTurn(session, { emit() {} }, { text: '方案a', decision: { decision_id: 'old', selected_id: 'a' } }), /过期/);
  assert.equal(JSON.stringify(session), before, 'stale answer must not mutate session');
  assert.equal(providerCalls, 0);
  const deps = { emit() {}, stopper: { stop: false }, settings: {}, ledger: {}, appDir: __dirname, sandbox: { root: __dirname }, abort: new AbortController(), children: new Set(), persist() {} };
  const makeSession = collab_mode => ({ id: 'decision-test', mode: 'free', model: 'offline', system_provider: 'deepseek', system: 'offline', messages: [], memory: [], usage: {}, decisions: [], collab_mode });
  const ask = { tool_calls: [{ id: 'ask', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '选择路线', candidates, recommended_id: 'b', recommendation_reason }) } }] };
  const automaticSession = makeSession('auto');
  responses = [ask, { content: '【全流程完成】' }];
  await runTurn(automaticSession, deps, { text: '开始' });
  assert.equal(automaticSession.decisions[0].chosen_id, 'b');
  assert.equal(automaticSession.decisions[0].source, 'system_auto');
  assert.match(automaticSession.decisions[0].rationale, /a数据要求更高/);
  const collaborative = makeSession('collab');
  responses = [ask];
  await runTurn(collaborative, deps, { text: '开始' });
  assert.equal(collaborative.status, 'waiting_input');
  assert.equal(collaborative.pendingQuestion.candidates.length, 3);
  const pending = collaborative.pendingQuestion;
  const optionSnapshot = JSON.stringify(pending);
  const decisionsBefore = collaborative.decisions.length;
  const emitted = [];
  const callsBeforeClarify = providerCalls;
  collaborative.data_epoch = 2;
  collaborative.model_specs = [{ id: 'Q1', epoch: 2, spec: { task: { goal: '设计抽样，题面未给固定样本量' }, algorithm: { name: '预定六阶段精确二项' }, givens: [], assumptions: [] } }];
  responses = [{ content: '因为 a 需要题目没有提供的额外数据；目前 b 更易在比赛时间内检验。' }];
  await runTurn(collaborative, { ...deps, emit: ev => emitted.push(ev) }, { action: 'clarify', decision_id: pending.decision_id, question: '为什么不选 a？' });
  assert.equal(providerCalls, callsBeforeClarify + 1, 'one read-only clarification call');
  assert.deepEqual(lastProviderArgs.tools, [], 'clarification cannot execute reads, writes or compute tools');
  assert.equal(lastProviderArgs.maxTokens, 2400, 'allow reasoning plus a complete clarification answer');
  assert.match(lastProviderArgs.messages.map(m => m.content).join('\n'), /题面未给固定样本量/, 'clarification must receive registered task facts');
  assert.match(lastProviderArgs.messages.map(m => m.content).join('\n'), /"current":true/, 'specification currency must be explicit');
  assert(lastProviderArgs.messages.every(m => !m.tool_calls), 'do not replay executable tool calls');
  assert.equal(collaborative.pendingQuestion, pending, 'same pending card must survive clarification');
  assert.equal(JSON.stringify(collaborative.pendingQuestion), optionSnapshot, 'clarification must not mutate options');
  assert.equal(collaborative.decisions.length, decisionsBefore, 'clarification must not adopt a choice');
  assert.equal(collaborative.status, 'waiting_input');
  assert.equal(collaborative.clarifications[0].question, '为什么不选 a？');
  assert(emitted.some(ev => ev.t === 'question' && ev.decision_id === pending.decision_id), 'same decision card must resume');
  // The optional judgment layer also runs for collaborative cards, but only
  // as visible advice; the human card and recommendation remain authoritative.
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, async json() { return { choices: [{ message: { content: '{"choice_id":"b","confidence":0.93,"reason":"协同卡复核一致"}' } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }; } });
  const judgedCollab = makeSession('collab');
  const judgedSettings = { ...deps.settings, decision_judge: { enabled: true, trigger: 'always', provider: 'tokenrhythm', model: 'neohorse-1-9b', min_confidence: 0.82 }, custom_providers: [{ id: 'tokenrhythm', name: 'TokenRhythm', base: 'https://tokenrhythm.test/v1', kind: 'openai', models: ['neohorse-1-9b'] }] };
  responses = [ask];
  await runTurn(judgedCollab, { ...deps, settings: judgedSettings }, { text: '开始' });
  global.fetch = oldFetch;
  assert.equal(judgedCollab.pendingQuestion.judge.disposition.status, 'accepted');
  const callsBeforeStale = providerCalls;
  await assert.rejects(runTurn(collaborative, deps, { action: 'clarify', decision_id: 'stale', question: '为什么？' }), /过期/);
  assert.equal(providerCalls, callsBeforeStale, 'stale clarification rejected before provider call');
  responses = [{ content: '偷偷执行', tool_calls: [{ function: { name: 'fs_write', arguments: '{}' } }] }];
  await runTurn(collaborative, deps, { action: 'clarify', decision_id: pending.decision_id, question: '帮我试试' });
  assert.equal(collaborative.clarifications.length, 1, 'tool response rejected without recording a successful explanation');
  assert.equal(collaborative.pendingQuestion, pending);
  assert.equal(collaborative.status, 'waiting_input', 'failed clarification must restore card');
  assert.equal(collaborative.decisions.length, decisionsBefore);
  responses = [{ content: '已记录选择' }];
  await runTurn(collaborative, deps, { text: '方案c', decision: { decision_id: collaborative.pendingQuestion.decision_id, selected_id: 'c', rationale: '运行时间更短', source: 'system_auto' } });
  assert.equal(collaborative.decisions[0].source, 'human');
  assert.equal(collaborative.decisions[0].rationale, '运行时间更短');
  const switched = makeSession('auto');
  switched.pendingQuestion = q;
  responses = [{ content: '【全流程完成】' }];
  await runTurn(switched, deps, { text: '方案a', decision: { decision_id: q.decision_id, selected_id: 'a', source: 'human' } });
  assert.equal(switched.decisions[0].chosen_id, 'b', 'auto mode must use server-stored recommendation');
  assert.equal(switched.decisions[0].source, 'system_auto');
  const negative = makeSession('collab');
  negative.pendingQuestion = { question: '选什么？', options: ['方案a', '方案b'] };
  responses = [{ content: '重新评估' }];
  await runTurn(negative, deps, { text: '不要方案a' });
  assert.equal(negative.decisions[0].rejected_option, '方案a');
  assert.equal(negative.decisions[0].chosen_option, null);
  const delegated = makeSession('collab');
  delegated.pendingQuestion = { question: '选什么？', options: ['方案a', '方案b'] };
  responses = [{ content: '自行评估' }];
  await runTurn(delegated, deps, { text: '你决定' });
  assert.equal(delegated.decisions[0].source, 'human_delegated');
  // Background waiting must stop this tool batch without replaying a write,
  // preserving a durable parent checkpoint rather than burning polling calls.
  stub('jobs', { statusJob: id => id === 'job_wait_test' ? { meta: { id, status: 'running', session_id: 'decision-test', project_id: 'project-one' } } : null });
  const waiting = makeSession('auto'); waiting.project_id = 'project-one';
  let savedWait = null;
  responses = [{ tool_calls: [
    { id: 'wait', type: 'function', function: { name: 'job_wait', arguments: '{"ids":["job_wait_test"]}' } },
    { id: 'must-not-write', type: 'function', function: { name: 'fs_write', arguments: '{"path":"must-not-write.txt","text":"unexpected"}' } },
  ] }];
  await runTurn(waiting, { ...deps, persist: s => { savedWait = JSON.parse(JSON.stringify(s)); } }, { text: '等待计算完成' });
  assert.equal(waiting.status, 'waiting_jobs');
  assert.deepEqual(savedWait.job_wait.job_ids, ['job_wait_test']);
  assert.equal(savedWait.job_wait.status, 'waiting');
  assert.match(waiting.messages.find(m => m.tool_call_id === 'must-not-write').content, /未执行/);
  assert.equal(responses.length, 0, 'wait ends the turn without calling the provider again');

  const plainRequest = '请选择 A、B、C 中的一个方案，确认后继续。';
  const plainCollab = makeSession('collab');
  const plainStartCalls = providerCalls;
  responses = [{ content: plainRequest }];
  await runTurn(plainCollab, deps, { text: '开始问题四' });
  assert.equal(providerCalls, plainStartCalls + 1);
  assert.equal(plainCollab.status, 'waiting_input');
  assert.equal(plainCollab.wait_reason.kind, 'decision_text');
  assert.equal(plainCollab.wait_reason.question, plainRequest);
  assert.deepEqual(continuationState(plainCollab), { can_continue: false, reason: 'waiting_for_decision', action: 'answer_decision' });
  const waitingHistory = JSON.stringify(plainCollab.messages);
  const waitingCalls = providerCalls;
  for (let i = 0; i < 60; i++) {
    await runTurn(plainCollab, deps, { text: '请继续推进任务书，直到四个产物全部生成。' });
  }
  assert.equal(providerCalls, waitingCalls, 'repeated vague nudges must not spend provider calls');
  assert.equal(JSON.stringify(plainCollab.messages), waitingHistory, 'repeated nudges must not pollute history');
  assert.equal(plainCollab.status, 'waiting_input');
  responses = [{ content: '已按 A 方案继续执行。' }];
  await runTurn(plainCollab, deps, { text: '选 A' });
  assert.equal(providerCalls, waitingCalls + 1, 'explicit choice resumes exactly once');
  assert.equal(plainCollab.wait_reason, null);
  assert.equal(plainCollab.decisions.at(-1).answer, '选 A');

  const plainAuto = makeSession('auto');
  const autoStartCalls = providerCalls;
  responses = [{ content: plainRequest }, ask, { content: '【全流程完成】' }];
  await runTurn(plainAuto, deps, { text: '开始问题四' });
  assert.equal(providerCalls, autoStartCalls + 3, 'one text repair, a structured choice, then final response');
  assert.equal(plainAuto.decisions[0].chosen_id, 'b');
  assert.equal(plainAuto.decisions[0].source, 'system_auto');
  assert.equal(plainAuto.wait_reason ?? null, null);

  const stubbornAuto = makeSession('auto');
  const stubbornStartCalls = providerCalls;
  responses = [{ content: plainRequest }, { content: '请直接回复 A、B、C 中的一个选项。' }];
  await runTurn(stubbornAuto, deps, { text: '开始问题四' });
  assert.equal(providerCalls, stubbornStartCalls + 2, 'a second text request must stop the auto turn');
  assert.equal(stubbornAuto.status, 'waiting_input');
  assert.equal(stubbornAuto.wait_reason.kind, 'decision_text');

  const resumedAuto = makeSession('auto');
  resumedAuto.pendingQuestion = q;
  responses = [{ content: '【全流程完成】' }];
  await runTurn(resumedAuto, deps, { text: '继续' });
  assert.equal(resumedAuto.decisions[0].chosen_id, 'b', 'server recommendation survives a mode switch');
  assert.equal(resumedAuto.decisions[0].source, 'system_auto');

  const repeatedCardAuto = makeSession('auto');
  const repeatedCardStartCalls = providerCalls;
  responses = [ask, ask, ask];
  await runTurn(repeatedCardAuto, deps, { text: '开始并完成路线决策' });
  assert.equal(providerCalls, repeatedCardStartCalls + 3, 'third same-card request stops the turn');
  assert.equal(repeatedCardAuto.decisions.length, 1, 'same input version must record a decision only once');
  assert.equal(repeatedCardAuto.decisions[0].chosen_id, 'b');
  assert.equal(repeatedCardAuto.last_error?.reason, '模型重复已完成决策');
  assert.deepEqual(continuationState(repeatedCardAuto),
    { can_continue: false, reason: 'blocked', action: 'review_error' });
  const blockedCardCalls = providerCalls;
  const blockedCardHistory = JSON.stringify(repeatedCardAuto.messages);
  for (let i = 0; i < 5; i++) await runTurn(repeatedCardAuto, deps, { text: '继续' });
  assert.equal(providerCalls, blockedCardCalls, 'a blocked card cannot be woken by a vague nudge');
  assert.equal(JSON.stringify(repeatedCardAuto.messages), blockedCardHistory);
  assert.equal(repeatedCardAuto.last_error?.reason, '模型重复已完成决策');
  console.log('decision contracts: passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
