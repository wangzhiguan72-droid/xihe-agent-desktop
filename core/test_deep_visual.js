'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { executeTool } = require('./tools');
const { Sandbox } = require('./sandbox');
const vision = require('./vision');
const providers = require('./providers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-deep-visual-'));
const appDir = path.join(root, 'app'); fs.mkdirSync(appDir);
const old = { describeImage: vision.describeImage, readVisionCache: vision.readVisionCache,
  writeVisionCache: vision.writeVisionCache, keyFor: providers.keyFor };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let active = null;
vision.readVisionCache = () => null;
vision.writeVisionCache = () => {};
providers.keyFor = () => 'offline-test-key';
vision.describeImage = async ({ imagePath }) => {
  const name = path.basename(imagePath);
  active.calls.push({ figure: name, sha256: sha(imagePath) });
  const action = active.responses[name];
  const reply = typeof action === 'function' ? await action(imagePath) : action;
  if (reply instanceof Error) throw reply;
  return typeof reply === 'object' && reply !== null
    ? { usage: { completion_tokens: 4 }, ...reply }
    : { text: reply, truncated: false, usage: { completion_tokens: 4 } };
};

function makeContext(name, responses, worker) {
  const workspace = path.join(root, name); fs.mkdirSync(workspace);
  const session = { effort: 'deep', deep_visual: [] };
  active = { workspace, responses, calls: [] };
  const ctx = { appDir, workspace, sandbox: new Sandbox(workspace), session,
    settings: { vision_model: 'deepseek:deepseek-flash', vision_fallback: 'deepseek:deepseek-flash' },
    trackVision: () => {}, engines: worker ? { subagent: async (...args) => worker(workspace, ...args) } : undefined };
  return { ctx, session, workspace, calls: active.calls };
}
function put(workspace, name, value = 'image-v1') {
  fs.writeFileSync(path.join(workspace, name), value);
  return sha(path.join(workspace, name));
}
async function inspect(ctx, figures, opts = {}) {
  const r = await executeTool(ctx, 'deep_visual', { figures, max_rounds: 2, ...opts });
  assert.equal(r.ok, true, r.error);
  return r.data;
}
const latest = session => {
  assert.equal(session.deep_visual.length, 1, 'each call should persist one inspection');
  return session.deep_visual[0];
};

