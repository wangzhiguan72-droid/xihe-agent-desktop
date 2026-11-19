'use strict';

// A deliberately small, independently checked optimization certificate. Its
// scope is the registered polynomial model, never the original contest task.
const MAX_POINTS = 10_000;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const keysOnly = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

function validateCheck(check) {
  const errors = [];
  if (!keysOnly(check, ['direction', 'variables', 'objective', 'constraints'])) return { ok: false, errors: ['优化检查定义须为对象且不能包含未知字段'] };
  if (!['min', 'max'].includes(check.direction)) errors.push('direction 须为 min 或 max');
  const variables = check.variables;
  if (!Array.isArray(variables) || variables.length < 1 || variables.length > 8) errors.push('variables 须有 1–8 个变量');
  const names = new Set();
  let totalTerms = 0;
  for (const [i, variable] of (Array.isArray(variables) ? variables.slice(0, 8) : []).entries()) {
    if (!keysOnly(variable, ['name', 'domain']) || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(variable.name || '') || names.has(variable.name)) {
      errors.push(`variables[${i}] 名称无效、重复或含未知字段`); continue;
    }
    names.add(variable.name);
    const domain = variable.domain;
    if (domain?.kind === 'finite') {
      if (!keysOnly(domain, ['kind', 'values']) || !Array.isArray(domain.values) || domain.values.length < 1 || domain.values.length > MAX_POINTS
          || !domain.values.every(finite) || new Set(domain.values).size !== domain.values.length) errors.push(`variables[${i}] 有限域无效或含重复值`);
    } else if (domain?.kind === 'interval') {
      if (!keysOnly(domain, ['kind', 'min', 'max']) || !finite(domain.min) || !finite(domain.max) || domain.min > domain.max) errors.push(`variables[${i}] 区间域无效`);
    } else errors.push(`variables[${i}] 域类型仅支持 finite/interval`);
  }
  function polynomial(poly, at) {
    if (!keysOnly(poly, ['constant', 'terms']) || (own(poly || {}, 'constant') && !finite(poly.constant))
        || !Array.isArray(poly?.terms) || poly.terms.length > 100) { errors.push(`${at} 多项式结构无效`); return; }
    totalTerms += poly.terms.length;
    for (const [i, term] of poly.terms.entries()) {
      if (!keysOnly(term, ['coefficient', 'powers']) || !finite(term.coefficient) || !object(term.powers)
          || !Object.keys(term.powers).length || Object.entries(term.powers).some(([name, power]) => !names.has(name) || !Number.isInteger(power) || power < 0 || power > 2)
          || Object.values(term.powers).reduce((sum, power) => sum + power, 0) > 2) errors.push(`${at}.terms[${i}] 系数或幂次无效`);
    }
  }
  polynomial(check.objective, 'objective');
  if (!Array.isArray(check.constraints) || check.constraints.length > 100) errors.push('constraints 须为不超过 100 条的数组');
  else check.constraints.forEach((constraint, i) => {
    if (!keysOnly(constraint, ['polynomial', 'sense', 'rhs']) || !['le', 'ge', 'eq'].includes(constraint.sense) || !finite(constraint.rhs)) errors.push(`constraints[${i}] 结构无效`);
    else polynomial(constraint.polynomial, `constraints[${i}].polynomial`);
  });
  if (totalTerms > 100) errors.push('所有目标与约束合计不得超过 100 项');
  return { ok: errors.length === 0, errors };
}

