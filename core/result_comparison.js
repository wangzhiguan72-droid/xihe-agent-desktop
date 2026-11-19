'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compareMetric } = require('./independent_verification');

const HASH = /^[a-f0-9]{64}$/i;
const CONTEXT = ['unit', 'definition', 'denominator', 'time_origin', 'dataset', 'protocol'];
const SIDE_FIELDS = ['result_key', ...CONTEXT];
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function objectFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '须为对象');
  const extra = Object.keys(value).filter(key => !fields.includes(key));
  if (extra.length) throw new Error(label + '含不允许的字段：' + extra.join('、'));
}

function checkedPath(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\0')) throw new Error('结果路径无效或越界');
  const base = fs.realpathSync(root);
  const abs = path.resolve(base, rel);
  const relative = path.relative(base, abs);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('结果路径越界');
  const real = fs.realpathSync(abs);
  const realRelative = path.relative(base, real);
  if (!realRelative || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new Error('结果真实路径越界');
  if (!fs.statSync(real).isFile()) throw new Error('结果路径不是文件：' + rel);
  return real;
}

function readResult(ctx, row, label) {
  objectFields(row, ['rel', 'sha256'], label);
  if (typeof row.rel !== 'string') throw new Error(label + '缺相对路径');
  if (row.sha256 != null && (!HASH.test(row.sha256))) throw new Error(label + '哈希无效');
  ctx.sandbox.resolve(row.rel, 'r');
  const real = checkedPath(ctx.workspace, row.rel);
  if (fs.statSync(real).size > 2_000_000) throw new Error(label + '超过2MB');
  const bytes = fs.readFileSync(real);
  if (bytes.length > 2_000_000) throw new Error(label + '超过2MB');
  const hash = sha256(bytes);
  if (row.sha256 && row.sha256.toLowerCase() !== hash) throw new Error(label + '哈希与文件不符');
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new Error(label + '不是有效JSON：' + error.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(label + '的JSON根须为对象');
  return { data, file: { rel: path.relative(ctx.workspace, real).replace(/\\/g, '/'), sha256: hash } };
}

function valueAt(data, key) {
  if (typeof key !== 'string' || !key || key.split('.').some(part => !part || ['__proto__', 'constructor', 'prototype'].includes(part))) return undefined;
  return key.split('.').reduce((value, part) => value && own(value, part) ? value[part] : undefined, data);
}

function measure(metric, sourceData, replicaData, purpose) {
  objectFields(metric, ['id', 'value_type', 'source', 'replica', 'tolerance'], '指标');
  if (typeof metric.id !== 'string' || !/^[\w-]{1,80}$/.test(metric.id)) throw new Error('指标ID无效');
  if (!['count', 'continuous'].includes(metric.value_type)) throw new Error('指标类型无效');
  objectFields(metric.source, SIDE_FIELDS, metric.id + '主解口径');
  objectFields(metric.replica, SIDE_FIELDS, metric.id + '复算口径');
  objectFields(metric.tolerance, ['absolute', 'relative'], metric.id + '容差');
  const tolerance = { ...metric.tolerance };
  for (const value of Object.values(tolerance)) if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(metric.id + '容差无效');
  const source = { ...metric.source, value: valueAt(sourceData, metric.source.result_key) };
  const replica = { ...metric.replica, value: valueAt(replicaData, metric.replica.result_key) };
  const row = { id: metric.id, value_type: metric.value_type, source, replica, tolerance, classification: 'invalid', absDiff: null, relDiff: null, reason: '' };
  if (typeof source.value !== 'number' || !Number.isFinite(source.value) || typeof replica.value !== 'number' || !Number.isFinite(replica.value)) {
    row.reason = '机器结果缺有效数值'; return row;
  }
  if (metric.value_type === 'count' && (![source.value, replica.value].every(v => Number.isSafeInteger(v) && v >= 0))) {
    row.reason = '计数必须为非负安全整数'; return row;
  }
  if (CONTEXT.some(key => typeof source[key] !== 'string' || !source[key].trim() || typeof replica[key] !== 'string' || !replica[key].trim())) {
    row.reason = '口径字段缺失'; return row;
  }
  const changed = CONTEXT.filter(key => source[key] !== replica[key]);
  if (changed.length) { row.classification = 'scope_difference'; row.reason = '口径不同：' + changed.join('、'); return row; }
  row.absDiff = Math.abs(source.value - replica.value);
  row.relDiff = source.value === 0 ? null : row.absDiff / Math.abs(source.value);
  if (purpose === 'alternative') {
    row.classification = 'alternative_difference';
    row.reason = '不同方案的观测差异，不作为独立复算通过数';
    return row;
  }
  if (metric.value_type === 'count') {
    row.classification = source.value === replica.value ? 'match' : 'discrepancy';
    row.reason = source.value === replica.value ? '计数精确相等' : '计数须精确相等；相对容差不适用';
    return row;
  }
  const compared = compareMetric({ source, replica, tolerance });
  if (compared.reason?.includes('缺有效容差')) { row.reason = compared.reason; return row; }
  row.classification = compared.match ? 'match' : 'discrepancy';
  row.reason = compared.match ? '数值在已登记容差内' : '数值超出已登记容差';
  return row;
}

function markdown(record) {
  const esc = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const kind = record.purpose === 'replication' ? '同口径独立复算' : '不同方案比较';
  const lines = [`# ${kind}`, '', `主解：${esc(record.files.source_result.rel)}（SHA-256 ${record.files.source_result.sha256}）`,
    `对照：${esc(record.files.replica_result.rel)}（SHA-256 ${record.files.replica_result.sha256}）`, '',
    '| 指标 | 主解 | 对照 | 口径/判定 | 绝对差 | 相对差 |', '|---|---:|---:|---|---:|---:|'];
  for (const m of record.metrics) lines.push(`| ${esc(m.id)} | ${esc(m.source.value)} | ${esc(m.replica.value)} | ${esc(m.classification)}：${esc(m.reason)} | ${esc(m.absDiff)} | ${m.relDiff == null ? '—' : (m.relDiff * 100).toFixed(4) + '%'} |`);
  lines.push('', `结果：${record.summary.matches}项同口径复算一致，${record.summary.discrepancies}项分歧，${record.summary.scope_differences}项口径不同，${record.summary.invalid}项无效。`);
  if (record.purpose === 'alternative') lines.push('不同方案不计入同口径独立复算一致数。');
  lines.push('口径来自登记声明；本工具核验机器结果数值与文件指纹，不证明方法在科学上等价。', '');
  return lines.join('\n');
}

function atomicWrite(file, contents) {
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, contents); fs.linkSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function buildComparison(ctx, manifest, outputBase = 'findings/comparisons/latest') {
  objectFields(manifest, ['purpose', 'source_result', 'replica_result', 'metrics'], '对拍清单');
  if (!['replication', 'alternative'].includes(manifest.purpose)) throw new Error('比较目的无效');
  if (!Array.isArray(manifest.metrics) || manifest.metrics.length < 1 || manifest.metrics.length > 200) throw new Error('指标数须为1至200');
  if (typeof outputBase !== 'string' || !/^findings\/comparisons\/[A-Za-z0-9_-]{1,64}$/.test(outputBase)) throw new Error('报告路径须在 findings/comparisons/ 下');
  const source = readResult(ctx, manifest.source_result, '主解结果');
  const replica = readResult(ctx, manifest.replica_result, '复算结果');
  if (source.file.rel === replica.file.rel) throw new Error('主解与对照不能是同一文件');
  const ids = new Set(), rows = [];
  for (const metric of manifest.metrics) {
    if (ids.has(metric?.id)) throw new Error('指标ID重复：' + metric.id);
    const row = measure(metric, source.data, replica.data, manifest.purpose);
    ids.add(row.id); rows.push(row);
  }
  const summary = { total: rows.length, matches: rows.filter(r => r.classification === 'match').length,
    discrepancies: rows.filter(r => r.classification === 'discrepancy').length,
    scope_differences: rows.filter(r => r.classification === 'scope_difference').length,
    invalid: rows.filter(r => r.classification === 'invalid').length,
    alternative_observations: rows.filter(r => r.classification === 'alternative_difference').length };
  const record = { schema_version: 1, purpose: manifest.purpose, at: Date.now(), files: { source_result: source.file, replica_result: replica.file }, metrics: rows, summary };
  const json_rel = outputBase + '.json', markdown_rel = outputBase + '.md';
  if ([source.file.rel, replica.file.rel].includes(json_rel) || [source.file.rel, replica.file.rel].includes(markdown_rel)) throw new Error('报告不能覆盖输入结果');
  const dir = path.posix.dirname(outputBase);
  ctx.sandbox.resolve(dir, 'w');
  fs.mkdirSync(path.join(ctx.workspace, dir), { recursive: true });
  const json = ctx.sandbox.resolve(json_rel, 'w'), md = ctx.sandbox.resolve(markdown_rel, 'w');
  if (fs.existsSync(json) || fs.existsSync(md)) throw new Error('报告id已存在，请用新id保留历史');
  const jsonBytes = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
  const markdownBytes = Buffer.from(markdown(record), 'utf8');
  atomicWrite(md, markdownBytes); atomicWrite(json, jsonBytes);
  return { record, json_rel, markdown_rel, json_sha256: sha256(jsonBytes), markdown_sha256: sha256(markdownBytes) };
}

function comparisonBlockers(root, saved) {
  const issues = [];
  if (!saved || typeof saved !== 'object' || !saved.record || !saved.record.files) return ['缺对拍记录'];
  for (const [label, row] of [['JSON报告', { rel: saved.json_rel, sha256: saved.json_sha256 }],
    ['Markdown报告', { rel: saved.markdown_rel, sha256: saved.markdown_sha256 }],
    ['主解结果', saved.record.files.source_result], ['复算结果', saved.record.files.replica_result]]) {
    if (!row || typeof row.rel !== 'string' || !HASH.test(row.sha256 || '')) { issues.push(label + '缺路径或哈希'); continue; }
    try { if (sha256(fs.readFileSync(checkedPath(root, row.rel))) !== row.sha256.toLowerCase()) issues.push(label + '哈希已变更'); }
    catch (error) { issues.push(label + '不可读或越界：' + error.message); }
  }
  if (!issues.length) {
    try {
      const actual = JSON.parse(fs.readFileSync(checkedPath(root, saved.json_rel), 'utf8'));
      if (JSON.stringify(actual) !== JSON.stringify(saved.record)) issues.push('JSON报告与会话登记记录不一致');
    } catch { issues.push('JSON报告格式无效'); }
  }
  return issues;
}

module.exports = { buildComparison, comparisonBlockers };
