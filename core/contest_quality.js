// Contest-writing checks: task -> model -> actual results -> appropriate checks.
// Historical paper styles are advice. Only supplied, attributable contest rules impose file/page gates.
'use strict';
const PAPER_QUALITY_VERSION = '2026-11-07.1';
function usePaperProfile(session = {}) {
  return Object.keys(require('./contest_workflows').qualityFor(session)).length > 0;
}
function paperQualityBlock(session = { paper_profile: 'cumcm-user' }) {
  return require('./contest_workflows').packageFor(session).workflow.paper_quality_block || '';
}
function contestWritingBlock(session = {}) {
  return `【数学建模竞赛写作与验收：本段优先于历史模板的泛化要求】
写作指导、范文和公众号示例用于理解方法，不是本题事实或最终输出格式。摘要从已完成的方法、结果、检验和结论提炼；不要把“输入XX、输出XX”等教学占位或分析提纲抄进正文。正常技术输入/输出术语可以使用。审查必须有依据，允许未发现问题，不能为了凑问题而制造错误。
主办方本题题面、勘误、随题附件和原始数据默认不列参考文献，也不编文献序号或用于凑篇数；正文按需标明题目页码、附件表/字段，工作记录保留原始位置。未列题给材料不属于漏引。实际使用的外部论文、教材、标准、算法来源与另行取得的数据仍需真实引用；官方发布或PDF格式本身均不是纳入或排除的依据。题面列出的书目须实际查阅采用后再引用原文。当届有来源的明确规定或用户特定要求另有约定时按依据执行。
格式核查针对数学建模竞赛论文，依据当届规则、适用模板和明确用户约定，重点核查逐问任务、模型建立与求解、实际答案与适配检验；不强制期刊式IMRaD、独立引言/文献综述、理论新颖性或通用最低文献篇数。外部科研写作/审稿技能建议须先按此边界筛选，本机特定数量约定单独标注。
以完整题目和附件为准，逐问写清任务、变量和单位、题给条件与新增假设、数学表达、求解步骤、实际答案和适配检验；前问输出进入后问时说清接口与误差影响。
先建立能回答题目的可解释基线。经典方法适用即可，不为创新改名或强拼算法；改进要有同口径对照、真实收益和代价，没收益允许保留基线。
路线推荐分别注明题给事实、团队设计假设、已验证结果与待证明判断。不得无前提称某方法最优、样本最少或是另一方法的下界；缺少比较口径、目标或证明时说明条件不足。例如抽样只有标称率和信度，不等于已给样本量、替代假设或唯一最小样本设计。追问揭示推荐错误时明确纠正，原卡留待重新决策。
论文按题目难度分配篇幅，不以发表科研论文的理论新颖性为目标，不按模型、公式、图表数量评分，不强凑每问一图或固定数量假设。表格、解析结论也能完整作答；没有数据支持不编造置信区间、灵敏度或性能数字。
图表服务结论：数据来源、坐标单位、可读字号、题注、正文引出和解释、必要交叉引用。避免图表重复，不强制3D/热力图或特定配色。核心需要引用的公式编号，局部推演无需逐式编号。
检验按题型：优化回代约束/目标，预测看样本外误差，机理看守恒/极限/数值收敛，评价看排序和权重条件。灵敏度只针对会影响结论且有合理扰动范围的参数，不统一套±10%。
官方规范优先；未提供当届条款时，官方页数、附录代码位置、AI披露位置只能标待核对，不能把2026模板强套其他年份。用户另定的本机质量契约单独标注来源。不得伪造文献、人类选择、执行或人工核验。编译成功只是技术检查，逐页视觉和模型正确性须分别验收。` + (usePaperProfile(session) ? '\n\n' + paperQualityBlock(session) : '');
}
function alignContestAudit(warnings, rules = {}, metadata = {}) {
  const attributable = typeof rules.source === 'string' && rules.source.trim();
  const result = warnings.map(w => {
    if (/AI 工具使用声明/.test(w)) {
      if (attributable && rules.ai_statement_in_body === true) return w.replace(/2026[^：。]*[:：]?/g, '').replace(/规定要求/g, `用户提供规范（${rules.source}）要求`);
      return '【规则待核对】AI使用应真实披露，位置与文件按当届要求；未提供条款时不强制正文设置声明。';
    }
    if (/附录|源程序/.test(w) && /^【必须修/.test(w)) {
      if (attributable && rules.appendix_code_required === true) return w.replace(/2026 规范/g, `用户提供规范（${rules.source}）`);
      return '【建议】提供必要完整源程序与运行说明，可按当届要求放附录或独立支撑材料；不因论文未贴全量代码判失败。';
    }
    if (/没有结果图/.test(w)) return '【建议】' + w.replace(/^【必须修】/, '').replace(/：每问至少[\s\S]*/, '：检查是否已用表格、解析结论或文字充分作答；有信息增益时再补图，不机械凑图。');
    if (/未编号行间公式/.test(w)) return '【建议】对正文需要交叉引用的核心公式编号，局部推演不要求逐式编号。';
    if (/摘要数字过长/.test(w)) return w.replace(/^【必须修】/, '【建议】');
    if (/2026 规范|2026 人工智能/.test(w)) return w.replace(/2026 规范要求/g, '通用写作建议').replace(/2026 规范[:：]?/g, '当届规范待核对：');
    return w;
  }).filter(Boolean).filter((w, i, all) => all.indexOf(w) === i);
  const pages = metadata.pdf && metadata.pdf.body_pages;
  if (attributable && Number.isFinite(rules.max_body_pages) && rules.max_body_pages > 0 && Number.isFinite(pages) && pages > rules.max_body_pages && !result.some(w => /^【必须修】正文/.test(w))) {
    result.unshift(`【必须修】正文 ${pages} 页 > ${rules.max_body_pages} 页上限（用户提供依据：${rules.source}，条款真实性另行核对）。`);
  }
  return result;
}
function fileSizeWarning(bytes, rules = {}) {
  const explicit = typeof rules.source === 'string' && rules.source.trim() && Number.isFinite(rules.max_file_bytes) && rules.max_file_bytes > 0;
  if (explicit && bytes > rules.max_file_bytes) return `【必须修】PDF ${bytes} 字节 > ${rules.max_file_bytes} 字节上限（用户提供依据：${rules.source}，条款真实性另行核对）。`;
  return null;
}
function paperAuditBlockers(root, session) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const a = session.paper_audit || {};
  const blockers = [];
  const policy = require('./contest_workflows').auditPolicy(session);
  if ((a.audit_policy && a.audit_policy !== policy) || (!a.audit_policy && session.contest_rules?.source)) blockers.push('赛事或规则条款已变化，请重新 paper_build 核验当前适用规则。');
  if (a.paper_contract_version !== PAPER_QUALITY_VERSION || (usePaperProfile(session) && a.paper_profile !== true)) blockers.push('论文写作契约已更新，请重新 paper_build 按当前赛事包与已核规则审计。');
  if (!a.tex_sha256 || !a.pdf_sha256) return ['论文审计缺当前稿件指纹，请重新 paper_build。'];
  if (!Array.isArray(a.inputs) || !a.inputs.length) blockers.push('论文审计缺章节、图件和引用输入指纹，请重新paper_build。');
  else {
    try {
      if (JSON.stringify(a.inputs) !== JSON.stringify(require('./review_snapshot').paperInputs(root, a.tex_path))) blockers.push('论文章节、图件或引用输入在审计后变化，请重新paper_build。');
    } catch (e) { blockers.push('论文输入指纹核验失败：' + e.message); }
  }
  const digest = rel => {
    const abs = path.resolve(root, rel);
    if (path.relative(root, abs).startsWith('..') || path.isAbsolute(path.relative(root, abs))) throw new Error('路径越界');
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  };
  try {
    if (digest(a.tex_path) !== a.tex_sha256 || digest(a.pdf_path) !== a.pdf_sha256) blockers.push('论文在审计后已修改，请重新 paper_build。');
    const ac = session.abstract_check;
    if (!ac || ac.src !== a.tex_path || ac.sha256 !== a.tex_sha256.slice(0, 16)) blockers.push('摘要检查没有绑定当前论文，请用 abstract_check(path) 检查最终稿。');
  } catch { blockers.push('论文审计关联文件不可读，请重新 paper_build。'); }
  return blockers;
}
module.exports = { PAPER_QUALITY_VERSION, contestWritingBlock, paperQualityBlock, usePaperProfile, paperAuditBlockers, alignContestAudit, fileSizeWarning };
