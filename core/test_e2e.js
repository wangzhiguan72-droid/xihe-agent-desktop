// 真实 API 端到端验证（手动运行：node core/test_e2e.js）
// 花真钱：默认只测 deepseek-flash，全部小请求，总成本 < ¥0.1。
// 验证项：Key 有效性 / 纯文本 / 工具调用往返 / reasoning 回传不 400 / Anthropic 端点协议适配。
'use strict';
const fs = require('fs');
const path = require('path');
const { chatStream, keyFor } = require('./providers');

const APP = path.join(__dirname, '..');
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' -> ' + detail : ''}`);
}

(async () => {
  const key = keyFor('deepseek', APP);
  if (!key) { console.log('SKIP：未配置 config/deepseek.key'); process.exit(process.env.XIHE_STRICT === '1' ? 1 : 0); }
  const base = 'https://api.deepseek.com';

  // 1) Key 有效性（GET /models 免费）
  try {
    const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
    const j = await r.json().catch(() => ({}));
    const ids = (j.data || []).map(m => m.id).join(',');
    report('Key 有效（/models）', r.status === 200, `可用模型: ${ids}`);
  } catch (e) { report('Key 有效（/models）', false, e.message); }

  const tiny = { model: 'deepseek-flash', maxTokens: 64 };

  // 2) 纯文本
  try {
    const r = await chatStream({ ...tiny, base, key, messages: [
      { role: 'user', content: '1+1等于几？只回答阿拉伯数字。' },
    ] });
    report('纯文本对话', /^\s*2\s*$/.test(r.content), `回复: ${r.content.trim().slice(0, 20)} | usage: in${r.usage.prompt_tokens}/out${r.usage.completion_tokens}`);
  } catch (e) { report('纯文本对话', false, e.message); }

  // 3) 工具调用往返 + reasoning 回传（历史 assistant 带 reasoning_content + tool_calls 回传不得 400）
  try {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: '查询城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const r1 = await chatStream({ ...tiny, base, key, tools, maxTokens: 512, messages: [
      { role: 'system', content: '你是天气助手，必须用工具查询。' },
      { role: 'user', content: '北京今天天气怎么样？' },
    ] });
    const hasCall = r1.tool_calls.length > 0 && r1.tool_calls[0].function.name === 'get_weather';
    report('工具调用触发', hasCall, `tool_calls=${r1.tool_calls.length}, name=${r1.tool_calls[0] && r1.tool_calls[0].function.name}, finish=${r1.finish}, reasoning=${r1.reasoning ? r1.reasoning.length + '字' : '无'}`);

    if (hasCall) {
      const tc = r1.tool_calls[0];
      const args = JSON.parse(tc.function.arguments || '{}');
      const hist = [
        { role: 'system', content: '你是天气助手。' },
        { role: 'user', content: '北京今天天气怎么样？' },
        { role: 'assistant', content: r1.content || '', reasoning_content: r1.reasoning || undefined, tool_calls: [tc] },
        { role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ city: args.city, weather: '晴 26℃' }) },
      ];
      const r2 = await chatStream({ ...tiny, base, key, tools, maxTokens: 256, messages: hist });
      report('带思考+工具历史回传不400', r2.finish === 'stop' && !!r2.content, `finish=${r2.finish}, 回复: ${r2.content.trim().slice(0, 40)}`);
    }
  } catch (e) { report('工具调用往返', false, e.message); }

  // 4) Anthropic 协议端点（deepseek 的 /anthropic）
  try {
    const r = await chatStream({ kind: 'anthropic', base: base + '/anthropic', key, model: 'deepseek-flash', maxTokens: 64, messages: [
      { role: 'user', content: '2+2等于几？只回答阿拉伯数字。' },
    ] });
    report('Anthropic 端点协议适配', /^\s*4\s*$/.test(r.content), `回复: ${r.content.trim().slice(0, 20)} | finish=${r.finish}`);
  } catch (e) { report('Anthropic 端点协议适配', false, String(e.message).slice(0, 160)); }

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n=== E2E ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E 异常:', e.message); process.exit(1); });
