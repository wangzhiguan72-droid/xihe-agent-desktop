'use strict';
// Portable plugin data only. Execution belongs to the guarded Python tool.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const skills = require('./skills');
const MAX_FILES = 200, MAX_BYTES = 8 * 1024 * 1024;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
const safePart = s => typeof s === 'string' && s.length > 0 && s.length <= 120 && s !== '.' && s !== '..'
  && !/[\\/:*?"<>|\x00-\x1f]/.test(s) && !/[. ]$/.test(s)
  && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(s);
const safePath = s => typeof s === 'string' && s.length <= 600 && s.split('/').every(safePart) && !s.includes('\\');
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
const keys = (obj, allowed, label) => {
  if (!plain(obj) || Object.keys(obj).some(k => !allowed.includes(k))) throw new Error(label + '字段无效');
};
const canonical = x => Array.isArray(x) ? x.map(canonical) : plain(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const shaPattern = /^[a-f0-9]{64}$/;

function normalizeSelections(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 8) throw new Error('plugins 须为最多8项的数组');
  const seen = new Set();
  return input.map(row => {
    keys(row, ['id', 'enabled'], '插件选择');
    if (!safePart(row.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(row.id) || typeof row.enabled !== 'boolean') throw new Error('插件选择无效');
    const lower = row.id.toLowerCase();
    if (seen.has(lower)) throw new Error('插件选择重复');
    seen.add(lower);
    return { id: row.id, enabled: row.enabled };
  });
}

function validateManifest(input, builtin = false) {
  keys(input, ['schema_version', 'id', 'version', 'label', 'capabilities', 'engine', 'entry', 'permissions', ...(builtin ? ['source_skill'] : [])], '插件清单');
  if (input.schema_version !== 1 || !safePart(input.id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.id)
      || typeof input.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(input.version)
      || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 100
      || !Array.isArray(input.capabilities) || input.capabilities.length !== 1 || input.capabilities[0] !== 'figures.render'
      || input.engine !== 'guarded-python' || !safePath(input.entry) || !input.entry.endsWith('.py')) throw new Error('插件清单无效');
  keys(input.permissions, ['workspace_read', 'workspace_write', 'network', 'subprocess'], '插件权限');
  const p = input.permissions;
  if (Object.keys(p).length !== 4 || p.workspace_read !== true || p.workspace_write !== true || p.network !== false || p.subprocess !== false) throw new Error('插件权限无效');
  if (builtin && input.source_skill != null) {
    keys(input.source_skill, ['name', 'file'], '插件源Skill');
    if (!safePart(input.source_skill.name) || !safePath(input.source_skill.file) || !input.source_skill.file.endsWith('.py')) throw new Error('插件源Skill无效');
  }
  return JSON.parse(JSON.stringify(input));
}

function validateBundle(input) {
  keys(input, ['manifest', 'files', 'sha256'], '插件包');
  const manifest = validateManifest(input.manifest);
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) throw new Error('插件包文件数无效');
  let total = 0;
  const seen = new Set();
  const files = input.files.map(row => {
    keys(row, ['path', 'content', 'sha256'], '插件文件');
    if (!safePath(row.path) || row.path.toLowerCase() === 'plugin.json' || typeof row.content !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.content)
        || !shaPattern.test(row.sha256)) throw new Error('插件包文件无效');
    if (seen.has(row.path.toLowerCase())) throw new Error('插件包路径重复');
    seen.add(row.path.toLowerCase());
    const bytes = Buffer.from(row.content, 'base64');
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('插件包超过8MB上限');
    if (hash(bytes) !== row.sha256) throw new Error('插件包文件指纹不一致：' + row.path);
    return { path: row.path, content: row.content, sha256: row.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.some(row => row.path === manifest.entry)) throw new Error('插件包缺少入口脚本');
  const sha256 = hash(JSON.stringify(canonical(manifest)) + '\n' + JSON.stringify(files.map(f => [f.path, f.sha256])));
  if (input.sha256 !== sha256) throw new Error('插件包总指纹不一致');
  return { manifest, files, sha256 };
}

function makeBundle(manifest, files) {
  const clean = validateManifest(manifest);
  const rows = files.map(f => ({ path: f.path, content: f.bytes.toString('base64'), sha256: hash(f.bytes) }));
  const sha256 = hash(JSON.stringify(canonical(clean)) + '\n' + JSON.stringify(rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(f => [f.path, f.sha256])));
  return validateBundle({ manifest: clean, files: rows, sha256 });
}

function checkedFile(dir, rel) {
  if (!safePath(rel)) throw new Error('插件文件路径无效');
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || fs.lstatSync(root).isSymbolicLink()) throw new Error('插件目录链接或缺失');
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (!inside(root, current) || !fs.existsSync(current) || fs.lstatSync(current).isSymbolicLink()) throw new Error('插件文件链接、越界或缺失');
  }
  if (!fs.statSync(current).isFile() || !inside(fs.realpathSync(root), fs.realpathSync(current))) throw new Error('插件文件不是普通文件');
  return current;
}

