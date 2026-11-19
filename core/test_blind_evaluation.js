'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const blind = require('./blind_evaluation');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-blind-eval-test-'));
const put = (rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
try {
  put('visible/problem.txt', 'synthetic complete problem; not sealed competition material');
  put('visible/data.csv', 'x,y\n1,2\n');
  put('hidden/gold.json', '{"answer":2}');
  const runtime = {
    original: put('versions/original.txt', 'actual older archive fingerprint placeholder'),
    skill: put('versions/skill.txt', 'same app with replaced skill'),
    plugin: put('versions/plugin.txt', 'same app with plugin declared'),
  };
  const lock = put('versions/plan.json', '{"version":1}');
  const plugin = put('versions/plugin.json', '{"plugin":"solver","version":1}');
  const args = { root: path.join(root, 'case_rehearsal'), case_id: 'synthetic-001', mode: 'rehearsal',
    visible: { root: path.join(root, 'visible'), files: ['problem.txt', 'data.csv'] },
    hidden: { root: path.join(root, 'hidden'), files: ['gold.json'] },
    protocol: { model: 'same-base-model', contest_package: 'generic', wall_time_ms: 1000, tool_call_limit: 5, cost_limit: 1.5, reviewers_per_paper: 2 },
    arms: {
      original: { runtime_manifest: runtime.original, baseline_origin: 'pre-change-archive', solver_id: 'solver-original' },
      skill: { runtime_manifest: runtime.skill, plan_lock: lock, solver_id: 'solver-skill' },
      plugin: { runtime_manifest: runtime.plugin, plan_lock: lock, plugin_manifest: plugin, solver_id: 'solver-plugin' },
    } };
  assert.throws(() => blind.prepare({ ...args, root: path.join(root, 'no-hidden'), mode: 'sealed', hidden: { root: path.join(root, 'hidden'), files: [] } }), /隐藏材料/);
  assert.throws(() => blind.prepare({ ...args, root: path.join(root, 'bad-original'), mode: 'sealed',
    arms: { ...args.arms, original: { runtime_manifest: runtime.original, solver_id: 'solver-original' } } }), /原版/);
  assert.throws(() => blind.prepare({ ...args, root: path.join(root, 'bad-plugin'), mode: 'sealed',
    arms: { ...args.arms, plugin: { runtime_manifest: runtime.plugin, plan_lock: lock, solver_id: 'solver-plugin' } } }), /插件版/);
  assert.throws(() => blind.prepare({ ...args, root: path.join(root, 'bad-budget'), protocol: { ...args.protocol, tool_call_limit: 0 } }), /正整数/);
  assert.throws(() => blind.prepare({ ...args, root: path.join(root, 'bad-path'), visible: { ...args.visible, files: ['../hidden/gold.json'] } }), /相对路径/);
  assert.throws(() => blind.prepare({ ...args, root: path.join(root, 'bad-overlap'), hidden: { root: path.join(root, 'visible'), files: ['problem.txt'] } }), /重叠/);
  const external = put('external.txt', 'private');
  fs.symlinkSync(external, path.join(root, 'visible', 'link.txt'), 'file');
  assert.throws(() => blind.prepare({ ...args, root: path.join(root, 'bad-link'), visible: { ...args.visible, files: ['link.txt'] } }), /链接/);
  const prepared = blind.prepare(args);
  assert.equal(prepared.status, 'rehearsal'); assert.equal(prepared.blind_evaluation, false);
  assert.equal(prepared.evidence.hidden_file_count, 1);
  assert.throws(() => blind.prepare(args), /全新/);
  const a = blind.allocate(args.root, 'original');
  const b = blind.allocate(args.root, 'skill');
  assert.notEqual(a.workspace, b.workspace);
  assert.deepEqual(fs.readdirSync(a.workspace).sort(), ['data.csv', 'problem.txt']);
  assert.deepEqual(fs.readdirSync(b.workspace).sort(), ['data.csv', 'problem.txt']);
  assert(!fs.existsSync(path.join(a.workspace, 'gold.json')));
  assert.throws(() => blind.allocate(args.root, 'original'), /已分配/);
  const makeSubmission = work => {
    fs.writeFileSync(path.join(work, 'manuscript.pdf'), Buffer.from('%PDF-1.4\nsynthetic paper\n%%EOF\n'));
    fs.writeFileSync(path.join(work, 'solver.py'), 'print(2)\n');
    fs.writeFileSync(path.join(work, 'result.json'), '{"answer":2}');
    fs.writeFileSync(path.join(work, 'execution.log'), 'self-reported local invocation');
    return { pdf: 'manuscript.pdf', source: 'solver.py', result: 'result.json', execution_log: 'execution.log' };
  };
  const filesA = makeSubmission(a.workspace), filesB = makeSubmission(b.workspace);
  assert.throws(() => blind.submit(args.root, 'original', { ...filesA, pdf: '../hidden/gold.json', usage: { wall_time_ms: 1, tool_calls: 1, cost: 0 } }), /相对路径/);
  const subA = blind.submit(args.root, 'original', { ...filesA, usage: { wall_time_ms: 1001, tool_calls: 6, cost: 1.6 } });
  const subB = blind.submit(args.root, 'skill', { ...filesB, usage: { wall_time_ms: 800, tool_calls: 4, cost: 1.2 } });
  assert.equal(subA.budget_overrun, true); assert.equal(subB.budget_overrun, false);
  assert.equal(subA.execution_verified, false);
  assert.match(path.basename(subA.packet), /^P[A-F0-9]{24}\.pdf$/);
  assert(!path.basename(subA.packet).includes('original'));
  const assessment = { reviewer_id: 'external-reviewer-1', reviewer_kind: 'human',
    hard: { constraints: 'pass', numerical: 'unknown', reproducibility: 'unknown' },
    paper: { coverage: 4, model: 3, innovation: 2, boundary: 3, communication: 5 }, notes: 'Synthetic fixture only; no paper judged.' };
  assert.throws(() => blind.review(args.root, subB.anon, { ...assessment, reviewer_id: 'solver-original' }), /独立/);
  assert.equal(blind.review(args.root, subB.anon, assessment).independence_verified, false);
  assert.throws(() => blind.review(args.root, subB.anon, assessment), /重复/);
  blind.review(args.root, subB.anon, { ...assessment, reviewer_id: 'external-reviewer-2',
    hard: { constraints: 'fail', numerical: 'pass', reproducibility: 'unknown' },
    paper: { ...assessment.paper, coverage: 5, model: 1 } });
  let r = blind.report(args.root);
  assert.equal(r.status, 'rehearsal'); assert.equal(r.blind_evaluation, false);
  assert.equal(r.arms.find(x => x.arm === 'original').status, 'over_budget');
  const rated = r.arms.find(x => x.arm === 'skill');
  assert.equal(rated.status, 'hard_failed', 'a high mean must not swallow a hard failure');
  assert.equal(rated.review_summary.hard.constraints.pass, 1);
  assert.equal(rated.review_summary.hard.constraints.fail, 1);
  assert.equal(rated.review_summary.hard.numerical.unknown, 1);
  assert.equal(rated.review_summary.paper.coverage.mean, 4.5);
  assert.deepEqual([rated.review_summary.paper.model.min, rated.review_summary.paper.model.max], [1, 3]);
  assert.equal(rated.review_summary.reviewer_disagreement, true);
  assert.equal(rated.review_summary.hard_checks_clear, false);
  assert.equal(rated.review_summary.valid_ranking, false);
  assert.equal(r.arms.find(x => x.arm === 'original').review_summary.status, 'missing');
  assert.equal(r.arms.find(x => x.arm === 'plugin').status, 'not_started');
  if (process.env.XIHE_BLIND_EVIDENCE_DIR) {
    const auditRoot = path.join(path.resolve(__dirname, '..'), 'audit');
    const target = path.resolve(process.env.XIHE_BLIND_EVIDENCE_DIR);
    assert(target.startsWith(auditRoot + path.sep), 'evidence path must stay under app/audit');
    const dest = path.join(target, 'synthetic-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'rehearsal-report.json'), JSON.stringify(r, null, 2));
    fs.copyFileSync(path.join(args.root, 'custodian', 'state.json'), path.join(dest, 'synthetic-custodian-state.json'));
    fs.mkdirSync(path.join(dest, 'anonymous-packets'));
    for (const sub of [subA, subB]) fs.copyFileSync(sub.packet, path.join(dest, 'anonymous-packets', path.basename(sub.packet)));
    fs.writeFileSync(path.join(dest, 'README.txt'), 'SYNTHETIC REHEARSAL ONLY. Fake PDF fixture, placeholder version manifests and simulated reviewer entries. No model run, independent human review, real baseline/plugin comparison or sealed contest result.\n');
    console.log('Synthetic rehearsal evidence:', dest);
  }
  fs.appendFileSync(path.join(b.workspace, 'result.json'), '\nchanged');
  assert.equal(blind.report(args.root).arms.find(x => x.arm === 'skill').status, 'stale');
  fs.writeFileSync(path.join(b.workspace, 'result.json'), '{"answer":2}');
  fs.appendFileSync(runtime.skill, '\nchanged');
  assert(blind.report(args.root).issues.some(x => /skill runtime 原版本已改变/.test(x)));
  fs.writeFileSync(runtime.skill, 'same app with replaced skill');
  fs.appendFileSync(path.join(root, 'hidden', 'gold.json'), '\nchanged');
  assert.equal(blind.report(args.root).issues.length, 0, 'original source no longer participates after sealed copy');
  fs.appendFileSync(path.join(args.root, 'custodian', 'hidden', 'gold.json'), '\nchanged');
  assert.match(blind.report(args.root).issues.join(' '), /隐藏材料已改变/);
  const unavailable = blind.prepare({ ...args, root: path.join(root, 'case_partial'), case_id: 'synthetic-002',
    arms: { original: {}, skill: args.arms.skill, plugin: {} } });
  assert.equal(unavailable.arms.find(x => x.arm === 'original').status, 'unavailable');
  assert.equal(unavailable.arms.find(x => x.arm === 'plugin').status, 'unavailable');
  assert.throws(() => blind.allocate(path.join(root, 'case_partial'), 'plugin'), /不可用/);
  const partialWork = blind.allocate(path.join(root, 'case_partial'), 'skill').workspace;
  const partialSubmission = blind.submit(path.join(root, 'case_partial'), 'skill', { ...makeSubmission(partialWork), usage: { wall_time_ms: 500, tool_calls: 2, cost: 0.5 } });
  for (const who of ['synthetic-reader-1', 'synthetic-reader-2']) blind.review(path.join(root, 'case_partial'), partialSubmission.anon, {
    ...assessment, reviewer_id: who, paper: { coverage: 5, model: 5, innovation: 5, boundary: 5, communication: 5 } });
  const partialReport = blind.report(path.join(root, 'case_partial'));
  assert.equal(partialReport.arms.find(x => x.arm === 'skill').status, 'hard_unknown');
  assert.equal(partialReport.arms.find(x => x.arm === 'skill').review_summary.paper.coverage.mean, 5);
  assert.equal(partialReport.arms.find(x => x.arm === 'skill').review_summary.hard_checks_clear, false);
  assert.equal(partialReport.arms.find(x => x.arm === 'skill').review_summary.valid_ranking, false);
  const formal = blind.prepare({ ...args, root: path.join(root, 'case_formal'), case_id: 'synthetic-003', mode: 'sealed' });
  assert.equal(formal.status, 'needs_input'); assert.equal(formal.blind_evaluation, false);
  console.log('PASS blind-eval tooling: separate visible/hidden, archived arms, budgets, anonymous packets, source staleness, review gaps, rehearsal and unverified formal state');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('xihe-blind-eval-test-'));
  fs.rmSync(root, { recursive: true, force: true });
}
