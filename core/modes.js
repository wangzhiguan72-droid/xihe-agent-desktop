// 协作方式与工作流程强度的单一事实源。
//
// 此前只有 collab_mode 一个维度（全自动 / 人机协同）——它解决的是「谁来拍板」。
// 工作流程强度是另一件事，和"谁来拍板"正交；提供商推理档位单独配置。
//
//            │ 人机协同 collab      │ 全自动 auto
//   ─────────┼──────────────────────┼──────────────────────
//   快速 fast │ ① 日常（默认）        │ ② 无人值守跑题
//   ─────────┼──────────────────────┼──────────────────────
//   深度 deep │ ③ 高成本人机协同      │ ④ 高成本全自动
//
// 深度模式解锁的是此前因为"74 小时预算下成本过高"而没做的四种重手法
// （树搜索 / 多智能体辩论 / OptiMUS 建模-求解循环 / MatPlotAgent 视觉迭代闭环）。
// 它们可能增加调用与 token 花费，所以必须由用户显式开启，
// 并且必须有预算闸门兜底（见 agent.js budgetCheck 与 modeBlock 的成本纪律段）。
//
// deep 不等于"乱花钱"：deep 模式必须**先估计再花**（成本预估段），且受 daily_budget 硬顶。
'use strict';

const EFFORTS = ['fast', 'deep', 'extreme'];
const COLLABS = ['collab', 'auto'];

// 组合成六种模式。id 用于 UI/日志/持久化，label 给用户看。
const MODES = {
  'collab:fast': { id: 'collab:fast', n: 1, label: '人机协同', icon: '🤝', desc: '你拍板，基础工作流程。日常解题默认。模型推理档位另行设置。' },
  'auto:fast': { id: 'auto:fast', n: 2, label: '全自动', icon: '🤖', desc: '引擎自动选推荐项并续推到完成，基础工作流程。模型推理档位另行设置。' },
  'collab:deep': { id: 'collab:deep', n: 3, label: '深度协同', icon: '🔬', desc: '你拍板，深度工作流程。关键分歧处按需使用多评审、方案树与视觉检查；会增加调用成本。' },
  'auto:deep': { id: 'auto:deep', n: 4, label: '深度全自动', icon: '🧠', desc: '无人值守的深度工作流程，按问题需要使用额外评审与验证；会增加调用成本。' },
  'collab:extreme': { id: 'collab:extreme', n: 5, label: '极致协同', icon: '🧬', desc: '你拍板，建模/编程/论文三固定职责 + 按需动态子代理与红队。' },
  'auto:extreme': { id: 'auto:extreme', n: 6, label: '极致全自动', icon: '🌌', desc: '无人值守 + 三固定职责、动态池与红队；保留全部确定性门禁。' },
};

function effortOf(session) {
  const e = session && session.effort;
  return EFFORTS.includes(e) ? e : 'fast';
}
function collabOf(session) {
  return session && session.collab_mode === 'auto' ? 'auto' : 'collab';
}
function modeOf(session) {
  return MODES[collabOf(session) + ':' + effortOf(session)];
}
function tierOf(session) {
  return Math.max(0, EFFORTS.indexOf(effortOf(session)));
}
function isDeep(session) {
  return tierOf(session) >= 1;
}
function isExtreme(session) {
  return tierOf(session) >= 2;
}

const FAST_HIDDEN = ['subagent_run'];
const HIDDEN_BY_TIER = {
  0: ['deep_debate', 'deep_tree', 'deep_loop', 'deep_visual', ...FAST_HIDDEN],
  1: [],
  2: [],
};

