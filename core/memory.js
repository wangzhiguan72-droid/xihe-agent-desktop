// 羲和经验库（Reflexion + 跨会话持久记忆，纯 Node 零依赖）：
// - 存储：data/memory/store.jsonl，一行一条经验，全部会话共享，重启/压缩不丢。
// - 两类条目：kind='memory'（偏好/结论/路径等事实）与 kind='lesson'（教训：situation+rule）。
// - 召回：关键词打分（拉丁词整词 + 中文二元组），lesson 加权；tool_fail/boost 命中场景加权。
// - 去重：text 归一化指纹重复时更新旧条目（hit/时间）而不是堆第二条。
'use strict';
const fs = require('fs');
const path = require('path');

const STORE_NAME = path.join('data', 'memory', 'store.jsonl');
const GLOBAL_PROJECT = 'GLOBAL';
const PROJECT_ONLY_RE = /(项目铁律|本项目|仅适用于.{0,12}项目|不得跨项目|勿跨项目)/i;
// 条数上限：超出按 (hits 升序, 最旧) 挤掉，lesson 优先保（比同 hits 的 memory 更不容易被淘汰）。
// 默认 5000——实测 2200 条 571 KB、召回 13 ms，5000 条约 1.4 MB / 30 ms，对单用户完全无压力。
// 真正决定召回质量的不是条数而是 situation 写得好不好（关键词命中靠它），所以宁可放宽条数、
// 把功夫花在写清场景上（memory_audit 会把缺 situation 的条目列出来）。
const DEFAULT_MAX_ENTRIES = 5000;
let maxEntriesOverride = 0;
function setMaxEntries(n) { maxEntriesOverride = Number(n) > 0 ? Math.min(Number(n), 50000) : 0; }
function maxEntries() { return maxEntriesOverride || DEFAULT_MAX_ENTRIES; }

function storePath(appDir) { return path.join(appDir, STORE_NAME); }

function entryRole(role) {
  if (role == null || role === '') return null;
  const normalized = require('./model_roles').normalizeRole(role);
  if (!normalized) throw new Error('invalid memory role');
  return normalized;
}

function sameScope(a, b) {
  return (a.project || null) === (b.project || null) && (a.role || null) === (b.role || null);
}

// Role-less historical records remain shared; private records require the matching role.
function isVisible(e, opts = {}) {
  if (e.superseded || (opts.kind && e.kind !== opts.kind)) return false;
  if (e.role && e.role !== opts.role) return false;
  if (opts.project && e.kind !== 'lesson' && e.project !== GLOBAL_PROJECT && e.project !== opts.project) return false;
  if (opts.project && !e.project && PROJECT_ONLY_RE.test(String(e.text || '') + ' ' + String(e.situation || ''))) return false;
  return true;
}

function isAuditVisible(e, opts = {}) {
  return (!e.role || e.role === opts.role)
    && (!opts.project || !e.project || e.project === GLOBAL_PROJECT || e.project === opts.project);
}

function loadStore(appDir) {
  const p = storePath(appDir);
  const out = [];
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { const e = JSON.parse(t); if (e && e.id && e.text) out.push(e); } catch {}
    }
  } catch {}
  return out;
}

function saveStore(appDir, entries) {
  const p = storePath(appDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

// 归一化指纹：大小写/空白/标点不敏感，用于"同一条经验别存两遍"
function fingerprint(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[，。！？；：、""''（）【】《》]/g, '').trim();
}

function nextId(entries) {
  let mx = 0;
  for (const e of entries) { const n = parseInt(String(e.id).replace(/\D/g, '')) || 0; if (n > mx) mx = n; }
  return 'm' + (mx + 1);
}

// 中文二元组 + 拉丁整词：对 "od e15s 收敛" 这类混合查询稳；
// 单元字不单独算（噪声大），中文按滑窗 bigram，>=2 字词也整词进索引
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const m of s.matchAll(/[a-z0-9_]+/g)) out.add(m[0]);
  for (const m of s.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    if (run.length === 1) { out.add(run); continue; }
    out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return [...out].filter(x => x.length >= 2 || /[一-鿿]/.test(x));
}

