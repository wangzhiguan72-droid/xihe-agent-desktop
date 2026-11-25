// 羲和智能体核心：DeepSeek V4 适配
// —— 协议：思考对话完整回传 reasoning_content（官方要求，否则带 tools 的后续请求 400）
// —— 可靠性：流完整性/截断参数拒绝执行、ask_user 立即暂停、死循环硬停止、子代理只读强制+预算纳管
// —— 成本：token/缓存命中/费用三账本，日预算硬顶（请求前熔断，含子代理/压缩/视觉），超限熔断
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createDecision, recommendedChoice, validateResponse, validateClarification, decisionRecord, textDecision, isVagueContinuation } = require('./decisions');
const { chatStream, keyFor, PROVIDERS, providerForModel, resolveProvider } = require('./providers');
const { toOpenAITools, toAnthropicTools, executeTool, READ_ONLY, RED_EXTRA, DEEP_ONLY, TOOLS, cap, conservationGate } = require('./tools');
const { costOf } = require('./pricing');
const projectPlan = require('./project_plan');
const { dayKey } = require('./external');
const spiral = require('./spiral');
const modes = require('./modes');
const { resolveRoleModel, roleForSubagent } = require('./model_roles');
const { runPool } = require('./pool');
const { finalizeRedteam, redteamBlockers } = require('./redteam');
const { archiveContext, makeHandoff, formatHandoff } = require('./handoff');
const { specGate, specSummary, specBinding } = require('./model_spec');
const { materialPolicyBlock, wrapMaterial, MATERIAL_POLICY_VERSION } = require('./material_policy');
const { resolveReasoning, callWithReasoning, reasoningRecorder, REASONING_POLICY_VERSION } = require('./reasoning');
const { judgeDecision, shouldAutoJudge, shouldOverride: shouldOverrideDecisionJudge, disposition: decisionJudgeDisposition } = require('./decision_judge');
const promptDiagnostics = require('./prompt_diagnostics');

const isLocalTask = session => session?.task_focus?.kind === 'local';
const isReviewTask = session => session?.task_scope === 'review' && !isLocalTask(session);
function reviewToolBlock(session, name, args = {}, workspace) {
  if (!isReviewTask(session)) return null;
  if (READ_ONLY.has(name) || ['ask_user', 'review_finding', 'review_snapshot', 'task_finish', 'result_compare', 'verification_run', 'independent_verify', 'abstract_check'].includes(name)) return null;
  if (['fs_write', 'fs_edit'].includes(name)) {
    const rel = path.posix.normalize(String(args.path || '').replace(/\\/g, '/'));
    if (/^findings\/reviews\/[^\0]+\.(md|json)$/.test(rel) && workspace) {
      try {
        const base = fs.realpathSync(workspace);
        let probe = path.join(base, rel);
        while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
        if (fs.realpathSync(probe).toLowerCase() === path.resolve(probe).toLowerCase()) return null;
      } catch {}
    }
  }
  return '当前是审稿任务：原稿和数据保持只读；报告可写 findings/reviews/，独立计算用 verification_run。';
}
const MAX_TOOL_ITER = (session) => isLocalTask(session) ? 18 : (session && (session.collab_mode === 'auto' || session.contest) ? 1500 : 80);
// Local work may edit requested files, but cannot advance the paused contest or
// manipulate its durable job wait. This filter applies to both schemas and calls.
const LOCAL_BLOCKED_TOOLS = new Set([
  'question_graph', 'contest_clock', 'iteration_register', 'iteration', 'assumption_register',
  'contract_register', 'formula_register', 'model_spec', 'conservation_check', 'repro_check',
  'abstract_check', 'paper_build', 'support_pack', 'reconcile_artifact', 'result_align', 'verification_run', 'independent_verify', 'review_finding',
  'job_start', 'job_wait', 'job_status', 'job_cancel', 'dispatch_child',
  'todo_write', 'memory_write', 'lesson_record', 'skill_save', 'memory_audit', 'dispatch_external',
  'deep_debate', 'deep_tree', 'deep_loop', 'deep_visual',
]);
// 全自动模式：turn 结束但任务未完成时自动续推的上限（连续无工具调用的收尾次数）
const AUTO_CONTINUE_MAX = 12;

// ---------- 审批门禁（v2.5：完全访问 / 请求审批，借鉴市面主流的权限模型）----------
// 市面主流（Codex/Claude Code 一类）把"沙箱范围"和"审批策略"分成两件事。羲和这边沙箱范围固定为
// 工作区（不放开），额外给一个**审批策略**开关：
//   full = 完全访问：照旧直接执行（默认，保持既有行为；全自动模式用这个）
//   ask  = 请求审批：每个"会改动/会花钱/会对外"的工具执行前弹卡等用户点批准（人机协同默认）
// 只读工具永不弹卡——否则读个文件都要点一下，没法用。
const APPROVAL_TOOLS = new Set([
  'fs_write', 'fs_edit', 'fs_move', 'fs_copy', 'fs_delete',
  'shell_run', 'python_run', 'job_start',
  'dispatch_external', 'subagent_run', 'dispatch_child', 'support_pack', 'verification_run',
  'skill_save', 'memory_write', 'lesson_record', 'kb_build',
  'rollback_artifact', 'result_align',
]);
// 审批策略解析：显式 session.approval 优先；没设过就按协作模式定（人机协同=请求审批，全自动=完全访问）
function approvalMode(session) {
  const a = session && session.approval;
  if (a === 'ask' || a === 'full') return a;
  return session && session.collab_mode === 'auto' ? 'full' : 'ask';
}
function needApproval(session, name) {
  if (!APPROVAL_TOOLS.has(name)) return false;
  if ((session.approval_allow || {})[name]) return false; // 用户已授权"本会话总是允许"
  return approvalMode(session) === 'ask';
}
// 审批事件的一句话说明（给用户看的：这个工具要干什么、影响面）
function approvalSummary(name, args) {
  const a = args || {};
  const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);
  switch (name) {
    case 'fs_write': return `写文件 ${a.path}（${cut(a.content, 8000).length} 字符）`;
    case 'fs_edit': return `编辑文件 ${a.path}（${(a.edits || []).length} 处）`;
    case 'fs_move': return `移动 ${a.from} → ${a.to}`;
    case 'fs_copy': return `复制 ${a.from} → ${a.to}`;
    case 'fs_delete': return `删除（进回收站）${a.path}`;
    case 'shell_run': return `执行命令：${cut(a.command, 200)}`;
    case 'python_run': return `运行 Python${a.formal ? '（formal 正式求解）' : ''}：${cut(a.code, 160)}`;
    case 'job_start': return `启动后台长作业：${cut(a.command, 160)}`;
    case 'dispatch_external': return `把任务交给外部模型 ${a.target}（消耗额度）`;
    case 'subagent_run': return `派子代理（${a.profile}）：${cut(a.prompt, 140)}`;
    case 'dispatch_child': return `派子会话：${cut(a.child_prompt, 140)}`;
    case 'support_pack': return '生成支撑包与 AI 使用详情（交付物，会写盘）';
    case 'skill_save': return `沉淀技能 ${a.name}（写入羲和技能库）`;
    case 'memory_write': return `写${a.scope === 'persistent' ? '跨会话经验库' : '会话记忆'}：${cut(a.content, 140)}`;
    case 'lesson_record': return `记教训：${cut(a.rule, 140)}`;
    case 'kb_build': return '重建知识库索引（后台长作业）';
    case 'rollback_artifact': return `从回收站恢复文件 ${a.id || '（全部）'}`;
    case 'result_align': return `对齐结果表 ${a.result_path} ↔ ${a.template_path}${a.auto_apply ? '（直接改文件）' : ''}`;
    default: return `${name}：${cut(JSON.stringify(args), 160)}`;
  }
}

// ---------- 协作模式（全自动 / 人机协同）----------
// 两种模式共用同一流程与决策卡（2–6 个有依据候选+自定义入口，一项标「推荐」）；区别只在谁来选：
// collab = 弹卡片等用户；auto = 引擎自动选推荐项并立即继续（决策照样留痕，用户回来可回看改选）。
function autoPick(options) {
  if (options && options.candidates) return recommendedChoice(options)?.label || null;
  const opts = (options || []).map(String);
  return opts.find(o => /推荐|recommend/i.test(o)) || opts[0] || null;
}

// The judgment model is deliberately advisory and bounded. It only sees the
// three already-prepared candidates, never the whole session or private files.
// A malformed response, timeout, missing key, or low confidence leaves the
// main model's explicit recommendation untouched.
async function applyDecisionJudge(args, session, deps) {
  if (!args || !Array.isArray(args.candidates) || args.candidates.length !== 3) return args;
  const trigger = shouldAutoJudge(args, deps.settings);
  if (!trigger.use) return args;
  const result = await judgeDecision({
    args,
    settings: deps.settings,
    appDir: deps.appDir,
    signal: deps.abort && deps.abort.signal,
  });
  if (result.usage && result.model && typeof deps.spend === 'function') {
    try {
      const usage = {
        prompt_tokens: Number(result.usage.prompt_tokens || 0),
        completion_tokens: Number(result.usage.completion_tokens || 0),
        cache_hit_tokens: Number(result.usage.prompt_cache_hit_tokens || result.usage.prompt_tokens_details?.cached_tokens || 0),
      };
      deps.spend(result.model, usage, 'judge');
    } catch { /* judging must never break the main decision */ }
  }
  const judged = { ...args, judge: { ...result, disposition: decisionJudgeDisposition(result, args, deps.settings) } };
  // A conflict is an escalation signal, not permission to silently replace
  // the main model's route. Override is an explicit, calibrated opt-in.
  if (shouldOverrideDecisionJudge(result, deps.settings)) {
    const chosen = args.candidates.find(c => c.id === result.choice_id);
    if (chosen) {
      judged.recommended_id = chosen.id;
      judged.recommendation_reason = `${String(args.recommendation_reason || '').trim()}；判断层复核：${result.reason || '按候选依据与风险比较后选择该方案。'}`.slice(0, 4000);
    }
  }
  return judged;
}
function modeBlock(session) {
  if (isLocalTask(session)) return '【临时任务】只处理用户当前的局部请求。答完、写完并核验后即停；需要局部选择时可用 ask_user，不要求赛题决策卡、论文交付或推进原主线。';
  // 深度维度（v2.5 第九轮）：deep 档追加的重手法说明由 modes.DEEP_APPENDIX 注入 system；
  // 这里只在最后补一句"当前是第几种模式"，避免模型把 deep 当成"可以不守门禁"。
  const deepTail = modes.isExtreme(session)
    ? `\n【当前深度：extreme（第 ${modes.modeOf(session).n} 种模式）】三固定职责与动态池已解锁；主代理负责编排与证据门禁，红队探针与子代理报告都不能替代 formal 证据。`
    : modes.isDeep(session)
      ? `\n【当前深度：deep（第 ${modes.modeOf(session).n} 种模式）】重手法（deep_debate/deep_tree/deep_loop/deep_visual）已解锁，用在刀刃上、每处调用前说清收益；确定性门禁优先级高于辩论共识。`
      : '';
  const wrap = (txt) => txt + deepTail;
  // 比赛会话（contest）：阶段规则见 phaseBlock（每轮注入当前阶段该看的规则）；
  // 这里只讲"谁来拍板"和"迭代决策卡"两件事。
  if (session.contest) {
    const fin = '全部完成（各问 committed + 论文审计无【必须修】+ 支撑包已生成 + contest_clock 阶段=final）时回复「【全流程完成】」+ 产物清单。';
    const iter = '到了假设迭代阶段：每一圈开始先做一次继续/停止决策。有具体迭代/创新方案时出决策卡：给 2–6 个有依据的候选，其中必须包含「停止迭代并冻结」，其余 1–5 个按题意列，不硬凑，另加 1 个自定义入口，用 recommended_id 明确推荐；完全没有可列方案时只用普通确认「停止迭代并冻结」，不要硬凑第二个选项。若有迭代方案，至少一个来自结构检查（单调性/对称性/可分解/边界结构/条件分层/可复用状态/边际代价/守恒），并写明成立条件。';
    if (session.collab_mode === 'auto') {
      return wrap('【当前协作模式：全自动】用户不在场，时间紧。流程与人机协同版完全相同：需要选择时照常用 ask_user 出决策卡（2–6 个有依据的候选+1 个自定义入口；候选按题意列，不足不硬凑，只有一个时用普通 options 确认；用 candidates 提供每项 id、label、basis、tradeoff/risk，用 recommended_id 明确推荐，并在 recommendation_reason 比较各候选对题目、数据和赛时的适合度），系统会立即自动选推荐项并把结果返回给你——拿到结果直接推进，不要停下等确认、不要用纯文字提问。' + iter + '剩余时间不足时，推荐项**必须是**「停止迭代并冻结」。' + fin);
    }
    return wrap('【当前协作模式：人机协同】每一问开工前都要单独出一张路线决策卡（开头在任务表里写的初步路线不算用户确认）；此外选求解方法、足以改变结论的假设/口径/创新、论文主线时，也必须用 ask_user 出决策卡（2–6 个有依据的候选+1 个自定义入口；候选按题意列，不足不硬凑，只有一个时用普通 options 确认；用 candidates 提供每项 id、label、basis、tradeoff/risk，用 recommended_id 明确推荐，并在 recommendation_reason 比较各候选对题目、数据和赛时的适合度，自定义必须说明理由），等用户选择。' + iter + '常规步骤、已授权的修复直接推进，不要事事请示；一轮做完别停下等"继续"，直接进入下一步。' + fin);
  }
  if (session.collab_mode === 'auto') {
      return wrap('【当前协作模式：全自动】用户不在场，时间紧。流程与人机协同版完全相同：需要选择时照常用 ask_user 出决策卡（模型/方法给 2–6 个有依据的候选+1 个自定义入口；候选按题意列，不足不硬凑，只有一个时用普通 options 确认；用 candidates 提供每项 id、label、basis、tradeoff/risk，用 recommended_id 明确推荐，并在 recommendation_reason 比较各候选对题目、数据和赛时的适合度），系统会立即自动选推荐项并把结果返回给你——拿到结果直接推进，不要停下等确认、不要用纯文字提问。一问完成（commit）立即进入下一问；题目各问完成后写论文并 paper_build，全部完成时回复「【全流程完成】」+ 产物清单。');
  }
  return wrap('【当前协作模式：人机协同】每一问开工前都要单独出一张路线决策卡（开头在任务表里写的初步路线不算用户确认）；此外选求解方法、足以改变结论的假设/口径/创新、论文主线时，也必须用 ask_user 出决策卡（2–6 个有依据的候选+1 个自定义入口；候选按题意列，不足不硬凑，只有一个时用普通 options 确认；用 candidates 提供每项 id、label、basis、tradeoff/risk，用 recommended_id 明确推荐，并在 recommendation_reason 比较各候选对题目、数据和赛时的适合度，自定义必须说明理由），等用户选择；常规步骤、已授权的修复直接推进，不要事事请示；一轮做完别停下等“继续”，直接进入下一步。全部完成（题目各问 committed + 论文编译通过）时回复「【全流程完成】」+ 产物清单。');
}
// 完成判据（I-2）：比赛会话要求「冻结后」——阶段到 freeze/final，且论文审计无【必须修】。
// 基线达成（各问 committed + main.pdf）**不再**算完成，而是转入 iterate（假设迭代）。
// 非比赛会话沿用旧判据（已登记各问 committed + paper/main.pdf），避免打扰普通数模会话。
function paperHardIssues(session) {
  const a = session && session.paper_audit;
  if (!a || !a.at) return null; // 没跑过审计
  return (a.must_fix || 0);
}
function autoFinished(session, root) {
  if (['review', 'blind'].includes(session.task_scope)) return !!session.task_completion && require('./acceptance').completionBlockers(root, session).length === 0;
  const qg = session.question_graph || [];
  if (!qg.length || qg.some(q => q.status !== 'committed')) return false;
  let pdf = false;
  try { pdf = fs.existsSync(path.join(root, 'paper', 'main.pdf')); } catch { pdf = false; }
  if (!pdf) return false;
  const paperProfile = require('./contest_quality').usePaperProfile(session);
  if (require('./contest_workflows').rulesBlockers(session).length) return false;
  if (require('./delivery_evidence').evidenceBlockers(root, session, { final: true }).length) return false;
  if (!session.contest && !paperProfile) return true; // 非比赛普通会话：旧判据
  // 比赛会话：必须显式走到 final（contest_clock op=phase phase=final）且论文无【必须修】
  const phase = spiral.effectivePhase(session);
  if (session.contest && phase !== 'final') return false;
  if (paperProfile || session.contest) {
    if (require('./contest_quality').paperAuditBlockers(root, session).length) return false;
    if (require('./support_integrity').freshSupportBlockers(root, session.support_pack, require('./contest_workflows').supportPolicy(session), require('./contest_workflows').supportRequirements(session)).length) return false;
    if (!session.abstract_check || session.abstract_check.must_fix) return false;
  }
  return paperHardIssues(session) === 0;
}
// 未完成时给模型的续推提示：说明当前卡在哪一关（基线 → 迭代 → 冻结 → 交付）
function nextStepHint(session, root) {
  if (['review', 'blind'].includes(session.task_scope)) return session.task_scope === 'review'
    ? '按审稿范围工作：review_snapshot固定待审文件；用review_finding登记实际问题，报告写findings/reviews/，task_finish登记范围与产物。原稿变化后重审，不要求重写论文或全题重算。'
    : '按盲测任务书完成独立实现、真实计算与源码/机器结果/报告；用task_finish登记本范围，不要求无关论文或整题提交。';
  const qg = session.question_graph || [];
  const notDone = qg.filter(q => q.status !== 'committed');
  if (!qg.length) return '任务表为空——先读题、contract_register、question_graph 登记各问。';
  if (notDone.length) {
    // 守恒门禁是 commit 的前置项，卡在 commit 的会话需要知道下一步该调什么。
    // 提示生成器**绝不能把一轮搞挂**：测试桩替换 tools 模块时这个符号可能是 undefined，
    // 所以先 typeof 判再调（只影响提示文字，不影响门禁本身）。
    let needCons = [];
    try {
      if (session.mode === 'math' && typeof conservationGate === 'function') {
        needCons = notDone.filter(q => !conservationGate(session, q.id).ok).map(q => 'Q' + q.id);
      }
    } catch { needCons = []; }
    return `未 committed：${notDone.map(q => 'Q' + q.id).join('、')}——继续求解、link_run/attach_artifact 后 commit。`
      + (needCons.length ? `\n守恒/平衡审计还没登记：${needCons.join('、')}——用 conservation_check 登记实算闭合（须来自 formal 运行），或 op="not_applicable" 写明替代检验。` : '');
  }
  let pdf = false;
  try { pdf = fs.existsSync(path.join(root, 'paper', 'main.pdf')); } catch {}
  if (!pdf) return '各问已 committed 但 paper/main.pdf 尚未编译——paper_build 铺模板并写论文。';
  if ((require('./contest_quality').usePaperProfile(session) || session.contest)
      && (!session.contest || spiral.effectivePhase(session) === 'final')) {
    const pending = require('./contest_quality').paperAuditBlockers(root, session)
      .concat(require('./support_integrity').freshSupportBlockers(root, session.support_pack, require('./contest_workflows').supportPolicy(session), require('./contest_workflows').supportRequirements(session)))
      .concat(require('./delivery_evidence').evidenceBlockers(root, session, { final: true }));
    pending.push(...require('./contest_workflows').rulesBlockers(session));
    const hard = paperHardIssues(session);
    if (hard == null || hard > 0) pending.unshift(`论文审计${hard == null ? '尚未完成' : '仍有' + hard + '项必须修'}，运行 paper_build 后修复`);
    if (!session.abstract_check || session.abstract_check.must_fix) pending.push('摘要检查尚未通过，修复后用 abstract_check(path) 检查最终稿');
    if (pending.length) return require('./contest_workflows').packageFor(session).label + '交付尚未完成：' + pending.join('；');
  }
  if (!session.contest) return '旧完成判据已满足。';
  const phase = spiral.effectivePhase(session);
  if (session.contest) return require('./contest_workflows').phaseGuidance(phase, session)
    + (phase === 'final' ? '\n技术工作已收口；AI详情关键交互、人工采纳/修改、核心工作独立性和签署按真实状态报告，不能据此称已可提交或已提交。' : '');

}
const SUB_MAX_ITER = 30;
// 同一工具连续失败达到该次数后：本会话内禁用该工具，只能换路或问用户
const TOOL_FAIL_HARD = 3;
// 同一签名调用连续重复达到该次数后：硬停止本轮
const LOOP_HARD = 3;
// 原地打转检测（防死循环第二层，视频说的"重复任务去重"在数模场景的落地）：
// LOOP_HARD 只抓"连续完全相同"，模型换个措辞重试就能绕过；真正打转的模式是
// "反复读/反复失败的写、没有任何产出"——连续 STALL_HARD 轮零产出（无成功计算/写文件/
// 登记动作）就停轮让它总结卡点。15 轮先警告一次（给转向机会）。
const STALL_WARN = 15, STALL_HARD = 35;
// 本工具调用哪些算"有产出"：成功的计算（python_run/shell_run）、写盘、登记类动作。
// 纯读类（fs_read/grep/kb_search/skill_load…）与失败的调用不算——打转正是这些动作的循环。
const PRODUCTIVE_TOOLS = new Set(['fs_write', 'fs_edit', 'fs_move', 'fs_copy', 'fs_delete',
  'plugin_run', 'optimization_check',
  'formula_register', 'contract_register', 'question_graph', 'lesson_record', 'skill_save',
  'memory_write', 'job_start', 'dispatch_external', 'rollback_artifact', 'flowchart_draw', 'paper_build',
  'assumption_register', 'iteration', 'contest_clock', 'support_pack', 'independent_verify', 'result_compare', 'verification_run', 'review_finding', 'review_snapshot', 'task_finish', 'release_freeze', 'conservation_check', 'memory_audit']);

// "provider:model" 内部标识 → 实际发给厂商的纯模型名（前缀绝不能进 API 请求）
function apiModelOf(model, providerKey) {
  return providerKey && model && model.startsWith(providerKey + ':') ? model.slice(providerKey.length + 1) : model;
}

// 判断一次工具调用是否构成「计算证据」（证据门禁的口径：成功跑过计算 ≠ todo/读文件）
// 子代理报告不算计算证据——「另一个模型说过这个数字」不能成为数字正确的证据；
// 子代理产生的真实运行另行记录到 session.child_runs（带 child_run_id 链接）。
function isComputeTool(name, args) {
  if (name === 'python_run') return true;
  if (name === 'shell_run') {
    const c = String((args && args.command) || '').trim();
    // 依赖安装与纯展示命令不构成计算证据（echo hello 放行不了任何数值主张）
    if (/^(pip|pip3|npm|pnpm|yarn)(\.exe)?\s/i.test(c)) return false;
    if (/^(echo|type|dir|cls|ver|whoami|cd|chcp|title|pause|rem|set)(\s|$|\?)/i.test(c)) return false;
    return true;
  }
  return false;
}

// ---------- 证据链 v2.2（bzd-latest 复审落实） ----------
// 输入文件扩展名（代码 + 数据）：快照追踪这些文件的变化 → data_epoch 递增 → 旧运行过期。
// CSV/JSON 等数据文件既可能是原始输入也可能是生成输出，无法按扩展名区分——统一纳入追踪：
// 误报方向是"多质询一次"（安全），漏报方向是"旧输入配旧答案"（危险），宁可保守。
const DATA_EXTS = new Set(['.py', '.m', '.r', '.jl', '.cpp', '.c', '.h', '.java', '.csv', '.json', '.dat', '.xlsx', '.mat', '.sql']);

