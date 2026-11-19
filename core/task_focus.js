'use strict';
const { createHash } = require('crypto');
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const isLocalTask = session => session?.task_focus?.kind === 'local';
const inputIdentity = session => createHash('sha256').update(JSON.stringify({
  inputs: Object.keys(session.input_stamp_map || {}).sort().map(key => [key, session.input_stamp_map[key]?.hash || '']),
  attachments: session.attachment_manifest || [],
})).digest('hex');

function enterLocalTask(session, pausedFrom = session.status, diskInputs = null) {
  if (isLocalTask(session)) return session.task_focus;
  if (session.pendingApproval) throw new Error('请先等待当前审批与工具收尾，再进入临时小任务');
  session.task_focus = {
    kind: 'local', entered_at: Date.now(), main_status: pausedFrom,
    main_effort: session.effort || 'fast', main_model: session.model || null,
    main_model_present: Object.hasOwn(session, 'model'),
    main_collab_mode: session.collab_mode || 'collab', main_epoch: session.data_epoch || 0,
    main_inputs: inputIdentity(session),
    main_disk_inputs: diskInputs,
    main_pending_question: copy(session.pendingQuestion), main_job_wait: copy(session.job_wait),
    main_wait_reason: copy(session.wait_reason),
    main_last_error: copy(session.last_error),
    main_pending_reflection: copy(session.pending_reflection),
  };
  session.pendingQuestion = null;
  session.wait_reason = null;
  session.last_error = null;
  session.pending_reflection = null;
  session.job_wait = null;
  session.effort = 'fast';
  session.status = 'idle';
  session.messages = session.messages || [];
  session.messages.push({ role: 'user', content: '[用户·暂停主线] 先处理临时小任务。原主线、决策和后台等待已保留；仅处理接下来的局部请求，完成即停，等我点击“返回主线”。' });
  return session.task_focus;
}

function returnToMain(session, diskInputs = null) {
  if (!isLocalTask(session)) throw new Error('当前不在临时小任务中');
  if (session.pendingApproval) throw new Error('请先等待临时任务的审批与工具收尾');
  if (session.job_wait && ['waiting', 'queued', 'resuming'].includes(session.job_wait.status)) throw new Error('临时任务仍有后台等待，请先核对');
  const focus = session.task_focus;
  const changed = (session.data_epoch || 0) !== focus.main_epoch ||
    (focus.main_inputs != null && focus.main_inputs !== inputIdentity(session)) ||
    (focus.main_disk_inputs != null && diskInputs !== focus.main_disk_inputs);
  const localQuestion = session.pendingQuestion;
  const localReflection = session.pending_reflection;
  session.effort = focus.main_effort;
  session.collab_mode = focus.main_collab_mode;
  if (focus.main_model_present !== false) session.model = focus.main_model;
  else delete session.model;
  session.pendingQuestion = changed ? null : copy(focus.main_pending_question);
  session.wait_reason = changed ? null : copy(focus.main_wait_reason);
  session.last_error = copy(focus.main_last_error);
  session.job_wait = copy(focus.main_job_wait);
  session.pending_reflection = copy(focus.main_pending_reflection) || localReflection;
  if (focus.main_pending_reflection && localReflection) {
    session.pending_reflection.reasons = [...new Set([...(focus.main_pending_reflection.reasons || []), ...(localReflection.reasons || [])])].slice(0, 6);
    session.pending_reflection.detail = [focus.main_pending_reflection.detail, localReflection.detail].filter(Boolean).join('\n临时任务：').slice(0, 1000);
  }
  if (changed && session.job_wait && ['waiting', 'queued', 'resuming'].includes(session.job_wait.status)) {
    session.job_wait.status = 'needs_review';
    session.job_wait.error = '临时任务期间输入版本已改变，请核对后台结果和规格后继续';
  }
  session.status = session.pendingQuestion || session.wait_reason?.kind === 'decision_text' ? 'waiting_input'
    : session.job_wait && ['waiting', 'queued'].includes(session.job_wait.status) ? 'waiting_jobs'
    : focus.main_status === 'waiting_external' ? 'waiting_external' : 'idle';
  session.task_focus_history = [...(session.task_focus_history || []), {
    entered_at: focus.entered_at, returned_at: Date.now(), main_epoch: focus.main_epoch,
    returned_epoch: session.data_epoch || 0,
    ...(localQuestion ? { abandoned_local_question: copy(localQuestion) } : {}),
    ...(changed && focus.main_pending_question ? { invalidated_main_question: copy(focus.main_pending_question) } : {}),
  }].slice(-12);
  session.task_focus = null;
  session.messages.push({ role: 'user', content: '[用户·返回主线] 临时小任务结束，恢复原主线。' +
    (localQuestion ? '局部待选卡未被采纳，返回不代表确认任何局部选项。' : '') +
    (changed ? '临时任务期间输入版本已改变，原待选卡已作废；先核对受影响的规格、产物和后台结果，必要时重新出卡或重算。' : '') +
    '从已有产物与记录继续，检查中断工具的实际结果，不直接重放未知写入。' });
  return resumePlan(session);
}

function resumePlan(session) {
  if (session.pendingQuestion || session.wait_reason?.kind === 'decision_text') return { action: 'decision' };
  if (session.job_wait?.status === 'needs_review') return { action: 'review' };
  if (['waiting', 'queued'].includes(session.job_wait?.status)) return { action: 'jobs' };
  if (session.status === 'waiting_external') return { action: 'external' };
  return { action: 'continue', text: '[用户·继续主线] 已返回原任务，请先核对当前进度和已有产物，处理临时任务带来的输入变化，然后继续原主线；不要重复执行已完成的计算或结果未知的写入。' };
}

module.exports = { isLocalTask, enterLocalTask, returnToMain, resumePlan };
