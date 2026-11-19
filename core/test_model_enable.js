'use strict';
const assert = require('assert');
const { providerModels, resolveProvider } = require('./providers');
const { providerForModel } = require('./providers');
const { resolveRoleModel } = require('./model_roles');
const { validateModelSettingsPayload } = require('./server');
const { resolveProviderTestRequest } = require('./server');

// An explicit empty provider_models entry must suppress built-ins.
assert.deepStrictEqual(providerModels({ provider_models: { glm: [] } }).filter(x => x.provider === 'glm'), []);
assert(providerModels({ provider_models: { glm: ['glm-custom'] } }).some(x => x.id === 'glm-custom'));

// Disabled entries are qualified and hidden from pickers.
const settings = { provider_models: { glm: ['glm-5.3', 'glm-custom'] }, disabled_models: ['glm:glm-5.3'] };
assert(!providerModels(settings).some(x => x.provider === 'glm' && x.id === 'glm-5.3'));
assert(providerModels(settings).some(x => x.provider === 'glm' && x.id === 'glm-custom'));

// Explicit session selection of a disabled model fails instead of falling back.
const explicit = resolveRoleModel({ role: 'modeler', settings: { ...settings, role_models: {}, default_model: 'deepseek-flash' }, sessionModel: 'glm-5.3', sessionExplicit: true, requireKey: false });
assert.strictEqual(explicit.ok, false);
assert.match(explicit.error, /已被禁用/);
const qualified = resolveRoleModel({ role: 'modeler', settings: { ...settings, role_models: {}, default_model: 'deepseek-flash' }, sessionModel: 'glm:glm-5.3', sessionExplicit: true, requireKey: false });
assert.strictEqual(qualified.ok, false);
assert.match(qualified.error, /已被禁用/);

// Non-explicit disabled candidates may fall through to the default model.
const fallback = resolveRoleModel({ role: 'modeler', settings: { ...settings, role_models: { modeler: 'glm-5.3' }, default_model: 'deepseek-flash' }, requireKey: false });
assert.strictEqual(fallback.ok, true);
assert.strictEqual(fallback.model, 'deepseek-flash');
const deleted = resolveRoleModel({ role: 'modeler', settings: { provider_models: { glm: [] }, role_models: { modeler: 'glm-5.3' }, default_model: 'deepseek-flash' }, requireKey: false });
assert.strictEqual(deleted.ok, true);
assert.strictEqual(deleted.model, 'deepseek-flash');
const customSettings = { custom_providers: [{ id: 'relay', name: 'Relay', base: 'https://relay.test/v1', kind: 'openai', models: ['relay-a'] }] };
assert.strictEqual(providerForModel('relay:relay-a', customSettings), 'relay');
assert.strictEqual(providerForModel('relay:relay-removed', customSettings), null);
assert.strictEqual(providerForModel('gpt-test', { custom_providers: [{ id: 'relay', base: 'https://relay.test', models: [] }], disabled_models: ['relay:gpt-test'] }), null);
assert.strictEqual(providerForModel('gpt-5.5', { custom_providers: [{ id: 'relay', base: 'https://relay.test', models: ['gpt-5.5'] }], provider_models: { relay: [] }, disabled_models: ['relay:gpt-5.5'] }), null);
assert.throws(() => validateModelSettingsPayload({ custom_providers: [{ id: 'Bad ID', base: 'file:///tmp', models: [] }] }), /id 无效/);
assert.throws(() => validateModelSettingsPayload({ provider_models: { unknown: [] } }), /提供商不存在/);

// Save payload validation trims and deduplicates while preserving [] semantics.
const payload = { provider_models: { glm: [' glm-5.3 ', 'glm-5.3', ''] }, disabled_models: [' glm:glm-5.3 ', 'glm:glm-5.3'] };
validateModelSettingsPayload(payload);
assert.deepStrictEqual(payload.provider_models.glm, ['glm-5.3']);
assert.deepStrictEqual(payload.disabled_models, ['glm:glm-5.3']);
assert.throws(() => validateModelSettingsPayload({ provider_models: { glm: ['ok', 3] } }), /只能包含字符串/);
assert.throws(() => validateModelSettingsPayload({ disabled_models: ['glm-5.3'] }), /provider:model/);
const testReg = { relay: { models: ['relay-a'], kind: 'openai' } };
assert.strictEqual(resolveProviderTestRequest({pk:'relay',base:'https://relay.test/v1',kind:'responses',key:'k',model:'relay-a'},testReg,()=> 'old').kind,'responses');
assert.strictEqual(resolveProvider('relay',{custom_providers:[{id:'relay',base:'https://relay.test/v1',kind:'responses',models:['gpt-test']}]}).kind,'responses');
assert.strictEqual(resolveProvider('openai',{provider_kinds:{openai:'responses'}}).kind,'responses');
const judgePayload = { decision_judge: { enabled: true, provider: 'tokenrhythm', model: 'neohorse-1-9b', min_confidence: 0.82 } };
validateModelSettingsPayload(judgePayload);
assert.equal(judgePayload.decision_judge.allow_override, false);
const smartJudgePayload = { decision_judge: { enabled: true, trigger: 'smart' } };
validateModelSettingsPayload(smartJudgePayload);
assert.equal(smartJudgePayload.decision_judge.trigger, 'smart');
assert.throws(() => validateModelSettingsPayload({ decision_judge: { min_confidence: 1.2 } }), /0到1/);
assert.throws(() => validateModelSettingsPayload({ decision_judge: { trigger: 'guess' } }), /trigger/);
assert.throws(()=>validateModelSettingsPayload({provider_kinds:{openai:'typo'}}),/接口格式/);
assert.throws(()=>validateModelSettingsPayload({custom_providers:[{id:'relay',base:'https://relay.test/v1',kind:'typo',models:['gpt-test']}]}),/接口格式/);
assert.strictEqual(resolveProviderTestRequest({ pk: 'relay', base: 'https://relay.test', kind: 'anthropic', key: 'k', model: 'relay-a' }, testReg, () => 'old').kind, 'anthropic');
const draftReq = resolveProviderTestRequest({ pk: 'newrelay', base: 'https://relay.test', kind: 'anthropic', key: 'draft-k', model: 'new-a' }, testReg, () => 'old');
assert.strictEqual(draftReq.draft, true);
assert.strictEqual(resolveProviderTestRequest({ pk: 'newrelay', base: 'https://relay.test', model: 'new-a' }, testReg, () => 'old').error, '没有 Key');

assert.throws(() => validateModelSettingsPayload({custom_providers:[{id:'relay',base:'https://',models:['x']}]}), /base/);
assert.throws(() => validateModelSettingsPayload({custom_providers:[{id:'relay',base:'https://relay.example',models:['x']},{id:'relay',base:'https://other.example',models:['y']}]}), /重复/);

(async () => {
  const vision = require('./tools').TOOLS.find(t => t.name === 'vision_read');
  await assert.rejects(() => vision.run({sandbox:{resolve:()=>'/not-read-disabled.png'},settings:{vision_model:'glm-5.3-flash',vision_fallback:'glm-5.3-flash',disabled_models:['glm:glm-5.3-flash']}}, {path:'image.png'}), /已被禁用/);
  console.log('model enable tests passed (including disabled vision path)');
})().catch(e => { console.error(e); process.exitCode = 1; });
