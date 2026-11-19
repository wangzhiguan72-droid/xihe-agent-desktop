'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { createJobManager, parseCommand } = require('./jobs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-jobs-'));
const JOBS = path.join(ROOT, 'jobs');
const PYTHON = execFileSync('where.exe', ['python'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
const GUARD = path.join(__dirname, 'pywrap.py');
const RUNNER = path.join(__dirname, 'job_runner.js');
const managers = [];
const runnerPids = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeScript(name, source) { const p = path.join(ROOT, name); fs.writeFileSync(p, source, 'utf8'); return p; }
function rawMeta(jobId) { return JSON.parse(fs.readFileSync(path.join(JOBS, jobId, 'meta.json'), 'utf8')); }
function manager(opts = {}) { const m = createJobManager({ jobsDir: JOBS, runnerPath: RUNNER, pythonPath: PYTHON, guardPath: GUARD, retryBaseMs: 80, heartbeatTtlMs: 5000, ...opts }); managers.push(m); return m; }
function waitFor(m, id, predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const status = m.statusJob(id);
      if (status) { const raw = rawMeta(id); if (raw.runnerPid) runnerPids.add(raw.runnerPid); if (predicate(status.meta)) return resolve(status); }
      if (Date.now() >= end) return reject(new Error(`timeout waiting job ${id}: ${JSON.stringify(status && status.meta)}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}
function enqueue(m, script, options = {}) {
  return m.enqueueJob({ command: `python "${script}"`, cwd: ROOT, pyGuard: GUARD, pythonPath: PYTHON,
    env: { ...process.env, XIHE_PY_ROOT: ROOT, XIHE_PY_MODE: 'rw' }, ...options });
}

(async () => {
  try {
    assert.equal(parseCommand('matlab -batch "run.m"').bin, 'matlab');
    assert.throws(() => parseCommand('powershell -c "x"'), /白名单/);

    const m = manager({ maxActive: 1 });
    const events = []; m.subscribe(e => events.push(e));
    const firstScript = writeScript('first.py', "import time\ntime.sleep(.3)\nopen('order.txt','a').write('1')\nprint('first done')\n");
    const secondScript = writeScript('second.py', "open('order.txt','a').write('2')\nprint('second done')\n");
    const first = enqueue(m, firstScript, { start: false, label: 'first', session_id: 'session-A', project_id: 'project-A', dedupKey: 'session-A:call-1' });
    assert.equal(first.ok, true); assert.equal(first.status, 'queued');
    const sameCall = enqueue(m, firstScript, { start: false, dedup_key: 'session-A:call-1' });
    assert.equal(sameCall.id, first.id); assert.equal(sameCall.deduplicated, true);
    assert.equal(enqueue(m, secondScript, { start: false, dedupKey: 'session-A:call-1' }).ok, false);
    const second = enqueue(m, secondScript, { start: false, label: 'second' });
    m.pumpJobs(); m.startScheduler(50);
    await waitFor(m, first.id, x => x.status === 'succeeded');
    await waitFor(m, second.id, x => x.status === 'succeeded');
    assert.equal(fs.readFileSync(path.join(ROOT, 'order.txt'), 'utf8'), '12', 'queue starts in FIFO order');
    assert(events.some(e => e.type === 'enqueue') && events.some(e => e.type === 'finish'), 'scheduler publishes lifecycle events');
    assert.equal(m.statusJob(first.id).meta.session_id, 'session-A');
    assert.equal(m.statusJob(first.id).meta.project_id, 'project-A');
    assert.equal(m.statusJob(first.id).meta.logBytes > 0, true);

    const retryScript = writeScript('retry.py', "import sys\nopen('attempts.txt','a').write('x')\nsys.exit(4)\n");
    const retry = enqueue(m, retryScript, { retryable: true, maxAttempts: 2 });
    const retried = await waitFor(m, retry.id, x => x.status === 'failed', 12000);
    assert.equal(retried.meta.attempts, 2, 'retry limit bounds automatic retries');
    assert.equal(fs.readFileSync(path.join(ROOT, 'attempts.txt'), 'utf8'), 'xx');
    const failedScript = writeScript('manual.py', "import sys\nsys.exit(5)\n");
    const manual = enqueue(m, failedScript, { retryable: false });
    await waitFor(m, manual.id, x => x.status === 'failed');
    fs.appendFileSync(failedScript, '# changed after reviewed run\n');
    assert.equal(m.retryJob(manual.id).ok, false, 'manual retry rejects changed script hash');

    const cancellableScript = writeScript('cancel.py', "import time\ntime.sleep(30)\nopen('should-not-exist.txt','w').write('bad')\n");
    const cancellable = enqueue(m, cancellableScript);
    await waitFor(m, cancellable.id, x => x.status === 'running');
    const cancelResult = m.cancelJob(cancellable.id);
    assert.equal(cancelResult.ok, true, JSON.stringify({ cancelResult, raw: rawMeta(cancellable.id), heartbeat: fs.existsSync(path.join(JOBS, cancellable.id, 'heartbeat.json')) ? fs.readFileSync(path.join(JOBS, cancellable.id, 'heartbeat.json'), 'utf8') : null }));
    await waitFor(m, cancellable.id, x => x.status === 'cancelled');
    assert.equal(fs.existsSync(path.join(ROOT, 'should-not-exist.txt')), false);

    const secretScript = writeScript('secret.py', "print('safe')\n");
    const secret = enqueue(m, secretScript, { start: false, env: { ...process.env, TEST_API_KEY: 'never-persist-this' } });
    const raw = fs.readFileSync(path.join(JOBS, secret.id, 'meta.json'), 'utf8');
    assert.doesNotMatch(raw, /never-persist-this|TEST_API_KEY/);
    const restrictedRoot = path.join(ROOT, 'restricted-root'); fs.mkdirSync(restrictedRoot);
    const restrictedScript = writeScript('restricted-root/readonly.py', "print('readonly')\n");
    const preserved = enqueue(m, restrictedScript, { start: false, cwd: restrictedRoot, env: { ...process.env, XIHE_PY_ROOT: restrictedRoot, XIHE_PY_MODE: 'ro' } });
    const preservedMeta = rawMeta(preserved.id);
    assert.equal(preservedMeta.envSnapshot.XIHE_PY_ROOT, path.join(ROOT, 'restricted-root'));
    assert.equal(preservedMeta.envSnapshot.XIHE_PY_MODE, 'ro');
    assert.equal(m.cancelJob(secret.id).status, 'cancelled');
    assert.equal(m.cancelJob(preserved.id).status, 'cancelled');

    const changedScript = writeScript('changed-while-queued.py', "print('old')\n");
    const queuedChanged = enqueue(m, changedScript, { start: false, retryable: true, maxAttempts: 2 });
    fs.appendFileSync(changedScript, "print('new')\n");
    m.pumpJobs();
    assert.equal(m.statusJob(queuedChanged.id).meta.status, 'needs_review', 'queued script changes block execution');

    const matlab = m.enqueueJob({ command: 'matlab -batch "disp(1)"', cwd: ROOT, retryable: true, maxAttempts: 3, start: false });
    assert.equal(matlab.retryable, false, 'unverifiable MATLAB inputs cannot auto-retry');
    m.cancelJob(matlab.id);

    const internalScript = path.join(__dirname, 'kb_extract.py');
    const internalOut = path.join(__dirname, '..', 'data', 'kb');
    const internal = m.enqueueJob({ command: `python "${internalScript}" --root "${ROOT}" --out "${internalOut}"`, cwd: ROOT,
      internalWorker: 'kb_extract', retryable: true, maxAttempts: 2, start: false });
    assert.equal(internal.ok, true, 'fixed internal kb extractor may be queued without widening Python guard roots');
    assert.equal(rawMeta(internal.id).internalWorker, 'kb_extract');
    assert.equal(m.cancelJob(internal.id).status, 'cancelled');
    const arbitraryInternal = m.enqueueJob({ command: `python "${secretScript}" --root "${ROOT}" --out "${internalOut}"`, cwd: ROOT,
      internalWorker: 'kb_extract', start: false });
    assert.equal(arbitraryInternal.ok, false, 'internal worker cannot substitute an arbitrary Python script');

    let fakeStarts = 0;
    const held = manager({ jobsDir: path.join(ROOT, 'held-jobs'), maxActive: 1,
      spawnImpl: () => { fakeStarts++; const child = new EventEmitter(); child.pid = 123456 + fakeStarts; child.unref = () => {}; return child; }, pidAlive: () => true });
    const heldOne = enqueue(held, secretScript);
    const heldTwo = enqueue(held, secretScript);
    const heldThree = enqueue(held, secretScript);
    assert.equal(fakeStarts, 1, 'unreported heartbeat handles still reserve concurrency slots');
    assert.equal(held.statusJob(heldOne.id).meta.status, 'running');
    assert.equal(held.statusJob(heldTwo.id).meta.status, 'queued');
    assert.equal(held.statusJob(heldThree.id).meta.status, 'queued');

    const ambiguousId = 'starting_without_receipt'; const ambiguousDir = path.join(JOBS, ambiguousId); fs.mkdirSync(ambiguousDir, { recursive: true });
    fs.writeFileSync(path.join(ambiguousDir, 'meta.json'), JSON.stringify({ id: ambiguousId, status: 'starting', runToken: 'b'.repeat(48),
      runnerPid: null, attempts: 1, maxAttempts: 3, retryable: true, cwd: ROOT, bin: 'python', args: [], scriptPath: changedScript,
      scriptHash: 'old-hash', queueSeq: 1000 }));
    const ambiguousRecovery = m.recoverJobs({ start: false });
    assert.equal(m.statusJob(ambiguousId).meta.status, 'needs_review', 'ambiguous recovery fails closed');
    assert.equal(m.statusJob(ambiguousId).meta.status, 'needs_review', 'ambiguous starting jobs never auto-replay');

    // A new scheduler instance must claim a still-running isolated runner and read its receipt without replay.
    const longScript = writeScript('restart.py', "import time\ntime.sleep(4)\nopen('restart-marker.txt','a').write('done')\n");
    const beforeRestart = enqueue(m, longScript);
    await waitFor(m, beforeRestart.id, x => x.status === 'running');
    while (!fs.existsSync(path.join(JOBS, beforeRestart.id, 'heartbeat.json'))) await sleep(20);
    runnerPids.add(rawMeta(beforeRestart.id).runnerPid);
    m.dispose();
    const afterRestart = manager();
    const recovered = afterRestart.recoverJobs({ start: true });
    assert.equal(recovered.reclaimed, 1, 'live runner lease is reclaimed after first heartbeat, without replay');
    const final = await waitFor(afterRestart, beforeRestart.id, x => x.status === 'succeeded', 12000);
    assert.equal(final.meta.attempts, 1, 'live job is never replayed');
    assert.equal(fs.readFileSync(path.join(ROOT, 'restart-marker.txt'), 'utf8'), 'done');
    assert.equal(afterRestart.recoverJobs({ start: false }).changed, 0, 'recovery is idempotent');

    // A dead PID without matching heartbeat/receipt is never trusted, even if PID liveness is spoofed.
    const unsafeId = 'legacy_untrusted'; const unsafeDir = path.join(JOBS, unsafeId); fs.mkdirSync(unsafeDir, { recursive: true });
    fs.writeFileSync(path.join(unsafeDir, 'meta.json'), JSON.stringify({ id: unsafeId, status: 'running', pid: process.pid,
      runnerPid: process.pid, runToken: 'a'.repeat(48), bin: 'python', args: [], cwd: ROOT, retryable: false, attempts: 1, maxAttempts: 1 }));
    const unsafeRecovery = afterRestart.recoverJobs({ start: false });
    assert.equal(unsafeRecovery.needs_review, 1);
    assert.equal(afterRestart.statusJob(unsafeId).meta.status, 'needs_review');
    assert.equal(afterRestart.retryJob(unsafeId).ok, false, 'legacy records cannot execute without a verified execution schema');

    const mismatchId = 'pid_reused'; const mismatchDir = path.join(JOBS, mismatchId); fs.mkdirSync(mismatchDir, { recursive: true });
    const mismatchToken = 'c'.repeat(48);
    fs.writeFileSync(path.join(mismatchDir, 'meta.json'), JSON.stringify({ id: mismatchId, status: 'running', pid: 4567,
      runnerPid: 4567, runToken: mismatchToken, bin: 'python', args: [], cwd: ROOT, retryable: true, attempts: 1, maxAttempts: 2,
      startedAt: Date.now() - 1000 }));
    fs.writeFileSync(path.join(mismatchDir, 'heartbeat.json'), JSON.stringify({ runToken: mismatchToken, runnerPid: 4567,
      processStartedAt: Date.now() - 2000, at: Date.now() }));
    const pidReuseManager = manager({ pidAlive: () => true, pidStartTime: () => Date.now() - 300000 });
    const mismatchRecovery = pidReuseManager.recoverJobs({ start: false });
    assert.equal(mismatchRecovery.needs_review, 1, 'PID reuse without matching process start identity never reclaims or replays');
    assert.equal(pidReuseManager.statusJob(mismatchId).meta.status, 'needs_review');

    console.log('job scheduler tests passed');
  } finally {
    for (const m of managers) m.dispose();
    // Cancel only runner PIDs created by this isolated test.
    for (const pid of runnerPids) { try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(pid, 'SIGTERM'); } catch {} }
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

