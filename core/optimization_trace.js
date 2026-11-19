'use strict';
// Bind the bounded mathematical checker to existing formal-run receipts. Nothing
// in this module trusts stdout status strings or solver-reported optimality gaps.
const fs = require('fs');
const crypto = require('crypto');
const checker = require('./optimization_evidence');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function isOptimization(session, q) {
  const spec = (session.model_specs || []).find(s => s.question_id === q?.id)?.spec;
  return q?.type === 'optimization' || /optimization|optimisation|优化/i.test(spec?.model_type || '') || !!spec?.optimization?.check;
}

function verifyBound(root, session, questionId, runId, rel) {
  const trace = require('./claim_trace');
  const source = trace.sourceFor(root, session, questionId, runId, rel);
  const spec = (session.model_specs || []).find(s => s.question_id === questionId);
  const check = spec?.spec?.optimization?.check;
  if (!check) throw new Error('优化规格缺 optimization.check 可执行目标、约束和变量域；不能凭可行/最优字样验收');
  const abs = require('./verification_run').checkedFile(root, { rel: source.path, sha256: source.sha256 });
  const bytes = fs.readFileSync(abs);
  if (sha(bytes) !== source.sha256) throw new Error('读取期间优化结果发生变化');
  const report = checker.verify(check, JSON.parse(bytes.toString('utf8')).optimization);
  return { question_id: questionId, run_id: runId, source, check: JSON.parse(JSON.stringify(check)), report };
}

function register(ctx, input) {
  const record = verifyBound(ctx.workspace, ctx.session, input.question_id, input.run_id, input.path);
  ctx.session.optimization_checks = [
    ...(ctx.session.optimization_checks || []).filter(r => r.question_id !== input.question_id),
    { ...record, checked_at: Date.now() },
  ];
  return record;
}

function inspect(root, session, questionId) {
  return (session.optimization_checks || []).filter(r => questionId == null || r.question_id === questionId).map(record => {
    try {
      const fresh = verifyBound(root, session, record.question_id, record.run_id, record.source.path);
      if (!same(fresh.source, record.source) || !same(fresh.check, record.check) || !same(fresh.report, record.report)) throw new Error('优化核验的运行、规格、结果或结论边界已变化');
      return { ...record, status: 'fresh', reasons: [] };
    } catch (error) { return { ...record, status: 'stale', reasons: [error.message] }; }
  });
}

function questionBlockers(root, session, q) {
  if (!isOptimization(session, q)) return [];
  if (!root) return [`优化类问题 ${q.id} 需要工作区中的正式结果与 optimization_check 实算核验，文字说明不能代替`];
  // A conditional analytic route is a separate, explicitly limited verification
  // contract. It does not acquire a numerical/global-optimality certificate here.
  if (!(q.experiments || []).length) {
    const analytic = require('./claim_trace').inspect(root, session).claims
      .some(c => c.kind === 'analytic' && c.question_id === q.id && c.status === 'fresh');
    if (analytic) return [];
  }
  const records = inspect(root, session, q.id);
  if (records.some(r => r.status === 'fresh')) return [];
  return [`优化类问题 ${q.id} 缺少当前版本的结构化可行性与结论范围核验；先登记 optimization.check，正式输出 optimization 对象，再调用 optimization_check。`
    + records.flatMap(r => r.reasons).map(s => ' ' + s).join('')];
}

function blockers(root, session) {
  return (session.question_graph || []).flatMap(q => questionBlockers(root, session, q));
}

const optimalWords = text => /最优|最小|最大|最短|最长|最低|最高|最快|最慢|最佳|最省|全局|全域|\b(?:optimal(?:ity)?|minimum|maximum|best|lowest|highest|shortest|longest|fastest|slowest|global)\b/i.test(text);
function claimCheck(root, session, input) {
  const q = (session.question_graph || []).find(q => q.id === input.question_id);
  if (!input.optimality) {
    if (isOptimization(session, q) && optimalWords(input.text + ' ' + input.scope)) throw new Error('数值最优性主张必须登记 optimality:{level} 并绑定 optimization.objective；真实数字本身不证明最优');
    return undefined;
  }
  if (Object.keys(input.optimality).length !== 1 || typeof input.optimality.level !== 'string') throw new Error('optimality 仅接受 level');
  if (input.source.field !== 'optimization.objective' || (input.transform && input.transform.kind !== 'identity')) throw new Error('最优性主张必须直接绑定 optimization.objective，单位换算另行登记');
  const record = verifyBound(root, session, input.question_id, input.run_id, input.source.path);
  const level = input.optimality.level;
  if (level !== record.report.level) throw new Error('主张的最优性级别与已核查结果不一致');
  const text = input.text + ' ' + input.scope;
  if (/全局|全域|global/i.test(text)) throw new Error('自动最优性核验只接受明确的登记有限域、候选或网格范围，不接受泛称全局/全域最优');
  if (['feasible', 'candidates', 'grid'].includes(level) && /有限域|finite\s+domain/i.test(text)
      || ['feasible', 'candidates'].includes(level) && /网格|grid/i.test(text)) throw new Error('主张超出已核查的候选或可行性范围');
  const qualifier = { feasible: /可行|feasible/i, candidates: /候选|candidate/i, grid: /网格|grid/i, finite_domain: /有限域|finite\s+domain/i }[level];
  if (!qualifier?.test(input.text)) throw new Error('主张原句须写明核查级别的范围：可行、候选、网格或登记有限域');
  if (level === 'feasible' && optimalWords(text)) throw new Error('可行性证据不能支持最优性主张');
  if (input.scope !== record.report.optimality_scope) throw new Error('最优性 scope 须使用 optimization_check 返回的 optimality_scope 原值；数据假设和适用前提另记模型规格，不扩大已核验范围');
  return record;
}

module.exports = { isOptimization, verifyBound, register, inspect, questionBlockers, blockers, claimCheck };
