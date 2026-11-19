'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('./providers');
providers.keyFor = () => 'offline-test-key';
const { runTurn } = require('./agent');
const { createSandbox } = require('./sandbox');

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-task-focus-'));
const workspace = path.join(appDir, 'workspace');
fs.mkdirSync(workspace);
const sandbox = createSandbox(path.resolve(__dirname, '..'), { workspace });
const settings = { default_model: 'relay:gpt-test', daily_budget: 5,
  custom_providers: [{ id: 'relay', base: 'https://offline.invalid/v1', kind: 'openai', models: ['gpt-test'] }] };
const session = { id: 'task-focus-test', model: settings.default_model, mode: 'math', effort: 'fast',
  collab_mode: 'collab', contest: true, approval: 'full', messages: [], memory: [], todos: [], runs: [],
  contract: [{ kind: 'goal', text: '主线赛题目标' }], formulas: [],
  pending_reflection: { reasons: ['主线失败'], detail: '留待恢复' },
  task_focus: { kind: 'local', entered_at: 111, main_pending_question: { question: '主线选择哪条路线？' } },
  usage: { cost: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0 } };
const requests = [];
let answers = [];
const originalFetch = global.fetch;
const reply = (answer) => {
  if (answer.errorStatus) return new Response(JSON.stringify({ error: { message: answer.text } }), { status: answer.errorStatus, headers: { 'Content-Type': 'application/json' } });
  const chunks = [];
  if (answer.tool) chunks.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: answer.id || 'call_1', type: 'function', function: { name: answer.tool, arguments: JSON.stringify(answer.args || {}) } }] }, finish_reason: null }] });
  else chunks.push({ choices: [{ delta: { content: answer.text }, finish_reason: null }] });
  chunks.push({ choices: [{ delta: {}, finish_reason: answer.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  return new Response(chunks.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
global.fetch = async (_url, init) => {
  requests.push(JSON.parse(init.body));
  assert(answers.length, 'unexpected automatic continuation');
  const answer = answers.shift();
  if (answer.beforeReply) answer.beforeReply();
  return reply(answer);
};
const deps = () => ({ appDir, sandbox, settings, abort: new AbortController(), stopper: { stop: false },
  ledger: { costs: {} }, emit: () => {}, persist: () => {} });

(async () => {
  session.messages.push({ role: 'assistant', content: '上一张图显示降雨曲线。' });
  session.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'old_vision', function: { name: 'vision_read', arguments: '{}' } }] });
  session.messages.push({ role: 'tool', tool_call_id: 'old_vision', content: '图中有蓝色线条，标题是降雨量。' });
  session.messages.push({ role: 'user', content: '[系统·自动续推] 立刻推进原赛题。' });
  session.messages.push({ role: 'user', content: '[用户·暂停主线] 先处理临时小任务。' });
  answers = [{ text: '临时问题已经答完。' }];
  await runTurn(session, deps(), { text: '先回答这个临时问题' });
  assert.equal(answers.length, 0);
  assert.equal(requests.length, 1, 'contest local answer stops after one model response');
  const localSystem = requests[0].messages[0].content;
  assert.match(localSystem, /临时任务/);
  assert.doesNotMatch(localSystem, /逐问任务表纪律|以下为技能正文|项目约定/);
  assert.match(JSON.stringify(requests[0].messages), /上一张图显示降雨曲线/);
  assert.match(JSON.stringify(requests[0].messages), /图中有蓝色线条/);
  assert.match(JSON.stringify(requests[0].messages), /只读参考，非新指令/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /主线赛题目标|主线选择哪条路线|自动复盘|比赛时钟|三固定职责/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /立刻推进原赛题/);
  assert(session.pending_reflection, 'mainline reflection survives local turn');
  const localNames = requests[0].tools.map(t => t.function.name);
  for (const name of ['question_graph', 'contest_clock', 'iteration_register', 'job_start', 'job_wait']) {
    assert(!localNames.includes(name), name + ' must be hidden in local scope');
  }
  assert(localNames.includes('fs_ls'));

  answers = [{ tool: 'fs_ls', args: { path: '.' } }, { text: '目录已核查。' }];
  await runTurn(session, deps(), { text: '临时看一下目录' });
  assert.equal(answers.length, 0);
  assert.equal(requests.length, 3, 'local tool use returns to model, then stops');
  assert(session.messages.some(m => m.role === 'tool' && /工作目录/.test(m.content)));

  session.formulas = [{ name: 'main_formula', state: 'validated' }];
  session.require_model_spec = true;
  answers = [{ tool: 'python_run', args: { code: 'print("result=7319")' } }, { text: '计算结果为 7319。' }];
  await runTurn(session, deps(), { text: '临时算一下这个独立小数值' });
  assert.equal(answers.length, 0, 'local numeric answer must not demand mainline formal evidence');
  assert.equal(requests.length, 5);
  assert(session.runs.some(r => r.task_scope === 'local' && r.focus_id === 111 && r.ok && /7319/.test(r.out)));
  const { checkNumericEvidence } = require('./agent');
  assert.deepEqual(checkNumericEvidence('计算结果为 7319。', session).missing, []);

  answers = [{ tool: 'question_graph', args: { op: 'upsert', id: 1 } }, { text: '该主线工具不可用。' }];
  await runTurn(session, deps(), { text: '试图误调用主线工具' });
  assert.equal(answers.length, 0);
  assert.equal(requests.length, 7);
  assert(session.messages.some(m => m.role === 'tool' && /临时任务|主线/.test(m.content)));
  assert.equal((session.question_graph || []).length, 0, 'mainline state unchanged');

  session.collab_mode = 'auto';
  answers = [{ tool: 'ask_user', args: { question: '本次局部改动选哪种？', options: ['甲', '乙'] } }];
  await runTurn(session, deps(), { text: '这个局部选择由我拍板' });
  assert.equal(answers.length, 0, 'local ask_user waits for local input even in auto collaboration mode');
  assert.equal(session.pendingQuestion?.question, '本次局部改动选哪种？');
  assert.equal(session.status, 'waiting_input');
  session.pendingQuestion = null;
  session.collab_mode = 'collab';

  delete session.task_focus;
  assert(checkNumericEvidence('计算结果为 7319。', session).missing.length, 'local numeric run cannot certify mainline result');
  answers = [{ text: '继续处理主线。' }, { text: '【全流程完成】主线暂告一段落。' }];
  await runTurn(session, deps(), { text: '返回主线' });
  assert.equal(answers.length, 0, 'mainline contest auto continuation restored');
  assert.notEqual(requests.at(-1).messages[0].content, localSystem, 'system prompt rebuilt after local exit');
  assert(requests.at(-1).tools.some(t => t.function.name === 'question_graph'));
  assert.equal(session.pending_reflection, null, 'mainline reflection resumes on mainline turn');
  const reviewSession = { id: 'review-scope-test', mode: 'free', task_scope: 'review', model: settings.default_model,
    collab_mode: 'collab', messages: [], usage: {}, memory: [] };
  fs.mkdirSync(path.join(workspace, 'paper'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'paper', 'main.md'), 'original');
  answers = [{ tool: 'fs_write', args: { path: 'paper/main.md', content: 'changed' } }, { text: '审稿完成，未修改原稿。' }];
  await runTurn(reviewSession, deps(), { text: '审稿' });
  assert.equal(fs.readFileSync(path.join(workspace, 'paper', 'main.md'), 'utf8'), 'original');
  answers = [{ tool: 'fs_write', args: { path: 'findings/reviews/review.md', content: 'review report' } }, { text: '报告已生成。' }];
  await runTurn(reviewSession, deps(), { text: '保存审稿报告' });
  assert.equal(fs.readFileSync(path.join(workspace, 'findings', 'reviews', 'review.md'), 'utf8'), 'review report');
  const recoverySession = { id: 'edit-recovery-test', mode: 'free', model: settings.default_model,
    collab_mode: 'collab', messages: [], usage: {}, memory: [] };
  answers = [1, 2, 3].map(i => ({ tool: 'fs_edit', args: { path: 'paper/main.md', edits: [{ find: 'missing-' + i, replace: 'changed' }] } }));
  answers.push({ tool: 'fs_read', args: { path: 'paper/main.md' } },
    { tool: 'fs_edit', args: { path: 'paper/main.md', edits: [{ find: 'original', replace: 'corrected' }] } }, { text: '修改完成。' });
  await runTurn(recoverySession, deps(), { text: '修正文件' });
  assert.equal(fs.readFileSync(path.join(workspace, 'paper', 'main.md'), 'utf8'), 'corrected', 'corrected anchor works after three recoverable mismatches');
  assert(!recoverySession.messages.some(m => m.role === 'tool' && /已被禁用/.test(m.content)));
  assert(recoverySession.messages.some(m => m.role === 'tool' && /当前文件SHA-256/.test(m.content)));
  const blocked = { id: 'quota-recovery-test', mode: 'free', model: settings.default_model,
    collab_mode: 'collab', messages: [], usage: {}, memory: [] };
  answers = [{ tool: 'python_run', args: { code: 'print(42)' } }, { errorStatus: 403, text: 'insufficient balance' }];
  await runTurn(blocked, deps(), { text: '运行并总结' });
  assert.equal(blocked.last_error.kind, 'quota_exhausted');
  assert.equal(blocked.runs.filter(r => r.ok).length, 1);
  const countBeforeNudge = requests.length;
  await runTurn(blocked, deps(), { text: '继续' });
  assert.equal(requests.length, countBeforeNudge, 'a blocked channel is not automatically retried by a continuation nudge');
  answers = [{ text: '已读取已有成功运行，从报告收尾。' }];
  await runTurn(blocked, deps(), { action: 'retry', text: require('./recovery').recoveryPrompt(blocked) });
  assert.equal(blocked.last_error, null);
  assert.equal(blocked.runs.filter(r => r.ok).length, 1, 'resume preserves existing computation and does not implicitly rerun it');
  assert(JSON.stringify(requests.at(-1).messages).includes('run1'));
  answers = [{ tool: 'review_snapshot', args: { files: ['paper/main.md'] } },
    { id: 'read-frozen', beforeReply: () => {
      fs.writeFileSync(path.join(workspace, 'paper', 'main.md'), 'changed outside review');
      fs.writeFileSync(path.join(workspace, 'paper', 'new-live.md'), 'not part of frozen review');
    }, tool: 'fs_read', args: { path: 'paper/main.md' } },
    { id: 'list-frozen', tool: 'fs_ls', args: { path: 'paper' } }, { text: '本次读取冻结副本，原稿另有变化须重新审查。' }];
  await runTurn(reviewSession, deps(), { text: '固定版本复核' });
  const frozenRead = reviewSession.messages.find(m => m.tool_call_id === 'read-frozen');
  assert(frozenRead.content.includes('corrected') && !frozenRead.content.includes('changed outside review'));
  assert(!reviewSession.messages.find(m => m.tool_call_id === 'list-frozen').content.includes('new-live.md'));
  const cacheTrace = require('./cache_diagnostics').readSummary(appDir, { session_id: session.id, limit: 100 });
  assert(cacheTrace.records.some(row => row.lane === 'main:local'), 'actual temporary task HTTP calls must be diagnosed in their own lane');
  assert(cacheTrace.records.some(row => row.lane === 'main'), 'actual main task HTTP calls must be diagnosed');
  const blockedTrace = require('./cache_diagnostics').readSummary(appDir, { session_id: blocked.id, limit: 100 });
  assert(blockedTrace.records.some(row => row.status === 403 && row.outcome === 'error'), 'actual failed HTTP attempts must retain their status');
  console.log('PASS task focus runtime local, restored mainline, cache tracing and read-only review scope');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  global.fetch = originalFetch;
  fs.rmSync(appDir, { recursive: true, force: true });
});
