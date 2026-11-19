'use strict';

const assert = require('assert/strict');
const { auditAbstractStyle, auditAbstractGuidance } = require('./paper_contract');

const abstract = body => String.raw`\begin{abstract}${body}\end{abstract}\keywords{整数规划；车辆调度；成本控制}`;
const result = body => auditAbstractStyle(abstract(body));
const narrative = String.raw`本文根据路网容量建立\textbf{整数规划模型}，将总成本\textbf{降低12\%}。`;

assert(result(`输入：XX；输出：XX。${narrative}`).some(w => /^【必须修】/.test(w) && /占位|模板/.test(w)),
  '未填的输入/输出教学模板须阻断摘要');
assert(auditAbstractGuidance('输入：XX 输出：XX').some(w => /^【必须修】/.test(w)),
  '空格连接的原始占位提纲也须阻断');
assert(auditAbstractGuidance('输入XX，输出XX').some(w => /^【必须修】/.test(w)),
  '省略冒号的 XX 占位提纲须阻断');
assert(auditAbstractGuidance('输入什么什么，输出什么什么').some(w => /^【必须修】/.test(w)),
  '省略冒号的口语占位提纲须阻断');
assert.deepEqual(auditAbstractGuidance('输入XX矩阵，输出XX矩阵'), [],
  '实际矩阵记号不能被误判为未填模板');
assert(result(`输入：待填写；输出：待填写。${narrative}`).some(w => /^【必须修】/.test(w) && /占位|模板/.test(w)),
  '待填写占位也须阻断摘要');
assert(result(`输入：路网容量与车辆需求；输出：最优调度方案。${narrative}`).some(w => /^【待人工核验】/.test(w) && /输入|输出/.test(w)),
  `有内容的标签式提纲至多提示人工核验：${JSON.stringify(result(`输入：路网容量与车辆需求；输出：最优调度方案。${narrative}`))}`);
assert(!result(`输入：路网容量与车辆需求；输出：最优调度方案。${narrative}`).some(w => /^【必须修】/.test(w) && /输入|输出|模板|占位/.test(w)),
  '有内容的标签式提纲不能硬拒绝');
assert.deepEqual(result(`本文将路网容量作为输入，输出最优调度方案。${narrative}`), [],
  '正常科学叙述中的输入输出必须放行');
assert.deepEqual(result(narrative), [], '既有摘要行为保持不变');
assert(auditAbstractGuidance('# 摘要\n输入：XX；输出：XX。\n\n关键词：调度；成本；规划').some(w => /^【必须修】/.test(w)),
  'Markdown 摘要须受相同检查');
assert.deepEqual(auditAbstractGuidance(String.raw`\begin{abstract}
本文使用矩阵 XX 表示流量转移，输入：矩阵 XX；输出：最优流量。
% 输入：XX；输出：XX
\end{abstract}`), [
  '【待人工核验】摘要使用“输入/输出”标签式提纲，请核对是否完整交代本题约束、方法与结果。',
], 'LaTeX 注释的示例应被忽略，合法 XX 矩阵记号不算占位');
assert.deepEqual(auditAbstractGuidance('本文使用矩阵 XX 表示流量转移。'), [],
  '数学符号 XX 不应被当成教学占位');

const { TOOLS, auditPaperTex } = require('./tools');
const manuscript = String.raw`\begin{document}\begin{abstract}输入XX，输出XX。${narrative}\end{abstract}\keywords{整数规划；车辆调度；成本控制}\section{问题一}结果。\end{document}`;
for (const paperProfile of [false, true]) {
  const warnings = auditPaperTex(manuscript, { contestFit: false, paperProfile });
  assert(warnings.some(w => /^【必须修】/.test(w) && /占位模板/.test(w)),
    `${paperProfile ? '国赛' : '通用'}论文审计必须调用摘要占位检查`);
}

(async () => {
  const tool = TOOLS.find(tool => tool.name === 'abstract_check');
  for (const paper_profile of ['generic', 'cumcm-user']) {
    const ctx = { session: { mode: 'math', paper_profile } };
    const output = await tool.run(ctx, { text: manuscript });
    assert.match(output, /占位模板/, `${paper_profile} abstract_check 必须报告模板污染`);
    assert(ctx.session.abstract_check.must_fix > 0,
      `${paper_profile} abstract_check 必须将模板污染计入门禁`);
  }
  console.log('abstract guidance tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
