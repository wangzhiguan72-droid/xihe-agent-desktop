'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { decodeText: decodeLog } = require('./textdec');
const APP_PATHS = require('./paths');

const JOBS_DIR = path.join(APP_PATHS.DATA_DIR, 'jobs');
const INTERNAL_KB_DIR = path.join(APP_PATHS.DATA_DIR, 'kb');
const MAX_ACTIVE = 2;
const ALLOWED_BINS = new Set(['matlab', 'python']);
const RUNNER_PATH = path.join(__dirname, 'job_runner.js');
const PY_GUARD_PATH = path.join(__dirname, 'pywrap.py');
const PYTHON_PATH = process.env.XIHE_PYTHON || 'python';

function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  try { const dirFd = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); } } catch {}
}
function safeId(id) { return /^[A-Za-z0-9_-]{1,120}$/.test(String(id || '')); }
function parseCommand(command) {
  const c = String(command || '').trim(); if (!c) throw new Error('command 不能为空');
  const tokens = []; let cur = '', quote = null;
  for (const ch of c) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (cur) { tokens.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (quote) throw new Error('command 引号未闭合');
  if (cur) tokens.push(cur); if (!tokens.length) throw new Error('无法解析命令');
  const bin = path.basename(tokens[0]).toLowerCase().replace(/\.exe$/, '');
  if (!ALLOWED_BINS.has(bin)) throw new Error(`禁止以 ${bin} 作为长作业入口（仅放行白名单：${[...ALLOWED_BINS].join(', ')}）`);
  const args = tokens.slice(1);
  if (bin === 'python' && !(args[0] && /\.py$/i.test(args[0]))) throw new Error('python 长作业只能执行脚本文件');
  if (bin === 'matlab' && !args.includes('-batch')) throw new Error('matlab 长作业只放行 -batch 模式');
  return { bin, args };
}
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function processAlive(pid) {
  const n = Number(pid); if (!Number.isInteger(n) || n <= 0) return false;
  try {
    if (process.platform === 'win32') return /^\s*"[^"]+"/.test(execFileSync('tasklist', ['/FI', `PID eq ${n}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    process.kill(n, 0); return true;
  } catch { return false; }
}
function processStartTimeMs(pid) {
  const n = Number(pid); if (!Number.isInteger(n) || n <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const ticks = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process -Id ${n} -ErrorAction SilentlyContinue;if($p){[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2500 }).trim());
      return Number.isFinite(ticks) && ticks > 0 ? ticks / 10000 - 62135596800000 : null;
    }
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(n)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2500 }).trim();
    const parsed = Date.parse(raw); return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}
function makeEnvSnapshot(env, cwd, pyMode) {
  const keys = ['PATH', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'PYTHONUTF8', 'PYTHONIOENCODING',
    'MPLBACKEND', 'MPLCONFIGDIR', 'PYTHONPYCACHEPREFIX', 'XIHE_PY_MODE', 'XIHE_PY_ROOT', 'XIHE_PY_WRITE_ROOT', 'XIHE_PY_TEMP', 'TEMP', 'TMP', 'PYTHONPATH'];
  const out = {};
  for (const k of keys) if (typeof env?.[k] === 'string') out[k] = env[k];
  if (!out.PATH && typeof env?.Path === 'string') out.PATH = env.Path;
  const mode = pyMode || env?.XIHE_PY_MODE;
  out.XIHE_PY_MODE = ['ro', 'redteam'].includes(mode) ? mode : 'rw';
  out.XIHE_PY_ROOT = typeof env?.XIHE_PY_ROOT === 'string' ? env.XIHE_PY_ROOT : cwd;
  if (typeof env?.XIHE_PY_WRITE_ROOT === 'string') out.XIHE_PY_WRITE_ROOT = env.XIHE_PY_WRITE_ROOT;
  return out;
}

