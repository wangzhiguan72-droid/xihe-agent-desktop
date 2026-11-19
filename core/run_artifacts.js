// Bind declared result files to the compute call that actually produced them.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 20;
const MAX_BYTES = 20 * 1024 * 1024;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function resolve(root, file) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error('结果文件必须是工作区内的相对路径');
  }
  const base = fs.realpathSync(root);
  const absolute = path.resolve(base, file);
  if (!within(base, absolute) || absolute === base) throw new Error('结果文件越出工作区');
  // A missing output is normal before a run. Resolve its nearest existing parent
  // so junctions and symlinks cannot point a declared result outside the root.
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error('结果文件路径无法解析');
    probe = parent;
  }
  if (!within(base, fs.realpathSync(probe))) throw new Error('结果文件实际指向工作区外');
  return { absolute, path: path.relative(base, absolute).split(path.sep).join('/') };
}

function fingerprint(root, file) {
  const resolved = resolve(root, file);
  if (!fs.existsSync(resolved.absolute)) return { path: resolved.path, missing: true };
  const stat = fs.statSync(resolved.absolute);
  if (!stat.isFile()) throw new Error('结果路径不是普通文件：' + resolved.path);
  if (stat.size > MAX_BYTES) throw new Error('结果文件超过 20 MB：' + resolved.path);
  return {
    path: resolved.path,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(resolved.absolute)).digest('hex'),
    bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    ino: stat.ino,
  };
}

function requested(args) {
  if (args?.result_files == null) return [];
  if (!Array.isArray(args.result_files) || args.result_files.length > MAX_FILES) {
    throw new Error('result_files 必须是最多 20 项的路径数组');
  }
  const files = args.result_files;
  if (new Set(files).size !== files.length) throw new Error('result_files 不可重复');
  return files;
}

function begin(ctx, args) {
  const files = requested(args).map(file => fingerprint(ctx.workspace, file));
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('result_files 规范化后不可重复');
  return { files };
}

function finish(ctx, args, before, ok) {
  const result = { files: [], issues: [] };
  if (!ok) return result;
  const previous = new Map((before?.files || []).map(file => [file.path, file]));
  for (const file of requested(args)) {
    let current;
    try { current = fingerprint(ctx.workspace, file); }
    catch (error) { result.issues.push(`${file}: ${error.message}`); continue; }
    if (current.missing) { result.issues.push(`${current.path}: 运行结束后文件不存在`); continue; }
    const old = previous.get(current.path);
    if (!old) { result.issues.push(`${current.path}: 缺少运行前快照`); continue; }
    const changed = old.missing || ['sha256', 'bytes', 'mtime_ms', 'ctime_ms', 'ino'].some(key => old[key] !== current[key]);
    if (!changed) { result.issues.push(`${current.path}: 运行未生成或重写此文件`); continue; }
    result.files.push(current);
  }
  return result;
}

function validate(root, receipt) {
  const result = { ok: false, issues: [], files: [] };
  const files = Array.isArray(receipt?.files) ? receipt.files : (receipt?.path ? [receipt] : []);
  if (!files.length || files.length > MAX_FILES) result.issues.push('运行没有有效结果文件凭据');
  for (const saved of files.slice(0, MAX_FILES)) {
    if (!saved || !/^[a-f0-9]{64}$/.test(saved.sha256 || '') || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0) {
      result.issues.push('结果文件凭据缺少有效哈希或大小'); continue;
    }
    let current;
    try { current = fingerprint(root, saved.path); }
    catch (error) { result.issues.push(`${saved.path}: ${error.message}`); continue; }
    if (current.missing) { result.issues.push(`${saved.path}: 文件已缺失`); continue; }
    if (current.sha256 !== saved.sha256 || current.bytes !== saved.bytes) {
      result.issues.push(`${saved.path}: 内容已变更`); continue;
    }
    result.files.push(current);
  }
  result.ok = result.issues.length === 0;
  return result;
}

module.exports = { begin, finish, validate };
