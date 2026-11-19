// repro_check 的 MATLAB(.m) 分支端到端验证（用户指定：此前宣称"没真跑过"）。
// 正题用真实 matlab -batch 跑两遍：
//   ① 正确脚本 → 必须 pass（证明 .m 分支真能跑通，不是摆设）
//   ② 把算法改错 → 必须 FAIL 且标出超差格（证明复现检查真能抓差异，不是永远点头）
// 不需要另跑"基线"：repro_check 内部先复制再重跑，比对发生在 auto_backup 收走产物之前。
// 运行：node core/test_repro_matlab.js   （没装 MATLAB 则跳过，不算失败）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Sandbox } = require('./sandbox');
const { TOOLS } = require('./tools');

// 夹具清理挂 exit：末尾那条走的是正常路径，MATLAB 没装时的 process.exit(0) 和文件尾的
// 顶层 catch 都够不着它。~/.xihe-matlab-* 那 4 个就是没装 MATLAB 的那几次留下的。
let reproTmpRoot = null;
process.on('exit', (code) => {
  if (!reproTmpRoot) return;
  try { fs.rmSync(reproTmpRoot, { recursive: true, force: true }); }
  catch (e) { console.error(`[夹具未清理] 退出码 ${code}，请手动删除：${reproTmpRoot}（${e.code || e.message}）`); }
});

const MATLAB = process.env.MATLAB_EXE || 'C:/Program Files/MATLAB/R2024b/bin/matlab.exe';

const SCRIPT = (bad) => [
  '% 主解脚本（repro_check .m 分支验证用）：相对路径读 data/、相对路径写 result_*.xlsx',
  'T = readtable("data/in.csv");',
  'v = T.x;',
  `s = sum(v)${bad ? ' + 1000' : ''};`,   // bad=true 时刻意算错
  'm = mean(v);',
  'out = table(s, m, VariableNames=["sum_x","mean_x"]);',
  'writetable(out, "result_q1.xlsx");',
  'disp("solve.m done");',
].join('\n');

