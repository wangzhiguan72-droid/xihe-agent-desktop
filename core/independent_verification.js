'use strict';
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./support_integrity');

// Optional session.independent_verification contract:
// { paper:{rel,sha256}, source_result:{rel,sha256},
//   files:[{rel,sha256,kind:'script'|'result'}],
//   provenance:{independent_implementation:true,target_answer_blind:true,
//     execution:{status:'succeeded',exit_code:0,script_rel,result_rel}},
//   metrics:[{id,source:{value,result_key?,unit,definition,denominator,time_origin},
//     replica:{value,result_key?,unit,definition,denominator,time_origin},
//     tolerance:{absolute?,relative?},classification:'match'|'scope_difference'|'discrepancy',
//     resolution?:{status:'resolved',reason,paper_sha256}}] }
// result_key is a dot path in the corresponding machine JSON; default is metric.id.
// This checks hashes, JSON values and arithmetic. It cannot prove what the script read.

const HASH = /^[a-f0-9]{64}$/i;
const CONTEXT = ['unit', 'definition', 'denominator', 'time_origin'];
function finite(v) { return typeof v === 'number' && Number.isFinite(v); }

function compareMetric(metric) {
  const a = metric && metric.source, b = metric && metric.replica;
  if (!a || !b || !finite(a.value) || !finite(b.value)) return { comparable: false, match: false, invalid: true, reason: '缺有效数值' };
  if (CONTEXT.some(k => typeof a[k] !== 'string' || !a[k].trim() || typeof b[k] !== 'string' || !b[k].trim())) return { comparable: false, match: false, invalid: true, reason: '缺口径字段，不适用须明确填写' };
  const changed = CONTEXT.filter(k => a[k] !== b[k]);
  for (const key of ['dataset', 'protocol']) {
    if ((a[key] != null || b[key] != null) && (typeof a[key] !== 'string' || !a[key].trim() || a[key] !== b[key])) changed.push(key);
  }
  if (changed.length) return { comparable: false, match: false, reason: `口径不同或缺失：${changed.join('、')}` };
  const absDiff = Math.abs(a.value - b.value);
  const relDiff = a.value === 0 ? null : absDiff / Math.abs(a.value);
  if (metric.value_type === 'count') {
    if (![a.value, b.value].every(v => Number.isSafeInteger(v) && v >= 0)) return { comparable: false, match: false, invalid: true, reason: '计数必须是非负安全整数' };
    return { comparable: true, match: a.value === b.value, absDiff, relDiff };
  }
  const t = metric.tolerance || {};
  const absOk = finite(t.absolute) && t.absolute >= 0;
  const relOk = finite(t.relative) && t.relative >= 0;
  if ((!absOk && !relOk) || (a.value === 0 && !absOk)) return { comparable: true, match: false, absDiff, relDiff, reason: '缺有效容差；零基准值需绝对容差' };
  return { comparable: true, match: (absOk && absDiff <= t.absolute) || (relOk && relDiff != null && relDiff <= t.relative), absDiff, relDiff };
}

function checkedFile(root, row, label, blockers) {
  if (!row || typeof row.rel !== 'string' || !HASH.test(row.sha256 || '')) {
    blockers.push(`${label}缺相对路径或有效 SHA-256`); return false;
  }
  const abs = path.resolve(root, row.rel);
  const rel = path.relative(root, abs);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    blockers.push(`${label}越出项目工作区`); return false;
  }
  try {
    const real = fs.realpathSync(abs);
    const realRel = path.relative(fs.realpathSync(root), real);
    if (!realRel || realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
      blockers.push(`${label}实际路径越出项目工作区：${row.rel}`); return false;
    }
    if (!fs.statSync(real).isFile() || sha256(real).toLowerCase() !== row.sha256.toLowerCase()) {
      blockers.push(`${label}内容与登记哈希不符：${row.rel}`); return false;
    }
  } catch { blockers.push(`${label}文件缺失或不可读：${row.rel}`); return false; }
  return true;
}

function resultJson(root, row, label, blockers) {
  if (!checkedFile(root, row, label, blockers)) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(path.resolve(root, row.rel), 'utf8'));
    if (!obj || typeof obj !== 'object') throw new Error('根须为对象');
    return obj;
  } catch (e) { blockers.push(`${label}不是有效的机器结果 JSON：${e.message}`); return null; }
}

function jsonValue(obj, key) {
  if (!obj || typeof key !== 'string' || !key.trim()) return undefined;
  return key.split('.').reduce((v, part) => v && Object.prototype.hasOwnProperty.call(v, part) ? v[part] : undefined, obj);
}

