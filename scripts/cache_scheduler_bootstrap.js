'use strict';
// Preload used only by the explicitly authorized isolated live scheduler run.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = process.env.XIHE_LIVE_SOURCE, audit = process.env.XIHE_LIVE_AUDIT;
if (!root || !audit || !process.env.XIHE_LIVE_PROVIDER) throw new Error('Missing controlled probe context');
const pk = process.env.XIHE_LIVE_PROVIDER;
const actual = require(path.join(root, 'core/providers'));
const local = require(path.join(process.cwd(), 'core/providers'));
const settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config/settings.json'), 'utf8'));
const provider = local.resolveProvider(pk, settings);
const current = actual.resolveProvider(pk, JSON.parse(fs.readFileSync(path.join(root, 'config/settings.json'), 'utf8')));
if (!current || current.base !== provider.base || current.kind !== provider.kind) throw new Error('Provider identity changed; stop the controlled run');
const key = actual.keyFor(pk, root);
if (!key) throw new Error('Authorized channel key unavailable');
local.keyFor = selected => selected === pk ? key : '';
const model = process.env.XIHE_LIVE_MODEL;
const url = require(path.join(root, 'core/responses-routing')).endpointURL(provider.base, provider.kind);
const file = path.join(audit, 'requests.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
const save = rows => fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
const { observeStream } = require(path.join(root, 'scripts/cache_live_probe'));
const nativeFetch = global.fetch;
const requestedLimit = Number(process.env.XIHE_LIVE_CALL_LIMIT) || 8;
const callLimit = Math.max(1, Math.min(12, requestedLimit));
global.fetch = async (target, init) => {
  const name = String(target);
  if (name !== url) {
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/.test(name)) return nativeFetch(target, init);
    throw Object.assign(new Error('Probe blocked an unapproved remote endpoint'), { status: 400 });
  }
  const rows = read();
  if (rows.length >= callLimit || rows.reduce((n, r) => n + (r.usage?.prompt_tokens || 0), 0) >= 250000)
    throw Object.assign(new Error('Controlled live request budget reached'), { status: 400, code: 'PROBE_BUDGET_LIMIT' });
  const body = JSON.parse(init.body);
  if (body.model !== model) throw Object.assign(new Error('Unexpected model blocked'), { status: 400 });
  const messages = body.messages || body.input || [];
  const descriptor = messages.map(message => ({ role: message.role || message.type || 'other', hash: sha(JSON.stringify(message)),
    fields: Object.fromEntries(['role', 'content', 'reasoning_content', 'tool_calls', 'responses_items', 'output'].filter(k => k in message).map(k => [k, sha(JSON.stringify(message[k]))])) }));
  const previous = rows.at(-1);
  let common = 0;
  while (common < Math.min(previous?.message_hashes?.length || 0, descriptor.length) && previous.message_hashes[common].hash === descriptor[common].hash) common++;
  const row = { seq: rows.length + 1, started: Date.now(), request_bytes: Buffer.byteLength(init.body), request_sha256: sha(init.body),
    tools_sha256: sha(JSON.stringify(body.tools || [])), message_hashes: descriptor, common_previous_messages: common,
    previous_messages: previous?.message_hashes?.length || null, current_messages: descriptor.length,
    system_changed: previous ? previous.message_hashes[0]?.hash !== descriptor[0]?.hash : null,
    tools_changed: previous ? previous.tools_sha256 !== sha(JSON.stringify(body.tools || [])) : null,
    raw_usage_events: [], first_stream_ms: null, http_status: null };
  rows.push(row); save(rows);
  let response;
  try {
    response = await nativeFetch(target, { ...init,
      signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(90000)]) });
  } catch (error) {
    row.duration_ms = Date.now() - row.started;
    row.error = { name: ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'other',
      code: ['ECONNRESET', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(error.cause?.code) ? error.cause.code : null };
    save(rows); throw error;
  }
  row.http_status = response.status; row.header_ms = Date.now() - row.started; save(rows);
  const observed = response.body ? observeStream(response.body, row) : null;
  const bodyStream = observed ? { async *[Symbol.asyncIterator]() {
    try { for await (const chunk of observed) yield chunk; }
    finally {
      row.duration_ms = Date.now() - row.started;
      const snapshots = row.raw_usage_events.map(x => x.usage), merged = Object.assign({}, ...snapshots);
      row.usage = { prompt_tokens: merged.prompt_tokens ?? merged.input_tokens ?? null,
        completion_tokens: merged.completion_tokens ?? merged.output_tokens ?? null,
        cache_tokens: merged.prompt_cache_hit_tokens ?? merged.prompt_tokens_details?.cached_tokens ?? merged.input_tokens_details?.cached_tokens ?? null };
      save(rows);
    }
  } } : null;
  return { ok: response.ok, status: response.status, headers: response.headers, body: bodyStream,
    text: async () => (await response.text()).replaceAll(key, '[REDACTED]') };
};