function gcd(a, b) {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}
function rational(n, d = 1n) {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
function decimal(value) {
  if (!finite(value)) throw new Error('数值必须有限');
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new Error('数值不是可核验的小数');
  const digits = match[2] + (match[3] || '');
  const exp = Number(match[4] || 0) - (match[3] || '').length;
  const signed = BigInt(digits) * (match[1] ? -1n : 1n);
  return exp >= 0 ? rational(signed * 10n ** BigInt(exp)) : rational(signed, 10n ** BigInt(-exp));
}
const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a, b) => rational(a.n * b.n, a.d * b.d);
const compare = (a, b) => {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};
function evaluate(poly, point) {
  let total = decimal(poly.constant || 0);
  for (const term of poly.terms) {
    let product = decimal(term.coefficient);
    for (const [name, power] of Object.entries(term.powers)) for (let i = 0; i < power; i++) product = mul(product, decimal(point[name]));
    total = add(total, product);
  }
  return total;
}
function pointKey(check, point) { return check.variables.map(variable => String(point[variable.name])).join('|'); }
function validPoint(check, point, at) {
  const expected = check.variables.map(variable => variable.name);
  if (!object(point) || Object.keys(point).length !== expected.length || expected.some(name => !own(point, name) || !finite(point[name]))) throw new Error(`${at} 坐标缺失、非有限或含多余字段`);
  for (const variable of check.variables) {
    const value = point[variable.name];
    const domain = variable.domain;
    if (domain.kind === 'finite' ? !domain.values.includes(value) : value < domain.min || value > domain.max) throw new Error(`${at} 超出登记的决策域`);
  }
}
function feasible(check, point) {
  return check.constraints.every(constraint => {
    const sign = compare(evaluate(constraint.polynomial, point), decimal(constraint.rhs));
    return constraint.sense === 'le' ? sign <= 0 : constraint.sense === 'ge' ? sign >= 0 : sign === 0;
  });
}
function rows(check, result, axes) {
  if (!Array.isArray(result.candidates) || !result.candidates.length || result.candidates.length > MAX_POINTS) throw new Error('候选记录须为 1–10000 条');
  const found = new Set();
  const axisSets = axes && Object.fromEntries(Object.entries(axes).map(([name, values]) => [name, new Set(values)]));
  let feasiblePoints = 0;
  let best = null;
  for (const [i, row] of result.candidates.entries()) {
    if (!keysOnly(row, ['point', 'objective']) || !own(row, 'point') || !finite(row.objective)) throw new Error(`candidates[${i}] 结构无效`);
    validPoint(check, row.point, `candidates[${i}]`);
    if (axisSets && check.variables.some(variable => !axisSets[variable.name].has(row.point[variable.name]))) throw new Error(`candidates[${i}] 不在登记网格`);
    const key = pointKey(check, row.point);
    if (found.has(key)) throw new Error('候选坐标重复');
    found.add(key);
    if (compare(evaluate(check.objective, row.point), decimal(row.objective)) !== 0) throw new Error(`candidates[${i}] 目标值与模型回代不符`);
    if (feasible(check, row.point)) {
      feasiblePoints++;
      const value = decimal(row.objective);
      if (best === null || (check.direction === 'min' ? compare(value, best) < 0 : compare(value, best) > 0)) best = value;
    }
  }
  return { found, feasiblePoints, best };
}
function axesFor(check, result) {
  const names = check.variables.map(variable => variable.name);
  if (!object(result.axes) || Object.keys(result.axes).length !== names.length || names.some(name => !own(result.axes, name))) throw new Error('网格 axes 须覆盖全部变量');
  let count = 1;
  for (const variable of check.variables) {
    const values = result.axes[variable.name];
    if (!Array.isArray(values) || !values.length || !values.every(finite) || new Set(values).size !== values.length) throw new Error('网格轴须为非空、有限且无重复的坐标');
    for (const value of values) validPoint(check, Object.fromEntries(check.variables.map(v => [v.name, v.name === variable.name ? value : v.domain.kind === 'finite' ? v.domain.values[0] : v.domain.min])), '网格轴');
    count *= values.length;
    if (count > MAX_POINTS) throw new Error('网格超过 10000 点上限');
  }
  return count;
}
function finiteDomainCount(check) {
  let count = 1;
  for (const variable of check.variables) {
    if (variable.domain.kind !== 'finite') throw new Error('连续区间不能声称有限域全域最优');
    count *= variable.domain.values.length;
    if (count > MAX_POINTS) throw new Error('有限域超过 10000 点上限');
  }
  return count;
}
function enumerate(check, visit, index = 0, point = {}) {
  if (index === check.variables.length) { visit({ ...point }); return; }
  const variable = check.variables[index];
  for (const value of variable.domain.values) { point[variable.name] = value; enumerate(check, visit, index + 1, point); }
}

function verify(check, result) {
  const validation = validateCheck(check);
  if (!validation.ok) throw new Error(`优化检查定义无效：${validation.errors.join('；')}`);
  if (!keysOnly(result, ['level', 'solution', 'objective', 'candidates', 'axes']) || !['feasible', 'candidates', 'grid', 'finite_domain'].includes(result.level)
      || !finite(result.objective)) throw new Error('优化结果结构或主张级别无效');
  if (result.level === 'feasible' && (own(result, 'candidates') || own(result, 'axes'))
      || result.level === 'candidates' && own(result, 'axes')
      || result.level === 'finite_domain' && (own(result, 'candidates') || own(result, 'axes'))) throw new Error('当前主张级别包含不适用的候选或网格字段');
  if (result.level === 'grid' && !own(result, 'candidates')) throw new Error('网格主张缺少候选记录');
  validPoint(check, result.solution, '解');
  if (!feasible(check, result.solution)) throw new Error('所称解不满足登记约束');
  const objective = decimal(result.objective);
  if (compare(evaluate(check.objective, result.solution), objective) !== 0) throw new Error('所称目标值与模型回代不符');
  let checked = 1; let count = 1; let feasiblePoints = 1;
  if (result.level === 'candidates' || result.level === 'grid') {
    if (result.level === 'grid') count = axesFor(check, result);
    const inspected = rows(check, result, result.level === 'grid' ? result.axes : null);
    if (!inspected.found.has(pointKey(check, result.solution))) throw new Error('所称解不在已检查候选集合内');
    if (result.level === 'grid' && inspected.found.size !== count) throw new Error('候选记录未覆盖完整登记网格');
    if (compare(inspected.best, objective) !== 0) throw new Error('已检查集合存在更优可行解');
    checked = inspected.found.size; feasiblePoints = inspected.feasiblePoints;
  } else if (result.level === 'finite_domain') {
    count = finiteDomainCount(check);
    feasiblePoints = 0;
    enumerate(check, point => {
      if (!feasible(check, point)) return;
      feasiblePoints++;
      const cmp = compare(evaluate(check.objective, point), objective);
      if (check.direction === 'min' ? cmp < 0 : cmp > 0) throw new Error('有限域中存在更优可行解');
    });
    checked = count;
  }
  const scopes = { feasible: '已登记模型下的可行解', candidates: '已登记候选集合内最优', grid: '已登记网格内最优', finite_domain: '已登记完整有限域内最优' };
  return { level: result.level, direction: check.direction, solution: { ...result.solution }, objective: result.objective,
    checked_points: checked, feasible_points: feasiblePoints,
    domain_points: result.level === 'finite_domain' ? count : null,
    optimality_scope: scopes[result.level],
    boundary: '仅核查登记的多项式目标、约束与决策域；原题建模正确性及连续域全局最优仍需另证。' };
}

module.exports = { validateCheck, verify };