function resolved(metric, paperHash, root, strict) {
  const r = metric.resolution || {};
  if (!(r.status === 'resolved' && typeof r.reason === 'string' && r.reason.trim().length >= 12 && r.paper_sha256 === paperHash)) return false;
  if (!strict) return true;
  const issues = [];
  if (!checkedFile(root, r.disclosure, '分歧披露位置', issues) || typeof r.disclosure.quote !== 'string' || !r.disclosure.quote.trim()) return false;
  return fs.readFileSync(path.resolve(root, r.disclosure.rel), 'utf8').includes(r.disclosure.quote);
}
function verificationRequired(session = {}, options = {}) {
  if (['blind', 'review'].includes(session.task_scope)) return false;
  const required = require('./contest_workflows').packageFor(session).workflow.independent_verification_required === true;
  return required && (session.contest === true || session.task_scope === 'delivery' || options.final === true);
}
function verificationBlockers(root, session, options = {}) {
  const v = session && session.independent_verification;
  const required = verificationRequired(session, options);
  if (v == null) return required ? ['本任务要求独立复算，尚未登记执行证据（不能把未开始视为通过）'] : [];
  const strict = required || v.schema_version === 2;
  const problems = [];
  if (!v || typeof v !== 'object') return ['独立复算记录格式无效'];
  checkedFile(root, v.paper, '目标论文', problems);
  if (session.paper_audit) {
    const a = session.paper_audit;
    const paperRel = v.paper?.rel?.replace(/\\/g, '/');
    const bound = [[a.tex_path, a.tex_sha256], [a.pdf_path, a.pdf_sha256]]
      .some(([rel, hash]) => rel && HASH.test(hash || '') && paperRel === rel.replace(/\\/g, '/') && v.paper?.sha256 === hash);
    if (!bound) problems.push('复算绑定的论文不是当前论文审计版本');
  }
  const source = resultJson(root, v.source_result, '主解结果', problems);
  const files = Array.isArray(v.files) ? v.files : [];
  const scripts = files.filter(f => f && f.kind === 'script');
  const results = files.filter(f => f && f.kind === 'result');
  if (!scripts.length || !results.length) problems.push('独立复算缺脚本或结果文件哈希');
  if (new Set(files.map(f => f?.rel)).size !== files.length) problems.push('独立复算文件路径重复');
  files.forEach((f, i) => checkedFile(root, f, `复算文件 ${i + 1}`, problems));
  const p = v.provenance || {};
  const e = p.execution || {};
  if (strict) {
    const receipt = (session.verification_runs || []).find(row => row.run_id === e.run_id);
    problems.push(...require('./verification_run').receiptBlockers(root, receipt));
    if (!receipt || receipt.script?.rel !== e.script_rel || receipt.result?.rel !== e.result_rel
      || receipt.script?.sha256 !== scripts.find(row => row.rel === e.script_rel)?.sha256
      || receipt.result?.sha256 !== results.find(row => row.rel === e.result_rel)?.sha256) problems.push('独立复算清单未绑定当前宿主运行回执的脚本及结果');
  }
  if (p.independent_implementation !== true || p.target_answer_blind !== true) problems.push('独立实现或目标答案隔离声明缺失');
  if (e.status !== 'succeeded' || e.exit_code !== 0 || !scripts.some(f => f.rel === e.script_rel)
      || !results.some(f => f.rel === e.result_rel)) problems.push('缺成功执行的复算脚本与结果记录；审阅回执不能代替运行证据');
  const replicaRow = results.find(f => f.rel === e.result_rel);
  const replica = replicaRow ? resultJson(root, replicaRow, '复算结果', problems) : null;
  if (!Array.isArray(v.metrics) || !v.metrics.length) problems.push('独立复算缺指标对照');
  else {
    const ids = new Set();
    for (const m of v.metrics) {
      if (!m || !m.id || ids.has(m.id)) { problems.push('复算指标 ID 缺失或重复'); continue; }
      ids.add(m.id);
      for (const [side, obj, label] of [['source', source, '主解'], ['replica', replica, '复算']]) {
        const key = m[side]?.result_key || m.id;
        const actual = jsonValue(obj, key);
        if (obj && (!finite(actual) || actual !== m[side]?.value)) problems.push(`${m.id}：${label}登记值与机器结果 JSON 的 ${key} 不一致`);
      }
      const c = compareMetric(m);
      if (c.invalid) problems.push(`${m.id}：${c.reason}`);
      else if (!c.comparable) {
        if (m.classification !== 'scope_difference' || !resolved(m, v.paper?.sha256, root, strict)) problems.push(`${m.id}：${c.reason}；须分类并在当前论文披露`);
      } else if (c.match) {
        if (m.classification !== 'match') problems.push(`${m.id}：数值在容差内，但分类未对应`);
      } else if (m.classification !== 'discrepancy' || !resolved(m, v.paper?.sha256, root, strict)) {
        problems.push(`${m.id}：复算数值超出容差或容差无效，分歧尚未在当前论文解决`);
      }
    }
  }
  return problems;
}

module.exports = { compareMetric, verificationBlockers, verificationRequired };
