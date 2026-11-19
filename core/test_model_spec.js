'use strict';
const assert = require('assert/strict');
const { registerSpec, validateSpec, specGate, specSummary, specBinding, runSpecBlock } = require('./model_spec');

const spec = {
  question_id: 1,
  task: { prompt_ref: '题目第一问', goal: '估计每日需求', output: '每日需求预测表，单位件' },
  model_type: 'prediction',
  givens: [{ statement: '附件1有历史销量', source: '附件1' }],
  assumptions: [{ statement: '历史趋势短期可延续', rationale: '短期预测基线', check: '留出末周检验' }],
  variables: [{ symbol: 'y_t', meaning: '第t天需求量', unit: '件', domain: '非负整数' }],
  formulation: [{ expression: 'y_t = f(x_t; theta) + epsilon_t', meaning: '输入特征至需求的预测关系' }],
  data: [{ name: '历史销量', source: '附件1', fields: '日期、销量', treatment: '按日汇总' }],
  parameters: [{ symbol: 'theta', value: '由训练集拟合', unit: '随特征单位定义', source: '附件1训练时段估计' }],
  algorithm: { name: '时间序列回归', inputs: '历史日销量', steps: ['时间切分', '拟合参数', '预测'], outputs: '逐日预测', stopping: '拟合收敛或达到迭代上限' },
  validation: [{ method: '末周留出检验', criterion: '与季节基线比较 MAE', evidence: '待正式运行' }],
  interfaces: { receives: '原始附件1', supplies: '问题二的需求预测输入' },
  deliverables: ['每日预测表', '误差对比表'],
};

assert.equal(validateSpec(spec).ok, true);
assert.equal(validateSpec({ ...spec, assumptions: [{ statement: '趋势继续' }] }).ok, false);
assert.equal(validateSpec({ ...spec, variables: [{ symbol: 'y_t', meaning: '需求' }] }).ok, false);
assert.equal(validateSpec({ ...spec, formulation: [] }).ok, false);
assert.equal(validateSpec({ ...spec, validation: [{ method: '模型检验', criterion: '', evidence: '' }] }).ok, false);
assert.equal(validateSpec({ ...spec, model_type: 'optimization' }).ok, false);
assert.equal(validateSpec({ ...spec, model_type: '优化' }).ok, false);
assert.equal(validateSpec({ ...spec, parameters: [{ symbol: 'theta', value: '0.5', unit: '1' }] }).ok, false);
const session = { require_model_spec: true, data_epoch: 0 };
assert.match(specGate(session, { formal: true, question_id: 1 }), /模型规格/);
const first = registerSpec(session, spec);
assert.equal(first.ok, true);
assert.equal(first.record.id, 'Q1');
registerSpec(session, Object.fromEntries(Object.entries(spec).reverse()));
assert.equal(session.data_epoch, 0, 'JSON key ordering must not invalidate evidence');
assert.equal(specGate(session, { formal: true, model_spec_id: 'Q1' }), null);
assert.match(specGate(session, { formal: true, model_spec_id: 'Q1', question_id: 2 }), /不同问题/);
const run = { ok: true, formal: true, model_spec: specBinding(session, { model_spec_id: 'Q1' }) };
assert.equal(runSpecBlock(session, run, 1), null);
assert.match(specGate(session, { formal: true }), /model_spec_id/);
assert.match(specGate(session, { formal: true, model_spec_id: 'Q2' }), /未登记/);
assert.equal(specGate(session, { formal: false }), null);
assert.match(specSummary(session), /Q1/);
session.data_epoch++;
assert.match(specGate(session, { formal: true, model_spec_id: 'Q1' }), /过期/);
assert.match(runSpecBlock(session, run, 1), /旧输入版本/);
const refreshed = registerSpec(session, spec);
assert.equal(refreshed.ok, true);
assert.match(runSpecBlock(session, run, 1), /需重跑/);
assert.equal(specGate(session, { formal: true, model_spec_id: 'Q1' }), null);
const changed = registerSpec(session, { ...spec, task: { ...spec.task, goal: '估计逐周需求' } });
assert.equal(changed.ok, true);
assert.equal(session.data_epoch, 2);
assert.equal(changed.record.version, 2);
const legacy = { data_epoch: 0 };
assert.equal(specGate(legacy, { formal: true }), null);
const isolated = { question_graph: [{ id: 1, status: 'committed', experiments: ['run1'] }, { id: 2, deps: [1], status: 'committed', experiments: ['run2'] }] };
registerSpec(isolated, spec);
spec.task.goal = '外部对象改写不污染登记';
assert.notEqual(isolated.model_specs[0].spec.task.goal, spec.task.goal);
registerSpec(isolated, spec);
assert.equal(isolated.question_graph[0].status, 'drafting');
assert.deepEqual(isolated.question_graph[1].experiments, []);
const { formulaDepsBlock, recordRun } = require('./agent');
assert.match(formulaDepsBlock({ require_model_spec: true }, 'shell_run', { formal: true, question_id: 1 }), /模型规格/);
recordRun(session, { tool: 'python_run', ok: true, formal: true, modelSpec: run.model_spec });
assert.deepEqual(session.runs[0].model_spec, run.model_spec);
const { TOOLS, executeTool } = require('./tools');
assert.ok(TOOLS.find(t => t.name === 'python_run').params.model_spec_id);
assert.ok(TOOLS.find(t => t.name === 'shell_run').params.formal);
const tool = TOOLS.find(t => t.name === 'model_spec');
assert.throws(() => tool.run({ session: {} }, { op: 'register', spec: {} }), /校验失败/);
const strict = { require_model_spec: true, question_graph: [{ id: 1, experiments: [], artifacts: [] }] };
registerSpec(strict, { ...spec, task: { ...spec.task } });
strict.runs = [{ run_id: 'run1', ...run }];
(async () => {
  await assert.rejects(() => TOOLS.find(t => t.name === 'question_graph').run({ session: strict }, { op: 'link_run', id: 1, run_id: 'run1' }), /模型规格/);
  strict.runs[0].model_spec = specBinding(strict, { model_spec_id: 'Q1' });
  const questionTool = TOOLS.find(t => t.name === 'question_graph');
  await questionTool.run({ session: strict }, { op: 'link_run', id: 1, run_id: 'run1' });
  assert.deepEqual(strict.question_graph[0].experiments, ['run1']);
  strict.runs[0].model_spec.hash = 'stale';
  await assert.rejects(() => questionTool.run({ session: strict }, { op: 'commit', id: 1 }), /模型规格/);
  const blocked = await executeTool({ session: { require_model_spec: true } }, 'python_run', { code: 'raise Exception()', formal: true, question_id: 1 });
  assert.equal(blocked.ok, false);
  console.log('model_spec tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
