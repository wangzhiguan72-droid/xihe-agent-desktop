'use strict';

// Paired observations only. A trusted host must provide the executor, grader,
// and (for empirical eligibility) an attestation verifier outside this folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value);
const same = (a, b) => json(a) === json(b);
const need = (condition, message) => { if (!condition) throw new Error(message); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 300;

function combination(value) {
  need(isObject(value) && Array.isArray(value.skills) && Array.isArray(value.plugins), '组合须包含 Skill 与插件锁定清单');
  need(value.skills.length <= 16 && value.plugins.length <= 8, '组合数量超限');
  const skills = value.skills.map(row => {
    need(isObject(row) && text(row.slot) && text(row.name) && SHA.test(row.sha256)
      && ['append', 'replace'].includes(row.mode), 'Skill 锁定项须含槽位、名称、指纹和方式');
    return { slot: row.slot, name: row.name, sha256: row.sha256, mode: row.mode };
  }).sort((a, b) => a.slot.localeCompare(b.slot));
  const plugins = value.plugins.map(row => {
    need(isObject(row) && text(row.id) && SHA.test(row.sha256), '插件锁定项须含 ID 和指纹');
    return { id: row.id, sha256: row.sha256 };
  }).sort((a, b) => a.id.localeCompare(b.id));
  need(new Set(skills.map(row => row.slot)).size === skills.length && new Set(plugins.map(row => row.id)).size === plugins.length,
    '组合锁定项重复');
  return { skills, plugins };
}

function context(value) {
  need(isObject(value), '实验上下文无效');
  const model = value.model, metric = value.metric, budget = value.budget;
  need(isObject(model) && text(model.id) && model.id.includes(':') && text(model.reasoning)
    && SHA.test(model.config_sha256), '底模须固定提供商、推理档与配置指纹');
  need(text(value.problem_family) && text(value.stage) && SHA.test(value.task_sha256)
    && SHA.test(value.data_sha256) && SHA.test(value.runtime_sha256), '题型、阶段、题目、数据与运行时须固定');
  need(isObject(metric) && text(metric.name) && text(metric.unit) && text(metric.protocol)
    && ['max', 'min'].includes(metric.direction), '指标须固定名称、单位、口径和方向');
  need(isObject(budget) && positive(budget.wall_time_ms) && positive(budget.token_limit)
    && positive(budget.tool_call_limit), '预算须固定时间、token 和工具调用上限');
  return { model: { id: model.id, reasoning: model.reasoning, config_sha256: model.config_sha256 },
    problem_family: value.problem_family, stage: value.stage, task_sha256: value.task_sha256,
    data_sha256: value.data_sha256, runtime_sha256: value.runtime_sha256,
    metric: { name: metric.name, unit: metric.unit, protocol: metric.protocol, direction: metric.direction },
    budget: { wall_time_ms: budget.wall_time_ms, token_limit: budget.token_limit, tool_call_limit: budget.tool_call_limit } };
}

function protocol(value) {
  need(isObject(value) && ['development', 'empirical'].includes(value.kind), '实验类型无效');
  return { kind: value.kind, context: context(value.context),
    seed: (() => { need(Number.isSafeInteger(value.seed) && value.seed >= 0, '随机种子无效'); return value.seed; })() };
}

function targetRoot(root) {
  need(typeof root === 'string' && path.isAbsolute(root), '证据根目录须为绝对路径');
  const resolved = path.resolve(root);
  if (fs.existsSync(resolved)) need(fs.statSync(resolved).isDirectory() && !fs.lstatSync(resolved).isSymbolicLink(), '证据根目录不能是链接');
  return resolved;
}

async function run({ root, protocol: input, baseline: baseInput, candidate: candidateInput, trials, execute, grade, attest }) {
  const folder = targetRoot(root), spec = protocol(input), baseline = combination(baseInput), candidate = combination(candidateInput);
  need(!same(baseline, candidate), '基线与候选组合相同');
  need(Array.isArray(trials) && trials.length >= 2 && trials.length <= 100
    && trials.every(row => isObject(row) && text(row.id) && SHA.test(row.task_sha256) && SHA.test(row.data_sha256)), '须提供至少两个可核对试次');
  need(new Set(trials.map(row => row.id)).size === trials.length, '试次 ID 重复');
  trials = JSON.parse(json(trials));
  need(trials.every(row => row.task_sha256 === spec.context.task_sha256 && row.data_sha256 === spec.context.data_sha256), '试次题目或数据不一致');
  need(typeof execute === 'function' && typeof grade === 'function', '须提供可信执行与评分回调');
  if (spec.kind === 'empirical') need(typeof attest === 'function', '经验记录须由可信宿主签发');
  const id = crypto.randomBytes(16).toString('hex');
  const finalDestination = path.join(folder, id), destination = path.join(folder, '.pending-' + id);
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(destination, { recursive: false });
  try {
  const observations = [];
  for (const [index, trial] of trials.entries()) {
    const seed = (spec.seed + index) % 2147483647;
    const order = (index + spec.seed) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    const pair = { id: trial.id, task_sha256: trial.task_sha256, data_sha256: trial.data_sha256, seed, order, arms: {} };
    for (const arm of order) {
      const selected = arm === 'baseline' ? baseline : candidate;
      const started = process.hrtime.bigint();
      let output, error;
      try { output = await execute({ arm, combination: JSON.parse(json(selected)), context: JSON.parse(json(spec.context)),
        trial: JSON.parse(json(trial)), seed }); }
      catch (e) { error = String(e?.message || e).slice(0, 500); }
      const wallTime = Number((process.hrtime.bigint() - started) / 1000000n);
      const row = { status: 'failed', wall_time_ms: wallTime, tokens: null, tool_calls: null, artifact_sha256: null, score: null,
        reason: error || null };
      if (!error) {
        const artifact = Buffer.isBuffer(output?.artifact) ? output.artifact : typeof output?.artifact === 'string' ? Buffer.from(output.artifact) : null;
        const tokens = output?.usage?.tokens, tools = output?.usage?.tool_calls;
        row.tokens = Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null;
        row.tool_calls = Number.isSafeInteger(tools) && tools >= 0 ? tools : null;
        if (!artifact || !artifact.length || artifact.length > 20_000_000 || row.tokens === null || row.tool_calls === null) row.reason = '缺少有效产物或真实用量';
        else {
          const filename = `${trial.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${arm}-${crypto.randomBytes(4).toString('hex')}.bin`;
          const file = path.join(destination, filename);
          fs.writeFileSync(file, artifact, { flag: 'wx' });
          row.artifact = filename; row.artifact_sha256 = hash(artifact);
          if (wallTime > spec.context.budget.wall_time_ms || tokens > spec.context.budget.token_limit
              || tools > spec.context.budget.tool_call_limit) row.reason = '超出固定预算';
          else {
            try {
              const score = await grade({ artifact: Buffer.from(artifact), arm, trial: JSON.parse(json(trial)),
                context: JSON.parse(json(spec.context)) });
              if (typeof score !== 'number' || !Number.isFinite(score)) row.reason = '评分无效';
              else { row.status = 'ok'; row.score = score; row.reason = null; }
            } catch (e) { row.reason = '评分失败：' + String(e?.message || e).slice(0, 300); }
          }
        }
      }
      pair.arms[arm] = row;
    }
    observations.push(pair);
  }
  const payload = { schema_version: 1, id, protocol: spec, baseline, candidate, observations,
    provenance: 'xihe-skill-gain-harness', blind_evaluation: false, provider_compliance_verified: false };
  const digest = hash(json(payload));
  const attestation = spec.kind === 'empirical' ? await attest(digest, payload) : null;
  need(spec.kind !== 'empirical' || (text(attestation) && attestation.length <= 4096), '可信宿主签发失败');
  fs.writeFileSync(path.join(destination, 'report.json'), json({ payload, digest, attestation }), { flag: 'wx' });
  fs.renameSync(destination, finalDestination);
  return { id, root: finalDestination, digest, outcome: assess(payload) };
  } finally {
    // Only remove this invocation's unpublished staging directory.
    need(path.dirname(destination) === folder && path.basename(destination) === '.pending-' + id, '临时证据路径越界');
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  }
}

function assess(payload) {
  const rows = payload.observations;
  if (rows.some(pair => pair.arms.baseline.status !== 'ok' || pair.arms.candidate.status !== 'ok'))
    return { status: 'inconclusive', reason: '存在失败、缺失结果或预算超限' };
  const sign = payload.protocol.context.metric.direction === 'max' ? 1 : -1;
  const deltas = rows.map(pair => sign * (pair.arms.candidate.score - pair.arms.baseline.score));
  const mean_delta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return { status: mean_delta > 0 && deltas.every(delta => delta > 0) ? 'observed_gain' : 'no_gain',
    mean_delta, trial_count: rows.length, reason: mean_delta > 0 && deltas.every(delta => delta > 0)
      ? '全部配对试次改善' : '没有一致的正向改善' };
}

function inspect(directory, verifyAttestation) {
  if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory())
    return { status: 'invalid', reason: '证据目录无效或为链接' };
  const file = path.join(directory, 'report.json');
  if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 1_000_000) return { status: 'invalid', reason: '报告缺失、过大或为链接' };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const p = saved.payload;
    need(isObject(p) && p.schema_version === 1 && p.id === path.basename(directory)
      && p.provenance === 'xihe-skill-gain-harness' && SHA.test(saved.digest) && hash(json(p)) === saved.digest, '报告指纹不一致');
    protocol(p.protocol); combination(p.baseline); combination(p.candidate);
    need(Array.isArray(p.observations) && p.observations.length >= 2, '观察记录缺失');
    need(new Set(p.observations.map(row => row.id)).size === p.observations.length, '试次重复');
    for (const pair of p.observations) for (const arm of ['baseline', 'candidate']) {
      need(text(pair.id) && pair.task_sha256 === p.protocol.context.task_sha256
        && pair.data_sha256 === p.protocol.context.data_sha256, '试次任务或数据与协议不符');
      const row = pair.arms?.[arm]; need(isObject(row) && ['ok', 'failed'].includes(row.status), '结果状态无效');
      need(Number.isSafeInteger(row.wall_time_ms) && row.wall_time_ms >= 0, '实际耗时无效');
      if (row.status === 'ok') need(Number.isFinite(row.score) && row.artifact && row.reason === null
        && Number.isSafeInteger(row.tokens) && row.tokens >= 0 && row.tokens <= p.protocol.context.budget.token_limit
        && Number.isSafeInteger(row.tool_calls) && row.tool_calls >= 0 && row.tool_calls <= p.protocol.context.budget.tool_call_limit
        && row.wall_time_ms <= p.protocol.context.budget.wall_time_ms, '有效记录缺少评分或超预算');
      if (row.artifact) {
        need(/^[A-Za-z0-9_-]+-(?:baseline|candidate)-[a-f0-9]{8}\.bin$/.test(row.artifact), '产物路径无效');
        const artifact = path.join(directory, row.artifact);
        need(fs.existsSync(artifact) && !fs.lstatSync(artifact).isSymbolicLink()
          && fs.statSync(artifact).size <= 20_000_000 && hash(fs.readFileSync(artifact)) === row.artifact_sha256, '产物指纹不一致');
      }
    }
    const eligible = p.protocol.kind === 'empirical' && typeof verifyAttestation === 'function'
      && verifyAttestation(saved.digest, saved.attestation, p) === true;
    return { status: eligible ? 'eligible' : 'development', payload: p, outcome: assess(p), digest: saved.digest,
      reason: eligible ? null : '缺少可信宿主签发核验或仅为开发试验' };
  } catch (e) { return { status: 'invalid', reason: String(e.message).slice(0, 300) }; }
}

