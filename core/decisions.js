'use strict';
const { randomUUID } = require('crypto');
const clean = value => typeof value === 'string' ? value.trim() : '';

function createDecision(args) {
  if (!clean(args.question)) throw new Error('决策 question 不能为空');
  const q = { question: clean(args.question), options: Array.isArray(args.options) ? args.options.map(String) : [] };
  if (args.candidates == null) return q;
  if (!Array.isArray(args.candidates) || args.candidates.length < 2 || args.candidates.length > 6) {
    throw new Error('结构化决策卡需要 2–6 个有依据的候选方案；只有一个候选时用普通 options 或纯文字确认');
  }
  const ids = new Set();
  q.candidates = args.candidates.map(c => {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || c.id === 'custom' || ids.has(c.id)) throw new Error('候选 id 必须唯一，且不能使用 custom');
    ids.add(c.id);
    if (!clean(c.label) || !clean(c.basis) || !(clean(c.tradeoff) || clean(c.risk))) throw new Error('每项需 label、basis，以及 tradeoff 或 risk');
    return { id: c.id, label: clean(c.label), basis: clean(c.basis), tradeoff: clean(c.tradeoff), risk: clean(c.risk) };
  });
  if (new Set(q.candidates.map(c => c.label.replace(/\s+/g, '').toLowerCase())).size !== q.candidates.length) throw new Error('候选方案需有区别，不能重复标签');
  if (!ids.has(args.recommended_id)) throw new Error('recommended_id 必须指向候选方案');
  if (!clean(args.recommendation_reason)) throw new Error('路线决策需要推荐判断：结合题目、数据与赛时条件比较候选方案');
  q.recommended_id = args.recommended_id;
  q.recommendation_reason = clean(args.recommendation_reason);
  // Optional bounded second opinion from the configured judgment model. It
  // never replaces the human/system provenance; it is evidence attached to
  // the card and can be used by the auto lane after confidence checks.
  if (args.judge && typeof args.judge === 'object') q.judge = JSON.parse(JSON.stringify(args.judge));
  q.decision_id = randomUUID();
  q.options = q.candidates.map(c => c.label);
  return q;
}

function recommendedChoice(q) {
  return (q.candidates || []).find(c => c.id === q.recommended_id) || null;
}

// Recognize only an actionable request for a choice. Mentioning A/B/C or a
// completed decision in a report must not pause the run.
function textDecision(text) {
  const body = clean(text);
  if (!body) return null;
  const request = /(?:请(?:直接)?(?:选择|回复|确认|确定|选定)|等待(?:你|用户|人工)?(?:明确)?选择|尚待(?:你|用户)?选择|仍需(?:你|用户)?(?:明确)?选择|待(?:你|用户)?选择)[^。\n！？]{0,100}(?:方案|路线|主模型|模型|推荐项|(?:A|B|C)(?![A-Za-z0-9]))/i;
  return request.test(body) ? body : null;
}

// A polling client may use these short nudges. They carry no answer and must
// not wake a decision card or spend another model request.
function isVagueContinuation(text) {
  const body = clean(text).replace(/[。！!.?？\s]+$/g, '');
  if (/^(?:continue|proceed|go on)(?: with the task)?$/i.test(body)) return true;
  if (/^(?:请|麻烦)?继续(?:推进|执行|完成|做)?$/.test(body)) return true;
  if (/^(?:请|麻烦)?(?:继续|接着)(?:推进|执行|完成|做)?(?:当前|后续|剩余|全部|所有)?(?:任务|工作|流程|步骤|任务书)$/.test(body)) return true;
  return /^(?:请|麻烦)?继续推进任务书(?:中要求的(?:所有|全部)?工作)?[，,](?:直到)?(?:四个|全部|所有)产物(?:全部)?生成$/.test(body);
}

function continuationState(session = {}) {
  if (session.pendingQuestion || session.wait_reason?.kind === 'decision_text' || session.status === 'waiting_input') {
    return { can_continue: false, reason: 'waiting_for_decision', action: 'answer_decision' };
  }
  if (session.pendingApproval) return { can_continue: false, reason: 'waiting_for_approval', action: 'approve' };
  if (session.status === 'running') return { can_continue: false, reason: 'running', action: 'wait' };
  if (session.status === 'waiting_jobs') return { can_continue: false, reason: 'waiting_for_jobs', action: 'wait' };
  if (session.status === 'waiting_external') return { can_continue: false, reason: 'waiting_external', action: 'wait' };
  if (session.last_error) return { can_continue: false, reason: 'blocked', action: 'review_error' };
  if (!session.status || session.status === 'idle') return { can_continue: true, reason: 'ready', action: 'continue' };
  return { can_continue: false, reason: session.status, action: 'wait' };
}

function validateClarification(q, input) {
  if (!q || !q.candidates || !q.decision_id || !input || input.decision_id !== q.decision_id) {
    throw new Error('决策卡已过期，请刷新后追问当前卡片');
  }
  const question = clean(input.question);
  if (!question || question.length > 2000) throw new Error('追问问题需为 1–2000 字');
  return { question };
}

function validateResponse(q, response) {
  if (!q || !q.candidates) {
    if (response) throw new Error('决策卡已过期，请刷新会话');
    return null;
  }
  if (!response || response.decision_id !== q.decision_id) throw new Error('决策卡已过期或缺少 decision_id，请刷新后回答当前卡片');
  const selected_id = clean(response.selected_id);
  if (selected_id !== 'custom' && !q.candidates.some(c => c.id === selected_id)) throw new Error('决策选项不存在');
  const custom_text = clean(response.custom_text);
  const rationale = clean(response.rationale);
  if (selected_id === 'custom' && (!custom_text || !rationale)) throw new Error('自定义方案必须填写方案与理由');
  return { selected_id, custom_text: selected_id === 'custom' ? custom_text : null, rationale };
}

function decisionRecord(q, response, source) {
  const chosen = (q.candidates || []).find(c => c.id === response.selected_id);
  return {
    decision_id: q.decision_id, question: q.question, options: q.options,
    candidates: q.candidates, recommended_id: q.recommended_id, recommendation_reason: q.recommendation_reason || null,
    chosen_id: chosen ? chosen.id : null, chosen_option: chosen ? chosen.label : null,
    custom_text: response.custom_text || null, rationale: response.rationale || '',
    basis: chosen ? chosen.basis : null, tradeoff: chosen ? chosen.tradeoff : null, risk: chosen ? chosen.risk : null,
    judge: q.judge || null,
    source, status: source === 'system_auto' ? 'auto' : chosen ? 'resolved' : 'custom',
    answer: chosen ? chosen.label : response.custom_text, at: Date.now(),
  };
}
module.exports = { createDecision, recommendedChoice, validateResponse, validateClarification, decisionRecord,
  textDecision, isVagueContinuation, continuationState };
