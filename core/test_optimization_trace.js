'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { registerSpec, specBinding, validateSpec } = require('./model_spec');
const { stampInputFiles, inputStampHash } = require('./agent');
const { executeTool, questionTypeChecks } = require('./tools');
const { Sandbox } = require('./sandbox');
const trace = require('./claim_trace'), optimization = require('./optimization_trace');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-opt-trace-'));
const put = (rel, data) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, data); };
const check = { direction: 'min', variables: [{ name: 'x', domain: { kind: 'finite', values: [0, 1, 2] } }],
  objective: { terms: [{ coefficient: 1, powers: { x: 1 } }] }, constraints: [{ polynomial: { terms: [{ coefficient: 1, powers: { x: 1 } }] }, sense: 'ge', rhs: 1 }] };
const spec = { question_id: 1, model_type: 'optimization', task: { prompt_ref: 'data/problem.json', goal: 'min x', output: 'x and objective' },
  givens: [{ statement: 'x in {0,1,2}; x>=1', source: 'fixture' }], assumptions: [], variables: [{ symbol: 'x', meaning: 'decision', unit: 'none', domain: '{0,1,2}' }],
  formulation: [{ expression: 'min x subject to x>=1', meaning: 'registered model' }], data: [{ name: 'domain', source: 'fixture', fields: 'x', treatment: 'none' }], parameters: [],
  algorithm: { name: 'enumeration', inputs: 'domain', steps: ['enumerate'], outputs: 'solution', stopping: 'all points' },
  validation: [{ method: 'host enumeration', criterion: 'feasible and optimal', evidence: 'result' }], interfaces: { receives: 'domain', supplies: 'result' }, deliverables: ['outputs/result.json'],
  optimization: { objective: 'min x', constraints: 'x>=1', decision_domain: '{0,1,2}', check } };
const session = { mode: 'code', data_epoch: 0, require_model_spec: true,
  question_graph: [{ id: 1, status: 'drafting', experiments: ['run1'], artifacts: [{ path: 'outputs/result.json', kind: 'result' }] }] };