// appends one entry; returns {entry, updated} —— 指纹重复即更新（合并 tags/hit++），不新增
function addEntry(appDir, { kind = 'memory', text, tags = [], situation = '', source = 'agent', project = null, role = null, repro = '', forceReason = '' }) {
  text = String(text || '').trim().slice(0, 1200);
  if (!text) throw new Error('内容为空');
  if (!['memory', 'lesson'].includes(kind)) kind = 'memory';
  project = project ? String(project).slice(0, 48) : null;
  role = entryRole(role);
  const entries = loadStore(appDir);
  const fp = fingerprint(text);
  const now = Date.now();
  const dup = entries.find(e => e.kind === kind && sameScope(e, { project, role }) && (e.fp === fp || fingerprint(e.text) === fp));
  if (dup) {
    dup.hits = (dup.hits || 0) + 1;
    dup.at = now;
    dup.kind = kind;
    if (situation && !dup.situation) dup.situation = String(situation).slice(0, 300);
    dup.tags = [...new Set([...(dup.tags || []), ...tags.map(String)])].slice(0, 12);
    dup.source = dup.source || source;
    if (project) dup.project = String(project).slice(0, 48);
    if (String(repro || '').trim()) dup.repro = String(repro).trim().slice(0, 1200);
    if (String(forceReason || '').trim()) dup.force_reason = String(forceReason).trim().slice(0, 300);
    saveStore(appDir, entries);
    return { entry: dup, updated: true };
  }
  const e = {
    id: nextId(entries), kind, text, fp,
    tags: tags.map(String).slice(0, 12),
    situation: String(situation || '').slice(0, 300),
    source: String(source || 'agent').slice(0, 60),
    at: now, hits: 0,
    // 来源项目：项目专属约定（主语言、口径）只该在本项目生效（v2.4 V-26：2026A 的「MATLAB 主解」污染了华数杯项目）
    ...(project ? { project: String(project).slice(0, 48) } : {}),
    ...(role ? { role } : {}),
    ...(String(repro || '').trim() ? { repro: String(repro).trim().slice(0, 1200) } : {}),
    ...(String(forceReason || '').trim() ? { force_reason: String(forceReason).trim().slice(0, 300) } : {}),
  };
  entries.push(e);
  // 超帽淘汰：lesson 优先保，memory 按 (hits 升序, at 升序) 淘汰
  const cap = maxEntries();
  if (entries.length > cap) {
    entries.sort((a, b) =>
      (a.kind === 'lesson' ? 1 : 0) - (b.kind === 'lesson' ? 1 : 0)
      || (a.hits || 0) - (b.hits || 0) || a.at - b.at);
    entries.splice(0, entries.length - cap);
  }
  saveStore(appDir, entries);
  return { entry: e, updated: false };
}

function removeEntry(appDir, id) {
  const entries = loadStore(appDir);
  const i = entries.findIndex(e => e.id === id);
  if (i < 0) return false;
  entries.splice(i, 1);
  saveStore(appDir, entries);
  return true;
}

