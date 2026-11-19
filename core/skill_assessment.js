'use strict';
// Declarative compatibility only. A matching contract is not a mathematical proof.
const fs = require('fs');
const path = require('path');
const FILE = 'skill-contract.json';
const SLOTS = ['main', 'research', 'figures', 'review'];
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '须为对象');
  return value;
};
function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(label + '未知字段：' + key);
}
function list(value, label, nullable = false) {
  if (value == null && nullable) return null;
  if (!Array.isArray(value) || value.length > 40 || value.some(x => typeof x !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,99}$/.test(x))) throw new Error(label + '须为最多40项标识符数组');
  return [...new Set(value)].sort();
}
function constraints(value = {}) {
  object(value, 'constraints');
  if (Object.keys(value).length > 40) throw new Error('constraints过多');
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(key) || typeof v !== 'string' || !v.trim() || v.length > 200) throw new Error('constraints须为参数标识符到非空字符串的映射');
    Object.defineProperty(result, key, { value: v.trim(), enumerable: true });
  }
  return result;
}
function normalizeContext(value = {}) {
  keys(value, ['problem_types', 'stages', 'data', 'constraints'], 'task_context');
  return { problem_types: list(value.problem_types, 'problem_types', true), stages: list(value.stages, 'stages', true),
    data: list(value.data, 'data', true), constraints: constraints(value.constraints) };
}
function normalizeContract(value) {
  keys(value, ['schema_version', 'slots', 'modes', 'problem_types', 'stages', 'contest_kinds', 'requires', 'conflicts', 'constraints'], FILE);
  if (value.schema_version !== 1) throw new Error(FILE + ' schema_version必须为1');
  const result = { schema_version: 1 };
  for (const key of ['slots', 'modes', 'problem_types', 'stages', 'contest_kinds']) if (value[key] != null) {
    result[key] = list(value[key], key);
    if (!result[key].length) throw new Error(key + '适用范围不能为空；通用范围请省略字段');
  }
  if (result.slots?.some(x => !SLOTS.includes(x)) || result.modes?.some(x => !['append', 'replace'].includes(x))) throw new Error('Skill槽位或模式无效');
  keys(value.requires || {}, ['data', 'tools', 'plugins'], 'requires');
  result.requires = Object.fromEntries(['data', 'tools', 'plugins'].map(key => [key, list(value.requires?.[key] || [], 'requires.' + key)]));
  result.conflicts = list(value.conflicts || [], 'conflicts');
  result.constraints = constraints(value.constraints);
  return result;
}
function readContract(dir) {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return null;
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile() || st.size > 64000) throw new Error(FILE + '须为不超过64KB的普通文件');
  return normalizeContract(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function assess(contract, { slot, mode, contest_kind, context = {}, tools = [], plugins = [] }) {
  if (!contract) return { status: 'unknown', reasons: ['缺少skill-contract.json适用性声明'] };
  context = normalizeContext(context);
  const errors = [], unknown = [];
  for (const [key, actual] of [['slots', slot], ['modes', mode], ['contest_kinds', contest_kind]]) {
    if (actual != null && contract[key] && !contract[key].includes(actual)) errors.push(`${key}不支持${actual}`);
  }
  for (const key of ['problem_types', 'stages']) if (contract[key]) {
    if (context[key] == null) unknown.push(`尚未登记${key}`);
    // Whole selected scope must fit. A mixed problem must be split into narrower tasks.
    else if (!context[key].length || context[key].some(x => !contract[key].includes(x))) errors.push(`${key}与声明范围不匹配（${context[key].join('、') || '无'}）`);
  }
  if (contract.requires.data.length) {
    if (context.data == null) unknown.push('尚未登记可用数据');
    else for (const item of contract.requires.data) if (!context.data.includes(item)) errors.push('缺少数据：' + item);
  }
  for (const [key, available] of [['tools', tools], ['plugins', plugins]]) for (const item of contract.requires[key]) {
    if (!available.includes(item)) errors.push(`缺少${key}：${item}`);
  }
  for (const [key, expected] of Object.entries(contract.constraints)) {
    if (context.constraints[key] == null) unknown.push(`固定参数${key}=${expected}尚未核对`);
    else if (context.constraints[key] !== expected) errors.push(`固定参数${key}冲突：任务${context.constraints[key]}，Skill ${expected}`);
  }
  return { status: errors.length ? 'incompatible' : unknown.length ? 'unknown' : 'compatible', reasons: [...errors, ...unknown] };
}
function combinationConflicts(entries, loaded) {
  const active = entries.filter(row => row.status === 'loaded' && !row.blocked);
  const contracts = new Map(loaded.map(row => [row.slot, row.skill.contract]));
  const issues = new Map();
  const add = (row, reason) => { if (!issues.has(row.slot)) issues.set(row.slot, []); issues.get(row.slot).push(reason); };
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j], ca = contracts.get(a.slot), cb = contracts.get(b.slot);
    if (ca?.conflicts.includes(b.name) || cb?.conflicts.includes(a.name)) {
      add(a, `与${b.slot}/${b.name}互斥`); add(b, `与${a.slot}/${a.name}互斥`);
    }
    for (const [key, value] of Object.entries(ca?.constraints || {})) if (cb?.constraints[key] != null && cb.constraints[key] !== value) {
      add(a, `固定参数${key}与${b.slot}/${b.name}冲突`); add(b, `固定参数${key}与${a.slot}/${a.name}冲突`);
    }
  }
  for (const row of active) if (issues.has(row.slot)) {
    row.blocked = true;
    row.applicability = { status: 'incompatible', reasons: [...row.applicability.reasons, ...issues.get(row.slot)] };
  }
}
function summarize(entries) {
  const active = entries.filter(row => row.status !== 'off');
  const status = active.some(row => row.status !== 'loaded' || row.blocked) ? 'incompatible'
    : active.some(row => row.applicability.status === 'unknown') ? 'unknown' : 'compatible';
  return { status, reasons: active.flatMap(row => (row.applicability?.reasons || []).map(reason => `${row.slot}: ${reason}`)),
    scope: '声明条件匹配；任务信息由用户登记，工具仅检查宿主注册，未验证数学正确性、凭据或外部服务健康' };
}
module.exports = { FILE, normalizeContext, normalizeContract, readContract, assess, combinationConflicts, summarize };
