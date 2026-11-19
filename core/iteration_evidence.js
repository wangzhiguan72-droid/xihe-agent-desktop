'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const comparison = require('./candidate_comparison');
const modelSpec = require('./model_spec');
const verification = require('./verification_run');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error(`${name} 必须为1—2000字的非空说明`);
  return value.trim();
}
// Optional for exploration, mandatory for adoption; result cannot add a criterion after seeing outputs.
function evaluationPlan(value) {
  if (value == null) return null;
  if (value.kind === 'quantitative') {
    const scope = comparison.comparisonScope(value.comparison);
    const key = text(value.measurement_key, 'measurement_key');
    comparison.validateMetric(key, key, scope);
    const min = value.min_improvement;
    if (typeof min !== 'number' || !Number.isFinite(min) || min < 0) throw new Error('min_improvement 必须是非负有限数值（指标原单位的绝对收益，0仍要求严格改善）');
    return { kind: value.kind, comparison: scope, measurement_key: key, min_improvement: min,
      inputs: value.inputs, evaluator: value.evaluator };
  }
  if (value.kind === 'analytical') {
    if (!Number.isSafeInteger(value.question_id) || value.question_id < 1) throw new Error('解析改进 question_id 必须为正整数');
    return { kind: value.kind, question_id: value.question_id, statement: text(value.statement, 'statement'), domain: text(value.domain, 'domain') };
  }
  throw new Error('evaluation.kind 必须为 quantitative 或 analytical');
}

function prepareEvaluation(ctx, value) {
  const plan = evaluationPlan(value);
  if (!plan || plan.kind !== 'quantitative') return plan;
  if (!Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length > 100) throw new Error('定量判据 inputs 需列出1—100个实际评测数据/划分文件');
  plan.inputs = value.inputs.map(rel => snapshotFile(ctx, rel));
  if (new Set(plan.inputs.map(row => row.rel)).size !== plan.inputs.length) throw new Error('inputs 不可重复');
  plan.evaluator = snapshotFile(ctx, value.evaluator);
  return plan;
}

function snapshotFile(ctx, rel) {
  text(rel, '评测文件路径');
  if (path.isAbsolute(rel)) throw new Error('评测文件必须为工作区相对路径');
  const abs = ctx.sandbox.resolve(rel, 'r');
  const normalized = path.relative(ctx.workspace || ctx.sandbox.root, abs).replace(/\\/g, '/');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) throw new Error('评测文件必须位于当前工作区');
  const row = { rel: normalized, sha256: hash(fs.readFileSync(abs)) };
  // checkedFile enforces realpath containment as well as the content hash.
  verification.checkedFile(ctx.workspace || ctx.sandbox.root, row);
  return row;
}

function freshCandidate(it, run) {
  if (!Number.isFinite(run.t) || run.t < it.planned_at || (it.planned_run_ids || []).includes(run.run_id)) {
    throw new Error('候选/解析核查必须在预登记之后实际运行，不能用先前结果补登记');
  }
}

function runFor(ctx, id, questionId, auditRun) {
  const run = auditRun(ctx.session, id);
  if (run.unstable && !(Array.isArray(run.unstable_files) && run.unstable_files.length)) throw new Error('运行带unstable但缺变动清单，无法验证输入稳定性；请重新正式运行');
  if (!(ctx.session.model_specs || []).some(spec => spec.question_id === questionId) || !run.model_spec) throw new Error('改进采纳要求明确登记的子问规格及正式运行绑定；旧会话先登记规格并重跑');
  if (run.model_spec.id !== `Q${questionId}`) throw new Error('运行绑定了不同子问的模型规格');
  const block = modelSpec.runSpecBlock(ctx.session, run, questionId);
  if (block) throw new Error(block);
  return run;
}

