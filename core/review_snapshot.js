'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 2000;
const MAX_BYTES = 800_000_000;
const HASH = /^[a-f0-9]{64}$/i;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = value => value.replace(/\\/g, '/');
const excluded = rel => /^(?:findings\/review_snapshots|submission\/releases)(?:\/|$)/.test(rel);

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function checkedFile(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel)) throw new Error('文件路径无效或越界');
  const base = fs.realpathSync(root);
  const abs = path.resolve(base, rel);
  if (!inside(base, abs)) throw new Error('文件路径越界');
  const real = fs.realpathSync(abs);
  if (!inside(base, real)) throw new Error('文件真实路径越界');
  if (!fs.statSync(real).isFile()) throw new Error('输入须为普通文件，不能是目录');
  return { abs: real, rel: slash(path.relative(base, abs)) };
}

function fileHash(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function createSnapshot(ctx, args) {
  if (!ctx || !ctx.sandbox || !ctx.workspace) throw new Error('缺工作区上下文');
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['files', 'label', 'kind'].includes(key))) throw new Error('快照参数无效');
  if (!['review', 'release'].includes(args.kind)) throw new Error('快照 kind 无效');
  if (args.label != null && (typeof args.label !== 'string' || args.label.length > 200)) throw new Error('快照 label 无效');
  if (!Array.isArray(args.files) || !args.files.length || args.files.length > MAX_FILES) throw new Error('快照须包含1至2000个文件');
  const root = fs.realpathSync(ctx.workspace);
  const source = [];
  const seen = new Set();
  let total = 0;
  for (const rel of args.files) {
    ctx.sandbox.resolve(rel, 'r');
    const file = checkedFile(root, rel);
    const real = slash(path.relative(root, file.abs));
    if (excluded(file.rel) || excluded(real)) throw new Error('禁止递归复制快照或发行目录');
    if (seen.has(real)) throw new Error('快照输入路径重复');
    seen.add(real);
    const bytes = fs.statSync(file.abs).size;
    total += bytes;
    if (total > MAX_BYTES) throw new Error('快照总大小超过800MB');
    source.push({ ...file, bytes });
  }
  const id = crypto.randomBytes(12).toString('hex');
  const prefix = args.kind === 'review' ? 'findings/review_snapshots' : 'submission/releases';
  const dirRel = prefix + '/' + id;
  const root_rel = dirRel + '/files';
  const manifestRel = dirRel + '/manifest.json';
  ctx.sandbox.resolve(dirRel, 'w');
  fs.mkdirSync(ctx.sandbox.resolve(prefix, 'w'), { recursive: true });
  fs.mkdirSync(ctx.sandbox.resolve(dirRel, 'w'));
  fs.mkdirSync(ctx.sandbox.resolve(root_rel, 'w'));
  const files = [];
  for (const row of source) {
    const copy_rel = root_rel + '/' + row.rel;
    if (path.resolve(root, copy_rel) === row.abs) throw new Error('输入不得等于快照目标');
    const target = ctx.sandbox.resolve(copy_rel, 'w');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const before = fileHash(row.abs);
    fs.copyFileSync(row.abs, target, fs.constants.COPYFILE_EXCL);
    const after = fileHash(row.abs), copyHash = fileHash(target);
    if (before !== after || before !== copyHash || fs.statSync(row.abs).size !== row.bytes || fs.statSync(target).size !== row.bytes)
      throw new Error('快照源文件在复制期间变化或副本不一致：' + row.rel);
    files.push({ rel: row.rel, sha256: before, bytes: row.bytes, copy_rel });
  }
  const at = Date.now();
  const manifestData = { id, kind: args.kind, at, ...(args.label ? { label: args.label } : {}), root_rel, files };
  const bytes = Buffer.from(JSON.stringify(manifestData, null, 2), 'utf8');
  const manifestPath = ctx.sandbox.resolve(manifestRel, 'w');
  const temp = manifestPath + '.tmp-' + crypto.randomBytes(6).toString('hex');
  ctx.sandbox.resolve(slash(path.relative(root, temp)), 'w');
  fs.writeFileSync(temp, bytes, { flag: 'wx' });
  fs.renameSync(temp, manifestPath);
  return { ...manifestData, manifest: { rel: manifestRel, sha256: sha256(bytes) } };
}