// 结构指纹（v2.3）：区分"格式级变更"与"算法级变更"。
// 仅改 import 顺序、注释、变量重命名 → struct_fp 不变 → 不 ++ epoch。
// def/class/函数签名/函数体变了 → struct_fp 变 → ++ epoch（旧版会因注释改动全过期——C 题 2026 教训）。
// 同一文件用 content hash 配合结构指纹联合判定：hash 变 + struct 不变 = 格式级；hash 变 + struct 变 = 算法级。
function structuralFingerprint(fullPath, content) {
  const ext = path.extname(fullPath).toLowerCase();
  if (ext === '.py') {
    const sigs = [];
    // def/class 签名 + 函数体 hash（C 题 2026 P1b2 教训：只签名不算，函数体变要算算法级；
    // P1b2b 教训：注释/空白变不算 → 剥注释 + 规范化空白后 hash）
    const re = /^[ \t]*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->[^:]+)?:\s*$/gm;
    let m;
    // 简易 Python 规范化：剥行内注释（# 后到行尾）+ 三引号字符串；保留空行；collapse 尾随空白
    function normPy(s) {
      return s
        .replace(/"""[\s\S]*?"""/g, '')             // 三引号字符串（docstring）
        .replace(/'''[\s\S]*?'''/g, '')             // 三单引号字符串
        .replace(/(^|\s)#.*$/gm, '$1')              // 剥行内 # 注释
        .replace(/[ \t]+$/gm, '')                   // 剥每行尾随空白
        .split('\n').map(x => x.trimEnd()).join('\n');
    }
    while ((m = re.exec(content))) {
      const params = m[2].split(',').map(x => x.trim()).filter(x => x && x !== 'self' && x !== 'cls');
      // 抓函数体：从此 def 行起，到下一个 0 缩进行（同级 def/class）止
      const start = m.index;
      const rest = content.slice(start);
      const lines = rest.split('\n');
      let bodyEnd = lines.length;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] && !/^[ \t]/.test(lines[i])) { bodyEnd = i; break; }
      }
      const body = lines.slice(0, bodyEnd).join('\n');
      const bodyHash = crypto.createHash('md5').update(normPy(body)).digest('hex').slice(0, 8);
      sigs.push(`${m[1]}/${params.length}#${bodyHash}`);
    }
    const imports = [];
    const re2 = /^\s*(?:from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import|import\s+([A-Za-z_][A-Za-z0-9_.]*))/gm;
    while ((m = re2.exec(content))) imports.push(m[1] || m[2]);
    const tops = [];
    const re3 = /^[A-Z][A-Z0-9_]{1,}\s*=/gm;
    while ((m = re3.exec(content))) tops.push(m[0].trim().replace(/\s*=\s*$/, ''));
    return `py|sig:${sigs.sort().join(',')}|imp:${[...new Set(imports)].sort().join(',')}|top:${tops.sort().join(',')}`;
  }
  if (ext === '.m') {
    const sigs = [];
    const re = /^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
    let m;
    while ((m = re.exec(content))) {
      const params = m[2].split(',').map(x => x.trim()).filter(Boolean);
      // MATLAB 函数体：到下一个 function/end 止（简化：抓到 end 行）
      const start = m.index;
      const rest = content.slice(start);
      const lines = rest.split('\n');
      let bodyEnd = lines.length;
      for (let i = 1; i < lines.length; i++) {
        if (/^\s*(?:function|end\s*%?)\s*[;\(]?$/m.test(lines[i]) || /^\s*function\s/.test(lines[i])) { bodyEnd = i; break; }
      }
      const body = lines.slice(0, bodyEnd).join('\n');
      const bodyHash = crypto.createHash('md5').update(body).digest('hex').slice(0, 8);
      sigs.push(`${m[1]}/${params.length}#${bodyHash}`);
    }
    return `m|sig:${sigs.sort().join(',')}`;
  }
  if (ext === '.sql') {
    const tables = [];
    const re = /(?:FROM|INTO|UPDATE|TABLE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    let m;
    while ((m = re.exec(content))) tables.push(m[1]);
    return `sql|t:${[...new Set(tables)].sort().join(',')}`;
  }
  // 其他扩展：空指纹 → 任何 hash 变更都被视为算法级
  return '';
}

// 数值文本规范化：Unicode 减号（U+2212，从 PDF/公式复制常见）与全角负号归一为 ASCII '-'
function normNumText(s) {
  return String(s).replace(/\u2212/g, '-').replace(/\uFF0D/g, '-');
}

// 数值主张句的关键词（中英同检）：只有命中关键词的句子里的数值才进入核验
// 数值主张句的关键词门。命中即视为「在做数值结论」进证据核验。
// 华数杯复审补充：只有名词类关键词（结果/误差/成本类）时，「下降 12.4%」「标准差 3.2 万元」
// 这类最常见的结论句式一个都不命中 → 整句的数字全部绕过证据门禁（假阴性，比误报危险）。
// 补入比较/变化类动词，仍是白名单而不是「句中有数字就查」，避免把叙述性数字也算主张。
const NUM_CLAIM_RE = /(最优|最大|最小|结果|结论|误差|准确率|精度|指标|得分|预测|通过|达到|阈值|显著|p值|p-value|用车|方案数|迭代|收敛|残差|概率|置信|风险|有效率|命中率|存活率|下降|上升|提升|增加|减少|降低|高于|低于|超过|标准差|方差|均值|平均| optimal|maximum|minimum|result|conclusion|error|accuracy|precision|metric|score|predict|probability|confidence|RMSE|MAE|MAPE|decrease|increase|reduce|std|variance|R2|R²)/i;
// 来源标记：仅当明确指向「题给/原文位置」时豁免（题目第N页/题给/题目给定/附件/文献…）。
// 旧版裸匹配「题目/来源/参考」——"根据题目计算结果为999"里的"题目"不是来源标记（复审反例）。
const SOURCE_MARK_RE = /(题目第\s*\d+\s*页|题给|题目给定|题目要求|原文|附件|题面|文献|引用了|参考文献|式\s*[（(]\s*\d|给定)/;

// 单位别名（长前缀在前）：key=单位族，scale=相对族的倍率（万元≠元——复审单位倍率反例）
const UNIT_ALIASES = [
  { s: '万元', key: 'yuan', scale: 1e4 },
  { s: '千元', key: 'yuan', scale: 1e3 },
  { s: '元', key: 'yuan', scale: 1 },
  { s: '小时', key: 'h', scale: 1 }, { s: 'hr', key: 'h', scale: 1 }, { s: 'h', key: 'h', scale: 1 },
  { s: '分钟', key: 'min', scale: 1 }, { s: 'min', key: 'min', scale: 1 },
  { s: '秒', key: 's', scale: 1 }, { s: 'sec', key: 's', scale: 1 }, { s: 's', key: 's', scale: 1 },
  { s: '千米', key: 'km', scale: 1 }, { s: '公里', key: 'km', scale: 1 }, { s: 'km', key: 'km', scale: 1 },
  { s: '厘米', key: 'cm', scale: 1 }, { s: 'cm', key: 'cm', scale: 1 },
  { s: '米', key: 'm', scale: 1 }, { s: 'm', key: 'm', scale: 1 },
  { s: '%', key: 'pct', scale: 1 }, { s: '％', key: 'pct', scale: 1 }, { s: '百分之', key: 'pct', scale: 1 },
  { s: '摄氏度', key: 'C', scale: 1 }, { s: '℃', key: 'C', scale: 1 }, { s: '°c', key: 'C', scale: 1 }, { s: '度', key: 'C', scale: 1 },
  { s: '千克', key: 'kg', scale: 1 }, { s: '公斤', key: 'kg', scale: 1 }, { s: 'kg', key: 'kg', scale: 1 },
  { s: '克', key: 'g', scale: 1 }, { s: 'g', key: 'g', scale: 1 },
  { s: '摩尔', key: 'mol', scale: 1 }, { s: 'mol', key: 'mol', scale: 1 },
];
function unitFamily(text) {
  const t = String(text || '').trim().toLowerCase();
  for (const u of UNIT_ALIASES) {
    if (t.startsWith(u.s.toLowerCase())) return { key: u.key, scale: u.scale };
  }
  return null;
}

// 数值 token（带符号与指数，先做 Unicode 减号归一）：-123.45 / 1.23e-9 / 820 / 0
const NUM_TOKEN_RE = /[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// 量词语境（华数杯复审 P1：日志「阈值=0.90」不能验证正文「导通概率0.90」——数字相同、
// 数学对象不同）。主张与证据两侧都识别出量词时，两个集合必须相交；证据是裸输出
// （无量词）时不卡量词（无法推断含义），由单位与数值约束兜底。
const QUANTITY_WORDS = [
  { re: /(概率)|\bprobability\b|\bprob\b/i, key: 'prob' },
  { re: /(p值)|\bp[- ]?value\b/i, key: 'pval' },
  { re: /(阈值|门限|临界)|\bthreshold\b|\bthresh\b/i, key: 'thresh' },
  { re: /(成本|费用|开销)|\bcost\b/i, key: 'cost' },
  { re: /(误差|偏差)|\berror\b/i, key: 'err' },
  { re: /(残差)|\bresidual\b|\bresid\b/i, key: 'resid' },
  { re: /(时间|耗时)|\btime\b/i, key: 'time' },
  { re: /(最优)|\bopt(imal|imum)?\b/i, key: 'opt' },
  { re: /(浓度)|\bconcentration\b|\bconc\b/i, key: 'conc' },
  { re: /(温度)|\btemperature\b|\btemp\b/i, key: 'temp' },
  { re: /(数量|个数|用车数|方案数|根数|样本数|人数|辆|个)|\bcount\b|\bnumber\b|\bnA\b|\bnB\b/i, key: 'count' },
];
function quantityKeys(ctxText) {
  const keys = new Set();
  const t = String(ctxText || '');
  for (const q of QUANTITY_WORDS) if (q.re.test(t)) keys.add(q.key);
  return keys;
}

// 数值主张分类：基于「题给常数/派生 vs 计算结果」分类
// - 紧邻显式来源标记（题目第N页/题给/附件/文献...）→ 题给常数
// - 同一句含代数推导关键词（= / 比例 / 比值 / 占比 / 等于 / 总长 / 半径÷长 / 类比于 / R/L / ρ/）→ 代数派生
//   这些是题目常数的代数组合，不构成"模型计算结果"，不应被证据门禁要求运行背书
//   （A 题教训：模型写「R/L = 0.08 = 端面面积占比」被误伤要求运行证据）
// - 其他 → 实际计算结果，需要运行背书
const DERIVATION_MARK_RE = /(=|比例|比值|占比|等于|总长|总宽|总和|类比|之比|除以|乘以|÷|\/L|\/R|半径\W*[/÷]|长度\W*[/÷])/i;
function classifyClaimToken(sent, tok) {
  // 整句是题给常数 / 引用值
  if (SOURCE_MARK_RE.test(sent)) return 'given';
  // 含代数推导关键词 → 派生
  if (DERIVATION_MARK_RE.test(sent)) return 'derived';
  return 'computed';
}

// 从「数值主张句」提取待核验数值（含单位与倍率）。位数不决定数学重要性——
// 「最优用车数2」「p值0.04」「阈值0.15」「残差为0」都要查（复审：零误差结论恰是高风险漏检）。
// 排除：年份、序数（第N页/问）、紧邻来源标记的题给常数、代数派生（= / 比例 / 比值 / 占比）。
function extractClaimNumbers(text) {
  const out = [];
  const seen = new Set();
  const src = normNumText(text);
  const sentences = String(src || '').split(/(?:[。！？；!?;\n]+)/);
  for (const sent of sentences) {
    if (!NUM_CLAIM_RE.test(sent)) continue;
    // 整句层面分类：题给/派生 → 全部数值豁免
    const sentClass = classifyClaimToken(sent, '');
    if (sentClass !== 'computed') continue; // given 或 derived 整句跳过
    NUM_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = NUM_TOKEN_RE.exec(sent))) {
      const tok = m[0];
      const before = sent.slice(Math.max(0, m.index - 18), m.index);
      // 紧邻来源标记 → 题给常数/引用值，非计算结果
      if (SOURCE_MARK_RE.test(before)) continue;
      // 标识符里的数字不是数值主张：run1/fig2/x3 的尾数会被 NUM_TOKEN_RE 当成裸数字，
      // 而句子照样过 NUM_CLAIM_RE、前面也没有来源标记 → 恒判「缺运行背书」。
      // stateBlock 正是把 run_id 交给模型去引用的（agent.js:1651），引一次就多一个
      // 永远无法满足的缺口（实测摘要里一句「（见 run1）」凭空多出未背书数字「1」）。
      // 只卡紧邻左字符是 ASCII 词字符的情形：CJK 左邻（「下降12.4%」无空格）不受影响；
      // 右侧绝不能卡——单位就靠右侧字母识别（「123.4 万元」「3.2 万元」）。
      if (/[A-Za-z0-9_]/.test(sent[m.index - 1] || '')) continue;
      // 派生（按 token 上下文再核一次——例如某句同时含"="和"计算"则按 computed）
      if (classifyClaimToken(sent, tok) === 'derived') continue;
      const digits = tok.replace(/[+-]/g, '').replace('.', '').replace(/^0+/, '').replace(/e[+-]?\d+$/i, '');
      const isZero = /^[-+]?0*(?:\.0+)?$/.test(tok);
      if (!digits && !isZero) continue; // 零值主张必须核验（"残差为0"），其余空 token 跳过
      // 年份（4位裸整数在1900-2099；不含 0.xxx 与科学计数）
      if (/^(19|20)\d{2}$/.test(tok)) continue;
      // 序数（第N页/问/步）
      if (/第\s*$/.test(before)) continue;
      const after = sent.slice(m.index + tok.length, m.index + tok.length + 8).trimStart();
      // 单位识别：先查单位别名表（含倍率）；否则仅接受纯字母/符号单位（h、s、kg、%…）
      let fam = unitFamily(after);
      if (fam == null) {
        const m2 = /^[a-zA-Zμ°℃%]+/.exec(after);
        fam = m2 ? { key: m2[0], scale: 1 } : null;
      }
      const key = tok + '|' + (fam ? fam.key : '') + '|' + (fam ? fam.scale : 1);
      if (seen.has(key)) continue;
      seen.add(key);
      // 量词语境（±16字）随主张携带：核验时与证据侧量词必须相交
      const qty = quantityKeys(sent.slice(Math.max(0, m.index - 16), m.index + tok.length + 16));
      out.push({ token: tok, unitKey: fam ? fam.key : null, scale: fam ? fam.scale : 1, qty });
    }
  }
  return out;
}

// 数值匹配（语义级）：
// - 符号必须一致（含 Unicode 减号归一后的 −123.45 vs +123.45）
// - 指数必须一致（1.23e-9 不被 1.23e+9 验证）：token 级解析，数值比较
// - 无子串匹配（“123”不能命中“91234”）：按主张小数位做舍入容差
// - 单位族一致 + 倍率换算（“123万元”不被“123元”验证；同族不同倍率按换算后量值比较）
// - 主张带单位而证据是裸数字：接受（程序输出常不带单位）；证据带单位且族不同：拒绝
function tokenTolerance(tok) {
  if (/[eE][+-]?\d+$/.test(tok)) {
    const mant = tok.replace(/[eE][+-]?\d+$/, '');
    const sig = mant.replace(/[+-]/, '').replace('.', '').length;
    return { rel: 0.5 * Math.pow(10, -(sig - 1)) * 1.0000001 }; // 有效位数的半个末位
  }
  const dec = (tok.split('.')[1] || '').length;
  return { abs: dec > 0 ? 0.5 * Math.pow(10, -dec) * 1.0000001 : 1e-9 }; // 整数主张须精确命中
}

function numberInEvidence(claim, evidence) {
  const ev = normNumText(evidence);
  const cRaw = parseFloat(claim.token);
  const cVal = cRaw * (claim.scale || 1);
  const tol = tokenTolerance(claim.token);
  NUM_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = NUM_TOKEN_RE.exec(ev))) {
    const tok = m[0];
    const after = ev.slice(m.index + tok.length, m.index + tok.length + 8).trimStart();
    let evidUnit = unitFamily(after);
    if (evidUnit == null) {
      const m2 = /^[a-zA-Zμ°℃%]+/.exec(after);
      evidUnit = m2 ? { key: m2[0], scale: 1 } : null;
    }
    // 单位（复审 P1）：主张带单位时，证据必须带同族单位——裸数字不能验证带单位的主张
    //（"57.17" 不能验证 "57.17小时"；正式结果须显式单位，质询会强制这一点）
    if (claim.unitKey != null && (evidUnit == null || evidUnit.key !== claim.unitKey)) continue;
    // 量词语境（复审 P1）：两侧都有量词时必须相交（"阈值0.90"不能验证"概率0.90"）
    if (claim.qty && claim.qty.size) {
      const ectx = ev.slice(Math.max(0, m.index - 16), m.index + tok.length + 16);
      const eqty = quantityKeys(ectx);
      if (eqty.size && ![...claim.qty].some(k => eqty.has(k))) continue;
    }
    const v = parseFloat(tok) * (evidUnit ? evidUnit.scale : 1);
    let ok;
    if (tol.rel != null) ok = v !== 0 && cVal !== 0 && Math.abs((v - cVal) / cVal) <= tol.rel;
    else ok = Math.abs(v - cVal) <= tol.abs * (claim.scale || 1);
    if (ok) return true;
  }
  return false;
}

// 主张级证据核验：数值主张句里的每个数值（含零值），都必须能在「当前代码/数据版本
// （data_epoch）」成功运行的输出摘录里找到。证据绑定的数学输入版本，不是 LLM 名称——
// 换模型审阅不使可信计算失效；改代码/数据/公式/题目契约才失效。
// 华数杯复审 P1 的证据资格收紧：
// - 会话登记过公式后，只有「正式求解」（formal:true 或声明 uses_formulas）构成证据——
//   探索运行可执行，但其数值不进入正式证据（省略依赖声明不能产出"已验证"）；
// - 运行期间修改了已存在输入文件的运行标记 unstable，不作证据（先读旧参数、算完再改
//   参数文件的输出属于旧版输入，不能按新版认证）。
// frag=true 时 content 视为「片段文本」（如摘要）：仍用同一套主张提取与证据匹配，
// 但返回值额外带上逐条主张明细，供 abstract_check 定位到具体数字。
function checkNumericEvidence(content, session, frag = false) {
  const claimed = extractClaimNumbers(content);
  if (!claimed.length) return { numeric: false, missing: [], claimed: [], details: [] };
  const epoch = session.data_epoch || 0;
  const hasFormulas = (session.formulas || []).length > 0;
  const local = isLocalTask(session);
  const focusId = session.task_focus?.entered_at;
  // 主证据来自 session.runs；子代理报告不直接构成主会话的数值证据——
  // 「另一个模型说过这个数字」不是计算证据。子代理的真实运行记录在 child_runs，
  // 仅作子代理自身内部验证（reviewer 重算一致性），主代理引用时必须给出 child_run_id。
  const fresh = (session.runs || []).filter(r => r.ok && (r.epoch || 0) === epoch && r.out
    && !r.unstable && (local
      ? r.task_scope === 'local' && r.focus_id === focusId
      : r.task_scope !== 'local' && (!hasFormulas || r.formal)));
  const evidence = fresh.map(r => r.out).join('\n');
  const label = (c) => c.token + (c.unitKey ? c.unitKey : '');
  const details = claimed.map(c => ({ label: label(c), token: c.token, unit: c.unitKey, qty: c.qty ? [...c.qty] : [], ok: numberInEvidence(c, evidence) }));
  const missing = details.filter(d => !d.ok).map(d => d.label);
  return { numeric: true, missing, claimed: claimed.map(label), details };
}

// 输入文件快照：path → 内容身份。≤1MB 文件用内容哈希（同 size 同 mtime 的改写也能
// 抓到——复审 P2：path+size+mtime 不是内容身份）；大文件退化为 size+mtime（哈希成本）。
// v2.3：联合存 hash + 结构指纹，refreshInputStamp 据此区分"格式级"与"算法级"变更。
// 检测所有不经 fs 工具的输入变更——python/shell 运行期改写、轮间外部编辑。
// 排除引擎自身输出目录与产出型目录——其内文件由本系统主动覆盖，是正常结果产物而非
// 输入变化（华数杯复审：覆盖 result.csv 不应被误判为改输入，否则每次仿真都被反复
// 质询和重算）。
// 华数杯 C 题实战事故（2026-09-23）：findings/、figures/、paper/、result*.xlsx、
// data/pycache、data/pytemp 不在排除集——python_run 每覆盖一次 result.xlsx 或写
// findings/*.json，就被 stampInputFiles 当成"运行期改写已存在输入"→ unstable=true +
// data_epoch++，42 个 run 全 ⚠unstable，question_graph commit 门禁全拒，Q1-Q4 卡
// reviewing。产出文件被覆盖不是输入污染——快照层就不该采它们。
const ENGINE_OUTPUT_DIRS = new Set(['runs', '.run', '.attachments', '.trash', 'recycle', '.git',
  'figures', 'findings', 'paper', 'pycache', 'pytemp', '__pycache__',
  // 脚本自产的中间结果目录（华数杯 C v2.4 实测：写 data/q1_summary.json 被判改写输入→commit 被拒）
  'outputs', 'results', 'verification_runs', 'exp_repro']);
// 交付物命名：result*.xlsx（result_align/reconcile_artifact 的主输出，python_run 常规覆盖写）。
// 注意 result.csv 不在此列——沿用既有测试口径（根目录 result.csv 仍按输入追踪，保守方向）。
const RESULT_ARTIFACT_RE = /^result.*\.xlsx$/i;
// 统一判据：路径是否属于"产出型写"（快照排除集 + 交付物文件名）。
// commit 门禁重判历史 run 的 unstable_files 时用同一判据——改一处两处生效。
// 后缀清理：unstable_files 里可能带 '（被删除）'/' (new)' 尾注。
function isProductiveWritePath(p) {
  const s = String(p || '').replace(/（[^）]*）/g, '').replace(/\s*\([^)]*\)\s*$/, '').trim().replace(/\\/g, '/');
  if (!s) return false;
  if (/^submission\/releases(?:\/|$)/i.test(s)) return true;
  const segs = s.split('/');
  const base = segs[segs.length - 1];
  if (RESULT_ARTIFACT_RE.test(base)) return true;
  // 任一级目录在产出集内 / 以 . 开头（快照本来就不采点目录与点文件）
  return segs.slice(0, -1).some(seg => ENGINE_OUTPUT_DIRS.has(seg) || seg.startsWith('.'));
}
function stampInputFiles(root) {
  const map = {};
  const stack = [root];
  let n = 0;
  while (stack.length && n < 2000) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === '__pycache__' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      // Project templates are application metadata, not numerical inputs. Their changes
      // affect future sessions, and must not invalidate the frozen session's experiments.
      if (dir === root && e.name === 'project.json') {
        try {
          const metadata = JSON.parse(fs.readFileSync(full, 'utf8'));
          const keys = ['id', 'title', 'createdAt', 'dir', 'external', 'contest_profile', 'modeling_plan'];
          if (metadata.id === path.basename(root) && typeof metadata.title === 'string'
              && typeof metadata.createdAt === 'number' && Object.keys(metadata).every(key => keys.includes(key))) continue;
        } catch {}
      }
      if (/^submission\/releases(?:\/|$)/i.test(path.relative(root, full).replace(/\\/g, '/'))) continue;
      if (e.isDirectory()) {
        // 引擎自身输出目录——其内任何文件变化都是结果产物，不是输入变化
        if (ENGINE_OUTPUT_DIRS.has(e.name)) continue;
        stack.push(full); continue;
      }
      if (!DATA_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      // 产出型文件名（result*.xlsx 交付物）不采快照——覆盖写是正常产物不是输入污染
      if (RESULT_ARTIFACT_RE.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        let hash, struct = '';
        if (st.size <= 1024 * 1024) {
          try {
            const buf = fs.readFileSync(full);
            hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
            struct = structuralFingerprint(full, buf.toString('utf8'));
          } catch { hash = st.size + ':' + Math.floor(st.mtimeMs); }
        } else {
          hash = st.size + ':' + Math.floor(st.mtimeMs);
        }
        map[path.relative(root, full)] = { hash, struct };
        n++;
      } catch {}
    }
  }
  return map;
}

