'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const meter = require('./meter');

function at(y, m, d, h = 12) { return new Date(y, m - 1, d, h).getTime(); }
function write(appDir, rec) { assert(meter.record(appDir, rec)); }
function usage(project_id, model, t, prompt_tokens, completion_tokens, extra = {}) {
  return { project_id, model, t, prompt_tokens, completion_tokens, cache_hit_tokens: 0, kind: 'main', ...extra };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-usage-'));
try {
  const now = at(2026, 10, 20, 18); // Tuesday; local calendar boundaries are intentional.
  write(dir, usage('alpha', 'model-a', at(2026, 9, 30), 7, 0));
  write(dir, usage('alpha', 'model-a', at(2026, 10, 1), 10, 2));
  write(dir, usage('alpha', 'model-a', at(2026, 10, 18), 20, 3)); // Sunday: month, not week.
  write(dir, usage('alpha', 'model-a', at(2026, 10, 19, 0), 100, 10, { cache_hit_tokens: 80 }));
  write(dir, usage('beta', 'model-b', at(2026, 10, 20), 50, 5, { kind: 'subagent', session_id: 'child' }));
  write(dir, usage('beta', 'model-b', at(2026, 10, 20, 13), 30, 2, { kind: 'subagent', session_id: 'child' }));
  write(dir, usage('beta', 'model-b', at(2026, 10, 21), 999, 0)); // Future records do not count.
  const file = meter.meterFile(dir, meter.localDay(now));
  fs.appendFileSync(file, '{bad json\n' + JSON.stringify({ t: now, model: 'model-a', project_id: 'alpha', prompt_tokens: -1, completion_tokens: 10 }) + '\n' + JSON.stringify({ t: 'not-a-date', model: 'model-a', project_id: 'alpha', prompt_tokens: 8, completion_tokens: 1 }) + '\n');

  const week = meter.usageStats(dir, { now, period: 'week' });
  assert.deepStrictEqual(week.totals, { week: { tokens: 197, calls: 3 }, month: { tokens: 232, calls: 5 }, all: { tokens: 239, calls: 6 } });
  assert.deepStrictEqual(week.byProject, [{ project_id: 'alpha', tokens: 110, calls: 1 }, { project_id: 'beta', tokens: 87, calls: 2 }]);
  assert.deepStrictEqual(week.byModel, [{ model: 'model-a', tokens: 110, calls: 1 }, { model: 'model-b', tokens: 87, calls: 2 }]);
  assert.deepStrictEqual(week.trend, [{ day: '2026-10-19', tokens: 110, calls: 1 }, { day: '2026-10-20', tokens: 87, calls: 2 }]);
  assert.equal(week.totals.week.tokens, 100 + 10 + 50 + 5 + 30 + 2, 'cache hits are included in prompt tokens');

  const month = meter.usageStats(dir, { now, period: 'month' });
  assert.equal(month.trend[0].day, '2026-10-01');
  assert.equal(month.trend.at(-1).day, '2026-10-20');
  assert.equal(month.byProject.find(p => p.project_id === 'alpha').tokens, 145);
  assert.equal(meter.usageStats(dir, { now, period: 'all' }).byProject.find(p => p.project_id === 'alpha').tokens, 152);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-usage-empty-'));
  try {
    const stats = meter.usageStats(empty, { now, period: 'week' });
    assert.deepStrictEqual(stats.totals, { week: { tokens: 0, calls: 0 }, month: { tokens: 0, calls: 0 }, all: { tokens: 0, calls: 0 } });
    assert.deepStrictEqual(stats.byModel, []);
    assert.deepStrictEqual(stats.byProject, []);
    assert.deepStrictEqual(stats.trend, [{ day: '2026-10-19', tokens: 0, calls: 0 }, { day: '2026-10-20', tokens: 0, calls: 0 }]);
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }

  const boundary = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-usage-boundary-'));
  try {
    const janNow = at(2027, 1, 5);
    write(boundary, usage(null, 'legacy-model', at(2026, 12, 31), 4, 1));
    write(boundary, usage('new-year', 'model-c', at(2027, 1, 1), 6, 2));
    write(boundary, usage('new-year', 'model-c', at(2027, 1, 4), 3, 1));
    const bad = [null, 23, 'text', [], { t: janNow, model: 'bad', prompt_tokens: 1.5, completion_tokens: 0 },
      { t: janNow, model: 'bad', prompt_tokens: '10', completion_tokens: 0 },
      { t: janNow, model: 'bad', prompt_tokens: 1, completion_tokens: -1 },
      { t: janNow, model: 'bad', prompt_tokens: 1, completion_tokens: 1, project_id: '../bad' }];
    fs.appendFileSync(meter.meterFile(boundary, meter.localDay(janNow)), bad.map(JSON.stringify).join('\n') + '\n');
    const stats = meter.usageStats(boundary, { now: janNow, period: 'month' });
    assert.deepStrictEqual(stats.totals, { week: { tokens: 4, calls: 1 }, month: { tokens: 12, calls: 2 }, all: { tokens: 17, calls: 3 } });
    assert.equal(stats.trend[0].day, '2027-01-01');
    assert.equal(stats.trend.at(-1).day, '2027-01-05');
    assert.deepStrictEqual(meter.usageStats(boundary, { now: janNow, period: 'all' }).byProject.find(p => p.project_id === null), { project_id: null, tokens: 5, calls: 1 });
  } finally { fs.rmSync(boundary, { recursive: true, force: true }); }
  console.log('PASS usage stats');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
