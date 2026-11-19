'use strict';
// Explicit, bounded recovery for the isolated scheduler experiment only.
const fs = require('fs'), path = require('path'), net = require('net'), assert = require('assert/strict');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (!process.argv.includes('--live')) { console.log('Plan only: finish an existing isolated probe, no new computation; at most 2 additional model requests.'); return; }
  const selected = process.argv.find(x => x.startsWith('--audit='))?.slice(8);
  if (!/^cache-scheduler-live-2026-11-09-[a-f0-9]{10}$/.test(selected || '')) throw new Error('Exact experiment ID required');
  const audit = path.resolve(ROOT, 'audit', selected); assert.equal(path.dirname(audit), path.join(ROOT, 'audit'));
  const info = JSON.parse(fs.readFileSync(path.join(audit, 'run.json'), 'utf8'));
  assert.equal(info.app, path.join(audit, 'runtime', 'app'));
  assert.equal(Number(fs.readFileSync(path.join(info.workspace, 'execution-count.txt'), 'utf8')), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(info.workspace, 'outputs/summary.json'), 'utf8')), { count: 128, sum: 8256, mean: 64.5, min: 1, max: 128 });
  assert(fs.existsSync(path.join(info.workspace, 'findings/result.md')));
  const before = JSON.parse(fs.readFileSync(path.join(audit, 'requests.json'), 'utf8')).length;
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
  const provider = 'wanzhao-gpt', model = 'gpt-6-astra';
  const key = require('../core/providers').keyFor(provider, ROOT);
  const server = spawn(process.execPath, ['--require', path.join(ROOT, 'scripts/cache_scheduler_bootstrap.js'), 'core/server.js'], {
    cwd: info.app, windowsHide: true, env: { ...process.env, XIHE_PORT: String(port), XIHE_LIVE_SOURCE: ROOT,
      XIHE_LIVE_AUDIT: audit, XIHE_LIVE_PROVIDER: provider, XIHE_LIVE_MODEL: model, XIHE_LIVE_CALL_LIMIT: String(Math.min(12, before + 2)),
      OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', NODE_OPTIONS: '--max-old-space-size=256' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', b => { log += String(b).replaceAll(key, '[REDACTED]'); }); server.stderr.on('data', b => { log += String(b).replaceAll(key, '[REDACTED]'); });
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/api/health')).ok) break; } catch {} await pause(100); }
    const html = await (await fetch('http://127.0.0.1:' + port + '/')).text();
    const token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(html)?.[1]; assert(token);
    const api = async (route, body) => { const response = await fetch('http://127.0.0.1:' + port + route, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 200); return response.json(); };
    const followup = process.argv.includes('--followup');
    const beforeSession = await api('/api/session/open', { id: info.session_id });
    if (followup) assert(!beforeSession.last_error); else assert(beforeSession.last_error);
    const input = followup ? { id: info.session_id, text: '根据刚刚已经核验的交付，用一行列出结果文件和报告路径即可。不要再次读取文件、运行计算、调用工具或审计经验库。' }
      : { id: info.session_id, action: 'retry' };
    const response = await fetch('http://127.0.0.1:' + port + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, body: JSON.stringify(input) });
    assert.equal(response.status, 200); fs.writeFileSync(path.join(audit, followup ? 'followup-events.sse' : 'recovery-events.sse'), (await response.text()).replaceAll(key, '[REDACTED]'));
    const session = await api('/api/session/open', { id: info.session_id }); const jobs = await api('/api/jobs?session_id=' + info.session_id);
    const diagnostics = await api('/api/session/cache-diagnostics?session_id=' + info.session_id);
    const after = JSON.parse(fs.readFileSync(path.join(audit, 'requests.json'), 'utf8')).length;
    const count = Number(fs.readFileSync(path.join(info.workspace, 'execution-count.txt'), 'utf8'));
    info.recovery = { mode: followup ? 'normal_followup' : 'retry_existing_outputs', before_requests: before, after_requests: after, additional_requests: after - before,
      status: session.status, has_error: !!session.last_error, execution_count: count, job_count: jobs.jobs.length,
      job_attempts: jobs.jobs[0]?.attempts, completed_at: Date.now() };
    info.recoveries = [...(info.recoveries || []), info.recovery];
    for (const [name, value] of [['run.json', info], ['session.json', session], ['jobs.json', jobs], ['diagnostics.json', diagnostics]])
      fs.writeFileSync(path.join(audit, name), JSON.stringify(value, null, 2) + '\n');
    assert.equal(session.status, 'idle'); assert(!session.last_error, 'Recovery must actually finish');
    assert.equal(count, 1); assert.equal(jobs.jobs.length, 1); assert.equal(jobs.jobs[0].status, 'succeeded'); assert.equal(jobs.jobs[0].attempts, 1);
    assert(after - before <= 2); console.log(JSON.stringify({ recovery: 'verified', ...info.recovery }));
    info.verified = true; info.status = session.status; info.job_wait = session.job_wait?.status || null;
    fs.writeFileSync(path.join(audit, 'run.json'), JSON.stringify(info, null, 2) + '\n');
  } finally {
    if (server.exitCode == null) { const done = new Promise(r => server.once('exit', r)); server.kill(); await done; }
    fs.writeFileSync(path.join(audit, 'recovery-server.log'), log.replaceAll(key, '[REDACTED]'));
  }
}
if (require.main === module) main().catch(error => { console.error(error.name + ': ' + String(error.message || error).slice(0, 160)); process.exitCode = 1; });
