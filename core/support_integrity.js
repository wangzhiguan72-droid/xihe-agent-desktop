'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_ZIP_BYTES = require('./contest_packages').getPackage('cumcm')?.rules.defaults.support_policy.max_bytes ?? null;
const DEFAULT_SIZE_POLICY = Object.freeze({ max_bytes: null, exclusive: false, source: '' });

function normalizePolicy(policy) {
  if (policy == null) return { ...DEFAULT_SIZE_POLICY };
  if (typeof policy !== 'object' || Array.isArray(policy)) throw new Error('支撑包体积策略必须是对象');
  if (policy.max_bytes === null) return { ...DEFAULT_SIZE_POLICY };
  if (!Number.isSafeInteger(policy.max_bytes) || policy.max_bytes <= 0 || typeof policy.source !== 'string' || !policy.source.trim()) {
    throw new Error('有上限的支撑包策略必须给出正整数字节数和可追溯来源');
  }
  if (policy.exclusive != null && typeof policy.exclusive !== 'boolean') throw new Error('exclusive 必须是布尔值');
  return { max_bytes: policy.max_bytes, exclusive: policy.exclusive !== false, source: policy.source.trim() };
}

function checkSize(bytes, policy) {
  const limit = normalizePolicy(policy);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('支撑包大小无效');
  if (limit.max_bytes == null || (limit.exclusive ? bytes < limit.max_bytes : bytes <= limit.max_bytes)) return null;
  return `支撑包 ${bytes} 字节，须${limit.exclusive ? '严格小于' : '不超过'} ${limit.max_bytes} 字节（${limit.source}）`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relativeEntry(root, file) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || rel.includes('\0')) {
    throw new Error(`支撑文件越界：${file}`);
  }
  return rel;
}

