'use strict';
// Jev 校准汇总：零 API 调用，只读本地会话与 audit 快照里的决策留痕。
// 用法: node scripts/jev_calibration.js [--root <应用目录>] [--extra <目录>] [--out <报告.md>]
// 校准对 = judge.ok 且有最终选择的决策；source=human 才是人工金标，system_auto 单独统计。

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = { root: path.resolve(__dirname, '..'), extra: [], out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root') out.root = path.resolve(argv[++i]);
    else if (argv[i] === '--extra') out.extra.push(path.resolve(argv[++i]));
    else if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else throw new Error('未知参数: ' + argv[i]);
  }
  return out;
}

function* walkJson(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      yield* walkJson(p);
    } else if (e.isFile() && e.name.endsWith('.json')) {
      yield p;
    }
  }
}

function loadSession(file) {
  try {
    if (fs.statSync(file).size > 20_000_000) return null;
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && Array.isArray(s.decisions) ? s : null;
  } catch { return null; }
}

const BUCKETS = [[0, 0.7], [0.7, 0.82], [0.82, 0.9], [0.9, 1.0001]];
const bucketOf = c => BUCKETS.findIndex(([lo, hi]) => c >= lo && c < hi);
const bucketLabel = i => `[${BUCKETS[i][0]}, ${BUCKETS[i][1] === 1.0001 ? '1.0]' : BUCKETS[i][1] + ')'}`;

