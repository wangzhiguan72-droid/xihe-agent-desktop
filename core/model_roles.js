// 角色模型路由：设置只描述“哪个角色用哪个模型”，运行时按职责/任务选择。
// 本模块不发起 LLM 请求；分类、回退与告警都可离线测试。
'use strict';
const { providerForModel, resolveProvider, keyFor } = require('./providers');

const ROLE_IDS = ['modeler', 'coder', 'writer', 'reviewer'];
const ROLE_LABELS = { modeler: '建模手', coder: '编程手', writer: '论文手', reviewer: '审查手' };
const ROLE_ALIASES = {
  model: 'modeler', modeling: 'modeler', modeler: 'modeler',
  code: 'coder', coding: 'coder', coder: 'coder',
  write: 'writer', writing: 'writer', paper: 'writer', writer: 'writer',
  review: 'reviewer', reviewer: 'reviewer', redteam: 'reviewer', red: 'reviewer',
};

function normalizeRoleModels(input) {
  const out = Object.fromEntries(ROLE_IDS.map(r => [r, '']));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const role of ROLE_IDS) out[role] = String(input[role] || '').trim().slice(0, 200);
  return out;
}

function normalizeRole(role) {
  const key = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[key] || null;
}

const TASK_PATTERNS = {
  reviewer: /(独立审查|审查|评审|复核|核查|证伪|红队|挑错|漏洞|review|audit)/i,
  coder: /(python|matlab|编程|代码|脚本|调试|报错|求解器|数值求解|实现|运行|画图|xlsx|bug|coding)/i,
  writer: /(论文|摘要|正文|润色|排版|参考文献|文献综述|latex|撰写|写作|paper)/i,
  modeler: /(建模|模型|假设|公式|变量|约束|目标函数|方法选型|技术路线|数学表达|modeling)/i,
};

function classifyTask(prompt) {
  const text = String(prompt || '');
  if (!text.trim()) return null;
  // 审查意图优先于材料类型：审查论文应选审查手，而不是论文手。
  if (TASK_PATTERNS.reviewer.test(text)) return 'reviewer';
  // 有明确执行/求解动作时，公式或论文只是工作对象，不改变编程职责。
  if (TASK_PATTERNS.coder.test(text)) return 'coder';
  if (TASK_PATTERNS.writer.test(text)) return 'writer';
  if (TASK_PATTERNS.modeler.test(text)) return 'modeler';
  return null;
}

function roleForSubagent(profile, meta, prompt) {
  const m = meta || {};
  return normalizeRole(m.crew) || normalizeRole(m.role) || normalizeRole(m.task)
    || (profile === 'reviewer' || profile === 'redteam' ? 'reviewer' : classifyTask(prompt));
}

function resolveRoleModel({ role, settings = {}, sessionModel = '', sessionExplicit = false, appDir, requireKey = true, excludeModels = [] }) {
  const normalizedRole = normalizeRole(role);
  const roleModels = normalizeRoleModels(settings.role_models);
  const candidates = [];
  const add = (model, source) => {
    const m = String(model || '').trim();
    if (m && !candidates.some(c => c.model === m)) candidates.push({ model: m, source });
  };
  if (sessionExplicit) {
    // 用户在顶部明确选择的模型不能被自动回退换掉；错误必须显式暴露。
    add(sessionModel, 'session_explicit');
  } else {
    if (normalizedRole) add(roleModels[normalizedRole], 'role:' + normalizedRole);
    if (normalizedRole === 'reviewer' && !roleModels.reviewer) add(settings.heavy_model, 'heavy_model');
    add(sessionModel, 'session');
    add(settings.default_model, 'default_model');
  }
  const warnings = [];
  const excluded = new Set((Array.isArray(excludeModels) ? excludeModels : [excludeModels]).map(String));
  const disabled = new Set(Array.isArray(settings.disabled_models) ? settings.disabled_models : []);
  for (const c of candidates) {
    if (excluded.has(c.model)) continue;
    const providerKey = providerForModel(c.model, settings);
    if (!providerKey) { warnings.push(`${c.source} 模型 ${c.model} 无法识别提供商，已跳过`); continue; }
    const provider = resolveProvider(providerKey, settings);
    if (!provider) { warnings.push(`${c.source} 模型 ${c.model} 的提供商 ${providerKey} 不存在，已跳过`); continue; }
    const modelName = String(c.model).startsWith(providerKey + ':')
      ? String(c.model).slice(providerKey.length + 1) : String(c.model);
    if (disabled.has(providerKey + ':' + modelName)) {
      const msg = `${c.source} 模型 ${c.model} 已被禁用`;
      warnings.push(msg);
      // An explicit session choice must fail loudly instead of silently
      // changing the user's selected model behind their back.
      if (c.source === 'session_explicit') {
        return { ok: false, role: normalizedRole, model: null, providerKey: null, provider: null, warnings, error: msg };
      }
      continue;
    }
    if (requireKey && !keyFor(providerKey, appDir)) {
      warnings.push(`${c.source} 模型 ${c.model} 缺少 ${provider.name} API Key，已跳过`);
      continue;
    }
    return {
      ok: true, role: normalizedRole, roleLabel: normalizedRole ? ROLE_LABELS[normalizedRole] : null,
      model: c.model, source: c.source, providerKey, provider, warnings,
      fallback: c.source !== 'session_explicit' && ((normalizedRole && c.source !== 'role:' + normalizedRole) || warnings.length > 0),
    };
  }
  return { ok: false, role: normalizedRole, model: null, providerKey: null, provider: null, warnings };
}

module.exports = { ROLE_IDS, ROLE_LABELS, normalizeRoleModels, normalizeRole, classifyTask, roleForSubagent, resolveRoleModel };