(async () => {
  if (!fs.existsSync(MATLAB)) {
    console.log('SKIP: 本机没有 MATLAB（' + MATLAB + '），.m 分支未能实测');
    process.exit(process.env.XIHE_STRICT === '1' ? 1 : 0);
  }

  // 夹具放用户目录，不放系统 TEMP（守卫白名单会互相干扰）
  const root = fs.mkdtempSync(path.join(os.homedir(), '.xihe-matlab-'));
  reproTmpRoot = root;
  const appDir = path.join(root, 'app');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'in.csv'), 'x\n1\n2\n3\n4\n', 'utf8');

  const sandbox = new Sandbox(root, { protected: [appDir] });
  const session = { mode: 'math', runs: [], data_epoch: 0, source_files: ['scripts/solve.m'] };
  const ctx = {
    workspace: root, appDir, session, sandbox,
    settings: {}, spend: () => {}, trackVision: () => {},
    emit: () => {}, abort: new AbortController(), sandboxViolations: 0,
  };
  const tool = TOOLS.find(x => x.name === 'repro_check');
  const manifestPath = path.join(root, 'findings', 'repro_manifest.json');
  const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { fn(); pass++; console.log('PASS', name); }
    catch (e) { fail++; console.log('FAIL', name, '->', String(e.message).slice(0, 240)); }
  };

  // 基线产物：repro_check 的比对目标就是工作区根上"已有"的 result*.xlsx（第 ③ 步在重跑前读）。
  // 这里直接 spawn MATLAB 生成，绕开工具层——否则 autoBackupAfterRun 会把它扫进 data/trash/，
  // 夹具就得跟备份层较劲（上一版就是这么废掉的）。备份层保护的是"被脚本改写的"，基线生成后没再动过。
  const makeBaseline = () => {
    // 与 repro_check 的 .m 分支同口径：addpath 后按名调用，cwd 留在工作区根
    const r = spawnSync(MATLAB, ['-batch', "addpath('scripts'); solve"], { cwd: root, encoding: 'utf8', timeout: 600000 });
    if (r.status !== 0 || !fs.existsSync(path.join(root, 'result_q1.xlsx'))) {
      throw new Error('基线生成失败：exit=' + r.status + ' ' + String(r.stderr || '').slice(-300));
    }
  };

  // ---------- ① 正确脚本：必须 pass ----------
  console.log('· ① 正确脚本跑 repro_check（.m 分支）…');
  fs.writeFileSync(path.join(root, 'scripts', 'solve.m'), SCRIPT(false), 'utf8');
  makeBaseline();
  const out1 = await tool.run(ctx, { script: 'scripts/solve.m', timeout_sec: 900 });
  console.log('    →', String(out1).split('\n').slice(0, 8).map(s => s.trim()).join(' | ').slice(0, 400));

  t('repro_check(.m)：有返回结论', () => {
    if (typeof out1 !== 'string' || !out1.length) throw new Error('无返回');
  });
  t('repro_check(.m)：manifest 落盘', () => {
    if (!fs.existsSync(manifestPath)) throw new Error('findings/repro_manifest.json 不存在');
  });
  t('repro_check(.m)：真的用 MATLAB 重跑成功（run_ok=true）', () => {
    const m = readManifest();
    if (m.run_ok !== true) throw new Error('run_ok=' + m.run_ok + '｜重跑输出：' + String(out1).split('\n').slice(3, 6).join(' '));
  });
  t('repro_check(.m)：脚本产物落进隔离目录根（addpath 保 cwd 生效）', () => {
    // 重跑用的 cwd 是 exp_repro；若退回 run() 形态，产物会落到 exp_repro/scripts/
    const mis = path.join(root, 'exp_repro', 'scripts', 'result_q1.xlsx');
    if (fs.existsSync(mis)) throw new Error('产物写进了 exp_repro/scripts/ —— cwd 被 run() 带偏了');
  });
  t('repro_check(.m)：逐格比对通过（pass=true）', () => {
    const m = readManifest();
    if (!m.pass) throw new Error('pass=false；compare=' + JSON.stringify(m.compare, null, 1).slice(0, 2500));
    if (!(m.results_targets || []).length) throw new Error('没有 result*.xlsx 比对目标');
  });
  t('repro_check(.m)：session.repro_check 记账为通过', () => {
    const rc = session.repro_check;
    if (!rc || !rc.at) throw new Error('未记账');
    if (!rc.pass) throw new Error('记账为未通过');
    if (rc.compared < 1) throw new Error('compared=' + rc.compared);
  });

  // ---------- ② 改错脚本：必须 FAIL ----------
  console.log('· ② 把算法改错（sum+1000），应判 FAIL …');
  fs.writeFileSync(path.join(root, 'scripts', 'solve.m'), SCRIPT(true), 'utf8');
  const out2 = await tool.run(ctx, { script: 'scripts/solve.m', timeout_sec: 900 });
  t('repro_check(.m)：算错必须判 FAIL（复现检查不是永远点头）', () => {
    const m = readManifest();
    if (m.pass) throw new Error('算错竟然还判通过');
    const bad = (m.compare || []).filter(c => c.status === 'diff' || c.status === 'missing' || c.status === 'error');
    if (!bad.length) throw new Error('没有任何比对失败项：' + JSON.stringify(m.compare).slice(0, 300));
  });
  t('repro_check(.m)：差异内容回传给模型（有可比对的报告）', () => {
    const m = readManifest();
    const withReport = (m.compare || []).filter(c => c.report);
    if (!withReport.length) throw new Error('没有带 report 的比对项');
  });
  t('repro_check(.m)：失败时 session 记账也置为未通过', () => {
    if (session.repro_check.pass !== false) throw new Error('session 仍记为通过');
  });

  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`\n=== REPRO-MATLAB ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常:', e); process.exit(1); });
