'use strict';

// A small, bounded judgment layer for finite-choice decisions.  It is kept
// separate from the main model so a provider outage can never block the
// modeling workflow: callers receive { ok:false } and keep the original
// recommendation.

const { keyFor, resolveProvider, providerForModel } = require('./providers');

const DEFAULTS = Object.freeze({
  enabled: false,
  // Automatic use policy. on_demand keeps Jev out of the automatic path;
  // smart uses bounded deterministic triggers; always is an explicit costier
  // mode for experiments and is never required by the main workflow.
  trigger: 'on_demand',
  provider: 'tokenrhythm',
  model: 'neohorse-1-9b',
  timeout_ms: 12000,
  // A 100-char Chinese reason plus JSON structure needs ~274 tokens; 256 truncates mid-JSON.
  max_tokens: 512,
  // Do not treat the model's raw probability as calibrated by default. The
  // first safe policy is agreement checking at a conservative threshold.
  min_confidence: 0.82,
  auto_override: false,
  allow_override: false,
  // Position-bias guard: judge twice with reversed candidate order and accept
  // only if both agree. Doubles judge calls, so it stays opt-in.
  swap_check: false,
});

function clean(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function settingsOf(settings) {
  const raw = settings && settings.decision_judge;
  return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

function modelName(config) {
  const model = clean(config.model, 200);
  const provider = clean(config.provider, 80);
  return provider && model.startsWith(provider + ':') ? model.slice(provider.length + 1) : model;
}

function extractJson(text) {
  const source = clean(text, 10000).replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  try { return JSON.parse(source); } catch {}
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(source.slice(start, end + 1)); } catch {}
  }
  return null;
}

function candidatePayload(args) {
  if (!args || !Array.isArray(args.candidates) || args.candidates.length !== 3) return null;
  return args.candidates.map(c => ({
    id: clean(c && c.id, 64),
    label: clean(c && c.label, 240),
    basis: clean(c && c.basis, 800),
    tradeoff: clean(c && c.tradeoff, 500),
    risk: clean(c && c.risk, 500),
  }));
}

const HIGH_RISK_RE = /(核心假设|关键假设|最终结论|论文主线|最终模型|创新点|正式求解|数学正确|证据|提交|获奖|主模型|主路线|建模方案|模型选择|算法选择|数学模型)/i;
const USEFUL_SCREEN_RE = /(路由|分流|分类|筛选|比较|报错|错误类型|格式|工具|供应商|接口|成本|费用|是否使用|基线|候选|简单选择|重复)/i;

// Decide whether the automatic path should spend a judgment call. This is a
// policy gate, not a quality claim: explicit decision_judge tool calls still
// remain available whenever the master switch is enabled.
function shouldAutoJudge(args, settings) {
  const config = settingsOf(settings);
  if (!config.enabled) return { use: false, reason: 'disabled' };
  const trigger = ['on_demand', 'smart', 'always'].includes(config.trigger) ? config.trigger : 'on_demand';
  if (trigger === 'on_demand') return { use: false, reason: 'on_demand' };
  if (trigger === 'always') return { use: true, reason: 'always' };
  const text = [args && args.question, args && args.recommendation_reason,
    ...((args && args.candidates) || []).flatMap(c => [c && c.label, c && c.basis, c && c.tradeoff, c && c.risk])]
    .map(x => clean(x, 800)).join(' ');
  if (!candidatePayload(args)) return { use: false, reason: 'requires_three_candidates' };
  if (HIGH_RISK_RE.test(text)) return { use: false, reason: 'high_risk_requires_main_or_human' };
  if (!USEFUL_SCREEN_RE.test(text)) return { use: false, reason: 'no_low_risk_screen_signal' };
  return { use: true, reason: 'smart_low_risk_screen' };
}

function buildPrompt(args, candidates) {
  const rows = candidates.map(c =>
    `${c.id} | ${c.label} | 依据:${c.basis} | 权衡:${c.tradeoff || '—'} | 风险:${c.risk || '—'}`).join('\n');
  return [
    '你是数学建模工作流的有限选项判断器。只比较给出的三个方案，不补造题目事实，不重写方案。',
    `决策问题：${clean(args.question, 1600)}`,
    `主模型当前推荐：${clean(args.recommended_id, 64)}`,
    `主模型推荐理由：${clean(args.recommendation_reason, 1600)}`,
    '候选方案：', rows,
    '只返回一个 JSON 对象，不要 Markdown，不要解释 JSON 以外的内容：',
    '{"choice_id":"候选id","confidence":0到1之间的数字,"reason":"不超过100字的比较理由"}',
  ].join('\n');
}

function failure(config, error, extra = {}) {
  return { enabled: !!config.enabled, ok: false, skipped: false, model: modelName(config), error: clean(error, 300), ...extra };
}

