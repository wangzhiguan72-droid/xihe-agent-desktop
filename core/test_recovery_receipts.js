'use strict';
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), os = require('os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-recovery-receipts-'));
(async () => {
try {
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, 'findings'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'data'));
  fs.writeFileSync(path.join(workspace, 'data/input.json'), '{"n":128}');
  const report = '已验证结果，报告已写入。';
  fs.writeFileSync(path.join(workspace, 'findings/result.md'), report);
  const agent = require('./agent'), recovery = require('./recovery');
  const session = { data_epoch: 0, runs: [{ run_id: 'run1', epoch: 0, ok: true, unstable: false, out: 'verified=true', input_hash: agent.inputStampHash(agent.stampInputFiles(workspace)) }],
    last_error: { reason: 'interrupted final reply' }, messages: [
      { role: 'assistant', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'findings/result.md', content: report }) } }] },
      { role: 'tool', tool_call_id: 'write', content: '已写入 report（1KB）' },
    ] };
  assert.match(recovery.recoveryPrompt(session, { workspace }), /已核验未变化的报告/);
  assert.match(recovery.recoveryPrompt(session, { workspace }), /只缺最终说明/);
  fs.appendFileSync(path.join(workspace, 'findings/result.md'), ' changed');
  assert.doesNotMatch(recovery.recoveryPrompt(session, { workspace }), /已核验未变化的报告/);
  fs.writeFileSync(path.join(workspace, 'findings/result.md'), report);
  fs.writeFileSync(path.join(workspace, 'data/input.json'), '{"n":129}');
  assert.doesNotMatch(recovery.recoveryPrompt(session, { workspace }), /已核验未变化的报告/);
  fs.writeFileSync(path.join(workspace, 'data/input.json'), '{"n":128}');
  session.runs[0].input_hash = agent.inputStampHash(agent.stampInputFiles(workspace));
  assert.match(recovery.recoveryPrompt(session, { workspace }), /已核验未变化的报告/, 'restore a valid baseline before testing missing acknowledgements');
  const noAck = { ...session, messages: session.messages.slice(0, 1) };
  assert.doesNotMatch(recovery.recoveryPrompt(noAck, { workspace }), /已核验未变化的报告/);
  const unknownWrite = { ...session, messages: [...session.messages, {
    role: 'assistant', tool_calls: [{ id: 'unacknowledged', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'findings/result.md', content: 'new report' }) } }],
  }] };
  assert.doesNotMatch(recovery.recoveryPrompt(unknownWrite, { workspace }), /已核验未变化的报告/, 'a newer unacknowledged write cannot reuse an older receipt');
  assert.doesNotMatch(recovery.recoveryPrompt(session), /已核验未变化的报告/, 'no workspace means no freshness proof');
  const outside = path.join(root, 'outside.md'); fs.writeFileSync(outside, report);
  fs.symlinkSync(outside, path.join(workspace, 'findings/linked.md'), 'file');
  const escaped = { ...session, messages: [
    { role: 'assistant', tool_calls: [{ id: 'write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'findings/linked.md', content: report }) } }] },
    { role: 'tool', tool_call_id: 'write', content: '已写入 linked' },
  ] };
  assert.doesNotMatch(recovery.recoveryPrompt(escaped, { workspace }), /已核验未变化的报告/);
  const tool = require('./tools').TOOLS.find(t => t.name === 'memory_audit');
  assert(!tool.desc.includes('任务收尾必跑一次'));
  assert.match(tool.desc, /空库.*不.*扫描/);
  const finish = require('./tools').TOOLS.find(t => t.name === 'contest_clock');
  const acceptance = require('./acceptance'), blockers = acceptance.deliveryBlockers;
  const finalSession = { contest_phase: 'freeze' };
  const ctx = { session: finalSession, workspace };
  await assert.rejects(finish.run(ctx, { op: 'phase', phase: 'final' }), /还不能进入 final/);
  assert.equal(finalSession.contest_phase, 'freeze', 'scientific delivery blockers must still run first');
  try {
    acceptance.deliveryBlockers = () => [];
    const result = await finish.run(ctx, { op: 'phase', phase: 'final' });
    assert.match(result, /技术验收达成/);
    assert.doesNotMatch(result, /memory_audit|体检|做完再回复/, 'final must not inject another unconditional audit round');
    assert.equal(finalSession.memory_audited_at, undefined, 'a reminder is not a completed audit');
  } finally { acceptance.deliveryBlockers = blockers; }
  console.log('recovery receipts: current inputs, acknowledged report bytes, stale/escape rejection and conditional memory audit PASS');
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('xihe-recovery-receipts-'));
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch(e => { console.error(e); process.exitCode = 1; });
