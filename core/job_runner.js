'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function atomicJSON(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function run(manifestPath) {
  const manifest = readJSON(manifestPath);
  if (!manifest || typeof manifest.runToken !== 'string' || !/^[a-f0-9]{48}$/.test(manifest.runToken)) process.exit(121);
  const runnerPid = process.pid;
  const processStartedAt = Date.now() - process.uptime() * 1000;
  const writeHeartbeat = () => atomicJSON(manifest.heartbeatPath, { runToken: manifest.runToken, runnerPid, processStartedAt, at: Date.now() });
  const interval = setInterval(writeHeartbeat, Math.max(250, Math.min(Number(manifest.heartbeatMs) || 1000, 5000)));
  interval.unref(); writeHeartbeat();
  const stdout = fs.openSync(manifest.stdoutPath, 'a'); const stderr = fs.openSync(manifest.stderrPath, 'a');
  let cancelPoll = null;
  const finish = (code, error, cancelled) => {
    clearInterval(interval);
    if (cancelPoll) clearInterval(cancelPoll);
    try { fs.closeSync(stdout); } catch {}
    try { fs.closeSync(stderr); } catch {}
    atomicJSON(manifest.receiptPath, { runToken: manifest.runToken, runnerPid, processStartedAt, exitCode: Number.isInteger(code) ? code : -1,
      error: error ? String(error).slice(0, 1000) : null, cancelled: !!cancelled, finishedAt: Date.now() });
    process.exitCode = Number.isInteger(code) && code >= 0 ? code : 1;
  };
  const child = spawn(manifest.bin, manifest.args, { cwd: manifest.cwd, env: manifest.env, windowsHide: true,
    stdio: [null, stdout, stderr], detached: false });
  let finished = false;
  const done = (code, error) => { if (finished) return; finished = true; finish(code, error, sawCancel); };
  child.once('error', e => done(-1, e.message));
  child.once('exit', code => done(code, null));
  let sawCancel = false;
  cancelPoll = setInterval(() => {
    const c = readJSON(manifest.cancelPath);
    if (c?.runToken !== manifest.runToken || sawCancel) return;
    sawCancel = true;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGTERM');
    } catch {}
  }, 400);
  cancelPoll.unref();
  const stop = () => { if (!finished) { try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); else child.kill('SIGTERM'); } catch {} } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (require.main === module) {
  if (!process.argv[2]) process.exit(120);
  try { run(path.resolve(process.argv[2])); } catch { process.exit(122); }
}
module.exports = { run };
