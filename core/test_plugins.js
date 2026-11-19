'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const plugins = require('./plugins');
const app = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-plugins-'));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const dirs = ['first', 'import', 'foreign'].map(x => path.join(root, x));
try {
  dirs.forEach(d => fs.mkdirSync(d));
  assert.deepEqual(plugins.normalizeSelections(), []);
  assert.deepEqual(plugins.normalizeSelections([{ id: 'evidence-figures', enabled: false }]), [{ id: 'evidence-figures', enabled: false }]);
  assert.throws(() => plugins.normalizeSelections([{ id: 'x', enabled: true }, { id: 'X', enabled: false }]), /重复/);
  assert.throws(() => plugins.normalizeSelections([{ id: 'CON', enabled: true }]), /无效/);
  assert.throws(() => plugins.normalizeSelections([{ id: 'x', enabled: 1 }]), /无效/);

  const first = plugins.resolve({ appDir: app, selections: [{ id: 'evidence-figures', enabled: true }] });
  assert.equal(first.entries[0].status, 'loaded', first.entries[0].reason);
  assert.equal(first.entries[0].source, 'builtin');
  assert.equal(first.bundles.length, 1);
  assert.equal(first.bundles[0].files[0].path, 'render_evidence.py');
  assert.match(Buffer.from(first.bundles[0].files[0].content, 'base64').toString(), /matplotlib/);
  const frozenDir = path.join(dirs[0], '.plugins', 'evidence-figures');
  plugins.materialize(dirs[0], first.bundles);
  const snapshot = { root: dirs[0], plugins: first.entries };
  assert.equal(plugins.loadFrozen(snapshot, 'evidence-figures').sha256, first.entries[0].sha256);
  assert.equal(plugins.loadFrozen(snapshot, 'evidence-figures').entry, path.join(frozenDir, 'render_evidence.py'));
  plugins.materialize(dirs[0], first.bundles); // Identical content is idempotent.

  // Exported bytes survive an app installation without the source Skill.
  plugins.materialize(dirs[1], first.bundles);
  const pin = first.entries.map(({ id, status, sha256, version }) => ({ id, status, sha256, version }));
  const imported = plugins.resolve({ appDir: dirs[2], selections: [{ id: 'evidence-figures', enabled: true }], options: { projectRoot: dirs[1] }, lock: pin });
  assert.equal(imported.entries[0].status, 'loaded', imported.entries[0].reason);
  assert.equal(imported.entries[0].source, 'project');
  assert.equal(imported.bundles[0].sha256, first.bundles[0].sha256);
  assert.equal(plugins.listAvailable(dirs[2], { projectRoot: dirs[1] })[0].status, 'loaded');

  const off = plugins.resolve({ appDir: app, selections: [{ id: 'evidence-figures', enabled: false }] });
  assert.equal(off.entries[0].status, 'off');
  assert.deepEqual(off.bundles, []);
  assert.equal(plugins.resolve({ appDir: app, selections: [{ id: 'absent', enabled: true }] }).entries[0].status, 'unavailable');
  assert.equal(plugins.resolve({ appDir: app, selections: [{ id: 'evidence-figures', enabled: true }], lock: [] }).entries[0].status, 'loaded');
  assert.equal(plugins.resolve({ appDir: app, selections: [{ id: 'evidence-figures', enabled: true }], lock: [{ id: 'evidence-figures', status: 'unavailable', version: '', sha256: null }] }).entries[0].status, 'unavailable');
  const badPin = [{ ...pin[0], sha256: '0'.repeat(64) }];
  assert.equal(plugins.resolve({ appDir: app, selections: [{ id: 'evidence-figures', enabled: true }], lock: badPin }).entries[0].status, 'unavailable');

  const bad = structuredClone(first.bundles[0]);
  bad.files[0].path = '../outside.py';
  assert.throws(() => plugins.validateBundle(bad), /无效/);
  bad.files[0].path = 'CON.py';
  assert.throws(() => plugins.validateBundle(bad), /无效/);
  bad.files[0].path = 'x:stream.py';
  assert.throws(() => plugins.validateBundle(bad), /无效/);
  bad.files[0].path = 'render_evidence.py';
  bad.files[0].content = Buffer.from('changed').toString('base64');
  assert.throws(() => plugins.validateBundle(bad), /指纹/);
  const script = path.join(dirs[1], '.plugins', 'evidence-figures', 'render_evidence.py');
  fs.appendFileSync(script, '\n# tampered');
  assert.throws(() => plugins.loadFrozen({ root: dirs[1], plugins: first.entries }, 'evidence-figures'), /指纹/);
  const compromised = plugins.resolve({ appDir: app, selections: [{ id: 'evidence-figures', enabled: true }], options: { projectRoot: dirs[1] }, lock: pin });
  assert.equal(compromised.entries[0].status, 'unavailable'); // No builtin fallback after local mismatch.

  const linkRoot = path.join(root, 'linked');
  try {
    fs.symlinkSync(dirs[0], linkRoot, 'junction');
    assert.throws(() => plugins.loadFrozen({ root: linkRoot, plugins: first.entries }, 'evidence-figures'), /链接/);
    assert.throws(() => plugins.materialize(linkRoot, first.bundles), /链接|内容不同/);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }
  const output = plugins.loadFrozen(snapshot, 'evidence-figures');
  assert.equal(sha(fs.readFileSync(output.entry)), first.bundles[0].files[0].sha256);
  console.log('plugin registry: portable roundtrip, pin, tamper and path checks passed');
} finally {
  if (path.dirname(root) !== os.tmpdir()) throw new Error('unsafe temporary test path');
  fs.rmSync(root, { recursive: true, force: true });
}
