'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sandbox } = require('./sandbox');
const { sha256 } = require('./support_integrity');
const { buildComparison, comparisonBlockers } = require('./result_comparison');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-compare-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-compare-outside-'));
const put = (rel, data) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); return rel; };
const scope = (result_key, overrides = {}) => ({ result_key, unit: '个', definition: '设计负样本数', denominator: '84个灾点×相同背景倍率', time_origin: '不适用', dataset: '题给灾点/v1', protocol: '相同抽样协议', ...overrides });
const metric = (overrides = {}) => ({ id: 'background', value_type: 'count', source: scope('counts.negative'), replica: scope('counts.negative'), tolerance: { absolute: 0 }, ...overrides });
const make = (overrides = {}) => ({ purpose: 'replication', source_result: { rel: 'source.json' }, replica_result: { rel: 'replica.json' }, metrics: [metric()], ...overrides });
try {
  put('source.json', { counts: { negative: 336 }, zero: 0, score: 0.863 });
  put('replica.json', { counts: { negative: 252 }, zero: 0.01, score: 0.909 });
  const ctx = { workspace: root, sandbox: new Sandbox(root), session: {} };
  let saved = buildComparison(ctx, make({ metrics: [metric({ tolerance: { relative: 0.3 } })] }), 'findings/comparisons/counts');
  let row = saved.record.metrics[0];
  assert.equal(row.source.value, 336);
  assert.equal(row.replica.value, 252);
  assert.equal(row.absDiff, 84);
  assert.equal(row.relDiff, 0.25);
  assert.equal(row.classification, 'discrepancy', 'count must be exact even when relative tolerance is 30%');
  assert.equal(saved.record.summary.matches, 0);
  assert.deepEqual(comparisonBlockers(root, saved), []);
  assert.throws(() => buildComparison(ctx, make({ source_result: { rel: 'source.json', sha256: '0'.repeat(64) } })), /哈希/);
  assert.equal(buildComparison(ctx, make({ source_result: { rel: 'source.json', sha256: sha256(path.join(root, 'source.json')) } }), 'findings/comparisons/pinned').record.metrics[0].classification, 'discrepancy');

  saved = buildComparison(ctx, make({ metrics: [metric({ replica: scope('counts.negative', { denominator: '84个灾点×3个背景样本' }) })] }), 'findings/comparisons/scope');
  row = saved.record.metrics[0];
  assert.equal(row.classification, 'scope_difference');
  assert.equal(row.relDiff, null, 'different scope must not be numerically ranked');
  assert.equal(saved.record.summary.matches, 0);

  const wrongSplit = metric({ id: 'auc', value_type: 'continuous', source: scope('score', { unit: 'AUC', definition: '空间分块AUC', protocol: '20 km经度分块' }), replica: scope('score', { unit: 'AUC', definition: '空间分块AUC', protocol: '20 km正方形空间块' }), tolerance: { relative: 0.1 } });
  saved = buildComparison(ctx, make({ metrics: [wrongSplit] }), 'findings/comparisons/split');
  assert.equal(saved.record.metrics[0].classification, 'scope_difference');

  const zero = metric({ id: 'zero', value_type: 'continuous', source: scope('zero', { unit: '比例', definition: '零基准检验' }), replica: scope('zero', { unit: '比例', definition: '零基准检验' }), tolerance: { relative: 0.1 } });
  saved = buildComparison(ctx, make({ metrics: [zero] }), 'findings/comparisons/zero');
  assert.equal(saved.record.metrics[0].classification, 'invalid');
  zero.tolerance = { absolute: 0.02 };
  saved = buildComparison(ctx, make({ metrics: [zero] }), 'findings/comparisons/zero_absolute');
  assert.equal(saved.record.metrics[0].classification, 'match');

  saved = buildComparison(ctx, make({ purpose: 'alternative', metrics: [metric()] }), 'findings/comparisons/alternative');
  assert.equal(saved.record.metrics[0].classification, 'alternative_difference');
  assert.equal(saved.record.summary.matches, 0);
  assert.equal(saved.record.summary.alternative_observations, 1);

  for (const candidate of [
    make({ relDiff: 0 }), make({ metrics: [metric({ relDiff: 0 })] }),
    make({ metrics: [metric({ source: { ...scope('counts.negative'), value: 336 } })] }),
    make({ metrics: [metric({ classification: 'match' })] }),
    make({ metrics: [metric(), metric()] }),
    make({ metrics: [metric({ value_type: 'unknown' })] }),
  ]) assert.throws(() => buildComparison(ctx, candidate), /字段|重复|类型/);
  assert.throws(() => buildComparison(ctx, make(), '../bad'), /路径/);
  assert.throws(() => buildComparison(ctx, make({ source_result: { rel: '../outside.json' } })), /越界/);
  const symlink = path.join(root, 'outside-link.json');
  const outsideFile = path.join(outside, 'result.json'); fs.writeFileSync(outsideFile, '{}');
  fs.symlinkSync(outsideFile, symlink, 'file');
  assert.throws(() => buildComparison(ctx, make({ source_result: { rel: 'outside-link.json' } })), /越界/);
  put('too_large.json', { payload: 'x'.repeat(2_000_000) });
  assert.throws(() => buildComparison(ctx, make({ source_result: { rel: 'too_large.json' } })), /2MB/);
  put('fractional.json', { counts: { negative: 336.5 } });
  saved = buildComparison(ctx, make({ replica_result: { rel: 'fractional.json' } }), 'findings/comparisons/fractional');
  assert.equal(saved.record.metrics[0].classification, 'invalid');

  saved = buildComparison(ctx, make(), 'findings/comparisons/changed');
  fs.writeFileSync(path.join(root, 'replica.json'), '{"counts":{"negative":251}}');
  assert.match(comparisonBlockers(root, saved).join('；'), /复算结果|replica|哈希/);
  fs.writeFileSync(path.join(root, 'replica.json'), '{"counts":{"negative":252},"zero":0.01,"score":0.909}');
  saved = buildComparison(ctx, make(), 'findings/comparisons/report_changed');
  fs.appendFileSync(path.join(root, saved.markdown_rel), '\nchanged');
  assert.match(comparisonBlockers(root, saved).join('；'), /报告|哈希/);
  saved = buildComparison(ctx, make(), 'findings/comparisons/json_changed');
  fs.appendFileSync(path.join(root, saved.json_rel), '\n');
  assert.match(comparisonBlockers(root, saved).join('；'), /JSON报告.*哈希/);
  console.log('result comparison: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
