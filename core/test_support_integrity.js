'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const I = require('./support_integrity');
const { Sandbox } = require('./sandbox');
const { TOOLS } = require('./tools');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-support-'));
  try {
    const scripts = path.join(root, 'scripts');
    const findings = path.join(root, 'findings');
    const paper = path.join(root, 'paper');
    fs.mkdirSync(scripts);
    fs.mkdirSync(findings);
    fs.mkdirSync(paper);
    const paperTex = path.join(paper, 'main.tex');
    fs.writeFileSync(paperTex, '\\appendix\n\\input{../findings/support_manifest.tex}\n');
    const file = path.join(scripts, '求解_1.py');
    fs.writeFileSync(file, 'print(42)\n');
    const row = { rel: I.relativeEntry(root, file), bytes: fs.statSync(file).size, sha256: I.sha256(file) };
    const zip = path.join(root, '支撑材料.zip');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Compress-Archive -LiteralPath $env:XIHE_TEST_INPUT -DestinationPath $env:XIHE_TEST_ZIP -Force'],
    { env: { ...process.env, XIHE_TEST_INPUT: scripts, XIHE_TEST_ZIP: zip } });
    const checked = await I.verifyZip(zip, [row]);
    assert.deepStrictEqual(checked.entries, [row.rel]);
    const texPath = path.join(findings, 'support_manifest.tex');
    fs.writeFileSync(texPath, I.manifestTex(checked.entries));
    assert(I.checkManifest(fs.readFileSync(texPath, 'utf8'), [row.rel]));
    assert(!I.checkManifest(fs.readFileSync(texPath, 'utf8'), [row.rel, 'missing.csv']));
    const state = { verified: true, must_fix: 0, zip: path.basename(zip), zip_sha256: I.sha256(zip),
      manifest_sha256: I.sha256(texPath), entries: [row] };
    assert.deepStrictEqual(I.freshSupportBlockers(root, state), []);
    await assert.rejects(I.verifyZip(zip, [{ ...row, sha256: '0'.repeat(64) }]), /不符/);
    fs.writeFileSync(file, 'print(43)\n');
    assert(I.freshSupportBlockers(root, state).some(s => s.includes('源文件已变化')));
    fs.writeFileSync(file, 'print(42)\n');
    fs.writeFileSync(texPath, I.manifestTex([]));
    assert(I.freshSupportBlockers(root, state).some(s => s.includes('清单')));
    fs.writeFileSync(texPath, I.manifestTex(checked.entries));
    fs.writeFileSync(paperTex, '% \\appendix\n% \\input{../findings/support_manifest.tex}\n');
    assert.deepStrictEqual(I.freshSupportBlockers(root, state), []);
    assert(I.freshSupportBlockers(root, state, undefined, { manifest_in_paper: true }).some(s => s.includes('尚未实际引入')));
    assert(I.MAX_ZIP_BYTES === 20000000);
    const packedRoot = path.join(root, 'pack-workspace');
    fs.mkdirSync(path.join(packedRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(packedRoot, 'paper'));
    fs.mkdirSync(path.join(packedRoot, 'findings'));
    fs.mkdirSync(path.join(packedRoot, 'data'));
    fs.mkdirSync(path.join(packedRoot, 'source'));
    fs.writeFileSync(path.join(packedRoot, 'scripts', 'solve.py'), 'print(1)\n');
    fs.writeFileSync(path.join(packedRoot, 'scripts', 'plot.py'), '# Complete plotting helper stays in the support archive.\nprint("plot")\n');
    fs.writeFileSync(path.join(packedRoot, 'data', 'observed.csv'), 'x,y\n1,2\n');
    fs.writeFileSync(path.join(packedRoot, 'source', 'original.csv'), 'private problem attachment');
    fs.writeFileSync(path.join(packedRoot, 'paper', 'main.pdf'), 'paper outside support package');
    fs.writeFileSync(path.join(packedRoot, 'paper', 'main.tex'), '\\appendix\n\\input{../findings/support_manifest.tex}\n');
    const appDir = path.resolve(__dirname, '..');
    const session = { runs: [], messages: [], createdAt: Date.now(), contest_rules: {} };
    const ctx = { workspace: packedRoot, appDir, sandbox: new Sandbox(packedRoot, { protected: [appDir] }),
      session, children: new Set(), abort: new AbortController() };
    const pack = TOOLS.find(t => t.name === 'support_pack');
    const output = await pack.run(ctx, {});
    assert(session.support_pack.verified, output);
    assert.deepStrictEqual(I.freshSupportBlockers(packedRoot, session.support_pack), []);
    const names = (await I.inspectZip(path.join(packedRoot, '支撑材料.zip'))).map(e => e.name);
    assert(names.includes('scripts/solve.py') && names.includes('scripts/plot.py') && names.includes('data/observed.csv'));
    assert(!names.some(n => n.startsWith('source/') || n === 'paper/main.pdf' || n === 'paper/main.tex'));
    assert(fs.readFileSync(path.join(packedRoot, 'findings', 'support_manifest.tex'), 'utf8').includes('数值计算或绘图的可运行代码'));
    fs.writeFileSync(path.join(packedRoot, 'scripts', 'solve.py'), '# 姓名：张三\nprint(1)\n');
    const flagged = await pack.run(ctx, {});
    assert(!session.support_pack.verified && session.support_pack.must_fix > 0 && flagged.includes('身份字段'));
    await assert.rejects(pack.run(ctx, { zip_name: '../escape.zip' }), /zip_name/);
    console.log('support integrity: PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
