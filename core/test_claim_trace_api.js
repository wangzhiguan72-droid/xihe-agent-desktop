'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-claim-trace-api-'));
let server, output = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

(async () => {
  const app = path.join(temp, 'app'); fs.mkdirSync(app);
  const repo = path.resolve(__dirname, '..');
  for (const name of ['core', 'ui', 'contest_packages']) fs.cpSync(path.join(repo, name), path.join(app, name), { recursive: true });
  const port = await freePort();
  server = spawn(process.execPath, ['core/server.js'], { cwd: app, windowsHide: true,
    env: { ...process.env, XIHE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  let healthy = false;
  for (let i = 0; i < 150 && !healthy; i++) {
    try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
    if (!healthy) await wait(100);
  }
  assert(healthy, output);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(html)?.[1]; assert(token);
  async function api(route, body, status = 200) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, route + ': ' + JSON.stringify(value));
    return value;
  }
  for (const id of ['trace_a', 'trace_b']) await api('/api/project/new', { id, title: id });
  const first = await api('/api/session/new', { mode: 'math', project_id: 'trace_a', title: '早期会话' });
  const second = await api('/api/session/new', { mode: 'math', project_id: 'trace_a', title: '当前会话' });
  const other = await api('/api/session/new', { mode: 'math', project_id: 'trace_b', title: '其他项目' });
  const route = sid => '/api/project/trace?project_id=trace_a&session_id=' + encodeURIComponent(sid);
  const old = await api(route(first.id));
  const current = await api(route(second.id));
  assert.equal(old.session_id, first.id); assert.equal(current.session_id, second.id);
  assert.equal(old.project_id, 'trace_a'); assert.equal(old.trace.status, 'unregistered');
  assert.deepEqual(old.trace.claims, []);
  assert.equal(old.project_dir, path.join(temp, 'workspace', 'projects', 'trace_a'));
  await api(route(other.id), undefined, 403);
  await api(route('no-such-session'), undefined, 404);
  await api('/api/project/trace?project_id=trace_a', undefined, 400);
  await api('/api/project/trace?project_id=missing&session_id=' + first.id, undefined, 404);
  const unauthorized = await fetch(`http://127.0.0.1:${port}${route(first.id)}`);
  assert.equal(unauthorized.status, 403);
  console.log('PASS claim trace API: selected historical session, legacy status, membership, missing session, token');
})().catch(e => { console.error(e); console.error(output.slice(-1500)); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode == null) {
    server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(4000)]);
  }
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
});
