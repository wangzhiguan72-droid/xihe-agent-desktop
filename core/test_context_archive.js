'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const providerId = require.resolve('./providers');
require.cache[providerId] = { id: providerId, filename: providerId, loaded: true, exports: {
  chatStream: async () => ({ content: '保留约束的摘要', usage: {} }), keyFor: () => 'offline',
  providerForModel: () => 'offline', resolveProvider: () => ({ name: 'offline', kind: 'openai' }), PROVIDERS: {},
} };
const { compactHistory, stampInputFiles, inputStampHash } = require('./agent');
const root = fs.mkdtempSync(path.join(os.homedir(), '.xihe-context-'));
const history = () => Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '原始约束' + i }));
(async () => {
  const original = history(); const s = { id: 'ctx', messages: original, memory: [] };
  const deps = { appDir: root, sandbox: { root }, settings: {}, emit() {} };
  const beforeHash = inputStampHash(stampInputFiles(root));
  assert.equal(await compactHistory(s, deps, 'offline', 'offline', { name: 'offline' }, () => {}, 'offline'), true);
  assert.ok(s.messages.length < original.length);
  const archive = s.context_archives[0];
  assert.deepEqual(JSON.parse(fs.readFileSync(archive.path, 'utf8')).messages, original);
  assert.equal(beforeHash, inputStampHash(stampInputFiles(root)), '归档不应污染计算输入指纹');
  fs.writeFileSync(path.join(root, 'blocked'), 'not a directory');
  const failed = { id: 'blocked', messages: history(), memory: [] };
  const snapshot = JSON.stringify(failed.messages); const warnings = [];
  assert.equal(await compactHistory(failed, { ...deps, sandbox: { root: path.join(root, 'blocked') }, emit: e => warnings.push(e) },
    'offline', 'offline', { name: 'offline' }, () => {}, 'offline'), false);
  assert.equal(JSON.stringify(failed.messages), snapshot);
  assert.ok(warnings.some(e => /历史压缩失败/.test(e.msg)));
  const disabled = { id: 'disabled', messages: history(), memory: [] };
  const disabledBefore = JSON.stringify(disabled.messages);
  assert.equal(await compactHistory(disabled, { ...deps, settings: { summarize_model:'offline', disabled_models:['offline:offline'] } },
    'offline', 'offline', {name:'offline'}, () => {}, 'offline'), false);
  assert.equal(JSON.stringify(disabled.messages), disabledBefore, 'disabled compressor cannot alter history');
  console.log('PASS context compression archives original messages, preserves input hash, and fails without data loss');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
