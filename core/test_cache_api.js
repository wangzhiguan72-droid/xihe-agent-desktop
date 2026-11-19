'use strict';
// Real local HTTP API and isolation check. The copied app has no user keys,
// sessions, or settings, and this test never starts a model request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { beginTrace } = require('./cache_diagnostics');
const { record } = require('./meter');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-cache-api-'));
const app = path.join(temp, 'app');
const secret = 'PRIVATE-SYNTHETIC-PROMPT-AND-KEY';
let server;
let serverOutput = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function call(port, token, route, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body == null ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  let parsed;
  try { parsed = await response.json(); } catch { parsed = await response.text(); }
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(parsed).slice(0, 350)}`);
  return parsed;
}
async function start(port) {
  server = spawn(process.execPath, ['core/server.js'], {
    cwd: app, windowsHide: true, env: { ...process.env, XIHE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  server.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  let up = false;
  for (let i = 0; i < 200; i++) {
    if (server.exitCode != null) break;
    try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
    if (up) break;
    await pause(100);
  }
  assert(up, 'isolated server failed: ' + serverOutput.slice(-350));
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(html)?.[1];
  assert(token, 'isolated server did not issue a token');
  return token;
}
function syntheticTrace(sessionId, input, cached) {
  const body = { model: 'gpt-test', messages: [{ role: 'system', content: secret }, { role: 'user', content: 'synthetic check' }] };
  const trace = beginTrace({ appDir: app, session_id: sessionId, project_id: 'test', lane: 'main', provider_key: 'offline' },
    { protocol: 'openai', url: 'https://offline.invalid/v1/chat/completions?key=' + secret, body, serializedBody: JSON.stringify(body) });
  assert(trace, 'synthetic trace created');
  const raw = { prompt_tokens: input, completion_tokens: 1 };
  if (cached !== undefined) raw.prompt_tokens_details = { cached_tokens: cached };
  trace.response(200, new Headers({ 'x-request-id': secret }));
  trace.observeUsage(raw);
  trace.finish({ prompt_tokens: input, completion_tokens: 1, cache_hit_tokens: cached || 0 }, null, 'gpt-test');
}

(async () => {
  try {
    fs.mkdirSync(app);
    const source = path.resolve(__dirname, '..');
    for (const dir of ['core', 'ui', 'templates', 'contest_packages'])
      fs.cpSync(path.join(source, dir), path.join(app, dir), { recursive: true });
    fs.copyFileSync(path.join(source, 'package.json'), path.join(app, 'package.json'));
    const port = await freePort(), token = await start(port);
    const a = await call(port, token, '/api/session/new', { mode: 'free', title: 'Cache A' });
    const b = await call(port, token, '/api/session/new', { mode: 'free', title: 'Cache B' });
    assert(a.id && b.id && a.id !== b.id);
    const route = id => '/api/session/cache-diagnostics?session_id=' + encodeURIComponent(id);
    const none = await call(port, token, route(a.id));
    assert.equal(none.available, false);
    assert.equal(none.requests, 0);
    assert.deepEqual(none.historical_models, []);

    syntheticTrace(a.id, 100, 40);
    syntheticTrace(a.id, 200, undefined); // genuinely missing cache field
    syntheticTrace(a.id, 50, 0);         // explicitly reported zero
    syntheticTrace(b.id, 300, 250);
    record(app, { t: Date.now(), session_id: a.id, project_id: 'test', model: 'gpt-test', kind: 'main', prompt_tokens: 100, completion_tokens: 1, cache_hit_tokens: 40 });
    record(app, { t: Date.now(), session_id: a.id, project_id: 'test', model: 'gpt-test', kind: 'main', prompt_tokens: 200, completion_tokens: 1, cache_hit_tokens: 0 });
    record(app, { t: Date.now(), session_id: b.id, project_id: 'test', model: 'glm-test', kind: 'vision', prompt_tokens: 300, completion_tokens: 1, cache_hit_tokens: 250 });

    const reportA = await call(port, token, route(a.id));
    assert.equal(reportA.session_id, a.id);
    assert.equal(reportA.available, true);
    assert.equal(reportA.requests, 3, 'another session must not enter diagnostics');
    assert.equal(reportA.cache_reported, 2);
    assert.equal(reportA.cache_missing, 1);
    assert.equal(reportA.unknown_count, 1);
    assert.equal(reportA.known_input_tokens, 150, 'missing cache data is excluded from known rate');
    assert.equal(reportA.known_cached_tokens, 40);
    assert.equal(reportA.known_rate, 26.67);
    assert.deepEqual({ met: reportA.cache_target.met, below: reportA.cache_target.below,
      unverified: reportA.cache_target.unverified, status: reportA.cache_target.status },
    { met: 0, below: 2, unverified: 1, status: 'below' });
    assert.deepEqual(new Set(reportA.records.map(row => row.usage.raw_cache.state)), new Set(['missing', 'reported', 'zero']));
    assert(reportA.records.every(row => row.session_id === a.id));
    assert.deepEqual(reportA.historical_models.map(row => row.model), ['gpt-test']);
    assert.equal(reportA.historical_models[0].calls, 2);
    assert.equal(reportA.historical_models[0].input_tokens, 300);
    assert.equal(reportA.historical_models[0].rate, 100 * 40 / 300);

    const reportB = await call(port, token, route(b.id));
    assert.equal(reportB.requests, 1);
    assert.equal(reportB.known_rate, 83.33);
    assert.equal(reportB.cache_target.status, 'below');
    assert(reportB.records.every(row => row.session_id === b.id));
    assert.deepEqual(reportB.historical_models.map(row => row.model), ['glm-test']);

    const noToken = await fetch(`http://127.0.0.1:${port}${route(a.id)}`);
    assert.equal(noToken.status, 403);
    assert.equal(await noToken.text(), 'invalid token');
    const traversal = await call(port, token, route('../config/settings'), null, 404);
    assert.match(traversal.error, /会话不存在/);
    const unknown = await call(port, token, route('does_not_exist'), null, 404);
    assert.match(unknown.error, /会话不存在/);

    const logDir = path.join(app, 'data', 'cache-diagnostics');
    const logs = fs.readdirSync(logDir).filter(file => file.endsWith('.jsonl'))
      .map(file => fs.readFileSync(path.join(logDir, file), 'utf8')).join('');
    assert(!logs.includes(secret), 'neither prompt nor URL query nor header value may be persisted');
    assert(!logs.includes('offline.invalid'), 'the endpoint must be fingerprinted');
    console.log('cache API: isolated HTTP, session auth/scope, historical models, missing-vs-zero and private trace PASS');
  } finally {
    if (server && server.exitCode == null && !server.killed) {
      await new Promise(resolve => { server.once('exit', resolve); server.kill(); setTimeout(resolve, 5000); });
      if (server.exitCode == null) server.kill('SIGKILL');
    }
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'test cleanup target must be inside OS temp');
    assert(path.basename(resolved).startsWith('xihe-cache-api-'), 'test cleanup target must be owned by this test');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
