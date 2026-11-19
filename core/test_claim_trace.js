'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { registerSpec, specBinding } = require('./model_spec');
const { stampInputFiles, inputStampHash } = require('./agent');
const trace = require('./claim_trace');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-claim-trace-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-claim-trace-outside-'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const put = (rel, content) => {
  const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content); return file;
};
const spec = {
  question_id: 1, task: { prompt_ref: '题面 Q1', goal: '最小化平均送达时间', output: '选址和分钟' },
  model_type: 'optimization', givens: [{ statement: '订单占比65%', source: '题面' }], assumptions: [],
  variables: [{ symbol: 'x', meaning: '站点选择', unit: '站', domain: '{A,B}' }],
  formulation: [{ expression: 'min_x E[T(x)]', meaning: '加权平均送达时间' }],
  data: [{ name: '订单和时间', source: '题面', fields: '区域,占比,送达时间', treatment: '按区域权重汇总' }],
  parameters: [], algorithm: { name: '枚举', inputs: '订单占比和时间矩阵', steps: ['分别计算两站平均时间', '选择较小者'], outputs: '选址', stopping: '两候选均完成' },
  validation: [{ method: '人工分数复核', criterion: '与枚举相同', evidence: '结果 JSON' }],
  interfaces: { receives: '题面矩阵', supplies: '图和摘要' }, deliverables: ['选址结论'],
  optimization: { objective: '平均送达时间最小', constraints: '只能选一个站', decision_domain: 'A 或 B' },
};
try {
  put('data/input.json', JSON.stringify({ east_share: 0.65 }));
  const result = put('outputs/result.json', JSON.stringify({ mean: { A: 7.5, B: 8.6 }, series: [7.5, 8.6] }));
  const figure = put('figures/mean.svg', '<svg><text>A 7.5 分钟</text></svg>');
  const paper = put('paper/main.tex', '\\begin{abstract}在65%东区订单下，A站平均送达时间为7.5分钟。\\end{abstract}');
  const s = { mode: 'math', require_model_spec: true, data_epoch: 0,
    question_graph: [{ id: 1, status: 'committed', experiments: ['run1'], artifacts: [{ path: 'figures/mean.svg', kind: 'figure' }] }] };
  registerSpec(s, spec);
  const bytes = fs.readFileSync(result);
  const run = { run_id: 'run1', tool: 'python_run', ok: true, formal: true, unstable: false, epoch: 0,
    input_hash: inputStampHash(stampInputFiles(root)), model_spec: specBinding(s, { question_id: 1 }),
    result_artifacts: { files: [{ path: 'outputs/result.json', sha256: sha(bytes), bytes: bytes.length },
      { path: 'figures/mean.svg', sha256: sha(fs.readFileSync(figure)), bytes: fs.statSync(figure).size }] }, out: 'A 7.5' };
  s.runs = [run];
  const input = { id: 'q1_mean', question_id: 1, text: 'A站平均送达时间为7.5分钟', scope: '东区订单占65%，仅题给两站的平均时间', run_id: 'run1',
    source: { path: 'outputs/result.json', field: 'mean.A', unit: '分钟' }, displayed_value: 7.5, decimals: 1,
    figures: [{ path: 'figures/mean.svg', kind: 'data', panel: 'A站均值' }],
    references: [{ path: 'paper/main.tex', kind: 'abstract', quote: '在65%东区订单下，A站平均送达时间为7.5分钟。' }] };
  assert.equal(trace.inspect(root, s).status, 'unregistered');
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  assert.equal(trace.register({ workspace: root, session: s }, input).ok, true);
  assert.equal(trace.inspect(root, s).status, 'fresh');
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  assert.equal(trace.manifest(root, s).claims[0].value, 7.5);
  assert.equal(trace.register({ workspace: root, session: s }, { ...input, id: 'scaled', text: 'A站平均送达时间为450秒',
    transform: { kind: 'affine', scale: 60, offset: 0 }, output_unit: '秒', displayed_value: 450, decimals: 0,
    figures: [], references: [] }).claim.value, 450);
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'wrong', displayed_value: 9 }), /展示值/);
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'omitted', displayed_value: undefined }), /displayed_value/);
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'wrong-text', text: 'A站平均送达时间为9分钟', references: [] }), /原句/);
  for (const minus of ['−', '－']) assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'wrong-sign', text: `A站平均送达时间为${minus}7.5分钟`, references: [] }), /原句/);
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'wrong-unit', transform: { kind: 'affine', scale: 1, offset: 0 } }), /output_unit/);
  const arbitrary = put('figures/arbitrary.svg', '<svg/>');
  s.question_graph[0].artifacts.push({ path: 'figures/arbitrary.svg', kind: 'figure' });
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'fake-figure', figures: [{ path: 'figures/arbitrary.svg', kind: 'data', panel: 'A' }] }), /回执/);
  s.question_graph[0].artifacts.pop(); fs.unlinkSync(arbitrary);
  s.paper_audit = { tex_path: 'paper/main.tex' };
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  put('paper/other.md', input.text);
  const misplaced = structuredClone(s); misplaced.claim_trace.claims[0].references[0].path = 'paper/other.md';
  const other = fs.readFileSync(path.join(root, 'paper/other.md'));
  misplaced.claim_trace.claims[0].references[0].sha256 = sha(other); misplaced.claim_trace.claims[0].references[0].bytes = other.length;
  misplaced.claim_trace.claims[0].references[0].quote = input.text;
  assert.match(trace.blockers(root, misplaced, { final: true }).join(' '), /当前论文摘要/);
  const withoutAbstract = structuredClone(s);
  put('paper/no-abstract.tex', input.text);
  withoutAbstract.paper_audit.tex_path = 'paper/no-abstract.tex';
  const noAbstract = fs.readFileSync(path.join(root, 'paper/no-abstract.tex'));
  Object.assign(withoutAbstract.claim_trace.claims[0].references[0], { path: 'paper/no-abstract.tex', quote: input.text, sha256: sha(noAbstract), bytes: noAbstract.length });
  assert.match(trace.blockers(root, withoutAbstract, { final: true }).join(' '), /摘要区域/);
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'proto', source: { ...input.source, field: '__proto__.x' } }), /字段/);
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'escape', source: { ...input.source, path: '../outside.json' } }), /越界/);
  const outsideFile = path.join(outside, 'result.json'); fs.writeFileSync(outsideFile, '{}');
  const link = path.join(root, 'outputs/link.json'); fs.symlinkSync(outsideFile, link, 'file');
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'link', source: { ...input.source, path: 'outputs/link.json' } }), /越界/);
  const afterFile = put('outputs/later.json', JSON.stringify({ value: 1 }));
  assert.throws(() => trace.register({ workspace: root, session: s }, { ...input, id: 'later', source: { path: 'outputs/later.json', field: 'value', unit: '分钟' } }), /回执/,
    'a file written after the run cannot be attached without a run receipt');
  fs.unlinkSync(afterFile);
  s.question_graph[0].experiments = [];
  assert.match(trace.inspect(root, s).issues.join(' '), /link_run/);
  s.question_graph[0].experiments = ['run1'];
  fs.writeFileSync(result, JSON.stringify({ mean: { A: 8, B: 8.6 }, series: [8, 8.6] }));
  assert.match(trace.inspect(root, s).issues.join(' '), /结果文件/);
  fs.writeFileSync(result, bytes);
  fs.writeFileSync(figure, '<svg><text>B 8.6 分钟</text></svg>');
  assert.match(trace.inspect(root, s).issues.join(' '), /数据图.*版本/);
  fs.writeFileSync(figure, '<svg><text>A 7.5 分钟</text></svg>');
  fs.writeFileSync(paper, '旧摘要');
  assert.match(trace.inspect(root, s).issues.join(' '), /文稿引用.*版本|原文已改变/);
  fs.writeFileSync(paper, '\\begin{abstract}在65%东区订单下，A站平均送达时间为7.5分钟。\\end{abstract}');
  run.result_artifacts.files[0].sha256 = '0'.repeat(64);
  assert.match(trace.inspect(root, s).issues.join(' '), /回执/);
  run.result_artifacts.files[0].sha256 = sha(bytes);
  s.data_epoch++;
  assert.match(trace.inspect(root, s).issues.join(' '), /旧输入版本|模型规格/);
  s.data_epoch--;
  s.claim_trace.claims = s.claim_trace.claims.filter(x => x.id === 'q1_mean');
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  s.question_graph[0].artifacts.push({ path: 'figures/unlinked.svg', kind: 'figure' });
  assert.match(trace.blockers(root, s, { final: true }).join(' '), /unlinked/);
  s.question_graph[0].artifacts.pop();
  s.model_specs[0].hash = 'tampered';
  assert.match(trace.inspect(root, s).issues.join(' '), /模型规格/);
  console.log('claim trace tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}
