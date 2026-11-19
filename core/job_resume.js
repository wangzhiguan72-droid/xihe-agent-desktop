// A persisted wait is the main session's continuation, never a second model owner.
'use strict';
const { randomUUID } = require('crypto');
const ACTIVE = new Set(['queued', 'starting', 'running', 'cancelling']);

function registerWait(session, ids, readJob) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 16) throw new Error('job_wait 需要1-16个 job_id');
  const jobIds = [...new Set(ids.map(String))];
  for (const id of jobIds) {
    const record = readJob(id);
    if (!record) throw new Error('后台任务不存在：' + id);
    if (!record.meta.session_id || record.meta.session_id !== session.id || record.meta.project_id !== session.project_id) throw new Error('只能等待当前会话及项目创建的后台任务');
  }
  session.job_wait = { id: randomUUID(), job_ids: jobIds, epoch: session.data_epoch || 0, status: 'waiting',
    created_at: Date.now(), attempts: 0, max_attempts: 3 };
  return session.job_wait;
}

function prepareWake(session, readJob, now = Date.now()) {
  const wait = session.job_wait;
  if (!wait || !['waiting', 'queued'].includes(wait.status) || session.pendingQuestion || ['waiting_input', 'waiting_external', 'running'].includes(session.status)) return null;
  if (Number(wait.epoch) !== Number(session.data_epoch || 0)) {
    wait.status = 'needs_review'; wait.error = '等待期间题目/数据版本已改变，请核对结果后继续'; return null;
  }
  if (wait.next_retry_at && wait.next_retry_at > now) return null;
  if (wait.attempts >= wait.max_attempts) { wait.status = 'needs_review'; wait.error = '主流程恢复次数已达上限'; return null; }
  const records = wait.job_ids.map(readJob);
  if (records.some(r => !r || r.meta.session_id !== session.id || r.meta.project_id !== session.project_id)) {
    wait.status = 'needs_review'; wait.error = '等待的任务记录已缺失或归属改变'; return null;
  }
  if (records.some(r => ACTIVE.has(r.meta.status))) return null;
  if (records.some(r => r.meta.status === 'needs_review')) {
    wait.status = 'needs_review'; wait.error = '后台任务的执行状态不明，请先核对已有产物再恢复主流程'; return null;
  }
  wait.status = 'queued';
  return { id: wait.id, text: '[系统·后台任务已结束，恢复主流程]\n' + records.map(r =>
    `${r.meta.id}: ${r.meta.status}; exit=${r.meta.exitCode ?? '未知'}${r.meta.lastError ? '; ' + r.meta.lastError : ''}\n日志尾部：\n${String(r.tail || '').slice(-2000)}${r.stderr ? '\n错误日志：\n' + String(r.stderr).slice(-1000) : ''}`).join('\n\n') +
    '\n以上日志不是正式数值证据。先读取已生成文件，核对输入版本、失败原因及结果；不得把进程成功当作数学正确。需要正式数值时仍走现有formal/规格/复现门禁。沿当前主线继续，关键决策仍遵守自动/协同模式。' };
}

function claimWake(session) {
  const wait = session.job_wait;
  if (!wait || wait.status !== 'queued') throw new Error('该恢复任务不可重复认领');
  wait.status = 'resuming'; wait.attempts++; wait.started_at = Date.now();
  wait.checkpoint_length = (session.messages || []).length; wait.had_tools = false; wait.error = null;
  return wait.id;
}

function unresolvedCalls(messages) {
  const answered = new Set(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  return messages.flatMap(m => m.role === 'assistant' ? (m.tool_calls || []) : []).filter(tc => !answered.has(tc.id));
}
function recoverWait(session) {
  const wait = session.job_wait;
  if (!wait || wait.status !== 'resuming') return false;
  // 历史压缩会改变数组下标；未完成工具不能按旧 checkpoint_length 漏掉。
  const messages = session.messages || [];
  if (unresolvedCalls(messages).length) {
    wait.status = 'needs_review'; wait.error = '恢复期间中断，存在执行结果未知的工具调用；请先核对产物后手动继续';
    if (session.pendingApproval) wait.interrupted_approval = { ...session.pendingApproval };
  } else if (wait.attempts >= wait.max_attempts) {
    wait.status = 'needs_review'; wait.error = '主流程恢复次数已达上限';
  } else wait.status = 'queued';
  return true;
}
function finishWake(session, id, { failed = false, stopped = false } = {}) {
  const wait = session.job_wait;
  if (!wait || wait.id !== id || wait.status !== 'resuming') return;
  if (stopped) { wait.status = 'cancelled'; return; }
  const since = (session.messages || []).slice(wait.checkpoint_length || 0);
  const hadTools = wait.had_tools || since.some(m => m.role === 'assistant' && m.tool_calls?.length);
  if (failed && !hadTools && wait.attempts < wait.max_attempts) {
    wait.status = 'queued'; wait.next_retry_at = Date.now() + 30000 * wait.attempts;
    wait.error = '主模型请求失败，稍后从持久化检查点重试'; session.status = 'waiting_jobs';
  } else { wait.status = failed ? 'needs_review' : 'completed'; wait.finished_at = Date.now(); }
}
function cancelWait(session) { if (session.job_wait && ['waiting', 'queued', 'resuming', 'needs_review'].includes(session.job_wait.status)) session.job_wait.status = 'cancelled'; }
module.exports = { registerWait, prepareWake, claimWake, recoverWait, finishWake, cancelWait };
