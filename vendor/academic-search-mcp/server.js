#!/usr/bin/env node
'use strict';

// 零依赖 MCP stdio 服务：Crossref / arXiv 论文元数据检索。
// 只暴露三个固定工具，不接受任意 URL、命令或环境变量。
// 协议：MCP 2024-11-05，换行分隔 JSON-RPC 2.0；stdout 只写协议消息。

const PROTOCOL_VERSION = '2024-11-05';
const MAX_QUERY = 300;
const MAX_ID = 200;
const MAX_ROWS = 10;
const TIMEOUT_MS = 15000;
const CROSSREF = process.env.XIHE_CROSSREF_BASE || 'https://api.crossref.org';
const ARXIV = process.env.XIHE_ARXIV_BASE || 'http://export.arxiv.org/api/query';
const UA = 'xihe-agent-academic-search/1.0 (MCP stdio; metadata only)';

const TOOLS = [
  {
    name: 'search_papers',
    description: 'Search public paper metadata from Crossref and/or arXiv. Returns titles, authors, year, DOI/URL and abstract snippets. Metadata only; verify before citing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords, 1-300 characters' },
        rows: { type: 'integer', description: 'Number of results, 1-10', minimum: 1, maximum: 10 },
        sources: { type: 'array', items: { type: 'string', enum: ['crossref', 'arxiv'] }, description: 'Metadata sources; defaults to both' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_paper_by_id',
    description: 'Look up one paper by DOI or arXiv id. Returns metadata only.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'DOI (10.xxxx/...) or arXiv id (2401.01234)' },
        id_type: { type: 'string', enum: ['auto', 'doi', 'arxiv'], description: 'Defaults to auto' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_citation',
    description: 'Format an APA-like citation from Crossref/arXiv metadata. Always verify authors, year, venue and pages against the publisher page.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'DOI or arXiv id' },
        id_type: { type: 'string', enum: ['auto', 'doi', 'arxiv'], description: 'Defaults to auto' },
        style: { type: 'string', enum: ['apa'], description: 'Only APA is supported' },
      },
      required: ['id'],
    },
  },
];

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function asText(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value == null ? '' : value);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function fetchText(url, type) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: type }, signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url) {
  const text = await fetchText(url, 'application/json');
  try { return JSON.parse(text); } catch { throw new Error('上游返回的不是有效 JSON'); }
}

