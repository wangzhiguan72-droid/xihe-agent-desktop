'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const skills = require('./skills');
const contests = require('./project_contest');
const workflow = require('./contest_workflows');
const pluginRegistry = require('./plugins');
const assessment = require('./skill_assessment');
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SLOTS = ['research', 'figures', 'review'];
const FORMAT = 'xihe-project-plan';
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '须为对象');
  return value;
}
function skillName(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 100 || /[\s\\/:\x00-\x1f]/.test(value) || value.includes('..')) throw new Error('Skill 名称无效');
  return value;
}
function selection(value = {}, slot) {
  object(value, slot);
  const primary = skillName(value.primary);
  const fallbacks = value.fallbacks ?? [];
  if (!Array.isArray(fallbacks) || fallbacks.length > 8) throw new Error(slot + '.fallbacks须为最多8项的数组');
  const clean = [...new Set(fallbacks.map(skillName).filter(Boolean))];
  if (slot === 'main') return { primary, fallbacks: clean };
  const mode = value.mode || 'off';
  if (!['off', 'append', 'replace'].includes(mode)) throw new Error(slot + '.mode须为off/append/replace');
  if (mode !== 'off' && !primary && !clean.length) throw new Error(slot + '启用后需选择Skill');
  return { mode, primary, fallbacks: clean };
}
function contestInput(profile) {
  return { contest_kind: profile.contest_kind, edition: profile.identity.edition || '', stage: profile.identity.stage || '',
    track: profile.identity.track || '', control_number: profile.identity.control_number || null, contest_rules: clone(profile.rules || {}), paper_profile: profile.paper_profile,
    deadline: profile.deadline };
}
function defaultPlan(profile) {
  return normalizePlan({ schema_version: 1, label: '项目建模方案', skills: {}, evidence: { claim_trace: 'optional' } }, profile);
}
function normalizePlan(input, previousProfile) {
  object(input, '方案');
  if (input.schema_version !== 1) throw new Error('方案schema_version必须为1');
  for (const key of Object.keys(input)) if (!['schema_version', 'label', 'contest', 'skills', 'evidence', 'plugins', 'task_context'].includes(key)) throw new Error('未知方案字段：' + key);
  if (input.label != null && (typeof input.label !== 'string' || input.label.length > 100)) throw new Error('方案名称不超过100字');
  const profile = contests.createProfile(input.contest || {}, previousProfile);
  const evidence = object(input.evidence ?? {}, 'evidence');
  for (const key of Object.keys(evidence)) if (key !== 'claim_trace') throw new Error('未知证据选项：' + key);
  const claimTrace = evidence.claim_trace ?? 'optional';
  if (!['required', 'optional'].includes(claimTrace)) throw new Error('evidence.claim_trace须为required或optional');
  const picks = object(input.skills || {}, 'skills');
  for (const key of Object.keys(picks)) if (!['main', ...SLOTS].includes(key)) throw new Error('未知Skill槽位：' + key);
  const normalized = { main: selection(picks.main, 'main') };
  for (const slot of SLOTS) normalized[slot] = selection(picks[slot], slot);
  for (const name of [normalized.main.primary, ...normalized.main.fallbacks].filter(Boolean)) workflow.skillChain('deepseek', name, { contest_kind: profile.contest_kind });
  return { schema_version: 1, label: input.label || '项目建模方案', contest: contestInput(profile), skills: normalized,
    evidence: { claim_trace: claimTrace }, plugins: pluginRegistry.normalizeSelections(input.plugins),
    task_context: assessment.normalizeContext(input.task_context) };
}
function sessionFields(plan) { return { ...contests.sessionFields(contests.createProfile(plan.contest)),
  claim_trace_required: plan.evidence?.claim_trace === 'required' }; }
