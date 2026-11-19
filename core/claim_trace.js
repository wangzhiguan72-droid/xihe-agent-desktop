'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runSpecBlock } = require('./model_spec');
const modelSpec = require('./model_spec');
const verificationRun = require('./verification_run');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const filled = value => typeof value === 'string' && !!value.trim();
const LIMITS = [
  '核验登记内容、文件字节、正式运行和模型规格的一致性，不证明模型方法、图形含义或论文主张在科学上正确。',
  '未登记的自由文本主张不在自动覆盖范围内；发布前仍需人工逐项核读。',
  '解析核查回执只能证明有限脚本和输入执行过且输出符合登记的检查合同，不能证明一般定理。',
];

function checkedFile(root, rel, limit = 20_000_000) {
  if (!filled(rel) || path.isAbsolute(rel) || rel.includes('\0') || /^(?:[A-Za-z]:|\\\\)/.test(rel)) throw new Error('证据路径必须是工作区内相对路径');
  const base = fs.realpathSync(root);
  const abs = path.resolve(base, rel);
  const inside = path.relative(base, abs);
  if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw new Error('证据路径越界');
  const real = fs.realpathSync(abs);
  const realInside = path.relative(base, real);
  if (!realInside || realInside === '..' || realInside.startsWith('..' + path.sep) || path.isAbsolute(realInside)) throw new Error('证据真实路径越界');
  const st = fs.statSync(real);
  if (!st.isFile() || st.size > limit) throw new Error('证据文件不是普通文件或超过大小上限');
  const bytes = fs.readFileSync(real);
  if (bytes.length > limit) throw new Error('证据文件超过大小上限');
  return { path: inside.replace(/\\/g, '/'), sha256: hash(bytes), bytes: bytes.length, contents: bytes };
}

function sourceValue(data, field) {
  if (!filled(field) || field.split('.').some(x => !x || ['__proto__', 'constructor', 'prototype'].includes(x))) throw new Error('结果字段无效');
  const value = field.split('.').reduce((current, part) => current && own(current, part) ? current[part] : undefined, data);
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  if (finite(value)) return value;
  if (Array.isArray(value) && value.length && value.length <= 100_000 && value.every(finite)) return value;
  throw new Error('结果字段必须是有限数值或非空有限数值数组');
}