function inputStampHash(stamp) {
  const rows = Object.keys(stamp || {}).sort().map(p => [p, String((stamp[p] && stamp[p].hash) || '')]);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// 输入版本刷新：快照出现差异（增/删/改）→ data_epoch 递增（旧运行证据过期）。
// v2.3：分类
//   - 算法级变更（hash + struct 都变，或文件新增/删除）→ ++ epoch + warn
//   - 格式级变更（hash 变但 struct 不变，如改注释/import 顺序/变量重命名）→ 仅 info，不 ++ epoch
// 调用点：轮开始（外部编辑基线）、每次计算工具后（运行期改写——成功失败都刷，复审
// "写后报错沿用旧证据"路径）、每次文件工具后（fs 写/改/删代码或数据，成败都刷）。
// precomputed 可传入已算好的快照（调用方刚算过时避免重复哈希）。
function refreshInputStamp(session, ctx, emitSafe, precomputed) {
  try {
    const after = precomputed || stampInputFiles(ctx.workspace);
    const before = session.input_stamp_map;
    if (before) {
      const algoChanged = [];    // 算法级：触发 epoch++
      const fmtChanged = [];     // 格式级：仅 info
      for (const p of Object.keys(after)) {
        const a = after[p], b = before[p];
        if (!b) continue;
        if (a.hash !== b.hash) {
          if (a.struct && b.struct && a.struct === b.struct) {
            fmtChanged.push(p);
          } else {
            algoChanged.push(p);
          }
        }
      }
      // 文件消失 / 新增 → 算法级
      for (const p of Object.keys(after)) { if (!(p in before)) { algoChanged.push(p + ' (new)'); break; } }
      for (const p of Object.keys(before)) { if (!(p in after)) { algoChanged.push(p + ' (deleted)'); break; } }
      const hasFresh = (session.runs || []).some(r => r.ok && (r.epoch || 0) === (session.data_epoch || 0));
      if (algoChanged.length && hasFresh) {
        session.data_epoch = (session.data_epoch || 0) + 1;
        if (session.mode === 'math') emitSafe({ t: 'warn', msg: `[算法级变更] 检测到 ${algoChanged.length} 个文件（hash+结构指纹同时变化）—此前运行结果对后续数值主张视为过期，受影响结论需重算。文件: ${algoChanged.slice(0, 3).join('、')}${algoChanged.length > 3 ? '…' : ''}` });
      }
      if (fmtChanged.length && session.mode === 'math') {
        // 仅格式级：不 ++ epoch（防止改注释触发整个证据链过期——C 题 2026 教训）
        emitSafe({ t: 'warn', msg: `[格式级] ${fmtChanged.length} 个文件仅 import/注释/重命名变化，结构指纹不变——不触发证据过期。文件: ${fmtChanged.slice(0, 3).join('、')}${fmtChanged.length > 3 ? '…' : ''}` });
      }
    }
    session.input_stamp_map = after;
  } catch { /* 快照失败不阻塞任务 */ }
}

// 公式依赖检查（执行层，华数杯复审 P1 补全）：
// 1) 声明的依赖名必须真实存在——拼错/虚构的名字直接报错（旧版只查已登记名，拼错即绕过）；
// 2) 声明的依赖中有 tests_failed 公式 → 拒绝（原有）；
// 3) 正式求解（formal:true 或声明了 uses_formulas）时，会话存在任何 tests_failed 公式
//    即拒绝——省略依赖声明不能绕过（探索运行放行，但其结果不作正式证据）。
function formulaDepsBlock(session, name, args) {
  if (name !== 'python_run' && name !== 'shell_run') return null;
  const modelBlock = specGate(session, args);
  if (modelBlock) return modelBlock;
  const formulas = session.formulas || [];
  const failed = formulas.filter(f => f.state === 'tests_failed');
  const deps = Array.isArray(args && args.uses_formulas) ? args.uses_formulas.map(String) : [];
  const known = formulas.map(f => f.name);
  const unknown = deps.filter(d => !known.includes(d));
  if (unknown.length) {
    return `uses_formulas 中的 ${unknown.join('、')} 未在本会话登记（可能拼错）。已登记公式：${known.join('、') || '无'}。请修正依赖名后重试；若公式尚未登记，先 formula_register。`;
  }
  const declaredFailed = deps.filter(d => failed.some(f => f.name === d));
  if (declaredFailed.length) {
    return `依赖的公式 ${declaredFailed.join('、')} 处于 tests_failed 状态（测试点与期望值不一致），已拒绝执行正式求解。请对照原题逐字符核对后重新 formula_register（修正表达式或期望值）；不依赖该公式的工作不受影响。`;
  }
  const isFormal = !!(args && (args.formal === true || deps.length > 0));
  if (isFormal && failed.length) {
    return `本会话存在未通过测试的公式（${failed.map(f => f.name).join('、')}），正式求解（formal/uses_formulas）被拒绝——省略依赖声明不能绕过。请先修正公式并重新登记通过测试；探索性计算可不带 formal 运行，但其数值不会作为正式证据。`;
  }
  return null;
}

// 决策状态分类：resolved（选定给定项）/ custom（自定义方案）/ deferred（暂缓）/
// ambiguous（模糊）/ rejected（明确否定某选项）/ delegated（明确委托智能体定夺）。
// 「不要采用X」绝不能记成选中X（deepseek-glm 复审 P1：否定反向记录）；
// 「你决定」是明确委托（技能规范：用户明确委托时可推进），不是暂缓。
const DEFER_RE = /^(暂缓|稍后|以后再说|先不决定|先不|待定|都行|随便|defer|later)[，。!！.\s]*$/i;
const AMBIG_RE = /^(继续|好|好的|嗯+|哦+|噢+|ok|okay|可以|行|收到|明白|知道了|continue|go on)[，。!！.\s]*$/i;
const DELEGATE_RE = /^(你决定|你来决定|交给你|听你的|你选|你来选|你看着办|看着办|you decide)/i;
const NEG_PREFIX_RE = /^(不要|不能|不可以|别|不用|不采用|不选|拒绝|排除|否决|去掉)/;
function classifyDecision(answer, options) {
  const a = String(answer || '').trim();
  const opts = (options || []).map(o => String(o).trim());
  const hit = opts.find(o => o && (o === a || (o.length >= 3 && (a.includes(o) || o.includes(a)))));
  if (hit) {
    // 否定检测：整体以否定词开头，或命中子串之前出现否定词 → rejected，绝不记成选中
    const before = a.slice(0, Math.max(0, a.indexOf(hit)));
    if (NEG_PREFIX_RE.test(a) || /不|别|拒|排除|否决/.test(before)) {
      return { status: 'rejected', rejected_option: hit };
    }
    return { status: 'resolved', chosen_option: hit };
  }
  if (DELEGATE_RE.test(a)) return { status: 'delegated' };
  if (DEFER_RE.test(a)) return { status: 'deferred' };
  if (AMBIG_RE.test(a)) return { status: 'ambiguous' };
  return { status: 'custom', custom_text: a };
}

// 运行记录：编号用持久单调序号（run_seq），与 runs 数组截断彻底解耦（审计 P2 的重复 run201）。
// 每条带模型标签 + 数据版本 + 输出摘录 + 参数签名，供主张核验与追溯。
// 旧会话（无 run_seq 字段）迁移：从现存编号推算起点，避免新记录从 1 重编与旧记录冲突。
function recordRun(session, { tool, ok, ms, modelTag, out, sig, formal, unstable, unstable_files, deps, boundary_mode, key_params, inputHash, origin, modelSpec, taskScope, focusId, resultArtifacts }) {
  if (!session.run_seq) {
    session.run_seq = (session.runs || []).reduce((mx, r) => Math.max(mx, parseInt(String(r.run_id || '').replace(/\D/g, '')) || 0), 0);
  }
  session.run_seq = session.run_seq + 1;
  session.runs = session.runs || [];
  session.runs.push({
    run_id: 'run' + session.run_seq, t: Date.now(), tool, ok: !!ok, ms: ms || 0,
    model: modelTag, epoch: session.data_epoch || 0, out: out || '', sig: sig || '',
    formal: !!formal, unstable: !!unstable,
    ...(taskScope === 'local' ? { task_scope: 'local', focus_id: focusId } : {}),
    model_spec: modelSpec || null,
    result_artifacts: resultArtifacts || null,
    // ISS-10：记运行期被改写的输入文件清单，供 commit 门禁逐项输出拒绝原因
    unstable_files: Array.isArray(unstable_files) && unstable_files.length ? unstable_files.slice(0, 5) : undefined,
    deps: Array.isArray(deps) ? deps : [],
    // P1-3：run_meta 记录可复现关键元数据
    // - boundary_mode: 环境边界外推方式（tail_mean / tail_end / tail_constant / interpolation），跨解对比可按 mode 分组
    // - key_params: 关键参数签名（如 D1=7e-9·exp(-0.89/C)、ρ=820, cp=2600, k=0.36, h=25, hm=8e-7）—— 公式/参数变了，旧结果自动失效
    boundary_mode: boundary_mode || null,
    key_params: key_params ? String(key_params).slice(0, 800) : null,
    input_hash: inputHash || null,
    origin: origin || null,
  });
  if (session.runs.length > 200) session.runs.shift();
  return 'run' + session.run_seq;
}

// ---------- 系统提示（会话创建时冻结 → 前缀缓存根基） ----------
function baseSystem(root, settings, mainModel) {
  const configuredMain = String(mainModel || settings?.role_models?.modeler || settings?.default_model || '当前配置模型');
  const judgeOn = settings?.decision_judge?.enabled === true;
  return `你是「羲和 Agent」，运行在用户本机的桌面智能体，当前主脑模型为 ${configuredMain}。唯一可写工作区（沙箱根目录）：${root}
当前时间：${new Date().toLocaleString('zh-CN', { hour12: false })}（会话内固定，勿再询问）

## 铁律（工具层强制执行，违反会直接报错）
1. 所有 fs_* / shell / python 操作限定在上面的目录内；不要尝试读写用户主目录、系统盘、其他项目。技能库经 skill_load/skill_search 只读访问。
2. 删除永远进回收站（fs_delete 自动完成，绝不物理删除）；覆盖已有文件自动留 .bak 快照。
3. shell 命令中禁止引用工作区外盘符绝对路径、禁止用 .. 相对路径逃逸；需要外部命令（matlab、pip、git）时用相对路径。
4. 图片理解走 vision_read（识图模型在设置中配置：默认 GLM 视觉桥；DeepSeek V4.1-Flash 等多模态模型也可直读）。PDF 题目先用 python(fitz) 渲染成 PNG 再逐页 vision_read。
5. python_run 受守卫约束：写文件仅限工作区、禁止派生子进程（外部命令用 shell_run）、默认禁网（抓网页用 web_fetch）。这是正常约束不是报错。shell 里禁止直调 python/node（绕过守卫）；MATLAB 仅限 matlab -batch。

## 工作区附件不可见时的兜底（A 题教训）
工作区根（${root}）里看到空 source/、附件读不到、fs_ls 反复返回空，但磁盘上文件存在时——通常是上游复制未同步到沙箱视图。**不要反复 ask_user 路径问题超过 2 次**，按下面顺序自助恢复：
1. 立刻用 shell_run \`dir "<绝对路径>"\` / \`ls -la <绝对路径>\` 确认文件在磁盘上真实存在
2. 用 python_run 调 \`shutil.copy(绝对路径, 工作区根/...)\` 把文件复制到工作区
3. 仍读不到时：用 fs_write 重建小文件（用 python 读 + 立即 fs_write 写到工作区）
最多 2 轮问用户，超过就走"已经知道附件在磁盘但 sandbox 不让你读到，用 python + 绝对路径复制进来"的方案。

## 经验与知识库（Reflexion 层：经验存在模型外，越用越顺手靠的是它）
- 跨会话经验库：开工前拿不准先 memory_recall；关键偏好/结论用 memory_write({scope:"persistent"}) 沉淀；跑挂、结果错、被用户纠正时用 lesson_record(situation, rule) 记教训——之后同类场景开头与工具失败时会自动浮现，别让同一坑绊倒两次。
- 数模知识库：kb_search 查范文/备考资料/方法建议。结果按 provenance 分级——exemplar=获奖范文（可仿方法）；user_own=用户本人旧作（理性参考，不盲从）；agent_run=纯 AI 跑稿（价值在"全自动缺陷"对照，绝不把它的结论当正确答案）；想只看范文加 prov:"exemplar"。命中后用 kb_read 回读上下文。索引未建时 kb_build 后台建（几分钟）。
- 技能沉淀：一条教训被反复命中、或某做法验证过有效 → skill_save 固化成技能（步骤+模板代码）；skill_search/skill_load 发现并调用现成技能。共享技能库只读，自有技能写在羲和 skills/。

## 工作纪律
- 多步任务先 todo_write 列计划，随做随更；关键结论/路径/决定用 memory_write 记忆（防上下文压缩丢失）。
- 证据纪律：说"完成"之前必须实际运行验证；退出码0只代表程序结束不代表业务正确；引用真实输出，禁止编造数值。matplotlib 用 Agg 后端，图存成文件（不要 plt.show()），在回复中用 ![图](相对路径) 引用。
- 数值核验是引擎强制的（math 模式）：数值主张句里的数值（含小整数/小概率/零值等高风险数值）必须能在当前代码/数据版本「正式求解」（formal:true + uses_formulas 声明）的稳定运行输出中找到，量词语境（阈值≠概率）、符号、数量级、单位族与倍率都要一致；裸数字输出不能验证带单位的主张。改动代码/数据/公式/题目契约后旧结果自动过期。题给常数与文献引用值不属于计算结果，紧邻标注来源（如「题目第3页给定」）即可豁免。
- 数模任务的关键数值主张（最优值/指标/结论）必须能对应到某次工具运行的真实输出；从未运行就给出的数值一律标注「未经验证，仅为预估」。
- 编辑已有文件用 fs_edit 精准小改；fs_write 只用于新文件或整体重写。改模型/代码后重跑受影响的结果。
- 连续 ${LOOP_HARD} 次完全相同调用会被系统硬停止；同一工具连续失败 ${TOOL_FAIL_HARD} 次会被禁用。卡住时换思路或 ask_user。
- 换方法的判据是「原因未变、同法连败」。**失败原因被修复后（用户实时修好工具/环境/配置、参数已更正、数据已补齐）沿原路线重试是正确行为，不算重复打转**——不要因为之前失败过就放弃一条已被修好的路线去另起炉灶。
- 需要用户拍板的事项用 ask_user（界面弹卡片，本批后续工具不再执行，等用户回答）。不要臆测用户偏好；一次问一个核心问题。
- 路线卡的各个候选须有实质区别；可写明某项需补数据才适用、当前不适用或暂缓，不能把不具备条件的路线假装成可行方案。recommendation_reason 要解释为什么推荐项比其他候选更适合题目目标、现有数据和剩余赛时；只有一个有依据的候选时，说明为什么不列其他方案，不要为凑卡片虚构；没有运行证据时写“待验证”，不要编造比较实验。示例：“题目只需解释已观测关系，现有样本可支持基线回归；复杂预测模型需额外时序样本，机理模型缺参数，因此先采用可检验基线。”用户可先追问，追问不代表采纳。
${judgeOn ? '- 有恰好三个已经成形的有限候选、需要快速做路由或重复性筛选时，可调用 decision_judge 做独立初筛；它只收恰好 3 个候选，只给选择、置信度和升级信号。Jev 与主模型推荐不一致、置信度低于设置门槛、接口不可用或任务涉及开放式创新/核心假设/最终论文时，必须保留主模型或人的裁决并升级，不能把它当作证明或一票否决。\n' : ''}- 长计算通过 job_start 入队；只在任务幂等且能安全重跑时设 retryable:true/max_attempts。无需继续独立工作时用 job_wait({ids:[job_id]}) 暂停本轮，任务结束后由系统恢复同一主会话，不循环调用 job_status 空等。后台成功仅是进程完成，结果仍需正式证据门禁；子代理仅返回 job_id 给主会话。

## 成本纪律（DeepSeek 按前缀缓存计价，未命中最高可达命中价的数倍）
- 系统提示与会话历史不可变；你的每次回复都会成为缓存前缀的一部分。
- 读大文件用行区间；已经读过的内容记住要点，不要反复重读；工具结果很长时在后续引用要点即可。
- 上下文接近上限时羲和会自动压缩历史并保留 memory_write 的关键记忆。

## 外部调度纪律（稀缺资源，省着用）
dispatch_external 可升级到 ChatGPT 网页版 / Codex 桌面版（用户额度有限）/ GLM 网页 / DeepSeek 网页。仅当：
(a) 同一子问题连续两次验证失败且无新思路；(b) 用户明确要求；(c) 任务明确需要多模态或更强推理且收益清晰。
调用时必须给出 reason，并一次性写好自包含的完整提示词（对方看不到本会话任何上下文）。`;
}

const MODE_APPENDIX = {
  code: `
## 当前模式：软件编程
- 小步快跑：写完即运行、报错读完整栈再改，不盲改。
- 新功能先想清楚接口和边界，复杂任务先写最小可运行骨架再迭代。
- 依赖安装用 pip/npm，安装前说明用途。测试通过才算完成。`,
  math: `
## 数学建模比赛质量检查
按题目和附件确定各问交付量、适用方法与证据。逐问说明题给条件与新增假设、变量单位、数学表达、求解步骤、实际答案及其检验。结论要能追溯到正式运行、解析推导或题目给定数据。
- 机理/守恒问题：用 conservation_check 登记实际闭合残差；不适用守恒的题，使用 not_applicable 并说明替代检验。question_graph.commit 会核对这一状态。涉及数值离散时按误差风险做网格或步长收敛，解析解不凑网格。
- 优化问题：回代原约束并核验可行性，再比较目标值。预测问题：区分时序和非时序划分，避免训练数据泄漏。统计问题：精确公式/枚举检验归一性或回代，随机模拟记录种子、重复运行及离散度。
- 参数或情景有不确定性且可能改变答案时，针对有依据的范围做敏感性或稳健性检验。若答案已由精确推导确定，无需为凑项目做随机重复或机械扰动。
- 明确约定会改变结果时，在 question_graph.conventions 登记实际使用的求解器、容差、边界口径等。统计类在 conventions.statistics_method 写 exact 或 stochastic；预测类在 conventions.prediction_structure 写 time_series 或 cross_sectional。需要与附件结果表逐格对照时使用 spreadsheet_diff。
- 异常大的改善、零值或与题给基线明显矛盾的结果先回查约束、数据口径和单位，再决定是否采纳；需要人决策时展示有依据的候选。

## 竞赛论文
以当届规则和题目交付为准组织章节，不强套某题、某年的固定目录。摘要逐问交代方法、真实结果与结论，数值同正文和运行证据一致；没有必要的数字不强塞。图表和流程图按信息增益选用，表格或解析结论已清楚时不补装饰图。排版完成后逐页查看 PDF 的公式、图表、字号和页码。
- main.tex 使用 LaTeX 语法；正文陈述避免无证据的夸大形容词。`,
  free: '',
};

// math 模式技能按当前模型选择可用适配版：优先加载与模型匹配的数学建模技能，
// 加载失败逐级回退，最后按通用数模流程执行。
const { MATH_SKILLS, mathSkill: pickMathSkill } = require('./contest_workflows');

// P0-2：项目级约定注入
// 工作区根若有 CLAUDE.md/AGENTS.md/AGENT.md，自动读入并注入到 system prompt 末尾。
// 这些文件是用户/CI/项目维护的"本地铁律"——比如「MATLAB 主解、Python 仅独立审计」，
// 必须硬编码进模型推理上下文，而不能在每条用户消息里再读一次。
// 读不到就静默跳过，不影响默认行为。
// 查找路径：工作区根 → appDir 上一级（项目源根）→ appDir 自身（兜底）
const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'AGENT.md'];
function loadProjectConventions(root, appDir) {
  if (!root) return '';
  const candidates = [];
  candidates.push(root);
  // 向上跳一级找项目源（例如工作区项目目录的上一级可能是题目源目录）
  if (appDir) {
    let p = path.resolve(appDir, '..');
    for (let i = 0; i < 4 && p !== path.dirname(p); i++) {
      candidates.push(p);
      p = path.resolve(p, '..');
    }
  }
  let txt = '';
  for (const dir of candidates) {
    for (const fname of CONVENTION_FILES) {
      try {
        const p = require('path').join(dir, fname);
        if (!require('fs').existsSync(p)) continue;
        const c = require('fs').readFileSync(p, 'utf8').trim();
        if (c) {
          txt += '\n\n## 项目约定（自动读自 ' + dir + '/' + fname + '，**整会话有效**）\n' + c;
          return txt; // 找到第一个就返回
        }
      } catch {}
    }
  }
  return txt;
}

function buildSystem(mode, root, settings, appDir, providerKey, skillOverride, session) {
  const mainModel = session && (session.model || session.resolved_model)
    || settings?.role_models?.modeler
    || settings?.default_model
    || providerKey;
  if (isLocalTask(session)) return `你是「羲和 Agent」，当前主脑模型为 ${mainModel}。可写工作区：${root}。
当前是同一聊天中暂停主线后的临时任务。只处理用户当前局部请求；完成必要的工具操作和核验后直接答复并停止，不推进原赛题、论文、阶段或后台等待。用户返回主线后才恢复原流程。
所有文件和命令遵守沙箱与审批；真实运行才能支持计算结论，输入文件变化仍会使旧证据失效。不要编造工具执行或数值结果。需要决定本次任务的关键分支时用 ask_user；普通小问题直接答复。`;
  let s = baseSystem(root, settings, mainModel) + MODE_APPENDIX[mode] || '';
  // v2.5 第九轮：deep 档追加高成本模式规则段（重手法清单 + 成本纪律）。
  // 放在 system（而非每轮注入的 user 消息）——深度在会话内不变，前缀缓存友好。
  if (modes.isExtreme(session)) s += modes.EXTREME_APPENDIX;
  else if (modes.isDeep(session)) s += modes.DEEP_APPENDIX;
  // P0-2：自动注入项目级约定 CLAUDE.md（位于工作区根）
  // 解决 A 题教训：项目铁律「MATLAB 主解，Python 仅独立审计」必须硬编码进 system prompt，
  // 不让模型在每条用户消息里重新读、每次会话都重选主解语言
  s += loadProjectConventions(root, appDir);
  const contractParam = (TOOLS.find(t => t.name === 'contract_register') || {}).params;
  const contractKinds = contractParam && contractParam.items && contractParam.items.items && contractParam.items.items.properties.kind.enum || [];
  if (mode === 'math') {
    // 本次会话指定的技能优先（UI 里选过一次就一直生效）；没选就走按提供商的自动链
    const frozen = session?.skill_plan_snapshot;
    const pinnedMain = frozen?.entries?.find(row => row.slot === 'main');
    const chain = frozen ? (pinnedMain?.status === 'loaded' && !pinnedMain.blocked ? [pinnedMain.name] : [])
      : require('./contest_workflows').skillChain(providerKey, skillOverride, session);
    let skillBlock = null;
    const tried = [];
    const skillFallbacks = [];
    for (const name of chain) {
      tried.push(name);
      try {
        const r = projectPlan.loadSessionSkill(appDir, session, name, null, settings, { slot: 'main', mode: 'replace' });
        const refs = r.refs.length ? `\n可用参考文件（skill_load("${name}", file) 按需读取，别一次全读）：\n${r.refs.map(x => '- ' + x).join('\n')}` : '';
        skillBlock = `\n\n## 数学建模模式（已加载技能 ${r.name} v${r.version}，只读引用）\n` +
          `羲和平台适配：问答窗口=ask_user 工具；文件/Shell/Python 工具真实可用（工作区=${root}）；${modes.isDeep(session) ? 'subagent_run 可派独立子代理（reviewer 写操作会被执行层拒绝）；' : ''}vision_read 读题图片；本技能提到的 skill 均可用 skill_load 加载。\n` +
          `公式纪律（引擎强制）：题给关键公式（系数函数、边界条件等）必须先 formula_register 登记（来源页码 + ≥2 个有区分力的测试点，远离盲区值）再投入使用；读题转录出的公式要与原题图核对页码。\n` +
          `题目契约纪律（引擎强制，读题后第一件事）：用 contract_register 登记关键题设——实体定义（几何对象、尺寸）、越界/边界规则、单位、目标、关键假设，各带原文位置（题目第N页/附件）。可用 kind 与工具 schema 同源：${contractKinds.join('/')}。契约独立于聊天摘要存活（长对话压缩不丢），修订会自动作废旧结果。历史教训：几何/实体对象理解错了（如越界处理方式），后面所有精细计算跟着错——契约是第一道防线。\n` +
          `逐问任务表纪律（引擎强制）：按题目实际问题数，用 question_graph({op:"upsert", id, title, route, status, deps, assumptions, experiments}) 维护数模问题级状态；上游问题修订（路线/假设/备注）可能触发下游问题实验失效传播。状态机：drafting → reviewing → committed；committed 状态须实验数据完整且与依赖项假设一致才能标。\n` +
          `正式求解纪律（引擎强制）：会话登记过公式后，正式计算必须带 formal:true 与 uses_formulas（声明依赖的公式名，拼错会被拒）；探索性计算可省略，但其数值不构成证据。关键几何/物理假设先构造解析反例验证（如端面间距、越界裁剪、守恒与极限情形）——反例不通过时不得进入大规模计算，应回到建模阶段。\n` +
          `以下为技能正文：\n\n${wrapMaterial(r.content, { kind: 'skill', source: r.file })}${refs}`
          + require('./skill_quality').qualityWarning(appDir, r.sha256, settings);
        break;
      } catch (e) {
        if (frozen) throw new Error('冻结的主Skill无法读取，保留原版本而未静默替换：' + e.message);
        skillFallbacks.push(`${name}（${String(e.message || e).slice(0, 120)}）`);
      }
    }
    if (skillBlock) {
      s += skillBlock;
      if (skillFallbacks.length) s += `\n[技能加载回退] ${skillFallbacks.join('；')}；实际使用上方所列技能，不要按首选技能名归因。`;
    } else s += `\n\n## 数学建模模式\n（数模技能加载失败（已尝试 ${tried.join('、')}；${skillFallbacks.join('；')}）按通用数模流程执行：读题→选路→形式化→数据基线→主解→验证→写作→终审，关键选择 ask_user。`;
  }
  if (mode === 'math') s += projectPlan.composedBlock(appDir, session, settings, wrapMaterial);
  if (mode === 'math') s += '\n\n' + materialPolicyBlock() + '\n\n' + require('./contest_quality').contestWritingBlock(session)
    + '\n\n' + require('./contest_workflows').workflowBlock(session);
  if (session?.task_scope === 'review') s += '\n【当前任务仅审稿】先review_snapshot列明待审文件并固定版本；读取和Python审查走冻结副本，新增待审文件须重新建立完整快照。原稿保持只读，报告写findings/reviews/；用review_finding登记实际问题，允许未发现问题。task_finish说明实际覆盖与限制，审稿结束不表示原稿通过，不开展无关全题求解或重写论文。本段优先于完整赛事求解流程。';
  if (session?.task_scope === 'blind') s += '\n【当前任务仅独立盲测】仅按本次任务书与可见原始输入独立设计实现；完成真实计算、源码、机器结果、报告后task_finish，不要求额外整题论文与提交包，不把局部完成称为整题完成。本段优先于完整赛事交付要求。';
  return s;
}

