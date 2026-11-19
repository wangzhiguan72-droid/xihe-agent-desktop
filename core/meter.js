// 计费明细账（v2.6）：把「每次 API 调用用了多少 token」原样记下来，花费**现算**。
//
// 为什么不再在调用时刻把金额固化进 ledger：
//   官方价格会变。旧实现 spend() 里 costOf(...) 一算就把金额写死进账本，价格一改，
//   历史账目永久停在旧价（v2.4 那次「界面估算偏高 2.8×」就是 hit 价记错后无法回溯）。
//   现在只存 token 与调用时刻，金额每次由「记录 × 当前价目表」现算：
//     · 改价 → 历史账自动跟着变（含高峰/空闲时段差异，因为存了 t）
//     · 能按模型/按天/按会话/按项目分组
//     · 一条记录 ~120 字节，一天几千次调用也就几百 KB
//
// 口径：usage 是提供商官方计量（最准的「用量」）；账户余额差是「实扣」。
// 两者本应一致，差额暴露缓存计价/计量口径问题——所以 UI 保留双数，不是冗余。
'use strict';
const fs = require('fs');
const path = require('path');
const { costOf, DEFAULT_PRICES } = require('./pricing');

function meterDir(appDir) { return path.join(appDir, 'data', 'meter'); }
function meterFile(appDir, day) { return path.join(meterDir(appDir), day + '.jsonl'); }
// 本地日期（与 external.dayKey 同口径：按用户本地时区分天，不按 UTC）
function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 记一条调用明细。绝不抛：记账失败不能拖垮一轮对话（调用方在热路径上）。
function record(appDir, rec) {
  try {
    const day = localDay(rec.t || Date.now());
    fs.mkdirSync(meterDir(appDir), { recursive: true });
    fs.appendFileSync(meterFile(appDir, day), JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

// 列出 [from, to] 覆盖的日文件（闭区间，'YYYY-MM-DD'；缺省=全部）
function dayFiles(appDir, from, to) {
  let names;
  try { names = fs.readdirSync(meterDir(appDir)); } catch { return []; }
  return names.filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .map(n => n.slice(0, 10))
    .filter(d => (!from || d >= from) && (!to || d <= to))
    .sort();
}

// 读明细（可选按 from/to 日过滤）。坏行跳过而不是整文件失败——半行写入不该毁掉整月账单。
function readRecords(appDir, opts = {}) {
  const out = [];
  for (const day of dayFiles(appDir, opts.from, opts.to)) {
    let txt;
    try { txt = fs.readFileSync(meterFile(appDir, day), 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

// 汇总：按当前价目表现算。未识别模型回落到 pricing 的兜底价（不是 0——0 会让用户以为免费）。
function meterSummary(appDir, opts = {}) {
  const prices = opts.prices || DEFAULT_PRICES;
  const recs = readRecords(appDir, opts).filter(r =>
    (!opts.model || r.model === opts.model) &&
    (!opts.project_id || r.project_id === opts.project_id) &&
    (!opts.session_id || r.session_id === opts.session_id));
  const acc = { total: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0, byModel: {}, byDay: {}, byKind: {} };
  for (const r of recs) {
    const at = r.t || 0;
    const c = costOf(r.model, r, prices, at);
    const day = localDay(at);
    acc.total += c;
    acc.calls += 1;
    acc.prompt_tokens += r.prompt_tokens || 0;
    acc.completion_tokens += r.completion_tokens || 0;
    acc.cache_hit_tokens += r.cache_hit_tokens || 0;
    const m = acc.byModel[r.model] = acc.byModel[r.model] || { cost: 0, calls: 0, prompt_tokens: 0, completion_tokens: 0, cache_hit_tokens: 0 };
    m.cost += c; m.calls += 1;
    m.prompt_tokens += r.prompt_tokens || 0; m.completion_tokens += r.completion_tokens || 0; m.cache_hit_tokens += r.cache_hit_tokens || 0;
    const d = acc.byDay[day] = acc.byDay[day] || { cost: 0, calls: 0 };
    d.cost += c; d.calls += 1;
    const k = acc.byKind[r.kind || 'main'] = acc.byKind[r.kind || 'main'] || { cost: 0, calls: 0 };
    k.cost += c; k.calls += 1;
  }
  for (const key of ['byModel', 'byDay', 'byKind']) {
    for (const v of Object.values(acc[key])) v.cost = +v.cost.toFixed(6);
  }
  acc.total = +acc.total.toFixed(6);
  return acc;
}

function validUsageRecord(r, now) {
  return !!r && typeof r === 'object' && !Array.isArray(r) &&
    Number.isSafeInteger(r.t) && r.t > 0 && r.t <= now &&
    typeof r.model === 'string' && r.model.length > 0 && r.model.length <= 200 &&
    Number.isSafeInteger(r.prompt_tokens) && r.prompt_tokens >= 0 &&
    Number.isSafeInteger(r.completion_tokens) && r.completion_tokens >= 0 &&
    Number.isSafeInteger(r.prompt_tokens + r.completion_tokens) &&
    (r.cache_hit_tokens == null || (Number.isSafeInteger(r.cache_hit_tokens) && r.cache_hit_tokens >= 0)) &&
    (r.project_id == null || (typeof r.project_id === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(r.project_id)));
}

// 旧版仅保存 session.usage，没有每次调用日期。只恢复未被 meter 覆盖的差值，
// 归入未分期累计，不伪造周/月日期、模型或主/子调用分布。
function usageHistory(appDir, records, persist = false) {
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const fields = ['prompt_tokens', 'completion_tokens', 'calls'];
  const detail = new Map();
  for (const r of records) {
    if (typeof r.session_id !== 'string') continue;
    const row = detail.get(r.session_id) || { prompt_tokens: 0, completion_tokens: 0, calls: 0 };
    row.prompt_tokens += r.prompt_tokens; row.completion_tokens += r.completion_tokens; row.calls++;
    detail.set(r.session_id, row);
  }
  const historyFile = path.join(appDir, 'data', 'usage-history.json');
  const rows = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    if (saved.version === 1 && Array.isArray(saved.sessions)) for (const row of saved.sessions) {
      if (row && typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.id))
        rows.set(row.id, { id: row.id, project_id: typeof row.project_id === 'string' ? row.project_id : null,
          ...Object.fromEntries(fields.map(f => [f, count(row[f])])) });
    }
  } catch {}
  for (const subdir of ['sessions', 'trash']) {
    const dir = path.join(appDir, 'data', subdir);
    let files = [];
    try { files = fs.readdirSync(dir).filter(n => subdir === 'sessions' ? /^[A-Za-z0-9_-]{1,64}\.json$/.test(n) : /^session_\d+_[A-Za-z0-9_-]+\.json$/.test(n)); } catch {}
    for (const file of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (!s || !s.usage || typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.id)) continue;
        const covered = detail.get(s.id) || {};
        const old = rows.get(s.id);
        const row = { id: s.id, project_id: old ? old.project_id : (/^[A-Za-z0-9_-]{1,48}$/.test(s.project_id || '') ? s.project_id : null) };
        for (const f of fields) row[f] = Math.max(count(old && old[f]), count(s.usage[f]) - count(covered[f]), 0);
        if (row.prompt_tokens + row.completion_tokens > 0 || row.calls > 0) rows.set(s.id, row);
      } catch { /* 损坏会话不妨碍其余历史恢复 */ }
    }
  }
  const values = [...rows.values()];
  if (persist && values.length) {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    const temp = historyFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ version: 1, sessions: values }, null, 2));
    fs.renameSync(temp, historyFile);
  }
  return values;
}
function captureUsageHistory(appDir) {
  return usageHistory(appDir, readRecords(appDir).filter(r => validUsageRecord(r, Date.now())), true);
}

