'use strict';
// A real guarded computation, portable method import, PNG and PDF, then a changed objective.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { executeTool, buildPaper } = require('./tools');
const { Sandbox } = require('./sandbox');
const { recordRun, recordChildRun, stampInputFiles, inputStampHash } = require('./agent');
const { specBinding, registerSpec } = require('./model_spec');
const trace = require('./claim_trace'), plans = require('./project_plan');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-trace-workflow-'));
const app = path.resolve(__dirname, '..');
const put = (rel, content) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const spec = {
  question_id: 1, task: { prompt_ref: 'Two-site delivery problem', goal: 'Minimize weighted mean time', output: 'Station and minutes' },
  model_type: 'optimization', givens: [{ statement: 'A=(4,14), B=(10,6), weights=(0.65,0.35)', source: 'data/orders.json' }], assumptions: [],
  variables: [{ symbol: 's', meaning: 'station', unit: 'station', domain: '{A,B}' }],
  formulation: [{ expression: 'min_s sum(w_i t_is)', meaning: 'Weighted mean time' }],
  data: [{ name: 'travel times', source: 'data/orders.json', fields: 'A,B,weights', treatment: 'Exact decimal weights; no imputation' }], parameters: [],
  algorithm: { name: 'Exhaustive enumeration', inputs: 'two sites', steps: ['Evaluate both objective values', 'Choose smaller value'], outputs: 'station and minutes', stopping: 'Both sites evaluated' },
  validation: [{ method: 'Independent rational arithmetic', criterion: 'Mean A=7.5 B=8.6; worst A=14 B=10', evidence: 'Assertions in workflow test' }],
  interfaces: { receives: 'travel matrix', supplies: 'summary and data figure' }, deliverables: ['outputs/result.json', 'figures/sites.png'],
  optimization: { objective: 'minimum weighted mean time', constraints: 'Choose one station', decision_domain: '{A,B}',
    check: { direction: 'min', variables: [{ name: 's', domain: { kind: 'finite', values: [0, 1] } }],
      objective: { constant: 7.5, terms: [{ coefficient: 1.1, powers: { s: 1 } }] }, constraints: [] } },
};
(async () => {
  const plan = plans.defaultPlan();
  plan.evidence = { claim_trace: 'required' };
  plan.skills.research = { mode: 'replace', primary: 'xihe-research-methods', fallbacks: [] };
  const first = plans.snapshot({ appDir: app, plan: plans.normalizePlan(plan), storageRoot: path.join(root, '.source'), revision: 1 });
  const pack = plans.exportPackage({ appDir: app, plan: first.plan, options: { projectRoot: first.root }, lock: plans.resolutionLock(first) });
  const imported = plans.importPackage(pack, null, path.join(root, '.imported'));
  const frozen = plans.snapshot({ appDir: app, plan: imported.plan, lock: imported.lock, options: { projectRoot: imported.assetRoot }, storageRoot: path.join(root, '.destination') });
  assert.equal(frozen.entries.find(x => x.slot === 'research').sha256, first.entries.find(x => x.slot === 'research').sha256);
  const session = { mode: 'code', require_model_spec: true, data_epoch: 0, ...plans.sessionFields(frozen.plan), skill_plan_snapshot: frozen,
    question_graph: [{ id: 1, title: 'Station choice', status: 'drafting', experiments: [], artifacts: [] }] };
  const ctx = { workspace: root, appDir: app, sandbox: new Sandbox(root, { readOnlyRoots: [frozen.root] }), session, settings: {}, children: new Set() };
  assert((await executeTool(ctx, 'skill_load', { name: 'xihe-research-methods', file: 'optimization.md' })).data.includes('最优'));
  await executeTool(ctx, 'claim_trace', { op: 'enable' });
  put('data/orders.json', JSON.stringify({ A: [4, 14], B: [10, 6], weights: [0.65, 0.35] }));
  put('scripts/solve.py', [
    'import json,sys', 'from fractions import Fraction', 'from pathlib import Path',
    'objective=globals().get("objective",sys.argv[1] if len(sys.argv)>1 else "mean")',
    'import matplotlib', 'matplotlib.use("Agg")', 'import matplotlib.pyplot as plt',
    'data=json.loads(Path("data/orders.json").read_text())',
    'scores={s:float(sum(Fraction(str(w))*t for w,t in zip(data["weights"],data[s]))) if objective=="mean" else max(data[s]) for s in ["A","B"]}',
    'chosen=min(scores,key=scores.get)',
    'result={"objective":objective,"scores":scores,"selected":chosen,"value":scores[chosen],"unit":"min"}',
    'result["optimization"]={"level":"finite_domain","solution":{"s":["A","B"].index(chosen)},"objective":scores[chosen]}',
    'Path("outputs").mkdir(exist_ok=True)', 'Path("figures").mkdir(exist_ok=True)',
    'Path("outputs/result.json").write_text(json.dumps(result))',
    'fig,ax=plt.subplots(figsize=(4,3)); ax.bar(list(scores),list(scores.values())); ax.set_ylabel("Time (min)"); ax.set_title(objective+" delivery time"); fig.tight_layout(); fig.savefig("figures/sites.png",dpi=120); plt.close(fig)',
    'print(json.dumps(result))',
  ].join('\n'));
  assert(registerSpec(session, spec).ok);
  const compute = async objective => {
    const response = await executeTool(ctx, 'python_run', { formal: true, question_id: 1, result_artifact: true,
      result_files: ['outputs/result.json', 'figures/sites.png'],
      code: `from pathlib import Path\nobjective=${JSON.stringify(objective)}\nexec(compile(Path('scripts/solve.py').read_text(), 'scripts/solve.py', 'exec'))` });
    assert(response.ok, response.data);
    assert.equal(response.result_artifacts.files.length, 2, JSON.stringify(response.result_artifacts));
    const rid = recordRun(session, { tool: 'python_run', ok: response.ok, formal: true, out: response.data,
      modelSpec: specBinding(session, { question_id: 1 }), inputHash: inputStampHash(stampInputFiles(root)), resultArtifacts: response.result_artifacts });
    await executeTool(ctx, 'question_graph', { op: 'link_run', id: 1, run_id: rid });
    await executeTool(ctx, 'optimization_check', { op: 'check', question_id: 1, run_id: rid, path: 'outputs/result.json' });
    return rid;
  };
  const makePaper = text => put('paper/main.tex', '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\begin{abstract}\n' + text + '\n\\end{abstract}\n\\section{Result}\n' + text + '\n\\begin{figure}[h]\\centering\\includegraphics[width=.6\\textwidth]{../figures/sites.png}\\caption{' + text + '}\\end{figure}\n\\end{document}\n');
  const bind = async (rid, text, value, field) => {
    await executeTool(ctx, 'question_graph', { op: 'attach_artifact', id: 1, path: 'figures/sites.png', kind: 'figure', note: 'Objective values for both feasible sites' });
    const r = await executeTool(ctx, 'claim_trace', { op: 'register', id: 'site', question_id: 1, run_id: rid, text,
      scope: 'Only the two given feasible stations and given travel times; no demand uncertainty estimated',
      source: { path: 'outputs/result.json', field, unit: 'min' }, displayed_value: value, decimals: 1,
      figures: [{ path: 'figures/sites.png', kind: 'data', panel: 'selected station' }],
      references: [{ kind: 'abstract', path: 'paper/main.tex', quote: text }, { kind: 'caption', path: 'paper/main.tex', quote: text }] });
    assert(r.ok, r.data); assert.deepEqual(trace.blockers(root, session, { final: true }), []);
  };
  const mean = await compute('mean');
  const firstResult = JSON.parse(fs.readFileSync(path.join(root, 'outputs/result.json')));
  assert.deepEqual(firstResult.scores, { A: 7.5, B: 8.6 }); assert.equal(firstResult.selected, 'A');
  const meanText = 'A gives 7.5 min mean delivery time with the given demand weights.';
  makePaper(meanText); await bind(mean, meanText, 7.5, 'scores.A');
  // Commit must keep trace-enabled current result/spec evidence usable.
  const beforeCommit = session.data_epoch;
  await executeTool(ctx, 'question_graph', { op: 'commit', id: 1 });
  assert.equal(session.data_epoch, beforeCommit); assert.equal(trace.inspect(root, session).status, 'fresh');
  const firstTrace = trace.manifest(root, session);
  put('findings/mean-trace.json', JSON.stringify(firstTrace, null, 2));
  fs.copyFileSync(path.join(root, 'outputs/result.json'), path.join(root, 'outputs/mean-result.json'));
  fs.copyFileSync(path.join(root, 'figures/sites.png'), path.join(root, 'figures/mean.png'));
  fs.copyFileSync(path.join(root, 'paper/main.tex'), path.join(root, 'paper/mean.tex'));
  const build = await buildPaper(ctx, 'paper/main.tex', { passes: 1 });
  assert(build.ok, build.errors);
  fs.copyFileSync(path.join(root, 'paper/main.pdf'), path.join(root, 'paper/mean.pdf'));
  // A successful run that does not touch an old result cannot claim to have produced it.
  const noop = await executeTool(ctx, 'python_run', { formal: true, question_id: 1, result_artifact: true, code: 'print("no result written")', result_files: ['outputs/result.json'] });
  assert(noop.ok); assert.equal(noop.result_artifacts.files.length, 0); assert(noop.result_artifacts.issues.length);
  const worst = structuredClone(spec); worst.task.goal = 'Minimize the slowest area time';
  worst.optimization.objective = 'minimum worst area time';
  worst.optimization.check.objective = { constant: 14, terms: [{ coefficient: -4, powers: { s: 1 } }] };
  worst.formulation = [{ expression: 'min_s max_i t_is', meaning: 'Worst area time' }];
  registerSpec(session, worst);
  const invalidated = trace.manifest(root, session); assert.equal(invalidated.status, 'stale');
  put('findings/invalidated-trace.json', JSON.stringify(invalidated, null, 2));
  const second = await compute('worst');
  const nextResult = JSON.parse(fs.readFileSync(path.join(root, 'outputs/result.json')));
  assert.deepEqual(nextResult.scores, { A: 14, B: 10 }); assert.equal(nextResult.selected, 'B');
  assert.equal(trace.inspect(root, session).status, 'stale', 'new computation must not silently refresh the old summary/figure binding');
  const worstText = 'B gives 10.0 min worst area delivery time among the two given feasible stations.';
  makePaper(worstText); await bind(second, worstText, 10, 'scores.B');
  const finalBuild = await buildPaper(ctx, 'paper/main.tex', { passes: 1 }); assert(finalBuild.ok, finalBuild.errors);
  await executeTool(ctx, 'claim_trace', { op: 'export' });
  assert.equal(trace.inspect(root, session).claims[0].value, 10);
  assert.equal(trace.inspect(root, session).claims[0].run_id, second);
  const exported = fs.readFileSync(path.join(root, 'findings/claim_trace.json'), 'utf8');
  await executeTool(ctx, 'support_pack', {});
  assert(session.support_pack.verified, JSON.stringify(session.support_pack));
  for (const rel of ['outputs/result.json', 'figures/sites.png', 'findings/claim_trace.json', 'scripts/solve.py']) {
    assert(session.support_pack.entries.some(entry => entry.rel === rel), 'support missing ' + rel);
  }
  await executeTool(ctx, 'claim_trace', { op: 'export' });
  assert.equal(fs.readFileSync(path.join(root, 'findings/claim_trace.json'), 'utf8'), exported, 'same trace export must not stale its packaged copy');
  const workflow = require('./contest_workflows');
  assert.deepEqual(require('./support_integrity').freshSupportBlockers(root, session.support_pack,
    workflow.supportPolicy(session), workflow.supportRequirements(session)), []);
  // Document a same-value but redrawn figure, then require an explicit new registration.
  fs.appendFileSync(path.join(root, 'figures/sites.png'), Buffer.from('\nnew version'));
  assert.match(trace.inspect(root, session).issues.join(' '), /数据图.*版本/);
  // Restore the computed image; the source remains identical to that run's receipt.
  // The bytes appended above are test-only and never exported as the completed demo.
  const image = fs.readFileSync(path.join(root, 'figures/sites.png'));
  fs.writeFileSync(path.join(root, 'figures/sites.png'), image.subarray(0, image.length - 12));
  assert.equal(trace.inspect(root, session).status, 'fresh');
  // An upstream commit cannot make a previously computed downstream run reusable.
  const dependencies = structuredClone(session);
  dependencies.question_graph.push({ id: 2, deps: [1], status: 'drafting', experiments: [], artifacts: [] });
  const childSpec = structuredClone(worst); childSpec.question_id = 2;
  assert(registerSpec(dependencies, childSpec).ok);
  const oldDownstream = recordRun(dependencies, { tool: 'python_run', ok: true, formal: true, out: '10',
    modelSpec: specBinding(dependencies, { question_id: 2 }), inputHash: inputStampHash(stampInputFiles(root)) });
  const depCtx = { ...ctx, session: dependencies };
  const oldChild = recordChildRun(dependencies, { profile: 'worker', tool: 'python_run', ok: true, formal: true,
    epoch: dependencies.data_epoch, modelSpec: specBinding(dependencies, { question_id: 2 }), inputHash: inputStampHash(stampInputFiles(root)) });
  await executeTool(depCtx, 'question_graph', { op: 'link_run', id: 2, run_id: oldDownstream });
  await executeTool(depCtx, 'question_graph', { op: 'commit', id: 1 });
  await assert.rejects(executeTool(depCtx, 'question_graph', { op: 'link_run', id: 2, run_id: oldDownstream }), /上游提交失效点/);
  await assert.rejects(executeTool(depCtx, 'question_graph', { op: 'link_run', id: 2, run_id: oldChild }), /上游提交失效点/);
  const lateImport = recordChildRun(dependencies, { profile: 'child_session', originSessionId: 'old-session', originAt: 1,
    tool: 'python_run', ok: true, formal: true, epoch: dependencies.data_epoch,
    modelSpec: specBinding(dependencies, { question_id: 2 }), inputHash: inputStampHash(stampInputFiles(root)) });
  await assert.rejects(executeTool(depCtx, 'question_graph', { op: 'link_run', id: 2, run_id: lateImport }), /上游提交失效点/);
  put('findings/workflow-session.json', JSON.stringify(session, null, 2));
  if (process.env.XIHE_TRACE_EVIDENCE_DIR) {
    const dest = path.resolve(process.env.XIHE_TRACE_EVIDENCE_DIR);
    assert(dest.startsWith(path.join(app, 'audit') + path.sep));
    fs.mkdirSync(dest, { recursive: true });
    for (const rel of ['data', 'scripts', 'outputs', 'figures', 'paper', 'findings']) fs.cpSync(path.join(root, rel), path.join(dest, rel), { recursive: true });
    for (const rel of [session.support_pack.zip, session.support_pack.ai_pdf].filter(Boolean)) fs.copyFileSync(path.join(root, rel), path.join(dest, rel));
    fs.writeFileSync(path.join(dest, 'imported-plan.json'), JSON.stringify(pack, null, 2));
  }
  console.log('PASS imported Skill -> guarded rational solve -> result receipts -> summary/PNG/PDF trace -> changed objective A to B -> stale references -> explicit updated binding');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
});
