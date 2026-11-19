// 螺旋创新层（v2.5，交接清单 X-0 / I-1…I-10 落地）
// —— 比赛时钟与阶段：从赛事包读取计时策略与阶段规则
//    （通用包不采用任何已知赛事的赛程或格式约定）
// —— 假设登记表 A-id：内容与类型/来源/必要性/证据/敏感性/可辨识性/替代方案/影响范围/状态
// —— 迭代记录 I-id：预登记判据（先写后跑，判据不可改）→ 结果 → 采纳/撤回
// —— 基线快照：每圈开始前存 snapshots/iter_N/，撤回时可恢复
//
// 注入位置：与 stateBlock/modeBlock 同层（最后一条 user 消息），不动 system 前缀（DeepSeek 前缀缓存）。
'use strict';
const fs = require('fs');
const path = require('path');

// ---------- 比赛时钟（I-1）----------
// 赛事时钟的自动阶段比例由当前包声明；通用包不预设比例。
const PHASE_ORDER = ['baseline', 'iterate', 'freeze', 'final'];
const PHASE_LABEL = {
  baseline: '已验证基线（读题 → 各问跑通并 commit → 论文可编译）',
  iterate: '假设迭代（螺旋：审计高风险假设 → 预登记 → 对照实验 → 采纳/撤回）',
  freeze: '冻结与总验证（禁探索性换模型 → 最终集成版本验证 → 论文整合）',
  final: '交付收尾（逐页渲染检查 → 支撑包与 AI 详情 → 冻结确认）',
};
// 全自动默认最多 3 圈（用户 2026-09-27 拍板），每圈有花费上限
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_ROUND_BUDGET_CNY = 8;

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

// 由截止时间推导的"时间阶段"（不含 agent 主动声明的 final）
function timePhase(session, now) {
  const ratios = require('./contest_workflows').packageFor(session).workflow.clock.ratios;
  if (!ratios) return null;
  const dl = num(session && session.contest_deadline, 0);
  // 开赛时间缺失时退回会话创建时间（contest_start 允许为 0）
  const st = session && session.contest_start != null ? Number(session.contest_start) : num(session && session.createdAt, 0);
  if (!dl || !Number.isFinite(st) || dl <= st) return null;
  const frac = (now - st) / (dl - st);
  if (frac < ratios.baseline) return 'baseline';
  if (frac < ratios.iterate) return 'iterate';
  return 'freeze';
}

// 显式推进可覆盖计时下限；解冻窗口由赛事包声明。
function effectivePhase(session, now = Date.now()) {
  const declared = PHASE_ORDER.includes(session && session.contest_phase) ? session.contest_phase : null;
  const derived = timePhase(session, now);
  if (!derived) return declared || 'baseline';
  if (!declared) return derived;
  const di = PHASE_ORDER.indexOf(declared), si = PHASE_ORDER.indexOf(derived);
  if (di >= si) return declared;
  const at = num(session.contest_phase_at, 0);
  const dl = num(session.contest_deadline, 0), st = num(session.contest_start, 0);
  const ratio = require('./contest_workflows').packageFor(session).workflow.clock.unfreeze_ratio || 0;
  const windowMs = dl > st ? (dl - st) * ratio : 0;
  return (at && now - at < windowMs) ? declared : derived;
}

// 时钟摘要（stateBlock 用，一行）
function clockLine(session, now = Date.now()) {
  const dl = num(session && session.contest_deadline, 0);
  const st = session && session.contest_start != null ? Number(session.contest_start) : num(session && session.createdAt, 0);
  const phase = effectivePhase(session, now);
  if (!dl || !Number.isFinite(st) || dl <= st) return `阶段 ${phase}（未设截止时间——自行按题目截止把握，或用 contest_clock 重设）`;
  const totalH = (dl - st) / 3.6e6, leftH = Math.max(0, (dl - now) / 3.6e6);
  const frac = Math.min(1, Math.max(0, (now - st) / (dl - st)));
  const rounds = iterationStats(session);
  const cap = session.contest_max_rounds || DEFAULT_MAX_ROUNDS;
  const frozen = session.freeze && session.freeze.at ? '，已冻结' : '';
  return `${leftH.toFixed(1)}h/${totalH.toFixed(1)}h（${(frac * 100).toFixed(0)}% 已用）· 阶段 ${phase}=${PHASE_LABEL[phase]}${frozen}`
    + ` · 迭代圈 ${rounds.rounds}/${cap}（采纳${rounds.adopted} 撤回${rounds.withdrawn} 未决${rounds.undecided}）`;
}