// 附件清单摘要：上传附件已被自动解析，把关键元数据（页数/文本层/工作表名）注入
// stateBlock——避免模型为了「这个 PDF 有没有文本」再花一次 vision_read 的钱。
function attachmentBlock(session) {
  const manifest = session.attachment_manifest || [];
  if (!manifest.length) return '';
  const lines = manifest.slice(-15).map(a => {
    if (a.kind === 'pdf') return `📄 ${a.name}（${(a.bytes / 1024).toFixed(1)}KB，${a.pages} 页${a.has_text_layer ? '，含文本层' : '，⚠无文本层需 vision_read'}，标题猜测:${a.title_guess || '—'}）`;
    if (a.kind === 'xlsx') return `📊 ${a.name}（${(a.bytes / 1024).toFixed(1)}KB，${(a.sheets || []).length} 表：${(a.sheets || []).slice(0, 5).join('/')}）`;
    if (a.kind === 'docx') return `📝 ${a.name}（${(a.bytes / 1024).toFixed(1)}KB，约 ${a.paragraphs} 段，标题:${a.title_guess || '—'}）`;
    if (a.kind === 'image') return `🖼 ${a.name}（${(a.bytes / 1024).toFixed(1)}KB）`;
    if (a.kind === 'text') return `📃 ${a.name}（${(a.bytes / 1024).toFixed(1)}KB，${a.lines} 行）`;
    return `📎 ${a.name}（${(a.bytes / 1024).toFixed(1)}KB）`;
  });
  return `\n附件清单（已自动解析，仅最近 ${Math.min(manifest.length, 15)} 项）:\n${lines.join('\n')}\n`;
}

// ---------- 工具调用参数修复 ----------
// 只做「无损」修复（去码栏、去尾逗号）；未闭合的截断 JSON 直接拒绝执行——半截参数猜补后执行副作用太危险。
function safeParseArgs(s) {
  if (!s || !s.trim()) return {};
  try { return JSON.parse(s); } catch {}
  let t = s.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch {}
  // 去尾部逗号
  t = t.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(t); } catch {}
  throw new Error(`工具参数不是合法JSON（疑似截断，已拒绝执行而非猜测补全）。原始前200字符: ${s.slice(0, 200)}\n请重新完整发送该工具调用。`);
}

// ---------- 费用纳管（主调用/子代理/压缩/视觉共用同一账本与预算） ----------
// v2.6：金额不再只固化在账本里——每次调用同时写一条 token 明细（data/meter/<day>.jsonl），
// 花费由「明细 × 当前价目表」现算（core/meter.js）。ledger 的累加**保留**：预算是实时熔断用的，
// 不能变成一次磁盘查询。kind 区分调用来源（main/sub/summarize/vision）。
function makeSpend(session, deps) {
  const { ledger, settings, appDir, emit } = deps;
  return function spend(model, usage, kind, partial = false) {
    const u = session.usage;
    u.prompt_tokens += usage.prompt_tokens || 0;
    u.completion_tokens += usage.completion_tokens || 0;
    u.cache_hit_tokens += usage.cache_hit_tokens || 0;
    u.calls += 1;
    const cost = costOf(model, usage, settings.prices);
    u.cost = +(((u.cost || 0) + cost).toFixed(6));
    ledger.costs = ledger.costs || {};
    const today = dayKey();
    ledger.costs[today] = +(((ledger.costs[today] || 0) + cost).toFixed(4));
    try {
      require('./meter').record(appDir, {
        t: Date.now(), model, kind: kind || 'main',
        session_id: session.id || null, project_id: session.project_id || null,
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        cache_hit_tokens: usage.cache_hit_tokens || 0,
        ...(partial ? {usage_partial:true} : {}),
      });
    } catch { /* 记账失败不拖垮本轮对话 */ }
    const { saveLedger } = require('./external');
    saveLedger(appDir, ledger);
  };
}

function budgetCheck(session, deps, emitSafe) {
  const { settings, ledger } = deps;
  if (!(settings.daily_budget > 0)) return true;
  const spentToday = (ledger.costs && ledger.costs[dayKey()]) || 0;
  if (spentToday >= settings.daily_budget) {
    emitSafe({ t: 'error', msg: `今日开销已达预算上限 ¥${spentToday.toFixed(2)}/${settings.daily_budget}，熔断。可在设置中调整预算。` });
    return false;
  }
  // 预警降档不改变 100% 硬顶：75% 时 extreme→deep，90% 时 deep→fast。
  // system_effort 不在这里写，runTurn 会因档位不一致自动重建系统提示。
  const ratio = spentToday / settings.daily_budget;
  const from = modes.effortOf(session);
  const to = from === 'extreme' && ratio >= 0.75 ? 'deep' : from === 'deep' && ratio >= 0.90 ? 'fast' : null;
  if (to) {
    session.effort = to;
    session.effort_downgrade = { at: Date.now(), from, to, reason: 'budget', spent: spentToday, budget: settings.daily_budget };
    emitSafe({ t: 'warn', msg: `预算预警 ¥${spentToday.toFixed(2)}/${settings.daily_budget}：已从 ${from} 降到 ${to}。已有池产物保留；100% 硬顶仍然生效。` });
  }
  return true;
}

// ISS-08：turn 级错误落盘助手——把 SSE 仅发的错误补写进 session.messages（外部推送可见）
// 并写 session.last_error（结构化字段，供 API 查询/重试决策）。所有 error 退出路径必须经此。
function failTurn(session, deps, emitSafe, reason, detail) {
  const msg = `[系统·本轮失败] ${reason}` + (detail ? `\n${String(detail).slice(0, 800)}` : '') + '\n（轮已终止，会话可继续；用户/推送方据此判断是否重试或换方法）';
  session.messages.push({ role: 'user', content: msg });
  session.last_error = { at: Date.now(), reason, detail: String(detail || '').slice(0, 800), kind: require('./recovery').failureKind(reason, detail), needs_attention: true };
  emitSafe({ t: 'error', msg: reason + (detail ? '：' + String(detail).slice(0, 200) : '') });
  emitSafe({ t: 'done', reason: 'error' });
  session.status = 'idle';
  try { saveSession(deps, session); } catch {}
}