// ---------- 经验库体检（任务做完能查错、把错的剔除）----------
// 动机：错误教训会污染之后每一轮召回（例如把一次配置问题写成「该求解器误报不可行」）。
// 入库时的反证检查只能拦"与已知条目明显相反"的；**任务结束后统一体检**才能发现
// "当时证据不足、后来被自己推翻"的条目。这份报告按危险度排序，人工/模型逐条裁决：
//   contradict 互相矛盾 → blame 归咎环境（最易错）→ weak 信息不足 → stale 从未命中 → retired 已退休
function auditStore(appDir, opts = {}) {
  const entries = loadStore(appDir).filter(e => isAuditVisible(e, opts));
  const now = Date.now();
  const staleDays = Number(opts.staleDays) || 30;
  const active = entries.filter(e => !e.superseded);
  const report = { total: entries.length, active: active.length, blame: [], weak: [], stale: [], retired: [], unscoped: [] };

  // 1) 互相矛盾：**只认一种形状**——同一工具/命令上，一条说它"不行/误报/不支持"，另一条说它"正常/可用/通过"。
  //    为什么不做通用语义矛盾检测：我用"共享词 + 极性相反"试过两版，在真实的 50 条库上分别报出 18 对和 10 对
  //    **全是误报**（"别猜 run_id" 与 "先确认是同一问题" 这种被强行判成相反）。中文语义矛盾靠正则判不可靠，
  //    而体检报告满屏噪音比不报更糟（真矛盾会被淹掉）。所以收紧到唯一有实证的形状：「某工具误报不可行」
  //    对「该工具求解正常」——**工具名相同 + 一边归咎一边证实 + 一边有复现证据一边没有**。
  const TOOLISH = /(python_run|shell_run|job_start|job_status|link_run|question_graph|contract_register|formula_register|fs_write|fs_edit|fs_read|fs_delete|rollback_artifact|spreadsheet_diff|result_align|reconcile_artifact|vision_read|web_search|web_fetch|kb_search|paper_build|flowchart_draw|dispatch_child|subagent_run|matlab|python|scipy|numpy|pandas|matplotlib|hi?ghs|linprog|ode15s|ode45|pdepe|xelatex|drawio|pymupdf|fitz|openpyxl)/gi;
  const lessons = active.filter(e => e.kind === 'lesson');
  const toolsOf = (e) => [...new Set((String(e.text || '') + ' ' + String(e.situation || '')).match(TOOLISH) || [])].map(t => t.toLowerCase());
  const blames = lessons.filter(e => BLAME_RE.test(e.text + ' ' + (e.situation || '')));
  const affirms = lessons.filter(e => AFFIRM_RE.test(e.text + ' ' + (e.situation || '')));
  // 2) 归因类教训（归咎环境的同型）：最该被复核的一类
  for (const e of active) {
    if (e.kind === 'lesson' && BLAME_RE.test(e.text + ' ' + (e.situation || ''))) {
      // 附"同工具上另有断言正常的教训"作为**复核线索**（不作矛盾判定——工具相同 ≠ 条件相同：
      // 「并发会崩」与「串行求解正常」并不矛盾，是适用条件不同）。让模型/人自己判。
      const tb = new Set(toolsOf(e));
      const peers = tb.size ? affirms.filter(g => g.id !== e.id && toolsOf(g).some(t => tb.has(t))).slice(0, 3) : [];
      report.blame.push({ id: e.id, text: e.text.slice(0, 140), repro: e.repro || null, at: e.at, peers: peers.map(g => ({ id: g.id, text: g.text.slice(0, 100) })) });
    }
  }
  // 3) 信息不足：lesson 没有 situation（召回靠关键词，没有场景几乎命中不了）
  for (const e of active) {
    if (e.kind === 'lesson' && (!e.situation || e.situation.trim().length < 6)) report.weak.push({ id: e.id, text: e.text.slice(0, 120) });
  }
  // 4) 从未命中且很久没碰过：低价值候选（不自动删，列出来让人决定）
  for (const e of active) {
    if (!(e.hits > 0) && (now - (e.at || 0)) > staleDays * 864e5) report.stale.push({ id: e.id, kind: e.kind, days: Math.round((now - e.at) / 864e5), text: e.text.slice(0, 120) });
  }
  // 5) 已退休残留：确认无误就可以从库里清掉（superseded_by 指向的替代条目仍在）
  for (const e of entries) {
    if (e.superseded) report.retired.push({ id: e.id, by: e.superseded_by || null, reason: e.superseded_reason || null, text: e.text.slice(0, 110) });
  }
  // 6) 未标项目：v2.4 之前的历史条目与显式 GLOBAL 不能混为一谈。
  // memory 在项目会话中默认隔离；lesson 仍可跨项目降权迁移，但应在审计里可见。
  for (const e of active) {
    if (!e.project) report.unscoped.push({ id: e.id, kind: e.kind, text: e.text.slice(0, 120) });
  }
  return report;
}

// 软退休：保留记录但不再被召回（比硬删安全，能追溯"为什么这条不用了"）
function retireEntry(appDir, id, reason) {
  const entries = loadStore(appDir);
  const e = entries.find(x => x.id === id);
  if (!e) return null;
  e.superseded = true;
  e.superseded_reason = String(reason || '任务收尾体检：证据不足/已被推翻').slice(0, 300);
  e.at = Date.now();
  saveStore(appDir, entries);
  return e;
}

// 撤销退休（体检判错了可以恢复）
function reviveEntry(appDir, id) {
  const entries = loadStore(appDir);
  const e = entries.find(x => x.id === id);
  if (!e) return null;
  delete e.superseded; delete e.superseded_by; delete e.superseded_reason;
  e.at = Date.now();
  saveStore(appDir, entries);
  return e;
}

