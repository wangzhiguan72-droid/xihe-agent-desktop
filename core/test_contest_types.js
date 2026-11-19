'use strict';
const assert = require('assert/strict');
const { questionTypeChecks, TOOLS } = require('./tools');

const session = out => ({ runs: [{ run_id: 'run1', out }] });
const q = (type, method, desc = '') => ({ id: 1, type, experiments: ['run1'], experiments_desc: [desc],
  conventions: type === 'statistics' ? { statistics_method: method } : { prediction_structure: method } });

assert.match(questionTypeChecks(session(''), q('statistics', null)).join(' '), /方法/);
assert.match(questionTypeChecks(session(''), q('statistics', 'exact', '精确二项解析计算')).join(' '), /校验/);
assert.deepEqual(questionTypeChecks(session('概率和=1.000000，精确枚举与二项公式一致'), q('statistics', 'exact', '精确二项概率')), []);
assert(!/种子|均值±标准差/.test(questionTypeChecks(session('概率和=1.000000，精确枚举与二项公式一致'), q('statistics', 'exact')).join(' ')));
assert.match(questionTypeChecks(session(''), q('statistics', 'stochastic')).join(' '), /种子/);
assert.deepEqual(questionTypeChecks(session('seed=42，独立重复 30 次，均值=0.53，标准差=0.02'), q('statistics', 'stochastic', '蒙特卡洛抽样')), []);
assert.deepEqual(questionTypeChecks(session('分层抽样划分，训练集拟合 scaler，测试集误差=0.12'), q('prediction', 'cross_sectional', '非时序分类')), []);
assert.match(questionTypeChecks(session('按随机打乱顺序划分，测试误差=0.12'), q('prediction', 'time_series')).join(' '), /随机打乱/);
assert.deepEqual(questionTypeChecks(session('按时间顺序切分训练测试，测试误差=0.12'), q('prediction', 'time_series')), []);
const graph = TOOLS.find(t => t.name === 'question_graph');
for (const narrative of ['不可行', 'feasible:false', 'optimal, gap=0', 'slack=0']) {
  assert.match(questionTypeChecks(session(narrative), q('optimization', null, narrative)).join(' '), /正式结果|实算核验/,
    'status words are never feasibility evidence');
}
(async () => {
  const ctx = { session: { question_graph: [] } };
  await graph.run(ctx, { op: 'upsert', id: 1, type: 'statistics', conventions: { statistics_method: 'exact' } });
  assert.equal(ctx.session.question_graph[0].conventions.statistics_method, 'exact', 'tool input must persist method');
  await graph.run(ctx, { op: 'upsert', id: 2, type: 'prediction', conventions: { prediction_structure: 'cross_sectional' } });
  assert.equal(ctx.session.question_graph[1].conventions.prediction_structure, 'cross_sectional');
  console.log('contest type checks: passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
