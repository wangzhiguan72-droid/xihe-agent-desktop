'use strict';
// One bounded capability: render an existing formal result through guarded Python.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const plugins = require('./plugins'), artifacts = require('./run_artifacts');
const { Sandbox } = require('./sandbox');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inputHash = root => { const a = require('./agent'); return a.inputStampHash(a.stampInputFiles(root)); };
function localFile(root, name, limit = 2_000_000) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.includes('\0') || name.split(/[\\/]/).includes('..')) throw new Error('插件输入/输出须为工作区相对路径');
  const base = fs.realpathSync(root), abs = path.resolve(base, name);
  const rel = path.relative(base, fs.realpathSync(abs));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('插件文件真实路径越界');
  if (!fs.statSync(abs).isFile() || fs.statSync(abs).size > limit) throw new Error('插件文件缺失或超过大小限制');
  const bytes = fs.readFileSync(abs);
  if (bytes.length > limit) throw new Error('插件文件超过大小限制');
  return { path: path.relative(base, abs).replace(/\\/g, '/'), sha256: sha(bytes), bytes: bytes.length, content: bytes };
}
function savedFile(root, ref) {
  if (!ref?.path || !ref.sha256) throw new Error('插件证据缺文件指纹');
  const current = localFile(root, ref.path, 20_000_000);
  if (current.sha256 !== ref.sha256 || (ref.bytes != null && current.bytes !== ref.bytes)) throw new Error('插件证据文件已变化：' + ref.path);
  return current;
}
function sourceFor(root, session, qid, rid, source) {
  return require('./claim_trace').sourceFor(root, session, qid, rid, source);
}
function verifyValues(meta, recipe, data) {
  const at = field => {
    if (typeof field !== 'string' || field.split('.').some(p => !p || ['__proto__', 'constructor', 'prototype'].includes(p))) throw new Error('插件数值字段无效');
    let value = data;
    for (const key of field.split('.')) {
      if (!value || !Object.hasOwn(value, key)) throw new Error('插件数值字段不存在：' + field);
      value = value[key];
    }
    return value;
  };
  if (recipe.schema_version !== 1 || !Array.isArray(recipe.panels) || recipe.panels.length < 1 || recipe.panels.length > 4 || !Array.isArray(meta.panels) || meta.panels.length !== recipe.panels.length || new Set(meta.panels.map(p => p.id)).size !== meta.panels.length) throw new Error('图件面板与配方不一致');
  for (const expected of recipe.panels) {
    const actual = meta.panels.find(p => p.id === expected.id);
    if (!actual || actual.kind !== expected.kind || actual.unit !== expected.unit || actual.transform !== 'identity' || !Array.isArray(expected.series) || !Array.isArray(actual.series) || actual.series.length !== expected.series.length) throw new Error('图件面板的类型、单位或系列与配方不一致');
    if ((actual.x_field ?? null) !== (expected.x_field ?? null) || JSON.stringify(actual.categories ?? null) !== JSON.stringify(expected.categories ?? null)) throw new Error('图件类别或横轴字段与配方不一致');
    expected.series.forEach((series, index) => {
      const fields = series.fields || [series.field];
      if (!Array.isArray(fields) || !fields.length) throw new Error('插件数值字段清单无效');
      const values = series.fields ? fields.map(at) : at(series.field);
      if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'number' || !Number.isFinite(v)) || JSON.stringify(actual.series[index].fields) !== JSON.stringify(fields) || JSON.stringify(actual.series[index].values) !== JSON.stringify(values)) throw new Error('插件清单数值与正式结果字段不一致');
    });
  }
}
function validatePlot(root, session, id, questionId, runId, sourcePath, figure, sourceField) {
  const row = (session.plugin_runs || []).find(item => item.plot_run_id === id);
  if (!row?.ok || row.task_scope === 'local') throw new Error('插件绘图回执缺失、失败或仅用于临时任务');
  if (row.source.question_id !== questionId || row.source.run_id !== runId || row.source.path !== sourcePath) throw new Error('绘图回执与主张的子问/正式结果来源不一致');
  const currentSource = sourceFor(root, session, questionId, runId, sourcePath);
  if (JSON.stringify(currentSource) !== JSON.stringify(row.source) || row.input_hash !== inputHash(root)) throw new Error('绘图引用的正式运行、规格或输入已变化');
  const loaded = plugins.loadFrozen(session.skill_plan_snapshot, row.plugin_id);
  if (loaded.sha256 !== row.sha256 || session.skill_plan_snapshot.id !== row.snapshot_id) throw new Error('绘图插件的冻结版本已变化');
  savedFile(root, row.recipe); const metadata = JSON.parse(savedFile(root, row.manifest).content.toString('utf8')); savedFile(root, row.receipt_file);
  verifyValues(metadata, JSON.parse(savedFile(root, row.recipe).content.toString('utf8')), JSON.parse(localFile(root, sourcePath).content.toString('utf8')));
  const panel = (metadata.panels || []).find(item => item.id === figure.panel);
  if (!panel || !panel.series?.some(item => item.fields?.includes(sourceField))) throw new Error('图件面板未声明该主张的实际结果字段');
  for (const file of row.execution_files || []) savedFile(root, file);
  const expected = row.figures.find(file => file.path === figure.path);
  if (!expected || expected.sha256 !== figure.sha256 || expected.bytes !== figure.bytes) throw new Error('图件不属于该插件运行产出版本');
  savedFile(root, expected);
  return row;
}
async function runPlugin(ctx, args, execute) {
  const s = ctx.session, root = ctx.workspace;
  if (!s || !root || ctx.pyMode === 'ro' || ctx.redteamOnly || s.task_focus?.kind === 'local') throw new Error('插件绘图须在可写主线任务中执行');
  const program = plugins.loadFrozen(s.skill_plan_snapshot, args.plugin_id);
  if (!program.manifest.capabilities.includes('figures.render')) throw new Error('插件未声明绘图执行能力');
  if (!Number.isSafeInteger(args.question_id) || typeof args.source_run_id !== 'string') throw new Error('须指定子问和实际正式运行编号');
  const source = sourceFor(root, s, args.question_id, args.source_run_id, args.source_path);
  const recipe = localFile(root, args.recipe);
  const plan = JSON.parse(recipe.content.toString('utf8'));
  if (plan.source?.replace(/\\/g, '/') !== source.path) throw new Error('绘图配方 source 与声明的正式结果不一致');
  if (typeof args.output !== 'string' || !args.output) throw new Error('须指定工作区内图件前缀 output');
  const resultFiles = ['.png', '.pdf', '.figure.json'].map(ext => args.output + ext);
  const before = artifacts.begin(ctx, { result_files: resultFiles });
  const canonical = rel => {
    const full = path.resolve(root, rel);
    let parent = full;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    return path.join(fs.realpathSync(parent), path.relative(parent, full)).toLowerCase();
  };
  const outputPaths = resultFiles.map(canonical), protectedInputs = [canonical(source.path), canonical(recipe.path)];
  if (new Set(outputPaths).size !== outputPaths.length || outputPaths.some(file => protectedInputs.includes(file))) throw new Error('插件输出不能覆盖正式来源、配方或互相指向同一文件');
  const identity = file => { const stat = fs.statSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; };
  const protectedIds = [identity(path.join(root, source.path)), identity(path.join(root, recipe.path))];
  if (resultFiles.some(rel => fs.existsSync(path.join(root, rel)) && protectedIds.includes(identity(path.join(root, rel))))) throw new Error('插件输出硬链接指向正式来源或配方，拒绝覆盖');
  const destination = rel => {
    const dest = ctx.sandbox.resolve(rel, 'w');
    let probe = dest;
    while (probe !== path.dirname(probe) && path.resolve(probe) !== path.resolve(root)) {
      if (fs.existsSync(probe) && fs.lstatSync(probe).isSymbolicLink()) throw new Error('插件输出路径不能包含链接');
      probe = path.dirname(probe);
    }
    return dest;
  };
  resultFiles.forEach(destination);
  const startHash = inputHash(root), id = 'plot_' + crypto.randomBytes(10).toString('hex'), started = Date.now();
  const { bundle } = plugins.getBundle(ctx.appDir, args.plugin_id, { projectRoot: s.skill_plan_snapshot.root });
  if (bundle.sha256 !== program.sha256) throw new Error('插件包指纹与冻结记录不一致');
  const tempParent = path.resolve(ctx.appDir, 'data', 'pytemp'); fs.mkdirSync(tempParent, { recursive: true });
  const privateRoot = fs.mkdtempSync(path.join(tempParent, 'plugin-'));
  try {
  const stage = path.join(privateRoot, 'workspace'); fs.mkdirSync(stage);
  const stageCtx = { ...ctx, workspace: stage, appDir: path.join(privateRoot, 'env'), pluginSandbox: true,
    pluginReadRoot: program.root, sandbox: new Sandbox(stage, { readOnlyRoots: [program.root] }) };
  for (const [rel, bytes] of [[source.path, localFile(root, source.path).content], [recipe.path, recipe.content]]) {
    const copy = stageCtx.sandbox.resolve(rel, 'w'); fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.writeFileSync(copy, bytes);
  }
  const stageBefore = artifacts.begin(stageCtx, { result_files: resultFiles });
  let response;
  try {
    response = await execute(stageCtx, 'python_run', {
      code: `import runpy,sys,os\nsys.path.insert(0,${JSON.stringify(program.root)})\nsys.path.insert(0,os.path.dirname(${JSON.stringify(program.entry)}))\nsys.argv=['plugin','--root','.', '--recipe',${JSON.stringify(recipe.path)},'--output',${JSON.stringify(args.output)}]\nrunpy.run_path(${JSON.stringify(program.entry)},run_name='__main__')`,
      timeout_sec: Math.min(Math.max(Number(args.timeout_sec) || 120, 1), 300), result_artifact: true,
    });
  } catch (e) { response = { ok: false, data: e.message }; }
  const receipt = artifacts.finish(stageCtx, { result_files: resultFiles }, stageBefore, !!response.ok);
  const row = { plot_run_id: id, plugin_id: args.plugin_id, version: program.manifest.version, sha256: program.sha256,
    snapshot_id: s.skill_plan_snapshot.id, capability: 'figures.render', source, recipe: { path: recipe.path, sha256: recipe.sha256, bytes: recipe.bytes },
    input_hash: startHash, at: started, elapsed_ms: Date.now() - started, ok: !!response.ok,
    figures: receipt.files.filter(file => /\.(png|pdf)$/.test(file.path)), issues: receipt.issues.slice(),
    task_scope: s.task_scope || 'solve', execution_scope: 'isolated-input-copies', execution_files: [] };
  if (!response.ok) row.issues.push(String(response.data || response.error || 'Python 执行失败').slice(-1800));
  try {
    if (inputHash(root) !== startHash || JSON.stringify(sourceFor(root, s, args.question_id, args.source_run_id, source.path)) !== JSON.stringify(source)) throw new Error('绘图运行期间修改了正式输入/来源');
    if (localFile(root, recipe.path).sha256 !== recipe.sha256) throw new Error('绘图期间配方变化');
    if (localFile(stage, source.path).sha256 !== source.sha256 || localFile(stage, recipe.path).sha256 !== recipe.sha256) throw new Error('插件修改了隔离输入副本，拒绝接收图件');
    if (plugins.loadFrozen(s.skill_plan_snapshot, args.plugin_id).sha256 !== program.sha256) throw new Error('绘图期间插件版本变化');
    if (receipt.files.length !== 3) throw new Error('插件未生成全部声明图件及来源清单');
    const file = localFile(stage, resultFiles[2]), meta = JSON.parse(file.content.toString('utf8'));
    if (meta.source?.path !== source.path || meta.source.sha256 !== source.sha256 || meta.recipe?.path !== recipe.path || meta.recipe.sha256 !== recipe.sha256) throw new Error('图件来源清单未绑定当前正式结果和配方');
    for (const fig of row.figures) if (!(meta.figures || []).some(ref => ref.path === fig.path && ref.sha256 === fig.sha256)) throw new Error('来源清单中的图版本不匹配');
    verifyValues(meta, plan, JSON.parse(localFile(root, source.path).content.toString('utf8')));
    row.manifest = { path: file.path, sha256: file.sha256, bytes: file.bytes };
  } catch (e) { row.issues.push(e.message); }
  row.ok = row.ok && row.issues.length === 0;
  if (row.ok) {
    try {
      for (const rel of resultFiles) {
        const to = destination(rel); fs.mkdirSync(path.dirname(to), { recursive: true });
        const pending = to + '.' + id + '.tmp';
        let created = false;
        try {
          fs.copyFileSync(path.join(stage, rel), pending, fs.constants.COPYFILE_EXCL);
          created = true;
          fs.renameSync(pending, to);
        } finally { if (created && fs.existsSync(pending)) fs.unlinkSync(pending); }
      }
      if (inputHash(root) !== startHash || localFile(root, source.path).sha256 !== source.sha256 || localFile(root, recipe.path).sha256 !== recipe.sha256) throw new Error('接收图件时正式输入或配方变化');
      const committed = artifacts.finish(ctx, { result_files: resultFiles }, before, true);
      row.figures = committed.files.filter(file => /\.(png|pdf)$/.test(file.path)); row.issues.push(...committed.issues);
      if (committed.files.length !== 3) row.issues.push('主机未能接收完整图件');
    } catch (e) { row.issues.push('图件接收失败：' + e.message); }
    row.ok = row.issues.length === 0;
  } else row.figures = [];
  // Archive the exact executable bundle after the invocation. The host fixes its
  // hashes; a plugin's stdout cannot assert it executed a different version.
  const prefix = 'findings/plugin_runs/' + id;
  for (const file of bundle.files) {
    const rel = prefix + '/program/' + file.path, abs = ctx.sandbox.resolve(rel, 'w');
    fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, Buffer.from(file.content, 'base64'));
    row.execution_files.push({ path: rel, sha256: file.sha256, bytes: fs.statSync(abs).size });
  }
  const configPath = prefix + '/plugin.json', configAbs = ctx.sandbox.resolve(configPath, 'w');
  fs.mkdirSync(path.dirname(configAbs), { recursive: true }); const config = JSON.stringify(bundle.manifest, null, 2);
  fs.writeFileSync(configAbs, config); row.execution_files.push({ path: configPath, sha256: sha(Buffer.from(config)), bytes: Buffer.byteLength(config) });
  const logPath = prefix + '/execution.log', logAbs = ctx.sandbox.resolve(logPath, 'w');
  const log = String(response.data || response.error || '').slice(-100000); fs.writeFileSync(logAbs, log);
  row.execution_files.push({ path: logPath, sha256: sha(Buffer.from(log)), bytes: Buffer.byteLength(log) });
  const receiptPath = prefix + '/receipt.json', receiptAbs = ctx.sandbox.resolve(receiptPath, 'w');
  row.elapsed_ms = Date.now() - started;
  const serialized = JSON.stringify(row, null, 2); fs.writeFileSync(receiptAbs, serialized);
  row.receipt_file = { path: receiptPath, sha256: sha(Buffer.from(serialized)), bytes: Buffer.byteLength(serialized) };
  s.plugin_runs = [...(s.plugin_runs || []), row].slice(-100);
  return { exit: row.ok ? 0 : 1, stdout: JSON.stringify({ plot_run_id: id, ok: row.ok, plugin: row.plugin_id, figures: row.figures.map(f => f.path), receipt: receiptPath }), stderr: row.issues.join('\n'), _pluginRunId: id };
  } finally {
    const actual = fs.realpathSync(privateRoot), parent = fs.realpathSync(tempParent);
    if (path.dirname(actual) !== parent || !path.basename(actual).startsWith('plugin-')) throw new Error('拒绝清理不属于本次插件的临时目录');
    fs.rmSync(actual, { recursive: true, force: true });
  }
}
module.exports = { runPlugin, validatePlot };