function main() {
  const args = parseArgs(process.argv);
  const seen = new Map();
  const failures = new Map();
  const skips = new Map();
  let filesScanned = 0, sessionFiles = 0, decisionCount = 0, withJudge = 0, judgeOk = 0;

  const dirs = [path.join(args.root, 'data', 'sessions'), path.join(args.root, 'audit'), ...args.extra];
  for (const dir of dirs) {
    for (const file of walkJson(dir)) {
      if (/synthetic/i.test(file)) continue;
      filesScanned++;
      const s = loadSession(file);
      if (!s) continue;
      sessionFiles++;
      for (const d of s.decisions) {
        decisionCount++;
        if (!d.judge) continue;
        withJudge++;
        if (d.judge.ok) judgeOk++;
        else if (d.judge.skipped) skips.set(d.judge.reason || 'unknown', (skips.get(d.judge.reason || 'unknown') || 0) + 1);
        else failures.set(d.judge.error || 'unknown', (failures.get(d.judge.error || 'unknown') || 0) + 1);
        const key = d.decision_id || `${file}:${d.at}:${d.question}`;
        if (!seen.has(key)) seen.set(key, { d, file });
      }
    }
  }

  const pairs = [];
  for (const { d } of seen.values()) {
    if (!d.judge || !d.judge.ok) continue;
    const conf = Number(d.judge.confidence);
    if (!Number.isFinite(conf)) continue;
    const custom = d.status === 'custom' || (!d.chosen_id && d.custom_text);
    pairs.push({
      question: d.question, source: d.source || 'unknown', confidence: conf,
      judgeChoice: d.judge.choice_id, recommended: d.recommended_id,
      chosen: custom ? 'custom' : d.chosen_id,
      agree: !custom && d.judge.choice_id === d.chosen_id,
      agreeWithMain: d.judge.choice_id === d.recommended_id,
      custom, at: d.at,
    });
  }

  const human = pairs.filter(p => p.source === 'human');
  const auto = pairs.filter(p => p.source !== 'human');
  const pct = (n, d) => d ? (100 * n / d).toFixed(1) + '%' : '—';
  const lines = [];
  lines.push(`# Jev 校准汇总（${new Date().toISOString().slice(0, 10)}）`);
  lines.push('');
  lines.push(`扫描：${filesScanned} 个 JSON 文件，${sessionFiles} 个含决策的会话/快照；决策 ${decisionCount} 条（按 decision_id 去重后 ${seen.size} 条）。`);
  lines.push(`带 Jev 记录 ${withJudge} 条：成功 ${judgeOk}，失败 ${[...failures.values()].reduce((a, b) => a + b, 0)}，跳过 ${[...skips.values()].reduce((a, b) => a + b, 0)}。`);
  if (failures.size) lines.push(`失败原因：${[...failures.entries()].map(([k, v]) => `${k} ×${v}`).join('；')}`);
  if (skips.size) lines.push(`跳过原因：${[...skips.entries()].map(([k, v]) => `${k} ×${v}`).join('；')}`);
  lines.push('');

  if (!pairs.length) {
    lines.push('## 结论：没有可用校准对');
    lines.push('');
    lines.push('Jev 没有在任何真实决策上成功返回过判断（或成功记录缺最终选择）。**当前无法评估它是否有用，0.82 门槛没有任何本地证据支撑。**');
    lines.push('先解决调用失败（如 HTTP 402 = 供应商额度/计费问题），让 Jev 在 smart 低风险筛选上真正跑起来，攒到至少 30–50 条人工最终选择后再回看本报告。');
  } else {
    lines.push(`## 校准对：${pairs.length} 条（人工金标 ${human.length}，自动选择 ${auto.length}）`);
    lines.push('');
    lines.push('| 置信度桶 | 人工对数 | Jev=人 | 一致率 | 自动对数 | Jev=自动 |');
    lines.push('|---|---|---|---|---|---|');
    for (let i = 0; i < BUCKETS.length; i++) {
      const h = human.filter(p => bucketOf(p.confidence) === i);
      const a = auto.filter(p => bucketOf(p.confidence) === i);
      lines.push(`| ${bucketLabel(i)} | ${h.length} | ${h.filter(p => p.agree).length} | ${pct(h.filter(p => p.agree).length, h.length)} | ${a.length} | ${a.filter(p => p.agree).length} | ${pct(a.filter(p => p.agree).length, a.length)} |`);
    }
    lines.push('');
    lines.push(`人工金标总体一致率：${pct(human.filter(p => p.agree).length, human.length)}（${human.length} 条）；其中自定义方案 ${human.filter(p => p.custom).length} 条按不一致计。`);
    lines.push(`Jev 与主模型推荐一致率：${pct(pairs.filter(p => p.agreeWithMain).length, pairs.length)}（${pairs.length} 条）。`);
    lines.push('');
    lines.push('## 门槛模拟（选择性放行：置信度≥阈值才采信 Jev）');
    lines.push('');
    lines.push('| 阈值 | 人工覆盖 | 覆盖内一致率 |');
    lines.push('|---|---|---|');
    for (const t of [0.7, 0.8, 0.82, 0.85, 0.9]) {
      const h = human.filter(p => p.confidence >= t);
      lines.push(`| ${t} | ${h.length}/${human.length} | ${pct(h.filter(p => p.agree).length, h.length)} |`);
    }
    lines.push('');
    lines.push('样本量小于 30 时一致率波动极大，只能作方向参考，不能据此冻结阈值。');
    lines.push('');
    lines.push('## 明细');
    lines.push('');
    lines.push('| 时间 | 来源 | 置信度 | Jev | 主模型推荐 | 最终 | 一致 | 问题 |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const p of pairs.sort((a, b) => a.at - b.at)) {
      lines.push(`| ${new Date(p.at).toISOString().slice(0, 16).replace('T', ' ')} | ${p.source} | ${p.confidence.toFixed(2)} | ${p.judgeChoice} | ${p.recommended} | ${p.chosen} | ${p.agree ? '✓' : '✗'} | ${String(p.question).replace(/\|/g, '\\|').slice(0, 60)} |`);
    }
  }

  const report = lines.join('\n') + '\n';
  const outPath = args.out || path.join(args.root, 'audit', `jev-calibration-${new Date().toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log('报告已写入: ' + outPath);
}

main();
