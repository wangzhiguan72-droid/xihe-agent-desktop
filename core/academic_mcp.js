'use strict';

// A small, bounded MCP stdio client for the locally configured academic-search server.
// Model input never controls the executable, arguments, environment, or MCP tool name.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const TOOLS = Object.freeze({ search: 'search_papers', paper: 'get_paper_by_id', citation: 'get_citation' });
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 45000;
const PROTOCOL_VERSION = '2024-11-05';
let configCache = { file: '', mtimeMs: -1, value: null };

function readCodexConfig() {
  const file = path.join(os.homedir(), '.codex', 'config.toml');
  let mtimeMs;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  if (configCache.file === file && configCache.mtimeMs === mtimeMs) return configCache.value;
  const script = 'import json,sys,tomllib; c=tomllib.load(open(sys.argv[1],"rb")).get("mcp_servers",{}).get("academic-search",{}); print(json.dumps({k:c.get(k) for k in ("command","args","env")},ensure_ascii=False))';
  const result = spawnSync('python', ['-c', script, file], { encoding: 'utf8', timeout: 3000, maxBuffer: 65536, windowsHide: true });
  let value = null;
  if (result.status === 0 && result.stdout) {
    try { value = JSON.parse(result.stdout); } catch { /* invalid config remains unavailable */ }
  }
  configCache = { file, mtimeMs, value };
  return value;
}

// 发行版自带的零依赖论文检索 MCP：未配置外部服务时自动使用，保证开箱可用。
function bundledConfig() {
  const server = path.join(__dirname, '..', 'vendor', 'academic-search-mcp', 'server.js');
  try { if (!fs.statSync(server).isFile()) return null; } catch { return null; }
  return { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1' }, timeout_ms: 45000 };
}

function configuration(settings = {}) {
  const configured = (settings.academic_mcp && settings.academic_mcp.command ? settings.academic_mcp : null)
    || readCodexConfig() || bundledConfig();
  if (!configured || typeof configured.command !== 'string' || !configured.command.trim()
    || !Array.isArray(configured.args) || !configured.args.every(a => typeof a === 'string')
    || configured.args.length > 24 || configured.args.some(a => a.length > 2048)) return null;
  if (configured.env && (typeof configured.env !== 'object' || Array.isArray(configured.env))) return null;
  return configured;
}

function status(settings = {}) {
  const configured = settings.academic_mcp && settings.academic_mcp.command;
  const config = configuration(settings);
  return { configured: !!config, connected: null, availability: config ? 'configured-unprobed' : 'unconfigured',
    source: config ? (configured ? 'app-settings' : (readCodexConfig() ? 'codex-config' : 'bundled')) : null };
}

function argumentsFor(input) {
  if (!input || !Object.hasOwn(TOOLS, input.operation)) throw new Error('不支持的学术检索操作');
  if (input.operation === 'search') {
    const query = String(input.query || '').trim();
    if (!query || query.length > 300) throw new Error('检索词须为 1–300 字');
    const rows = input.rows == null ? 5 : Number(input.rows);
    if (!Number.isInteger(rows) || rows < 1 || rows > 10) throw new Error('rows 须为 1–10');
    return { query, rows, sources: ['crossref', 'arxiv'] };
  }
  const id = String(input.id || '').trim();
  if (!id || id.length > 200) throw new Error('文献标识须为 1–200 字');
  return { id, id_type: 'auto', ...(input.operation === 'citation' ? { style: 'apa' } : {}) };
}

async function callAcademic(settings = {}, input = {}) {
  const args = argumentsFor(input);
  const config = configuration(settings);
  if (!config) return { ok: false, error: 'academic-search MCP 未配置或当前不可用' };
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(config.command, config.args, {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...(config.env || {}) },
      });
    } catch { resolve({ ok: false, error: 'academic-search MCP 无法启动' }); return; }
    let settled = false, buffer = '', bytes = 0, stage = 0;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      resolve(result);
    };
    const send = (id, method, params) => {
      if (child.stdin.destroyed) return;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...(id == null ? {} : { id }), method, ...(params == null ? {} : { params }) }) + '\n');
    };
    const requestedTimeout = Number(config.timeout_ms);
    const timeout = Number.isInteger(requestedTimeout) ? Math.max(100, Math.min(TIMEOUT_MS, requestedTimeout)) : TIMEOUT_MS;
    const timer = setTimeout(() => finish({ ok: false, error: 'academic-search MCP 响应超时' }), timeout);
    child.on('error', () => finish({ ok: false, error: 'academic-search MCP 无法启动' }));
    child.on('close', () => finish({ ok: false, error: 'academic-search MCP 提前退出' }));
    child.stdin.on('error', () => finish({ ok: false, error: 'academic-search MCP 输入通道关闭' }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_BYTES) { finish({ ok: false, error: 'academic-search MCP 返回内容过大' }); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0 && !settled) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); } catch { finish({ ok: false, error: 'academic-search MCP 协议响应无效' }); break; }
        if (!response || typeof response !== 'object' || Array.isArray(response) || response.jsonrpc !== '2.0') {
          finish({ ok: false, error: 'academic-search MCP 协议响应无效' }); break;
        }
        if (stage === 0 && response.id === 1) {
          if (response.error || response.result?.protocolVersion !== PROTOCOL_VERSION
              || !response.result?.capabilities || typeof response.result.capabilities !== 'object'
              || !response.result.capabilities.tools) {
            finish({ ok: false, error: 'academic-search MCP 初始化失败或协议版本不匹配' }); break;
          }
          stage = 1;
          send(null, 'notifications/initialized');
          send(2, 'tools/list');
        } else if (stage === 1 && response.id === 2) {
          if (!Array.isArray(response.result?.tools) || !response.result.tools.some(tool => tool?.name === TOOLS[input.operation])) {
            finish({ ok: false, error: 'academic-search MCP 未提供所需工具' }); break;
          }
          stage = 2;
          send(3, 'tools/call', { name: TOOLS[input.operation], arguments: args });
        } else if (stage === 2 && response.id === 3) {
          if (response.error || !response.result || response.result.isError) { finish({ ok: false, error: 'academic-search MCP 检索失败' }); break; }
          finish({ ok: true, operation: input.operation, content: response.result?.content || [], structuredContent: response.result?.structuredContent || null });
        }
      }
    });
    send(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'xihe-agent', version: '2.9.0' } });
  });
}

module.exports = { callAcademic, status, argumentsFor };
