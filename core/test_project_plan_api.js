'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-plan-api-'));
let server, output = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
function put(app, name, body) {
  const dir = path.join(app, 'skills', name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0"\ndescription: test\n---\n${body}`);
}
(async () => {
  const app = path.join(temp, 'app'); fs.mkdirSync(app);
  const repo = path.resolve(__dirname, '..');
  for (const name of ['core', 'ui', 'contest_packages', 'plugins']) fs.cpSync(path.join(repo, name), path.join(app, name), { recursive: true });
  fs.cpSync(path.join(repo, 'skills', 'xihe-evidence-figures'), path.join(app, 'skills', 'xihe-evidence-figures'), { recursive: true });
  put(app, 'contest-modeling-generic', 'PORTABLE_MAIN'); put(app, 'api-method', 'API_METHOD_V1');
  const account = path.join(temp, 'ordinary-account'); fs.mkdirSync(account);
  const port = await freePort();
  server = spawn(process.execPath, ['core/server.js'], { cwd: app, windowsHide: true,
    env: { ...process.env, XIHE_PORT: String(port), USERPROFILE: account, HOME: account }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { output += data; }); server.stderr.on('data', data => { output += data; });
  let healthy = false;
  for (let i = 0; i < 150 && !healthy; i++) {
    try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
    if (!healthy) await wait(100);
  }
  assert(healthy, output);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(html)?.[1]; assert(token);
  async function api(route, body, status = 200) {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await r.json(); assert.equal(r.status, status, route + ': ' + JSON.stringify(value)); return value;
  }
  const noToken = await fetch(`http://127.0.0.1:${port}/api/project/plan?project_id=a`); assert.equal(noToken.status, 403);
  for (const id of ['a', 'b']) await api('/api/project/new', { id, title: id });
  const initial = await api('/api/project/plan?project_id=a'); assert.equal(initial.revision, 0);
  assert.equal(initial.plan.evidence.claim_trace, 'optional');
  assert(initial.available_plugins.some(row => row.id === 'evidence-figures' && row.status === 'loaded'));
  initial.plan.skills.research = { mode: 'replace', primary: 'missing-method', fallbacks: ['api-method'] };
  initial.plan.evidence.claim_trace = 'required';
  initial.plan.plugins = [{ id: 'evidence-figures', enabled: true }];
  const saved = await api('/api/project/plan', { project_id: 'a', plan: initial.plan });
  assert.equal(saved.revision, 1); assert.equal(saved.effective.entries[1].name, 'api-method');
  const selectedPlugin = saved.effective.plugins.find(row => row.id === 'evidence-figures');
  assert.equal(selectedPlugin.status, 'loaded'); assert(selectedPlugin.version && selectedPlugin.sha256);
  assert(saved.effective.entries[1].fallbacks.length);
  const old = await api('/api/session/new', { mode: 'math', project_id: 'a' });
  assert.equal(old.claim_trace_required, true);
  assert.equal(old.skill_plan_snapshot.revision, 1);
  assert.equal(old.skill_plan_snapshot.entries[1].name, 'api-method');
  assert.equal(old.skill_plan_snapshot.plugins[0].sha256, selectedPlugin.sha256);
  const pack = await api('/api/project/plan/export?project_id=a');
  assert(!JSON.stringify(pack).includes(temp));
  assert.equal(pack.plan.plugins[0].enabled, true);
  await api('/api/project/new', { id: 'local-plugin', title: 'Local plugin regression' });
  const localBundle = structuredClone(pack.plugins[0]); localBundle.manifest.id = 'local-only';
  const ordered = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
  localBundle.sha256 = require('crypto').createHash('sha256').update(JSON.stringify(ordered(localBundle.manifest)) + '\n' + JSON.stringify(localBundle.files.map(f => [f.path, f.sha256]))).digest('hex');
  require('./plugins').materialize(path.join(temp, 'workspace/projects/local-plugin'), [localBundle]);
  const localState = await api('/api/project/plan?project_id=local-plugin');
  assert(localState.available_plugins.some(row => row.id === 'local-only' && row.status === 'loaded'));
  localState.plan.plugins = [{ id: 'local-only', enabled: true }];
  assert.equal((await api('/api/project/plan', { project_id: 'local-plugin', plan: localState.plan })).effective.plugins[0].status, 'loaded');
  assert.equal((await api('/api/session/new', { project_id: 'local-plugin', mode: 'math' })).skill_plan_snapshot.plugins[0].status, 'loaded');
  assert((await api('/api/project/plan/export?project_id=local-plugin')).plugins.some(p => p.manifest.id === 'local-only'));
  put(app, 'api-method', 'LOCAL_METHOD_V99');
  await api('/api/project/plan/import', { project_id: 'b', package: pack });
  const imported = await api('/api/session/new', { mode: 'math', project_id: 'b' });
  assert.equal(pack.plan.evidence.claim_trace, 'required');
  assert.equal(imported.skill_plan_snapshot.plan.evidence.claim_trace, 'required');
  assert.equal(imported.claim_trace_required, true);
  const sessionFile = id => path.join(app, 'data/sessions', id + '.json');
  const readSession = id => JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
  assert(readSession(imported.id).system.includes('API_METHOD_V1'));
  assert(!readSession(imported.id).system.includes('LOCAL_METHOD_V99'));
  assert.equal(imported.skill_plan_snapshot.entries[1].sha256, old.skill_plan_snapshot.entries[1].sha256);
  assert.equal(imported.skill_plan_snapshot.plugins[0].sha256, selectedPlugin.sha256);
  const bPlan = (await api('/api/project/plan?project_id=b')).plan;
  bPlan.plugins[0].enabled = false;
  assert.equal((await api('/api/project/plan', { project_id: 'b', plan: bPlan })).effective.plugins[0].status, 'off');
  bPlan.plugins[0].enabled = true;
  const reenabled = await api('/api/project/plan', { project_id: 'b', plan: bPlan });
  assert.equal(reenabled.effective.plugins[0].status, 'loaded', 'a changed selection unlocks only that plugin');
  assert.equal(reenabled.effective.plugins[0].sha256, selectedPlugin.sha256);
  const rootBefore = readSession(old.id).skill_plan_snapshot.root;
  const { stampInputFiles } = require('./agent');
  const projectRoot = path.join(temp, 'workspace/projects/a');
  fs.writeFileSync(path.join(projectRoot, 'orders.csv'), 'x,y\n1,2\n');
  const numericalInputs = stampInputFiles(projectRoot);
  saved.plan.skills.research = { mode: 'off', primary: null, fallbacks: [] };
  saved.plan.evidence.claim_trace = 'optional';
  saved.plan.plugins = [{ id: 'evidence-figures', enabled: false }];
  const updated = await api('/api/project/plan', { project_id: 'a', plan: saved.plan }); assert.equal(updated.revision, 2);
  assert.equal(readSession(old.id).skill_plan_snapshot.root, rootBefore);
  const fresh = await api('/api/session/new', { mode: 'math', project_id: 'a' }); assert.equal(fresh.skill_plan_snapshot.entries[1].status, 'off');
  assert.equal(fresh.skill_plan_snapshot.plugins[0].status, 'off');
  assert.equal(readSession(old.id).skill_plan_snapshot.plugins[0].status, 'loaded', 'old session plugin must remain frozen');
  assert.equal(fresh.claim_trace_required, false);
  assert.equal(readSession(old.id).claim_trace_required, true, 'old session requirement must remain frozen');
  assert.deepEqual(stampInputFiles(projectRoot), numericalInputs, 'project plan edits or new snapshots must not change numerical input identity');
  const child = await api('/api/session/new', { mode: 'math', project_id: 'a', inherit_session_id: old.id });
  assert.equal(child.claim_trace_required, true, 'inherited session keeps frozen required trace');
  assert.equal(child.skill_plan_snapshot.id, old.skill_plan_snapshot.id);
  assert.equal(child.skill_plan_snapshot.plugins[0].sha256, selectedPlugin.sha256);
  assert(readSession(child.id).system.includes('API_METHOD_V1'));
  const wrong = await fetch(`http://127.0.0.1:${port}/api/session/new`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token },
    body: JSON.stringify({ mode: 'math', project_id: 'b', inherit_session_id: old.id }) });
  assert(wrong.status >= 400, 'cannot inherit another project');
  const override = await api('/api/session/skill', { id: old.id, skill: 'api-method' });
  assert.equal(override.skill_plan_snapshot.entries[0].name, 'api-method');
  const restored = await api('/api/session/skill', { id: old.id, skill: '' });
  assert.equal(restored.skill_plan_snapshot.entries[0].name, 'contest-modeling-generic');
  const bad = structuredClone(pack); bad.skills[0].files[0].path = '../escape';
  const before = await api('/api/project/plan?project_id=b');
  await api('/api/project/plan/import', { project_id: 'b', package: bad }, 400);
  const badEvidence = structuredClone(pack); badEvidence.plan.evidence.claim_trace = 'auto';
  await api('/api/project/plan/import', { project_id: 'b', package: badEvidence }, 400);
  assert.equal((await api('/api/project/plan?project_id=b')).revision, before.revision);
  put(app, 'missing-method', 'NEW_LOCAL_PRIMARY');
  before.plan.label = 'only label changed';
  const renamed = await api('/api/project/plan', { project_id: 'b', plan: before.plan });
  assert.equal(renamed.effective.entries[1].name, 'api-method', 'renaming must not unlock an imported fallback');
  await api('/api/project/plan/roots', { project_id: 'a', roots: [path.join(app, 'skills')] });
  assert.deepEqual((await api('/api/project/plan?project_id=a')).local_skill_roots, [path.join(app, 'skills')]);
  assert(!JSON.stringify(await api('/api/project/plan/export?project_id=a')).includes(path.join(app, 'skills')));
  console.log('PASS project plan API: ordinary account, save/preview/export/import, local conflict, frozen sessions/children, override restore, auth/tamper, local roots');
})().catch(e => { console.error(e); console.error(output.slice(-1500)); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode == null) {
    server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), wait(4000)]);
  }
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); fs.rmSync(temp, { recursive: true, force: true });
});
