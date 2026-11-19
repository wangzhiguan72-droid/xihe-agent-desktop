'use strict';
const fs = require('fs'), path = require('path');
const workflow = require('./contest_workflows');
const { checkedFile } = require('./verification_run');
const { sha256, freshSupportBlockers } = require('./support_integrity');
const safe = fn => { try { return fn(); } catch (e) { return ['证据核验失败：' + e.message]; } };

function deliveryBlockers(root, session) {
  const issues = [], s = session || {};
  if (['review', 'blind'].includes(s.task_scope)) return ['当前为局部审稿/盲测任务，请用task_finish按本范围收尾，不能认证整题交付'];
  issues.push(...workflow.rulesBlockers(s));
  const qg = s.question_graph || [];
  if (!qg.length) issues.push('任务表为空');
  const unfinished = qg.filter(q => q.status !== 'committed');
  if (unfinished.length) issues.push('未 committed：' + unfinished.map(q => 'Q' + q.id).join('、'));
  if (!fs.existsSync(path.join(root, 'paper', 'main.pdf'))) issues.push('paper/main.pdf 不存在（先 paper_build）');
  if (!s.paper_audit?.at) issues.push('还没跑过论文审计——先 paper_build');
  else if (s.paper_audit.must_fix) issues.push('论文审计仍有 ' + s.paper_audit.must_fix + ' 条【必须修】');
  issues.push(...safe(() => require('./contest_quality').paperAuditBlockers(root, s)));
  issues.push(...safe(() => freshSupportBlockers(root, s.support_pack, workflow.supportPolicy(s), workflow.supportRequirements(s))));
  if (!s.abstract_check?.at || s.abstract_check.must_fix) issues.push('摘要检查尚未通过，须绑定当前稿件重新abstract_check');
  issues.push(...safe(() => require('./delivery_evidence').evidenceBlockers(root, s, { final: true })));
  issues.push(...safe(() => require('./repro_evidence').freshReproBlockers(root, s.repro_check)));
  const attacks = require('./redteam').redteamBlockers(s, { final: true });
  if (attacks.length) issues.push('红队仍有未结项发现：' + attacks.map(r => r.id).join('、'));
  if (s.last_error) issues.push('任务仍有未处理的阻塞：' + s.last_error.reason);
  return [...new Set(issues)];
}
function sourceRef(ctx, rel) {
  const abs = ctx.sandbox.resolve(rel, 'r');
  const name = path.relative(ctx.workspace, abs).replace(/\\/g, '/');
  if (!name || name.startsWith('../') || path.isAbsolute(name) || !fs.statSync(abs).isFile()) throw new Error('交付文件越界或不是文件');
  return { rel: name, sha256: sha256(abs) };
}
function completionBlockers(root, s) {
  const c = s.task_completion;
  if (!c || c.scope !== s.task_scope || !Array.isArray(c.files) || !c.files.length) return ['当前任务范围尚未验收'];
  const issues = [];
  for (const row of c.files) { try { checkedFile(root, row); } catch (e) { issues.push(e.message); } }
  if (c.scope === 'review') {
    if (!s.review_snapshot || s.review_snapshot.id !== c.snapshot_id) issues.push('审稿快照已变化');
    else issues.push(...safe(() => require('./review_snapshot').snapshotBlockers(root, s.review_snapshot)));
  }
  if (c.scope === 'blind') {
    const a = require('./agent');
    if (c.epoch !== (s.data_epoch || 0) || c.input_hash !== a.inputStampHash(a.stampInputFiles(root))) issues.push('盲测输入或代码已变化，需重新核验');
  }
  return [...new Set(issues)];
}
function finishTask(ctx, args) {
  const s = ctx.session, scope = s.task_scope;
  if (!['review', 'blind'].includes(scope)) throw new Error('整题交付使用contest_clock final和release_freeze；task_finish仅收尾审稿/盲测范围');
  if (typeof args.summary !== 'string' || !args.summary.trim()) throw new Error('须说明本次实际完成的范围及限制');
  if (!Array.isArray(args.artifacts) || !args.artifacts.length || args.artifacts.length > 200) throw new Error('须登记实际交付文件');
  const files = args.artifacts.map(rel => sourceRef(ctx, rel));
  if (!files.some(row => /\.(md|txt)$/i.test(row.rel))) throw new Error('局部交付需提供结果/审稿报告');
  if (scope === 'review') {
    if (!s.review_snapshot) throw new Error('审稿须先review_snapshot固定所审版本');
    const issues = require('./review_snapshot').snapshotBlockers(ctx.workspace, s.review_snapshot);
    if (issues.length) throw new Error(issues.join('；'));
    const reports = files.filter(row => /^findings\/reviews\/.+\.(md|txt)$/i.test(row.rel));
    if (!reports.length) throw new Error('审稿报告须位于findings/reviews/，不能用旧README代替');
    if (!reports.some(row => fs.statSync(path.join(ctx.workspace, row.rel)).mtimeMs >= s.review_snapshot.at
      && !s.review_snapshot.files.some(source => source.rel === row.rel))) throw new Error('须提供建立快照后生成或更新的本轮审稿报告');
  } else {
    if (!(s.runs || []).some(r => r.ok && !r.unstable && r.epoch === (s.data_epoch || 0)) && !(s.verification_runs || []).some(r => r.ok)) throw new Error('盲测缺真实成功计算记录');
    if (!files.some(row => /\.(json|csv|xlsx)$/i.test(row.rel)) || !files.some(row => /\.(py|m)$/i.test(row.rel))) throw new Error('盲测交付需包含机器结果和实际源码');
  }
  const a = require('./agent');
  s.task_completion = { scope, at: Date.now(), summary: args.summary.trim(), files, epoch: s.data_epoch || 0,
    snapshot_id: s.review_snapshot?.id || null, input_hash: scope === 'blind' ? a.inputStampHash(a.stampInputFiles(ctx.workspace)) : null };
  return { ...s.task_completion, note: scope === 'review' ? '审稿范围已完成，发现的问题仍按各自状态处理，不代表稿件通过。' : '盲测范围已完成，不代表整题论文与提交验收。' };
}
function createRelease(ctx, extraFiles = []) {
  const s = ctx.session;
  const issues = deliveryBlockers(ctx.workspace, s);
  if (s.contest_phase !== 'final') issues.push('须先完成contest_clock final技术验收');
  if (issues.length) throw new Error('交付尚未就绪：' + issues.join('；'));
  const traceFiles = [];
  if (s.claim_trace_required || s.claim_trace?.claims?.length || s.optimization_checks?.length) {
    const traceRel = 'findings/claim_trace.json';
    const dest = ctx.sandbox.resolve(traceRel, 'w');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = JSON.stringify(require('./claim_trace').manifest(ctx.workspace, s), null, 2);
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8') !== data) fs.writeFileSync(dest, data, 'utf8');
    traceFiles.push(traceRel);
    traceFiles.push(...require('./claim_trace').files(ctx.workspace, s));
  }
  const names = [s.paper_audit.tex_path, s.paper_audit.pdf_path, s.support_pack.zip, s.support_pack.ai_pdf,
    ...require('./review_snapshot').paperInputs(ctx.workspace, s.paper_audit.tex_path).map(row => row.rel),
    ...(s.question_graph || []).flatMap(q => (q.artifacts || []).map(a => typeof a === 'string' ? a : a.path || a.rel)), ...traceFiles, ...extraFiles].filter(Boolean);
  const snapshot = require('./review_snapshot').createSnapshot(ctx, { kind: 'release', files: [...new Set(names)], label: '技术验收交付；人工审核与提交状态另核' });
  const changed = deliveryBlockers(ctx.workspace, s);
  if (changed.length) throw new Error('冻结期间证据变化，未登记为有效交付：' + changed.join('；'));
  s.release_snapshot = snapshot;
  return snapshot;
}
function sessionAcceptance(root, s) {
  const partial = ['review', 'blind'].includes(s.task_scope), stages = [];
  const row = (id, label, present, issues, notRequired = false, detail = '') => {
    stages.push({ id, label, state: notRequired ? 'not_required' : issues.length ? present ? 'blocked' : 'pending' : present ? 'passed' : 'pending', issues, detail });
  };
  row('rules', '赛事规则', !!s.contest_rules?.source, workflow.rulesBlockers(s), false, s.contest_rules?.source || '未登记来源，不能宣称官方合规');
  const qg = s.question_graph || [], currentRuns = (s.runs || []).filter(r => r.ok && !r.unstable && r.epoch === (s.data_epoch || 0));
  row('questions', '逐问结果', qg.length > 0, qg.filter(q => q.status !== 'committed').map(q => 'Q' + q.id + '：' + q.status)
    .concat(partial ? [] : safe(() => require('./optimization_trace').blockers(root, s))), s.task_scope === 'review', currentRuns.length + '次当前版本成功计算；' + (s.verification_runs || []).filter(r => r.ok).length + '次隔离核查（各主张另核实际绑定）');
  const traceActive = !!(s.claim_trace_required || s.claim_trace?.claims?.length);
  row('trace', '主张与图表追溯', !!s.claim_trace?.claims?.length,
    safe(() => require('./claim_trace').blockers(root, s, { final: !partial })), !traceActive,
    traceActive ? '核对已登记主张、结果字段和文件版本；数学含义仍须复核' : '未登记；尚未核验主张与图表的计算来源');
  row('comparison', '规范对拍', (s.comparison_reports || []).length > 0, safe(() => require('./delivery_evidence').evidenceBlockers(root, s)).filter(text => text.startsWith('对拍')), partial && !s.comparison_reports?.length);
  row('snapshot', '审稿版本', !!s.review_snapshot, s.review_snapshot ? safe(() => require('./review_snapshot').snapshotBlockers(root, s.review_snapshot)) : [], s.task_scope !== 'review' && !s.review_snapshot);
  const verification = require('./independent_verification');
  row('independent', '独立复算', !!s.independent_verification, safe(() => verification.verificationBlockers(root, s, { final: !partial })), !s.independent_verification && !verification.verificationRequired(s, { final: !partial }));
  row('review', '复核问题', Array.isArray(s.review_findings), safe(() => require('./review_findings').findingBlockers(root, s)), false, (s.review_findings || []).length + '项已登记，证据变化会重新标为待复核');
  row('repro', '空目录复现', !!s.repro_check, s.repro_check ? safe(() => require('./repro_evidence').freshReproBlockers(root, s.repro_check)) : [], partial && !s.repro_check, s.repro_check?.status || '尚未执行');
  row('paper', '论文与摘要', !!s.paper_audit, s.paper_audit ? safe(() => require('./contest_quality').paperAuditBlockers(root, s)).concat(s.paper_audit.must_fix ? ['仍有必须修问题'] : []) : [], partial);
  row('support', '支撑包', !!s.support_pack, s.support_pack ? safe(() => freshSupportBlockers(root, s.support_pack, workflow.supportPolicy(s), workflow.supportRequirements(s))) : [], partial);
  const blockers = partial ? completionBlockers(root, s) : deliveryBlockers(root, s);
  const releaseIssues = s.release_snapshot ? safe(() => require('./review_snapshot').snapshotBlockers(root, s.release_snapshot)) : [];
  const ready = !partial && blockers.length === 0 && s.contest_phase === 'final';
  const scopedComplete = partial && !!s.task_completion && blockers.length === 0;
  const released = ready && !!s.release_snapshot && releaseIssues.length === 0;
  return { scope: s.task_scope || 'solve', stages, blockers, can_freeze: ready, scoped_complete: scopedComplete, released,
    headline: s.last_error ? '任务受阻，已有计算记录已保留' : scopedComplete ? (s.task_scope === 'review' ? '审稿任务已完成，修订项另行处理' : '盲测范围已完成，整题验收另行进行') : released ? '已固定交付版本' : ready ? '技术验收通过，待固定交付版本' : '验收尚未完成',
    last_error: s.last_error || null, continuation: require('./decisions').continuationState(s),
    comparison_reports: (s.comparison_reports || []).map(r => ({ path: r.markdown_rel, summary: r.record.summary, status: r.status || 'active', superseded_by: r.superseded_by || null })),
    findings: s.review_findings || [], release: s.release_snapshot ? { manifest: s.release_snapshot.manifest, issues: releaseIssues } : null,
    review_snapshot: s.review_snapshot ? { id: s.review_snapshot.id, issues: safe(() => require('./review_snapshot').snapshotBlockers(root, s.review_snapshot)), manifest: s.review_snapshot.manifest } : null };
}
module.exports = { deliveryBlockers, sessionAcceptance, finishTask, completionBlockers, createRelease };
