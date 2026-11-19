'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { executeTool } = require('./tools');
const { Sandbox } = require('./sandbox');
const modelSpec = require('./model_spec');
const trace = require('./claim_trace');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-analytic-trace-'));
const put = (rel, contents) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file; };
const statement = '东区订单比例高于4/7时A的平均送达时间较短';
const domain = '仅两候选站点、固定时间矩阵、东区订单比例p在[0,1]';
const proofText = `${statement}。A=14-10p，B=6+4p，A-B=8-14p；故p>4/7。限定范围：${domain}。`;
const spec = { question_id: 1, task: { prompt_ref: '选址题第1问', goal: '推导比例阈值', output: '条件性结论' },
  model_type: 'evaluation', givens: [{ statement: 'A=(4,14) B=(10,6)', source: '题面第1页' }], assumptions: [],
  variables: [{ symbol: 'p', meaning: '东区订单比例', unit: '比例', domain: '[0,1]' }],
  formulation: [{ expression: 'A-B=8-14p', meaning: '平均时间差' }],
  data: [{ name: '送达时间', source: '题面第1页', fields: 'A,B', treatment: '精确分数' }], parameters: [],
  algorithm: { name: '代数推导', inputs: '时间矩阵', steps: ['推导时间差', '解不等式'], outputs: '阈值与方向', stopping: '完成两侧与等号检查' },
  validation: [{ method: '有理数独立核查', criterion: '零点与两侧一致', evidence: 'verification_run' }],
  interfaces: { receives: '题设数据', supplies: '论文结论' }, deliverables: ['推导及示意图'] };

