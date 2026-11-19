// Durable raw material, bounded active context. Engine completion is not mathematical validation.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function archiveHash(file) { return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function identity(value) { return crypto.createHash('sha256').update(String(value || 'session')).digest('hex').slice(0, 20); }
function bounded(text, limit = 1200) {
  const s = String(text || '');
  return s.length <= limit ? s : s.slice(0, limit - 200) + '\n[摘要截短，原文见归档]\n' + s.slice(-150);
}
function writeArchive(root, dirs, payload) {
  // Refuse junction/symlink escapes even if an output folder already exists.
  const base = fs.realpathSync(root);
  let dir = base;
  for (const part of dirs) {
    if (!/^[a-zA-Z0-9_-]+$/.test(part)) throw new Error('非法归档目录');
    dir = path.join(dir, part);
    fs.mkdirSync(dir, { recursive: true });
    const real = fs.realpathSync(dir);
    const rel = path.relative(base, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('归档目录越界');
    dir = real;
  }
  const file = path.join(dir, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
  return { path: file, sha256: archiveHash(file) };
}
function archiveContext(appDir, sessionId, messages) {
  return writeArchive(appDir, ['findings', 'context', identity(sessionId)], {
    schema: 1, session_id: sessionId, at: Date.now(), messages,
  });
}
function makeHandoff({ workspace, sessionId, taskId, role, report, reason, childRunIds = [], messages = [] }) {
  const status = reason === 'stop' ? 'completed' : reason === 'stopped' ? 'cancelled'
    : ['max_iter', 'budget', 'provider_error', 'error', 'no_model', 'output_truncated', 'empty_report'].includes(reason) ? 'failed' : 'unverified';
  const warnings = [];
  let archive = null, hash = null;
  try {
    const saved = writeArchive(workspace, ['findings', 'handoffs', identity(sessionId)], {
      schema: 1, task_id: taskId || null, role: role || null, reason: reason || 'unverified',
      at: Date.now(), report: String(report || ''), child_run_ids: childRunIds, messages,
    });
    archive = path.relative(fs.realpathSync(workspace), saved.path).split(path.sep).join('/');
    hash = saved.sha256;
  } catch (e) { warnings.push('原文归档失败：' + bounded(e.message, 240)); }
  if (status !== 'completed') warnings.push('未取得正常完成状态；不得将报告当作已完成结果。');
  return {
    schema: 1, task_id: taskId || null, role: role || null, status,
    reason: reason || 'unverified', acceptance: 'pending', formal: false,
    summary: bounded(report), child_run_ids: childRunIds.slice(),
    archive, archive_hash: hash, warnings,
  };
}
function formatHandoff(h) {
  return '[结构化子代理交接·待主脑验收]\n' + JSON.stringify(h, null, 2)
    + '\n完成状态只代表执行已结束；正式数值仍须 question_graph link_run 显式接收真实 child_run_ids。';
}
module.exports = { bounded, archiveHash, archiveContext, makeHandoff, formatHandoff };
