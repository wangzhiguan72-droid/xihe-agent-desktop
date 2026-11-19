'use strict';
const { usesResponses } = require('./responses-routing');
const LEVELS = ['provider_default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off'];
const REASONING_POLICY_VERSION = '2026-10-20.8';
const ALL = ['provider_default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const budget = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };
function reasoningProbeTimeout(plan) {
  // Reasoning relays may acknowledge HTTP before producing their first token.
  // A probe timeout says nothing about whether the requested effort is valid.
  return ['xhigh','max'].includes(plan.requested) ? 180000 : 120000;
}
function nativeReasoningCapabilities(pk, provider, model) {
  const kind = provider && provider.kind;
  const m = String(model || '').toLowerCase();
  const cap = (mode, levels, note = '') => ({ mode, levels: ['provider_default', ...levels], note });
  if (provider?.custom && kind === 'anthropic' && /^claude-/.test(m)) {
    const known = nativeReasoningCapabilities('anthropic',{kind},model);
    return {...known,note:(known.note ? known.note+'；' : '')+'使用Anthropic Messages参数；中转实际执行强度需单独确认'};
  }
  if (kind === 'responses') {
    if (/^gpt-/.test(m)) {
      const known = nativeReasoningCapabilities('openai',{kind:'openai'},model);
      return {...known,note:'Responses接口发送reasoning.effort；模型/中转是否支持该档位以接口结果为准'};
    }
    return cap('unknown', [], 'Responses协议已接入；此非GPT型号的强度映射未确认，暂不把Messages/Chat字段套入Responses');
  }
  if (provider?.custom && kind === 'openai' && /^gpt-6(?:\.1)?-(?:astra|sol|luna)(?:-|$)/.test(m)) {
    const known = nativeReasoningCapabilities('openai', {kind}, model);
    return {...known, note:'按该型号公开档位发送reasoning_effort；自定义中转是否执行需由中转确认'};
  }
  if (pk === 'deepseek' && kind === 'openai') return {...cap('deepseek', ['none','low','high','max'], '原生低/高/最大三档；可关闭思考。旧medium/xhigh按high、minimal按low兼容'),aliases:{minimal:'low',medium:'high',xhigh:'high',off:'none'}};
  if (pk === 'glm') {
    if (kind !== 'openai') return cap('unknown', [], 'GLM模型有低/高/最大档；当前订阅Anthropic接口的强度映射未公开，接受测试字段不能证明生效，暂用默认');
    if (/^glm-5\.3(?:-|$)/.test(m)) return cap('glm-effort', ['low','high','max'], '该型号强制思考');
    if (/^glm-5\.2(?:-|$)/.test(m)) return cap('glm-effort', ['none','high','max'], 'high/max发送原生reasoning_effort；none关闭思考');
    if (/^glm-(?:4\.7|5(?:\.1)?)(?:-|$)/.test(m)) return cap('glm-switch', ['none','high'], '可开关思考；high仅表示开启，非强度档位');
    return cap('unknown', [], '此GLM型号的强度协议未验证');
  }
  if (pk === 'moonshot' && kind === 'openai') {
    if (/^kimi-k3(?:-|$)/.test(m)) return cap('kimi-effort', ['low','high','max'], 'K3强制思考，只接受low/high/max');
    if (/^kimi-k2\.6(?:-|$)/.test(m)) return cap('kimi-switch', ['none','high'], 'high仅表示开启思考，非强度档位');
    return cap('unknown', [], '此Kimi型号的强度协议未验证');
  }
  if (pk === 'qwen' && kind === 'openai') {
    if (/^qwen3\.8-(?:max|flash|27b)(?:-|$)/.test(m)) return cap('qwen-budget', ['none','minimal','low','medium','high'], '档位映射为应用侧thinking_budget，非原生强度');
    return cap('unknown', [], '此Qwen型号的思考参数未验证');
  }
  if (pk === 'openai' && kind === 'openai') {
    if (/^gpt-5\.2-pro(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return cap('openai-effort', ['medium','high','xhigh'], '官方端点使用Responses；中转需自行确认支持相同档位');
    if (/^gpt-5-pro(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return cap('openai-effort', ['high'], '官方端点使用Responses，仅支持high；中转需确认协议');
    if (/^gpt-6(?:\.1)?-(?:astra|sol|luna)(?:-|$)/.test(m)) return cap('openai-effort', /^gpt-6\.1-sol|^gpt-6-astra/.test(m) ? ['low','medium','high','xhigh','max'] : ['none','low','medium','high','xhigh','max'], '官方OpenAI端点自动使用Responses；中转使用其Chat兼容协议，实际执行强度需由中转确认');
    if (/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return cap('openai-effort', ['none','low','medium','high','xhigh']);
    if (/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return cap('openai-effort', ['none','low','medium','high']);
    if (/^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(m)) return cap('openai-effort', ['minimal','low','medium','high']);
    return cap('unknown', [], '此OpenAI型号的档位未验证');
  }
  if (pk === 'xai' && kind === 'openai') {
    if (/^grok-4\.[67](?:-|$)/.test(m)) return cap('grok-effort', ['low','medium','high', ...(m.startsWith('grok-4.7') || m.startsWith('grok-4.6') ? ['xhigh'] : [])]);
    if (/^grok-4\.5(?:-|$)/.test(m)) return cap('grok-effort', ['low','medium','high']);
    if (/^grok-4\.3(?:-|$)/.test(m)) return cap('grok-effort', ['none','low','medium','high']);
    return cap('unknown', [], '此Grok型号的强度协议未验证');
  }
  if (pk === 'anthropic' && kind === 'anthropic') {
    if (/^claude-(?:fable-5-1|opus-5-5|sonnet-5-5)(?:-|$)/.test(m)) return cap('claude-adaptive', ['low','medium','high','xhigh','max'], '该型号强制自适应思考');
    if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(m)) return cap('claude-adaptive', ['none','low','medium','high','max']);
    if (/^claude-(?:sonnet|haiku)-4-5|^claude-opus-4-1/.test(m)) return cap('claude-manual', ['none','minimal','low','medium','high'], '档位映射为应用侧思考预算，非原生强度');
    return cap('unknown', [], '此Claude型号的推理协议未验证');
  }
  if (pk === 'anthropic' && kind === 'openai') return cap('unknown', [], 'Claude OpenAI中转协议的强度映射未验证');
  if (kind === 'openai') return cap('relay-pass-through', ALL.slice(1), '自定义OpenAI中转：原样发送reasoning_effort，实际支持取决于中转');
  return cap('unknown', [], '此协议的推理参数未验证');
}
function reasoningCapabilities(pk, provider, model, settings = {}) {
  const capability = nativeReasoningCapabilities(pk, provider, model);
  const limit = settings.model_reasoning_limits?.[`${pk}:${model}`];
  if (!limit || limit.kind !== provider?.kind || String(limit.base).replace(/\/+$/, '') !== String(provider?.base || '').replace(/\/+$/, '')) return capability;
  const allowed = new Set(['provider_default', ...(Array.isArray(limit.levels) ? limit.levels : [])]);
  const mode = capability.mode === 'qwen-budget' && limit.mode === 'qwen-switch' ? 'qwen-switch' : capability.mode;
  const baseLevels = mode === 'qwen-switch' ? ['provider_default','none','high'] : capability.levels;
  return {...capability, mode, levels:baseLevels.filter(level=>allowed.has(level)), limited:true,
    note:limit.note || '此接口仅保留当前适用档位；连通测试不等于强度效果已证实'};
}
function normalizeReasoningLimits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200) throw new Error('model_reasoning_limits 必须为最多200项的对象');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || key.length > 160 || !item || typeof item !== 'object' || !['openai','anthropic','responses'].includes(item.kind)) throw new Error('推理限制模型或接口格式无效');
    let url;
    try { url = new URL(item.base); } catch { throw new Error('推理限制的接口地址无效'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('推理限制的接口地址无效');
    if (!Array.isArray(item.levels) || item.levels.some(level=>!ALL.includes(level))) throw new Error('推理限制档位无效');
    if (item.mode != null && (item.mode !== 'qwen-switch' || !key.startsWith('qwen:'))) throw new Error('推理限制适配模式无效');
    result[key] = {base:String(item.base).trim().replace(/\/+$/, ''),kind:item.kind,
      levels:[...new Set(['provider_default',...item.levels])],note:String(item.note || '').slice(0,500),...(item.mode ? {mode:item.mode} : {})};
  }
  return result;
}
function normalizeModelReasoning(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model_reasoning 必须为对象');
  const entries = Object.entries(value);
  if (entries.length > 200) throw new Error('推理配置最多200个模型');
  for (const [key, level] of entries) {
    if (!key.trim() || key.length > 160 || !LEVELS.includes(level)) throw new Error(`模型 ${key} 的推理档位无效`);
  }
  return Object.fromEntries(entries);
}
function resolveReasoning(settings, pk, provider, model) {
  const configured = settings.model_reasoning || {};
  const key = `${pk}:${model}`;
  const explicit = Object.hasOwn(configured, key) || Object.hasOwn(configured, model);
  let requested = explicit ? (Object.hasOwn(configured, key) ? configured[key] : configured[model]) : 'provider_default';
  let options = {}, error = null;
  if (!explicit && pk === 'deepseek') {
    if (settings.reasoning_effort === 'off') { requested = 'off'; options.thinking = 'off'; }
    else if (settings.efforts && settings.efforts[model]) requested = settings.efforts[model];
  }
  const capability = reasoningCapabilities(pk, provider, model, settings);
  const level = capability.aliases?.[requested] || (requested === 'off' ? 'none' : requested);
  if (!LEVELS.includes(requested)) error = `推理档位 ${requested} 无效`;
  else if (!capability.levels.includes(level)) error = `模型 ${model} 不支持 ${requested}：${capability.note || '请选提供商默认'}`;
  if (!error && level !== 'provider_default') {
    const mode = capability.mode;
    if (mode === 'relay-pass-through') options.reasoningEffort = level;
    else {
      let reasoningBody = {};
      if (mode === 'deepseek') reasoningBody = level === 'none' ? { thinking: {type:'disabled'} } : { thinking: {type:'enabled'}, reasoning_effort: ({minimal:'low',medium:'high',xhigh:'high'}[level] || level) };
      else if (mode === 'glm-effort') reasoningBody = level === 'none' ? {thinking:{type:'disabled'}} : { thinking: {type:'enabled'}, reasoning_effort: level };
      else if (mode === 'glm-switch' || mode === 'kimi-switch') reasoningBody = { thinking: {type: level === 'none' ? 'disabled' : 'enabled'} };
      else if (mode === 'kimi-effort' || mode === 'openai-effort' || mode === 'grok-effort') reasoningBody = { reasoning_effort: level };
      else if (mode === 'qwen-budget') reasoningBody = level === 'none' ? {enable_thinking:false} : {enable_thinking:true, thinking_budget:budget[level]};
      else if (mode === 'qwen-switch') reasoningBody = {enable_thinking:level !== 'none'};
      else if (mode === 'claude-adaptive') reasoningBody = level === 'none' ? {thinking:{type:'disabled'}} : {thinking:{type:'adaptive'},output_config:{effort:level}};
      else if (mode === 'claude-manual') reasoningBody = level === 'none' ? {thinking:{type:'disabled'}} : {thinking:{type:'enabled',budget_tokens:budget[level]}};
      options.reasoningBody = reasoningBody;
    }
  }
  return { provider: pk, model, requested, options, error, capability, fallback: settings.reasoning_fallback === 'provider_default' ? 'provider_default' : 'error' };
}
function combineUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...b };
  for (const key of ['prompt_tokens', 'completion_tokens', 'cache_hit_tokens', 'reasoning_tokens']) out[key] = (a[key] || 0) + (b[key] || 0);
  return out;
}
async function callWithReasoning(send, args, plan, record = () => {}) {
  let options = { ...plan.options }, priorUsage = null;
  const rejectLocally = message => {
    record({ provider: plan.provider, model: plan.model, requested: plan.requested, sent: null,
      status: 'unsupported', note: message, at: Date.now() });
    const e = new Error(message); e.status = 400; e.reasoningRejected = true; throw e;
  };
  if (plan.error) rejectLocally(plan.error);
  if (options.reasoningBody && args.maxTokens) {
    options.reasoningBody = structuredClone(options.reasoningBody);
    const thinking = options.reasoningBody.thinking;
    if (thinking?.budget_tokens && thinking.budget_tokens >= args.maxTokens) {
      if (args.maxTokens < 2048) rejectLocally('思考预算需要单次输出上限至少2048 Token，请调高输出上限或关闭思考');
      thinking.budget_tokens = Math.max(1024, args.maxTokens - 1024);
    }
    if (options.reasoningBody.thinking_budget >= args.maxTokens) options.reasoningBody.thinking_budget = Math.max(1, args.maxTokens - Math.min(1024, Math.floor(args.maxTokens / 2)));
  }
  const isResponses = usesResponses(args);
  const sentValue = () => {
    const effort = options.reasoningBody?.reasoning_effort || options.reasoningEffort;
    if (isResponses && effort) return JSON.stringify({reasoning:{effort}});
    return options.reasoningBody ? JSON.stringify(options.reasoningBody) : (options.reasoningEffort || (options.thinking === 'off' ? 'off' : null));
  };
  const publish = (status, note) => record({ provider: plan.provider, model: plan.model, requested: plan.requested,
    effective: sentValue() ? plan.requested : 'provider_default', sent: sentValue(), status, note, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (args.signal && args.signal.aborted) { const e = new Error('用户停止 (aborted)'); e.usage = priorUsage; throw e; }
    publish(sentValue() ? 'requested' : 'provider_default', `实际请求参数：${sentValue() || '提供商默认'}；接口接受不证明中转实际执行该档位`);
    try {
      const result = await send({ ...args, ...options });
      result.usage = combineUsage(priorUsage, result.usage);
      publish('api_accepted', '接口已接受请求；提供商实际推理强度未获独立确认');
      return result;
    } catch (e) {
      const unsupported = [400, 422].includes(e.status) && !e.incomplete &&
        /reasoning_effort|reasoning[.\s_-]+effort|thinking|output_config|budget_tokens|enable_thinking/i.test(e.message || '') && /unsupported|not support|unknown|unrecognized|invalid|not allowed|not permitted|未知|不支持|无效|不允许/i.test(e.message || '');
      if (attempt === 0 && plan.fallback === 'provider_default' && unsupported && sentValue()) {
        priorUsage = combineUsage(priorUsage, e.usage);
        options = {};
        publish('fallback', '请求参数被拒绝，按明确配置回退提供商默认一次');
        continue;
      }
      e.usage = combineUsage(priorUsage, e.usage);
      if (unsupported) e.reasoningRejected = true;
      publish('failed', unsupported ? '推理参数被拒绝，未静默降档' : '调用失败，未确认推理档位');
      throw e;
    }
  }
}
function reasoningRecorder(session, emit, kind) {
  return record => {
    const row = { ...record, kind };
    session.resolved_reasoning = row;
    session.reasoning_history = session.reasoning_history || [];
    session.reasoning_history.push(row);
    if (session.reasoning_history.length > 200) session.reasoning_history.shift();
    emit({ t: 'reasoning_config', ...row });
    if (['fallback', 'unsupported'].includes(row.status)) emit({ t: 'warn', msg: row.note });
  };
}
module.exports = { LEVELS, REASONING_POLICY_VERSION, normalizeModelReasoning, normalizeReasoningLimits, reasoningCapabilities, resolveReasoning, callWithReasoning, reasoningRecorder, reasoningProbeTimeout };
