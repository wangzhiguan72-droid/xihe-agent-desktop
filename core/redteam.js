// 红队报告的确定性验收与台账：模型措辞不能替代脚本 hash 和引擎退出码。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SURFACES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function reportPath(workspace) { return path.join(workspace, 'findings', 'redteam', 'report.json'); }

function validateRedteamReport(session, workspace) {
  const issues = [];
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportPath(workspace), 'utf8')); }
  catch (e) { return { ok: false, issues: ['缺少可解析的 findings/redteam/report.json：' + String(e.message || e).slice(0, 160)], report: null }; }
  for (const k of ['claim', 'surface', 'script', 'script_hash', 'cmd', 'verdict', 'repro']) {
    if (typeof report[k] !== 'string' || !report[k].trim()) issues.push(`report.${k} 缺失或为空`);
  }
  if (!SURFACES.includes(report.surface)) issues.push('report.surface 必须是 ' + SURFACES.join('/'));
  if (!Number.isInteger(report.exit)) issues.push('report.exit 必须是整数');
  if (!['refuted', 'held'].includes(report.verdict)) issues.push('report.verdict 必须是 refuted/held');

  const scriptRel = String(report.script || '').replace(/\\/g, '/');
  if (!scriptRel.startsWith('findings/redteam/') || scriptRel.includes('..')) {
    issues.push('探针脚本必须位于 findings/redteam/ 且不能含 ..');
  } else {
    const abs = path.join(workspace, scriptRel);
    if (!fs.existsSync(abs)) issues.push('探针脚本不存在：' + scriptRel);
    else {
      const actualHash = 'sha256:' + sha256File(abs);
      if (String(report.script_hash) !== actualHash) issues.push(`script_hash 不一致：报告 ${report.script_hash}，实际 ${actualHash}`);
    }
  }

  const runs = (session.child_runs || []).filter(r => r.profile === 'redteam' && r.tool === 'python_run' && /formal:false|exit=/.test(String(r.out || '')));
  const actual = runs.length ? String(runs[runs.length - 1].out || '').match(/exit=(-?\d+)/) : null;
  if (!actual) issues.push('child_runs 中没有红队 python_run 的引擎退出码');
  else if (Number.isInteger(report.exit) && Number(actual[1]) !== report.exit) {
    issues.push(`退出码对账失败：报告 ${report.exit}，引擎 ${actual[1]}`);
  }
  if (Number.isInteger(report.exit)) {
    const expected = report.exit !== 0 ? 'refuted' : 'held';
    if (report.verdict !== expected) issues.push(`verdict 与退出码语义不一致：exit=${report.exit} 应为 ${expected}`);
  }

  const checklist = Array.isArray(report.surfaces) ? report.surfaces : [];
  for (const id of SURFACES) {
    const row = checklist.find(x => String((x && (x.surface || x.id)) || '') === id);
    if (!row) { issues.push(`七面清单缺 ${id}`); continue; }
    if (typeof row.attacked !== 'boolean') issues.push(`${id}.attacked 必须是 boolean`);
    if (row.attacked === false && !String(row.reason || row.note || '').trim()) issues.push(`${id} 未攻击必须说明不适用原因`);
  }
  return { ok: issues.length === 0, issues, report };
}

function isResolved(row) {
  return !!(row.resolved || row.waived || ['held', 'resolved', 'accepted_risk'].includes(row.status));
}
function redteamBlockers(session, { final = false } = {}) {
  return (session.redteam || []).filter(r => !isResolved(r) && (final || r.severity === '致命'));
}

function finalizeRedteam(session, workspace) {
  const v = validateRedteamReport(session, workspace);
  session.redteam = session.redteam || [];
  session.redteam_seq = (session.redteam_seq || 0) + 1;
  const id = 'R' + session.redteam_seq;
  const report = v.report || {};
  const row = {
    id, at: Date.now(), claim: String(report.claim || '红队报告未通过验收').slice(0, 500),
    surface: report.surface || null, severity: String(report.severity || '致命'),
    status: v.ok ? (report.verdict === 'held' ? 'held' : 'open') : 'open',
    resolved: v.ok && report.verdict === 'held',
    exit: Number.isInteger(report.exit) ? report.exit : null,
    verdict: report.verdict || null, script: report.script || null,
    validation_errors: v.issues,
  };
  session.redteam.push(row);
  return { ...v, id, row };
}

function resolveRedteam(session, id, { iterationId = null, waived = false, reason = '' } = {}) {
  const row = (session.redteam || []).find(r => r.id === id);
  if (!row) throw new Error(`红队发现 ${id} 不存在`);
  if (waived && !String(reason).trim()) throw new Error('接受红队风险必须给非空 reason，并在论文中披露');
  row.resolved = true;
  row.status = waived ? 'accepted_risk' : 'resolved';
  if (iterationId) row.iteration_id = iterationId;
  if (waived) { row.waived = true; row.waive_reason = String(reason).slice(0, 600); }
  return row;
}

module.exports = { SURFACES, validateRedteamReport, finalizeRedteam, redteamBlockers, resolveRedteam, isResolved };