// 阶段文案、参考材料与计时策略都由赛事包声明。
// 返回该阶段该读的参考材料清单（只列磁盘上真实存在的）。返回 '' = 无可用参考。
function referenceIndex(session, appDir, phase) {
  if (!appDir) return '';
  const workflow = require('./contest_workflows').packageFor(session).workflow;
  if (!workflow.reference_routes_enabled) return '';
  const route = (workflow.reference_routes || {})[phase] || [];
  const base = workflow.reference_base || [];
  const rows = [];
  for (const [file, dir, when] of route) {
    const rel = [...base, dir, file].join('/');
    const abs = require('path').join(appDir, ...base, ...dir.split('/'), file);
    let ok = false; try { ok = require('fs').statSync(abs).isFile(); } catch { ok = false; }
    if (ok) rows.push(`  · ${rel}\n    何时读：${when}`);
  }
  if (!rows.length) return '';
  const loaded = (session && session.ref_loaded) || {};
  const mark = (r) => { const rel = r.split('\n')[0].trim().slice(2); return loaded[rel] ? '✓' : ' '; };
  return `【参考材料·按需读】不是全都要读，卡住/开始新环节时读对应的那份（fs_read 直接打开，路径是相对项目根的）。`
    + `读完用 fs_read 的返回内容作答，别凭印象写。\n`
    + rows.map(r => `${mark(r)}${r.split('\n')[0]}\n    ${r.split('\n')[1].replace('    何时读：', '什么时候读：')}`).join('\n')
    + `\n（✓ = 本会话已读过；摘要相关材料只有 freeze/final 阶段列出来，先按需取。）`;
}

function phaseBlock(session, now = Date.now(), appDir = null) {
  if (!session || session.mode !== 'math') return '';
  if (!session.contest) return ''; // 普通数模会话不注入比赛阶段规则（避免打扰）
  const phase = effectivePhase(session, now);
  const head = `【比赛时钟】${clockLine(session, now)}`;
  const refs = referenceIndex(session, appDir, phase);
  return head + '\n' + require('./contest_workflows').phaseGuidance(phase, session) + (refs ? '\n\n' + refs : '');
}

// ---------- 假设登记表（I-3）----------
const ASSUMPTION_KINDS = ['given_fact', 'pending_interpretation', 'model_simplification', 'parameter_estimate', 'implementation_error'];
const KIND_LABEL = {
  given_fact: '题给事实/硬约束', pending_interpretation: '待定解释', model_simplification: '模型简化',
  parameter_estimate: '参数估计', implementation_error: '实现错误',
};
// 题给事实与硬约束不能作为迭代靶子（题目硬约束不得改成便于获胜的假设）
const IMMUTABLE_KINDS = new Set(['given_fact']);

function assumptionList(session) { return (session && session.assumptions) || []; }

function upsertAssumption(session, a) {
  session.assumptions = session.assumptions || [];
  const list = session.assumptions;
  const text = String(a.text || '').trim();
  if (!text) throw new Error('text 必填：假设内容');
  const kind = ASSUMPTION_KINDS.includes(a.kind) ? a.kind : 'model_simplification';
  const id = String(a.id || '').trim().toUpperCase();
  const nextNum = () => 'A' + (1 + list.reduce((mx, x) => Math.max(mx, parseInt(String(x.id).replace(/\D/g, '')) || 0), 0));
  const rec = {
    id: id || nextNum(),
    text: text.slice(0, 400),
    kind,
    source: String(a.source || '').slice(0, 120),
    necessity: String(a.necessity || '').slice(0, 200),
    evidence: String(a.evidence || '').slice(0, 300),
    sensitivity: String(a.sensitivity || '').slice(0, 200),
    identifiability: String(a.identifiability || '').slice(0, 200),
    alternatives: String(a.alternatives || '').slice(0, 300),
    impact: String(a.impact || '').slice(0, 300),
    questions: Array.isArray(a.questions) ? a.questions.map(x => Number(x)).filter(Number.isInteger) : (a.questions ? [Number(a.questions)].filter(Number.isInteger) : []),
    risk: ['high', 'med', 'low'].includes(a.risk) ? a.risk : 'med',
    status: ['open', 'supported', 'refuted', 'frozen'].includes(a.status) ? a.status : 'open',
    at: Date.now(),
  };
  const i = list.findIndex(x => x.id === rec.id);
  if (i >= 0) { list[i] = Object.assign({}, list[i], rec); return { id: rec.id, updated: true, rec: list[i] }; }
  list.push(rec);
  if (list.length > 60) list.shift();
  return { id: rec.id, updated: false, rec };
}

function assumptionBlock(session) {
  const list = assumptionList(session);
  if (!list.length) return '';
  return list.map(x => `[${x.id}·${KIND_LABEL[x.kind] || x.kind}·risk=${x.risk}·${x.status}] ${x.text.slice(0, 120)}`
    + (x.impact ? `（影响:${x.impact.slice(0, 60)}）` : '')).join('\n');
}

// ---------- 迭代记录（I-4）+ 快照（I-5）----------
function iterationList(session) { return (session && session.iterations) || []; }

