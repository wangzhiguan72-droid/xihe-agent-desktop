'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Sandbox } = require('./sandbox');
const { registerFinding, resolveFinding, findingBlockers } = require('./review_findings');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-finding-'));
const session = { review_findings: [], verification_runs: [] };
const ctx = { workspace: root, sandbox: new Sandbox(root), session };
const hash = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
function write(rel, body) { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
function denied(fn, pattern) { assert.throws(fn, pattern); }
function target(rel, quote) { return { rel, quote }; }

try {
  write('paper/main.md', 'Claim: count is 336.\n');
  write('data/results.json', '{"count":252}\n');
  write('notes/review.md', 'Independent check says 252.\n');
  const original = registerFinding(ctx, { id: 'n1', claim: 'Count discrepancy', kind: 'numeric', severity: 'must_fix', targets: [target('paper/main.md', 'count is 336')] });
  assert.equal(original.status, 'open');
  assert.equal(original.targets[0].sha256, hash('paper/main.md'));
  assert(findingBlockers(root, session).some(x => x.includes('n1')));
  denied(() => registerFinding(ctx, { id: 'bad', claim: 'No quote', kind: 'text', severity: 'must_fix', targets: [target('paper/main.md', 'not in file')] }), /引用|quote|不存在/);
  denied(() => registerFinding(ctx, { id: 'bad', claim: 'No quote', kind: 'text', severity: 'must_fix', targets: [target('../outside.txt', 'x')] }), /越界|路径/);
  denied(() => resolveFinding(ctx, { id: 'n1', reason: 'fixed', revisions: [target('paper/main.md', 'count is 336')], evidence: [target('notes/review.md', '252')] }), /运行|run_id|回执/);
  denied(() => resolveFinding(ctx, { id: 'n1', reason: 'fixed', revisions: [target('paper/main.md', 'count is 336')], evidence: [target('paper/main.md', 'count is 336')], run_id: 'r1' }), /独立|目标|证据/);
  write('paper/main.md', 'Claim: count is 252.\n');
  write('runs/script_source.py', 'print(252)\n');
  write('runs/script.py', 'print(252)\n');
  write('runs/result.json', '{"count":252}\n');
  write('runs/log.txt', 'exit 0\n');
  const receipt = { run_id: 'r1', ok: true, exit_code: 0, script_source: target('runs/script_source.py', ''), script: target('runs/script.py', ''), inputs: [], copied_inputs: [], result: target('runs/result.json', ''), log: target('runs/log.txt', ''), at: Date.now() };
  for (const row of [receipt.script_source, receipt.script, receipt.result, receipt.log]) { delete row.quote; row.sha256 = hash(row.rel); }
  session.verification_runs.push(receipt);
  denied(() => resolveFinding(ctx, { id: 'n1', reason: 'fixed', revisions: [target('paper/main.md', 'count is 252')], evidence: [target('notes/review.md', '252')], run_id: 'r1' }), /结果|result/);
  resolveFinding(ctx, { id: 'n1', reason: 'fixed and checked', revisions: [target('paper/main.md', 'count is 252')], evidence: [target('runs/result.json', '252')], run_id: 'r1' });
  assert.equal(session.review_findings[0].status, 'resolved');
  assert.deepEqual(findingBlockers(root, session), []);
  write('runs/log.txt', 'changed\n');
  assert(findingBlockers(root, session).some(x => x.includes('n1')));
  write('runs/log.txt', 'exit 0\n');
  assert.deepEqual(findingBlockers(root, session), []);
  write('runs/result.json', '{"count":251}\n');
  assert(findingBlockers(root, session).some(x => x.includes('n1')));
  assert.equal(session.review_findings[0].status, 'stale');
  write('runs/result.json', '{"count":252}\n');
  assert.deepEqual(findingBlockers(root, session), []);
  session.review_findings[0].targets[0].quote = 'tampered';
  assert(findingBlockers(root, session).some(x => x.includes('n1')));
  session.review_findings[0].targets[0].quote = 'count is 336';
  assert.deepEqual(findingBlockers(root, session), []);
  write('paper/main.md', 'Claim: count is 253.\n');
  assert(findingBlockers(root, session).some(x => x.includes('n1')));
  write('paper/main.md', 'Claim: count is 252.\n');
  assert.deepEqual(findingBlockers(root, session), []);

  registerFinding(ctx, { id: 'n1', claim: 'Reopened', kind: 'text', severity: 'must_fix', targets: [target('paper/main.md', 'count is 252')] });
  assert.equal(session.review_findings.length, 1);
  assert.equal(session.review_findings[0].status, 'open');
  denied(() => resolveFinding(ctx, { id: 'n1', reason: 'waive', revisions: [], evidence: [] }), /修订|revisions/);
  denied(() => resolveFinding(ctx, { id: 'n1', reason: 'waive', revisions: [target('paper/main.md', 'count is 252')], evidence: [] }), /证据|evidence/);
  resolveFinding(ctx, { id: 'n1', reason: 'Updated note', revisions: [target('paper/main.md', 'count is 252')], evidence: [target('notes/review.md', '252')] });
  assert.deepEqual(findingBlockers(root, session), []);
  write('notes/review.md', 'changed\n');
  assert(findingBlockers(root, session).some(x => x.includes('n1')));

  registerFinding(ctx, { id: 'a1', claim: 'Wording', kind: 'text', severity: 'advisory', targets: [target('paper/main.md', 'count is 252')] });
  assert.equal(findingBlockers(root, session).length, 1);
  denied(() => registerFinding(ctx, { id: 'x', claim: 'x', kind: 'unknown', severity: 'must_fix', targets: [target('paper/main.md', '252')] }), /类型|kind/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-finding-outside-'));
  try { fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret'); fs.symlinkSync(outside, path.join(root, 'escape'), 'junction'); denied(() => registerFinding(ctx, { id: 'escape', claim: 'x', kind: 'text', severity: 'must_fix', targets: [target('escape/secret.txt', 'secret')] }), /越界/); }
  catch (error) { if (error.code !== 'EPERM') throw error; }
  finally { fs.rmSync(outside, { recursive: true, force: true }); }
  console.log('review findings: PASS');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
