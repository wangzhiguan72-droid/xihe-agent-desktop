'use strict';
const assert = require('assert/strict');
const { validateCheck, verify } = require('./optimization_evidence');

const linear = (coefficient, name = 'x', constant = 0) => ({ constant, terms: [{ coefficient, powers: { [name]: 1 } }] });
const model = {
  direction: 'min', variables: [{ name: 'x', domain: { kind: 'finite', values: [0, 1, 2] } }],
  objective: linear(1), constraints: [{ polynomial: linear(1), sense: 'ge', rhs: 1 }],
};
const point = x => ({ x });
const row = x => ({ point: point(x), objective: x });

assert.equal(validateCheck(model).ok, true);
assert.throws(() => verify(model, { level: 'feasible', solution: point(0), objective: 0 }), /约束/);
assert.throws(() => verify(model, { level: 'feasible', solution: point(1), objective: 0 }), /目标值/);
assert.throws(() => verify(model, { level: 'feasible', solution: { x: 1, y: 2 }, objective: 1 }), /坐标/);
assert.throws(() => verify(model, { level: 'feasible', solution: point(3), objective: 3 }), /决策域/);
assert.throws(() => verify(model, { level: 'global', solution: point(1), objective: 1 }), /级别/);
assert.throws(() => verify(model, { level: 'feasible', solution: point(1), objective: 1, status: 'optimal' }), /结构/);
assert.throws(() => verify(model, { level: 'feasible', solution: point(1), objective: 1, candidates: [row(1)] }), /不适用/);

const feasible = verify(model, { level: 'feasible', solution: point(2), objective: 2 });
assert.equal(feasible.optimality_scope, '已登记模型下的可行解');
assert.equal(feasible.domain_points, null);
assert.equal(feasible.feasible_points, 1);
assert.match(feasible.boundary, /原题/);

const sampled = verify(model, { level: 'candidates', solution: point(2), objective: 2, candidates: [row(0), row(2)] });
assert.equal(sampled.optimality_scope, '已登记候选集合内最优');
assert.equal(sampled.checked_points, 2);
assert.equal(sampled.feasible_points, 1);
assert.equal(sampled.domain_points, null, 'candidate coverage never establishes full domain');
assert.throws(() => verify(model, { level: 'candidates', solution: point(2), objective: 2, candidates: [row(1), row(2)] }), /更优/);
assert.throws(() => verify(model, { level: 'candidates', solution: point(2), objective: 2, candidates: [row(1), row(1)] }), /重复/);
assert.throws(() => verify(model, { level: 'candidates', solution: point(2), objective: 2, candidates: [row(0), { point: point(2), objective: 9 }] }), /回代/);
assert.throws(() => verify(model, { level: 'candidates', solution: point(1), objective: 1, candidates: [row(2)] }), /不在/);

const finite = verify(model, { level: 'finite_domain', solution: point(1), objective: 1 });
assert.equal(finite.domain_points, 3);
assert.equal(finite.feasible_points, 2);
assert.equal(finite.checked_points, 3);
assert.equal(finite.optimality_scope, '已登记完整有限域内最优');
assert.throws(() => verify(model, { level: 'finite_domain', solution: point(2), objective: 2 }), /更优/);

const maxModel = { ...model, direction: 'max' };
assert.equal(verify(maxModel, { level: 'finite_domain', solution: point(2), objective: 2 }).direction, 'max');
assert.throws(() => verify(maxModel, { level: 'finite_domain', solution: point(1), objective: 1 }), /更优/);

const interval = { ...model, variables: [{ name: 'x', domain: { kind: 'interval', min: 0, max: 2 } }] };
assert.throws(() => verify(interval, { level: 'finite_domain', solution: point(1), objective: 1 }), /连续区间/);
const grid = verify(interval, { level: 'grid', solution: point(1), objective: 1,
  axes: { x: [0, 1, 2] }, candidates: [row(0), row(1), row(2)] });
