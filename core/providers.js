// 提供商适配层：统一 chatStream 接口，双协议（OpenAI 兼容 / Anthropic 原生）
// 提供商：DeepSeek(主力) / GLM(第二) / Kimi月之暗面 / 通义千问 / OpenAI ChatGPT / xAI Grok / Anthropic Claude
// 模型→提供商解析支持「前缀匹配」与「provider:model 显式指定」两种方式，
// 新模型可在 settings.provider_models 里追加而不用改代码。
'use strict';
const { usesResponses, endpointURL } = require('./responses-routing');
const PROTOCOL_KINDS = ['openai','anthropic','responses'];

const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek 官方',
    base: 'https://api.deepseek.com',
    kind: 'openai',
    keyFile: 'config/deepseek.key',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    ctxLimit: { 'deepseek-flash': 1048576, 'deepseek-v4-pro': 1048576 },
    defaultMaxTokens: 65536,
    supportsEffort: true,      // reasoning_effort / thinking 参数
    replayReasoning: true,     // 思考内容必须回传（官方协议要求）
  },
  glm: {
    name: '智谱 GLM',
    // coding-plan 订阅端点（anthropic 协议）。paas/v4 需另充平台余额，订阅 key 走不通；
    // chatStreamAnthropic 已完整适配（thinking 签名回放/tool_result/同角色合并），glm-5.3-flash 经视觉桥实测可用
    base: 'https://open.bigmodel.cn/api/anthropic',
    kind: 'anthropic',
    keyFile: 'config/glm.key',
    models: ['glm-5.3-flash', 'glm-5.3', 'glm-5.3-flashx'],
    ctxLimit: { 'glm-5.3-flash': 131072, 'glm-5.3': 131072, 'glm-5.3-flashx': 131072 },
    defaultMaxTokens: 32768,
  },
  moonshot: {
    name: 'Kimi 月之暗面',
    base: 'https://api.moonshot.cn/v1',
    kind: 'openai',
    keyFile: 'config/moonshot.key',
    models: ['kimi-k2-turbo-preview', 'kimi-k2-thinking', 'kimi-latest'],
    ctxLimit: { 'kimi-k2-turbo-preview': 262144, 'kimi-k2-thinking': 262144, 'kimi-latest': 262144 },
    defaultMaxTokens: 32768,
    // 思考模型官方要求 temperature=1.0（否则 400 "invalid temperature: must be 1.0 when thinking is enabled"）
    temperatureLock: 1.0,
  },
  qwen: {
    name: '通义千问（阿里）',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    kind: 'openai',
    keyFile: 'config/qwen.key',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-max'],
    ctxLimit: { 'qwen-max': 131072, 'qwen-plus': 131072, 'qwen-turbo': 131072, 'qwen3-max': 262144 },
    defaultMaxTokens: 32768,
  },
  openai: {
    name: 'OpenAI ChatGPT',
    base: 'https://api.openai.com/v1',
    kind: 'openai',
    keyFile: 'config/openai.key',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1'],
    ctxLimit: { 'gpt-5': 400000, 'gpt-5-mini': 400000, 'gpt-5-nano': 400000, 'gpt-4.1': 1048576 },
    defaultMaxTokens: 32768,
  },
  xai: {
    name: 'xAI Grok',
    base: 'https://api.x.ai/v1',
    kind: 'openai',
    keyFile: 'config/xai.key',
    models: ['grok-4', 'grok-4-fast'],
    ctxLimit: { 'grok-4': 262144, 'grok-4-fast': 262144 },
    defaultMaxTokens: 32768,
  },
  anthropic: {
    name: 'Anthropic Claude',
    base: 'https://api.anthropic.com',
    kind: 'anthropic',
    keyFile: 'config/anthropic.key',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    ctxLimit: { 'claude-sonnet-4-5': 200000, 'claude-opus-4-1': 200000, 'claude-haiku-4-5': 200000 },
    defaultMaxTokens: 32768,
  },
};

