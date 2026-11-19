// 长历史分块：只验证确定性分组逻辑，不调用压缩模型。
'use strict';
const { chunkSummaryMessages } = require('./agent');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', e.message); } }
t('压缩分块不拆 assistant(tool_calls) 与其全部 tool 结果', () => {
  const mid = [];
  for (let i = 0; i < 12; i++) {
    mid.push({ role: 'assistant', content: '步骤' + i + ' ' + 'x'.repeat(80), tool_calls: [{ function: { name: 'python_run', arguments: '{}' } }] });
    mid.push({ role: 'tool', tool_call_id: 'a' + i, content: '结果A ' + 'y'.repeat(70) });
    mid.push({ role: 'tool', tool_call_id: 'b' + i, content: '结果B ' + 'z'.repeat(70) });
  }
  const chunks = chunkSummaryMessages(mid, 360);
  if (chunks.length < 2) throw new Error('长历史未分块');
  let calls = 0, tools = 0;
  for (const c of chunks) {
    const nc = (c.match(/\[调用工具:/g) || []).length;
    const nt = (c.match(/\[tool\]/g) || []).length;
    if (nt !== nc * 2) throw new Error(`工具组被拆开: calls=${nc}, tools=${nt}`);
    calls += nc; tools += nt;
  }
  if (calls !== 12 || tools !== 24) throw new Error('分块丢失消息组');
});
t('普通短历史不强行分块', () => {
  const chunks = chunkSummaryMessages([{ role: 'user', content: '短' }]);
  if (chunks.length !== 1 || !/短/.test(chunks[0])) throw new Error('短历史分块异常');
});
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
