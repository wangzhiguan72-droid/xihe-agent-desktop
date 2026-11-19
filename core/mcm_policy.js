'use strict';
// COMAP-specific submission checks. Every assertion is scoped to a confirmed edition.
const crypto = require('crypto');
const fs = require('fs'), path = require('path');
const SOURCE_2027 = 'https://www.contest.comap.com/undergraduate/contests/mcm/instructions.php';
const AI_POLICY = 'https://www.contest.comap.com/undergraduate/contests/mcm/flyer/Contest_AI_Policy.pdf';
const AI_TITLES = ['Report on Use of AI', 'Report on Use of AI Tools'];
const official2027 = session => String(session?.contest_identity?.edition || '') === '2027'
  && session?.contest_rules?.profile === 'mcm-icm-2027'
  && typeof session?.contest_rules?.source === 'string' && !!session.contest_rules.source.trim();
const normal = s => String(s || '').replace(/\s+/g, ' ').trim();
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripComments = tex => String(tex || '').split(/\r?\n/).map(line => line.replace(/(^|[^\\])%.*$/, '$1')).join('\n');
const warning = msg => '【必须修】' + msg;
const heading = (all, name) => all.find(x => normal(x.text).replace(/^\d+[.\s]+/, '') === name);

function expandedTex(tex, options) {
  const initial = stripComments(tex);
  if (!/\\(?:input|include)\s*\{/.test(initial)) return initial;
  if (!options.root || !options.texPath) throw new Error('含子文件的稿件缺工作区/主稿路径，无法核验章节先后');
  const root = fs.realpathSync(options.root);
  const inside = file => {
    const rel = path.relative(root, file);
    return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  const main = path.resolve(root, options.texPath);
  if (!inside(main) || !inside(fs.realpathSync(main))) throw new Error('主稿越出工作区');
  let count = 0, total = 0;
  const expand = (source, current, stack) => source.replace(/\\(?:input|include)\s*\{([^}]+)\}/g, (_, named) => {
    const name = named.trim();
    if (!name || name.includes('\0') || path.isAbsolute(name) || /[{}\\]/.test(name)) throw new Error('子稿路径必须为静态相对TeX路径');
    const target = path.resolve(path.dirname(current), /\.tex$/i.test(name) ? name : name + '.tex');
    if (!inside(target) || !fs.existsSync(target) || !inside(fs.realpathSync(target))) throw new Error('子稿不存在或越出工作区：' + name);
    if (stack.includes(target)) throw new Error('子稿循环引用：' + name);
    if (++count > 30) throw new Error('子稿超过30个');
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 1_000_000 || (total += stat.size) > 2_000_000) throw new Error('子稿过大或非文本文件');
    return expand(stripComments(fs.readFileSync(target, 'utf8')), target, [...stack, target]);
  });
  return expand(initial, main, [main]);
}

function validateProblemDeliverables(value, identity = {}) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error('problem_deliverables 须为最多12项的数组');
  const seen = new Set();
  return value.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !['letter', 'memo'].includes(item.kind)
        || typeof item.problem_id !== 'string' || !/^[A-F]$/i.test(item.problem_id)
        || typeof item.heading !== 'string' || !/^[\w ,.'()&/-]{5,120}$/.test(item.heading)
        || !item.source || typeof item.source !== 'object' || typeof item.source.url !== 'string'
        || !/^https:\/\/(?:www\.)?contest\.comap\.com\//i.test(item.source.url)
        || !Number.isSafeInteger(item.source.page) || item.source.page < 1 || item.source.page > 50
        || !Number.isSafeInteger(item.min_pages) || item.min_pages < 1 || item.min_pages > 25
        || !Number.isSafeInteger(item.max_pages) || item.max_pages < item.min_pages || item.max_pages > 25) {
      throw new Error(`problem_deliverables[${i}] 需kind、题号、英文标题、COMAP题面URL/页码和合理的页数范围`);
    }
    const key = `${item.problem_id}:${item.heading}`;
    if (seen.has(key)) throw new Error('problem_deliverables 重复登记');
    seen.add(key);
    if (identity.track && /^[A-F]$/i.test(identity.track) && item.problem_id.toUpperCase() !== identity.track.toUpperCase()) {
      throw new Error('题面额外交付物题号与项目赛题不一致');
    }
    const sourceYear = item.source.url.match(/\/contests\/(20\d{2})\//)?.[1];
    if (sourceYear && /^20\d{2}$/.test(String(identity.edition || '')) && sourceYear !== identity.edition) {
      throw new Error('题面额外交付物来源年份与项目届次不一致');
    }
    return { kind: item.kind, problem_id: item.problem_id.toUpperCase(), heading: item.heading,
      source: { url: item.source.url, page: item.source.page }, min_pages: item.min_pages, max_pages: item.max_pages };
  });
}

