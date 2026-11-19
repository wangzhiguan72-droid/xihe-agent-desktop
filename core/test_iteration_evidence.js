'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { executeTool } = require('./tools');
const { Sandbox } = require('./sandbox');
const { registerSpec, specBinding } = require('./model_spec');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-iteration-'));
const comparison = { question_id: 1, dataset: 'orders:v1:east=0.65', protocol: '同时间矩阵，按订单量加权', unit: 'min', direction: 'min' };
const evaluation = { kind: 'quantitative', comparison, measurement_key: 'mean_minutes', min_improvement: 1, inputs: ['orders.csv'], evaluator: 'evaluate.py' };
const independence = '手算两区加权平均；共用题给时间矩阵；排除程序加权错误；仍依赖订单比例准确。';
let count = 0;
async function context(ev = evaluation) {
  const workspace = path.join(root, String(++count)); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'orders.csv'), 'area,A,B,weight\neast,4,10,0.65\nwest,14,6,0.35\n');
  fs.writeFileSync(path.join(workspace, 'evaluate.py'), '# fixed evaluation protocol v1\n');
  const ctx = { workspace, sandbox: new Sandbox(workspace), session: { data_epoch: 0,
    assumptions: [{ id: 'A1', kind: 'model_simplification', status: 'open' }], runs: [],
    question_graph: [{ id: 1, status: 'committed' }, { id: 2, status: 'committed', deps: [1] }] } };
  registerSpec(ctx.session, { question_id: 1, task: { prompt_ref: 'fixture', goal: '比较A/B', output: '指标' }, model_type: 'evaluation',
    givens: [{ statement: '同一时间矩阵', source: 'orders.csv' }], assumptions: [],
    variables: [{ symbol: 's', meaning: '方案', unit: '无', domain: 'A/B' }],
    formulation: [{ expression: 'score(s)', meaning: '固定评测' }], data: [{ name: '订单', source: 'orders.csv', fields: 'weight', treatment: '不变' }], parameters: [],
    algorithm: { name: '固定评价', inputs: '两方案', outputs: '指标', steps: ['读取', '比较'], stopping: '两方案结束' },
    validation: [{ method: '手算', criterion: '一致', evidence: 'fixture' }], interfaces: { receives: '数据', supplies: '指标' }, deliverables: ['JSON'] });
  await executeTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '更换站点',
    criterion: { success: '同口径平均送达至少改善1分钟', ...(ev ? { evaluation: ev } : {}) } });
  return ctx;
}
function run(ctx, id, value, scope = comparison, extra = {}) {
  const ev = ctx.session.iterations[0].criterion.evaluation;
  const files = ev && ev.inputs ? Object.fromEntries([...ev.inputs, ev.evaluator].map(row => [row.rel, row.sha256])) : {};
  ctx.session.runs.push({ run_id: id, t: ctx.session.iterations[0].planned_at + 1,
    ok: true, formal: true, epoch: 0, model_spec: specBinding(ctx.session, { question_id: 1 }),
    out: JSON.stringify({ mean_minutes: value, comparison: scope, evaluation_files: files }), ...extra });
}
const result = ctx => executeTool(ctx, 'iteration', { op: 'result', id: 'I1', run_id: 'candidate', control_run_id: 'baseline', verdict: 'supported', independence });
const adopt = ctx => executeTool(ctx, 'iteration', { op: 'adopt', id: 'I1', independence, impact_questions: [1, 2] });
async function denied(ctx) {
  const before = JSON.stringify({ epoch: ctx.session.data_epoch, graph: ctx.session.question_graph, assumptions: ctx.session.assumptions });
  await assert.rejects(() => adopt(ctx));
  assert.equal(JSON.stringify({ epoch: ctx.session.data_epoch, graph: ctx.session.question_graph, assumptions: ctx.session.assumptions }), before);
  assert.notEqual(ctx.session.iterations[0].status, 'adopted');
}
(async () => {
  const empty = await context(null);
  const recorded = await executeTool(empty, 'iteration', { op: 'result', id: 'I1', verdict: 'supported', independence });
  assert.equal(empty.session.iterations[0].status, 'undecided', recorded.data);
  assert.match(recorded.data, /未决|待验证/);
  await denied(empty);

  const good = await context(); run(good, 'candidate', 7.5); run(good, 'baseline', 8.6);
  await result(good); await adopt(good);
  assert.equal(good.session.iterations[0].status, 'adopted');
  assert.equal(good.session.data_epoch, 1);
  assert(good.session.question_graph.every(q => q.status === 'reviewing'));
  assert(Math.abs(good.session.iterations[0].result.evidence.improvement - 1.1) < 1e-12);
  await assert.rejects(() => adopt(good));

  for (const [label, value, scope, extra] of [
    ['loses', 9, comparison, {}], ['ties', 8.6, comparison, {}], ['below threshold', 8, comparison, {}],
    ['different split', 7, { ...comparison, dataset: 'another split' }, {}],
    ['different protocol', 7, { ...comparison, protocol: 'unweighted' }, {}],
    ['different unit', 7, { ...comparison, unit: 's' }, {}],
    ['different question', 7, { ...comparison, question_id: 2 }, {}],
    ['different direction', 7, { ...comparison, direction: 'max' }, {}],
    ['failed', 7, comparison, { ok: false }], ['exploratory', 7, comparison, { formal: false }],
    ['stale', 7, comparison, { epoch: 9 }], ['unstable', 7, comparison, { unstable: true, unstable_files: ['data.csv'] }],
    ['unverifiable unstable', 7, comparison, { unstable: true }],
    ['old candidate', 7, comparison, { t: 1 }], ['missing scope', 7, comparison, { out: '{"mean_minutes":7}' }],
    ['ambiguous', 7, comparison, { out: '{"mean_minutes":7}\n{"mean_minutes":8}' }],
    ['local task', 7, comparison, { task_scope: 'local' }],
    ['unbound question', 7, comparison, { model_spec: null }],
  ]) {
    const ctx = await context(); run(ctx, 'candidate', value, scope, extra); run(ctx, 'baseline', 8.6);
    await result(ctx); await denied(ctx);
    assert.equal(ctx.session.iterations[0].status, 'undecided', label);
  }
  for (const mutate of [
    ctx => { ctx.session.data_epoch++; },
    ctx => { ctx.session.runs[0].out = '{"mean_minutes":0}'; },
    ctx => { ctx.session.runs[1].ok = false; },
    ctx => { ctx.session.runs[1].formal = false; },
    ctx => { ctx.session.runs[1].unstable = true; ctx.session.runs[1].unstable_files = ['data.csv']; },
    ctx => { ctx.session.runs[1].model_spec = { id: 'Q2' }; },
    ctx => { fs.appendFileSync(path.join(ctx.workspace, 'orders.csv'), 'changed split'); },
    ctx => { fs.appendFileSync(path.join(ctx.workspace, 'evaluate.py'), '# changed evaluator'); },
  ]) {
    const ctx = await context(); run(ctx, 'candidate', 7.5); run(ctx, 'baseline', 8.6);
    await result(ctx); mutate(ctx); await denied(ctx);
  }
  const legacy = await context(null); run(legacy, 'candidate', 7.5); run(legacy, 'baseline', 8.6);
  legacy.session.iterations[0].status = 'ran';
  legacy.session.iterations[0].result = { verdict: 'supported', run_id: 'candidate', control_run_id: 'baseline', independence };
  await denied(legacy);

  // Failed evidence can be repaired on the same candidate, keeping the preregistered criterion.
  const repair = await context(); run(repair, 'candidate', 9); run(repair, 'baseline', 8.6);
  await result(repair); await denied(repair);
  const corrected = JSON.parse(repair.session.runs[0].out); corrected.mean_minutes = 7.5;
  repair.session.runs[0].out = JSON.stringify(corrected);
  await result(repair);
  await executeTool(repair, 'iteration', { op: 'adopt', id: 'I1', independence, impact_questions: [2] });
  assert.deepEqual(repair.session.iterations[0].impact_questions.sort(), [1, 2]);
  assert(repair.session.question_graph.every(q => q.status === 'reviewing'));

  const self = await context(); run(self, 'candidate', 7.5);
  await executeTool(self, 'iteration', { op: 'result', id: 'I1', run_id: 'candidate', control_run_id: 'candidate', verdict: 'supported', independence });
  await denied(self);

  const noSpec = await context(); run(noSpec, 'candidate', 7.5); run(noSpec, 'baseline', 8.6);
  delete noSpec.session.model_specs;
  await result(noSpec); await denied(noSpec);
  assert.equal(noSpec.session.iterations[0].status, 'undecided');

  const maxScope = { ...comparison, direction: 'max', unit: '比例' };
  const max = await context({ ...evaluation, comparison: maxScope, measurement_key: 'Accuracy', min_improvement: 0.05 });
  run(max, 'candidate', 0, maxScope);
  run(max, 'baseline', 0, maxScope);
  for (const [i, value] of [0.9, 0.8].entries()) {
    const output = JSON.parse(max.session.runs[i].out); output.Accuracy = value;
    max.session.runs[i].out = JSON.stringify(output);
  }
  await result(max); await adopt(max);
  assert.equal(max.session.iterations[0].status, 'adopted');

  // A real computation still cannot promote evidence registered only after seeing it.
  const late = await context(); run(late, 'candidate', 7.5); run(late, 'baseline', 8.6);
  late.session.iterations[0].planned_run_ids = ['candidate'];
  await result(late); await denied(late);
  console.log('PASS iteration evidence: empty, real gain, threshold, scope, formal, freshness, mutation, legacy, max, preregistration');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