function skillOptions(settings = {}, root) {
  return { ...(root ? { projectRoot: root } : {}), extraRoots: Array.isArray(settings.skill_roots) ? settings.skill_roots : [] };
}
function resolvePlan({ appDir, plan, provider = 'deepseek', options = {}, lock = null, mainOverride = null,
  gainContext = null, baselineLock = null, verifyAttestation }) {
  const session = sessionFields(plan);
  const entries = [], loaded = [], notices = [];
  const pluginState = pluginRegistry.resolve({ appDir, selections: plan.plugins || [], options, lock: lock?.plugins });
  const environment = { contest_kind: session.contest_kind, context: plan.task_context,
    tools: require('./tools').TOOLS.map(row => row.name), plugins: pluginState.entries.filter(row => row.status === 'loaded').map(row => row.id) };
  for (const slot of ['main', ...SLOTS]) {
    const pick = plan.skills[slot];
    const pinned = lock?.entries?.find(row => row.slot === slot);
    const row = { slot, mode: slot === 'main' ? 'replace' : pick.mode, status: 'unavailable', name: null, version: '', source: '', sha256: null, shadowed: [], fallbacks: [],
      blocked: false, installation: { status: 'unavailable', reasons: [] }, applicability: { status: 'unknown', reasons: ['尚无可检查的Skill'] } };
    if (slot !== 'main' && pick.mode === 'off') {
      row.status = 'off'; row.installation.status = 'off'; row.applicability = { status: 'off', reasons: [] }; entries.push(row); continue;
    }
    let names;
    if (pinned && !(slot === 'main' && mainOverride)) names = pinned.status === 'loaded' ? [pinned.name] : [];
    else if (slot === 'main') names = [...new Set([mainOverride, pick.primary, ...pick.fallbacks,
      ...workflow.skillChain(provider, mainOverride || pick.primary, session)].filter(Boolean))];
    else names = [...new Set([pick.primary, ...pick.fallbacks].filter(Boolean))];
    let incompatible = null, chosen = null;
    for (const name of names) {
      try {
        const result = skills.loadSkill(appDir, name, null, options);
        if (!result.sha256) throw new Error('该Skill无法生成完整可移植指纹（超出包限制或含链接文件），请查看目录依赖');
        if (pinned && !(slot === 'main' && mainOverride) && result.sha256 !== pinned.sha256) throw new Error('锁定指纹不匹配，未使用本机同名替代版本');
        const applicability = assessment.assess(result.contract, { ...environment, slot, mode: row.mode });
        if (applicability.status === 'incompatible') {
          if (!incompatible) incompatible = { result, applicability };
          row.fallbacks.push({ name, reason: '不适配：' + applicability.reasons.join('；') });
          continue;
        }
        chosen = { result, applicability };
        if (pinned && pick.primary && pick.primary !== result.name) row.fallbacks.push({ name: pick.primary, reason: '沿用导入方案锁定的回退选择' });
        break;
      } catch (e) { row.fallbacks.push({ name, reason: String(e.message).slice(0, 300) }); }
    }
    chosen = chosen || incompatible;
    if (chosen) {
      const { result, applicability } = chosen;
      Object.assign(row, { status: 'loaded', name: result.name, version: result.version || '', source: `${result.source || ''} · ${result.file}`,
        sha256: result.sha256, shadowed: result.shadowed || [], installation: { status: 'installable', reasons: [] },
        applicability, blocked: applicability.status === 'incompatible' });
      loaded.push({ slot, skill: result });
    } else row.installation.reasons = row.fallbacks.map(item => item.reason);
    if (row.status !== 'loaded') notices.push(`${slot}没有可用Skill，保留内置通用流程与验收；没有把缺项当作已加载。`);
    else if (!row.blocked && row.fallbacks.length) notices.push(`${slot}已回退到${row.name}，原因见该槽位记录。`);
    entries.push(row);
  }
  assessment.combinationConflicts(entries, loaded);
  for (const row of entries) {
    if (row.blocked) notices.push(`${row.slot}/${row.name}适配检查未通过，不注入；保留内置流程。`);
    else if (row.status === 'loaded' && row.applicability.status === 'unknown') notices.push(`${row.slot}/${row.name}适配性待确认；${row.applicability.reasons.join('；')}。`);
  }
  for (const row of pluginState.entries) if (row.enabled && row.status !== 'loaded') notices.push(`插件 ${row.id} 未加载：${row.reason}`);
  const combination = { skills: entries.filter(row => row.status === 'loaded' && !row.blocked).map(({ slot, name, sha256, mode }) => ({ slot, name, sha256, mode })),
    plugins: pluginState.entries.filter(row => row.status === 'loaded').map(({ id, sha256 }) => ({ id, sha256 })) };
  const gain = require('./skill_gain').summarize(path.join(appDir, 'data', 'skill_evaluations'),
    { combination, context: gainContext, baseline: baselineLock, verifyAttestation });
  return { entries, loaded, notices, plugins: pluginState.entries, pluginBundles: pluginState.bundles,
    assessment: { applicability: assessment.summarize(entries), gain, combination } };
}
function resolutionLock(effective) {
  return { entries: effective.entries.map(({ slot, status, name, version, sha256 }) => ({ slot, status, name, version, sha256 })),
    plugins: (effective.plugins || []).map(({ id, status, version, sha256 }) => ({ id, status, version, sha256 })) };
}
function resolvedBundles(appDir, effective, options) {
  const bundles = [...new Map(effective.loaded.map(row => [row.skill.name, skills.readSkillBundle(appDir, row.skill.name, options)])).values()];
  for (const row of effective.loaded) if (bundles.find(bundle => bundle.name === row.skill.name)?.sha256 !== row.skill.sha256) {
    throw new Error('Skill在解析后已变化，请重新检查方案：' + row.skill.name);
  }
  return bundles;
}
function storagePath(storageRoot, kind, id) {
  fs.mkdirSync(storageRoot, { recursive: true });
  const base = fs.realpathSync(storageRoot);
  const destination = path.join(base, '.xihe', kind, id);
  let probe = destination;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const relative = path.relative(base, fs.realpathSync(probe));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('方案存储目录实际指向项目元数据之外');
  return destination;
}
function snapshot({ appDir, plan, provider, options, lock, storageRoot, revision = 0, mainOverride }) {
  const effective = resolvePlan({ appDir, plan, provider, options, lock, mainOverride });
  const bundles = resolvedBundles(appDir, effective, options);
  const identity = hash({ plan, lock: resolutionLock(effective), bundles: bundles.map(row => [row.name, row.sha256]),
    applicability: effective.entries.map(row => [row.slot, row.blocked, row.applicability]) });
  const root = storagePath(storageRoot, 'skill_snapshots', identity);
  skills.materializeBundles(root, bundles);
  pluginRegistry.materialize(root, effective.pluginBundles);
  return { schema_version: 1, plan: clone(plan), revision, id: identity, root, entries: effective.entries,
    plugins: effective.plugins, notices: effective.notices, assessment: effective.assessment, at: Date.now() };
}
function loadSessionSkill(appDir, session, name, file, settings = {}, usage = {}) {
  const frozen = session?.skill_plan_snapshot;
  const result = skills.loadSkill(appDir, name, file, skillOptions(settings, frozen?.root));
  const expected = frozen?.entries?.find(row => row.status === 'loaded' && row.name === result.name);
  if (expected && result.sha256 !== expected.sha256) throw new Error('会话Skill快照内容已变化，不能静默改用新版本：' + name);
  {
    const blocked = frozen?.entries.find(row => row.name === result.name && row.blocked);
    if (blocked) throw new Error('Skill不适配，已阻止加载：' + blocked.applicability.reasons.join('；'));
    // Dynamically discovered Skills must pass the same task/dependency checks.
    const slot = usage.slot || expected?.slot || 'research', mode = usage.mode || expected?.mode || 'append';
    if (!['main', ...SLOTS].includes(slot) || !['append', 'replace'].includes(mode)) throw new Error('动态Skill槽位或模式无效');
    const checked = assessment.assess(result.contract, { slot, mode, context: frozen?.plan.task_context || session?.task_context,
      contest_kind: frozen?.plan.contest.contest_kind || workflow.contestKind(session || {}),
      tools: require('./tools').toOpenAITools(session).map(row => row.function.name), plugins: (frozen?.plugins || []).filter(row => row.status === 'loaded').map(row => row.id) });
    if (checked.status === 'incompatible') throw new Error('Skill不适配，已阻止加载：' + checked.reasons.join('；'));
    result.applicability = checked;
    const dynamic = session?.skill_dynamic_entries || [];
    const selected = [...(frozen?.entries || []).filter(row => row.status === 'loaded' && !row.blocked), ...dynamic].filter(row => row.name !== result.name);
    for (const entry of selected) {
      const other = skills.loadSkill(appDir, entry.name, null, skillOptions(settings, frozen?.root));
      if (other.sha256 !== entry.sha256) throw new Error('已加载Skill内容已变化，需新会话重新核对：' + entry.name);
      const probe = [{ slot: 'dynamic', name: result.name, status: 'loaded', applicability: checked },
        { slot: entry.slot, name: entry.name, status: 'loaded', applicability: entry.applicability || { reasons: [] } }];
      assessment.combinationConflicts(probe, [{ slot: 'dynamic', skill: result }, { slot: entry.slot, skill: other }]);
      if (probe[0].blocked) throw new Error('Skill组合冲突，已阻止加载：' + probe[0].applicability.reasons.join('；'));
    }
    if (!expected && session) {
      const prior = dynamic.find(row => row.name === result.name);
      if (prior && prior.sha256 !== result.sha256) throw new Error('动态Skill版本已变化，需新会话重新核对：' + name);
      if (!prior) {
        if (dynamic.length >= 40) throw new Error('动态Skill达到40项，请在新会话重新组合');
        session.skill_dynamic_entries = [...dynamic, { name: result.name, sha256: result.sha256, slot: 'dynamic-' + dynamic.length,
          status: 'loaded', applicability: checked, intended_slot: slot, mode }];
      }
    }
  }
  return result;
}
function publicSnapshot(value) {
  if (!value) return null;
  const { plan, entries, plugins, notices, assessment, revision, id, at } = value;
  return clone({ plan, entries, plugins: plugins || [], notices, assessment, revision, id, at });
}
function exportPackage({ appDir, plan, provider, options, lock }) {
  const effective = resolvePlan({ appDir, plan, provider, options, lock });
  const bundles = resolvedBundles(appDir, effective, options);
  return { format: FORMAT, schema_version: 1, plan: clone(plan), skills: bundles, plugins: effective.pluginBundles, lock: resolutionLock(effective) };
}
function importPackage(packageValue, previousProfile, storageRoot) {
  object(packageValue, '导入包');
  if (packageValue.format !== FORMAT || packageValue.schema_version !== 1) throw new Error('不是受支持的羲和项目方案包');
  const plan = normalizePlan(packageValue.plan, previousProfile);
  if (!Array.isArray(packageValue.skills) || packageValue.skills.length > 16) throw new Error('方案包最多包含16个Skill');
  const bundles = packageValue.skills.map(row => skills.validateBundle(row));
  const plugins = packageValue.plugins ?? [];
  if (!Array.isArray(plugins) || plugins.length > 8) throw new Error('方案包最多包含8个插件');
  const pluginBundles = plugins.map(row => pluginRegistry.validateBundle(row));
  if (new Set(pluginBundles.map(row => row.manifest.id)).size !== pluginBundles.length) throw new Error('导入插件重名');
  if (new Set(bundles.map(row => row.name.toLowerCase())).size !== bundles.length) throw new Error('导入Skill重名');
  const lock = object(packageValue.lock, '方案锁定清单');
  if (!Array.isArray(lock.entries) || lock.entries.length !== 4) throw new Error('方案锁定清单须包含四个槽位');
  const seen = new Set();
  for (const row of lock.entries) {
    if (!row || !['main', ...SLOTS].includes(row.slot) || seen.has(row.slot) || !['loaded', 'off', 'unavailable'].includes(row.status)) throw new Error('方案锁定槽位无效或重复');
    seen.add(row.slot);
    if (row.slot === 'main' && row.status === 'off') throw new Error('赛事主Skill不可标记为关闭');
    if (row.status === 'loaded' && !bundles.some(bundle => bundle.name === row.name && bundle.sha256 === row.sha256)) throw new Error('锁定的Skill文件缺失或指纹不匹配：' + row.name);
    const pick = plan.skills[row.slot];
    if (row.slot !== 'main' && (pick.mode === 'off') !== (row.status === 'off')) throw new Error('锁定状态与槽位启停不一致');
    if (row.status === 'loaded' && row.slot !== 'main' && ![pick.primary, ...pick.fallbacks].includes(row.name)) throw new Error('锁定Skill不在该槽位候选中');
    if (row.status === 'loaded' && row.slot === 'main') {
      const pkg = workflow.packageFor(sessionFields(plan));
      const mainNames = [pick.primary, ...pick.fallbacks, pkg.skills.default, ...Object.values(pkg.skills.providers), workflow.packageFor({ contest_kind: 'generic' }).skills.default];
      if (!mainNames.includes(row.name)) throw new Error('锁定主Skill不属于所选赛事或明确候选');
    }
  }
  const pluginLock = lock.plugins ?? [];
  if (!Array.isArray(pluginLock) || pluginLock.length !== plan.plugins.length || new Set(pluginLock.map(row => row?.id)).size !== pluginLock.length) throw new Error('插件锁定清单须匹配项目选择');
  for (const selected of plan.plugins) {
    const pinned = pluginLock.find(row => row.id === selected.id);
    if (!pinned || !['off', 'loaded', 'unavailable'].includes(pinned.status) || (pinned.status === 'off') !== !selected.enabled) throw new Error('插件锁定状态与启停选择不一致');
    if (pinned.status === 'loaded' && !pluginBundles.some(row => row.manifest.id === pinned.id && row.sha256 === pinned.sha256)) throw new Error('锁定插件文件缺失或指纹不匹配：' + pinned.id);
  }
  if (pluginBundles.some(bundle => !pluginLock.some(row => row.id === bundle.manifest.id && row.status === 'loaded' && row.sha256 === bundle.sha256))) throw new Error('方案包含未启用或未锁定的插件代码');
  const root = storagePath(storageRoot, 'skill_imports', hash({ skills: bundles.map(row => [row.name, row.sha256]), plugins: pluginBundles.map(row => [row.manifest.id, row.sha256]) }));
  skills.materializeBundles(root, bundles);
  pluginRegistry.materialize(root, pluginBundles);
  return { plan, lock: clone(lock), assetRoot: root };
}
function composedBlock(appDir, session, settings, wrap, slots = SLOTS) {
  const frozen = session?.skill_plan_snapshot;
  if (!frozen) return '';
  let text = '\n\n## 项目Skill组合（本会话冻结快照）\n';
  text += '赛事官方约束、事实与证据门禁始终保留；下列替换仅作用于方法建议，不能绕过真实计算和验收。\n';
  if (slots.includes('figures')) text += '\n项目插件：' + ((frozen.plugins || []).map(row => `${row.id} ${row.status}${row.version ? ' v' + row.version : ''}${row.reason ? '（' + row.reason + '）' : ''}`).join('；') || '未启用')
    + '。启用的绘图执行插件用plugin_run；引用现有正式结果生成图件，plot_run_id只代表绘图来源，不是新的数值求解或视觉验收。\n';
  for (const row of frozen.entries.filter(row => slots.includes(row.slot))) {
    if (row.status !== 'loaded' || row.blocked) { text += `${row.slot}: ${row.blocked ? '适配检查不通过：' + row.applicability.reasons.join('；') : row.status}；保留默认流程。\n`; continue; }
    const skill = loadSessionSkill(appDir, session, row.name, null, settings);
    text += `\n### ${row.slot}（${row.mode === 'replace' ? '替换主Skill中本槽位的方法建议' : '补充主Skill中本槽位的方法建议'}）\n`;
    text += `${skill.name} v${skill.version} | SHA-256=${skill.sha256}\n` + wrap(skill.content, { kind: 'skill', source: skill.file }) + '\n';
  }
  text += '\n适配检查只核声明条件；未知项需先核对，固定参数不能直接当成本题事实。组合效果：'
    + (frozen.assessment?.gain?.status || 'unverified') + '；功能通过不表示建模或论文质量提升。\n';
  return text;
}
module.exports = { defaultPlan, normalizePlan, contestInput, sessionFields, skillOptions, resolvePlan, snapshot,
  loadSessionSkill, publicSnapshot, exportPackage, importPackage, composedBlock, resolutionLock };
