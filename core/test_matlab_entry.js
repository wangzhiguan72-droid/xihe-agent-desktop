'use strict';
const assert = require('assert/strict');
const { matlabEntryExpression } = require('./tools');
assert.equal(matlabEntryExpression('scripts/solve.m'), "addpath('scripts'); solve");
assert.equal(matlabEntryExpression("scripts'quoted/solve.m"), "addpath('scripts''quoted'); solve");
for (const name of ["scripts/x');system('bad');%.m", 'scripts/bad name.m', 'scripts/solve.py']) assert.throws(() => matlabEntryExpression(name), /MATLAB入口/);
console.log('MATLAB entry quoting and filename validation: PASS');
