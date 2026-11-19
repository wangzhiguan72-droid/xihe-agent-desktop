'use strict';
const assert = require('assert/strict');
const { enterLocalTask, returnToMain, resumePlan } = require('./task_focus');
const { runSpecBlock } = require('./model_spec');

assert.match(runSpecBlock({}, { ok: true, formal: true, task_scope: 'local' }, 1) || '', /临时|局部/,
  'local numerical evidence cannot be linked into a main question, including legacy sessions without model specs');

function session() {
  return { id: 'focus-test', mode: 'math', contest: true, status: 'waiting_input', effort: 'extreme',
    model: 'main:model', collab_mode: 'collab', data_epoch: 2, messages: [],
    pendingQuestion: { decision_id: 'main-card', question: '选择主路线', candidates: [{ id: 'A' }] },
    question_graph: [{ id: 1, status: 'reviewing' }],
    job_wait: { id: 'main-wait', job_ids: ['main-job'], status: 'waiting', epoch: 2 },
    pending_reflection: { reasons: ['主线复核'], detail: '保持原始依据' } };
}

const s = session();
const graph = JSON.stringify(s.question_graph);
const card = JSON.stringify(s.pendingQuestion);
const wait = JSON.stringify(s.job_wait);
enterLocalTask(s);
assert.equal(s.task_focus.kind, 'local');
assert.equal(s.effort, 'fast');
assert.equal(s.model, 'main:model', 'entering local work must not silently change the provider/model');
assert.equal(s.pendingQuestion, null);
assert.equal(s.job_wait, null, 'main wait must not wake during local work');
assert.equal(s.pending_reflection, null);
assert.equal(s.status, 'idle');
const saved = JSON.stringify(s.task_focus);
enterLocalTask(s);
assert.equal(JSON.stringify(s.task_focus), saved, 'repeat entry must not overwrite the checkpoint');
s.model = 'fast:flash';
s.pendingQuestion = { decision_id: 'local-card', question: '局部选择尚未采纳' };
returnToMain(s);
assert.equal(s.task_focus, null);
assert.equal(s.effort, 'extreme');
assert.equal(s.model, 'main:model');
assert.equal(JSON.stringify(s.pendingQuestion), card);
assert.equal(JSON.stringify(s.job_wait), wait);
assert.equal(JSON.stringify(s.question_graph), graph);
assert.equal(s.pending_reflection.reasons[0], '主线复核');
assert.equal(resumePlan(s).action, 'decision');
assert(!s.decisions?.some(d => d.decision_id === 'local-card'), 'returning is not accepting a local decision');
assert.throws(() => returnToMain(s), /临时/);

const changed = session();
enterLocalTask(changed); changed.data_epoch++;
returnToMain(changed);
assert.equal(changed.pendingQuestion, null, 'changed inputs must invalidate the saved recommendation');
assert.equal(changed.job_wait.status, 'needs_review');
assert.equal(resumePlan(changed).action, 'review');
assert(changed.messages.some(m => /输入版本|数据版本/.test(m.content)));

const filesChanged = session(); filesChanged.runs = [];
filesChanged.input_stamp_map = { 'source/data.csv': { hash: 'original' } };
enterLocalTask(filesChanged);
filesChanged.input_stamp_map = { 'source/data.csv': { hash: 'modified-with-no-successful-run' } };
returnToMain(filesChanged);
assert.equal(filesChanged.pendingQuestion, null, 'input changes before the first successful run must invalidate the original card');
assert.equal(filesChanged.job_wait.status, 'needs_review');

const attached = session(); attached.attachment_manifest = [];
enterLocalTask(attached);
attached.attachment_manifest.push({ path: '.attachments/new-data.csv', size: 12 });
returnToMain(attached);
assert.equal(attached.pendingQuestion, null, 'new uploaded data must be reviewed before accepting the saved card');

const externalEdit = session();
enterLocalTask(externalEdit, externalEdit.status, 'before-disk-edit');
returnToMain(externalEdit, 'after-disk-edit');
assert.equal(externalEdit.pendingQuestion, null, 'external changes during the pause must invalidate the saved card');

const waiting = session(); waiting.pendingQuestion = null; waiting.status = 'waiting_jobs';
enterLocalTask(waiting); returnToMain(waiting);
assert.equal(waiting.status, 'waiting_jobs');
assert.equal(resumePlan(waiting).action, 'jobs');

const idle = session(); idle.pendingQuestion = null; idle.job_wait = null; delete idle.model;
enterLocalTask(idle); idle.model = 'other:flash'; returnToMain(idle);
assert.equal(idle.model, undefined);
assert.equal(resumePlan(idle).action, 'continue');
assert.match(resumePlan(idle).text, /主线/);

const approval = session(); approval.pendingApproval = { id: 'tool', summary: '未完成审批' };
assert.throws(() => enterLocalTask(approval), /审批/);
assert.equal(approval.task_focus, undefined, 'invalid entry must not mutate main state');
console.log('task focus: checkpoint/restore, model, decisions, waits and changed-input safety passed');