// ---------- 自定义供应商（v2.5）----------
// 需求：内置 7 家不一定够（新中转站、自建网关、公司内网端点都会冒出来），要能**无限添加**。
// 定义存在 settings.custom_providers 数组里，每条：
//   { id, name, base, kind: 'openai'|'anthropic', models: [], ctx_limit?, max_tokens? }
// - id 必须是安全标识（字母开头、只含小写字母数字_-），不能与内置 pk 撞名
// - Key 走固定约定文件 config/custom_<id>.key —— 这样 keyFor(pk, appDir) 不需要额外参数就能找到它
//   （keyFor 的调用点很多，改签名容易漏）
// 自定义条目本身自带 base/kind/models，所以不走 provider_bases/provider_kinds 覆盖也能用；
// 但两者都写时以 provider_bases/provider_kinds 为准（与内置行为一致，便于临时切中转）。
const CUSTOM_ID_RE = /^[a-z][a-z0-9_-]{1,23}$/;
function customProviders(settings) {
  const out = {};
  const list = (settings && settings.custom_providers) || [];
  if (!Array.isArray(list)) return out;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = String(c.id || '').trim().toLowerCase();
    if (!CUSTOM_ID_RE.test(id) || PROVIDERS[id]) continue; // 非法 id 或与内置撞名：忽略而不是炸掉启动
    const models = (Array.isArray(c.models) ? c.models : []).map(x => String(x).trim()).filter(Boolean).slice(0, 40);
    out[id] = {
      name: String(c.name || id).slice(0, 40),
      base: String(c.base || '').trim().replace(/\/+$/, ''),
      kind: PROTOCOL_KINDS.includes(c.kind) ? c.kind : 'openai',
      models,
      keyFile: 'config/custom_' + id + '.key',
      custom: true,
      ctxLimit: Object.fromEntries(models.map(m => [m, Number(c.ctx_limit) > 0 ? Number(c.ctx_limit) : 131072])),
      defaultMaxTokens: Number(c.max_tokens) > 0 ? Number(c.max_tokens) : 32768,
    };
  }
  return out;
}
// 内置 + 自定义合并后的注册表（所有"按 pk 查提供商"的地方都应该用这个）
function allProviders(settings) {
  return { ...PROVIDERS, ...customProviders(settings) };
}

// 前缀启发（settings.provider_models 未命中、注册表未命中时的兜底）
const MODEL_PREFIXES = [
  ['deepseek-', 'deepseek'], ['glm-', 'glm'], ['kimi-', 'moonshot'],
  ['qwen', 'qwen'], ['gpt-', 'openai'], ['o1', 'openai'], ['o3', 'openai'],
  ['grok-', 'xai'], ['claude-', 'anthropic'],
];

// 模型名 → 提供商 key。支持 "provider:model"（如 "glm:glm-4.7"）显式指定。
function providerForModel(model, settings) {
  const m = String(model || '');
  if (!m) return 'deepseek';
  const all = allProviders(settings);
  const colon = m.indexOf(':');
  if (colon > 0 && all[m.slice(0, colon)]) {
    const pk = m.slice(0, colon);
    const suffix = m.slice(colon + 1);
    const overrides = (settings && settings.provider_models) || {};
    if (Object.prototype.hasOwnProperty.call(overrides, pk)
      && (!Array.isArray(overrides[pk]) || !overrides[pk].includes(suffix))) return null;
    // Custom providers have an explicit model registry. A removed custom
    // model must not be revived by the qualified-name syntax.
    if (all[pk].custom && !Object.prototype.hasOwnProperty.call(overrides, pk) && !all[pk].models.includes(suffix)) return null;
    return pk;
  }
  const overrides = (settings && settings.provider_models) || {};
  for (const [pk, models] of Object.entries(overrides)) {
    if (Array.isArray(models) && models.includes(m)) return pk;
  }
  for (const [pk, p] of Object.entries(all)) {
    if (Object.prototype.hasOwnProperty.call(overrides, pk)) continue;
    if (p.models.includes(m)) return pk;
  }
  // A deleted custom model may still look like another provider's model by
  // prefix (for example a removed relay:gpt-test). Honor its tombstone when
  // no registered provider still owns the bare model name.
  const registered = Object.entries(all).some(([pk, p]) => {
    const list = Object.prototype.hasOwnProperty.call(overrides, pk) ? overrides[pk] : p.models;
    return Array.isArray(list) && list.includes(m);
  });
  const disabled = Array.isArray(settings && settings.disabled_models) ? settings.disabled_models : [];
  if (!registered && disabled.some(x => typeof x === 'string' && x.endsWith(':' + m))) return null;
  for (const [prefix, pk] of MODEL_PREFIXES) {
    if (Object.prototype.hasOwnProperty.call(overrides, pk)) continue;
    if (m.toLowerCase().startsWith(prefix)) return pk;
  }
  return null; // 未知模型：调用方决定报错或按 deepseek 默认端点尝试
}

