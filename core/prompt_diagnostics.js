'use strict';
// 估算一次请求的 token 来源，用于回答「token 为什么涨这么快」。
// 只做本地统计，不调用模型；实际账单仍以提供商返回的 usage 为准。
const LABELS = {
  system: '系统提示', tools: '工具定义', user: '用户消息', assistant: '助手回复',
  reasoning: '思考内容', tool_calls: '工具参数', tool_results: '工具结果', dynamic: '本轮动态规则',
};

function textOf(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// 中文/全角字符约 1 token/字，其余约 4 字符/token；JSON 键名偏英文。
// 这是用于定位来源的估算，不替代官方 usage。
function estimateTokens(text) {
  let cjk = 0, narrow = 0;
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0);
    if (code >= 0x2e80) cjk++;
    else narrow++;
  }
  return Math.ceil(cjk + narrow / 4);
}

function addText(parts, key, text) {
  const body = textOf(text);
  if (!body) return;
  const row = parts.get(key) || { key, label: LABELS[key] || key, chars: 0, tokens: 0 };
  row.chars += body.length;
  row.tokens += estimateTokens(body);
  parts.set(key, row);
}

function analyzeMessages(messages) {
  const parts = new Map();
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') addText(parts, 'user', m.content);
    else if (m.role === 'tool') addText(parts, 'tool_results', m.content);
    else if (m.role === 'assistant') {
      // anthropic_blocks/raw items already contain text/thinking/tool_use；避免重复计数。
      if (Array.isArray(m.anthropic_blocks) && m.anthropic_blocks.length) {
        addText(parts, 'assistant', m.anthropic_blocks);
      } else {
        addText(parts, 'assistant', m.content);
        addText(parts, 'reasoning', m.reasoning_content);
        if (m.tool_calls) addText(parts, 'tool_calls', m.tool_calls);
      }
    } else addText(parts, 'user', m.content);
  }
  return parts;
}

function summarize(parts, extra = {}) {
  const rows = [...parts.values()].filter(row => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return {
    ...extra,
    total_tokens: total,
    total_chars: rows.reduce((sum, row) => sum + row.chars, 0),
    components: rows.map(row => ({ ...row, share: total ? +(row.tokens / total).toFixed(4) : 0 })),
    top: rows.slice(0, 5).map(row => ({ key: row.key, label: row.label, tokens: row.tokens,
      share: total ? +(row.tokens / total).toFixed(4) : 0 })),
  };
}

function analyzePrompt({ system, messages, tools, dynamic = [] }) {
  const parts = new Map();
  addText(parts, 'system', system);
  if (Array.isArray(tools) && tools.length) addText(parts, 'tools', tools);
  for (const [key, row] of analyzeMessages(messages)) {
    const target = parts.get(key) || { key, label: row.label, chars: 0, tokens: 0 };
    target.chars += row.chars; target.tokens += row.tokens; parts.set(key, target);
  }
  for (const text of dynamic) addText(parts, 'dynamic', text);
  return summarize(parts);
}

function record(session, stats) {
  if (!session || !stats) return stats;
  const rows = Array.isArray(session.prompt_stats) ? session.prompt_stats : [];
  const row = {
    at: Date.now(), iter: stats.iter, total_tokens: stats.total_tokens,
    components: stats.components.map(c => ({ key: c.key, tokens: c.tokens, share: c.share })),
    prompt_tokens: stats.prompt_tokens == null ? null : stats.prompt_tokens,
    cache_hit_tokens: stats.cache_hit_tokens == null ? null : stats.cache_hit_tokens,
  };
  rows.push(row);
  session.prompt_stats = rows.slice(-30);
  stats.at = row.at;
  return stats;
}

function finish(session, stats, usage) {
  if (!stats || !usage) return stats;
  stats.prompt_tokens = Number(usage.prompt_tokens) || 0;
  stats.cache_hit_tokens = Number(usage.cache_hit_tokens) || 0;
  stats.cache_rate = stats.prompt_tokens ? +(stats.cache_hit_tokens / stats.prompt_tokens).toFixed(4) : 0;
  const row = Array.isArray(session?.prompt_stats) ? session.prompt_stats.at(-1) : null;
  if (row) {
    row.prompt_tokens = stats.prompt_tokens;
    row.cache_hit_tokens = stats.cache_hit_tokens;
    row.cache_rate = stats.cache_rate;
  }
  return stats;
}

module.exports = { analyzePrompt, estimateTokens, record, finish };