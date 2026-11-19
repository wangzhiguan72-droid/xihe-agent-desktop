'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireRuntimeLock } = require('./runtime_lock');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-runtime-lock-'));
try {
  const file = path.join(tmp, 'runtime.lock');
  const release = acquireRuntimeLock(file);
  assert.throws(() => acquireRuntimeLock(file), /实例/);
  const stored = fs.readFileSync(file, 'utf8');
  release(); assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'stale' }));
  const next = acquireRuntimeLock(file); assert.notEqual(fs.readFileSync(file, 'utf8'), stored);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'another-owner' }));
  next(); assert.equal(fs.existsSync(file), true, 'release cannot erase another owner lock');
  fs.writeFileSync(file + '.reclaim', 'another-recovery');
  assert.throws(() => acquireRuntimeLock(file), /回收运行锁/);
  assert.equal(fs.readFileSync(file + '.reclaim', 'utf8'), 'another-recovery', 'cannot erase another cleanup claim');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log('exclusive runtime lock passed');