function summarize(root, { combination: requested, baseline: requestedBaseline, context: requestedContext, verifyAttestation } = {}) {
  const folder = targetRoot(root);
  if (!requested || !requestedContext) return { status: 'unverified', reasons: ['缺少锁定组合或任务评价上下文'], records: [] };
  const selected = combination(requested), scope = context(requestedContext);
  const base = requestedBaseline ? combination(requestedBaseline) : null;
  if (!base) return { status: 'unverified', reasons: ['须明确默认流程的锁定版本才能比较增益'], records: [] };
  if (!fs.existsSync(folder)) return { status: 'unverified', reasons: ['尚无配对实验'], records: [] };
  const records = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const found = inspect(path.join(folder, entry.name), verifyAttestation);
    if (found.status === 'invalid') { records.push({ id: entry.name, status: 'invalid', reason: found.reason }); continue; }
    if (!same(found.payload.candidate, selected) || !same(found.payload.baseline, base)
      || !same(found.payload.protocol.context, scope)) continue;
    records.push({ id: entry.name, status: found.status, outcome: found.outcome, digest: found.digest, reason: found.reason });
  }
  const eligible = records.filter(row => row.status === 'eligible');
  const status = records.some(row => row.status === 'invalid') ? 'inconclusive' : !eligible.length ? 'unverified'
    : eligible.some(row => row.outcome.status === 'inconclusive') ? 'inconclusive'
    : eligible.every(row => row.outcome.status === 'observed_gain') ? 'observed_gain' : 'no_gain';
  return { status, reasons: status === 'unverified' ? ['没有同版本、同题型阶段、同模型与预算的可信经验记录']
    : status === 'inconclusive' ? ['存在失败、损坏或预算超限的配对记录；不能排除反向证据'] : [], records,
    context: scope, baseline: base, combination: selected };
}

module.exports = { run, inspect, summarize, combination, context };
