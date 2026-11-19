'use strict';
// Real guarded Python + independent host arithmetic + manuscript/plot receipts.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { executeTool, buildPaper } = require('./tools');
const { Sandbox } = require('./sandbox');
const { registerSpec, specBinding } = require('./model_spec');
const { recordRun, stampInputFiles, inputStampHash } = require('./agent');
const trace = require('./claim_trace'), optimization = require('./optimization_trace');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-opt-flow-'));
const app = path.resolve(__dirname, '..');
const put = (rel, value) => { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, value); };
const session = { mode: 'code', require_model_spec: true, data_epoch: 0, claim_trace_required: true,
  question_graph: [{ id: 1, title: 'Allocation', status: 'drafting', experiments: [], artifacts: [] }] };
const ctx = { workspace: root, appDir: app, session, sandbox: new Sandbox(root), settings: {}, children: new Set() };
const check = { direction: 'max', variables: ['x', 'y'].map(name => ({ name, domain: { kind: 'finite', values: [0, 1, 2] } })),
  objective: { terms: [{ coefficient: 3, powers: { x: 1 } }, { coefficient: 2, powers: { y: 1 } }] },
  constraints: [{ polynomial: { terms: [{ coefficient: 2, powers: { x: 1 } }, { coefficient: 1, powers: { y: 1 } }] }, sense: 'le', rhs: 3 }] };
const spec = { question_id: 1, model_type: 'optimization', task: { prompt_ref: 'data/problem.json', goal: 'Maximize allocation benefit', output: 'Solution, benefit and scope' },
  givens: [{ statement: 'x,y in {0,1,2};2x+y<=3; benefit3x+2y', source: 'data/problem.json' }], assumptions: [],
  variables: ['x', 'y'].map(symbol => ({ symbol, meaning: 'allocation', unit: 'unit', domain: '{0,1,2}' })),
  formulation: [{ expression: 'max 3x+2y subject to 2x+y<=3', meaning: 'benefit with resource limit' }],
  data: [{ name: 'allocation model', source: 'data/problem.json', fields: 'variables,objective,constraints', treatment: 'exact decimal coefficients' }], parameters: [],
  algorithm: { name: 'enumeration', inputs: 'registered model', steps: ['Enumerate selected points', 'Back-substitute', 'Compare benefit'], outputs: 'solution and evaluated points', stopping: 'declared search covered' },
  validation: [{ method: 'independent host rational checker', criterion: 'feasible, objective correct, scope justified', evidence: 'optimization_check' }],
  interfaces: { receives: 'model', supplies: 'paper and figure' }, deliverables: ['outputs/result.json', 'figures/search.png'],
  optimization: { objective: 'max benefit', constraints: '2x+y<=3', decision_domain: '{0,1,2} squared', check } };
