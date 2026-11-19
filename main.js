// 羲和 Agent — Electron 壳：起核心服务器 + 开桌面窗口
'use strict';
const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const { codeStamp } = require('./core/version');
// 握手逻辑放 core/probe.js：本文件顶层就 require('electron')，在纯 node 下加载不了，
// 而「点开图标拿到的是不是最新版」全靠这几个函数——留在这儿就永远只能靠手工点图标验证。
const { probePort, waitPortFree, waitForServer, needsRestart, PORT_FROM, PORT_TO } = require('./core/probe');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

// 便携版：数据与工作区放在 exe 同级目录；源码开发模式保持旧布局（程序目录上一级的 workspace）。
// 必须在 require('./core/paths') 之前设置，子模块是在模块加载期读取该环境变量的。
if (app.isPackaged && !process.env.XIHE_HOME) process.env.XIHE_HOME = path.dirname(process.execPath);
// 便携布局 app/ 与 runtime/ 同级：直接双击 electron.exe（不经启动脚本）时也能把数据落在便携根目录。
if (!process.env.XIHE_HOME && fs.existsSync(path.join(__dirname, '..', 'runtime', 'electron.exe'))) {
  process.env.XIHE_HOME = path.dirname(__dirname);
}
const APP_PATHS = require('./core/paths');

let win = null;
let serverProc = null;
let port = null;
let logFd = null;

// 起不来的原因得留证：stdio 原先是 ignore，失败时除了「没起来」什么都不知道。
// 追加写 data/server.log，不轮转——它是诊断用的，不是运行日志，出问题才有人看。
function serverLogFd() {
  if (logFd != null) return logFd;
  try {
    fs.mkdirSync(APP_PATHS.DATA_DIR, { recursive: true });
    logFd = fs.openSync(path.join(APP_PATHS.DATA_DIR, 'server.log'), 'a');
  } catch { logFd = 'ignore'; }
  return logFd;
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择题目文件夹', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// 端口段上找本版服务；旧版且没在跑任务就结束它腾位置；都没有则现拉一个。
// 指纹每次调用现算——这是单实例锁的前提：点第二次图标落回老壳时，老壳必须能发现
// 磁盘代码已经前进，而不是拿自己启动时算的旧指纹判定「无需重启」，把老版本又端给你。
async function bootServer() {
  const stamp = codeStamp(__dirname);
  for (let p = PORT_FROM; p <= PORT_TO; p++) { // 先单轮快探（复用场景毫秒级返回）
    const info = await probePort(p, null);
    if (!info) continue;
    // 版本一致，或旧版服务正在跑任务（比赛中途绝不打断）→ 直接复用
    if (info.code_stamp === stamp || info.running > 0) return { port: p, restarted: false };
    // 端口上是旧版服务（代码已更新）：结束它再拉起新版，保证桌面端永远是最新功能
    try { process.kill(info.pid); } catch {}
    // 真等它让出端口，而不是猜一个固定时长。猜早了，下面 spawn 的新服务会在启动时
    // 走 core/server.js 的 findRunning() 撞见还没退干净的旧实例，直接「已在运行」退 0，
    // 而外壳随后 waitForServer 认领的就是那个旧实例——用户看到的仍不是最新版。
    if (!(await waitPortFree(p))) continue;
    // 本端口已空，交给下面的 spawn（新服务会自己挑最低空闲端口）。
    break;
  }
  if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
  // 用 Electron 自带的 Node 运行核心服务：接收方无需另装 Node。
  serverProc = spawn(process.execPath, [path.join(__dirname, 'core', 'server.js')], {
    cwd: __dirname, windowsHide: true, stdio: ['ignore', 'ignore', serverLogFd()], detached: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  // 只认本版指纹。若端口段上另有旧版服务在跑（比如它在我们 spawn 之后才起来），
  // 不带 wantStamp 会把旧实例认成自己的——窗口指向旧代码，用户以为更新没生效。
  const p = await waitForServer(null, 60000, stamp);
  return p ? { port: p, restarted: true } : null;
}

// 启动失败必须看得见：旧写法是 whenReady 里 app.quit()，那时还没建窗口，
// 双击图标的现象就是「什么都没发生」——比旧版静默还难查，因为旧版至少开了个旧界面。
function bootFailed() {
  dialog.showErrorBox('羲和 Agent 启动失败',
    '本地核心服务在 ' + PORT_FROM + '-' + PORT_TO + ' 端口段上没起来。\n\n'
    + '先试：关掉所有「羲和 Agent」窗口，再重开一次。\n'
    + '仍不行的话，在终端里手工跑一次就能看到具体报错：\n\n'
    + '  cd "' + __dirname + '"\n'
    + '  node core/server.js\n\n'
    + '服务端最后输出留在 data\\server.log。');
  app.quit();
}

// 单实例锁：第二个壳直接退，把已有窗口提到前台。
// 不这么做就是两个壳两个窗口指向同一个服务——关掉其中一个会连带杀掉服务，另一个变白屏。
const SMOKE_TEST = process.argv.includes('--smoke-test');
if (!SMOKE_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    if (port == null || !win) return; // 还在起：whenReady 那条路自己会走到最新版
    const live = await probePort(port, null);
    // 代码已经前进、端口上还是旧服务、且它没在跑任务 → 就地换到最新版并重载界面。
    // 老壳不重算这一步，你双击图标只是被提到前台，看到的还是它启动那天的代码。
    // 判定本身抽在 probe.needsRestart 里，离线可测（这是"更新没生效"那条路）。
    if (!needsRestart(live, codeStamp(__dirname))) return;
    const next = await bootServer();
    if (!next) { bootFailed(); return; }
    port = next.port;
    win.loadURL('http://127.0.0.1:' + port).catch(() => {});
  });

  app.whenReady().then(async () => {
    const boot = await bootServer();
    if (!boot) { bootFailed(); return; }
    port = boot.port;

    // 打包后无界面冒烟：验证 exe 能用自带 Node 拉起核心服务并返回健康信息。
    if (process.argv.includes('--smoke-test')) {
      try {
        const health = await new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 5000 }, res => {
            let body = ''; res.on('data', c => body += c); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
          });
          req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('health timeout')); });
        });
        console.log(JSON.stringify({ ok: health.app === 'xihe-agent', port, pid: health.pid, code_stamp: health.code_stamp }));
        if (serverProc) serverProc.kill();
        app.exit(health.app === 'xihe-agent' ? 0 : 1);
      } catch (e) {
        console.error('SMOKE_FAIL ' + String(e.message || e));
        if (serverProc) serverProc.kill();
        app.exit(1);
      }
      return;
    }

    win = new BrowserWindow({
      width: 1500, height: 940, minWidth: 1100, minHeight: 700,
      title: '羲和 Agent', backgroundColor: '#0d1017', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    // Explicitly show even when the launcher inherited a hidden window state.
    // Navigate from the main process so a rejected renderer Promise cannot
    // leave the desktop on an intermediate splash page.
    win.show();
    win.focus();
    win.loadURL('http://127.0.0.1:' + port).catch(e => {
      dialog.showErrorBox('羲和 Agent 界面加载失败', String(e.message || e));
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      // 外链协议白名单：只允许 http/https 走系统浏览器
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
      } catch {}
      return { action: 'deny' };
    });
  });
}

app.on('window-all-closed', () => { if (serverProc) serverProc.kill(); app.quit(); });
