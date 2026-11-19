'use strict';
// Small curated texts only; never recursively scan or reclassify user corpora.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { tokens } = require('./memory');
const inside = (base, target) => { const rel = path.relative(base, target); return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
function checked(root, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\') || !rel.split('/').every(x => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(x) && x !== '..')) throw new Error('内置资料路径无效');
  let file = root;
  for (const part of rel.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('内置资料不能包含链接');
  }
  if (!inside(root, fs.realpathSync(file)) || !fs.statSync(file).isFile() || fs.statSync(file).size > 100000) throw new Error('内置资料越界或超过100KB');
  return file;
}
function split(text) {
  const blocks = []; let heading = '', buffer = '';
  const flush = () => { if (buffer.trim()) blocks.push({ id: blocks.length, heading, text: buffer.trim(), toks: tokens(buffer) }); buffer = ''; };
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,4} /.test(line)) { flush(); heading = line.replace(/^#+ /, ''); }
    if (buffer.length + line.length > 1400) flush();
    // Bound even a malformed single long line.
    for (let at = 0; at < Math.max(1, line.length); at += 1400) { buffer += line.slice(at, at + 1400) + '\n'; if (buffer.length >= 1400) flush(); }
  }
  flush(); return blocks;
}
function load(appDir) {
  const root = path.join(path.resolve(appDir), 'knowledge');
  if (!fs.existsSync(path.join(root, 'catalog.json'))) return { docs: [], chunks: new Map(), issues: [] };
  const docs = [], chunks = new Map(), issues = [];
  try {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('内置资料根不能是链接');
    const real = fs.realpathSync(root), catalog = JSON.parse(fs.readFileSync(checked(real, 'catalog.json'), 'utf8'));
    if (catalog.schema_version !== 1 || !Array.isArray(catalog.documents) || catalog.documents.length > 40) throw new Error('内置资料目录无效');
    const seen = new Set();
    for (const row of catalog.documents) {
      try {
        if (!row || !/^builtin-[a-z0-9-]+$/.test(row.id || '') || seen.has(row.id) || !['advice', 'reference'].includes(row.provenance)
          || typeof row.title !== 'string' || !row.title || typeof row.scope !== 'string' || !row.path?.endsWith('.md')
          || !Array.isArray(row.source_urls) || row.source_urls.length > 12 || row.source_urls.some(x => typeof x !== 'string' || !/^https:\/\//.test(x))) throw new Error('内置条目字段或来源无效');
        seen.add(row.id);
        const bytes = fs.readFileSync(checked(real, row.path));
        const parts = split(bytes.toString('utf8'));
        docs.push({ id: row.id, rel: 'knowledge/' + row.path, title: row.title, provenance: row.provenance, chunks: parts.length,
          builtin: true, scope: row.scope, source_urls: row.source_urls, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        chunks.set(row.id, parts);
      } catch (e) { issues.push(`${row?.id || '?'}: ${e.message}`); }
    }
  } catch (e) { issues.push(e.message); }
  return { docs, chunks, issues };
}
module.exports = { load };