(async () => {
  const mixed = makeContext('mixed', { 'good.png': '坐标和单位均清楚。\n结论=PASS' });
  const goodHash = put(mixed.workspace, 'good.png');
  const mixedOutput = await inspect(mixed.ctx, ['good.png', 'missing.png']);
  assert.doesNotMatch(mixedOutput, /所有图视觉检查 PASS/);
  assert.match(mixedOutput, /missing\.png/);
  assert.match(mixedOutput, /未验证/);
  const mixedRecord = latest(mixed.session);
  assert.equal(mixedRecord.status, 'unverified');
  assert.deepEqual(mixedRecord.figures, ['good.png', 'missing.png']);
  assert.equal(mixedRecord.checks.length, 2);
  assert.equal(mixedRecord.checks[0].figure, 'good.png');
  assert.equal(mixedRecord.checks[0].status, 'pass');
  assert.equal(mixedRecord.checks[0].sha256, goodHash);
  assert.equal(mixedRecord.checks[1].figure, 'missing.png');
  assert.equal(mixedRecord.checks[1].status, 'unverified');
  assert.match(mixedRecord.checks[1].reason, /缺|不存在|读图|文件/);
  assert.deepEqual(mixedRecord.rounds[0].unverified, ['missing.png']);

  const fail = makeContext('fail', { 'bad.png': '图例挡住曲线。\n结论=FAIL', 'good.png': '正常。\n结论=PASS' });
  put(fail.workspace, 'bad.png'); put(fail.workspace, 'good.png');
  const failOutput = await inspect(fail.ctx, ['bad.png', 'good.png']);
  assert.doesNotMatch(failOutput, /所有图视觉检查 PASS/);
  assert.match(failOutput, /bad\.png/);
  assert.equal(latest(fail.session).status, 'fail');
  assert.deepEqual(latest(fail.session).rounds[0].fails, ['bad.png']);
  assert.deepEqual(latest(fail.session).rounds[0].unverified, []);

  for (const [name, response] of [
    ['empty', ''], ['no_marker', '整体可以 PASS，但没有独立结论行。'],
    ['conflicting', '第一遍：\n结论=PASS\n复看发现有错。\n结论=FAIL'],
    ['truncated', { text: '坐标清楚。\n结论=PASS', truncated: true }],
    ['error', new Error('vision connection failed')], ['timeout', new Error('vision timed out')],
  ]) {
    const row = makeContext(name, { 'chart.png': response });
    put(row.workspace, 'chart.png');
    const output = await inspect(row.ctx, ['chart.png']);
    assert.doesNotMatch(output, /所有图视觉检查 PASS/, name);
    const record = latest(row.session);
    assert.equal(record.status, 'unverified', name);
    assert.equal(record.checks[0].status, 'unverified', name);
    assert(record.checks[0].reason, name + ' lacks reason');
  }

  const hanging = makeContext('hanging', { 'chart.png': () => new Promise(() => {}) });
  put(hanging.workspace, 'chart.png');
  const started = Date.now();
  const hangingOutput = await inspect(hanging.ctx, ['chart.png'], { timeout_sec: 1 });
  assert(Date.now() - started >= 850 && Date.now() - started < 5000,
    'deep_visual must independently time out a never-resolving image read');
  assert.doesNotMatch(hangingOutput, /所有图视觉检查 PASS/);
  assert.equal(latest(hanging.session).status, 'unverified');
  assert.match(latest(hanging.session).checks[0].reason, /超时/);

  const rerun = makeContext('rerun', {
    'bad.png': file => fs.readFileSync(file, 'utf8').includes('v2') ? '已修图例。\n结论=PASS' : '图例遮挡。\n结论=FAIL',
    'other.png': '坐标和单位清楚。\n结论=PASS',
  }, workspace => {
    put(workspace, 'bad.png', 'image-v2');
    put(workspace, 'other.png', 'other-v2');
    return 'redrawn';
  });
  const initialBad = put(rerun.workspace, 'bad.png');
  put(rerun.workspace, 'other.png', 'other-v1');
  const rerunOutput = await inspect(rerun.ctx, ['bad.png', 'other.png'], { script: 'draw.py' });
  assert.match(rerunOutput, /所有图视觉检查 PASS/);
  const rerunRecord = latest(rerun.session);
  assert.equal(rerunRecord.status, 'pass');
  assert.equal(rerunRecord.rounds.length, 2);
  assert.deepEqual(rerunRecord.rounds[0].fails, ['bad.png']);
  assert.equal(rerunRecord.rounds[0].checks[0].sha256, initialBad);
  assert.notEqual(rerunRecord.rounds[1].checks[0].sha256, initialBad);
  assert.notEqual(rerunRecord.rounds[0].checks[1].sha256, rerunRecord.rounds[1].checks[1].sha256);
  assert.equal(rerun.calls.filter(c => c.figure === 'other.png').length, 2,
    'worker-modified figure also needs rereading');

  let noOpReads = 0;
  const noOp = makeContext('noop_worker', {
    'bad.png': () => ++noOpReads === 1 ? '图例遮挡。\n结论=FAIL' : '现在正常。\n结论=PASS',
  }, () => 'reported done without writing a figure');
  const noOpHash = put(noOp.workspace, 'bad.png');
  const noOpOutput = await inspect(noOp.ctx, ['bad.png'], { script: 'draw.py' });
  assert.doesNotMatch(noOpOutput, /所有图视觉检查 PASS/,
    'an unchanged image may not be promoted by a different model reply');
  assert.match(noOpOutput, /未重绘|未重新出图|图片内容没有变化/);
  assert.equal(sha(path.join(noOp.workspace, 'bad.png')), noOpHash);
  assert.notEqual(latest(noOp.session).status, 'pass');
  assert.notEqual(latest(noOp.session).checks[0].status, 'pass');

  const failedWorker = makeContext('failed_worker', { 'bad.png': '图例挡住点。\n结论=FAIL' }, workspace => {
    put(workspace, 'bad.png', 'partial-redraw');
    throw new Error('renderer crashed');
  });
  const failedHash = put(failedWorker.workspace, 'bad.png');
  const failedOutput = await inspect(failedWorker.ctx, ['bad.png'], { script: 'draw.py' });
  assert.doesNotMatch(failedOutput, /所有图视觉检查 PASS/);
  assert.match(failedOutput, /快照|检查时/,
    'the output should distinguish an earlier round from the final per-figure state');
  assert.equal(latest(failedWorker.session).status, 'unverified',
    'a partial redraw after worker failure invalidates the visual judgment');
  assert.notEqual(sha(path.join(failedWorker.workspace, 'bad.png')), failedHash);
  assert.match(latest(failedWorker.session).rounds[0].note, /crashed/);

  const withinRound = makeContext('within_round', {
    'first.png': '第一张正常。\n结论=PASS',
    'second.png': () => {
      fs.writeFileSync(path.join(withinRound.workspace, 'first.png'), 'first changed during second read');
      return '第二张正常。\n结论=PASS';
    },
  });
  put(withinRound.workspace, 'first.png'); put(withinRound.workspace, 'second.png');
  const withinOutput = await inspect(withinRound.ctx, ['first.png', 'second.png']);
  assert.doesNotMatch(withinOutput, /所有图视觉检查 PASS/);
  assert.equal(latest(withinRound.session).status, 'unverified');
  assert.equal(latest(withinRound.session).checks[0].status, 'unverified');
  assert.equal(latest(withinRound.session).checks[1].status, 'pass');

  const midRead = makeContext('mid_read', { 'chart.png': file => {
    fs.writeFileSync(file, 'changed while being inspected');
    return '一切正常。\n结论=PASS';
  } });
  put(midRead.workspace, 'chart.png');
  const changedOutput = await inspect(midRead.ctx, ['chart.png']);
  assert.doesNotMatch(changedOutput, /所有图视觉检查 PASS/);
  assert.equal(latest(midRead.session).status, 'unverified');
  assert.match(latest(midRead.session).checks[0].reason, /变化|版本|重验|改动/);

  console.log('PASS deep_visual: mixed missing, fail, empty, unmarked, conflicting, truncated, timeout, errors, redraw versions, no-op worker, partial redraw, within-round and mid-read changes');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  vision.describeImage = old.describeImage;
  vision.readVisionCache = old.readVisionCache;
  vision.writeVisionCache = old.writeVisionCache;
  providers.keyFor = old.keyFor;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith('xihe-deep-visual-'));
  fs.rmSync(root, { recursive: true, force: true });
});
