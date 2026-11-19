'use strict';
// Isolated server, fake provider and synthetic sessions only. Never copy user settings/keys.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-focus-api-'));
const app = path.join(tmp, 'app');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let proc, provider, port, token, held = false, calls = 0, log = '', backgroundId;
async function until(fn, message, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error(message + '\n' + log.slice(-1000));
}
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function start() {
  proc = spawn(process.execPath, ['core/server.js'], { cwd: app, windowsHide: true, env: { ...process.env, XIHE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', b => { log += b; }); proc.stderr.on('data', b => { log += b; });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } }, 'server unavailable');
  token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(await (await fetch(`http://127.0.0.1:${port}/`)).text())[1];
}
async function stop() { if (proc && proc.exitCode == null) { const p = proc; await new Promise(r => { p.once('exit', r); p.kill(); }); } proc = null; }
async function request(route, body) {
  return fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function api(route, body) { const r = await request(route, body); const value = await r.json(); assert(r.ok, route + ': ' + JSON.stringify(value)); return value; }
async function chat(id, text) { const r = await request('/api/chat', { id, text }); assert(r.ok, 'chat rejected'); return r.text(); }
function respond(res, message) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: message, finish_reason: null }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
}
(async () => {
  try {
    fs.mkdirSync(app);
    for (const dir of ['core', 'ui', 'contest_packages']) fs.cpSync(path.join(__dirname, '..', dir), path.join(app, dir), { recursive: true });
    fs.cpSync(path.join(__dirname, '..', 'skills', 'contest-modeling-generic'), path.join(app, 'skills', 'contest-modeling-generic'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(app, 'package.json'));
    fs.mkdirSync(path.join(app, 'config'));
    provider = http.createServer(async (req, res) => {
      let raw = ''; for await (const part of req) raw += part;
      const body = JSON.parse(raw); calls++;
      const latest = [...body.messages].reverse().find(m => m.role === 'user' && /HOLD_MAIN|MAKE_CARD|MAKE_BACKGROUND|局部请求|继续主线/.test(typeof m.content === 'string' ? m.content : ''))?.content || '';
      if (latest === 'HOLD_MAIN') { held = true; return; }
      if (latest === 'MAKE_CARD') return respond(res, { role: 'assistant', tool_calls: [{ id: 'main-card-tool', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '主线选哪个？', candidates: ['A', 'B', 'C'].map(id => ({ id, label: id, basis: '不同主路线 ' + id, risk: '需验证' })), recommended_id: 'A', recommendation_reason: '按题目约束推荐A' }) } }] });
      if (latest === 'MAKE_BACKGROUND') {
        const started = body.messages.find(m => m.role === 'tool' && m.tool_call_id === 'main-background');
        if (!started) return respond(res, { role: 'assistant', tool_calls: [{ id: 'main-background', type: 'function', function: { name: 'job_start', arguments: JSON.stringify({ command: 'python scripts/background.py', label: '主线后台' }) } }] });
        backgroundId = /job_id:\s*(job_\w+)/.exec(started.content)?.[1];
        return respond(res, { role: 'assistant', tool_calls: [{ id: 'wait-background', type: 'function', function: { name: 'job_wait', arguments: JSON.stringify({ ids: [backgroundId] }) } }] });
      }
      respond(res, { role: 'assistant', content: /局部请求/.test(latest) ? '局部任务完成。' : '主线已继续。' });
    });
    await new Promise(r => provider.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(app, 'config', 'settings.json'), JSON.stringify({ default_model: 'focus-test:fake', custom_providers: [{ id: 'focus-test', base: `http://127.0.0.1:${provider.address().port}/v1`, kind: 'openai', models: ['fake'] }], daily_budget: 0, kb_roots: [] }));
    fs.writeFileSync(path.join(app, 'config', 'custom_focus-test.key'), 'offline-placeholder');
    port = await freePort(); await start();
    const s = await api('/api/session/new', { mode: 'free', title: 'local focus test' });
    const original = await api('/api/session/open', { id: s.id });
    const main = chat(s.id, 'HOLD_MAIN');
    main.catch(() => {}); // cleanup on an assertion failure may close the held SSE socket
    await until(() => held, 'main request never reached provider');
    const focus = await api('/api/session/focus', { id: s.id, action: 'local' });
    await main;
    assert.equal(focus.session.task_focus.kind, 'local');
    assert.equal(focus.session.status, 'idle', 'must wait until the old model request actually stops');
    const local = await chat(s.id, '局部请求：只回答这个小问题');
    assert.match(local, /局部任务完成/);
    assert.doesNotMatch(local, /自动续推/);
    const beforeRestart = calls;
    await stop(); await start();
    const restored = await api('/api/session/open', { id: s.id });
    assert.equal(restored.task_focus.kind, 'local', 'local checkpoint must survive server restart');
    assert.equal(calls, beforeRestart, 'restart must not silently resume the main model');
    const returned = await api('/api/session/focus', { id: s.id, action: 'main' });
    assert.equal(returned.session.task_focus, null);
    assert.equal(returned.session.effort, original.effort);
    assert.equal(returned.resume.action, 'continue');
    assert.match(await chat(s.id, returned.resume.text), /主线已继续/);

    const cardSession = await api('/api/session/new', { mode: 'free', title: 'preserve main card' });
    await chat(cardSession.id, 'MAKE_CARD');
    const card = (await api('/api/session/open', { id: cardSession.id })).pendingQuestion;
    assert(card?.decision_id);
    const parked = await api('/api/session/focus', { id: cardSession.id, action: 'local' });
    assert.equal(parked.session.pendingQuestion, null);
    await chat(cardSession.id, '局部请求：解释一个词');
    const unparked = await api('/api/session/focus', { id: cardSession.id, action: 'main' });
    assert.equal(unparked.session.pendingQuestion.decision_id, card.decision_id);
    assert.equal(unparked.resume.action, 'decision');
    assert(!unparked.session.decisions.some(d => d.decision_id === card.decision_id), 'small task must not accept the main card');

    const background = await api('/api/session/new', { mode: 'free', title: 'preserve background work' });
    const ws = path.join(tmp, 'workspace', 'projects', background.project_id);
    fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'scripts', 'background.py'), 'import time\ntime.sleep(30)\nprint("background done")\n');
    assert.match(await chat(background.id, 'MAKE_BACKGROUND'), /waiting_jobs/);
    const mainWait = (await api('/api/session/open', { id: background.id })).job_wait;
    await api('/api/session/focus', { id: background.id, action: 'local' });
    await api('/api/stop', { id: background.id });
    const activeJobs = await api('/api/jobs?session_id=' + background.id);
    assert(activeJobs.jobs.some(j => j.id === backgroundId && ['queued', 'starting', 'running'].includes(j.status)), 'stopping local work must not cancel parked main jobs');
    assert.equal((await api('/api/session/open', { id: background.id })).task_focus.main_job_wait.id, mainWait.id);
    await api('/api/jobs/cancel', { id: backgroundId, session_id: background.id, project_id: background.project_id });
    await until(async () => { const jobs = (await api('/api/jobs?session_id=' + background.id)).jobs; return jobs.every(j => !['queued', 'starting', 'running', 'cancelling'].includes(j.status)); }, 'test background runner did not stop');
    const savedWait = await api('/api/session/focus', { id: background.id, action: 'main' });
    assert.equal(savedWait.session.job_wait.id, mainWait.id);
    assert.equal(savedWait.resume.action, 'jobs');
    console.log('task focus API: running pause, restart, original card and background wait/stop protection passed');
  } finally {
    await stop();
    if (provider) { provider.closeAllConnections(); await new Promise(r => provider.close(r)); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
