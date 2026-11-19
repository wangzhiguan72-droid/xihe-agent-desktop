'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256 } = require('./support_integrity');
const { compareMetric, verificationBlockers } = require('./independent_verification');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-independent-'));
const put = (rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { rel, sha256: sha256(file) };
};
const context = (value, denominator = '同一批事件') => ({ value, unit: '比例', definition: '覆盖率', denominator, time_origin: '起报时刻' });
try {
  const paper = put('paper/main.tex', '最终论文 v1');
  const script = { ...put('independent/solve.py', 'print(0.905)'), kind: 'script' };
  const sourceResult = put('outputs/main.json', '{"coverage":0.905,"volume":35.42,"zero":0}');
  const result = { ...put('independent/result.json', '{"coverage":0.9049,"volume":22.82,"zero":0.01}'), kind: 'result' };
  const metric = { id: 'coverage', source: context(0.905), replica: context(0.9049),
    tolerance: { absolute: 0.001 }, classification: 'match' };
  const state = { paper, source_result: sourceResult, files: [script, result], provenance: { independent_implementation: true,
    target_answer_blind: true, execution: { status: 'succeeded', exit_code: 0,
      script_rel: script.rel, result_rel: result.rel } }, metrics: [metric] };
  const session = { independent_verification: state,
    paper_audit: { tex_path: paper.rel, tex_sha256: paper.sha256 } };
  assert.deepEqual(verificationBlockers(root, {}), []);
  assert.deepEqual(verificationBlockers(root, session), []);
  assert.equal(compareMetric({ ...metric, source: { ...metric.source, unit: '' } }).invalid, true);
  state.files.push(null);
  assert.match(verificationBlockers(root, session).join('；'), /缺相对路径/);
  state.files.pop();

  const wrongDenominator = { ...metric, replica: context(0.9049, '有厚度像元') };
  assert.equal(compareMetric(wrongDenominator).comparable, false);
  state.metrics = [wrongDenominator];
  assert.match(verificationBlockers(root, session).join('；'), /须分类/);
  wrongDenominator.classification = 'scope_difference';
  wrongDenominator.resolution = { status: 'resolved', reason: '分母定义不同，本文已单列两种覆盖比例', paper_sha256: paper.sha256 };
  assert.deepEqual(verificationBlockers(root, session), []);

  const volume = { id: 'volume', source: { ...context(35.42), unit: 'Mm³', definition: '源区体积' },
    replica: { ...context(22.82), unit: 'Mm³', definition: '源区体积' },
    tolerance: { relative: 0.35 }, classification: 'match' };
  const ratio = compareMetric(volume);
  assert.equal(ratio.comparable, true);
  assert.equal(ratio.match, false, '36% 分歧不能落在 ±35% 容差内');
  assert(ratio.relDiff > 0.35);
  const count = { id: 'negative_count', value_type: 'count', source: context(336), replica: context(252), tolerance: { relative: 1 } };
  assert.equal(compareMetric(count).match, false, 'integer counts cannot be forced to agree by tolerance');
  assert.equal(compareMetric(count).relDiff, 0.25);
  const differentProtocol = { ...metric, source: { ...metric.source, protocol: '按灾害年份' }, replica: { ...metric.replica, protocol: '按影像批次' } };
  assert.equal(compareMetric(differentProtocol).comparable, false);
  state.metrics = [volume];
  assert.match(verificationBlockers(root, session).join('；'), /超出容差/);
  volume.replica.definition = '冰厚栅格多边形积分';
  volume.source.definition = '事件重建';
  volume.classification = 'scope_difference';
  volume.resolution = { status: 'resolved', reason: '两种体积计算口径不同且已在当前稿件分别披露', paper_sha256: paper.sha256 };
  assert.deepEqual(verificationBlockers(root, session), []);

  state.metrics = [metric];
  const zero = { ...metric, id: 'zero', source: context(0), replica: context(0.01), tolerance: { relative: 0.1 } };
  assert.equal(compareMetric(zero).match, false);
  zero.tolerance = { absolute: 0.02 };
  assert.equal(compareMetric(zero).match, true);
  state.metrics = [zero];
  assert.deepEqual(verificationBlockers(root, session), []);

  state.provenance.execution = { status: 'reviewed', exit_code: 0, script_rel: script.rel, result_rel: result.rel };
  assert.match(verificationBlockers(root, session).join('；'), /审阅回执不能代替/);
  state.provenance.execution.status = 'succeeded';
  state.provenance.execution.exit_code = 429;
  assert.match(verificationBlockers(root, session).join('；'), /审阅回执不能代替/);
  state.provenance.execution.exit_code = 0;

  fs.writeFileSync(path.join(root, result.rel), '{"coverage":0.9,"volume":22.82,"zero":0.01}');
  assert.match(verificationBlockers(root, session).join('；'), /哈希不符/);
  result.sha256 = sha256(path.join(root, result.rel));
  state.metrics = [metric];
  assert.match(verificationBlockers(root, session).join('；'), /登记值与机器结果/,
    '更新文件哈希也不能让旧登记数值通过');
  fs.writeFileSync(path.join(root, result.rel), '{"coverage":0.9049,"volume":22.82,"zero":0.01}');
  result.sha256 = sha256(path.join(root, result.rel));
  state.paper = put('unrelated.tex', '无关论文');
  assert.match(verificationBlockers(root, session).join('；'), /不是当前论文审计版本/);
  state.paper = paper;
  fs.writeFileSync(path.join(root, paper.rel), '最终论文 v2');
  assert.match(verificationBlockers(root, session).join('；'), /目标论文.*哈希不符/);
  console.log('independent verification: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
