'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const skills = require('./skills'), plans = require('./project_plan');
const { buildSystem } = require('./agent');
const { executeTool } = require('./tools');
const { Sandbox } = require('./sandbox');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-method-integration-'));
const app = path.resolve(__dirname, '..');
(async () => {
  const plan = plans.defaultPlan();
  plan.skills.research = { mode: 'replace', primary: 'xihe-research-methods', fallbacks: [] };
  const frozen = plans.snapshot({ appDir: app, plan: plans.normalizePlan(plan), storageRoot: root, revision: 1 });
  const row = frozen.entries.find(item => item.slot === 'research');
  assert.equal(row.status, 'loaded'); assert.equal(row.version, '1.2.0');
  const pack = plans.exportPackage({ appDir: app, plan: frozen.plan, options: { projectRoot: frozen.root }, lock: plans.resolutionLock(frozen) });
  const method = pack.skills.find(item => item.name === row.name);
  assert(method);
  const expected = ['mechanism-inverse.md', 'prediction.md', 'optimization.md', 'evaluation.md', 'adaptive-routing.md', 'cumcm2026-methods.md'];
  for (const name of expected) assert(method.files.some(file => file.path === 'references/' + name));
  const target = path.join(root, 'ordinary-computer'); fs.mkdirSync(path.join(target, 'skills'), { recursive: true });
  const conflicting = path.join(target, 'skills', row.name); fs.mkdirSync(conflicting);
  fs.writeFileSync(path.join(conflicting, 'SKILL.md'), '---\nname: xihe-research-methods\nversion: "99.0"\n---\nDIFFERENT_LOCAL_METHOD');
  const imported = plans.importPackage(pack, null, path.join(root, 'new-project'));
  const replica = plans.snapshot({ appDir: target, plan: imported.plan, lock: imported.lock,
    options: { projectRoot: imported.assetRoot }, storageRoot: path.join(root, 'new-project') });
  const session = { mode: 'math', ...plans.sessionFields(replica.plan), skill_plan_snapshot: replica };
  const system = buildSystem('math', root, {}, target, 'deepseek', null, session);
  assert(!system.includes('DIFFERENT_LOCAL_METHOD'));
  assert(system.includes('xihe-research-methods') && system.includes('formula_register'));
  const ctx = { appDir: target, workspace: root, settings: {}, session, sandbox: new Sandbox(root, { readOnlyRoots: [replica.root] }) };
  for (const name of expected) {
    const response = await executeTool(ctx, 'skill_load', { name: row.name, file: name });
    assert.equal(response.ok, true); assert.equal(session.skill_reads.at(-1).sha256, row.sha256);
    assert(response.data.length > 500);
  }
  assert.equal(replica.entries[1].sha256, row.sha256);
  console.log('PASS research method Skill: registered, composed, six resource cards portable, conflicting version shadowed, frozen tool reads');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});