function sourceData(file, field) {
  if (file.bytes > 2_000_000) throw new Error('数值结果 JSON 超过 2MB');
  let data;
  try { data = JSON.parse(file.contents.toString('utf8')); }
  catch { throw new Error('数值结果不是有效 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数值结果 JSON 根节点必须是对象');
  return sourceValue(data, field);
}

function transformOf(raw, value) {
  const spec = raw == null ? { kind: 'identity' } : raw;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('变换须为对象');
  if (spec.kind === 'identity') {
    if (Object.keys(spec).some(x => x !== 'kind')) throw new Error('恒等变换含未知字段');
    return { spec: { kind: 'identity' }, value };
  }
  if (spec.kind !== 'affine' || Object.keys(spec).some(x => !['kind', 'scale', 'offset'].includes(x))
      || typeof spec.scale !== 'number' || !Number.isFinite(spec.scale)
      || typeof spec.offset !== 'number' || !Number.isFinite(spec.offset)) throw new Error('变换仅支持 identity 或有限的 affine(scale,offset)');
  const apply = x => x * spec.scale + spec.offset;
  const result = Array.isArray(value) ? value.map(apply) : apply(value);
  if ((Array.isArray(result) ? result : [result]).some(x => !Number.isFinite(x))) throw new Error('变换产生非有限结果');
  return { spec: { kind: 'affine', scale: spec.scale, offset: spec.offset }, value: result };
}

function displayCheck(actual, displayed, decimals) {
  if (displayed == null) throw new Error('数值主张必须提供 displayed_value 和 decimals');
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 12) throw new Error('提供 displayed_value 时 decimals 须为 0–12');
  const expected = Array.isArray(actual) ? actual : [actual];
  const shown = Array.isArray(displayed) ? displayed : [displayed];
  if (expected.length !== shown.length || shown.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('展示值形状或数值无效');
  if (expected.some((x, i) => Number(x.toFixed(decimals)) !== shown[i])) throw new Error('展示值与结果字段及指定小数位不符');
  return displayed;
}

function fingerprint(run) {
  return hash(JSON.stringify({ run_id: run.run_id, tool: run.tool, ok: run.ok, formal: run.formal,
    unstable: run.unstable, task_scope: run.task_scope, epoch: run.epoch,
    input_hash: run.input_hash, model_spec: run.model_spec, result_artifacts: run.result_artifacts,
    out: run.out }));
}

function currentInputHash(root) {
  const { stampInputFiles, inputStampHash } = require('./agent');
  return inputStampHash(stampInputFiles(root));
}

function checkedRun(root, session, questionId, runId) {
  const q = (session.question_graph || []).find(x => x.id === questionId);
  if (!q) throw new Error(`问题${questionId} 未登记`);
  if (!(q.experiments || []).includes(runId)) throw new Error(`问题${questionId} 尚未 link_run 关联 ${runId}`);
  const run = (session.runs || []).find(x => x.run_id === runId);
  if (!run || !run.ok || !run.formal || run.unstable || run.task_scope === 'local'
      || !['python_run', 'shell_run'].includes(run.tool)) throw new Error('主张需要主会话中成功、稳定的正式计算运行');
  if ((run.epoch || 0) !== (session.data_epoch || 0)) throw new Error('正式运行属于旧输入版本');
  if (q.evidence_after_run_seq != null && Number(String(run.run_id).replace(/^run/, '')) <= q.evidence_after_run_seq) throw new Error('正式运行早于上游提交失效点，需重新计算');
  if (!run.input_hash || run.input_hash !== currentInputHash(root)) throw new Error('正式运行的输入内容指纹与当前工作区不一致');
  if (!(session.model_specs || []).some(x => x.question_id === questionId)) throw new Error('问题模型规格未登记');
  const specProblem = runSpecBlock(session, run, questionId);
  if (specProblem) throw new Error(specProblem);
  return run;
}

function receiptFor(run, file) {
  const entries = run.result_artifacts?.files;
  const receipt = Array.isArray(entries) && entries.find(x => x.path === file.path);
  if (!receipt || receipt.sha256 !== file.sha256 || receipt.bytes !== file.bytes) throw new Error('结果文件未绑定该正式运行的产出回执，或文件内容已改变');
  return receipt;
}

function sourceFor(root, session, questionId, runId, rel) {
  const run = checkedRun(root, session, questionId, runId);
  const file = checkedFile(root, rel, 2_000_000);
  receiptFor(run, file);
  // Parsing is part of the source contract, not a caller's assertion.
  const data = JSON.parse(file.contents.toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('绘图来源必须是正式结果 JSON 对象');
  return { question_id: questionId, run_id: runId, path: file.path, sha256: file.sha256, bytes: file.bytes,
    run_fingerprint: fingerprint(run), epoch: session.data_epoch || 0, model_spec: run.model_spec };
}

function snapshotFiles(root, entries, kind, text, q) {
  if (entries == null) return [];
  if (!Array.isArray(entries) || entries.length > 20) throw new Error(`${kind} 须为不超过20项的数组`);
  return entries.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${kind}[${i}] 无效`);
    const file = checkedFile(root, entry.path);
    if (kind === 'references') {
      if (!['abstract', 'body', 'caption'].includes(entry.kind) || !filled(entry.quote) || entry.quote.length > 2000) throw new Error('文稿引用需要 kind 和短原文 quote');
      if (!entry.quote.includes(text) || !file.contents.toString('utf8').includes(entry.quote)) throw new Error('文稿中找不到与主张相符的逐字引用');
      return { kind: entry.kind, path: file.path, quote: entry.quote, sha256: file.sha256, bytes: file.bytes };
    }
    if (entry.kind !== 'data' || !filled(entry.panel) || entry.panel.length > 80) throw new Error('数据图需要 kind=data 和 panel 名称');
    if (!(q.artifacts || []).some(a => String(a.path || a.rel || a).replace(/\\/g, '/') === file.path)) throw new Error('数据图尚未挂接到问题');
    if (entry.plot_run_id != null && !/^plot_[a-f0-9]{20}$/.test(entry.plot_run_id)) throw new Error('plot_run_id 格式无效');
    return { kind: 'data', path: file.path, panel: entry.panel, note: String(entry.note || '').slice(0, 400), sha256: file.sha256, bytes: file.bytes,
      ...(entry.plot_run_id ? { plot_run_id: entry.plot_run_id } : {}) };
  });
}

function recordFor(ctx, input) {
  if (input?.kind === 'analytic') return analyticRecord(ctx, input);
  const { session, workspace } = ctx;
  if (!session || !workspace) throw new Error('缺少会话或工作区');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('主张登记参数无效');
  const id = input.id;
  const questionId = Number(input.question_id);
  const text = input.text;
  if (!filled(id) || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('主张 ID 无效');
  if (!Number.isSafeInteger(questionId) || questionId < 1) throw new Error('question_id 无效');
  if (!filled(text) || text.length > 2000 || !filled(input.scope) || input.scope.length > 500) throw new Error('主张需要 text 和适用范围 scope');
  if (!filled(input.run_id)) throw new Error('run_id 必填');
  if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)
      || !filled(input.source.path) || !filled(input.source.field) || !filled(input.source.unit)) throw new Error('source 需要 path、field、unit');
  const run = checkedRun(workspace, session, questionId, input.run_id);
  const file = checkedFile(workspace, input.source.path);
  receiptFor(run, file);
  const raw = sourceData(file, input.source.field);
  if (Array.isArray(raw)) throw new Error('当前主张须绑定单个数值字段；多个图表数值分别登记');
  const transformed = transformOf(input.transform, raw);
  const displayed = displayCheck(transformed.value, input.displayed_value, input.decimals);
  const numericText = text.replace(/[\u2212\uFF0D]/g, '-');
  const textNumbers = (numericText.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g) || []).map(Number);
  if (!textNumbers.some(number => number === displayed)) throw new Error('主张原句未包含所登记的展示数值');
  const outputUnit = input.output_unit == null && transformed.spec.kind === 'identity' ? input.source.unit : input.output_unit;
  if (!filled(outputUnit) || outputUnit.length > 100) throw new Error('变换后的数值必须登记 output_unit');
  const q = session.question_graph.find(x => x.id === questionId);
  const optimality = require('./optimization_trace').claimCheck(workspace, session, { ...input, question_id: questionId });
  const references = snapshotFiles(workspace, input.references, 'references', text, q);
  const figures = snapshotFiles(workspace, input.figures, 'figures', text, q);
  for (const figure of figures) {
    if (figure.plot_run_id) require('./plugin_runtime').validatePlot(workspace, session, figure.plot_run_id, questionId, run.run_id, file.path, figure, input.source.field);
    else receiptFor(run, figure);
  }
  const binding = JSON.parse(JSON.stringify(run.model_spec));
  return { id, question_id: questionId, text, scope: input.scope, run_id: run.run_id,
    source: { path: file.path, field: input.source.field, unit: input.source.unit, sha256: file.sha256, bytes: file.bytes },
    transform: transformed.spec, value: transformed.value, displayed_value: displayed, output_unit: outputUnit,
    decimals: displayed == null ? null : input.decimals, figures, references,
    ...(optimality ? { optimality } : {}),
    model_spec: binding, run_fingerprint: fingerprint(run), epoch: session.data_epoch || 0, registered_at: Date.now() };
}

function questionFor(session, id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('question_id 必须为正整数');
  const q = (session.question_graph || []).find(row => row.id === id);
  if (!q) throw new Error(`问题${id} 未登记`);
  return q;
}

function relatedQuestion(session, owner, target) {
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of (session.question_graph || []).find(q => q.id === id)?.deps || []) visit(dep);
  };
  visit(owner); return seen.has(target);
}
function premiseSnapshot(session, input, questionId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('来源须为契约、公式或模型规格引用');
  let record, label, source;
  if (input.kind === 'contract') {
    if (!filled(input.key)) throw new Error('契约来源需要 key');
    const matches = (session.contract || []).filter(x => x.key === input.key && (!input.contract_kind || x.kind === input.contract_kind));
    if (matches.length !== 1) throw new Error(`契约 ${input.key} 不存在或引用不唯一`);
    record = matches[0]; label = record.kind + ':' + record.key; source = record.source;
  } else if (input.kind === 'formula') {
    if (!filled(input.name)) throw new Error('公式来源需要 name');
    record = (session.formulas || []).find(x => x.name === input.name);
    if (!record || record.state !== 'tests_passed') throw new Error(`公式 ${input.name} 未通过测试点核验`);
    label = record.name; source = record.source;
  } else if (input.kind === 'model_spec') {
    if (!/^Q[1-9]\d*$/.test(input.id || '')) throw new Error('模型规格来源需要 Q 编号');
    record = (session.model_specs || []).find(x => x.id === input.id);
    if (!record || modelSpec.specGate(session, { formal: true, question_id: record.question_id })) throw new Error(`模型规格 ${input.id} 不存在或不属于当前版本`);
    if (questionId != null && !relatedQuestion(session, questionId, record.question_id)) throw new Error('模型规格来源不属于当前子问或已声明依赖');
    label = record.id; source = record.spec.task.prompt_ref;
  } else throw new Error('来源 kind 仅支持 contract、formula 或 model_spec');
  const ref = { kind: input.kind, ...(input.key ? { key: input.key } : {}),
    ...(input.contract_kind ? { contract_kind: input.contract_kind } : {}),
    ...(input.name ? { name: input.name } : {}), ...(input.id ? { id: input.id } : {}) };
  return { ...ref, label, source, sha256: hash(JSON.stringify(record)) };
}

function premisesFor(session, entries, questionId) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 20) throw new Error('解析主张/示意图需要1—20个实际登记的题设、公式或规格来源');
  const rows = entries.map(entry => premiseSnapshot(session, entry, questionId));
  if (new Set(rows.map(row => row.kind + ':' + row.label)).size !== rows.length) throw new Error('来源不能重复');
  return rows;
}

function verificationFor(root, session, input, proof, questionId, statement, domain, q) {
  const runId = input?.run_id;
  const receipt = (session.verification_runs || []).find(x => x.run_id === runId);
  const blockers = verificationRun.receiptBlockers(root, receipt).concat(verificationRun.contextBlockers(root, session, receipt));
  if (blockers.length) throw new Error('解析核查需要有效 verification_run 回执：' + blockers.join('；'));
  if (q.evidence_invalidated_at && (!receipt.at || receipt.at <= q.evidence_invalidated_at)) throw new Error('解析核查早于上游提交失效点，须重新执行');
  if (!(receipt.inputs || []).some(row => row.rel === proof.path && row.sha256 === proof.sha256)) throw new Error('独立核查输入未绑定当前推导文件');
  const result = verificationRun.checkedFile(root, receipt.result);
  if (fs.statSync(result).size > 2_000_000) throw new Error('解析核查结果超过2MB');
  const data = JSON.parse(fs.readFileSync(result, 'utf8'));
  if (!data || data.checks_passed !== 1 || data.derivation_sha256 !== proof.sha256
      || data.question_id !== questionId || data.statement !== statement || data.domain !== domain) {
    throw new Error('解析核查输出必须绑定推导哈希、子问、原句和适用域，且 checks_passed=1');
  }
  const files = [receipt.script_source, receipt.script, receipt.result, receipt.log, ...receipt.inputs, ...receipt.copied_inputs]
    .map(row => ({ path: row.rel, sha256: row.sha256 }));
  return { run_id: receipt.run_id, at: receipt.at, receipt_sha256: hash(JSON.stringify(receipt)), files };
}

function analyticRecord(ctx, input) {
  const { session, workspace } = ctx;
  if (!session || !workspace || !input || typeof input !== 'object') throw new Error('缺会话或解析主张');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.id || '')) throw new Error('解析主张 ID 无效');
  if (!filled(input.text) || input.text.length > 2000 || !filled(input.scope) || input.scope.length > 500) throw new Error('解析主张需要原句 text 和适用域 scope');
  const q = questionFor(session, input.question_id);
  const spec = (session.model_specs || []).find(x => x.question_id === q.id);
  if (!spec || modelSpec.specGate(session, { formal: true, question_id: q.id })) throw new Error('解析主张需要当前子问的有效模型规格');
  const proofInput = input.proof;
  if (!proofInput || !filled(proofInput.path) || !filled(proofInput.quote) || proofInput.quote.length > 2000
      || !filled(proofInput.review_boundary) || proofInput.review_boundary.length > 500) throw new Error('解析主张需要 proof{path,quote,review_boundary}，引用不超过2000字、边界不超过500字');
  const proofFile = checkedFile(workspace, proofInput.path, 1_000_000);
  if (!proofFile.contents.toString('utf8').includes(proofInput.quote) || !proofInput.quote.includes(input.text)) throw new Error('推导文件缺少逐字解析主张');
  const proof = { path: proofFile.path, sha256: proofFile.sha256, bytes: proofFile.bytes,
    quote: proofInput.quote, review_boundary: proofInput.review_boundary };
  const premises = premisesFor(session, input.premises, q.id);
  const verification = verificationFor(workspace, session, input.verification, proof, q.id, input.text, input.scope, q);
  const references = snapshotFiles(workspace, input.references, 'references', input.text, q);
  return { kind: 'analytic', id: input.id, question_id: q.id, text: input.text, scope: input.scope, proof, premises,
    verification, references, figures: [], model_spec: modelSpec.specBinding(session, { question_id: q.id }),
    model_spec_sha256: hash(JSON.stringify(spec)), input_hash: currentInputHash(workspace), epoch: session.data_epoch || 0,
    registered_at: Date.now() };
}

function register(ctx, input) {
  const row = recordFor(ctx, input);
  const session = ctx.session;
  const existing = session.claim_trace?.claims || [];
  if (!Array.isArray(existing)) throw new Error('主张登记簿损坏');
  if (existing.length >= 100 && !existing.some(x => x.id === row.id)) throw new Error('主张登记簿最多100条');
  session.claim_trace = { ...session.claim_trace, version: 2, claims: [...existing.filter(x => x.id !== row.id), row] };
  session.claim_trace_required = true;
  return { ok: true, claim: row };
}

function diagramSources(root, session, entries, freshClaims, questionId) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 20) throw new Error('示意图需要1—20个已登记的题设、公式、模型规格或解析证明来源');
  return entries.map(entry => {
    if (entry?.kind !== 'proof') return premiseSnapshot(session, entry, questionId);
    if (!filled(entry.claim_id) || !filled(entry.path) || !filled(entry.quote) || entry.quote.length > 2000) throw new Error('证明来源需要 claim_id、path、quote，引用不超过2000字');
    const claim = freshClaims.find(x => x.id === entry.claim_id && x.kind === 'analytic' && x.status === 'fresh');
    if (!claim) throw new Error(`证明 ${entry.claim_id} 未登记或已经失效`);
    if (!relatedQuestion(session, questionId, claim.question_id)) throw new Error('解析证明来源不属于当前子问或已声明依赖');
    const file = checkedFile(root, entry.path, 1_000_000);
    if (file.path !== claim.proof.path || file.sha256 !== claim.proof.sha256
        || !file.contents.toString('utf8').includes(entry.quote)) throw new Error('示意图证明来源不匹配当前推导文件');
    return { kind: 'proof', claim_id: claim.id, path: file.path, quote: entry.quote,
      label: claim.id, sha256: file.sha256 };
  });
}

function diagramRecord(ctx, input) {
  const { workspace, session } = ctx;
  if (!session || !workspace || !input || !/^[A-Za-z0-9_-]{1,80}$/.test(input.id || '')) throw new Error('示意图需要有效 ID 与会话');
  const q = questionFor(session, input.question_id);
  const spec = (session.model_specs || []).find(x => x.question_id === q.id);
  if (!spec || modelSpec.specGate(session, { formal: true, question_id: q.id })) throw new Error('示意图需要当前子问的有效模型规格');
  const file = checkedFile(workspace, input.path);
  if (!(q.artifacts || []).some(a => a.path === file.path && a.kind === 'diagram')) throw new Error('示意图须先以 kind=diagram 挂接到对应子问');
  if (!filled(input.panel) || input.panel.length > 80) throw new Error('示意图需要面板名称');
  const freshClaims = (session.claim_trace?.claims || []).filter(row => row.kind === 'analytic').map(row => checkAnalytic(workspace, session, row));
  const sources = diagramSources(workspace, session, input.sources, freshClaims, q.id);
  if (new Set(sources.map(x => x.kind + ':' + x.label)).size !== sources.length) throw new Error('示意图来源不能重复');
  const references = snapshotFiles(workspace, input.references, 'references', input.panel, q);
  return { id: input.id, question_id: q.id, kind: 'diagram', path: file.path, panel: input.panel,
    sha256: file.sha256, bytes: file.bytes, sources, references, model_spec: modelSpec.specBinding(session, { question_id: q.id }),
    model_spec_sha256: hash(JSON.stringify(spec)), input_hash: currentInputHash(workspace), epoch: session.data_epoch || 0,
    registered_at: Date.now() };
}

function registerDiagram(ctx, input) {
  const row = diagramRecord(ctx, input);
  const session = ctx.session, existing = session.claim_trace?.diagrams || [];
  if (!Array.isArray(existing) || (existing.length >= 100 && !existing.some(x => x.id === row.id))) throw new Error('示意图登记簿无效或超过100项');
  session.claim_trace = { ...session.claim_trace, version: 2, diagrams: [...existing.filter(x => x.id !== row.id), row] };
  session.claim_trace_required = true;
  return { ok: true, diagram: row };
}

function checkAnalytic(root, session, row) {
  const reasons = [];
  try {
    const q = questionFor(session, row.question_id);
    if (!Array.isArray(row.premises) || !row.premises.length) reasons.push('解析主张缺少题设、公式或模型规格来源');
    const spec = (session.model_specs || []).find(x => x.question_id === row.question_id);
    if (!spec || modelSpec.specGate(session, { formal: true, question_id: row.question_id })
        || JSON.stringify(row.model_spec) !== JSON.stringify(modelSpec.specBinding(session, { question_id: row.question_id }))
        || row.model_spec_sha256 !== hash(JSON.stringify(spec))) reasons.push('模型规格已变化');
    if (row.epoch !== (session.data_epoch || 0) || row.input_hash !== currentInputHash(root)) reasons.push('解析主张的代码、数据或输入版本已变化');
    for (const premise of row.premises || []) {
      try {
        const fresh = premiseSnapshot(session, premise, row.question_id);
        if (fresh.sha256 !== premise.sha256) reasons.push(`题设/公式来源 ${premise.label} 已变化`);
      } catch (e) { reasons.push(`题设/公式来源 ${premise.label || ''}：${e.message}`); }
    }
    try {
      const file = checkedFile(root, row.proof.path, 1_000_000);
      if (file.sha256 !== row.proof.sha256 || !file.contents.toString('utf8').includes(row.proof.quote)
          || !row.proof.quote.includes(row.text)) reasons.push('推导文件版本或逐字主张已变化');
      const current = verificationFor(root, session, { run_id: row.verification.run_id }, row.proof,
        row.question_id, row.text, row.scope, q);
      if (current.receipt_sha256 !== row.verification.receipt_sha256) reasons.push('解析核查回执已变化');
    } catch (e) { reasons.push('解析核查或推导文件：' + e.message); }
    for (const ref of row.references || []) {
      try {
        const file = checkedFile(root, ref.path);
        if (file.sha256 !== ref.sha256 || !file.contents.toString('utf8').includes(ref.quote)
            || !ref.quote.includes(row.text)) reasons.push(`文稿引用 ${ref.path} 版本已变化`);
      } catch (e) { reasons.push(`文稿引用 ${ref.path}：${e.message}`); }
    }
  } catch (e) { reasons.push(String(e.message || e)); }
  return { ...row, status: reasons.length ? 'stale' : 'fresh', reasons: [...new Set(reasons)] };
}

function checkDiagram(root, session, row, freshClaims) {
  const reasons = [];
  try {
    const q = questionFor(session, row.question_id);
    if (!Array.isArray(row.sources) || !row.sources.length) reasons.push('示意图缺少来源');
    if (!(q.artifacts || []).some(a => a.path === row.path && a.kind === 'diagram')) reasons.push('示意图已从子问挂接中移除');
    const spec = (session.model_specs || []).find(x => x.question_id === row.question_id);
    if (!spec || modelSpec.specGate(session, { formal: true, question_id: row.question_id })
        || JSON.stringify(row.model_spec) !== JSON.stringify(modelSpec.specBinding(session, { question_id: row.question_id }))
        || row.model_spec_sha256 !== hash(JSON.stringify(spec))) reasons.push('示意图的模型规格已变化');
    if (row.epoch !== (session.data_epoch || 0) || row.input_hash !== currentInputHash(root)) reasons.push('示意图的输入版本已变化');
    const file = checkedFile(root, row.path);
    if (file.sha256 !== row.sha256) reasons.push('示意图版本已变化');
    for (const source of row.sources || []) {
      try {
        if (source.kind === 'proof') {
          const claim = freshClaims.find(x => x.id === source.claim_id && x.kind === 'analytic' && x.status === 'fresh');
          const proofFile = checkedFile(root, source.path, 1_000_000);
          if (!claim || !relatedQuestion(session, row.question_id, claim.question_id) || claim.proof.path !== proofFile.path || claim.proof.sha256 !== proofFile.sha256
              || source.sha256 !== proofFile.sha256 || !proofFile.contents.toString('utf8').includes(source.quote)) reasons.push(`证明来源 ${source.claim_id} 已变化`);
        } else if (premiseSnapshot(session, source, row.question_id).sha256 !== source.sha256) reasons.push(`题设/公式来源 ${source.label} 已变化`);
      } catch (e) { reasons.push(`图来源 ${source.label || ''}：${e.message}`); }
    }
    for (const ref of row.references || []) {
      try {
        const doc = checkedFile(root, ref.path);
        if (doc.sha256 !== ref.sha256 || !doc.contents.toString('utf8').includes(ref.quote)) reasons.push(`示意图文稿引用 ${ref.path} 已变化`);
      } catch (e) { reasons.push(`示意图文稿引用 ${ref.path}：${e.message}`); }
    }
  } catch (e) { reasons.push(String(e.message || e)); }
  return { ...row, status: reasons.length ? 'stale' : 'fresh', reasons: [...new Set(reasons)] };
}

function checkRow(root, session, row) {
  if (row.kind === 'analytic') return checkAnalytic(root, session, row);
  const reasons = [];
  try {
    const fresh = require('./optimization_trace').claimCheck(root, session, {
      ...row, optimality: row.optimality ? { level: row.optimality.report.level } : undefined,
    });
    if (JSON.stringify(fresh) !== JSON.stringify(row.optimality)) reasons.push('最优性证据或结论范围已变化');
  } catch (e) { reasons.push('最优性范围：' + e.message); }
  let run;
  try { run = checkedRun(root, session, row.question_id, row.run_id); }
  catch (e) { reasons.push(String(e.message || e)); }
  if (run && fingerprint(run) !== row.run_fingerprint) reasons.push('运行记录或产出回执已改变');
  try {
    const file = checkedFile(root, row.source?.path);
    if (file.sha256 !== row.source.sha256 || file.bytes !== row.source.bytes) reasons.push('结果文件内容已改变');
    if (run) receiptFor(run, file);
    const value = transformOf(row.transform, sourceData(file, row.source.field)).value;
    if (JSON.stringify(value) !== JSON.stringify(row.value)) reasons.push('结果字段或变换后的数值已改变');
    displayCheck(value, row.displayed_value, row.decimals);
  } catch (e) { reasons.push(String(e.message || e)); }
  for (const [kind, entries] of [['数据图', row.figures], ['文稿引用', row.references]]) {
    for (const entry of entries || []) {
      try {
        const file = checkedFile(root, entry.path);
        if (file.sha256 !== entry.sha256 || file.bytes !== entry.bytes) reasons.push(`${kind} ${entry.path} 版本已改变`);
        if (kind === '文稿引用' && (!file.contents.toString('utf8').includes(entry.quote) || !entry.quote.includes(row.text))) reasons.push(`${kind} ${entry.path} 原文已改变`);
        if (kind === '数据图') {
          if (run) {
            if (entry.plot_run_id) require('./plugin_runtime').validatePlot(root, session, entry.plot_run_id, row.question_id, run.run_id, row.source.path, entry, row.source.field);
            else receiptFor(run, file);
          }
          const q = (session.question_graph || []).find(x => x.id === row.question_id);
          if (!(q?.artifacts || []).some(a => String(a.path || a.rel || a).replace(/\\/g, '/') === file.path)) reasons.push(`数据图 ${entry.path} 已从问题挂接中移除`);
        }
      } catch (e) { reasons.push(`${kind} ${entry.path}：${String(e.message || e)}`); }
    }
  }
  return { ...row, status: reasons.length ? 'stale' : 'fresh', reasons: [...new Set(reasons)] };
}

function inspect(root, session) {
  const rows = session?.claim_trace?.claims;
  const diagramRows = session?.claim_trace?.diagrams;
  const required = !!session?.claim_trace_required || !!(Array.isArray(rows) && rows.length) || !!(Array.isArray(diagramRows) && diagramRows.length);
  if ((!Array.isArray(rows) || !rows.length) && (!Array.isArray(diagramRows) || !diagramRows.length)) {
    return { status: 'unregistered', required, claims: [], diagrams: [], issues: [], limits: LIMITS.slice() };
  }
  const claims = (Array.isArray(rows) ? rows : []).map((row, index) => {
    try { return checkRow(root, session, row); }
    catch (error) { return { id: typeof row?.id === 'string' ? row.id : `记录${index + 1}`, status: 'stale', reasons: ['登记记录损坏：' + String(error.message || error)] }; }
  });
  const diagrams = (Array.isArray(diagramRows) ? diagramRows : []).map((row, index) => {
    try { return checkDiagram(root, session, row, claims); }
    catch (error) { return { id: typeof row?.id === 'string' ? row.id : `示意图${index + 1}`, status: 'stale', reasons: ['示意图登记损坏：' + String(error.message || error)] }; }
  });
  const issues = [...claims, ...diagrams].filter(x => x.status === 'stale').flatMap(x => x.reasons.map(reason => `${x.id}：${reason}`));
  return { status: issues.length ? 'stale' : 'fresh', required, claims, diagrams, issues, limits: LIMITS.slice() };
}

function blockers(root, session, options = {}) {
  const state = inspect(root, session);
  if (!state.required) return [];
  const issues = state.issues.map(x => `证据追溯 ${x}`);
  if (!options.final) return issues;
  if (!state.claims.length) issues.push('证据追溯已启用但没有登记关键主张');
  const fresh = state.claims.filter(x => x.status === 'fresh');
  const freshDiagrams = state.diagrams.filter(x => x.status === 'fresh');
  for (const q of session.question_graph || []) {
    if (!fresh.some(x => x.question_id === q.id)) issues.push(`问题${q.id} 缺少当前版本的数值主张追溯`);
    for (const artifact of q.artifacts || []) {
      const kind = String(artifact.kind || '').toLowerCase();
      if (kind === 'diagram') {
        const rel = String(artifact.path || artifact.rel || artifact).replace(/\\/g, '/');
        if (!freshDiagrams.some(x => x.question_id === q.id && x.path === rel)) issues.push(`问题${q.id} 示意图 ${rel} 尚未绑定题设、公式或核查过的证明来源`);
        continue;
      }
      if (!['figure', 'chart', 'plot', 'table'].includes(kind)) continue;
      const rel = String(artifact.path || artifact.rel || artifact).replace(/\\/g, '/');
      if (!fresh.some(x => x.question_id === q.id && x.figures.some(f => f.path === rel))) issues.push(`问题${q.id} 数据图/表 ${rel} 尚未绑定主张与正式结果`);
    }
  }
  if (!fresh.some(x => x.references.some(r => r.kind === 'abstract'))) issues.push('摘要没有指向当前版本的关键主张');
  const manuscript = session.paper_audit?.tex_path || (session.abstract_check?.src !== '(text)' && session.abstract_check?.src);
  if (manuscript) {
    try {
      const doc = checkedFile(root, manuscript);
      const extracted = require('./tools').extractAbstract(doc.contents.toString('utf8'), /\.tex$/i.test(doc.path) ? 'tex' : 'md');
      if (!extracted || extracted.src === '整个文本') throw new Error('稿件缺少明确的摘要区域');
      const body = extracted.body;
      if (!fresh.some(c => c.references.some(r => r.kind === 'abstract' && r.path === doc.path && body.includes(r.quote)))) {
        issues.push('当前论文摘要没有绑定当前结果的逐字主张引用');
      }
    } catch (e) { issues.push('当前论文摘要追溯无法核验：' + e.message); }
  }
  return [...new Set(issues)];
}

function manifest(root, session) {
  const state = inspect(root, session);
  const optimization = require('./optimization_trace');
  return { schema_version: 2, ...state, optimization_checks: optimization.inspect(root, session),
    final_blockers: [...new Set([...blockers(root, session, { final: true }), ...optimization.blockers(root, session)])] };
}

function files(root, session) {
  const paths = new Set();
  const add = rel => { if (filled(rel)) { checkedFile(root, rel); paths.add(rel); } };
  for (const record of session.optimization_checks || []) add(record.source?.path);
  for (const row of session.claim_trace?.claims || []) {
    add(row.source?.path); add(row.proof?.path);
    for (const entry of row.verification?.files || []) add(entry.path);
    for (const entry of row.figures || []) add(entry.path);
    for (const entry of row.figures || []) if (entry.plot_run_id) {
      const plot = (session.plugin_runs || []).find(p => p.plot_run_id === entry.plot_run_id);
      if (!plot?.ok) throw new Error('图件插件回执缺失或失败');
      add(plot.receipt_file?.path); add(plot.recipe?.path); add(plot.manifest?.path);
      for (const file of plot.execution_files || []) add(file.path);
    }
    for (const entry of row.references || []) add(entry.path);
  }
  for (const row of session.claim_trace?.diagrams || []) {
    add(row.path);
    for (const entry of row.sources || []) if (entry.kind === 'proof') add(entry.path);
    for (const entry of row.references || []) add(entry.path);
  }
  return [...paths];
}

module.exports = { register, registerDiagram, inspect, blockers, manifest, files, sourceFor };
