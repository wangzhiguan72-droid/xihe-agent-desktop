'use strict';
// 离线验证随包论文检索 MCP：真实 stdio 握手 + 固定工具 + Crossref/arXiv 解析。
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', 'vendor', 'academic-search-mcp', 'server.js');

const crossref = {
  message: {
    items: [{
      DOI: '10.1000/xyz123',
      title: ['A test paper about network optimization'],
      author: [{ given: 'Ada', family: 'Lovelace' }, { given: 'Alan', family: 'Turing' }],
      issued: { 'date-parts': [[2024, 5, 1]] },
      'container-title': ['Journal of Tests'],
      URL: 'https://doi.org/10.1000/xyz123',
      abstract: '<jats:p>We test optimization.</jats:p>',
      type: 'journal-article', page: '1-10', volume: '12', issue: '3',
    }],
  },
};

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <published>2024-01-03T00:00:00Z</published>
    <title>An arXiv paper on network optimization</title>
    <summary>Abstract text for the arXiv paper.</summary>
    <author><name>Grace Hopper</name></author>
  </entry>
</feed>`;

const fixture = http.createServer((req, res) => {
  if (req.url.startsWith('/works/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: crossref.message.items[0] })); return; }
  if (req.url.startsWith('/works?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(crossref)); return; }
  if (req.url.startsWith('/arxiv')) { res.setHeader('Content-Type', 'application/atom+xml'); res.end(atom); return; }
  res.statusCode = 404; res.end('{}');
});

function rpc(child, message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}

function collect(child) {
  const queue = [];
  const waiting = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiting.length) waiting.shift()(msg); else queue.push(msg);
    }
  });
  return () => new Promise((resolve, reject) => {
    if (queue.length) { resolve(queue.shift()); return; }
    const timer = setTimeout(() => reject(new Error('MCP response timeout')), 8000);
    waiting.push(msg => { clearTimeout(timer); resolve(msg); });
  });
}

(async () => {
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  const port = fixture.address().port;
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XIHE_CROSSREF_BASE: `http://127.0.0.1:${port}`, XIHE_ARXIV_BASE: `http://127.0.0.1:${port}/arxiv` },
  });
  const next = collect(child);
  try {
    rpc(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    const init = await next();
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert(init.result.capabilities.tools);
    rpc(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    rpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = await next();
    assert.equal(tools.result.tools.length, 3);
    rpc(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_papers', arguments: { query: 'network optimization', rows: 3 } } });
    const search = await next();
    assert.equal(search.result.isError, undefined);
    assert.equal(search.result.structuredContent.count, 2);
    assert(search.result.structuredContent.results.some(x => x.doi === '10.1000/xyz123'));
    assert(search.result.structuredContent.results.some(x => x.source === 'arxiv'));
    rpc(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_citation', arguments: { id: '10.1000/xyz123' } } });
    const cite = await next();
    assert.match(cite.result.structuredContent.citation, /Lovelace/);
    assert.match(cite.result.structuredContent.citation, /2024/);
    console.log('PASS bundled academic MCP handshake/search/citation');
  } finally {
    child.kill();
    fixture.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