const events = [];
(async () => {
  put('data/problem.json', JSON.stringify(check, null, 2));
  put('scripts/solve.py', [
    'import json', 'from fractions import Fraction as F', 'from itertools import product', 'from pathlib import Path',
    'import matplotlib', 'matplotlib.use("Agg")', 'import matplotlib.pyplot as plt',
    'model=json.loads(Path("data/problem.json").read_text())',
    'def evaluate(poly,p):',
    '    value=F(str(poly.get("constant",0)))',
    '    for term in poly["terms"]:',
    '        v=F(str(term["coefficient"]))',
    '        for k,power in term["powers"].items(): v*=F(str(p[k]))**power',
    '        value+=v', '    return value',
    'def feasible(p):',
    '    for c in model["constraints"]:',
    '        lhs=evaluate(c["polynomial"],p);rhs=F(str(c["rhs"]))',
    '        if not {"le":lhs<=rhs,"ge":lhs>=rhs,"eq":lhs==rhs}[c["sense"]]: return False',
    '    return True',
    'names=[v["name"] for v in model["variables"]]',
    'if mode=="candidates": points=[{"x":0,"y":0},{"x":0,"y":2}]',
    'elif mode=="grid": points=[{"x":i} for i in [0,1,2]]',
    'else: points=[dict(zip(names,coords)) for coords in product(*[v["domain"]["values"] for v in model["variables"]])]',
    'rows=[{"point":p,"objective":float(evaluate(model["objective"],p))} for p in points]',
    'eligible=[r for r in rows if feasible(r["point"])]',
    'chosen=(min if model["direction"]=="min" else max)(eligible,key=lambda r:r["objective"])',
    'result={"level":mode,"solution":chosen["point"],"objective":chosen["objective"]}',
    'if mode in ["candidates","grid"]: result["candidates"]=rows',
    'if mode=="grid": result["axes"]={"x":[0,1,2]}',
    'Path("outputs").mkdir(exist_ok=True);Path("figures").mkdir(exist_ok=True)',
    'Path("outputs/result.json").write_text(json.dumps({"optimization":result}))',
    'fig,ax=plt.subplots(figsize=(5,3));ax.bar([str(r["point"]) for r in rows],[r["objective"] for r in rows]);ax.set_ylabel("Objective");ax.set_title(mode+" search, registered model");fig.tight_layout();fig.savefig("figures/search.png",dpi=120);plt.close(fig)',
    'print(json.dumps({"optimization":result}))',
  ].join('\n'));
  assert(registerSpec(session, spec).ok);
  const compute = async mode => {
    const response = await executeTool(ctx, 'python_run', { formal: true, question_id: 1, result_artifact: true,
      result_files: ['outputs/result.json', 'figures/search.png'],
      code: `from pathlib import Path\nmode=${JSON.stringify(mode)}\nexec(compile(Path('scripts/solve.py').read_text(),'scripts/solve.py','exec'))` });
    assert(response.ok, response.data);
    const runId = recordRun(session, { tool: 'python_run', ok: response.ok, formal: true, out: response.data,
      modelSpec: specBinding(session, { question_id: 1 }), inputHash: inputStampHash(stampInputFiles(root)), resultArtifacts: response.result_artifacts });
    await executeTool(ctx, 'question_graph', { op: 'link_run', id: 1, run_id: runId });
    await executeTool(ctx, 'optimization_check', { op: 'check', question_id: 1, run_id: runId, path: 'outputs/result.json' });
    return runId;
  };
  const paper = text => put('paper/main.tex', '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\begin{abstract}\n' + text + '\n\\end{abstract}\n\\section{Result and boundary}\n' + text + '\nThe host verifies the registered model; the mapping from the problem to that model still requires review.\\begin{figure}[h]\\centering\\includegraphics[width=.8\\textwidth]{../figures/search.png}\\caption{' + text + '}\\end{figure}\n\\end{document}\n');
  const bind = async (runId, level, value, text) => {
    paper(text);
    const q = session.question_graph[0]; q.artifacts = [];
    await executeTool(ctx, 'question_graph', { op: 'attach_artifact', id: 1, path: 'figures/search.png', kind: 'figure' });
    await executeTool(ctx, 'claim_trace', { op: 'register', id: 'opt', question_id: 1, run_id: runId, text,
      scope: optimization.inspect(root, session)[0].report.optimality_scope,
      source: { path: 'outputs/result.json', field: 'optimization.objective', unit: 'benefit' }, optimality: { level }, displayed_value: value, decimals: 2,
      figures: [{ path: 'figures/search.png', kind: 'data', panel: 'evaluated objective values' }],
      references: [{ kind: 'abstract', path: 'paper/main.tex', quote: text }, { kind: 'caption', path: 'paper/main.tex', quote: text }] });
    assert.deepEqual(trace.blockers(root, session, { final: true }), []);
    await executeTool(ctx, 'question_graph', { op: 'commit', id: 1 });
  };
  const archiveStage = name => {
    const dest = path.join(root, 'findings', 'stages', name);
    for (const rel of ['data/problem.json', 'scripts/solve.py', 'outputs/result.json', 'figures/search.png', 'paper/main.tex', 'paper/main.pdf']) {
      const file = path.join(dest, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(root, rel), file);
    }
    const snapshot = structuredClone(session);
    assert.equal(trace.inspect(dest, snapshot).status, 'fresh', 'each archived stage retains independently checkable inputs and output bytes');
    assert.deepEqual(optimization.blockers(dest, snapshot), []);
    const findings = path.join(dest, 'findings'); fs.mkdirSync(findings, { recursive: true });
    fs.writeFileSync(path.join(findings, 'session.json'), JSON.stringify(snapshot, null, 2));
    fs.writeFileSync(path.join(findings, 'claim-trace.json'), JSON.stringify(trace.manifest(dest, snapshot), null, 2));
  };
  const shortlist = await compute('candidates');
  await bind(shortlist, 'candidates', 4, 'The best value among the two registered candidates is 4.');
  archiveStage('candidates');
  const first = trace.manifest(root, session); put('findings/candidates-trace.json', JSON.stringify(first, null, 2));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'outputs/result.json')));
  const inflated = { level: 'finite_domain', solution: source.optimization.solution, objective: 4 };
  assert.throws(() => require('./optimization_evidence').verify(check, inflated), /更优/);
  events.push({ case: 'shortlist', value: 4, status: 'accepted only within candidates', finite_domain_promotion: 'rejected: better feasible point exists' });
  const complete = await compute('finite_domain');
  assert.equal(trace.inspect(root, session).status, 'stale', 'new solve does not refresh old manuscript or plot evidence');
  await bind(complete, 'finite_domain', 5, 'The optimum over the registered finite domain is 5.');
  assert.equal(optimization.inspect(root, session)[0].report.checked_points, 9);
  assert.equal(optimization.inspect(root, session)[0].report.feasible_points, 5);
  archiveStage('finite-domain');
  put('findings/finite-domain-trace.json', JSON.stringify(trace.manifest(root, session), null, 2));
  events.push({ case: 'finite_domain', value: 5, checked_points: 9, feasible_points: 5, solution: { x: 1, y: 1 } });
  const continuous = structuredClone(spec);
  continuous.task.goal = 'Minimize quadratic on [0,2]';
  continuous.variables = [{ symbol: 'x', meaning: 'decision', unit: 'none', domain: '[0,2]' }];
  continuous.formulation = [{ expression: '(x-0.6)^2+1', meaning: 'Quadratic objective' }];
  continuous.optimization = { objective: 'min quadratic', constraints: '0<=x<=2', decision_domain: '[0,2]',
    check: { direction: 'min', variables: [{ name: 'x', domain: { kind: 'interval', min: 0, max: 2 } }],
      objective: { constant: 1.36, terms: [{ coefficient: -1.2, powers: { x: 1 } }, { coefficient: 1, powers: { x: 2 } }] }, constraints: [] } };
  put('data/problem.json', JSON.stringify(continuous.optimization.check, null, 2));
  assert(registerSpec(session, continuous).ok);
  assert.equal(trace.inspect(root, session).status, 'stale');
  const grid = await compute('grid');
  await bind(grid, 'grid', 1.16, 'On the registered grid, the minimum objective value is 1.16.');
  archiveStage('grid');
  const gridResult = JSON.parse(fs.readFileSync(path.join(root, 'outputs/result.json'))).optimization;
  assert.throws(() => require('./optimization_evidence').verify(continuous.optimization.check,
    { level: 'finite_domain', solution: gridResult.solution, objective: 1.16 }), /连续区间/);
  assert.throws(() => trace.register(ctx, { id: 'inflated', question_id: 1, run_id: grid,
    text: 'The global minimum objective value is 1.16.', scope: 'given interval',
    source: { path: 'outputs/result.json', field: 'optimization.objective', unit: 'benefit' }, displayed_value: 1.16, decimals: 2, optimality: { level: 'grid' } }), /全局|全域/);
  events.push({ case: 'grid', value: 1.16, checked_points: 3, domain: '[0,2]', scope: 'grid only', continuous_global_promotion: 'rejected' });
  const built = await buildPaper(ctx, 'paper/main.tex', { passes: 1 }); assert(built.ok, built.errors);
  await executeTool(ctx, 'claim_trace', { op: 'export' });
  await executeTool(ctx, 'support_pack', {});
  assert(session.support_pack.verified, JSON.stringify(session.support_pack));
  assert(session.support_pack.entries.some(f => f.rel === 'outputs/result.json'));
  put('findings/workflow-events.json', JSON.stringify({ execution: 'actual guarded Python, host verifier, XeLaTeX; no model API', events }, null, 2));
  put('findings/session.json', JSON.stringify(session, null, 2));
  if (process.env.XIHE_OPTIMIZATION_EVIDENCE_DIR) {
    const dest = path.resolve(process.env.XIHE_OPTIMIZATION_EVIDENCE_DIR);
    assert(dest.startsWith(path.join(app, 'audit') + path.sep)); fs.mkdirSync(dest, { recursive: true });
    for (const folder of ['data', 'scripts', 'outputs', 'figures', 'paper', 'findings']) fs.cpSync(path.join(root, folder), path.join(dest, folder), { recursive: true });
    // The pack also declares root-level AI disclosure drafts; retain their exact
    // bytes so the relocated support receipt can be checked independently.
    for (const entry of session.support_pack.entries) {
      const target = path.resolve(dest, entry.rel);
      assert(target.startsWith(dest + path.sep)); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, entry.rel), target);
    }
    fs.copyFileSync(path.join(root, session.support_pack.zip), path.join(dest, session.support_pack.zip));
  }
  console.log('PASS real optimization workflow: candidates4 -> finite-domain5 over9points -> grid1.16; false promotions/stale evidence rejected; PDF/PNG/trace/support produced');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
});
