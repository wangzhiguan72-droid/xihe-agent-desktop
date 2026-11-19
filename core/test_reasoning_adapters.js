'use strict';
const assert = require('node:assert/strict');
const { reasoningCapabilities, resolveReasoning, callWithReasoning } = require('./reasoning');
const { chatStream } = require('./providers');

async function wire(pk, kind, model, level, extra = {}) {
  const plan = resolveReasoning({ model_reasoning: { [`${pk}:${model}`]: level } }, pk, { kind }, model);
  assert.equal(plan.error, null, `${pk}:${model}: ${plan.error}`);
  let body;
  const original = global.fetch;
  global.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    const ending = kind === 'anthropic'
      ? 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
      : 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n';
    return { ok: true, body: [Buffer.from(ending)] };
  };
  try { await callWithReasoning(chatStream, { kind, base: 'https://example.test', key: 'x', model, messages: [{ role: 'user', content: 'x' }], temperature: 0.6, maxTokens: 10000, ...extra }, plan); }
  finally { global.fetch = original; }
  return body;
}

(async () => {
  assert.deepEqual(reasoningCapabilities('openai', {kind:'openai'}, 'gpt-6.1-sol').levels.includes('none'), false);
  const customClaude=resolveReasoning({model_reasoning:{'aivbv-fable:claude-fable-5-1':'high'}},'aivbv-fable',{kind:'anthropic',custom:true},'claude-fable-5-1');
  assert.equal(customClaude.error,null);
  assert.deepEqual(customClaude.options.reasoningBody,{thinking:{type:'adaptive'},output_config:{effort:'high'}});
  const responsePlan=resolveReasoning({model_reasoning:{'relay:gpt-6-astra':'high'}},'relay',{kind:'responses',base:'https://relay.test/v1'},'gpt-6-astra');
  assert.equal(responsePlan.options.reasoningBody.reasoning_effort,'high');
  assert.equal(reasoningCapabilities('qwen',{kind:'responses'},'qwen3.8-27b').levels.join(','),'provider_default','Responses must not silently reuse Chat thinking_budget');
  assert.equal(reasoningCapabilities('anthropic',{kind:'responses'},'claude-fable-5-1').levels.join(','),'provider_default','Responses must not reuse Anthropic thinking fields');
  const astraRelay = reasoningCapabilities('wanzhao-gpt',{kind:'openai',custom:true},'gpt-6-astra');
  assert.deepEqual(astraRelay.levels,['provider_default','low','medium','high','xhigh','max']);
  const astraPlan = resolveReasoning({model_reasoning:{'wanzhao-gpt:gpt-6-astra':'high'}},'wanzhao-gpt',{kind:'openai',custom:true},'gpt-6-astra');
  assert.equal(astraPlan.options.reasoningBody.reasoning_effort,'high');
  assert.equal(reasoningCapabilities('glm', {kind:'anthropic'}, 'glm-5.3').levels.length, 1);
  assert.equal(resolveReasoning({model_reasoning:{'glm:glm-5.3':'high'}}, 'glm', {kind:'anthropic'}, 'glm-5.3').error != null, true);
  assert.equal((await wire('openai','openai','gpt-6.1-sol','high')).reasoning_effort, 'high');
  const gpt5Relay = await wire('openai','openai','gpt-5','high');
  assert.equal(gpt5Relay.max_completion_tokens,10000); assert.equal(gpt5Relay.max_tokens,undefined); assert.equal(gpt5Relay.temperature,undefined);
  assert.equal((await wire('openai','openai','gpt-5.2','none')).temperature,.6);
  assert.equal((await wire('openai','openai','gpt-5.2','provider_default')).temperature,undefined);
  assert.equal(reasoningCapabilities('openai',{kind:'openai'},'gpt-5-chat-latest').mode,'unknown');
  assert.equal(reasoningCapabilities('openai',{kind:'openai'},'gpt-5.1-codex').mode,'unknown');
  const ds = await wire('deepseek','openai','deepseek-flash','low');
  assert.deepEqual(reasoningCapabilities('deepseek',{kind:'openai'},'deepseek-flash').levels,['provider_default','none','low','high','max']);
  assert.equal((await wire('deepseek','openai','deepseek-flash','medium')).reasoning_effort,'high','old preset aliases must remain compatible');
  assert.deepEqual(ds.thinking, {type:'enabled'}); assert.equal(ds.reasoning_effort,'low'); assert.equal(ds.temperature, undefined);
  const off = await wire('deepseek','openai','deepseek-flash','none'); assert.deepEqual(off.thinking, {type:'disabled'});
  const kimi = await wire('moonshot','openai','kimi-k3','high'); assert.equal(kimi.reasoning_effort,'high'); assert.equal(kimi.thinking,undefined); assert.equal(kimi.temperature,undefined);
  const glm = await wire('glm','openai','glm-5.3','max'); assert.equal(glm.reasoning_effort,'max'); assert.deepEqual(glm.thinking,{type:'enabled'});
  const glm52 = await wire('glm','openai','glm-5.2','high'); assert.equal(glm52.reasoning_effort,'high'); assert.deepEqual(glm52.thinking,{type:'enabled'});
  assert.equal((await wire('glm','openai','glm-5.2','max')).reasoning_effort,'max');
  assert.deepEqual((await wire('glm','openai','glm-5.2','none')).thinking,{type:'disabled'});
  const qwen = await wire('qwen','openai','qwen3.8-max','medium'); assert.equal(qwen.enable_thinking,true); assert.equal(typeof qwen.thinking_budget,'number');
  const switchSettings={model_reasoning_limits:{'qwen:qwen3.8-flash':{base:'https://relay.example/v1',kind:'openai',mode:'qwen-switch',levels:['none','high']}},model_reasoning:{'qwen:qwen3.8-flash':'high'}};
  const switchPlan=resolveReasoning(switchSettings,'qwen',{kind:'openai',base:'https://relay.example/v1'},'qwen3.8-flash');
  assert.deepEqual(switchPlan.options.reasoningBody,{enable_thinking:true});
  assert.equal(reasoningCapabilities('qwen',{kind:'openai',base:'https://official.example/v1'},'qwen3.8-flash',switchSettings).mode,'qwen-budget','relay compatibility must not change official protocol');
  const claude = await wire('anthropic','anthropic','claude-sonnet-4-6','high'); assert.deepEqual(claude.thinking,{type:'adaptive'}); assert.deepEqual(claude.output_config,{effort:'high'}); assert.equal(claude.temperature,undefined);
  const old = await wire('anthropic','anthropic','claude-sonnet-4-5','medium'); assert.equal(old.thinking.type,'enabled'); assert(old.thinking.budget_tokens >= 1024); assert(old.thinking.budget_tokens < old.max_tokens);
  const grok = await wire('xai','openai','grok-4.7','xhigh'); assert.equal(grok.reasoning_effort,'xhigh');
  const unknown = resolveReasoning({model_reasoning:{'relay:gpt-test':'xhigh'}}, 'relay', {kind:'openai'}, 'gpt-test'); assert.equal(unknown.options.reasoningEffort,'xhigh');
  console.log('PASS reasoning wire adapters');
})().catch(e => { console.error(e); process.exitCode = 1; });
