'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { callAcademic, argumentsFor, status } = require('./academic_mcp');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-academic-mcp-'));
const server = path.join(dir, 'server.js');
fs.writeFileSync(server, `
const readline = require('readline');
const mode = process.argv[2];
const line = readline.createInterface({ input: process.stdin });
const out = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
line.on('line', raw => {
  const q = JSON.parse(raw);
  if (mode === 'hang') return;
  if (mode === 'malformed') { process.stdout.write('bad\\n'); return; }
  if (mode === 'null') { process.stdout.write('null\\n'); return; }
  if (mode === 'oversize') { process.stdout.write('x'.repeat(3 * 1024 * 1024)); return; }
  if (mode === 'exit') { process.exit(0); }
  if (q.method === 'initialize') out({ id: q.id, result: { protocolVersion: q.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (q.method === 'tools/list') out({ id: q.id, result: { tools: mode === 'missing' ? [] : [{ name: 'search_papers' }, { name: 'get_paper_by_id' }, { name: 'get_citation' }] } });
  if (q.method === 'tools/call') out({ id: q.id, result: mode === 'error' ? { isError: true, content: [] } : { content: [{ type: 'text', text: JSON.stringify({ name: q.params.name, args: q.params.arguments }) }] } });
});
`);
const settings = mode => ({ academic_mcp: { command: process.execPath, args: [server, mode], timeout_ms: 1000 } });
(async () => {
  assert.equal(status(settings('success')).configured, true);
  assert.equal(status(settings('success')).connected, null);
  assert.throws(() => argumentsFor({ operation: 'exec', query: 'x' }), /不支持/);
  assert.throws(() => argumentsFor({ operation: 'search', query: 'x', rows: 50 }), /rows/);
  const search = await callAcademic(settings('success'), { operation: 'search', query: 'optimization', rows: 2 });
  assert.equal(search.ok, true);
  assert.deepEqual(JSON.parse(search.content[0].text), { name: 'search_papers', args: { query: 'optimization', rows: 2, sources: ['crossref', 'arxiv'] } });
  const paper = await callAcademic(settings('success'), { operation: 'paper', id: '10.1000/test' });
  assert.equal(JSON.parse(paper.content[0].text).name, 'get_paper_by_id');
  const citation = await callAcademic(settings('success'), { operation: 'citation', id: '10.1000/test' });
  assert.equal(JSON.parse(citation.content[0].text).name, 'get_citation');
  assert.match((await callAcademic(settings('missing'), { operation: 'search', query: 'x' })).error, /未提供/);
  assert.match((await callAcademic(settings('error'), { operation: 'search', query: 'x' })).error, /失败/);
  assert.match((await callAcademic(settings('malformed'), { operation: 'search', query: 'x' })).error, /协议/);
  assert.match((await callAcademic(settings('null'), { operation: 'search', query: 'x' })).error, /协议/);
  assert.match((await callAcademic(settings('oversize'), { operation: 'search', query: 'x' })).error, /过大/);
  assert.match((await callAcademic(settings('exit'), { operation: 'search', query: 'x' })).error, /退出|通道/);
  const timed = await callAcademic({ academic_mcp: { command: process.execPath, args: [server, 'hang'], timeout_ms: 150 } }, { operation: 'search', query: 'x' });
  assert.match(timed.error, /超时/);
  assert.equal((await callAcademic({ academic_mcp: { command: path.join(dir, 'missing.exe'), args: [] } }, { operation: 'search', query: 'x' })).ok, false);
  console.log('PASS academic MCP: stdio handshake, allowlist, metadata, error, malformed, timeout, unavailable');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
});
