'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPackages, getPackage, detectPackage, validatePackageDir, resourcePath } = require('./contest_packages');
const { EFFORTS } = require('./modes');

const installed = loadPackages();
assert.deepStrictEqual(installed.map(pkg => pkg.id).sort(), ['apmcm', 'cumcm', 'generic', 'mathorcup-bigdata', 'mcm-icm']);
for (const pkg of installed) {
  assert.strictEqual(pkg.root, fs.realpathSync(pkg.root));
  assert(fs.existsSync(path.join(pkg.template_dir, 'main.tex')));
}
const generic = getPackage('generic');
assert.deepStrictEqual(generic.workflow.clock.ratios, null);
assert.strictEqual(generic.rules.defaults.support_policy.max_bytes, null);
assert.strictEqual(generic.rules.paper.toc_required, false);
assert.deepStrictEqual(generic.rules.profiles, {});
assert(!JSON.stringify(generic).includes('20000000'));
assert.strictEqual(detectPackage({ contest_kind: 'generic', title: '国赛2026' }).id, 'generic');
assert.strictEqual(detectPackage({ contest_kind: 'uninstalled', title: '妈妈杯' }).id, 'generic');
assert.strictEqual(detectPackage({ title: '未知赛题', project_id: '2026-CUMCM' }).id, 'generic');
assert.strictEqual(detectPackage({ title: 'MathorCup 2026 大数据赛题' }).id, 'mathorcup-bigdata');
assert.strictEqual(detectPackage({ title: '妈妈杯普通数学竞赛' }).id, 'generic');
assert.strictEqual(detectPackage({ paper_profile: 'cumcm-user' }).id, 'cumcm');
assert.strictEqual(detectPackage({ title: '全国大学生数学建模竞赛' }).id, 'cumcm');
assert.strictEqual(detectPackage({ title: '2027 MCM/ICM Problem D' }).id, 'mcm-icm');
assert.strictEqual(detectPackage({ title: '2026 APMCM Problem A' }).id, 'apmcm');
assert.deepStrictEqual(EFFORTS, ['fast', 'deep', 'extreme']);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contest-packages-test-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contest-packages-outside-'));
function make(id, overrides = {}) {
  const dir = path.join(tmp, id);
  fs.mkdirSync(path.join(dir, 'paper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'paper', 'main.tex'), `\\documentclass{ctexart}\\begin{document}${id}\\end{document}`);
  const manifest = {
    schema_version: 1, id, label: id,
    identity: { competition: id, edition: '2030', stage: 'preliminary' },
    match: { any: [id], all: [] },
    skills: { default: `${id}-skill`, providers: {} },
    rules: 'rules.json', workflow: 'workflow.json', template: 'paper',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({
    sources: [], require_confirmation: true, required_fields: ['source', 'profile'],
    paper_quality_profile: null, defaults: { support_policy: { max_bytes: null } },
    paper: { toc_required: false, appendix_heading_titles: [], ai_details: { title: '', filename: '', draft_only: true } },
    profiles: {},
  }));
  fs.writeFileSync(path.join(dir, 'workflow.json'), JSON.stringify({
    intro: `${id} custom workflow`, phases: { baseline: 'one', iterate: 'two', freeze: 'three', final: 'four' },
    clock: { ratios: null }, reference_routes_enabled: false,
  }));
  return dir;
}
try {
  make('generic');
  const custom = make('future-contest');
  assert.strictEqual(loadPackages(tmp).length, 2);
  const selected = detectPackage({ title: 'future-contest 2030' }, tmp);
  assert.strictEqual(selected.id, 'future-contest');
  assert.strictEqual(selected.skills.default, 'future-contest-skill');
  assert.strictEqual(selected.workflow.intro, 'future-contest custom workflow');
  assert.strictEqual(fs.readFileSync(path.join(selected.template_dir, 'main.tex'), 'utf8').includes('future-contest'), true);
  const changedRules = JSON.parse(fs.readFileSync(path.join(custom, 'rules.json'), 'utf8'));
  changedRules.paper.toc_required = true;
  fs.writeFileSync(path.join(custom, 'rules.json'), JSON.stringify(changedRules));
  assert.strictEqual(getPackage('future-contest', tmp), null, '有约束却无来源的包应隔离');
  changedRules.sources = [{ id: 'test-rule', type: 'user', description: '合成赛事测试规范：要求目录' }];
  fs.writeFileSync(path.join(custom, 'rules.json'), JSON.stringify(changedRules));
  assert.strictEqual(getPackage('future-contest', tmp).rules.paper.toc_required, true);
  for (const change of [
    r => { r.defaults.support_policy = { max_bytes: 0, source: 'test' }; },
    r => { r.paper.ai_details.filename = '../outside.pdf'; },
  ]) {
    const invalid = JSON.parse(JSON.stringify(changedRules));
    change(invalid);
    fs.writeFileSync(path.join(custom, 'rules.json'), JSON.stringify(invalid));
    assert.strictEqual(getPackage('future-contest', tmp), null, '无效交付策略应隔离');
  }
  fs.writeFileSync(path.join(custom, 'rules.json'), JSON.stringify(changedRules));
  const changedWorkflow = JSON.parse(fs.readFileSync(path.join(custom, 'workflow.json'), 'utf8'));
  changedWorkflow.intro = 'changed workflow';
  fs.writeFileSync(path.join(custom, 'workflow.json'), JSON.stringify(changedWorkflow));
  assert.strictEqual(getPackage('future-contest', tmp).workflow.intro, 'changed workflow');
  fs.writeFileSync(path.join(custom, 'paper', 'main.tex'), 'changed template');
  assert.strictEqual(fs.readFileSync(path.join(getPackage('future-contest', tmp).template_dir, 'main.tex'), 'utf8'), 'changed template');
  assert.strictEqual(detectPackage({ title: 'other contest' }, tmp).id, 'generic');
  assert.throws(() => resourcePath(selected, '../generic/manifest.json'), /escapes root/);
  assert.throws(() => resourcePath(selected, path.join(outside, 'x')), /Invalid package resource path/);

  const secret = path.join(outside, 'secret.tex');
  fs.writeFileSync(secret, 'outside');
  const link = path.join(custom, 'paper', 'link.tex');
  fs.symlinkSync(secret, link, 'file');
  assert.throws(() => resourcePath(selected, 'paper/link.tex'), /symlink escapes root/);
  assert.throws(() => validatePackageDir(custom), /symlink escapes root/);
  fs.unlinkSync(link);
  const packageLink = path.join(tmp, 'linked-contest');
  fs.symlinkSync(outside, packageLink, 'junction');
  assert.strictEqual(loadPackages(tmp).length, 2);
  assert.match(loadPackages(tmp).diagnostics[0].error, /Symlinked contest package/);
  fs.unlinkSync(packageLink);

  const bad = make('malicious', { rules: '../outside.json' });
  assert.throws(() => validatePackageDir(bad), /escapes root|ENOENT/);
  assert.strictEqual(loadPackages(tmp).length, 2);
  assert(loadPackages(tmp).diagnostics.some(item => item.id === 'malicious'));
  fs.rmSync(bad, { recursive: true, force: true });
  make('bad-json');
  fs.writeFileSync(path.join(tmp, 'bad-json', 'manifest.json'), '{ "schema_version":1, "id":"bad-json", "code": function(){} }');
  assert.strictEqual(loadPackages(tmp).length, 2);
  assert(loadPackages(tmp).diagnostics.some(item => item.id === 'bad-json'));
  assert.strictEqual(detectPackage({ contest_kind: 'bad-json' }, tmp).id, 'generic');
  const genericManifest = path.join(tmp, 'generic', 'manifest.json');
  const previous = fs.readFileSync(genericManifest, 'utf8');
  fs.writeFileSync(genericManifest, '{bad json');
  assert.throws(() => loadPackages(tmp), /Generic contest package is invalid/);
  fs.writeFileSync(genericManifest, previous);
  assert.strictEqual(getPackage('generic', tmp).id, 'generic');
  assert.deepStrictEqual(EFFORTS, ['fast', 'deep', 'extreme']);
} finally {
  for (const dir of [tmp, outside]) {
    const resolved = path.resolve(dir), tempRoot = path.resolve(os.tmpdir());
    assert(path.relative(tempRoot, resolved).startsWith('contest-packages-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
console.log('contest package tests passed');
