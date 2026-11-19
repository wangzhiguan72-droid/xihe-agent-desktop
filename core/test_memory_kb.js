// 经验库（memory.js）+ 知识库（kb.js）+ skill_save + kb_roots 沙箱只读 单测
// 运行：node core/test_memory_kb.js（在 xihe-agent 目录下，全离线，零 API）
'use strict';
const fs = require('fs'); const path = require('path'); const os = require('os');
const { execSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', String(e && e.message || e).slice(0, 160)); } };
const tAsync = async (name, fn) => { try { await fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '->', String(e && e.message || e).slice(0, 160)); } };
// 夹具清理挂 exit 而不是只写在文件末尾：末尾那条够不着失败分支，~/.xihe-conf-* 攒下的 8 个
// 就是失败那几次留下的（同批的 .xihe-memkb-* 一个都没有——那些是成功那几次，末尾清理跑到了）。
process.on('exit', (code) => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); }
  catch (e) { console.error(`[夹具未清理] 退出码 ${code}，请手动删除：${tmp}（${e.code || e.message}）`); }
});

// ---- 夹具：临时 appDir + workspace + 小型语料库 ----
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.xihe-memkb-'));
const appDir = path.join(tmp, 'app');
const ws = path.join(tmp, 'workspace');
const corpus = path.join(tmp, 'corpus');
fs.mkdirSync(path.join(appDir, 'config'), { recursive: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(corpus, 'ai-run'), { recursive: true });
fs.mkdirSync(path.join(corpus, 'own-draft'), { recursive: true });
fs.mkdirSync(path.join(corpus, 'advice'), { recursive: true });

const mem = require('./memory');
const kb = require('./kb');
const { createSandbox } = require('./sandbox');
const { executeTool } = require('./tools');

// ---------- memory.js（同步部分） ----------
t('经验库写入与统计', () => {
  const r = mem.addEntry(appDir, { kind: 'lesson', text: 'ode15s 必须配 JPattern 否则慢', situation: 'python_run FVM 网格', tags: ['ode15s'] });
  if (!r.entry.id) throw new Error('未返回 id');
  mem.addEntry(appDir, { kind: 'memory', text: 'MATLAB 主解、Python 审计' });
  const s = mem.stats(appDir);
  if (s.total !== 2 || s.lessons !== 1 || s.memory !== 1) throw new Error('stats 错: ' + JSON.stringify(s));
});

t('经验库去重：同文再写是更新不是新增', () => {
  mem.addEntry(appDir, { text: 'MATLAB 主解、Python 审计' });
  const s = mem.stats(appDir);
  if (s.total !== 2) throw new Error('重复写不该新增，total=' + s.total);
});

t('召回：关键词命中 + lesson 加权 + toolFail 场景加权', () => {
  mem.addEntry(appDir, { kind: 'lesson', text: 'xlsx 比对用 spreadsheet_diff 别目测', situation: 'spreadsheet_diff 结果对比', tags: ['比对'] });
  const hits = mem.recall(appDir, '结果 比对 用什么', { limit: 5 });
  if (!hits.length) throw new Error('无命中');
  const lessonFirst = hits.find(h => h.kind === 'lesson');
  if (!lessonFirst) throw new Error('lesson 未被召回');
  const tf = mem.recall(appDir, 'ode15s 报错', { toolFail: 'python_run', kind: 'lesson' });
  if (!tf.length || !/JPattern/.test(tf[0].text)) throw new Error('toolFail 场景未命中 ode15s lesson');
});

t('召回大小写/中文二元组混合命中', () => {
  const hits = mem.recall(appDir, 'matlab主解', {});
  if (!hits.length) throw new Error('中文+英文混合查询未命中');
});

t('删除条目', () => {
  const all = mem.loadStore(appDir);
  const id = all[0].id;
  if (!mem.removeEntry(appDir, id)) throw new Error('删除失败');
  if (mem.removeEntry(appDir, id)) throw new Error('重复删不该成功');
});

// ---------- kb.js（先跑真实索引器建小索引） ----------
t('kb_extract.py 真实建索引', () => {
  fs.writeFileSync(path.join(corpus, '获奖范文A.md'), '# 微分方程获奖论文\n本文用 ode15s 求解刚性方程，网格收敛做了两套比对。灵敏度分析覆盖全部参数。\n模型假设含恒温边界与均匀介质，结果与实验值吻合。\n附录给出全部代码与网格加密曲线。'.repeat(3));
  fs.writeFileSync(path.join(corpus, 'ai-run', 'AI稿.md'), '纯AI生成的内容：直接给出答案 42，没有守恒审计，没有网格验证。\n全文没有灵敏度分析，参数取值没有依据，图表没有标注数据来源，是典型的全自动跑稿缺陷。'.repeat(3));
  fs.writeFileSync(path.join(corpus, 'own-draft', 'notes.md'), '解题记录：LP 模型用 linprog，灵敏度看影子价格。\n当时时间紧没做收敛验证，被评审批注"网格无关性未证明"，这条经验记在这里。'.repeat(3));
  fs.writeFileSync(path.join(corpus, 'advice', '方法论.md'), '数模方法论：先问题分析再模型假设，摘要要有一页。\n模型评价部分别只写优点，缺点与适用边界同样要交代清楚，这是评委看重的诚实性。'.repeat(3));
  fs.writeFileSync(path.join(corpus, 'binary.png'), 'not text'); // 非索引类型应被跳过
  const out = path.join(appDir, 'data', 'kb');
  const r = execSync(`python "${path.join(__dirname, 'kb_extract.py')}" --root "${corpus}" --out "${out}"`, { encoding: 'utf8', timeout: 60000 });
  const last = r.trim().split('\n').pop();
  const j = JSON.parse(last);
  if (!j.ok || j.docs < 4) throw new Error('索引结果异常: ' + last.slice(0, 200));
  if (j.byProv.agent_run !== 1 || j.byProv.exemplar !== 1 || j.byProv.user_own !== 1) throw new Error('provenance 分级错: ' + JSON.stringify(j.byProv));
  const st = kb.status(appDir);
  if (!st.built || st.docs < 4) throw new Error('kb.status 未读到索引');
});

t('kb_search：命中+provenance 标注+agent_run 降权', () => {
  const r = kb.search(appDir, '网格收敛 ode15s', { limit: 5 });
  if (r.error) throw new Error(r.error);
  if (!r.hits.length) throw new Error('无命中');
  if (r.hits[0].prov === 'agent_run') throw new Error('AI 跑稿不应排最前');
  const r2 = kb.search(appDir, '答案', { prov: 'agent_run' });
  if (r2.error || !r2.hits.length || r2.hits[0].prov !== 'agent_run') throw new Error('prov 过滤失效');
});

t('kb_read：回读分块 + 列文档', () => {
  const docs = kb.listDocs(appDir, {});
  if (docs.length < 4) throw new Error('文档清单短');
  const r = kb.read(appDir, docs[0].id, { n: 2 });
  if (r.error || !r.blocks.length) throw new Error('回读失败: ' + (r.error || 'no blocks'));
});

// ---------- 沙箱 kb_roots 只读 ----------
t('kb_roots 并入只读根：可读不可写', () => {
  fs.writeFileSync(path.join(appDir, 'config', 'settings.json'), JSON.stringify({ kb_roots: [corpus] }));
  const sb = createSandbox(appDir, { workspace: ws });
  const md = path.join(corpus, '获奖范文A.md');
  const r = sb.resolve(md, 'r'); // 应放行
  if (!fs.existsSync(r)) throw new Error('读路径解析异常');
  let denied = false;
  try { sb.resolve(md, 'w'); } catch { denied = true; }
  if (!denied) throw new Error('知识库目录应只读，写入竟然放行');
  try { sb.resolve(path.join(corpus, 'evil.txt'), 'w'); denied = false; } catch { denied = true; }
  if (!denied) throw new Error('知识库内新文件写入竟然放行');
});

// ---------- agent.js 注入点 ----------
t('V-26 异项目经验降权并标注来源项目', () => {
  const m = require('./memory');
  m.addEntry(appDir, { kind: 'lesson', text: '主解语言 MATLAB 本项目铁律 zzq', project: 'projA' });
  m.addEntry(appDir, { kind: 'lesson', text: '主解语言 以当前项目约定为准 zzq' });
  const other = m.recall(appDir, '主解语言 MATLAB zzq', { project: 'projB' });
  if (/projA|铁律/.test(other[0].text)) throw new Error('异项目条目未降权');
  if (!/来自项目 projA/.test(m.formatEntries(other, 'h'))) throw new Error('缺来源项目标注');
});

t('项目隔离：memory 跨项目硬屏蔽，GLOBAL 放行，lesson 仅降权', () => {
  const d = fs.mkdtempSync(path.join(os.homedir(), '.xihe-scope-'));
  try {
    mem.addEntry(d, { kind: 'memory', text: '共同标记 zeta 项目A专用语言裁定', project: 'projA' });
    mem.addEntry(d, { kind: 'memory', text: '共同标记 zeta 旧库未标项目' });
    mem.addEntry(d, { kind: 'memory', text: '共同标记 zeta 全局偏好', project: mem.GLOBAL_PROJECT });
    mem.addEntry(d, { kind: 'lesson', text: '共同标记 zeta 可迁移项目教训', project: 'projA' });
    mem.addEntry(d, { kind: 'lesson', text: '共同标记 zeta 项目铁律：只在旧项目适用' });
    const hits = mem.recall(d, '共同标记 zeta', { project: 'projB', limit: 10 });
    if (hits.some(e => /项目A专用|旧库未标|项目铁律/.test(e.text))) throw new Error('项目专属、未标 memory 或未标项目铁律泄漏到 projB');
    if (!hits.some(e => /全局偏好/.test(e.text))) throw new Error('GLOBAL 未召回');
    if (!hits.some(e => /可迁移项目教训/.test(e.text))) throw new Error('lesson 被错误硬屏蔽');
    const report = mem.auditStore(d);
    if (report.unscoped.length !== 2) throw new Error('未标项目审计数量错误: ' + report.unscoped.length);
    const legacy = report.unscoped.find(e => e.kind === 'memory');
    mem.markGlobal(d, legacy.id, '测试确认通用');
    const after = mem.recall(d, '共同标记 zeta', { project: 'projB', limit: 10 });
    if (!after.some(e => e.id === legacy.id && e.project === mem.GLOBAL_PROJECT)) throw new Error('显式 GLOBAL 后仍未放行');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t('stateBlock 含经验库/知识库状态行', () => {
  const { stateBlock } = require('./agent');
  const sess = { formulas: [], decisions: [], contract: [], question_graph: [], runs: [], memory: [], data_epoch: 0 };
  const b = stateBlock(sess, appDir);
  if (!/经验库|知识库/.test(b)) throw new Error('stateBlock 缺经验/知识库行');
});

t('buildSystem 含经验与知识库用法段', () => {
  const { buildSystem } = require('./agent');
  const sys = buildSystem('free', ws, {}, appDir, 'deepseek');
  if (!/经验与知识库/.test(sys) || !/lesson_record/.test(sys)) throw new Error('system 缺经验层说明');
});

// ---------- 异步部分：executeTool 集成 ----------
const ctx = { appDir, workspace: ws, sandbox: createSandbox(appDir, { workspace: ws }), settings: { kb_roots: [corpus] }, session: { memory: [] }, setTodos: () => {}, addMemory: () => {} };

async function runAsync() {
  await tAsync('lesson_record 工具落库', async () => {
    const r = await executeTool(ctx, 'lesson_record', { situation: 'matlab 缺 JPattern', rule: '刚性 ODE 必须给稀疏雅可比', tags: ['ode'] });
    if (!r.ok || !/教训已记/.test(r.data)) throw new Error(String(r.data || r.error).slice(0, 120));
    const all = mem.loadStore(appDir);
    if (!all.some(e => e.kind === 'lesson' && /JPattern|雅可比/.test(e.text))) throw new Error('教训未落库');
  });

  await tAsync('memory_write persistent 走经验库', async () => {
    const r = await executeTool(ctx, 'memory_write', { content: '用户偏好 DeepSeek 主力模型', scope: 'persistent' });
    if (!r.ok || !/经验库/.test(r.data)) throw new Error(String(r.data || r.error).slice(0, 120));
  });

  await tAsync('memory_recall 检索工具', async () => {
    const r = await executeTool(ctx, 'memory_recall', { query: 'JPattern' });
    if (!r.ok || !/经验库召回|经验库最近/.test(r.data)) throw new Error(String(r.data).slice(0, 160));
  });

  await tAsync('kb_search/kb_read 工具层走通', async () => {
    const r = await executeTool(ctx, 'kb_search', { query: '灵敏度分析' });
    if (!r.ok || !/知识库命中|无有效命中/.test(r.data)) throw new Error(String(r.data || r.error).slice(0, 160));
    const r2 = await executeTool(ctx, 'kb_read', {});
    if (!r2.ok || !/文档清单|尚未构建/.test(r2.data)) throw new Error(String(r2.data).slice(0, 160));
  });

  await tAsync('kb_build 未配根时提示', async () => {
    const ctxNoRoots = { ...ctx, settings: {} };
    const r = await executeTool(ctxNoRoots, 'kb_build', {});
    if (!r.ok || !/未配置语料根/.test(r.data)) throw new Error('应提示未配置: ' + String(r.data || r.error).slice(0, 120));
  });

  await tAsync('skill_save：写入+可检索+覆盖留 .bak+非法名拒绝', async () => {
    const { getIndex } = require('./skills');
    const appRoot = path.resolve(__dirname, '..'); // 真 appDir：skill_save 写 skills/
    const ctx2 = { ...ctx, appDir: appRoot };
    const r = await executeTool(ctx2, 'skill_save', { name: 'test-fixture-skill', description: '测试夹具技能：验证 skill_save 落盘与检索', content: '## 用途\n测试用技能。\n## 步骤\n1. 做 A；2. 做 B；3. 校验输出。\n## 注意\n本技能是测试夹具，可删。' });
    if (!r.ok || !/技能已沉淀/.test(r.data)) throw new Error(String(r.data || r.error).slice(0, 160));
    const idx = getIndex(appRoot, true);
    if (!idx.some(s => s.name === 'test-fixture-skill')) throw new Error('索引未收录新技能');
    const r2 = await executeTool(ctx2, 'skill_save', { name: 'test-fixture-skill', description: 'v2', content: '## 用途\n更新版测试技能。\n## 步骤\n1. 做 A；2. 做 C（替代 B）；3. 校验输出并记录差异。' });
    if (!/\.bak/.test(r2.data)) throw new Error('覆盖未留 .bak');
    if (!fs.existsSync(path.join(appRoot, 'skills', 'test-fixture-skill', 'SKILL.md.bak'))) throw new Error('.bak 文件不存在');
    fs.rmSync(path.join(appRoot, 'skills', 'test-fixture-skill'), { recursive: true, force: true });
    // 非法名走 executeTool 的异常上抛路径（工具内 throw）
    let threw = false;
    try { await executeTool(ctx2, 'skill_save', { name: '../evil', description: 'x', content: 'y'.repeat(80) }); }
    catch { threw = true; }
    if (!threw) throw new Error('非法名竟然放行');
  });

  // ---------- v2.5：教训入库前反证检查（issues V-27 遗留）----------
  // 事故原型：智能体把自己排查不充分的结论写成教训 m49「本机 HiGHS 对大稀疏 LP 误报 infeasible」，
  // 而 round1 同环境 19,256 变量 LP 全部 status=0。错误教训入库会污染之后每一轮召回。
  await tAsync('反证检查：同一对象上归因相反的教训被拦下', async () => {
    const appDir2 = fs.mkdtempSync(path.join(os.homedir(), '.xihe-conf-'));
    fs.mkdirSync(path.join(appDir2, 'config'), { recursive: true });
    const c2 = { ...ctx, appDir: appDir2 };
    const call = async (a) => {
      try { const r = await executeTool(c2, 'lesson_record', a); return { ok: true, data: String((r && r.data) || '') }; }
      catch (e) { return { ok: false, error: String(e.message || e) }; }
    };
    const a1 = await call({ situation: 'scipy linprog HiGHS 求解 LP', rule: 'HiGHS 在本机正常工作，19256 变量稀疏 LP 全部 status=0，先查自己的约束装配' });
    if (!a1.ok) throw new Error('首条教训入库失败: ' + a1.error);
    const bad = await call({ situation: 'scipy linprog HiGHS 求解 LP 报 infeasible', rule: '本机 HiGHS 对大稀疏 LP 误报 infeasible，别用 HiGHS' });
    if (bad.ok) throw new Error('相反归因的教训竟然入库');
    // 两道闸按顺序生效：先是"归因类必须附 repro"（更具体），附了 repro 才轮到"与旧条目结论相反"那道
    if (!/归咎环境|反证检查未通过/.test(bad.error)) throw new Error('拒绝理由不对: ' + bad.error.slice(0, 160));
    // 两道闸的报错格式不同（一道用「· m1」列表，一道写进正文），统一按 m\d+ 抓
    const oldId = (bad.error.match(/\bm\d+\b/) || [])[0];
    if (!oldId) throw new Error('报错里没给出冲突条目 id: ' + bad.error.slice(0, 200));
    // memory_write(kind=lesson) 也必须走同一门禁，且 force 没有理由不能绕过。
    const writeCall = async (a) => {
      try { const r = await executeTool(c2, 'memory_write', a); return { ok: true, data: String((r && r.data) || '') }; }
      catch (e) { return { ok: false, error: String(e.message || e) }; }
    };
    const writeBase = { scope: 'persistent', kind: 'lesson', situation: 'scipy linprog HiGHS 求解 LP 报 infeasible', content: '本机 HiGHS 对大稀疏 LP 误报 infeasible，别用 HiGHS', repro: 'linprog(big_sparse) → status=2' };
    const noReason = await writeCall({ ...writeBase, force: true });
    if (noReason.ok || !/reason/.test(noReason.error)) throw new Error('memory_write 的 force 无理由被放行');
    const withReason = await writeCall({ ...writeBase, force: true, reason: '另一环境独立复现，保留两种口径待核' });
    if (!withReason.ok) throw new Error('memory_write force+reason+repro 未放行: ' + withReason.error);
    const forcedRow = mem.loadStore(appDir2).find(e => e.force_reason);
    if (!forcedRow || !forcedRow.repro) throw new Error('force reason 或 repro 未持久化');
    const ok2 = await call({ situation: 'matplotlib 中文方块', rule: 'rc 里直接列具体字体名，别写通用族 serif' });
    if (!ok2.ok) throw new Error('无关教训被误拦: ' + ok2.error);
    // supersedes 让"与旧条目冲突"这一关过，但归咎型还得带 repro——两道闸各管一段，不互相顶掉
    const noReproSup = await call({ situation: 'scipy linprog HiGHS 求解 LP 报 infeasible', rule: '本机 HiGHS 对大稀疏 LP 误报 infeasible', supersedes: oldId });
    if (noReproSup.ok) throw new Error('仅有 supersedes 不该绕过"归咎型要证据"这道闸');
    const sup = await call({ situation: 'scipy linprog HiGHS 求解 LP 报 infeasible', rule: '本机 HiGHS 对大稀疏 LP 误报 infeasible', supersedes: oldId, repro: 'linprog(big_sparse) → status=2；同一脚本换 19256 变量 → status=0' });
    if (!sup.ok) throw new Error('supersedes+repro 未放行: ' + sup.error);
    if (!/superseded/.test(sup.data)) throw new Error('未提示旧条目作废: ' + sup.data);
    const wrongSup = await call({ situation: 'x', rule: '本机 HiGHS 对大稀疏 LP 误报 infeasible', supersedes: 'm999' });
    if (wrongSup.ok) throw new Error('supersedes 指错条目竟然放行');
    // force 管的是"与旧条目冲突"这一关；归咎型仍要 repro（两道闸各管一段）
    const forced = await call({ situation: 'y', rule: '本机 HiGHS 对大稀疏 LP 误报 infeasible', force: true, reason: '另一台机器复现', repro: 'B 机同样脚本 → status=2' });
    if (!forced.ok) throw new Error('force+repro 未放行: ' + forced.error);
    const { recall } = require('./memory');
    const hits = recall(appDir2, 'HiGHS 稀疏 LP', { limit: 6 });
    if (hits.some(e => e.id === oldId)) throw new Error('被 superseded 的旧条目仍被召回');
    fs.rmSync(appDir2, { recursive: true, force: true });
  });

  // ---------- v2.5：技能索引自动刷新（新装/删除/改正文不必重启）----------
  t('技能索引：新装立刻可见、删除立刻消失、正文改动立刻生效', () => {
    const { getIndex, loadSkill } = require('./skills');
    const appRoot = path.resolve(__dirname, '..');
    const dir = path.join(appRoot, 'skills', 'zz-probe-tmp');
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      getIndex(appRoot, true); // 先建一次缓存（模拟浏览器已刷新过）
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: zz-probe-tmp\nmetadata:\n  version: "0.1"\ndescription: 探针\n---\n\n正文 v1\n', 'utf8');
      if (!getIndex(appRoot).some(s => s.name === 'zz-probe-tmp')) throw new Error('新装技能没立刻可见（缓存不失效 → 要重启才看得到）');
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: zz-probe-tmp\nmetadata:\n  version: "9.9"\ndescription: 探针\n---\n\n正文 v2\n', 'utf8');
      const got = loadSkill(appRoot, 'zz-probe-tmp');
      if (!/正文 v2/.test(got.content)) throw new Error('改了正文却读到旧内容');
      if (got.version !== '9.9') throw new Error('版本号读的是缓存: ' + got.version);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    if (getIndex(appRoot).some(s => s.name === 'zz-probe-tmp')) throw new Error('删除技能后仍在索引里');
  });

  // ---------- v2.5：经验库条数上限可配（默认 5000）----------
  t('经验库：条数上限可配，超限按 hits/时间淘汰且 lesson 优先保', () => {
    const M = require('./memory');
    const before = M.maxEntries();
    try {
      M.setMaxEntries(10);
      const d = fs.mkdtempSync(path.join(os.homedir(), '.xihe-cap-'));
      fs.mkdirSync(path.join(d, 'config'), { recursive: true });
      for (let i = 0; i < 14; i++) M.addEntry(d, { kind: 'memory', text: '第' + i + '条', tags: [], situation: 's' });
      if (M.loadStore(d).length !== 10) throw new Error('未按上限裁剪: ' + M.loadStore(d).length);
      M.setMaxEntries(3);
      for (let i = 0; i < 3; i++) M.addEntry(d, { kind: 'lesson', text: '重要教训' + i, tags: [], situation: 's' });
      const kept = M.loadStore(d);
      if (kept.length !== 3) throw new Error('第二次裁剪不对: ' + kept.length);
      if (!kept.every(e => e.kind === 'lesson')) throw new Error('lesson 未被优先保：' + kept.map(e => e.kind).join(','));
      M.setMaxEntries(999999);
      if (M.maxEntries() !== 50000) throw new Error('上限越界未收敛: ' + M.maxEntries());
      fs.rmSync(d, { recursive: true, force: true });
    } finally { M.setMaxEntries(before); }
  });

  // ---------- v2.5：归因类教训的证据门槛 + 经验库体检 ----------
  await tAsync('归因类教训：无复现证据被拒，附 repro 才放行', async () => {
    const appDir3 = fs.mkdtempSync(path.join(os.homedir(), '.xihe-aud-'));
    fs.mkdirSync(path.join(appDir3, 'config'), { recursive: true });
    const c3 = { ...ctx, appDir: appDir3 };
    const call = async (a) => {
      try { const r = await executeTool(c3, 'lesson_record', a); return { ok: true, data: String((r && r.data) || '') }; }
      catch (e) { return { ok: false, error: String(e.message || e) }; }
    };
    const bare = await call({ situation: 'result_align 处理中文工作表名', rule: 'result_align 对中文 sheet 名会误报，别用它' });
    if (bare.ok) throw new Error('归因类且无 repro 竟然入库');
    if (!/归咎环境|最小复现/.test(bare.error)) throw new Error('拒绝理由不对: ' + bare.error.slice(0, 120));
    const okRepro = await call({ situation: 'result_align 处理中文工作表名', rule: 'result_align 对中文 sheet 名会误报', repro: 'result_align({result_path:"r.xlsx",template_path:"t.xlsx"}) → 报 sheet1 缺 计划购电量' });
    if (!okRepro.ok) throw new Error('带 repro 仍未放行: ' + okRepro.error);
    const saved = mem.loadStore(appDir3).find(e => /result_align/.test(e.text) && e.repro);
    if (!saved || !/计划购电量/.test(saved.repro)) throw new Error('repro 只用于放行但没有持久化');
    fs.rmSync(appDir3, { recursive: true, force: true });
  });

  await tAsync('体检：报出归因条目并给出同工具正向线索，retire/revive/delete 生效', async () => {
    const appDir4 = fs.mkdtempSync(path.join(os.homedir(), '.xihe-aud2-'));
    fs.mkdirSync(path.join(appDir4, 'config'), { recursive: true });
    const c4 = { ...ctx, appDir: appDir4 };
    const call = async (name, a) => {
      try { const r = await executeTool(c4, name, a); return { ok: true, data: String((r && r.data) || '') }; }
      catch (e) { return { ok: false, error: String(e.message || e) }; }
    };
    // 先入一条"证实正常"的，再入一条带 repro 的"归因"条目（同工具 scipy/linprog）
    await call('lesson_record', { situation: 'scipy linprog 求解 LP', rule: 'scipy 的 linprog 在本机正常工作，19256 变量稀疏 LP 全部 status=0', repro: 'linprog(...) → status=0' });
    const blameRec = await call('lesson_record', { situation: 'scipy linprog 处理大稀疏 LP', rule: '本机 scipy linprog 对大稀疏 LP 误报 infeasible，别用它', repro: 'linprog(big_sparse) → status=2' });
    if (!blameRec.ok) throw new Error('带 repro 的归因条目未入库: ' + blameRec.error);
    const scan = await call('memory_audit', { op: 'scan' });
    if (!scan.ok) throw new Error('体检失败: ' + scan.error);
    if (!/归咎型教训 1 条/.test(scan.data)) throw new Error('未报出归因条目: ' + scan.data.slice(0, 200));
    if (!/复核线索/.test(scan.data)) throw new Error('未给出同工具正向线索（m49↔m50 形状未复现）: ' + scan.data.slice(0, 300));
    // 软退休后不再被召回
    const id = (scan.data.match(/·\s*(m\d+)/) || [])[1];
    const ret = await call('memory_audit', { op: 'retire', id, reason: '复现条件不成立' });
    if (!ret.ok) throw new Error('retire 失败: ' + ret.error);
    const { recall, loadStore } = require('./memory');
    if (recall(appDir4, 'scipy linprog 稀疏 LP', { limit: 8 }).some(e => e.id === id)) throw new Error('退休后仍被召回');
    // 撤销退休
    const rev = await call('memory_audit', { op: 'revive', id });
    if (!rev.ok) throw new Error('revive 失败: ' + rev.error);
    if (!recall(appDir4, 'scipy linprog 稀疏 LP', { limit: 8 }).some(e => e.id === id)) throw new Error('撤销退休后应重新参与召回');
    // 硬删 + 备份
    const del = await call('memory_audit', { op: 'delete', id });
    if (!del.ok) throw new Error('delete 失败: ' + del.error);
    if (loadStore(appDir4).some(e => e.id === id)) throw new Error('删除后仍在库里');
    const trash = fs.readdirSync(path.join(appDir4, 'data', 'trash')).filter(f => f.includes(id));
    if (!trash.length) throw new Error('删除未留备份（体检也可能判错，必须留后路）');
    fs.rmSync(appDir4, { recursive: true, force: true });
  });
}

(async () => {
  try { await runAsync(); } catch (e) { fail++; console.log('FAIL async-runner ->', e.message); }
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