function crossrefItem(row) {
  if (!row || !row.DOI) return null;
  const authors = (row.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ') || a.name || '').filter(Boolean);
  const year = row.issued?.['date-parts']?.[0]?.[0] || row['published-print']?.['date-parts']?.[0]?.[0]
    || row['published-online']?.['date-parts']?.[0]?.[0] || null;
  return {
    source: 'crossref',
    id: row.DOI,
    doi: row.DOI,
    title: clip(stripTags(asText(row.title)), 400),
    authors,
    year,
    venue: clip(stripTags(asText(row['container-title'])), 240),
    type: row.type || '',
    url: row.URL || ('https://doi.org/' + row.DOI),
    abstract: clip(stripTags(row.abstract || ''), 1200),
    pages: row.page || '',
    volume: row.volume || '',
    issue: row.issue || '',
  };
}

async function searchCrossref(query, rows) {
  const url = CROSSREF.replace(/\/+$/, '') + '/works?query=' + encodeURIComponent(query)
    + '&rows=' + rows
    + '&select=DOI,title,author,issued,published-print,published-online,container-title,URL,abstract,type,page,volume,issue';
  const j = await fetchJSON(url);
  const items = j?.message?.items || [];
  return items.map(crossrefItem).filter(Boolean);
}

function arxivEntry(xml) {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entry) return null;
  const block = entry[1];
  const pick = tag => {
    const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
    return m ? stripTags(m[1]) : '';
  };
  const idUrl = pick('id');
  const id = (idUrl.match(/abs\/([^/?#]+)/) || [])[1] || idUrl;
  const authors = [...block.matchAll(/<author[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    .map(m => stripTags(m[1])).filter(Boolean);
  const published = pick('published') || pick('updated');
  const doiMatch = block.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/i);
  return {
    source: 'arxiv',
    id,
    doi: doiMatch ? stripTags(doiMatch[1]) : '',
    title: clip(pick('title'), 400),
    authors,
    year: published ? Number(String(published).slice(0, 4)) || null : null,
    venue: 'arXiv',
    type: 'preprint',
    url: idUrl || ('https://arxiv.org/abs/' + id),
    abstract: clip(pick('summary'), 1200),
    pages: '', volume: '', issue: '',
  };
}

async function searchArxiv(query, rows) {
  const url = ARXIV + '?search_query=' + encodeURIComponent('all:' + query)
    + '&start=0&max_results=' + rows + '&sortBy=relevance&sortOrder=descending';
  const xml = await fetchText(url, 'application/atom+xml, application/xml, text/xml');
  return [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/gi)]
    .map(m => arxivEntry(m[0]))
    .filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = (item.doi || item.title || item.id || '').toLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function summarize(items) {
  if (!items.length) return 'No metadata results.';
  return items.map((x, i) => {
    const authors = x.authors.length ? (x.authors.slice(0, 4).join(', ') + (x.authors.length > 4 ? ', et al.' : '')) : 'Unknown authors';
    return `${i + 1}. ${x.title}\n   ${authors}${x.year ? ' · ' + x.year : ''}${x.venue ? ' · ' + x.venue : ''}\n   ${x.doi ? 'DOI: ' + x.doi + '\n   ' : ''}${x.url || ''}${x.abstract ? '\n   ' + clip(x.abstract, 320) : ''}`;
  }).join('\n\n');
}

function normalizeId(id, idType) {
  const raw = String(id || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  const type = idType === 'doi' || idType === 'arxiv' ? idType
    : (/^10\.\d{4,9}\//.test(raw) ? 'doi' : (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(raw) ? 'arxiv' : 'auto'));
  if (type === 'arxiv') return { type, id: raw.replace(/^arxiv:/i, '') };
  return { type, id: raw };
}

async function lookup(id, idType) {
  const n = normalizeId(id, idType);
  if (n.type === 'doi') {
    const j = await fetchJSON(CROSSREF.replace(/\/+$/, '') + '/works/' + encodeURIComponent(n.id));
    const item = crossrefItem(j?.message);
    if (item) return item;
  } else if (n.type === 'arxiv') {
    const xml = await fetchText(ARXIV + '?id_list=' + encodeURIComponent(n.id), 'application/atom+xml, application/xml, text/xml');
    const item = arxivEntry(xml);
    if (item) return item;
  } else {
    try { return await lookup(n.id, 'doi'); } catch { /* try arXiv */ }
    return await lookup(n.id, 'arxiv');
  }
  throw new Error('未找到该文献的公开元数据');
}

function apa(item) {
  const authors = item.authors.length
    ? item.authors.map(name => {
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return parts[0];
      const family = parts.pop();
      const initials = parts.map(p => p.replace(/[^A-Za-z\u4e00-\u9fff]/g, '').slice(0, 1).toUpperCase() + '.').join(' ');
      return family + ', ' + initials;
    }).join(', ')
    : 'Unknown author';
  const year = item.year || 'n.d.';
  const venue = item.venue ? ' ' + item.venue + (item.volume ? ', ' + item.volume : '') + (item.issue ? '(' + item.issue + ')' : '') + (item.pages ? ', ' + item.pages : '') + '.' : '';
  const doi = item.doi ? ' https://doi.org/' + item.doi : (item.url ? ' ' + item.url : '');
  return `${authors} (${year}). ${item.title}.${venue}${doi}`.replace(/\s+/g, ' ').trim();
}

function toolResult(payload, text) {
  return { content: [{ type: 'text', text: text || JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

async function runTool(name, args) {
  if (name === 'search_papers') {
    const query = String(args?.query || '').trim();
    if (!query || query.length > MAX_QUERY) throw new Error('检索词须为 1–300 字');
    const rows = args?.rows == null ? 5 : Number(args.rows);
    if (!Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) throw new Error('rows 须为 1–10');
    const sources = Array.isArray(args?.sources) && args.sources.length ? args.sources : ['crossref', 'arxiv'];
    const jobs = [];
    if (sources.includes('crossref')) jobs.push(searchCrossref(query, rows).catch(() => []));
    if (sources.includes('arxiv')) jobs.push(searchArxiv(query, rows).catch(() => []));
    const merged = dedupe((await Promise.all(jobs)).flat()).slice(0, rows);
    if (!merged.length) throw new Error('公开元数据源未返回结果（网络或接口不可用）');
    return toolResult({ query, count: merged.length, results: merged }, summarize(merged));
  }
  if (name === 'get_paper_by_id') {
    const id = String(args?.id || '').trim();
    if (!id || id.length > MAX_ID) throw new Error('文献标识须为 1–200 字');
    const item = await lookup(id, args?.id_type);
    return toolResult({ paper: item }, summarize([item]));
  }
  if (name === 'get_citation') {
    const id = String(args?.id || '').trim();
    if (!id || id.length > MAX_ID) throw new Error('文献标识须为 1–200 字');
    if (args?.style && args.style !== 'apa') throw new Error('目前只支持 APA');
    const item = await lookup(id, args?.id_type);
    return toolResult({ citation: apa(item), paper: item }, apa(item));
  }
  throw new Error('未知工具：' + name);
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); return; }
  if (!msg || msg.jsonrpc !== '2.0') { fail(msg?.id ?? null, -32600, 'Invalid Request'); return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'xihe-academic-search', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) return;
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }
  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const result = await runTool(name, params?.arguments || {});
      reply(id, result);
    } catch (e) {
      reply(id, { isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
    }
    return;
  }
  fail(id, -32601, 'Method not found');
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(line).catch(e => { if (process.env.XIHE_MCP_DEBUG) process.stderr.write(String(e.stack || e) + '\n'); });
  }
});
process.stdin.on('end', () => { if (buffer.trim()) handle(buffer.trim()); });
