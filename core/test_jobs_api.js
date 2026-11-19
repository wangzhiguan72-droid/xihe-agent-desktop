'use strict';
// Real isolated server + real guarded Python + fake local provider. No paid API or user state.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-async-api-'));
const app = path.join(tmp, 'app');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await pause(100); }
  throw new Error(message);
}
async function freePort() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
let proc, upstream, token, port, calls = 0, childLog = '', seenJobId = null, kbMode = false, kbCalls = 0;
const corpus = path.join(tmp, 'external-corpus');
async function stop() {
  if (!proc || proc.exitCode != null) return;
  const current = proc; const ended = new Promise(r => current.once('exit', r)); current.kill(); await ended; proc = null;
}
async function start() {
  proc = spawn(process.execPath, ['core/server.js'], { cwd: app, env: { ...process.env, XIHE_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', b => { childLog += b.toString(); }); proc.stderr.on('data', b => { childLog += b.toString(); });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } }, 'isolated server did not start: ' + childLog);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  token = html.match(/name="xihe-token"[^>]*content="([^"]+)"/)[1];
}
async function api(route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await res.json(); if (!res.ok) throw new Error(route + ': ' + JSON.stringify(result)); return result;
}
(async () => {
  try {
    fs.mkdirSync(app);
    for (const dir of ['core', 'ui', 'contest_packages']) fs.cpSync(path.join(__dirname, '..', dir), path.join(app, dir), { recursive: true });
    fs.cpSync(path.join(__dirname, '..', 'skills', 'contest-modeling-generic'), path.join(app, 'skills', 'contest-modeling-generic'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(app, 'package.json'));
    fs.mkdirSync(path.join(app, 'config'));
    upstream = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); calls++;
      let message;
      if (kbMode) {
        message = ++kbCalls === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'build-index', type: 'function', function: { name: 'kb_build', arguments: JSON.stringify({ roots: [corpus] }) } }] }
          : { role: 'assistant', content: '索引任务已提交。' };
      }
      else if (calls === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'start-calculation', type: 'function', function: { name: 'job_start', arguments: JSON.stringify({ command: 'python scripts/background.py', label: '重启验证', retryable: true, max_attempts: 2 }) } }] };
      else if (calls === 2) {
        const toolOutput = body.messages.find(m => m.role === 'tool' && m.tool_call_id === 'start-calculation')?.content || '';
        seenJobId = /job_id:\s*(job_\w+)/.exec(toolOutput)?.[1];
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'wait-calculation', type: 'function', function: { name: 'job_wait', arguments: JSON.stringify({ ids: [seenJobId] }) } }] };
      } else message = { role: 'assistant', content: '后台结果已核对，已恢复主流程。' };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 8 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 8 } })); }
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const providerBase = `http://127.0.0.1:${upstream.address().port}/v1`;
    fs.writeFileSync(path.join(app, 'config', 'settings.json'), JSON.stringify({ default_model: 'async-test:offline-model', custom_providers: [{ id: 'async-test', base: providerBase, kind: 'openai', models: ['offline-model'] }], kb_roots: [], daily_budget: 0 }));
    fs.writeFileSync(path.join(app, 'config', 'custom_async-test.key'), 'offline-test-key');
    port = await freePort(); await start();
    const sidecarPort = await freePort();
    const sidecar = spawn(process.execPath, ['core/server.js'], { cwd: app, env: { ...process.env, XIHE_PORT: String(sidecarPort) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let sidecarLog = ''; sidecar.stdout.on('data', b => { sidecarLog += b; }); sidecar.stderr.on('data', b => { sidecarLog += b; });
    const sidecarExit = await new Promise(resolve => sidecar.once('exit', resolve));
    assert.equal(sidecarExit, 1); assert.match(sidecarLog, /另一实例/);
    const s = await api('/api/session/new', { mode: 'free', title: 'async test' });
    const ws = path.join(tmp, 'workspace', 'projects', s.project_id);
    fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'scripts', 'background.py'), 'import time\nfrom pathlib import Path\ntime.sleep(4)\np = Path("completed-count.txt")\np.write_text(str(int(p.read_text()) + 1) if p.exists() else "1")\nprint("background work complete")\n');
    const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, body: JSON.stringify({ id: s.id, text: 'start async work' }) });
    const events = await chat.text();
    assert.match(events, /waiting_jobs/, 'main loop must suspend instead of busy-polling');
    assert.equal(calls, 2);
    assert.ok(seenJobId);
    let snapshot = await api('/api/jobs?session_id=' + s.id);
    assert.equal(snapshot.jobs.length, 1); assert.equal(snapshot.jobs[0].session_id, s.id);
    assert.equal((await api('/api/jobs?session_id=unrelated')).jobs.length, 0);
    const mismatch = await fetch(`http://127.0.0.1:${port}/api/jobs/detail?id=${seenJobId}&session_id=unrelated`, { headers: { 'X-Xihe-Token': token } });
    assert.equal(mismatch.status, 403, 'scoped detail must not leak another session log');
    for (const hard of [false, true]) {
      const deletion = await fetch(`http://127.0.0.1:${port}/api/session/delete`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, body: JSON.stringify({ id: s.id, hard }) });
      assert.equal(deletion.status, 409, 'waiting parent cannot be deleted while its detached calculation is active');
    }
    const oldToken = token;
    await stop();
    await until(() => fs.existsSync(path.join(ws, 'completed-count.txt')), 'runner died with the server');
    await pause(400); await start();
    assert.notEqual(token, oldToken);
    const completed = await until(async () => { const current = await api('/api/session/open', { id: s.id }); return current.job_wait?.status === 'completed' && current.messages.some(m => m.content === '后台结果已核对，已恢复主流程。') ? current : null; }, 'parent did not resume after restart: ' + childLog);
    assert.equal(calls, 3, 'must resume once without regenerating the job');
    assert.equal(fs.readFileSync(path.join(ws, 'completed-count.txt'), 'utf8'), '1', 'successful detached calculation must not replay');
    assert.equal(completed.compute_runs, 0, 'background log must not bypass formal evidence gates');
    snapshot = await api('/api/jobs?session_id=' + s.id);
    assert.equal(snapshot.jobs[0].status, 'succeeded'); assert.equal(snapshot.jobs[0].attempts, 1);
    assert.ok(snapshot.notifications.some(n => n.job.status === 'succeeded'));
    assert.ok(!JSON.stringify(snapshot).includes('offline-test-key'));
    const detail = await api('/api/jobs/detail?id=' + seenJobId); assert.match(detail.tail, /background work complete/);
    await api('/api/jobs/ack', { ids: snapshot.notifications.map(n => n.id) });
    await stop(); await start();
    assert.equal((await api('/api/jobs?session_id=' + s.id)).unread, 0, 'notification ack must survive service restart');
    await pause(500); assert.equal(calls, 3, 'completed parent must not resume again on another restart');
    const streamAbort = new AbortController();
    const eventStream = await fetch(`http://127.0.0.1:${port}/api/jobs/events?session_id=${s.id}`, { headers: { 'X-Xihe-Token': token }, signal: streamAbort.signal });
    const first = await eventStream.body.getReader().read(); assert.match(Buffer.from(first.value).toString(), /snapshot/); streamAbort.abort();
    await stop();
    const sessionFile = path.join(app, 'data', 'sessions', s.id + '.json');
    const reviewSession = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    reviewSession.job_wait.status = 'needs_review'; reviewSession.job_wait.error = 'interrupted test continuation';
    fs.writeFileSync(sessionFile, JSON.stringify(reviewSession));
    await start();
    assert.equal((await api('/api/jobs?session_id=' + s.id)).resumptions.length, 1);
    await api('/api/session/resume', { id: s.id, project_id: s.project_id, confirmed: true });
    await until(async () => (await api('/api/session/open', { id: s.id })).status === 'idle', 'manual parent continuation did not finish');
    assert.equal((await api('/api/jobs?session_id=' + s.id)).resumptions.length, 0, 'accepted manual continuation clears stale recovery card');
    // The existing trusted indexer needs its fixed internal worker, not a widened model-code guard.
    fs.mkdirSync(corpus);
    fs.writeFileSync(path.join(corpus, 'method.md'), '模型选择必须根据任务与证据，先建立基线，再检查假设、验证结果，并说明适用范围。'.repeat(8));
    kbMode = true;
    const indexSession = await api('/api/session/new', { mode: 'free', title: 'index regression' });
    const indexChat = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, body: JSON.stringify({ id: indexSession.id, text: 'build local index' }) });
    const indexEvents = await indexChat.text();
    assert.match(indexEvents, /知识库索引已启动/);
    const indexJob = await until(async () => {
      const data = await api('/api/jobs?session_id=' + indexSession.id);
      return data.jobs.find(j => /kb_extract/.test(j.label) && ['succeeded', 'failed', 'needs_review'].includes(j.status));
    }, 'trusted indexer did not finish');
    const indexDetail = await api('/api/jobs/detail?id=' + indexJob.id);
    assert.equal(indexJob.status, 'succeeded', 'trusted indexer failed: ' + indexDetail.stderr);
    assert.ok(require(path.join(app, 'core', 'kb')).status(app).docs > 0, 'corpus must become searchable');
    console.log('job API, detached completion, restart parent continuation and persistent notification tests passed');
  } finally {
    await stop();
    if (upstream) await new Promise(r => upstream.close(r));
    // tmp is an exact directory created for this test, never a computed user workspace.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); if (childLog) console.error(childLog.slice(-4000)); process.exitCode = 1; });
