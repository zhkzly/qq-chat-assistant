'use strict';
const malformedActual015="{\"kind\":\"discussion\",\"text\":\"上一版整体已经有依据，也接住了她问网页用途的问题；可以保留「给自己记读书笔记」和「昨天把查找功能弄好了」这两点。要更直接一点，可以删掉「还挺开心的，找笔记方便多了」——前者虽然有依据，但你原话说的是挺开心，后半句“找笔记方便多了”不是你提供过的事实。\",\"requestDelivery\":{\"mode\":\"both\",\"sourceId\":\"private:b97b9591-7364-4b06-bddc-709f0fcdfbef\",\"quote\":\"我想改成更直接、更像我自己在说话的版本，保留有依据的部分。\",\"},\"draftPlan\":{\"editingReference\":{\"choice\":\"e1\"},\"quotes\":[{\"sourceId\":\"private:p1\",\"text\":\"这是我给自己记读书笔记的小网页。昨天第一次把查找功能弄好了，我挺开心。想告诉她这个小进展，也想听她平时怎么留住读到的东西。\"}],\"taskUse\":\"continue\",\"intent\":\"reply\",\"style\":\"natural\",\"language\":\"zh-CN\",\"askFollowup\":true,\"useEmoji\":false,\"guidance\":{\"objective\":{\"text\":\"接她问网页有什么意思，并分享一点真实的小进展。\",\"sourceIds\":[\"private:b97b9591-7364-4b06-bddc-709f0fcdfbef\",\"qq:72057594049927937001\"]},\"allowedApproach\":{\"text\":\"说清网页是记读书笔记用的，提到昨天刚弄好查找功能；表达直接、自然。\",\"sourceIds\":[\"private:p1\",\"private:b97b9591-7364-4b06-bddc-709f0fcdfbef\"]},\"avoidances\":[{\"text\":\"不添加没有依据的功能效果或个人感受。\",\"sourceIds\":[\"private:b97b9591-7364-4b06-bddc-709f0fcdfbef\"]}],\"currentStep\":{\"text\":\"用简短回应分享网页用途和查找功能的小进展，再问她平时怎么留住读到的东西。\",\"sourceIds\":[\"private:b97b9591-7364-4b06-bddc-709f0fcdfbef\",\"qq:72057594049927937001\"]}}}}";
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {responseEnvelope}=require('../src/model-response-format.cjs'),{assistModel}=require('../src/assistant-model.cjs');
const {Store}=require('../src/store.cjs'),{TaskLedger}=require('../src/request-budget.cjs'),{scope}=require('./fixtures/native.cjs');
const p={purpose:'discussion',requestDeliveryPolicy:{version:1},draftMaterialPolicy:{version:1},intentAuthority:{sourceId:'private:current'},userRequest:{sourceId:'private:current',text:'今天我完成了笔记查找，帮我把这个进展告诉她。'},sources:[{id:'private:current',type:'private',role:'user',text:'今天我完成了笔记查找，帮我把这个进展告诉她。'},{id:'private:old',type:'private',role:'user',text:'OLD_PRIVATE_FACT'}]};
const valid={kind:'discussion',text:'按这次明确意思组织表达。',requestDelivery:{mode:'editable_message',sourceId:'private:current',quote:p.userRequest.text},draftPlan:{quotes:[{sourceId:'private:current',text:'今天我完成了笔记查找'}]}};
const settings={model:'gpt-6-luna',baseUrl:'http://fixture.invalid/v1',anonymous:true};
const packet=value=>({ok:true,status:200,json:async()=>({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]})});
const tool=value=>({ok:true,status:200,json:async()=>({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'assistant_result',arguments:JSON.stringify(value)}}]}}]})});
test('actual015 malformed primary remains hash-bound and is not guessed into valid JSON',()=>{assert.equal(createHash('sha256').update(malformedActual015).digest('hex'),'d2431719e8a0397375d12ea946d484d226245918801f7a5017a37f1b55b5a431');assert.throws(()=>JSON.parse(malformedActual015));});
for(const model of ['gpt-4o','gpt-4.1-mini','gpt-5','gpt-5.2-codex','gpt-6-luna'])test(`${model} auto uses named result tools without strict assumptions`,()=>{
 const e=responseEnvelope({model},'discussion',p);assert.equal(e.tools[0].function.name,'assistant_result');assert.equal(e.tool_choice.function.name,'assistant_result');assert.equal(e.parallel_tool_calls,false);assert.equal(e.tools[0].function.strict,undefined);assert.equal(e.response_format,undefined);
});
test('explicit modes, Claude and Gemini keep their selected carrier',()=>{
 assert.deepEqual(responseEnvelope({...settings,modelResponseMode:'plain_text'},'discussion',p),{});
 assert.deepEqual(responseEnvelope({...settings,modelResponseMode:'json_object'},'discussion',p),{response_format:{type:'json_object'}});
 assert.equal(responseEnvelope({model:'gemini-2.5-pro',modelResponseMode:'result_tool'},'discussion',p).tool_choice.function.name,'assistant_result');
 assert.deepEqual(responseEnvelope({model:'gemini-2.5-pro'},'discussion',p),{response_format:{type:'json_object'}});
 assert.equal(responseEnvelope({model:'claude-sonnet-4-6'},'discussion',p).tool_choice.function.name,'assistant_result');
 assert.deepEqual(responseEnvelope({model:'claude-opus-4-6-thinking'},'discussion',p),{response_format:{type:'json_object'}});
});
test('malformed actual primary gets one same-carrier repair with complete payload and shared call accounting',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const task=new TaskLedger(store).create(scope,{inputDigest:'actual015-envelope',limit:2}),context={payload:structuredClone(p),manifest:{}},calls=[];
 const result=await assistModel({...settings,requestBudget:task.forStage('discussion')},context,undefined,async(_url,args)=>{
  const r=JSON.parse(args.body);calls.push(r);assert.equal(r.tool_choice.function.name,'assistant_result');return calls.length===1?packet(malformedActual015):tool(valid);
 });
 assert.equal(calls.length,2);assert.equal(task.snapshot().attempts,2);assert.deepEqual(task.snapshot().requests.map(r=>r.purpose),['discussion','delivery_repair']);assert.ok(result.draftPlan);
 const repair=JSON.parse(calls[1].messages[1].content);assert.deepEqual(repair.originalInput,p);assert.equal(repair.invalidResponse,malformedActual015);assert.equal(context.manifest.formatRepair.attempts,1);
});
for(const mode of ['result_tool','json_object','plain_text'])test(`structural repair respects explicit ${mode}`,async()=>{
 const calls=[];await assistModel({...settings,modelResponseMode:mode},{payload:structuredClone(p),manifest:{}},undefined,async(_url,args)=>{const r=JSON.parse(args.body);calls.push(r);return calls.length===1?packet(malformedActual015):packet(valid);});
 for(const r of calls){if(mode==='result_tool')assert.equal(r.tool_choice.function.name,'assistant_result');else if(mode==='json_object')assert.deepEqual(r.response_format,{type:'json_object'});else{assert.equal(r.tools,undefined);assert.equal(r.response_format,undefined);}}
});
test('retaining a result tool does not admit missing historical private authorization or purchase another repair',async()=>{
 const bad={...valid,draftPlan:{quotes:[{sourceId:'private:old',text:'OLD_PRIVATE_FACT'}]}};let calls=0;
 await assert.rejects(assistModel(settings,{payload:structuredClone(p),manifest:{}},undefined,async(_url,args)=>{calls++;assert.equal(JSON.parse(args.body).tool_choice.function.name,'assistant_result');return calls===1?packet(malformedActual015):tool(bad);}),/quotes\[0\]\.authorization/);assert.equal(calls,2);
});
test('intentional natural private recovery remains plain despite GPT auto tools',async()=>{
 const calls=[],legacy={purpose:'discussion',sources:[],userRequest:{text:'私下帮我理清想法。'}};
 const result=await assistModel(settings,{payload:legacy,manifest:{}},undefined,async(_url,args)=>{calls.push(JSON.parse(args.body));return calls.length===1?packet('bad-json'):packet('可以先从你最在意的那部分说起。');});
 assert.equal(result.kind,'discussion');assert.equal(calls[0].tool_choice.function.name,'assistant_result');assert.equal(calls[1].tools,undefined);assert.equal(calls[1].response_format,undefined);
});
test('provider unsupported result tools fails visibly without silently retrying a weaker carrier',async()=>{
 let calls=0;await assert.rejects(assistModel(settings,{payload:structuredClone(p),manifest:{}},undefined,async()=>{calls++;return {ok:false,status:400,json:async()=>({error:{message:'unsupported tool_choice'}})};}),error=>error.code==='model_http_400_provider');assert.equal(calls,1);
});
