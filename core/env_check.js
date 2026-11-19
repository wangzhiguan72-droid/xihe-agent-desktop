// 环境体检（应用层复审 §10：环境诊断失败后直接给修复路线，减少模型反复试错）
// v2.4：改为异步 + 服务启动时跑一次缓存复用。旧版在「新建会话」里同步跑 7 次 python + 一次
// matlab -batch（冷启动 10-30 s），整个服务卡住，点完「数学建模」要等好几秒才出会话。
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (exe, args, timeout) => new Promise((resolve) => {
  execFile(exe, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
});

async function checkPython() {
  const pkgs = ['numpy', 'scipy', 'pandas', 'matplotlib', 'openpyxl', 'pymupdf'];
  // 一次进程查完全部包（旧版每个包起一次 python）
  const code = `import sys,importlib\nprint(sys.version.split()[0])\nfor p in ${JSON.stringify(pkgs)}:\n  try:\n    importlib.import_module(p); print(p+'=ok')\n  except Exception: print(p+'=no')`;
  // 60s 上限：冷磁盘缓存 + 杀软扫描时一次进程导入 6 个科学计算包实测可达 17.5s+（2026-10-17 实测，
  // 几乎全是磁盘等待）；守卫模式下更慢。体检是异步预热+缓存复用，放宽不阻塞任何 UX。
  const out = await run('python', ['-c', code], 60000);
  if (!out) return { ok: false, error: '未找到 python 或运行失败' };
  const lines = out.split(/\r?\n/);
  const packages = {};
  for (const l of lines.slice(1)) { const [k, v] = l.split('='); if (k) packages[k] = v === 'ok' ? '✓' : '✗'; }
  return { ok: true, version: lines[0], implementation: 'CPython', packages };
}

async function checkMatlab() {
  const candidates = [
    process.env.MATLAB_EXE,
    'C:\\Program Files\\MATLAB\\R2024b\\bin\\matlab.exe',
    'C:\\Program Files\\MATLAB\\R2023b\\bin\\matlab.exe',
    'C:\\Program Files\\MATLAB\\R2022b\\bin\\matlab.exe',
    'C:\\Program Files\\MATLAB\\R2021b\\bin\\matlab.exe',
  ].filter(Boolean);
  // 只确认可执行文件存在，不再启动 MATLAB（-batch 冷启动要 10-30 s）；版本号取自路径
  const exe = candidates.find(p => fs.existsSync(p));
  if (!exe) return { ok: false, error: '未找到 MATLAB 可执行文件' };
  const m = exe.match(/R\d{4}[ab]/);
  return { ok: true, version: m ? m[0] : '?', path: exe };
}

function checkWorkspace(root) {
  const out = { root, exists: fs.existsSync(root), dirs: [] };
  if (out.exists) {
    try {
      const ents = fs.readdirSync(root, { withFileTypes: true });
      out.dirs = ents.filter(e => e.isDirectory()).slice(0, 20).map(e => e.name);
      out.file_count = ents.filter(e => !e.isDirectory()).length;
    } catch (e) { out.readdir_err = String(e.message || e).slice(0, 200); }
  }
  return out;
}

// 机器级结果（python/matlab）全局缓存：启动时预热，之后新建会话零等待
let cached = null, pending = null;
function warmup() {
  if (!pending) pending = Promise.all([checkPython(), checkMatlab()]).then(([python, matlab]) => (cached = { at: Date.now(), python, matlab }));
  return pending;
}
// 同步取：缓存就绪则返回完整报告，否则只含工作区信息（python/matlab 标记为检测中）
function envCheck(workspace) {
  warmup();
  const base = cached || { at: Date.now(), python: { ok: null, note: '检测中' }, matlab: { ok: null, note: '检测中' } };
  return { ...base, workspace: checkWorkspace(workspace) };
}

module.exports = { envCheck, warmup, checkPython, checkMatlab, checkWorkspace };
