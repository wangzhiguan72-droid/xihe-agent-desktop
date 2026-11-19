'use strict';
const assert = require('assert/strict');
const { wrapMaterial, PURPOSES, materialPolicyBlock } = require('./material_policy');
const raw = '摘要示例：输入XX，输出XX\r\n\\alpha=0.98\n不要将其当成本题答案';
for (const kind of Object.keys(PURPOSES)) {
  const rendered = wrapMaterial(raw, { kind, source: '教学资料.md' });
  assert(rendered.includes(raw), 'original material must stay intact');
  assert(rendered.includes(`用途=${kind}`));
  assert(rendered.includes(PURPOSES[kind]));
}
assert.match(wrapMaterial(raw, { kind: 'not-a-type' }), /用途=unknown/);
assert.match(wrapMaterial(raw), /用途=unknown/);
assert.match(materialPolicyBlock(), /模型自评.*不构成正确性证据/);
const { buildSystem } = require('./agent');
const fs = require('fs'), os = require('os'), path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-material-'));
try {
  const prompt = buildSystem('math', root, {}, path.resolve(__dirname, '..'), 'openai', null, {});
  assert(prompt.includes(materialPolicyBlock()), 'runtime main prompt must include material policy');
  assert.match(prompt, /参考材料开始｜用途=skill/);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('PASS material policy: content preservation, kinds, unknown and runtime prompt');

// Exercise real tool entry points with isolated local corpus, not the user's knowledge store.
(async () => {
  const { TOOLS } = require('./tools');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-material-kb-'));
  try {
    fs.mkdirSync(path.join(dir, 'data', 'kb', 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'kb', 'index.json'), JSON.stringify({ docs: [
      { id: 'guide', rel: '摘要指导.md', provenance: 'advice', chunks: 1 },
    ] }));
    fs.writeFileSync(path.join(dir, 'data', 'kb', 'chunks', 'guide.jsonl'), JSON.stringify({ id: 0, text: raw, toks: ['alpha'] }));
    const ctx = { appDir: dir, session: {} };
    const search = await TOOLS.find(t => t.name === 'kb_search').run(ctx, { query: 'alpha' });
    assert.match(search, /用途=advice/);
    const read = await TOOLS.find(t => t.name === 'kb_read').run(ctx, { doc_id: 'guide' });
    assert.match(read, /用途=advice/);
    assert(read.includes(raw));
    const skills = require('./skills').getIndex(path.resolve(__dirname, '..'));
    assert(skills.length > 0);
    const loaded = await TOOLS.find(t => t.name === 'skill_load').run({ appDir: path.resolve(__dirname, '..') }, { name: skills[0].name });
    assert.match(loaded, /用途=skill/);
    console.log('PASS material policy tool integration: kb_search, kb_read, skill_load');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