function providerModels(settings) {
  const overrides = (settings && settings.provider_models) || {};
  const disabled = new Set(Array.isArray(settings && settings.disabled_models) ? settings.disabled_models : []);
  const out = [];
  for (const [pk, p] of Object.entries(allProviders(settings))) {
    // Presence of an override is authoritative, including [] (which means no
    // enabled/registered models for this provider). This lets the UI disable a
    // provider's built-ins without silently repopulating them.
    const models = Object.prototype.hasOwnProperty.call(overrides, pk)
      ? (Array.isArray(overrides[pk]) ? overrides[pk] : [])
      : p.models;
    const kind = (resolveProvider(pk, settings) || p).kind;
    for (const m of models) {
      const qualified = pk + ':' + m;
      if (disabled.has(qualified)) continue;
      out.push({ id: m, provider: pk, providerName: p.name, kind });
    }
  }
  return out;
}

function keyFor(provider, appDir) {
  const path = require('path');
  const fs = require('fs');
  // 自定义供应商没有注册表条目，Key 按约定路径 config/custom_<pk>.key 找
  const p = PROVIDERS[provider] || { keyFile: CUSTOM_ID_RE.test(String(provider)) ? 'config/custom_' + provider + '.key' : '' };
  if (!p || !p.keyFile) return '';
  for (const cand of [path.join(appDir, p.keyFile), path.join(appDir, '..', p.keyFile)]) {
    try { const k = fs.readFileSync(cand, 'utf8').trim(); if (k) return k; } catch {}
  }
  return '';
}

// 生效提供商配置：settings.provider_bases 可按提供商覆盖 base（中转站接入用）。
// 例：{"moonshot": "https://aiaaa.cc/v1"} → Kimi 系模型走中转站，key 仍用 config/moonshot.key
// settings.provider_kinds 可按提供商覆盖协议（'openai' | 'anthropic'）——中转站常把各家模型统一成 OpenAI 格式。
function resolveProvider(pk, settings) {
  const p = allProviders(settings)[pk];
  if (!p) return null;
  let base = (settings && settings.provider_bases && settings.provider_bases[pk]) || '';
  if (!base && pk === 'glm' && settings && settings.glm_base) base = settings.glm_base; // 旧版设置兼容
  base = String(base || p.base).trim().replace(/\/+$/, '');
  const k = settings && settings.provider_kinds && settings.provider_kinds[pk];
  const kind = PROTOCOL_KINDS.includes(k) ? k : p.kind;
  return base === p.base && kind === p.kind ? p : { ...p, base, kind };
}

