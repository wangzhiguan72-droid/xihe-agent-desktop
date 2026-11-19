// 6 步人工端到端验收的自动化（v2.6.3）。
//
// 这份用例复刻《羲和Agent使用说明书》里那 6 步手工验收动作，全部在真浏览器 + 真服务里跑：
//   1. 新建项目 → 选一个有既有文件的真实文件夹 → 建两条对话
//   2. 跑一轮 python 产物 → 产物落在那文件夹、既有文件一个没少、右侧面板只显示本项目
//   3. 切项目 → 会话列表和交付物面板都跟着切
//   4. 点对话里的交付物 chip → 资源管理器定位
//   5. 计费卡显示精确费用；改一个价格 → 点重算 → 历史总额跟着变
//   6. 步骤时间线默认折叠、可展开、失败步骤标红
// 第 2 步是**数据安全那条**的真实验证（外部项目下自动备份/回收站整体停用）。
//
// 隔离三件套（缺一件都会污染用户正在用的实例，理由同 core/test_render.js）：
//   1) 跑在 app 目录的【副本】里：DATA_DIR 硬编码 APP_DIR/data 且无覆盖口子，recoverSessions()
//      启动时会把 data/sessions/*.json 的 running 改写成 idle —— 直接拿真目录起服务 = 改写用户会话。
//   2) XIHE_PORT=<空闲口>：同时跳过 findRunning() 的单实例守卫（否则新服务看到 18652 就 exit 0）。
//   3) 只复制代码，不复制 config/*.key 与 config/settings.json：不制造第二份密钥。
//
// 用户真实文件夹一律**只读**：step 1a 只让接口收下它并断言"一个字节没动"，
// step 2 真正跑 python 用的是 HOME 下的临时 fixture（不往用户既有资料里写任何东西）。
//
// 无 npm 依赖：Node 24 内置全局 WebSocket，CDP 直接用（同一手法见 core/test_render.js）。
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const APP_ID = 'xihe-agent';
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
// step 1a 用的"真实文件夹"候选：测试自建的临时目录，含既有文件，只读校验
const REAL_DIR_CANDIDATES = [path.join(os.tmpdir(), 'xihe-acceptance-real')];
try {
  fs.mkdirSync(REAL_DIR_CANDIDATES[0], { recursive: true });
  for (let i = 1; i <= 4; i++) {
    const f = path.join(REAL_DIR_CANDIDATES[0], `existing-${i}.txt`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, `fixture ${i}\n`);
  }
} catch {}

const J = JSON.stringify;

// ---------- 结果记账（沿用 core/test_render.js 的 report / === N/M passed === 约定） ----------
const results = [];
const STEPS = [
  '新建项目：选有既有文件的文件夹 → 建两条对话',
  '跑一轮 python 产物：落在该文件夹、既有文件没少、面板只显示本项目',
  '切项目：会话列表与交付物面板跟着切',
  '点对话里的交付物 chip → 资源管理器定位',
  '计费卡精确费用：改价 → 重算 → 历史总额跟着变',
  '步骤时间线：默认折叠、可展开、失败步骤标红',
];
let curStep = 0;
function step(n) { curStep = n; console.log(`\n---- 第 ${n} 步：${STEPS[n - 1]} ----`); }
function report(name, ok, detail) {
  results.push({ name, ok, detail, step: curStep });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
}
async function check(name, fn) {
  try { report(name, true, await fn()); }
  catch (e) { report(name, false, String((e && e.message) || e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- 清理 ----------
const cleanup = [];
process.on('exit', () => { for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch {} } });

function killTree(pid) {
  if (!pid) return;
  try {
    // Windows 上只 kill 父进程会留下 chrome 子进程；/T 连子树一起收。
    // MSYS_NO_PATHCONV 必须带上，否则 Git Bash 会把 /PID 改写成路径。
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  } catch {}
}

// 陈旧副本清扫：崩溃（含被 Ctrl-C）会留下 xihe-accept-*，不清就成了永久垃圾
const STALE_MS = 3600 * 1000;
for (const n of fs.readdirSync(os.homedir()).filter(n => n.startsWith('xihe-accept-'))) {
  const p = path.join(os.homedir(), n);
  try { if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

// ---------- 小工具 ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function getJSON(url, timeoutMs) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 1000) }); return await r.json(); } catch { return null; }
}

// 目录快照：相对路径 → {size, mtimeMs}。用于"既有文件一个没少"的字节级对照。
function snapshot(dir, cap, out, rel) {
  out = out || {}; rel = rel || '';
  if (Object.keys(out).length > (cap || 5000)) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) snapshot(full, cap, out, r);
    else { try { const st = fs.statSync(full); out[r] = st.size + ':' + Math.floor(st.mtimeMs); } catch {} }
  }
  return out;
}
function diffSnapshot(before, after) {
  const gone = Object.keys(before).filter(k => !(k in after));
  const changed = Object.keys(before).filter(k => k in after && after[k] !== before[k]);
  return { gone, changed };
}

// ---------- CDP 客户端（Node 内置 WebSocket，零依赖） ----------
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const wait = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) {
      const { resolve, reject } = wait.get(d.id);
      wait.delete(d.id);
      if (d.error) reject(new Error(d.error.message || 'CDP error')); else resolve(d.result);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    wait.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (wait.has(id)) { wait.delete(id); reject(new Error('CDP 超时: ' + method)); } }, 30000);
  });
  async function evaluate(expression, awaitPromise) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  return { ready, send, evaluate, close: () => { try { ws.close(); } catch {} } };
}

