'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const W = require('./contest_workflows');
const S = require('./spiral');
const { buildSystem } = require('./agent');
const { installPaperTemplate } = require('./tools');
const app = path.resolve(__dirname, '..');
const unknown = { mode: 'math', contest: true, contest_kind: 'generic', title: '未来挑战赛', contest_start: 0, contest_deadline: 1000, contest_phase: 'baseline' };
assert.equal(W.mathSkill('deepseek', unknown), 'contest-modeling-generic');
assert.deepEqual(W.supportPolicy(unknown), { max_bytes: null });
assert.equal(S.effectivePhase(unknown, 990), 'baseline', '未知赛事不继承国赛时间比例');
assert.doesNotMatch(S.phaseBlock(unknown, 990, app), /前 19%|74 小时|全部自编源程序|参考文献之前/);
for (const id of ['generic', 'cumcm', 'mathorcup-bigdata', 'mcm-icm']) {
  const skill = W.mathSkill('deepseek', { contest_kind: id });
  const policy = W.supportPolicy({ contest_kind: id });
  for (const effort of ['fast', 'deep', 'extreme']) {
    assert.equal(W.mathSkill('deepseek', { contest_kind: id, effort }), skill);
    assert.deepEqual(W.supportPolicy({ contest_kind: id, effort }), policy);
  }
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-contest-isolation-'));
try {
  installPaperTemplate(temp, 'main.tex', unknown);
  assert(!fs.existsSync(path.join(temp, 'cumcmthesis.cls')));
  assert.doesNotMatch(fs.readFileSync(path.join(temp, 'main.tex'), 'utf8'), /cumcmthesis|国赛|附录.*20页|20,000,000/);
  for (const effort of ['fast', 'deep', 'extreme']) {
    const system = buildSystem('math', temp, {}, app, 'deepseek', null, { ...unknown, effort });
    assert.match(system, /已加载技能 contest-modeling-generic/);
    assert.doesNotMatch(system, /已加载技能 my-cumcm|本机国赛论文质量契约/);
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('contest isolation: PASS');
