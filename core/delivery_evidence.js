'use strict';
function evidenceBlockers(root, session, options = {}) {
  const issues = require('./independent_verification').verificationBlockers(root, session, options)
    .concat(require('./review_findings').findingBlockers(root, session));
  issues.push(...require('./claim_trace').blockers(root, session, options));
  if (options.final) issues.push(...require('./optimization_trace').blockers(root, session));
  if (session.repro_check || (options.final && (session.contest || session.task_scope === 'delivery'))) {
    issues.push(...require('./repro_evidence').freshReproBlockers(root, session.repro_check));
  }
  for (const saved of session.comparison_reports || []) {
    if (saved.status === 'superseded') continue;
    const stale = require('./result_comparison').comparisonBlockers(root, saved);
    issues.push(...stale.map(text => '对拍' + saved.json_rel + '：' + text));
    if (stale.length || saved.record?.purpose !== 'replication') continue;
    const v = session.independent_verification;
    for (const metric of saved.record.metrics || []) {
      if (metric.classification === 'match') continue;
      const bound = v?.source_result?.sha256 === saved.record.files.source_result.sha256
        && v?.files?.some(row => row.kind === 'result' && row.sha256 === saved.record.files.replica_result.sha256);
      const resolution = bound && v.metrics?.find(row => row.id === metric.id && row.classification === metric.classification && row.resolution?.status === 'resolved');
      if (!resolution || metric.classification === 'invalid') issues.push('对拍指标 ' + metric.id + ' 尚有未解决的' + metric.classification + '；须补证据、同口径重算或在独立复算清单绑定当前稿件披露');
    }
  }
  return [...new Set(issues)];
}
module.exports = { evidenceBlockers };
