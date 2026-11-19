'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require('./memory');
const { executeTool } = require('./tools');
const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-role-memory-'));
async function main() {
  const shared = mem.addEntry(appDir, { text: 'routing shared', project: 'P' }).entry;
  const privateRow = mem.addEntry(appDir, { text: 'routing private coder', project: 'P', role: 'coder' }).entry;
  mem.addEntry(appDir, { text: 'routing private writer', project: 'P', role: 'writer' });
  assert.deepStrictEqual(mem.recall(appDir, 'routing', { project: 'P', role: 'modeler' }).map(e => e.id), [shared.id]);
  assert(mem.recall(appDir, 'routing', { project: 'P', role: 'coder' }).some(e => e.id === privateRow.id));
  assert(!mem.recall(appDir, 'routing', { project: 'P' }).some(e => e.role));
  for (const spec of [{ project: 'Q' }, { project: 'P', role: 'coder' }, { project: 'P', kind: 'lesson' }]) {
    assert.strictEqual(mem.addEntry(appDir, { text: shared.text, ...spec }).updated, false);
  }
  assert.strictEqual(mem.loadStore(appDir).find(e => e.id === shared.id).project, 'P');
  assert.throws(() => mem.addEntry(appDir, { text: 'bad role', role: 'invented' }), /role/);
  assert.strictEqual(mem.supersede(appDir, shared.id, privateRow.id), false);
  mem.addEntry(appDir, { text: 'scipy linprog 正常可用', situation: 'python solver', project: 'P', role: 'writer' });
  assert.deepStrictEqual(mem.findConflicts(appDir, { text: 'scipy linprog 不能用', situation: 'python solver', project: 'P', role: 'coder' }), []);
  const ctx = { appDir, workspace: appDir, session: { project_id: 'P', role: 'coder', mode: 'math' }, addMemory() {} };
  mem.addEntry(appDir, { text: 'another project exclusive', project: 'Q' });
  const retired = mem.addEntry(appDir, { text: 'retired exclusive', project: 'P' }).entry;
  mem.retireEntry(appDir, retired.id, 'test');
  const globalRow = mem.addEntry(appDir, { text: 'GLOBAL shared preference', project: mem.GLOBAL_PROJECT }).entry;
  const recent = await executeTool(ctx, 'memory_recall', {});
  assert(!JSON.stringify(recent).includes('private writer'));
  assert(!JSON.stringify(recent).includes('正常可用'));
  assert(!JSON.stringify(recent).includes('another project exclusive'));
  assert(!JSON.stringify(recent).includes('retired exclusive'));
  assert(JSON.stringify(recent).includes('GLOBAL shared preference'));
  const afterRecall = mem.loadStore(appDir);
  assert(afterRecall.find(e => e.id === globalRow.id).hits > 0);
  assert.strictEqual(afterRecall.find(e => e.text === 'routing private writer').hits, 0);
  const written = await executeTool(ctx, 'memory_write', { scope: 'persistent', content: 'private via tool', visibility: 'role', role: 'writer' });
  assert(written.ok !== false, JSON.stringify(written));
  assert.strictEqual(mem.loadStore(appDir).find(e => e.text === 'private via tool').role, 'coder');
  const lesson = await executeTool(ctx, 'lesson_record', { rule: 'private lesson tool', situation: 'special situation', visibility: 'role' });
  assert(lesson.ok !== false, JSON.stringify(lesson));
  assert.strictEqual(mem.loadStore(appDir).find(e => e.text === 'private lesson tool').role, 'coder');
  const invalid = await executeTool(ctx, 'memory_write', { scope: 'persistent', content: 'invalid visibility', visibility: 'everybody' }).catch(e => ({ ok: false }));
  assert.strictEqual(invalid.ok, false);
  const privateWriter = mem.addEntry(appDir, { text: 'writer audit secret', project: 'P', role: 'writer' }).entry;
  const otherProject = mem.addEntry(appDir, { text: 'other project audit secret', project: 'Q' }).entry;
  const audit = await executeTool(ctx, 'memory_audit', { op: 'scan' });
  assert(!JSON.stringify(audit).includes('writer audit secret'));
  assert(!JSON.stringify(audit).includes('other project audit secret'));
  for (const id of [privateWriter.id, otherProject.id]) {
    for (const op of ['retire', 'revive', 'mark_global', 'delete']) {
      const blocked = await executeTool(ctx, 'memory_audit', { op, id, reason: 'test' }).catch(e => ({ ok: false }));
      assert.strictEqual(blocked.ok, false, `${op} ${id} unexpectedly succeeded`);
    }
    assert(mem.loadStore(appDir).find(e => e.id === id), `${id} changed`);
  }
  const { collectCandidateLessons } = require('./agent');
  const parent = { pending_lessons: [] };
  collectCandidateLessons(parent, '【候选教训】coder scipy failure | check input shape', 'worker/coder', 'coder');
  assert.strictEqual(parent.pending_lessons[0].role, 'coder');
  const coordinatorCtx = { ...ctx, session: { project_id: 'P', role: 'modeler', pending_lessons: parent.pending_lessons }, addMemory() {} };
  const accepted = await executeTool(coordinatorCtx, 'lesson_record', { from_pending: 'PL1' });
  assert(accepted.ok !== false, JSON.stringify(accepted));
  assert.strictEqual(mem.loadStore(appDir).find(e => e.text === 'check input shape').role, 'coder');
  // Exercise the real child request assembly with an offline provider stub.
  const providers = require('./providers');
  const originalChat = providers.chatStream;
  const requests = [];
  providers.chatStream = async request => {
    requests.push(JSON.parse(JSON.stringify(request.messages)));
    if (requests.length === 1) return { tool_calls: [{ id: 'recall1', function: { name: 'memory_recall', arguments: '{}' } }] };
    return { content: '检查完成，证据见工具返回。' };
  };
  fs.mkdirSync(path.join(appDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'config', 'deepseek.key'), 'offline-test-key');
  delete require.cache[require.resolve('./agent')];
  const { runSubagent } = require('./agent');
  try {
    await runSubagent({ ...ctx, emit() {}, session: { ...ctx.session, id: 'test-parent', effort: 'deep', usage: {} } }, {
      appDir, settings: { default_model: 'deepseek-flash' }, stopper: { stop: false }, abort: new AbortController(),
    }, 'worker', 'routing coder task', { role: 'coder' }, () => {});
    assert.strictEqual(requests.length, 2);
    const first = JSON.stringify(requests[0]);
    assert(first.includes('routing private coder'));
    assert(!first.includes('routing private writer'));
    assert(!first.includes('another project exclusive'));
    assert(!requests[0][0].content.includes('routing private coder'));
    assert.strictEqual(requests[1].filter(m => String(m.content).includes('【当前角色经验召回')).length, 1);
    const toolResult = requests[1].find(m => m.role === 'tool');
    assert(toolResult && !toolResult.content.includes('another project exclusive'));
    mem.addEntry(appDir, { text: 'routing private reviewer', project: 'P', role: 'reviewer' });
    await runSubagent({ ...ctx, emit() {}, session: { ...ctx.session, id: 'test-reviewer', effort: 'deep', usage: {} } }, {
      appDir, settings: { default_model: 'deepseek-flash' }, stopper: { stop: false }, abort: new AbortController(),
    }, 'reviewer', 'routing audit task', { role: 'coder' }, () => {});
    const reviewerRequest = JSON.stringify(requests[2]);
    assert(reviewerRequest.includes('routing private reviewer'));
    assert(!reviewerRequest.includes('routing private coder'));
  } finally { providers.chatStream = originalChat; delete require.cache[require.resolve('./agent')]; }
  console.log('PASS role isolation, scoped dedup, supersession, conflicts, recent recall and tool role binding');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(appDir, { recursive: true, force: true }));
