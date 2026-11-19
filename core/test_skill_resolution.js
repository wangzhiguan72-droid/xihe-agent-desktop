'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const skills = require('./skills');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-skill-roots-'));
const savedRoots = skills.ROOTS.slice();
function put(root, name, body, extra = {}) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\nversion: "1.0"\ndescription: portable test\n---\n${body}`);
  for (const [rel, value] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), value); }
  return dir;
}
try {
  assert(skills.getRoots(temp).some(row => row.dir === path.join(os.homedir(), '.agents', 'skills')));
  skills.ROOTS.splice(0);
  const app = path.join(temp, 'app'), a = path.join(temp, 'a'), b = path.join(temp, 'b');
  put(path.join(app, 'skills'), 'method', 'DEFAULT');
  put(a, 'method', 'PROJECT A', { 'references/ref.md': 'REFERENCE A', 'scripts/nested/solve.py': 'print(1)', 'assets/图.txt': 'image bytes' });
  put(b, 'method', 'PROJECT B');
  const first = skills.loadSkill(app, 'method', null, { projectRoot: a });
  assert(first.content.includes('PROJECT A')); assert.equal(first.source, 'project');
  assert(first.shadowed.some(row => row.tag === 'xihe'));
  assert(skills.loadSkill(app, 'method', null, { projectRoot: b }).content.includes('PROJECT B'));
  assert(skills.loadSkill(app, 'method', null, { projectRoot: a }).content.includes('PROJECT A'));
  assert(skills.loadSkill(app, 'method').content.includes('DEFAULT'));
  const bundle = skills.readSkillBundle(app, 'method', { projectRoot: a });
  const installed = path.join(temp, 'imported');
  skills.materializeBundles(installed, [bundle]);
  assert.equal(skills.readSkillBundle(app, 'method', { projectRoot: installed }).sha256, bundle.sha256);
  assert.equal(skills.loadSkill(app, 'method', 'ref.md', { projectRoot: installed }).content, 'REFERENCE A');
  assert.equal(fs.readFileSync(path.join(installed, 'method/scripts/nested/solve.py'), 'utf8'), 'print(1)');
  fs.appendFileSync(path.join(a, 'method/SKILL.md'), 'CHANGED');
  assert.notEqual(skills.loadSkill(app, 'method', null, { projectRoot: a }).sha256, first.sha256);
  assert.equal(skills.loadSkill(app, 'method', null, { projectRoot: installed }).sha256, bundle.sha256);
  const versionFile = path.join(a, 'method/SKILL.md');
  fs.writeFileSync(versionFile, fs.readFileSync(versionFile, 'utf8').replace('version: "1.0"', 'metadata:\n  version: "1.1.0-beta.2"'));
  assert.equal(skills.loadSkill(app, 'method', 'ref.md', { projectRoot: a }).version, '1.1.0-beta.2');
  skills.materializeBundles(installed, [bundle]);
  fs.appendFileSync(path.join(installed, 'method/SKILL.md'), 'TAMPER');
  assert.throws(() => skills.materializeBundles(installed, [bundle]), /拒绝覆盖/);
  for (const rel of ['../escape', 'C:/escape', '/escape', 'a\\escape', 'a:ads', 'CON', 'a/../escape', 'a/file.']) {
    const changed = structuredClone(bundle); changed.files[0].path = rel;
    assert.throws(() => skills.validateBundle(changed), undefined, rel);
  }
  const corrupted = structuredClone(bundle); corrupted.files[0].content = Buffer.from('changed').toString('base64');
  assert.throws(() => skills.validateBundle(corrupted), /指纹/);
  assert.throws(() => skills.loadSkill(app, 'method', '../secret', { projectRoot: a }), /越界/);
  console.log('PASS portable skills: HOME roots, project isolation, shadowing, full file fingerprints, nested roundtrip, tamper/traversal rejection');
} finally {
  skills.ROOTS.splice(0, skills.ROOTS.length, ...savedRoots);
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true });
}
