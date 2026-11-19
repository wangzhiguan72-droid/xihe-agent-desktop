// 红队权限、报告对账与结项门禁离线测试。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const RT = require('./redteam');
const { executeTool, READ_ONLY, RED_EXTRA } = require('./tools');
const { Sandbox } = require('./sandbox');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '->', e.message); }
}
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.xihe-redteam-'));
const appDir = path.join(tmp, 'app');
const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(appDir, 'config'), { recursive: true });
fs.mkdirSync(ws, { recursive: true });
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
function writeReport(ws, report) {
  const dir = path.join(ws, 'findings', 'redteam');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
}
function baseReport(ws, exit = 1) {
  const script = path.join(ws, 'findings', 'redteam', 'A1_probe.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, 'print("probe")\n');
  const hash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex');
  return {
    claim: '参数变化后主结论仍成立', surface: 'A1', script: 'findings/redteam/A1_probe.py', script_hash: hash,
    cmd: 'python_run(exec A1_probe.py)', exit, verdict: exit !== 0 ? 'refuted' : 'held',
    counterexample: exit !== 0 ? 'k=0 时结论翻号' : '', repro: 'python_run(exec A1_probe.py)', severity: '致命',
    surfaces: RT.SURFACES.map(surface => ({ surface, attacked: surface === 'A1', reason: surface === 'A1' ? '' : '本题不适用', result: surface === 'A1' ? '已构造反例' : '' })),
  };
}
function ctxFor(ws) {
  return {
    appDir, workspace: ws, sandbox: new Sandbox(ws, { protected: [appDir] }),
    settings: {}, session: { runs: [] }, children: new Set(), pyMode: 'redteam', redteamOnly: true,
    allowTools: new Set([...READ_ONLY, ...RED_EXTRA]),
  };
}
(async () => {
  await t('红队报告：脚本hash、七面清单和引擎退出码一致才通过', async () => {
    const session = { child_runs: [{ profile: 'redteam', tool: 'python_run', out: 'exit=1\n--- stdout ---\nprobe', formal: false }] };
    writeReport(ws, baseReport(ws, 1));
    const v = RT.validateRedteamReport(session, ws);
    if (!v.ok) throw new Error(v.issues.join('；'));
    const fin = RT.finalizeRedteam(session, ws);
    if (!fin.ok || fin.row.status !== 'open' || RT.redteamBlockers(session).length !== 1) throw new Error('致命发现未进入提交门禁');
    const waived = await executeTool({ session }, 'iteration', { op: 'waive', redteam_id: fin.id, reason: '仅在域外出现，论文明确限定适用范围' });
    if (!waived.ok || RT.redteamBlockers(session, { final: true }).length !== 0) throw new Error('iteration waive 后仍未结项');
  });

  await t('红队报告：声称退出码与引擎不一致会拒绝', async () => {
    const session = { child_runs: [{ profile: 'redteam', tool: 'python_run', out: 'exit=0\n--- stdout ---\nheld', formal: false }] };
    writeReport(ws, baseReport(ws, 1));
    const v = RT.validateRedteamReport(session, ws);
    if (v.ok || !v.issues.some(x => /退出码对账失败/.test(x))) throw new Error('退出码造假未检出: ' + v.issues.join('；'));
  });

  await t('红队写盘：fs 与 formal 在执行层拒绝越界', async () => {
    const ctx = ctxFor(ws);
    const bad = await executeTool(ctx, 'fs_write', { path: 'evil.txt', content: 'x' });
    if (bad.ok || !/findings\/redteam/.test(bad.error)) throw new Error('fs 越界未拒绝');
    const good = await executeTool(ctx, 'fs_write', { path: 'findings/redteam/probe.txt', content: 'x' });
    if (!good.ok) throw new Error('红队目录内写入被误拒: ' + good.error);
    const formal = await executeTool(ctx, 'python_run', { code: 'print(1)', formal: true });
    if (formal.ok || !/禁止 formal/.test(formal.error)) throw new Error('红队探针混入 formal 证据链');
  });

  await t('红队 Python 守卫：目录内可写，工作区其他位置不可写', async () => {
    const ctx = ctxFor(ws);
    const inside = await executeTool(ctx, 'python_run', { code: "open('findings/redteam/py_inside.txt','w',encoding='utf-8').write('ok')", intermediate_artifact: true });
    if (!inside.ok) throw new Error('目录内 Python 写失败: ' + String(inside.data || inside.error).slice(0, 300));
    const outside = await executeTool(ctx, 'python_run', { code: "open('py_evil.txt','w').write('x')", intermediate_artifact: true });
    if (outside.ok || !/羲和守卫|PermissionError/.test(String(outside.data || outside.error))) throw new Error('Python 绕过目录限制');
    if (fs.existsSync(path.join(ws, 'py_evil.txt'))) throw new Error('越界文件实际被写入');
  });

  await t('缺报告也会形成未结项，不能当作红队已完成', async () => {
    const ws2 = path.join(tmp, 'missing');
    fs.mkdirSync(ws2, { recursive: true });
    const session = {};
    const fin = RT.finalizeRedteam(session, ws2);
    if (fin.ok || RT.redteamBlockers(session).length !== 1) throw new Error('缺报告未形成阻塞');
  });
  await t('红队致命未结项实际阻断 question_graph.commit', async () => {
    const mk = () => ({ mode: 'free', data_epoch: 0,
      runs: [{ run_id: 'run1', ok: true, formal: true, unstable: false, epoch: 0, out: '42' }],
      question_graph: [{ id: 1, status: 'reviewing', deps: [], experiments: ['run1'], artifacts: [{ path: 'findings/redteam/probe.txt' }] }],
      redteam: [{ id: 'R9', severity: '致命', surface: 'A1', status: 'open', resolved: false }] });
    const blocked = mk();
    let denied = false;
    try { await executeTool({ session: blocked, workspace: ws }, 'question_graph', { op: 'commit', id: 1 }); }
    catch (e) { denied = /红队有 1 条致命发现未结项/.test(e.message); }
    if (!denied) throw new Error('commit 未被红队发现阻断');
    blocked.redteam[0].resolved = true;
    const ok = await executeTool({ session: blocked, workspace: ws }, 'question_graph', { op: 'commit', id: 1 });
    if (!ok.ok || blocked.question_graph[0].status !== 'committed') throw new Error('结项后仍误阻 commit');
  });
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