function inspectZip(zipPath) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$zip=[System.IO.Compression.ZipFile]::OpenRead($env:XIHE_ZIP_INSPECT); ` +
    `try { $rows=@(); foreach($entry in $zip.Entries) { if($entry.FullName.EndsWith('/')) { continue }; ` +
    `$stream=$entry.Open(); try { $sha=[System.Security.Cryptography.SHA256]::Create(); ` +
    `try { $hash=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() } ` +
    `} finally { $stream.Dispose() }; $rows+=@{name=$entry.FullName; bytes=$entry.Length; sha256=$hash} }; ` +
    `$json=ConvertTo-Json -InputObject @($rows) -Compress -Depth 4; ` +
    `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) ` +
    `} finally { $zip.Dispose() }`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, env: { ...process.env, XIHE_ZIP_INSPECT: zipPath },
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString('ascii'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`无法读取 zip：${err.slice(0, 600)}`));
      try { resolve(JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'))); }
      catch (e) { reject(new Error(`zip 清单读取失败：${e.message}`)); }
    });
  });
}

async function verifyZip(zipPath, expected, policy) {
  const bytes = fs.statSync(zipPath).size;
  const sizeIssue = checkSize(bytes, policy);
  if (sizeIssue) throw new Error(sizeIssue);
  const actual = await inspectZip(zipPath);
  const want = new Map(expected.map(r => [r.rel, r]));
  if (want.size !== expected.length) throw new Error('待打包文件名重复');
  const seen = new Set();
  for (const row of actual) {
    const name = row.name.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').includes('..') || seen.has(name)) throw new Error(`zip 非法或重复条目：${name}`);
    seen.add(name);
    const ref = want.get(name);
    if (!ref || ref.sha256 !== row.sha256 || ref.bytes !== row.bytes) throw new Error(`zip 条目与源文件不符：${name}`);
  }
  if (seen.size !== want.size) throw new Error(`zip 缺失文件：${[...want.keys()].filter(n => !seen.has(n)).join('、')}`);
  return { bytes, entries: actual.map(r => r.name.replace(/\\/g, '/')) };
}

function texEscape(s) {
  return String(s).replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
}

function describeEntry(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.py', '.m', '.r', '.jl'].includes(ext)) return ['源程序', '数值计算或绘图的可运行代码'];
  if (['.xlsx', '.csv'].includes(ext)) return ['数据表', name.startsWith('data/') ? '自主获取的输入数据' : '模型计算结果或中间数据'];
  if (name === 'AI 工具使用详情.pdf') return ['AI 使用详情', '工具使用与人工核验记录'];
  if (['.png', '.pdf'].includes(ext)) return ['图件', '计算结果或验证图'];
  if (ext === '.json') return ['结构化记录', '模型结果或核验记录'];
  if (['.md', '.txt'].includes(ext)) return ['文字资料', name.startsWith('data/') ? '自主获取的输入资料' : '运行说明或分析记录'];
  if (ext === '.tex') return ['源文件', 'AI 使用详情的可编译源文件'];
  return ['支撑文件', '模型计算或结果核验所用文件'];
}

function manifestTex(entries) {
  return '% 支撑材料文件列表；由 support_pack 核验 zip 后生成。\n' +
    '\\section*{支撑材料文件列表}\n\\begin{itemize}\n' +
    entries.map(name => {
      const [kind, role] = describeEntry(name);
      return `\\item \\texttt{${texEscape(name)}}（${texEscape(kind)}：${texEscape(role)}）\n% XIHE-SUPPORT-ENTRY:${Buffer.from(name, 'utf8').toString('base64')}\n`;
    }).join('') +
    '\\end{itemize}\n';
}

function manifestEntries(tex) {
  return [...tex.matchAll(/^% XIHE-SUPPORT-ENTRY:([A-Za-z0-9+/=]+)$/gm)]
    .map(m => Buffer.from(m[1], 'base64').toString('utf8'));
}

function checkManifest(tex, entries) {
  const listed = manifestEntries(tex);
  return listed.length === entries.length && listed.every((v, i) => v === entries[i]);
}

function freshSupportBlockers(root, state, policy, requirements = {}) {
  const problems = [];
  if (!state || state.verified !== true || state.must_fix) return ['支撑包尚未通过 zip 内容与附录清单核验'];
  try {
    const currentPolicy = normalizePolicy(policy);
    const recordedPolicy = state.size_policy == null ? { ...DEFAULT_SIZE_POLICY } : normalizePolicy(state.size_policy);
    if (JSON.stringify(recordedPolicy) !== JSON.stringify(currentPolicy)) problems.push('支撑包体积策略已改变，须重新打包与核验');
    const zip = path.join(root, state.zip);
    if (!fs.existsSync(zip) || checkSize(fs.statSync(zip).size, currentPolicy) || sha256(zip) !== state.zip_sha256) problems.push('支撑包丢失、超限或内容已修改，须重新打包');
    const tex = fs.readFileSync(path.join(root, 'findings', 'support_manifest.tex'), 'utf8');
    const entries = state.entries.map(r => r.rel);
    if (!checkManifest(tex, entries) || sha256(path.join(root, 'findings', 'support_manifest.tex')) !== state.manifest_sha256) {
      problems.push('附录支撑文件清单与已核验 zip 不一致，须重新打包');
    }
    if (requirements.manifest_in_paper === true) {
      const paper = fs.readFileSync(path.join(root, 'paper', 'main.tex'), 'utf8');
      const uncommented = paper.split(/\r?\n/).map(line => line.replace(/(?<!\\)%.*$/, '')).join('\n');
      const appendix = uncommented.indexOf('\\appendix');
      if (appendix < 0 || !/\\input\s*\{\s*\.\.\/findings\/support_manifest\.tex\s*\}/.test(uncommented.slice(appendix))) {
        problems.push('论文附录尚未实际引入支撑文件清单：\\input{../findings/support_manifest.tex}');
      }
    }
    for (const row of state.entries) {
      const file = path.join(root, row.rel);
      if (!fs.existsSync(file) || fs.statSync(file).size !== row.bytes || sha256(file) !== row.sha256) {
        problems.push(`源文件已变化：${row.rel}，须重新打包`);
      }
    }
  } catch (e) { problems.push(`支撑包复核失败：${e.message}`); }
  return problems;
}

module.exports = { MAX_ZIP_BYTES, normalizePolicy, checkSize, sha256, relativeEntry, inspectZip, verifyZip, manifestTex, manifestEntries, checkManifest, freshSupportBlockers, describeEntry };
