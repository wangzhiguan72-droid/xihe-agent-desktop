'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { executeTool } = require('./tools');
const { Sandbox } = require('./sandbox');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-iteration-proof-'));
const evaluation = { kind: 'analytical', question_id: 1, statement: 'A的加权时间低于B当且仅当p>4/7', domain: 'p为东区订单比例，0<=p<=1，时间矩阵固定' };
const independence = '有理数独立复算；共用题给时间矩阵；排除阈值与不等号实现错误；仍可能共有题意解释错误。';
const review_boundary = '推导给出线性差8-14p；有理数检查阈值两边及相等点。有限检查不证明任意非线性变体。';
const tool = (ctx, op, args = {}) => executeTool(ctx, 'iteration', { op, id: 'I1', ...args });
(async () => {
  const appDir = path.join(root, 'app'); fs.mkdirSync(appDir);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const ctx = { workspace, sandbox: new Sandbox(workspace), appDir, settings: {}, children: new Set(),
    session: { data_epoch: 0, assumptions: [{ id: 'A1', kind: 'parameter_estimate', status: 'open' }],
      question_graph: [{ id: 1, status: 'committed' }] } };
  fs.writeFileSync(path.join(workspace, 'derivation.md'), 'A=14-10p，B=6+4p。A-B=8-14p；A<B iff p>4/7。定义域p∈[0,1]。');
  await tool(ctx, 'plan', { assumption_ids: ['A1'], change: '用条件性阈值替代臆定订单比例', criterion: { success: '线性差推导并独立核查阈值', evaluation } });
  const proof = { derivation_path: 'derivation.md', check_run_id: 'fake', review_boundary };
  await tool(ctx, 'result', { verdict: 'supported', proof, independence });
  assert.equal(ctx.session.iterations[0].status, 'undecided');
  await assert.rejects(() => tool(ctx, 'adopt', { independence }));

  const script = [
    'import json, hashlib', 'from fractions import Fraction', 'from pathlib import Path',
    'a=lambda p:4*p+14*(1-p)', 'b=lambda p:10*p+6*(1-p)',
    'threshold=Fraction(4,7)', 'assert a(threshold)==b(threshold)',
    'assert a(Fraction(0))>b(Fraction(0))', 'assert a(Fraction(1))<b(Fraction(1))',
    'assert a(Fraction(13,20))==Fraction(15,2)', 'assert b(Fraction(13,20))==Fraction(43,5)',
    'out='+JSON.stringify({ checks_passed: 1, question_id: evaluation.question_id, statement: evaluation.statement, domain: evaluation.domain }),
    "out['derivation_sha256']=hashlib.sha256(Path('derivation.md').read_bytes()).hexdigest()",
    "Path('checks.json').write_text(json.dumps(out), encoding='utf-8')",
  ].join('\n');
  fs.writeFileSync(path.join(workspace, 'check.py'), script);
  await executeTool(ctx, 'verification_run', { script: 'check.py', inputs: ['derivation.md'], result: 'checks.json', timeout_sec: 30 });
  const receipt = ctx.session.verification_runs.at(-1);
  assert.equal(receipt.ok, true, JSON.stringify(receipt)); proof.check_run_id = receipt.run_id;
  await tool(ctx, 'result', { verdict: 'supported', proof, independence });
  assert.equal(ctx.session.iterations[0].status, 'ran');
  assert.match(ctx.session.iterations[0].result.evidence.limitation, /不等于通用数学证明/);

  // Every artifact or receipt change must block adoption before mutating the graph/epoch.
  for (const rel of ['derivation.md', receipt.script_source.rel, receipt.script.rel, receipt.result.rel, receipt.log.rel]) {
    const abs = path.join(workspace, rel); const original = fs.readFileSync(abs);
    fs.appendFileSync(abs, '\nchanged');
    await assert.rejects(() => tool(ctx, 'adopt', { independence }));
    assert.equal(ctx.session.data_epoch, 0); assert.equal(ctx.session.question_graph[0].status, 'committed');
    fs.writeFileSync(abs, original);
  }
  ctx.session.data_epoch = 1;
  await assert.rejects(() => tool(ctx, 'adopt', { independence }));
  ctx.session.data_epoch = 0;
  await tool(ctx, 'adopt', { independence });
  assert.equal(ctx.session.iterations[0].status, 'adopted');
  assert.equal(ctx.session.data_epoch, 1);
  console.log('PASS analytical iteration: guarded rational threshold check, missing receipt, artifact/epoch expiry, bounded claim');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('xihe-iteration-proof-'));
  fs.rmSync(root, { recursive: true, force: true });
});