function snapshotBlockers(root, snapshot, { check_sources = true } = {}) {
  const issues = [];
  if (!snapshot || !['review', 'release'].includes(snapshot.kind) || !/^[a-f0-9]{24}$/.test(snapshot.id || '') || !Array.isArray(snapshot.files)) return ['快照登记无效'];
  const prefix = snapshot.kind === 'review' ? 'findings/review_snapshots' : 'submission/releases';
  const expectedRoot = prefix + '/' + snapshot.id + '/files';
  const expectedManifest = prefix + '/' + snapshot.id + '/manifest.json';
  if (snapshot.root_rel !== expectedRoot || snapshot.manifest?.rel !== expectedManifest || !HASH.test(snapshot.manifest.sha256 || '')) return ['快照清单位置或哈希无效'];
  try {
    const file = checkedFile(root, expectedManifest);
    if (file.abs !== path.resolve(root, expectedManifest)) issues.push('快照清单路径已重定向');
    const bytes = fs.readFileSync(file.abs);
    if (sha256(bytes) !== snapshot.manifest.sha256.toLowerCase()) issues.push('快照清单哈希已变化');
    else {
      const actual = JSON.parse(bytes.toString('utf8'));
      const expected = { id: snapshot.id, kind: snapshot.kind, at: snapshot.at, ...(snapshot.label ? { label: snapshot.label } : {}), root_rel: expectedRoot, files: snapshot.files };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push('快照清单与登记记录不一致');
    }
  } catch (error) { issues.push('快照清单不可读或无效：' + error.message); }
  if (!snapshot.files.length || snapshot.files.length > MAX_FILES || snapshot.files.reduce((sum, row) => sum + (row?.bytes || 0), 0) > MAX_BYTES) issues.push('快照文件数或大小无效');
  const seen = new Set();
  for (const row of snapshot.files) {
    const canonical = row && typeof row.rel === 'string' && row.rel && !path.isAbsolute(row.rel) && !row.rel.includes('\\') && !row.rel.split('/').some(part => !part || part === '.' || part === '..');
    if (!canonical || !HASH.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || excluded(row.rel) || row.copy_rel !== expectedRoot + '/' + row.rel || seen.has(row.rel)) {
      issues.push('快照文件登记无效'); continue;
    }
    seen.add(row.rel);
    for (const [label, rel] of [['副本', row.copy_rel], ...(check_sources ? [['源文件', row.rel]] : [])]) {
      try {
        const file = checkedFile(root, rel);
        if (label === '副本' && file.abs !== path.resolve(root, rel)) issues.push('副本路径已重定向：' + rel);
        if (fs.statSync(file.abs).size !== row.bytes || fileHash(file.abs) !== row.sha256.toLowerCase()) issues.push(label + '已变化：' + rel);
      } catch (error) { issues.push(label + '不可读或越界：' + rel + ' ' + error.message); }
    }
  }
  return issues;
}

function paperInputs(root, entry = 'paper/main.tex') {
  const base = fs.realpathSync(root);
  const paper = path.join(base, 'paper');
  if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || !inside(base, path.resolve(base, entry))) throw new Error('论文入口路径越界或无效');
  const entryRel = slash(path.relative(base, path.resolve(base, entry)));
  const selected = new Set();
  if (fs.existsSync(path.join(base, entryRel))) { checkedFile(base, entryRel); selected.add(entryRel); }
  const flsRel = slash(path.join(path.dirname(entryRel), path.parse(entryRel).name + '.fls'));
  const recorder = fs.existsSync(path.join(base, flsRel)) ? [checkedFile(base, flsRel).abs] : [];
  const seenDirs = new Set();
  const walk = dir => {
    const real = fs.realpathSync(dir);
    if (!inside(base, real)) throw new Error('论文目录符号链接越界');
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = slash(path.relative(base, abs));
      if (excluded(rel)) continue;
      if (entry.isDirectory() || entry.isSymbolicLink() && fs.statSync(abs).isDirectory()) walk(abs);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        checkedFile(base, rel);
        const code = /\.(?:tex|bib|cls|sty)$/i.test(rel);
        const figure = /^paper\/figures\//i.test(rel) && /\.(?:png|jpe?g|gif|bmp|webp|tiff?|svg|eps|pdf)$/i.test(rel);
        if (code || figure) selected.add(rel);
      }
    }
  };
  if (fs.existsSync(paper)) walk(paper);
  for (const fls of recorder) {
    if (fs.statSync(fls).size > 10_000_000) throw new Error('论文 .fls 记录超过10MB');
    for (const line of fs.readFileSync(fls, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith('INPUT ')) continue;
      const stated = line.slice(6).trim();
      if (!stated) continue;
      const abs = path.isAbsolute(stated) ? stated : path.resolve(path.dirname(fls), stated);
      if (!inside(base, abs) || !fs.existsSync(abs)) continue;
      const rel = slash(path.relative(base, abs));
      if (excluded(rel) || /(?:^|\/)(?:main\.pdf|[^/]+\.(?:aux|log|fls|fdb_latexmk|xdv|synctex(?:\.gz)?))$/i.test(rel)) continue;
      if (fs.statSync(abs).isFile()) selected.add(rel);
    }
  }
  return [...selected].sort().map(rel => { const file = checkedFile(base, rel); return { rel, sha256: fileHash(file.abs) }; });
}

module.exports = { createSnapshot, snapshotBlockers, paperInputs };
