'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const kb = require('./kb'), builtin = require('./builtin_knowledge'), plans = require('./project_plan');
const { executeTool } = require('./tools');
const { Sandbox } = require('./sandbox');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-builtin-kb-'));
const repo = path.resolve(__dirname, '..');
function external(app, tag) {
  const dir = path.join(app, 'data', 'kb'); fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ builtAt: 1, roots: ['UNCHANGED_EXTERNAL_ROOT'],
    docs: [{ id: 'external', rel: tag + '.md', title: tag, provenance: 'user_own', chunks: 1 }] }));
  fs.writeFileSync(path.join(dir, 'chunks', 'external.jsonl'), JSON.stringify({ id: 0, text: tag + ' 外部知识', toks: [tag.toLowerCase()] }) + '\n');
  fs.utimesSync(path.join(dir, 'index.json'), new Date(1700000000000), new Date(1700000000000));
  return path.join(dir, 'index.json');
}
(async () => {
  const app = path.join(root, 'app'); fs.mkdirSync(app);
  fs.cpSync(path.join(repo, 'knowledge'), path.join(app, 'knowledge'), { recursive: true, filter: p => !p.includes(path.sep + 'apmcm') });
  assert.equal(kb.status(app).external_built, false);
  assert.equal(kb.status(app).builtin_docs, 5);
  for (const [query, id] of [['2026 A 药材 热质耦合', 'a'], ['无线电 干扰源 无信号', 'b'], ['微网 储能 信息泄漏', 'c'], ['AI Agent 人工核验', 'ai']]) {
    const found = kb.search(app, query, { limit: 10 });
    assert(found.hits.some(row => row.doc_id === 'builtin-cumcm2026-' + id), query);
    const hit = found.hits.find(row => row.doc_id === 'builtin-cumcm2026-' + id);
    assert.equal(hit.prov, 'advice'); assert(hit.source_urls.length && hit.scope.includes('摘要'));
  }
  assert(kb.listDocs(app).every(row => row.provenance !== 'exemplar'), 'distilled notes are not award papers');
  const read = kb.read(app, 'builtin-cumcm2026-b', { n: 10 });
  assert(read.blocks.some(row => row.text.includes('无信号'))); assert.equal(read.doc.source_urls.length, 3);
  const indexFile = external(app, 'PRIVATE_A'), before = fs.readFileSync(indexFile);
  assert(kb.search(app, 'private_a').hits.some(row => row.doc_id === 'external'));
  assert(kb.search(app, '药材').hits.some(row => row.doc_id.startsWith('builtin-')));
  assert.deepEqual(fs.readFileSync(indexFile), before, 'built-in retrieval must not rebuild external index');
  assert.equal(kb.status(app).docs, 6); assert.deepEqual(kb.status(app).roots, ['UNCHANGED_EXTERNAL_ROOT']);
  const app2 = path.join(root, 'app2'); external(app2, 'PRIVATE_B');
  assert(kb.search(app2, 'private_b').hits.some(row => row.source === 'PRIVATE_B.md'));
  assert(!kb.search(app2, 'private_a').hits.length, 'identical index mtime must not leak another app cache');
  assert(kb.read(app, 'external').blocks[0].text.includes('PRIVATE_A'));
  const boundedApp = path.join(root, 'bounded'); external(boundedApp, 'LONG_DOCUMENT');
  fs.writeFileSync(path.join(boundedApp, 'data/kb/chunks/external.jsonl'), Array.from({ length: 30 }, (_, id) => JSON.stringify({ id, text: 'block-' + id })).join('\n'));
  assert.equal(kb.read(boundedApp, 'external', { n: -1 }).blocks.length, 1, 'negative n must not expose almost the entire document');
  assert.equal(kb.read(boundedApp, 'external', { n: 500 }).blocks.length, 10);
  assert.equal(kb.read(boundedApp, 'external', { n: 1.5, from: 1.5 }).blocks[0].chunk_id, 1);
  const ctx = { appDir: app, session: {}, settings: {}, workspace: root, sandbox: new Sandbox(root) };
  const tool = await executeTool(ctx, 'kb_search', { query: '干扰源 无信号' });
  assert.equal(tool.ok, true); assert(tool.data.includes('阅读范围') && tool.data.includes('https://dxs.moe.gov.cn/'));
  assert((await executeTool(ctx, 'kb_read', { doc_id: 'builtin-cumcm2026-ai' })).data.includes('方法建议'));
  const bad = path.join(root, 'bad'); fs.mkdirSync(path.join(bad, 'knowledge'), { recursive: true });
  const row = { id: 'builtin-escape', title: 'escape', scope: 'test', provenance: 'advice', source_urls: [], path: '../secret.md' };
  fs.writeFileSync(path.join(bad, 'secret.md'), 'MUST_NOT_READ');
  fs.writeFileSync(path.join(bad, 'knowledge/catalog.json'), JSON.stringify({ schema_version: 1, documents: [row, { ...row, id: 'builtin-award', provenance: 'exemplar', path: 'secret.md' }] }));
  const denied = builtin.load(bad); assert.equal(denied.docs.length, 0); assert.equal(denied.issues.length, 2);
  const plan = plans.defaultPlan();
  plan.skills.research = { mode: 'append', primary: 'pde-award-solve', fallbacks: [] };
  plan.task_context = { problem_types: ['pde'], stages: ['solving'], data: null, constraints: { rtol: '1e-4', max_step: '2' } };
  const result = plans.resolvePlan({ appDir: repo, plan });
  assert.equal(result.entries[1].version, '1.1.0');
  assert.equal(result.entries[1].applicability.status, 'compatible', 'historical numerical settings must not lock future tasks');
  assert.equal(result.assessment.gain.status, 'unverified');
  plan.task_context.problem_types = ['kinematics'];
  assert.equal(plans.resolvePlan({ appDir: repo, plan }).entries[1].blocked, true, 'task applicability remains checked');
  console.log('PASS built-in distillation: no-build retrieval, source/scope, external index unchanged, cache isolation, bounded paths, tool flow, adaptive PDE parameters');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
});
