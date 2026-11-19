'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/i;

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '须为对象');
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(label + '含不允许的字段：' + extra.join('、'));
}

function checkedFile(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\0')) throw new Error('文件路径无效或越界');
  const base = fs.realpathSync(root);
  const abs = path.resolve(base, rel);
  const inside = candidate => {
    const part = path.relative(base, candidate);
    return part && part !== '..' && !part.startsWith('..' + path.sep) && !path.isAbsolute(part);
  };
  if (!inside(abs)) throw new Error('文件路径越界');
  const real = fs.realpathSync(abs);
  if (!inside(real)) throw new Error('文件真实路径越界');
  if (!fs.statSync(real).isFile()) throw new Error('路径不是文件');
  return { abs: real, rel: path.relative(base, real).replace(/\\/g, '/') };
}

function capture(ctx, row, label) {
  fields(row, ['rel', 'quote'], label);
  if (typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 10000) throw new Error(label + '引用 quote 无效');
  ctx.sandbox.resolve(row.rel, 'r');
  const file = checkedFile(ctx.workspace, row.rel);
  if (fs.statSync(file.abs).size > 2_000_000) throw new Error(label + '文件超过2MB');
  const bytes = fs.readFileSync(file.abs);
  if (bytes.length > 2_000_000) throw new Error(label + '文件超过2MB');
  if (bytes.includes(0) || !bytes.toString('utf8').includes(row.quote)) throw new Error(label + '引用在目标文本中不存在');
  return { rel: file.rel, quote: row.quote, sha256: sha256(bytes) };
}

function captureRows(ctx, rows, label) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new Error(label + '须有1至200条');
  const found = rows.map((row, index) => capture(ctx, row, label + (index + 1)));
  if (new Set(found.map(row => row.rel)).size !== found.length) throw new Error(label + '路径重复');
  return found;
}

function registry(ctx) {
  if (!ctx || !ctx.session || !ctx.workspace || !ctx.sandbox) throw new Error('缺工作区或会话上下文');
  if (ctx.session.review_findings == null) ctx.session.review_findings = [];
  if (!Array.isArray(ctx.session.review_findings)) throw new Error('审查问题登记无效');
  return ctx.session.review_findings;
}

function registerFinding(ctx, args) {
  fields(args, ['id', 'claim', 'kind', 'severity', 'targets'], '审查问题');
  if (typeof args.id !== 'string' || !/^[\w-]{1,80}$/.test(args.id)) throw new Error('审查问题ID无效');
  if (typeof args.claim !== 'string' || !args.claim.trim() || args.claim.length > 2000) throw new Error('审查主张无效');
  if (!['text', 'numeric'].includes(args.kind)) throw new Error('审查问题类型 kind 无效');
  if (!['must_fix', 'advisory'].includes(args.severity)) throw new Error('审查严重度无效');
  const list = registry(ctx);
  const index = list.findIndex(item => item.id === args.id);
  if (index < 0 && list.length >= 200) throw new Error('审查问题数超过200');
  const finding = { id: args.id, claim: args.claim, kind: args.kind, severity: args.severity,
    targets: captureRows(ctx, args.targets, '目标'), status: 'open', at: Date.now() };
  if (index < 0) list.push(finding); else list[index] = finding;
  return finding;
}

function receiptIssues(root, receipt) {
  const { receiptBlockers } = require('./verification_run');
  const result = receiptBlockers(root, receipt);
  return Array.isArray(result) ? result : result ? [String(result)] : [];
}