(async () => {
  const s = { mode: 'code', data_epoch: 0, require_model_spec: true,
    question_graph: [{ id: 1, status: 'committed', artifacts: [], experiments: [] }] };
  const ctx = { workspace: root, appDir: root, sandbox: new Sandbox(root), session: s, settings: {}, children: new Set() };
  put('data/times.json', JSON.stringify({ A: [4, 14], B: [10, 6] }));
  put('findings/proof.md', proofText);
  const paper = put('paper/analysis.md', '# 摘要\n' + statement + '。\n关键词：选址；阈值\n# 方法\n阈值示意图展示两候选的条件区域。');
  const picture = put('figures/threshold.svg', '<svg><text>p>4/7 A</text></svg>');
  await executeTool(ctx, 'contract_register', { items: [{ kind: 'boundary', key: 'two_sites', text: '只比较题给两站点', source: '题面第1页' }] });
  s.formulas = [{ name: 'diff(p)', expression: '8-14*p', source: '题面第1页', domain: '[0,1]',
    tests: [{ inputs: { p: 0 }, expected: 8, computed: 8, pass: true },
      { inputs: { p: 1 }, expected: -6, computed: -6, pass: true }], state: 'tests_passed', at: Date.now() }];
  assert(modelSpec.registerSpec(s, spec).ok);
  const script = [
    'import json,hashlib', 'from fractions import Fraction', 'from pathlib import Path',
    'times=json.loads(Path("data/times.json").read_text())',
    'a=lambda p: p*times["A"][0]+(1-p)*times["A"][1]',
    'b=lambda p: p*times["B"][0]+(1-p)*times["B"][1]',
    't=Fraction(4,7)', 'assert a(t)==b(t)', 'assert a(Fraction(0))>b(Fraction(0))', 'assert a(Fraction(1))<b(Fraction(1))',
    `out=${JSON.stringify({ checks_passed: 1, question_id: 1, statement, domain })}`,
    'out["derivation_sha256"]=hashlib.sha256(Path("findings/proof.md").read_bytes()).hexdigest()',
    'Path("checks.json").write_text(json.dumps(out))',
  ].join('\n');
  put('check.py', script);
  const run = await executeTool(ctx, 'verification_run', { script: 'check.py', inputs: ['findings/proof.md', 'data/times.json'], result: 'checks.json' });
  assert(run.ok, run.error);
  const receipt = s.verification_runs.at(-1);
  assert(receipt.ok, JSON.stringify(receipt));
  const claim = { kind: 'analytic', id: 'threshold', question_id: 1, text: statement, scope: domain,
    proof: { path: 'findings/proof.md', quote: statement, review_boundary: '有限有理数核查阈值两侧与等号；仍需人工审阅代数推导和题意。' },
    premises: [{ kind: 'contract', key: 'two_sites' }, { kind: 'formula', name: 'diff(p)' }, { kind: 'model_spec', id: 'Q1' }],
    verification: { run_id: receipt.run_id }, references: [{ kind: 'abstract', path: 'paper/analysis.md', quote: statement }] };
  const dataPath = path.join(root, 'data/times.json'), priorData = fs.readFileSync(dataPath);
  fs.writeFileSync(dataPath, JSON.stringify({ A: [5, 14], B: [10, 6] }));
  assert.throws(() => trace.register(ctx, claim), /主线输入|模型前提版本/, 'unchanged proof cannot reuse a check executed before data edits');
  fs.writeFileSync(dataPath, priorData);
  const revised = structuredClone(s), changedSpec = structuredClone(spec); changedSpec.task.goal += ' revised';
  assert(modelSpec.registerSpec(revised, changedSpec).ok);
  assert.throws(() => trace.register({ ...ctx, session: revised }, claim), /主线输入|模型前提版本/, 're-registering current spec must not refresh old verification');
  s.formulas[0].expression += '+0';
  assert.throws(() => trace.register(ctx, claim), /主线输入|模型前提版本/);
  s.formulas[0].expression = '8-14*p';
  assert.equal(trace.register(ctx, claim).claim.kind, 'analytic');
  assert.equal(trace.inspect(root, s).status, 'fresh');
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  s.paper_audit = { tex_path: 'paper/analysis.md' };
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);

  await executeTool(ctx, 'question_graph', { op: 'attach_artifact', id: 1, path: 'figures/threshold.svg', kind: 'diagram' });
  assert.match(trace.blockers(root, s, { final: true }).join(' '), /示意图/);
  const diagram = { id: 'threshold_plot', question_id: 1, path: 'figures/threshold.svg', panel: '阈值示意图',
    sources: [{ kind: 'contract', key: 'two_sites' }, { kind: 'formula', name: 'diff(p)' },
      { kind: 'proof', claim_id: 'threshold', path: 'findings/proof.md', quote: statement }],
    references: [{ kind: 'caption', path: 'paper/analysis.md', quote: '阈值示意图展示两候选的条件区域' }] };
  assert.equal(trace.registerDiagram(ctx, diagram).diagram.kind, 'diagram');
  assert.equal(trace.inspect(root, s).diagrams[0].status, 'fresh');
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  assert(trace.files(root, s).includes(receipt.script.rel));
  assert(trace.files(root, s).includes('figures/threshold.svg'));
  const cross = structuredClone(s), spec2 = { ...structuredClone(spec), question_id: 2 };
  cross.question_graph.push({ id: 2, status: 'drafting', artifacts: [{ path: 'figures/threshold.svg', kind: 'diagram' }], experiments: [] });
  assert(modelSpec.registerSpec(cross, spec2).ok);
  const crossCtx = { ...ctx, session: cross };
  assert.throws(() => trace.registerDiagram(crossCtx, { ...diagram, id: 'other-question', question_id: 2, sources: [{ kind: 'model_spec', id: 'Q1' }] }), /已声明依赖/);
  await executeTool(crossCtx, 'verification_run', { script: 'check.py', inputs: ['findings/proof.md', 'data/times.json'], result: 'checks.json' });
  trace.register(crossCtx, { ...claim, verification: { run_id: cross.verification_runs.at(-1).run_id } });
  assert.throws(() => trace.registerDiagram(crossCtx, { ...diagram, id: 'other-proof', question_id: 2, sources: [{ kind: 'proof', claim_id: 'threshold', path: 'findings/proof.md', quote: statement }] }), /已声明依赖/);
  cross.question_graph[1].deps = [1];
  assert.equal(trace.registerDiagram(crossCtx, { ...diagram, id: 'dependent-question', question_id: 2, sources: [{ kind: 'model_spec', id: 'Q1' }] }).ok, true);

  const invalid = (action, pattern) => {
    const undo = action(); assert.match(trace.blockers(root, s, { final: true }).join(' '), pattern); undo();
    assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  };
  invalid(() => { fs.writeFileSync(picture, '<svg/>'); return () => fs.writeFileSync(picture, '<svg><text>p>4/7 A</text></svg>'); }, /示意图版本/);
  invalid(() => { fs.appendFileSync(paper, '\nchanged'); return () => fs.writeFileSync(paper, '# 摘要\n' + statement + '。\n关键词：选址；阈值\n# 方法\n阈值示意图展示两候选的条件区域。'); }, /文稿引用|示意图文稿/);
  invalid(() => { fs.appendFileSync(path.join(root, 'findings/proof.md'), '\nchanged'); return () => fs.writeFileSync(path.join(root, 'findings/proof.md'), proofText); }, /推导文件|解析核查|证明来源/);
  invalid(() => { s.contract[0].text = '改成另一题意'; return () => { s.contract[0].text = '只比较题给两站点'; }; }, /题设\/公式来源/);
  invalid(() => { s.formulas[0].state = 'tests_failed'; return () => { s.formulas[0].state = 'tests_passed'; }; }, /公式.*未通过|题设\/公式来源/);
  invalid(() => { const prior = fs.readFileSync(path.join(root, receipt.result.rel)); fs.appendFileSync(path.join(root, receipt.result.rel), '\nchanged'); return () => fs.writeFileSync(path.join(root, receipt.result.rel), prior); }, /解析核查/);
  assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  assert.throws(() => trace.register(ctx, { ...claim, id: 'unverified', verification: { run_id: 'fake' } }), /回执/);
  assert.throws(() => trace.register(ctx, { ...claim, id: 'missing-proof', proof: { ...claim.proof, path: '../outside.md' } }), /越界/);
  assert.throws(() => trace.registerDiagram(ctx, { ...diagram, id: 'fake-diagram', sources: [{ kind: 'proof', claim_id: 'absent', path: 'findings/proof.md', quote: statement }] }), /未登记/);
  s.question_graph[0].evidence_invalidated_at = Date.now();
  assert.match(trace.inspect(root, s).issues.join(' '), /上游提交失效点/);
  console.log('PASS analytic claim: actual verification_run, premise/proof/document/receipt staleness and diagram sources');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});
