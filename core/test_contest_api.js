'use strict';
// Real HTTP smoke in an isolated copy. No user configuration, keys, or model calls.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-contest-api-'));
const app = path.join(temp, 'app');
let server;
let log = '';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function request(port, token, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(result)}`);
  return result;
}

async function requestRejected(port, token, route, body, status = 400) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Xihe-Token': token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
  assert(result.error);
}

async function startIsolatedServer(port) {
  server = spawn(process.execPath, ['core/server.js'], {
    cwd: app, windowsHide: true, env: { ...process.env, XIHE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { log += chunk.toString(); });
  server.stderr.on('data', chunk => { log += chunk.toString(); });
  let healthy = false;
  for (let i = 0; i < 200; i++) {
    if (server.exitCode != null) break;
    try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
    if (healthy) break;
    await wait(100);
  }
  assert(healthy, `isolated server failed to start: ${log.slice(-700)}`);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = /name="xihe-token"[^>]*content="([^"]+)"/.exec(html)?.[1];
  assert(token, 'server token missing');
  return token;
}

(async () => {
  try {
    fs.mkdirSync(app);
    const repo = path.resolve(__dirname, '..');
    for (const dir of ['core', 'ui', 'templates', 'contest_packages']) fs.cpSync(path.join(repo, dir), path.join(app, dir), { recursive: true });
    for (const name of ['my-mathorcup-bigdata', 'contest-modeling-generic']) {
      const skill = path.join('skills', name);
      fs.cpSync(path.join(repo, skill), path.join(app, skill), { recursive: true });
    }
    // A future competition is installed only by adding a package directory and its declared skill.
    const future = path.join(app, 'contest_packages', 'future-cup');
    fs.cpSync(path.join(app, 'contest_packages', 'generic'), future, { recursive: true });
    const manifestFile = path.join(future, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    Object.assign(manifest, { id: 'future-cup', label: '未来杯', identity: { competition: '未来杯', edition: '2030', stage: '初赛' }, match: { any: ['未来杯'], all: [] }, skills: { default: 'future-cup-skill', providers: {} } });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const futureRules = path.join(future, 'rules.json');
    const rules = JSON.parse(fs.readFileSync(futureRules, 'utf8'));
    rules.paper_quality_profile = 'future-cup-profile';
    fs.writeFileSync(futureRules, JSON.stringify(rules));
    const futureTex = path.join(future, 'paper', 'main.tex');
    fs.appendFileSync(futureTex, '\n% FUTURE_CUP_TEMPLATE\n');
    fs.cpSync(path.join(app, 'skills', 'contest-modeling-generic'), path.join(app, 'skills', 'future-cup-skill'), { recursive: true });
    const futureSkill = path.join(app, 'skills', 'future-cup-skill', 'SKILL.md');
    fs.writeFileSync(futureSkill, fs.readFileSync(futureSkill, 'utf8').replace(/contest-modeling-generic/g, 'future-cup-skill'));
    fs.mkdirSync(path.join(app, 'contest_packages', 'broken-cup'));
    fs.copyFileSync(path.join(repo, 'package.json'), path.join(app, 'package.json'));
    const source = path.join(temp, '2026 MathorCup 大数据竞赛初赛 B题');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'problem.txt'), '合成题目，供路由和模板冒烟测试。\n');
    const port = await freePort();
    let token = await startIsolatedServer(port);
    const boot = await request(port, token, '/api/bootstrap');
    assert(boot.contest_packages.some(pkg => pkg.id === 'future-cup' && pkg.skill === 'future-cup-skill'));
    assert(boot.contest_packages.some(pkg => pkg.id === 'generic' && pkg.skill === 'contest-modeling-generic'));
    assert(boot.contest_package_diagnostics.some(item => item.id === 'broken-cup'));

    const unknownInOldFolder = await request(port, token, '/api/contest/start', { sourceDir: source, title: '未注册赛事', effort: 'fast' });
    assert.equal(unknownInOldFolder.session.contest_kind, 'generic', '来源目录的旧赛事名不能覆盖明确的未知标题');
    assert.equal(unknownInOldFolder.session.skill_loaded?.name, 'contest-modeling-generic');
    const started = await request(port, token, '/api/contest/start', { sourceDir: source, collab_mode: 'auto', lang: 'python', effort: 'extreme' });
    assert.equal(started.session.contest_kind, 'mathorcup-bigdata');
    assert.equal(started.session.skill_loaded?.name, 'my-mathorcup-bigdata');
    assert.equal(started.session.contest_deadline, null, 'omitted deadline must not invent a competition duration');
    assert.equal(started.session.effort, 'extreme');
    const project = path.join(temp, 'workspace', 'projects', started.project_id);
    const paper = path.join(project, 'paper');
    const tex = fs.readFileSync(path.join(paper, 'main.tex'), 'utf8');
    assert.match(tex, /\\tableofcontents/);
    assert.match(tex, /\\pagenumbering\{arabic\}/);
    assert(!fs.existsSync(path.join(paper, 'cumcmthesis.cls')), 'mama paper must not install CUMCM class');
    assert.match(started.kickoff, /妈妈杯|MathorCup/);
    assert.doesNotMatch(started.kickoff, /基线只是前\s*19%|国赛论文模板|全程四段，\*\*基线/);
    const stored = JSON.parse(fs.readFileSync(path.join(app, 'data', 'sessions', started.session.id + '.json'), 'utf8'));
    assert.equal(stored.contest_deadline, undefined);
    assert.match(stored.system, /my-mathorcup-bigdata/);

    const metaFile = path.join(project, 'project.json');
    const startedProfile = JSON.parse(fs.readFileSync(metaFile, 'utf8')).contest_profile;
    assert.equal(startedProfile.contest_kind, 'mathorcup-bigdata', 'opening a contest must save its project profile');
    assert(startedProfile.revision >= 1);
    const review = await request(port, token, '/api/session/new', {
      mode: 'math', project_id: started.project_id, task_scope: 'review',
    });
    assert.equal(review.contest_kind, 'mathorcup-bigdata', 'untitled review must inherit project contest');
    assert.equal(review.task_scope, 'review');
    assert.equal(review.project_contest_revision, startedProfile.revision);
    assert.equal(review.contest, false, 'a review must not inherit contest auto-run state');
    assert.equal(review.effort, 'fast', 'a fresh session must choose its own effort');
    assert.deepEqual(review.decisions, []);
    assert.deepEqual(review.runs, []);
    assert.equal(review.contest_deadline, null);
    const reviewBefore = JSON.parse(fs.readFileSync(path.join(app, 'data', 'sessions', review.id + '.json'), 'utf8'));
    assert.match(reviewBefore.system, /my-mathorcup-bigdata/);

    const deadline = new Date(Date.now() + 24 * 3600_000).toISOString();
    const rules2026 = {
      source: '当届官方格式 PDF 第 2 页和 AI 规则第 3 条', profile: 'mathorcup-bigdata-2026-preliminary',
      max_body_pages: 30, appendix_code_required: true, ai_statement_in_body: true,
      ai_statement_position: 'after_references',
    };
    const configured = await request(port, token, '/api/project/contest', {
      project_id: started.project_id, contest_kind: 'mathorcup-bigdata', edition: '2026',
      stage: 'preliminary', track: 'B', contest_rules: rules2026, deadline,
    });
    assert.equal(configured.contest_profile.contest_kind, 'mathorcup-bigdata');
    assert(configured.contest_profile.revision > startedProfile.revision);
    await requestRejected(port, token, '/api/project/contest', {
      project_id: started.project_id, contest_kind: 'mathorcup-bigdata', edition: '2026',
      stage: 'preliminary', track: 'B', contest_rules: { ...rules2026, max_body_pages: 999 },
    });
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).contest_profile.revision,
      configured.contest_profile.revision, 'rejected rules must leave the project profile untouched');
    await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
    token = await startIsolatedServer(port);
    const projectList = await request(port, token, '/api/project/list');
    assert.equal(projectList.projects.find(p => p.id === started.project_id).contest_profile.revision,
      configured.contest_profile.revision, 'project list must expose current profile');
    const delivery = await request(port, token, '/api/session/new', {
      mode: 'math', project_id: started.project_id, task_scope: 'delivery',
    });
    assert.equal(delivery.contest_kind, 'mathorcup-bigdata');
    assert.equal(delivery.task_scope, 'delivery');
    assert.equal(delivery.contest_identity.edition, '2026');
    assert.equal(delivery.contest_identity.stage, 'preliminary');
    assert.equal(delivery.contest_identity.track, 'B');
    assert.deepEqual(delivery.contest_rules, rules2026);
    assert.equal(delivery.contest_deadline, Date.parse(deadline));
    assert.equal(delivery.project_contest_revision, configured.contest_profile.revision);
    assert.equal(delivery.contest, false);
    assert.equal(delivery.paper_audit ?? null, null);
    assert.equal(delivery.independent_verification ?? null, null);
    const reviewAfter = JSON.parse(fs.readFileSync(path.join(app, 'data', 'sessions', review.id + '.json'), 'utf8'));
    assert.deepEqual(reviewAfter.contest_rules, reviewBefore.contest_rules, 'old review keeps original rules');
    assert.equal(reviewAfter.project_contest_revision, reviewBefore.project_contest_revision);
    assert.equal(reviewAfter.contest_deadline, reviewBefore.contest_deadline);
    const genericProfile = await request(port, token, '/api/project/contest', {
      project_id: started.project_id, contest_kind: 'generic',
    });
    assert(genericProfile.contest_profile.revision > configured.contest_profile.revision);
    const genericChat = await request(port, token, '/api/session/new', { mode: 'math', project_id: started.project_id });
    assert.equal(genericChat.contest_kind, 'generic');
    assert.deepEqual(genericChat.contest_rules, {}, 'changing contest must not retain old rules');
    assert.equal(genericChat.task_scope, 'solve');
    assert.equal(genericChat.contest_deadline, null);

    // A project without a profile keeps title matching, independent of the previous project.
    await request(port, token, '/api/project/new', { id: 'untagged', title: '未识别项目' });

    const acceptance = await request(port, token,
      `/api/project/acceptance?project_id=${encodeURIComponent(started.project_id)}&session_id=${encodeURIComponent(delivery.id)}`);
    assert.equal(acceptance.project_id, started.project_id);
    assert.equal(acceptance.session_id, delivery.id);
    assert.equal(acceptance.acceptance.scope, 'delivery');
    assert.equal(acceptance.acceptance.can_freeze, false, 'new delivery session has no audited artifacts');
    assert(acceptance.acceptance.blockers.length > 0);
    await requestRejected(port, token, '/api/project/release',
      { project_id: started.project_id, session_id: delivery.id }, 409);
    const otherProject = await fetch(`http://127.0.0.1:${port}/api/project/acceptance?project_id=untagged&session_id=${encodeURIComponent(delivery.id)}`,
      { headers: { 'X-Xihe-Token': token } });
    assert.equal(otherProject.status, 403, 'acceptance must reject a session from another project');
    assert((await otherProject.json()).error);

    const fresh = await request(port, token, '/api/session/new', { mode: 'math', project_id: 'untagged', title: '妈妈杯大数据题目讨论' });
    assert.equal(fresh.contest_kind, 'mathorcup-bigdata');
    assert.equal(fresh.skill_loaded?.name, 'my-mathorcup-bigdata');
    const plain = await request(port, token, '/api/session/new', { mode: 'math', project_id: 'untagged', title: '陌生赛题讨论' });
    assert.equal(plain.contest_kind, 'generic');
    assert.equal(plain.skill_loaded?.name, 'contest-modeling-generic');

    const unknownSource = path.join(temp, '陌生赛事试题');
    fs.mkdirSync(unknownSource);
    fs.writeFileSync(path.join(unknownSource, 'problem.txt'), '未知赛事');
    const unknown = await request(port, token, '/api/contest/start', { sourceDir: unknownSource, contest_kind: 'uninstalled-cup', paper_profile: 'cumcm-user' });
    assert.equal(unknown.session.contest_kind, 'generic');
    assert(unknown.session.contest_package_notice?.includes('uninstalled-cup'));
    assert.equal(unknown.session.skill_loaded?.name, 'contest-modeling-generic');
    assert.equal(unknown.session.paper_profile, 'generic');
    assert.equal(unknown.session.contest_deadline, null);
    assert.doesNotMatch(unknown.kickoff, /74\s*小时|19%|国赛模板|20MB/);
    const unknownSaved = JSON.parse(fs.readFileSync(path.join(app, 'data', 'sessions', unknown.session.id + '.json'), 'utf8'));
    assert.match(unknownSaved.system, /contest-modeling-generic/);

    const futureSource = path.join(temp, '2030未来杯试题');
    fs.mkdirSync(futureSource);
    fs.writeFileSync(path.join(futureSource, 'problem.txt'), '未来赛事');
    const selected = await request(port, token, '/api/contest/start', { sourceDir: futureSource, contest_kind: 'future-cup', paper_profile: 'cumcm-user' });
    assert.equal(selected.session.contest_kind, 'future-cup');
    assert.equal(selected.session.contest_identity.competition, '未来杯');
    assert.equal(selected.session.skill_loaded?.name, 'future-cup-skill');
    assert.equal(selected.session.paper_profile, 'future-cup-profile');
    assert.match(fs.readFileSync(path.join(temp, 'workspace', 'projects', selected.project_id, 'paper', 'main.tex'), 'utf8'), /FUTURE_CUP_TEMPLATE/);
    assert.match(selected.kickoff, /未来杯/);
    assert.equal(selected.session.contest_deadline, null);
    const futureChat = await request(port, token, '/api/session/new', { mode: 'math', title: '未来杯讨论' });
    assert.equal(futureChat.contest_kind, 'future-cup');
    assert.equal(futureChat.skill_loaded?.name, 'future-cup-skill');
    // A selected historical session must stay in the acceptance picker even
    // when this project has more than 80 newer sessions.
    const sessionDir = path.join(app, 'data', 'sessions');
    for (let i = 0; i < 81; i++) {
      const id = `newer_acceptance_${i}`;
      fs.writeFileSync(path.join(sessionDir, id + '.json'), JSON.stringify({
        id, title: `近期验收 ${i}`, mode: 'math', task_scope: 'review',
        project_id: started.project_id, updatedAt: Date.now() + 10_000 + i,
      }));
    }
    const historicalAcceptance = await request(port, token,
      `/api/project/acceptance?project_id=${encodeURIComponent(started.project_id)}&session_id=${encodeURIComponent(delivery.id)}`);
    assert.equal(historicalAcceptance.session_id, delivery.id);
    assert.equal(historicalAcceptance.sessions.length, 80);
    assert.equal(historicalAcceptance.sessions[0].id, delivery.id, 'historical selected session must remain selectable');
    assert.equal(historicalAcceptance.sessions.filter(row => row.id === delivery.id).length, 1);
    assert.equal(historicalAcceptance.sessions.filter(row => row.id.startsWith('newer_acceptance_')).length, 79);
    console.log('contest API: mama, unknown generic fallback and dynamically installed future package PASS');
  } finally {
    if (server && server.exitCode == null) {
      await new Promise(resolve => { server.once('exit', resolve); server.kill(); setTimeout(resolve, 5000); });
    }
    const resolved = path.resolve(temp);
    const base = path.resolve(os.tmpdir()) + path.sep;
    assert(resolved.startsWith(base) && path.basename(resolved).startsWith('xihe-contest-api-'), 'unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