function mergeUsage(a, b) {
  if (!a || !b) return a || b || null;
  const cached = u => Number(u.prompt_cache_hit_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0);
  return {
    prompt_tokens: Number(a.prompt_tokens || 0) + Number(b.prompt_tokens || 0),
    completion_tokens: Number(a.completion_tokens || 0) + Number(b.completion_tokens || 0),
    prompt_tokens_details: { cached_tokens: cached(a) + cached(b) },
  };
}

async function judgeDecision({ args, settings, appDir, signal, fetchImpl } = {}) {
  const config = settingsOf(settings);
  const candidates = candidatePayload(args);
  if (!config.enabled) return { enabled: false, ok: false, skipped: true, reason: 'disabled' };
  if (!candidates) return { enabled: true, ok: false, skipped: true, reason: 'requires_three_candidates' };
  const providerKey = clean(config.provider, 80);
  const provider = resolveProvider(providerKey, settings || {});
  if (!provider || provider.kind !== 'openai') return failure(config, '判断模型必须使用 Chat Completions 协议');
  const key = keyFor(providerKey, appDir);
  if (!key) return failure(config, `缺少 ${provider.name} API Key`);
  const model = modelName(config);
  if (!model || providerForModel(`${providerKey}:${model}`, settings || {}) !== providerKey) {
    return failure(config, '判断模型未注册到该供应商');
  }
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') return failure(config, '当前运行时没有 fetch');
  const timeout = Math.min(Math.max(Number(config.timeout_ms) || DEFAULTS.timeout_ms, 1000), 60000);

  async function callOnce(list) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await fetcher(provider.base.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '只做有限选项判断。输出必须是 JSON。' },
            { role: 'user', content: buildPrompt(args, list) },
          ],
          temperature: 0,
          max_tokens: Math.min(Math.max(Number(config.max_tokens) || DEFAULTS.max_tokens, 64), 1024),
          stream: false,
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return failure(config, `HTTP ${response.status}`, { status: response.status });
      const message = body && body.choices && body.choices[0] && body.choices[0].message;
      const parsed = extractJson(message && message.content);
      const choiceId = clean(parsed && (parsed.choice_id || parsed.choice), 64);
      const confidence = Number(parsed && (parsed.confidence ?? parsed.score));
      const valid = list.some(c => c.id === choiceId);
      if (!valid || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        return failure(config, '返回内容不是合法的候选判断', { raw: clean(message && message.content, 500) });
      }
      return {
        enabled: true,
        ok: true,
        skipped: false,
        model,
        choice_id: choiceId,
        confidence,
        reason: clean(parsed.reason || parsed.rationale, 400),
        usage: body && body.usage ? body.usage : null,
        trace_id: clean(body && body.trace_id, 120) || null,
      };
    } catch (error) {
      return failure(config, error && error.name === 'AbortError' ? '请求超时' : (error && error.message) || error);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  const first = await callOnce(candidates);
  if (!config.swap_check || !first.ok) return first;
  const second = await callOnce([...candidates].reverse());
  if (!second.ok) return failure(config, `交换顺序复判失败：${second.error}`, { swap_checked: true });
  if (first.choice_id !== second.choice_id) {
    return failure(config, '交换顺序两次判断不一致（疑似位置偏差）', {
      swap_checked: true, swap_consistent: false, choices: [first.choice_id, second.choice_id],
    });
  }
  // Both orders agree: keep the smaller confidence so the acceptance threshold
  // stays conservative, and merge usage so spend accounting covers both calls.
  return {
    ...first,
    confidence: Math.min(first.confidence, second.confidence),
    usage: mergeUsage(first.usage, second.usage),
    swap_checked: true,
    swap_consistent: true,
  };
}

function shouldOverride(result, settings) {
  const config = settingsOf(settings);
  return !!(result && result.ok && config.auto_override === true && config.allow_override === true
    && Number(result.confidence) >= (Number(config.min_confidence) || DEFAULTS.min_confidence));
}

function disposition(result, args, settings) {
  const config = settingsOf(settings);
  const threshold = Number(config.min_confidence) || DEFAULTS.min_confidence;
  if (!result || !result.ok) {
    return { status: 'escalate', reason: result && result.swap_consistent === false ? '交换顺序双评不一致（疑似位置偏差）' : '判断模型不可用或返回无效结果' };
  }
  const agrees = result.choice_id === clean(args && args.recommended_id, 64);
  if (agrees && Number(result.confidence) >= threshold) {
    return { status: 'accepted', agreement: true, threshold };
  }
  if (!agrees) return { status: 'escalate', agreement: false, threshold, reason: '判断层与主模型推荐不一致' };
  return { status: 'escalate', agreement: true, threshold, reason: '判断层置信度低于校准门槛' };
}

module.exports = { DEFAULTS, settingsOf, extractJson, candidatePayload, buildPrompt, shouldAutoJudge, judgeDecision, shouldOverride, disposition };
