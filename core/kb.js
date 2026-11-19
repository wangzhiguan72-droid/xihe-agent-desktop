// 羲和知识库（查询侧，纯 Node 零依赖）：读 data/kb/index.json + chunks/*.jsonl 做关键词检索。
// 索引由 core/kb_extract.py 离线生成（kb_build 工具经 jobs 后台跑）。
// 语料按 provenance 分级：exemplar（获奖范文）> advice（建议/方法论）> reference（资料）>
// user_own（用户自己写的，质量中等）> agent_run（纯 AI 跑稿——用作"全自动缺陷"反面教材，
// 不当正确答案模板）。检索结果按档加权并显式标注，防止模型把 AI 跑稿当权威引用。
'use strict';
const fs = require('fs');
const path = require('path');
const { tokens } = require('./memory');
const builtinKnowledge = require('./builtin_knowledge');

const APP_PATHS = require('./paths');
const KB_DIR = path.join('data', 'kb');
const PROVENANCE_RANK = { exemplar: 1.25, advice: 1.15, reference: 1.0, user_own: 0.9, agent_run: 0.55, misc: 0.8 };
const PROVENANCE_LABEL = {
  exemplar: '获奖范文', advice: '建议/方法论', reference: '资料',
  user_own: '用户本人旧作·理性参考', agent_run: '纯AI跑稿·看缺陷别看答案', misc: '其他',
};

let cache = { path: null, mtime: 0, index: null, chunks: new Map() };

// 打包模式把索引放在便携根目录的 data/kb；测试/开发仍按传入的 appDir 隔离。
function kbDir(appDir) { return process.env.XIHE_HOME ? path.join(APP_PATHS.DATA_DIR, 'kb') : path.join(appDir, KB_DIR); }
function indexPath(appDir) { return path.join(kbDir(appDir), 'index.json'); }

function loadIndex(appDir) {
  const p = indexPath(appDir);
  let st;
  try { st = fs.statSync(p); } catch { return null; }
  if (cache.index && cache.path === p && cache.mtime === st.mtimeMs) return cache.index;
  try {
    cache = { path: p, mtime: st.mtimeMs, index: JSON.parse(fs.readFileSync(p, 'utf8')), chunks: new Map() };
  } catch { return null; }
  return cache.index;
}