// 三固定职责：复用 runSubagent，由职责契约 + 工具白名单分工，不新增全权限 profile。
const CREW = {
  modeler: {
    label: '建模手', icon: '📐', out: 'spec',
    role: '你负责建模。按赛题逐问登记 model_spec：题给条件与新增假设分开，变量有单位与定义域，写明表达式、数据来源、输入输出、求解步骤和与模型类型相称的检验。结构通过不等于数学正确，主代理须对照原题审查。不要写代码求解。',
    tools: ['model_spec', 'formula_register', 'assumption_register', 'contract_register', 'question_graph'],
  },
  coder: {
    label: '编程手', icon: '⌨️', out: 'runs',
    role: '你负责求解。只依据主代理交给你的逐问模型规格写代码，不许自己改公式；规格有问题就回报告。正式结果必须 formal:true，声明 model_spec_id=Q号 和 uses_formulas。',
    tools: ['model_spec', 'python_run', 'shell_run', 'job_start', 'job_status', 'job_cancel', 'conservation_check', 'repro_check', 'result_align', 'spreadsheet_diff', 'fs_write', 'fs_edit', 'fs_move', 'fs_copy'],
  },
  writer: {
    label: '论文手', icon: '📝', out: 'paper',
    role: '你负责论文。只写主代理标记为 committed 的问题；每个计算数值必须有 formal 运行或 result*.xlsx 格值背书。不要修改模型公式或求解代码。',
    tools: ['fs_write', 'fs_edit', 'paper_build', 'abstract_check', 'reconcile_artifact', 'flowchart_draw', 'support_pack'],
  },
};

// deep 模式解锁的重手法清单（同时用于 UI 展示与 system prompt 注入）。
// 每条写清：什么时候用、怎么用、什么算"做过了"——避免变成"模型自己声称辩论过了"。
const DEEP_TECHNIQUES = [
  {
    key: 'debate', tool: 'deep_debate', name: '多评审辩论',
    when: '关键分歧点：两个方法结论相差足以改变论文主结论、或一个数值主张没有把握、或评审要点里评委会挑的地方。',
    how: '同一问题派 3 个立场不同的 reviewer（保守/激进/挑错），各自独立用工具取证，再由裁判归纳"双方都同意的部分"与"仍存疑的部分"。',
    done: '产出必须区分「已收敛的结论」「仍存疑的结论」——不许把 3 个 agent 的合影当结论。存疑项要落到论文的"模型评价"或假设表里。',
  },
  {
    key: 'tree', tool: 'deep_tree', name: '建模方案树搜索',
    when: '开工前选路线，或某一问卡住要换思路时。',
    how: '显式展开候选建模方案（各自的目标/变量/约束/数据需求/代价），评估可行性与预期收益；按问题、现有证据和预算决定需要实现几个。可直接淘汰不适用的方案，需要比较时在相同条件下实测。',
    done: '必须落盘 candidate 清单与选择理由；未选中的方案要写清淘汰原因（否则论文里"我们选了模型 A"没有依据）。',
  },
  {
    key: 'loop', tool: 'deep_loop', name: '建模-求解-回改循环（OptiMUS 式）',
    when: '优化类问题：有明确目标函数与约束，实际检查发现约束遗漏、不可行或结果异常时使用；正确基线无需为迭代而改动。',
    how: '模型给出公式 → 引擎实测求解 → 把求解器报错/不可行/边界越界**原文回灌**给模型 → 模型改公式 → 再求解。循环直到可行且通过交叉验证，或达到轮次上限。',
    done: '每轮记进 iteration（预登记判据 → 结果 → 采纳/撤回），不许静默改公式。最终版必须有可行性证据（约束满足/违反量）。',
  },
  {
    key: 'visual', tool: 'deep_visual', name: '图表视觉迭代闭环（MatPlotAgent 式）',
    when: '正式出图阶段——图是要印进论文给评委看的，占位图、缺标签、压字、图例遮挡在 PDF 里全都藏不住。',
    how: '出图 → vision_read 实际看图 → 按视觉反馈改代码 → 再出图，最多 N 轮。检查项：坐标轴/单位/图例/中文是否乱码/数据点是否被裁掉/多面板是否压字。',
    done: '每张正式图都要有一轮 vision_read 记录，或写明为何跳过（如纯示意图）。',
  },
];

