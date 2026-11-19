// 前端渲染自动化（v2.6.3 / 计划 D）：真浏览器跑一遍界面，把「选择器静默不命中」这类
// 只有肉眼才能发现的 bug 变成可自动失败的断言。
//
// 为什么需要它：v2.6 的 span.bad 选择器写错时，全部离线用例照样全绿——因为没有任何一套
// 测试真的把 ui/ 渲染出来过。C 项的构建指纹卡片同样从没在真浏览器里验证过。
//
// 三件事缺一不可，缺哪件都会污染用户正在用的实例：
//   1) 跑在 app 目录的【副本】里。DATA_DIR 硬编码为 APP_DIR/data 且无覆盖口子，
//      而 recoverSessions() 在启动时会把 data/sessions/*.json 的 running 改写成 idle。
//      直接拿真目录起服务 = 改写用户的会话文件。
//   2) 用 XIHE_PORT 指定端口。它同时跳过 findRunning() 的单实例守卫——否则新服务会
//      发现 18652 上那个正在用的实例，打印"已在运行"然后 exit(0)。
//   3) 只复制代码，不复制 config/*.key 与 config/settings.json：不制造第二份密钥，
//      服务端 loadSettings() 本来就会按 DEFAULT_SETTINGS 生成一份。
//
// 无 npm 依赖：Node 24 内置全局 WebSocket，CDP 直接用（同一手法见 workflow_helpers/cdp.js）。
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const APP_ID = 'xihe-agent';
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

// ---------- 结果记账（跟随 core/test_e2e.js 的 report/=== N/M passed === 约定） ----------
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    report(name, true, detail);
  } catch (e) {
    report(name, false, String((e && e.message) || e));
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- 清理（退出路径统一走这里，失败时也不留孤儿进程/目录） ----------
const cleanup = [];
process.on('exit', () => {
  for (const fn of cleanup.splice(0).reverse()) { try { fn(); } catch {} }
});

function killTree(pid, label) {
  if (!pid) return;
  try {
    // Windows 上只 kill 父进程会留下 chrome 的子进程；/T 连子树一起收。
    // MSYS_NO_PATHCONV 必须带上，否则 Git Bash 会把 /PID 改写成路径。
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  } catch {} // 已经自己退了也算成功
}

// 陈旧副本清扫：崩溃（含被 Ctrl-C）会留下 xihe-render-*，不清就成了永久垃圾。
// 1 小时 mtime 门槛，避免误删另一个正在跑的实例。
const STALE_MS = 3600 * 1000;
for (const n of fs.readdirSync(os.homedir()).filter(n => n.startsWith('xihe-render-'))) {
  const p = path.join(os.homedir(), n);
  try {
    if (Date.now() - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

// ---------- 小工具 ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function getJSON(url, timeoutMs) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 1000) });
    return await r.json();
  } catch { return null; }
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
  // Runtime.evaluate 包一层：awaitPromise + returnByValue，异常直接抛出方便定位
  async function evaluate(expression, awaitPromise) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('页面内异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result && r.result.value;
  }
  return { ready, send, evaluate, close: () => { try { ws.close(); } catch {} } };
}

// ---------- app.js 依赖的选择器 vs 实时 DOM ----------
// 真正要抓的 bug 类：app.js 里 $('#x') 指向了一个 index.html 里并不存在、也没在运行时
// 被建出来的 id —— 代码不报错，功能静默失效。v2.6 的 span.bad 就是这一类。
function staticIds(html) {
  return new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));
}
function dynamicIds(js) {
  const s = new Set();
  for (const m of js.matchAll(/\.id\s*=\s*'([\w-]+)'/g)) s.add(m[1]);   // el.id = 'liveQ'
  for (const m of js.matchAll(/\bid="([\w-]+)"/g)) s.add(m[1]);          // innerHTML 里建的
  return s;
}
function lookupIds(js) {
  const s = new Set();
  for (const m of js.matchAll(/\$\(\s*'#([\w-]+)'\s*\)/g)) s.add(m[1]);
  for (const m of js.matchAll(/querySelector\(\s*'#([\w-]+)'\s*\)/g)) s.add(m[1]);
  return s;
}