// ---------- OpenAI 兼容协议（DeepSeek/GLM/Kimi/Qwen/GPT/Grok） ----------
// 返回 {content, reasoning, tool_calls, finish, usage, raw}
// thinking: 'off' 时显式发送 disabled（DeepSeek 官方默认开启思考，仅省略 effort 不会关）
// Apply only adapter-approved reasoning keys. This helper also serves native
// Anthropic callers outside chatStream (for example vision requests).
function applyReasoningBody(body, reasoningBody) {
  if (!reasoningBody) return body;
  const allowed = ['reasoning_effort','thinking','enable_thinking','thinking_budget','output_config'];
  for (const [key, value] of Object.entries(reasoningBody)) {
    if (!allowed.includes(key)) throw new Error(`未经适配的推理参数：${key}`);
    if (key === 'reasoning_effort' && !['none','minimal','low','medium','high','xhigh','max'].includes(value)) throw new Error('推理强度无效');
    if (key === 'thinking' && (!value || !['enabled','disabled','adaptive'].includes(value.type) || Object.keys(value).some(x => !['type','budget_tokens'].includes(x)))) throw new Error('thinking参数无效');
    if (key === 'enable_thinking' && typeof value !== 'boolean') throw new Error('enable_thinking参数无效');
    if (key === 'thinking_budget' && (!Number.isInteger(value) || value < 1 || value > 32768)) throw new Error('thinking_budget参数无效');
    if (key === 'output_config' && (!value || Object.keys(value).length !== 1 || !['low','medium','high','xhigh','max'].includes(value.effort))) throw new Error('output_config参数无效');
    body[key] = value;
  }
  if (body.thinking && body.thinking.type === 'enabled' && body.thinking.budget_tokens != null) {
    if (!Number.isInteger(body.thinking.budget_tokens) || body.thinking.budget_tokens < 1024 || body.thinking.budget_tokens >= body.max_tokens) throw new Error('Claude 思考预算必须至少1024且小于max_tokens');
  }
  if (body.thinking || body.enable_thinking != null || body.output_config || (body.reasoning_effort && body.reasoning_effort !== 'none')) delete body.temperature;
  return body;
}

async function chatStreamOpenAI({ base, key, model, messages, tools, temperature, reasoningEffort, thinking, reasoningBody, signal, maxTokens, onDelta, onReason, transportTrace }) {
  // Responses replay items are protocol-internal. Never leak them into a
  // later Chat Completions request when a session changes provider protocol.
  const requestMessages = (messages || []).map(m => {
    const copy = { ...m };
    delete copy.responses_items;
    return copy;
  });
  const body = {
    model,
    messages: requestMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (temperature != null) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (tools && tools.length) body.tools = tools;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (thinking === 'off') body.thinking = { type: 'disabled' };
  applyReasoningBody(body, reasoningBody);
  if (/^kimi-k3(?:-|$)|^deepseek-/i.test(model)) delete body.temperature;
  if (reasoningEffort && reasoningEffort !== 'none') delete body.temperature;
  if (/^gpt-5(?:[.-]|$)/i.test(model)) {
    if (maxTokens) { body.max_completion_tokens = maxTokens; delete body.max_tokens; }
    if (!/^gpt-5\.[12](?:-|$)/i.test(model) || body.reasoning_effort !== 'none') delete body.temperature;
  }

  const url = endpointURL(base, 'openai');
  const serializedBody = JSON.stringify(body);
  transportTrace?.request('openai', url, body, serializedBody);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
      Accept: 'text/event-stream',
    },
    body: serializedBody,
    signal,
  });
  transportTrace?.response(res);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${t.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }

  const decoder = new TextDecoder();
  let buf = '';
  const out = { content: '', reasoning: '', tool_calls: [], finish: null, usage: null };
  let sawDone = false;
  const handle = (obj) => {
    transportTrace?.observe(obj.usage, obj.model);
    if (obj.usage) out.usage = normalizeUsage(obj.usage, out.usage);
    const choice = obj.choices && obj.choices[0];
    if (!choice) return;
    if (choice.finish_reason) out.finish = choice.finish_reason;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content) { out.content += d.content; if (onDelta) try { onDelta(d.content); } catch {} }
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) { out.reasoning += d.reasoning_content; if (onReason) try { onReason(d.reasoning_content); } catch {} }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index != null ? tc.index : out.tool_calls.length;
        if (!out.tool_calls[i]) out.tool_calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) out.tool_calls[i].id = tc.id;
        if (tc.function && tc.function.name) out.tool_calls[i].function.name += tc.function.name;
        if (tc.function && tc.function.arguments) out.tool_calls[i].function.arguments += tc.function.arguments;
      }
    }
  };

  const parseLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { sawDone = true; return; }
    try { handle(JSON.parse(payload)); } catch {}
  };

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        parseLine(line);
      }
    }
  } catch (err) {
    attachPartialUsage(err, out);
    throw err;
  }
  if (buf.trim()) parseLine(buf);
  out.tool_calls = out.tool_calls.filter(Boolean);
  if (out.finish == null && !sawDone) {
    const err = new Error(`流式响应未完整结束（缺少 finish_reason，已收 content ${out.content.length} 字符）。半截输出不可使用。`);
    err.incomplete = true;
    err.usage = out.usage || null; // 断流前已收到的 usage 必须随错误上抛结算（中断≠免费）
    throw err;
  }
  if (out.finish === 'length') {
    const err = new Error(`输出被 max_tokens 截断（finish=length）。请减少单次输出量或调大 max_output_tokens 后重试。`);
    err.truncated = true;
    err.usage = out.usage || null; // 截断的调用同样产生费用，必须记账
    throw err;
  }
  return out;
}