function auditPaper(tex, options = {}) {
  const session = options.session || {};
  const rules = session.contest_rules || {};
  const issues = [];
  let T;
  try { T = expandedTex(tex, options); }
  catch (error) {
    issues.push(warning('美赛稿件章节依赖无法核验：' + error.message));
    T = stripComments(tex);
  }
  const pdf = options.pdf || null;
  const facts = pdf?.mcm;
  const known = official2027(session);
  const required = rules.problem_deliverables || [];
  if (!known) issues.push('【规则待核对】MCM/ICM 当前届次尚未绑定已核实的 2027 profile；该版式不能认证为当前年份官方合规。');
  if (!pdf || pdf.error || !facts || !Number.isSafeInteger(pdf.pages)) {
    issues.push(warning('美赛英文 PDF 尚未完成逐页实测；不能确认 Summary Sheet、页数、页眉和 AI 报告位置。'));
    return issues;
  }

  if (!known) {
    // User-supplied problem deliverables can still be checked without claiming 2027 general rules.
    return [...issues, ...problemDeliverableIssues(required, session, T, pdf)];
  }
  if (!Number.isSafeInteger(rules.max_body_pages) || rules.max_body_pages > 25
      || !Number.isSafeInteger(rules.max_file_bytes) || rules.max_file_bytes > 24999999) {
    issues.push(warning('2027 MCM/ICM 已核条款须登记 25 页和严格小于 25 MB 的文件上限。'));
  }

  if (!/\\documentclass\s*\[[^\]]*\b(?:1[2-9]|[2-9]\d)pt\b[^\]]*\]\s*\{(?:article|report|memoir|scrartcl)\}/.test(T)) {
    issues.push(warning('英语论文须明确使用至少 12pt 的正文模板；当前源码未显示受支持的 12pt 文档类。'));
  }
  if (facts.undersized_text?.length) issues.push(warning('PDF 存在小于 12pt 的可读正文：' + facts.undersized_text.slice(0, 4).map(x => `第${x.page}页 ${x.size}pt`).join('、')));
  const title = facts.headings.filter(h => normal(h.text) === 'Summary Sheet');
  if (!title.some(h => h.page === 1) || title.some(h => h.page > 1)) issues.push(warning('单页英文 Summary Sheet 必须是 PDF 第 1 页。'));
  const summarySource = T.match(/\\section\*?\{Summary Sheet\}/);
  const firstMain = summarySource && [...T.slice(summarySource.index + summarySource[0].length).matchAll(/\\section\*?\{([^}]+)\}/g)]
    .find(m => !AI_TITLES.includes(m[1]) && m[1] !== 'References');
  if (!summarySource || !firstMain || !/\\begin\{abstract\}/.test(T.slice(summarySource.index, summarySource.index + summarySource[0].length + firstMain.index))) {
    issues.push(warning('稿件缺明确 Summary Sheet、摘要正文或之后的主报告章节。'));
  } else {
    const firstTitle = normal(firstMain[1]);
    const mainPage = heading(facts.headings, firstTitle)?.page;
    if (mainPage !== 2) issues.push(warning('摘要页未单独占第 1 页，或主报告没有从第 2 页开始；请逐页核对溢出与分页。'));
  }
  const edition = String(session.contest_identity.edition);
  if (!new RegExp(`\\b${esc(edition)}\\b`).test(String(facts.first_page_text || ''))) {
    issues.push(warning(`Summary Sheet 第 1 页未显示已核届次 ${edition}。`));
  }
  const control = String(session.contest_identity?.control_number || '');
  if (!/^\d{5,12}$/.test(control)) issues.push(warning('赛事档案尚未登记有效团队控制号；不得使用模板占位值提交。'));
  const headerPages = facts.headers || [];
  for (let i = 0; i < pdf.pages; i++) {
    const head = normal(headerPages[i]);
    if (!control || !head.includes(control) || !new RegExp(`\\b(?:Page\\s*)?${i + 1}\\b`).test(head)) {
      issues.push(warning(`PDF 第 ${i + 1} 页页眉缺对应团队控制号和页码。`));
      break;
    }
  }
  if (/\\author\s*\{\s*[^}\s][^}]*\}|\\thanks\b/.test(T)) issues.push(warning('源码包含作者/致谢身份字段；MCM/ICM 论文仅保留团队控制号。'));
  if (/(?:TO[_\\]VERIFY|PLACEHOLDER|INSERT HERE)/i.test(T)) issues.push(warning('论文仍含未替换的模板占位符。'));

  const reportSections = [...T.matchAll(/\\section\*?\{(Report on Use of AI(?: Tools)?)\}/g)];
  const reportHeadings = facts.headings.filter(h => AI_TITLES.includes(normal(h.text)));
  let reportPage = null;
  if (reportSections.length !== 1 || reportHeadings.length !== 1) issues.push(warning('在同一 PDF 文末缺单独的 Report on Use of AI / Report on Use of AI Tools 章节，或出现了多个。'));
  else {
    const source = reportSections[0], rendered = reportHeadings[0];
    reportPage = rendered.page;
    const after = T.slice(source.index + source[0].length);
    if (/\\section\*?\{/.test(after)) issues.push(warning('AI 使用报告之后仍有主报告章节；报告必须在同一 PDF 最末。'));
    const refBefore = /\\section\*?\{References\}|\\begin\{thebibliography\}/.test(T.slice(0, source.index));
    if (!refBefore) issues.push(warning('AI 使用报告应置于参考文献之后。'));
    if (rendered.text !== source[1]) issues.push(warning('PDF 中的 AI 报告标题与稿件源码不一致。'));
  }
  const counted = reportPage == null ? pdf.pages : reportPage - 1 + (reportHeadings[0]?.prior_body ? 1 : 0);
  if (counted > Math.min(25, rules.max_body_pages || 25)) issues.push(warning(`摘要、正文、参考文献、附录及题面额外交付物共 ${counted} 页，超出 2027 MCM/ICM 的 ${Math.min(25, rules.max_body_pages || 25)} 页上限。`));
  if (!reportPage && pdf.pages > 25) issues.push(warning(`无法从总计 ${pdf.pages} 页中扣除无有效边界的 AI 报告页。`));
  if (Number.isSafeInteger(options.pdfBytes) && options.pdfBytes > Math.min(24999999, rules.max_file_bytes || 24999999)) issues.push(warning('提交 PDF 不得达到或超过 25 MB（或已登记的更严上限）。'));
  if (!Number.isSafeInteger(options.pdfBytes)) issues.push(warning('PDF 文件大小未实测。'));
  if (!/\\cite(?:\[[^\]]*\])?\{[^}]+\}/.test(T.slice(0, reportSections[0]?.index ?? T.length))
      || !/\\(?:section\*?\{References\}|begin\{thebibliography\})/.test(T)) {
    issues.push(warning('正文缺来源引用或参考文献；AI 工具用途和外部来源应在文中与文末真实披露。'));
  }
  issues.push(...problemDeliverableIssues(required, session, T, pdf, counted));
  issues.push('【人工核验】正文英语、团队匿名、AI 使用真实性与引文准确性仍需参赛队逐项复核。');
  return [...new Set(issues)];
}

