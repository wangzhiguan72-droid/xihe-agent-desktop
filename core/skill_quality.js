'use strict';

// 技能首检质检层：全局开关（默认关）+ 以全文 SHA-256 为键的标记。
// 同指纹零 API 复用结论；内容变化 = 新指纹 = 重新首检。质检失败绝不阻塞加载，
// 也不落错误标记（下次首用重试）。共享技能库只读铁律不变：修复只生成
// 独立副本到羲和私有 skills/，原件保留可对比回退。
// 范式与 decision_judge 一致：独立供应商、超时熔断、失败返回结构化错误而非抛异常。

const fs = require('fs');
const path = require('path');
const { keyFor, resolveProvider, providerForModel } = require('./providers');

const DEFAULTS = Object.freeze({
  enabled: false,
  provider: '',
  model: '',
  timeout_ms: 60000,
  max_tokens: 4096,
});
const SHA = /^[a-f0-9]{64}$/;
const MAX_REVIEW_CHARS = 48000;
const MAX_ISSUES = 12;
const SEVERITIES = ['high', 'medium', 'low'];

function clean(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function settingsOf(settings) {
  const raw = settings && settings.skill_quality;
  const config = { ...DEFAULTS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) };
  config.enabled = config.enabled === true;
  config.provider = clean(config.provider, 80);
  config.model = clean(config.model, 200);
  config.timeout_ms = Math.min(Math.max(Number(config.timeout_ms) || DEFAULTS.timeout_ms, 5000), 180000);
  config.max_tokens = Math.min(Math.max(Number(config.max_tokens) || DEFAULTS.max_tokens, 1024), 8192);
  return config;
}

// 未显式配置质检模型时跟随 heavy_model/default_model（9b 级小模型审长文矛盾不够格）。
function modelChoice(settings) {
  const config = settingsOf(settings);
  let provider = config.provider;
  let model = config.model;
  if (provider && model.startsWith(provider + ':')) model = model.slice(provider.length + 1);
  if (!model) {
    model = clean(settings?.heavy_model || settings?.default_model, 200);
    const colon = model.indexOf(':');
    if (colon > 0) { if (!provider) provider = model.slice(0, colon); model = model.slice(colon + 1); }
  }
  if (!provider) provider = providerForModel(model, settings || {}) || '';
  return { provider, model };
}

function storeDir(appDir) { return path.join(appDir, 'data', 'skill_quality'); }
function markerFile(appDir, sha256) {
  if (!SHA.test(String(sha256 || ''))) throw new Error('技能指纹无效');
  return path.join(storeDir(appDir), sha256 + '.json');
}
function readMarker(appDir, sha256) {
  if (!SHA.test(String(sha256 || ''))) return null;
  try {
    const row = JSON.parse(fs.readFileSync(markerFile(appDir, sha256), 'utf8'));
    return row && row.schema_version === 1 && row.sha256 === sha256 ? row : null;
  } catch { return null; }
}
function writeMarker(appDir, record) {
  fs.mkdirSync(storeDir(appDir), { recursive: true });
  const file = markerFile(appDir, record.sha256);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
  return record;
}
function declineSkill(appDir, { name, sha256 }) {
  return writeMarker(appDir, { schema_version: 1, sha256, name: clean(name, 120), status: 'declined', declined_at: Date.now() });
}

function normalizeVerdict(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!['ok', 'warn', 'conflict'].includes(parsed.status)) return null;
  const issues = [];
  for (const row of (Array.isArray(parsed.issues) ? parsed.issues : []).slice(0, MAX_ISSUES)) {
    if (!row || typeof row !== 'object') continue;
    const problem = clean(row.problem, 400);
    if (!problem) continue;
    issues.push({
      severity: SEVERITIES.includes(row.severity) ? row.severity : 'medium',
      where: clean(row.where, 120),
      problem,
      fix: clean(row.fix, 600),
    });
  }
  // 结论与问题清单必须自洽：有问题不能报 ok，有 high 不能只报 warn。
  let status = parsed.status;
  if (issues.length && status === 'ok') status = 'warn';
  if (issues.some(row => row.severity === 'high')) status = 'conflict';
  return { status, summary: clean(parsed.summary, 300), issues };
}

function extractJson(text) {
  const source = clean(text, 60000).replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  try { return JSON.parse(source); } catch {}
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(source.slice(start, end + 1)); } catch {}
  }
  return null;
}

