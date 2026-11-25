'use strict';
// 还原 vendor/open-webSearch（约 117 MB 的网页搜索运行时，不随 git 分发）。
// 用法：
//   node scripts/fetch-open-websearch.js --from <zip|目录> [--dest <目录>] [--force]
//   node scripts/fetch-open-websearch.js --url <https地址> [--sha256 <hex>] [--dest <目录>] [--force]
// 不带参数时只检查现有安装。便携包构建读取本目录，最终用户无需运行本脚本。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.resolve(opt('--dest') || path.join(ROOT, 'vendor', 'open-webSearch'));

function opt(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const flag = name => process.argv.includes(name);
const fail = msg => { console.error(msg); process.exit(1); };

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function componentRoot(dir) {
  const hit = d => {
    try { return fs.statSync(path.join(d, 'build', 'index.js')).isFile(); } catch { return false; }
  };
  if (hit(dir)) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
  if (entries.length === 1) {
    const sub = path.join(dir, entries[0].name);
    if (hit(sub)) return sub;
  }
  return null;
}

function validate(dir) {
  const root = componentRoot(dir);
  if (!root) fail(`不是有效的 open-webSearch 目录（缺 build/index.js）：${dir}`);
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    fail(`该目录缺 node_modules，daemon 起不来。请从已安装的机器打包整个目录，或在有 npm 的机器上 npm ci --omit=dev 后再打包：${root}`);
  }
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || version; } catch {}
  return { root, version };
}

function extractZip(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const r = spawnSync(tar, ['-xf', zip, '-C', into], { windowsHide: true, encoding: 'utf8' });
  if (r.status === 0) return;
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`],
      { windowsHide: true, encoding: 'utf8' });
    if (ps.status === 0) return;
    fail(`解压失败：${(ps.stderr || ps.stdout || r.stderr || '').slice(0, 400)}`);
  }
  fail(`解压失败：${(r.stderr || r.stdout || '').slice(0, 400)}`);
}

async function download(url, to) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
  if (!res.ok) fail(`下载失败：HTTP ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(to);
  let seen = 0;
  for await (const chunk of res.body) {
    seen += chunk.length;
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    if (total) process.stdout.write(`\r下载中 ${(seen / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`);
  }
  await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
  if (total) process.stdout.write('\n');
}

function installFrom(src) {
  const incoming = DEST + '.incoming-' + Date.now();
  fs.rmSync(incoming, { recursive: true, force: true });
  try {
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, incoming, { recursive: true, dereference: true });
    } else {
      extractZip(src, incoming);
    }
    const { root, version } = validate(incoming);
    if (fs.existsSync(DEST)) {
      if (!flag('--force')) fail(`目标已存在：${DEST}\n确认替换请加 --force`);
      fs.rmSync(DEST, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
    if (root === incoming) {
      fs.renameSync(incoming, DEST);
    } else {
      fs.renameSync(root, DEST);
      fs.rmSync(incoming, { recursive: true, force: true });
    }
    console.log(`已安装 open-webSearch ${version} → ${DEST}`);
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

(async () => {
  if (flag('--help') || flag('-h')) {
    console.log('用法：node scripts/fetch-open-websearch.js --from <zip|目录> | --url <https地址> [--sha256 <hex>] [--dest <目录>] [--force]');
    return;
  }
  const from = opt('--from');
  const url = opt('--url');
  const wantSha = (opt('--sha256') || '').toLowerCase();

  if (!from && !url) {
    if (!fs.existsSync(DEST)) fail(`未安装：${DEST}\n用 --from <zip|目录> 或 --url <地址> 安装。`);
    const { version } = validate(DEST);
    console.log(`已安装 open-webSearch ${version} → ${DEST}`);
    return;
  }
  if (from && url) fail('--from 与 --url 只能二选一');

  if (from) {
    const src = path.resolve(from);
    if (!fs.existsSync(src)) fail(`找不到：${src}`);
    if (!fs.statSync(src).isDirectory() && !/\.zip$/i.test(src)) fail('--from 只接受目录或 .zip');
    installFrom(src);
    return;
  }

  const tmp = path.join(os.tmpdir(), `open-websearch-${Date.now()}.zip`);
  try {
    await download(url, tmp);
    const got = sha256(tmp);
    if (wantSha && got !== wantSha) fail(`SHA-256 不匹配\n期望 ${wantSha}\n实际 ${got}`);
    console.log(`SHA-256 ${got}`);
    installFrom(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
})().catch(err => fail(err && err.stack || String(err)));