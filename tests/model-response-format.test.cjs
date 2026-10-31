'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {responseEnvelope}=require('../src/model-response-format.cjs'),{readModelOutput,parseModelJson}=require('../src/model-json.cjs');
const {assistModel,prepareAssistantRequest,parseAssistant,canonicalSourceView}=require('./fixtures/assistant-protocol.cjs');
test('verified Claude and GPT use result envelopes; thinking Claude retains compatible JSON mode',()=>{
 for(const purpose of ['discussion','draft','discussion_compaction','memory','fidelity_check']){
  const settings={model:'claude-sonnet-4-6'},result=responseEnvelope(settings,purpose);
  assert.equal(result.tools.length,1);assert.equal(result.tools[0].function.name,result.tool_choice.function.name);
  assert.equal(result.response_format,undefined);assert.equal(result.parallel_tool_calls,false);
 }
 assert.equal(responseEnvelope({model:'gpt-6-astra'},'draft').tool_choice.function.name,'draft_result');
 assert.deepEqual(responseEnvelope({model:'claude-opus-4-6-thinking'},'draft'),{response_format:{type:'json_object'}});
});
test('every nested transport object declares the fields that the local parser consumes',()=>{
 function check(schema){if(schema.type==='object'){assert.ok(Object.keys(schema.properties||{}).length,'untyped objects can be replaced with provider placeholder fields');for(const value of Object.values(schema.properties))check(value);}if(schema.items)check(schema.items);}
 for(const purpose of ['discussion','draft','discussion_compaction','memory','fidelity_check'])check(responseEnvelope({model:'claude-sonnet-4-6'},purpose).tools[0].function.parameters);
 const refs=responseEnvelope({model:'claude-sonnet-4-6'},'discussion_compaction').tools[0].function.parameters.properties.quoteRefs.items;
 assert.ok(refs.properties.turnId);assert.ok(refs.properties.text);assert.ok(refs.properties.role);
});
test('result arguments preserve quoted Chinese and newlines while unknown/multiple calls are never executed',()=>{
 const expected={kind:'discussion',text:'他说：“想聊聊”。\n也保留 "内部引号"。'};
 const result=readModelOutput({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{function:{name:'assistant_result',arguments:JSON.stringify(expected)}}]}}]});
 assert.deepEqual(parseModelJson(result.text),expected);assert.equal(result.metadata.contentShape,'result_tool');
 for(const name of ['send_qq','unknown'])assert.throws(()=>readModelOutput({choices:[{message:{tool_calls:[{function:{name,arguments:'{}'}}]}}]}),/未执行/);
 assert.throws(()=>readModelOutput({choices:[{message:{tool_calls:[{function:{name:'assistant_result',arguments:'{}'}},{function:{name:'assistant_result',arguments:'{}'}}]}}]}),/未执行/);
});
test('only documented proxy padding at optional-object schema paths is removed',()=>{
 const data={_:true,draftPlan:{_:false,guidance:{_:true,objective:{text:'不要把 _ 字符或“内部引号”改掉',sourceIds:['private:actor']}},quotes:[],intent:'reply'},unknown:'retain'};
 const output=readModelOutput({choices:[{message:{tool_calls:[{function:{name:'assistant_result',arguments:JSON.stringify(data)}}]}}]});
 const result=parseModelJson(output.text);assert.equal(result._,undefined);assert.equal(result.draftPlan._,undefined);assert.equal(result.draftPlan.guidance._,undefined);
 assert.equal(result.draftPlan.guidance.objective.text,data.draftPlan.guidance.objective.text);assert.equal(result.unknown,'retain');
 const required=readModelOutput({choices:[{message:{tool_calls:[{function:{name:'discussion_compaction_result',arguments:JSON.stringify({summary:'x',reviewedTurnIds:[],quoteRefs:[{_:true,turnId:'x',role:'assistant',text:'x'}]})}}]}}]});
 assert.equal(parseModelJson(required.text).quoteRefs[0]._,true,'unknown required-object fields still reach the strict local validator');
});
test('result-tool framing decodes only schema-declared containers and retains source validation',()=>{
 const source={id:'private:current',type:'private',role:'user',text:'我住得很近，帮我回答她。',revision:'r1'};
 const payload={purpose:'reply',userRequest:{sourceId:source.id,text:source.text},sources:[source]};
 const plan={_:true,quotes:JSON.stringify([{sourceId:source.id,text:'我住得很近'}]),style:'natural',
  guidance:JSON.stringify({_:true,currentStep:{text:'回答距离，不加经历',sourceIds:[source.id]}})};
 const expected={kind:'discussion',text:'准备一句完整表达。',draftPlan:JSON.stringify(plan)};
 const carrier=value=>({choices:[{message:{tool_calls:[{function:{name:'assistant_result',arguments:JSON.stringify(value)}}]}}]});
 const decoded=parseModelJson(readModelOutput(carrier(expected)).text);
 assert.equal(typeof decoded.draftPlan,'object');assert.equal(decoded.draftPlan._,undefined);assert.ok(Array.isArray(decoded.draftPlan.quotes));
 assert.equal(decoded.draftPlan.guidance._,undefined);assert.equal(decoded.draftPlan.guidance.currentStep.text,plan.guidance&&JSON.parse(plan.guidance).currentStep.text);
 assert.equal(parseAssistant(decoded,'reply',payload).draftPlan.quotes[0].text,'我住得很近');
 const scalar='{"kind":"discussion","text":"literal quoted JSON"}';
 const literal=parseModelJson(readModelOutput(carrier({kind:'discussion',text:scalar,unknown:JSON.stringify({text:'unknown schema path'})})).text);
 assert.equal(literal.text,scalar);assert.equal(typeof literal.unknown,'string');
 const textCarrier=parseModelJson(readModelOutput({choices:[{message:{content:JSON.stringify(expected)}}]}).text);
 assert.equal(typeof textCarrier.draftPlan,'string','plain message data is not container-decoded');
 for(const malformed of [JSON.stringify(plan)+'}',JSON.stringify(plan)+'\n'+JSON.stringify(plan),'[]','{broken']){
  const bad=parseModelJson(readModelOutput(carrier({...expected,draftPlan:malformed})).text);
  assert.equal(bad.draftPlan,malformed);assert.throws(()=>parseAssistant(bad,'reply',payload),error=>error.code==='draft_plan_shape_invalid'&&error.issues.length===1&&error.issues[0].path==='draftPlan');
 }
 const forbidden=parseModelJson(readModelOutput(carrier({...expected,draftPlan:JSON.stringify({...plan,guidance:{currentStep:{text:'unsupported control',sourceIds:['private:missing']}}})})).text);
 assert.throws(()=>parseAssistant(forbidden,'reply',payload),/sourceIds/,'framing does not relax control-source authority');
});
test('Claude response envelope still passes local phase validation and the full serialized request budget',async()=>{
 const settings={model:'claude-sonnet-4-6',baseUrl:'http://fixture.invalid/v1',anonymous:true},context={payload:{purpose:'review',userRequest:{sourceId:'request:x',text:'先回顾，不写新句子'},sources:[]},manifest:{}};
 let request;
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{request=JSON.parse(args.body);return {ok:true,json:async()=>({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{function:{name:'assistant_result',arguments:JSON.stringify({kind:'review',text:'用户选择的是先接话，暂不邀约；“之后”仍未决定。'})}}]}}]})};});
 assert.equal(result.kind,'discussion');assert.equal(result.suggestions,undefined);assert.equal(request.tool_choice.function.name,'assistant_result');
 assert.equal(context.manifest.serializedTextRequestBytes,Buffer.byteLength(JSON.stringify(request)));
 assert.ok(context.manifest.serializedTextRequestBytes<=prepareAssistantRequest(settings,null).byteLimit);
});
test('malformed nested tool arguments get one same-carrier repair without weakening source-bound controls',async()=>{
 const settings={model:'claude-sonnet-4-6',baseUrl:'http://fixture.invalid/v1',anonymous:true};
 const id='private:current',source={id,type:'private',role:'user',text:'第二个方向，不邀约',revision:'r1'};
 const context={payload:{purpose:'draft_prepare',userRequest:{sourceId:id,text:source.text},sources:[source],topicContext:{active:{id:'topic',lifecycle:'active',objective:'接住游戏分享',direction:'保留反差',constraints:['不邀约']}}},manifest:{}};
 const answer={suggestions:[{style:'自然',text:'这个玩法听着挺有意思。'}]};
 const control=text=>({text,sourceIds:[id]}),valid={draftPlan:{quotes:[],intent:'reply',guidance:{objective:control('接住游戏分享'),allowedApproach:control('保留人与关卡的反差'),avoidances:[control('不邀约')]}}};
 const bodies=[];
 const transport=async(_url,args)=>{const body=JSON.parse(args.body);bodies.push(body);return {ok:true,json:async()=>({choices:[{message:bodies.length===1?{content:null,tool_calls:[{function:{name:'assistant_result',arguments:JSON.stringify({draftPlan:'<parameter name="_">true',kind:'draft',text:'invalid'})}}]}:{content:JSON.stringify({operation:'prepare_message',answer})}}]})};};
 const result=await assistModel(settings,context,undefined,transport);
 assert.equal(result.kind,'draft');assert.equal(result.draftPlan,undefined);assert.equal(bodies.length,2);
 assert.equal(bodies[0].tool_choice.function.name,'assistant_result');assert.equal(bodies[1].tool_choice.function.name,'assistant_result');assert.equal(bodies[1].response_format,undefined);
 assert.deepEqual(canonicalSourceView(JSON.parse(bodies[1].messages[1].content).originalInput,context.extraRequests[0].manifest.sourceHandles,context.resultContext?.payload||context.payload),context.payload);assert.equal(context.manifest.formatRepair.responseMode,'model_default');
 const bad={payload:context.payload,manifest:{}};let calls=0;
 await assert.rejects(assistModel(settings,bad,undefined,async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:calls===1?{content:null,tool_calls:[{function:{name:'assistant_result',arguments:'{"draftPlan":"broken"}'}}]}:{content:JSON.stringify({operation:'prepare_message',answer:{suggestions:'broken'}})}}]})};}),/answer|suggestions/);
 assert.equal(calls,2,'the alternate carrier is still exactly one format repair');
});

test('the fidelity envelope cannot advertise reply rewriting or auxiliary writes',()=>{
 const envelope=responseEnvelope({model:'gpt-6-luna'},'fidelity_check');
 assert.equal(envelope.tool_choice.function.name,'fidelity_result');
 assert.deepEqual(Object.keys(envelope.tools[0].function.parameters.properties).sort(),['checkRef','concerns','issues','verdict']);
 assert.deepEqual(envelope.tools[0].function.parameters.required,['checkRef','verdict','issues']);
});