const XIHE_INVARIANTS = [
  '数值结论必须来自真实运行产物，不得指示编造或手填结果',
  '题给关键公式先 formula_register 登记（来源页码+测试点）再使用',
  '题设契约先 contract_register 登记；逐问状态用 question_graph 维护',
  '赛事官方规则与匿名要求高于技能建议；范文数值不得迁移到本题',
  '共享技能库只读；关键分支选择用 ask_user 交给人',
].join('；');

function buildReviewPrompt({ name, content, refs }) {
  const truncated = content.length > MAX_REVIEW_CHARS;
  const body = content.slice(0, MAX_REVIEW_CHARS);
  return [
    '你是羲和 Agent 的技能质检器。审查下面这个数学建模技能的正文，只找有正文依据的真实问题，不重写技能，不评价文风，不补造题目事实。',
    '重点检查：',
    '1. 前后矛盾：同一事项在不同小节给出冲突指令（语言/工具/参数/阈值/流程顺序不一致）。',
    `2. 与宿主门禁冲突：羲和强制要求——${XIHE_INVARIANTS}。技能若指示绕过这些，列为 high。`,
    '3. 不可执行指令：缺关键步骤、未定义术语、依赖明显不存在的工具或文件。',
    '4. 数模写作指导缺陷：摘要/排版/图表/论文组织建议自相矛盾或明显误导（摘要是论文牌面，重点看）。',
    '5. 无证据夸大：宣称获奖级效果却没有可验证路径。',
    '每条问题给出位置、问题描述、可操作的修复建议；确无问题则 status=ok 且 issues 为空。',
    '只返回一个 JSON 对象，不要 Markdown 围栏，不要 JSON 以外的内容：',
    '{"status":"ok|warn|conflict","summary":"不超过150字总评","issues":[{"severity":"high|medium|low","where":"小节或位置","problem":"问题","fix":"修复建议"}]}',
    'status 口径：conflict=存在 high 级矛盾或门禁冲突；warn=仅中低问题；ok=无问题。',
    `技能名：${clean(name, 120)}`,
    `references 文件清单（本次未审其正文，仅列出）：${(refs || []).join('、') || '无'}`,
    truncated ? `技能正文过长，以下仅前 ${MAX_REVIEW_CHARS} 字符（审查范围以此为准，总评中注明）：` : '技能正文：',
    body,
  ].join('\n');
}

function resolveEndpoint(settings, appDir) {
  const { provider: providerKey, model } = modelChoice(settings);
  if (!providerKey || !model) return { error: '质检模型未配置且无法从默认模型推断' };
  const provider = resolveProvider(providerKey, settings || {});
  if (!provider || provider.kind !== 'openai') return { error: '质检模型必须使用 Chat Completions 协议' };
  const key = keyFor(providerKey, appDir);
  if (!key) return { error: `缺少 ${provider.name || providerKey} API Key` };
  if (providerForModel(`${providerKey}:${model}`, settings || {}) !== providerKey) return { error: '质检模型未注册到该供应商' };
  return { provider, providerKey, model, key };
}