function problemDeliverableIssues(requirements, session, tex, pdf, countedPages = pdf.pages) {
  const issues = [];
  let rows;
  try { rows = validateProblemDeliverables(requirements, session.contest_identity || {}); }
  catch (e) { return [warning('题面额外交付物登记无效：' + e.message)]; }
  const headings = pdf.mcm?.headings || [];
  for (const row of rows) {
    const sourceMatch = new RegExp('\\\\section\\*?\\{' + esc(row.heading) + '\\}').test(tex);
    const found = heading(headings, row.heading);
    if (!sourceMatch || !found) { issues.push(warning(`题面要求的 ${row.kind} 未在稿件与 PDF 中找到独立章节：${row.heading}（${row.source.url} 第${row.source.page}页）。`)); continue; }
    if (found.page > countedPages) { issues.push(warning(`${row.kind} 落在 AI 报告的页数豁免区；题面要求的信函/备忘录必须计入 25 页。`)); continue; }
    const next = headings.find(h => h.page >= found.page && h !== found && h.text !== row.heading && h.size >= found.size && h.page <= countedPages);
    const pages = (next?.page || countedPages + 1) - found.page;
    if (pages < row.min_pages || pages > row.max_pages) issues.push(warning(`${row.kind} 实测约 ${pages} 页，不在登记的 ${row.min_pages}–${row.max_pages} 页范围内。`));
  }
  return issues;
}

function policyFingerprint(session) {
  const payload = { edition: session?.contest_identity?.edition, track: session?.contest_identity?.track,
    control: session?.contest_identity?.control_number, profile: session?.contest_rules?.profile,
    deliverables: session?.contest_rules?.problem_deliverables || [] };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

module.exports = { auditPaper, validateProblemDeliverables, official2027, policyFingerprint, SOURCE_2027, AI_POLICY };
