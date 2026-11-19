'use strict';
const workflow = require('./contest_workflows');
const clone = value => JSON.parse(JSON.stringify(value));

// Project settings are templates for future sessions, never shared execution state.
function createProfile(input, previous = null) {
  const requested = input.contest_kind ?? previous?.contest_kind ?? 'generic';
  if (!workflow.packageRows().some(p => p.id === requested)) throw new Error('未安装赛事包：' + requested);
  const pkg = workflow.packageFor({ contest_kind: requested });
  const changedKind = previous && previous.contest_kind !== pkg.id;
  const identity = { ...pkg.identity, ...(!changedKind ? previous?.identity : {}) };
  for (const key of ['edition', 'stage', 'track']) {
    if (input[key] != null) {
      if (typeof input[key] !== 'string' || input[key].length > 100) throw new Error(key + ' 须为不超过100字的文本');
      identity[key] = input[key].trim() || (pkg.identity[key] || 'to-verify');
    }
  }
  if (Object.hasOwn(input, 'control_number')) {
    if (input.control_number != null && (typeof input.control_number !== 'string' || !/^\d{5,12}$/.test(input.control_number))) throw new Error('团队控制号须为5–12位数字，未取得前留空');
    if (input.control_number) identity.control_number = input.control_number;
    else delete identity.control_number;
  }
  const changedIdentity = previous && (changedKind || ['edition', 'stage', 'track'].some(key => identity[key] !== previous.identity?.[key]));
  let rules = changedIdentity ? {} : clone(previous?.rules || {});
  if (input.contest_rules != null) {
    if (!input.contest_rules || typeof input.contest_rules !== 'object' || Array.isArray(input.contest_rules)) throw new Error('contest_rules 须为对象');
    rules = Object.keys(input.contest_rules).length
      ? workflow.validateRules({ contest_kind: pkg.id, contest_identity: identity, title: /^20\d{2}$/.test(identity.edition) ? identity.edition : '' }, input.contest_rules) : {};
  }
  const allowed = [pkg.rules.paper_quality_profile || 'generic', 'generic'];
  const wantedPaper = input.paper_profile ?? (!changedKind && previous?.paper_profile);
  const paperProfile = allowed.includes(wantedPaper) ? wantedPaper : allowed[0];
  let deadline = changedIdentity ? null : previous?.deadline ?? null;
  if (Object.hasOwn(input, 'deadline')) {
    deadline = input.deadline == null || input.deadline === '' ? null
      : typeof input.deadline === 'number' ? input.deadline : Date.parse(input.deadline);
    if (deadline != null && (!Number.isSafeInteger(deadline) || deadline <= 0)) throw new Error('截止时间无效，请提供带时区的实际时间');
  }
  const content = { schema_version: 1, contest_kind: pkg.id, identity, rules, paper_profile: paperProfile, deadline };
  if (previous && Object.keys(content).every(key => JSON.stringify(content[key]) === JSON.stringify(previous[key]))) return clone(previous);
  return { ...content, revision: (previous?.revision || 0) + 1, updatedAt: Date.now() };
}

function sessionFields(profile) {
  if (!profile) return {};
  const pkg = workflow.packageFor({ contest_kind: profile.contest_kind });
  if (pkg.id !== profile.contest_kind) return { contest_kind: 'generic', contest_package_notice: '项目赛事包已不可用，请重新选择赛事档案。' };
  return {
    contest_kind: profile.contest_kind, contest_identity: clone(profile.identity),
    contest_rules: clone(profile.rules || {}), paper_profile: profile.paper_profile,
    contest_deadline: profile.deadline, project_contest_revision: profile.revision,
  };
}

module.exports = { createProfile, sessionFields };