function readInstalled(dir, id) {
  const pluginBase = path.dirname(dir);
  if (!fs.existsSync(pluginBase) || fs.lstatSync(pluginBase).isSymbolicLink()
      || !fs.statSync(pluginBase).isDirectory()) throw new Error('插件根为链接或缺失');
  const stored = JSON.parse(fs.readFileSync(checkedFile(dir, 'plugin.json'), 'utf8'));
  keys(stored, ['manifest', 'sha256'], '安装清单');
  const manifest = validateManifest(stored.manifest);
  if (manifest.id !== id || !shaPattern.test(stored.sha256)) throw new Error('插件安装清单无效');
  const files = [];
  const walk = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safePath(rel) || entry.isSymbolicLink()) throw new Error('插件包含链接或无效路径');
      if (rel === 'plugin.json') continue;
      if (entry.isDirectory()) { walk(path.join(current, entry.name), rel); continue; }
      if (!entry.isFile()) throw new Error('插件包含非普通文件');
      files.push({ path: rel, bytes: fs.readFileSync(checkedFile(dir, rel)) });
      if (files.length > MAX_FILES) throw new Error('插件文件数超限');
    }
  };
  walk(dir);
  const bundle = makeBundle(manifest, files);
  if (bundle.sha256 !== stored.sha256) throw new Error('插件安装内容指纹不一致');
  return bundle;
}

