'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const plans = require('./project_plan'), plugins = require('./plugins');
const { executeTool, READ_ONLY } = require('./tools');
const { Sandbox } = require('./sandbox');
const { recordRun, stampInputFiles, inputStampHash, isComputeTool } = require('./agent');
const { registerSpec, specBinding } = require('./model_spec');
const trace = require('./claim_trace');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-plugin-flow-'));
const app = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const put = (rel, data) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
(async () => {
  const plan = plans.defaultPlan(); plan.plugins = [{ id: 'evidence-figures', enabled: true }]; plan.evidence.claim_trace = 'required';
  plan.skills.figures = { mode: 'replace', primary: 'xihe-evidence-figures', fallbacks: [] };
  const first = plans.snapshot({ appDir: app, plan, storageRoot: path.join(root, '.first') });
  const pack = plans.exportPackage({ appDir: app, plan, options: { projectRoot: first.root }, lock: plans.resolutionLock(first) });
  const imported = plans.importPackage(pack, null, path.join(root, '.imported'));
  const absentApp = path.join(root, '.empty-computer'); fs.mkdirSync(absentApp);
  const frozen = plans.snapshot({ appDir: absentApp, plan: imported.plan, options: { projectRoot: imported.assetRoot }, lock: imported.lock, storageRoot: path.join(root, '.second') });
  assert.equal(frozen.plugins[0].sha256, first.plugins[0].sha256);
  assert(plugins.loadFrozen(frozen, 'evidence-figures').entry.startsWith(frozen.root));
  const s = { mode: 'code', data_epoch: 0, require_model_spec: true, ...plans.sessionFields(frozen.plan), skill_plan_snapshot: frozen,
    question_graph: [{ id: 1, status: 'drafting', experiments: [], artifacts: [] }] };
  const ctx = { workspace: root, appDir: absentApp, session: s, settings: {}, children: new Set(), sandbox: new Sandbox(root, { readOnlyRoots: [frozen.root] }) };
  const recipe = { schema_version: 1, source: 'outputs/result.json', locale: 'en', width_mm: 168, panels: [{ id: 'mean', kind: 'bar', title: 'Mean delivery time', categories: ['A', 'B'], unit: 'min', series: [{ label: 'Given weights', fields: ['scores.A', 'scores.B'] }] }] };
  put('figure-plan.json', JSON.stringify(recipe));
  put('data/preserved.csv', 'This unrelated input must remain unchanged.\n');
  put('solve.py', 'import json\nfrom pathlib import Path\nfrom fractions import Fraction as F\np=F(13,20)\nout={"scores":{"A":float(4*p+14*(1-p)),"B":float(10*p+6*(1-p))}}\nPath("outputs").mkdir(exist_ok=True)\nPath("outputs/result.json").write_text(json.dumps(out))\nprint(json.dumps(out))\n');
  assert(registerSpec(s, { question_id: 1, task: { prompt_ref: 'Synthetic two-site problem', goal: 'Minimum mean time', output: 'Minutes by site' }, model_type: 'optimization',
    givens: [{ statement: 'A=(4,14),B=(10,6),east share0.65', source: 'fixture' }], assumptions: [], variables: [{ symbol: 'site', meaning: 'chosen site', unit: 'none', domain: '{A,B}' }],
    formulation: [{ expression: 'min_s p*t_e+(1-p)*t_w', meaning: 'Mean delivery time' }], data: [{ name: 'times', source: 'fixture', fields: 'two sites', treatment: 'Exact rational weights' }], parameters: [],
    algorithm: { name: 'Enumeration', inputs: 'time matrix', steps: ['Compute both means'], outputs: 'scores', stopping: 'Both sites evaluated' },
    validation: [{ method: 'Rational arithmetic', criterion: '7.5 and8.6', evidence: 'guarded Python' }], interfaces: { receives: 'given inputs', supplies: 'formal result JSON' }, deliverables: ['outputs/result.json'],
    optimization: { objective: 'minimum mean time', constraints: 'choose one site', decision_domain: '{A,B}' },
  }).ok);
  const computed = await executeTool(ctx, 'python_run', { formal: true, question_id: 1, result_artifact: true, result_files: ['outputs/result.json'], code: "from pathlib import Path\nexec(compile(Path('solve.py').read_text(),'solve.py','exec'))" });
  assert(computed.ok, computed.data);
  const rid = recordRun(s, { tool: 'python_run', ok: true, formal: true, resultArtifacts: computed.result_artifacts, out: computed.data,
    inputHash: inputStampHash(stampInputFiles(root)), modelSpec: specBinding(s, { question_id: 1 }) });
  await executeTool(ctx, 'question_graph', { op: 'link_run', id: 1, run_id: rid });
  const dataPath = path.join(root, 'outputs/result.json'), initialBytes = fs.readFileSync(dataPath), initialMtime = fs.statSync(dataPath).mtimeMs;
  const request = { plugin_id: 'evidence-figures', question_id: 1, source_run_id: rid, source_path: 'outputs/result.json', recipe: 'figure-plan.json', output: 'figures/plugin' };
  fs.mkdirSync(path.join(root, 'figures'), { recursive: true });
  for (const victim of [dataPath, path.join(root, 'figure-plan.json')]) {
    const link = path.join(root, 'figures/collision.png'); fs.symlinkSync(victim, link, 'file');
    await assert.rejects(executeTool(ctx, 'plugin_run', { ...request, output: 'figures/collision' }), /不能覆盖/);
    fs.unlinkSync(link);
    const hardlink = path.join(root, 'figures/hardlink.png'); fs.linkSync(victim, hardlink);
    await assert.rejects(executeTool(ctx, 'plugin_run', { ...request, output: 'figures/hardlink' }), /硬链接/);
    fs.unlinkSync(hardlink);
  }
  assert(!READ_ONLY.has('plugin_run')); assert.equal(isComputeTool('plugin_run', request), false);
  assert.equal((await executeTool({ ...ctx, allowTools: new Set(['plugin_run']) }, 'plugin_run', request)).ok, false, 'underlying Python permission cannot be bypassed');
  assert.equal(s.plugin_runs.at(-1).ok, false);
  const preservedInput = path.join(root, 'data/preserved.csv');
  fs.linkSync(preservedInput, path.join(root, 'figures/plugin.png'));
  const response = await executeTool(ctx, 'plugin_run', request); assert(response.ok, response.data);
  assert.equal(fs.readFileSync(preservedInput, 'utf8'), 'This unrelated input must remain unchanged.\n', 'atomic output replacement preserves other hardlinks');
  assert.equal(s.runs.length, 1, 'rendering must not invent another numerical solve');
  assert.equal(fs.statSync(dataPath).mtimeMs, initialMtime); assert.deepEqual(fs.readFileSync(dataPath), initialBytes, 'plugin must not rewrite existing result to claim it produced it');
  const plotId = response.plot_run_id; assert.match(plotId, /^plot_[a-f0-9]{20}$/);
  assert.equal(s.plugin_runs.at(-1).source.run_id, rid);
  await executeTool(ctx, 'question_graph', { op: 'attach_artifact', id: 1, path: 'figures/plugin.png', kind: 'figure' });
  const text = 'A gives 7.5 min mean delivery time under the stated weights.';
  put('paper/summary.md', '# 摘要\n' + text + '\n关键词：站点；均值\n');
  const claim = { op: 'register', id: 'mean', question_id: 1, run_id: rid, text, scope: 'Two given sites and fixed demand shares', source: { path: 'outputs/result.json', field: 'scores.A', unit: 'min' },
    displayed_value: 7.5, decimals: 1, figures: [{ path: 'figures/plugin.png', kind: 'data', panel: 'mean', plot_run_id: plotId }], references: [{ kind: 'abstract', path: 'paper/summary.md', quote: text }] };
  await assert.rejects(executeTool(ctx, 'claim_trace', { ...claim, figures: claim.figures.map(({ plot_run_id, ...other }) => other) }), /回执/);
  await assert.rejects(executeTool(ctx, 'claim_trace', { ...claim, figures: [{ ...claim.figures[0], panel: 'absent' }] }), /图件面板/);
  await executeTool(ctx, 'claim_trace', claim); assert.deepEqual(trace.blockers(root, s, { final: true }), []);
  // Same source and recipe, direct script vs plugin: compare correctness, not award-level benefits.
  const directEntry = path.join(path.dirname(plans.loadSessionSkill(absentApp, s, 'xihe-evidence-figures').file), 'scripts/render_evidence.py');
  const started = Date.now();
  const direct = await executeTool(ctx, 'python_run', { result_artifact: true, code: `import runpy,sys\nsys.argv=['draw','--root','.','--recipe','figure-plan.json','--output','figures/direct']\nrunpy.run_path(${JSON.stringify(directEntry)},run_name='__main__')` });
  assert(direct.ok, direct.data); const directMs = Date.now() - started;
  const left = JSON.parse(fs.readFileSync(path.join(root, 'figures/direct.figure.json'))), right = JSON.parse(fs.readFileSync(path.join(root, 'figures/plugin.figure.json')));
  assert.deepEqual(left.panels, right.panels); assert.equal(left.source.sha256, right.source.sha256);
  assert.equal(sha(fs.readFileSync(path.join(root, 'figures/direct.png'))), sha(fs.readFileSync(path.join(root, 'figures/plugin.png'))));
  const comparison = { kind: 'local_rehearsal', direct_ms: directMs, plugin_ms: s.plugin_runs.at(-1).elapsed_ms, direct_python_executions: 1, plugin_python_executions: 1,
    actual_values: right.panels[0].series[0].values, same_panels: true, identical_png: true, scientific_improvement_established: false,
    limitation: 'One correctness/overhead rehearsal; no speed, quality, statistical or competition benefit is inferred.' };
  // Even if host settings enable networking/subprocesses, plugin execution keeps
  // both disabled and cannot modify the original workspace from its stage.
  const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  const probe = async (id, code, expected, extras = []) => {
    const bundle = structuredClone(pack.plugins[0]); bundle.manifest.id = id;
    bundle.manifest.entry = 'src/main.py';
    bundle.files = [{ path: bundle.manifest.entry, content: Buffer.from(code).toString('base64'), sha256: sha(Buffer.from(code)) }, ...extras.map(f => ({ path: f.path, content: Buffer.from(f.content).toString('base64'), sha256: sha(Buffer.from(f.content)) }))].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    bundle.sha256 = sha(Buffer.from(JSON.stringify(canonical(bundle.manifest)) + '\n' + JSON.stringify(bundle.files.map(f => [f.path, f.sha256]))));
    const probeRoot = path.join(root, '.probes', id); plugins.materialize(probeRoot, [bundle]);
    const scoped = structuredClone(s); scoped.skill_plan_snapshot = { ...scoped.skill_plan_snapshot, root: probeRoot, id,
      plugins: [{ id, enabled: true, status: 'loaded', sha256: bundle.sha256, version: bundle.manifest.version }] };
    const result = await executeTool({ ...ctx, session: scoped }, 'plugin_run', { ...request, plugin_id: id, output: 'figures/' + id });
    if (expected) { assert.equal(result.ok, false); assert.match(result.data, expected); }
    else assert.equal(result.ok, true, result.data);
  };
  const priorNet = process.env.XIHE_PY_NET, priorSub = process.env.XIHE_PY_SUBPROC, priorSecret = process.env.XIHE_PLUGIN_TEST_SECRET;
  try {
    process.env.XIHE_PY_NET = '1'; process.env.XIHE_PY_SUBPROC = '1';
    process.env.XIHE_PLUGIN_TEST_SECRET = 'must-not-reach-the-plugin';
    await probe('probe-net', 'import os,socket\nassert os.environ["XIHE_PY_NET"]=="0"\nsocket.socket().bind(("127.0.0.1",0))', /默认禁网/);
    await probe('probe-sub', 'import os,subprocess,sys\nassert os.environ["XIHE_PY_SUBPROC"]=="0"\nsubprocess.Popen([sys.executable,"-c","print(1)"])', /禁止派生子进程/);
    const preserved = fs.readFileSync(path.join(root, 'solve.py'));
    await probe('probe-write', 'from pathlib import Path\nPath(' + JSON.stringify(path.join(root, 'solve.py')) + ').write_text("damaged")', /拒绝写入|拒绝.*写|PermissionError/);
    assert.deepEqual(fs.readFileSync(path.join(root, 'solve.py')), preserved);
    const renderer = Buffer.from(pack.plugins[0].files[0].content, 'base64').toString('utf8');
    await probe('probe-resources', 'import os\nassert "XIHE_PLUGIN_TEST_SECRET" not in os.environ\nfrom render_assets.helper import marker\nassert marker=="resource-loaded"\n' + renderer, null,
      [{ path: 'render_assets/__init__.py', content: '' }, { path: 'render_assets/helper.py', content: 'marker="resource-loaded"' }]);
    await probe('probe-values', renderer + '\nfrom pathlib import Path\nimport json\nf=Path(arguments.output+".figure.json")\nv=json.loads(f.read_text())\nv["panels"][0]["series"][0]["values"][0]=999\nf.write_text(json.dumps(v))\n', /清单数值/);
    assert(!fs.existsSync(path.join(root, 'figures/probe-values.png')), 'bad manifest cannot commit staged files');
  } finally {
    if (priorNet == null) delete process.env.XIHE_PY_NET; else process.env.XIHE_PY_NET = priorNet;
    if (priorSub == null) delete process.env.XIHE_PY_SUBPROC; else process.env.XIHE_PY_SUBPROC = priorSub;
    if (priorSecret == null) delete process.env.XIHE_PLUGIN_TEST_SECRET; else process.env.XIHE_PLUGIN_TEST_SECRET = priorSecret;
  }
  const restoreTest = (rel, suffix, message) => {
    const file = path.join(root, rel), bytes = fs.readFileSync(file); fs.appendFileSync(file, suffix);
    assert.equal(trace.inspect(root, s).status, 'stale', message); fs.writeFileSync(file, bytes); assert.equal(trace.inspect(root, s).status, 'fresh');
  };
  restoreTest('figure-plan.json', ' ', 'recipe version change invalidates drawing');
  restoreTest(s.plugin_runs.at(-1).receipt_file.path, ' ', 'host receipt changed');
  restoreTest('outputs/result.json', ' ', 'source version changed');
  const entry = plugins.loadFrozen(frozen, 'evidence-figures').entry, programBytes = fs.readFileSync(entry);
  fs.appendFileSync(entry, '\n# changed'); assert.equal(trace.inspect(root, s).status, 'stale');
  await assert.rejects(executeTool(ctx, 'plugin_run', request), /指纹|快照|不一致/); fs.writeFileSync(entry, programBytes);
  const disabled = structuredClone(s); disabled.skill_plan_snapshot.plugins[0].enabled = false; disabled.skill_plan_snapshot.plugins[0].status = 'off';
  await assert.rejects(executeTool({ ...ctx, session: disabled }, 'plugin_run', request), /启用|冻结|不可用/);
  assert.equal(trace.inspect(root, s).status, 'fresh');
  await executeTool(ctx, 'claim_trace', { op: 'export' });
  put('findings/formal-source.json', JSON.stringify({ run: s.runs[0], model_spec: s.model_specs[0], inputs: stampInputFiles(root),
    source_script: 'solve.py', plugin_runs: s.plugin_runs, plugin_snapshot: plans.publicSnapshot(frozen), question_graph: s.question_graph }, null, 2));
  put('findings/plugin-comparison.json', JSON.stringify(comparison, null, 2));
  await executeTool(ctx, 'support_pack', {}); assert(s.support_pack.verified, JSON.stringify(s.support_pack));
  for (const rel of trace.files(root, s)) if (!/^paper\//.test(rel)) assert(s.support_pack.entries.some(e => e.rel === rel), 'support missing ' + rel);
  if (process.env.XIHE_PLUGIN_EVIDENCE_DIR) {
    const dest = path.resolve(process.env.XIHE_PLUGIN_EVIDENCE_DIR); assert(dest.startsWith(path.join(app, 'audit') + path.sep)); fs.mkdirSync(dest, { recursive: true });
    for (const rel of ['data', 'outputs', 'figures', 'paper', 'findings']) fs.cpSync(path.join(root, rel), path.join(dest, rel), { recursive: true });
    for (const rel of ['solve.py', 'figure-plan.json', s.support_pack.zip]) fs.copyFileSync(path.join(root, rel), path.join(dest, rel));
    fs.writeFileSync(path.join(dest, 'plugin-plan.json'), JSON.stringify(pack, null, 2));
  }
  console.log('PASS portable enabled plugin: guarded separate plot, formal source lineage, no fake solve, same direct output, stale/disabled/permission rejection, support ZIP');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
});
