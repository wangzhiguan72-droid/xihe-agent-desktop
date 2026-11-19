'use strict';
const crypto = require('crypto');

const filled = x => typeof x === 'string' && x.trim().length > 0;
const fields = (value, keys, at, errors) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${at} 必须为对象`); return;
  }
  for (const key of keys) if (!filled(value[key])) errors.push(`${at}.${key} 缺失`);
};
const rows = (value, keys, at, errors, min = 1) => {
  if (!Array.isArray(value) || value.length < min) { errors.push(`${at} 至少 ${min} 条`); return; }
  value.forEach((item, i) => fields(item, keys, `${at}[${i}]`, errors));
};

function validateSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['规格必须为对象'] };
  if (!Number.isSafeInteger(spec.question_id) || spec.question_id < 1) errors.push('question_id 必须为正整数');
  fields(spec.task, ['prompt_ref', 'goal', 'output'], 'task', errors);
  if (!filled(spec.model_type)) errors.push('model_type 缺失');
  rows(spec.givens, ['statement', 'source'], 'givens', errors);
  // An empty list is allowed when no extra assumptions are needed; supplied assumptions need an audit trail.
  rows(spec.assumptions, ['statement', 'rationale', 'check'], 'assumptions', errors, 0);
  rows(spec.variables, ['symbol', 'meaning', 'unit', 'domain'], 'variables', errors);
  rows(spec.formulation, ['expression', 'meaning'], 'formulation', errors);
  rows(spec.data, ['name', 'source', 'fields', 'treatment'], 'data', errors);
  rows(spec.parameters, ['symbol', 'value', 'unit', 'source'], 'parameters', errors, 0);
  fields(spec.algorithm, ['name', 'inputs', 'outputs', 'stopping'], 'algorithm', errors);
  if (!Array.isArray(spec.algorithm && spec.algorithm.steps) || !spec.algorithm.steps.length || !spec.algorithm.steps.every(filled)) errors.push('algorithm.steps 至少一条具体步骤');
  rows(spec.validation, ['method', 'criterion', 'evidence'], 'validation', errors);
  fields(spec.interfaces, ['receives', 'supplies'], 'interfaces', errors);
  if (!Array.isArray(spec.deliverables) || !spec.deliverables.length || !spec.deliverables.every(filled)) errors.push('deliverables 至少一个交付物');
  if (/optimization|optimisation|优化/i.test(spec.model_type || '')) {
    fields(spec.optimization, ['objective', 'constraints', 'decision_domain'], 'optimization', errors);
  }
  if (spec.optimization?.check != null) {
    errors.push(...require('./optimization_evidence').validateCheck(spec.optimization.check).errors.map(e => 'optimization.check: ' + e));
  }
  return { ok: errors.length === 0, errors };
}

function canonical(spec) {
  if (Array.isArray(spec)) return '[' + spec.map(canonical).join(',') + ']';
  if (spec && typeof spec === 'object') return '{' + Object.keys(spec).sort().map(k => JSON.stringify(k) + ':' + canonical(spec[k])).join(',') + '}';
  return JSON.stringify(spec);
}
function hashSpec(spec) { return crypto.createHash('sha256').update(canonical(spec)).digest('hex'); }
function registerSpec(session, spec) {
  const check = validateSpec(spec);
  if (!check.ok) return check;
  session.model_specs = session.model_specs || [];
  const id = `Q${spec.question_id}`;
  const old = session.model_specs.find(x => x.id === id);
  const hash = hashSpec(spec);
  if (old && old.hash !== hash) session.data_epoch = (session.data_epoch || 0) + 1;
  const record = { id, question_id: spec.question_id, spec: JSON.parse(JSON.stringify(spec)), hash, version: old ? old.version + (old.hash === hash ? 0 : 1) : 1, epoch: session.data_epoch || 0, registered_at: Date.now() };
  if (old) session.model_specs[session.model_specs.indexOf(old)] = record;
  else session.model_specs.push(record);
  if (old && old.hash !== hash) {
    const affected = new Set([spec.question_id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const q of session.question_graph || []) if (!affected.has(q.id) && (q.deps || []).some(id => affected.has(id))) { affected.add(q.id); changed = true; }
    }
    for (const q of session.question_graph || []) if (affected.has(q.id)) {
      q.status = 'drafting'; q.experiments = []; delete q.committed_at;
    }
  }
  return { ok: true, record };
}

function specBinding(session, args) {
  if (args && args.model_spec_id != null && args.question_id != null && args.model_spec_id !== `Q${args.question_id}`) return undefined;
  const id = args && (args.model_spec_id || (Number.isSafeInteger(args.question_id) ? `Q${args.question_id}` : null));
  const record = (session.model_specs || []).find(x => x.id === id);
  return record ? { id: record.id, hash: record.hash, version: record.version, epoch: record.epoch } : undefined;
}

function runSpecBlock(session, run, questionId) {
  if (run?.task_scope === 'local') return '临时任务运行仅用于局部核验；回主线后按当前规格重新正式计算，不能直接关联为主线证据';
  if (!session.require_model_spec && !(session.model_specs || []).length) return null;
  const record = (session.model_specs || []).find(x => x.question_id === questionId);
  if (!record) return `问题${questionId} 模型规格未登记`;
  if (record.epoch !== (session.data_epoch || 0)) return `问题${questionId} 模型规格属于旧输入版本，需核对并重新登记`;
  if (!run.formal || !run.ok) return '模型规格证据必须来自成功的 formal 运行';
  const binding = run.model_spec;
  if (!binding || binding.id !== record.id || binding.hash !== record.hash || binding.version !== record.version || binding.epoch !== record.epoch) return `运行未绑定问题${questionId} 当前模型规格版本与输入版本，需重跑`;
  if (!validateSpec(record.spec).ok || hashSpec(record.spec) !== record.hash) return '当前模型规格已损坏，需重新登记';
  return null;
}

function specGate(session, args) {
  const formal = args && (args.formal === true || (Array.isArray(args.uses_formulas) && args.uses_formulas.length > 0));
  if (!formal) return null;
  const list = session.model_specs || [];
  if (!session.require_model_spec && !list.length) return null;
  if (args.model_spec_id != null && args.question_id != null && args.model_spec_id !== `Q${args.question_id}`) return 'model_spec_id 与 question_id 指向不同问题，请统一后重试。';
  const id = args.model_spec_id || (Number.isSafeInteger(args.question_id) ? `Q${args.question_id}` : null);
  if (!id) return '正式求解必须传 model_spec_id（如 Q1）或 question_id，以绑定逐问模型规格。';
  const record = list.find(x => x.id === id);
  if (!record) return `模型规格 ${id} 未登记；先用 model_spec register 登记并校验。`;
  const check = validateSpec(record.spec);
  if (!check.ok) return `模型规格 ${id} 无效：${check.errors.join('；')}`;
  if (record.hash !== hashSpec(record.spec)) return `模型规格 ${id} 内容已改变，需重新登记。`;
  if (record.epoch !== (session.data_epoch || 0)) return `模型规格 ${id} 已过期（登记 epoch=${record.epoch}，当前 ${session.data_epoch || 0}）；核对新输入后重新登记。`;
  return null;
}

function specSummary(session) {
  const list = session.model_specs || [];
  if (!list.length) return session.require_model_spec ? '模型规格: 未登记（正式求解被阻止）' : '模型规格: 未登记（旧会话兼容）';
  return '模型规格: ' + list.map(x => `${x.id} v${x.version} ${x.epoch === (session.data_epoch || 0) ? '当前' : '过期'} hash=${x.hash.slice(0, 10)} 类型=${x.spec.model_type} 目标=${String(x.spec.task.goal).slice(0, 60)}`).join('；');
}

module.exports = { validateSpec, registerSpec, specGate, specSummary, specBinding, runSpecBlock };
