'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packages = require('./contest_packages');
const workflows = require('./contest_workflows');
const { installPaperTemplate } = require('./tools');

const pkg = packages.getPackage('apmcm');
assert(pkg, 'APMCM must appear in discovered packages');
assert.equal(packages.validatePackageDir(pkg.root).id, 'apmcm');
assert.equal(packages.detectPackage({ title: '2026 亚太杯 A 题' }).id, 'apmcm');
assert.equal(packages.detectPackage({ title: 'APMCM 2026 B' }).id, 'apmcm');
assert.equal(packages.detectPackage({ contest_kind: 'generic', title: 'APMCM' }).id, 'generic');
assert.equal(workflows.mathSkill('deepseek', { contest_kind: 'apmcm' }), 'contest-modeling-apmcm');
assert.equal(workflows.mathSkill('glm', { contest_kind: 'apmcm' }), 'contest-modeling-apmcm');
assert.match(workflows.phaseGuidance('baseline', { contest_kind: 'apmcm' }), /量纲|数据来源/);
assert.match(workflows.phaseGuidance('final', { contest_kind: 'apmcm' }), /承诺书分开/);
assert.deepEqual(workflows.supportPolicy({ contest_kind: 'apmcm' }), { max_bytes: null });
assert.equal(pkg.workflow.clock.ratios, null);
assert.equal(pkg.rules.paper_quality_profile, null);
assert.equal(pkg.rules.paper.toc_required, false);
assert.equal(pkg.rules.paper.ai_details.required, false);
assert.equal(pkg.rules.paper.body_pages, undefined);
assert.notEqual(pkg.rules.paper_quality_profile, packages.getPackage('cumcm').rules.paper_quality_profile);
assert.deepEqual(workflows.rulesBlockers({ contest_kind: 'apmcm', contest: true, title: '2026 APMCM A',
  contest_identity: { edition: '2026' }, contest_rules: { profile: 'apmcm-2026-english', source: 'Official 2026 PDF p.3-5', abstract_first_page: true } }), []);
assert(workflows.rulesBlockers({ contest_kind: 'apmcm', contest: true, title: '2025 APMCM A',
  contest_identity: { edition: '2025' }, contest_rules: { profile: 'apmcm-2026-english', source: 'Official 2026 PDF p.3-5', abstract_first_page: true } }).some(x => /年份/.test(x)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apmcm-template-'));
try {
  installPaperTemplate(root, 'main.tex', { contest_kind: 'apmcm' });
  const tex = fs.readFileSync(path.join(root, 'main.tex'), 'utf8');
  assert.match(tex, /\\section\*\{Summary Sheet\}|APMCM Summary Sheet/);
  assert.match(tex, /\\fancyhead\[L\]/);
  assert.match(tex, /\\fancyhead\[R\]/);
  assert.match(tex, /\\appendix/);
  assert.doesNotMatch(tex, /\\tableofcontents|\\section\*\{Control Sheet\}|TO_VERIFY_CONTROL/);
  assert.doesNotMatch(tex, /20,?000,?000|30 pages|74 hours|0\.95|accuracy.*%/i);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('APMCM package tests passed');
