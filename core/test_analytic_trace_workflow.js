'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { executeTool, buildPaper } = require('./tools');
const { Sandbox } = require('./sandbox');
const { registerSpec } = require('./model_spec');
const trace = require('./claim_trace');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-analytic-workflow-'));
const app = path.resolve(__dirname, '..');
const put = (rel, content) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
(async () => {
  const statement = 'A is faster exactly when p exceeds 4/7, for p in [0,1].';
  const domain = 'Given fixed two-site travel times; p is the unknown east-order share in [0,1].';
  const session = { mode: 'code', require_model_spec: true, data_epoch: 0, question_graph: [{ id: 1, status: 'drafting', experiments: [], artifacts: [] }] };
  const ctx = { workspace: root, appDir: app, sandbox: new Sandbox(root), session, settings: {}, children: new Set() };
  await executeTool(ctx, 'claim_trace', { op: 'enable' });
  await executeTool(ctx, 'contract_register', { items: [{ kind: 'goal', key: 'site-choice', text: 'Minimize mean delivery time; east share p is unknown, not estimated.', source: 'data/problem.json: goal' }] });
  put('data/problem.json', JSON.stringify({ A: [4, 14], B: [10, 6], p: null }));
  assert(registerSpec(session, { question_id: 1, task: { prompt_ref: 'data/problem.json', goal: 'Conditional choice under unknown demand share', output: 'Exact threshold and domain' },
    model_type: 'optimization', givens: [{ statement: 'A=(4,14), B=(10,6); p unknown', source: 'data/problem.json' }], assumptions: [],
    variables: [{ symbol: 'p', meaning: 'east demand share', unit: 'fraction', domain: '[0,1]' }],
    formulation: [{ expression: 'A-B=8-14p', meaning: 'Time difference in minutes' }],
    data: [{ name: 'travel times', source: 'data/problem.json', fields: 'A,B', treatment: 'No imputation of p' }], parameters: [],
    algorithm: { name: 'Exact affine comparison', inputs: 'time matrix', steps: ['Subtract weighted means', 'Solve linear inequality'], outputs: 'Threshold and choices', stopping: 'All cases of p covered' },
    validation: [{ method: 'Rational coefficient and endpoint checks', criterion: 'Difference=8-14p, threshold=4/7', evidence: 'verification_run receipt' }],
    interfaces: { receives: 'given times', supplies: 'conditional conclusion' }, deliverables: ['source/derivation.md', 'figures/threshold.tex'],
    optimization: { objective: 'minimum mean time', constraints: 'choose A or B; p unknown', decision_domain: '{A,B}' },
  }).ok);
  put('source/derivation.md', '# Conditional site choice\n\n' + statement + '\n\nA(p)=14-10p, B(p)=6+4p, so A-B=8-14p. Since 14>0, A<B iff p>4/7. At equality either site is optimal. Below it B is faster. No order proportions are fabricated.\n');
  put('scripts/check.py', [
    'import json,hashlib', 'from pathlib import Path', 'from fractions import Fraction as F',
    'd=json.loads(Path("data/problem.json").read_text())',
    'intercept=F(d["A"][1])-F(d["B"][1])',
    'slope=F(d["A"][0])-F(d["A"][1])-F(d["B"][0])+F(d["B"][1])',
    'assert (intercept,slope)==(8,-14)', 'threshold=-intercept/slope; assert threshold==F(4,7)',
    'assert slope<0 and intercept>0 and intercept+slope<0',
    'out=' + JSON.stringify({ checks_passed: 1, question_id: 1, statement, domain }),
    'out["derivation_sha256"]=hashlib.sha256(Path("source/derivation.md").read_bytes()).hexdigest()',
    'out["checked_coefficients"]=[str(intercept),str(slope)]',
    'Path("checked.json").write_text(json.dumps(out))',
  ].join('\n'));
  put('figures/threshold.tex', '\\begin{picture}(260,55)\n\\put(0,20){\\framebox(80,25){Unknown share p}}\n\\put(80,32){\\vector(1,0){30}}\n\\put(115,20){\\framebox(135,25){Compare p with 4/7}}\n\\end{picture}\n');
  put('paper/main.tex', '\\documentclass{article}\n\\begin{document}\n\\begin{abstract}\n' + statement + '\n\\end{abstract}\n\\section{Conditional result}\n' + statement + '\nThe derivation uses fixed given travel times, not estimated order shares.\n\\begin{figure}[h]\\centering\\input{../figures/threshold.tex}\\caption{' + statement + '}\\end{figure}\n\\end{document}\n');
  await executeTool(ctx, 'question_graph', { op: 'attach_artifact', id: 1, path: 'figures/threshold.tex', kind: 'diagram' });
  await executeTool(ctx, 'verification_run', { script: 'scripts/check.py', inputs: ['source/derivation.md', 'data/problem.json'], result: 'checked.json' });
  const receipt = session.verification_runs.at(-1); assert(receipt.ok, JSON.stringify(receipt));
  await executeTool(ctx, 'claim_trace', { op: 'register', kind: 'analytic', id: 'threshold', question_id: 1, text: statement, scope: domain,
    proof: { path: 'source/derivation.md', quote: statement, review_boundary: 'Checks exact affine coefficients and sign cases; is not a theorem prover and does not verify travel data collection.' },
    premises: [{ kind: 'contract', key: 'site-choice' }, { kind: 'model_spec', id: 'Q1' }], verification: { run_id: receipt.run_id },
    references: [{ kind: 'abstract', path: 'paper/main.tex', quote: statement }] });
  assert(trace.blockers(root, session, { final: true }).some(s => s.includes('示意图')), 'unregistered diagram cannot bypass final gate');
  await executeTool(ctx, 'claim_trace', { op: 'register_diagram', id: 'threshold-diagram', question_id: 1, path: 'figures/threshold.tex', panel: 'decision structure',
    sources: [{ kind: 'contract', key: 'site-choice' }, { kind: 'model_spec', id: 'Q1' }, { kind: 'proof', claim_id: 'threshold', path: 'source/derivation.md', quote: statement }] });
  assert.deepEqual(trace.blockers(root, session, { final: true }), []);
  await executeTool(ctx, 'abstract_check', { path: 'paper/main.tex' });
  assert.equal(session.abstract_check.must_fix, 0, JSON.stringify(session.abstract_check));
  assert.deepEqual(session.abstract_check.analytic_claims, ['threshold']);
  await executeTool(ctx, 'question_graph', { op: 'commit', id: 1 });
  assert.equal(session.question_graph[0].status, 'committed'); assert.equal(session.runs?.length || 0, 0, 'no fictional numeric solve');
  const built = await buildPaper(ctx, 'paper/main.tex', { passes: 1 }); assert(built.ok, built.errors);
  await executeTool(ctx, 'claim_trace', { op: 'export' });
  await executeTool(ctx, 'support_pack', {});
  assert(session.support_pack.verified, JSON.stringify(session.support_pack));
  for (const rel of ['source/derivation.md', 'figures/threshold.tex', receipt.script.rel, receipt.result.rel, receipt.log.rel]) assert(session.support_pack.entries.some(row => row.rel === rel), 'support missing ' + rel);
  const before = fs.readFileSync(path.join(root, 'source/derivation.md'));
  fs.appendFileSync(path.join(root, 'source/derivation.md'), '\nChanged argument.');
  const stale = trace.manifest(root, session); assert.equal(stale.status, 'stale');
  put('findings/stale-proof-trace.json', JSON.stringify(stale, null, 2));
  fs.writeFileSync(path.join(root, 'source/derivation.md'), before);
  session.contract[0].text += ' New premise.';
  assert.equal(trace.inspect(root, session).status, 'stale');
  session.contract[0].text = session.contract[0].text.replace(' New premise.', '');
  assert.equal(trace.inspect(root, session).status, 'fresh');
  put('findings/session.json', JSON.stringify(session, null, 2));
  if (process.env.XIHE_ANALYTIC_EVIDENCE_DIR) {
    const dest = path.resolve(process.env.XIHE_ANALYTIC_EVIDENCE_DIR); assert(dest.startsWith(path.join(app, 'audit') + path.sep));
    fs.mkdirSync(dest, { recursive: true });
    for (const dir of ['data', 'scripts', 'source', 'findings', 'figures', 'paper', 'verification_runs']) fs.cpSync(path.join(root, dir), path.join(dest, dir), { recursive: true });
    fs.copyFileSync(path.join(root, session.support_pack.zip), path.join(dest, session.support_pack.zip));
  }
  console.log('PASS actual rational analytic check + source-bound diagram + abstract + PDF + support ZIP; changed proof/premise invalidates claims and diagram, no fake numeric run');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
});