function resolveFinding(ctx, args) {
  fields(args, ['id', 'reason', 'revisions', 'evidence', 'run_id'], '问题修复');
  const list = registry(ctx);
  const finding = list.find(item => item.id === args.id);
  if (!finding) throw new Error('未找到审查问题ID');
  if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) throw new Error('修复说明无效');
  const revisions = captureRows(ctx, args.revisions, '修订');
  const evidence = captureRows(ctx, args.evidence, '证据');
  const targetRels = new Set(finding.targets.map(row => row.rel));
  for (const rel of targetRels) if (!revisions.some(row => row.rel === rel)) throw new Error('修订必须覆盖每个原目标');
  if (!evidence.some(row => !targetRels.has(row.rel))) throw new Error('至少一份独立于目标的证据');
  const targets_current = finding.targets.map(row => {
    const file = checkedFile(ctx.workspace, row.rel);
    return { rel: file.rel, sha256: sha256(fs.readFileSync(file.abs)) };
  });
  let receipt;
  if (finding.kind === 'numeric') {
    if (typeof args.run_id !== 'string' || !args.run_id.trim()) throw new Error('数值问题须提供运行回执 run_id');
    if (!Array.isArray(ctx.session.verification_runs)) throw new Error('缺运行回执登记');
    receipt = ctx.session.verification_runs.find(row => row.run_id === args.run_id);
    if (!receipt || receipt.ok !== true || receipt.exit_code !== 0) throw new Error('运行回执不成功或不存在');
    const issues = receiptIssues(ctx.workspace, receipt);
    if (issues.length) throw new Error('运行回执失效：' + issues.join('；'));
    if (!receipt.result || !evidence.some(row => row.rel === receipt.result.rel)) throw new Error('证据必须包含运行回执结果 result');
  } else if (args.run_id != null) {
    throw new Error('文字问题不需要运行回执');
  }
  finding.resolution = { reason: args.reason, revisions, evidence, targets_current,
    targets_original: JSON.parse(JSON.stringify(finding.targets)),
    ...(receipt ? { run_id: receipt.run_id, receipt: JSON.parse(JSON.stringify(receipt)) } : {}), at: Date.now() };
  finding.status = 'resolved';
  return finding;
}

function currentIssues(root, session, finding) {
  const issues = [];
  const resolution = finding.resolution;
  if (!resolution || !Array.isArray(resolution.targets_current) || !Array.isArray(resolution.revisions) || !Array.isArray(resolution.evidence)) return ['缺修复证据'];
  if (JSON.stringify(finding.targets) !== JSON.stringify(resolution.targets_original)) issues.push('原目标登记已变动');
  for (const row of [...resolution.targets_current, ...resolution.revisions, ...resolution.evidence]) {
    if (!row || typeof row.rel !== 'string' || !HASH.test(row.sha256 || '')) { issues.push('路径或哈希无效'); continue; }
    try {
      const file = checkedFile(root, row.rel);
      const bytes = fs.readFileSync(file.abs);
      if (sha256(bytes) !== row.sha256.toLowerCase()) issues.push(row.rel + '内容已变动');
      if ('quote' in row && (!row.quote || !bytes.toString('utf8').includes(row.quote))) issues.push(row.rel + '引用已失效');
    } catch (error) { issues.push(row.rel + '不可读或越界：' + error.message); }
  }
  if (finding.kind === 'numeric') {
    const receipt = Array.isArray(session.verification_runs) && session.verification_runs.find(row => row.run_id === resolution.run_id);
    if (!receipt || receipt.ok !== true || receipt.exit_code !== 0 || JSON.stringify(receipt) !== JSON.stringify(resolution.receipt)) issues.push('运行回执已变动或缺失');
    else {
      try { issues.push(...receiptIssues(root, receipt)); }
      catch (error) { issues.push('运行回执不可核验：' + error.message); }
      if (!resolution.evidence.some(row => row.rel === receipt.result?.rel)) issues.push('缺运行结果证据');
    }
  }
  return issues;
}

function findingBlockers(root, session) {
  const list = session && session.review_findings;
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 200) return ['审查问题登记无效'];
  const blockers = [];
  for (const finding of list) {
    if (!finding || !finding.id || !['must_fix', 'advisory'].includes(finding.severity)) { blockers.push('审查问题记录无效'); continue; }
    const issues = finding.resolution ? currentIssues(root, session, finding) : ['未解决'];
    finding.status = finding.resolution ? issues.length ? 'stale' : 'resolved' : 'open';
    if (finding.severity === 'must_fix' && issues.length) blockers.push(finding.id + '：' + issues.join('；'));
  }
  return blockers;
}

module.exports = { registerFinding, resolveFinding, findingBlockers };
