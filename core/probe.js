// 桌面壳与核心服务之间的握手：探活 / 等端口释放 / 等服务就绪。
//
// 单独成文件是为了能离线测：main.js 顶层就 require('electron')，在纯 node 下根本加载不了，
// 而这段正是「点开桌面快捷方式拿到的到底是不是最新版」的全部逻辑——本会话里它已经出过一次
// 静默认领旧实例的问题，不能只靠手工点图标验证。
'use strict';
const http = require('http');

const PORT_FROM = 18652, PORT_TO = 18670;

// 服务身份握手：不只是"端口有响应"，还要确认 /api/health 返回本应用标识、已知 pid、以及
// （给了 wantStamp 时）本版代码指纹。三者缺一，那个端口就不算我们的。
function probePort(port, knownPid = null, wantStamp = null) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1200 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(j.app === 'xihe-agent' && (!knownPid || j.pid === knownPid)
            && (!wantStamp || j.code_stamp === wantStamp) ? j : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 等旧版服务真的把端口交出来，而不是猜一个固定时长。固定 sleep 猜早了，
// 新服务启动时 core/server.js 的 findRunning() 会撞见还没退干净的旧实例，直接"已在运行"退 0，
// 而外壳随后认领的就是那个旧实例——用户看到的仍不是最新版。
async function waitPortFree(p, maxMs = 8000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!(await probePort(p, null))) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function waitForServer(knownPid, maxMs = 60000, wantStamp = null, from = PORT_FROM, to = PORT_TO) {
  // 一轮快速探测端口段；找不到就再等 500ms 重扫，直到总时限。
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    for (let p = from; p <= to; p++) {
      const info = await probePort(p, knownPid, wantStamp);
      if (info) return p;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// 老壳（第一次点图标留下的那个进程）接到"又点了一次图标"时，该不该换成最新版。
// 这段错掉的现象是"改完代码点图标还是老界面"，跟服务没起来一样难查，所以跟握手放一起离线测。
// 注意 live.code_stamp 是服务自己启动时算的，freshStamp 必须由调用方现算——拿启动时缓存的
// 指纹来比，结果永远是"不用重启"，恰好把这条路的唯一价值抹掉。
function needsRestart(live, freshStamp) {
  if (!live) return true;                 // 服务已经没了（被关掉/崩了），得重拉一个
  if (live.code_stamp === freshStamp) return false; // 端口上就是本版
  if (live.running > 0) return false;     // 旧版正在跑任务：宁可给旧界面，也不打断比赛
  return true;
}

module.exports = { probePort, waitPortFree, waitForServer, needsRestart, PORT_FROM, PORT_TO };
