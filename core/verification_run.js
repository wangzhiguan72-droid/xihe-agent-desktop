'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Sandbox } = require('./sandbox');
const { sha256 } = require('./support_integrity');
const HASH = /^[a-f0-9]{64}$/i;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

function hostContext(root, session = {}) {
  const agent = require('./agent');
  const semantic = record => Object.fromEntries(Object.entries(record).filter(([key]) => !['at', 'registered_at', 'confirmed'].includes(key)));
  return {
    schema_version: 1,
    input_hash: agent.inputStampHash(agent.stampInputFiles(root)),
    epoch: session.data_epoch || 0,
    math_sha256: crypto.createHash('sha256').update(JSON.stringify(stable({
      specs: (session.model_specs || []).map(semantic),
      contracts: (session.contract || []).map(semantic),
      formulas: (session.formulas || []).map(semantic),
    }))).digest('hex'),
  };
}
function contextBlockers(root, session, receipt) {
  if (!receipt?.host_context) return ['核查回执缺少执行时的主线输入与模型前提版本，须重新执行'];
  return JSON.stringify(receipt.host_context) === JSON.stringify(hostContext(root, session)) ? [] : ['核查执行时的主线输入、模型规格或题设/公式前提已变化，须重新执行'];
}

function checkedFile(root, row) {
  if (!row || typeof row.rel !== 'string' || path.isAbsolute(row.rel) || !HASH.test(row.sha256 || '')) throw new Error('文件缺有效相对路径或SHA-256');
  const sb = new Sandbox(root, { readOnlyRoots: [] });
  const abs = sb.resolve(row.rel, 'r');
  if (!fs.statSync(abs).isFile() || sha256(abs) !== row.sha256.toLowerCase()) throw new Error('文件缺失或哈希已变化：' + row.rel);
  return abs;
}
function receiptBlockers(root, receipt) {
  if (!receipt || typeof receipt.run_id !== 'string' || receipt.ok !== true || receipt.exit_code !== 0) return ['缺宿主成功运行回执'];
  const issues = [];
  if (!Array.isArray(receipt.inputs) || !Array.isArray(receipt.copied_inputs)) return ['回执缺输入清单'];
  for (const row of [receipt.script_source, receipt.script, receipt.result, receipt.log, ...receipt.inputs, ...receipt.copied_inputs]) {
    try { checkedFile(root, row); } catch (e) { issues.push(e.message); }
  }
  return issues;
}
async function runVerification(ctx, args, execute) {
  const root = ctx.workspace || ctx.sandbox.root;
  const beforeContext = hostContext(root, ctx.session);
  const rel = value => {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0')) throw new Error('需提供工作区相对路径');
    const abs = ctx.sandbox.resolve(value, 'r');
    const relative = path.relative(root, abs).replace(/\\/g, '/');
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('路径越界');
    return relative;
  };
  const scriptRel = rel(args.script);
  if (!/\.py$/i.test(scriptRel)) throw new Error('独立运行当前支持Python脚本');
  const inputNames = args.inputs ?? [];
  if (!Array.isArray(inputNames) || inputNames.length > 500) throw new Error('输入清单须为最多500个文件');
  const names = [scriptRel, ...inputNames.map(rel)];
  if (new Set(names).size !== names.length) throw new Error('脚本或输入清单重复');
  if (names.includes('execution.log')) throw new Error('execution.log为运行器保留文件名');
  if (typeof args.result !== 'string' || !/\.json$/i.test(args.result)) throw new Error('result须为隔离目录内的JSON相对路径');
  const resultName = path.normalize(args.result).replace(/\\/g, '/');
  if (path.isAbsolute(resultName) || resultName === '..' || resultName.startsWith('../') || resultName.includes('\0') || names.includes(resultName)) throw new Error('结果路径越界或覆盖输入');
  const sourceRows = names.map(name => {
    const file = ctx.sandbox.resolve(name, 'r');
    if (!fs.statSync(file).isFile()) throw new Error('输入不是文件：' + name);
    return { rel: name, sha256: sha256(file) };
  });
  const run_id = 'verify_' + crypto.randomBytes(10).toString('hex');
  const prefix = 'verification_runs/' + run_id;
  const isolated = ctx.sandbox.resolve(prefix, 'w');
  fs.mkdirSync(isolated, { recursive: true });
  const sb = new Sandbox(isolated, { readOnlyRoots: [] });
  const copy = row => {
    const to = sb.resolve(row.rel, 'w');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(ctx.sandbox.resolve(row.rel, 'r'), to);
    return { rel: prefix + '/' + row.rel, sha256: sha256(to) };
  };
  const copies = sourceRows.map(copy);
  const destination = sb.resolve(resultName, 'w');
  if (fs.existsSync(destination)) throw new Error('隔离结果必须由本次运行生成');
  const isolatedCtx = { ...ctx, workspace: isolated, sandbox: sb, pyMode: 'rw', session: { id: run_id, mode: 'code' } };
  let run;
  try { run = await execute(isolatedCtx, scriptRel, args.timeout_sec); }
  catch (e) { run = { exit: null, stderr: e.message }; }
  const exit = run?.exit ?? run?.exit_code ?? (run?.ok === true ? 0 : null);
  const logPath = sb.resolve('execution.log', 'w');
  fs.writeFileSync(logPath, [run?.stdout, run?.stderr, run?.out].filter(Boolean).join('\n').slice(-100000), 'utf8');
  const receipt = { run_id, at: Date.now(), ok: exit === 0, exit_code: exit, host_context: beforeContext,
    script_source: sourceRows[0], script: copies[0], inputs: sourceRows.slice(1), copied_inputs: copies.slice(1),
    result: null, log: { rel: prefix + '/execution.log', sha256: sha256(logPath) } };
  try {
    if (fs.statSync(destination).size > 2_000_000) throw new Error('结果JSON超过2MB');
    const obj = JSON.parse(fs.readFileSync(sb.resolve(resultName, 'r'), 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('结果JSON根须为对象');
    receipt.result = { rel: prefix + '/' + resultName, sha256: sha256(destination) };
    for (let i = 0; i < copies.length; i++) {
      checkedFile(root, copies[i]); checkedFile(root, sourceRows[i]);
      if (copies[i].sha256 !== sourceRows[i].sha256) throw new Error('复制输入不稳定');
    }
  } catch (e) { receipt.ok = false; receipt.error = e.message; }
  const contextIssues = contextBlockers(root, ctx.session, receipt);
  if (contextIssues.length) { receipt.ok = false; receipt.error = contextIssues.join('；'); }
  ctx.session.verification_runs = [...(ctx.session.verification_runs || []), receipt].slice(-100);
  return receipt;
}
module.exports = { runVerification, receiptBlockers, checkedFile, hostContext, contextBlockers };
