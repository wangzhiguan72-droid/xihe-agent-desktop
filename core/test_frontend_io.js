'use strict';
// Exercise the shipped API and attachment handlers with controlled I/O failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, 'frontend section exists');
  return source.slice(first, last);
}
const apiSource = section('async function api(', '// ---------- 后台任务监控');
const uploadSource = section('let attachmentUploading = false;', 'function renderAttachRow()');
const sendSource = section('async function sendText(', '// ---------- 会话管理');

async function main() {
  let response;
  let networkError = false;
  const apiContext = vm.createContext({ window: {}, fetch: async () => {
    if (networkError) throw new Error('offline');
    return response;
  } });
  vm.runInContext(apiSource, apiContext);
  const call = () => apiContext.api('/api/test');
  response = { ok: true, status: 200, json: async () => ({ ok: true }) };
  assert.equal((await call()).ok, true);
  response.json = async () => { throw new SyntaxError('not JSON'); };
  await assert.rejects(call, /响应格式异常/);
  response.ok = false; response.status = 502;
  await assert.rejects(call, /HTTP 502.*JSON/);
  response.json = async () => ({ error: '具体错误' });
  await assert.rejects(call, /具体错误/);
  response.json = async () => null;
  await assert.rejects(call, /HTTP 502/);
  networkError = true;
  await assert.rejects(call, /无法连接本机服务/);

  const elements = Object.fromEntries(['#btnAttach', '#btnSend', '#attachStatus'].map(k => [k, {}]));
  let input, reader, finishUpload, failUpload, uploadCalls = 0, renders = 0;
  const alerts = [];
  const state = { attachments: [] };
  const context = vm.createContext({
    $: key => elements[key], state, alert: msg => alerts.push(msg),
    document: { createElement: () => (input = { click() {}, files: [{ name: 'data.csv', size: 42 }] }) },
    FileReader: class { constructor() { reader = this; } readAsDataURL() {} },
    api: () => { uploadCalls++; return new Promise((resolve, reject) => { finishUpload = resolve; failUpload = reject; }); },
    renderAttachRow: () => { renders++; },
  });
  vm.runInContext(uploadSource + '\n' + sendSource, context);
  function begin() { elements['#btnAttach'].onclick(); return input.onchange(); }
  function restored() {
    assert.equal(elements['#btnAttach'].disabled, false);
    assert.equal(elements['#btnSend'].disabled, false);
    assert.equal(vm.runInContext('attachmentUploading', context), false);
  }
  let pending = begin();
  assert.match(elements['#attachStatus'].textContent, /正在读取/);
  assert.equal(elements['#btnSend'].disabled, true);
  await context.sendText('message');
  assert.match(alerts.pop(), /等待上传完成/);
  const firstInput = input;
  elements['#btnAttach'].onclick();
  assert.equal(input, firstInput, 'duplicate picker blocked');
  reader.result = 'data:text/csv;base64,YQ=='; reader.onload();
  await Promise.resolve();
  assert.match(elements['#attachStatus'].textContent, /正在上传/);
  finishUpload({ path: 'data/data.csv' }); await pending;
  assert.equal(state.attachments.length, 1); assert.equal(renders, 1); restored();

  for (const event of ['onerror', 'onabort']) {
    pending = begin(); reader[event](); await pending;
    assert.match(elements['#attachStatus'].textContent, /失败.*重试/);
    assert.equal(uploadCalls, 1, 'read failure never uploads'); restored();
  }
  pending = begin(); reader.result = 'data:text/csv;base64,YQ=='; reader.onload();
  await Promise.resolve(); failUpload(new Error('网络中断')); await pending;
  assert.match(elements['#attachStatus'].textContent, /网络中断/); restored();
  pending = begin(); reader.result = 'data:text/csv;base64,YQ=='; reader.onload();
  await Promise.resolve(); finishUpload({}); await pending;
  assert.match(elements['#attachStatus'].textContent, /缺少附件路径/);
  assert.equal(state.attachments.length, 1, 'failures preserve existing attachments'); restored();
  pending = begin(); reader.result = 'data:text/csv;base64,YQ=='; reader.onload();
  await Promise.resolve(); finishUpload({ path: 'data/retry.csv' }); await pending;
  assert.equal(state.attachments.length, 2, 'retry succeeds'); restored();
  elements['#btnAttach'].onclick(); input.files = []; await input.onchange(); restored();
  elements['#btnAttach'].onclick(); input.files[0].size = 61 * 1024 * 1024;
  await input.onchange(); assert.match(alerts.pop(), /附件过大/); restored();
  console.log('PASS frontend I/O: JSON/HTTP/network errors, upload status, read failure/abort, upload failure, invalid response, retry, send guard, cancel and size limit');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