// ---------- 主流程 ----------
(async () => {
  let tmp = null, extDir = null, chrome = null, proc = null, client = null;

  // 环境预检：浏览器与 python 都是本套件的硬依赖
  const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!chromePath) { console.log('SKIP: 本机没有 Chrome/Edge，端到端验收无法运行'); process.exit(0); }
  let pyVer = '';
  try { pyVer = execFileSync('python', ['-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8', windowsHide: true }).trim(); }
  catch { console.log('SKIP: 本机没有可用的 python，第 2 步（数据安全）无法运行'); process.exit(0); }
  console.log(`环境：python ${pyVer} · ${path.basename(chromePath)}`);

  // 副本布局：APP_DIR 的副本放 tmp/app，则 WORKSPACE=resolve(APP_DIR,'..') 自动变成 tmp/workspace，
  // PROJECTS_DIR=tmp/workspace/projects —— 用户的真实 workspace/projects 一个字节都不碰。
  tmp = fs.mkdtempSync(path.join(os.homedir(), 'xihe-accept-'));
  cleanup.push(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
  const appCopy = path.join(tmp, 'app');
  fs.mkdirSync(appCopy, { recursive: true });
  for (const d of ['core', 'ui', 'contest_packages']) fs.cpSync(path.join(APP_DIR, d), path.join(appCopy, d), { recursive: true });
  fs.cpSync(path.join(APP_DIR, 'skills', 'contest-modeling-generic'), path.join(appCopy, 'skills', 'contest-modeling-generic'), { recursive: true });
  for (const f of ['package.json', 'main.js', 'preload.js']) {
    if (fs.existsSync(path.join(APP_DIR, f))) fs.copyFileSync(path.join(APP_DIR, f), path.join(appCopy, f));
  }
  fs.mkdirSync(path.join(appCopy, 'data'), { recursive: true });
  fs.mkdirSync(path.join(appCopy, 'config'), { recursive: true }); // 服务端 loadSettings() 需要 config/ 存在

  // step 2 的"用户既有文件夹"fixture。必须自己一次 mkdtemp：
  // validateProjectRoot 会拒绝落在 APP_DIR 与其上级（=tmp）里的任何目录 —— 自己建一个平行目录。
  extDir = fs.mkdtempSync(path.join(os.homedir(), 'xihe-accept-ext-'));
  cleanup.push(() => { if (extDir) fs.rmSync(extDir, { recursive: true, force: true }); });
  const PREEXISTING = [
    ['旧数据.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x11, 0x22, 0x33])], // 假 OOXML 头，二进制非纯文本
    ['notes.md', '# 去年的笔记\n\n这行字不能被任何自动流程改掉。\n'],
    ['solve.py', 'print("旧的求解脚本")\n'],
    ['data.csv', 'x,y\n1,2\n3,4\n'],
  ];
  for (const [n, body] of PREEXISTING) fs.writeFileSync(path.join(extDir, n), body);
  const extBefore = snapshot(extDir);

  // 服务端（副本 + 指定端口）
  const port = await freePort();
  const serverLog = path.join(tmp, 'server.log');
  const out = fs.openSync(serverLog, 'a');
  proc = spawn(process.execPath, [path.join(appCopy, 'core', 'server.js')], {
    cwd: appCopy, windowsHide: true, stdio: ['ignore', out, out], detached: false,
    env: { ...process.env, XIHE_PORT: String(port) },
  });
  cleanup.push(() => killTree(proc && proc.pid));

  let health = null;
  for (let i = 0; i < 120 && !health; i++) { health = await getJSON(`http://127.0.0.1:${port}/api/health`, 500); if (!health) await sleep(250); }
  if (!health) {
    console.log('服务未起来，server.log 末尾：\n' + String(fs.readFileSync(serverLog, 'utf8')).slice(-1500));
    console.log(`\n=== ACCEPT 0/${results.length || 1} passed ===`);
    process.exit(1);
  }
  await check('副本服务在指定端口就绪（XIHE_PORT 旁路实例守卫，未触碰 18652）', () => {
    assert(health.app === APP_ID, 'health.app 不是 ' + APP_ID + '：' + JSON.stringify(health).slice(0, 200));
    return `pid ${health.pid} · 端口 ${port}`;
  });

  // 真浏览器（独立 user-data-dir）
  const cdpPort = await freePort();
  const profile = path.join(tmp, 'chrome-profile');
  const url = `http://127.0.0.1:${port}`;
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--disable-features=Translate,MediaRouter', '--window-size=1500,940',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, url,
  ], { stdio: 'ignore', windowsHide: true, detached: false });
  cleanup.push(() => killTree(chrome && chrome.pid));

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    const list = await getJSON(`http://127.0.0.1:${cdpPort}/json/list`, 500);
    if (list && list.length) target = list.find(t => t.type === 'page' && String(t.url).includes(':' + port)) || list.find(t => t.type === 'page');
    if (!target) await sleep(250);
  }
  if (!target) { report('浏览器 CDP 调试口就绪', false, '拿不到 page target'); console.log(`\n=== ACCEPT ${results.filter(r => r.ok).length}/${results.length} passed ===`); process.exit(1); }

  client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  cleanup.push(() => client.close());
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  // 等 app.js 执行完 + /api/bootstrap 回来。renderMD 是 app.js 顶层函数声明（全局）；
  // state.boot 决定设置页/项目切换器能不能用 —— 加载完成 ≠ 引导完成，两样都要等。
  let booted = false;
  for (let i = 0; i < 120 && !booted; i++) {
    booted = await client.evaluate('typeof window.renderMD === "function" && !!(typeof state !== "undefined" && state.boot)').catch(() => false);
    if (!booted) await sleep(250);
  }
  await check('页面加载并完成引导（renderMD 全局就绪 + state.boot 已回）', () => {
    assert(booted, '30s 内 window.renderMD 未出现或 /api/bootstrap 未回 —— 看控制台/CSP');
    return 'readyState 完成 · bootstrap 已回';
  });
  if (!booted) { console.log(`\n=== ACCEPT ${results.filter(r => r.ok).length}/${results.length} passed ===`); process.exit(1); }

  // 无头环境里 confirm/alert 会阻塞或静默丢弃：统一打桩，并把 alert 文案留在 __lastAlert 里供断言
  await client.evaluate('window.__lastAlert = ""; window.confirm = () => true; window.alert = (m) => { window.__lastAlert = String(m); };');

  // =====================================================================
  // 第 1 步：新建项目（选有既有文件的文件夹）→ 建两条对话
  // =====================================================================
  step(1);

  const realDir = REAL_DIR_CANDIDATES.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  await check('1a 有既有文件的文件夹可被选为项目根，且接口一个字节都没动它', async () => {
    assert(realDir, '找不到任何候选目录：' + REAL_DIR_CANDIDATES.join('、'));
    const before = snapshot(realDir, 3000);
    assert(Object.keys(before).length >= 3, `候选目录 ${realDir} 内容太少（${Object.keys(before).length} 个文件），不满足"有既有文件"这个前提`);
    const r = await client.evaluate(`(async () => {
      try { const j = await api('/api/project/new', { id: 'e2e_real', title: '真实文件夹只读校验', dir: ${J(realDir)} });
            return { ok: true, r: j }; }
      catch (e) { return { ok: false, err: String(e.message || e) }; }
    })()`, true);
    assert(r.ok, '接口拒绝了真实文件夹：' + r.err);
    assert(r.r.external === true, 'external 未置位 —— 外部项目语义没生效，后面的数据安全短路全靠它');
    assert(String(r.r.dir).replace(/\\/g, '/').toLowerCase() === realDir.replace(/\\/g, '/').toLowerCase(), '返回的 dir 与所选不符：' + r.r.dir);
    // 项目元数据落在【程序侧】的 projects/<id>/project.json，不在用户目录里
    const meta = path.join(tmp, 'workspace', 'projects', 'e2e_real', 'project.json');
    assert(fs.existsSync(meta), '程序侧没建 project.json：' + meta);
    const after = snapshot(realDir, 3000);
    const d = diffSnapshot(before, after);
    assert(d.gone.length === 0 && d.changed.length === 0,
      `真实文件夹被改动了！消失 ${d.gone.length} 个、改动 ${d.changed.length} 个：${[...d.gone, ...d.changed].slice(0, 5).join('、')}`);
    return `${realDir} · ${Object.keys(before).length} 个既有文件全须全尾`;
  });

  // 1b：驱动真弹窗建项目 + 第一条对话（走 resolveProjectForNewSession → /api/project/new → /api/session/new）
  let pidA = null, sidA = null;
  await check('1b 真弹窗新建外部项目并开出第一条对话', async () => {
    const r = await client.evaluate(`(async () => {
      document.querySelector('#btnNewSession').click();
      await new Promise(r => setTimeout(r, 300));
      const sel = document.querySelector('#nsProject');
      sel.value = '__new__';
      sel.dispatchEvent(new Event('change'));
      document.querySelector('#nsProjectName').value = 'e2e_ext';
      document.querySelector('#nsProjectDir').value = ${J(extDir)};
      document.querySelector('button.mode-card[data-mode="math"]').click();
      for (let i = 0; i < 80 && !(state.session && state.session.project_id); i++) await new Promise(r => setTimeout(r, 250));
      return { pid: state.session && state.session.project_id, sid: state.session && state.session.id,
               dlgOpen: document.querySelector('#dlgNew').open };
    })()`, true);
    assert(r.pid, '80 次轮询后 state.session.project_id 仍为空 —— 建会话链路断了');
    assert(r.pid === 'e2e_ext_261004' || /^e2e_ext_/.test(r.pid), '意外 project id：' + r.pid);
    assert(r.sid, '会话没有 id');
    assert(r.dlgOpen === false, '新建弹窗没关掉');
    pidA = r.pid; sidA = r.sid;
    // 外部项目只写 project.json，故意不建 source/ runs/（那是内部项目的骨架）
    const pj = path.join(tmp, 'workspace', 'projects', pidA, 'project.json');
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    assert(meta.external === true && String(meta.dir).replace(/\\/g, '/') === extDir.replace(/\\/g, '/'), 'project.json 内容不对：' + JSON.stringify(meta));
    return `${pidA} · 会话 ${sidA}`;
  });

  // 1c：点项目分组头上的 ＋ 开第二条对话
  await check('1c 项目分组头的 ＋ 能开出第二条对话（同一项目）', async () => {
    assert(pidA, '1b 没拿到 pid，跳过');
    const r = await client.evaluate(`(async () => {
      await refreshSessions();
      // 按 dataset.pid 找，别按 title 反查 id：proj-head 的 title 是「项目目录：<路径>」，
      // 拿 pid 去 includes 只在 projOf() 意外拿不到项目时碰巧成立 —— 那样用例是假通过的。
      const heads = [...document.querySelectorAll('#sessionList .proj-head')];
      const head = heads.find(h => h.dataset.pid === ${J(pidA)});
      if (!head) return { err: '会话列表里找不到项目分组头（data-pid=' + ${J(pidA)} + '），实际：'
        + heads.map(h => (h.dataset.pid || '(无 data-pid)') + '=' + (h.textContent || '').trim()).join(' | ') };
      head.querySelector('.padd').click();
      await new Promise(r => setTimeout(r, 300));
      const sel = document.querySelector('#nsProject');
      if (sel.value !== ${J(pidA)}) return { err: '＋ 没把项目钉在当前项目上，select=' + sel.value };
      document.querySelector('button.mode-card[data-mode="math"]').click();
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (state.session && state.session.project_id === ${J(pidA)} && state.session.id !== ${J(sidA)}) break;
      }
      return { sid: state.session && state.session.id, pid: state.session && state.session.project_id };
    })()`, true);
    assert(!r.err, r.err);
    assert(r.pid === pidA, '第二条对话没落在同一项目里：' + r.pid);
    assert(r.sid && r.sid !== sidA, '没有新建出第二条对话（id 还是原来那条）');
    return `第二条对话 ${r.sid}`;
  });

  // =====================================================================
  // 第 2 步：数据安全 —— 跑一轮 python，产物落在该文件夹，既有文件一个没少
  // =====================================================================
  step(2);

  // 没有"直接执行工具"的 HTTP 路由：工具只能经 /api/chat → 模型 tool-call → executeTool。
  // 所以这里在进程内用同一份 tools.js + 手搭 ctx 调 executeTool —— 走的仍是
  // tPythonRun → captureAutoBackupBaseline/autoBackupAfterRun → isExternalCtx 那条真路径，
  // 不花钱、不需要 key，且 ctx.sandbox.external 与 server.js:426 的构造方式一致。
  const { executeTool } = require(path.join(appCopy, 'core', 'tools.js'));
  const { Sandbox } = require(path.join(appCopy, 'core', 'sandbox.js'));
  const PY = [
    'import openpyxl',
    'wb = openpyxl.Workbook(); ws = wb.active',
    'ws.append(["题号", "结果"]); ws.append(["Q1", 42])',
    'wb.save("result_e2e.xlsx")',
    'print("WROTE result_e2e.xlsx")',
  ].join('\n');

  let ctxExt = null;
  await check('2a 外部项目跑 python：产物落地、自动备份短路、回收站空', async () => {
    ctxExt = {
      appDir: appCopy, workspace: extDir, children: new Set(),
      sandbox: new Sandbox(extDir, { protected: [appCopy], external: true }),
    };
    assert(ctxExt.sandbox.external === true, '手搭 ctx 的 sandbox.external 没置位，本用例就失去意义了');
    // 注意：**不能**带 result_artifact/intermediate_artifact —— 那两个参数会让
    // captureAutoBackupBaseline / autoBackupAfterRun 双双不执行，正好绕过要验的代码。
    const r = await executeTool(ctxExt, 'python_run', { code: PY, timeout_sec: 180 });
    assert(r.ok === true, 'python_run 失败：' + String(r.data).slice(0, 4000));
    assert(/WROTE result_e2e\.xlsx/.test(String(r.data)), '脚本没打印预期标记：' + String(r.data).slice(0, 400));
    const xlsx = path.join(extDir, 'result_e2e.xlsx');
    assert(fs.existsSync(xlsx), '产物没落在项目文件夹里：' + xlsx);
    assert(fs.statSync(xlsx).size > 3000, '产物太小，不像是真的 xlsx：' + fs.statSync(xlsx).size + ' 字节');
    // 短路的三处可观测证据
    const rep = ctxExt._lastAutoBackupReport;
    assert(rep && rep.external === true, '_lastAutoBackupReport 没有 external:true —— 外部短路没走到：' + JSON.stringify(rep));
    assert(rep.backed.length === 0 && rep.skipped.length === 0, '外部项目竟然扫了文件：' + JSON.stringify(rep));
    assert(ctxExt._autoBackupBaseline === null, '_autoBackupBaseline 没被清成 null（说明建过基线）');
    const trash = path.join(appCopy, 'data', 'trash');
    const trashN = fs.existsSync(trash) ? fs.readdirSync(trash).length : 0;
    assert(trashN === 0, `回收站里有 ${trashN} 个文件 —— 外部项目下不该产生任何备份：` + fs.readdirSync(trash).slice(0, 5).join('、'));
    return `exit=0 · result_e2e.xlsx ${fs.statSync(xlsx).size}B · trash 空`;
  });

  // 回归：cmd.exe 的 /s 会剥掉命令里最外层成对引号，任何被引号包住的路径都会先碎一层
  // （'目录名无效'/'系统找不到指定的路径'）。真实用户的目录叫「数学建模 A题」，引号路径是常态。
  //
  // 两处刻意为之：
  //  1) 用**独立工作区** ws2，不往 extDir 里写东西——否则 2b 的「既有文件一个没少」会被本用例污染。
  //  2) 只断言退出码 + 文件系统副作用，不去正则 stdout：cmd 内建命令（dir/echo）即使 chcp 65001
  //     也按 ANSI 代码页输出，中文是乱码（既有问题，见 ISS 记录），拿乱码做断言只会假失败。
  await check('2b2 shell_run 引号路径：空格/中文/反斜杠目录都能通（回归）', async () => {
    const ws2 = fs.mkdtempSync(path.join(os.homedir(), 'e2e-shell-'));
    cleanup.push(() => fs.rmSync(ws2, { recursive: true, force: true }));
    const sub = path.join(ws2, '数据 文件夹');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '表 1.csv'), 'a,b\n1,2\n', 'utf-8');
    const ctx = {
      appDir: appCopy, workspace: ws2, children: new Set(),
      sandbox: new Sandbox(ws2, { protected: [appCopy], external: true }),
    };
    const cases = [
      ['引号+空格目录+反斜杠 + 中文文件名', 'type "数据 文件夹\\表 1.csv"', null],
      ['引号+空格目录枚举', 'dir /b "数据 文件夹"', null],
      ['引号+空格名写出', 'echo hi > "新 文件.txt"', '新 文件.txt'],
      ['引号+空格名复制', 'copy "数据 文件夹\\表 1.csv" "副本 1.csv"', '副本 1.csv'],
      ['无引号（回归）', 'echo plain > plain_out.txt', 'plain_out.txt'],
      ['管道（回归）', 'dir /b | findstr csv', null],
      ['&&（回归）', 'echo a && echo b', null],
    ];
    const bad = [];
    for (const [label, cmd, expectFile] of cases) {
      const r = await executeTool(ctx, 'shell_run', { command: cmd, timeout_sec: 60 });
      if (r.ok !== true) { bad.push(`${label} exit≠0 → ${String(r.data).split('\n').slice(0, 3).join(' ')}`); continue; }
      if (expectFile && !fs.existsSync(path.join(ws2, expectFile))) bad.push(`${label} 声称成功但 ${expectFile} 不存在`);
    }
    assert(bad.length === 0, '引号路径回归失败：\n  ' + bad.join('\n  '));
    return `${cases.length}/${cases.length} 通过（含 4 个曾被 /s 剥引号剥碎的用例）`;
  });

  await check('2b 既有 4 个文件逐个字节比对：一个没少、一个没改', async () => {
    assert(extBefore, '2a 没跑起来，无基线可比');
    const after = snapshot(extDir);
    const d = diffSnapshot(extBefore, after);
    assert(d.gone.length === 0, '既有文件消失了：' + d.gone.join('、'));
    assert(d.changed.length === 0, '既有文件被改动了：' + d.changed.join('、'));
    // 逐字节重读一遍（快照只比 size+mtime，这里比内容）
    for (const [n, body] of PREEXISTING) {
      const now = fs.readFileSync(path.join(extDir, n));
      assert(Buffer.compare(now, Buffer.isBuffer(body) ? body : Buffer.from(body)) === 0, `${n} 内容被改写了`);
    }
    // 新增项只允许两类：产物本身，和引擎自己的 .run/ 脚本目录
    const added = Object.keys(after).filter(k => !(k in extBefore));
    const bad = added.filter(k => k !== 'result_e2e.xlsx' && !k.startsWith('.run/'));
    assert(bad.length === 0, '目录里多出意料之外的文件：' + bad.join('、'));
    return `既有 ${Object.keys(extBefore).length} 个未动 · 新增 ${added.length} 项（产物 + .run/）`;
  });

  await check('2c 对照组：内部项目下自动备份照常生效（证明 2a 的"空"不是假阳性）', async () => {
    const ctrlWs = path.join(tmp, 'ctrl-ws');
    fs.mkdirSync(ctrlWs, { recursive: true });
    fs.writeFileSync(path.join(ctrlWs, 'draft_ctrl.txt'), '上一轮草稿\n');
    const ctxIn = { appDir: appCopy, workspace: ctrlWs, children: new Set(), sandbox: new Sandbox(ctrlWs, { protected: [appCopy] }) };
    const r = await executeTool(ctxIn, 'python_run', { code: 'open("draft_ctrl.txt", "w", encoding="utf-8").write("被脚本改写了")\nprint("OK")', timeout_sec: 120 });
    assert(r.ok === true, '对照组 python_run 失败：' + String(r.data).slice(0, 600));
    const rep = ctxIn._lastAutoBackupReport;
    assert(rep && rep.external === undefined, '内部项目的报告里不该有 external 键：' + JSON.stringify(rep));
    assert(rep.backed.length > 0, '内部项目竟然没备份？自动备份链路可能整体失效：' + JSON.stringify(rep));
    assert(!fs.existsSync(path.join(ctrlWs, 'draft_ctrl.txt')), '被脚本改写的文件没进回收站，还留在工作区');
    const hits = fs.readdirSync(path.join(appCopy, 'data', 'trash')).filter(n => n.includes('draft_ctrl.txt'));
    assert(hits.some(n => n.endsWith('.meta.json')), '回收站缺少 .meta.json 恢复元数据：' + hits.join('、'));
    return `backed ${rep.backed.length} 个 · 工作区已移走 · trash 有 meta`;
  });

  await check('2d 右侧交付物面板只显示本项目，且指向该文件夹', async () => {
    assert(pidA, '1b 没拿到 pid，跳过');
    const r = await client.evaluate(`(async () => {
      await renderDeliverables(state.session);
      return { proj: (document.querySelector('#deliverProj') || {}).textContent,
               dir: (document.querySelector('#deliverProj') || {}).title,
               text: document.querySelector('#deliverList').textContent,
               arteDir: state.artifactDir,
               n: (state.deliverables || []).length };
    })()`, true);
    assert(r.proj === pidA, `面板项目标签应为 ${pidA}，实际 ${r.proj}`);
    assert(String(r.dir).replace(/\\/g, '/') === extDir.replace(/\\/g, '/'), '面板标题里的目录不对：' + r.dir);
    assert(/result_e2e\.xlsx/.test(r.text), '面板里没有刚跑出来的产物：' + r.text.slice(0, 300));
    assert(!/读取失败|（还没有产物/.test(r.text), '面板停在错误态/空态：' + r.text.slice(0, 300));
    assert(String(r.arteDir).replace(/\\/g, '/') === extDir.replace(/\\/g, '/'), 'state.artifactDir 没指向项目文件夹：' + r.arteDir);
    return `${r.proj} · ${r.n} 个产物 · ${r.dir}`;
  });

  // =====================================================================
  // 第 3 步：切项目 → 会话列表与交付物面板都跟着切
  // =====================================================================
  step(3);

  const pidB = 'e2e_inner_b';
  await check('3a 切到另一个项目：会话列表只剩该项目的、面板换成它的产物', async () => {
    // 内部项目（不传 dir）→ 落在副本的 workspace/projects/<id>
    const mk = await client.evaluate(`(async () => {
      try { await api('/api/project/new', { id: ${J(pidB)}, title: '内部项目B' }); return ''; }
      catch (e) { return String(e.message || e); }
    })()`, true);
    assert(!mk, '建项目 B 失败：' + mk);
    const wsB = path.join(tmp, 'workspace', 'projects', pidB);
    fs.mkdirSync(wsB, { recursive: true });
    fs.writeFileSync(path.join(wsB, 'result_B.xlsx'), 'B'.repeat(120));
    const sB = await client.evaluate(`(async () => {
      try { const s = await api('/api/session/new', { mode: 'math', project_id: ${J(pidB)} }); return s.id || ''; }
      catch (e) { return 'ERR:' + String(e.message || e); }
    })()`, true);
    assert(sB && !String(sB).startsWith('ERR:'), '在项目 B 下建会话失败：' + sB);

    // fillProjectSwitch 才能把 state.projects 填上（/api/bootstrap 不返回 projects），
    // 而会话分组头 groupHead 靠 state.projects 取名 —— 不先跑一次，断言会打在空数据上。
    const r = await client.evaluate(`(async () => {
      await fillProjectSwitch();
      const sel = document.querySelector('#projSwitch');
      sel.value = ${J(pidB)};
      sel.dispatchEvent(new Event('change'));
      for (let i = 0; i < 60 && state.projectFilter !== ${J(pidB)}; i++) await new Promise(r => setTimeout(r, 200));
      await new Promise(r => setTimeout(r, 600));
      return { filter: state.projectFilter,
               sess: document.querySelectorAll('#sessionList .sess').length,
               heads: [...document.querySelectorAll('#sessionList .pname')].map(e => e.textContent),
               delivText: document.querySelector('#deliverList').textContent,
               delivProj: (document.querySelector('#deliverProj') || {}).textContent };
    })()`, true);
    assert(r.filter === pidB, '切换后 state.projectFilter 没跟着变：' + r.filter);
    assert(r.sess === 1, `项目 B 下应只剩 1 条会话，实际 ${r.sess}（共 ${r.heads.length} 个分组头：${r.heads.join('、')}）`);
    assert(r.delivProj === pidB, `交付物面板没切到 B：${r.delivProj}`);
    assert(/result_B\.xlsx/.test(r.delivText), '面板里没有 B 的产物：' + r.delivText.slice(0, 300));
    assert(!/result_e2e\.xlsx/.test(r.delivText), '面板里串进了 A 的产物：' + r.delivText.slice(0, 300));
    return `会话 1 条 · 面板 ${r.delivProj} · result_B.xlsx`;
  });

  await check('3b 切回 A：会话列表与面板都回到 A', async () => {
    const r = await client.evaluate(`(async () => {
      const sel = document.querySelector('#projSwitch');
      sel.value = ${J(pidA)};
      sel.dispatchEvent(new Event('change'));
      for (let i = 0; i < 60 && state.projectFilter !== ${J(pidA)}; i++) await new Promise(r => setTimeout(r, 200));
      await new Promise(r => setTimeout(r, 600));
      return { filter: state.projectFilter,
               sess: document.querySelectorAll('#sessionList .sess').length,
               delivText: document.querySelector('#deliverList').textContent,
               delivProj: (document.querySelector('#deliverProj') || {}).textContent };
    })()`, true);
    assert(r.filter === pidA, '没切回 A：' + r.filter);
    assert(r.sess === 2, `项目 A 下应有 2 条会话，实际 ${r.sess}`);
    assert(r.delivProj === pidA, `面板没切回 A：${r.delivProj}`);
    assert(/result_e2e\.xlsx/.test(r.delivText), '面板里没有 A 的产物：' + r.delivText.slice(0, 300));
    assert(!/result_B\.xlsx/.test(r.delivText), '面板里串进了 B 的产物：' + r.delivText.slice(0, 300));
    return `会话 2 条 · 面板 ${r.delivProj} · result_e2e.xlsx`;
  });

  // =====================================================================
  // 第 4 步：点对话里的交付物 chip → 资源管理器定位
  // =====================================================================
  step(4);

  const absXlsx = path.join(extDir, 'result_e2e.xlsx');
  await check('4a 命中的产物路径渲染成可点 chip，未命中保持纯文本', async () => {
    const r = await client.evaluate(`(() => {
      state.deliverables = [{ path: 'result_e2e.xlsx', abs: ${J(absXlsx)} }];
      const hit = renderMD('见 \\u0060result_e2e.xlsx\\u0060 这份表');
      const miss = renderMD('见 \\u0060unknown/nope.xlsx\\u0060 这份表');
      return { hit, miss };
    })()`);
    assert(/class="artifact"/.test(r.hit), '命中的产物没变成 chip：' + r.hit.slice(0, 200));
    assert(new RegExp('data-artpath="' + absXlsx.replace(/\\/g, '\\\\') + '"').test(r.hit) || r.hit.includes(absXlsx), 'chip 的 data-artpath 不是绝对路径：' + r.hit.slice(0, 300));
    assert(!/class="artifact"/.test(r.miss), '未命中的路径也被做成了 chip —— 点了会开空');
    return '命中可点 · 未命中纯文本';
  });

  await check('4b 左键走 open_file、Alt+左键走 reveal（真事件，不是直接调函数）', async () => {
    const r = await client.evaluate(`(async () => {
      const seen = [];
      const orig = window.api;
      window.api = (p, b) => { seen.push({ p, path: b && b.path }); return Promise.resolve({ ok: true }); };
      const cs = document.querySelector('#chatStream');
      cs.innerHTML = '';
      const el = document.createElement('div');
      el.innerHTML = renderMD('见 \\u0060result_e2e.xlsx\\u0060 这份表');
      cs.appendChild(el);
      const chip = cs.querySelector('code.artifact');
      if (!chip) { window.api = orig; return { err: 'chip 没渲染出来' }; }
      chip.click();
      await new Promise(r => setTimeout(r, 100));
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
      await new Promise(r => setTimeout(r, 100));
      cs.innerHTML = '';
      window.api = orig;
      return { seen };
    })()`, true);
    assert(!r.err, r.err);
    assert(r.seen.length === 2, '应捕获 2 次调用，实际 ' + r.seen.length + '：' + JSON.stringify(r.seen));
    assert(r.seen[0].p === '/api/open_file', '左键应走 open_file，实际 ' + r.seen[0].p);
    assert(r.seen[1].p === '/api/reveal', 'Alt+左键应走 reveal，实际 ' + r.seen[1].p);
    for (const s of r.seen) assert(String(s.path).replace(/\\/g, '/') === absXlsx.replace(/\\/g, '/'), 'chip 带出去的路径不对：' + s.path);
    return 'open_file / reveal 双路由命中，路径正确';
  });

  await check('4c chip 的样式类在实时样式表里有定义（否则点了用户看不出来能点）', async () => {
    const r = await client.evaluate(`(() => {
      let found = false;
      for (const ss of document.styleSheets) {
        let rules; try { rules = ss.cssRules; } catch { continue; }
        for (const rule of rules) if (rule.selectorText && /code\\.artifact|artifact/.test(rule.selectorText)) { found = true; break; }
        if (found) break;
      }
      const cs = document.querySelector('#chatStream');
      cs.innerHTML = '';
      const el = document.createElement('div');
      el.innerHTML = renderMD('\\u0060result_e2e.xlsx\\u0060');
      cs.appendChild(el);
      const chip = cs.querySelector('code');
      return { found, cls: chip && chip.className };
    })()`);
    assert(r.found, 'style.css 里没有 code.artifact 规则 —— chip 会退化成裸 <code>');
    assert(/artifact/.test(String(r.cls)), 'chip 的 class 不含 artifact：' + r.cls);
    return 'code.artifact 有样式规则 · class 正确';
  });

  await check('4d /api/reveal 真能定位文件与文件夹（会弹出资源管理器窗口）', async () => {
    const r = await client.evaluate(`(async () => {
      const out = {};
      try { out.file = await api('/api/reveal', { path: ${J(absXlsx)} }); } catch (e) { out.fileErr = String(e.message || e); }
      try { out.dir = await api('/api/reveal', { path: ${J(extDir)} }); } catch (e) { out.dirErr = String(e.message || e); }
      return out;
    })()`, true);
    assert(!r.fileErr, '定位文件被拒：' + r.fileErr);
    assert(r.file && r.file.opened === 'select', '文件的 opened 应为 select，实际 ' + JSON.stringify(r.file));
    assert(!r.dirErr, '定位文件夹被拒：' + r.dirErr);
    assert(r.dir && r.dir.opened === 'folder', '文件夹的 opened 应为 folder，实际 ' + JSON.stringify(r.dir));
    return '文件 /select · 文件夹 /folder';
  });

  await check('4e 越界路径必须被拒（沙箱不是摆设）', async () => {
    const r = await client.evaluate(`(async () => {
      try { const j = await api('/api/reveal', { path: 'C:/Windows/System32/drivers/etc/hosts' }); return { ok: true, j }; }
      catch (e) { return { ok: false, err: String(e.message || e) }; }
    })()`, true);
    assert(r.ok === false, '系统目录竟然被放行了：' + JSON.stringify(r.j));
    assert(/越界拒绝|受保护/.test(r.err), '拒绝理由不是沙箱越界：' + r.err);
    return 'C:/Windows/... 被拦：' + r.err.slice(0, 60);
  });

  // =====================================================================
  // 第 5 步：计费卡精确费用；改价 → 重算 → 历史总额跟着变
  // =====================================================================
  step(5);

  // 2026-01-03 是周六 → isPeak() 为 false，走平峰价，数字可手算复现：
  // costOf('deepseek-flash', 1e6 全命中, hit=0.02) = 1e6 * 0.02 / 1e6 = 0.02
  const AT = Date.UTC(2026, 0, 3, 4, 0, 0);
  const meter = require(path.join(appCopy, 'core', 'meter.js'));
  const DAY = meter.localDay(AT);

  await check('5a 计费明细按当前价目表现算，显示精确到 4 位', async () => {
    assert(sidA, '1b 没拿到 sid，跳过');
    // refreshCostDetail() 查的是 state.session.id（app.js:230），不是 1b 那条：
    // 第 1c 步已经在同一项目下开了第二条对话，第 3 步又切过项目。所以按【当前真正打开的会话】种记录，
    // 否则断言会打在"本会话暂无逐次记录"的空态上。
    const live = await client.evaluate('({ id: state.session && state.session.id, pid: state.session && state.session.project_id })');
    assert(live && live.id, '当前没有打开的会话，计费卡无从查起');
    assert(live.pid === pidA, `当前会话不属于项目 A（${live.pid}）—— 前面的项目切换没切回来`);
    const seeded = meter.record(appCopy, {
      t: AT, model: 'deepseek-flash', kind: 'main', project_id: live.pid, session_id: live.id,
      prompt_tokens: 1000000, cache_hit_tokens: 1000000, completion_tokens: 0,
    });
    assert(seeded === true, 'meter.record 写失败');
    assert(DAY === '2026-01-03', '本地日键应为 2026-01-03，实际 ' + DAY);
    const r = await client.evaluate(`(async () => { await refreshCostDetail(); return document.querySelector('#costDetail').textContent; })()`, true);
    assert(/明细合计\s*¥0\.0200/.test(r), `明细合计应为 ¥0.0200（1e6 全命中 × hit 0.02），实际：` + r.slice(-200));
    assert(/1\s*次调用/.test(r), '调用次数应为 1：' + r.slice(-200));
    return r.match(/明细合计[^（]*/)[0].trim() + ' · 会话 ' + live.id;
  });

  await check('5b 改价并重算：明细立刻变、ledger 历史总额跟着变', async () => {
    const r = await client.evaluate(`(async () => {
      // 经 /api/settings 改价（saveSettings 深合并，未提到的模型必须原样保留）
      await api('/api/settings', { prices: { 'deepseek-flash': { hit: 0.10, miss: 1.0, out: 4.0 } } });
      const s = await api('/api/settings', {});
      await refreshCostDetail();
      const after = document.querySelector('#costDetail').textContent;
      document.querySelector('#btnResummarize').click();
      for (let i = 0; i < 60 && !window.__lastAlert; i++) await new Promise(r => setTimeout(r, 200));
      return { prices: s && s.settings && s.settings.prices, after, alert: window.__lastAlert };
    })()`, true);
    assert(/明细合计\s*¥0\.1000/.test(r.after), `改价后明细合计应为 ¥0.1000（hit 0.02→0.10），实际：` + String(r.after).slice(-200));
    assert(r.prices && r.prices['deepseek-v4-pro'], '改价把 deepseek-v4-pro 冲掉了 —— 设置是覆盖不是深合并：' + JSON.stringify(r.prices));
    assert(r.prices['deepseek-flash'].hit === 0.1, 'deepseek-flash.hit 没生效：' + JSON.stringify(r.prices['deepseek-flash']));
    assert(/已重算\s*\d+\s*天/.test(r.alert), '重算提示不对：' + J(r.alert));
    assert(/其中\s*[1-9]\d*\s*天金额发生变化/.test(r.alert), '重算没报出金额变化 —— 历史总额没跟着变：' + J(r.alert));
    const ledger = JSON.parse(fs.readFileSync(path.join(appCopy, 'data', 'ledger.json'), 'utf8'));
    assert(Math.abs((ledger.costs[DAY] || 0) - 0.1) < 1e-6, `ledger.costs['${DAY}'] 应为 0.1，实际 ` + ledger.costs[DAY]);
    return `${J(r.alert)} · ledger.costs['${DAY}']=${ledger.costs[DAY]}`;
  });

  await check('5c 计费卡 updateCost：金额 4 位、缓存命中率、调用次数', async () => {
    const r = await client.evaluate(`(() => {
      updateCost({ cost: 0.3, prompt_tokens: 1000000, completion_tokens: 0, calls: 1, cache_hit_tokens: 1000000 });
      const t = id => (document.querySelector('#' + id) || {}).textContent;
      return { est: t('estCost'), tIn: t('tIn'), tCalls: t('tCalls'), tHit: t('tHit') };
    })()`);
    assert(r.est === '¥0.3000', '金额应精确到 4 位：' + r.est);
    assert(r.tHit === '100%', '缓存命中率应为 100%：' + r.tHit);
    assert(r.tCalls === '1', '调用次数不对：' + r.tCalls);
    return `${r.est} · 入 ${r.tIn} · 缓存 ${r.tHit}`;
  });

  // =====================================================================
  // 第 6 步：步骤时间线默认折叠、可展开、失败步骤标红
  // =====================================================================
  step(6);

  await check('6a 历史重放：1 个折叠块 / 3 张卡 / 1 步失败 / 默认收起 / 失败标红', async () => {
    const r = await client.evaluate(`(() => {
      const msgs = [
        { role: 'user', content: '帮我算一下' },
        { role: 'assistant', content: '开始', tool_calls: [
          { id: 'c1', function: { name: 'fs_read', arguments: '{"path":"a.csv"}' } },
          { id: 'c2', function: { name: 'python_run', arguments: '{"code":"1/0"}' } },
          { id: 'c3', function: { name: 'fs_write', arguments: '{"path":"b.txt"}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: 'x,y\\n1,2' },
        { role: 'tool', tool_call_id: 'c2', content: '[工具执行失败] ZeroDivisionError: division by zero' },
        { role: 'tool', tool_call_id: 'c3', content: '已写入' },
      ];
      renderHistory({ id: 'synth', messages: msgs, todos: [], memory: [], usage: {} });
      const cs = document.querySelector('#chatStream');
      const g = cs.querySelector('details.steps');
      const badSpan = g.querySelector('summary .bad');
      const cardBad = g.querySelector('.toolcard span.bad');
      const okSpan = g.querySelector('.toolcard span.ok');
      return {
        groups: cs.querySelectorAll('details.steps').length,
        cards: g.querySelectorAll('.toolcard').length,
        bad: g.querySelectorAll('.toolcard span.bad').length,
        summary: g.querySelector('summary').textContent,
        open: g.open,
        // 收起是 <details> 的原生行为，不是 CSS —— style.css:99 给 .steps-body 的只有 padding，
        // 所以收起态下 getComputedStyle(...).display 照样返回 block。要验"看不见"只能问可见性。
        bodyVisible: (() => { const b = g.querySelector('.steps-body');
          return typeof b.checkVisibility === 'function' ? b.checkVisibility() : b.getBoundingClientRect().height > 0; })(),
        badColor: badSpan && getComputedStyle(badSpan).color,
        cardBadColor: cardBad && getComputedStyle(cardBad).color,
        okColor: okSpan && getComputedStyle(okSpan).color,
        redVar: getComputedStyle(document.documentElement).getPropertyValue('--red').trim(),
      };
    })()`);
    assert(r.groups === 1, '3 张卡应收进 1 个折叠块，实际 ' + r.groups);
    assert(r.cards === 3, '折叠块里应有 3 张工具卡，实际 ' + r.cards);
    assert(r.bad === 1, '应恰好 1 个 span.bad（失败的 python_run），实际 ' + r.bad + ' —— 失败步骤在折叠态下会被埋掉');
    assert(/3\s*步/.test(r.summary), 'summary 没显示步数：' + J(r.summary));
    assert(/1\s*步失败/.test(r.summary), 'summary 没显示失败计数：' + J(r.summary));
    assert(r.open === false, '折叠块默认应是收起态（历史重放不能铺满屏）');
    assert(r.bodyVisible === false, '收起态下 .steps-body 应不可见（原生 details 收起）');
    // 标红：summary 上的计数与卡内的 ✗ 都必须是 --red，且不能和 ✓ 的绿色撞色
    assert(r.badColor && r.badColor !== r.okColor, `失败色与成功色相同/取不到：bad=${r.badColor} ok=${r.okColor}`);
    assert(r.badColor !== 'rgb(0, 0, 0)', '失败计数是黑色 —— 没有拿到 --red 规则：' + r.badColor);
    assert(r.badColor === r.cardBadColor, `summary 上的失败计数与卡内 ✗ 颜色不一致：${r.badColor} vs ${r.cardBadColor}`);
    return `${r.summary.replace(/\s+/g, ' ').trim()} · ✗ ${r.badColor} · ✓ ${r.okColor}`;
  });

  await check('6b summary 点击能展开、卡片 head 点击能摊开详情（失败原因看得到）', async () => {
    const r = await client.evaluate(`(async () => {
      const cs = document.querySelector('#chatStream');
      const g = cs.querySelector('details.steps');
      g.querySelector('summary').click();
      await new Promise(r => setTimeout(r, 150));
      const afterSummary = { open: g.open,
        bodyVisible: (() => { const b = g.querySelector('.steps-body');
          return typeof b.checkVisibility === 'function' ? b.checkVisibility() : b.getBoundingClientRect().height > 0; })() };
      const failed = [...g.querySelectorAll('.toolcard')].find(c => c.querySelector('span.bad'));
      if (!failed) return { err: '找不到失败卡片' };
      const before = getComputedStyle(failed.querySelector('.tbody')).display;
      failed.querySelector('.head').click();
      await new Promise(r => setTimeout(r, 150));
      const afterHead = { open: failed.classList.contains('open'), display: getComputedStyle(failed.querySelector('.tbody')).display, text: failed.querySelector('.tbody').textContent };
      return { afterSummary, before, afterHead };
    })()`, true);
    assert(!r.err, r.err);
    assert(r.afterSummary.open === true, '点 summary 没展开折叠块（details.open 仍为 false）');
    assert(r.afterSummary.bodyVisible === true, '展开后 .steps-body 仍不可见');
    assert(r.before === 'none', '卡片详情默认就该收起，实际 display=' + r.before);
    assert(r.afterHead.open === true, '点 head 后卡片没加 .open 类');
    assert(r.afterHead.display === 'block', '点 head 后 .tbody 应显示，实际 ' + r.afterHead.display);
    assert(/ZeroDivisionError/.test(r.afterHead.text), '展开后看不到失败原因：' + r.afterHead.text.slice(0, 200));
    return '折叠块已展开 · 失败卡片展开后可见 ZeroDivisionError';
  });

  // =====================================================================
  // 收尾
  // =====================================================================
  console.log('\n—— 6 步逐条映射 ——');
  for (let i = 1; i <= 6; i++) {
    const mine = results.filter(r => r.step === i);
    const ok = mine.filter(r => r.ok).length;
    console.log(`  ${mine.length && ok === mine.length ? '✔' : '✘'} 第${i}步 ${STEPS[i - 1]} (${ok}/${mine.length})`);
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== ACCEPT ${passed}/${results.length} passed ===`);
  if (failed) {
    console.log('\n失败项：');
    for (const r of results.filter(x => !x.ok)) console.log(`  - [第${r.step}步] ${r.name} :: ${r.detail}`);
  }
  console.log('\n注：第 4 步会拉起真实的资源管理器窗口（/api/reveal 是 detached+unref 的 explorer.exe），');
  console.log('    harness 收不到它们，跑完请自行关闭。');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('harness 崩溃: ' + (e && e.stack || e));
  process.exit(1);
});
