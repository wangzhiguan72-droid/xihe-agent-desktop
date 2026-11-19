// Skill discovery stays read-only; portable bundles install only under a caller-supplied project root.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOTS = [
  { dir: path.join(os.homedir(), '.agents', 'skills'), tag: 'agents', priority: 1 },
  { dir: path.join(os.homedir(), '.codex', 'skills'), tag: 'codex', priority: 1 },
  { dir: path.join(os.homedir(), '.zcode', 'skills'), tag: 'zcode', priority: 1 },
  { dir: path.join(__dirname, '..', 'skills'), tag: 'xihe', priority: 2 },
];
const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
const MAX_FILES = 200;
const MAX_BYTES = 8 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stableCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

function getRoots(appDir = path.resolve(__dirname, '..'), options = {}) {
  const roots = ROOTS.filter(root => root.tag !== 'xihe').map(root => ({ ...root }));
  if (!Array.isArray(options.extraRoots || [])) throw new Error('extraRoots 必须为数组');
  for (const [i, row] of (options.extraRoots || []).entries()) {
    const dir = typeof row === 'string' ? row : row?.dir;
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('本机 Skill 搜索根须为绝对路径');
    roots.push({ dir: path.resolve(dir), tag: `extra${i + 1}`, priority: 0 });
  }
  roots.push({ dir: path.join(path.resolve(appDir), 'skills'), tag: 'xihe', priority: 2 });
  if (options.projectRoot != null) {
    if (typeof options.projectRoot !== 'string' || !path.isAbsolute(options.projectRoot)) throw new Error('项目 Skill 根须为绝对路径');
    roots.push({ dir: path.resolve(options.projectRoot), tag: 'project', priority: 3 });
  }
  return roots;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let key = null, buf = '';
  const flush = () => {
    if (key) fm[key] = buf.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    key = null; buf = '';
  };
  for (const ln of lines) {
    const kv = ln.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) { flush(); key = kv[1]; buf = kv[2]; }
    else if (key) buf += ' ' + ln.trim();
  }
  flush();
  return fm;
}