function iterationStats(session) {
  const list = iterationList(session);
  const rounds = list.filter(x => x.status !== 'planned').length;
  return {
    total: list.length, rounds,
    planned: list.filter(x => x.status === 'planned').length,
    adopted: list.filter(x => x.status === 'adopted').length,
    withdrawn: list.filter(x => x.status === 'withdrawn').length,
    undecided: list.filter(x => x.status === 'undecided').length,
  };
}

function nextIterId(session) {
  const list = iterationList(session);
  return 'I' + (1 + list.reduce((mx, x) => Math.max(mx, parseInt(String(x.id).replace(/\D/g, '')) || 0), 0));
}

// 快照：把结果/发现/论文/脚本复制到 snapshots/<label>/（撤回时恢复）
const SNAP_INCLUDE = [
  { glob: 'root', exts: ['.xlsx', '.csv', '.json'] },   // 工作区根的结果文件
  { dir: 'results' }, { dir: 'outputs' }, { dir: 'findings' }, { dir: 'paper' }, { dir: 'scripts' }, { dir: 'figures' },
];
const SNAP_MAX_BYTES = 400 * 1024 * 1024;

function snapshotDir(root, label) {
  return path.join(root, 'snapshots', String(label).replace(/[^\w.-]/g, '_').slice(0, 40) || 'iter');
}

function takeSnapshot(root, label, note) {
  const dst = snapshotDir(root, label);
  fs.mkdirSync(dst, { recursive: true });
  let bytes = 0, files = 0;
  const copy = (src, rel) => {
    let st; try { st = fs.statSync(src); } catch { return; }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(src)) copy(path.join(src, e), path.posix.join(rel, e));
      return;
    }
    if (!st.isFile() || bytes + st.size > SNAP_MAX_BYTES) return;
    const d = path.join(dst, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    try { fs.copyFileSync(src, d); bytes += st.size; files++; } catch {}
  };
  for (const inc of SNAP_INCLUDE) {
    if (inc.dir) { const p = path.join(root, inc.dir); if (fs.existsSync(p)) copy(p, inc.dir); }
    else {
      let ents = []; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch {}
      for (const e of ents) {
        if (!e.isFile()) continue;
        if (!inc.exts.includes(path.extname(e.name).toLowerCase())) continue;
        if (/^snapshots?$/i.test(e.name)) continue;
        copy(path.join(root, e.name), e.name);
      }
    }
  }
  fs.writeFileSync(path.join(dst, '_snapshot.json'), JSON.stringify({ label, note: note || '', at: Date.now(), files, bytes }, null, 2), 'utf8');
  return { dir: dst, rel: path.relative(root, dst).replace(/\\/g, '/'), files, bytes, label, note: note || '', at: Date.now() };
}

function listSnapshots(root) {
  const base = path.join(root, 'snapshots');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let meta = { label: e.name, files: null, bytes: null, at: null, note: '' };
    try { meta = Object.assign(meta, JSON.parse(fs.readFileSync(path.join(base, e.name, '_snapshot.json'), 'utf8'))); } catch {}
    out.push(Object.assign(meta, { path: path.posix.join('snapshots', e.name) }));
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

// 恢复：只覆盖快照里存在的文件（清掉快照之后新增的产出文件用 restore_delete）
// label 既接受干净名字（iter_1，落在 snapshots/ 下），也接受 snapshots/iter_1 这类工作区相对路径
function restoreSnapshot(root, label, opts = {}) {
  const raw = String(label);
  const looksPathed = /[\\/]/.test(raw);
  const dir = path.isAbsolute(raw) ? raw : (looksPathed ? path.join(root, raw) : snapshotDir(root, raw));
  if (!fs.existsSync(dir)) throw new Error(`快照不存在: ${label}（用 contest_clock({op:"snapshots"}) 列出现有快照）`);
  const copied = [];
  const walk = (src, rel) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), r = rel ? path.posix.join(rel, e.name) : e.name;
      if (e.isDirectory()) { walk(s, r); continue; }
      if (e.name === '_snapshot.json') continue;
      const d = path.join(root, r);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      try { fs.copyFileSync(s, d); copied.push(r); } catch {}
    }
  };
  walk(dir, '');
  return { dir, copied: copied.length, files: copied };
}

module.exports = {
  PHASE_ORDER, PHASE_LABEL, DEFAULT_MAX_ROUNDS, DEFAULT_ROUND_BUDGET_CNY,
  effectivePhase, timePhase, clockLine, phaseBlock,
  ASSUMPTION_KINDS, KIND_LABEL, IMMUTABLE_KINDS, upsertAssumption, assumptionList, assumptionBlock,
  iterationList, iterationStats, nextIterId,
  takeSnapshot, listSnapshots, restoreSnapshot, snapshotDir,
};
