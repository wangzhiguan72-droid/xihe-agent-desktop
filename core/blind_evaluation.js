'use strict';
// Custodian-side preparation for a whole-problem comparison. This module never
// runs a model or certifies that a problem, execution, or reviewer is independent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARMS = ['original', 'skill', 'plugin'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const id = () => crypto.randomBytes(12).toString('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
function relativeFile(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)
      || rel.split(/[\\/]/).some(seg => seg === '..' || !seg)) throw new Error('文件须为目录内普通相对路径');
  const base = fs.realpathSync(root), full = path.resolve(base, rel);
  if (!inside(base, full)) throw new Error('文件路径越界');
  let part = base;
  for (const seg of path.relative(base, full).split(path.sep)) {
    part = path.join(part, seg);
    if (fs.lstatSync(part).isSymbolicLink()) throw new Error('文件路径含链接');
  }
  const real = fs.realpathSync(full);
  if (!inside(base, real) || !fs.statSync(real).isFile()) throw new Error('文件不在目录内或不是普通文件');
  return { abs: real, rel: path.relative(base, full).replace(/\\/g, '/') };
}
function sourceList(source, label, required = true) {
  if (!source || typeof source.root !== 'string' || !Array.isArray(source.files)
      || source.files.length > 200 || (required && !source.files.length)) throw new Error(label + '须列明文件和根目录');
  const rows = source.files.map(file => {
    const { abs, rel } = relativeFile(source.root, file), bytes = fs.readFileSync(abs);
    if (bytes.length > 50_000_000) throw new Error(label + '单文件超过50MB');
    return { abs, rel, sha256: sha(bytes), bytes: bytes.length };
  });
  if (new Set(rows.map(row => row.rel.toLowerCase())).size !== rows.length
      || rows.reduce((n, row) => n + row.bytes, 0) > 200_000_000) throw new Error(label + '文件重复或总体超过200MB');
  return rows;
}
function validateProtocol(p) {
  if (!p || typeof p.model !== 'string' || !p.model.trim() || typeof p.contest_package !== 'string' || !p.contest_package.trim()) throw new Error('协议须固定底模和赛事包');
  for (const key of ['wall_time_ms', 'tool_call_limit']) if (!Number.isSafeInteger(p[key]) || p[key] < 1) throw new Error(key + ' 须为正整数');
  if (typeof p.cost_limit !== 'number' || !Number.isFinite(p.cost_limit) || p.cost_limit <= 0) throw new Error('cost_limit 须为正数');
  if (!Number.isSafeInteger(p.reviewers_per_paper) || p.reviewers_per_paper < 2 || p.reviewers_per_paper > 10) throw new Error('每份稿件须安排至少两位独立评阅者');
  return { model: p.model, contest_package: p.contest_package, wall_time_ms: p.wall_time_ms,
    tool_call_limit: p.tool_call_limit, cost_limit: p.cost_limit, reviewers_per_paper: p.reviewers_per_paper };
}
function checkArm(kind, row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { status: 'unavailable', reason: '未提供运行版本清单' };
  if (typeof row.runtime_manifest !== 'string' || !fs.existsSync(row.runtime_manifest)) return { status: 'unavailable', reason: '缺少实际运行版本清单' };
  const manifest = fs.statSync(row.runtime_manifest).isFile() ? row.runtime_manifest : null;
  if (!manifest) return { status: 'unavailable', reason: '运行版本清单不是文件' };
  if (kind === 'original' && row.baseline_origin !== 'pre-change-archive') return { status: 'unavailable', reason: '原版须提供改动前的可复现归档及来源声明' };
  if ((kind === 'skill' || kind === 'plugin') && (typeof row.plan_lock !== 'string' || !fs.existsSync(row.plan_lock))) return { status: 'unavailable', reason: '缺少固定的项目方案版本' };
  if (kind === 'plugin' && (typeof row.plugin_manifest !== 'string' || !fs.existsSync(row.plugin_manifest))) return { status: 'unavailable', reason: '缺少可执行插件版本清单' };
  if (typeof row.solver_id !== 'string' || !row.solver_id.trim()) return { status: 'unavailable', reason: '缺少执行者标识' };
  const fingerprint = file => {
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('版本清单不能是链接/目录');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 2_000_000) throw new Error('版本清单超过2MB');
    return sha(bytes);
  };
  return { status: 'ready', solver_id: row.solver_id, runtime_path: path.resolve(manifest), runtime_sha256: fingerprint(manifest),
    ...(row.plan_lock ? { plan_path: path.resolve(row.plan_lock), plan_sha256: fingerprint(row.plan_lock) } : {}),
    ...(row.plugin_manifest ? { plugin_path: path.resolve(row.plugin_manifest), plugin_sha256: fingerprint(row.plugin_manifest) } : {}),
    ...(kind === 'original' ? { baseline_origin: row.baseline_origin } : {}) };
}
function copyFixed(row, target) {
  const output = path.join(target, row.rel);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const before = fs.readFileSync(row.abs);
  if (before.length !== row.bytes || sha(before) !== row.sha256) throw new Error('封存源文件在复制前改变：' + row.rel);
  fs.writeFileSync(output, before, { flag: 'wx' });
  if (sha(fs.readFileSync(output)) !== row.sha256) throw new Error('封存复制内容不一致：' + row.rel);
}
function prepare(args) {
  if (!args || typeof args.root !== 'string' || typeof args.case_id !== 'string' || !/^[A-Za-z0-9_-]{3,80}$/.test(args.case_id)
      || !['rehearsal', 'sealed'].includes(args.mode)) throw new Error('准备参数须含新目录、case_id及mode');
  const destination = path.resolve(args.root);
  if (fs.existsSync(destination)) throw new Error('封存目标目录必须全新，禁止覆盖');
  const visible = sourceList(args.visible, '可见材料');
  const hidden = sourceList(args.hidden, '隐藏材料', args.mode === 'sealed');
  const seen = new Set(visible.map(row => row.abs.toLowerCase()));
  if (hidden.some(row => seen.has(row.abs.toLowerCase()))) throw new Error('隐藏材料与可见材料重叠');
  for (const row of [...visible, ...hidden]) if (inside(destination, row.abs) || row.abs === destination) throw new Error('源文件不得位于封存目标内');
  const protocol = validateProtocol(args.protocol);
  const arms = Object.fromEntries(ARMS.map(kind => [kind, checkArm(kind, args.arms?.[kind])]));
  if (args.mode === 'sealed' && ARMS.some(kind => arms[kind].status !== 'ready')) throw new Error('正式封存须同时准备原版、Skill版和插件版：' + ARMS.filter(kind => arms[kind].status !== 'ready').join('、'));
  fs.mkdirSync(destination, { recursive: false });
  const visibleDir = path.join(destination, 'custodian', 'visible');
  const hiddenDir = path.join(destination, 'custodian', 'hidden');
  fs.mkdirSync(visibleDir, { recursive: true }); fs.mkdirSync(hiddenDir, { recursive: true });
  for (const row of visible) copyFixed(row, visibleDir);
  for (const row of hidden) copyFixed(row, hiddenDir);
  for (const kind of ARMS) if (arms[kind].status === 'ready') {
    for (const label of ['runtime', 'plan', 'plugin']) {
      const source = arms[kind][label + '_path'];
      if (!source) continue;
      const target = path.join(destination, 'custodian', 'versions', kind, label + '.manifest');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = fs.readFileSync(source);
      if (sha(bytes) !== arms[kind][label + '_sha256']) throw new Error('运行版本文件在封存期间变化');
      fs.writeFileSync(target, bytes, { flag: 'wx' });
    }
  }
  const state = { schema_version: 1, case_id: args.case_id, mode: args.mode, created_at: Date.now(),
    protocol, visible: visible.map(({ rel, sha256, bytes }) => ({ rel, sha256, bytes })),
    hidden: hidden.map(({ rel, sha256, bytes }) => ({ rel, sha256, bytes })),
    arms, allocations: {}, submissions: {}, reviews: {} };
  fs.writeFileSync(path.join(destination, 'custodian', 'state.json'), JSON.stringify(state, null, 2), { flag: 'wx' });
  return report(destination);
}
function stateAt(root) {
  const base = fs.realpathSync(root);
  const file = path.join(base, 'custodian', 'state.json');
  if (!fs.statSync(file).isFile()) throw new Error('封存账本不存在');
  const state = read(file);
  if (state.schema_version !== 1 || !/^[A-Za-z0-9_-]{3,80}$/.test(state.case_id || '')) throw new Error('封存账本损坏');
  return { root: base, file, state, digest: sha(fs.readFileSync(file)) };
}
function save(entry) {
  const { root, file, state } = entry;
  const fresh = stateAt(root).state;
  if (fresh.created_at !== state.created_at || sha(fs.readFileSync(file)) !== entry.digest) throw new Error('封存账本已变化');
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}
function validateVisible(entry) {
  const issues = [];
  for (const row of entry.state.visible) {
    try {
      const p = relativeFile(path.join(entry.root, 'custodian', 'visible'), row.rel);
      const bytes = fs.readFileSync(p.abs);
      if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) issues.push('可见材料已改变：' + row.rel);
    } catch { issues.push('可见材料丢失：' + row.rel); }
  }
  for (const row of entry.state.hidden) {
    try {
      const p = relativeFile(path.join(entry.root, 'custodian', 'hidden'), row.rel);
      const bytes = fs.readFileSync(p.abs);
      if (bytes.length !== row.bytes || sha(bytes) !== row.sha256) issues.push('隐藏材料已改变：' + row.rel);
    } catch { issues.push('隐藏材料丢失：' + row.rel); }
  }
  return issues;
}
function allocate(root, arm) {
  const entry = stateAt(root), { state } = entry;
  if (!ARMS.includes(arm) || state.arms[arm]?.status !== 'ready') throw new Error('比较组不可用');
  if (state.allocations[arm]) throw new Error('该组已分配工作区');
  if (validateVisible(entry).length) throw new Error('封存材料已变化，不能分配');
  const anon = 'P' + id().toUpperCase();
  const dir = path.join(entry.root, 'solvers', arm + '-' + id());
  fs.mkdirSync(dir, { recursive: true });
  for (const row of state.visible) {
    const src = relativeFile(path.join(entry.root, 'custodian', 'visible'), row.rel);
    copyFixed({ ...row, abs: src.abs }, dir);
  }
  const allocation = { anon, workspace: path.relative(entry.root, dir).replace(/\\/g, '/'), at: Date.now() };
  state.allocations[arm] = allocation;
  save(entry);
  return { workspace: dir, visible_sha256: sha(JSON.stringify(state.visible)),
    protocol: state.protocol, runtime_sha256: state.arms[arm].runtime_sha256,
    plan_sha256: state.arms[arm].plan_sha256 || null, plugin_sha256: state.arms[arm].plugin_sha256 || null };
}
function submit(root, arm, submission) {
  const entry = stateAt(root), { state } = entry;
  const allocation = state.allocations[arm];
  if (!allocation || state.submissions[arm]) throw new Error('该组未分配或已提交');
  const work = path.join(entry.root, allocation.workspace);
  const files = {};
  for (const key of ['pdf', 'source', 'result', 'execution_log']) {
    if (typeof submission?.[key] !== 'string') throw new Error('提交须含PDF、源码、机器结果与执行日志');
    const p = relativeFile(work, submission[key]), bytes = fs.readFileSync(p.abs);
    files[key] = { rel: p.rel, sha256: sha(bytes), bytes: bytes.length };
  }
  if (!/\.pdf$/i.test(files.pdf.rel) || fs.readFileSync(path.join(work, files.pdf.rel)).subarray(0, 5).toString() !== '%PDF-') throw new Error('论文须为PDF文件');
  if (!/\.(py|m|r|jl)$/i.test(files.source.rel) || !/\.(json|csv|xlsx)$/i.test(files.result.rel)) throw new Error('源码或机器结果类型不符合');
  const usage = submission.usage;
  if (!usage || !Number.isSafeInteger(usage.wall_time_ms) || usage.wall_time_ms < 0
      || !Number.isSafeInteger(usage.tool_calls) || usage.tool_calls < 0
      || typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost < 0) throw new Error('用量须登记时间、调用及费用');
  const over = usage.wall_time_ms > state.protocol.wall_time_ms || usage.tool_calls > state.protocol.tool_call_limit || usage.cost > state.protocol.cost_limit;
  const packetDir = path.join(entry.root, 'review_packets'); fs.mkdirSync(packetDir, { recursive: true });
  const packet = path.join(packetDir, allocation.anon + '.pdf');
  fs.copyFileSync(path.join(work, files.pdf.rel), packet, fs.constants.COPYFILE_EXCL);
  const saved = { anon: allocation.anon, files, usage, budget_overrun: over, packet_sha256: sha(fs.readFileSync(packet)), at: Date.now(), execution_verified: false };
  state.submissions[arm] = saved;
  save(entry);
  return { anon: allocation.anon, packet, packet_sha256: saved.packet_sha256, budget_overrun: over, execution_verified: false };
}
function review(root, anon, row) {
  const entry = stateAt(root), { state } = entry;
  const arm = ARMS.find(kind => state.submissions[kind]?.anon === anon);
  if (!arm) throw new Error('匿名论文编号不存在');
  if (!row || typeof row.reviewer_id !== 'string' || !row.reviewer_id.trim() || ARMS.some(kind => row.reviewer_id === state.arms[kind].solver_id)
      || row.reviewer_kind !== 'human') throw new Error('评阅须登记独立人工评阅者');
  const allowed = ['pass', 'fail', 'unknown'];
  if (!row.hard || ['constraints', 'numerical', 'reproducibility'].some(key => !allowed.includes(row.hard[key]))) throw new Error('硬约束、数值和复现判断缺失');
  if (!row.paper || ['coverage', 'model', 'innovation', 'boundary', 'communication'].some(key => !Number.isSafeInteger(row.paper[key]) || row.paper[key] < 0 || row.paper[key] > 5)) throw new Error('论文五维评分须为0至5整数');
  if (typeof row.notes !== 'string' || !row.notes.trim()) throw new Error('评阅须记录证据说明');
  const existing = state.reviews[anon] || [];
  if (existing.some(r => r.reviewer_id === row.reviewer_id)) throw new Error('同一评阅者不能重复评分');
  existing.push({ reviewer_id: row.reviewer_id, reviewer_kind: row.reviewer_kind, hard: row.hard, paper: row.paper,
    notes: row.notes.slice(0, 4000), at: Date.now(), independence_verified: false });
  state.reviews[anon] = existing;
  save(entry);
  return { anon, reviews: existing.length, independence_verified: false };
}
function reviewSummary(reviews, expected) {
  const hard = Object.fromEntries(['constraints', 'numerical', 'reproducibility'].map(key => {
    const counts = { pass: 0, fail: 0, unknown: 0 };
    for (const row of reviews) counts[row.hard[key]]++;
    return [key, counts];
  }));
  const paper = Object.fromEntries(['coverage', 'model', 'innovation', 'boundary', 'communication'].map(key => {
    const values = reviews.map(row => row.paper[key]);
    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    return [key, { mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      min, max, disagreement: values.length > 1 && min !== max }];
  }));
  const complete = reviews.length >= expected;
  const hardDisagreement = Object.values(hard).some(row => [row.pass, row.fail, row.unknown].filter(n => n > 0).length > 1);
  return { status: !reviews.length ? 'missing' : complete ? 'raw_attested_unverified' : 'partial',
    recorded: reviews.length, expected, hard_checks_clear: complete && Object.values(hard).every(row => row.pass === reviews.length),
    hard, paper, reviewer_disagreement: hardDisagreement || Object.values(paper).some(row => row.disagreement),
    valid_ranking: false, note: '仅汇总录入的评阅记录；身份、执行和论文质量未由程序独立验证。' };
}
function report(root) {
  const entry = stateAt(root), { state } = entry;
  const issues = validateVisible(entry);
  for (const kind of ARMS) if (state.arms[kind].status === 'ready') for (const label of ['runtime', 'plan', 'plugin']) {
    const arm = state.arms[kind];
    if (!arm[label + '_path']) continue;
    for (const [source, file] of [['原版本', arm[label + '_path']], ['封存版本', path.join(entry.root, 'custodian', 'versions', kind, label + '.manifest')]]) {
      try { if (sha(fs.readFileSync(file)) !== arm[label + '_sha256']) issues.push(kind + ' ' + label + ' ' + source + '已改变'); }
      catch { issues.push(kind + ' ' + label + ' ' + source + '丢失'); }
    }
  }
  const rows = ARMS.map(kind => {
    const arm = state.arms[kind], allocation = state.allocations[kind], submission = state.submissions[kind];
    const reviews = submission ? state.reviews[submission.anon] || [] : [];
    const summary = reviewSummary(reviews, state.protocol.reviewers_per_paper);
    const stale = [];
    if (allocation) for (const file of state.visible) {
      try {
        const current = relativeFile(path.join(entry.root, allocation.workspace), file.rel);
        // Visible inputs may be copied or modified by a solver. Actual modifications
        // invalidate comparisons until explicitly adjudicated by the custodian.
        if (sha(fs.readFileSync(current.abs)) !== file.sha256) stale.push('求解可见材料已改变：' + file.rel);
      } catch { stale.push('求解可见材料丢失：' + file.rel); }
    }
    if (submission) {
      for (const file of Object.values(submission.files)) {
        try { if (sha(fs.readFileSync(relativeFile(path.join(entry.root, allocation.workspace), file.rel).abs)) !== file.sha256) stale.push('交付文件已变化：' + file.rel); }
        catch { stale.push('交付文件丢失：' + file.rel); }
      }
      try { if (sha(fs.readFileSync(path.join(entry.root, 'review_packets', submission.anon + '.pdf'))) !== submission.packet_sha256) stale.push('匿名PDF包已变化'); }
      catch { stale.push('匿名PDF包丢失'); }
    }
    return { arm: kind, status: arm.status !== 'ready' ? 'unavailable' : !allocation ? 'not_started'
      : !submission ? 'allocated' : stale.length ? 'stale' : submission.budget_overrun ? 'over_budget'
      : reviews.length < state.protocol.reviewers_per_paper ? 'review_pending'
      : Object.values(summary.hard).some(counts => counts.fail > 0) ? 'hard_failed'
      : Object.values(summary.hard).some(counts => counts.unknown > 0) ? 'hard_unknown'
      : 'review_recorded_unverified',
    reason: arm.reason || null, anon: submission?.anon || null, files: submission?.files || null,
    usage: submission?.usage || null, reviews: reviews.length, review_summary: summary, issues: stale };
  });
  const incomplete = issues.length || rows.some(row => row.status !== 'review_recorded_unverified');
  return { mode: state.mode, case_id: state.case_id, status: state.mode === 'rehearsal' ? 'rehearsal'
    : incomplete ? 'needs_input' : 'review_recorded_unverified',
  blind_evaluation: false, execution_verified: false, reviewer_independence_verified: false,
  evidence: { visible: state.visible, hidden_file_count: state.hidden.length, protocol: state.protocol },
  arms: rows, issues, limitations: [
    '工具固定文件和协议，不运行底模或确认执行日志的真实性。',
    '评阅者身份与独立性是登记信息，须由封存材料持有人独立核验。',
    '当前报告不认证真正的封存盲评，人工揭盲和独立评分须在外部确认。',
  ] };
}

module.exports = { prepare, allocate, submit, review, report };
