'use strict';
// Acceptance state is exercised in a disposable workspace. Full-delivery state below
// represents already completed audits; this test does not claim scientific validation.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Sandbox } = require('./sandbox');
const { TOOLS } = require('./tools');
const { sha256, verifyZip, manifestTex } = require('./support_integrity');
const { PAPER_QUALITY_VERSION } = require('./contest_quality');
const { createSnapshot, paperInputs } = require('./review_snapshot');
const { deliveryBlockers, sessionAcceptance, finishTask, completionBlockers, createRelease } = require('./acceptance');
const { auditPolicy, supportPolicy } = require('./contest_workflows');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-acceptance-state-'));
const root = path.join(temp, 'project');
const appDir = path.join(temp, 'app');
fs.mkdirSync(root);
fs.mkdirSync(appDir);
const put = (rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return { rel, sha256: sha256(abs) };
};
const context = session => ({ workspace: root, appDir, session, sandbox: new Sandbox(root), settings: {},
  children: new Set(), abort: new AbortController(), emit: () => {}, spend: () => {}, trackVision: () => {} });
const blockers = s => deliveryBlockers(root, s).join('；');

(async () => {
  try {
    const empty = { contest_kind: 'generic', task_scope: 'delivery', contest_rules: { source: '合成夹具规范', profile: 'generic-test' } };
    assert(blockers(empty).length > 0, 'empty delivery must not pass');
    assert.equal(sessionAcceptance(root, empty).can_freeze, false);
    assert.throws(() => createRelease(context(empty)), /交付尚未就绪/);

    put('paper/main.tex', '\\section{稿件}\n初稿。\n');
    const report = put('findings/reviews/review.md', '已检查当前稿件；此处仅记录审稿范围。');
    const readme = put('README.md', '项目简介不能代替审稿报告。');
    const oldReportTime = new Date(Date.now() - 10_000);
    fs.utimesSync(path.join(root, report.rel), oldReportTime, oldReportTime);
    const review = { contest_kind: 'generic', task_scope: 'review' };
    assert.equal(sessionAcceptance(root, review).stages.find(x => x.id === 'paper').state, 'not_required');
    assert.deepEqual(completionBlockers(root, review), ['当前任务范围尚未验收']);
    assert.throws(() => finishTask(context(review), { summary: '完成本稿审阅', artifacts: [report.rel] }), /review_snapshot/);
    review.review_snapshot = createSnapshot(context(review), { kind: 'review', files: ['paper/main.tex'] });
    assert.throws(() => finishTask(context(review), { summary: '完成本稿审阅', artifacts: [readme.rel] }), /findings\/reviews/);
    assert.throws(() => finishTask(context(review), { summary: '完成本稿审阅', artifacts: [report.rel] }), /建立快照后/);
    const justBeforeSnapshot = new Date(review.review_snapshot.at - 200);
    fs.utimesSync(path.join(root, report.rel), justBeforeSnapshot, justBeforeSnapshot);
    assert.throws(() => finishTask(context(review), { summary: '完成本稿审阅', artifacts: [report.rel] }), /建立快照后/);
    put(report.rel, '已检查当前快照稿件；此处仅记录审稿范围。');
    finishTask(context(review), { summary: '完成当前版本审阅；科学结论尚待作者核实', artifacts: [report.rel] });
    assert.deepEqual(completionBlockers(root, review), []);
    assert.equal(sessionAcceptance(root, review).scoped_complete, true);
    fs.appendFileSync(path.join(root, report.rel), '\n报告修订');
    assert(completionBlockers(root, review).length > 0, 'edited report expires task completion');
    put(report.rel, '已检查当前快照稿件；此处仅记录审稿范围。');
    assert.deepEqual(completionBlockers(root, review), []);
    fs.appendFileSync(path.join(root, 'paper/main.tex'), '\n稿件修订');
    assert(completionBlockers(root, review).length > 0, 'edited reviewed source expires snapshot');

    const blind = { contest_kind: 'generic', task_scope: 'blind', data_epoch: 0, runs: [] };
    put('data/in.json', '{"value":3}');
    put('scripts/solve.py', [
      'import json', 'from pathlib import Path',
      "value = json.loads(Path('data/in.json').read_text(encoding='utf-8'))['value']",
      "out = Path('outputs/blind.json')", 'out.parent.mkdir(exist_ok=True)',
      "out.write_text(json.dumps({'score': value * 2}), encoding='utf-8')",
    ].join('\n'));
    put('findings/blind.md', '盲测报告：当前结果 6。');
    assert.equal(sessionAcceptance(root, blind).stages.find(x => x.id === 'paper').state, 'not_required');
    assert.throws(() => finishTask(context(blind), { summary: '完成独立计算', artifacts: ['scripts/solve.py', 'findings/blind.md'] }), /真实成功计算记录/);
    const verify = TOOLS.find(tool => tool.name === 'verification_run');
    assert(verify);
    await verify.run(context(blind), { script: 'scripts/solve.py', inputs: ['data/in.json'], result: 'outputs/blind.json', timeout_sec: 30 });
    assert.equal(blind.verification_runs.at(-1).ok, true, 'blind test needs a real host run receipt');
    const blindResult = blind.verification_runs.at(-1).result.rel;
    put('paper/blind.pdf', '%PDF-1.4\nblind fixture\n');
    assert.throws(() => finishTask(context(blind), { summary: '完成独立计算', artifacts: ['scripts/solve.py', 'paper/blind.pdf', 'findings/blind.md'] }), /机器结果和实际源码/);
    assert.throws(() => finishTask(context(blind), { summary: '完成独立计算', artifacts: [blindResult, 'paper/blind.pdf', 'findings/blind.md'] }), /机器结果和实际源码/);
    finishTask(context(blind), { summary: '完成当前输入的独立计算，未进行整题交付', artifacts: ['scripts/solve.py', blindResult, 'findings/blind.md'] });
    assert.deepEqual(completionBlockers(root, blind), []);
    assert.equal(sessionAcceptance(root, blind).scoped_complete, true);
    fs.appendFileSync(path.join(root, 'scripts/solve.py'), '# changed\n');
    assert(completionBlockers(root, blind).length > 0, 'changed blind source expires completion');

    // Restore the paper and source so the full-delivery fixture begins with current files.
    put('paper/main.tex', '\\section{稿件}\n初稿。\n');
    put('scripts/solve.py', [
      'import json', 'from pathlib import Path',
      "value = json.loads(Path('data/in.json').read_text(encoding='utf-8'))['value']",
      "out = Path('outputs')", 'out.mkdir(exist_ok=True)',
      "(out / 'result.json').write_text(json.dumps({'score': value * 2}), encoding='utf-8')",
      "(out / 'table.csv').write_text('id,score\\ncase,6\\n', encoding='utf-8')",
    ].join('\n'));
    put('outputs/result.json', '{"score":6}');
    put('outputs/table.csv', 'id,score\ncase,6\n');
    put('paper/chapters/results.tex', '结果章节。\n');
    put('paper/figures/plot.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    put('paper/main.pdf', '%PDF-1.4\nsynthetic prior build fixture\n');
    const manifest = put('findings/support_manifest.tex', manifestTex(['scripts/solve.py']));
    const source = path.join(root, 'scripts/solve.py');
    const supportRow = { rel: 'scripts/solve.py', bytes: fs.statSync(source).size, sha256: sha256(source) };
    const zip = path.join(root, 'support.zip');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath $env:XIHE_TEST_INPUT -DestinationPath $env:XIHE_TEST_ZIP -Force'],
    { env: { ...process.env, XIHE_TEST_INPUT: path.join(root, 'scripts'), XIHE_TEST_ZIP: zip } });
    const full = { mode: 'math', contest_kind: 'generic', task_scope: 'delivery', contest_phase: 'final',
      contest_rules: { source: '合成夹具规范', profile: 'generic-test' },
      question_graph: [{ id: 1, status: 'committed', artifacts: ['outputs/result.json'] }],
      runs: [{ ok: true, unstable: false, epoch: 0 }], data_epoch: 0,
      source_files: ['scripts/solve.py'], review_findings: [] };
    const checked = await verifyZip(zip, [supportRow], supportPolicy(full));
    assert.deepEqual(checked.entries, [supportRow.rel]);
    full.support_pack = { verified: true, must_fix: 0, zip: 'support.zip', zip_sha256: sha256(zip),
      manifest_sha256: manifest.sha256, entries: [supportRow], size_policy: supportPolicy(full) };
    const tex = path.join(root, 'paper/main.tex'), pdf = path.join(root, 'paper/main.pdf');
    full.paper_audit = { at: Date.now(), must_fix: 0, tex_path: 'paper/main.tex', pdf_path: 'paper/main.pdf',
      tex_sha256: sha256(tex), pdf_sha256: sha256(pdf), inputs: paperInputs(root, 'paper/main.tex'),
      audit_policy: auditPolicy(full), paper_contract_version: PAPER_QUALITY_VERSION };
    full.abstract_check = { at: Date.now(), must_fix: 0, src: 'paper/main.tex', sha256: full.paper_audit.tex_sha256.slice(0, 16) };
    const reproTool = TOOLS.find(tool => tool.name === 'repro_check');
    assert(reproTool);
    await reproTool.run(context(full), { script: 'scripts/solve.py', results: ['outputs/result.json', 'outputs/table.csv'], timeout_sec: 30 });
    assert.equal(full.repro_check.pass, true, JSON.stringify(full.repro_check));
    assert.deepEqual(deliveryBlockers(root, full), [], blockers(full));
    assert.equal(sessionAcceptance(root, full).can_freeze, true);
    const first = createRelease(context(full));
    assert.equal(first.kind, 'release');
    assert.deepEqual(sessionAcceptance(root, full).release.issues, []);
    assert.equal(sessionAcceptance(root, full).released, true);
    for (const rel of ['paper/main.pdf', 'paper/main.tex', 'support.zip']) {
      const row = first.files.find(file => file.rel === rel);
      assert(row, `release omitted ${rel}`);
      assert.equal(sha256(path.join(root, row.copy_rel)), sha256(path.join(root, rel)));
    }
    const oldSubmission = put('submission/older.txt', 'prior submission must remain');
    const second = createRelease(context(full));
    assert.notEqual(first.id, second.id, 'new release must use a fresh snapshot');
    assert.equal(fs.readFileSync(path.join(root, oldSubmission.rel), 'utf8'), 'prior submission must remain');
    assert(fs.existsSync(path.join(root, first.manifest.rel)), 'older release remains');
    for (const rel of ['paper/chapters/results.tex', 'paper/figures/plot.svg', 'support.zip', 'paper/main.pdf']) {
      const original = fs.readFileSync(path.join(root, rel));
      fs.appendFileSync(path.join(root, rel), '\nchanged');
      assert.equal(sessionAcceptance(root, full).released, false, `${rel} must expire release`);
      assert.throws(() => createRelease(context(full)), /交付尚未就绪/, `${rel} must block another freeze`);
      fs.writeFileSync(path.join(root, rel), original);
      assert.deepEqual(deliveryBlockers(root, full), [], `restored ${rel} did not recover`);
    }
    console.log('acceptance state: scoped completion, audited fixture release, expiry PASS');
  } finally {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'unsafe cleanup parent');
    assert(path.basename(resolved).startsWith('xihe-acceptance-state-'), 'unsafe cleanup name');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