const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function versionOf(fm) {
  return fm.metadata ? (String(fm.metadata).match(/version:\s*["']?([^\s"']+)/) || [])[1] || '' : (fm.version || '');
}
function manifestHash(files) {
  return sha256(JSON.stringify(files.map(row => [row.path, row.sha256])));
}
function fileRows(dir) {
  const rows = [];
  const realRoot = fs.realpathSync(dir);
  let bytes = 0;
  const walk = (current, prefix = '') => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => stableCompare(a.name, b.name))) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.toLowerCase().endsWith('.bak')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Skill 包含链接，不能完整导出：${rel}`);
      if (!inside(realRoot, fs.realpathSync(file))) throw new Error(`Skill 文件越界：${rel}`);
      if (entry.isDirectory()) { walk(file, rel); continue; }
      if (!entry.isFile()) throw new Error(`Skill 包含非普通文件：${rel}`);
      bytes += fs.statSync(file).size;
      if (rows.length >= MAX_FILES || bytes > MAX_BYTES) throw new Error('Skill 超出可移植上限（200文件/8MB）');
      const content = fs.readFileSync(file);
      rows.push({ path: rel, content: content.toString('base64'), sha256: sha256(content) });
    }
  };
  walk(dir);
  rows.sort((a, b) => stableCompare(a.path, b.path));
  if (!rows.some(row => row.path === 'SKILL.md')) throw new Error('Skill 缺少 SKILL.md');
  return rows;
}
function digestSkill(dir) {
  try { return manifestHash(fileRows(dir)); }
  catch { return null; }
}

// 列出技能根下的技能目录。
// **关键**：Windows 的 junction（目录联接）在 readdir(withFileTypes) 里既不是目录也不是文件
// （isDirectory()=false、isFile()=false、只有 isSymbolicLink()=true），旧写法 `.filter(isDirectory)`
// 会把它静默丢掉——实测 .agents/skills 下 180 个条目有 130 个是 junction，其中 56 个与数模/论文
// 直接相关（scipilot-figure-skill、nature-figure、cumcm-math-modeling…），后果是 skill_search
// 搜不到、skill_load 载不进来，HANDOFF 的绘图路由因此指向了空气。
// 这里对符号链接用 statSync（跟随链接）确认目标确实是目录才收录；断链跳过，不炸。
function listSkillDirs(rootDir) {
  let ents = [];
  try { ents = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (e.isDirectory()) { out.push(e.name); continue; }
    if (e.isSymbolicLink()) {
      try { if (fs.statSync(path.join(rootDir, e.name)).isDirectory()) out.push(e.name); } catch { /* 断链跳过 */ }
    }
  }
  return out;
}

function buildIndex(roots) {
  const byName = new Map();
  for (const root of roots) {
    const dirs = listSkillDirs(root.dir);
    for (const dirName of dirs) {
      const skillFile = path.join(root.dir, dirName, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(skillFile, 'utf8'); } catch { continue; }
      const fm = parseFrontmatter(text);
      const name = fm.name || dirName;
      const prev = byName.get(name);
      let refs = [];
      try {
        refs = fs.readdirSync(path.join(root.dir, dirName, 'references'), { withFileTypes: true })
          .filter(x => x.isFile() || x.isSymbolicLink()).map(x => x.name);
      } catch {}
      const row = {
        name,
        dir: dirName,
        root: root.dir,
        tag: root.tag,
        priority: root.priority,
        source: root.tag,
        version: versionOf(fm),
        description: (fm.description || '').slice(0, 220),
        refs,
        size: text.length,
        // Fingerprint full contents only when this Skill is actually selected/exported.
        // Scanning every binary asset in every installed Skill would make ordinary search slow.
        sha256: null, fingerprint_pending: true, shadowed: [],
      };
      if (!prev) { byName.set(name, row); continue; }
      const shadow = item => ({ name, tag: item.tag, source: item.source, root: item.root, dir: item.dir,
        version: item.version, sha256: item.sha256 });
      if (prev.priority >= row.priority) prev.shadowed.push(shadow(row));
      else { row.shadowed = [shadow(prev), ...prev.shadowed]; byName.set(name, row); }
    }
  }
  return [...byName.values()];
}

// Each project has its own index entry. Root/directory changes are visible immediately;
// SKILL.md edits also invalidate discovery; resource bytes are always read on selection/export.
function rootsStamp(roots) {
  return roots.map(root => {
    let stamp;
    try { stamp = fs.statSync(root.dir).mtimeMs; } catch { stamp = 'missing'; }
    const dirs = listSkillDirs(root.dir).map(name => {
      try {
        const skill = fs.statSync(path.join(root.dir, name, 'SKILL.md'));
        return `${name}:${fs.statSync(path.join(root.dir, name)).mtimeMs}:${skill.mtimeMs}:${skill.size}`;
      } catch { return name; }
    });
    return `${root.tag}:${root.dir}:${stamp}:${dirs.join(',')}`;
  }).join('|');
}
function getIndex(appDir, force = false, options = {}) {
  const roots = getRoots(appDir, options);
  const key = JSON.stringify(roots.map(root => [root.dir, root.tag, root.priority]));
  const stamp = rootsStamp(roots);
  const prior = cache.get(key);
  if (!prior || force || stamp !== prior.stamp || Date.now() - prior.at >= CACHE_TTL_MS) {
    cache.set(key, { at: Date.now(), stamp, index: buildIndex(roots) });
    if (cache.size > 24) cache.delete(cache.keys().next().value);
  }
  return cache.get(key).index;
}

function loadSkill(appDir, name, refFile, options = {}) {
  const idx = getIndex(appDir, false, options);
  const s = idx.find(x => x.name === name || x.dir === name);
  if (!s) {
    const sug = idx.filter(x => x.name.toLowerCase().includes(String(name).toLowerCase().slice(0, 6))).slice(0, 5).map(x => x.name);
    throw new Error(`技能 ${name} 不存在。相近技能：${sug.join('、') || '无'}`);
  }
  const skillDir = path.resolve(s.root, s.dir);
  // 引用文件只允许 references/ 下、无路径分隔符的纯文件名（杜绝 ../ 前缀逃逸与相邻目录混入）
  if (refFile != null && String(refFile) !== '') {
    const rf = String(refFile);
    if (/[\\/]|\.\./.test(rf)) throw new Error(`越界拒绝：引用文件名不能包含路径分隔符（收到: ${rf}）`);
    if (s.refs.length && !s.refs.includes(rf)) throw new Error(`越界拒绝：${rf} 不在技能 ${s.name} 的 references 清单内。可用: ${s.refs.join('、')}`);
  }
  const file = refFile ? path.join(skillDir, 'references', refFile) : path.join(skillDir, 'SKILL.md');
  const resolved = path.resolve(file);
  // 边界校验：必须在「该技能自己的目录」内（不只是技能根的前缀匹配）
  if (!inside(skillDir, resolved)) throw new Error('越界拒绝：技能读取必须位于该技能目录内');
  // 真实路径二次校验（符号链接逃逸）。技能根可能是 junction 或符号链接，
  // 因此以「技能目录的真实路径」为基准，而不是字面路径。
  let probe = resolved;
  while (probe && !fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const realSkillDir = fs.realpathSync(skillDir);
  const real = fs.realpathSync(probe);
  if (!inside(realSkillDir, real)) throw new Error('越界拒绝：技能文件实际指向技能目录外');
  const content = fs.readFileSync(resolved, 'utf8');
  // 版本号就地重解析：索引里的是缓存值，用户改了 SKILL.md 的 version 后要立刻反映
  // （顶栏会显示「已加载技能 x v…」，显示旧版本号会让人以为没生效）
  let version = s.version;
  try {
    const fm = parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
    version = versionOf(fm);
  } catch {}
  return { name: s.name, version, file: resolved, refs: s.refs, content,
    source: s.source, tag: s.tag, root: s.root, shadowed: s.shadowed, sha256: digestSkill(skillDir),
    contract: require('./skill_assessment').readContract(skillDir) };
}

function searchSkills(appDir, query, limit = 10, options = {}) {
  const idx = getIndex(appDir, false, options);
  const q = String(query).toLowerCase();
  const scored = idx.map(s => {
    let score = 0;
    if (s.name.toLowerCase().includes(q)) score += 10;
    if (s.description.toLowerCase().includes(q)) score += 3;
    if (s.refs.some(r => r.toLowerCase().includes(q))) score += 1;
    for (const kw of q.split(/\s+/)) {
      if (kw && s.name.toLowerCase().includes(kw)) score += 3;
      if (kw && s.description.toLowerCase().includes(kw)) score += 1;
    }
    return { s, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return scored.map(x => `${x.s.name}(${x.s.tag}${x.s.version ? ' v' + x.s.version : ''})：${x.s.description.slice(0, 120)}`);
}

function safeComponent(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 120 && name !== '.' && name !== '..'
    && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name);
}
function safeRelative(rel) {
  return typeof rel === 'string' && rel.length > 0 && rel.length <= 600
    && rel.split('/').every(safeComponent) && !rel.includes('\\') && !path.posix.isAbsolute(rel);
}
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || !safeComponent(bundle.name)) throw new Error('Skill 包名称无效');
  if (typeof bundle.version !== 'string' || bundle.version.length > 100) throw new Error('Skill 包版本无效');
  if (!Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > MAX_FILES) throw new Error('Skill 包文件数无效');
  const seen = new Set();
  let total = 0;
  const files = bundle.files.map(row => {
    if (!row || !safeRelative(row.path) || typeof row.content !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.content)) {
      throw new Error('Skill 包包含无效路径或内容');
    }
    const key = row.path.toLowerCase();
    if (seen.has(key)) throw new Error('Skill 包文件路径重复');
    seen.add(key);
    const bytes = Buffer.from(row.content, 'base64');
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Skill 包超过8MB上限');
    const checksum = sha256(bytes);
    if (row.sha256 !== checksum) throw new Error('Skill 包文件指纹不一致：' + row.path);
    return { path: row.path, content: row.content, sha256: checksum };
  }).sort((a, b) => stableCompare(a.path, b.path));
  if (!files.some(row => row.path === 'SKILL.md')) throw new Error('Skill 包缺SKILL.md');
  const contractFile = files.find(row => row.path === 'skill-contract.json');
  if (contractFile) {
    const bytes = Buffer.from(contractFile.content, 'base64');
    if (bytes.length > 64000) throw new Error('skill-contract.json超过64KB');
    require('./skill_assessment').normalizeContract(JSON.parse(bytes.toString('utf8')));
  }
  const manifest = manifestHash(files);
  if (bundle.sha256 !== manifest) throw new Error('Skill 包总指纹不一致');
  const frontmatter = parseFrontmatter(Buffer.from(files.find(row => row.path === 'SKILL.md').content, 'base64').toString('utf8'));
  if ((frontmatter.name && frontmatter.name !== bundle.name) || versionOf(frontmatter) !== bundle.version) throw new Error('Skill 包名称/版本与SKILL.md不一致');
  return { name: bundle.name, version: bundle.version, sha256: manifest, files };
}
function readSkillBundle(appDir, name, options = {}) {
  const loaded = loadSkill(appDir, name, undefined, options);
  const files = fileRows(path.dirname(loaded.file));
  return validateBundle({ name: loaded.name, version: loaded.version, sha256: manifestHash(files), files });
}
function materializeBundles(root, bundles) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(bundles)) throw new Error('需要绝对项目根与Skill包数组');
  const validated = bundles.map(validateBundle);
  if (new Set(validated.map(bundle => bundle.name.toLowerCase())).size !== validated.length) throw new Error('Skill 包名称重复');
  fs.mkdirSync(root, { recursive: true });
  const realRoot = fs.realpathSync(root);
  const installed = [];
  for (const bundle of validated) {
    const target = path.join(realRoot, bundle.name);
    if (!inside(realRoot, target)) throw new Error('Skill 安装路径越界');
    if (fs.existsSync(target)) {
      if (fs.lstatSync(target).isSymbolicLink() || manifestHash(fileRows(target)) !== bundle.sha256) throw new Error(`已有同名 Skill 内容不同，拒绝覆盖：${bundle.name}`);
      installed.push({ name: bundle.name, dir: target, sha256: bundle.sha256 });
      continue;
    }
    const temporary = path.join(realRoot, `.${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(temporary);
      for (const row of bundle.files) {
        const destination = path.join(temporary, ...row.path.split('/'));
        if (!inside(temporary, destination)) throw new Error('Skill 包路径越界');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, Buffer.from(row.content, 'base64'), { flag: 'wx' });
      }
      fs.renameSync(temporary, target);
      installed.push({ name: bundle.name, dir: target, sha256: bundle.sha256 });
    } finally {
      if (path.dirname(temporary) !== realRoot) throw new Error('临时路径越界');
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return installed;
}

module.exports = { ROOTS, getRoots, getIndex, loadSkill, searchSkills, readSkillBundle, validateBundle, materializeBundles };
