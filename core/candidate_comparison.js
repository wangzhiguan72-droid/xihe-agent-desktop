'use strict';
const crypto = require('crypto');

// Read actual tool output, never a model-authored note or a number elsewhere in a log.
function readMeasurementRecord(run, key) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('measurement_key 必须是输出 JSON 的指标字段名');
  const raw = String(run.out || '').trim();
  if (raw.includes('[中间截断') || (raw.includes('--- stdout ---') && !raw.includes('--- stderr ---'))) {
    throw new Error('运行输出摘录已截断，不能确认指标唯一性；请缩短日志后重新正式运行并输出指标 JSON');
  }
  // Tool records include diagnostic stderr after stdout. Diagnostics are not measurements.
  const out = raw.includes('--- stdout ---')
    ? raw.split('--- stdout ---', 2)[1].split('--- stderr ---', 1)[0].trim()
    : raw.split('--- stderr ---', 1)[0].trim();
  let objects;
  try { objects = [JSON.parse(out)]; }
  catch {
    objects = out.split(/\r?\n/).flatMap(line => {
      try { return [JSON.parse(line.trim())]; } catch { return []; }
    });
  }
  const hits = objects.filter(x => x && typeof x === 'object' && !Array.isArray(x) && Object.hasOwn(x, key));
  if (hits.length !== 1) throw new Error(`正式输出必须包含唯一 JSON 指标 ${key}（当前 ${hits.length} 处）；请打印一行 JSON，不能由备注代填`);
  const value = hits[0][key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`指标 ${key} 必须为有限数值`);
  return hits[0];
}

function readMeasurement(run, key) { return readMeasurementRecord(run, key)[key]; }

function comparisonScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('comparison 必须说明比较口径');
  if (!Number.isSafeInteger(value.question_id) || value.question_id < 1) throw new Error('comparison.question_id 必须为正整数');
  for (const field of ['dataset', 'protocol', 'unit']) {
    if (typeof value[field] !== 'string' || !value[field].trim() || value[field].length > 600) throw new Error(`comparison.${field} 必须为1—600字的非空说明`);
  }
  if (!['min', 'max'].includes(value.direction)) throw new Error('comparison.direction 必须为 min 或 max');
  return { question_id: value.question_id, dataset: value.dataset.trim(), protocol: value.protocol.trim(), unit: value.unit.trim(), direction: value.direction };
}

function evidenceFingerprint(run) {
  return crypto.createHash('sha256').update(JSON.stringify({
    out: run.out, ms: run.ms, epoch: run.epoch, input_hash: run.input_hash,
    model_spec: run.model_spec, boundary_mode: run.boundary_mode,
  })).digest('hex');
}

function groupKey(row) {
  const s = row.comparison;
  return JSON.stringify([s.question_id, s.dataset, s.protocol, s.unit, s.direction,
    row.err.metric, row.epoch, row.boundary_mode || null]);
}

function validateMetric(metric, key, scope) {
  if (metric !== key) throw new Error('指标名 err.metric 必须与正式输出 measurement_key 一致，不能重命名数值冒充其他指标');
  const normalized = metric.toLowerCase().replace(/[\s_\-²^]/g, '').replace(/^r$/, 'r2');
  const minimize = /^(mae|mse|rmse|mape|smape|mase|logloss|brier|brierscore|均方误差|平均绝对误差|均方根误差)$/;
  const maximize = /^(accuracy|accuracy率|准确率|auc|rocauc|f1|f1score|r2|决定系数)$/;
  if ((minimize.test(normalized) && scope.direction !== 'min') || (maximize.test(normalized) && scope.direction !== 'max')) {
    throw new Error(`指标 ${metric} 的比较方向与其常规定义冲突；变换指标应使用新的明确名称并说明评价协议`);
  }
}

module.exports = { readMeasurement, readMeasurementRecord, comparisonScope, evidenceFingerprint, groupKey, validateMetric };