function markGlobal(appDir, id, reason) {
  const entries = loadStore(appDir);
  const e = entries.find(x => x.id === id);
  if (!e) return null;
  e.project = GLOBAL_PROJECT;
  e.global_reason = String(reason || '人工确认：适用于所有项目').slice(0, 300);
  e.at = Date.now();
  saveStore(appDir, entries);
  return e;
}

// v2.3.4 minor 修复 2：superseded 字段——标记"已被新教训/修复取代的旧经验"
// 召回时跳过 superseded=true 的条目；superseded_by 字段记录指向哪个新 id
// 场景：v2.3.3 修了 m34（run_id 回显）后，旧 m25「link_run 不可达」就该标记 superseded
function supersede(appDir, oldId, newId) {
  const entries = loadStore(appDir);
  const old = entries.find(e => e.id === oldId);
  const newer = entries.find(e => e.id === newId);
  if (!old || !newer || old.id === newer.id || !sameScope(old, newer)) return false;
  old.superseded = true;
  old.superseded_by = newId;
  old.at = Date.now(); // 让 supersede 也触碰 at，方便排查
  saveStore(appDir, entries);
  return true;
}

// ---------- 入库前反证检查 ----------
// 事故原型：一次建模任务的 LP 报不可行，排查时写成「求解器对大稀疏 LP 误报 infeasible」；
// 同一环境下的另一组 LP 却全部正常，该归因根本不成立。**错误教训
// 入库比不入库更糟**：之后每一轮召回都会把它当既有事实。这里在入库前扫同类旧条目，发现"同一对象
// 上归咎方向相反"就拦下来，逼调用方二选一：显式 supersede 旧条目，或带理由强制入库（留痕）。
// 注意只收**归因结论**（"这东西坏了/不能用"），不收**症状词**（崩溃/报错/挂了）——
// 症状是观察，教训里描述崩溃并给出正确做法（如"重型运行要串行，否则 MemoryError"）是好教训，
// 不是归咎。第一版把 崩溃? 写进去，结果 m30/m36 这类正确教训被误判成"归咎环境"。
const BLAME_RE = /(误报|不支持|不兼容|有\s*bug|环境问题|本机.{0,8}(不行|失效|坏|有问题)|版本.{0,6}(缺陷|问题)|不能用|跑不了|不可行是.{0,6}(环境|工具)|工具.{0,6}(有问题|缺陷|靠不住))/i;
const AFFIRM_RE = /(正常|可用|能用|可用性|通过|没问题|有效|可靠|应当|推荐|优先|成功)/;
const NEG_RE = /(别|不要|不应|不能|禁止|避免|切勿|勿)/;
// 中文停用碎片：出现在几乎所有教训里，不能作为"同一对象"的证据
const STOP_TOKENS = new Set(['问题', '环境', '工具', '教训', '下次', '出现', '导致', '一个', '这个', '那个', '如果', '因为', '所以', '就是', '可以', '需要', '时候', '结果', '直接']);

function polarity(text) {
  const t = String(text || '');
  if (BLAME_RE.test(t)) return -1;        // 归咎环境/工具不可用
  if (AFFIRM_RE.test(t)) return +1;       // 断言可用/正常/推荐
  if (NEG_RE.test(t)) return -1;          // 纯禁令也是"负面方向"
  return 0;
}

// 返回与 candidate 可能互相矛盾的既有条目（同对象 + 极性相反 + 共享 ≥2 个有区分力的词）
function findConflicts(appDir, candidate, opts = {}) {
  const text = typeof candidate === 'string' ? candidate : String((candidate && candidate.text) || '');
  const situation = typeof candidate === 'string' ? '' : String((candidate && candidate.situation) || '');
  const mine = polarity(text + ' ' + situation);
  if (!mine) return [];
  const myToks = new Set(tokens(text + ' ' + situation).filter(t => !STOP_TOKENS.has(t)));
  const out = [];
  for (const e of loadStore(appDir)) {
    if (e.superseded) continue;
    const scope = typeof candidate === 'object' && candidate ? candidate : opts;
    if (!sameScope(e, scope)) continue;
    if (opts.skipIds && opts.skipIds.includes(e.id)) continue;
    const theirs = polarity(e.text + ' ' + (e.situation || ''));
    if (!theirs || theirs === mine) continue;       // 同向不构成反证
    const shared = [...new Set(tokens(e.text + ' ' + (e.situation || '')).filter(t => myToks.has(t) && !STOP_TOKENS.has(t)))];
    if (shared.length < 2) continue;
    out.push({ id: e.id, kind: e.kind, text: e.text.slice(0, 220), situation: (e.situation || '').slice(0, 120), polarity: theirs, shared: shared.slice(0, 6) });
  }
  return out.sort((a, b) => b.shared.length - a.shared.length).slice(0, 3);
}

