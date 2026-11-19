'use strict';
// Executes both models through guarded Python and the production run recorder, with current specs.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { executeTool } = require('./tools');
const { recordRun } = require('./agent');
const { registerSpec, specBinding } = require('./model_spec');
const { Sandbox } = require('./sandbox');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-iteration-compute-'));
(async () => {
  const appDir = path.join(root, 'app'); fs.mkdirSync(appDir);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const session = { mode: 'math', require_model_spec: true, data_epoch: 0,
    assumptions: [{ id: 'A1', kind: 'model_simplification', status: 'open' }],
    question_graph: [{ id: 1, status: 'committed' }, { id: 2, deps: [1], status: 'committed' }] };
  const ctx = { workspace, appDir, sandbox: new Sandbox(workspace), session, settings: {}, children: new Set() };
  const spec = { question_id: 1, task: { prompt_ref: '选址例题', goal: '最小化订单加权送达时间', output: '站点与分钟数' }, model_type: 'optimization',
    givens: [{ statement: 'A:4/14；B:10/6；东区65%', source: 'orders.csv' }], assumptions: [],
    variables: [{ symbol: 's', meaning: '选址', unit: '无', domain: '{A,B}' }],
    formulation: [{ expression: 'min_s 0.65*t_e(s)+0.35*t_w(s)', meaning: '订单加权时间' }],
    data: [{ name: '送达时间', source: '题给数据', fields: 'area,A,B,weight', treatment: '不插补' }], parameters: [],
    algorithm: { name: '穷举', inputs: '两站两区时间及权重', steps: ['分别求加权和', '取较小者'], outputs: '平均分钟数', stopping: '两站均计算' },
    validation: [{ method: '独立手算', criterion: 'A=7.5,B=8.6', evidence: '本测试与有理数核查' }],
    interfaces: { receives: '题给数据', supplies: '站点选择' }, deliverables: ['比较JSON'],
    optimization: { objective: '平均时间最小', constraints: '只能选一个站点', decision_domain: '{A,B}' } };
  assert.equal(registerSpec(session, spec).ok, true);
  let comparison = { question_id: 1, dataset: 'orders.csv:east=0.65:v1', protocol: 'mean:同一加权评测脚本穷举两站', unit: 'min', direction: 'min' };
  fs.writeFileSync(path.join(workspace, 'orders.csv'), 'area,A,B,weight\neast,4,10,0.65\nwest,14,6,0.35\n');
  fs.writeFileSync(path.join(workspace, 'comparison.json'), JSON.stringify(comparison));
  fs.writeFileSync(path.join(workspace, 'evaluate.py'), [
    'import csv,json,hashlib', 'from pathlib import Path',
    "rows=list(csv.DictReader(Path('orders.csv').read_text().splitlines()))",
    "scope=json.loads(Path('comparison.json').read_text(encoding='utf-8'))",
    'score=max(float(row[station]) for row in rows) if scope["protocol"].startswith("worst:") else sum(float(row[station])*float(row["weight"]) for row in rows)',
    'key="worst_minutes" if scope["protocol"].startswith("worst:") else "mean_minutes"',
    "files={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in ['orders.csv','comparison.json','evaluate.py']}",
    "print(json.dumps({key:score,'comparison':scope,'evaluation_files':files}))",
  ].join('\n'));
  await executeTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '从B改选A',
    criterion: { success: '同口径至少降低1分钟', evaluation: { kind: 'quantitative', comparison,
      measurement_key: 'mean_minutes', min_improvement: 1, inputs: ['orders.csv', 'comparison.json'], evaluator: 'evaluate.py' } } });
  const ids = [];
  for (const station of ['A', 'B']) {
    const response = await executeTool(ctx, 'python_run', { formal: true, question_id: 1,
      code: `from pathlib import Path\nstation=${JSON.stringify(station)}\nexec(compile(Path('evaluate.py').read_text(encoding='utf-8'), 'evaluate.py', 'exec'))`, result_artifact: true });
    assert.equal(response.ok, true, response.data);
    ids.push(recordRun(session, { tool: 'python_run', ok: response.ok, formal: true, out: response.data, modelSpec: specBinding(session, { question_id: 1 }) }));
  }
  const independence = '另用Fraction手算；共用时间矩阵；可排除加权代码错；不验证订单比例来源。';
  await executeTool(ctx, 'iteration', { op: 'result', id: 'I1', run_id: ids[0], control_run_id: ids[1], verdict: 'supported', independence });
  assert.equal(session.iterations[0].result.evidence.candidate, 7.5);
  assert.equal(session.iterations[0].result.evidence.baseline, 8.6);
  await executeTool(ctx, 'iteration', { op: 'adopt', id: 'I1', impact_questions: [1] });
  assert.equal(session.iterations[0].status, 'adopted');
  assert(session.question_graph.every(q => q.status === 'reviewing'));

  // Change only the objective: the same travel times must now favor B, with actual recomputation.
  comparison = { ...comparison, protocol: 'worst:同一脚本取区域最大时间' };
  fs.writeFileSync(path.join(workspace, 'comparison.json'), JSON.stringify(comparison));
  const worstSpec = structuredClone(spec);
  worstSpec.task.goal = '最小化最慢区域时间';
  worstSpec.formulation = [{ expression: 'min_s max(t_e(s),t_w(s))', meaning: '最坏时间' }];
  worstSpec.optimization.objective = '最坏时间最小';
  worstSpec.validation[0].criterion = 'A=14,B=10';
  registerSpec(session, worstSpec);
  await executeTool(ctx, 'iteration', { op: 'plan', assumption_ids: ['A1'], change: '目标改为最坏时间，候选改选B',
    criterion: { success: '最坏时间降低至少4分钟', evaluation: { kind: 'quantitative', comparison,
      measurement_key: 'worst_minutes', min_improvement: 4, inputs: ['orders.csv', 'comparison.json'], evaluator: 'evaluate.py' } } });
  const newIds = [];
  for (const station of ['B', 'A']) {
    const response = await executeTool(ctx, 'python_run', { formal: true, question_id: 1,
      code: `from pathlib import Path\nstation=${JSON.stringify(station)}\nexec(compile(Path('evaluate.py').read_text(encoding='utf-8'), 'evaluate.py', 'exec'))`, result_artifact: true });
    assert.equal(response.ok, true, response.data);
    newIds.push(recordRun(session, { tool: 'python_run', ok: response.ok, formal: true, out: response.data, modelSpec: specBinding(session, { question_id: 1 }) }));
  }
  await executeTool(ctx, 'iteration', { op: 'result', id: 'I2', run_id: newIds[0], control_run_id: ids[0], verdict: 'supported', independence });
  assert.equal(session.iterations[1].status, 'undecided', 'old mean result must not support a worst-time claim');
  await executeTool(ctx, 'iteration', { op: 'result', id: 'I2', run_id: newIds[0], control_run_id: newIds[1], verdict: 'supported', independence });
  assert.equal(session.iterations[1].result.evidence.candidate, 10);
  assert.equal(session.iterations[1].result.evidence.baseline, 14);
  await executeTool(ctx, 'iteration', { op: 'adopt', id: 'I2' });
  assert.equal(session.iterations[1].status, 'adopted');
  console.log('PASS computed iteration: mean A=7.5/B=8.6 -> worst B=10/A=14, real recomputation, rejects old objective evidence');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('xihe-iteration-compute-'));
  fs.rmSync(root, { recursive: true, force: true });
});
