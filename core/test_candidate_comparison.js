'use strict';
const assert = require('assert/strict');
const { executeTool } = require('./tools');
const comparison = { question_id: 1, dataset: '附件1:留出末周:v1', protocol: '同一末周逐日MAE', unit: '件', direction: 'min' };
function context() {
  return { session: { effort: 'deep', data_epoch: 0, runs: [
    { run_id: 'rA', ok: true, formal: true, epoch: 0, ms: 1000, out: '{"MAE":2}', boundary_mode: 'holdout' },
    { run_id: 'rB', ok: true, formal: true, epoch: 0, ms: 2000, out: '{"MAE":3}', boundary_mode: 'holdout' },
  ] } };
}
const result = (ctx, id, run, value, scope = comparison) => executeTool(ctx, 'deep_tree', {
  op: 'result', id, note: '在同一测试集比较', err: { metric: 'MAE', value }, evidence_run_id: run,
  measurement_key: 'MAE', comparison: scope,
});
(async () => {
  const c = context();
  const { readMeasurement } = require('./candidate_comparison');
  assert.throws(() => readMeasurement({ out: 'exit=0\n--- stdout ---\n\n--- stderr ---\n{"MAE":2}' }, 'MAE'), /唯一/);
  assert.equal(readMeasurement({ out: 'exit=0\n--- stdout ---\n{"MAE":2}\n--- stderr ---\n{"MAE":9}' }, 'MAE'), 2);
  assert.throws(() => readMeasurement({ out: 'exit=0\n--- stdout ---\n{"MAE":2}\n…[中间截断 900 字符]…\n--- stderr ---\n' }, 'MAE'), /截断/);
  await assert.rejects(() => executeTool(c, 'deep_tree', { op: 'result', id: 'A', note: '错误指标名',
    err: { metric: 'Accuracy', value: 2 }, evidence_run_id: 'rA', measurement_key: 'MAE', comparison }), /指标名/);
  await assert.rejects(() => result(c, 'A', 'rA', 2, { ...comparison, direction: 'max' }), /方向/);
  await assert.rejects(() => result(c, 'A', 'rA', 0.1), /指标.*不一致/);
  await result(c, 'A', 'rA', 2);
  const ranked = await result(c, 'B', 'rB', 3);
  assert.match(ranked.data, /被 A 支配/);
  c.session.data_epoch++;
  const stale = await executeTool(c, 'deep_tree', { op: 'view' });
  assert.doesNotMatch(stale.data, /被 A 支配/);
  assert.match(stale.data, /失效|旧数据/);

  const notes = context();
  for (const id of ['A', 'B']) {
    const r = await executeTool(notes, 'deep_tree', { op: 'result', id, note: '模型认为自己最好' });
    assert.doesNotMatch(r.data, /可以做结论|已有实测|两个（含）以上候选都有实测/);
    assert.match(r.data, /待验证|未验证/);
  }
  const split = context();
  await result(split, 'A', 'rA', 2);
  const different = await result(split, 'B', 'rB', 3, { ...comparison, dataset: '另一测试集' });
  assert.doesNotMatch(different.data, /被 A 支配/);
  assert.match(different.data, /不足两个/);

  const legacy = context();
  await executeTool(legacy, 'deep_tree', { op: 'result', id: 'A', note: '旧记录', err: { metric: 'MAE', value: 2 }, evidence_run_id: 'rA' });
  const lv = await executeTool(legacy, 'deep_tree', { op: 'view' });
  assert.match(lv.data, /待验证|未验证/);
  assert.doesNotMatch(lv.data, /← 前沿/);

  const incomplete = context();
  await assert.rejects(() => result(incomplete, 'A', 'rA', 2, { ...comparison, protocol: '' }), /protocol/);
  incomplete.session.runs[0].out = '{"MAE":2}\n{"MAE":9}';
  await assert.rejects(() => result(incomplete, 'A', 'rA', 2), /唯一|歧义/);
  incomplete.session.runs[0].out = '{"MAE":"2"}';
  await assert.rejects(() => result(incomplete, 'A', 'rA', 2), /数值/);

  const changed = context();
  await result(changed, 'A', 'rA', 2);
  await result(changed, 'B', 'rB', 3);
  changed.session.runs[0].out = '{"MAE":0}';
  const cv = await executeTool(changed, 'deep_tree', { op: 'view' });
  assert.doesNotMatch(cv.data, /被 A 支配/);
  assert.match(cv.data, /失效|改变/);
  const maximize = context();
  maximize.session.runs[0].out = '{"Accuracy":0.8}';
  maximize.session.runs[1].out = '{"Accuracy":0.9}';
  maximize.session.runs[1].ms = 500;
  const accuracy = (id, run, value) => executeTool(maximize, 'deep_tree', {op: 'result', id, note: '准确率比较',
    err: { metric: 'Accuracy', value }, evidence_run_id: run, measurement_key: 'Accuracy', comparison: { ...comparison, unit: '比例', direction: 'max' } });
  await accuracy('A', 'rA', 0.8);
  const max = await accuracy('B', 'rB', 0.9);
  assert.match(max.data, /被 B 支配/);
  const repeated = context();
  await result(repeated, 'A', 'rA', 2);
  const duplicate = await result(repeated, 'A', 'rB', 3);
  assert.match(duplicate.data, /不足两个/);
  assert.doesNotMatch(duplicate.data, /被 A 支配/);
  // Invalidating the newest measurement must not silently resurrect an older one.
  const latest = context();
  latest.session.runs.push({ ...latest.session.runs[1], run_id: 'rNew' });
  await result(latest, 'A', 'rA', 2);
  await result(latest, 'B', 'rB', 3);
  await result(latest, 'A', 'rNew', 3);
  latest.session.runs[2].ok = false;
  const latestView = await executeTool(latest, 'deep_tree', { op: 'view' });
  assert.doesNotMatch(latestView.data, /被 A 支配/);
  assert.match(latestView.data, /证据失效.*A/);
  console.log('PASS candidate comparison: mismatch, scope, stale, notes, legacy, ambiguous output, mutation');
})().catch(e => { console.error(e); process.exitCode = 1; });