// ---------- 主流程 ----------
(async () => {
  let tmp = null, chrome = null, proc = null, client = null;

  const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  // SKIP 的退出码：默认退 0（没装浏览器的机器不该被卡红），XIHE_STRICT=1 时退 1（CI/发版前自查，
  // 免得"跳过"被当成"通过"——这正是本套件自己要消灭的那类假绿）。
  if (!chromePath) { console.log('SKIP: 本机没有 Chrome/Edge，前端渲染用例无法运行'); process.exit(process.env.XIHE_STRICT === '1' ? 1 : 0); }

  // 1) 隔离副本。fixture 放 HOME 而不是系统 TEMP——TEMP 是 sandbox 的守卫白名单，
  //    测试残留物会互相干扰（core/test_sandbox.js 里已有同样的血泪注释）。
  tmp = fs.mkdtempSync(path.join(os.homedir(), 'xihe-render-'));
  cleanup.push(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
  const appCopy = path.join(tmp, 'app');
  fs.mkdirSync(appCopy, { recursive: true });
  for (const d of ['core', 'ui', 'contest_packages', 'plugins', 'template_library']) fs.cpSync(path.join(APP_DIR, d), path.join(appCopy, d), { recursive: true });
  for (const d of ['contest-modeling-apmcm', 'xihe-research-methods', 'pde-award-solve']) fs.cpSync(path.join(APP_DIR, 'skills', d), path.join(appCopy, 'skills', d), { recursive: true });
  fs.cpSync(path.join(APP_DIR, 'skills', 'xihe-evidence-figures'), path.join(appCopy, 'skills', 'xihe-evidence-figures'), { recursive: true });
  const extraPlugin = path.join(appCopy, 'plugins', 'extra-figures'); fs.mkdirSync(extraPlugin, { recursive: true });
  const extraManifest = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'plugins', 'evidence-figures', 'manifest.json'), 'utf8'));
  extraManifest.id = 'extra-figures'; extraManifest.label = 'Additional renderer fixture';
  fs.writeFileSync(path.join(extraPlugin, 'manifest.json'), JSON.stringify(extraManifest));
  fs.cpSync(path.join(APP_DIR, 'skills', 'contest-modeling-generic'), path.join(appCopy, 'skills', 'contest-modeling-generic'), { recursive: true });
  fs.mkdirSync(path.join(appCopy, 'skills', 'ui-method'), { recursive: true });
  fs.writeFileSync(path.join(appCopy, 'skills', 'ui-method', 'SKILL.md'), '---\nname: ui-method\nversion: "1.0"\ndescription: UI fixture\n---\nRESEARCH_METHOD_FIXTURE');
  for (const f of ['package.json', 'main.js', 'preload.js']) {
    if (fs.existsSync(path.join(APP_DIR, f))) fs.copyFileSync(path.join(APP_DIR, f), path.join(appCopy, f));
  }
  fs.mkdirSync(path.join(appCopy, 'data'), { recursive: true });
  fs.mkdirSync(path.join(appCopy, 'config'), { recursive: true }); // 服务端会往里写自己那份 settings.json

  // 2) 起服务（副本 + 指定端口 → 用户的 18652 实例不会被探测、结束或写入）
  const port = await freePort();
  const portFile = path.join(tmp, 'server.log');
  const out = fs.openSync(portFile, 'a');
  proc = spawn(process.execPath, [path.join(appCopy, 'core', 'server.js')], {
    cwd: appCopy, windowsHide: true, stdio: ['ignore', out, out], detached: false,
    env: { ...process.env, XIHE_PORT: String(port) },
  });
  cleanup.push(() => killTree(proc && proc.pid, 'server'));

  let health = null;
  for (let i = 0; i < 120 && !health; i++) { health = await getJSON(`http://127.0.0.1:${port}/api/health`, 500); if (!health) await sleep(250); }
  if (!health) {
    console.log('服务未起来，server.log 末尾：\n' + String(fs.readFileSync(portFile, 'utf8')).slice(-1500));
    report('副本服务在指定端口就绪', false, 'health 不可达');
    console.log(`\n=== RENDER 0/${results.length} passed ===`);
    process.exit(1);
  }

  await check('副本服务在指定端口就绪（XIHE_PORT 旁路实例，未触碰 18652）', () => {
    assert(health.app === APP_ID, 'health.app 不是 ' + APP_ID + '：' + JSON.stringify(health).slice(0, 200));
    return `pid ${health.pid} · stamp ${health.code_stamp}`;
  });

  // 3) 起真浏览器（独立 user-data-dir，不会把标签页塞进用户自己的 Chrome 会话）
  const cdpPort = await freePort();
  const profile = path.join(tmp, 'chrome-profile');
  const url = `http://127.0.0.1:${port}`;
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync',
    '--disable-features=Translate,MediaRouter', '--window-size=1500,940',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, url,
  ], { stdio: 'ignore', windowsHide: true, detached: false });
  cleanup.push(() => killTree(chrome && chrome.pid, 'chrome'));

  let target = null;
  for (let i = 0; i < 120 && !target; i++) {
    const list = await getJSON(`http://127.0.0.1:${cdpPort}/json/list`, 500);
    if (list && list.length) target = list.find(t => t.type === 'page' && String(t.url).includes(':' + port)) || list.find(t => t.type === 'page');
    if (!target) await sleep(250);
  }
  if (!target) {
    report('浏览器 CDP 调试口就绪', false, '拿不到 page target');
    console.log(`\n=== RENDER ${results.filter(r => r.ok).length}/${results.length} passed ===`);
    process.exit(1);
  }

  client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  cleanup.push(() => client.close());
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  // 等待 app.js 真的执行完：renderMD 是 app.js 顶层的函数声明，是全局。
  // 它出现 == 整份脚本解析并执行成功（语法错误会让它永远不出现）。
  let booted = false;
  for (let i = 0; i < 80 && !booted; i++) {
    booted = await client.evaluate('typeof window.renderMD === "function"').catch(() => false);
    if (!booted) await sleep(250);
  }
  await check('页面加载并执行 app.js（renderMD 已成为全局函数）', () => {
    assert(booted, '15s 内 window.renderMD 未出现——脚本没跑起来，看控制台/CSP');
    return 'readyState=' + 'complete';
  });
  if (!booted) {
    console.log(`\n=== RENDER ${results.filter(r => r.ok).length}/${results.length} passed ===`);
    process.exit(1);
  }

  await check('赛事选择与技能列表由 bootstrap 赛事包生成，通用模式不预设赛程', async () => {
    let loaded = false;
    for (let i = 0; i < 80 && !loaded; i++) {
      loaded = await client.evaluate('typeof state !== "undefined" && !!state.boot?.contest_packages').catch(() => false);
      if (!loaded) await sleep(100);
    }
    assert(loaded, '赛事包列表未加载');
    const result = await client.evaluate(`(() => {
      state.boot.contest_packages.push({id:'future-cup', label:'未来杯', skill:'future-cup-skill'});
      state.boot.contest_package_diagnostics = [{id:'broken-cup', error:'缺少清单'}];
      fillContestKinds();
      renderMyCumcm();
      return {
        options:[...document.querySelector('#ctContestKind').options].map(o=>o.value),
        futureSkill:document.querySelector('#myCumcmBody').textContent.includes('future-cup-skill'),
        hours:[...document.querySelector('#ctHours').options].map(o=>o.value),
        warning:document.querySelector('#ctPackageWarnings').textContent,
      };
    })()`);
    assert(result.options.includes('auto') && result.options.includes('generic') && result.options.includes('future-cup'));
    assert(result.futureSkill, '新赛事默认技能未显示');
    assert(!result.hours.includes('74'), '通用比赛仍预设 74 小时');
    assert(result.warning.includes('broken-cup'), '坏包诊断未显示');
  });

  await check('首次入场动画关闭后可直接键入聊天输入框', async () => {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      ready = await client.evaluate('!!window.xiheAppearance?.ready');
      if (!ready) await sleep(100);
    }
    assert(ready, '入场动画尚未就绪');
    const shown = await client.evaluate('document.querySelector("#dlgIntro").open');
    assert(shown, '首次入场动画未显示');
    await client.evaluate('document.querySelector("#btnSkipIntro").click()');
    await sleep(50);
    await client.send('Input.insertText', { text: '动画结束后输入' });
    const r = await client.evaluate(`(() => ({ focused: document.activeElement === document.querySelector('#input'), value: document.querySelector('#input').value }))()`);
    await client.evaluate(`document.querySelector('#input').value = ''`);
    assert(r.focused && r.value === '动画结束后输入', '入场动画关闭后无法键入：' + JSON.stringify(r));
  });

  await check('主题可即时切换、刷新保留；首次入场默认开启并可关闭和重播', async () => {
    let appearanceReady = false;
    for (let i = 0; i < 80 && !appearanceReady; i++) {
      appearanceReady = await client.evaluate('!!window.xiheAppearance?.ready');
      if (!appearanceReady) await sleep(100);
    }
    assert(appearanceReady, '界面偏好事件未就绪');
    const r = await client.evaluate(`(() => {
      const pref = window.xiheAppearance;
      if (!pref) return { missing: true };
      const initiallyEnabled = pref.get().intro;
      document.querySelector('#btnSkipIntro').click();
      document.querySelector('#setTheme').value = 'light';
      document.querySelector('#setTheme').dispatchEvent(new Event('change'));
      const light = { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor };
      document.querySelector('#btnTheme').click();
      const dark = { theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor };
      document.querySelector('#setIntro').checked = false;
      document.querySelector('#setIntro').dispatchEvent(new Event('change'));
      document.querySelector('#btnReplayIntro').click();
      const replay = document.querySelector('#dlgIntro').open;
      document.querySelector('#btnSkipIntro').click();
      return { initiallyEnabled, light, dark, replay, saved: pref.get() };
    })()`);
    assert(!r.missing, '缺少界面偏好模块');
    assert(r.initiallyEnabled === true, '首次打开默认未启用入场动画');
    assert(r.light.theme === 'light' && r.dark.theme === 'dark', '深浅主题切换失败：' + JSON.stringify(r));
    assert(r.light.bg !== r.dark.bg, '主题属性改变但背景颜色没有改变');
    assert(r.replay && r.saved.intro === false && r.saved.theme === 'dark', '重播或动画开关未保存');
    await client.send('Page.reload');
    let loaded = false;
    for (let i = 0; i < 80 && !loaded; i++) {
      loaded = await client.evaluate('!!(window.xiheAppearance && typeof state !== "undefined" && state.boot)').catch(() => false);
      if (!loaded) await sleep(100);
    }
    assert(loaded, '刷新后界面未就绪');
    const after = await client.evaluate('({ theme:document.documentElement.dataset.theme, intro:document.querySelector("#dlgIntro").open, logo:document.querySelector(".brand img").complete })');
    assert(after.theme === 'dark' && after.intro === false && after.logo, '刷新后主题、动画开关或金乌标识未生效');
  });

  await check('启动后不选附件也能直接键入聊天输入框', async () => {
    await client.send('Input.insertText', { text: '直接输入测试' });
    const r = await client.evaluate(`(() => ({
      value: document.querySelector('#input').value,
      focused: document.activeElement === document.querySelector('#input'),
      attachments: state.attachments.length
    }))()`);
    await client.evaluate(`document.querySelector('#input').value = ''`);
    assert(r.focused && r.value === '直接输入测试' && r.attachments === 0, '无附件直接键入失败：' + JSON.stringify(r));
  });

  await check('中文输入法确认候选词的 Enter 不触发发送', async () => {
    const r = await client.evaluate(`(() => {
      const input = document.querySelector('#input');
      const oldAlert = window.alert;
      let alerts = 0;
      window.alert = () => { alerts++; };
      input.value = '候选词';
      try {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, keyCode: 229 }));
        return { alerts, value: input.value };
      } finally { window.alert = oldAlert; input.value = ''; }
    })()`);
    assert(r.alerts === 0 && r.value === '候选词', '输入法确认误触发发送：' + JSON.stringify(r));
  });

  await check('关闭普通对话框后可直接继续键入聊天输入框', async () => {
    const opened = await client.evaluate(`(() => {
      const input = document.querySelector('#input');
      input.focus();
      document.querySelector('#dlgNew').showModal();
      return document.querySelector('#dlgNew').open && document.activeElement !== input;
    })()`);
    assert(opened, '测试对话框未实际接管焦点');
    await client.evaluate(`document.querySelector('#dlgNew').close()`);
    await sleep(50);
    await client.send('Input.insertText', { text: '关闭后继续' });
    const r = await client.evaluate(`(() => ({ focused: document.activeElement === document.querySelector('#input'), value: document.querySelector('#input').value }))()`);
    await client.evaluate(`document.querySelector('#input').value = ''`);
    assert(r.focused && r.value === '关闭后继续', '关闭对话框后无法键入：' + JSON.stringify(r));
  });
  await check('无会话发送提示关闭后仍能键入输入框', async () => {
    assert(await client.evaluate('!state.session'), '测试需要尚未建立会话');
    await client.evaluate(`document.querySelector('#input').focus()`);
    const pending = client.evaluate(`sendText('未建会话')`, true);
    await sleep(100);
    await client.send('Page.handleJavaScriptDialog', { accept: true });
    await pending;
    await client.send('Input.insertText', { text: '提示后输入' });
    const r = await client.evaluate(`(() => ({ focused: document.activeElement === document.querySelector('#input'), value: document.querySelector('#input').value }))()`);
    await client.evaluate(`document.querySelector('#input').value = ''`);
    assert(r.focused && r.value === '提示后输入', '提示框关闭后无法键入：' + JSON.stringify(r));
  });

  // 拿到页面上的真实 DOM 与两份源码（选择器比对要看真实产物，不是磁盘上的）
  const domHtml = await client.evaluate('document.documentElement.outerHTML');
  const indexHtml = fs.readFileSync(path.join(appCopy, 'ui', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(appCopy, 'ui', 'app.js'), 'utf8');

  await check('启动令牌已注入（页面里没有残留占位符）', () => {
    assert(!domHtml.includes('__XIHE_TOKEN_PLACEHOLDER__'), 'index.html 里的 __XIHE_TOKEN_PLACEHOLDER__ 没被替换——前端所有带令牌请求都会 403');
    const tok = (domHtml.match(/name="xihe-token"[^>]*content="([^"]*)"/) || [])[1];
    assert(tok && tok.length >= 32, '注入的令牌为空或过短：' + String(tok).slice(0, 20));
    return `${tok.length} 字符`;
  });

  // 核心用例：app.js 依赖的每个 id 都要在实时 DOM 里存在，或在运行时被建出来
  await check('app.js 的每个 #id 选择器在实时 DOM 中命中（v2.6 span.bad 那一类静默失效）', () => {
    const known = new Set([...staticIds(indexHtml), ...dynamicIds(appJs)]);
    const missing = [...lookupIds(appJs)].filter(id => !known.has(id)).sort();
    assert(missing.length === 0, `app.js 引用了不存在的 id：${missing.join(', ')} —— 对应功能会静默失效`);
    return `${lookupIds(appJs).size} 个选择器全部有落点`;
  });

  // 同一类风险的另一半：样式类。span.bad 只在 style.css 里有定义时才会显红，
  // 类名改了而 CSS 没跟着改，失败步骤就不标红了——折叠态下这就是把错误埋掉。
  await check('折叠时间线用到的 class 在 style.css 里有定义', () => {
    const css = fs.readFileSync(path.join(appCopy, 'ui', 'style.css'), 'utf8');
    // 不查 .run：它是 emoji ⏳，没有 CSS 规则也照常显示。只查"没样式就看不见/退化成裸文本"的那些。
    for (const cls of ['steps', 'steps-body', 'toolcard', 'ok', 'bad', 'workbar']) {
      assert(new RegExp('\\.' + cls + '\\b').test(css), `style.css 里没有 .${cls} —— 界面会退化成裸文本`);
    }
    // span.bad 在 v2.6 里同时用在两处：工具卡内和折叠 summary 上。后者不在 .toolcard 里，
    // 只写 .toolcard .bad 的话摘要上的失败计数拿不到红色——这条断言专门锁住这个后代选择器。
    assert(/details\.steps[^{]*\.bad/.test(css), 'style.css 缺少 details.steps 下的 .bad 规则——折叠摘要上的失败计数不会标红');
    return 'steps/toolcard/ok/bad/workbar + summary 上的 .bad 均有样式';
  });

  // 设置页构建指纹（C 项）：点开 → 卡片里出现真构建号与 pid，且不带未替换的占位符
  // 注意：openSettings() 一上来就解引用 state.boot.settings，而 state.boot 要等
  // /api/bootstrap 回来才有值。加载完成 ≠ 引导完成，不等这一下就是随机失败。
  await check('设置页构建指纹卡渲染出真实构建号（C 项，此前从未在浏览器里验证过）', async () => {
    let booted2 = false;
    for (let i = 0; i < 80 && !booted2; i++) {
      booted2 = await client.evaluate('!!(typeof state !== "undefined" && state.boot)');
      if (!booted2) await sleep(250);
    }
    assert(booted2, '/api/bootstrap 20s 内没回来，state.boot 仍为空——设置页打不开');
    await client.evaluate("document.querySelector('#btnSettings').click()");
    let txt = '';
    for (let i = 0; i < 60; i++) {
      txt = await client.evaluate("(document.querySelector('#buildStamp')||{}).textContent || ''");
      if (/构建\s*[0-9a-f]{12}/.test(txt)) break;
      await sleep(100);
    }
    assert(/构建/.test(txt), '未进入读取态，实际内容：' + JSON.stringify(txt));
    assert(/[0-9a-f]{12}/.test(txt), '构建指纹没渲染出来：' + JSON.stringify(txt));
    assert(!/读取失败/.test(txt), '前端报「构建指纹读取失败」——/api/health 或令牌有问题：' + txt);
    // pid 也要在：只有构建号没有 pid 的话，判断不了"这个号是哪个进程在报"
    assert(/pid\s*\d+/.test(txt), '没显示服务 pid：' + txt);
    const shown = (txt.match(/[0-9a-f]{12}/) || [])[0];
    // 副本的构建号是复制的文件算出来的，应与服务端 /api/health 自报的一致 —— 不一致说明
    // codeStamp 在"谁算的"上有分歧，桌面壳的"要不要重启"判定会跟着错。
    assert(shown === health.code_stamp, `页面显示的构建号 ${shown} 与服务端自报 ${health.code_stamp} 不一致`);
    return `显示 ${shown} · 与服务端一致`;
  });

  await check('标题栏始终显示判断层状态，并可一键进入设置（可关闭/按需/智能）', async () => {
    const r = await client.evaluate(`(async () => {
      const pill = document.querySelector('#judgePill');
      const initial = { exists: !!pill, role: pill?.getAttribute('role'), text: pill?.textContent || '',
        title: pill?.title || '', keyboard: pill?.tabIndex === 0 };
      pill?.click();
      for (let i = 0; i < 30 && !document.querySelector('#dlgSettings')?.open; i++) await new Promise(resolve => setTimeout(resolve, 50));
      const opened = document.querySelector('#dlgSettings')?.open === true;
      document.querySelector('#btnCloseSettings')?.click();
      renderJudgePill({ decision_judge: { enabled: true, trigger: 'smart', provider: 'tokenrhythm', model: 'neohorse-1-9b' } });
      const smart = { text: pill.textContent, trigger: pill.dataset.trigger, pressed: pill.getAttribute('aria-pressed'), title: pill.title };
      renderJudgePill({ decision_judge: { enabled: false } });
      const off = { text: pill.textContent, pressed: pill.getAttribute('aria-pressed') };
      renderJudgePill(state.boot?.settings || {});
      return { initial, opened, smart, off };
    })()`, true);
    assert(r.initial.exists && r.initial.role === 'button' && r.initial.keyboard, '标题栏判断层胶囊缺少可发现/可键盘操作入口：' + JSON.stringify(r));
    assert(r.opened, '点击标题栏判断层胶囊没有打开设置页');
    assert(r.smart.text === 'Jev 智能' && r.smart.trigger === 'smart' && r.smart.pressed === 'true' && /neohorse-1-9b/.test(r.smart.title), '智能状态显示不完整：' + JSON.stringify(r));
    assert(r.off.text === 'Jev 关闭' && r.off.pressed === 'false', '关闭状态显示不完整：' + JSON.stringify(r));
    return '标题栏状态入口可见，点击可打开设置，三种状态可辨识';
  });

  await check('后台任务状态、恢复通知、人工核查提示与重试/取消操作可用', async () => {
    const r = await client.evaluate(`(async () => {
      const originalApi = api; const calls = [];
      const previousSession = state.session;
      state.session = { id:'scope-session', project_id:'scope-project' };
      const jobs = [
        {id:'job-q',label:'排队任务',status:'queued',attempts:0,maxAttempts:1},
        {id:'job-s',label:'启动任务',status:'starting',attempts:1,maxAttempts:1},
        {id:'job-r',label:'运行任务',status:'running',attempts:1,maxAttempts:1},
        {id:'job-c',label:'取消中',status:'cancelling',attempts:1,maxAttempts:1},
        {id:'job-n',label:'需要核查',status:'needs_review',attempts:1,maxAttempts:1,lastError:'服务重启时任务中断'},
        {id:'job-f',label:'失败任务',status:'failed',attempts:1,maxAttempts:1,lastError:'退出码 1'},
      ];
      const notifications = [{id:'notice-1',type:'recovered',at:Date.now(),job:{id:'job-n',label:'需要核查',status:'running'},read:false}];
      const resumptions = [{session_id:'resume-session',project_id:'scope-project',title:'待恢复会话',status:'needs_review',error:'恢复中有工具调用结果不明',
        interrupted_approval:{id:'approval-1',tool:'fs_write',summary:'写入结果'}}];
      api = async (url, body) => {
        calls.push({url,body});
        if (url === '/api/jobs/retry') return {ok:true,id:body.id,status:'queued'};
        if (url === '/api/jobs/cancel') return {ok:true,id:body.id,status:'cancelled'};
        if (url === '/api/jobs/ack') {
          const selected = new Set(body.ids || []);
          notifications.forEach(n => { if (selected.has(n.id)) n.read = true; });
          return {ok:true};
        }
        if (url === '/api/session/resume') return {ok:true,session_id:body.id};
        if (url.startsWith('/api/jobs/detail?')) return {meta:{id:'job-n'},tail:'stdout result',stderr:'stderr detail'};
        if (url === '/api/bootstrap') return {sessions:[],settings:{}};
        return {jobs,counts:{queued:1,starting:1,running:1,cancelling:1,needs_review:1,failed:1},resumptions,notifications,unread:1};
      };
      try {
        renderJobs({jobs:[],counts:{},notifications:[],unread:0});
        const emptyHidden = document.querySelector('#jobStatusBar').hidden;
        renderJobs({jobs,counts:{queued:1,starting:1,running:1,cancelling:1,needs_review:1,failed:1},resumptions,notifications,unread:1});
        const visible = !document.querySelector('#jobStatusBar').hidden;
        const statusText = document.querySelector('#jobStatusText').textContent;
        document.querySelector('#btnJobs').click();
        const dialogOpen = document.querySelector('#dlgJobs').open;
        const warning = [...document.querySelectorAll('.job-row-error')].some(el=>el.textContent.includes('将从任务入口重跑，请先核对已有产物'));
        const resumeWarning = [...document.querySelectorAll('.job-resumption')].some(el=>el.textContent.includes('上次执行结果不明，请核对已有产物后继续'));
        const interruptedApproval = [...document.querySelectorAll('.job-resumption')].some(el=>el.textContent.includes('fs_write'));
        const retry = [...document.querySelectorAll('.job-row[data-job-id="job-n"] button')].find(b=>b.textContent==='重试');
        const cancel = [...document.querySelectorAll('.job-row[data-job-id="job-r"] button')].find(b=>b.textContent==='取消');
        const detail = [...document.querySelectorAll('.job-row[data-job-id="job-n"] button')].find(b=>b.textContent==='查看日志');
        const resume = [...document.querySelectorAll('.job-resumption button')].find(b=>b.textContent==='核对后继续');
        await retry.onclick(); await cancel.onclick(); await detail.onclick(); await resume.onclick();
        await document.querySelector('#btnAckJobNotifications').onclick();
        const actions = calls.filter(c=>['/api/jobs/retry','/api/jobs/cancel','/api/jobs/ack'].includes(c.url));
        const ackIds = calls.find(c=>c.url==='/api/jobs/ack')?.body?.ids || [];
        const notificationRead = document.querySelector('#jobNotifications .job-notification')?.classList.contains('read');
        const detailsCall = calls.find(c=>c.url.startsWith('/api/jobs/detail?'))?.url || '';
        const scopedRetry = calls.find(c=>c.url==='/api/jobs/retry')?.body;
        const scopedCancel = calls.find(c=>c.url==='/api/jobs/cancel')?.body;
        const resumed = calls.find(c=>c.url==='/api/session/resume')?.body;
        const notificationText = document.querySelector('#jobNotifications .job-notification')?.textContent || '';
        const startingText = [...document.querySelectorAll('.job-row[data-job-id="job-s"] .job-status')].map(el=>el.textContent).join('');
        const cancellingText = [...document.querySelectorAll('.job-row[data-job-id="job-c"] .job-status')].map(el=>el.textContent).join('');
        return {emptyHidden,visible,statusText,startingText,cancellingText,dialogOpen,warning,resumeWarning,interruptedApproval,actions:actions.map(c=>c.url),retryId:scopedRetry?.id,
          cancelId:scopedCancel?.id,scopedRetry,scopedCancel,detailsCall,resumed,ackIds,notificationRead,notificationText};
      } finally { api = originalApi; state.session = previousSession; document.querySelector('#dlgJobs').close(); }
    })()`, true);
    assert(r.emptyHidden && r.visible && r.dialogOpen, '后台任务入口显隐或抽屉未打开：' + JSON.stringify(r));
    assert(/启动中/.test(r.startingText) && /取消中/.test(r.cancellingText) && /运行 2/.test(r.statusText), 'starting/cancelling 状态没有正确呈现或计入活动量：' + JSON.stringify(r));
    assert(r.warning, 'needs_review 缺少核对已有产物的明确提示');
    assert(r.resumeWarning && r.interruptedApproval, '主流程待恢复未显示结果不明警告或中断审批信息：' + JSON.stringify(r));
    assert(r.actions.includes('/api/jobs/retry') && r.retryId === 'job-n', '重试按钮没有请求对应任务：' + JSON.stringify(r));
    assert(r.actions.includes('/api/jobs/cancel') && r.cancelId === 'job-r', '取消按钮没有请求对应任务：' + JSON.stringify(r));
    assert(r.scopedRetry.session_id === 'scope-session' && r.scopedRetry.project_id === 'scope-project'
      && r.scopedCancel.session_id === 'scope-session' && r.scopedCancel.project_id === 'scope-project', '重试/取消请求缺少当前作用域：' + JSON.stringify(r));
    assert(/session_id=scope-session/.test(r.detailsCall) && /project_id=scope-project/.test(r.detailsCall), '日志详情请求缺少当前作用域：' + r.detailsCall);
    assert(r.resumed.id === 'resume-session' && r.resumed.project_id === 'scope-project' && r.resumed.confirmed === true, '恢复请求没有确认及当前项目：' + JSON.stringify(r));
    assert(r.ackIds.includes('notice-1') && r.notificationRead, '任务通知没有持久标记已读：' + JSON.stringify(r));
    assert(/运行中/.test(r.notificationText) && /已接回/.test(r.notificationText), '通知标签没有按任务状态和恢复类型呈现：' + r.notificationText);
    return '新/取消中状态、作用域请求、核对后恢复、日志、通知和已读动作均工作';
  });

  await check('较慢的旧后台任务轮询响应不会覆盖新的作用域结果', async () => {
    const r = await client.evaluate(`(async () => {
      const originalApi = api, originalConnect = connectJobEvents; const previousSession = state.session; const previousProject = state.projectFilter;
      const previousScope = state.jobScopeKey; let releaseOld; const calls = [];
      state.session = {id:'old-scope-session',project_id:'old-scope-project'};
      state.jobScopeKey = jobScopePath();
      state.backgroundJobs = {jobs:[],counts:{},resumptions:[],notifications:[],unread:0};
      connectJobEvents = () => {};
      api = async url => { calls.push(url); if (calls.length === 1) return await new Promise(resolve => { releaseOld = resolve; });
        return {jobs:[{id:'new-scope-job',label:'新查询结果',status:'succeeded'}],counts:{succeeded:1},resumptions:[],notifications:[],unread:0}; };
      try {
        const oldRequest = refreshJobs();
        state.session = {id:'new-scope-session',project_id:'new-scope-project'};
        await refreshJobs();
        releaseOld({jobs:[{id:'old-scope-job',label:'过期查询结果',status:'failed'}],counts:{failed:1},resumptions:[],notifications:[],unread:0});
        await oldRequest;
        return {ids:state.backgroundJobs.jobs.map(j=>j.id), calls};
      } finally { api = originalApi; connectJobEvents = originalConnect; state.session = previousSession; state.projectFilter = previousProject; state.jobScopeKey = previousScope; }
    })()`, true);
    assert(r.ids.join(',') === 'new-scope-job', '较慢的旧响应覆盖了最新结果：' + JSON.stringify(r));
    assert(r.calls[0].includes('old-scope-session') && r.calls[1].includes('new-scope-session'), '轮询没有随会话切换重新限定作用域：' + JSON.stringify(r));
    return '会话作用域切换触发新查询，旧响应被序号门禁丢弃';
  });

  await check('推理强度可直接打开、读取新协议并保存Claude与Astra档位', async () => {
    const r = await client.evaluate(`(async () => {
      const before=await api('/api/bootstrap');
      const old=before.settings;
      const previousSession=state.session;
      let probes=0;const originalApi=api;
      try {
        await api('/api/settings',{provider_models:{...old.provider_models,anthropic:['claude-sonnet-5-5']},
          provider_kinds:{...old.provider_kinds,anthropic:'anthropic'},
          custom_providers:[...(old.custom_providers||[]).filter(p=>p.id!=='ui-astra'),{id:'ui-astra',name:'Astra测试中转',kind:'openai',base:'https://offline.invalid/v1',models:['gpt-6-astra']}]});
        // Deliberately keep state.boot stale: opening settings must fetch the changed protocol.
        state.boot=before;state.session=null;
        document.querySelector('#dlgSettings').close();
        api=(url,...args)=>{if(url==='/api/provider/test')probes++;return originalApi(url,...args);};
        await document.querySelector('#btnReasoningSettings').onclick({currentTarget:document.querySelector('#btnReasoningSettings')});
        await new Promise(resolve=>setTimeout(resolve,400));
        const dialog=document.querySelector('#dlgSettings');
        const section=document.querySelector('#reasoningSettings');
        const claude=document.querySelector('[data-model-key="anthropic:claude-sonnet-5-5"]');
        const astra=document.querySelector('[data-model-key="ui-astra:gpt-6-astra"]');
        const options=el=>[...el.options].map(x=>x.value);
        const opening={open:dialog.open,expanded:section.open,claude:options(claude),astra:options(astra),
          beforeProviders:!!(section.compareDocumentPosition(document.querySelector('#provTable'))&Node.DOCUMENT_POSITION_FOLLOWING)};
        const filter=document.querySelector('#reasoningModelFilter');filter.value='claude';filter.dispatchEvent(new Event('input'));
        const filtered=[...document.querySelectorAll('.reasoning-row')].filter(row=>!row.hidden).map(row=>row.textContent);
        const searchable=filtered.length===1 && filtered.every(text=>text.includes('claude-sonnet-5-5'));
        filter.value='';filter.dispatchEvent(new Event('input'));
        const save=document.querySelector('#btnSaveSettings');const box=save.getBoundingClientRect();
        const reachable=box.top>=0 && box.bottom<=innerHeight && document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('#btnSaveSettings')===save;
        claude.value='xhigh';astra.value='high';
        await save.onclick();
        const saved=(await api('/api/bootstrap')).settings.model_reasoning;
        await document.querySelector('#btnReasoningSettings').onclick({currentTarget:document.querySelector('#btnReasoningSettings')});
        document.querySelector('[data-model-key="anthropic:claude-sonnet-5-5"]').value='low';
        document.querySelector('#btnCloseSettings').click();
        const afterCancel=(await api('/api/bootstrap')).settings.model_reasoning;
        return {opening,reachable,searchable,saved:{claude:saved['anthropic:claude-sonnet-5-5'],astra:saved['ui-astra:gpt-6-astra']},cancelled:afterCancel['anthropic:claude-sonnet-5-5']==='xhigh',probes};
      } finally {
        api=originalApi;
        document.querySelector('#dlgSettings').close();
        await api('/api/settings',{provider_models:old.provider_models||{},provider_kinds:old.provider_kinds||{},custom_providers:old.custom_providers||[],model_reasoning:old.model_reasoning||{}});
        state.boot=await api('/api/bootstrap');state.session=previousSession;
      }
    })()`, true);
    assert(r.opening.open && r.opening.expanded && r.opening.beforeProviders,'推理入口未展开到供应商列表前：'+JSON.stringify(r));
    assert(r.opening.claude.includes('xhigh') && !r.opening.claude.includes('none'),'Claude仍使用旧协议选项：'+JSON.stringify(r));
    assert(r.opening.astra.includes('high') && !r.opening.astra.includes('none') && !r.opening.astra.includes('minimal'),'自定义Astra档位不符合型号：'+JSON.stringify(r));
    assert(r.reachable,'保存按钮被长设置列表遮挡：'+JSON.stringify(r));
    assert(r.searchable,'无法按模型搜索推理设置：'+JSON.stringify(r));
    assert(r.saved.claude==='xhigh' && r.saved.astra==='high' && r.cancelled,'档位保存/取消未按预期工作：'+JSON.stringify(r));
    assert(r.probes===0,'修改推理档位竟然调用了付费测试');
  });

  await check('窄屏推理强度入口可见且不被遮挡', async () => {
    try {
      for (const width of [480,960]) {
        await client.send('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
        const r=await client.evaluate(`(() => {
          document.querySelector('#dlgSettings').close();
          const button=document.querySelector('#btnReasoningSettings');const rect=button.getBoundingClientRect();
          return {visible:rect.width>0&&rect.left>=0&&rect.right<=innerWidth,hit:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.closest('#btnReasoningSettings')===button};
        })()`);
        assert(r.visible && r.hit,width+'px推理按钮不可操作：'+JSON.stringify(r));
      }
    } finally {await client.send('Emulation.clearDeviceMetricsOverride');}
  });

  await check('国产模型显示真实档位、预算数字及中转思考开关', async () => {
    const r=await client.evaluate(`(async()=>{
      const old=(await api('/api/bootstrap')).settings;
      const base='https://budget-relay.invalid/v1';
      try {
        await api('/api/settings',{provider_models:{...old.provider_models,deepseek:['deepseek-flash'],qwen:['qwen3.8-flash','qwen3.8-max']},
          provider_kinds:{...old.provider_kinds,deepseek:'openai',qwen:'openai'},provider_bases:{...old.provider_bases,qwen:base},
          model_reasoning:{...old.model_reasoning,'deepseek:deepseek-flash':'medium'},model_reasoning_limits:{'qwen:qwen3.8-flash':{base,kind:'openai',mode:'qwen-switch',levels:['none','high'],note:'中转仅接受思考开关'}}});
        await openSettings(true);
        const select=key=>document.querySelector('[data-model-key="'+key+'"]');
        const ds=select('deepseek:deepseek-flash'),qw=select('qwen:qwen3.8-flash'),budget=select('qwen:qwen3.8-max');
        const result={ds:[...ds.options].map(x=>x.value),dsValue:ds.value,qwen:[...qw.options].map(x=>({value:x.value,text:x.textContent})),budget:budget.textContent};
        await document.querySelector('#btnSaveSettings').onclick();
        result.saved=(await api('/api/bootstrap')).settings.model_reasoning['deepseek:deepseek-flash'];
        return result;
      }finally{
        document.querySelector('#dlgSettings').close();
        await api('/api/settings',{provider_models:old.provider_models||{},provider_kinds:old.provider_kinds||{},provider_bases:old.provider_bases||{},model_reasoning:old.model_reasoning||{},model_reasoning_limits:old.model_reasoning_limits||{}});
        state.boot=await api('/api/bootstrap');
      }
    })()`,true);
    assert(r.ds.join(',')===',provider_default,none,low,high,max' && r.dsValue==='high' && r.saved==='high','DeepSeek显示重复别名或丢失旧配置：'+JSON.stringify(r));
    assert(r.qwen.find(x=>x.value==='high')?.text==='开启思考' && r.qwen.find(x=>x.value==='none')?.text==='关闭思考','Qwen开关伪装为强度：'+JSON.stringify(r));
    assert(/1,024 Token/.test(r.budget) && /8,192 Token/.test(r.budget),'官方Qwen预算未标明数值：'+JSON.stringify(r));
  });

  await check('三种协议可选择并保存，目录查询只读且不删除27B', async () => {
    const seen=[];
    const directoryServer=http.createServer((req,res)=>{
      seen.push(req.url);
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({data:[{id:'qwen3.8-flash'},{id:'qwen3.8-max'}]}));
    });
    await new Promise(resolve=>directoryServer.listen(0,'127.0.0.1',resolve));
    const catalogBase='http://127.0.0.1:'+directoryServer.address().port+'/v1';
    try {
      const r=await client.evaluate(`(async()=>{
        const old=(await api('/api/bootstrap')).settings;
        try {
          await api('/api/settings',{provider_models:{...old.provider_models,qwen:['qwen3.8-flash','qwen3.8-27b']},provider_bases:{...old.provider_bases,qwen:'${catalogBase}'},
            custom_providers:[...(old.custom_providers||[]),{id:'responses-test',name:'Responses测试',base:'https://offline.invalid/v1',kind:'responses',models:['gpt-6-astra']}]});
          await openSettings();
          const row=document.querySelector('.prov[data-pk="qwen"]');const custom=document.querySelector('.prov[data-pk="responses-test"]');
          const formats=[...row.querySelector('.pv-kind').options].map(x=>({value:x.value,text:x.textContent}));
          row.querySelector('.pv-kind').value='responses';
          row.querySelector('.pv-key').value='offline-directory-only';
          await row.querySelector('.pv-model-catalog').onclick();
          const catalogText=row.textContent;
          const retained=[...row.querySelectorAll('.pv-model-id')].some(x=>x.value==='qwen3.8-27b');
          const customKind=custom.querySelector('.pv-kind').value;
          await document.querySelector('#btnSaveSettings').onclick();
          const saved=(await api('/api/bootstrap')).settings;
          await openSettings();
          const reopened=document.querySelector('.prov[data-pk="qwen"] .pv-kind').value;
          return {formats,retained,catalogText,customKind,savedKind:saved.provider_kinds.qwen,reopened};
        }finally{
          document.querySelector('#dlgSettings').close();
          await api('/api/settings',{provider_models:old.provider_models||{},provider_bases:old.provider_bases||{},provider_kinds:old.provider_kinds||{},custom_providers:old.custom_providers||[],disabled_models:old.disabled_models||[]});state.boot=await api('/api/bootstrap');
        }
      })()`,true);
      assert(r.formats.map(x=>x.value).sort().join(',')==='anthropic,openai,responses','协议下拉框未提供三种格式：'+JSON.stringify(r));
      assert(r.savedKind==='responses'&&r.reopened==='responses'&&r.customKind==='responses','Responses保存/回读失败：'+JSON.stringify(r));
      assert(r.retained&&r.catalogText.includes('当前 Key 目录未列出')&&r.catalogText.includes('qwen3.8-27b'),'目录查询误删除模型或未区分权限：'+JSON.stringify(r));
      assert(seen.length===1&&seen[0]==='/v1/models','目录查询竟然调用生成接口：'+JSON.stringify(seen));
    }finally{await new Promise(resolve=>directoryServer.close(resolve));}
  });

  await check('角色模型设置与 fast/deep/extreme 三态在实时 DOM 可用', async () => {
    const r = await client.evaluate(`(() => {
      const ids = ['setRoleModeler','setRoleCoder','setRoleWriter','setRoleReviewer','modelChoices'];
      const missing = ids.filter(id => !document.getElementById(id));
      const efforts = [...document.querySelectorAll('#ctEffort option')].map(o => o.value);
      renderEffort({ mode:'math', effort:'extreme' });
      const extreme = { text:document.querySelector('#effortPill').textContent, cls:document.querySelector('#effortPill').className };
      const priorSession=state.session;
      state.session={mode:'math',effort:'extreme'};
      document.querySelector('#effortPill').click();
      const menu={open:!document.querySelector('#effortMenu').hidden,items:[...document.querySelectorAll('#effortMenu [data-effort]')].map(b=>b.dataset.effort),active:document.querySelector('#effortMenu [data-effort="extreme"]').classList.contains('active')};
      document.querySelector('#effortPill').click();
      state.session=priorSession;
      renderEffort({ mode:'math', effort:'fast' });
      return { missing, efforts, extreme, menu, roleChoices:document.querySelectorAll('#modelChoices option').length };
    })()`);
    assert(r.missing.length === 0, '角色设置字段缺失：' + r.missing.join(','));
    assert(JSON.stringify(r.efforts) === JSON.stringify(['fast', 'deep', 'extreme']), '比赛档位不是三态：' + JSON.stringify(r.efforts));
    assert(/极致/.test(r.extreme.text) && /extreme/.test(r.extreme.cls), 'extreme 胶囊未正确渲染：' + JSON.stringify(r.extreme));
    assert(r.menu.open && r.menu.active && r.menu.items.join(',') === 'fast,deep,extreme', '顶部模式选择菜单不完整：' + JSON.stringify(r.menu));
    assert(r.roleChoices > 0, '角色模型 datalist 没有可选项');
    return `4 个角色字段 + ${r.roleChoices} 个模型候选 + 三态胶囊`;
  });

  await check('提供商模型行校验空行与重复模型', async () => {
    const r = await client.evaluate(`(() => {
      const box = document.querySelector('#provTable .pv-model-list'), rows = [...box.querySelectorAll('.pv-model-row')];
      const first = rows[0], original = first.querySelector('.pv-model-id').value;
      first.querySelector('.pv-model-id').value = ''; let empty = false; try { collectProviders(); } catch (e) { empty = /不能为空/.test(e.message); }
      first.querySelector('.pv-model-id').value = original;
      const extra = document.createElement('div'); extra.className='pv-model-row'; extra.innerHTML='<input class="pv-model-id"><label class="pv-model-enabled"><input type="checkbox" class="pv-model-toggle" checked></label>'; box.appendChild(extra); extra.querySelector('.pv-model-id').value = original; let dup = false; try { collectProviders(); } catch (e) { dup = /模型重复/.test(e.message); } extra.remove();
      return {empty, dup};
    })()`);
    assert(r.empty && r.dup, '空模型行或重复模型未拒绝：' + JSON.stringify(r));
    await client.send('Runtime.evaluate', { expression: "document.querySelector('#provTable')?.scrollIntoView({block:'start'});" });
    const shot = await client.send('Page.captureScreenshot', { format:'png' });
    const shotPath = path.join(APP_DIR, '..', 'audit', 'model-list-2026-10-19', 'model-list-preview.png');
    fs.mkdirSync(path.dirname(shotPath), { recursive:true }); fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    return '空行与重复模型均被拦截；截图已保存';
  });

  await check('模型行增改停用删除真实保存回读与扩展字段保留', async () => {
    const r = await client.evaluate(`(async () => {
      const before = (await api('/api/bootstrap')).settings;
      try {
        await api('/api/settings',{custom_providers:[{id:'rowtest',base:'https://relay.example/v1',kind:'openai',models:['original'],ctx_limit:200000,max_tokens:1234}],disabled_models:['missing:model']});
        state.boot=await api('/api/bootstrap'); await openSettings();
        let row=[...document.querySelectorAll('#provTable .prov')].find(x=>x.dataset.pk==='rowtest');
        row.querySelector('.pv-model-id').value='renamed'; row.querySelector('.pv-model-add').click();
        let added=[...row.querySelectorAll('.pv-model-row')].at(-1);added.querySelector('.pv-model-id').value='added';added.querySelector('.pv-model-toggle').checked=false;
        await document.querySelector('#btnSaveSettings').onclick();
        const first=(await api('/api/bootstrap')).settings; await openSettings();
        row=[...document.querySelectorAll('#provTable .prov')].find(x=>x.dataset.pk==='rowtest');
        const reloaded=[...row.querySelectorAll('.pv-model-row')].map(x=>({id:x.querySelector('.pv-model-id').value,on:x.querySelector('.pv-model-toggle').checked}));
        row.querySelectorAll('.pv-model-del')[1].click();await document.querySelector('#btnSaveSettings').onclick();
        const last=(await api('/api/bootstrap')).settings;
        return {first:first.custom_providers.find(x=>x.id==='rowtest'),disabled:first.disabled_models,reloaded,last:last.custom_providers.find(x=>x.id==='rowtest'),tombstones:last.disabled_models,comma:!!document.querySelector('input.pv-models')};
      } finally {await api('/api/settings',{custom_providers:before.custom_providers||[],provider_models:before.provider_models||{},disabled_models:before.disabled_models||[]});state.boot=await api('/api/bootstrap'); await openSettings();}
    })()`,true);
    assert(r.first.models.join(',')==='renamed,added' && r.first.ctx_limit===200000 && r.first.max_tokens===1234,JSON.stringify(r));
    assert(r.disabled.includes('missing:model') && r.disabled.includes('rowtest:original') && r.disabled.includes('rowtest:added'),JSON.stringify(r));
    assert(r.reloaded[1].on===false && r.last.models.join(',')==='renamed' && r.tombstones.includes('rowtest:added') && !r.comma,JSON.stringify(r));
  });

  await check('同名模型选择限定提供商且草稿模型测试使用当前表单', async () => {
    const r=await client.evaluate(`(async()=>{
      const oldApi=api,oldBoot=state.boot,oldSession=state.session,oldAlert=window.alert;const sent=[],alerts=[];
      api=async(p,b)=>{sent.push({p,b});return {ok:true,ms:1};};window.alert=x=>alerts.push(x);
      try{
        const draft=customProvRow({id:'draftrelay',name:'草稿',base:'https://draft.example/v1',kind:'openai',models:['draft-model']},true,new Set());
        document.querySelector('#customProvs').appendChild(draft);draft.querySelector('.pv-key').value='fixture-not-a-real-key';
        await draft.querySelector('.pv-model-test').onclick();draft.remove();
        state.boot={...oldBoot,models:[{provider:'one',providerName:'One',id:'same'},{provider:'two',providerName:'Two',id:'same'}]};state.session={id:'fixture',model:'one:same'};
        document.querySelector('#modelMenu')?.remove();const menu=buildModelMenu();await menu.querySelectorAll('.mm-item')[1].onclick();menu.remove();
        state.boot=oldBoot;state.session=oldSession;
        const first=document.querySelector('#provTable .pv-model-id'),value=first.value;first.value='';
        await document.querySelector('#btnSaveSettings').onclick();first.value=value;
        return {sent,alerts,dialogOpen:document.querySelector('#dlgSettings').open};
      }finally{api=oldApi;state.boot=oldBoot;state.session=oldSession;window.alert=oldAlert;}
    })()`,true);
    assert(r.sent[0].p==='/api/provider/test' && r.sent[0].b.pk==='draftrelay' && r.sent[0].b.model==='draft-model' && r.sent[0].b.key==='fixture-not-a-real-key',JSON.stringify(r));
    assert(r.sent[1].p==='/api/session/model' && r.sent[1].b.model==='two:same',JSON.stringify(r));
    assert(r.sent.length===2 && r.alerts.length===1 && r.dialogOpen,JSON.stringify(r));
  });

  await check('角色模型设置经 /api/settings 保存并由 bootstrap 回读', async () => {
    const r = await client.evaluate(`(async () => {
      const headers = { 'Content-Type':'application/json', 'X-Xihe-Token':window.__XIHE_TOKEN__ };
      const body = JSON.stringify({ role_models:{ modeler:'deepseek-v4-pro', coder:'glm:glm-5.3', writer:'', reviewer:'', evil:'drop-me' } });
      const rs = await fetch('/api/settings', { method:'POST', headers, body });
      const saved = await rs.json();
      const rb = await fetch('/api/bootstrap', { headers });
      const boot = await rb.json();
      await fetch('/api/settings', { method:'POST', headers, body:JSON.stringify({ role_models:{ modeler:'', coder:'', writer:'', reviewer:'' } }) });
      return { status:[rs.status, rb.status], saved:saved.settings, boot:boot.settings, error:saved.error || null };
    })()`, true);
    assert(r.status.join(',') === '200,200', '设置/bootstrap 状态异常：' + JSON.stringify(r));
    const saved = r.saved, boot = r.boot;
    assert(saved && boot, '设置接口未返回 settings：' + JSON.stringify(r));
    assert(saved.role_models && boot.role_models, '设置里缺 role_models：' + JSON.stringify(r));
    assert(saved.role_models.modeler === 'deepseek-v4-pro' && boot.role_models.coder === 'glm:glm-5.3', '角色模型没有持久化/回读：' + JSON.stringify(r));
    assert(!('evil' in saved.role_models) && Object.keys(boot.role_models).length === 4, '非法角色字段未被过滤：' + JSON.stringify(saved.role_models));
    return 'modeler/coder 保存回读成功，非法字段已过滤';
  });

  await check('非法推理设置返回400且不改变原配置', async () => {
    const r = await client.evaluate(`(async () => {
      const before = (await api('/api/bootstrap')).settings;
      const codes = [];
      try {
        for (const patch of [{reasoning_effort:'garbage'}, {model_reasoning:{'relay:m':'ultra'}}, {reasoning_fallback:'silent'},
          {model_reasoning_limits:[]}, {model_reasoning_limits:{'relay:m':{base:'https://relay.invalid',kind:'openai',levels:['ultra']}}}]) {
          const response = await fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json','X-Xihe-Token':window.__XIHE_TOKEN__},body:JSON.stringify(patch)});
          codes.push(response.status);
        }
        const after = (await api('/api/bootstrap')).settings;
        return {codes, unchanged:before.reasoning_effort===after.reasoning_effort && JSON.stringify(before.model_reasoning)===JSON.stringify(after.model_reasoning) && before.reasoning_fallback===after.reasoning_fallback};
      } finally { await api('/api/settings', {reasoning_effort:before.reasoning_effort,model_reasoning:before.model_reasoning||{},reasoning_fallback:before.reasoning_fallback||'error'}); }
    })()`, true);
    assert(r.codes.every(x => x === 400) && r.unchanged, '非法推理设置被接受：' + JSON.stringify(r));
  });

  await check('逐模型推理档位与工作强度分别保存，且未知模型配置不丢失', async () => {
    const r = await client.evaluate(`(async () => {
      const before = await api('/api/bootstrap');
      const key = before.models[0].provider + ':' + before.models[0].id;
      const old = before.settings.model_reasoning || {};
      try {
        await api('/api/settings', { model_reasoning: { ...old, [key]:'max', 'retired-provider:old-model':'low' }, reasoning_fallback:'provider_default' });
        state.boot = await api('/api/bootstrap');
        await openSettings();
        const row = [...document.querySelectorAll('#modelReasoningRows select')].find(x => x.dataset.modelKey === key);
        const hasMax = [...row.options].some(x => x.value === 'max');
        const legacy = document.querySelector('#setEffort').value;
        const workflow = [...document.querySelectorAll('#ctEffort option')].map(x => x.value);
        row.value = 'max';
        document.querySelector('#setReasoningFallback').value = 'error';
        document.querySelector('#btnSaveSettings').click();
        for (let i = 0; i < 60 && document.querySelector('#dlgSettings').open; i++) await new Promise(done => setTimeout(done, 100));
        const after = await api('/api/bootstrap');
        await openSettings();
        [...document.querySelectorAll('#modelReasoningRows select')].find(x => x.dataset.modelKey === key).value = '';
        document.querySelector('#btnSaveSettings').click();
        for (let i = 0; i < 60 && document.querySelector('#dlgSettings').open; i++) await new Promise(done => setTimeout(done, 100));
        const cleared = await api('/api/bootstrap');
        return { key, selected:after.settings.model_reasoning[key], unknown:after.settings.model_reasoning['retired-provider:old-model'], fallback:after.settings.reasoning_fallback,
          hasMax, blankUnsets:!(key in cleared.settings.model_reasoning), legacyBefore:legacy, legacyAfter:after.settings.reasoning_effort, workflow, dialogOpen:document.querySelector('#dlgSettings').open };
      } finally {
        await api('/api/settings', { model_reasoning:old, reasoning_fallback:before.settings.reasoning_fallback || 'error' });
        state.boot = await api('/api/bootstrap');
      }
    })()`, true);
    assert(!r.dialogOpen, '设置页保存未结束：' + JSON.stringify(r));
    assert(r.selected === 'max' && r.hasMax && r.unknown === 'low', 'max 档位或未知模型设置丢失：' + JSON.stringify(r));
    assert(r.blankUnsets, '留空没有清除显式设置：' + JSON.stringify(r));
    assert(r.fallback === 'error', '回退策略未保存：' + JSON.stringify(r));
    assert(r.legacyBefore === r.legacyAfter, 'DeepSeek 旧开关被覆盖：' + JSON.stringify(r));
    assert(JSON.stringify(r.workflow) === JSON.stringify(['fast','deep','extreme']), '工作强度选项被推理档位覆盖：' + JSON.stringify(r));
    return `${r.key}=${r.selected}，未知模型保留，工作强度独立`;
  });

  await check('中转模型限制按端点生效，旧不适用档位不再可选', async () => {
    const r=await client.evaluate(`(async()=>{
      const old=(await api('/api/bootstrap')).settings;
      try {
        const base='https://relay-test.invalid';
        await api('/api/settings',{provider_models:{...old.provider_models,anthropic:['claude-opus-5-5','claude-sonnet-5-5']},
          provider_bases:{...old.provider_bases,anthropic:base},provider_kinds:{...old.provider_kinds,anthropic:'anthropic'},
          model_reasoning:{...old.model_reasoning,'anthropic:claude-opus-5-5':'max'},
          model_reasoning_limits:{'anthropic:claude-opus-5-5':{base,kind:'anthropic',levels:['provider_default'],note:'当前中转暂保留默认'},
            'anthropic:claude-sonnet-5-5':{base,kind:'anthropic',levels:['provider_default','high'],note:'低档复杂题持续生成超时'}}});
        await openSettings(true);
        const select=key=>document.querySelector('[data-model-key="'+key+'"]');
        const opus=select('anthropic:claude-opus-5-5'),sonnet=select('anthropic:claude-sonnet-5-5');
        const restricted={opus:[...opus.options].map(x=>x.value),selected:opus.value,sonnet:[...sonnet.options].map(x=>x.value)};
        document.querySelector('#dlgSettings').close();
        await api('/api/settings',{provider_bases:{...old.provider_bases,anthropic:'https://api.anthropic.com'}});
        await openSettings(true);
        const official=[...select('anthropic:claude-opus-5-5').options].map(x=>x.value);
        return {restricted,official};
      }finally{
        document.querySelector('#dlgSettings').close();
        await api('/api/settings',{provider_models:old.provider_models||{},provider_bases:old.provider_bases||{},provider_kinds:old.provider_kinds||{},model_reasoning:old.model_reasoning||{},model_reasoning_limits:old.model_reasoning_limits||{}});
        state.boot=await api('/api/bootstrap');
      }
    })()`,true);
    assert(r.restricted.opus.join(',')===',provider_default' && r.restricted.selected==='provider_default','旧档位仍然可选：'+JSON.stringify(r));
    assert(r.restricted.sonnet.join(',')===',provider_default,high','Sonnet限制错误：'+JSON.stringify(r));
    assert(r.official.includes('max'),'当前中转限制污染了其他端点：'+JSON.stringify(r));
  });

  await check('最近推理请求状态显示 API 接受的证据边界', async () => {
    const r = await client.evaluate(`(() => {
      const previous = state.session;
      try {
        state.session = { id:'render-reasoning', resolved_reasoning:null };
        handleEvent({ t:'reasoning_config', provider:'openai', model:'gpt-test', requested:'high', sent:'high', status:'api_accepted', kind:'main', note:'参数已被 API 接受' }, {});
        const pill = document.querySelector('#reasoningPill');
        const accepted = { text:pill.textContent, title:pill.title, visible:pill.style.display, saved:state.session.resolved_reasoning.status };
        handleEvent({ t:'reasoning_config', provider:'openai', model:'gpt-test', requested:'high', sent:'provider_default', status:'fallback', kind:'sub', note:'不支持 high' }, {});
        const fallback = { text:pill.textContent, title:pill.title };
        renderReasoningStatus(null);
        return { accepted, fallback, hidden:pill.style.display };
      } finally { state.session = previous; renderReasoningStatus(previous && previous.resolved_reasoning); }
    })()`);
    assert(r.accepted.visible !== 'none' && /API 已接受/.test(r.accepted.text), 'API 状态未显示：' + JSON.stringify(r));
    assert(/不代表中转站最终执行/.test(r.accepted.title), '标题误把 API 接受当成执行证明：' + JSON.stringify(r));
    assert(r.accepted.saved === 'api_accepted' && /已回退/.test(r.fallback.text) && /provider_default/.test(r.fallback.title), '事件状态未更新：' + JSON.stringify(r));
    assert(r.hidden === 'none', '无状态时未隐藏胶囊：' + JSON.stringify(r));
    return 'API 接受、回退、无记录三种状态正确呈现';
  });

  await client.evaluate("document.querySelector('#dlgSettings').close()");

  await check('结构化决策卡：3 个候选、显式推荐、依据与自定义理由随选择提交', async () => {
    const r = await client.evaluate(`(() => {
      const savedSend = sendText, savedAlert = window.alert;
      const sent = [], alerts = [];
      sendText = (text, decision) => { sent.push({ text, decision }); };
      window.alert = text => alerts.push(text);
      try {
        const q = { question:'选择方法', decision_id:'render-decision', recommended_id:'b', recommendation_reason:'b 在现有数据与赛时内可检验，a 缺数据，c 偏差更大',
          candidates:['a','b','c'].map(id => ({ id, label:'方案'+id, basis:'基线实验'+id, tradeoff:'耗时', risk:'样本不足' })) };
        showQuestion(q.question, [], q);
        const card = document.querySelector('#liveQ');
        const candidates = card.querySelectorAll('.decision-option');
        const summary = { count:candidates.length, rec:card.querySelectorAll('.decision-option.rec').length,
          recLabel:card.querySelector('.rec').textContent, basis:card.textContent.includes('基线实验b'),
          judgment:card.textContent.includes('a 缺数据'), clarify:!!card.querySelector('.decision-clarify-submit') };
        card.querySelector('.decision-reason').value = '耗时更短';
        candidates[2].click();
        const custom = card.querySelectorAll('textarea')[1];
        custom.value = '自行设计方法';
        card.querySelector('.decision-reason').value = '';
        card.querySelector('.decision-custom-submit').click();
        const blocked = sent.length === 1 && alerts.length === 1;
        card.querySelector('.decision-reason').value = '题目有额外约束';
        card.querySelector('.decision-custom-submit').click();
        card.querySelector('.decision-clarify-question').value = '为什么不选 a？';
        card.querySelector('.decision-clarify-submit').click();
        renderHistory({ messages:[], pendingQuestion:q });
        const restored = document.querySelectorAll('#liveQ .decision-option').length;
        return { summary, sent, blocked, restored };
      } finally { sendText = savedSend; window.alert = savedAlert; removeInteractive(); }
    })()`);
    assert(r.summary.count === 3 && r.summary.rec === 1 && /方案b/.test(r.summary.recLabel) && r.summary.basis && r.summary.judgment && r.summary.clarify, '候选/推荐/依据渲染错误：' + JSON.stringify(r));
    assert(r.sent[0].decision.decision_id === 'render-decision' && r.sent[0].decision.selected_id === 'c' && r.sent[0].decision.rationale === '耗时更短', '选择提交缺少绑定或理由：' + JSON.stringify(r.sent));
    assert(r.blocked, '无理由自定义方案未被阻止');
    assert(r.sent[1].decision.selected_id === 'custom' && r.sent[1].decision.custom_text === '自行设计方法' && r.sent[1].decision.rationale === '题目有额外约束', '自定义提交信息缺失');
    assert(r.sent[2].decision.action === 'clarify' && r.sent[2].decision.decision_id === 'render-decision' && r.sent[2].decision.question === '为什么不选 a？', '追问未绑定原卡片');
    assert(r.restored === 3, '历史重绘丢失结构化决策卡');
    return '3 候选 + 1 自定义，推荐与理由正确，历史可恢复';
  });

  await check('协同切全自动：待答结构化决策使用推荐 id 并携带卡片绑定', async () => {
    const r = await client.evaluate(`(async () => {
      const saved = { sendText, api, session:state.session, running:state.running,
        renderCollab, renderContest, renderDeliverables, renderApproval };
      const sent = [];
      const q = { question:'选择方法', decision_id:'toggle-decision', recommended_id:'b',
        options:['方案a','方案b','方案c'], candidates:['a','b','c'].map(id => ({ id, label:'方案'+id, basis:'依据'+id })) };
      try {
        sendText = async (text, decision) => sent.push({ text, decision });
        api = async () => ({ collab_mode:'auto', pendingQuestion:q });
        renderCollab = renderContest = renderDeliverables = renderApproval = () => {};
        state.session = { id:'render-toggle', collab_mode:'collab' }; state.running = false;
        await document.querySelector('#collabPill').onclick();
        return { sent, mode:state.session.collab_mode };
      } finally {
        sendText=saved.sendText; api=saved.api; state.session=saved.session; state.running=saved.running;
        renderCollab=saved.renderCollab; renderContest=saved.renderContest;
        renderDeliverables=saved.renderDeliverables; renderApproval=saved.renderApproval;
      }
    })()`, true);
    assert(r.mode === 'auto' && r.sent.length === 1, '切换模式没有继续待答卡片');
    assert(r.sent[0].text === '方案b' && r.sent[0].decision.selected_id === 'b' && r.sent[0].decision.decision_id === 'toggle-decision', '未使用显式推荐或卡片绑定：' + JSON.stringify(r));
    return '推荐 b + decision_id，无网络调用';
  });

  // 折叠式步骤时间线（v2.6）：3 步 1 失败 → 计数与标红都要对
  await check('折叠式步骤时间线：步数/失败计数/summary 文案', async () => {
    const r = await client.evaluate(`(() => {
      const cs = document.querySelector('#chatStream');
      cs.innerHTML = '';
      const host = document.createElement('div');
      cs.appendChild(host);
      renderToolCard(host, 'read_file', 'a.py', true, 'ok', 12);
      renderToolCard(host, 'run_python', 'b.py', false, '[工具执行失败] boom', 30);
      renderToolCard(host, 'write_file', 'c.py', null, '', null);
      const g = host.querySelector('details.steps');
      return {
        groups: cs.querySelectorAll('details.steps').length,
        cards: g.querySelectorAll('.toolcard').length,
        bad: g.querySelectorAll('.toolcard span.bad').length,
        run: g.querySelectorAll('.toolcard span.run').length,
        summary: g.querySelector('summary').textContent,
        open: g.open,
      };
    })()`);
    assert(r.groups === 3 - 2, '3 张卡应收进 1 个折叠块，实际 ' + r.groups); // 3 张卡 → 1 块
    assert(r.cards === 3, '折叠块里应有 3 张工具卡，实际 ' + r.cards);
    assert(r.bad === 1, '应恰好 1 个 span.bad（失败的 run_python），实际 ' + r.bad + ' —— 这个数不对，失败步骤在折叠态下就被埋掉了');
    assert(r.run === 1, 'ok=null 的进行中卡片应渲染 span.run(⏳)，实际 ' + r.run + ' —— 此前 falsy 会被误画成 ✗');
    assert(/3\s*步/.test(r.summary), 'summary 未显示步数：' + JSON.stringify(r.summary));
    assert(/1\s*步失败/.test(r.summary), 'summary 未显示失败计数：' + JSON.stringify(r.summary));
    assert(r.open === false, '折叠块默认应是收起态（历史重放不能铺满屏）');
    return r.summary.replace(/\s+/g, ' ').trim();
  });

  await check('用量卡 updateCost：输入/输出/调用/缓存命中/识图（不显示费用）', async () => {
    const r = await client.evaluate(`(() => {
      updateCost({ cost: 1.2345, prompt_tokens: 20000, completion_tokens: 3000, calls: 7, cache_hit_tokens: 5000, vision_calls: 2 });
      const t = id => (document.querySelector('#' + id) || {}).textContent;
      return { est: t('estCost'), tIn: t('tIn'), tOut: t('tOut'), tCalls: t('tCalls'), tHit: t('tHit'), tVision: t('tVision'), costCard: !!document.querySelector('#costCard') };
    })()`);
    assert(r.est === undefined, '费用字段不应再显示：' + r.est);
    assert(!r.costCard, '费用卡片不应再显示');
    assert(r.tCalls === '7', 'tCalls 不对：' + r.tCalls);
    assert(r.tHit === '25%', '缓存命中率应为 5000/20000=25%，实际 ' + r.tHit);
    assert(r.tVision === '2', 'tVision 不对：' + r.tVision);
    assert(r.tIn === '20.0k', 'tIn 应走 fmtK 千分位：' + r.tIn);
    return `入 ${r.tIn} · 调用 ${r.tCalls} · 缓存 ${r.tHit}`;
  });

  // 交付物面板是唯一一个"渲染函数 + 服务端扫描 + 沙箱根解析"三者串起来的界面块，
  // 也正好是 v2.6 外部项目改造里最容易断的一环（打不开、列不出）。所以这里不喂假数据，
  // 而是真建一个项目、真落几个文件，走真接口。
  await check('交付物面板：建项目→落文件→/api/artifacts→列表渲染', async () => {
    const pid = 'render_probe';
    const mk = (rel) => { const p = path.join(tmp, 'workspace', 'projects', pid, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
    // WORKSPACE = resolve(APP_DIR,'..') → 副本布局下就是 tmp/workspace/projects/<pid>
    const mkErr = await client.evaluate(`(async () => {
      const r = await api('/api/project/new', { id: ${JSON.stringify(pid)}, title: '渲染测试项目' });
      return r && r.error ? r.error : '';
    })()`, true);
    assert(!mkErr, '建项目失败：' + mkErr);
    for (const f of ['paper/main.tex', 'paper/main.pdf', 'result1.xlsx', 'figures/fig1.png']) mk(f);

    const r = await client.evaluate(`(async () => {
      await renderDeliverables(null, ${JSON.stringify(pid)});
      const list = document.querySelector('#deliverList');
      return { text: list.textContent, proj: (document.querySelector('#deliverProj')||{}).textContent };
    })()`, true);
    for (const want of ['paper/main.tex', 'result1.xlsx', 'fig1.png']) {
      assert(r.text.includes(want), `交付物列表缺少 ${want}：` + r.text.slice(0, 300));
    }
    assert(!/（还没有产物|读取失败|暂无/.test(r.text), '交付物面板停在空态/错误态：' + r.text.slice(0, 300));
    assert(r.proj === pid, `交付物面板的项目标签应为 ${pid}，实际 ` + r.proj);
    return `列出 4 个产物 · 项目 ${r.proj}`;
  });

  await check('任务清单 renderTodos：三态图标', async () => {
    const r = await client.evaluate(`(() => {
      renderTodos([{ content: '读题', status: 'completed' }, { content: '建模', status: 'in_progress' }, { content: '写论文', status: 'pending' }]);
      const el = document.querySelector('#todoList');
      return { html: el.innerHTML, done: el.querySelectorAll('.done').length, prog: el.querySelectorAll('.prog').length };
    })()`);
    assert(r.done === 1 && r.prog === 1, '三态渲染不对：done=' + r.done + ' prog=' + r.prog);
    assert(/读题/.test(r.html) && /写论文/.test(r.html), '条目缺失：' + r.html.slice(0, 200));
    return '3 条 / 完成 1 进行中 1';
  });

  await check('项目记忆 renderMemory：空态与截断', async () => {
    const r = await client.evaluate(`(() => {
      renderMemory([]);
      const empty = document.querySelector('#memList').textContent;
      renderMemory([{ text: 'x'.repeat(300) }]);
      const long = document.querySelector('#memList').textContent;
      return { empty, len: long.length };
    })()`);
    assert(/暂无/.test(r.empty), '空记忆应显示（暂无），实际 ' + JSON.stringify(r.empty));
    assert(r.len <= 130, '长记忆未按 120 字截断，实际长度 ' + r.len);
    return `空态正常 · 300 字截到 ${r.len}`;
  });

  await check('状态条 setWork：显示/隐藏/文案', async () => {
    const r = await client.evaluate(`(() => {
      setWork('正在跑 MATLAB 求解', '第 3 步 · 12s');
      const bar = document.querySelector('#workBar');
      const shown = { disp: bar.style.display, text: document.querySelector('#workText').textContent, meta: document.querySelector('#workMeta').textContent };
      setWork(null);
      return { shown, hidden: document.querySelector('#workBar').style.display };
    })()`);
    assert(r.shown.disp === '', 'setWork 未把状态条显示出来（display=' + r.shown.disp + '）');
    assert(/MATLAB/.test(r.shown.text), 'workText 不对：' + r.shown.text);
    assert(/第 3 步/.test(r.shown.meta), 'workMeta 不对：' + r.shown.meta);
    assert(r.hidden === 'none', 'setWork(null) 未隐藏状态条（display=' + r.hidden + '）');
    return '显示→隐藏 往返正常';
  });

  await check('renderMD 内联产物：命中才生成可点 chip，未命中保持纯文本', async () => {
    const r = await client.evaluate(`(() => {
      state.deliverables = [{ path: 'paper/main.tex', abs: 'C:/work/p/paper/main.tex' }];
      const hit = renderMD('见 \\u0060paper/main.tex\\u0060 这份');
      const miss = renderMD('见 \\u0060unknown/zzz.tex\\u0060 这份');
      return { hit, miss };
    })()`);
    assert(/class="artifact"/.test(r.hit), '命中的产物路径没变成可点 chip：' + r.hit.slice(0, 200));
    assert(/data-artpath=/.test(r.hit), 'chip 没带 data-artpath，点了不知道开哪个文件');
    assert(!/class="artifact"/.test(r.miss), '未命中的路径也被做成了 chip —— 这是猜测，会点空');
    return '命中可点 · 未命中纯文本';
  });

  await check('所有项目统计独立展示，缓存不重复，时间范围切换和刷新可用', async () => {
    const empty = await client.evaluate(`(async () => {
      await window.openUsageStats();
      return { text: document.querySelector('#dlgUsage').textContent, status: document.querySelector('#usageStatus').textContent };
    })()`, true);
    assert(/暂无|尚无|没有/.test(empty.text), '空数据没有说明');
    const meter = require('./meter');
    const at = Date.now() - 1000;
    meter.record(appCopy, { t: at, model: 'model-a', project_id: 'alpha', kind: 'main', prompt_tokens: 1000, completion_tokens: 200, cache_hit_tokens: 600 });
    meter.record(appCopy, { t: at, model: 'model-b', project_id: 'beta', kind: 'sub', prompt_tokens: 300, completion_tokens: 50, cache_hit_tokens: 0 });
    const r = await client.evaluate(`(async () => {
      const before = document.querySelector('#usageCard').textContent;
      state.projectFilter = 'alpha';
      document.querySelector('#usageRefresh').click();
      for (let i = 0; i < 80 && !document.querySelector('#usageModels').textContent.includes('model-a'); i++) await new Promise(r => setTimeout(r, 50));
      const stats = await api('/api/usage/stats?period=week');
      const text = document.querySelector('#dlgUsage').textContent;
      document.querySelector('[data-usage-period="month"]').click();
      await new Promise(r => setTimeout(r, 150));
      const month = document.querySelector('[data-usage-period="month"]').getAttribute('aria-pressed');
      document.querySelector('[data-usage-period="all"]').click();
      await new Promise(r => setTimeout(r, 150));
      const all = document.querySelector('[data-usage-period="all"]').getAttribute('aria-pressed');
      const unchanged = before === document.querySelector('#usageCard').textContent;
      document.querySelector('#dlgUsage').close();
      state.projectFilter = null;
      return { stats, text, month, all, unchanged };
    })()`, true);
    assert(r.stats.totals.all.tokens === 1550 && r.stats.totals.all.calls === 2, 'Token被缓存或子代理重复累计');
    assert(r.stats.byProject.length === 2 && r.text.includes('model-a') && r.text.includes('model-b'), '项目筛选影响全局统计或模型分布未显示');
    assert(r.month === 'true' && r.all === 'true', '月份/累计切换没有激活');
    assert(r.unchanged, '全局统计改写了本会话卡片');
  });

  await check('统计失败可重试，较慢旧响应不覆盖新范围，模型名称按文本显示', async () => {
    const r = await client.evaluate(`(async () => {
      const originalApi = api;
      try {
        const data = await originalApi('/api/usage/stats?period=all');
        api = async () => { throw new Error('离线测试'); };
        await openUsageStats();
        const error = document.querySelector('#usageStatus').textContent;
        const pending = [];
        api = () => new Promise(resolve => pending.push(resolve));
        const slow = openUsageStats();
        const fast = openUsageStats();
        const model = '<img src=x onerror="window.usageXss=true">';
        pending[1]({ ...data, byModel: [{ model, tokens: 10, calls: 1 }] });
        await fast;
        pending[0]({ ...data, byModel: [{ model: 'stale-result', tokens: 9, calls: 1 }] });
        await slow;
        const text = document.querySelector('#usageModels').textContent;
        const safe = !document.querySelector('#usageModels img') && !window.usageXss;
        api = originalApi;
        await openUsageStats();
        const recovered = document.querySelector('#usageStatus').dataset.kind !== 'error';
        document.querySelector('#dlgUsage').close();
        return { error, text, model, safe, recovered };
      } finally { api = originalApi; }
    })()`, true);
    assert(r.error.includes('离线测试') && r.recovered, '统计错误未说明或无法恢复');
    assert(r.text.includes(r.model) && !r.text.includes('stale-result'), '旧响应覆盖了新数据');
    assert(r.safe, '模型名被当作HTML执行');
  });

  await check('真实历史会话恢复累计且不伪造本周/月；删除后历史保留', async () => {
    const id = 'usage-history-fixture';
    const dir = path.join(appCopy, 'data', 'sessions');
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, project_id: 'old-project', mode: 'free', system: '', messages: [], usage: { prompt_tokens: 1000, completion_tokens: 20, calls: 3 } }));
    const r = await client.evaluate(`(async () => {
      const old = await api('/api/usage/stats?period=all');
      await openUsageStats();
      const note = document.querySelector('#usageCoverage').textContent;
      const hidden = document.querySelector('#usageCoverage').hidden;
      await api('/api/session/delete', { id: '${id}', hard: true });
      const after = await api('/api/usage/stats?period=all');
      document.querySelector('#dlgUsage').close();
      return { old, after, note, hidden };
    })()`, true);
    assert(r.old.totals.all.tokens === 2570 && r.old.totals.week.tokens === 1550, '历史恢复与明细重叠或伪造日期');
    assert(r.after.totals.all.tokens === r.old.totals.all.tokens, '删除会话导致历史统计减少');
    assert(!r.hidden && /未分期历史/.test(r.note), '历史覆盖范围未在界面说明：' + JSON.stringify({note:r.note,hidden:r.hidden,coverage:r.old.coverage}));
  });

  await check('按实际模型协议限制推理选项，思考预算单独标注', async () => {
    const r = await client.evaluate(`(async () => {
      const before = (await api('/api/bootstrap')).settings;
      try {
        await api('/api/settings', { provider_models: { ...before.provider_models, glm:['glm-5.3'], moonshot:['kimi-k3'], qwen:['qwen3.8-flash'], anthropic:['claude-sonnet-5-5'] }, provider_kinds: { ...before.provider_kinds, glm:'openai', anthropic:'anthropic' } });
        const boot = await api('/api/bootstrap');
        renderModelReasoningRows({...boot,models:[...(boot.models||[]),
          {id:'limited-test',provider:'relay-test',providerName:'Relay test',reasoning:{mode:'openai-effort',levels:['provider_default','low','high'],note:'test'}},
          {id:'single-test',provider:'switch-test',providerName:'Switch test',reasoning:{mode:'kimi-switch',levels:['provider_default','none','high'],note:'test'}}]});
        const values = key => [...document.querySelector('[data-model-key="'+key+'"]').options].map(o => o.value);
        const supported = { glm: values('glm:glm-5.3'), kimi: values('moonshot:kimi-k3'), qwen: values('qwen:qwen3.8-flash'), claude: values('anthropic:claude-sonnet-5-5') };
        const budget = document.querySelector('[data-model-key="qwen:qwen3.8-flash"]')?.textContent || '';
        const astraSlider = document.querySelector('[data-model-key="relay-test:limited-test"]').closest('.reasoning-row');
        const qwenSlider = document.querySelector('[data-model-key="switch-test:single-test"]').closest('.reasoning-row');
        const range = astraSlider.querySelector('.model-reasoning-slider');
        range.value='0'; range.dispatchEvent(new Event('input'));
        const routedLow=astraSlider.querySelector('select').value;
        range.value='4'; range.dispatchEvent(new Event('input'));
        const routedHigh=astraSlider.querySelector('select').value;
        const singleLevel = qwenSlider.querySelector('.model-reasoning-slider');
        singleLevel.value='0'; singleLevel.dispatchEvent(new Event('input'));
        const fixedRoute=qwenSlider.querySelector('select').value;
        astraSlider.querySelector('.reasoning-default').click();
        const providerDefault=astraSlider.querySelector('select').value;
        await api('/api/settings', {provider_kinds:{ ...before.provider_kinds, glm:'anthropic', anthropic:'openai' }});
        renderModelReasoningRows(await api('/api/bootstrap'));
        const restricted = { glm: values('glm:glm-5.3'), claude: values('anthropic:claude-sonnet-5-5') };
        return {supported,budget,restricted,routedLow,routedHigh,fixedRoute,providerDefault,singleDisabled:singleLevel.disabled};
      } finally {
        await api('/api/settings', { provider_models:before.provider_models||{},provider_kinds:before.provider_kinds||{} });
        state.boot=await api('/api/bootstrap'); renderModelReasoningRows(state.boot);
      }
    })()`, true);
    assert(r.supported.glm.join(',') === ',provider_default,low,high,max', JSON.stringify(r));
    assert(r.supported.kimi.join(',') === ',provider_default,low,high,max', JSON.stringify(r));
    assert(r.supported.claude.includes('xhigh') && !r.supported.claude.includes('none'), '强制思考模型提供了关闭');
    assert(/思考预算/.test(r.budget), 'Qwen预算被标为原生强度');
    assert(r.restricted.glm.length === 2 && r.restricted.claude.length === 2, '未证实接口也可选强度');
    assert(r.routedLow === 'low' && r.routedHigh === 'high', '滑杆没有映射到该中转模型当前稳定的低/高档：' + JSON.stringify(r));
    assert(r.fixedRoute === 'high', '单强度模型没有路由到稳定档位：' + JSON.stringify(r));
    assert(r.providerDefault === 'provider_default', '提供商默认入口未保留');
    const label = await client.evaluate(`(() => {
      renderReasoningStatus({requested:'high',sent:null,status:'api_accepted',model:'mock',provider:'relay'});
      const text=document.querySelector('#reasoningPill').textContent;
      renderReasoningStatus(state.session?.resolved_reasoning);
      return text;
    })()`);
    assert(label.includes('默认（已回退）') && !label.includes('推理 高'), '回退默认后仍显示高强度已接受：' + label);
    const cacheLabel = await client.evaluate(`(() => {
      renderReasoningStatus({requested:'high',sent:null,effective:'provider_default',status:'cache_hit',model:'mock',provider:'relay'});
      const text=document.querySelector('#reasoningPill').textContent;
      renderReasoningStatus(state.session?.resolved_reasoning);
      return text;
    })()`);
    assert(cacheLabel.includes('默认（已回退）') && cacheLabel.includes('缓存复用'), '默认缓存误显示高强度或新请求：' + cacheLabel);
  });

  await check('金乌双翼独立振动后腾飞，扶桑原地不动；支持减少动态效果', async () => {
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await client.evaluate('window.xiheAppearance.playIntro()', true);
    const frames = [];
    for (const at of [600, 1600, 3400]) {
      const frame = await client.evaluate(`(() => {
        const scene = document.querySelector('#jinwuMotionScene');
        if (!scene) return null;
        for (const animation of scene.getAnimations({subtree:true})) { animation.pause(); animation.currentTime=${at}; }
        window.xiheJinwuMotion.seek?.(${at});
        const transform = selector => getComputedStyle(scene.querySelector(selector)).transform;
        return { left:transform('.wing-left'),right:transform('.wing-right'),bird:transform('.bird-flight'),tree:transform('#fusang') };
      })()`);
      frames.push(frame);
      if (process.env.XIHE_SCREENSHOT_DIR) {
        fs.mkdirSync(path.resolve(process.env.XIHE_SCREENSHOT_DIR), { recursive:true });
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(process.env.XIHE_SCREENSHOT_DIR, 'intro-frame-' + at + '.png'), Buffer.from(shot.data, 'base64'));
      }
    }
    assert(frames.every(Boolean), '场景未加载到真实SVG');
    assert(new Set(frames.map(f=>f.left)).size === 3 && new Set(frames.map(f=>f.right)).size === 3, '翅膀并未独立振动');
    assert(new Set(frames.map(f=>f.bird)).size === 3 && frames.every(f=>f.tree==='none'), '鸟未腾空或扶桑跟着鸟移动');
    const articulation = await client.evaluate(`(() => {
      const motion = window.xiheJinwuMotion;
      if (!motion.seek) return { missing: true };
      const scene = document.querySelector('#jinwuMotionScene');
      const snapshots = [350, 900, 1350, 1750, 2300, 3100].map(ms => {
        motion.seek(ms);
        return { wing: scene.querySelector('.wing-left .primary-feather')?.getAttribute('d'),
          wrist: scene.querySelector('.wing-left .wing-cover')?.getAttribute('d'),
          tail: scene.querySelector('.tail-feather')?.getAttribute('d'),
          toes: scene.querySelector('.bird-toes')?.getAttribute('d'),
          head: scene.querySelector('.bird-head')?.getAttribute('transform') };
      });
      // 先飞入落枝：开场鸟在画外左上，ENTER 后才站上扶桑
      motion.seek(0);
      const offstage = scene.querySelector('.bird-flight').getAttribute('transform');
      motion.seek(motion.duration - 4200);
      const perched = scene.querySelector('.bird-flight').getAttribute('transform');
      const enter = motion.duration - 4200;
      motion.seek(enter + 200);
      const openEye = scene.querySelector('.bird-eye').getAttribute('transform');
      motion.seek(enter + 320);
      const closedEye = scene.querySelector('.bird-eye').getAttribute('transform');
      const invalidFrames = [];
      for (let ms = 0; ms <= motion.duration; ms += 25) {
        motion.seek(ms);
        if ([...scene.querySelectorAll('[d],[transform]')].some(el => /NaN|Infinity/.test((el.getAttribute('d') || '') + (el.getAttribute('transform') || '')))) invalidFrames.push(ms);
      }
      return { offstage, perched, snapshots, openEye, closedEye, invalidFrames, feathers: scene.querySelectorAll('.primary-feather').length };
    })()`);
    assert(!articulation.missing, '缺少可逐帧检查的关节动画');
    assert(articulation.feathers >= 16, '翅膀仍是一整块，缺少独立飞羽');
    assert(/^translate\(-\d{3}/.test(articulation.offstage) && !/^translate\(-\d{3}/.test(articulation.perched), '缺少飞入落枝的出场动画：' + articulation.offstage);
    assert(articulation.openEye !== articulation.closedEye, '眨眼动作未生效');
    assert(articulation.invalidFrames.length === 0, '动画包含无效几何坐标：' + articulation.invalidFrames.join(','));
    for (const part of ['wing','wrist','tail','toes','head'])
      assert(new Set(articulation.snapshots.map(s=>s[part])).size >= 3 && articulation.snapshots.every(s=>s[part]), part + ' 未随飞行动作独立变化');
    await client.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
    await client.evaluate('window.xiheAppearance.playIntro()', true);
    assert(await client.evaluate('document.querySelector("#jinwuMotionScene").getAnimations({subtree:true}).length===0'), '减少动态效果设置未生效');
    await client.evaluate('document.querySelector("#btnSkipIntro").click()');
    await client.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    if (process.env.XIHE_MOTION_FRAMES_DIR) {
      const framesDir = path.resolve(process.env.XIHE_MOTION_FRAMES_DIR);
      fs.mkdirSync(framesDir, { recursive: true });
      await client.evaluate('window.xiheAppearance.playIntro()', true);
      await client.evaluate('window.xiheJinwuMotion.seek(0)');
      const clip = await client.evaluate(`(() => { const r=document.querySelector('.intro-scene').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()`);
      for (let i = 0; i <= 106; i++) {
        await client.evaluate(`(() => {const scene=document.querySelector('#jinwuMotionScene');for(const a of scene.getAnimations({subtree:true})){a.pause();a.currentTime=${i*50};}window.xiheJinwuMotion.seek(${i*50});})()`);
        const shot = await client.send('Page.captureScreenshot', {format:'png',clip});
        fs.writeFileSync(path.join(framesDir,String(i).padStart(3,'0')+'.png'),Buffer.from(shot.data,'base64'));
      }
      await client.evaluate('document.querySelector("#btnSkipIntro").click()');
    }
  });

  await check('已有会话刷新后不选附件也能直接键入', async () => {
    const created = await client.evaluate(`api('/api/session/new', { mode: 'free' })`, true);
    assert(created && created.id, '隔离副本创建测试会话失败');
    await client.send('Page.reload');
    let opened = false;
    for (let i = 0; i < 80 && !opened; i++) {
      opened = await client.evaluate(`typeof state !== 'undefined' && state.session?.id === ${JSON.stringify(created.id)}`).catch(() => false);
      if (!opened) await sleep(100);
    }
    assert(opened, '已有会话刷新后未恢复');
    await client.send('Input.insertText', { text: '会话中直接输入' });
    const r = await client.evaluate(`(() => ({ focused: document.activeElement === document.querySelector('#input'), value: document.querySelector('#input').value, attachments: state.attachments.length }))()`);
    await client.evaluate(`document.querySelector('#input').value = ''`);
    assert(r.focused && r.value === '会话中直接输入' && r.attachments === 0, '已有会话刷新后无法键入：' + JSON.stringify(r));
  });

  await check('同一聊天切入临时小任务并返回主线，保留草稿且恢复原模型', async () => {
    const result = await client.evaluate(`(async () => {
      const previous = state.session;
      const originalChat = sseChat;
      const requests = [];
      sseChat = async body => { requests.push({ ...body, switching: state.taskFocusChanging }); };
      try {
        const created = await api('/api/session/new', { mode: 'free', title: '界面局部任务回归' });
        await openSession(created.id);
        const originalModel = state.session.model;
        document.querySelector('#input').value = '先解释这个小问题';
        await document.querySelector('#btnLocalTask').onclick();
        const local = {
          kind: state.session.task_focus?.kind,
          effort: state.session.effort,
          canReturn: !document.querySelector('#btnReturnMain').hidden,
          hint: document.querySelector('#taskFocusHint').textContent,
          draft: document.querySelector('#input').value,
        };
        await api('/api/session/model', { id: created.id, model: 'offline:flash' });
        await document.querySelector('#btnReturnMain').onclick();
        return { local, restored: !state.session.task_focus && state.session.model === originalModel,
          originalModel, returnedModel: state.session.model,
          hidden: document.querySelector('#btnReturnMain').hidden, requests,
          sameSession: state.session.id === created.id };
      } finally {
        sseChat = originalChat;
        document.querySelector('#input').value = '';
        if (previous) await openSession(previous.id);
      }
    })()`, true);
    assert(result.local.kind === 'local' && result.local.effort === 'fast' && result.local.canReturn,
      '临时入口未接入真实持久化接口：' + JSON.stringify(result));
    assert(result.local.draft === '先解释这个小问题' && /主线已暂停/.test(result.local.hint), '草稿丢失或范围提示错误');
    assert(result.restored && result.hidden && result.sameSession, '返回未恢复原模型或切换了会话：' + JSON.stringify(result));
    assert(result.requests.length === 1 && /继续主线/.test(result.requests[0].text), '返回未明确续接原主线');
    assert(result.requests[0].switching === false, '主线续跑时切换锁未释放，后续无法再暂停处理小问题');
  });

  await check('妈妈杯项目新会话继承档案，审稿范围与项目验收真实显示', async () => {
    const r = await client.evaluate(`(async () => {
      await api('/api/project/new', { id:'ui_mama_practice', title:'妈妈杯界面回归' });
      await api('/api/project/contest', { project_id:'ui_mama_practice', contest_kind:'mathorcup-bigdata', edition:'2026', stage:'preliminary', track:'B' });
      await document.querySelector('#btnNewSession').onclick();
      const project=document.querySelector('#nsProject'); project.value='ui_mama_practice'; project.dispatchEvent(new Event('change'));
      const inherited={kind:document.querySelector('#nsContestKind').value,edition:document.querySelector('#nsEdition').value};
      document.querySelector('#nsTaskScope').value='review';
      await document.querySelector('.mode-card[data-mode="math"]').onclick();
      await renderAcceptance(state.session);
      return { inherited,kind:state.session.contest_kind,scope:state.session.task_scope,
        profile:document.querySelector('#acceptanceProfile').textContent,
        headline:document.querySelector('#acceptanceHeadline').textContent,
        rows:document.querySelector('#acceptanceStages').textContent,
        freezeDisabled:document.querySelector('#btnFreezeRelease').disabled,
        retryDisabled:document.querySelector('#btnRetryTask').disabled };
    })()`, true);
    assert(r.inherited.kind === 'mathorcup-bigdata' && r.inherited.edition === '2026', '项目档案未回填真实弹窗：'+JSON.stringify(r));
    assert(r.kind === 'mathorcup-bigdata' && r.scope === 'review', '正常UI创建路径未继承赛事或范围：'+JSON.stringify(r));
    assert(/项目档案v1/.test(r.profile) && /验收尚未完成/.test(r.headline), '项目验收未显示真实未完成状态：'+JSON.stringify(r));
    assert(/本范围不要求/.test(r.rows) && r.freezeDisabled && r.retryDisabled, '审稿误要求整题交付或未验收即可冻结：'+JSON.stringify(r));
  });
  await check('主张追溯按历史验收会话展示失效原因和可打开证据', async () => {
    const r = await client.evaluate(`(async () => {
      const originalApi=api, previous=state.session;
      try {
        await api('/api/project/new',{id:'ui_trace',title:'追溯界面回归'});
        const old=await api('/api/session/new',{mode:'math',project_id:'ui_trace',title:'旧解'});
        const latest=await api('/api/session/new',{mode:'math',project_id:'ui_trace',title:'新解'});
        state.session=latest;
        let requested='';
        api=async (url,...args) => {
          if (url.startsWith('/api/project/trace?')) {
            requested=url;
            return {project_id:'ui_trace',session_id:old.id,project_dir:'C:/work/isolated/workspace/projects/ui_trace',
              trace:{status:'stale',issues:['摘要引用需更新'],limits:['仅核对登记引用'],claims:[
                {id:'delivery',text:'平均时间为 450 秒',scope:'东区占 65%',question_id:1,status:'stale',reasons:['图件已变更'],run_id:'run3',
                  source:{path:'outputs/result.json',field:'mean_A',unit:'分钟'},value:450,output_unit:'秒',transform:{kind:'affine',scale:60,offset:0},
                  figures:[{path:'paper/figures/site.png',panel:'A'}],references:[{kind:'abstract',path:'paper/main.tex',quote:'选 A'}]},
                {id:'threshold',kind:'analytic',question_id:1,text:'条件性阈值',scope:'p属于[0,1]',status:'fresh',proof:{path:'findings/proof.md',review_boundary:'只检查线性系数'},verification:{run_id:'verify1',files:[{path:'scripts/check.py'},{path:'verification_runs/verify1/checks.json'}]},references:[]}
              ],diagrams:[{id:'decision',question_id:1,path:'figures/decision.tex',panel:'选择示意图',status:'stale',reasons:['前提已变化'],sources:[{kind:'proof',claim_id:'threshold',path:'findings/proof.md'}]}]}};
          }
          return originalApi(url,...args);
        };
        await renderAcceptance(null,'ui_trace',old.id);
        const panel=document.querySelector('#claimTracePanel'); panel.open=true;
        return {selected:document.querySelector('#acceptanceSession').value,requested,
          status:document.querySelector('#claimTraceStatus').textContent,
          text:document.querySelector('#claimTraceBody').textContent,
          buttons:[...document.querySelectorAll('#claimTraceBody button')].map(x=>x.textContent)};
      } finally {api=originalApi; state.session=previous;}
    })()`, true);
    assert(r.requested.includes('session_id='+encodeURIComponent(r.selected)), '追溯读取了当前会话而非所选历史会话：'+JSON.stringify(r));
    assert(r.status==='需更新' && /图件已变更/.test(r.text) && /摘要引用需更新/.test(r.text), '失效状态或原因未显示：'+JSON.stringify(r));
    assert(/原始单位 分钟/.test(r.text) && /450 秒/.test(r.text) && !/450 分钟/.test(r.text), '单位转换错误沿用了源单位：'+JSON.stringify(r));
    assert(r.buttons.some(x=>/result\.json/.test(x)) && r.buttons.some(x=>/site\.png/.test(x)) && r.buttons.some(x=>/main\.tex/.test(x)), '无法从主张打开结果、图和摘要：'+JSON.stringify(r));
    assert(/有限核查不等于通用数学证明/.test(r.text) && /前提已变化/.test(r.text) && r.buttons.some(x=>/check\.py/.test(x)) && r.buttons.some(x=>/checks\.json/.test(x)) && r.buttons.some(x=>/decision\.tex/.test(x)), '解析核查或示意图无法追到实际文件：'+JSON.stringify(r));
  });
  await check('模板库选择亚太杯、保存后新会话生效，仿真模板保留赛事', async () => {
    const r = await client.evaluate(`(async () => {
      const previous=state.session, previousFilter=state.projectFilter;
      try {
        state.boot=await api('/api/bootstrap');
        await api('/api/project/new',{id:'ui_template',title:'模板选择回归'});
        await fillProjectSwitch(); state.projectFilter='ui_template';
        await document.querySelector('#btnProjectPlan').onclick();
        const select=document.querySelector('#planTemplate');
        const choices=Array.from(select.options).map(o=>o.value);
        select.value='apmcm'; select.dispatchEvent(new Event('change'));
        const description=document.querySelector('#planTemplateDescription').textContent;
        await document.querySelector('#btnPlanTemplate').onclick();
        const preview=JSON.parse(document.querySelector('#planJson').value);
        const beforeSave=await api('/api/project/plan?project_id=ui_template');
        await document.querySelector('#btnPlanSave').onclick();
        const saved=await api('/api/project/plan?project_id=ui_template');
        const session=await api('/api/session/new',{mode:'math',project_id:'ui_template'});
        select.value='simulation'; select.dispatchEvent(new Event('change'));
        await document.querySelector('#btnPlanTemplate').onclick();
        const simulation=JSON.parse(document.querySelector('#planJson').value);
        document.querySelector('#planProblemTypes').value='kinematics';
        document.querySelector('#planProblemTypes').dispatchEvent(new Event('input'));
        document.querySelector('#planStages').value='solving';
        document.querySelector('#planStages').dispatchEvent(new Event('input'));
        await document.querySelector('#btnPlanAssess').onclick();
        const assessmentText=document.querySelector('#planEffective').textContent;
        const afterAssess=await api('/api/project/plan?project_id=ui_template');
        const currentAssessment=document.querySelector('#planCurrentSession').textContent;
        const assessmentStatus=document.querySelector('#planStatus').textContent;
        const draftBefore=document.querySelector('#planJson').value, originalApi=api;
        let releaseAssess;
        try {
          api=(url,...args)=>url==='/api/project/plan/assess'?new Promise(resolve=>{releaseAssess=resolve}):originalApi(url,...args);
          const pendingAssess=document.querySelector('#btnPlanAssess').onclick();
          document.querySelector('#planProblemTypes').value='pde'; document.querySelector('#planProblemTypes').dispatchEvent(new Event('input'));
          releaseAssess({effective:{entries:[],notices:['STALE_ASSESSMENT']}}); await pendingAssess;
        } finally {api=originalApi;}
        const ignoredStale=!document.querySelector('#planEffective').textContent.includes('STALE_ASSESSMENT');
        return {choices,description,preview:preview.contest.contest_kind,revisionBefore:beforeSave.revision,
          saved:saved.plan.contest.contest_kind,session:session.contest_kind,skill:session.skill_plan_snapshot.entries[0].name,
          simulation:simulation.contest.contest_kind,method:simulation.skills.research.primary,assessmentText,assessmentStatus,
          revisionUnchanged:afterAssess.revision===saved.revision,ignoredStale,context:JSON.parse(draftBefore).task_context};
      } finally {
        document.querySelector('#btnPlanClose').onclick(); state.session=previous; state.projectFilter=previousFilter;
      }
    })()`, true);
    assert(r.choices.includes('apmcm')&&r.choices.includes('simulation')&&r.choices.includes('cumcm'), '模板选项不全：'+JSON.stringify(r));
    assert(r.preview==='apmcm'&&r.revisionBefore===0, '载入模板必须只是草稿：'+JSON.stringify(r));
    assert(r.saved==='apmcm'&&r.session==='apmcm'&&r.skill==='contest-modeling-apmcm', '保存未连接新会话：'+JSON.stringify(r));
    assert(r.simulation==='apmcm'&&r.method==='pde-award-solve', '方法模板改写了赛事：'+JSON.stringify(r));
    assert(r.context.problem_types[0]==='kinematics' && r.context.stages[0]==='solving', '任务条件表单未进入草稿：'+JSON.stringify(r));
    assert(/可安装/.test(r.assessmentText)&&/不适配当前任务/.test(r.assessmentText)&&/因不适配未注入/.test(r.assessmentText)&&/效果未验证/.test(r.assessmentText), '三种状态显示不准确：'+JSON.stringify(r));
    assert(r.revisionUnchanged && /仍未保存/.test(r.assessmentStatus) && r.ignoredStale, '草稿检查保存了方案或旧响应覆盖了新草稿：'+JSON.stringify(r));
  });
  await check('项目方案真实表单保存、冻结会话、JSON导出导入及慢回包隔离', async () => {
    const r = await client.evaluate(`(async () => {
      const previous=state.session, previousFilter=state.projectFilter, originalApi=api;
      const originalCreate=URL.createObjectURL, originalClick=HTMLAnchorElement.prototype.click;
      try {
        await api('/api/project/new',{id:'ui_plan',title:'项目方案界面回归'});
        await api('/api/project/new',{id:'ui_plan_second',title:'另一方案'});
        await fillProjectSwitch(); state.projectFilter='ui_plan';
        await document.querySelector('#btnProjectPlan').onclick();
        const mode=document.querySelector('[data-slot="research"] .plan-slot-mode');
        const skill=document.querySelector('[data-slot="research"] .plan-slot-skill');
        mode.value='replace'; skill.value='ui-method'; mode.dispatchEvent(new Event('change'));
        document.querySelector('#planTraceRequired').checked=true;
        document.querySelector('#planTraceRequired').dispatchEvent(new Event('change'));
        const extraPlugin=document.querySelector('[data-plugin-id="extra-figures"]'); extraPlugin.checked=true; extraPlugin.dispatchEvent(new Event('change'));
        document.querySelector('#planEvidenceFigures').checked=true;
        document.querySelector('#planEvidenceFigures').dispatchEvent(new Event('change'));
        await document.querySelector('#btnPlanSave').onclick();
        const saved=await api('/api/project/plan?project_id=ui_plan');
        state.session=await api('/api/session/new',{mode:'math',project_id:'ui_plan'});
        const sessionRequiresTrace=state.session.claim_trace_required;
        renderCurrentPlanSnapshot();
        const frozenBefore=document.querySelector('#planCurrentSession').textContent;
        document.querySelector('[data-slot="research"] .plan-slot-mode').value='off';
        document.querySelector('[data-slot="research"] .plan-slot-mode').dispatchEvent(new Event('change'));
        document.querySelector('#planTraceRequired').checked=false;
        document.querySelector('#planTraceRequired').dispatchEvent(new Event('change'));
        document.querySelector('#planEvidenceFigures').checked=false;
        document.querySelector('#planEvidenceFigures').dispatchEvent(new Event('change'));
        await document.querySelector('#btnPlanSave').onclick();
        const frozenAfter=document.querySelector('#planCurrentSession').textContent;
        let blob; URL.createObjectURL=value=>{blob=value;return originalCreate(value)};
        HTMLAnchorElement.prototype.click=function(){};
        await document.querySelector('#btnPlanExport').onclick();
        const packaged=JSON.parse(await blob.text());
        packaged.plan.skills.research={mode:'off',primary:null,fallbacks:[]};
        Object.defineProperty(document.querySelector('#planImportFile'),'files',{configurable:true,value:[new File([JSON.stringify(packaged)],'plan.json',{type:'application/json'})]});
        await document.querySelector('#planImportFile').onchange();
        const imported=await api('/api/project/plan?project_id=ui_plan');
        let release; api=url=>url.includes('project_id=ui_plan&slow')?new Promise(resolve=>{release=resolve}):originalApi(url);
        // Force the first project's response to arrive after the second project's real response.
        api=url=>url==='/api/project/plan?project_id=ui_plan'?new Promise(resolve=>{release=resolve}):originalApi(url);
        const pending=loadProjectPlan('ui_plan'); await loadProjectPlan('ui_plan_second');
        release(saved); await pending;
        const staleIgnored=document.querySelector('#planProjectName').textContent.includes('ui_plan_second');
        const result={mode:saved.plan.skills.research.mode,name:saved.effective.entries[1].name,
          savedTrace:saved.plan.evidence.claim_trace,sessionRequiresTrace,extraEnabled:saved.plan.plugins.some(p=>p.id==='extra-figures'&&p.enabled),
          pluginSaved:saved.plan.plugins[0]?.enabled && saved.effective.plugins[0]?.status==='loaded',
          pluginFrozen:state.session.skill_plan_snapshot.plugins[0]?.status==='loaded' && frozenAfter.includes('插件 证据图渲染：已启用'),
          pluginExported:packaged.plan.plugins[0]?.enabled===false && imported.plan.plugins[0]?.enabled===false,
          frozenStable:frozenBefore===frozenAfter&&frozenBefore.includes('ui-method'),
          exported:packaged.format,imported:imported.revision>saved.revision,staleIgnored};
        return result;
      } finally {
        api=originalApi; URL.createObjectURL=originalCreate; HTMLAnchorElement.prototype.click=originalClick;
        document.querySelector('#btnPlanClose').onclick(); state.session=previous; state.projectFilter=previousFilter;
      }
    })()`, true);
    assert(r.mode==='replace'&&r.name==='ui-method','表单未通过真实API保存选中方法：'+JSON.stringify(r));
    assert(r.savedTrace==='required'&&r.sessionRequiresTrace,'追溯要求未保存或未继承到新会话：'+JSON.stringify(r));
    assert(r.extraEnabled,'额外导入插件不能从表单启停：'+JSON.stringify(r));
    assert(r.pluginSaved&&r.pluginFrozen&&r.pluginExported,'插件启停、会话冻结或导入导出未接通：'+JSON.stringify(r));
    assert(r.frozenStable,'项目修改覆盖了当前会话快照：'+JSON.stringify(r));
    assert(r.exported==='xihe-project-plan'&&r.imported,'真实导入/导出未接通：'+JSON.stringify(r));
    assert(r.staleIgnored,'旧项目慢回包覆盖了新项目');
  });
  await check('缓存诊断区分历史比例、未上报与明确零命中，切换会话不串入旧响应', async () => {
    const result = await client.evaluate(`(async () => {
      const originalApi = api;
      const id = state.session.id;
      try {
        const empty = await originalApi('/api/session/cache-diagnostics?session_id=' + encodeURIComponent(id));
        if (empty.session_id !== id || empty.available !== false) throw new Error('空诊断接口状态不对');
        api = async (url, ...args) => url.startsWith('/api/session/cache-diagnostics') ? {
          available: true, requests: 3, unknown_count: 1, cache_missing: 1, known_rate: 50,
          cache_target: { threshold_percent: 90, status: 'below', met: 1, below: 1, unverified: 1,
            below_requests: [{ request_seq: 2, model: 'gpt-ui', input_tokens: 100000, cached_tokens: 89995 }] },
          historical_models: [{ model: 'gpt-ui', calls: 3, rate: 33.3 }],
          records: [
            { model: 'gpt-ui', lane: 'main', outcome: 'complete', cache_target_status: 'unverified', usage: { raw_cache: { state: 'missing' } }, comparison: { kind: 'append' } },
            { model: 'gpt-ui', lane: 'main', outcome: 'complete', cache_target_status: 'below', usage: { raw_cache: { state: 'zero', tokens: 0 } }, comparison: { kind: 'rewrite', first_changed: { index: 1 } } },
            { model: 'gpt-ui', lane: 'main', outcome: 'complete', cache_target_status: 'met', usage: { raw_cache: { state: 'reported', tokens: 128 } }, comparison: { kind: 'structure_change', changed_parts: ['tools'] } },
          ],
        } : originalApi(url, ...args);
        document.querySelector('#cacheDiagnostics').open = true;
        await refreshCacheDiagnostics();
        const text = document.querySelector('#cacheDiagnosticsBody').textContent;
        let resolveOld;
        api = url => url.startsWith('/api/session/cache-diagnostics') ? new Promise(resolve => { resolveOld = resolve; }) : originalApi(url);
        const pending = refreshCacheDiagnostics();
        const old = state.session;
        state.session = { ...old, id: 'another-cache-session' };
        document.querySelector('#cacheDiagnosticsBody').textContent = 'new session marker';
        resolveOld({ available: false, historical_models: [] });
        await pending;
        const staleIgnored = document.querySelector('#cacheDiagnosticsBody').textContent === 'new session marker';
        state.session = old;
        return { text, staleIgnored };
      } finally { api = originalApi; document.querySelector('#cacheDiagnostics').open = false; }
    })()`, true);
    assert(/33\.3%/.test(result.text) && /50\.0%/.test(result.text), '历史/已知部分命中率未分开显示');
    const hitLabel = await client.evaluate(`document.querySelector('#tHit').parentElement.textContent`);
    assert(/缓存上报占比/.test(hitLabel), '旧总览不能把未返回字段混成已确认的真实命中率');
    assert(/通道未返回缓存字段/.test(result.text) && /缓存读取0 token/.test(result.text), '未上报被混成0命中：'+result.text);
    assert(/无法计算占比1次，其中缓存字段未返回1次/.test(result.text), '缺失字段数量与无法计量数量口径混淆');
    assert(/逐请求缓存目标≥90%：达标1次，低于目标1次，无法核验1次/.test(result.text), '逐请求目标未如实显示');
    assert(/低于90% · 请求#2/.test(result.text) && /89\.995%/.test(result.text), '不能把89.995%四舍五入成达标');
    assert(/历史仅在末尾追加/.test(result.text) && /第2条消息/.test(result.text), '前缀变化解释缺失');
    assert(/请求消息发生变化（可能含临时状态）/.test(result.text), '实际出站尾部变化不能直接认定持久历史被改写');
    assert(/系统提示、工具或设置变化；变化：工具列表/.test(result.text), '工具变化被误称历史改写');
    assert(result.staleIgnored, '切换会话后旧诊断覆盖新会话');
  });
  if (process.env.XIHE_SCREENSHOT_DIR) {
    fs.mkdirSync(path.resolve(process.env.XIHE_SCREENSHOT_DIR), { recursive:true });
    const shot=await client.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(path.resolve(process.env.XIHE_SCREENSHOT_DIR),'project-acceptance.png'),Buffer.from(shot.data,'base64'));
  }

  // 可选保留可审阅截图：仅截取隔离副本中的合成用量，不含真实密钥与会话。
  if (process.env.XIHE_SCREENSHOT_DIR) {
    const screenshotDir = path.resolve(process.env.XIHE_SCREENSHOT_DIR);
    fs.mkdirSync(screenshotDir, { recursive: true });
    await client.evaluate(`(async () => {
      await openSettings(true);
      const boot=state.boot;
      renderModelReasoningRows({...boot,models:[{id:'claude-sonnet-5-5',provider:'anthropic',providerName:'Anthropic Claude',reasoning:{mode:'claude-adaptive',levels:['provider_default','low','medium','high','xhigh','max'],note:'Anthropic 格式 · 自适应思考'}},{id:'gpt-6-astra',provider:'ui-astra',providerName:'Astra 中转',reasoning:{mode:'openai-effort',levels:['provider_default','low','medium','high','xhigh','max'],note:'按型号发送推理档位；中转实际执行需由中转确认'}}]});
      document.querySelector('#reasoningSettings').scrollIntoView({block:'start'});
    })()`,true);
    await sleep(400);
    const controlsShot=await client.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(screenshotDir,'reasoning-controls.png'),Buffer.from(controlsShot.data,'base64'));
    await client.evaluate('document.querySelector("#dlgSettings").close()');
    await client.evaluate('openUsageStats()', true);
    for (const theme of ['dark', 'light']) {
      await client.evaluate(`document.querySelector('#setTheme').value='${theme}'; document.querySelector('#setTheme').dispatchEvent(new Event('change'))`);
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(screenshotDir, 'usage-' + theme + '.png'), Buffer.from(shot.data, 'base64'));
    }
    await client.evaluate(`document.querySelector('#dlgUsage').close(); document.querySelector('#setTheme').value='dark'; document.querySelector('#setTheme').dispatchEvent(new Event('change')); window.xiheAppearance.playIntro()`);
    await sleep(1800);
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(screenshotDir, 'jinwu-intro.png'), Buffer.from(shot.data, 'base64'));
  }

  // ---------- 收尾 ----------
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== RENDER ${passed}/${results.length} passed ===`);
  if (failed) {
    console.log('\n失败项：');
    for (const r of results.filter(x => !x.ok)) console.log('  - ' + r.name + ' :: ' + r.detail);
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('harness 崩溃: ' + (e && e.stack || e));
  process.exit(1);
});
