// 只消费声明式赛事包；工作强度与模型提供商不定义赛事规则。
'use strict';
const crypto = require('crypto');
const registry = require('./contest_packages');
function packageFor(session = {}) { return typeof session === 'string' ? registry.getPackage(session) || registry.getPackage('generic') : registry.detectPackage(session); }
function contestKind(session = {}) { return packageFor(session).id; }
function packageRows() {
  return registry.loadPackages().map(p => ({ id: p.id, label: p.label, identity: p.identity, skill: p.skills.default,
    profiles: Object.entries(p.rules.profiles).map(([id, v]) => ({ id, edition: v.edition, stage: v.stage })) }));
}
function packageStamp(session = {}) {
  const p = packageFor(session);
  return crypto.createHash('sha256').update(JSON.stringify({ id: p.id, identity: p.identity, skills: p.skills, rules: p.rules, workflow: p.workflow, template: p.template })).digest('hex');
}
function auditPolicy(session = {}) { return JSON.stringify({ package: packageStamp(session), rules: session.contest_rules || {}, paper_profile: session.paper_profile || null,
  ...(contestKind(session) === 'mcm-icm' ? { mcm_identity: require('./mcm_policy').policyFingerprint(session) } : {}) }); }
function templateDir(session = {}) { return registry.validatePackageDir(packageFor(session).root).template_dir; }
function mathSkill(provider, session = {}) { const s = packageFor(session).skills; return s.providers[provider] || s.default; }
function skillChain(provider, override, session = {}) {
  const current = packageFor(session), generic = registry.getPackage('generic');
  if (override) {
    const shared = [current.skills.default, ...Object.values(current.skills.providers), generic.skills.default, ...Object.values(generic.skills.providers)].includes(override);
    const other = !shared && registry.loadPackages().find(p => p.id !== current.id && [p.skills.default, ...Object.values(p.skills.providers)].includes(override));
    if (other) throw new Error('技能 ' + override + ' 属于 ' + other.label + '，与当前 ' + current.label + ' 不匹配；请显式选择对应赛事包');
  }
  return [...new Set([override, mathSkill(provider, session), current.skills.default, generic.skills.default].filter(Boolean))];
}
function supportPolicy(session = {}) {
  const r = session.contest_rules || {};
  if (typeof r.source === 'string' && r.source.trim() && Number.isSafeInteger(r.max_support_bytes) && r.max_support_bytes > 0) {
    return { max_bytes: r.max_support_bytes, exclusive: r.support_limit_exclusive === true, source: r.source.trim() };
  }
  return { ...packageFor(session).rules.defaults.support_policy };
}
function workflowBlock(session = {}) {
  const p = packageFor(session), r = session.contest_rules || {};
  return '【赛事档案·' + p.label + '】' + p.workflow.intro + '\n身份：' + JSON.stringify(session.contest_identity || p.identity) + '；当前已登记规则：' + (r.profile || '待核对届次/来源') + '。执行档位只改变投入和验证方式，不能改变适用的赛事规则。';
}
function phaseGuidance(phase, session = {}) {
  const p = packageFor(session);
  return '【' + p.label + '阶段·' + phase + '】' + (p.workflow.phases[phase] || p.workflow.phases.baseline);
}
function rulesBlockers(session = {}) {
  const p = packageFor(session), config = p.rules, r = session.contest_rules || {};
  if (!config.require_confirmation && !r.profile) return [];
  if (!session.contest && p.id === 'generic') return [];
  const issues = [], profile = config.profiles[r.profile];
  if (p.id === 'mcm-icm' && r.profile && !profile) issues.push('MCM/ICM 当前届次无已核实赛事档，不能把往届条款标为当前届次官方验收；须登记适用的新赛事包规则');
  const required = [...new Set([...(config.required_fields || []), ...(profile?.required_fields || []), ...Object.keys(profile?.constraints || {})])];
  for (const key of required) if (r[key] == null || (typeof r[key] === 'string' && !r[key].trim())) issues.push(p.label + '规则尚未明确登记 ' + key + '（届次/profile、实际来源及适用条款）');
  if ((typeof r.source !== 'string' || !r.source.trim()) && !required.includes('source')) issues.push('当届规则缺实际来源');
  if (r.profile && !profile && p.id !== 'generic' && !String(r.profile).startsWith(p.id + '-')) issues.push('规则profile与当前赛事身份冲突');
  const titleYear = String(session.title || '').match(/(?:^|\D)(20\d{2})(?!\d)/)?.[1];
  const profileYear = profile?.edition || String(r.profile || '').match(/(?:^|-)(20\d{2})(?:-|$)/)?.[1];
  if (titleYear && profileYear && titleYear !== profileYear) issues.push('规则profile年份与当前赛事标题年份冲突');
  const identityYear = String(session.contest_identity?.edition || '').match(/^20\d{2}$/)?.[0];
  if (identityYear && profileYear && identityYear !== profileYear) issues.push('规则profile年份与当前赛事档案届次冲突');
  if (p.id === 'mcm-icm' && r.problem_deliverables != null) {
    try { require('./mcm_policy').validateProblemDeliverables(r.problem_deliverables, session.contest_identity || {}); }
    catch (e) { issues.push(e.message); }
  }
  for (const [key, expected] of Object.entries(profile?.constraints || {})) {
    if (r[key] == null) continue;
    const ok = typeof expected === 'number' ? typeof r[key] === 'number' && (key.includes('min') ? r[key] >= expected : r[key] <= expected) : r[key] === expected;
    if (!ok) issues.push('登记条款 ' + key + ' 与已核验赛事档 ' + r.profile + ' 冲突，不得削弱有来源的规则');
  }
  if (r.max_body_pages != null && (!Number.isSafeInteger(r.max_body_pages) || r.max_body_pages <= 0)) issues.push('正文页数上限须为正整数，未知限制不要编造');
  for (const key of ['appendix_code_required', 'ai_statement_in_body']) if (r[key] != null && typeof r[key] !== 'boolean') issues.push(key + ' 须为布尔值');
  if (r.ai_statement_position != null && !['before_references', 'after_references'].includes(r.ai_statement_position)) issues.push('AI声明位置约定无效');
  return issues;
}
function paperPolicy(session = {}) { return packageFor(session).rules.paper; }
function validateRules(session, rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || typeof rules.source !== 'string' || !rules.source.trim()) throw new Error('rules.source 必填：实际读取的当届文件与页码/条款');
  for (const key of ['max_body_pages', 'max_file_bytes', 'max_support_bytes']) {
    if (rules[key] != null && (!Number.isSafeInteger(rules[key]) || rules[key] <= 0)) throw new Error(`${key} 须为正整数`);
  }
  const allowed = ['source', 'profile', 'max_body_pages', 'max_file_bytes', 'max_support_bytes', 'support_limit_exclusive', 'ai_statement_in_body', 'ai_statement_position', 'appendix_code_required', 'support_manifest_required', 'abstract_first_page', 'toc_required', 'problem_materials_in_references', 'problem_deliverables'];
  if (rules.ai_statement_position != null && !['before_references', 'after_references'].includes(rules.ai_statement_position)) throw new Error('AI声明位置须为 before_references/after_references');
  for (const key of ['support_limit_exclusive', 'ai_statement_in_body', 'appendix_code_required', 'support_manifest_required', 'abstract_first_page', 'toc_required', 'problem_materials_in_references']) {
    if (rules[key] != null && typeof rules[key] !== 'boolean') throw new Error(`${key} 须为布尔值`);
  }
  const candidate = Object.fromEntries(allowed.filter(k => rules[k] != null).map(k => [k, rules[k]]));
  if (candidate.problem_deliverables != null) {
    if (packageFor(session).id !== 'mcm-icm') throw new Error('problem_deliverables 当前仅支持 MCM/ICM 按题登记');
    candidate.problem_deliverables = require('./mcm_policy').validateProblemDeliverables(candidate.problem_deliverables, session.contest_identity || {});
  }
  const blockers = rulesBlockers({ ...session, contest_rules: candidate });
  if (blockers.length) throw new Error(blockers.join('；'));
  return candidate;
}
function supportRequirements(session = {}) {
  return { manifest_in_paper: paperPolicy(session).support_manifest_required === true || !!(session.contest_rules?.source && session.contest_rules.support_manifest_required === true) };
}
function qualityFor(session = {}) {
  const p = packageFor(session);
  if (!p.rules.paper_quality_profile || session.paper_profile === 'generic') return {};
  return p.rules.quality || {};
}
// 兼容展示API；实际路由始终按会话包解析，不用历史键兜底。
const legacy = registry.getPackage('cumcm')?.skills || { default: 'contest-modeling-generic', providers: {} };
const MATH_SKILLS = { ...legacy.providers, fallback: legacy.default };
const CONTEST_SKILLS = Object.fromEntries(packageRows().map(p => [p.id, p.skill]));
module.exports = { MATH_SKILLS, CONTEST_SKILLS, packageFor, packageRows, packageStamp, auditPolicy, templateDir, contestKind, mathSkill, skillChain, supportPolicy, workflowBlock, phaseGuidance, rulesBlockers, validateRules, paperPolicy, qualityFor, supportRequirements };
