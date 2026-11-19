'use strict';
// HTTP integration in a disposable application copy. Never opens the real user sessions.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const repo = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-template-api-'));
const app = path.join(root, 'app');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, log = '';
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function stop() {
  if (server && server.exitCode == null) {
    server.kill();
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(4000)]);
  }
  assert.equal(path.dirname(root), os.tmpdir(), 'cleanup target must be the direct test directory');
  fs.rmSync(root, { recursive: true, force: true });
}
(async () => {
  fs.mkdirSync(app);
  for (const name of ['core', 'ui', 'contest_packages', 'plugins', 'template_library', 'skills']) {
    fs.cpSync(path.join(repo, name), path.join(app, name), { recursive: true });
  }
  fs.mkdirSync(path.join(app, 'config'));
  const port = await freePort();
  const account = path.join(root, 'account'); fs.mkdirSync(account);
  server = spawn(process.execPath, ['core/server.js'], { cwd: app, windowsHide: true,
    env: { ...process.env, XIHE_PORT: String(port), USERPROFILE: account, HOME: account }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
    if (!ready) await pause(100);
  }
  assert(ready, `isolated server did not start: ${log.slice(-800)}`);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(html)?.[1];
  assert(token);
  const base = `http://127.0.0.1:${port}`;
  async function request(route, body, expected = 200, auth = true) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers:
      { 'Content-Type': 'application/json', ...(auth ? { 'X-Xihe-Token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = { message: text }; }
    assert.equal(response.status, expected, `${route}: ${JSON.stringify(value).slice(0, 700)}`);
    return value;
  }
  const catalog = await request('/api/template-library');
  const ids = catalog.templates.map(row => row.id);
  for (const id of ['generic', 'cumcm', 'simulation', 'apmcm', 'mcm-icm', 'mathorcup-bigdata']) assert(ids.includes(id), id);
  assert(catalog.templates.find(row => row.id === 'apmcm').available);
  const boot = await request('/api/bootstrap');
  assert(boot.template_library.some(row => row.id === 'apmcm'));
  await request('/api/template-library', undefined, 403, false);
  await request('/api/project/new', { id: 'template-test', title: 'Template integration' });
  const initial = await request('/api/project/plan?project_id=template-test');
  assert.equal(initial.revision, 0);
  const draft = structuredClone(initial.plan);
  draft.task_context = { problem_types: ['kinematics'], stages: ['solving'], data: null, constraints: {} };
  draft.skills.research = { mode: 'append', primary: 'pde-award-solve', fallbacks: [] };
  await request('/api/project/plan/assess', { project_id: 'template-test', plan: draft }, 403, false);
  const assessment = await request('/api/project/plan/assess', { project_id: 'template-test', plan: draft });
  assert.equal(assessment.effective.entries[1].installation.status, 'installable');
  assert.equal(assessment.effective.entries[1].applicability.status, 'incompatible');
  assert.equal(assessment.effective.entries[1].blocked, true);
  assert.equal(assessment.effective.assessment.gain.status, 'unverified');
  assert.equal((await request('/api/project/plan?project_id=template-test')).revision, 0, 'assessment must not save');
  const badContext = structuredClone(draft); badContext.task_context.data = 'unknown';
  await request('/api/project/plan/assess', { project_id: 'template-test', plan: badContext }, 400);
  const body = { project_id: 'template-test', template_id: 'apmcm', plan: initial.plan };
  await request('/api/project/plan/template', body, 403, false);
  const preview = await request('/api/project/plan/template', body);
  assert.equal(preview.plan.contest.contest_kind, 'apmcm');
  assert.equal((await request('/api/project/plan?project_id=template-test')).revision, 0, 'preview must not save');
  const saved = await request('/api/project/plan', { project_id: 'template-test', plan: preview.plan });
  assert.equal(saved.revision, 1);
  assert.equal(saved.effective.entries[0].name, 'contest-modeling-apmcm');
  const session = await request('/api/session/new', { mode: 'math', project_id: 'template-test' });
  assert.equal(session.contest_kind, 'apmcm');
  assert.equal(session.skill_plan_snapshot.entries[0].name, 'contest-modeling-apmcm');
  assert.equal(session.skill_plan_snapshot.assessment.gain.status, 'unverified');
  const sim = await request('/api/project/plan/template', { project_id: 'template-test', template_id: 'simulation', plan: saved.plan });
  assert.deepEqual(sim.plan.contest, saved.plan.contest, 'simulation must preserve APMCM identity/rules');
  assert.equal(sim.plan.skills.research.primary, 'pde-award-solve');
  await request('/api/project/plan/template', { project_id: 'template-test', template_id: '../bad', plan: saved.plan }, 400);
  await request('/api/project/plan/template', { project_id: 'template-test', template_id: 'apmcm', plan: { schema_version: 99 } }, 400);
  assert.equal((await request('/api/project/plan?project_id=template-test')).revision, 1, 'invalid previews must not save');
  console.log('PASS template library API: discovery, auth, preview, save, APMCM session, simulation isolation, rejection');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
