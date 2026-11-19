// 极致模式动态子代理池：仅编排进程内 runSubagent，不改变主工具循环的串行语义。
'use strict';
const modes = require('./modes');
const { bounded, formatHandoff } = require('./handoff');

const MAX_CONCURRENT = 3;
const HARD_CAP = 12;

function recoverPool(session) {
  let changed = !!session.pool_active;
  session.pool_active = 0;
  for (const row of session.pool_tasks || []) {
    if (!['running', 'queued'].includes(row.status)) continue;
    row.status = 'interrupted'; row.finished_at = Date.now();
    row.error = '服务重启，原任务已中断；核查已有产物后再决定是否重跑，禁止自动重放副作用。';
    changed = true;
  }
  return changed;
}

function emitPool(ctx) {
  const s = ctx.session;
  if (ctx.emit) ctx.emit({
    t: 'crew', active: s.pool_active || 0, dispatched: s.pool_dispatched || 0,
    cap: HARD_CAP, fixed: 3,
  });
}

async function runPool(ctx, tasks, batchMeta = {}) {
  if (!modes.isExtreme(ctx.session)) throw new Error('动态子代理池仅在 extreme 档可用');
  if (!ctx.engines || typeof ctx.engines.subagent !== 'function') throw new Error('子代理引擎不可用');
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('tasks 不能为空；按需摊派，没有独立任务时不要开池');
  const s = ctx.session;
  const already = s.pool_dispatched || 0;
  if (already + tasks.length > HARD_CAP) {
    throw new Error(`本会话动态池硬上限 ${HARD_CAP} 个，已派 ${already} 个，本批 ${tasks.length} 个超限；先收敛既有产出，不要为凑数量派活。`);
  }
  const clean = tasks.map((t, i) => {
    const crew = String((t && t.crew) || '').trim();
    if (!modes.CREW[crew] && !['red', 'reviewer'].includes(crew)) throw new Error(`tasks[${i}].crew 必须是 modeler/coder/writer/red/reviewer`);
    const prompt = String((t && t.prompt) || '').trim();
    if (!prompt) throw new Error(`tasks[${i}].prompt 必填`);
    return { ...t, crew, prompt };
  });
  const base = already;
  s.pool_dispatched = already + clean.length; // 预留总量席位，异常终止也如实计入已摊派任务
  s.pool_active = s.pool_active || 0;
  s.pool_tasks = s.pool_tasks || [];
  const rows = clean.map((t, i) => ({ task_id: 'p' + (base + i + 1) + '_', crew: t.crew,
    purpose: bounded(t.why || batchMeta.why || t.prompt, 400), status: 'queued',
    acceptance: 'pending', created_at: Date.now() }));
  s.pool_tasks.push(...rows);
  const persist = () => {
    try { if (ctx.deps && typeof ctx.deps.persist === 'function') ctx.deps.persist(s); }
    catch (e) { if (ctx.emit) ctx.emit({ t: 'warn', msg: '池状态存档失败：' + String(e.message || e).slice(0, 200) }); }
  };
  const stopped = () => !!((ctx.deps && ctx.deps.stopper && ctx.deps.stopper.stop)
    || (ctx.abort && ctx.abort.signal && ctx.abort.signal.aborted));
  persist();
  const results = new Array(clean.length);
  // 当前子任务共用工作区：写任务独占，纯读取任务可并行，避免读到半写产物。
  let barrier = Promise.resolve();
  const readers = new Set();
  function reserveAccess(crew) {
    let release;
    const done = new Promise(resolve => { release = resolve; });
    const previous = barrier;
    if (['coder', 'writer', 'red'].includes(crew)) {
      const ready = Promise.all([previous, ...readers]);
      barrier = done;
      return { ready, release };
    }
    readers.add(done);
    return { ready: previous, release: () => { readers.delete(done); release(); } };
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, clean.length) }, async () => {
    while (cursor < clean.length) {
      const i = cursor++;
      const t = clean[i];
      const number = base + i + 1;
      const taskPrefix = 'p' + number + '_';
      const row = rows[i];
      const access = reserveAccess(t.crew);
      await access.ready;
      if (stopped()) {
        row.status = 'cancelled'; row.finished_at = Date.now();
        results[i] = { crew: t.crew, taskPrefix, error: '用户已停止，排队任务未启动' };
        access.release(); persist(); continue;
      }
      row.status = 'running'; row.started_at = Date.now(); persist();
      s.pool_active++;
      emitPool(ctx);
      try {
        const profile = t.crew === 'red' ? 'redteam' : t.crew === 'reviewer' ? 'reviewer' : 'worker';
        const meta = {
          ...batchMeta, ...t, taskPrefix, returnHandoff: true,
          crew: modes.CREW[t.crew] ? t.crew : undefined,
          why: t.why || batchMeta.why || '',
        };
        const report = await ctx.engines.subagent(profile, t.prompt, meta);
        const handoff = report && typeof report === 'object' && !Array.isArray(report) ? report : {
          status: 'unverified', acceptance: 'pending', summary: bounded(report), child_run_ids: [],
          archive: null, warnings: ['引擎未返回结构化执行状态，报告尚未验证。'],
        };
        row.status = ['completed', 'failed', 'cancelled', 'unverified'].includes(handoff.status) ? handoff.status : 'unverified';
        row.handoff = handoff;
        results[i] = { crew: t.crew, taskPrefix, report: formatHandoff(handoff) };
      } catch (e) {
        row.status = 'failed'; row.error = String(e.message || e).slice(0, 400);
        results[i] = { crew: t.crew, taskPrefix, error: String(e.message || e).slice(0, 400) };
      } finally {
        row.finished_at = Date.now();
        s.pool_active--;
        access.release();
        emitPool(ctx);
        persist();
      }
    }
  });
  await Promise.all(workers);
  const lines = [`[动态子代理池] 本批 ${clean.length} 个，最多 ${MAX_CONCURRENT} 并发；会话累计 ${s.pool_dispatched}/${HARD_CAP}。`];
  results.forEach((r, i) => {
    lines.push(`\n===== ${r.taskPrefix} ${r.crew} =====`);
    lines.push(r.error ? `[异常] ${r.error}` : r.report);
  });
  return lines.join('\n');
}

module.exports = { runPool, recoverPool, MAX_CONCURRENT, HARD_CAP };
