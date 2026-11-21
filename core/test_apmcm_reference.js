'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { query } = require('./apmcm_reference');
const { executeTool, toOpenAITools, toAnthropicTools, READ_ONLY } = require('./tools');
const app = path.resolve(__dirname, '..');
(async () => {
  const catalog = query(app);
  assert.equal(catalog.pdf_count, 16);
  assert.equal(catalog.total_pages, 657);
  assert.equal(catalog.documents.filter(row => row.possible_truncation).length, 7);
  assert.equal(query(app, { op: 'catalog', year: 2022 }).documents.length, 5);
  assert.equal(query(app, { op: 'catalog', year: 2023, problem: 'B' }).documents[0].id, '2023-B');
  const page = query(app, { op: 'read', doc_id: '2025-D', page: 1 });
  assert.equal(page.text_available, false);
  assert.deepEqual(page.pages, []);
  assert.match(query(app, { op: 'cards' }).text, /2022-A/);
  const found = query(app, { op: 'search', query: 'optimization', year: 2025, limit: 2 });
  assert.equal(found.total_hits, 0);
  assert.deepEqual(found.hits, []);
  assert.throws(() => query(app, { op: 'read', doc_id: '../config' }), /doc_id/);
  assert.throws(() => query(app, { op: 'read', doc_id: '2025-D', page: 0 }), /page/);
  assert.throws(() => query(app, { op: 'read', doc_id: '2025-D', page: 1, end_page: 10 }), /end_page/);
  assert.throws(() => query(app, { op: 'search', query: 'x', limit: 100 }), /limit/);
  const reply = await executeTool({ appDir: app, session: {}, allowTools: new Set(['apmcm_reference']) }, 'apmcm_reference', { op: 'read', doc_id: '2025-D', page: 1 });
  assert.equal(reply.ok, true);
  assert.match(JSON.stringify(reply), /用途=exemplar|用途.*exemplar/);
  assert(READ_ONLY.has('apmcm_reference') && READ_ONLY.has('academic_search'));
  assert(toOpenAITools().some(row => row.function.name === 'apmcm_reference'));
  assert(toAnthropicTools().some(row => row.name === 'academic_search'));

  // 合成夹具：随包不带逐页全文，上面的断言只覆盖缺失分支；这里用自造文本覆盖
  // 用户自行 ingest 后的全文读/搜索计分/中文别名/摘录窗口/截断分支。
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-apmcm-syn-'));
  try {
    const kdir = path.join(tmp, 'knowledge', 'apmcm');
    fs.mkdirSync(path.join(kdir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(kdir, 'catalog.json'), JSON.stringify({
      schema_version: 1, pdf_count: 2, total_pdf_pages_available: 4, archive_sha256: 'a'.repeat(64),
      papers: [
        { id: '2024-A', year: 2024, problem: 'A', pdf_pages_available: 3, possible_truncation: false, pdf_sha256: 'b'.repeat(64) },
        { id: '2024-B', year: 2024, problem: 'B', pdf_pages_available: 1, possible_truncation: true },
      ],
    }));
    fs.writeFileSync(path.join(kdir, 'pages', '2024-A.json'), JSON.stringify({
      id: '2024-A', pages: [
        { pdf_page: 1, text: 'Summary: we build an optimization model for electricity commitment and validate it with simulation.' },
        { pdf_page: 2, text: 'prefix '.repeat(60) + 'sensitivity analysis of the scheduling policy' },
        { pdf_page: 3, text: 'conclusion '.repeat(700) },
      ],
    }));
    fs.writeFileSync(path.join(kdir, 'cards.md'), '# cards\n2024-A synthetic fixture');
    const cat = query(tmp);
    assert.equal(cat.archive_sha256, 'a'.repeat(64));
    assert.equal(cat.documents.find(d => d.id === '2024-A').sha256, 'b'.repeat(64));
    assert.equal(cat.documents.find(d => d.id === '2024-B').sha256, undefined);
    const r1 = query(tmp, { op: 'read', doc_id: '2024-A', page: 1 });
    assert.equal(r1.text_available, true);
    assert.match(r1.pages[0].text, /optimization/);
    assert.equal(r1.pages[0].truncated, false);
    const r3 = query(tmp, { op: 'read', doc_id: '2024-A', page: 3 });
    assert.equal(r3.pages[0].truncated, true);
    assert.equal(r3.pages[0].text.length, 6500);
    assert.equal(query(tmp, { op: 'read', doc_id: '2024-A', page: 1, end_page: 3 }).pages.length, 3);
    assert.equal(query(tmp, { op: 'read', doc_id: '2024-B' }).text_available, false);
    const s1 = query(tmp, { op: 'search', query: 'optimization' });
    assert(s1.total_hits >= 1 && s1.hits[0].score >= 5);
    assert(s1.skipped_documents.includes('2024-B'));
    assert(query(tmp, { op: 'search', query: '仿真' }).hits.some(h => h.doc_id === '2024-A'));
    assert(query(tmp, { op: 'search', query: '调度' }).total_hits >= 1);
    const s4 = query(tmp, { op: 'search', query: 'sensitivity' });
    assert(s4.hits[0].excerpt.includes('sensitivity') && s4.hits[0].excerpt.length <= 1800);
    assert.equal(query(tmp, { op: 'search', query: 'optimization', year: 2025 }).total_hits, 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  console.log('PASS APMCM references: catalog metadata, no bundled full text, bounded read, historical material wrapper, tool authorization, synthetic full-text read/search/alias/truncation');
})().catch(error => { console.error(error); process.exitCode = 1; });