// deep 模式追加的 system 规则段。放在 MODE_APPENDIX 之后，不动 system 前缀的缓存友好性。
const DEEP_APPENDIX = `
## 当前深度：deep（高成本模式，用户已显式开启）
用户知道这一档更贵，换的是**更高置信度的结论**。以下四种重手法在这一档**可用且被期待**——但每一种都要用在刀刃上，不是"每步都跑一遍"：

1. **多评审辩论 deep_debate**：关键分歧点上派 3 个立场不同的 reviewer 独立取证再归纳。
2. **方案树搜索 deep_tree**：开工选路线、或某问卡住时，显式展开候选方案并评分；按问题、证据和预算决定实测范围，记录淘汰理由与可比证据。
3. **建模-求解回改循环 deep_loop**：优化类问题把求解器的报错/不可行原文回灌给模型改公式，循环到可行。
4. **图表视觉迭代闭环 deep_visual**：正式图出图后 vision_read 实际看图 → 改 → 再出，直到图能直接印。

**成本纪律（这一档唯一的硬约束）**：
- 每一处重手法调用前，先用一句话说清「为什么这里值得多花钱」「预期拿回什么」，说不清就不要调。
- **不重复花钱**：同一个分歧点辩论一次就够；辩论结果已收敛的结论，不要再开第二轮。
- 预算见 daily_budget（超了引擎会熔断，中断时已完成的部分仍有效，不要重跑）。
- 权威顺序不变：**确定性检查器 > 辩论共识**。辩论出来的结论若与守恒/复现/证据门禁冲突，以门禁为准。
- fast 档的规则一条都不少（守恒审计、网格收敛、复现门禁、论文硬规则照旧全部执行）——deep 是**加法**，不是替换。`;

const EXTREME_APPENDIX = DEEP_APPENDIX.replace('## 当前深度：deep（高成本模式，用户已显式开启）', '## 深度手法（极致档继承）') + `
## 当前深度：extreme（极致模式，用户已显式开启）
这一档包含 deep 的全部重手法与成本纪律，并增加编制分工：
1. **三固定职责**：建模手维护模型规格，编程手按规格求解，论文手只写 committed 内容；职责由 subagent_run 的 crew 指定，工具白名单强制执行。
2. **动态摊派**：只在任务出现独立路线、高风险假设或需要专项核查时拆任务；没有预先配额。批量任务用 subagent_run 的 tasks，单个子代理用 prompt。
3. **红队证伪**：只有 extreme 可派 redteam。红队必须落探针与退出码，自然语言声称“攻击过”不算。
4. **证据不降级**：formal/epoch/unstable/守恒/复现门禁全部照旧。子代理报告本身不是计算证据，主代理负责接受登记、汇总结论与处理红队发现。
5. **独立性与收敛**：同内核换种子不算独立验证；连续两轮没有新缺陷/新路径就停止扩池，预算紧张时先收敛，不为凑数量派活。
主代理是总师：优先编排与核验，不亲自重复子代理的大段求解工作。
6. **实战收口**：计算、复算、审稿、编译和人工审核分别记状态。额度/登录/模型失败不算完成，不以换名字绕开失败；保留已完成证据，从首个未完成环节恢复。通道按用户现有选择，记录实际 provider/model；不静默改直连为中转。
7. **版本与口径**：最终复算绑定输入/代码/结果及论文哈希；时区、时间原点、单位、分母和区间性质不同先拆口径，再比较数值。复算分歧不得用总体通过率掩盖。声明独立不等于技术隔离，需披露仍共享的数据与假设。
8. **预算可恢复**：子代理不需要再派人也能完成有界任务；主代理可接管失败或容量不足的工作，不能因“总师不亲算”放弃必要修复。只给最终文件和实际覆盖范围背书。
9. **最小充分方案**：增加模型、特征、融合、代理或图表前写明当前哪个题目要求/已证实缺陷尚未解决，简单基线为何不足、预期验证与预算。不能仅因极致档开启就堆算法；无可验证收益时保留或回归简单方案，负面对照留档。`;

module.exports = { EFFORTS, COLLABS, MODES, effortOf, collabOf, modeOf, tierOf, isDeep, isExtreme, FAST_HIDDEN, HIDDEN_BY_TIER, CREW, DEEP_TECHNIQUES, DEEP_APPENDIX, EXTREME_APPENDIX };
