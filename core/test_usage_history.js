'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const meter = require('./meter');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-history-'));
const sessions = path.join(dir, 'data', 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const file = path.join(sessions, 'old.json');
function save(input, output, calls) {
  fs.writeFileSync(file, JSON.stringify({ id: 'old', project_id: 'legacy', createdAt: 1700000000000, updatedAt: 1700000000001,
    usage: { prompt_tokens: input, completion_tokens: output, cache_hit_tokens: 80, calls } }));
}
try {
  save(100, 20, 2);
  let stats = meter.usageStats(dir, { period: 'all' });
  assert.equal(stats.totals.all.tokens, 120, 'historical sessions without meter must appear in cumulative');
  assert.equal(stats.totals.week.tokens, 0, 'unknown historical dates must not be invented');
  assert.equal(stats.coverage.legacy_tokens, 120);
  assert.equal(stats.byProject[0].project_id, 'legacy');
  assert.equal(stats.trend.length, 0);
  meter.captureUsageHistory(dir);
  meter.record(dir, { t: Date.now() - 1000, session_id: 'old', project_id: 'legacy', model: 'new-model', prompt_tokens: 30, completion_tokens: 5 });
  save(130, 25, 3);
  stats = meter.usageStats(dir, { period: 'all' });
  assert.equal(stats.totals.all.tokens, 155, 'new detailed calls must not double count old cumulative');
  assert.equal(stats.totals.all.calls, 3);
  assert.equal(stats.coverage.legacy_tokens, 120);
  meter.captureUsageHistory(dir);
  fs.unlinkSync(file);
  assert.equal(meter.usageStats(dir).totals.all.tokens, 155, 'deletion must preserve captured legacy total');
  // Partial meter already existed before migration: only restore its missing difference.
  const partial = path.join(sessions, 'partial.json');
  fs.writeFileSync(partial, JSON.stringify({ id: 'partial', project_id: 'legacy', usage: { prompt_tokens: 60, completion_tokens: 10, calls: 2 } }));
  meter.record(dir, { t: Date.now() - 1000, session_id: 'partial', project_id: 'legacy', model: 'new-model', prompt_tokens: 20, completion_tokens: 3 });
  assert.equal(meter.usageStats(dir).totals.all.tokens, 225);
  assert.equal(meter.usageStats(dir).coverage.legacy_tokens, 167);
  // Trash duplicate is the same session, never another copy of the usage.
  const trash = path.join(dir, 'data', 'trash'); fs.mkdirSync(trash);
  fs.copyFileSync(partial, path.join(trash, 'session_1700000000000_partial.json'));
  assert.equal(meter.usageStats(dir).totals.all.tokens, 225);
  console.log('PASS legacy recovery, partial-meter reconciliation, undated coverage and deletion persistence');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