const ctx = { workspace: root, session, sandbox: new Sandbox(root), settings: {} };
const setResult = result => {
  put('outputs/result.json', JSON.stringify({ optimization: result }));
  const bytes = fs.readFileSync(path.join(root, 'outputs/result.json'));
  session.runs = [{ run_id: 'run1', tool: 'python_run', ok: true, formal: true, unstable: false, epoch: session.data_epoch,
    out: 'feasible:false; optimal=true', input_hash: inputStampHash(stampInputFiles(root)), model_spec: specBinding(session, { question_id: 1 }),
    result_artifacts: { files: [{ path: 'outputs/result.json', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] } }];
};
const statement = { id: 'opt', question_id: 1, run_id: 'run1', source: { path: 'outputs/result.json', field: 'optimization.objective', unit: 'none' },
  text: '候选集合内最优值为2', scope: '已登记候选集合内最优', displayed_value: 2, decimals: 0, optimality: { level: 'candidates' } };
(async () => {
  put('data/problem.json', '{}');
  assert(registerSpec(session, spec).ok);
  assert.equal(validateSpec({ ...spec, optimization: { ...spec.optimization, check: { ...check, direction: 'invalid' } } }).ok, false);
  setResult({ level: 'feasible', solution: { x: 0 }, objective: 0 });
  await assert.rejects(executeTool(ctx, 'optimization_check', { op: 'check', question_id: 1, run_id: 'run1', path: 'outputs/result.json' }), /约束/);
  assert.match(questionTypeChecks(session, session.question_graph[0], root).join(' '), /结构化/,
    'an optimization model cannot bypass the gate by omitting q.type');
  setResult({ level: 'candidates', solution: { x: 2 }, objective: 2,
    candidates: [{ point: { x: 0 }, objective: 0 }, { point: { x: 2 }, objective: 2 }] });
  const checked = await executeTool(ctx, 'optimization_check', { op: 'check', question_id: 1, run_id: 'run1', path: 'outputs/result.json' });
  assert(checked.ok, checked.data);
  assert.deepEqual(optimization.blockers(root, session), []);
  assert.equal(trace.register(ctx, statement).claim.optimality.report.level, 'candidates');
  assert.equal(trace.inspect(root, session).status, 'fresh');
  assert.throws(() => trace.register(ctx, { ...statement, text: '有限域最优值为2', optimality: { level: 'finite_domain' } }), /级别/);
  assert.throws(() => trace.register(ctx, { ...statement, text: '候选最优值为2，也是有限域最优', scope: '给定模型' }), /超出/);
  assert.throws(() => trace.register(ctx, { ...statement, text: '全局最优值为2' }), /全局|全域/);
  assert.throws(() => trace.register(ctx, { ...statement, optimality: undefined }), /必须登记/);
  for (const text of ['全题最低成本为2', '最快到达时间为2', 'The best value is 2', 'The lowest cost is 2']) {
    assert.throws(() => trace.register(ctx, { ...statement, text, optimality: undefined }), /必须登记/);
  }
  assert.throws(() => trace.register(ctx, { ...statement, text: '方案目标值为2', scope: '全局最优', optimality: undefined }), /必须登记/);
  assert.throws(() => trace.register(ctx, { ...statement, scope: '适用于所有需求权重、所有站点和全部方案' }), /scope/);
  assert.throws(() => trace.register(ctx, { ...statement, source: { ...statement.source, field: 'other' } }), /字段/);
  assert.throws(() => trace.register(ctx, { ...statement, transform: { kind: 'affine', scale: 1, offset: 0 }, output_unit: 'none' }), /直接绑定/);
  await executeTool(ctx, 'question_graph', { op: 'commit', id: 1 });
  assert.equal(session.question_graph[0].status, 'committed');
  assert.equal(session.data_epoch, 0, 'workflow commit must not stale mathematical evidence');
  assert.equal(optimization.inspect(root, session)[0].status, 'fresh');
  session.optimization_checks[0].report.level = 'finite_domain';
  assert(optimization.blockers(root, session).length, 'saved level tampering is rechecked');
  session.optimization_checks[0].report.level = 'candidates';
  session.claim_trace.claims[0].text = '全局最优值为2';
  assert.equal(trace.inspect(root, session).status, 'stale');
  session.claim_trace.claims[0].text = statement.text;
  assert.equal(trace.inspect(root, session).status, 'fresh');
  session.runs[0].result_artifacts.files = [];
  assert(optimization.blockers(root, session).length, 'stdout alone never backs a mathematical certificate');
  setResult({ level: 'finite_domain', solution: { x: 2 }, objective: 2 });
  await assert.rejects(executeTool(ctx, 'optimization_check', { op: 'check', question_id: 1, run_id: 'run1', path: 'outputs/result.json' }), /更优/);
  setResult({ level: 'finite_domain', solution: { x: 1 }, objective: 1 });
  await executeTool(ctx, 'optimization_check', { op: 'check', question_id: 1, run_id: 'run1', path: 'outputs/result.json' });
  const full = { ...statement, text: '登记有限域内最优值为1', scope: '已登记完整有限域内最优', displayed_value: 1, optimality: { level: 'finite_domain' } };
  trace.register(ctx, full);
  assert.equal(trace.inspect(root, session).status, 'fresh');
  put('data/problem.json', '{"changed":true}');
  assert(optimization.blockers(root, session).length);
  assert.equal(trace.inspect(root, session).status, 'stale');
  put('data/problem.json', '{}');
  session.question_graph[0].experiments = [];
  assert(optimization.blockers(root, session).length, 'unlinked result invalidates certificate');
  session.question_graph[0].experiments = ['run1'];
  const updated = structuredClone(spec); updated.optimization.check.direction = 'max';
  registerSpec(session, updated);
  assert(optimization.blockers(root, session).length, 'objective change requires fresh solve');
  const acceptance = require('./acceptance').sessionAcceptance(root, session);
  assert.notEqual(acceptance.stages.find(s => s.id === 'questions').state, 'passed');
  console.log('optimization_trace tests passed: keywords/false feasibility/scope/receipt/version/commit/acceptance');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
});
