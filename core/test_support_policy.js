'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const I = require('./support_integrity');

async function main() {
  const cumcmPolicy = require('../contest_packages/cumcm/rules.json').defaults.support_policy;
  assert.equal(I.checkSize(I.MAX_ZIP_BYTES), null);
  assert.equal(I.checkSize(I.MAX_ZIP_BYTES, cumcmPolicy), `支撑包 ${I.MAX_ZIP_BYTES} 字节，须严格小于 ${I.MAX_ZIP_BYTES} 字节（${cumcmPolicy.source}）`);
  assert.equal(I.checkSize(I.MAX_ZIP_BYTES, { max_bytes: null }), null);
  assert.equal(I.checkSize(44_950_000, { max_bytes: null }), null);
  assert.throws(() => I.normalizePolicy({ max_bytes: 50_000_000 }), /来源/);
  const capped = { max_bytes: 44_950_000, exclusive: false, source: '测试赛规' };
  assert.equal(I.checkSize(44_950_000, capped), null);
  assert.match(I.checkSize(44_950_001, capped), /不超过/);
  assert.match(I.checkSize(44_950_000, { ...capped, exclusive: true }), /严格小于/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-support-policy-'));
  try {
    for (const dir of ['scripts', 'findings', 'paper']) fs.mkdirSync(path.join(root, dir));
    const file = path.join(root, 'scripts', 'solve.py');
    fs.writeFileSync(file, 'print(42)\n');
    const row = { rel: 'scripts/solve.py', bytes: fs.statSync(file).size, sha256: I.sha256(file) };
    const zip = path.join(root, 'support.zip');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath $env:XIHE_TEST_INPUT -DestinationPath $env:XIHE_TEST_ZIP -Force'],
    { env: { ...process.env, XIHE_TEST_INPUT: path.join(root, 'scripts'), XIHE_TEST_ZIP: zip } });
    const unlimited = { max_bytes: null, source: '本届规则未规定体积' };
    const checked = await I.verifyZip(zip, [row], unlimited);
    assert.deepEqual(checked.entries, [row.rel]);
    await assert.rejects(I.verifyZip(zip, [{ ...row, sha256: '0'.repeat(64) }], unlimited), /条目与源文件不符/);
    const manifest = path.join(root, 'findings', 'support_manifest.tex');
    fs.writeFileSync(manifest, I.manifestTex([row.rel]));
    fs.writeFileSync(path.join(root, 'paper', 'main.tex'), '\\appendix\n\\input{../findings/support_manifest.tex}\n');
    const state = { verified: true, must_fix: 0, zip: 'support.zip', zip_sha256: I.sha256(zip),
      manifest_sha256: I.sha256(manifest), entries: [row], size_policy: I.normalizePolicy(unlimited) };
    assert.deepEqual(I.freshSupportBlockers(root, state, unlimited), []);
    assert.deepEqual(I.freshSupportBlockers(root, state), []);
    const oldState = { ...state };
    delete oldState.size_policy;
    assert.deepEqual(I.freshSupportBlockers(root, oldState), []);
    assert.deepEqual(I.freshSupportBlockers(root, oldState, unlimited), []);
    fs.appendFileSync(zip, 'changed');
    assert.match(I.freshSupportBlockers(root, state, unlimited).join(';'), /内容已修改/);
    fs.truncateSync(zip, 44_950_000);
    state.zip_sha256 = I.sha256(zip);
    // The fake large archive probes only size policy; verifyZip above checks real ZIP entries.
    assert.deepEqual(I.freshSupportBlockers(root, state, unlimited), []);
    assert.deepEqual(I.freshSupportBlockers(root, state), []);
    assert.match(I.freshSupportBlockers(root, state, cumcmPolicy).join(';'), /策略已改变|超限/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('support policy: PASS');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
