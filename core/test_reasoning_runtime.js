'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const providers = require('./providers');
providers.keyFor = () => 'offline-test-placeholder';
const { runTurn, runSubagent } = require('./agent');
const { createDecision } = require('./decisions');
const { createSandbox } = require('./sandbox');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xihe-reasoning-runtime-'));
const ws = path.join(root, 'workspace'); fs.mkdirSync(ws);
const bodies = [], events = [];
let rejectEffort = false;
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body); bodies.push(body);
  if (rejectEffort && body.reasoning_effort) return new Response(JSON.stringify({error:{message:'Unsupported parameter: reasoning_effort'}}), { status: 400 });
  const message = {choices:[{delta:{content:'已核查，本次未发现新问题。'},finish_reason:null}]};
  const done = { choices:[{delta:{},finish_reason:'stop'}], usage:{prompt_tokens:10,completion_tokens:10} };
  return new Response(`data: ${JSON.stringify(message)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {headers:{'Content-Type':'text/event-stream'}});
};
const settings = { default_model:'relay:gpt-test', role_models:{reviewer:'relay:gpt-test'},
  model_reasoning:{'relay:gpt-test':'medium'}, reasoning_effort:'off', daily_budget:5,
  custom_providers:[{id:'relay',base:'https://offline.invalid/v1',kind:'openai',models:['gpt-test']}], max_output_tokens:1000 };
function session() { return { id:'reasoning-test', model:'relay:gpt-test', mode:'free', effort:'fast', approval:'full',
  messages:[],memory:[],todos:[],runs:[],contract:[],formulas:[],usage:{cost:0,calls:0,prompt_tokens:0,completion_tokens:0,cache_hit_tokens:0} }; }
const deps = {appDir:root, sandbox:createSandbox(path.resolve(__dirname,'..'), {workspace:ws}), settings,
  abort:new AbortController(),stopper:{stop:false},ledger:{costs:{}},emit:e=>events.push(e),persist:()=>{}};
(async()=>{
  const s=session();
  await runTurn(s,deps,{text:'只回复一句话'});
  assert.equal(bodies[0].reasoning_effort,'medium');
  assert.equal(bodies[0].thinking,undefined);
  assert.equal(s.resolved_reasoning.status,'api_accepted');
  assert.equal(s.resolved_reasoning.kind,'main');
  s.pendingQuestion=createDecision({question:'选择路线',candidates:['A','B','C'].map(id=>({id,label:id,basis:'数据依据',risk:'待检验'})),recommended_id:'A',recommendation_reason:'按条件选择'});
  await runTurn(s,deps,{action:'clarify',decision_id:s.pendingQuestion.decision_id,question:'为何推荐？'});
  assert.equal(bodies.at(-1).reasoning_effort,'medium');
  assert.equal(s.resolved_reasoning.kind,'clarify');
  const ctx={session:s,settings,appDir:root,workspace:ws,sandbox:deps.sandbox,resolvedModel:s.model,emit:deps.emit};
  await runSubagent(ctx,deps,'reviewer','只读审查并回复一句，不调用工具',{},()=>{});
  assert.equal(bodies.at(-1).reasoning_effort,'medium');
  assert.equal(s.resolved_reasoning.kind,'sub');
  rejectEffort=true;
  const blocked=session(); const before=bodies.length;
  await runTurn(blocked,deps,{text:'只回复一句'});
  assert.equal(bodies.length-before,1,'explicit rejected effort must not silently retry defaults');
  assert.equal(blocked.resolved_reasoning.status,'failed');
  settings.reasoning_fallback='provider_default';
  const fallback=session(); const n=bodies.length;
  await runTurn(fallback,deps,{text:'只回复一句'});
  assert.equal(bodies.length-n,2);
  assert.equal(bodies.at(-1).reasoning_effort,undefined);
  assert.equal(fallback.resolved_reasoning.sent,null);
  assert(fallback.reasoning_history.some(r=>r.status==='fallback'));
  assert(events.some(e=>e.t==='reasoning_config'));
  const timeout = new Error('model is still reasoning'); timeout.name='TimeoutError';
  timeout.usage={prompt_tokens:4,completion_tokens:2};timeout.usage_partial=true;
  let timeoutRequests=0;
  global.fetch=async()=>{timeoutRequests++;throw timeout;};
  const timed=session();
  await runTurn(timed,deps,{text:'只回复一句'});
  assert.equal(timeoutRequests,1,'timed-out model request must not be silently charged again');
  assert.equal(timed.usage.prompt_tokens,4,'partial timeout input usage must survive the runtime');
  assert.equal(timed.usage.completion_tokens,2,'partial timeout output usage must survive the runtime');
  const partialRow=require('./meter').readRecords(root).find(row=>row.prompt_tokens===4&&row.completion_tokens===2);
  assert(partialRow?.usage_partial,'timeout usage must be marked partial in the durable meter');
  console.log('PASS actual adapter payloads through main/sub/clarify and explicit fallback');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
