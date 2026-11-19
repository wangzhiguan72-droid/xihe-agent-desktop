// deep_tree 成本—精度证据审计离线测试。
'use strict';
const { executeTool } = require('./tools');
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS', name); }
  catch (e) { fail++; console.log('FAIL', name, '->', e.message); }
}
function ctx() {
  return { session: {
    effort: 'deep', data_epoch: 0, usage: { cost: 1.23 },
    deep_tree: { at: Date.now(), candidates: [], selected: null, results: [] },
    runs: [
      { run_id: 'runA', ok: true, formal: true, epoch: 0, unstable: false, ms: 212000, boundary_mode: 'tail_mean', out: '{"MAPE":6.9}' },
      { run_id: 'runB', ok: true, formal: true, epoch: 0, unstable: false, ms: 140000, boundary_mode: 'tail_mean', out: '{"MAPE":9.1}' },
      { run_id: 'runC', ok: true, formal: true, epoch: 0, unstable: false, ms: 61000, boundary_mode: 'tail_mean', out: '{"MAPE":8.2}' },
      { run_id: 'runOld', ok: true, formal: true, epoch: 1, unstable: false, ms: 1000, boundary_mode: 'tail_mean', out: 'MAPE 1' },
    ],
  } };
}
(async () => {
  await t('方案树：同口径正式run支撑下按 err+墙钟判断支配', async () => {
    const c = ctx();
    for (const [id, value, run] of [['A', 6.9, 'runA'], ['B', 9.1, 'runB'], ['C', 8.2, 'runC']]) {
      const r = await executeTool(c, 'deep_tree', { op: 'result', id, note: id + ' 实测', err: { metric: 'MAPE', value }, evidence_run_id: run, measurement_key: 'MAPE', comparison: {question_id: 1, dataset: 'held-out-v1', protocol: '逐点MAPE', unit: '%', direction: 'min'} });
      if (!r.ok) throw new Error(id + ': ' + r.error);
      if (id === 'C') {
        if (!/B[\s\S]*被 C 支配/.test(r.data)) throw new Error('B 未被 C 支配: ' + r.data);
        if (!/费用只有会话级累计/.test(r.data)) throw new Error('成本口径未声明');
      }
    }
    const view = await executeTool(c, 'deep_tree', { op: 'view' });
    if (!/成本-精度审计/.test(view.data) || !/boundary_mode=tail_mean/.test(view.data)) throw new Error('view 未渲染同口径审计');
  });

  await t('方案树：旧epoch、非formal、缺run出处都拒绝', async () => {
    const c = ctx();
    let oldDenied = false;
    try { await executeTool(c, 'deep_tree', { op: 'result', id: 'D', note: '旧证据', err: { metric: 'MAPE', value: 1 }, evidence_run_id: 'runOld' }); }
    catch (e) { oldDenied = /旧数据版本/.test(e.message); }
    if (!oldDenied) throw new Error('旧 epoch 未拒绝');
    c.session.runs[0].formal = false;
    let informalDenied = false;
    try { await executeTool(c, 'deep_tree', { op: 'result', id: 'A', note: '非正式', err: { metric: 'MAPE', value: 6.9 }, evidence_run_id: 'runA' }); }
    catch (e) { informalDenied = /不是正式运行/.test(e.message); }
    if (!informalDenied) throw new Error('非 formal 未拒绝');
    let noRun = false;
    try { await executeTool(c, 'deep_tree', { op: 'result', id: 'A', note: '无出处', err: { metric: 'MAPE', value: 6.9 } }); }
    catch (e) { noRun = /evidence_run_id/.test(e.message); }
    if (!noRun) throw new Error('缺 run 出处未拒绝');
  });

  await t('方案树：旧版只写note的实测记录保持兼容', async () => {
    const c = ctx();
    const r = await executeTool(c, 'deep_tree', { op: 'result', id: 'legacy', note: '只记文字，不参与支配审计' });
    if (!r.ok || !/legacy 待验证/.test(r.data)) throw new Error(String(r.data || r.error));
  });
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
