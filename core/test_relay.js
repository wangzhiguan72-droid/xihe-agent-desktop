// 中转站 + GLM 订阅端点 真实 API 验证（手动运行：node core/test_relay.js）
// 花真钱但极省：每家抽一款模型，文本 + 工具调用两个小请求（max_tokens ≤512）。
// 验证项：中转站连通/鉴权、文本生成、工具调用往返（智能体的核心能力）、GLM 订阅 anthropic 协议聊天。
'use strict';
// 这是付费在线联调，普通验证不得误触。离线测试使用 test_reasoning*.js。
if (process.env.XIHE_LIVE_TESTS !== '1') {
  console.log('SKIP paid relay test: explicitly set XIHE_LIVE_TESTS=1 to run live requests');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');
const { chatStream, keyFor, resolveProvider } = require('./providers');

const APP = path.join(__dirname, '..');
async function measuredChat(args) {
  const save = usage => {
    if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens)) return;
    require('./meter').record(APP, { t: Date.now(), model: args.model, kind: 'diagnostic', project_id: null, session_id: null,
      prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, cache_hit_tokens: usage.cache_hit_tokens || 0 });
  };
  try { const result = await chatStream(args); save(result.usage); return result; }
  catch (e) { save(e.usage); throw e; }
}
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' -> ' + detail : ''}`);
}

const WEATHER_TOOL = [{ type: 'function', function: { name: 'get_weather', description: '查询城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];

async function testModel({ label, providerKey, model, settings, maxTokens = 512 }) {
  const provider = resolveProvider(providerKey, settings);
  const key = keyFor(providerKey, APP);
  if (!key) { report(label + '（无key跳过）', true, '未配置 key'); return; }
  // 文本（GLM/kimi-k3 默认开思考，64 token 会被思考耗光触发 max_tokens 截断；512 才是合理预算）
  try {
    const thinking = provider.kind === 'anthropic' || /kimi-k3/i.test(model);
    const r = await measuredChat({ kind: provider.kind, base: provider.base, key, model, maxTokens: thinking ? 512 : 64, messages: [{ role: 'user', content: '1+1等于几？只回答阿拉伯数字。' }] });
    report(`${label} 文本`, /^\s*2\s*$/.test(r.content), `回复:${r.content.trim().slice(0, 12)} in${r.usage ? r.usage.prompt_tokens : '?'}/out${r.usage ? r.usage.completion_tokens : '?'}`);
  } catch (e) { report(`${label} 文本`, false, String(e.message).slice(0, 140)); }
  // 工具调用往返（智能体核心能力：不会调工具的模型在羲和里没用）
  try {
    const isAnthropic = provider.kind === 'anthropic';
    const r1 = await measuredChat({
      kind: provider.kind, base: provider.base, key, model, maxTokens,
      tools: isAnthropic ? [{ name: 'get_weather', description: '查询城市天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] : WEATHER_TOOL,
      messages: isAnthropic
        ? [{ role: 'user', content: '北京今天天气怎么样？必须调用工具查询。' }]
        : [{ role: 'system', content: '你是天气助手，必须用工具查询。' }, { role: 'user', content: '北京今天天气怎么样？' }],
    });
    const hasCall = r1.tool_calls && r1.tool_calls.length && r1.tool_calls[0].function.name === 'get_weather';
    report(`${label} 工具调用`, !!hasCall, `name=${hasCall ? r1.tool_calls[0].function.name : '无'} finish=${r1.finish} args=${hasCall ? r1.tool_calls[0].function.arguments.slice(0, 40) : ''}`);
    if (hasCall) {
      // 工具结果回传（Anthropic 协议用 anthropic_blocks 逐字回放）
      const tc = r1.tool_calls[0];
      let hist;
      if (isAnthropic) {
        hist = [
          { role: 'user', content: '北京今天天气怎么样？必须调用工具查询。' },
          { role: 'assistant', content: r1.anthropic_blocks },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify({ city: '北京', weather: '晴 26℃' }) }] },
        ];
      } else {
        hist = [
          { role: 'system', content: '你是天气助手。' },
          { role: 'user', content: '北京今天天气怎么样？' },
          { role: 'assistant', content: r1.content || '', tool_calls: [tc] },
          { role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ city: '北京', weather: '晴 26℃' }) },
        ];
      }
      const r2 = await measuredChat({ kind: provider.kind, base: provider.base, key, model, maxTokens, tools: isAnthropic ? [{ name: 'get_weather', description: '查询城市天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }] : WEATHER_TOOL, messages: hist });
      report(`${label} 工具结果回传`, !!r2.content, `回复:${r2.content.trim().slice(0, 36)}`);
    }
  } catch (e) { report(`${label} 工具调用`, false, String(e.message).slice(0, 140)); }
}

(async () => {
  const settings = JSON.parse(fs.readFileSync(path.join(APP, 'config', 'settings.json'), 'utf8'));

  // 中转站抽测（每家抽一款：kimi-k3 / qwen3.8-flash 便宜款 / gpt-6-astra 旗舰——2026-10-17 起 astra 走 wanzhao 中转）
  await testModel({ label: '中转站 kimi-k3', providerKey: 'moonshot', model: 'kimi-k3', settings });
  await testModel({ label: '中转站 qwen3.8-flash', providerKey: 'qwen', model: 'qwen3.8-flash', settings });
  await testModel({ label: 'wanzhao 中转 gpt-6-astra', providerKey: 'wanzhao', model: 'gpt-6-astra', settings });

  // GLM 官方订阅 anthropic 端点（第二优先级；视觉桥已验证过 glm-5.3-flash，这里验证完整聊天+工具路径）
  await testModel({ label: 'GLM订阅 glm-5.3-flash', providerKey: 'glm', model: 'glm-5.3-flash', settings });
  await testModel({ label: 'GLM订阅 glm-5.3', providerKey: 'glm', model: 'glm-5.3', settings });

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n=== RELAY-TEST ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(1); });