function verifyEvidence(ctx, it, result, auditRun) {
  const plan = evaluationPlan(it.criterion && it.criterion.evaluation);
  if (!plan) throw new Error('缺少预登记的 criterion.evaluation；本候选可继续研究，不能采纳为已有证据的改进');
  if (plan.kind === 'quantitative') {
    if (!Array.isArray(plan.inputs) || !plan.inputs.length || !plan.evaluator) throw new Error('缺预登记的评测输入/脚本指纹');
    const root = ctx.workspace || ctx.sandbox.root;
    const expectedFiles = Object.fromEntries([...plan.inputs, plan.evaluator].map(row => {
      verification.checkedFile(root, row);
      return [row.rel, row.sha256];
    }));
    if (!result.run_id || !result.control_run_id || result.run_id === result.control_run_id) throw new Error('定量改进需要两个不同的实际正式运行：run_id 与 control_run_id');
    const candidate = runFor(ctx, result.run_id, plan.comparison.question_id, auditRun);
    const baseline = runFor(ctx, result.control_run_id, plan.comparison.question_id, auditRun);
    freshCandidate(it, candidate);
    if ((candidate.boundary_mode || null) !== (baseline.boundary_mode || null)) throw new Error('两次运行的边界口径不同');
    const values = [candidate, baseline].map(run => {
      const record = comparison.readMeasurementRecord(run, plan.measurement_key);
      const scope = comparison.comparisonScope(record.comparison);
      if (JSON.stringify(scope) !== JSON.stringify(plan.comparison)) throw new Error('正式输出的子问/数据划分/评价协议/单位/方向与预登记比较口径不同');
      const files = record.evaluation_files;
      if (!files || Object.keys(files).length !== Object.keys(expectedFiles).length
          || Object.entries(expectedFiles).some(([rel, sha]) => files[rel] !== sha)) throw new Error('正式输出的评测输入/脚本指纹与预登记不同');
      return record[plan.measurement_key];
    });
    const improvement = plan.comparison.direction === 'min' ? values[1] - values[0] : values[0] - values[1];
    if (!Number.isFinite(improvement) || improvement <= 0 || improvement < plan.min_improvement) throw new Error(`实际收益 ${improvement} 未达到预登记判据（严格改善且至少 ${plan.min_improvement} ${plan.comparison.unit}）`);
    return { kind: plan.kind, epoch: ctx.session.data_epoch || 0, comparison: plan.comparison, measurement_key: plan.measurement_key,
      evaluation_files: expectedFiles,
      candidate: values[0], baseline: values[1], improvement,
      run_fingerprint: comparison.evidenceFingerprint(candidate), control_fingerprint: comparison.evidenceFingerprint(baseline),
      limitation: '已核对正式输出数值与磁盘文件指纹；程序是否实际使用这些文件及声明口径仍须审阅。通过结构化数值判据不证明其它文字条件、数据公平性、统计显著或全局最优。' };
  }
  const proof = result.proof;
  if (!proof || typeof proof !== 'object') throw new Error('解析改进需要 proof：推导文件与实际核查运行');
  const rel = text(proof.derivation_path, 'proof.derivation_path');
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('推导文件必须位于当前工作区');
  const abs = ctx.sandbox.resolve(rel, 'r');
  const root = fs.realpathSync(ctx.workspace || ctx.sandbox.root);
  const inside = path.relative(root, fs.realpathSync(abs));
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('推导文件必须位于当前工作区');
  const stat = fs.statSync(abs);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('推导文件必须为不超过1MB的文本文件');
  const contents = fs.readFileSync(abs);
  if (!contents.toString('utf8').trim()) throw new Error('推导文件为空');
  const derivationHash = hash(contents);
  const receipt = (ctx.session.verification_runs || []).find(row => row.run_id === proof.check_run_id);
  const blockers = verification.receiptBlockers(root, receipt).concat(verification.contextBlockers(root, ctx.session, receipt));
  if (blockers.length) throw new Error('解析核查需要 verification_run 隔离执行的有效回执：' + blockers.join('；'));
  if (!Number.isFinite(receipt.at) || receipt.at < it.planned_at) throw new Error('解析核查必须在预登记后执行');
  if (!(receipt.inputs || []).some(row => row.rel === rel && row.sha256 === derivationHash)) throw new Error('隔离核查输入未绑定当前推导文件');
  const resultPath = verification.checkedFile(root, receipt.result);
  if (fs.statSync(resultPath).size > 2_000_000) throw new Error('解析核查结果超过2MB');
  const record = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  if (record.checks_passed !== 1 || record.derivation_sha256 !== derivationHash
      || record.question_id !== plan.question_id || record.statement !== plan.statement || record.domain !== plan.domain) {
    throw new Error('解析核查正式输出须绑定推导SHA-256、子问、主张与适用域，且 checks_passed=1');
  }
  return { ...plan, epoch: ctx.session.data_epoch || 0, derivation_path: rel, derivation_sha256: derivationHash,
    check_run_id: proof.check_run_id, receipt_fingerprint: hash(JSON.stringify(receipt)),
    review_boundary: text(proof.review_boundary, 'proof.review_boundary（核查覆盖及未证明的部分）'),
    limitation: '已留存推导和通过的核查记录；有限测试/未发现反例不等于通用数学证明，推导正确性仍需独立审阅。' };
}

module.exports = { prepareEvaluation, verifyEvidence };
