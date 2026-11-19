// 识图：按识图模型的提供商自动路由（settings.vision_model 决定）。
// 默认 glm-5.3-flash 走 GLM 订阅 anthropic 端点；DeepSeek V4.1-Flash 等多模态模型
// 走各自 OpenAI 兼容端点（image_url 格式）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chatStream, applyReasoningBody } = require('./providers');
const { usesResponses, endpointURL } = require('./responses-routing');
const { callWithReasoning } = require('./reasoning');

const CACHE_VERSION = 2;
const CACHE_LIMIT = 200;
function cachePath(appDir) { return path.join(appDir, 'data', 'vision_cache.json'); }
function loadVisionCache(appDir) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(appDir), 'utf8'));
    return j && j.entries && typeof j.entries === 'object' ? j.entries : {};
  } catch { return {}; }
}
function visionCacheKey({ imagePath, question, model, maxTokens, region, provider, kind, base, reasoning, actualReasoning }) {
  const imageHash = crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify({
    v: CACHE_VERSION, imageHash, question: String(question || ''), model: String(model || ''),
    maxTokens: Number(maxTokens) || 8192, region: region || null,
    provider: String(provider || ''), kind: String(kind || ''), base: String(base || '').replace(/\/+$/, ''),
    reasoning: reasoning || { requested: 'provider_default', fallback: 'error' },
    actualReasoning: actualReasoning || 'unknown',
  })).digest('hex');
}
function readVisionCache(appDir, key) {
  const hit = loadVisionCache(appDir)[key];
  return hit && typeof hit.text === 'string' ? hit : null;
}
function writeVisionCache(appDir, key, value) {
  const entries = loadVisionCache(appDir);
  entries[key] = { ...value, at: Date.now() };
  const keys = Object.keys(entries);
  if (keys.length > CACHE_LIMIT) {
    keys.sort((a, b) => (entries[a].at || 0) - (entries[b].at || 0));
    for (const old of keys.slice(0, keys.length - CACHE_LIMIT)) delete entries[old];
  }
  const file = cachePath(appDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_INSTRUCTION = `请完整转录这张图片中的全部信息，供后续数学建模使用：
1. 文字逐字转录，保持原有结构与编号，不要概括、不要遗漏；
2. 表格转为 Markdown 表格；
3. 数学公式用 LaTeX（行内 $...$，独立 $$...$$）；
4. 图形精确描述：坐标轴含义与刻度范围、图例、曲线/数据点形态、关键数值；
5. 若是题目：明确每问的输入、输出、约束与数据来源。
直接输出转录内容，不要添加评论。`;

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

async function describeImage({ kind, base, key, model, imagePath, question, signal, maxTokens, reasoningPlan, recordReasoning }) {
  const abs = path.isAbsolute(imagePath) ? imagePath : imagePath;
  const ext = path.extname(abs).toLowerCase();
  if (!MIME[ext]) throw new Error(`不支持的图片格式 ${ext}（支持：${Object.keys(MIME).join('/')}）。PDF 请先用 python(fitz) 渲染为 PNG。`);
  const stat = fs.statSync(abs);
  if (stat.size > 8 * 1024 * 1024) throw new Error(`图片过大（${(stat.size / 1e6).toFixed(1)}MB > 8MB），请裁剪或压缩后重试`);
  const b64 = fs.readFileSync(abs).toString('base64');
  const outBudget = maxTokens || 8192; // 两条协议分支共用同一输出预算（旧版 OpenAI 分支不传，受服务端默认限制）

  const instruction = (question && question.trim()) ? DEFAULT_INSTRUCTION + '\n\n用户附加问题：' + question.trim() : DEFAULT_INSTRUCTION;
  const mdl = model || 'glm-5.3-flash';
  const isAnthropic = kind === 'anthropic';
  const isResponses = !isAnthropic && usesResponses({ kind, base, model: mdl });
  const plan = reasoningPlan || { options: {}, provider: null, model: mdl, requested: 'provider_default', fallback: 'error' };

  let text = '', usage = {}, truncated = false;
  if (isAnthropic) {
    const result = await callWithReasoning(async options => {
    const body = applyReasoningBody({
      model: mdl, max_tokens: outBudget,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: MIME[ext], data: b64 } },
        { type: 'text', text: instruction },
      ] }],
    }, options.reasoningBody);
    const res = await fetch(endpointURL(base, 'anthropic'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(`视觉桥 HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`); e.status = res.status; throw e; }
    return { text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
      usage: j.usage ? { prompt_tokens: (j.usage.input_tokens || 0) + (j.usage.cache_read_input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0), completion_tokens: j.usage.output_tokens || 0, cache_hit_tokens: j.usage.cache_read_input_tokens || 0 } : {},
      truncated: j.stop_reason === 'max_tokens' };
    }, { signal, maxTokens: outBudget }, plan, recordReasoning);
    ({ text, usage, truncated } = result);
  } else {
    const messages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${MIME[ext]};base64,${b64}` } },
        { type: 'text', text: instruction },
      ],
    }];
    const r = await callWithReasoning(chatStream, { kind: isResponses ? 'responses' : kind, base, key, model: mdl, messages, temperature: 0.1, maxTokens: outBudget, signal }, plan, recordReasoning);
    text = r.content || r.reasoning || '(视觉模型返回空)';
    usage = r.usage || {};
  }
  return { text, usage, truncated };
}

module.exports = { describeImage, visionCacheKey, readVisionCache, writeVisionCache };