// 全项目 Token 用量。每条 meter 记录就是一次真实调用；session.usage 是这些调用的
// 派生累计值，不能再叠加。缓存命中属于 prompt_tokens 的子集。
function usageStats(appDir, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const period = ['week', 'month', 'all'].includes(opts.period) ? opts.period : 'week';
  const today = new Date(now);
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  const totals = { week: { tokens: 0, calls: 0 }, month: { tokens: 0, calls: 0 }, all: { tokens: 0, calls: 0 } };
  const byDay = new Map();
  const byModel = new Map();
  const byProject = new Map();
  let first = Infinity;
  const add = (map, key, field, tokens) => {
    const row = map.get(key) || { [field]: key, tokens: 0, calls: 0 };
    row.tokens += tokens; row.calls += 1;
    map.set(key, row);
  };
  const records = readRecords(appDir).filter(r => validUsageRecord(r, now));
  for (const r of records) {
    const tokens = r.prompt_tokens + r.completion_tokens;
    if (!Number.isSafeInteger(tokens)) continue;
    first = Math.min(first, r.t);
    totals.all.tokens += tokens; totals.all.calls += 1;
    if (r.t >= monthStart) { totals.month.tokens += tokens; totals.month.calls += 1; }
    if (r.t >= weekStart.getTime()) { totals.week.tokens += tokens; totals.week.calls += 1; }
    const selectedStart = period === 'week' ? weekStart.getTime() : period === 'month' ? monthStart : 0;
    if (r.t < selectedStart) continue;
    add(byDay, localDay(r.t), 'day', tokens);
    add(byModel, r.model, 'model', tokens);
    add(byProject, r.project_id || null, 'project_id', tokens);
  }
  const coverage = { detailed_tokens: totals.all.tokens, detailed_calls: totals.all.calls, legacy_tokens: 0, legacy_calls: 0, legacy_sessions: 0 };
  for (const row of usageHistory(appDir, records)) {
    const tokens = row.prompt_tokens + row.completion_tokens;
    coverage.legacy_tokens += tokens; coverage.legacy_calls += row.calls; coverage.legacy_sessions++;
    totals.all.tokens += tokens; totals.all.calls += row.calls;
    if (period === 'all') {
      for (const [map, key, field] of [[byProject, row.project_id, 'project_id'], [byModel, '历史用量（未记录模型）', 'model']]) {
        const value = map.get(key) || { [field]: key, tokens: 0, calls: 0 };
        value.tokens += tokens; value.calls += row.calls; map.set(key, value);
      }
    }
  }
  const trend = [];
  const start = period === 'week' ? weekStart.getTime() : period === 'month' ? monthStart : first;
  if (Number.isFinite(start)) {
    const day = new Date(start);
    day.setHours(0, 0, 0, 0);
    for (; day.getTime() <= now; day.setDate(day.getDate() + 1)) {
      const key = localDay(day.getTime());
      trend.push(byDay.get(key) || { day: key, tokens: 0, calls: 0 });
    }
  }
  const sortRows = rows => [...rows.values()].sort((a, b) => b.tokens - a.tokens || String(a.model || a.project_id || '').localeCompare(String(b.model || b.project_id || '')));
  return { period, asOf: now, totals, coverage, trend, byModel: sortRows(byModel), byProject: sortRows(byProject) };
}

// 用当前价格表重算 ledger.costs（设置页「按当前价格重算历史账」按钮）。
// 只覆盖 meter 有记录的日期；更早的日期（明细机制上线前）保留原值——宁可留旧数也不清零。
function resummarize(appDir, opts = {}) {
  const prices = opts.prices || DEFAULT_PRICES;
  const byDay = meterSummary(appDir, { prices }).byDay;
  const { loadLedger, saveLedger } = require('./external');
  const ledger = loadLedger(appDir);
  ledger.costs = ledger.costs || {};
  let changed = 0;
  for (const [day, v] of Object.entries(byDay)) {
    const nv = +v.cost.toFixed(4);
    if (ledger.costs[day] !== nv) { ledger.costs[day] = nv; changed += 1; }
  }
  saveLedger(appDir, ledger);
  return { days: Object.keys(byDay).length, changed };
}

module.exports = { record, readRecords, meterSummary, usageStats, captureUsageHistory, resummarize, localDay, meterDir, meterFile };