function createJobManager({ jobsDir = JOBS_DIR, runnerPath = RUNNER_PATH, pythonPath = PYTHON_PATH,
  guardPath = PY_GUARD_PATH, maxActive = MAX_ACTIVE, heartbeatTtlMs = 12000, retryBaseMs = 750,
  clock = () => Date.now(), spawnImpl = spawn, pidAlive = processAlive, pidStartTime = processStartTimeMs } = {}) {
  fs.mkdirSync(jobsDir, { recursive: true });
  const listeners = new Set(); const handles = new Map(); let pumping = false; let scheduler = null; let disposed = false;
  const jobDir = id => path.join(jobsDir, id);
  const metaFile = id => path.join(jobDir(id), 'meta.json');
  const readMeta = id => {
    if (!safeId(id)) return null;
    return readJSON(metaFile(id)) || readJSON(path.join(jobsDir, id + '.json'));
  };
  const writeMeta = m => { fs.mkdirSync(jobDir(m.id), { recursive: true }); atomicWrite(metaFile(m.id), JSON.stringify(m, null, 2)); };
  const verifiedLeases = new Set();
  function subscribe(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); }
  function event(type, m, extra = {}) {
    const payload = { type, at: clock(), job: publicMeta(m), ...extra };
    for (const fn of listeners) { try { fn(payload); } catch {} }
  }
  function publicMeta(m) {
    if (!m) return null;
    const { id, label, command, cwd, status, startedAt, queuedAt, finishedAt, exitCode, pid, attempts, maxAttempts, retryable, lastError, recoveryCount, recoveryReason, session_id, project_id } = m;
    return { id, label, command: String(command || '').slice(0, 240), cwd: cwd || null, status, startedAt: startedAt || null,
      queuedAt: queuedAt || null, finishedAt: finishedAt || null, exitCode: exitCode ?? null, pid: pid || null,
      attempts: attempts || 0, maxAttempts: maxAttempts || 1, retryable: retryable === true, lastError: lastError || null,
      recoveryCount: recoveryCount || 0, recoveryReason: recoveryReason || null, session_id: session_id || null, project_id: project_id || null };
  }
  function listJobs() {
    const rows = new Map();
    for (const e of fs.readdirSync(jobsDir, { withFileTypes: true })) {
      try {
        if (e.isDirectory()) { const m = readMeta(e.name); if (m?.id === e.name && safeId(m.id)) rows.set(m.id, m); }
        else if (e.isFile() && e.name.endsWith('.json')) { const m = readJSON(path.join(jobsDir, e.name)); if (safeId(m?.id) && !rows.has(m.id)) rows.set(m.id, m); }
      } catch {}
    }
    return [...rows.values()].sort((a, b) => (a.queueSeq || a.queuedAt || a.startedAt || 0) - (b.queueSeq || b.queuedAt || b.startedAt || 0));
  }
  function leaseValid(m, verifyIdentity = false) {
    if (!m.runnerPid || !m.runToken || !pidAlive(m.runnerPid)) return false;
    const hb = readJSON(path.join(jobDir(m.id), 'heartbeat.json'));
    if (!hb || hb.runToken !== m.runToken || hb.runnerPid !== m.runnerPid || clock() - hb.at > heartbeatTtlMs) return false;
    const identity = `${m.id}:${m.runToken}:${m.runnerPid}`;
    if (!verifyIdentity && verifiedLeases.has(identity)) return true;
    const actualStart = pidStartTime(m.runnerPid);
    const valid = actualStart != null && hb.processStartedAt != null && Math.abs(actualStart - Number(hb.processStartedAt)) <= 1500;
    if (valid) verifiedLeases.add(identity);
    return valid;
  }
  function logTail(id, name) {
    try {
      const p = path.join(jobDir(id), name); const st = fs.statSync(p); const fd = fs.openSync(p, 'r');
      try { const start = Math.max(0, st.size - 4096); const b = Buffer.alloc(st.size - start); fs.readSync(fd, b, 0, b.length, start); return { text: decodeLog(b), bytes: st.size }; }
      finally { fs.closeSync(fd); }
    } catch { return { text: '', bytes: 0 }; }
  }
  function runCommand(m, token, manifestPath) {
    let bin = m.bin; let args = m.args.slice();
    if (m.bin === 'python') {
      bin = m.pythonPath || pythonPath;
      args = m.internalWorker === 'kb_extract' ? ['-I', ...args] : [guardPath, ...args];
    }
    const manifest = { id: m.id, runToken: token, cwd: m.cwd, bin, args, env: m.envSnapshot,
      stdoutPath: path.join(jobDir(m.id), 'stdout.log'), stderrPath: path.join(jobDir(m.id), 'stderr.log'), heartbeatPath: path.join(jobDir(m.id), 'heartbeat.json'), receiptPath: path.join(jobDir(m.id), 'receipt.json'), cancelPath: path.join(jobDir(m.id), 'cancel.json'), heartbeatMs: 1000 };
    atomicWrite(manifestPath, JSON.stringify(manifest));
  }
  function launch(m) {
    const cur = readMeta(m.id); if (!cur || cur.status !== 'queued' || cur.cancelRequested || handles.has(cur.id)) return false;
    if (!scriptUnchanged(cur)) {
      cur.status = 'needs_review'; cur.lastError = '入队后 Python 脚本发生变化，已阻止执行'; cur.finishedAt = clock();
      writeMeta(cur); event('needs_review', cur); return false;
    }
    // Before process launch, mark starting. A crash in this window is ambiguous and recovery fails closed.
    cur.status = 'starting'; cur.attempts = Number(cur.attempts || 0) + 1; cur.startedAt = clock(); cur.finishedAt = null;
    cur.exitCode = null; cur.pid = null; cur.runnerPid = null; cur.runToken = crypto.randomBytes(24).toString('hex'); cur.lastError = null;
    writeMeta(cur);
    const manifestPath = path.join(jobDir(cur.id), `run-${cur.attempts}.json`); runCommand(cur, cur.runToken, manifestPath);
    const child = spawnImpl(process.execPath, [runnerPath, manifestPath], { cwd: cur.cwd || process.cwd(),
      env: { PATH: process.env.PATH || '', SYSTEMROOT: process.env.SYSTEMROOT || '', WINDIR: process.env.WINDIR || '',
        HOME: process.env.HOME || '', USERPROFILE: process.env.USERPROFILE || '', NODE_ENV: 'production',
        ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref?.(); handles.set(cur.id, child);
    cur.status = 'running'; cur.runnerPid = child.pid; cur.pid = child.pid; writeMeta(cur); event('start', cur);
    child.once?.('error', e => { const latest = readMeta(cur.id); if (!latest || latest.runToken !== cur.runToken) return; handles.delete(cur.id); latest.status = 'needs_review'; latest.lastError = String(e.message || e); latest.finishedAt = clock(); writeMeta(latest); event('needs_review', latest); pumpJobs(); });
    child.once?.('exit', () => { handles.delete(cur.id); recoverJobs({ start: false }); pumpJobs(); });
    return true;
  }
  function activeCount() {
    const external = listJobs().filter(m => !handles.has(m.id) && (['starting', 'running'].includes(m.status) || m.uncertainActive));
    return handles.size + external.length;
  }
  function pumpJobs() {
    if (disposed || pumping) return; pumping = true;
    try {
      let slots = Math.max(0, maxActive - activeCount());
      for (const m of listJobs().filter(x => x.status === 'queued' && !x.cancelRequested && Number(x.retryAt || 0) <= clock())) { if (slots <= 0) break; if (launch(m)) slots--; }
    } finally { pumping = false; }
  }
  function enqueueJob(options = {}) {
    let parsed;
    try {
      parsed = parseCommand(options.command);
      if (parsed.bin === 'python' && options.internalWorker !== 'kb_extract' && options.pyGuard !== guardPath) throw new Error('python 长作业必须使用内置守卫路径');
      if (options.pyGuard && path.resolve(options.pyGuard) !== path.resolve(guardPath)) throw new Error('自定义 Python 守卫路径不允许');
      if (options.internalWorker && options.internalWorker !== 'kb_extract') throw new Error('未知 internalWorker');
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
    const cwd = path.resolve(options.cwd || process.cwd());
    const dedupRaw = options.dedupKey ?? options.dedup_key;
    const dedupKey = dedupRaw == null ? null : String(dedupRaw).slice(0, 300);
    if (dedupKey) {
      const existing = listJobs().find(m => m.dedupKey === dedupKey);
      if (existing) {
        if (existing.command !== String(options.command) || path.resolve(existing.cwd || process.cwd()) !== cwd)
          return { ok: false, error: 'dedup_key 已绑定到不同命令或工作目录' };
        return { ok: true, id: existing.id, pid: existing.pid, status: existing.status, retryable: existing.retryable, deduplicated: true,
          log_paths: { stdout: path.join(jobDir(existing.id), 'stdout.log'), stderr: path.join(jobDir(existing.id), 'stderr.log') } };
      }
    }
    const id = 'job_' + crypto.randomBytes(6).toString('hex'); const dir = jobDir(id); fs.mkdirSync(dir, { recursive: true });
    for (const name of ['stdout.log', 'stderr.log']) fs.closeSync(fs.openSync(path.join(dir, name), 'a'));
    const scriptIdx = parsed.bin === 'python' ? 0 : -1;
    let scriptPath = null;
    if (scriptIdx >= 0) {
      try {
        scriptPath = fs.realpathSync(path.resolve(cwd, parsed.args[scriptIdx]));
        if (options.internalWorker === 'kb_extract') {
          const fixed = fs.realpathSync(path.join(__dirname, 'kb_extract.py'));
          if (scriptPath !== fixed) return { ok: false, error: 'kb_extract internalWorker 只允许内置 core/kb_extract.py' };
          const args = parsed.args.slice(scriptIdx + 1);
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '--root') { if (!args[i + 1]) return { ok: false, error: 'kb_extract --root 缺路径' }; i++; continue; }
            if (args[i] === '--full') continue;
            if (args[i] === '--out') {
              const expected = path.resolve(INTERNAL_KB_DIR);
              if (!args[i + 1] || path.resolve(args[++i]) !== expected) return { ok: false, error: 'kb_extract 输出路径必须是内置 data/kb' };
              continue;
            }
            return { ok: false, error: 'kb_extract 参数超出固定白名单' };
          }
        } else {
          const guardRoot = fs.realpathSync(options.env?.XIHE_PY_ROOT || cwd);
          const realCwd = fs.realpathSync(cwd);
          if (realCwd !== guardRoot && !realCwd.startsWith(guardRoot + path.sep)) return { ok: false, error: 'Python 长作业工作目录超出守卫根目录' };
          if (scriptPath !== guardRoot && !scriptPath.startsWith(guardRoot + path.sep)) return { ok: false, error: 'Python 脚本实际路径超出守卫根目录' };
        }
        parsed.args[scriptIdx] = scriptPath;
      } catch { return { ok: false, error: 'Python 脚本、工作目录或守卫根目录不可用' }; }
    }
    const scriptHash = scriptPath ? crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex') : null;
    const env = makeEnvSnapshot(options.env || {}, cwd, options.pyMode);
    // Keep only specific numerical cache paths, never API keys or arbitrary caller environment.
    for (const k of ['MPLCONFIGDIR', 'PYTHONPYCACHEPREFIX', 'XIHE_PY_TEMP', 'TEMP', 'TMP', 'PYTHONPATH', 'XIHE_PY_WRITE_ROOT']) {
      if (typeof options.env?.[k] === 'string' && (k !== 'PYTHONPATH' || options.env[k].split(path.delimiter).every(p => !/key|secret|token/i.test(p)))) env[k] = options.env[k];
    }
    const seq = Math.max(0, ...listJobs().map(m => Number(m.queueSeq || 0))) + 1;
    const requestedAttempts = Number(options.maxAttempts ?? options.max_attempts);
    const maxAttempts = Number.isFinite(requestedAttempts) ? Math.max(1, Math.min(5, Math.floor(requestedAttempts))) : 1;
    const m = { id, executionSchema: 1, label: String(options.label || `${parsed.bin} ${parsed.args[0]}`).slice(0, 200), command: String(options.command), cwd,
      bin: parsed.bin, args: parsed.args, pythonPath: options.pythonPath || pythonPath, status: 'queued', queueSeq: seq, queuedAt: clock(), startedAt: null, finishedAt: null,
      exitCode: null, pid: null, runnerPid: null, runToken: null, attempts: 0, maxAttempts,
      retryable: parsed.bin === 'python' && options.retryable === true
        && (options.internalWorker === 'kb_extract' || options.pyGuard === guardPath),
      lastError: null, recoveryCount: 0, recoveryReason: null, cancelRequested: false, envSnapshot: env,
      scriptPath, scriptHash, internalWorker: options.internalWorker || null, dedupKey, session_id: options.session_id || null, project_id: options.project_id || null };
    writeMeta(m); event('enqueue', m); if (options.start !== false) pumpJobs();
    const current = readMeta(id); return { ok: true, id, pid: current.pid, status: current.status, retryable: m.retryable,
      log_paths: { stdout: path.join(dir, 'stdout.log'), stderr: path.join(dir, 'stderr.log') } };
  }
  function startJob(options) { return enqueueJob({ ...options, start: true }); }
  function recoverJobs({ start = false } = {}) {
    const result = { reclaimed: 0, requeued: 0, needs_review: 0, changed: 0 };
    for (const m of listJobs()) {
      if (['starting', 'running'].includes(m.status) || m.uncertainActive) {
        // A launch owned by this manager is still in its handoff window; only
        // reconcile it after this manager itself has lost the runner handle.
        if (handles.has(m.id)) continue;
        let receipt = readJSON(path.join(jobDir(m.id), 'receipt.json'));
        if (!m.runToken || receipt?.runToken !== m.runToken) receipt = null;
        const hb = readJSON(path.join(jobDir(m.id), 'heartbeat.json'));
        const validLease = !receipt && leaseValid(m);
        const alive = m.runnerPid && pidAlive(m.runnerPid);
        // The runner can publish its receipt while identity/liveness is queried.
        // Re-read after observing death before considering a new attempt.
        if (!alive && !receipt) receipt = readJSON(path.join(jobDir(m.id), 'receipt.json'));
        if (receipt && receipt.runToken === m.runToken) {
          m.uncertainActive = false;
          m.exitCode = receipt.exitCode; m.finishedAt = receipt.finishedAt || clock(); m.pid = null; m.runnerPid = null;
          if (receipt.cancelled) m.status = 'cancelled';
          else if (receipt.exitCode === 0) m.status = 'succeeded';
          else recoverFailed(m, `恢复到进程退出回执：${receipt.error || `exit ${receipt.exitCode}`}`, result);
          writeMeta(m); event('finish', m); result.changed++;
        } else if (validLease && hb?.runToken === m.runToken) {
          const wasUncertain = m.uncertainActive;
          m.uncertainActive = false;
          m.status = 'running';
          m.pid = m.runnerPid;
          if (m.recoveryReason !== '服务已重启并重新认领 runner') {
            m.recoveryCount = Number(m.recoveryCount || 0) + 1;
            m.recoveryReason = '服务已重启并重新认领 runner'; writeMeta(m); event('reclaim', m); result.reclaimed++;
          } else if (wasUncertain) { writeMeta(m); event('reclaim', m); result.changed++; }
        } else if (alive && m.executionSchema === 1 && (!hb || hb.runToken !== m.runToken) && clock() - Number(m.startedAt || 0) < heartbeatTtlMs) {
          // A known launch may not have published its first heartbeat yet.
        } else if (alive) {
          if (!m.uncertainActive) {
            m.status = 'needs_review'; m.uncertainActive = true;
            m.lastError = '存活PID缺少匹配执行身份或有效心跳；暂停认领与重试，请核对已有产物';
            writeMeta(m); event('needs_review', m); result.needs_review++; result.changed++;
          }
        } else {
          m.uncertainActive = false;
          m.lastError = '服务重启时没有有效 runner 心跳或完成回执'; m.finishedAt = clock(); m.pid = null; m.runnerPid = null;
          recoverFailed(m, m.lastError, result, true); writeMeta(m); event(m.status === 'queued' ? 'retry' : m.status === 'needs_review' ? 'needs_review' : 'finish', m); result.changed++;
        }
      } else if (m.status === 'failed' && m.retryable && m.attempts < m.maxAttempts) {
        if (!scriptUnchanged(m)) { m.status = 'needs_review'; m.lastError = '输入脚本自上次运行后已变化'; writeMeta(m); event('needs_review', m); result.needs_review++; result.changed++; }
        else { m.status = 'queued'; m.queueSeq = Math.max(0, ...listJobs().map(x => Number(x.queueSeq || 0))) + 1; m.queuedAt = clock();
          m.retryAt = clock() + Math.min(30000, retryBaseMs * (2 ** Math.max(0, m.attempts - 1)));
          writeMeta(m); event('retry', m); result.requeued++; result.changed++; }
      }
    }
    if (start) pumpJobs(); return result;
  }
  function scriptUnchanged(m) {
    if (m.executionSchema !== 1 || !ALLOWED_BINS.has(m.bin) || !Array.isArray(m.args)) return false;
    if (m.bin === 'matlab') return !m.internalWorker && m.args.includes('-batch');
    if (!m.scriptPath || m.args[0] !== m.scriptPath || !/\.py$/i.test(m.scriptPath)) return false;
    try {
      const realScript = fs.realpathSync(m.scriptPath);
      if (realScript !== m.scriptPath) return false;
      if (m.internalWorker === 'kb_extract') {
        if (realScript !== fs.realpathSync(path.join(__dirname, 'kb_extract.py')) || m.bin !== 'python' || m.args?.[0] !== realScript) return false;
        const args = m.args.slice(1);
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--root' && args[i + 1]) { i++; continue; }
          if (args[i] === '--full') continue;
          if (args[i] === '--out' && args[i + 1] && path.resolve(args[++i]) === path.resolve(INTERNAL_KB_DIR)) continue;
          return false;
        }
      } else {
        if (m.internalWorker) return false;
        const root = fs.realpathSync(m.envSnapshot?.XIHE_PY_ROOT || m.cwd);
        if (realScript !== root && !realScript.startsWith(root + path.sep)) return false;
        const cwd = fs.realpathSync(m.cwd || root);
        if (cwd !== root && !cwd.startsWith(root + path.sep)) return false;
      }
      return crypto.createHash('sha256').update(fs.readFileSync(realScript)).digest('hex') === m.scriptHash;
    } catch { return false; }
  }
  function recoverFailed(m, reason, result, ambiguous = false) {
    m.pid = null; m.runnerPid = null; m.recoveryCount = Number(m.recoveryCount || 0) + 1; m.recoveryReason = reason;
    if (m.cancelRequested) { m.status = 'cancelled'; return; }
    if (m.retryable && m.attempts < m.maxAttempts && scriptUnchanged(m)) {
      m.status = 'queued'; m.queueSeq = Math.max(0, ...listJobs().map(x => Number(x.queueSeq || 0))) + 1; m.queuedAt = clock();
      m.retryAt = clock() + Math.min(30000, retryBaseMs * (2 ** Math.max(0, m.attempts - 1))); result.requeued++;
    } else if (ambiguous) { m.status = 'needs_review'; if (m.retryable && !scriptUnchanged(m)) m.lastError = '输入脚本自上次运行后已变化'; result.needs_review++; }
    else m.status = 'failed';
  }
  function retryJob(id, { start = true } = {}) {
    const m = readMeta(id); if (!m) return { ok: false, error: 'job 不存在' };
    if (['running', 'starting', 'queued'].includes(m.status)) return { ok: false, error: 'job 正在运行或排队中' };
    if (!['failed', 'needs_review', 'interrupted'].includes(m.status)) return { ok: false, error: `当前状态 ${m.status} 不支持重试` };
    if (m.uncertainActive) return { ok: false, error: '原执行器状态仍未确认，暂不能重试；请先核对任务与已有产物' };
    if (!scriptUnchanged(m)) return { ok: false, error: '输入脚本已变化；请创建新任务以免执行未审阅的代码' };
    m.status = 'queued'; m.queueSeq = Math.max(0, ...listJobs().map(x => Number(x.queueSeq || 0))) + 1; m.queuedAt = clock(); m.retryAt = 0; m.startedAt = null; m.finishedAt = null;
    m.pid = null; m.runnerPid = null; m.runToken = null; m.exitCode = null; m.cancelRequested = false; m.lastError = null; m.recoveryReason = '用户手动重试';
    writeMeta(m); event('retry', m); if (start) pumpJobs(); const cur = readMeta(id); return { ok: true, id, status: cur.status, pid: cur.pid };
  }
  function cancelJob(id) {
    const m = readMeta(id); if (!m) return { ok: false, error: 'job 不存在' };
    if (m.uncertainActive) return { ok: false, error: '执行身份不明，拒绝声称已取消；请先核对任务状态' };
    if (['queued', 'failed', 'needs_review', 'interrupted'].includes(m.status)) { m.status = 'cancelled'; m.finishedAt = clock(); m.cancelRequested = true; writeMeta(m); event('finish', m); return { ok: true, status: m.status }; }
    if (!['starting', 'running'].includes(m.status)) return { ok: true, already_done: true, status: m.status };
    const receipt = readJSON(path.join(jobDir(id), 'receipt.json'));
    if (receipt?.runToken === m.runToken) { recoverJobs({ start: false }); return { ok: true, already_done: true, status: readMeta(id)?.status || 'finished' }; }
    const hb = readJSON(path.join(jobDir(id), 'heartbeat.json'));
    if (!handles.has(id) && (!leaseValid(m, true) || !hb || hb.runToken !== m.runToken)) return { ok: false, error: '任务 runner 租约失效，拒绝按 PID 猜测并终止进程；请刷新任务状态' };
    m.cancelRequested = true; writeMeta(m);
    const tokenFile = path.join(jobDir(id), 'cancel.json'); atomicWrite(tokenFile, JSON.stringify({ runToken: m.runToken, at: clock() }));
    event('cancelling', m); return { ok: true };
  }
  function statusJob(id) {
    const meta = readMeta(id); if (!meta) return null;
    const stdout = logTail(id, 'stdout.log'); const stderr = logTail(id, 'stderr.log');
    const row = publicMeta(meta); row.logBytes = stdout.bytes + stderr.bytes;
    return { meta: row, tail: stdout.text, stderr: stderr.text, stderrTail: stderr.text, logBytes: row.logBytes };
  }
  function startScheduler(intervalMs = 1000) { if (scheduler) return; scheduler = setInterval(() => { recoverJobs({ start: false }); pumpJobs(); }, intervalMs); scheduler.unref?.(); }
  function stopScheduler() { if (scheduler) clearInterval(scheduler); scheduler = null; }
  function dispose() { disposed = true; stopScheduler(); listeners.clear(); }
  return { enqueueJob, startJob, retryJob, cancelJob, statusJob, listJobs, recoverJobs, pumpJobs, subscribe,
    startScheduler, stopScheduler, dispose, publicMeta, jobsDir, maxActive };
}

const manager = createJobManager();
module.exports = { ...manager, createJobManager, parseCommand, processStartTimeMs, JOBS_DIR, MAX_ACTIVE };
