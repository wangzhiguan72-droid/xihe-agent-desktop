'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const receipts = require('./run_artifacts');
const { recordRun, recordChildRun } = require('./agent');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-run-artifacts-'));
const root = path.join(temp, 'project');
const outside = path.join(temp, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);
const ctx = { workspace: root };
const args = { result_files: ['out/result.json'] };
fs.mkdirSync(path.join(root, 'out'));

try {
  const before = receipts.begin(ctx, args);
  fs.writeFileSync(path.join(root, 'out', 'result.json'), '{"answer":7.5}\n');
  const created = receipts.finish(ctx, args, before, true);
  assert.equal(created.files.length, 1, 'new output must have one receipt');
  assert.deepEqual(created.issues, []);
  assert.equal(created.files[0].path, 'out/result.json');
  assert.equal(receipts.validate(root, created).ok, true);

  const stale = receipts.finish(ctx, args, receipts.begin(ctx, args), true);
  assert.equal(stale.files.length, 0, 'untouched old output cannot be attributed to a new run');
  assert.match(stale.issues.join(' '), /未生成或重写/);

  const overwrittenBefore = receipts.begin(ctx, args);
  fs.writeFileSync(path.join(root, 'out', 'result.json'), '{"answer":8.6}\n');
  const overwritten = receipts.finish(ctx, args, overwrittenBefore, true);
  assert.equal(overwritten.files.length, 1, 'overwritten output must have one receipt');
  assert.equal(receipts.validate(root, created).ok, false, 'old receipt must go stale');
  assert.match(receipts.validate(root, created).issues.join(' '), /内容已变更/);
  assert.equal(receipts.validate(root, overwritten).ok, true);

  const sameBytesBefore = receipts.begin(ctx, args);
  fs.writeFileSync(path.join(root, 'out', 'result.json'), '{"answer":8.6}\n');
  fs.utimesSync(path.join(root, 'out', 'result.json'), new Date('2020-01-01'), new Date('2020-01-01'));
  const sameBytes = receipts.finish(ctx, args, sameBytesBefore, true);
  assert.equal(sameBytes.files.length, 1, 'explicitly rewritten same-byte output must be linkable');
  assert.equal(sameBytes.files[0].sha256, overwritten.files[0].sha256);

  const failedBefore = receipts.begin(ctx, args);
  fs.writeFileSync(path.join(root, 'out', 'result.json'), '{"answer":9}\n');
  assert.deepEqual(receipts.finish(ctx, args, failedBefore, false), { files: [], issues: [] }, 'failed run cannot issue a receipt');
  const missing = receipts.finish(ctx, { result_files: ['out/missing.json'] }, receipts.begin(ctx, { result_files: ['out/missing.json'] }), true);
  assert.equal(missing.files.length, 0);
  assert.match(missing.issues.join(' '), /文件不存在/);

  assert.throws(() => receipts.begin(ctx, { result_files: ['../outside/result.json'] }), /相对路径/);
  assert.throws(() => receipts.begin(ctx, { result_files: [path.join(outside, 'result.json')] }), /相对路径/);
  assert.throws(() => receipts.begin(ctx, { result_files: Array(21).fill('x') }), /最多 20/);
  assert.throws(() => receipts.begin(ctx, { result_files: ['out/result.json', 'out/./result.json'] }), /规范化后不可重复/);
  fs.symlinkSync(outside, path.join(root, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => receipts.begin(ctx, { result_files: ['escaped/result.json'] }), /工作区外/);
  assert.equal(receipts.validate(root, { files: [{ ...overwritten.files[0], path: 'escaped/result.json' }] }).ok, false);

  const session = { runs: [], child_runs: [], data_epoch: 2 };
  const runId = recordRun(session, { tool: 'python_run', ok: true, formal: true, resultArtifacts: overwritten });
  assert.equal(session.runs.find(run => run.run_id === runId).result_artifacts.files[0].sha256, overwritten.files[0].sha256);
  const childId = recordChildRun(session, { profile: 'child_session', tool: 'python_run', ok: true, formal: true, resultArtifacts: overwritten });
  assert.equal(session.child_runs.find(run => run.child_run_id === childId).result_artifacts.files[0].sha256, overwritten.files[0].sha256);
  console.log('PASS result file creation, overwrite, staleness, failure, missing, path escape, and run journals');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
