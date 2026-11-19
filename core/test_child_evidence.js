// 跨会话真实 run 显式接收与输入指纹门禁。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeTool } = require('./tools');
const { stampInputFiles, inputStampHash, checkNumericEvidence } = require('./agent');
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '->', e.message); }
}
const ws = fs.mkdtempSync(path.join(os.homedir(), '.xihe-child-evidence-'));
process.on('exit', () => { try { fs.rmSync(ws, { recursive: true, force: true }); } catch {} });
function child(id, hash, extra = {}) {
  return { child_run_id: id, profile: 'child_session', origin_session_id: 'child1', origin_run_id: 'run9', tool: 'python_run', ok: true,
    formal: true, unstable: false, epoch: 0, input_hash: hash, out: '计算结果 value=42.00', model: 'test', sig: 'abc', ms: 12, ...extra };
}
(async () => {
  await t('子会话formal run：指纹一致时显式接收为父run', async () => {
    fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'scripts', 'a.py'), 'print(42)\n');
    const hash = inputStampHash(stampInputFiles(ws));
    const session = { data_epoch: 0, runs: [], question_graph: [{ id: 1, experiments: [] }], child_runs: [child('subrun1', hash)] };
    const ctx = { session, workspace: ws };
    const r = await executeTool(ctx, 'question_graph', { op: 'link_run', id: 1, run_id: 'subrun1' });
    if (!r.ok || !/显式接收/.test(r.data)) throw new Error(String(r.data || r.error));
    if (session.runs.length !== 1 || !session.runs[0].origin || session.runs[0].input_hash !== hash) throw new Error('父run缺少来源或指纹');
    if (session.question_graph[0].experiments[0] !== session.runs[0].run_id) throw new Error('问题未链接新父run');
    const ev = checkNumericEvidence('计算结果为 42.00。', session);
    if (ev.missing.length) throw new Error('接收后的真实run仍不能核验: ' + JSON.stringify(ev.missing));
    const view = await executeTool(ctx, 'question_graph', { op: 'runs_view' });
    if (!/child_runs 候选/.test(view.data)) throw new Error('runs_view 未展示child候选');
  });

  await t('子会话run：代码变化、非formal、红队与文字报告均拒绝接收', async () => {
    const oldHash = inputStampHash(stampInputFiles(ws));
    fs.appendFileSync(path.join(ws, 'scripts', 'a.py'), '# changed\n');
    const session = { data_epoch: 0, runs: [], question_graph: [{ id: 1, experiments: [] }], child_runs: [
      child('subrun_old', oldHash), child('subrun_informal', oldHash, { formal: false }),
      child('subrun_red', oldHash, { profile: 'redteam' }), child('subrun_text', oldHash, { tool: null }),
    ] };
    for (const [id, pattern] of [['subrun_old', /指纹/], ['subrun_informal', /formal/], ['subrun_red', /红队/], ['subrun_text', /文字报告|真实计算/]]) {
      let denied = false;
      try { await executeTool({ session, workspace: ws }, 'question_graph', { op: 'link_run', id: 1, run_id: id }); }
      catch (e) { denied = pattern.test(e.message); }
      if (!denied) throw new Error(id + ' 未被正确拒绝');
    }
    if (session.runs.length !== 0) throw new Error('拒绝路径仍写入父runs');
  });
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
