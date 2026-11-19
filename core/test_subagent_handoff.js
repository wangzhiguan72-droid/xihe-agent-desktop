'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os'); const assert = require('assert');
const root = fs.mkdtempSync(path.join(os.homedir(), '.xihe-subhandoff-'));
const id = require.resolve('./providers'); let requests = [], next;
require.cache[id] = { id, filename: id, loaded: true, exports: {
  chatStream: async opts => { requests.push(opts); if (typeof next === 'function') return next(); return next; }, keyFor: () => 'offline', providerForModel: () => 'offline',
  resolveProvider: () => ({ kind: 'openai', name: 'offline' }), PROVIDERS: {},
} };
const { runSubagent } = require('./agent');
const session = { id: 'parent', effort: 'extreme', role: 'modeler', mode: 'math', usage: {}, runs: [], child_runs: [] };
const ctx = { session, workspace: root, appDir: root, emit() {} };
const deps = { appDir: root, settings: { default_model: 'offline' }, stopper: { stop: false }, abort: new AbortController() };
(async () => {
  next = { content: '结果尚未输出完整', finish: 'length' };
  const partial = await runSubagent(ctx, deps, 'worker', '任务一', { crew: 'coder', taskPrefix: 'p1_', why: '试验一', returnHandoff: true }, () => {});
  assert.equal(partial.status, 'failed'); assert.equal(partial.reason, 'output_truncated');
  next = { content: '完成但未经主脑验收', finish: 'stop' };
  const done = await runSubagent(ctx, deps, 'worker', '任务二', { crew: 'coder', taskPrefix: 'p2_', why: '试验二', returnHandoff: true }, () => {});
  assert.equal(done.status, 'completed'); assert.equal(done.formal, false); assert.equal(done.acceptance, 'pending');
  assert.ok(fs.existsSync(path.join(root, done.archive)));
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content, '同角色动态任务不应改写system前缀');
  assert(!requests[1].messages[0].content.includes('p2_'));
  assert(requests[1].messages.some(m => m.role === 'user' && m.content.includes('p2_')));
  next = { content: '', finish: 'stop' };
  const empty = await runSubagent(ctx, deps, 'worker', '任务三', { returnHandoff: true }, () => {});
  assert.equal(empty.status, 'failed'); assert.equal(empty.reason, 'empty_report');
  // Actual process failure diagnostics must reach the model on its next request.
  const { createSandbox } = require('./sandbox');
  const failureCtx = { ...ctx, sandbox: createSandbox(path.resolve(__dirname, '..'), {workspace:root}), settings:{} };
  let turn = 0;
  next = () => ++turn === 1 ? { content:'', finish:'tool_calls', tool_calls:[{id:'failure',type:'function',function:{name:'python_run',arguments:JSON.stringify({code:'raise ValueError("independent-check-failed")'})}}] }
    : { content:'已看到真实失败，不冒充成功', finish:'stop' };
  await runSubagent(failureCtx, deps, 'worker', '运行失败探针', {crew:'coder'}, () => {});
  const toolMessage = requests.at(-1).messages.find(m => m.role === 'tool');
  assert.match(toolMessage.content, /independent-check-failed/);
  assert.match(session.child_runs.find(r => r.tool === 'python_run' && !r.ok).out, /independent-check-failed/);
  fs.writeFileSync(path.join(root, 'existing.py'), '# previous source');
  turn = 0;
  next = () => ++turn === 1 ? {content:'',finish:'tool_calls',tool_calls:[{id:'changed',type:'function',function:{name:'python_run',arguments:JSON.stringify({code:'open("existing.py", "w").write("# changed source")\nprint(35)',formal:true,result_artifact:true})}}]}
    : {content:'源文件改变，本次结果待复核',finish:'stop'};
  await runSubagent(failureCtx, deps, 'worker', '修改已有脚本的探针', {crew:'coder'}, () => {});
  const changed = session.child_runs.filter(r => r.tool === 'python_run' && r.ok).at(-1);
  assert.equal(changed.unstable, true);
  assert(changed.unstable_files.includes('existing.py'), 'new child modifications must not look like legacy empty unstable marks');
  session.question_graph = [{id:1,experiments:[],deps:[]}];
  await assert.rejects(() => require('./tools').executeTool(failureCtx, 'question_graph', {op:'link_run',id:1,run_id:changed.child_run_id}), /不稳定/);
  next = () => { deps.stopper.stop = true; deps.abort.abort(); throw new Error('aborted'); };
  const cancelled = await runSubagent(ctx, deps, 'worker', '任务四', { returnHandoff: true }, () => {});
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.reason, 'stopped');
  console.log('PASS subagent truncation, empty report, durable handoff, evidence boundary and stable system prefix');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
