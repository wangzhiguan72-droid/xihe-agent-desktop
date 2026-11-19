'use strict';
// Manual, bounded live probe. Without --live this only prints a request plan.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const APP = path.resolve(__dirname, '..');
const providers = require('../core/providers');
const agent = require('../core/agent');
const { endpointURL } = require('../core/responses-routing');
const { costOf, DEFAULT_PRICES } = require('../core/pricing');
const MAX_CALLS = 8, MAX_INPUT = 250000, MAX_OUTPUT = 256;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const USAGE_KEYS = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens',
  'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
  'cache_hit_tokens', 'cached_tokens', 'cache_tokens', 'input_cache_hit_tokens', 'input_cache_miss_tokens',
  'prompt_tokens_details', 'input_tokens_details', 'completion_tokens_details', 'output_tokens_details',
  'reasoning_tokens', 'audio_tokens', 'image_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']);
function selectedUsage(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value || {})) {
    if (!USAGE_KEYS.has(key)) continue;
    if (typeof entry === 'number' && Number.isFinite(entry) || entry === null) out[key] = entry;
    else if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[key] = selectedUsage(entry);
    else out[key] = { invalid_type: typeof entry };
  }
  return out;
}
function observeStream(raw, record) {
  const decoder = new TextDecoder(); let pending = '';
  const line = text => {
    if (!text.trim().startsWith('data:')) return;
    const data = text.trim().slice(5).trim(); if (!data || data === '[DONE]') return;
    let event; try { event = JSON.parse(data); } catch { return; }
    const usage = event.usage || event.response?.usage || event.message?.usage;
    if (usage) record.raw_usage_events.push({ elapsed_ms: Date.now() - record.started, usage: selectedUsage(usage) });
    if (typeof event.system_fingerprint === 'string') record.backend_fingerprint = sha(event.system_fingerprint);
  };
  return { async *[Symbol.asyncIterator]() {
    for await (const chunk of raw) {
      if (record.first_stream_ms == null) record.first_stream_ms = Date.now() - record.started;
      pending += decoder.decode(chunk, { stream: true });
      let end; while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      yield chunk;
    }
    if (pending.trim()) line(pending);
  } };
}
function prepare() {
  const settings = JSON.parse(fs.readFileSync(path.join(APP, 'config/settings.json'), 'utf8'));
  const old = JSON.parse(fs.readFileSync(path.join(APP, 'data/sessions/5c452c84af2d.json'), 'utf8'));
  const providerKey = old.system_provider || providers.providerForModel(old.model, settings);
  const provider = providers.resolveProvider(providerKey, settings);
  if (!provider) throw new Error('Source provider unavailable');
  const model = agent.apiModelOf(old.resolved_model || old.model, providerKey);
  if (!providers.providerModels(settings).some(row => row.provider === providerKey && row.id === model)) throw new Error('Source model disabled');
  const run = crypto.randomBytes(6).toString('hex'), projectId = 'cache_probe_20261109_' + run;
  const workspace = path.join(APP, '..', 'workspace', 'projects', projectId);
  const session = { id: crypto.randomBytes(6).toString('hex'), project_id: projectId, title: '缓存实践检测：64个数求和（受控重放）',
    mode: 'math', model, resolved_model: model, system_provider: providerKey, contest_kind: 'generic', task_scope: 'solve',
    effort: 'fast', approval: 'full', collab_mode: 'collab', contest: false, status: 'idle', createdAt: Date.now(), updatedAt: Date.now(),
    messages: [], memory: [], todos: [], runs: [], contract: [], question_graph: [], data_epoch: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, calls: 0, cost: 0, vision_calls: 0 } };
  const control = '\n本次是已批准的缓存验证微任务。直接计算用户提供的数字，不调用工具，不执行赛事全流程，不读其它项目。最终只输出SUM=整数。';
  const system = agent.buildSystem('math', workspace, settings, APP, providerKey, null, session) + control;
  const tools = provider.kind === 'anthropic' ? require('../core/tools').toAnthropicTools(session) : require('../core/tools').toOpenAITools(session);
  const rows = Array.from({ length: 64 }, (_, i) => ({ id: i + 1, value: i + 1, control: sha(run + ':' + i).slice(0, 48) }));
  const prompt = '受控任务编号：' + run + '\n请计算以下64条记录的value总和。control字段仅作固定档案标识，不参与计算。只输出SUM=整数。\n' + JSON.stringify(rows);
  const a = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const suffix = '保留前述记录，重新核对value之和。附加校验标识（不参与计算）：' + sha(run + ':suffix').repeat(16) + '\n只输出SUM=整数。';
  const b = [...a, { role: 'assistant', content: 'SUM=2080' }, { role: 'user', content: suffix }];
  const changedRows = rows.map((row, i) => i === 0 ? { ...row, value: 1001 } : row);
  const c = [{ role: 'system', content: system }, { role: 'user', content: prompt.replace(JSON.stringify(rows), JSON.stringify(changedRows)) }];
  const d = [{ role: 'system', content: '对照变体：此标识只改变早期前缀，不改变算术要求。\n' + system }, ...a.slice(1)];
  const cases = [
    ['A1_base', a, 2080, 0], ['A2_exact_repeat', a, 2080, 3000], ['A3_exact_repeat', a, 2080, 5000],
    ['B1_append', b, 2080, 3000], ['B2_append_repeat', b, 2080, 3000],
    ['C_early_data_change', c, 3080, 3000], ['D_early_system_change', d, 2080, 3000], ['A4_return_to_base', a, 2080, 5000],
  ].map(([name, messages, expected, wait_ms]) => ({ name, messages, expected, wait_ms }));
  return { settings, providerKey, provider, model, run, projectId, workspace, session, tools, rows, cases };
}
async function main() {
  const plan = prepare();
  const { settings, providerKey, provider, model, session, cases, workspace, projectId } = plan;
  const key = providers.keyFor(providerKey, APP); if (!key) throw new Error('API key unavailable');
  const protocol = providers.usesResponses({ kind: provider.kind, base: provider.base, model }) ? 'responses' : provider.kind;
  const modelURL = endpointURL(provider.base, protocol);
  const overview = { provider: providerKey, protocol, model, planned_calls: cases.length, output_cap_each: MAX_OUTPUT,
    total_input_stop: MAX_INPUT, tools: plan.tools.length, system_chars: cases[0].messages[0].content.length,
    first_request_chars: JSON.stringify({ messages: cases[0].messages, tools: plan.tools }).length, session_id: session.id, project_id: projectId };
  if (!process.argv.includes('--live')) { console.log(JSON.stringify({ live: false, ...overview }, null, 2)); return; }
  fs.mkdirSync(workspace, { recursive: true });
  write(path.join(workspace, 'project.json'), { id: projectId, title: '缓存实践检测', createdAt: session.createdAt, updatedAt: session.createdAt });
  write(path.join(workspace, 'data/records.json'), plan.rows);
  const audit = path.join(APP, 'audit', 'cache-live-2026-11-09-' + plan.run);
  const sessionFile = path.join(APP, 'data/sessions', session.id + '.json');
  const report = { ...overview, started_at: Date.now(), task: 'Sum values 1..64; controlled repeated/append/early-change inputs',
    source_session: '5c452c84af2d', result: [], billing_evidence: 'Not measured by runner; actual charge evidence must be checked independently',
    limits: { max_calls: MAX_CALLS, max_input_tokens: MAX_INPUT, max_output_each: MAX_OUTPUT, timeout_ms: 90000, automatic_retries: false } };
  session.cache_probe = { audit_dir: path.relative(APP, audit).replace(/\\/g, '/'), controlled_replay: true };
  session.messages.push({ role: 'user', content: '受控缓存检测：64个数求和。真实调用现有通道，比较相同请求、末尾追加和早期改写；上限8次，不操作原赛事。' });
  const save = () => { session.updatedAt = Date.now(); write(sessionFile, session); write(path.join(audit, 'results.json'), report); };
  save(); console.log(JSON.stringify({ phase: 'start', ...overview, audit: path.relative(APP, audit) }));
  const originalFetch = global.fetch; let current = null, physicalCalls = 0;
  global.fetch = async (url, init) => {
    if (String(url) !== modelURL) throw Object.assign(new Error('Unexpected endpoint blocked'), { status: 400 });
    if (++physicalCalls > MAX_CALLS) throw Object.assign(new Error('Physical request cap reached'), { status: 400 });
    current.request_bytes = Buffer.byteLength(init.body); current.request_sha256 = sha(init.body);
    const actual = JSON.parse(init.body);
    current.actual_model = actual.model;
    current.messages_sha256 = sha(JSON.stringify(actual.messages || actual.input));
    current.tools_sha256 = sha(JSON.stringify(actual.tools || []));
    const response = await originalFetch(url, init);
    current.header_ms = Date.now() - current.started; current.http_status = response.status;
    return { ok: response.ok, status: response.status, headers: response.headers,
      text: () => response.text(), body: response.body ? observeStream(response.body, current) : null };
  };
  try {
    for (const item of cases) {
      if (session.usage.prompt_tokens >= MAX_INPUT) { report.stop_reason = 'input_budget'; break; }
      const budgetLedger = require('../core/external');
      if (settings.daily_budget > 0 && (budgetLedger.loadLedger(APP).costs?.[budgetLedger.dayKey()] || 0) >= settings.daily_budget) {
        report.stop_reason = 'configured_daily_budget'; break;
      }
      await pause(item.wait_ms);
      current = { name: item.name, started: Date.now(), expected: item.expected, raw_usage_events: [], first_stream_ms: null, first_output_ms: null };
      let response = null, error = null;
      const markFirst = () => { if (current.first_output_ms == null) current.first_output_ms = Date.now() - current.started; };
      try {
        const common = { kind: provider.kind, base: provider.base, key, model, messages: item.messages, tools: plan.tools,
          maxTokens: MAX_OUTPUT, reasoningEffort: 'low', signal: AbortSignal.timeout(90000), onDelta: markFirst, onReason: markFirst,
          cacheDiagnostics: { appDir: APP, session_id: session.id, project_id: projectId, lane: 'main', provider_key: providerKey } };
        if (provider.kind === 'anthropic') { common.system = item.messages[0].content; common.messages = item.messages.slice(1); delete common.reasoningEffort; }
        response = await providers.chatStream(common);
      } catch (caught) { error = caught; }
      current.duration_ms = Date.now() - current.started;
      const usage = response?.usage || error?.usage || null;
      current.normalized_usage = usage;
      current.error = error ? { name: ['Error', 'TimeoutError', 'AbortError', 'TypeError'].includes(error.name) ? error.name : 'other', status: error.status || null, incomplete: !!error.incomplete, truncated: !!error.truncated } : null;
      const answer = /SUM\s*=\s*(\d+)/i.exec(response?.content || '');
      current.answer = answer ? Number(answer[1]) : null;
      current.task_correct = current.answer === item.expected;
      current.finish = response?.finish || null;
      if (usage && Number.isFinite(usage.prompt_tokens)) {
        session.usage.prompt_tokens += usage.prompt_tokens || 0; session.usage.completion_tokens += usage.completion_tokens || 0;
        session.usage.cache_hit_tokens += usage.cache_hit_tokens || 0; session.usage.calls++;
        const estimate = costOf(model, usage, { ...DEFAULT_PRICES, ...(settings.prices || {}) });
        session.usage.cost += estimate;
        require('../core/meter').record(APP, { t: Date.now(), model, kind: 'probe', session_id: session.id, project_id: projectId,
          prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0, cache_hit_tokens: usage.cache_hit_tokens || 0,
          ...(error ? { usage_partial: true } : {}) });
        const external = require('../core/external'), ledger = external.loadLedger(APP), day = external.dayKey();
        ledger.costs = ledger.costs || {}; ledger.costs[day] = +((ledger.costs[day] || 0) + estimate).toFixed(4); external.saveLedger(APP, ledger);
      }
      report.result.push(current);
      session.messages.push({ role: 'assistant', content: item.name + '：HTTP ' + (current.http_status || '未完成') + '，输入' + (usage?.prompt_tokens ?? '未知') + '，缓存' + (usage?.cache_hit_tokens ?? '未知') + '，答案' + (current.answer ?? '未取得') + '。这是受控请求重放记录，不是连续对话的完整出站原文。' });
      save();
      console.log(JSON.stringify({ phase: 'case', name: item.name, http: current.http_status, input: usage?.prompt_tokens, cached: usage?.cache_hit_tokens,
        output: usage?.completion_tokens, raw_usage_events: current.raw_usage_events.length, duration_ms: current.duration_ms, answer: current.answer, correct: current.task_correct, error: current.error }));
      if (error || !usage || usage.prompt_tokens > 50000) { report.stop_reason = error ? 'request_error_no_retry' : 'usage_or_size_guard'; break; }
    }
  } finally { global.fetch = originalFetch; report.completed_at = Date.now(); report.physical_calls = physicalCalls; save(); }
  console.log(JSON.stringify({ phase: 'complete', session_id: session.id, calls: report.physical_calls,
    input: session.usage.prompt_tokens, cached: session.usage.cache_hit_tokens, audit: path.relative(APP, audit) }));
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ error: ['Error', 'TimeoutError', 'AbortError', 'TypeError'].includes(error.name) ? error.name : 'other', status: error.status || null })); process.exitCode = 1; });
module.exports = { selectedUsage, observeStream };
