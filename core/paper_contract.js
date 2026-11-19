'use strict';

function withoutComments(source) {
  return String(source || '').replace(/(^|[^\\])%[^\r\n]*/gm, (line, prefix) => prefix + ' '.repeat(line.length - prefix.length));
}

function groupAt(source, start, open = '{', close = '}') {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '\\' && (source[i + 1] === open || source[i + 1] === close)) { i++; continue; }
    if (source[i] === open) depth++;
    if (source[i] === close && --depth === 0) return { content: source.slice(start + 1, i), end: i + 1 };
  }
  return null;
}

function extractBracedCommands(raw, names) {
  const source = withoutComments(raw);
  const allowed = new Set(names);
  const found = [];
  const commands = /\\([A-Za-z]+)\*?/g;
  let match;
  while ((match = commands.exec(source))) {
    if (!allowed.has(match[1])) continue;
    let pos = commands.lastIndex;
    while (/\s/.test(source[pos] || '') && pos < source.length) pos++;
    while (source[pos] === '[') {
      const optional = groupAt(source, pos, '[', ']');
      if (!optional) break;
      pos = optional.end;
      while (/\s/.test(source[pos] || '') && pos < source.length) pos++;
    }
    let group = groupAt(source, pos);
    if (!group) continue;
    if (match[1] === 'inputminted') {
      let next = group.end;
      while (next < source.length && /\s/.test(source[next])) next++;
      group = groupAt(source, next);
      if (!group) continue;
    }
    found.push({ name: match[1], content: group.content, start: match.index, end: group.end });
    commands.lastIndex = group.end;
  }
  return found;
}

function plain(source) {
  return source.replace(/\\%/g, '%').replace(/\\(?:[A-Za-z]+|.)\*?/g, '').replace(/[{}$]/g, '').trim();
}

function keywordList(raw) {
  return plain(raw).split(/[；;、，,]/).map(x => x.trim()).filter(Boolean);
}

