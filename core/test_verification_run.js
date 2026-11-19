'use strict';
// Real guarded Python execution in a throwaway project; no model or account access.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TOOLS } = require('./tools');
const { Sandbox } = require('./sandbox');
const { sha256 } = require('./support_integrity');
const { receiptBlockers } = require('./verification_run');
const { verificationBlockers } = require('./independent_verification');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-verification-run-'));
const root = path.join(temp, 'project');
const appDir = path.join(temp, 'app');
fs.mkdirSync(root);
fs.mkdirSync(appDir);
const put = (rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { rel: rel.replace(/\\/g, '/'), sha256: sha256(abs) };
};
const metricContext = value => ({ value, unit: '比例', definition: '覆盖率', denominator: '同一批样本', time_origin: '起报时刻' });

(async () => {
  try {
    const script = put('scripts/replica.py', [
      'import json',
      'from pathlib import Path',
      "inp = json.loads(Path('inputs/input.json').read_text(encoding='utf-8'))",
      "out = Path('outputs/result.json')",
      'out.parent.mkdir(parents=True, exist_ok=True)',
      "out.write_text(json.dumps({'score': inp['baseline'] - 0.0001}), encoding='utf-8')",
      "print('replica completed')",
    ].join('\n'));
    const sourceInput = put('inputs/input.json', '{"baseline":0.905}');
    const paper = put('paper/main.tex', '正文：主解覆盖率 0.905，独立复算另列。');
    const sourceResult = put('outputs/main.json', '{"score":0.905}');
    const session = { contest_kind: 'mathorcup-bigdata', task_scope: 'delivery' };
    const ctx = { workspace: root, sandbox: new Sandbox(root), appDir, session,
      settings: {}, children: new Set() };
    const verificationRun = TOOLS.find(tool => tool.name === 'verification_run');
    assert(verificationRun);
    assert.match(verificationBlockers(root, session, { final: true }).join('；'), /尚未登记执行证据/);
    for (const scope of ['review', 'blind']) {
      assert.deepEqual(verificationBlockers(root, { ...session, task_scope: scope }, { final: true }), []);
    }

    const toolOutput = await verificationRun.run(ctx, {
      script: script.rel, inputs: [sourceInput.rel], result: 'outputs/result.json', timeout_sec: 30,
    });
    assert.match(toolOutput, /\[verification_run\]/);
    assert.equal(session.verification_runs.length, 1, 'tool must persist the host receipt');
    const receipt = session.verification_runs[0];
    assert.match(receipt.run_id, /^verify_[a-f0-9]{20}$/);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.exit_code, 0);
    assert.deepEqual(receiptBlockers(root, receipt), []);
    assert.equal(receipt.script_source.rel, script.rel);
    assert.equal(receipt.script_source.sha256, script.sha256);
    assert.equal(receipt.inputs[0].rel, sourceInput.rel);
    assert.equal(receipt.copied_inputs[0].sha256, sourceInput.sha256);
    assert.notEqual(receipt.script.rel, receipt.script_source.rel, 'script must run from a fresh copy');
    assert.match(receipt.script.rel, new RegExp(`^verification_runs/${receipt.run_id}/`));
    assert.equal(sha256(path.join(root, receipt.result.rel)), receipt.result.sha256);
    assert.equal(sha256(path.join(root, receipt.log.rel)), receipt.log.sha256);
    assert.match(fs.readFileSync(path.join(root, receipt.log.rel), 'utf8'), /replica completed/);
    const replicaValue = JSON.parse(fs.readFileSync(path.join(root, receipt.result.rel), 'utf8')).score;
    const metric = { id: 'score', source: metricContext(0.905), replica: metricContext(replicaValue),
      tolerance: { absolute: 0.001 }, classification: 'match' };
    const verification = { schema_version: 2, paper, source_result: sourceResult,
      files: [{ ...receipt.script, kind: 'script' }, { ...receipt.result, kind: 'result' }],
      provenance: { independent_implementation: true, target_answer_blind: true,
        execution: { status: 'succeeded', exit_code: 0, run_id: receipt.run_id,
          script_rel: receipt.script.rel, result_rel: receipt.result.rel } },
      metrics: [metric] };
    session.independent_verification = verification;
    assert.deepEqual(verificationBlockers(root, session, { final: true }), []);

    const selfReported = structuredClone(verification);
    delete selfReported.provenance.execution.run_id;
    assert.match(verificationBlockers(root, { ...session, independent_verification: selfReported }, { final: true }).join('；'),
      /宿主成功运行回执|未绑定/);
    metric.tolerance = { absolute: 0.00001 };
    metric.classification = 'discrepancy';
    metric.resolution = { status: 'resolved', reason: '主解与复算数值存在差异，已在正文分别说明口径和限制', paper_sha256: paper.sha256 };
    assert.match(verificationBlockers(root, session, { final: true }).join('；'), /分歧尚未/,
      'a free-text resolution does not close a numerical discrepancy');
    const disclosure = put('paper/disclosure.tex', '独立复算为 0.9049，与主解相差 0.0001。');
    metric.resolution.disclosure = { ...disclosure, quote: '独立复算为 0.9049' };
    assert.deepEqual(verificationBlockers(root, session, { final: true }), []);
    fs.appendFileSync(path.join(root, disclosure.rel), '\n改写后须复核');
    assert.match(verificationBlockers(root, session, { final: true }).join('；'), /分歧尚未/);
    put(disclosure.rel, '独立复算为 0.9049，与主解相差 0.0001。');
    assert.deepEqual(verificationBlockers(root, session, { final: true }), []);
    fs.writeFileSync(path.join(root, sourceInput.rel), '{"baseline":0.5}', 'utf8');
    assert.match(receiptBlockers(root, receipt).join('；'), /哈希已变化/);
    assert.match(verificationBlockers(root, session, { final: true }).join('；'), /哈希已变化/);

    const secret = put('paper/secret.txt', 'FAKE-CANARY-OUTSIDE-ISOLATION');
    const escape = put('scripts/escape.py', [
      'from pathlib import Path',
      `Path(${JSON.stringify(path.join(root, secret.rel))}).read_text(encoding='utf-8')`,
      "Path('outputs/escape.json').write_text('{}', encoding='utf-8')",
    ].join('\n'));
    await verificationRun.run(ctx, { script: escape.rel, inputs: [], result: 'outputs/escape.json', timeout_sec: 30 });
    const denied = session.verification_runs.at(-1);
    assert.notEqual(denied.run_id, receipt.run_id, 'each execution gets a fresh identity');
    assert.equal(denied.ok, false, 'the isolated run must not read a project file absent from its input list');
    assert.notEqual(denied.exit_code, 0);
    assert.match(receiptBlockers(root, denied).join('；'), /缺宿主成功运行回执/);
    const deniedLog = fs.readFileSync(path.join(root, denied.log.rel), 'utf8');
    assert.match(deniedLog, /拒绝|越界|PermissionError/);
    assert.doesNotMatch(deniedLog, /FAKE-CANARY-OUTSIDE-ISOLATION/);
    console.log('verification run: guarded execution, receipt, strict delivery and expiry PASS');
  } finally {
    const resolved = path.resolve(temp);
    const tempRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), tempRoot, 'unsafe test cleanup parent');
    assert(path.basename(resolved).startsWith('xihe-verification-run-'), 'unsafe test cleanup name');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
