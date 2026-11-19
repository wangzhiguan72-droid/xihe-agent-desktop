// Local cache diagnostics. Records only keyed fingerprints and allowlisted
// counters from the actual outgoing body and incoming usage events.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROCESS_KEY = crypto.randomBytes(32);
const RUN_ID = crypto.randomBytes(8).toString('hex');
let requestSeq = 0;
const MAX_SCOPES = 32, MAX_FILE = 16 * 1024 * 1024, TAIL_BYTES = 1024 * 1024;
const MAX_DETAILED_BODY = 4 * 1024 * 1024;
const CHUNK_BYTES = 1024, MAX_MESSAGE_CHUNKS = 64, MAX_REQUEST_CHUNKS = 2048;
const recent = new Map(), lastRoutes = new Map(), previousLarge = new Map(), droppedCounts = new Map();
const MESSAGE_FIELDS = new Set(['role', 'type', 'content', 'reasoning_content', 'tool_calls',
  'responses_items', 'output', 'call_id', 'name', 'arguments', 'id', 'status']);
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function_call',
  'function_call_output', 'reasoning', 'message']);
const HEADER_NAMES = ['x-request-id', 'request-id', 'cf-ray'];
const USAGE_PATHS = {
  openai: ['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens', 'prompt_tokens_details.cached_tokens'],
  responses: ['input_tokens', 'output_tokens', 'input_tokens_details.cached_tokens'],
  anthropic: ['input_tokens', 'output_tokens', 'cache_read_input_tokens',
    'cache_creation_input_tokens', 'cache_creation.ephemeral_5m_input_tokens',
    'cache_creation.ephemeral_1h_input_tokens'],
};
const CACHE_PATHS = {
  openai: ['prompt_cache_hit_tokens', 'prompt_tokens_details.cached_tokens'],
  responses: ['input_tokens_details.cached_tokens'],
  anthropic: ['cache_read_input_tokens'],
};
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const count = value => validCount(value) ? value : null;
const CACHE_TARGET_PERCENT = 90;
const hash = value => crypto.createHmac('sha256', PROCESS_KEY).update(value).digest('hex');
const asJson = value => JSON.stringify(value === undefined ? null : value);
const bytes = value => Buffer.byteLength(value, 'utf8');
const safeLabel = (value, fallback = 'other', maximum = 64) =>
  typeof value === 'string' && value.length <= maximum && /^[a-zA-Z][a-zA-Z0-9._:-]*$/.test(value)
    ? value : fallback;
const modelLabel = value => typeof value === 'string' && value.length <= 80
  && /^(?:gpt|claude|deepseek|glm|qwen|grok|kimi|gemini|o[0-9]|model)[a-zA-Z0-9._:-]*$/i.test(value)
  ? value : '(custom)';
const roleLabel = message => ROLES.has(message?.role || message?.type)
  ? (message.role || message.type) : 'other';