assert.equal(grid.optimality_scope, '已登记网格内最优');
assert.equal(grid.domain_points, null);
assert.throws(() => verify(interval, { level: 'grid', solution: point(1), objective: 1,
  axes: { x: [0, 1, 2] }, candidates: [row(1), row(2)] }), /覆盖/);
assert.throws(() => verify(interval, { level: 'grid', solution: point(1), objective: 1,
  axes: { x: [0, 1, 1] }, candidates: [row(1), row(2)] }), /重复/);

// Two-dimensional complete grid: a Cartesian product, not a matching subset.
const two = { direction: 'min', variables: [
  { name: 'x', domain: { kind: 'finite', values: [0, 1] } },
  { name: 'y', domain: { kind: 'finite', values: [0, 1] } },
], objective: { terms: [{ coefficient: 1, powers: { x: 1 } }, { coefficient: 1, powers: { y: 1 } }] }, constraints: [] };
const twoRows = [
  { point: { x: 0, y: 0 }, objective: 0 }, { point: { x: 0, y: 1 }, objective: 1 },
  { point: { x: 1, y: 0 }, objective: 1 }, { point: { x: 1, y: 1 }, objective: 2 },
];
assert.equal(verify(two, { level: 'grid', solution: { x: 0, y: 0 }, objective: 0,
  axes: { x: [0, 1], y: [0, 1] }, candidates: twoRows }).checked_points, 4);
assert.throws(() => verify(two, { level: 'grid', solution: { x: 0, y: 0 }, objective: 0,
  axes: { x: [0, 1], y: [0, 1] }, candidates: twoRows.slice(0, 3) }), /覆盖/);

const decimalModel = { direction: 'min', variables: [{ name: 'x', domain: { kind: 'finite', values: [0.2] } }],
  objective: { constant: 0.1, terms: [{ coefficient: 1, powers: { x: 1 } }] }, constraints: [] };
assert.equal(verify(decimalModel, { level: 'finite_domain', solution: point(0.2), objective: 0.3 }).objective, 0.3);
assert.throws(() => verify(decimalModel, { level: 'finite_domain', solution: point(0.2), objective: 0.30000000000000004 }), /回代/);
assert.equal(validateCheck({ ...model, direction: 'sideways' }).ok, false);
assert.equal(validateCheck({ ...model, objective: { terms: [{ coefficient: 1, powers: { x: 3 } }] } }).ok, false);
assert.equal(validateCheck({ ...model, objective: { terms: [{ coefficient: 1, powers: { y: 1 } }] } }).ok, false);
assert.equal(validateCheck({ ...model, variables: [{ name: 'x', domain: { kind: 'finite', values: [0, 0] } }] }).ok, false);
assert.equal(validateCheck({ ...model, weird: true }).ok, false);
assert.equal(validateCheck({ ...model, constraints: Array(101).fill(model.constraints[0]) }).ok, false);
assert.equal(validateCheck({ ...model, objective: { terms: Array(100).fill({ coefficient: 1, powers: { x: 1 } }) },
  constraints: [{ polynomial: linear(1), sense: 'ge', rhs: 0 }] }).ok, false, 'total term cap includes constraints');
const exactEq = { direction: 'max', variables: [{ name: 'x', domain: { kind: 'finite', values: [0.1, 0.2] } }],
  objective: linear(-1), constraints: [{ polynomial: linear(1, 'x', 0.1), sense: 'eq', rhs: 0.3 }] };
assert.equal(verify(exactEq, { level: 'finite_domain', solution: point(0.2), objective: -0.2 }).feasible_points, 1);
assert.throws(() => verify(exactEq, { level: 'feasible', solution: point(0.1), objective: -0.1 }), /约束/);
assert.throws(() => verify({ ...two, variables: [
  { name: 'x', domain: { kind: 'finite', values: Array.from({ length: 101 }, (_, i) => i) } },
  { name: 'y', domain: { kind: 'finite', values: Array.from({ length: 101 }, (_, i) => i) } },
] }, { level: 'finite_domain', solution: { x: 0, y: 0 }, objective: 0 }), /10000/);

console.log('optimization_evidence tests passed');
