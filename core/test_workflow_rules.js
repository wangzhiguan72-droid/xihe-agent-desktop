'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MODES, DEEP_TECHNIQUES, DEEP_APPENDIX } = require('./modes');
const { phaseBlock } = require('./spiral');

const descriptions = Object.values(MODES).map(m => m.desc).join('\n');
assert.doesNotMatch(descriptions, /快速算力|最高推理|最贵/,
  'workflow modes must not claim to select provider reasoning effort');
assert.match(MODES['collab:deep'].desc, /工作流程|多评审/);

const treeGuidance = DEEP_TECHNIQUES.find(t => t.tool === 'deep_tree').how + DEEP_APPENDIX;
assert.doesNotMatch(treeGuidance, /只(?:把|实现)\s*Top-2/,
  'candidate implementation count must depend on the question and comparison need');
assert.match(treeGuidance, /按.{0,30}(问题|证据|预算|需要)/);
assert.doesNotMatch(DEEP_TECHNIQUES.find(t => t.tool === 'deep_loop').when, /必然需要/);
const { TOOLS } = require('./tools');
assert.doesNotMatch(TOOLS.find(t => t.name === 'assumption_register').desc, /每问\s*≥\s*2/);
assert.doesNotMatch(TOOLS.find(t => t.name === 'deep_tree').desc, /只实现\s*Top-2/);

const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-workflow-rules-'));
try {
  const refDir = path.join(appDir, 'audit', 'repos', 'cumcm-step-review', 'references', '摘要写作');
  fs.mkdirSync(refDir, { recursive: true });
  fs.writeFileSync(path.join(refDir, '摘要写作方法论.md'), 'test');
  const freeze = phaseBlock({ mode: 'math', contest: true, contest_kind: 'cumcm', contest_phase: 'freeze' }, Date.now(), appDir);
  assert.match(freeze, /摘要写作方法论\.md/);
  assert.doesNotMatch(freeze, /写摘要前必读/,
    'reference index should recommend relevant reading without making one template compulsory');
  assert.match(freeze, /按需|需要时/);
} finally {
  fs.rmSync(appDir, { recursive: true, force: true });
}

console.log('workflow rules: passed');
