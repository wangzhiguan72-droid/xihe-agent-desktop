'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const plans = require('./project_plan'), { Sandbox } = require('./sandbox');
const { executeTool } = require('./tools');
const { recordRun, stampInputFiles, inputStampHash } = require('./agent');
const { registerSpec, specBinding } = require('./model_spec');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-figure-skill-'));
const app = path.resolve(__dirname, '..');
const put = (rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };
(async () => {
  const plan = plans.defaultPlan(); plan.evidence = { claim_trace: 'required' };
  plan.skills.figures = { mode: 'replace', primary: 'xihe-evidence-figures', fallbacks: [] };
  const first = plans.snapshot({ appDir: app, plan, storageRoot: path.join(root, '.first') });
  const pack = plans.exportPackage({ appDir: app, plan, options: { projectRoot: first.root }, lock: plans.resolutionLock(first) });
  assert(pack.skills.find(x => x.name === 'xihe-evidence-figures').files.some(x => x.path === 'scripts/render_evidence.py'));
  const imported = plans.importPackage(pack, null, path.join(root, '.import'));
  const frozen = plans.snapshot({ appDir: app, plan: imported.plan, lock: imported.lock, options: { projectRoot: imported.assetRoot }, storageRoot: path.join(root, '.frozen') });
  assert.equal(frozen.entries.find(x => x.slot === 'figures').sha256, first.entries.find(x => x.slot === 'figures').sha256);
  assert.equal(plans.sessionFields(frozen.plan).contest_kind, 'generic');
  const cumcm = plans.normalizePlan({ ...plan, contest: { contest_kind: 'cumcm', edition: '2026' } });
  assert.equal(plans.resolvePlan({ appDir: app, plan: cumcm }).entries.find(x => x.slot === 'figures').name, 'xihe-evidence-figures');
  const session = { mode: 'code', data_epoch: 0, require_model_spec: true, ...plans.sessionFields(frozen.plan), skill_plan_snapshot: frozen,
    question_graph: [{ id: 1, experiments: [], artifacts: [], status: 'drafting' }] };
  const ctx = { appDir: app, workspace: root, session, settings: {}, children: new Set(), sandbox: new Sandbox(root, { readOnlyRoots: [frozen.root] }) };
  const loaded = plans.loadSessionSkill(app, session, 'xihe-evidence-figures');
  const script = path.join(path.dirname(loaded.file), 'scripts', 'render_evidence.py');
  const recipe = { schema_version: 1, source: 'outputs/result.json', locale: 'en', width_mm: 168, panels: [
    { id: 'mean', kind: 'bar', title: 'Mean delivery time', categories: ['A', 'B'], unit: 'min', ylabel: 'Time', scale_group: 'time', series: [{ label: 'East share 0.65', fields: ['scores.A', 'scores.B'] }] },
    { id: 'worst', kind: 'bar', title: 'Worst area delivery time', categories: ['A', 'B'], unit: 'min', ylabel: 'Time', scale_group: 'time', series: [{ label: 'Two given areas', fields: ['worst.A', 'worst.B'] }] },
    { id: 'sensitivity', kind: 'line', title: 'Actual parameter evaluations', unit: 'min', ylabel: 'Mean time', xlabel: 'East-order share', x_field: 'sweep.p', series: [{ label: 'A', field: 'sweep.A' }, { label: 'B', field: 'sweep.B' }] },
    { id: 'paired', kind: 'paired', title: 'Same-objective station comparison', unit: 'min', ylabel: 'Mean time', categories: ['p=0.65', 'p=0.80'], series: [{ label: 'Station B', field: 'paired.B' }, { label: 'Station A', field: 'paired.A' }] },
  ] };
  put('figure-plan.json', JSON.stringify(recipe));
  put('scripts/solve.py', ['import json', 'from fractions import Fraction as F', 'from pathlib import Path',
    'ps=[F(0),F(1,4),F(1,2),F(4,7),F(3,4),F(1)]', 'a=lambda p:4*p+14*(1-p)', 'b=lambda p:10*p+6*(1-p)',
    'out={"scores":{"A":float(a(F(13,20))),"B":float(b(F(13,20)))},"worst":{"A":14,"B":10},"sweep":{"p":list(map(float,ps)),"A":[float(a(p)) for p in ps],"B":[float(b(p)) for p in ps]},"paired":{"B":[float(b(p)) for p in [F(13,20),F(4,5)]],"A":[float(a(p)) for p in [F(13,20),F(4,5)]]}}',
    'Path("outputs").mkdir(exist_ok=True)', 'Path("outputs/result.json").write_text(json.dumps(out))', 'print(json.dumps(out))'].join('\n'));
  assert(registerSpec(session, { question_id: 1, task: { prompt_ref: 'Synthetic two-site problem', goal: 'Compare conditional choices under two stated objectives', output: 'Times and parameter evaluations' }, model_type: 'optimization',
    givens: [{ statement: 'A=(4,14),B=(10,6),east share0.65', source: 'problem fixture' }], assumptions: [], variables: [{ symbol: 'p', meaning: 'east share', unit: 'fraction', domain: '[0,1]' }],
    formulation: [{ expression: 'A=14-10p;B=6+4p', meaning: 'Mean times' }], data: [{ name: 'times', source: 'synthetic fixture', fields: 'two regions', treatment: 'Exact fractions' }], parameters: [],
    algorithm: { name: 'Enumeration', inputs: 'given times', steps: ['Compute means', 'Compute maxima', 'Evaluate declared parameter points'], outputs: 'result JSON', stopping: 'All declared points evaluated' },
    validation: [{ method: 'Exact arithmetic', criterion: '7.5,8.6 and14,10', evidence: 'Production guarded solve' }], interfaces: { receives: 'given times', supplies: 'plot fields' }, deliverables: ['outputs/result.json'],
    optimization: { objective: 'mean and worst area objectives shown separately', constraints: 'choose one site', decision_domain: '{A,B}' },
  }).ok);
  const args = { formal: true, question_id: 1, result_artifact: true, result_files: ['outputs/result.json', 'figures/comparison.png', 'figures/comparison.pdf', 'figures/comparison.figure.json'],
    code: `from pathlib import Path\nimport runpy,sys\nexec(compile(Path('scripts/solve.py').read_text(), 'scripts/solve.py','exec'))\nsys.argv=['render_evidence.py','--root','.','--recipe','figure-plan.json','--output','figures/comparison']\nrunpy.run_path(${JSON.stringify(script)},run_name='__main__')` };
  const run = await executeTool(ctx, 'python_run', args); assert(run.ok, run.data); assert.equal(run.result_artifacts.files.length, 4, JSON.stringify(run.result_artifacts));
  const rid = recordRun(session, { tool: 'python_run', ok: true, formal: true, resultArtifacts: run.result_artifacts, out: run.data, inputHash: inputStampHash(stampInputFiles(root)), modelSpec: specBinding(session, { question_id: 1 }) });
  await executeTool(ctx, 'question_graph', { op: 'link_run', id: 1, run_id: rid });
  await executeTool(ctx, 'question_graph', { op: 'attach_artifact', id: 1, kind: 'figure', path: 'figures/comparison.png' });
  const text = 'A gives 7.5 min mean time for the stated demand weights.';
  put('paper/summary.md', '# 摘要\n' + text + '\n关键词：选址；时间\n');
  await executeTool(ctx, 'claim_trace', { op: 'register', id: 'mean_A', question_id: 1, run_id: rid, text, scope: 'Given two-site synthetic input, mean objective only',
    source: { path: 'outputs/result.json', field: 'scores.A', unit: 'min' }, displayed_value: 7.5, decimals: 1,
    figures: [{ path: 'figures/comparison.png', kind: 'data', panel: 'mean' }], references: [{ kind: 'abstract', path: 'paper/summary.md', quote: text }] });
  const trace = require('./claim_trace'); assert.deepEqual(trace.blockers(root, session, { final: true }), []);
  const mapping = JSON.parse(fs.readFileSync(path.join(root, 'figures/comparison.figure.json')));
  assert.deepEqual(mapping.panels[0].series[0].values, [7.5, 8.6]); assert.equal(mapping.panels[0].scale_group, mapping.panels[1].scale_group);
  assert.deepEqual(mapping.panels[2].series[0].values.slice(0, 3), [14, 11.5, 9]);
  assert.deepEqual(mapping.panels[3].series[0].values, [8.6, 9.2]);
  const badRecipe = structuredClone(recipe); badRecipe.panels[1].unit = 'seconds'; put('findings/bad-recipe.json', JSON.stringify(badRecipe));
  const bad = spawnSync('python', [script, '--root', root, '--recipe', 'findings/bad-recipe.json', '--output', 'figures/bad'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /matching units/);
  const badData = JSON.parse(fs.readFileSync(path.join(root, 'outputs/result.json'))); badData.scores.A = null;
  put('outputs/bad.json', JSON.stringify(badData)); badRecipe.source = 'outputs/bad.json'; badRecipe.panels[1].unit = 'min'; put('findings/bad-recipe.json', JSON.stringify(badRecipe));
  const missing = spawnSync('python', [script, '--root', root, '--recipe', 'findings/bad-recipe.json', '--output', 'figures/bad'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /nonnumeric/);
  fs.appendFileSync(path.join(root, 'figures/comparison.png'), '\nnew figure'); assert.equal(trace.inspect(root, session).status, 'stale');
  const png = fs.readFileSync(path.join(root, 'figures/comparison.png')); fs.writeFileSync(path.join(root, 'figures/comparison.png'), png.subarray(0, png.length - 11));
  assert.equal(trace.inspect(root, session).status, 'fresh');
  await executeTool(ctx, 'claim_trace', { op: 'export' });
  if (process.env.XIHE_FIGURE_EVIDENCE_DIR) {
    const target = path.resolve(process.env.XIHE_FIGURE_EVIDENCE_DIR); assert(target.startsWith(path.join(app, 'audit') + path.sep));
    fs.mkdirSync(target, { recursive: true });
    for (const dir of ['scripts', 'outputs', 'figures', 'paper', 'findings']) fs.cpSync(path.join(root, dir), path.join(target, dir), { recursive: true });
    fs.copyFileSync(path.join(root, 'figure-plan.json'), path.join(target, 'figure-plan.json'));
    fs.writeFileSync(path.join(target, 'xihe-figures-plan.json'), JSON.stringify(pack, null, 2));
  }
  console.log('PASS contest-neutral figure Skill: portable script, actual guarded solve+PDF/PNG, field/scale mapping, missing data rejection and trace expiry');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
});
