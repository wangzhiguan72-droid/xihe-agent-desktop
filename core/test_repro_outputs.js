'use strict';
// Exercise repro_check with real guarded Python runs in a throwaway project.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { TOOLS } = require('./tools');
const { Sandbox } = require('./sandbox');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-repro-outputs-'));
const root = path.join(temp, "project's workspace");
const appDir = path.join(temp, 'app');
fs.mkdirSync(root);
fs.mkdirSync(appDir);
const put = (rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const script = "scripts/solve's.py";
const results = ['outputs/summary.json', 'outputs/table.csv'];
const py = [
  'import csv, json',
  'from pathlib import Path',
  "value = json.loads(Path('data/in.json').read_text(encoding='utf-8'))['value']",
  "out = Path('outputs')",
  'out.mkdir(exist_ok=True)',
  "(out / 'summary.json').write_text(json.dumps({'score': value * 2, 'metadata': 'new'}), encoding='utf-8')",
  "with (out / 'table.csv').open('w', newline='', encoding='utf-8') as handle:",
  '    writer = csv.writer(handle)',
  "    writer.writerow(['id', 'score'])",
  "    writer.writerow(['case', value * 2])",
  "(out / 'notes.txt').write_text('done', encoding='utf-8')",
  "print('repro completed')",
].join('\n');

(async () => {
  try {
    put(script, py);
    put('data/in.json', '{"value":3}');
    put(results[0], '{"score":6,"metadata":"new"}');
    put(results[1], 'id,score\ncase,6\n');
    put('outputs/notes.txt', 'done');
    const session = { mode: 'math', runs: [], data_epoch: 0, source_files: [script] };
    const ctx = { workspace: root, appDir, session, sandbox: new Sandbox(root),
      settings: {}, children: new Set(), emit: () => {}, abort: new AbortController(),
      spend: () => {}, trackVision: () => {} };
    const tool = TOOLS.find(item => item.name === 'repro_check');
    assert(tool, 'repro_check tool must exist');
    const run = async args => {
      const engine = require('./agent');
      const beforeInputs = engine.inputStampHash(engine.stampInputFiles(root));
      const output = await tool.run(ctx, { script, ...args });
      assert.equal(engine.inputStampHash(engine.stampInputFiles(root)), beforeInputs, 'repro receipt copies must not invalidate original inputs');
      assert.match(output, /\[repro_check\]/);
      const state = structuredClone(session.repro_check);
      assert(state, 'tool must persist repro_check state');
      assert.match(state.dir, /^exp_repro\/run_[0-9a-f]{16}$/);
      const manifestPath = path.join(root, state.manifest.rel);
      assert.equal(hash(manifestPath), state.manifest.sha256, 'manifest hash must match saved file');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.equal(manifest.dir, state.dir);
      assert.equal(manifest.script_sha256, hash(path.join(root, script)));
      for (const file of state.files) {
        if (fs.existsSync(path.join(root, file.rel))) {
          assert.match(file.sha256, /^[0-9a-f]{64}$/, `missing hash for ${file.rel}`);
          assert.equal(hash(path.join(root, file.rel)), file.sha256, `changed evidence: ${file.rel}`);
        } else assert.equal(file.sha256, null, `missing output must not carry a hash: ${file.rel}`);
      }
      return { state, manifest, output };
    };

    const passed = await run({ results });
    assert.equal(passed.state.pass, true, passed.output);
    assert.equal(passed.state.status, 'passed');
    assert.equal(passed.state.run_ok, true);
    assert.deepEqual(passed.manifest.results_targets, results);
    assert.deepEqual(passed.manifest.compare.map(item => item.status), ['same', 'same']);
    assert.equal(passed.manifest.input_files_sha256['data/in.json'], hash(path.join(root, 'data/in.json')));
    for (const rel of results) assert(fs.existsSync(path.join(root, passed.state.dir, rel)), `run did not produce ${rel}`);

    // Root XLSX files are not covered by the CSV extension or output-directory
    // backup exemptions. They must survive the isolated run for real comparison.
    const xlsx = 'result_q1.xlsx';
    const saveXlsx = "book.save('result_q1.xlsx')";
    const xlsxPy = py + '\n' + [
      'import openpyxl',
      'book = openpyxl.Workbook()',
      "book.active.title = 'data'",
      "book.active.append(['score'])",
      'book.active.append([value * 2])',
      saveXlsx,
    ].join('\n');
    const baseline = spawnSync('python', ['-c',
      "import openpyxl, sys; book=openpyxl.Workbook(); book.active.title='data'; book.active.append(['score']); book.active.append([6]); book.save(sys.argv[1])",
      path.join(root, xlsx)], { encoding: 'utf8' });
    assert.equal(baseline.status, 0, baseline.stderr);
    put(script, xlsxPy);
    const xlsxPassed = await run({ results: [xlsx] });
    assert.equal(xlsxPassed.state.pass, true, xlsxPassed.output);
    assert.equal(xlsxPassed.manifest.compare[0].status, 'same');
    assert(xlsxPassed.manifest.compare[0].compared > 0);
    assert(fs.existsSync(path.join(root, xlsxPassed.state.dir, xlsx)), 'root XLSX must not be moved to auto_backup trash');

    put(script, xlsxPy.replace('book.active.append([value * 2])', 'book.active.append([value * 3])'));
    const xlsxChanged = await run({ results: [xlsx] });
    assert.equal(xlsxChanged.state.run_ok, true);
    assert.equal(xlsxChanged.state.pass, false, 'a successful run with wrong XLSX values must fail');
    assert.equal(xlsxChanged.manifest.compare[0].status, 'diff');
    put(script, xlsxPy.replace(saveXlsx, '# output intentionally omitted'));
    const xlsxMissing = await run({ results: [xlsx] });
    assert.equal(xlsxMissing.state.run_ok, true);
    assert.equal(xlsxMissing.state.pass, false, 'the old XLSX must not be copied into the isolated run');
    assert.equal(xlsxMissing.manifest.compare[0].status, 'missing');
    assert(fs.existsSync(path.join(root, xlsxPassed.state.dir, xlsx)), 'later failures must preserve earlier XLSX evidence');
    put(script, py);

    put('result.json', '{"score":6}');
    const missingRoot = await run({ results: ['result.json'] });
    assert.equal(missingRoot.state.pass, false, 'old root result must not be seeded into the clean run');
    assert.equal(missingRoot.state.run_ok, true);
    assert.equal(missingRoot.manifest.compare[0].status, 'missing');
    assert.equal(fs.existsSync(path.join(root, missingRoot.state.dir, 'result.json')), false);
    assert(fs.existsSync(path.join(root, passed.state.dir, results[0])), 'earlier run evidence must remain');
    assert.notEqual(passed.state.dir, missingRoot.state.dir, 'each run needs a fresh directory');

    put(script, py.replace("(out / 'summary.json').write_text(json.dumps({'score': value * 2, 'metadata': 'new'}), encoding='utf-8')", "# summary intentionally omitted"));
    const missingNested = await run({ results: [results[0]] });
    assert.equal(missingNested.state.pass, false, 'missing nested JSON must fail');
    assert.equal(missingNested.manifest.compare[0].status, 'missing');
    put(script, py);

    put(results[0], '{"score":7,"metadata":"new"}');
    const changed = await run({ results: [results[0]] });
    assert.equal(changed.state.pass, false);
    assert.equal(changed.state.status, 'diff');
    assert.equal(changed.manifest.compare[0].status, 'diff');
    assert.match(changed.manifest.compare[0].report, /score/);
    put(results[0], '{"score":6,"metadata":"old"}');
    const metadata = await run({ results: [results[0]] });
    assert.equal(metadata.state.pass, false, 'metadata difference is reported by default');
    assert.match(metadata.manifest.compare[0].report, /metadata/);
    const ignored = await run({ results: [results[0]], ignore_fields: ['metadata'] });
    assert.equal(ignored.state.pass, true, ignored.output);
    assert.deepEqual(ignored.state.ignored_fields, ['metadata']);
    assert.match(ignored.manifest.compare[0].report, /metadata/);

    const unsupported = await run({ results: ['outputs/notes.txt'] });
    assert.equal(unsupported.state.pass, false);
    assert.equal(unsupported.state.status, 'unsupported');
    assert.equal(unsupported.manifest.compare[0].status, 'unsupported');
    const skipped = await run({ results, skip_run: true });
    assert.equal(skipped.state.pass, false);
    assert.equal(skipped.state.run_ok, false);
    assert.equal(skipped.state.status, 'not_executed');
    assert.equal(skipped.manifest.pass, false);
    const deepScript = "scripts/deep's.py";
    put(deepScript, 'import sys\nassert sys.argv[1:] == ["a\\\\b", "it\'s valid"]\nprint("deep quoted entry OK")\n');
    session.effort = 'deep';
    await TOOLS.find(tool => tool.name === 'deep_loop').run(ctx, { script: deepScript, max_rounds: 1, timeout_sec: 30, args: ['a\\b', "it's valid"] });
    assert.equal(session.deep_loop.at(-1).ok, true, 'deep entry preserves quoted paths and literal argv without calling a model');
    console.log('repro outputs: JSON/CSV/XLSX run, root XLSX backup retention, fresh evidence, missing, diff, unsupported, skip, ignore PASS');
  } finally {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'unsafe test cleanup parent');
    assert(path.basename(resolved).startsWith('xihe-repro-outputs-'), 'unsafe test cleanup name');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