// ---------- Anthropic 原生协议（Claude；也兼容 DeepSeek 的 /anthropic 端点） ----------
// 返回结构与 OpenAI 版对齐；额外带 anthropic_blocks（原始 content blocks，工具对话回传必需）
async function chatStreamAnthropic({ base, key, model, messages, system, tools, temperature, reasoningBody, maxTokens, signal, onDelta, onReason, transportTrace }) {
  const body = {
    model,
    max_tokens: maxTokens || 32768, // Anthropic 协议必填
    stream: true,
    messages,
  };
  if (system) body.system = system;
  if (temperature != null) body.temperature = temperature;
  if (tools && tools.length) body.tools = tools;
  applyReasoningBody(body, reasoningBody);
  // 新Claude默认也是adaptive；未显式设置档位时同样不能带采样温度。
  if (/^claude-(?:fable-5-1|opus-5-5|sonnet-5-5|opus-4-6|sonnet-4-6)(?:-|$)/i.test(model)) delete body.temperature;
  // Anthropic 提示缓存必须显式打断点：system+工具是稳定前缀，放两个 ephemeral 断点；
  // 稳定历史末尾的第三个断点由 agent.js 的 markAnthropicCache 打。只对 claude 模型启用，
  // 避免不认识 cache_control 的 anthropic 兼容中转站直接 400。
  const cacheable = /^claude/i.test(model);
  if (cacheable) {
    if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (tools && tools.length) {
      body.tools = tools.slice();
      body.tools[body.tools.length - 1] = { ...body.tools[body.tools.length - 1], cache_control: { type: 'ephemeral' } };
    }
  }

  const url = endpointURL(base, 'anthropic');
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  let serializedBody = JSON.stringify(body);
  transportTrace?.request('anthropic', url, body, serializedBody);
  let res = await fetch(url, { method: 'POST', headers, body: serializedBody, signal });
  if (cacheable && res.status === 400) {
    const text = await res.text().catch(() => '');
    if (/cache_control/i.test(text)) {
      body.system = system;
      for (const tool of body.tools || []) delete tool.cache_control;
      serializedBody = JSON.stringify(body);
      transportTrace?.request('anthropic', url, body, serializedBody);
      res = await fetch(url, { method: 'POST', headers, body: serializedBody, signal });
    } else {
      res = new Response(text, { status: 400, statusText: res.statusText, headers: res.headers });
    }
  }
  transportTrace?.response(res);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${t.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }

  const decoder = new TextDecoder();
  let buf = '';
  const out = { content: '', reasoning: '', tool_calls: [], finish: null, usage: null, anthropic_blocks: [] };
  const blocks = []; // {type:'text'|'thinking'|'tool_use', text?, thinking?, signature?, id?, name?, inputJson?}
  const FINISH_MAP = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', refusal: 'stop' };

  const handle = (ev) => {
    switch (ev.type) {
      case 'message_start':
        transportTrace?.observe(ev.message?.usage, ev.message?.model);
        if (ev.message && ev.message.usage) applyUsageA(out, ev.message.usage);
        break;
      case 'content_block_start': {
        const cb = ev.content_block || {};
        if (cb.type === 'tool_use') blocks[ev.index] = { type: 'tool_use', id: cb.id || '', name: cb.name || '', inputJson: '' };
        else if (cb.type === 'thinking') blocks[ev.index] = { type: 'thinking', thinking: '', signature: '' };
        else blocks[ev.index] = { type: 'text', text: '' };
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta' && d.text != null) { b.text += d.text; out.content += d.text; if (onDelta) try { onDelta(d.text); } catch {} }
        else if (d.type === 'thinking_delta' && d.thinking != null) { b.thinking += d.thinking; out.reasoning += d.thinking; if (onReason) try { onReason(d.thinking); } catch {} }
        else if (d.type === 'signature_delta' && d.signature != null) b.signature += d.signature;
        else if (d.type === 'input_json_delta' && d.partial_json != null) b.inputJson += d.partial_json;
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b && b.type === 'tool_use') {
          let input = {};
          try { input = b.inputJson ? JSON.parse(b.inputJson) : {}; } catch { input = { _unparsed: b.inputJson }; }
          b.input = input;
          out.tool_calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(input) } });
        }
        break;
      }
      case 'message_delta':
        transportTrace?.observe(ev.usage);
        if (ev.delta && ev.delta.stop_reason) out.finish = FINISH_MAP[ev.delta.stop_reason] || 'stop';
        if (ev.usage) applyUsageA(out, ev.usage);
        break;
      case 'message_stop':
        out.finish = out.finish || 'stop';
        break;
      case 'error': {
        const msg = (ev.error && ev.error.message) || JSON.stringify(ev).slice(0, 300);
        const err = new Error('Anthropic 流错误: ' + msg);
        if (/overloaded|api_error/i.test(String(ev.error && ev.error.type))) err.status = 529;
        throw err;
      }
    }
  };

  const parseLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(payload); } catch { return; } // JSON 解析失败≠业务错误，跳过坏行
    handle(obj); // 业务异常（error 事件抛出的）必须向上传播，绝不能被吞成“成功停止”
  };

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        parseLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
  } catch (err) {
    attachPartialUsage(err, out);
    throw err;
  }
  if (buf.trim()) parseLine(buf);

  if (out.finish === 'length') {
    const err = new Error(`输出被 max_tokens 截断（stop_reason=max_tokens）。请减少单次输出量或调大 max_output_tokens 后重试。`);
    err.truncated = true;
    err.usage = out.usage || null;
    throw err;
  }
  if (out.finish == null) {
    const err = new Error(`流式响应未完整结束（缺少 stop_reason）。半截输出不可使用。`);
    err.incomplete = true;
    err.usage = out.usage || null;
    throw err;
  }
  // 供回传的原始 blocks：thinking（含签名）+ 文本 + tool_use
  out.anthropic_blocks = blocks.filter(Boolean).map(b => {
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
    return { type: 'text', text: b.text };
  }).filter(b => b.type !== 'text' || b.text);
  return out;
}

