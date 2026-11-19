'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const providers = require('./providers');
const { executeTool } = require('./tools');
const { visionCacheKey } = require('./vision');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-vision-cache-'));
const workspace = path.join(root, 'workspace');
const appDir = path.join(root, 'app');
fs.mkdirSync(workspace); fs.mkdirSync(appDir);
const image = path.join(workspace, 'chart.png'); fs.writeFileSync(image, 'offline image fixture');
const sandbox = require('./sandbox').createSandbox(path.resolve(__dirname, '..'), { workspace });
const oldFetch = global.fetch, oldKeyFor = providers.keyFor;
let requests = [];
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url: String(url), body });
  if (body.reasoning_effort) {
    return new Response(JSON.stringify({ error: { message: 'reasoning_effort unsupported' } }), { status: 400 });
  }
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '图表有两条曲线' }, finish_reason: 'stop' }], usage: { prompt_tokens: 18, completion_tokens: 7 } }) + '\n\ndata: [DONE]\n\n');
};
providers.keyFor = () => 'offline-placeholder';

function context(settings) {
  const records = [];
  const session = { reasoning_history: [] };
  return { records, session, ctx: { appDir, workspace, sandbox, settings, session, emit: e => records.push(e),
    trackVision: () => {}, spend: () => {} } };
}
async function read(settings) {
  const c = context(settings);
  const result = await executeTool(c.ctx, 'vision_read', { path: 'chart.png', question: '读图' });
  assert.equal(result.ok, true, result.error);
  return { ...c, data: result.data };
}
function settings(extra = {}) {
  return { vision_model: 'deepseek:deepseek-flash', vision_fallback: 'deepseek:deepseek-flash',
    provider_bases: { deepseek: 'https://relay-one.invalid/v1' },
    model_reasoning: { 'deepseek:deepseek-flash': 'high' }, ...extra };
}

(async () => {
  const keyArgs = { imagePath: image, question: 'q', model: 'm', maxTokens: 100 };
  const baseKey = visionCacheKey({ ...keyArgs, provider: 'p1', kind: 'openai', base: 'https://a.invalid/v1' });
  assert.notEqual(baseKey, visionCacheKey({ ...keyArgs, provider: 'p2', kind: 'openai', base: 'https://a.invalid/v1' }));
  assert.notEqual(baseKey, visionCacheKey({ ...keyArgs, provider: 'p1', kind: 'anthropic', base: 'https://a.invalid/v1' }));
  assert.notEqual(baseKey, visionCacheKey({ ...keyArgs, provider: 'p1', kind: 'openai', base: 'https://b.invalid/v1' }));
  assert.notEqual(baseKey, visionCacheKey({ ...keyArgs, provider: 'p1', kind: 'openai', base: 'https://a.invalid/v1',
    reasoning: { requested: 'provider_default', fallback: 'error' }, actualReasoning: 'provider_default' }));

  const fallbackSettings = settings({ reasoning_fallback: 'provider_default' });
  const first = await read(fallbackSettings);
  assert.match(first.data, /图表有两条曲线/);
  assert.equal(requests.length, 2, 'rejected high request should retry once at provider default');
  assert.equal(requests[0].body.reasoning_effort, 'high');
  assert.equal(requests[1].body.reasoning_effort, undefined);
  assert.equal(first.session.resolved_reasoning.status, 'api_accepted');
  assert.equal(first.session.resolved_reasoning.sent, null, 'effective fallback is provider default');

  const hit = await read(fallbackSettings);
  assert.equal(requests.length, 2, 'provider-default fallback result should be found on repeat');
  assert.match(hit.data, /缓存命中/);
  assert.equal(hit.session.resolved_reasoning.status, 'cache_hit');
  assert.equal(hit.session.resolved_reasoning.effective, 'provider_default');
  assert.deepEqual(hit.session.resolved_reasoning.cache, { hit: true, source: 'vision_cache' });
  assert.equal(hit.session.resolved_reasoning.sent, null, 'cache metadata must not claim an API parameter was sent');

  await assert.rejects(() => read(settings({ reasoning_fallback: 'error' })), /reasoning_effort unsupported/,
    'error policy must not reuse a prior provider-default fallback result');
  assert.equal(requests.length, 3);

  const changedBase = settings({ reasoning_fallback: 'provider_default', provider_bases: { deepseek: 'https://relay-two.invalid/v1' } });
  await read(changedBase);
  assert.equal(requests.length, 5, 'changed endpoint must not reuse cache from previous relay');
  assert(requests.slice(3).every(r => r.url.startsWith('https://relay-two.invalid/')));

  const beforeLocalReject = requests.length;
  await assert.rejects(() => read({ vision_model: 'anthropic:claude-sonnet-4-5', vision_fallback: 'deepseek:deepseek-flash',
    vision_max_tokens: 1200, provider_bases: { anthropic: 'https://claude-relay.invalid' },
    model_reasoning: { 'anthropic:claude-sonnet-4-5': 'high' } }), /至少2048/,
  'manual Claude reasoning budget below output minimum should be rejected');
  assert.equal(requests.length, beforeLocalReject, 'local reasoning rejection must not invoke the fallback vision model');
  const unsupported = context({vision_model:'glm:glm-5.3', vision_fallback:'deepseek:deepseek-flash',
    model_reasoning:{'glm:glm-5.3':'high'}});
  await assert.rejects(() => executeTool(unsupported.ctx,'vision_read',{path:'chart.png'}), /不支持/);
  assert.equal(requests.length,beforeLocalReject,'unsupported reasoning must not call backup model');
  assert.equal(unsupported.session.resolved_reasoning.status,'unsupported');
  assert.equal(unsupported.session.resolved_reasoning.kind,'vision');
  assert(unsupported.records.some(e=>e.t==='reasoning_config' && e.status==='unsupported'));
  console.log('PASS vision_read cache identity, fallback accuracy, endpoint isolation and truthful hit metadata');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  global.fetch = oldFetch; providers.keyFor = oldKeyFor;
  fs.rmSync(root, { recursive: true, force: true });
});