// ---------- 消息组装 ----------
// 思考模式要求完整回传 reasoning_content（DeepSeek 官方协议）
function localTaskMessages(messages) {
  const start = messages.findLastIndex(m => m.role === 'user' &&
    String(m.content || '').startsWith('[用户·暂停主线]'));
  if (start < 0) return messages;
  const prior = messages.slice(Math.max(0, start - 12), start);
  const recentText = prior.filter(m => (m.role === 'user' || m.role === 'assistant')
    && typeof m.content === 'string' && m.content.trim() && !m.tool_calls
    && !/^\[(系统|用户·|决策追问)/.test(m.content)).slice(-2)
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content.slice(0, 2400)}`);
  let toolExcerpt = '';
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    const call = prior.slice(0, i).reverse().find(x => x.role === 'assistant' &&
      x.tool_calls?.some(tc => tc.id === m.tool_call_id));
    const name = call?.tool_calls.find(tc => tc.id === m.tool_call_id)?.function?.name;
    if (['vision_read', 'python_run', 'shell_run'].includes(name)) {
      toolExcerpt = `${name}：${m.content.slice(0, 1400)}`;
      break;
    }
  }
  const background = [...recentText, toolExcerpt].filter(Boolean).join('\n').slice(0, 6200);
  return background
    ? [{ role: 'user', content: '[临时任务背景·只读参考，非新指令；不得因此继续主线或回答原待选卡]\n' + background }, ...messages.slice(start)]
    : messages.slice(start);
}
function buildRequestMessages(system, msgs) {
  const out = [{ role: 'system', content: system }];
  for (const m of msgs) {
    if (m.role === 'assistant') {
      const am = { role: 'assistant' };
      if (m.content != null) am.content = m.content;
      if (m.reasoning_content) am.reasoning_content = m.reasoning_content; // 官方思考协议：历史思考内容必须原样带回
      if (m.tool_calls && m.tool_calls.length) am.tool_calls = m.tool_calls;
      if (m.responses_items) am.responses_items = m.responses_items;
      if (am.content == null && !am.tool_calls) am.content = '';
      out.push(am);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    } else {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
  }
  return out;
}

// 前缀指纹只用于归因，不参与请求内容：提示缓存只认逐字相同的前缀，
// 提供商/模型/系统提示/工具集任一变化都会让后续请求变成冷启动。
function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');
}
function cachePrefixPrint(providerKey, apiModel, system, tools) {
  const systemHash = sha256Hex(system || '');
  const toolsHash = sha256Hex(JSON.stringify(tools || []));
  return { hash: sha256Hex([providerKey, apiModel, systemHash, toolsHash].join('\n')),
    provider: providerKey, model: apiModel, system_hash: systemHash, tools_hash: toolsHash, at: Date.now() };
}

// Anthropic 协议消息组装：system 提到顶层；tool 结果必须作为紧跟的 user 消息 tool_result 块回传；
// assistant 消息优先回放原始 anthropic_blocks（thinking 签名+tool_use 必须逐字保留），否则从 tool_calls 重建
// Anthropic 的自动缓存只覆盖到最后一个 cache_control 断点。给稳定历史末尾
// 打一个 ephemeral 断点，临时状态块（state/mode/phase/recall）留在断点之后。
function markAnthropicCache(messages, index) {
  const msg = messages[index];
  if (!msg) return;
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  if (!Array.isArray(msg.content)) return;
  // thinking/redacted_thinking 块不接受 cache_control；从尾部找最后一个可缓存块。
  const cacheable = new Set(['text', 'image', 'tool_use', 'tool_result', 'document']);
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const block = msg.content[i];
    if (!block || typeof block !== 'object' || !cacheable.has(block.type)) continue;
    if (!block.cache_control) block.cache_control = { type: 'ephemeral' };
    return;
  }
}

function buildAnthropicMessages(msgs) {
  const out = [];
  const flushToolResults = (acc) => {
    if (!acc.length) return;
    out.push({ role: 'user', content: acc });
  };
  let pendingToolResults = [];
  const push = (msg) => {
    flushToolResults(pendingToolResults); pendingToolResults = [];
    // 合并连续同角色消息（Anthropic 要求 user/assistant 交替）
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      last.content = [].concat(last.content, msg.content);
    } else out.push(msg);
  };
  for (const m of msgs) {
    if (m.role === 'assistant') {
      let blocks;
      if (Array.isArray(m.anthropic_blocks) && m.anthropic_blocks.length) {
        blocks = m.anthropic_blocks.map(b => ({ ...b })); // 逐字回放（thinking 签名在内）
      } else {
        blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of (m.tool_calls || [])) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      if (!blocks.length) blocks.push({ type: 'text', text: m.content || '' });
      push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      pendingToolResults.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    } else {
      push({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
  }
  flushToolResults(pendingToolResults);
  // Anthropic 要求首条消息是 user
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length) out.push({ role: 'user', content: '(空)' });
  return out;
}

// ---------- 主循环 ----------
// 历史协议完整性修复（ISS-07）：进程级死亡/外部杀死会把「assistant.tool_calls 已落盘、
// 对应 tool 结果永远缺席」的毒化历史留在 session.messages 里——此后每轮请求都因
// 「assistant.tool_calls 必须每个都有配对 tool 结果」被提供商 400 秒拒，会话永久砖化。
// 1180 行附近的 stopper 补齐逻辑只覆盖 turn 内主动停止，覆盖不到进程级死亡路径，
// 故在 runTurn 入口对全量历史做一次补洞。就地原位插入 tool 结果（紧跟该 assistant 块尾部），
// 保持 compactHistory「assistant(tool_calls)+tool 结果同组切割」的分组结构不被打穿。
function repairProtocolIntegrity(session, deps, emitSafe) {
  const msgs = session.messages || [];
  const answered = new Set();
  for (const m of msgs) if (m.role === 'tool' && m.tool_call_id) answered.add(m.tool_call_id);
  let repaired = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant' || !m.tool_calls || !m.tool_calls.length) continue;
    let j = i + 1;
    while (j < msgs.length && msgs[j].role === 'tool') j++; // 该 assistant 的 tool 结果块区间
    const fills = [];
    for (const tc of m.tool_calls) {
      if (!tc.id || answered.has(tc.id)) continue;
      fills.push({ role: 'tool', tool_call_id: tc.id, content: '[系统] 该调用期间发生中断，未保存执行结果，是否执行成功未知。请先核对已有产物和后台任务；不要直接重放可能已经发生的写入或计算。' });
    }
    if (fills.length) { msgs.splice(j, 0, ...fills); repaired += fills.length; i = j + fills.length - 1; }
  }
  if (repaired) {
    if (emitSafe) emitSafe({ t: 'warn', msg: `历史协议完整性修复：补齐 ${repaired} 条因中断缺失的 tool 结果（会话曾被进程级杀死）。` });
    saveSession(deps, session);
  }
  return repaired;
}

async function runTurn(session, deps, userInput) {
  const { emit, stopper, settings, ledger, appDir, sandbox } = deps;
  const emitSafe = (ev) => { try { emit(ev); } catch {} };

  if (userInput && userInput.action === 'clarify') {
    const { question } = validateClarification(session.pendingQuestion, userInput);
    const q = session.pendingQuestion;
    const restoreCard = () => {
      session.status = 'waiting_input';
      saveSession(deps, session);
      emitSafe({ t: 'question', ...q });
      emitSafe({ t: 'done', reason: 'ask_user' });
    };
    let clarificationModel = session.model || settings.default_model;
    try {
    if (stopper.stop) throw new Error('追问已停止');
    if (settings.daily_budget > 0 && ((ledger.costs && ledger.costs[dayKey()]) || 0) >= settings.daily_budget) throw new Error('今日预算已用完，追问未调用模型');
    const resolved = resolveRoleModel({ role: !session.model && session.mode === 'math' ? 'modeler' : null,
      settings, appDir, sessionModel: session.model || settings.default_model, sessionExplicit: !!session.model });
    if (!resolved.ok) throw new Error(resolved.warnings.join('；') || '模型不可用');
    clarificationModel = apiModelOf(resolved.model, resolved.providerKey);
    const key = keyFor(resolved.providerKey, appDir);
    if (!key) throw new Error('追问所用模型缺少 API Key');
    const context = (session.messages || []).filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string'))
      .slice(-8).map(m => `${m.role}: ${String(m.content).slice(0, 1200)}`).join('\n').slice(-6000);
    const specs = (session.model_specs || []).map(r => ({ id: r.id, current: r.epoch === (session.data_epoch || 0), task: r.spec.task, givens: r.spec.givens, assumptions: r.spec.assumptions, algorithm: r.spec.algorithm, optimization: r.spec.optimization })).slice(-8);
    const instruction = isLocalTask(session)
      ? '你只解释当前临时任务的局部决策卡，不能代用户选择、修改决策或宣称执行了工具。没有数据或运行证据时明确说明待验证，简明回答用户追问。'
      : '你只解释当前数学建模比赛决策卡，不能选择方案、修改决策或宣称执行了实验。以已登记的当前题目条件为准；卡片推荐或假设不等于题给事实，若卡片与规格矛盾须指出并建议在选择前修正。过期规格只能作为历史参考。没有数据或运行证据时明确说明待验证。回答要简明，并说明对推荐判断有无影响。';
    const prompt = `当前卡片：${JSON.stringify(q)}\n已登记模型规格（结构校验不代表数学正确）：${JSON.stringify(specs).slice(0, 18000)}\n最近上下文：${context}\n用户追问：${question}`;
    const provider = resolved.provider;
    const clarificationMaxTokens = Math.min(4000, Math.max(1200, Number(settings.max_output_tokens) || 2400));
    const reasoningPlan = resolveReasoning(settings, resolved.providerKey, provider, apiModelOf(resolved.model, resolved.providerKey));
    const result = await callWithReasoning(chatStream, provider.kind === 'anthropic'
      ? { kind: 'anthropic', base: provider.base, key, model: apiModelOf(resolved.model, resolved.providerKey), system: instruction,
        messages: [{ role: 'user', content: prompt }], tools: [], maxTokens: clarificationMaxTokens, signal: deps.abort.signal }
      : { base: provider.base, key, model: apiModelOf(resolved.model, resolved.providerKey),
        kind: provider.kind,
        messages: [{ role: 'system', content: instruction }, { role: 'user', content: prompt }], tools: [], maxTokens: clarificationMaxTokens,
        signal: deps.abort.signal }, reasoningPlan, reasoningRecorder(session, emitSafe, 'clarify'));
    if (result.usage) makeSpend(session, deps)(apiModelOf(resolved.model, resolved.providerKey), result.usage, 'main');
    if (stopper.stop || deps.abort.signal.aborted) throw new Error('追问已停止');
    if (result.tool_calls && result.tool_calls.length) throw new Error('追问回答意外请求执行工具，已拒绝');
    const answer = String(result.content || '').trim();
    if (!answer) throw new Error('追问没有得到有效回答，请重试');
    session.clarifications = session.clarifications || [];
    session.clarifications.push({ decision_id: q.decision_id, question, answer, at: Date.now() });
    if (session.clarifications.length > 100) session.clarifications.shift();
    session.messages.push({ role: 'user', content: `[决策追问 ${q.decision_id}] ${question}` });
    session.messages.push({ role: 'assistant', content: answer });
    emitSafe({ t: 'assistant_msg', content: answer });
    } catch (error) {
      if (error.usage) makeSpend(session, deps)(clarificationModel, error.usage, 'main', !!error.usage_partial);
      emitSafe({ t: 'warn', msg: '追问未完成：' + error.message + '。原决策仍待选择。' });
    }
    restoreCard();
    return;
  }

  // Validate before history repair, message append, status changes, or model calls.
  if (userInput?.action !== 'retry' && (session.wait_reason?.kind === 'decision_text' || session.last_error) && isVagueContinuation(userInput?.text)) {
    if (session.wait_reason) session.status = 'waiting_input';
    emitSafe({ t: 'warn', msg: '当前决策需要处理；重复“继续”不会调用模型。' });
    emitSafe({ t: 'done', reason: 'waiting_for_decision' });
    saveSession(deps, session);
    return;
  }
  if (session.pendingQuestion?.candidates && session.collab_mode === 'auto' && !isLocalTask(session) && !userInput?.decision) {
    userInput = { ...userInput, decision: { decision_id: session.pendingQuestion.decision_id, selected_id: session.pendingQuestion.recommended_id } };
  }
  const structuredAnswer = validateResponse(session.pendingQuestion, userInput && userInput.decision);
  repairProtocolIntegrity(session, deps, emitSafe);

  if (userInput && userInput.text) {
    session.messages.push({ role: 'user', content: userInput.text });
  }
  if (session.wait_reason?.kind === 'decision_text' && userInput?.text) {
    session.decisions = session.decisions || [];
    session.decisions.push({ question: session.wait_reason.question, answer: userInput.text, source: 'human', status: 'answered', at: Date.now() });
  }
  session.wait_reason = null;
  session.last_error = null;
  // 决策卡（持久化的人的选择）：上一轮 ask_user 的问答落到 session.decisions，
  // 刷新/重启/换模型后仍在。回答按四态分类：resolved/custom/deferred/ambiguous——
  // 「继续」这类模糊回复不记为任何方案确认；依赖该选择的工作需再次明确询问。
  if (session.pendingQuestion && userInput && (userInput.text || structuredAnswer)) {
    const q = session.pendingQuestion;
    const automaticAnswer = structuredAnswer && session.collab_mode === 'auto' && !isLocalTask(session)
      ? { selected_id: q.recommended_id, rationale: '全自动采用显式推荐：' + (q.recommendation_reason || recommendedChoice(q).basis) } : null;
    const cls = structuredAnswer ? decisionRecord(q, automaticAnswer || structuredAnswer, automaticAnswer ? 'system_auto' : 'human')
      : session.collab_mode === 'auto' && !isLocalTask(session) ? { status: 'auto', chosen_option: autoPick(q.options) } : classifyDecision(userInput.text, q.options);
    session.decisions = session.decisions || [];
    session.decisions.push(structuredAnswer ? cls : {
      question: q.question, options: q.options || [],
      answer: userInput.text, status: cls.status,
      chosen_option: cls.chosen_option || null, custom_text: cls.custom_text || null,
      rejected_option: cls.rejected_option || null,
      source: cls.status === 'auto' ? 'system_auto' : cls.status === 'delegated' ? 'human_delegated' : 'human',
      rationale: cls.status === 'auto' ? '全自动采用推荐项或首项' : '', at: Date.now(),
    });
    if (session.decisions.length > 100) session.decisions.shift();
    if (cls.status === 'ambiguous') {
      // 引擎级约束：模糊回答 ≠ 方案确认。不阻塞不依赖该选择的工作，
      // 但要求模型在涉及该选择时重新 ask_user 让用户明确选定。
      session.messages.push({ role: 'user', content: '[系统·决策记录] 用户回答「' + String(userInput.text).trim() + '」属于模糊回复，未被记录为任何方案的确认。若后续工作依赖该选择（建模路线、关键假设等），请重新 ask_user 请用户在明确选项中选定、给出自定义方案或选择暂缓；不依赖该选择的工作可以继续。' });
    } else if (cls.status === 'rejected') {
      // 明确否定：绝不反向记成选中；要求从其余选项重新选或自定义
      session.messages.push({ role: 'user', content: '[系统·决策记录] 用户明确否定了「' + cls.rejected_option + '」。该选项已被排除，不得采用。请从其余选项重新 ask_user 让用户选定，或请用户给出自定义方案。' });
    } else if (cls.status === 'delegated') {
      // 明确委托：智能体可以定夺并推进，但须记录是自己代选的（含理由），关键分歧仍应呈现给人
      session.messages.push({ role: 'user', content: '[系统·决策记录] 用户明确委托智能体决定（' + String(userInput.text).trim() + '）。你可以自行选定方案并推进，但请在回复中说明所选方案与理由；若后续出现高风险分歧（核心假设、路线争议），仍应 ask_user 呈现给用户。' });
    }
  }
  session.status = 'running';
  session.pendingQuestion = null;
  emitSafe({ t: 'turn_start', iter: 0 });

  const mainRole = !session.model && session.mode === 'math' ? 'modeler' : null;
  const modelResolution = resolveRoleModel({
    role: mainRole, settings, appDir,
    sessionModel: session.model || settings.default_model,
    sessionExplicit: !!session.model,
  });
  if (!modelResolution.ok) {
    failTurn(session, deps, emitSafe, '模型不可用', modelResolution.warnings.join('；') || '没有可用的角色模型或默认模型。');
    return;
  }
  const model = modelResolution.model;
  // 角色路由实况留痕：前端模型胶囊据此显示「实际在用的模型」（顶部手动选择仍优先显示）
  session.resolved_model = model;
  session.resolved_role = modelResolution.roleLabel || null;
  if (modelResolution.warnings.length) {
    emitSafe({ t: 'warn', msg: `模型路由：${modelResolution.warnings.join('；')}；当前使用 ${model}（${modelResolution.source}）` });
  }
  const providerKey = modelResolution.providerKey;
  const provider = modelResolution.provider;
  const apiModel = apiModelOf(model, providerKey); // 发给厂商的纯模型名（去掉 provider: 前缀）
  const modelTag = providerKey + ':' + apiModel;   // 运行记录的模型标签：证据按模型版本隔离
  // 技能版随主力模型走：会话中途切到不同提供商时重建系统提示（math 模式选对应 cumcm 技能版）
  // 系统提示重建条件：提供商变了，或本次会话指定的技能变了（技能换人也要重注技能正文）
  const paperContractVersion = require('./contest_quality').PAPER_QUALITY_VERSION + ':' + require('./contest_workflows').auditPolicy(session);
  const frozenPlan = session.skill_plan_snapshot;
  if (frozenPlan && !isLocalTask(session)) {
    for (const row of frozenPlan.entries.filter(row => row.status === 'loaded' && !row.blocked)) projectPlan.loadSessionSkill(appDir, session, row.name, null, settings);
  }
  if (session.system_provider !== providerKey || session.system_skill !== (session.skill_override || null)
      || session.system_effort !== modes.effortOf(session) || session.system_paper_contract !== paperContractVersion
      || session.system_material_policy !== MATERIAL_POLICY_VERSION
      || session.system_reasoning_policy !== REASONING_POLICY_VERSION
      || session.system_task_focus !== (isLocalTask(session) ? 'local' : 'main')
      || session.system_plan !== (frozenPlan?.id || null)
      // 首选技能当时没装上（回退/通用流程）→ 补装后自动换回首选，不必新建会话
      || (!frozenPlan && session.mode === 'math' && (session.skill_loaded || {}).name !== (session.skill_override || pickMathSkill(providerKey, session)))) {
    session.system = buildSystem(session.mode, sandbox.root, settings, appDir, providerKey, session.skill_override, session);
    session.system_provider = providerKey;
    session.system_skill = session.skill_override || null;
    session.system_effort = modes.effortOf(session);
    session.system_paper_contract = paperContractVersion;
    session.system_material_policy = MATERIAL_POLICY_VERSION;
    session.system_reasoning_policy = REASONING_POLICY_VERSION;
    session.system_task_focus = isLocalTask(session) ? 'local' : 'main';
    session.system_plan = frozenPlan?.id || null;
    const m = session.system.match(/已加载技能 (\S+)(?: v([\d.]+))?/);
    const activeMain = !isLocalTask(session) && frozenPlan?.entries?.find(row => row.slot === 'main' && row.status === 'loaded' && !row.blocked);
    session.skill_loaded = activeMain ? { name: activeMain.name, version: activeMain.version, sha256: activeMain.sha256, source: activeMain.source }
      : m ? { name: m[1], version: m[2] || '' } : null;
    saveSession(deps, session);
  }
  const apiKey = keyFor(providerKey, appDir);
  if (!apiKey) { failTurn(session, deps, emitSafe, '未配置 API Key', `提供商 ${provider.name} 缺少 key（设置页填入或放置 ${provider.keyFile}）。`); return; }
  const isAnthropic = provider.kind === 'anthropic';
  const tools = (isAnthropic ? toAnthropicTools(session, settings) : toOpenAITools(session, settings))
    .filter(t => !isLocalTask(session) || !LOCAL_BLOCKED_TOOLS.has(isAnthropic ? t.name : t.function.name));
  // 缓存前缀锁：轮开始记录实际发出的前缀指纹。变化时只如实报告冷启动归因，
  // 不自动换模型、不改上下文来掩盖——缓存命中率和推理质量必须同时成立。
  const prefix = cachePrefixPrint(providerKey, apiModel, session.system, tools);
  const prevPrefix = session.cache_prefix;
  if (prevPrefix && prevPrefix.hash !== prefix.hash) {
    const changed = [
      prevPrefix.provider !== prefix.provider ? '提供商' : '',
      prevPrefix.model !== prefix.model ? '模型' : '',
      prevPrefix.system_hash !== prefix.system_hash ? '系统提示' : '',
      prevPrefix.tools_hash !== prefix.tools_hash ? '工具集' : '',
    ].filter(Boolean);
    let reason = changed.join('+') || '前缀内容变化';
    const dg = session.effort_downgrade;
    if (changed.length === 1 && changed[0] === '系统提示' && dg && Date.now() - dg.at < 10 * 60 * 1000) {
      reason = `系统提示（预算降档 ${dg.from}→${dg.to}）`;
    }
    session.cache_reset = { at: Date.now(), kind: 'prefix', reason,
      from: prevPrefix.provider + ':' + prevPrefix.model, to: prefix.provider + ':' + prefix.model };
    emitSafe({ t: 'cache_reset', kind: 'prefix', reason,
      from: session.cache_reset.from, to: session.cache_reset.to });
  }
  session.cache_prefix = prefix;
  const spend = makeSpend(session, deps);
  const ctx = {
    sandbox, appDir, workspace: sandbox.root, session, settings, ledger,
    resolvedModel: model, modelResolution,
    deps, // 宿主注入的通道（requestApproval 等）——审批门禁要用
    emit: emitSafe, abort: deps.abort, children: deps.children,
    spend,
    ...(isReviewTask(session) ? { pyMode: 'ro' } : {}),
    setTodos: (todos) => { session.todos = todos; emitSafe({ t: 'todo', todos }); },
    addMemory: (text) => { session.memory.push({ t: Date.now(), text }); emitSafe({ t: 'memory', memory: session.memory }); },
    trackVision: (usage, m) => { session.usage.vision_calls = (session.usage.vision_calls || 0) + 1; },
    getGlmKey: () => keyFor('glm', appDir),
    engines: {},
  };
  ctx.engines.subagent = (profile, prompt, meta) => runSubagent(ctx, deps, profile, prompt, meta || {}, spend);
  ctx.engines.subagent_pool = (tasks, meta) => runPool(ctx, tasks, meta || {});
  // 输入版本基线：轮开始即快照求解代码（覆盖轮与轮之间的外部编辑；首轮建立基线不触发）
  refreshInputStamp(session, ctx, emitSafe);

  // 轮首经验召回（Reflexion 记忆层）：按本轮用户输入检索跨会话经验库，
  // 命中即固定为该轮的召回块（每轮请求注入在最后一条 user 消息后——不动 system 前缀，
  // 不破坏 DeepSeek 前缀缓存）。经验库为空时整块省略，零成本。
  ctx._recallBlock = '';
  try {
    const memLib = require('./memory');
    if (!isLocalTask(session) && userInput && userInput.text) {
      const hits = memLib.recall(appDir, String(userInput.text), { limit: 5, project: session.project_id,
        role: require('./model_roles').normalizeRole(ctx.role || session.role) || 'modeler' });
      if (hits.length) {
        memLib.markHit(appDir, hits.map(e => e.id));
        ctx._recallBlock = '【经验召回（跨会话经验库自动命中，先对照再动手）】\n'
          + memLib.formatEntries(hits, '').trim();
      }
    }
  } catch { /* 经验库故障不阻塞任务 */ }

  // 压缩阈值：用户设置优先；模型表上限只是兜底（1M 是能力上限，不是默认灌满的理由）
  const modelCap = (provider.ctxLimit && provider.ctxLimit[apiModel]) || 131072;
  const ctxLimit = Math.min(settings.ctx_limit || 131072, modelCap);
  // 单请求输出上限：0=真不限制（OpenAI 协议不发送该字段；Anthropic 协议必填故用提供商默认）；
  // 非零值是成本保险丝（防复读机失控）。65536 是羲和默认，不是任何厂商的能力上限。
  const maxOut = settings.max_output_tokens === 0 ? null
    : (settings.max_output_tokens != null ? settings.max_output_tokens : (provider.defaultMaxTokens || 32768));
  let lastPromptTokens = 0;
  // 压缩会改写历史 → 下一次请求必然冷启动。阈值随窗口和输出上限联动：
  // 只有窗口确实留得下输出时才放宽到 0.85，避免压缩过早白丢缓存或过晚触发超限。
  const compactAt = maxOut == null ? 0.72
    : Math.max(0.72, Math.min(0.85, (ctxLimit - maxOut - 4096) / ctxLimit));
  let consecutiveSame = 0, lastSig = '';
  let tempOk = true;
  let truncFails = 0, compactWarned = false;
  const toolFails = new Map();
  const disabledTools = new Set();
  let compactFails = 0;
  let stallIter = 0, stallWarned = false; // 连续零产出迭代计数（原地打转检测）
  // 本轮"值得复盘"的信号（v2.5 自动复盘）：工具连续失败 / 硬熔断 / 打转停轮。
  // 轮末若命中，写 session.pending_reflection，下一轮开头强制让模型表态（记教训或说明为何不记）。
  const turnSignals = { toolFails: [], hard: [] };
  const markReflection = (reason, detail) => {
    if (isLocalTask(session)) return;
    try {
      session.pending_reflection = {
        at: Date.now(),
        reasons: [...new Set([...((session.pending_reflection && session.pending_reflection.reasons) || []), reason])].slice(0, 6),
        detail: String(detail || '').replace(/\s+/g, ' ').slice(0, 500),
        toolFails: turnSignals.toolFails.slice(-6),
      };
    } catch { /* 复盘标记失败不能影响主流程 */ }
  };

  try {
    let autoContinues = 0;
    let decisionTextRepairs = 0;
    let repeatedAutoDecisions = 0;
    for (let iter = 0; iter < MAX_TOOL_ITER(session); iter++) {
      if (stopper.stop) { emitSafe({ t: 'done', reason: 'stopped' }); session.status = 'idle'; return; }
      if (!budgetCheck(session, deps, emitSafe)) { emitSafe({ t: 'done', reason: 'budget' }); session.status = 'idle'; return; }

      // 上下文自动压缩（保前缀缓存尽量晚触发）。压无可压时只警告一次（不熔断），
      // 真正超限的报错路径见 catch 里的 context-length 分支。
      if (!isLocalTask(session) && lastPromptTokens > ctxLimit * compactAt) {
        emitSafe({ t: 'compact', msg: '上下文接近上限，压缩历史…' });
        const ok = await compactHistory(session, deps, model, apiKey, provider, spend, providerKey);
        if (!ok && !compactWarned) {
          compactWarned = true;
          emitSafe({ t: 'warn', msg: '历史已无法进一步压缩（消息组太少），接近上下文上限。建议尽快总结并开新会话。' });
        }
      }

      const history = isLocalTask(session) ? localTaskMessages(session.messages) : session.messages;
      const messages = isAnthropic
        ? buildAnthropicMessages(history)
        : buildRequestMessages(session.system, history);
      // 稳定历史到此为止；后面追加的块每轮会变。Anthropic 需要显式断点，
      // 断点放在稳定历史末尾，避免把临时状态写进缓存前缀。
      const stableMessageCount = messages.length;
      const dynamicBlocks = [];
      // 契约完整注入每轮请求：math 模式下，作为最后一条 user 消息附加（不动 system 前缀，
      // 不破坏缓存命中；多轮追加 user 消息符合 OpenAI/Anthropic 协议交替规则）。
      // 关键题设不能依赖压缩摘要——审计复现：长对话中部关键边界条件在压缩时丢失，
      // 而压缩发生得太晚导致早期推理已经按错误假设走完。
      if (!isLocalTask(session) && session.mode === 'math' && (session.contract || []).length) {
        const block = stateBlock(session, appDir);
        if (block) {
          dynamicBlocks.push(block);
          messages.push({ role: 'user', content: block });
        }
      }
      // 自动复盘提示（v2.5）：上一轮踩了坑（工具反复失败/熔断/打转停轮）→ 本轮开头强制表态。
      // 一次性：读走即清，不反复唠叨。允许"说明为何不必记"，但不允许默默跳过。
      if (!isLocalTask(session) && session.pending_reflection) {
        const pr = session.pending_reflection;
        session.pending_reflection = null;
        const fails = (pr.toolFails || []).map(x => `- ${x.tool}（第 ${x.n} 次失败）：${x.err}`).join('\n');
        messages.push({ role: 'user', content: `[系统·自动复盘] 上一轮留下这些信号：${(pr.reasons || []).join('、')}${pr.detail ? '——' + pr.detail : ''}`
          + (fails ? `\n工具失败明细：\n${fails}` : '')
          + `\n请用 lesson_record(situation=这次的场景, rule=下次该怎么做) 记 1-2 条**可复用的**教训（situation 里带工具名/方法名，召回才准）；`
          + `若判断这是环境抖动或一次性失误、不值得沉淀，用一句话说明原因即可跳过。不要把这个提示原文抄进经验库。` });
        dynamicBlocks.push(messages[messages.length - 1].content);
        emitSafe({ t: 'warn', msg: '自动复盘：上一轮有失败信号，已提示沉淀教训' });
      }
      if (session.mode === 'math') {
        const block = modeBlock(session);
        dynamicBlocks.push(block);
        messages.push({ role: 'user', content: block });
      }
      // 阶段规则块（X-0 / I-1）：参考规则浓缩后按阶段注入——交接清单根因是
      // my-cumcm-deepseek 的 7 份 references 从未进入上下文（系统提示只注入了 SKILL.md 主文）。
      // 走最后一条 user 消息（与 stateBlock/modeBlock 同层），不动 system 前缀。
      {
        const pb = isLocalTask(session) ? '' : spiral.phaseBlock(session, Date.now(), appDir);
        if (pb) { dynamicBlocks.push(pb); messages.push({ role: 'user', content: pb }); }
      }
      // 经验召回块同样走最后 user 消息注入（与状态块同层：可访问、不占 system 前缀）
      if (ctx._recallBlock) {
        dynamicBlocks.push(ctx._recallBlock);
        messages.push({ role: 'user', content: ctx._recallBlock });
      }
      if (isAnthropic && /^claude/i.test(apiModel)) markAnthropicCache(messages, stableMessageCount - 1);
      const promptStats = promptDiagnostics.record(session, promptDiagnostics.analyzePrompt({
        system: session.system, messages: history, tools, dynamic: dynamicBlocks, iter,
      }));
      emitSafe({ t: 'prompt_stats', stats: promptStats });
      // temperature 三级：提供商锁温（如 kimi-k3 思考模式强制 1.0）> temperature 400 后本会话不传 > 用户设置
      const callExtra = {
        temperature: provider.temperatureLock != null ? provider.temperatureLock
          : (tempOk ? (settings.temperature ?? 0.6) : undefined),
      };
      const reasoningPlan = resolveReasoning(settings, providerKey, provider, apiModel);

      let res;
      try {
        emitSafe({ t: 'stream_start', iter });
        res = await callWithRetry({ provider, providerKey, apiKey, model: apiModel, messages, tools, callExtra, reasoningPlan, recordReasoning: reasoningRecorder(session, emitSafe, 'main'), deps, emitSafe, stopper,
          cacheDiagnostics: { appDir, session_id: session.owner_session_id || session.id, project_id: session.project_id,
            provider_key: providerKey, lane: isLocalTask(session) ? 'main:local' : 'main' },
          maxTokens: maxOut, system: session.system,
          onDelta: (s) => emitSafe({ t: 'delta', s }),
          onReason: (s) => emitSafe({ t: 'rdelta', s }),
        });
      } catch (e) {
        const msg = String(e.message || e);
        // 失败调用的 usage 也必须结算（截断/断流≠免费；callWithRetry 已累计重试期间的 usage）
        if (e.usage && e.usage.prompt_tokens != null) {
          spend(apiModel, e.usage, 'main', !!e.usage_partial);
          emitSafe({ t: 'usage', usage: session.usage, last: e.usage });
          if (e.usage_partial) emitSafe({t:'warn',msg:'请求中断，已记录返回的部分用量；最终完整消耗未知。'});
        }
        if (e.truncated) {
          if (++truncFails > 2) {
            markReflection('轮次被截断熔断', msg); failTurn(session, deps, emitSafe, 'max_tokens 连续 3 次截断', msg + '（避免无限烧钱已熔断。请拆小任务、减少单轮输出量，或在设置调大 max_output_tokens。）');
            return;
          }
          emitSafe({ t: 'error', msg: '模型输出被截断（第 ' + truncFails + '/2 次重试）：' + msg });
          continue; // 不把半截输出当成功；让模型重新生成（上下文里没有该 assistant 消息，不会污染）
        }
        // 思考模型常见限制：temperature 必须固定值（如 kimi-k3 要求 1.0）→ 本会话不再传 temperature 重试
        if (tempOk && !e.incomplete && e.status === 400 && /invalid temperature|temperature.{0,40}must/i.test(msg)) {
          tempOk = false;
          emitSafe({ t: 'warn', msg: '该模型要求固定 temperature，本会话不再传该参数并重试' });
          continue;
        }
        if (!isLocalTask(session) && /context length|maximum context|too long|too many tokens|context window/i.test(msg)) {
          emitSafe({ t: 'compact', msg: '上下文超限，强制压缩后重试' });
          const ok = await compactHistory(session, deps, model, apiKey, provider, spend, providerKey);
          if (!ok && ++compactFails >= 2) {
            markReflection('上下文超限无法压缩', '长 turn 上下文硬伤：建议拆会话或换更大窗口模型'); failTurn(session, deps, emitSafe, '上下文超限且已无法再压缩', '消息组太少或压缩失败 2 次。请开新会话。');
            return;
          }
          continue;
        }
        markReflection('模型调用失败', `${provider.name}: ${msg}`); failTurn(session, deps, emitSafe, `模型调用失败（${provider.name}）`, msg);
        return;
      }

      if (res.usage) {
        lastPromptTokens = res.usage.prompt_tokens;
        spend(apiModel, res.usage, 'main');
        promptDiagnostics.finish(session, promptStats, res.usage);
        emitSafe({ t: 'prompt_stats', stats: promptStats });
        emitSafe({ t: 'usage', usage: session.usage, last: res.usage });
      }

      const assistantMsg = { role: 'assistant', content: res.content || '' };
      if (res.reasoning) assistantMsg.reasoning_content = res.reasoning;
      if (res.tool_calls && res.tool_calls.length) assistantMsg.tool_calls = res.tool_calls;
      if (res.anthropic_blocks) assistantMsg.anthropic_blocks = res.anthropic_blocks; // Anthropic 回传必需（thinking 签名等）
      if (res.responses_items) assistantMsg.responses_items = res.responses_items;
      session.messages.push(assistantMsg);
      if (session.job_wait?.status === 'resuming' && assistantMsg.tool_calls?.length) session.job_wait.had_tools = true;
      if (res.content) emitSafe({ t: 'assistant_msg', content: res.content });
      saveSession(deps, session);

      if (!res.tool_calls || !res.tool_calls.length) {
        const waitingQuestion = textDecision(res.content);
        if (waitingQuestion) {
          if (session.collab_mode === 'auto' && !isLocalTask(session) && decisionTextRepairs++ === 0) {
            const last = (session.decisions || []).at(-1);
            session.messages.push({ role: 'user', content: '[系统·决策状态] 本会话已授权全自动采用明确推荐项。请调用 ask_user 生成有效决策卡，系统会记录选择并立即继续；不要以纯文字要求再次回复A/B/C。'
              + (last ? '最近已记录的选择：' + JSON.stringify(last) : '') });
            saveSession(deps, session);
            continue;
          }
          session.wait_reason = { kind: 'decision_text', question: waitingQuestion, at: Date.now() };
          session.status = 'waiting_input';
          emitSafe({ t: 'question', question: waitingQuestion, options: [] });
          emitSafe({ t: 'done', reason: 'waiting_for_decision' });
          saveSession(deps, session);
          return;
        }
        // v2.3.4 minor 修复 3：叙述意图自动追注——DeepSeek 偶发"叙述了想做什么但不发 tool_call 就停 turn"
        // 检测模式：内容里有"现在/接下来/我先去/我会/让我/let me/i will"等动作词 + 没有真问题 + 不触发证据门禁
        // → 自动追一条轻量 system 提示，让 agent 显式调用工具
        const narrationIntent = /现在|接下来|我先|我会|让我|马上|立刻|准备|let me|i will|i'm going to|接下来/i.test(res.content || '');
        if (!isLocalTask(session) && narrationIntent && (session._narrativeHintCount || 0) < 1) {
          session._narrativeHintCount = (session._narrativeHintCount || 0) + 1;
          session.messages.push({ role: 'user', content: '[系统·叙述意图提示] 你刚叙述了要做的事，但没发出 tool_call。请显式调用相应工具（fs_*/python_run/question_graph/web_search 等）真正执行；若这一轮确实已经完成（产出已落盘/已 commit），请用一句话总结状态让用户知道。' });
          saveSession(deps, session);
          continue;
        }
        // 数模证据门禁 v2.1（主张级·语义匹配）：触发条件为数值主张句关键词；提取时排除
        // 题给常数（紧邻来源标记）；匹配要求符号/指数/单位一致、无子串匹配。
        // 证据绑定 data_epoch（数学输入版本），不绑定 LLM 名称。
        if (session.mode === 'math' && !isReviewTask(session)) {
          const numeric = /\d/.test(res.content || '') && NUM_CLAIM_RE.test(res.content || '');
          if (numeric) {
            const ev = checkNumericEvidence(res.content, session);
            if (ev.missing.length) {
              if ((session.evidenceChallenges || 0) < 2) {
                session.evidenceChallenges = (session.evidenceChallenges || 0) + 1;
                session.messages.push({ role: 'user', content: `[系统·证据门禁] 数值结论中的以下数值未在「当前代码/数据版本」的成功运行输出里找到：${ev.missing.slice(0, 8).join('、')}。print('hello')、改动代码/数据/公式前的旧结果都不构成证据；数值须符号、数量级、单位一致。请用 python_run 实际计算后再给结论；若这些是题给常数或文献引用值（非计算结果），请紧邻标注来源（如「题目第3页给定」），引擎会据此豁免。` });
                saveSession(deps, session);
                continue;
              }
              emitSafe({ t: 'warn', msg: '证据门禁：以下数值结论未经当前代码/数据版本的实际运行验证（质询后仍未提供运行证据），请人工核验后再采用：' + ev.missing.slice(0, 8).join('、') });
              session.unverifiedNumeric = true;
            } else {
              session.unverifiedNumeric = false; // 本条结论的全部数值都有运行证据
            }
          }
        }
        // 比赛会话两种模式都续推（人机协同也只该在决策卡处停；v2.4 实测协同模式仍需手动发「继续」2 次）
        if (!isLocalTask(session) && (session.collab_mode === 'auto' || session.contest) && session.mode === 'math' && !autoFinished(session, sandbox.root) && autoContinues < AUTO_CONTINUE_MAX && !/【全流程完成】/.test(res.content || '')) {
          autoContinues++;
          session.messages.push({ role: 'user', content: `[系统·自动续推 ${autoContinues}/${AUTO_CONTINUE_MAX}] 任务尚未完成。当前卡点：${nextStepHint(session, sandbox.root)} 请直接执行下一步；需要用户拍板的选择照常 ask_user 出决策卡。确实无法继续时说明卡点并回复「【全流程完成】」以外的总结。` });
          emitSafe({ t: 'warn', msg: `自动续推（${autoContinues}/${AUTO_CONTINUE_MAX}）` });
          saveSession(deps, session);
          continue;
        }
        // 自动复盘（v2.5）：本轮工具失败够多就留个标记，下一轮开头让模型表态沉淀教训。
        // 为什么不在轮末直接写经验库：错误教训入库会污染之后每一轮（V-27 原型），作者必须是模型；
        // 但"要不要表态"不能靠模型自觉——这就是这条确定性提示存在的理由。
        const distinctFailed = new Set(turnSignals.toolFails.map(x => x.tool)).size;
        const repeatFailed = turnSignals.toolFails.some(x => x.n >= 2);
        if (!isLocalTask(session) && (distinctFailed >= 2 || repeatFailed)) {
          markReflection('工具反复失败', `${turnSignals.toolFails.length} 次失败涉及 ${distinctFailed} 个工具`);
          emitSafe({ t: 'warn', msg: `本轮有 ${turnSignals.toolFails.length} 次工具失败（${[...distinctFailed ? new Set(turnSignals.toolFails.map(x => x.tool)) : []].join('、')}）——下一轮开头会让你复盘沉淀。` });
        }
        emitSafe({ t: 'done', reason: 'stop' });
        session.status = 'idle';
        saveSession(deps, session);
        return;
      }

      // doom-loop 检测（签名=工具名+参数）
      // P0-3：长作业等待豁免——同一 job_id 的 job_status 连续轮询不算 loop
      // （A 题教训：MATLAB pdepe 长仿真期间 job_status 三次相同 → 硬停 → 用户必须手动续推）
      const sig = res.tool_calls.map(tc => tc.function.name + ':' + tc.function.arguments).join('|');
      // 仅在「单一工具 = 单一参数」且属于长作业工具时跳过计数
      const longJobTools = ['job_status', 'job_cancel'];
      const hasOwnLoopGuard = res.tool_calls.length === 1 && (longJobTools.includes(res.tool_calls[0].function.name)
        || (session.collab_mode === 'auto' && !isLocalTask(session) && res.tool_calls[0].function.name === 'ask_user'));
      if (hasOwnLoopGuard) {
        consecutiveSame = 0; // 不累计
      } else {
        consecutiveSame = sig === lastSig ? consecutiveSame + 1 : 0;
      }
      lastSig = sig;
      if (consecutiveSame + 1 >= LOOP_HARD) {
        // 硬停止：不执行第 LOOP_HARD 次相同调用。该 assistant 的 tool_calls 已入历史，
        // 必须逐个补「已拒绝」结果——否则留下孤儿 tool_calls，下一轮请求直接协议报错。
        for (const tc of res.tool_calls) {
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content: `[系统] 已拒绝执行（连续第 ${LOOP_HARD} 次完全相同调用，硬停止）。` });
        }
        // 比赛会话：不停轮，逼它换路继续（与收尾续推共用 AUTO_CONTINUE_MAX 预算，防无限循环）
        if (!isLocalTask(session) && (session.collab_mode === 'auto' || session.contest) && session.mode === 'math' && autoContinues < AUTO_CONTINUE_MAX) {
          autoContinues++;
          consecutiveSame = 0; lastSig = '';
          session.messages.push({ role: 'user', content: `[系统] 检测到连续第 ${LOOP_HARD} 次完全相同的工具调用，已拒绝执行。不要再重复这个调用——换一条不同的路径继续推进（自动续推 ${autoContinues}/${AUTO_CONTINUE_MAX}）。` });
          emitSafe({ t: 'warn', msg: `重复调用已拦截，自动换路续推（${autoContinues}/${AUTO_CONTINUE_MAX}）` });
          saveSession(deps, session);
          continue;
        }
        session.messages.push({ role: 'user', content: `[系统] 检测到连续第 ${LOOP_HARD} 次完全相同的工具调用，已拒绝执行并停止本轮。请总结卡点，用 ask_user 与用户确认下一步，或换一条不同的路径。` });
        emitSafe({ t: 'done', reason: 'loop_stop' });
        session.status = 'idle';
        saveSession(deps, session);
        return;
      }

      let pending = null;
      let iterProductive = false; // 本轮有没有实际产出（成功计算/写盘/登记）
      for (const tc of res.tool_calls) {
        if (stopper.stop) break;
        // ask_user：立即暂停，本批后续工具一律不执行（以「已取消」结果补齐协议）
        if (pending && (pending.question != null || pending.external || pending.jobs || pending.blocked)) {
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content: '[系统] 本轮已因 ask_user/外部调度暂停，该调用未执行。等用户回答后重新规划。' });
          emitSafe({ t: 'tool_end', id: tc.id, name: tc.function.name, ok: false, ms: 0, result_preview: '已取消（等待用户输入）' });
          continue;
        }
        let name = tc.function.name, args;
        const t0 = Date.now();
        emitSafe({ t: 'tool_start', id: tc.id, name,
          args_preview: cap(tc.function.arguments, 300),
          args_full: cap(String(tc.function.arguments || ''), 12000),
          args_len: String(tc.function.arguments || '').length });
        if (isLocalTask(session) && LOCAL_BLOCKED_TOOLS.has(name)) {
          const content = `[系统·临时任务] ${name} 属于暂停的主线流程，本次未执行。请只完成当前局部请求。`;
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content });
          emitSafe({ t: 'tool_end', id: tc.id, name, ok: false, ms: 0, result_preview: content });
          continue;
        }
        if (disabledTools.has(name)) {
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content: `[系统] 工具 ${name} 因连续失败已被禁用。请换方法或用 ask_user 说明卡点。` });
          emitSafe({ t: 'tool_end', id: tc.id, name, ok: false, ms: 0, result_preview: '已禁用（连续失败）' });
          continue;
        }
        try { args = safeParseArgs(tc.function.arguments); }
        catch (e) {
          const r = { ok: false, error: e.message + '\n修正参数后重新调用该工具。' };
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(r) });
          emitSafe({ t: 'tool_end', id: tc.id, name, ok: false, ms: Date.now() - t0, result_preview: r.error.slice(0, 300) });
          continue;
        }
        const scopeBlock = reviewToolBlock(session, name, args, ctx.workspace);
        if (scopeBlock) {
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content: scopeBlock });
          emitSafe({ t: 'tool_end', id: tc.id, name, ok: false, ms: 0, result_preview: scopeBlock });
          continue;
        }
        // 审批门禁（v2.5）：请求审批模式下，"会改动/会花钱/会对外"的工具执行前弹卡等用户点批准。
        // 三选一：批准 / 拒绝（换路）/ 本会话总是批准该工具。用户在场但超时按拒绝处理——
        // 宁可让模型换路，也不静默放行（静默放行等于把审批关掉，最危险）。
        // 例外：宿主没有审批通道时（无头 CLI/测试）降级为完全访问，但要**说出来**（一次性 warn），
        // 否则请求审批模式在无头环境下会把每一个工具都卡成超时，等于把工具全禁了。
        const hasApprover = typeof deps.requestApproval === 'function';
        if (needApproval(session, name) && !hasApprover && !session.approvalNoHostWarned) {
          session.approvalNoHostWarned = true;
          emitSafe({ t: 'warn', msg: '当前运行环境没有审批通道（无头模式），请求审批已降级为完全访问。要真正走审批请用桌面界面。' });
        }
        if (needApproval(session, name) && hasApprover) {
          const decision = await requestApproval(ctx, {
            id: tc.id, tool: name, summary: approvalSummary(name, args), args_preview: cap(tc.function.arguments, 400),
          });
          if (decision === 'allow_session') {
            session.approval_allow = session.approval_allow || {};
            session.approval_allow[name] = true;
            emitSafe({ t: 'warn', msg: `已授权本会话总是允许 ${name}` });
          } else if (decision !== 'allow') {
            const why = decision === 'timeout' ? '等待审批超时（无人应答）' : '用户拒绝了这次执行';
            session.messages.push({ role: 'tool', tool_call_id: tc.id, content: `[系统·审批] ${why}：${name} 未执行（${approvalSummary(name, args)}）。请改用只读方式核对，或换一条不需要该操作的路径；确实必须执行时用 ask_user 说明理由请用户批准。` });
            emitSafe({ t: 'tool_end', id: tc.id, name, ok: false, ms: Date.now() - t0, result_preview: `未批准（${decision}）` });
            continue;
          } else {
            emitSafe({ t: 'warn', msg: `已批准：${name}` });
          }
        }
        // Structured route cards can be independently checked in both modes.
        // In collab mode the result is shown as advice; in auto mode it is
        // recorded and may only validate the existing recommendation unless
        // explicit calibrated override settings are enabled.
        if (name === 'ask_user' && Array.isArray(args.candidates) && args.candidates.length === 3) {
          args = await applyDecisionJudge(args, session, { ...deps, spend });
        }
        if (session.collab_mode === 'auto' && !isLocalTask(session) && (name === 'ask_user' || name === 'dispatch_external')) {
          let content;
          if (name === 'ask_user') {
            let q;
            try {
              q = createDecision(args);
            }
            catch (error) {
              session.messages.push({ role: 'tool', tool_call_id: tc.id, content: '[决策格式错误] ' + error.message });
              emitSafe({ t: 'tool_end', id: tc.id, name, ok: false, ms: 0, result_preview: error.message });
              continue;
            }
            const pick = q.candidates ? autoPick(q) : autoPick(q.options);
            session.decisions = session.decisions || [];
            const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ question: q.question, candidates: q.candidates || q.options, recommended_id: q.recommended_id, epoch: session.data_epoch || 0 })).digest('hex');
            const previous = session.decisions.find(d => d.fingerprint === fingerprint);
            if (previous) {
              content = `[系统·已有决策] 本输入版本已经选择「${previous.chosen_option || previous.answer}」。沿用该选择，直接执行后续步骤，不要重复询问。`;
              session.messages.push({ role: 'tool', tool_call_id: tc.id, content });
              emitSafe({ t: 'tool_end', id: tc.id, name, ok: true, ms: 0, result_preview: content });
              if (++repeatedAutoDecisions >= 2) pending = { blocked: true, reason: '模型重复已完成决策', detail: '相同输入版本的决策已记录，模型重复索取选择；自动续推已暂停，请切换模型或明确重规划。' };
              continue;
            }
            const record = q.candidates
              ? decisionRecord(q, { selected_id: q.recommended_id, rationale: '全自动采用显式推荐：' + (q.recommendation_reason || recommendedChoice(q).basis) }, 'system_auto')
              : { question: q.question, options: q.options, answer: pick || '（智能体自定）', status: 'auto', chosen_option: pick, source: 'system_auto', rationale: '全自动采用推荐项或首项', at: Date.now() };
            session.decisions.push({ ...record, fingerprint });
            if (session.decisions.length > 100) session.decisions.shift();
            const judgeNote = q.judge && q.judge.ok
              ? (q.judge.disposition && q.judge.disposition.status === 'accepted'
                ? ` 判断层已复核一致（置信度 ${Number(q.judge.confidence || 0).toFixed(2)}）。`
                : ` 判断层未放行自动改选：${q.judge.disposition?.reason || '需主模型或人工复核'}。保留主模型推荐并记录升级信号。`)
              : (q.judge && !q.judge.skipped ? ` 判断层调用失败，已回退主模型推荐：${q.judge.error || '未知错误'}。` : '');
            content = pick
              ? `[全自动模式] 用户不在场，已自动选定推荐项：「${pick}」。${judgeNote}直接按此推进；把该选择写进 question_graph 的 conventions/备注留痕，不要再等确认。`
              : '[全自动模式] 用户不在场，本问题没有给选项。请按你的推荐方案自行决定、登记理由（contract_register ambiguity 或 conventions）后继续。';
            emitSafe({ t: 'auto_decision', question: args.question, choice: pick });
          } else {
            content = modes.isDeep(session)
              ? '[全自动模式] 外部模型调度需要用户手动操作，已跳过。请用本地工具（subagent_run reviewer / python 复核）替代。'
              : '[全自动模式] 外部模型调度需要用户手动操作，已跳过。请用本地 python 复核替代。';
          }
          session.messages.push({ role: 'tool', tool_call_id: tc.id, content });
          emitSafe({ t: 'tool_end', id: tc.id, name, ok: true, ms: 0, result_preview: content.slice(0, 300) });
          iterProductive = true;
          continue;
        }
        let r;
        ctx.toolCallId = tc.id;
        // 执行前输入快照（计算工具）：检测「运行期间修改已存在输入」——脚本先读旧参数、
        // 算完再改写参数文件时，输出属于旧版输入，不能按新版认证（复审指出的风险场景）
        const preStamp = isComputeTool(name, args) ? (session.input_stamp_map || null) : null;
        const depsBlock = formulaDepsBlock(session, name, args);
        if (depsBlock) r = { ok: false, error: depsBlock };
        else {
          try {
            let callCtx = ctx, callArgs = args, discovery = false;
            if (isReviewTask(session) && ['fs_ls', 'fs_glob', 'fs_read', 'fs_grep', 'python_run', 'vision_read'].includes(name)
              && !/^findings\/reviews\//.test(path.posix.normalize(String(args.path || '').replace(/\\/g, '/')))) {
              const snapshot = session.review_snapshot;
              discovery = !snapshot && ['fs_ls', 'fs_glob'].includes(name);
              if (!snapshot && !discovery) throw Object.assign(new Error('请先review_snapshot固定待审文件，再读取或计算'), { recoverable: true });
              if (snapshot) {
                if (ctx._reviewCheckedId !== snapshot.id) {
                  const issues = require('./review_snapshot').snapshotBlockers(ctx.workspace, snapshot, { check_sources: false });
                  if (issues.length) throw new Error(issues.join('；'));
                  ctx._reviewCheckedId = snapshot.id;
                }
                const readRoot = ctx.sandbox.resolve(snapshot.root_rel, 'r');
                callCtx = { ...ctx, workspace: readRoot, sandbox: new (ctx.sandbox.constructor)(readRoot), pyMode: 'ro' };
                if (args.path && path.isAbsolute(args.path)) callArgs = { ...args, path: path.relative(ctx.workspace, args.path) };
              }
            }
            r = await executeTool(callCtx, name, callArgs);
            if (discovery && r.ok) r.data = '[审稿范围发现：实时目录，仅用于选择快照文件，不能据此结项]\n' + r.data;
          }
          catch (e) { r = { ok: false, error: String(e.message || e), code: e.code, recoverable: e.recoverable === true }; }
        }
        let content;
        if (r.ok) { toolFails.delete(name); content = r.data; }
        else {
          const n = r.recoverable ? 0 : (toolFails.get(name) || 0) + 1;
          if (!r.recoverable) toolFails.set(name, n);
          // 自动复盘素材（v2.5）：把本轮真实踩的坑记下来，轮末决定要不要提示模型沉淀成教训。
          // 只收集信号、不自动写经验库——错误教训入库比不入库更糟（V-27），作者必须是模型。
          if (turnSignals.toolFails.length < 12) {
            turnSignals.toolFails.push({ tool: name, n, err: String(r.error || r.data || '').replace(/\s+/g, ' ').slice(0, 160) });
          }
          content = `[工具执行失败] ${r.error || r.data || '未知错误'}\n请检查参数后重试。若失败原因已被修复（用户/系统刚修好工具、环境、配置或参数已更正），沿原路线重试是正确行为；仅当原因未变且同一方法连续失败时才需要换方法。`;
          // 失败驱动召回（Reflexion）：首次失败时浮现与该工具/错误关键词相关的历史教训，
          // 让"上次这么修好的"在重试前自动出现在上下文里（每个工具每轮最多浮现一次，防刷屏）
          try {
            if (n === 1) {
              const memLib = require('./memory');
              const q = name + ' ' + String(r.error || '').slice(0, 200);
              const lessons = memLib.recall(appDir, q, { limit: 3, kind: 'lesson', toolFail: name, project: session.project_id,
                role: require('./model_roles').normalizeRole(ctx.role || session.role) || 'modeler' });
              if (lessons.length) {
                memLib.markHit(appDir, lessons.map(e => e.id));
                content += '\n\n【历史教训浮现（同类失败曾记录，先对照再重试）】\n'
                  + lessons.map(e => `- [${e.id}]${e.situation ? '（' + e.situation + '）' : ''} ${e.text}`).join('\n');
              }
            }
          } catch { /* 经验库故障不影响工具失败主流程 */ }
          if (n >= TOOL_FAIL_HARD) {
            disabledTools.add(name);
            content += `\n\n[系统] ${name} 已连续失败 ${n} 次，本轮内已被禁用。请换一条不同性质的路径，或用 ask_user 向用户说明卡点。`;
          }
        }
        session.messages.push({ role: 'tool', tool_call_id: tc.id, content: cap(content) });
        const resultText = String(content);
        emitSafe({ t: 'tool_end', id: tc.id, name, ok: r.ok, ms: Date.now() - t0,
          result_preview: cap(resultText.replace(/\s+/g, ' '), 400),
          result_full: cap(resultText, 24000), result_len: resultText.length });
        // 输入版本与运行记录（证据链 v2.3）：
        // 计算工具——比对执行前后快照，检测「运行中修改已存在输入」（unstable 运行不作证据）；
        // 再刷新 epoch（成败都刷，覆盖"写后报错"路径）并记账。文件工具——成败都刷（写已发生）。
        if (isComputeTool(name, args)) {
          const afterStamp = stampInputFiles(ctx.workspace);
          // ISS-10 根因：旧代码 `preStamp[p] !== afterStamp[p]` 比的是 {hash,struct} 对象引用，
          // 永不相等——只要工作区存在任何数据/代码文件，每个 python_run/shell_run 都被误标
          // unstable，commit 门禁对所有 link_run 一律「不存在或不稳定」全拒。正确判据：hash 比
          // 内容（struct 是 epoch 分类用，不是运行完整性判据）；运行新增的文件不算「改写已存在输入」。
          let changedDuring = false;
          const unstableFiles = [];
          const stampSame = (a, b) => ((a && typeof a === 'object' ? a.hash : a) === (b && typeof b === 'object' ? b.hash : b));
          if (preStamp) {
            for (const p of Object.keys(afterStamp)) {
              if (!(p in preStamp)) continue;
              if (!stampSame(afterStamp[p], preStamp[p])) { changedDuring = true; if (unstableFiles.length < 5) unstableFiles.push(p); }
            }
            for (const p of Object.keys(preStamp)) {
              if (!(p in afterStamp)) { changedDuring = true; if (unstableFiles.length < 5) unstableFiles.push(p + '（被删除）'); }
            }
          }
          refreshInputStamp(session, ctx, emitSafe, afterStamp);
          const isFormal = !!(args && (args.formal === true || (Array.isArray(args.uses_formulas) && args.uses_formulas.length)));
          const sig = crypto.createHash('md5').update(String(tc.function.arguments || '')).digest('hex').slice(0, 10);
          const runId = recordRun(session, { tool: name, ok: !!r.ok, ms: Date.now() - t0, modelTag, out: r.ok ? cap(String(content), 2400) : '', sig, formal: isFormal, unstable: changedDuring, unstable_files: unstableFiles, deps: args && args.uses_formulas, inputHash: inputStampHash(afterStamp), modelSpec: isFormal ? specBinding(session, args) : undefined, resultArtifacts: r.result_artifacts,
            taskScope: isLocalTask(session) ? 'local' : undefined, focusId: session.task_focus?.entered_at });
          // m34 修法：run_id 回显给模型——否则 link_run 拿不到 id 永远传错，
          // commit 门禁（要求 link_run）永远卡死。附在工具返回尾部，模型可见。
          if (r.ok) session.messages[session.messages.length - 1].content += `\n\n[run_id=${runId} epoch=${session.data_epoch || 0}${isFormal ? ' formal' : ''}]`;
          if (r.ok) session.compute_runs = (session.compute_runs || 0) + 1;
          if (changedDuring && session.mode === 'math') emitSafe({ t: 'warn', msg: '本次运行期间修改了已存在的输入文件（先读后写？）：' + (unstableFiles.join('、') || '未知') + '。该运行的输出按不稳定处理、不构成数值证据；请在输入稳定后重新运行。' });
        } else if (['fs_write', 'fs_edit', 'fs_move', 'fs_copy', 'fs_delete'].includes(name)) {
          refreshInputStamp(session, ctx, emitSafe); // 快照差异触发 epoch（代码/数据文件增删改）
        }
        // 公式修订失效（含测试失败的重登——失败修订同样作废旧证据，复审 P1-3）
        if (name === 'formula_register' && /公式已修订/.test(String(content))) {
          session.data_epoch = (session.data_epoch || 0) + 1;
          if (session.mode === 'math') emitSafe({ t: 'warn', msg: '公式已修订，此前基于旧公式的运行结果视为过期，受影响结论需重算。' });
        }
        // 题目契约修订失效：实体/边界/假设变化 → 旧结果过期（华数杯教训：几何对象错了，
        // 后面所有计算跟着错——契约修订必须阻断旧结论继续流通）
        if (name === 'contract_register' && /契约已修订/.test(String(content))) {
          session.data_epoch = (session.data_epoch || 0) + 1;
          if (session.mode === 'math') emitSafe({ t: 'warn', msg: '题目契约已修订（实体/边界/假设变化），此前运行结果视为过期，受影响结论需重算。' });
        }
        saveSession(deps, session);
        if (r.ok && (isComputeTool(name, args) || PRODUCTIVE_TOOLS.has(name))) iterProductive = true;
        if (name === 'ask_user' && r.ok) pending = ctx.preparedDecision || createDecision(args);
        if (name === 'dispatch_external' && r.ok) pending = { external: true, target: args.target };
        if (name === 'job_wait' && r.ok && ctx.waitingJobs) pending = { jobs: true };
      }

      if (pending?.blocked && !stopper.stop) {
        failTurn(session, deps, emitSafe, pending.reason, pending.detail);
        return;
      }
      if (pending?.jobs && !stopper.stop) {
        session.status = 'waiting_jobs';
        saveSession(deps, session);
        emitSafe({ t: 'done', reason: 'waiting_jobs' });
        return;
      }

      // 原地打转检测：纯读/反复失败零产出的迭代连续累计到阈值 → 先警告后停轮。
      // 这是 LOOP_HARD（连续相同签名）的补充——模型换个措辞重试就能绕过签名去重，
      // 但"零产出"是打转的本质特征，绕不过去。
      stallIter = iterProductive ? 0 : stallIter + 1;
      if (!iterProductive && stallIter === STALL_WARN && !stallWarned) {
        stallWarned = true;
        session.messages.push({ role: 'user', content: `[系统·进展检查] 已连续 ${stallIter} 轮工具调用没有任何产出（无成功计算、无文件写入、无登记动作）。请停下来评估：当前路径是否可行？是否需要换方法、补前置条件，或 ask_user 向用户确认方向？如果只是探索性阅读属正常，可继续但请给出阶段小结。` });
        emitSafe({ t: 'warn', msg: `已连续 ${stallIter} 轮无产出，已提醒模型评估方向（${STALL_HARD} 轮将停轮）` });
        saveSession(deps, session);
      }
      if (!iterProductive && stallIter >= STALL_HARD) {
        session.messages.push({ role: 'user', content: `[系统·硬停止] 连续 ${stallIter} 轮工具调用零产出，判定为原地打转，本轮已强制停止。请向用户总结：①目前做到哪一步 ②卡在哪里 ③需要的下一步输入或换路建议。` });
        emitSafe({ t: 'warn', msg: `连续 ${stallIter} 轮零产出，判定原地打转，强制停轮` });
        markReflection('原地打转停轮', '连续零产出迭代达到上限：反复读/反复失败的写，没有新产出');
        emitSafe({ t: 'done', reason: 'stall_stop' });
        session.status = 'idle';
        saveSession(deps, session);
        return;
      }

      // 用户停止/异常中断可能留下未执行的调用：补齐取消结果，保持消息协议完整
      // （assistant.tool_calls 必须每个都有对应 tool 结果，否则下一轮请求 400）
      if (stopper.stop) {
        for (const tc of res.tool_calls) {
          const answered = session.messages.some(m => m.role === 'tool' && m.tool_call_id === tc.id);
          if (!answered) session.messages.push({ role: 'tool', tool_call_id: tc.id, content: '[系统] 用户停止，该调用未执行。' });
        }
        emitSafe({ t: 'done', reason: 'stopped' });
        session.status = 'idle';
        saveSession(deps, session);
        return;
      }

      if (pending && pending.question != null) {
        session.pendingQuestion = pending;
        session.status = 'waiting_input';
        emitSafe({ t: 'question', ...pending });
        saveSession(deps, session);
        emitSafe({ t: 'done', reason: 'ask_user' });
        return;
      }
      if (pending && pending.external) {
        session.status = 'waiting_external';
        emitSafe({ t: 'external_wait', target: pending.target });
        saveSession(deps, session);
        emitSafe({ t: 'done', reason: 'wait_external' });
        return;
      }
    }
    emitSafe({ t: 'done', reason: 'max_iter' });
    session.status = 'idle';
  } finally {
    saveSession(deps, session);
  }
}

async function callWithRetry({ provider, providerKey, apiKey, model, messages, tools, callExtra, reasoningPlan, recordReasoning, deps, emitSafe, stopper, maxTokens, system, onDelta, onReason, cacheDiagnostics }) {
  const delays = [1500, 4000, 9000];
  // 重试期间的 usage 累计：每次失败的尝试（断流/5xx 前已收到的部分用量）都真实发生，
  // 必须随最终结果或最终错误上抛结算——否则重试越多账本越失真。
  let accUsage = null;
  const addUsage = (u) => {
    if (!u || u.prompt_tokens == null) return;
    accUsage = accUsage || { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0 };
    accUsage.prompt_tokens += u.prompt_tokens || 0;
    accUsage.completion_tokens += u.completion_tokens || 0;
    accUsage.cache_hit_tokens += u.cache_hit_tokens || 0;
  };
  for (let attempt = 0; ; attempt++) {
    if (stopper.stop) throw new Error('用户停止');
    try {
      const common = {
        base: provider.base, key: apiKey, model, messages, tools,
        temperature: callExtra.temperature,
        signal: deps.abort.signal,
        onDelta, onReason, cacheDiagnostics,
      };
      let res;
      if (provider.kind === 'anthropic') {
        res = await callWithReasoning(chatStream, {
          ...common, kind: 'anthropic',
          system, maxTokens: maxTokens || provider.defaultMaxTokens || 32768,
        }, reasoningPlan, recordReasoning);
      } else {
        res = await callWithReasoning(chatStream, { ...common, kind: provider.kind, maxTokens }, reasoningPlan, recordReasoning);
      }
      if (accUsage) res.usage = res.usage ? { ...res.usage,
        prompt_tokens: (res.usage.prompt_tokens || 0) + accUsage.prompt_tokens,
        completion_tokens: (res.usage.completion_tokens || 0) + accUsage.completion_tokens,
        cache_hit_tokens: (res.usage.cache_hit_tokens || 0) + accUsage.cache_hit_tokens,
      } : accUsage;
      return res;
    } catch (e) {
      addUsage(e.usage);
      if (e.name === 'AbortError' || deps.stopper.stop || deps.abort.signal.aborted) {
        const stopped = new Error('用户停止'); stopped.name = 'AbortError'; stopped.usage = accUsage || e.usage; stopped.usage_partial = !!e.usage_partial; throw stopped;
      }
      // A timed-out reasoning request may already have generated billable
      // tokens. Do not silently restart it and charge for another attempt.
      if (e.name === 'TimeoutError' || /UND_ERR_(?:HEADERS|BODY)_TIMEOUT/.test(e.cause?.code || '')) {
        if (accUsage) e.usage = accUsage;
        throw e;
      }
      const status = e.status || 0;
      // 流不完整（断流）可安全重试：请求未在历史里产生半截 assistant 消息
      const retriable = status === 429 || status >= 500 || status === 0 || e.incomplete;
      if (attempt < 3 && retriable && !e.truncated) {
        emitSafe({ t: 'warn', msg: `API ${status || '网络'}错误${e.incomplete ? '（流中断）' : ''}，${delays[attempt] / 1000}s 后重试（${attempt + 1}/3）` });
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      e.status = status;
      if (accUsage) e.usage = accUsage; // 最终失败也带着已发生的用量
      throw e;
    }
  }
}

// ---------- 历史压缩（按完整消息组切割：assistant(tool_calls) 与其全部 tool 结果同生同死） ----------
// 返回 true=确实压缩了（消息数减少）；false=压无可压/失败——调用方据此熔断，绝不能
// 在「没减少任何内容」时返回 true（那会让超限请求原样重试到迭代上限）。
// 结构化状态块：公式/决策/数据版本/运行——这些不依赖聊天摘要存活（deepseek-glm 复审 P1：
// 消息中部的边界条件在交给摘要模型前就被截掉；存档里存在≠推理时可访问）。
// 既注入压缩请求（让摘要模型看到），也逐字写进压缩后的替换消息（压缩后仍可访问）。
function stateBlock(session, appDir) {
  const f = (session.formulas || []).map(x => `${x.name} = ${x.expression}（来源:${x.source}；状态:${x.state || '已登记'}${x.confirmed ? '，已确认' : ''}）`).join('；') || '无';
  const d = (session.decisions || []).slice(-12).map(x => {
    const val = x.status === 'resolved' ? '选中:' + x.chosen_option
      : x.status === 'auto' ? '全自动选推荐:' + (x.chosen_option || '智能体自定')
      : x.status === 'rejected' ? '否定:' + x.rejected_option
      : x.status === 'delegated' ? '委托智能体定夺'
      : x.status === 'custom' ? '自定义:' + (x.custom_text || '').slice(0, 80)
      : x.status; // deferred / ambiguous
    const j = x.judge && x.judge.ok
      ? `；判断层:${x.judge.choice_id}/${Number(x.judge.confidence || 0).toFixed(2)}${x.judge.reason ? '（' + x.judge.reason.slice(0, 100) + '）' : ''}`
      : '';
    return `${x.question} → ${val}（来源:${x.source || '历史未标注'}；理由:${x.rationale || '未填写'}${x.basis ? '；依据:' + x.basis : ''}${x.tradeoff ? '；权衡:' + x.tradeoff : ''}${x.risk ? '；风险:' + x.risk : ''}${j}）`;
  }).join('；') || '无';
  // 题目契约逐字注入（华数杯复审 P1 + 应用层复审 P1：实体裁剪规则等关键题设独立于
  // 聊天摘要存活——长对话压缩后契约不变；正常轮次请求也要看到契约，不能只在压缩时可见）。
  // 完整保留所有契约条目（审计复现：超过 60/20 时被静默截断，首条和长条目尾部丢失）。
  const contractList = session.contract || [];
  const c = contractList.length
    ? contractList.map(x => `[${x.kind}:${x.key || ''}] ${String(x.text || '').slice(0, 600)}（${x.source}）`).join('\n')
    : '无（读题后应 contract_register 登记）';
  const curEpoch = session.data_epoch || 0;
  const lastRuns = (session.runs || []).filter(x => x.ok && !x.unstable && (x.epoch || 0) === curEpoch).slice(-5).map(x => x.run_id).join(',') || '无（当前版本无有效运行）';
  // 题目任务表：按实际问题数追踪，阶段进度让 reviewer 共看。
  const qgList = session.question_graph || [];
  const qg = qgList.length
    ? qgList.map(q => {
      const deps = (q.deps || []).map(d => 'Q' + d).join('+') || '—';
      const asm = (q.assumptions || []).length ? ` 假设${q.assumptions.length}条` : '';
      return `[Q${q.id} ${q.title || '问题' + q.id}] ${q.status} | 路线:${q.route || '未定'}${q.route_alt ? '（备选:' + q.route_alt.join('/') + '）' : ''} | 依赖:${deps}${asm}`;
    }).join('\n')
    : '无（建议读题后用 question_graph({op:"upsert", id:1, ...}) 按实际题目登记各问）';
  const imp = (session.question_impacts || []).slice(-3).map(x => `[${new Date(x.at).toLocaleTimeString()} 问题${x.problem_id} ${x.event || '修订'} → 下游Q${(x.downstream || []).join('、Q') || '无'} 需重算]`).join('\n') || '无';
  // 附件清单（上传时自动解析：PDF 文本层/Excel 工作表/标题猜测——避免模型为「这 PDF 有没有文本」再花 vision_read 的钱）
  const att = attachmentBlock(session);
  // 环境体检（应用层复审 §10：math/code 模式新建会话时自动跑一次）
  const env = session.env_report || null;
  const envLine = env ? (() => {
    const parts = [];
    if (env.python && env.python.ok) {
      const pkgs = Object.entries(env.python.packages || {}).filter(([_, v]) => v === '✓').map(([k]) => k).join('/');
      parts.push(`Python ${env.python.version}(${pkgs || 'no-pkgs'})`);
    } else if (env.python && !env.python.ok) { parts.push(`Python ✗ ${env.python.error || ''}`); }
    if (env.matlab && env.matlab.ok) parts.push(`MATLAB ${env.matlab.version}`);
    else if (env.matlab && !env.matlab.ok) parts.push(`MATLAB ✗ ${env.matlab.error || ''}`);
    if (env.workspace) parts.push(`工作区文件 ${env.workspace.file_count || 0} 个`);
    return `\n环境体检: ${parts.join(' | ')}`;
  })() : '';
  // 经验库规模与知识库状态（压缩不可丢的行级信号：让模型知道有没有家底可查）
  let expLine = '';
  try {
    if (appDir) {
      const mem = require('./memory').stats(appDir);
      const kbs = require('./kb').status(appDir);
      expLine = `\n经验库: ${mem.total ? `${mem.memory}条记忆+${mem.lessons}条教训` : '空'} | 知识库: ${kbs.built ? `${kbs.docs}篇/${kbs.chunks}块${kbs.builtin_docs ? `，内置精选${kbs.builtin_docs}篇` : ''}${kbs.builtAt ? `(${kbs.builtAt})` : ''}` : '未构建(kb_build)'}`;
    }
  } catch {}
  // 守恒/平衡审计状态（commit 门禁项）：逐问可见，压缩不可丢
  let consLine = '';
  if (session.mode === 'math') {
    const recs = session.conservation || [];
    const qids = (session.question_graph || []).map(q => q.id);
    if (qids.length) {
      consLine = '\n守恒审计: ' + qids.map(qid => {
        const r = [...recs].reverse().find(x => x.question === qid);
        if (!r) return `Q${qid} 未登记`;
        if (r.kind === 'na') return `Q${qid} 不适用`;
        return r.pass ? `Q${qid} ✓${(r.rel * 100).toFixed(3)}%` : (r.waived ? `Q${qid} 已豁免${(r.rel * 100).toFixed(2)}%` : `Q${qid} ✗${(r.rel * 100).toFixed(3)}%`);
      }).join(' · ') + '（commit 要求：通过/不适用+替代检验/豁免+理由，三选一）';
    }
  }
  // 比赛时钟 + 假设表 + 迭代记录（v2.5 螺旋层）——与契约同层：长对话压缩后仍可访问
  let spiralLine = '';
  try {
    if (session.contest) {
      spiralLine = `\n比赛时钟: ${spiral.clockLine(session)}`;
      const asm = spiral.assumptionList(session);
      if (asm.length) {
        const hi = asm.filter(x => x.risk === 'high' && x.status === 'open').map(x => x.id).join('、') || '无';
        spiralLine += `\n假设表 ${asm.length} 条（高风险未决: ${hi}）:\n${spiral.assumptionBlock(session)}`;
      }
      const it = spiral.iterationList(session);
      if (it.length) {
        spiralLine += '\n迭代记录:\n' + it.slice(-6).map(x => {
          const crit = x.criterion && x.criterion.success ? ` | 判据:${String(x.criterion.success).slice(0, 60)}` : '';
          const res = x.result ? ` → ${x.result.verdict}${x.result.run_id ? '(' + x.result.run_id + ')' : ''}` : '';
          return `[${x.id} ${x.status}${x.round ? ' 第' + x.round + '圈' : ''}] 靶:${(x.assumption_ids || []).join('+') || '—'} 改动:${String(x.change || '').slice(0, 70)}${crit}${res}`;
        }).join('\n');
      }
    }
  } catch { spiralLine = ''; }
  const rtOpen = redteamBlockers(session, { final: true });
  const rtLine = rtOpen.length
    ? `\n红队未结项: ${rtOpen.map(r => `[${r.id} ${r.severity} ${r.surface || '验收'}] ${String(r.claim || '').slice(0, 100)}${r.validation_errors && r.validation_errors.length ? '｜' + r.validation_errors.join('；') : ''}`).join('\n')}`
    : '';
  // M-5：子代理回传的候选教训——主代理审阅后用 lesson_record({from_pending:"PLn"}) 走既有门禁入库。
  // 放在状态块里（压缩不可丢），否则子代理的一手经验出了子会话就蒸发。
  const pl = (session.pending_lessons || []).filter(x => x && x.status === 'pending');
  const plLine = pl.length
    ? `\n子代理候选教训（待你审阅，确认有价值用 lesson_record({from_pending:"id"}) 入库，无价值忽略）:\n` +
      pl.slice(-6).map(x => `- [${x.id}]（${x.from || 'sub'}）${x.situation ? x.situation + ' | ' : ''}${x.rule}`).join('\n')
    : '';
  const poolLine = (session.pool_tasks || []).length
    ? '\n子任务执行状态（完成不等于已验收；中断任务先查产物再决定重跑）:\n'
      + session.pool_tasks.slice(-12).map(x => `- ${x.task_id} ${x.crew}: ${x.status} | 验收:${x.acceptance || 'pending'}`
        + (x.handoff && x.handoff.archive ? ` | 原文:${x.handoff.archive}` : '')).join('\n') : '';
  const contestLine = session.mode === 'math'
    ? '\n赛事规则档（压缩后保留，真实性仍须回读）: ' + JSON.stringify(session.contest_rules || {})
      + '\n主张追溯: ' + (session.claim_trace_required ? '已启用；用claim_trace view核验当前版本。数值结论绑定正式运行result_files与JSON字段；解析主张kind=analytic须绑定推导、前提和verification_run回执；示意图register_diagram绑定题设/公式/规格或解析证明。摘要及图文变化后重新核验登记；有限测试不等于数学证明。' : '未登记；需要逐问来源链时先claim_trace enable，再计算和登记。')
      + '\n优化核验账本: ' + ((session.optimization_checks || []).map(r => `Q${r.question_id} ${r.run_id} ${r.report?.level} ${r.source?.path}`).join('；') || '无') + '；用optimization_check view复核当前约束、目标与范围；数值最优主张需optimality及范围限定，有限域穷举不证明原题模型正确。'
      + '\n绘图插件账本: ' + ((session.plugin_runs || []).slice(-4).map(r => `${r.plot_run_id} ${r.plugin_id} v${r.version} 来源=${r.source?.run_id} ${r.ok ? '已产出' : '失败'}`).join('；') || '无') + '；这不是数值求解或视觉验收，当前来源版本用claim_trace view核验。'
      + '\n独立复算: ' + (session.independent_verification ? `已登记${(session.independent_verification.metrics || []).length}项，final实时核验文件与口径；登记不等于执行证明` : '未登记，不得声称已执行')
      + '\n当前任务范围: ' + (session.task_scope || 'solve') + '；宿主复算回执: ' + (session.verification_runs || []).map(r => `${r.run_id}:${r.ok ? '成功' : '失败'}`).slice(-6).join('、')
      + '\n复核问题: ' + (session.review_findings || []).map(r => `${r.id} ${r.severity} ${r.status}`).join('；') + '；用review_finding逐项绑定修订位置与证据，不能仅写已修复。'
      + '\n对拍报告: ' + (session.comparison_reports || []).slice(-6).map(r => r.markdown_rel).join('、') + '；同口径复算用result_compare，不同方案单列，禁止手填偏差。'
      + '\n人工/提交: ' + (session.support_pack?.submission_ready === false ? 'AI详情草稿待队员补充与审核，不是可提交认证' : '按实际记录，未确认不得代填') : '';
  return `【结构化状态（压缩不可丢，逐字保留，勿改写数值）】
题目契约: ${c}
已登记公式: ${f}
决策记录（按来源区分人工与系统）: ${d}
题目任务表:
${qg}
${specSummary(session)}
最近问题级联失效: ${imp}${consLine}${spiralLine}${rtLine}${plLine}${poolLine}${contestLine}
数据版本: epoch=${curEpoch}（此前代码/数据/契约若已变更，旧数值结论需重算）
成功计算: ${session.compute_runs || 0} 次；当前版本有效运行: ${lastRuns}
未验证标记: ${session.unverifiedNumeric ? '存在（有数值结论未经当前版本运行验证）' : '无'}${att}${envLine}${expLine}`;
}

// M-5：从子代理报告文本提取候选教训行（【候选教训】场景 | 规则），存入主会话待审队列。
// 入库权仍在主代理手里（子代理被硬禁止 lesson_record 是有意的）——这里只负责"不丢"。
function collectCandidateLessons(parent, reportText, fromLabel, originatingRole) {
  const lines = String(reportText || '').split(/\r?\n/);
  const found = [];
  for (const ln of lines) {
    const m = ln.match(/【候选教训】\s*(.+)/);
    if (!m) continue;
    const body = m[1].trim();
    if (!body) continue;
    const parts = body.split('|').map(s => s.trim());
    const rule = parts.length > 1 ? parts.slice(1).join(' | ') : parts[0];
    const situation = parts.length > 1 ? parts[0] : '';
    if (!rule) continue;
    found.push({ situation: situation.slice(0, 200), rule: rule.slice(0, 300) });
    if (found.length >= 3) break; // 每个子代理最多回传 3 条，防刷屏
  }
  if (!found.length) return 0;
  parent.pending_lessons = parent.pending_lessons || [];
  parent.pending_seq = parent.pending_seq || 0;
  for (const f of found) {
    parent.pending_seq += 1;
    parent.pending_lessons.push({ id: 'PL' + parent.pending_seq, ...f, from: fromLabel,
      role: require('./model_roles').normalizeRole(originatingRole) || null, at: Date.now(), status: 'pending' });
  }
  // 只保留最近 20 条：队列是待审缓冲区不是仓库，更早的要么已入库要么已证明没人在意
  if (parent.pending_lessons.length > 20) parent.pending_lessons = parent.pending_lessons.slice(-20);
  return found.length;
}

// 审批请求：把卡片推给 UI，等用户点。宿主（server）通过 deps.requestApproval 注入实现；
// 没有宿主实现时（CLI/测试）按"无人可审批"处理——返回 timeout 让模型换路，绝不静默放行。
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
function requestApproval(ctx, req) {
  const host = ctx && ctx.deps && typeof ctx.deps.requestApproval === 'function' ? ctx.deps.requestApproval : null;
  if (!host) {
    ctx && ctx.emit && ctx.emit({ t: 'warn', msg: `请求审批模式生效，但当前宿主没有审批通道（${req.tool} 未执行）。用桌面界面或把权限切回「完全访问」。` });
    return Promise.resolve('timeout');
  }
  return Promise.race([
    host(req),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), APPROVAL_TIMEOUT_MS).unref?.()),
  ]);
}

function serializeSummaryMessage(m) {
  let c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || m.tool_calls || '');
  if (m.tool_calls) c += ' [调用工具: ' + m.tool_calls.map(t => t.function.name).join(',') + ']';
  c = c.replace(/\s+/g, ' ');
  if (c.length > 2500) {
    const head = c.slice(0, 1500), tail = c.slice(-1000);
    const middle = c.slice(1500, -1000);
    const keySegs = middle.split(/(?<=[。；;\n])/)
      .filter(s => /(约束|边界|假设|条件|恒有|保持|给定|初始|不得超过|不低于|必须|要求|等于|越界|交集|裁剪|回绕|平移|周期|片段|复制|导通|电极|圆柱|立方体|半径|端面)/.test(s))
      .slice(0, 8).join(' ').slice(0, 800);
    c = head + (keySegs ? ` …[中部关键片段] ${keySegs} …` : ' …[中略]… ') + tail;
  }
  return `[${m.role}] ${c}`;
}

function chunkSummaryMessages(mid, maxChars = 50000) {
  const groups = [];
  for (let i = 0; i < mid.length;) {
    const start = i++;
    while (i < mid.length && mid[i].role === 'tool') i++;
    groups.push(mid.slice(start, i).map(serializeSummaryMessage).join('\n'));
  }
  const chunks = [];
  let current = '', size = 0;
  for (const group of groups) {
    if (current && size + group.length + 1 > maxChars) {
      chunks.push(current);
      current = ''; size = 0;
    }
    current += (current ? '\n' : '') + group;
    size += group.length + (size ? 1 : 0);
  }
  if (current) chunks.push(current);
  return chunks;
}

async function compactHistory(session, deps, model, apiKey, provider, spend, providerKey) {
  const msgs = session.messages;
  const before = msgs.length;
  if (msgs.length < 10) return false;
  // 找切割点：从前往后保留 8 条以上完整组（组边界=非 tool 消息的开头）
  const groupStarts = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== 'tool') groupStarts.push(i);
  }
  if (groupStarts.length <= 9) return false; // 完整组太少，压无可压（如实报告失败）
  const keepGroups = 8;
  const cut = groupStarts[groupStarts.length - keepGroups];
  const head = msgs[0];
  const mid = msgs.slice(1, cut);
  const tail = msgs.slice(cut);
  // 分块以完整工具消息组为单位，不把 assistant(tool_calls) 与其 tool 结果拆到不同压缩请求。
  const historyChunks = chunkSummaryMessages(mid);
  const sys = '你是会话压缩器。把对话历史压缩成任务状态摘要，保留：目标与约束、已完成工作、所有关键数值/文件路径/公式、当前进行中的工作、下一步计划、用户明确的选择与偏好。开头的【结构化状态】块由引擎在摘要后自动原样附回——你不要复述它，只压缩对话历史本身。数学数值、公式、约束条件必须逐字保留，禁止四舍五入或改写。输出≤1500字，纯文本。';
  try {
    // 压缩模型解析 + 协议随提供商切换（旧版解析了 GLM 却仍按 OpenAI 格式发 → 走错路径）；
    // 无 key 时回退当前会话提供商——回退必须整体回退（提供商+协议+模型名+凭据），
    // 不能 GLM 通道配 deepseek-flash 模型名（复审 P2：GLM-only 探针得到错误组合）
    let sumPk = providerForModel(deps.settings.summarize_model || 'deepseek-flash', deps.settings);
    if (!sumPk) throw new Error('压缩模型未登记或已删除，请在设置重新选择');
    if ((deps.settings.disabled_models || []).includes(sumPk + ':' + apiModelOf(deps.settings.summarize_model || 'deepseek-flash', sumPk))) throw new Error('压缩模型已被禁用，请在设置重新选择');
    let sumProvider = resolveProvider(sumPk, deps.settings);
    let sumKey = sumPk === providerKey ? apiKey : keyFor(sumPk, deps.appDir);
    let fellBack = false;
    if (!sumKey && providerKey && apiKey) {
      sumPk = providerKey; sumProvider = provider; sumKey = apiKey; fellBack = true;
    }
    if (!sumKey) throw new Error(`压缩模型所需 Key 未配置（${sumProvider.name}），且当前提供商亦无 Key`);
    const sumModelRaw = deps.settings.summarize_model || 'deepseek-flash';
    // 回退时模型名换成当前会话模型（它在该提供商上已知可用）；正常路径用设置的压缩模型
    const sumModel = fellBack ? apiModelOf(model, sumPk) : apiModelOf(sumModelRaw, sumPk);
    if ((deps.settings.disabled_models || []).includes(sumPk + ':' + sumModel)) throw new Error('回退压缩模型已被禁用');
    const isSumAnthropic = sumProvider.kind === 'anthropic';
    const summaries = [];
    for (let i = 0; i < historyChunks.length; i++) {
      const serial = stateBlock(session) + `\n\n以下是待压缩的对话历史（第 ${i + 1}/${historyChunks.length} 段；边界条件、约束、公式必须逐字保留）：\n` + historyChunks[i];
      const chunkSys = historyChunks.length > 1 ? sys + `\n当前只压缩第 ${i + 1}/${historyChunks.length} 段，输出≤1000字。` : sys;
      let r;
      try {
        r = await callWithReasoning(chatStream, isSumAnthropic ? {
          kind: 'anthropic', base: sumProvider.base, key: sumKey, model: sumModel,
          system: chunkSys,
          messages: [{ role: 'user', content: serial }],
          maxTokens: 8192,
          temperature: sumProvider.temperatureLock != null ? sumProvider.temperatureLock : 0.2,
          signal: deps.abort ? deps.abort.signal : undefined,
          cacheDiagnostics: { appDir: deps.appDir, session_id: session.owner_session_id || session.id, project_id: session.project_id, provider_key: sumPk, lane: 'summarize' },
        } : {
          kind: sumProvider.kind, base: sumProvider.base, key: sumKey, model: sumModel,
          messages: [{ role: 'system', content: chunkSys }, { role: 'user', content: serial }],
          temperature: sumProvider.temperatureLock != null ? sumProvider.temperatureLock : 0.2,
          maxTokens: historyChunks.length > 1 ? 8192 : 16384,
          signal: deps.abort ? deps.abort.signal : undefined,
          cacheDiagnostics: { appDir: deps.appDir, session_id: session.owner_session_id || session.id, project_id: session.project_id, provider_key: sumPk, lane: 'summarize' },
        }, resolveReasoning(deps.settings, sumPk, sumProvider, sumModel), reasoningRecorder(session, deps.emit || (() => {}), 'summarize'));
      } catch (e) {
        if (e.usage && e.usage.prompt_tokens != null) { try { spend(sumModel, e.usage, 'summarize', !!e.usage_partial); } catch {} }
        throw e;
      }
      if (r.usage) spend(sumModel, r.usage, 'summarize');
      if (!String(r.content || '').trim()) throw new Error(`压缩第 ${i + 1} 段返回空摘要`);
      summaries.push(`[分块 ${i + 1}/${historyChunks.length}]\n${r.content}`);
    }
    // 状态块随压缩结果回写：压缩后这些结构化事实仍在上下文里（不依赖模型"记得"摘要要保留）
    const summary = `【历史压缩摘要（此前 ${mid.length} 条消息，${historyChunks.length} 个完整消息组块）】\n${summaries.join('\n\n')}\n\n${stateBlock(session)}\n【记忆】\n${(session.memory || []).map(m => '- ' + m.text).join('\n') || '（无）'}`;
    // 保存完整原文后才替换活动窗口；磁盘失败由 catch 返回 false，原历史不变。
    const archive = archiveContext((deps.sandbox && deps.sandbox.root) || deps.appDir, session.id, msgs);
    session.context_archives = session.context_archives || [];
    session.context_archives.push({ at: Date.now(), path: archive.path, sha256: archive.sha256,
      original_messages: before, retained_messages: tail.length + 2 });
    session.messages = [head, { role: 'user', content: summary
      + `\n【原始历史归档】${archive.path}\n${archive.sha256}（仅活动窗口压缩，原文可追溯）` }, ...tail];
    deps.emit({ t: 'compact_done', kept: session.messages.length });
    deps.emit({ t: 'cache_reset', kind: 'compact', reason: '历史压缩',
      detail: `${before} 条 → ${session.messages.length} 条，原文已归档` });
    // 进度校验：确实减少了消息才叫成功（没减少却返回 true = 调用方会原样重试超限请求）
    return session.messages.length < before;
  } catch (e) {
    // 压缩失败返回 false，由调用方计数熔断；不再盲目截断丢证据
    deps.emit({ t: 'warn', msg: '历史压缩失败：' + String(e.message || e).slice(0, 200) });
    return false;
  }
}

// ---------- 子代理 ----------
const SUB_PROFILES = new Set(['worker', 'reviewer', 'redteam']);
const SUB_EXCLUDED = new Set(['ask_user', 'job_wait', 'dispatch_external', 'subagent_run', 'todo_write',
  'memory_write', 'lesson_record', 'skill_save', 'kb_build', ...(DEEP_ONLY || [])]);
function assertSubagentProfile(profile) {
  if (!SUB_PROFILES.has(profile)) {
    throw new Error(`未知子代理 profile：${String(profile || '')}。允许值：${[...SUB_PROFILES].join('/')}；拒绝静默降级为全写 worker。`);
  }
  return profile;
}

async function runSubagent(ctx, deps, profile, prompt, meta, spend) {
  assertSubagentProfile(profile);
  meta = meta || {};
  const crew = meta.crew ? modes.CREW[meta.crew] : null;
  if (meta.crew && !crew) throw new Error(`未知固定职责 crew：${meta.crew}；允许 ${Object.keys(modes.CREW).join('/')}`);
  if (crew && !modes.isExtreme(ctx.session)) throw new Error('三固定职责仅在 extreme 档可用');
  if (crew && profile !== 'worker') throw new Error('固定职责 crew 必须使用 worker profile，由职责白名单限制权限');
  const isRedteam = profile === 'redteam';
  if (isRedteam && !modes.isExtreme(ctx.session)) throw new Error('redteam 仅在 extreme 档可用；deep 请使用 deep_debate 的挑错派');
  const emitSafe = ctx.emit;
  const isReviewer = profile === 'reviewer';
  const role = isReviewer || isRedteam ? 'reviewer' : roleForSubagent(profile, meta, prompt);
  const finishHandoff = (report, reason, childRunIds = [], messages = []) => {
    const handoff = makeHandoff({ workspace: ctx.workspace, sessionId: ctx.session.id,
      taskId: meta.taskPrefix, role, report, reason, childRunIds, messages });
    if (!handoff.archive) {
      // 极端磁盘失败时保留内存原文，交给正常会话持久化路径兜底，不静默丢掉长报告。
      ctx.session.subagent_recovery = ctx.session.subagent_recovery || [];
      ctx.session.subagent_recovery.push({ at: Date.now(), task_id: meta.taskPrefix || null, reason, report, messages });
    }
    if (handoff.warnings.length && ctx.emit) ctx.emit({ t: 'warn', msg: handoff.warnings.join('；') });
    return meta.returnHandoff ? handoff : formatHandoff(handoff);
  };
  // 红队是 READ_ONLY + 明确探针工具，不是全写 worker。
  const toolNames = new Set(isRedteam ? [...READ_ONLY, ...RED_EXTRA]
    : crew ? [...READ_ONLY, ...crew.tools]
    : isReviewer ? [...READ_ONLY] : TOOLS.map(t => t.name).filter(n => !SUB_EXCLUDED.has(n)));

  let sys = isRedteam
    ? `你是红队，任务是尝试证伪主解，不是审查文风。主动构造反例，结论由实际证据决定；允许报告本次攻击未发现反例，禁止为了完成任务编造缺陷。七面清单必须逐项交代：A1数值鲁棒性、A2假设脆弱性、A3数据泄漏、A4量纲/口径、A5过度外推、A6图表正文一致、A7可复现性；未攻击的面必须说明不适用原因。A6优先复用 reconcile_artifact，A7优先复用 repro_check。
你只能写 findings/redteam/。探针两段式：① fs_write 落 findings/redteam/<面>_<claim>.py；② python_run(code:"exec(open('findings/redteam/<脚本>',encoding='utf-8').read())")。禁止 formal:true/uses_formulas，探针不构成主证据。需要重跑主解时在隔离副本中运行，输出也只许落在该目录。
退出码语义：exit 非0=攻击成功/结论被证伪(refuted)，exit 0=结论守住(held)。最后必须写 findings/redteam/report.json，字段包括 claim、surface、script、script_hash("sha256:"+文件SHA256)、cmd、exit、verdict、counterexample、repro、severity、surfaces(七项，每项{surface,attacked,reason,result})。报告 exit 必须与引擎实际输出一致，不得凭措辞编造。工作区与产物边界见本次任务上下文`
    : isReviewer
      ? `你是独立只读审查员。对主代理的工作做独立核查：先自己形成检查标准，再对照作者结论，找出错误、漏洞、未验证的声明。你有真实工具（读文件/跑python，python 处于只读守卫模式，写盘会被拒绝）。证据必须来自实际检查。返回：①检查标准 ②发现的问题（按严重度分级，附证据/复现命令）③确认无误的部分。不做修改，不改文件。工作区与产物边界见本次任务上下文`
      : `你是执行子代理，独立完成主代理委派的具体任务。有真实文件/命令工具。做实际工作并验证，返回：结果摘要 + 关键产物路径 + 验证证据。不要委派他人。工作区与产物边界见本次任务上下文
如果你在这次任务里踩了坑并总结出可复用经验（环境坑/工具坑/方法坑），在报告末尾用「【候选教训】场景 | 下次怎么做」格式逐条列出（最多 3 条，只写亲身踩过并验证的，不要写泛泛原则）——主代理会审阅后决定是否入经验库。`;
  if (crew) {
    sys += `\n\n【固定职责：${crew.label}】${crew.role}\n【独立性四条】说明验证方法；与主解共用的数据/代码/假设；能排除的错误；仍可能共有的错误。同内核换随机种子、同批数据换拟合形式不算独立验证。`;


  }

  if (ctx.session.mode === 'math' && !isRedteam) {
    sys += '\n\n' + materialPolicyBlock() + '\n\n' + require('./contest_quality').contestWritingBlock(ctx.session);
    sys += projectPlan.composedBlock(deps.appDir, ctx.session, deps.settings, wrapMaterial,
      isReviewer ? ['review'] : role === 'writer' ? ['figures'] : ['research', 'figures']);
  }

  // 首轮任务 prompt 存入 messages（否则第二轮模型请求就丢了原始委派任务）
  // 继承父会话的公式/契约/运行快照（只读副本，避免子代理误改主任务状态）；
  // 子代理内部声明 formulaDepsBlock 检查会引用这里的 formulas。
  const parent = ctx.session;
  const modelResolution = resolveRoleModel({
    role, settings: deps.settings, appDir: deps.appDir,
    sessionModel: ctx.resolvedModel || parent.model || deps.settings.default_model,
    excludeModels: meta._excludeModels || [],
  });
  if (modelResolution.warnings.length) {
    emitSafe({ t: 'warn', msg: `子代理模型路由（${role || '继承'}）：${modelResolution.warnings.join('；')}${modelResolution.ok ? `；当前使用 ${modelResolution.model}` : ''}` });
  }
  if (!modelResolution.ok) {
    const msg = `[子代理终止] 没有可用模型：${modelResolution.warnings.join('；') || '角色路由为空'}`;
    emitSafe({ t: 'subagent', phase: 'error', profile, role, msg });
    return finishHandoff(msg, 'no_model');
  }
  const model = modelResolution.model;
  const providerKey = modelResolution.providerKey;
  const provider = modelResolution.provider;
  const apiModel = apiModelOf(model, providerKey);
  const apiKey = keyFor(providerKey, deps.appDir);
  const subSession = {
    id: parent.id + ':sub:' + Date.now(), mode: parent.mode, model,
    owner_session_id: parent.owner_session_id || parent.id,
    project_id: parent.project_id, role: role || require('./model_roles').normalizeRole(parent.role) || 'modeler',
    effort: 'fast', _t0: Date.now(),
    messages: [{ role: 'user', content: String(prompt || '') }],
    todos: [], memory: [], usage: { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, calls: 0, cost: 0 },
    formulas: (parent.formulas || []).slice(),
    contract: (parent.contract || []).slice(),
    model_specs: (parent.model_specs || []).map(x => ({ ...x, spec: JSON.parse(JSON.stringify(x.spec)) })),
    require_model_spec: !!parent.require_model_spec,
    paper_profile: parent.paper_profile,
    contest_kind: require('./contest_workflows').contestKind(parent),
    contest_rules: parent.contest_rules,
    title: parent.title,
    skill_plan_snapshot: parent.skill_plan_snapshot ? JSON.parse(JSON.stringify(parent.skill_plan_snapshot)) : null,
    data_epoch: parent.data_epoch || 0,
    runs: [], compute_runs: 0,
  };
  // 固定角色/工具前缀保持稳定；路径、工单编号、派活理由放在动态任务消息中。
  subSession.messages.push({ role: 'user', content: `【本次任务上下文】工作区: ${ctx.workspace}`
    + (meta.taskPrefix ? `\n【产物边界】脚本与结果只能使用前缀 ${meta.taskPrefix}，不要修改其他池任务的产物。` : '')
    + (meta.why ? `\n【派活理由】${String(meta.why).slice(0, 500)}` : '') });
  // Recall is computed once per task and stays outside the stable system prefix.
  try {
    const memLib = require('./memory');
    const hits = memLib.recall(deps.appDir, `${role || ''} ${String(prompt || '')}`, {
      limit: 5, project: subSession.project_id, role: subSession.role,
    });
    if (hits.length) {
      subSession.messages.push({ role: 'user', content: memLib.formatEntries(hits, '【当前角色经验召回：对照任务与证据后使用】') });
      memLib.markHit(deps.appDir, hits.map(e => e.id));
    }
  } catch {}
  const isAnthropic = provider.kind === 'anthropic';
  const subTools = (isAnthropic ? toAnthropicTools(ctx.session, ctx.settings) : toOpenAITools(ctx.session, ctx.settings)).filter(t => {
    const name = isAnthropic ? t.name : t.function.name;
    return toolNames.has(name);
  });
  // 执行层授权：reviewer 只能调用 READ_ONLY（含 python_run——独立重算能力，守卫只读模式兜底）；
  // worker 不能调用交互类工具。就算模型返回了未广告的 fs_write，executeTool 也会按 allowTools 拒绝。
  // setTodos/addMemory 覆写为写子会话自己的状态——否则闭包会串写主任务的待办/记忆。
  const subCtx = { ...ctx, session: subSession, role: subSession.role, engines: {}, allowTools: toolNames, redteamOnly: isRedteam,
    pyMode: isRedteam ? 'redteam' : (isReviewer || (crew && meta.crew !== 'coder')) ? 'ro' : 'rw',
    setTodos: (todos) => { subSession.todos = todos; },
    addMemory: (text) => { subSession.memory.push({ t: Date.now(), text }); } };
  // 输入快照基线（子代理与主代理共用工作区——子代理看到文件状态后再改，会被主代理下次刷新捕获）。
  // 子代理自己的运行若修改了已存在输入，标 unstable（与主代理同口径）。
  const subStamp = stampInputFiles(ctx.workspace);
  const ownChildRunIds = [];
  emitSafe({ t: 'subagent', phase: 'start', profile, role, model, model_source: modelResolution.source, fallback: !!modelResolution.fallback });

  const subStopper = { stop: false };
  let iter = 0, outText = '';
  let terminalReason = 'max_iter';
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };
  for (iter = 0; iter < SUB_MAX_ITER; iter++) {
    if (deps.stopper.stop) { terminalReason = 'stopped'; break; }
    if (!budgetCheck(subSession, deps, emitSafe)) { terminalReason = 'budget'; break; } // 子代理内同样受预算熔断
    const messages = isAnthropic
      ? buildAnthropicMessages(subSession.messages)
      : [{ role: 'system', content: sys }, ...buildRequestMessages('', subSession.messages).slice(1)];
    let res;
    try {
      const common = { base: provider.base, key: apiKey, model: apiModel, messages, tools: subTools, temperature: provider.temperatureLock != null ? provider.temperatureLock : 0.5, signal: deps.abort.signal, onDelta: () => {},
        cacheDiagnostics: { appDir: deps.appDir, session_id: parent.owner_session_id || parent.id, project_id: parent.project_id,
          provider_key: providerKey, lane: 'sub:' + subSession.role, task_id: subSession.id } };
      res = await callWithReasoning(chatStream, isAnthropic
        ? { ...common, kind: 'anthropic', system: sys, maxTokens: deps.settings.max_output_tokens || provider.defaultMaxTokens || 32768 }
        : { ...common, kind: provider.kind, maxTokens: deps.settings.max_output_tokens || 65536 },
        resolveReasoning(deps.settings, providerKey, provider, apiModel), reasoningRecorder(parent, emitSafe, 'sub'));
    } catch (e) {
      // 异常结算：失败 usage 也要入账（父会话账本），不留下「不计数的中断」黑洞
      if (e.usage && e.usage.prompt_tokens != null) {
        spend(apiModel, e.usage, 'sub', !!e.usage_partial);
        totalUsage.prompt_tokens += e.usage.prompt_tokens || 0;
        totalUsage.completion_tokens += e.usage.completion_tokens || 0;
      }
      const status = Number(e.status || 0);
      if (deps.stopper.stop || (deps.abort && deps.abort.signal.aborted)) {
        recordChildRun(parent, { profile, role, ok: false, reason: 'stopped', modelTag: model,
          ms: Date.now() - subSession._t0, usage: totalUsage, report: '[用户停止子代理]', formal: false, unstable: !!subSession._unstable });
        return finishHandoff('[子代理已取消] 已完成部分见归档，未自动重跑。', 'stopped', ownChildRunIds, subSession.messages);
      }
      if (iter === 0 && !meta._fallbackAttempted && [401, 404, 429].includes(status)) {
        const excluded = [...(meta._excludeModels || []), model];
        const next = resolveRoleModel({
          role, settings: deps.settings, appDir: deps.appDir,
          sessionModel: ctx.resolvedModel || parent.model || deps.settings.default_model,
          excludeModels: excluded,
        });
        if (next.ok) {
          recordChildRun(parent, { profile, role, ok: false, reason: 'provider_fallback', modelTag: model,
            ms: Date.now() - subSession._t0, usage: totalUsage, report: `[${status}] 首次提供商调用失败，转入一次性角色回退`, formal: false, unstable: false });
          emitSafe({ t: 'warn', msg: `${role || profile} 模型 ${model} 首次调用 HTTP ${status}，未执行任何工具；一次性回退到 ${next.model}，不会重放副作用。` });
          return runSubagent(ctx, deps, profile, prompt, { ...meta, _fallbackAttempted: true, _excludeModels: excluded }, spend);
        }
      }
      emitSafe({ t: 'subagent', phase: 'error', profile, msg: String(e.message || e).slice(0, 200) });
      recordChildRun(parent, { profile, ok: false, ms: Date.now() - (subSession._t0 || Date.now()), usage: totalUsage, report: '[子代理异常终止]', formal: false, unstable: false });
      return finishHandoff(`[子代理异常终止] ${e.message}`, 'provider_error', ownChildRunIds, subSession.messages);
    }
    if (res.usage) {
      spend(apiModel, res.usage, 'sub');
      totalUsage.prompt_tokens += res.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += res.usage.completion_tokens || 0;
      totalUsage.cost += (parent.usage && parent.usage.cost) ? 0 : 0; // spend 已并入父账本
      emitSafe({ t: 'usage', usage: ctx.session.usage, last: res.usage });
      // 结算后立即复查预算：超限即刻熔断子代理，不再进入下一轮付费调用
      if (!budgetCheck(subSession, deps, () => {})) {
        emitSafe({ t: 'warn', msg: '子代理已因日预算熔断提前终止。' });
        recordChildRun(parent, { profile, ok: false, ms: Date.now() - (subSession._t0 || Date.now()), usage: totalUsage, report: '[子代理因预算熔断]', formal: false, unstable: false });
        return finishHandoff('[子代理因日预算熔断终止] 已完成部分见归档。', 'budget', ownChildRunIds, subSession.messages);
      }
    }
    const am = { role: 'assistant', content: res.content || '' };
    if (res.reasoning) am.reasoning_content = res.reasoning;
    if (res.tool_calls && res.tool_calls.length) am.tool_calls = res.tool_calls;
    if (res.anthropic_blocks) am.anthropic_blocks = res.anthropic_blocks;
    if (res.responses_items) am.responses_items = res.responses_items;
    subSession.messages.push(am);
    if (res.finish === 'length' || res.finish === 'max_tokens') {
      outText = res.content || '(模型输出达到上限，未执行可能截断的工具调用)';
      terminalReason = 'output_truncated'; break;
    }
    if (!res.tool_calls || !res.tool_calls.length) {
      outText = res.content || ''; terminalReason = outText.trim() ? 'stop' : 'empty_report'; break;
    }
    for (const tc of res.tool_calls) {
      let args, r;
      const t0 = Date.now();
      try { args = safeParseArgs(tc.function.arguments); } catch (e) {
        subSession.messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: e.message }) });
        continue;
      }
      // 统一门控：子代理的 python_run / shell_run 也要走公式依赖检查 + unstable 检测
      // （审计：失败公式正式求解主代理拒绝、子代理放行——同入口同规则）
      const depsBlock = formulaDepsBlock(subSession, tc.function.name, args);
      if (depsBlock) {
        r = { ok: false, error: depsBlock };
      } else {
        const preStamp = isComputeTool(tc.function.name, args) ? subStamp : null;
        try { r = await executeTool(subCtx, tc.function.name, args); }
        catch (e) { r = { ok: false, error: String(e.message || e) }; }
        // 计算工具：运行期间改了输入 → 标 unstable（不直接拒绝，让子代理看到结果，但该结果不作为正式证据）
        if (preStamp && r.ok) {
          const after = stampInputFiles(ctx.workspace);
          // ISS-10 同根修复：hash 比内容而非对象引用（旧代码 preStamp[p]!==after[p] 恒为 true）
          const stampSame = (a, b) => ((a && typeof a === 'object' ? a.hash : a) === (b && typeof b === 'object' ? b.hash : b));
          const changedFiles = Object.keys(preStamp).filter(p => !(p in after) || !stampSame(after[p], preStamp[p]));
          if (changedFiles.length) {
            subSession._unstable = true;
            r = { ...r, _unstable: true, _unstableFiles: changedFiles };
          }
        }
      }
      subSession.messages.push({ role: 'tool', tool_call_id: tc.id, content: cap(r.ok ? r.data : `[失败] ${r.error || r.data || '工具未返回错误详情'}`) });
      emitSafe({ t: 'subagent_tool', profile, role, model, name: tc.function.name, ok: r.ok, ms: Date.now() - t0 });
      // 计算工具在子代理里的运行也记入父会话的 child_runs（带 child_run_id 关联父 run_seq）
      if (isComputeTool(tc.function.name, args)) {
        const isFormal = !isRedteam && !!(args && (args.formal === true || (Array.isArray(args.uses_formulas) && args.uses_formulas.length)));
        const sig = crypto.createHash('md5').update(String(tc.function.arguments || '')).digest('hex').slice(0, 10);
        const runInputHash = inputStampHash(stampInputFiles(ctx.workspace));
        const originRunId = recordRun(subSession, {
          tool: tc.function.name, ok: !!r.ok, ms: Date.now() - t0, modelTag: model,
          out: cap(String(r.data || r.error || ''), 2400), sig, formal: isFormal,
          unstable: !!(r && r._unstable), unstable_files: r && r._unstableFiles, deps: args && args.uses_formulas, inputHash: runInputHash,
          modelSpec: isFormal ? specBinding(subSession, args) : undefined,
          resultArtifacts: r.result_artifacts,
        });
        const recordedChildId = recordChildRun(parent, {
          profile, role, originRunId,
          tool: tc.function.name,
          ok: !!r.ok,
          ms: Date.now() - t0,
          modelTag: model,
          out: cap(String(r.data || r.error || ''), 2400),
          sig,
          formal: isFormal,
          unstable: !!(r && r._unstable),
          unstableFiles: r && r._unstableFiles,
          deps: args && args.uses_formulas,
          epoch: subSession.data_epoch || 0,
          modelSpec: isFormal ? specBinding(subSession, args) : undefined,
          inputHash: runInputHash,
          resultArtifacts: r.result_artifacts,
        });
        ownChildRunIds.push(recordedChildId);
      }
    }
  }
  if (!outText) outText = terminalReason === 'max_iter'
    ? '(子代理达到迭代上限，未给出最终结论)'
    : `(子代理未给出最终结论，状态：${terminalReason})`;
  emitSafe({ t: 'subagent', phase: 'done', profile, role, model, iters: iter, reason: terminalReason });
  // 会话只保留索引，完整工具记录与报告写入工作区归档，不回灌主脑活动上下文。
  parent.subagent_logs = parent.subagent_logs || [];
  if (parent.subagent_logs.length > 30) parent.subagent_logs.shift();
  parent.subagent_logs.push({
    at: Date.now(), profile, role, model, model_source: modelResolution.source, prompt: String(prompt || '').slice(0, 500),
    iters: iter, usage: totalUsage, reason: terminalReason,
    unstable: !!subSession._unstable,
    child_run_ids: ownChildRunIds.slice(),
  });
  // 子代理总体记录（含报告文本与正式性——主代理引用时必须给出 child_run_id 链接）
  recordChildRun(parent, {
    profile, role, ok: terminalReason === 'stop', reason: terminalReason, ms: Date.now() - subSession._t0,
    modelTag: model, modelSource: modelResolution.source,
    usage: totalUsage, report: outText.slice(0, 4000),
    formal: false, unstable: !!subSession._unstable,
  });
  let redteamNote = '';
  if (isRedteam) {
    const audit = finalizeRedteam(parent, ctx.workspace);
    redteamNote = `\n\n[红队验收 ${audit.id}] ${audit.ok ? '报告、脚本 hash 与引擎退出码对账通过' : '验收未通过：' + audit.issues.join('；')}`;
    emitSafe({ t: 'redteam', id: audit.id, ok: audit.ok, issues: audit.issues, status: audit.row.status });
  }
  // M-5：收编子代理回传的候选教训（worker 通道；reviewer/redteam 的报告是证据链材料，不收教训）
  let lessonNote = '';
  if (!isReviewer && !isRedteam) {
    const n = collectCandidateLessons(parent, outText, `${profile}${role ? '/' + role : ''}`, role);
    if (n > 0) {
      lessonNote = `\n\n[候选教训已回传 ${n} 条] 已进主会话待审队列（见结构化状态块），审阅后用 lesson_record({from_pending:"PLn"}) 入库。`;
      emitSafe({ t: 'warn', msg: `子代理回传 ${n} 条候选教训，已进待审队列。` });
    }
  }
  return finishHandoff(`[${profile === 'reviewer' ? '独立审查' : isRedteam ? '红队' : '子代理'}报告]\n`
    + outText + redteamNote + lessonNote, terminalReason, ownChildRunIds, subSession.messages);
}

// 子代理运行记录：独立于 session.runs，避免污染主证据链。
// 每条带 child_run_id + parent_run_id（关联到主账本当前的 run_seq），
// 标记 formal/unstable（统一门控口径）；主代理引用子代理数字必须给 child_run_id 链接。
function recordChildRun(parent, { profile, role, originRunId, originSessionId, originAt, tool, ok, reason, ms, modelTag, modelSource, out, sig, formal, unstable, unstableFiles, deps, epoch, inputHash, boundaryMode, keyParams, report, usage, modelSpec, resultArtifacts }) {
  parent.child_seq = parent.child_seq || 0;
  parent.child_seq += 1;
  parent.child_runs = parent.child_runs || [];
  const childRunId = 'subrun' + parent.child_seq;
  parent.child_runs.push({
    child_run_id: childRunId,
    origin_run_id: originRunId || null,
    origin_session_id: originSessionId || null,
    origin_t: originAt || null,
    parent_run_id: parent.run_seq ? 'run' + parent.run_seq : null,
    t: Date.now(), profile, role: role || null, tool: tool || null, ok: !!ok, reason: reason || (ok ? 'stop' : 'failed'), ms: ms || 0,
    model: modelTag, model_source: modelSource || null, epoch: epoch || (parent.data_epoch || 0),
    out: out || '', sig: sig || '', formal: !!formal, unstable: !!unstable,
    unstable_files: Array.isArray(unstableFiles) && unstableFiles.length ? unstableFiles.slice(0, 5) : undefined,
    input_hash: inputHash || null,
    model_spec: modelSpec || null,
    result_artifacts: resultArtifacts || null,
    boundary_mode: boundaryMode || null, key_params: keyParams || null,
    deps: Array.isArray(deps) ? deps : [], report: report || null,
    usage: usage || null,
  });
  if (parent.child_runs.length > 400) parent.child_runs.shift();
  return childRunId;
}

function saveSession(deps, session) {
  // 存档失败必须可见：静默吞掉会让「正常结束」盖住丢档风险（崩溃=整轮工作蒸发）
  try { deps.persist(session); } catch (e) {
    try { deps.emit({ t: 'warn', msg: '⚠ 会话存档失败：' + String(e.message || e).slice(0, 160) + '（本轮仍在内存中运行；请勿关闭程序，尽快手动保存关键产物）' }); } catch {}
  }
}

module.exports = { MATH_SKILLS, autoPick, modeBlock, autoFinished, nextStepHint, paperHardIssues, runTurn, buildSystem, safeParseArgs, apiModelOf, isComputeTool, checkNumericEvidence, classifyDecision, recordRun, recordChildRun, extractClaimNumbers, stateBlock, stampInputFiles, inputStampHash, formulaDepsBlock, repairProtocolIntegrity, isProductiveWritePath, assertSubagentProfile, budgetCheck, compactHistory, chunkSummaryMessages, runSubagent, collectCandidateLessons, makeSpend };