// Anthropic 官方计量：input_tokens 不含缓存部分，cache_read/cache_creation 独立字段；
// message_start 提供输入侧 usage，message_delta 只提供（累计的）输出 usage。
// 旧实现把缺失字段折算成 0 再 Object.assign 整体覆盖 → 末尾事件把已记录的输入清零。
// 正确语义：只更新事件确实提供的字段；输入侧字段取已见最大值（防重复事件翻倍），输出取最后值（累计）。
function applyUsageA(out, u) {
  const inp = u.input_tokens, read = u.cache_read_input_tokens, write = u.cache_creation_input_tokens, comp = u.output_tokens;
  const tot = (inp != null ? inp : 0) + (read != null ? read : 0) + (write != null ? write : 0);
  if (tot > 0) { // 全缺失（如末尾只有输出的 delta）时不碰输入侧
    const U = out.usage = out.usage || {};
    U.prompt_tokens = Math.max(U.prompt_tokens || 0, inp + (read || 0) + (write || 0));
    if (read != null) U.cache_hit_tokens = Math.max(U.cache_hit_tokens || 0, read);
    if (write != null) U.cache_write_tokens = Math.max(U.cache_write_tokens || 0, write);
  }
  if (comp != null) {
    const U = out.usage = out.usage || {};
    U.completion_tokens = comp;
  }
}