// 建议对象（供调用方在报错里给出可直接用的 supersede 参数）
function supersedeByName(appDir, oldId, newId) { return supersede(appDir, oldId, newId); }

// 打分召回。opts.kind 限定 'lesson'/'memory'；opts.toolFail = 失败工具名（命中场景加权）
function recall(appDir, query, opts = {}) {
  const entries = loadStore(appDir);
  if (!entries.length) return [];
  const qToks = tokens(query);
  const toolFail = String(opts.toolFail || '').toLowerCase();
  const now = Date.now();
  const scored = [];
  for (const e of entries) {
    if (!isVisible(e, opts)) continue;
    const hay = [e.text, e.situation || '', (e.tags || []).join(' '), e.source || ''].join('\n');
    const eToks = tokens(hay);
    let score = 0;
    const hits = [];
    for (const t of qToks) {
      if (eToks.includes(t)) {
        // 整词/长词权重大于二元组碎片
        score += t.length >= 3 ? 3 : 2;
        if (hits.length < 6) hits.push(t);
      } else if (hay.toLowerCase().includes(t)) {
        score += 1; // 子串兜底（bigram 拆碎后整词仍能中）
      }
    }
    if (!score) continue;
    if (e.kind === 'lesson') score *= 1.4;
    if (opts.project && e.kind === 'lesson' && e.project && e.project !== GLOBAL_PROJECT && e.project !== opts.project) score *= 0.35;
    if (toolFail && (e.situation || '').toLowerCase().includes(toolFail)) score *= 1.8;
    score += Math.min(2, (e.hits || 0) * 0.3);              // 被反复命中的经验更可靠
    score += Math.max(0, 1.5 - (now - e.at) / (30 * 864e5)); // 30 天内的轻微新鲜度加权
    scored.push({ e, score, hits });
  }
  scored.sort((a, b) => b.score - a.score || b.e.at - a.e.at);
  return scored.slice(0, opts.limit || 6).map(x => x.e);
}

// 命中计数回写（召回被实际展示时才计，避免检索试探刷 hits）
function markHit(appDir, ids) {
  if (!ids || !ids.length) return;
  const entries = loadStore(appDir);
  const set = new Set(ids);
  let dirty = false;
  for (const e of entries) if (set.has(e.id)) { e.hits = (e.hits || 0) + 1; dirty = true; }
  if (dirty) saveStore(appDir, entries);
}

function stats(appDir) {
  const entries = loadStore(appDir);
  return {
    total: entries.length,
    memory: entries.filter(e => e.kind !== 'lesson').length,
    lessons: entries.filter(e => e.kind === 'lesson').length,
  };
}

// 注入文本（stateBlock / 轮首召回共用格式）
function formatEntries(entries, header) {
  if (!entries.length) return '';
  const lines = entries.map(e => {
    const tag = e.kind === 'lesson' ? '教训' : '记忆';
    const sit = e.situation ? `（场景:${e.situation}）` : '';
    const proj = e.project === GLOBAL_PROJECT ? '〔全局共享〕'
      : e.project ? `〔来自项目 ${e.project}，项目专属约定勿跨项目套用〕` : '〔未标项目〕';
    return `- [${e.id}·${tag}]${proj}${e.role ? `〔角色 ${e.role} 专属〕` : '〔角色共享〕'}${sit} ${e.text}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

module.exports = { GLOBAL_PROJECT, addEntry, removeEntry, setMaxEntries, maxEntries, recall, isVisible, isAuditVisible, markHit, stats, loadStore, saveStore, formatEntries, tokens, fingerprint, supersede, findConflicts, polarity, auditStore, retireEntry, reviveEntry, markGlobal, BLAME_RE };