function getBundle(appDir, id, options = {}) {
  if (!safePart(id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('插件ID无效');
  if (options.projectRoot != null) {
    if (typeof options.projectRoot !== 'string' || !path.isAbsolute(options.projectRoot)) throw new Error('项目根须为绝对路径');
    if (fs.existsSync(options.projectRoot) && fs.lstatSync(options.projectRoot).isSymbolicLink()) throw new Error('项目根为链接');
    const dir = path.join(options.projectRoot, '.plugins', id);
    if (fs.existsSync(dir)) return { bundle: readInstalled(dir, id), source: 'project' };
  }
  const dir = path.join(path.resolve(appDir), 'plugins', id);
  if (!fs.existsSync(dir)) throw new Error('插件不存在：' + id);
  const raw = JSON.parse(fs.readFileSync(checkedFile(dir, 'manifest.json'), 'utf8'));
  const manifest = validateManifest(raw, true);
  if (manifest.id !== id || !manifest.source_skill) throw new Error('内置插件清单无效');
  const source = manifest.source_skill;
  const loaded = skills.loadSkill(appDir, source.name, null, options);
  if (!loaded.sha256) throw new Error('源Skill无法完整校验');
  const skillDir = path.dirname(loaded.file);
  const script = fs.readFileSync(checkedFile(skillDir, source.file));
  delete manifest.source_skill;
  return { bundle: makeBundle(manifest, [{ path: manifest.entry, bytes: script }]), source: 'builtin' };
}

function resolve({ appDir, selections, options = {}, lock = null }) {
  const picks = normalizeSelections(selections);
  if (lock != null && !Array.isArray(lock)) throw new Error('插件锁须为数组');
  if (lock) {
    const seen = new Set();
    for (const pin of lock) {
      keys(pin, ['id', 'status', 'sha256', 'version'], '插件锁');
      if (!safePart(pin.id) || !['loaded', 'off', 'unavailable'].includes(pin.status)
          || (pin.status === 'loaded' && (!shaPattern.test(pin.sha256) || typeof pin.version !== 'string'))
          || seen.has(pin.id.toLowerCase())) throw new Error('插件锁无效');
      seen.add(pin.id.toLowerCase());
    }
  }
  const entries = [], bundles = [];
  for (const pick of picks) {
    const pin = lock?.find(x => x.id === pick.id);
    const row = { id: pick.id, enabled: pick.enabled, status: 'unavailable', version: '', sha256: null, label: pick.id, capabilities: [], source: '', reason: '' };
    if (!pick.enabled) { row.status = 'off'; entries.push(row); continue; }
    // Partial locks retain unchanged selections; a newly enabled pick resolves
    // normally. Imported packages validate complete locks before reaching here.
    if (pin && pin.status !== 'loaded') { row.reason = '锁定插件缺失或未加载'; entries.push(row); continue; }
    try {
      const found = getBundle(appDir, pick.id, options);
      const { bundle } = found;
      if (pin && (pin.sha256 !== bundle.sha256 || pin.version !== bundle.manifest.version)) throw new Error('锁定指纹或版本不匹配，未使用同名替代插件');
      Object.assign(row, { status: 'loaded', version: bundle.manifest.version, sha256: bundle.sha256,
        label: bundle.manifest.label, capabilities: bundle.manifest.capabilities, source: found.source });
      bundles.push(bundle);
    } catch (error) { row.reason = error.message; }
    entries.push(row);
  }
  return { entries, bundles };
}

function materialize(root, bundles) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(bundles)) throw new Error('需要绝对根目录与插件包数组');
  const validated = bundles.map(validateBundle);
  if (new Set(validated.map(x => x.manifest.id.toLowerCase())).size !== validated.length) throw new Error('插件包ID重复');
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error('项目根为链接');
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const base = path.join(realRoot, '.plugins');
  if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) throw new Error('插件根为链接');
  fs.mkdirSync(base, { recursive: true });
  const installed = [];
  for (const bundle of validated) {
    const dest = path.join(base, bundle.manifest.id);
    if (fs.existsSync(dest)) {
      if (readInstalled(dest, bundle.manifest.id).sha256 !== bundle.sha256) throw new Error('已有同名插件内容不同');
      installed.push({ id: bundle.manifest.id, dir: dest, sha256: bundle.sha256 });
      continue;
    }
    const tmp = path.join(base, '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
    try {
      fs.mkdirSync(tmp);
      fs.writeFileSync(path.join(tmp, 'plugin.json'), JSON.stringify({ manifest: bundle.manifest, sha256: bundle.sha256 }), { flag: 'wx' });
      for (const row of bundle.files) {
        const target = path.join(tmp, ...row.path.split('/'));
        if (!inside(tmp, target)) throw new Error('插件写入路径越界');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(row.content, 'base64'), { flag: 'wx' });
      }
      fs.renameSync(tmp, dest);
      installed.push({ id: bundle.manifest.id, dir: dest, sha256: bundle.sha256 });
    } finally {
      if (fs.existsSync(tmp) && path.dirname(tmp) === base) fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return installed;
}

function loadFrozen(snapshot, id) {
  if (!plain(snapshot) || typeof snapshot.root !== 'string' || !path.isAbsolute(snapshot.root)) throw new Error('插件快照无效');
  const entries = Array.isArray(snapshot.plugins) ? snapshot.plugins : snapshot.plugins?.entries;
  const row = entries?.find(x => x.id === id);
  if (!row || row.status !== 'loaded' || row.enabled !== true || !shaPattern.test(row.sha256)) throw new Error('插件未在快照中启用');
  if (!fs.existsSync(snapshot.root) || fs.lstatSync(snapshot.root).isSymbolicLink()) throw new Error('插件快照根为链接或缺失');
  const dir = path.join(snapshot.root, '.plugins', id);
  const bundle = readInstalled(dir, id);
  if (bundle.sha256 !== row.sha256 || bundle.manifest.version !== row.version) throw new Error('冻结插件指纹不一致');
  return { manifest: bundle.manifest, root: dir, entry: checkedFile(dir, bundle.manifest.entry), sha256: bundle.sha256 };
}

function listAvailable(appDir, options = {}) {
  const ids = new Set();
  const builtin = path.join(path.resolve(appDir), 'plugins');
  if (fs.existsSync(builtin)) for (const ent of fs.readdirSync(builtin, { withFileTypes: true })) if (ent.isDirectory() && safePart(ent.name)) ids.add(ent.name);
  if (options.projectRoot) {
    const local = path.join(options.projectRoot, '.plugins');
    if (fs.existsSync(local)) for (const ent of fs.readdirSync(local, { withFileTypes: true })) if (ent.isDirectory() && safePart(ent.name)) ids.add(ent.name);
  }
  return [...ids].sort().map(id => resolve({ appDir, selections: [{ id, enabled: true }], options }).entries[0]);
}

module.exports = { normalizeSelections, validateBundle, getBundle, resolve, materialize, loadFrozen, listAvailable };