function loadChunks(appDir, docId) {
  if (cache.chunks.has(docId)) return cache.chunks.get(docId);
  let arr = [];
  try {
    const p = path.join(kbDir(appDir), 'chunks', docId + '.jsonl');
    arr = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  if (cache.chunks.size > 40) cache.chunks.clear(); // 粗 LRU：超出即清，按需重建
  cache.chunks.set(docId, arr);
  return arr;
}

function status(appDir) {
  const idx = loadIndex(appDir);
  const builtin = builtinKnowledge.load(appDir), docs = [...builtin.docs, ...(idx?.docs || [])];
  if (!idx && !builtin.docs.length) return { built: false, builtin_issues: builtin.issues };
  return {
    built: true, builtAt: idx?.builtAt || null, docs: docs.length, external_built: !!idx, builtin_docs: builtin.docs.length,
    chunks: docs.reduce((s, d) => s + (d.chunks || 0), 0),
    roots: idx?.roots || [], builtin_issues: builtin.issues,
    byProv: docs.reduce((m, d) => { m[d.provenance] = (m[d.provenance] || 0) + 1; return m; }, {}),
  };
}

function listDocs(appDir, opts = {}) {
  const idx = loadIndex(appDir);
  let docs = [...builtinKnowledge.load(appDir).docs, ...(idx?.docs || [])];
  if (opts.prov) docs = docs.filter(d => d.provenance === opts.prov);
  if (opts.query) {
    const q = String(opts.query).toLowerCase();
    docs = docs.filter(d => (d.rel + ' ' + (d.title || '')).toLowerCase().includes(q));
  }
  return docs.slice(0, opts.limit || 60);
}

// 打分：查询 token 命中块文本计分；命中标题/文件名加权；provenance 档位加权；
// agent_run 降权（它是反面教材不是答案）。返回按分数排序的块。
function search(appDir, query, opts = {}) {
  const idx = loadIndex(appDir);
  const builtin = builtinKnowledge.load(appDir), docs = [...builtin.docs, ...(idx?.docs || [])];
  if (!idx && !builtin.docs.length) return { error: '知识库尚未构建。用 kb_build 建索引（后台 job，几分钟级），或先在 settings.json 配 kb_roots。' };
  const q = String(query || '').trim();
  if (!q) return { error: 'query 不能为空' };
  const qToks = tokens(q);
  const limit = Math.min(Number(opts.limit) || 8, 15);
  const provFilter = opts.prov ? String(opts.prov) : null;
  const scored = [];
  for (const doc of docs) {
    if (provFilter && doc.provenance !== provFilter) continue;
    const chunks = doc.builtin ? builtin.chunks.get(doc.id) : loadChunks(appDir, doc.id);
    const titleToks = tokens(doc.rel + ' ' + (doc.title || ''));
    for (const ch of chunks) {
      let score = 0;
      const chTok = ch.toks || [];
      for (const t of qToks) {
        if (chTok.includes(t)) score += t.length >= 3 ? 3 : 2;
      }
      if (!score) continue;
      for (const t of titleToks) if (qToks.includes(t)) score += 2.5;
      score *= (PROVENANCE_RANK[doc.provenance] || 0.8);
      scored.push({ doc, ch, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // 同一文档最多取 2 块，防止一篇长文霸屏
  const perDoc = new Map();
  const out = [];
  for (const x of scored) {
    const n = perDoc.get(x.doc.id) || 0;
    if (n >= 2) continue;
    perDoc.set(x.doc.id, n + 1);
    out.push(x);
    if (out.length >= limit) break;
  }
  return {
    total: scored.length,
    hits: out.map(x => ({
      doc_id: x.doc.id, chunk_id: x.ch.id, score: +x.score.toFixed(1),
      prov: x.doc.provenance, prov_label: PROVENANCE_LABEL[x.doc.provenance] || x.doc.provenance,
      source: x.doc.rel, heading: x.ch.heading || '',
      source_urls: x.doc.source_urls || [], scope: x.doc.scope || '',
      text: x.ch.text.slice(0, 900),
    })),
  };
}

// 读某文档的若干连续块（kb_search 命中后回读上下文）
function read(appDir, docId, opts = {}) {
  const idx = loadIndex(appDir);
  const builtin = builtinKnowledge.load(appDir);
  if (!idx && !builtin.docs.length) return { error: '知识库尚未构建（先 kb_build）' };
  const doc = [...builtin.docs, ...(idx?.docs || [])].find(d => d.id === docId || d.rel === docId);
  if (!doc) return { error: `文档 ${docId} 不在索引内` };
  const chunks = doc.builtin ? builtin.chunks.get(doc.id) : loadChunks(appDir, doc.id);
  if (!chunks.length) return { error: `文档 ${docId} 无分块数据（可能索引损坏，重新 kb_build）` };
  const start = Math.max(0, Math.floor(Number(opts.from) || 0));
  const n = Math.min(10, Math.max(1, Math.floor(Number(opts.n) || 3)));
  const slice = chunks.slice(start, start + n);
  return {
    doc: { id: doc.id, rel: doc.rel, provenance: doc.provenance, prov_label: PROVENANCE_LABEL[doc.provenance], chunks: chunks.length,
      source_urls: doc.source_urls || [], scope: doc.scope || '' },
    blocks: slice.map(c => ({ chunk_id: c.id, heading: c.heading || '', text: c.text })),
  };
}

module.exports = { search, read, status, listDocs, loadIndex, PROVENANCE_LABEL };