async function callChat({ endpoint, settings, system, prompt, maxTokens, signal, fetchImpl }) {
  const config = settingsOf(settings);
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') return { error: '当前运行时没有 fetch' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout_ms);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    // 与主传输层同规则：DeepSeek 官方默认开思考，必须显式关闭，否则推理吃光输出预算；
    // deepseek-/kimi-k3 系不接受 temperature（providers.js chatStreamOpenAI 同款处理）。
    const requestBody = {
      model: endpoint.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    };
    if (/^deepseek-/i.test(endpoint.model)) requestBody.thinking = { type: 'disabled' };
    if (!/^kimi-k3(?:-|$)|^deepseek-/i.test(endpoint.model)) requestBody.temperature = 0;
    const response = await fetcher(endpoint.provider.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + endpoint.key },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { error: `HTTP ${response.status}`, status: response.status };
    const choice = body && body.choices && body.choices[0];
    return {
      content: choice && choice.message && choice.message.content,
      finish: choice && choice.finish_reason,
      usage: body && body.usage ? body.usage : null,
    };
  } catch (error) {
    return { error: error && error.name === 'AbortError' ? '请求超时' : (error && error.message) || String(error) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 同一指纹的并发首检共用一个请求（多会话同时开赛时不重复花钱）。
const pending = new Map();

async function runCheck({ appDir, settings, name, sha256, content, refs, signal, fetchImpl }) {
  const endpoint = resolveEndpoint(settings, appDir);
  if (endpoint.error) return { status: 'error', error: endpoint.error };
  if (!content) return { status: 'error', error: '缺少技能正文' };
  const config = settingsOf(settings);
  const result = await callChat({
    endpoint, settings,
    system: '只做技能质检。输出必须是 JSON。',
    prompt: buildReviewPrompt({ name, content, refs }),
    maxTokens: config.max_tokens, signal, fetchImpl,
  });
  if (result.error) return { status: 'error', error: result.error };
  const verdict = normalizeVerdict(extractJson(result.content));
  if (!verdict) return { status: 'error', error: `返回内容不是合法质检结论（finish=${result.finish || '?'}）`, raw: clean(result.content, 500) };
  const marker = writeMarker(appDir, {
    schema_version: 1, sha256, name: clean(name, 120), status: verdict.status,
    model: `${endpoint.providerKey}:${endpoint.model}`, checked_at: Date.now(),
    scope: content.length > MAX_REVIEW_CHARS ? `SKILL.md 前 ${MAX_REVIEW_CHARS} 字符；references 未审` : 'SKILL.md 正文；references 未审',
    verdict, usage: result.usage,
  });
  return { status: 'checked', marker };
}

async function checkSkill({ appDir, settings, name, sha256, content, refs = [], signal, fetchImpl, force = false } = {}) {
  const config = settingsOf(settings);
  if (!config.enabled) return { status: 'disabled' };
  if (!SHA.test(String(sha256 || ''))) return { status: 'skipped', reason: '该技能无法生成完整指纹，质检跳过' };
  const marker = readMarker(appDir, sha256);
  if (marker && !force) return { status: marker.status === 'declined' ? 'declined' : 'cached', marker };
  if (pending.has(sha256) && !force) return pending.get(sha256);
  const task = runCheck({ appDir, settings, name, sha256, content, refs, signal, fetchImpl })
    .catch(error => ({ status: 'error', error: clean(error && error.message || error, 300) }))
    .finally(() => pending.delete(sha256));
  pending.set(sha256, task);
  return task;
}

function issueLines(verdict) {
  return verdict.issues.map((row, i) =>
    `${i + 1}. [${row.severity}]${row.where ? ' ' + row.where : ''} ${row.problem}${row.fix ? ' → 修复建议：' + row.fix : ''}`).join('\n');
}

// 工具输出用：完整结论（含 ok/declined），让模型和用户都看得到质检状态。
function verdictText(marker) {
  if (!marker) return '';
  if (marker.status === 'declined') return '[技能质检] 此版本已被用户标记跳过质检。';
  const verdict = marker.verdict;
  if (!verdict) return '';
  const label = verdict.status === 'ok' ? '通过' : verdict.status === 'conflict' ? '发现严重问题' : '发现问题';
  const head = `[技能质检] ${label}（首检模型 ${marker.model || '?'}；范围：${marker.scope || 'SKILL.md 正文'}）`;
  if (!verdict.issues.length) return head + (verdict.summary ? '：' + verdict.summary : '');
  return `${head}：${verdict.summary ? verdict.summary + '\n' : '\n'}${issueLines(verdict)}\n`
    + '未修复前，与羲和门禁冲突的技能指令以门禁为准；修复副本须经用户确认后生成（skill_quality op=repair 或技能面板按钮）。';
}

// system prompt 用：只读本地标记，零 API；仅有问题的版本才注入警告（省 token、缓存友好）。
// 开关关闭时一律不注入——关闭即零影响，历史标记只在重新启用后生效。
function qualityWarning(appDir, sha256, settings) {
  if (!settingsOf(settings).enabled) return '';
  const marker = readMarker(appDir, sha256);
  if (!marker || marker.status === 'declined' || !marker.verdict || !marker.verdict.issues.length) return '';
  return `\n[技能质检警告] 首检发现 ${marker.verdict.issues.length} 处问题（${marker.model || '?'}，范围：${marker.scope || 'SKILL.md 正文'}）：\n`
    + issueLines(marker.verdict) + '\n与羲和门禁冲突的指令以门禁为准；不要照搬问题指令，必要时向用户说明。';
}

function repairNotesBlock(marker) {
  return '## 羲和质检修复批注（本节优先于下文与之冲突的指令）\n'
    + `源技能 ${marker.name}（SHA-256=${marker.sha256}）首检发现以下问题。本次修复副本采用批注模式：`
    + '完整重写超出输出预算，故保留原文逐字不动，以本批注为准覆盖冲突指令。\n'
    + issueLines(marker.verdict);
}

function fixedNameFor(appDir, name) {
  const skills = require('./skills');
  const xiheRoot = skills.getRoots(appDir).find(root => root.tag === 'xihe');
  if (!xiheRoot) throw new Error('找不到羲和自有技能目录');
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';
  for (let i = 1; i <= 99; i++) {
    const candidate = i === 1 ? `${base}-xihe-fixed` : `${base}-xihe-fixed-${i}`;
    if (!fs.existsSync(path.join(xiheRoot.dir, candidate))) return { name: candidate, root: xiheRoot.dir };
  }
  throw new Error('修复副本命名次数用尽，请清理旧副本');
}

// 修复副本：用户确认后调用。原件一律不动；副本是新技能（新指纹），
// 首次加载时按同一套首检规则重新质检。重写被截断时降级为批注副本并如实披露。
async function repairSkill({ appDir, settings, name, options = {}, signal, fetchImpl } = {}) {
  const config = settingsOf(settings);
  if (!config.enabled) throw new Error('技能质检未启用，先在设置中打开');
  const skills = require('./skills');
  const loaded = skills.loadSkill(appDir, name, null, options);
  if (!loaded.sha256) throw new Error('该技能无法生成完整指纹，不能生成修复副本');
  const marker = readMarker(appDir, loaded.sha256);
  if (!marker || marker.status === 'declined') throw new Error('此版本尚无质检结论，先完成首次质检');
  if (!marker.verdict || !marker.verdict.issues.length) throw new Error('质检未发现问题，无需修复');
  const endpoint = resolveEndpoint(settings, appDir);
  if (endpoint.error) throw new Error(endpoint.error);

  const body = loaded.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const prompt = [
    '你是技能修复器。下面是一个数学建模技能的正文和质检问题清单。',
    '输出修复后的完整技能正文：只修改与问题清单相关的最小必要内容，其余逐字保留（包括代码块、表格、参考文件引用）。',
    '不要输出 --- frontmatter，不要 Markdown 围栏，不要解释。',
    '问题清单：', JSON.stringify(marker.verdict.issues),
    '技能正文：', body,
  ].join('\n');
  const result = await callChat({
    endpoint, settings,
    system: '只做最小必要修复。输出技能正文本身。',
    prompt,
    maxTokens: Math.min(Math.max(config.max_tokens * 2, 8192), 16384),
    signal, fetchImpl,
  });
  if (result.error) throw new Error('修复调用失败：' + result.error);
  let fixedBody = String(result.content || '').trim().replace(/^```(?:markdown|md)?\r?\n?/i, '').replace(/\r?\n?```$/, '').trim();
  let mode = 'rewrite';
  if (result.finish === 'length' || fixedBody.length < body.length * 0.5) {
    mode = 'annotated';
    fixedBody = repairNotesBlock(marker) + '\n\n' + body;
  }

  const bundle = skills.readSkillBundle(appDir, loaded.name, options);
  const target = fixedNameFor(appDir, loaded.name);
  const dir = path.join(target.root, target.name);
  fs.mkdirSync(dir, { recursive: true });
  const description = clean(`${loaded.name} 的羲和质检修复副本（${mode === 'rewrite' ? '最小重写' : '批注覆盖'}，源指纹 ${loaded.sha256.slice(0, 12)}）`, 200);
  const frontmatter = `---\nname: ${target.name}\ndescription: ${description}\nmetadata:\n  version: "${(loaded.version || '1.0')}-fix"\n  origin: xihe-quality-repair\n  source_skill: ${loaded.name}\n  source_sha256: ${loaded.sha256}\n  repair_mode: ${mode}\n---\n\n`;
  for (const row of bundle.files) {
    const destination = path.join(dir, ...row.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const bytes = row.path === 'SKILL.md' ? Buffer.from(frontmatter + fixedBody + '\n', 'utf8') : Buffer.from(row.content, 'base64');
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
  skills.getIndex(appDir, true);
  return {
    name: target.name, dir, mode, issues: marker.verdict.issues.length,
    source: loaded.name, source_sha256: loaded.sha256,
    model: `${endpoint.providerKey}:${endpoint.model}`, usage: result.usage,
  };
}

module.exports = { DEFAULTS, settingsOf, modelChoice, readMarker, writeMarker, declineSkill,
  normalizeVerdict, checkSkill, verdictText, qualityWarning, repairSkill };
