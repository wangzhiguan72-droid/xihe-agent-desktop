'use strict';
const assert = require('node:assert/strict');
const { chatStream, responsesInput } = require('./providers');
const { endpointURL, usesResponses } = require('./responses-routing');
const { resolveReasoning, callWithReasoning } = require('./reasoning');
function stream(events) { return events.map(x => Buffer.from('data: ' + JSON.stringify(x) + '\n\n')); }
async function run() {
  assert.equal(endpointURL('https://api.openai.com/v1', 'responses'), 'https://api.openai.com/v1/responses');
  assert.equal(endpointURL('https://api.openai.com','responses'),'https://api.openai.com/v1/responses');
  assert.equal(endpointURL('https://relay.test/v1/responses', 'responses'), 'https://relay.test/v1/responses');
  assert.equal(endpointURL('https://relay.test/v1', 'openai'), 'https://relay.test/v1/chat/completions');
  assert.equal(endpointURL('https://relay.test/api/anthropic', 'anthropic'), 'https://relay.test/api/anthropic/v1/messages');
  assert.equal(endpointURL('https://relay.test/v1', 'anthropic'), 'https://relay.test/v1/messages');
  assert.equal(endpointURL('https://relay.test/v1/messages','responses'),'https://relay.test/v1/responses');
  assert.equal(endpointURL('https://relay.test/v1/responses','anthropic'),'https://relay.test/v1/messages');
  assert.equal(endpointURL('https://relay.test/v1/chat/completions','responses'),'https://relay.test/v1/responses');
  assert.equal(usesResponses({kind:'responses',base:'https://relay.test',model:'qwen3.8-27b'}), true);
  assert.deepEqual(responsesInput([{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}])[0].content,
    [{type:'input_text',text:'看图'},{type:'input_image',image_url:'data:image/png;base64,AA=='}]);
  const calls = [];
  const original = global.fetch;
  let turn = 0;
  global.fetch = async (url, init) => {
    calls.push({url, body:JSON.parse(init.body)});
    const index = turn++;
    const output = index === 0
      ? [{type:'reasoning',id:'rs_1',encrypted_content:'sealed'}, {type:'function_call',id:'fc_1',call_id:'call_1',name:'weather',arguments:'{"city":"北京"}'}]
      : [{type:'message',id:'msg_2',role:'assistant',content:[{type:'output_text',text:'晴'}]}];
    return {ok:true, body:stream([{type:'response.output_text.delta',delta:output[0].type === 'message'?'晴':''}, {type:'response.reasoning_summary_text.delta',delta:index === 0 ? '摘要' : ''}, {type:index > 1 ? 'response.incomplete' : 'response.completed',response:{status:index > 1 ? 'incomplete':'completed',incomplete_details:index > 1 ? {reason:'max_output_tokens'} : null,output,usage:{input_tokens:12,output_tokens:9,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:3}}}}])};
  };
  try {
    const common = {kind:'openai',base:'https://api.openai.com/v1',key:'x',model:'gpt-6.1-sol',maxTokens:4000,reasoningBody:{reasoning_effort:'high'},temperature:0.6,tools:[{type:'function',function:{name:'weather',description:'weather',parameters:{type:'object',properties:{city:{type:'string'}}}}}]};
    const first = await chatStream({...common,messages:[{role:'system',content:'help'},{role:'user',content:'北京天气'}]});
    assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
    assert.equal(calls[0].body.reasoning.effort,'high'); assert.equal(calls[0].body.store,false);
    assert.deepEqual(calls[0].body.include,['reasoning.encrypted_content']);
    assert.equal(calls[0].body.temperature,undefined); assert.equal(calls[0].body.max_output_tokens,4000);
    assert.equal(calls[0].body.tools[0].name,'weather');
    assert.equal(first.tool_calls[0].id,'call_1'); assert.equal(first.tool_calls[0].function.arguments,'{"city":"北京"}');
    assert.equal(first.responses_items[0].encrypted_content,'sealed');
    assert.equal(first.reasoning, '摘要');
    assert.equal(first.usage.prompt_tokens,12); assert.equal(first.usage.completion_tokens,9); assert.equal(first.usage.cache_hit_tokens,2);
    const next = await chatStream({...common,messages:[{role:'user',content:'北京天气'}, {role:'assistant',content:'',responses_items:first.responses_items,tool_calls:first.tool_calls}, {role:'tool',tool_call_id:'call_1',content:'晴 26度'}]});
    assert.deepEqual(calls[1].body.input[1],first.responses_items[0]);
    assert.equal(calls[1].body.input[3].type,'function_call_output');
    assert.equal(calls[1].body.input[3].call_id,'call_1'); assert.equal(next.content,'晴');
    assert.equal(next.usage.reasoning_tokens,3);
    await assert.rejects(() => chatStream({...common,kind:'responses',base:'https://relay.test/v1',model:'qwen3.8-27b',reasoningBody:{enable_thinking:true},messages:[{role:'user',content:'x'}]}), /不支持推理参数/);
    await assert.rejects(() => chatStream({...common,messages:[{role:'user',content:'x'}],maxTokens:1}), /截断|budget|token/i);
    global.fetch = async (url, init) => {
      calls.push({url,body:JSON.parse(init.body)});
      return {ok:true,body:stream([{type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}}])};
    };
    for (const [model,level] of [['gpt-5','high'],['gpt-5-mini','minimal'],['gpt-5.1','none'],['gpt-5.2','xhigh'],['gpt-5-pro','high'],['gpt-5.2-pro','medium']]) {
      const plan=resolveReasoning({model_reasoning:{['openai:'+model]:level}},'openai',{kind:'openai'},model);
      const logs=[];
      await callWithReasoning(chatStream,{...common,model,messages:[{role:'user',content:'x'}]},plan,r=>logs.push(r));
      const actual=calls.at(-1);
      assert.equal(actual.url,'https://api.openai.com/v1/responses',model);
      assert.equal(actual.body.reasoning.effort,level);
      assert.equal(actual.body.max_output_tokens,4000);
      assert.equal(actual.body.temperature,undefined);
      assert.deepEqual(JSON.parse(logs.at(-1).sent),{reasoning:{effort:level}});
    }
    assert(resolveReasoning({model_reasoning:{'openai:gpt-5-pro':'minimal'}},'openai',{kind:'openai'},'gpt-5-pro').error);
    assert(resolveReasoning({model_reasoning:{'openai:gpt-5.2-pro':'none'}},'openai',{kind:'openai'},'gpt-5.2-pro').error);
    global.fetch = async (url, init) => {
      calls.push({url,body:JSON.parse(init.body)});
      return {ok:true,body:stream([{choices:[{delta:{content:'ok'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]}])};
    };
    await chatStream({kind:'openai',base:'https://relay.test/v1',key:'x',model:'gpt-test',messages:[{role:'assistant',content:'old',responses_items:[{type:'reasoning',encrypted_content:'must-not-leak'}]}]});
    assert.equal(calls.at(-1).url,'https://relay.test/v1/chat/completions');
    assert.equal(calls.at(-1).body.messages[0].responses_items,undefined);
    console.log('PASS Responses payload, encrypted replay, tool cycle, usage, truncation');
  } finally { global.fetch = original; }
}
run().catch(e=>{console.error(e);process.exitCode=1});
