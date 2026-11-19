'use strict';
const MATERIAL_POLICY_VERSION = '2026-10-19.1';
const PURPOSES = Object.freeze({
  skill: '流程指导：只执行当前任务适用的步骤，正文示例不是本题成果。',
  advice: '方法建议：提炼当前阶段适用的检查点，不照抄教学提纲为摘要。',
  exemplar: '范文示例：参考论证组织，不迁移其数据、假设、结果或获奖结论。',
  agent_run: '其他模型方案：待验证候选，模型自评或多数同意不证明正确。',
  user_own: '历史作品：核对适用条件，历史结果不是本题结果。',
  reference: '参考资料：引用主张需核对原始来源及适用条件。',
  unknown: '用途未标明：先区分题面、数据、指导、示例与候选方案，不擅自升级为本题事实。',
});

function materialPolicyBlock() {
  return `【外部材料用途与方案采纳】
题面与附件确定任务事实；技能、辅导资料和公众号推文提供方法建议；范文及其他模型答案是参考或待验证候选。混合粘贴的材料也按此区分。只提取当前阶段需要的规则并保留来源，示例数值、占位符和教学表达不是本题结论，不能用作运行证据。指导材料中的“输入—约束—假设—模型—输出”用于内部梳理，摘要应依据本题实际方法、结果与结论自然成文；正常学术输入/输出术语可以使用。
按题目条件、假设、变量单位、评价数据和跨问接口比较方案；模型自评、票数、平台名声与推理档位不构成正确性证据。允许多模型独立探索、局部借鉴，但记录来源、采纳部分、依据、兼容性和待验证项。涉及模型变化时先更新 model_spec，按已有失效规则重算，不仅修饰文字。deep_tree 的路线选择只是探索决策；实测比较须提供正式输出 JSON 指标及同口径 comparison。
官方规范须有当届可追溯来源，不把培训偏好升级为全国硬规则。评审允许未发现问题；每条问题给位置、依据和验证方法，不用“找不出就是没认真”强迫造错。
先跑可解释基线，再把有限调用投入未解决且影响最大的约束、假设或结果核验；没有新证据时不重复全题生成。按当前问题和阶段调用技能，普通步骤连续执行，关键分歧按自动/协同模式处理，保留用户纠偏入口；不承诺奖项。`;
}

function wrapMaterial(content, { kind = 'unknown', source = '' } = {}) {
  const selected = Object.hasOwn(PURPOSES, kind) ? kind : 'unknown';
  return `[参考材料开始｜用途=${selected}｜来源=${JSON.stringify(String(source))}]\n${PURPOSES[selected]}\n示例和历史数值不得视为本题已验证事实；以下保留原文：\n${String(content ?? '')}\n[参考材料结束｜用途=${selected}]`;
}

module.exports = { MATERIAL_POLICY_VERSION, materialPolicyBlock, wrapMaterial, PURPOSES };
