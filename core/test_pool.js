// 动态池离线测试：假子代理验证并发/上限/档位，不调用 API。
'use strict';
const { runPool, MAX_CONCURRENT, HARD_CAP } = require('./pool');
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '->', e.message); }
}
(async () => {
  await t('重启将残留池任务标为中断，不自动重放副作用', async () => {
    const { recoverPool } = require('./pool');
    const s = { pool_active: 2, pool_dispatched: 3, pool_tasks: [{ status: 'running' }, { status: 'queued' }, { status: 'completed' }] };
    if (!recoverPool(s)) throw new Error('未执行恢复');
    if (s.pool_active !== 0 || s.pool_dispatched !== 3) throw new Error('恢复改错计数');
    if (s.pool_tasks[0].status !== 'interrupted' || s.pool_tasks[1].status !== 'interrupted' || s.pool_tasks[2].status !== 'completed') throw new Error('恢复状态不正确');
    if (recoverPool(s)) throw new Error('恢复不幂等');
    const block = require('./agent').stateBlock({ ...s, pool_tasks: [{ task_id: 'p1_', crew: 'coder', status: 'interrupted', acceptance: 'pending' }] });
    if (!/p1_.*interrupted/.test(block)) throw new Error('主脑恢复上下文缺少池任务状态');
  });
  await t('动态池：最多3并发，保留任务前缀与报告', async () => {
    let active = 0, peak = 0;
    const events = [];
    const ctx = {
      session: { effort: 'extreme' }, emit: e => events.push(e),
      engines: { subagent: async (profile, prompt, meta) => {
        active++; peak = Math.max(peak, active);
        await new Promise(r => setTimeout(r, 25));
        active--;
        return `${meta.taskPrefix}:${profile}:${meta.crew || 'none'}:${prompt}`;
      } },
    };
    const tasks = Array.from({ length: 7 }, (_, i) => ({ crew: i % 2 ? 'reviewer' : 'modeler', prompt: 'task' + i }));
    const out = await runPool(ctx, tasks);
    if (peak > MAX_CONCURRENT || peak < 2) throw new Error('并发控制异常 peak=' + peak);
    if (ctx.session.pool_dispatched !== 7 || ctx.session.pool_active !== 0) throw new Error('池计数未收口');
    if (!/p7_/.test(out) || !/本批 7 个/.test(out)) throw new Error('报告缺前缀或汇总');
    if (!events.some(e => e.t === 'crew')) throw new Error('没有 crew 状态事件');
  });

  await t('动态池：12个总量硬上限在派活前拒绝', async () => {
    let calls = 0;
    const ctx = { session: { effort: 'extreme', pool_dispatched: HARD_CAP - 1 }, engines: { subagent: async () => { calls++; } } };
    let denied = false;
    try { await runPool(ctx, [{ crew: 'coder', prompt: 'a' }, { crew: 'coder', prompt: 'b' }]); }
    catch (e) { denied = /硬上限/.test(e.message); }
    if (!denied || calls !== 0) throw new Error('超限任务仍被派发');
  });

  await t('动态池：deep/fast 不可开池，未知职责失效关闭', async () => {
    const ctx = { session: { effort: 'deep' }, engines: { subagent: async () => 'x' } };
    let tierDenied = false;
    try { await runPool(ctx, [{ crew: 'coder', prompt: 'a' }]); } catch (e) { tierDenied = /extreme/.test(e.message); }
    if (!tierDenied) throw new Error('deep 竟能开池');
    ctx.session.effort = 'extreme';
    let roleDenied = false;
    try { await runPool(ctx, [{ crew: 'unknown', prompt: 'a' }]); } catch (e) { roleDenied = /crew/.test(e.message); }
    if (!roleDenied) throw new Error('未知职责未拒绝');
  });
  await t('预算预警逐档降级，100%硬顶仍熔断', async () => {
    const { budgetCheck } = require('./agent');
    const { dayKey } = require('./external');
    const session = { effort: 'extreme' };
    const deps = { settings: { daily_budget: 100 }, ledger: { costs: { [dayKey()]: 75 } } };
    const events = [];
    if (!budgetCheck(session, deps, e => events.push(e)) || session.effort !== 'deep') throw new Error('75%未从extreme降deep');
    if (!session.effort_downgrade || session.system_effort) throw new Error('降档留痕或system_effort语义错误');
    deps.ledger.costs[dayKey()] = 90;
    if (!budgetCheck(session, deps, e => events.push(e)) || session.effort !== 'fast') throw new Error('90%未从deep降fast');
    deps.ledger.costs[dayKey()] = 100;
    if (budgetCheck(session, deps, e => events.push(e))) throw new Error('100%硬顶被降档绕过');
  });
  await t('动态池：取消后不再派发排队任务，保存每项生命周期', async () => {
    const stopper = { stop: false }; let calls = 0;
    const ctx = { session: { effort: 'extreme' }, deps: { stopper }, engines: { subagent: async () => {
      calls++; stopper.stop = true;
      return { status: 'completed', acceptance: 'pending', summary: '结果待验收', child_run_ids: ['subrun1'] };
    } } };
    await runPool(ctx, Array.from({ length: 6 }, () => ({ crew: 'coder', prompt: '局部试验' })));
    if (calls > MAX_CONCURRENT) throw new Error('停止后仍派发排队任务');
    if (!ctx.session.pool_tasks || ctx.session.pool_tasks.length !== 6) throw new Error('缺少持久任务状态');
    if (!ctx.session.pool_tasks.some(x => x.status === 'cancelled')) throw new Error('排队取消未记录');
    if (ctx.session.pool_active !== 0) throw new Error('active未清零');
  });
  await t('动态池：未知状态长文本标为未验证且不淹没主脑', async () => {
    const ctx = { session: { effort: 'extreme' }, engines: { subagent: async () => '已完成'.repeat(20000) } };
    const out = await runPool(ctx, [{ crew: 'coder', prompt: 'a' }]);
    if (out.length > 4000) throw new Error('长报告直接回灌');
    if (ctx.session.pool_tasks[0].status !== 'unverified') throw new Error('未知引擎状态被当完成');
  });
  await t('动态池：共享工作区写任务串行，避免互相覆盖', async () => {
    let writes = 0, peak = 0;
    const ctx = { session: { effort: 'extreme' }, engines: { subagent: async () => {
      writes++; peak = Math.max(peak, writes); await new Promise(r => setTimeout(r, 15)); writes--;
      return { status: 'completed', acceptance: 'pending', summary: 'done' };
    } } };
    await runPool(ctx, ['coder', 'writer', 'coder'].map(crew => ({ crew, prompt: '独立写任务' })));
    if (peak !== 1) throw new Error('共享工作区存在并发写任务 peak=' + peak);
  });
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