// ---------- 统一入口 ----------
function responsesInput(messages) {
  const input = [];
  for (const m of messages || []) {
    if (m.role === 'tool') {
      input.push({type:'function_call_output',call_id:m.tool_call_id,output:typeof m.content === 'string' ? m.content : JSON.stringify(m.content)});
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.responses_items) && m.responses_items.length) {
      input.push(...m.responses_items.map(x => structuredClone(x)));
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (m.content) input.push({role:'assistant',content:m.content});
      for (const tc of m.tool_calls) input.push({type:'function_call',call_id:tc.id,name:tc.function.name,arguments:tc.function.arguments});
      continue;
    }
    let content = m.content;
    if (Array.isArray(content)) content = content.map(part => {
      if (part.type === 'text') return {type:'input_text',text:part.text};
      if (part.type === 'image_url') return {type:'input_image',image_url:typeof part.image_url === 'string' ? part.image_url : part.image_url.url};
      return part;
    });
    input.push({role:m.role,content});
  }
  return input;
}
function responsesTools(tools) {
  return (tools || []).map(t => {
    const fn = t.function || t;
    const out = {type:'function',name:fn.name,description:fn.description || '',parameters:fn.parameters || {type:'object',properties:{}}};
    // Chat-compatible tools default to non-strict; preserve that behavior
    // explicitly because Responses defaults may differ by relay.
    out.strict = fn.strict == null ? false : !!fn.strict;
    return out;
  });
}
async function chatStreamResponses({base,key,model,messages,tools,reasoningEffort,reasoningBody,maxTokens,signal,onDelta,onReason,transportTrace}) {
  const body = {model,input:responsesInput(messages),stream:true,store:false,include:['reasoning.encrypted_content']};
  if (tools && tools.length) body.tools = responsesTools(tools);
  if (maxTokens) body.max_output_tokens = maxTokens;
  const unsupported = reasoningBody && Object.keys(reasoningBody).filter(k => k !== 'reasoning_effort');
  if (unsupported && unsupported.length) throw new Error(`Responses协议不支持推理参数：${unsupported.join(', ')}`);
  const effort = (reasoningBody && reasoningBody.reasoning_effort) || reasoningEffort;
  if (effort != null && !['none','minimal','low','medium','high','xhigh','max'].includes(effort)) throw new Error('Responses推理强度无效');
  if (effort) body.reasoning = {effort};
  const url = endpointURL(base, 'responses');
  const serializedBody = JSON.stringify(body);
  transportTrace?.request('responses', url, body, serializedBody);
  const res = await fetch(url, {
    method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key,Accept:'text/event-stream'},body:serializedBody,signal,
  });
  transportTrace?.response(res);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${detail.slice(0,600)}`); err.status = res.status; throw err;
  }
  const out = {content:'',reasoning:'',tool_calls:[],finish:null,usage:null,responses_items:[]};
  let buf = '', final = null, failed = null;
  const decoder = new TextDecoder();
  const handle = ev => {
    if (ev.response) transportTrace?.observe(ev.response.usage, ev.response.model);
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
      out.content += ev.delta; if (onDelta) try {onDelta(ev.delta);} catch {}
    } else if (['response.reasoning_text.delta','response.reasoning_summary_text.delta','response.reasoning_summary.delta'].includes(ev.type) && typeof ev.delta === 'string') {
      out.reasoning += ev.delta; if (onReason) try {onReason(ev.delta);} catch {}
    } else if (ev.type === 'response.reasoning_summary_part.added') {
      const part = ev.part || ev.summary_part || {};
      const text = typeof part.text === 'string' ? part.text : (typeof part.summary === 'string' ? part.summary : '');
      if (text) { out.reasoning += text; if (onReason) try {onReason(text);} catch {} }
    } else if (['response.completed','response.incomplete','response.failed'].includes(ev.type)) {
      final = ev.response || {status:ev.type.slice(9)};
      if (final.usage) out.usage = normalizeResponsesUsage(final.usage);
    }
    else if (ev.type === 'error') failed = ev.error || {message:'Responses流错误'};
  };
  const parse = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
    try {handle(JSON.parse(data));} catch (e) {if (e instanceof SyntaxError) return; throw e;}
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk,{stream:true}); let pos;
      while ((pos = buf.indexOf('\n')) >= 0) {parse(buf.slice(0,pos).trim());buf = buf.slice(pos+1);}
    }
  } catch (err) {
    attachPartialUsage(err, out);
    throw err;
  }
  if (buf.trim()) parse(buf.trim());
  if (final && final.usage) {
    out.usage = normalizeResponsesUsage(final.usage);
  }
  if (failed || final?.status === 'failed') {
    const err = new Error('Responses流错误: '+(failed?.message || final?.error?.message || '未知错误')); err.usage = out.usage; throw err;
  }
  if (final?.status === 'incomplete' || final?.incomplete_details?.reason === 'max_output_tokens') {
    const err = new Error('输出被 max_output_tokens 截断'); err.truncated = true; err.usage = out.usage; throw err;
  }
  if (!final || final.status !== 'completed') {
    const err = new Error('Responses流式响应未完整结束'); err.incomplete = true; err.usage = out.usage; throw err;
  }
  out.responses_items = final.output || [];
  const texts = [];
  for (const item of out.responses_items) {
    if (item.type === 'message') for (const part of item.content || []) if (part.type === 'output_text' && part.text) texts.push(part.text);
    if (item.type === 'function_call') out.tool_calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments || '{}'}});
  }
  if (texts.length) out.content = texts.join('');
  out.finish = out.tool_calls.length ? 'tool_calls' : 'stop';
  return out;
}

// Observe the exact serialized payload after protocol conversion. Diagnostics
// never add wire parameters, retain prompt text, or change the adapter result.
function transportDiagnostics(context) {
  if (!context) return null;
  let trace = null, responseModel = null;
  return {
    request(protocol, url, body, serializedBody) {
      try { trace = require('./cache_diagnostics').beginTrace(context, { protocol, url, body, serializedBody }); } catch {}
    },
    response(res) { try { trace?.response(res.status, res.headers); } catch {} },
    observe(usage, model) {
      if (typeof model === 'string') responseModel = model;
      try { if (usage) trace?.observeUsage(usage); } catch {}
    },
    finish(usage, error) { try { trace?.finish(usage, error, responseModel); } catch {} },
  };
}
async function chatStream(args) {
  const transportTrace = transportDiagnostics(args.cacheDiagnostics);
  const observed = transportTrace ? { ...args, transportTrace } : args;
  try {
    const result = args.kind === 'anthropic' ? await chatStreamAnthropic(observed)
      : usesResponses(args) ? await chatStreamResponses(observed) : await chatStreamOpenAI(observed);
    transportTrace?.finish(result.usage, null);
    return result;
  } catch (error) {
    transportTrace?.finish(error.usage, error);
    throw error;
  }
}

function normalizeUsage(u, previous = null) {
  // Relays can split usage across events. Missing means "not supplied in this
  // event", while an explicit zero is authoritative. Do not erase earlier
  // input/cache counters when the final event only contains output tokens.
  const hit = (u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens
    : u.prompt_tokens_details?.cached_tokens != null ? u.prompt_tokens_details.cached_tokens
    : previous?.cache_hit_tokens) || 0;
  return {
    prompt_tokens: (u.prompt_tokens != null ? u.prompt_tokens : previous?.prompt_tokens) || 0,
    completion_tokens: (u.completion_tokens != null ? u.completion_tokens : previous?.completion_tokens) || 0,
    cache_hit_tokens: hit,
    completion_details: u.completion_tokens_details || previous?.completion_details || null,
  };
}

function normalizeResponsesUsage(u) {
  return {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    cache_hit_tokens: u.input_tokens_details?.cached_tokens || 0,
    reasoning_tokens: u.output_tokens_details?.reasoning_tokens || 0,
  };
}

// A stream can be billed before its transport fails. Preserve the original
// error object and its status/name/cause while marking the usage as partial.
function attachPartialUsage(err, out) {
  if (!err || typeof err !== 'object' || !out || !out.usage) return;
  err.usage = out.usage;
  err.usage_partial = true;
}

module.exports = { PROTOCOL_KINDS, PROVIDERS, allProviders, customProviders, CUSTOM_ID_RE, keyFor, chatStream, usesResponses, applyReasoningBody, responsesInput, normalizeUsage, providerForModel, providerModels, resolveProvider };