function abstractParts(raw) {
  const source = /\\(?:begin\{abstract\}|keywords?\s*\{)/.test(raw) ? withoutComments(raw) : String(raw || '');
  const latex = source.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/i);
  const markdown = source.match(/(?:^|\n)#{1,3}\s*摘\s*要\s*\n([\s\S]*?)(?=\n#{1,3}\s|\n\s*关键词\s*[:：]|$)/i);
  const body = latex ? latex[1] : markdown ? markdown[1] : (/\\(?:keywords?|begin\{thebibliography\})/.test(source) ? '' : source);
  return { source, body, labelled: Boolean(latex || markdown) };
}

function auditAbstractGuidance(raw, { required = false } = {}) {
  const { body, labelled } = abstractParts(raw);
  if (!body.trim()) return required ? ['【必须修】缺少可识别的摘要正文。'] : [];
  if (!labelled && /\\begin\{document\}/.test(body)) return [];
  const parts = plain(body).replace(/\*\*/g, '')
    .split(/[。；;，,\n]|\s+(?=(?:输入|输出)\s*[:：])/);
  const labelledParts = parts
    .map(part => part.trim().match(/^(输入|输出)\s*[:：]\s*(.*)$/))
    .filter(Boolean);
  const barePlaceholders = parts.map(part => part.trim().match(/^(输入|输出)\s*(?:[xｘ]{2,}|什么什么)$/i)).filter(Boolean);
  if (labelledParts.some(([, , value]) => /^(?:[xｘ]{2,}|[?？]{2,}|\.{3,}|…+|待填(?:写)?|待补充|请填写|请填入|占位符|某某|什么什么)$/i.test(value.trim()))
    || new Set(barePlaceholders.map(part => part[1])).size === 2) {
    return ['【必须修】摘要含未填的输入/输出占位模板，请用本题实际方法与结果改写。'];
  }
  if (new Set(labelledParts.map(part => part[1])).size === 2) {
    return ['【待人工核验】摘要使用“输入/输出”标签式提纲，请核对是否完整交代本题约束、方法与结果。'];
  }
  return [];
}

function auditAbstractStyle(raw, { required = true, policy } = {}) {
  policy = policy === undefined ? require('../contest_packages/cumcm/rules.json').quality : policy;
  const { source, body, labelled } = abstractParts(raw);
  if (!body.trim()) return required ? ['【必须修】缺少可识别的摘要正文。'] : [];
  if (!required && !labelled && !/\\keywords?\s*\{/.test(source)) return [];
  const warnings = [];
  const keywordCommand = extractBracedCommands(source, ['keywords', 'keyword'])[0];
  const keywordEnv = source.match(/\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}/i);
  const keywordMd = source.match(/(?:^|\n)\s*关键词\s*[:：]\s*([^\r\n]+)/);
  const keywordLabel = body.match(/\\textbf\{\s*关键词\s*[:：]\s*\}\s*([^\r\n]*)/);
  const keywords = keywordList(keywordCommand ? keywordCommand.content : keywordEnv ? keywordEnv[1] : keywordMd ? keywordMd[1] : keywordLabel ? keywordLabel[1] : '');
  if (Number.isInteger(policy.keywords_min) && Number.isInteger(policy.keywords_max)
      && (keywords.length < policy.keywords_min || keywords.length > policy.keywords_max)) warnings.push(`【必须修】摘要关键词应为${policy.keywords_min}-${policy.keywords_max}个，当前${keywords.length}个。`);
  if (new Set(keywords.map(x => x.toLowerCase())).size !== keywords.length) warnings.push('【必须修】摘要关键词重复。');
  if (keywords.some(x => /^(数学建模|数据分析|优化模型|机器学习|模型|算法)$/.test(x))) warnings.push('【必须修】摘要关键词含泛词，应改为本题具体方法或对象。');

  const latexBold = extractBracedCommands(body, ['textbf', 'bfseries']).map(x => plain(x.content)).filter(x => !/^关键词\s*[:：]?$/.test(x));
  const markdownBold = Array.from(body.matchAll(/\*\*([^*\n]+)\*\*/g), x => x[1].trim());
  const bold = latexBold.concat(markdownBold).filter(Boolean);
  const bodyText = plain(body).replace(/\*\*/g, '').replace(/\s+/g, '');
  warnings.push(...auditAbstractGuidance(raw));
  if (bold.some(x => /首先|其次|值得注意的是|综上所述|然后|最后我们|我们分析|我们研究|本文首先/.test(x))) warnings.push('【必须修】摘要加粗包含过程描述或连接套话。');
  if (bold.some(x => /^(数学建模|数据分析|优化模型|机器学习|模型|算法)$/.test(x))) warnings.push('【必须修】摘要加粗包含空泛模型名或泛词。');
  if (bold.some(x => x.length > 70 || (x.length > 24 && x.length > bodyText.length * 0.65))) warnings.push('【必须修】摘要存在整段或大段加粗。');
  const methods = bold.filter(x => /(?:具体|改进|自适应|双层|随机|整数|线性|非线性|贝叶斯|遗传|蒙特卡洛|灰色|代理|神经|岭回归|回归|规划|网络|树|聚类|模型|算法|XGBoost|ARIMA|SVR|PCA)/i.test(x) && !/^(数学建模|数据分析|优化模型|机器学习|模型|算法)$/.test(x));
  if (!methods.length) warnings.push('【必须修】摘要未精准加粗核心模型或算法名称；具体性仍需人工核验。');
  else if (!keywords.some(k => methods.some(m => {
    const a = m.replace(/(?:模型|算法)$/, '');
    const b = k.replace(/(?:模型|算法)$/, '');
    return a.includes(b) || b.includes(a);
  }))) warnings.push('【待人工核验】加粗的核心方法与关键词未直接呼应，请检查关键词选择。');
  if (!bold.some(x => /\d+(?:\.\d+)?\s*(?:%|％|元|万元|秒|分钟|小时|天|年|kg|千克|米|m\b|件|辆|kWh|°C|R²|R\^2|RMSE|MAE|误差|成本|准确率)|(?:R²|R\^2|RMSE|MAE|误差|成本|准确率|最优解|[a-z]\s*=)[^\n]*\d/i.test(x))) warnings.push('【必须修】摘要未加粗带指标或单位的关键数值。');
  return warnings;
}

// Only flag explicit supplied-material descriptions. Identity still needs a source read.
function problemMaterialItems(items, rules = {}) {
  if (typeof rules.source === 'string' && rules.source.trim() && rules.problem_materials_in_references === true) return [];
  return items.filter(item => /(?:本题|本次竞赛|题目|主办方提供的|竞赛提供的).{0,12}(?:随题附件|原始附件|随题数据)|随题(?:附件|数据)|(?:[A-F]题|[A-F]\s*题).{0,6}(?:竞赛题目|赛题原文)|(?:竞赛组委会|主办方).{0,30}(?:竞赛题目|赛题原文)/i.test(plain(item.text)));
}

function bibliographyItems(raw) {
  const source = withoutComments(raw);
  const bibliography = source.match(/\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/);
  const list = bibliography ? bibliography[1] : '';
  const itemPattern = /\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
  const items = [];
  let match;
  while ((match = itemPattern.exec(list))) items.push({ key: match[1].trim(), start: match.index, end: itemPattern.lastIndex });
  items.forEach((item, i) => { item.text = list.slice(item.end, items[i + 1]?.start ?? list.length).trim(); });
  return items;
}

function auditProblemMaterials(raw, rules = {}) {
  const suspects = problemMaterialItems(bibliographyItems(raw), rules);
  return suspects.length ? [`【待人工核验】参考文献疑似列入本题题面或随题材料：${suspects.map(x => x.key).join('、')}。回读确认；若为题给材料，移出文献表并改用题目页码/附件表及字段说明来源，同步编号和文献计数。外部研究论文、报告及另行取得的数据仍需引用，不能仅凭标题词语删除。`] : [];
}

function auditReferences(raw, rules = {}, policy) {
  policy = policy === undefined ? require('../contest_packages/cumcm/rules.json').quality : policy;
  const source = withoutComments(raw);
  const warnings = [];
  const items = bibliographyItems(source);
  const suspects = problemMaterialItems(items, rules);
  warnings.push(...auditProblemMaterials(source, rules));
  const count = items.length - suspects.length;
  if (Number.isInteger(policy.references_min) && Number.isInteger(policy.references_max)
      && (count < policy.references_min || count > policy.references_max)) warnings.push(`${suspects.length ? '【待人工核验】' : '【必须修】'}参考文献应为${policy.references_min}-${policy.references_max}篇，当前${count}篇${suspects.length ? '可识别外部文献（疑似题给材料待核实，确认后重计）' : ''}（赛事档案质量目标）。`);
  const keys = items.map(x => x.key);
  if (new Set(keys).size !== keys.length) warnings.push('【必须修】参考文献 bibitem key 重复。');
  const bodyEnd = Math.min(...[source.search(/\\begin\{thebibliography\}/), source.search(/\\appendix\b/), source.search(/\\begin\{appendix\}/)].filter(x => x >= 0), source.length);
  const citationBody = source.slice(0, bodyEnd)
    .replace(/\\begin\{(?:verbatim|lstlisting|minted)\}(?:\[[^\]]*\])?[\s\S]*?\\end\{(?:verbatim|lstlisting|minted)\}/g, ' ')
    .replace(/\\(?:verb|lstinline)\*?(?:\[[^\]]*\])?([^\w\s])[\s\S]*?\1/g, ' ');
  const cites = extractBracedCommands(citationBody, ['cite', 'citep', 'citet']).flatMap(x => x.content.split(',').map(y => y.trim()).filter(Boolean));
  const cited = new Set(cites);
  if (items.some(x => !cited.has(x.key))) warnings.push(`【必须修】参考文献未在正文引用：${items.filter(x => !cited.has(x.key)).map(x => x.key).join('、')}。`);
  if (cites.some(x => !keys.includes(x))) warnings.push(`【必须修】正文引用了未定义的文献 key：${[...new Set(cites.filter(x => !keys.includes(x)))].join('、')}。`);
  for (const book of policy.required_books || []) {
    if (!items.some(x => x.text.includes(book.author) && x.text.includes(book.title))) warnings.push(`【必须修】参考文献缺基础教材${book.author}《${book.title}》；如未实际使用，应报告与赛事档案要求的冲突。`);
  }
  if (items.some(x => !/\b(?:19|20)\d{2}\b/.test(x.text) || !/\[[MJCERD]\]/.test(x.text))) warnings.push('【待人工核验】部分文献缺年份或文献类型标识；GB/T 7714-2015 字段、格式和来源真实性需逐项核查。');
  return warnings;
}

module.exports = { auditAbstractStyle, auditAbstractGuidance, auditReferences, auditProblemMaterials, extractBracedCommands };