function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fingerprint(value) {
  const text = asJson(value);
  return { hash: hash(text), bytes: bytes(text) };
}
function componentFields(message, budget) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { other: field(message, budget) };
  const out = {}, other = [];
  for (const [name, value] of Object.entries(message)) {
    if (MESSAGE_FIELDS.has(name)) out[name] = field(value, budget);
    else other.push([name, value]);
  }
  if (other.length) out.other = field(other, budget);
  return out;
}
function field(value, budget) {
  const text = asJson(value), buffer = Buffer.from(text, 'utf8'), chunks = [];
  const n = Math.min(MAX_MESSAGE_CHUNKS, Math.ceil(buffer.length / CHUNK_BYTES), budget.left);
  for (let i = 0; i < n; i++) chunks.push(hash(buffer.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)));
  budget.left -= n;
  return { hash: hash(text), bytes: buffer.length, chunks };
}
function messageShape(message, budget) {
  return { ...fingerprint(message), role: roleLabel(message), fields: componentFields(message, budget) };
}
function endpointHash(url) {
  try {
    const parsed = new URL(String(url));
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
    return hash(parsed.origin + parsed.pathname);
  } catch { return hash('invalid-endpoint'); }
}
function requestShape(body, protocol, serializedBody) {
  const items = (protocol === 'responses' ? body.input : body.messages) || [];
  const allMessages = Array.isArray(items) ? items : [];
  let prefix = 0;
  if (protocol !== 'anthropic') while (prefix < allMessages.length
    && ['system', 'developer'].includes(allMessages[prefix]?.role)) prefix++;
  const system = protocol === 'anthropic' ? body.system || null : allMessages.slice(0, prefix);
  const conversation = allMessages.slice(prefix);
  const options = {};
  for (const [name, value] of Object.entries(body)) {
    if (!['model', 'system', 'tools', 'messages', 'input'].includes(name)) options[name] = value;
  }
  const budget = { left: MAX_REQUEST_CHUNKS };
  return {
    request: { wire: (() => {
      const wire = typeof serializedBody === 'string' ? serializedBody : asJson(body);
      return { hash: hash(wire), bytes: bytes(wire) };
    })(),
      system: fingerprint(system), tools: { ...fingerprint(body.tools || []), count: body.tools?.length || 0 },
      conversation: { ...fingerprint(conversation), count: conversation.length },
      options: fingerprint(options), message_count: allMessages.length },
    messages: conversation.map(message => messageShape(message, budget)),
  };
}
function firstDifferentField(previous, current) {
  const keys = [...new Set([...Object.keys(previous.fields), ...Object.keys(current.fields)])];
  for (const name of keys) {
    const a = previous.fields[name], b = current.fields[name];
    if (a?.hash === b?.hash && a?.bytes === b?.bytes) continue;
    let common = 0;
    while (common < Math.min(a?.chunks?.length || 0, b?.chunks?.length || 0)
      && a.chunks[common] === b.chunks[common]) common++;
    return { field: name, shared_bytes_lower_bound: common * CHUNK_BYTES };
  }
  return { field: 'other', shared_bytes_lower_bound: 0 };
}
function comparison(previous, current, routeChanged = false) {
  if (!previous) return { kind: routeChanged ? 'route_change' : 'first',
    common_messages: 0, first_changed: null, changed_parts: [] };
  const parts = ['system', 'tools', 'conversation', 'options'];
  const changed_parts = parts.filter(name => previous.request[name].hash !== current.request[name].hash);
  let common = 0;
  while (common < Math.min(previous.messages.length, current.messages.length)
    && previous.messages[common].hash === current.messages[common].hash) common++;
  let kind = changed_parts.length ? 'structure_change' : 'unchanged';
  if (changed_parts.includes('conversation')) {
    if (common < Math.min(previous.messages.length, current.messages.length)) kind = 'rewrite';
    else if (changed_parts.length === 1) {
      if (common === previous.messages.length && current.messages.length > common) kind = 'append';
      else if (common === current.messages.length && previous.messages.length > common) kind = 'shorter';
    }
  }
  let first_changed = null;
  if (common < Math.min(previous.messages.length, current.messages.length)) {
    const detail = firstDifferentField(previous.messages[common], current.messages[common]);
    first_changed = { index: common, role: current.messages[common].role, ...detail };
  }
  return { kind, common_messages: common, first_changed, changed_parts };
}
function remember(map, key, value) {
  map.delete(key); map.set(key, value);
  while (map.size > MAX_SCOPES) map.delete(map.keys().next().value);
}
function getPath(object, dotted) {
  let value = object;
  for (const name of dotted.split('.')) {
    if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, name)) return undefined;
    value = value[name];
  }
  return value;
}
function usageSnapshot(protocol, seen, normalized) {
  const cachePaths = CACHE_PATHS[protocol], reported = cachePaths.filter(name => seen.has(name));
  const valid = reported.filter(name => validCount(seen.get(name))), invalid = reported.filter(name => !validCount(seen.get(name)));
  let state = 'missing', source = null, tokens = null;
  if (invalid.length) state = 'invalid';
  else if (valid.length && new Set(valid.map(name => seen.get(name))).size > 1) state = 'conflicting';
  else if (valid.length) { source = valid[0]; tokens = seen.get(source); state = tokens ? 'reported' : 'zero'; }
  const read = name => seen.has(name) ? count(seen.get(name)) : null;
  let rawInput = null;
  if (protocol === 'openai') rawInput = read('prompt_tokens');
  if (protocol === 'responses') rawInput = read('input_tokens');
  if (protocol === 'anthropic') {
    const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
    if (fields.some(name => seen.has(name)) && !fields.some(name => seen.has(name) && read(name) == null))
      rawInput = fields.reduce((sum, name) => sum + (read(name) || 0), 0);
  }
  const normalizedInput = count(normalized?.prompt_tokens), normalizedCache = count(normalized?.cache_hit_tokens);
  const warnings = [];
  if (state === 'invalid') warnings.push('raw_cache_invalid');
  if (state === 'conflicting') warnings.push('raw_cache_alias_conflict');
  if (tokens != null && normalizedCache != null && tokens !== normalizedCache) warnings.push('adapter_cache_mismatch');
  if (rawInput != null && normalizedInput != null && rawInput !== normalizedInput) warnings.push('adapter_input_mismatch');
  if (tokens != null && rawInput != null && tokens > rawInput) warnings.push('cache_exceeds_input');
  return { raw_cache: { state, source, tokens }, raw_input_tokens: validCount(rawInput) ? rawInput : null,
    normalized_input_tokens: normalizedInput, normalized_cache_tokens: normalizedCache,
    raw_fields: Object.fromEntries((USAGE_PATHS[protocol] || []).filter(name => seen.has(name))
      .map(name => [name, count(seen.get(name))])), warnings };
}
function appendRecord(appDir, record) {
  try {
    const dir = path.join(appDir, 'data', 'cache-diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, localDay(record.t) + '.jsonl');
    const line = JSON.stringify(record) + '\n';
    let current = 0;
    try { current = fs.statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') return false; }
    if (current + bytes(line) > MAX_FILE) return false;
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch { return false; }
}
function headerHash(headers, name) {
  let value = null;
  if (typeof headers?.get === 'function') value = headers.get(name);
  else if (headers && typeof headers === 'object') {
    const key = Object.keys(headers).find(key => key.toLowerCase() === name);
    if (key) value = headers[key];
  }
  return typeof value === 'string' && value ? hash(value) : null;
}
function beginTrace(context, { protocol, url, body, serializedBody } = {}) {
  try {
    if (!context || typeof context.appDir !== 'string' || !path.isAbsolute(context.appDir)
      || typeof context.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(context.session_id)
      || !USAGE_PATHS[protocol] || !body || typeof body !== 'object') return null;
    const session_id = context.session_id, project_id = /^[A-Za-z0-9_-]{1,48}$/.test(context.project_id || '')
      ? context.project_id : null;
    const lane = safeLabel(context.lane, 'main'), provider_key = safeLabel(context.provider_key);
    const model = modelLabel(body.model), endpoint = endpointHash(url), modelHash = hash(asJson(body.model));
    const taskScope = context.task_id == null ? '' : hash(asJson(context.task_id));
    const base = JSON.stringify([context.appDir, session_id, lane, taskScope]);
    const route = JSON.stringify([provider_key, protocol, modelHash, endpoint]);
    const scope = base + route, previousRoute = lastRoutes.get(base);
    const wire = typeof serializedBody === 'string' ? serializedBody : asJson(body);
    const tooLarge = bytes(wire) > MAX_DETAILED_BODY;
    const shape = tooLarge ? { request: {
      wire: { hash: hash(wire), bytes: bytes(wire) },
      system: { hash: null, bytes: null }, tools: { hash: null, bytes: null, count: body.tools?.length || 0 },
      conversation: { hash: null, bytes: null, count: (protocol === 'responses' ? body.input : body.messages)?.length || 0 },
      options: { hash: null, bytes: null },
      message_count: (protocol === 'responses' ? body.input : body.messages)?.length || 0,
      skipped_large_request: true,
    }, messages: [] } : requestShape(body, protocol, wire);
    const prior = previousRoute === route ? recent.get(scope) : null;
    const compare = tooLarge ? { kind: 'skipped_large_request', common_messages: 0,
      first_changed: null, changed_parts: [] }
      : comparison(prior, shape, previousRoute != null && previousRoute !== route);
    if (!tooLarge && !prior && previousLarge.has(scope)) compare.reason = 'previous_large_request';
    // Set predecessor before the network call; concurrent completions never reorder it.
    remember(lastRoutes, base, route);
    if (tooLarge) { recent.delete(scope); remember(previousLarge, scope, true); }
    else { previousLarge.delete(scope); remember(recent, scope, shape); }
    const trace_id = crypto.randomBytes(8).toString('hex'), t = Date.now(), request_seq = ++requestSeq, seen = new Map();
    let finished = false, status = null, headers = {};
    const trace = { trace_id,
      response(code, responseHeaders) {
        try {
          status = Number.isSafeInteger(code) && code >= 100 && code <= 599 ? code : null;
          headers = Object.fromEntries(HEADER_NAMES.map(name => [name, headerHash(responseHeaders, name)]).filter(([, value]) => value));
        } catch {}
      },
      observeUsage(rawUsage) {
        try {
          if (!rawUsage || typeof rawUsage !== 'object') return;
          for (const name of USAGE_PATHS[protocol]) {
            const value = getPath(rawUsage, name);
            if (value !== undefined) seen.set(name, value);
          }
        } catch {}
      },
      finish(normalizedUsage, error, responseModel) {
        if (finished) return;
        finished = true;
        try {
          const responseModelHash = responseModel == null ? null : hash(asJson(responseModel));
          const errorName = ['Error', 'TimeoutError', 'AbortError', 'TypeError', 'FetchError'].includes(error?.name)
            ? error.name : error ? 'other' : null;
          const record = { version: 1, run_id: RUN_ID, trace_id, t, request_seq,
            duration_ms: Math.max(0, Date.now() - t),
            session_id, project_id, lane, provider_key, protocol, model, endpoint_hash: endpoint,
            task_scope_hash: taskScope || null, request: shape.request, comparison: compare,
            status, response_headers_hash: headers,
            response_model_hash: responseModelHash,
            response_model_matches_request: responseModelHash == null ? null : responseModelHash === modelHash,
            outcome: error ? 'error' : 'complete',
            usage: usageSnapshot(protocol, seen, normalizedUsage),
            error: error ? { name: errorName, status: Number.isSafeInteger(error.status)
              && error.status >= 0 && error.status <= 599 ? error.status : null,
              incomplete: !!error.incomplete, truncated: !!error.truncated, usage_partial: !!error.usage_partial } : null };
          if (!appendRecord(context.appDir, record)) {
            const dropKey = JSON.stringify([context.appDir, session_id]);
            remember(droppedCounts, dropKey, (droppedCounts.get(dropKey) || 0) + 1);
          }
        } catch {}
      },
    };
    return trace;
  } catch { return null; }
}

function readTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    return { lines: text.split('\n').filter(Boolean), truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}
function cacheTargetStatus(row) {
  const input = row.usage?.raw_input_tokens, cached = row.usage?.raw_cache?.tokens;
  if (row.outcome !== 'complete' || row.error || !Number.isSafeInteger(row.status)
    || row.status < 200 || row.status >= 300
    || !['reported', 'zero'].includes(row.usage?.raw_cache?.state)
    || !validCount(input) || input === 0 || !validCount(cached) || cached > input
    || row.usage?.warnings?.length) return 'unverified';
  return BigInt(cached) * 10n >= BigInt(input) * 9n ? 'met' : 'below';
}
function readSummary(appDir, { session_id, limit = 20 } = {}) {
  const dropped = droppedCounts.get(JSON.stringify([appDir, session_id])) || 0;
  const empty = { available: false, new_requests_only: true, window_days: 7,
    truncated: dropped > 0, dropped_count: dropped,
    recording_errors: dropped, recording_status: dropped ? 'degraded' : 'ok',
    diagnostic_error: dropped ? 'records_dropped' : null, requests: 0,
    cache_reported: 0, cache_missing: 0, cache_invalid: 0, cache_conflicting: 0,
    known_rate: null, unknown_count: 0, known_input_tokens: 0, known_cached_tokens: 0,
    cache_target: { threshold_percent: CACHE_TARGET_PERCENT, status: 'unverified', met: 0,
      below: 0, unverified: 0, below_requests: [] }, records: [] };
  try {
    if (typeof appDir !== 'string' || !path.isAbsolute(appDir)
      || typeof session_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(session_id)) return empty;
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 20;
    const dir = path.join(appDir, 'data', 'cache-diagnostics'), rows = [];
    let truncated = false;
    for (let days = 0; days < 7; days++) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days);
      let tail;
      try { tail = readTail(path.join(dir, localDay(d.getTime()) + '.jsonl')); }
      catch (e) { if (e.code === 'ENOENT') continue; else { truncated = true; continue; } }
      truncated ||= tail.truncated;
      for (const line of tail.lines.reverse()) {
        let row;
        try { row = JSON.parse(line); } catch { truncated = true; continue; }
        if (row?.version !== 1 || row.session_id !== session_id) continue;
        if (rows.length < 2000) rows.push(row);
        else truncated = true;
      }
    }
    if (!rows.length) return { ...empty, truncated: truncated || dropped > 0 };
    rows.sort((a, b) => b.t - a.t || (a.run_id === b.run_id ? b.request_seq - a.request_seq : 0));
    let known_input_tokens = 0, known_cached_tokens = 0;
    const summary = { ...empty, available: true, truncated: truncated || dropped > 0, requests: rows.length };
    for (const row of rows) {
      row.cache_target_status = cacheTargetStatus(row);
      summary.cache_target[row.cache_target_status]++;
      if (row.cache_target_status === 'below' && summary.cache_target.below_requests.length < 5) {
        summary.cache_target.below_requests.push({ t: row.t, request_seq: row.request_seq,
          lane: row.lane, model: row.model, input_tokens: row.usage.raw_input_tokens,
          cached_tokens: row.usage.raw_cache.tokens });
      }
      const state = row.usage?.raw_cache?.state;
      if (state === 'reported' || state === 'zero') {
        summary.cache_reported++;
        if (validCount(row.usage.raw_input_tokens) && validCount(row.usage.raw_cache.tokens)
          && row.usage.raw_cache.tokens <= row.usage.raw_input_tokens) {
          known_input_tokens += row.usage.raw_input_tokens;
          known_cached_tokens += row.usage.raw_cache.tokens;
        } else summary.unknown_count++;
      } else {
        if (state === 'invalid') summary.cache_invalid++;
        else if (state === 'conflicting') summary.cache_conflicting++;
        else summary.cache_missing++;
        summary.unknown_count++;
      }
    }
    summary.known_input_tokens = known_input_tokens;
    summary.known_cached_tokens = known_cached_tokens;
    summary.known_rate = known_input_tokens ? +(100 * known_cached_tokens / known_input_tokens).toFixed(2) : null;
    summary.cache_target.status = summary.cache_target.below ? 'below'
      : summary.cache_target.unverified || summary.truncated ? 'unverified' : 'met';
    summary.records = rows.slice(0, safeLimit);
    return summary;
  } catch { return empty; }
}
module.exports = { beginTrace, readSummary };
