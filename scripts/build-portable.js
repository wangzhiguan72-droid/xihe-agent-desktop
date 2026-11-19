'use strict';
// 生成便携目录与 zip：app/（源码与随包资料）+ runtime/（Electron）+ data/kb + workspace。
// 用法：node scripts/build-portable.js [--electron-dist <dir>] [--out <dir>] [--no-zip]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const OUT = path.resolve(opt('--out') || path.join(ROOT, 'dist'));
const STAGE = path.join(OUT, 'xihe-agent-portable');
const APP = path.join(STAGE, 'app');
const ELECTRON_DIST = path.resolve(opt('--electron-dist')
  || process.env.ELECTRON_DIST
  || path.join(ROOT, 'node_modules', 'electron', 'dist'));
const ZIP = path.join(OUT, 'xihe-agent-portable.zip');

const APP_ENTRIES = [
  'main.js', 'preload.js', 'cli.js', 'package.json',
  'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md',
  'core', 'ui', 'skills', 'knowledge', 'contest_packages',
  'templates', 'template_library', 'plugins', 'vendor', 'docs', 'scripts',
];

function run(cmd, argv, okCodes = [0]) {
  const r = spawnSync(cmd, argv, { stdio: 'pipe', windowsHide: true, encoding: 'utf8' });
  if (!okCodes.includes(r.status)) {
    throw new Error(`${cmd} 失败（exit ${r.status}）\n${(r.stderr || r.stdout || '').slice(0, 1200)}`);
  }
  return r;
}

function copyDir(src, dst) {
  if (process.platform === 'win32') {
    // robocopy 能处理 Windows 长路径；退出码 <8 表示成功。
    run('robocopy', [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'], [0, 1, 2, 3, 4, 5, 6, 7]);
  } else {
    fs.cpSync(src, dst, { recursive: true, dereference: true });
  }
}

function copyEntry(rel) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`缺少发布文件：${rel}`);
  const dst = path.join(APP, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.statSync(src).isDirectory()) copyDir(src, dst);
  else fs.copyFileSync(src, dst);
}

function writeLauncher() {
  const text = [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'set "XIHE_HOME=%~dp0"',
    'if not exist "data" mkdir "data"',
    'if not exist "workspace" mkdir "workspace"',
    'if not exist "runtime\\electron.exe" (',
    '  echo 缺少 runtime\\electron.exe。请重新解压完整的便携包。',
    '  pause',
    '  exit /b 1',
    ')',
    'start "" "%~dp0runtime\\electron.exe" "%~dp0app"',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(STAGE, '启动羲和.cmd'), text, 'utf8');
}

function zipStage() {
  if (fs.existsSync(ZIP)) fs.rmSync(ZIP);
  if (process.platform === 'win32') {
    // Windows 自带的 bsdtar 支持 zip，且比 Compress-Archive 更耐受深路径。
    // 必须用系统 tar；Git Bash 的 tar 会把 "D:" 当远端主机。
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const r = spawnSync(fs.existsSync(tar) ? tar : 'tar', ['-a', '-c', '-f', ZIP, '-C', OUT, 'xihe-agent-portable'], { windowsHide: true });
    if (r.status === 0 && fs.existsSync(ZIP)) return;
    run('powershell.exe', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${STAGE}' -DestinationPath '${ZIP}' -Force`]);
    if (!fs.existsSync(ZIP)) throw new Error('zip 生成失败：' + ZIP);
  } else {
    run('zip', ['-qr', ZIP, 'xihe-agent-portable'], [0]);
  }
}

if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
  throw new Error('未找到 Electron 运行时。先运行 npm install，或用 --electron-dist 指向 electron/dist 目录。');
}

fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
for (const entry of APP_ENTRIES) copyEntry(entry);

fs.mkdirSync(path.join(STAGE, 'config'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'config', 'settings.example.json'), path.join(STAGE, 'config', 'settings.example.json'));
copyDir(path.join(ROOT, 'data', 'kb'), path.join(STAGE, 'data', 'kb'));
fs.mkdirSync(path.join(STAGE, 'workspace'), { recursive: true });
copyDir(ELECTRON_DIST, path.join(STAGE, 'runtime'));
writeLauncher();
// 便携包只带知识库，不带开发机运行痕迹。
for (const name of ['jobs', 'sessions', 'trash', 'port.txt', 'runtime.lock', 'server.log', 'job_notifications.json']) {
  fs.rmSync(path.join(STAGE, 'data', name), { recursive: true, force: true });
}
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(STAGE, 'README.md'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(STAGE, 'LICENSE'));
fs.copyFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(STAGE, 'THIRD_PARTY_NOTICES.md'));

if (!args.includes('--no-zip')) zipStage();
const size = fs.existsSync(ZIP) ? (fs.statSync(ZIP).size / 1024 / 1024).toFixed(0) + ' MB' : '(未压缩)';
console.log(JSON.stringify({ ok: true, stage: STAGE, zip: args.includes('--no-zip') ? null : ZIP, zip_size: size }));