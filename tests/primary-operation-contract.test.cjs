'use strict';
// Raw production wire/parser checks only. An operation is not semantic proof of
// intent, permission, a sent message, or conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareAssistantRequest,parseAssistant,assistModel}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {primaryOperationFor}=require('../src/primary-operation.cjs');
const {scope}=require('./fixtures/native.cjs');
const FACT='这个小网页可以按标题找回我自己的摘记；';
const ANSWER={suggestions:[{style:'自然',text:FACT}]};
function fixture(){
 const current={id:'private:operation-current',type:'private',role:'user',kind:'discussion',revision:'current-r1',at:'2026-10-01T10:00:00.000Z',text:'我愿把网页查找功能这件已知事实告诉她，按我这次的实际意思帮助我；PRIVATE_CONTROL_REASON只在这里商量。'};
 const old={id:'private:operation-old',type:'private',role:'user',kind:'discussion',revision:'old-r1',at:'2026-08-31T10:00:00.000Z',text:FACT+'旧的私下细节不能自动分享。'};
 const payload={purpose:'discussion',generationOrigin:'private_discussion',requestDeliveryPolicy:{version:1},draftMaterialPolicy:{version:1},intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:current.text},sources:[old,current]};
 const settings={model:'synthetic-operation-contract',modelResponseMode:'result_tool',baseUrl:'http://fixture.invalid/v1',anonymous:true,sourceHandleOwner:new SourceHandleOwner({scope,taskId:'operation-contract'})};
 return {payload,settings,current,old};
}
function body(source){return source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');}
function materials(wire){
 const old=wire.sources.find(source=>source.at?.startsWith('2026-08'));
 return [{materialRef:old.segments[0].materialRef,authorityRef:wire.currentPermission.authorityRef}];
}
function active(){
 const original=fixture(),prepared=prepareAssistantRequest(original.settings,original.payload,[]);
 prepared.sourceWire.commit();prepared.primaryFrame.commit();
 const context={payload:original.payload,manifest:{scope,requestId:'operation-contract',sourceRevisions:Object.fromEntries(original.payload.sources.map(source=>[source.id,source.revision]))},sourceWireSnapshot:prepared.sourceWire,primaryFrameSnapshot:prepared.primaryFrame};
 return {...original,prepared,context,wire:prepared.wirePayload};
}
function response(value,name='assistant_result'){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'fictional-operation-call',type:'function',function:{name,arguments:JSON.stringify(value)}}]}}]}),{status:200});}
function issue(error){return String(error.message)+' '+JSON.stringify(error.issues||[]);}

test('one existing named result tool advertises an operation without duplicate kind or delivery mode',()=>{
 const {payload,settings}=fixture(),prepared=prepareAssistantRequest(settings,payload,[]),tools=prepared.request.tools;
 assert.equal(tools.length,1);assert.equal(tools[0].function.name,'assistant_result');
 const schema=tools[0].function.parameters;assert.ok(schema.properties.operation,'the model chooses one authoritative operation');
 assert.deepEqual(new Set(schema.properties.operation.enum),new Set(['advise','prepare_message','lookup','clarify']));assert.ok(schema.required.includes('operation'));assert.equal(schema.required.includes('text'),false);
 assert.equal(schema.properties.kind,undefined);assert.equal(schema.properties.requestDelivery,undefined);
 assert.equal(schema.properties.draftPlan,undefined);assert.ok(schema.properties.currentFacts);assert.ok(schema.properties.materials);assert.ok(schema.properties.editingReference);
 assert.ok(prepared.wirePayload.operationProtocol);assert.equal(prepared.wirePayload.requestDeliveryPolicy,undefined);assert.equal(prepared.wirePayload.operationProtocol.requiredArtifact,undefined);
 assert.equal(prepared.request.tool_choice.function.name,'assistant_result');assert.equal(payload.sources[0].text,FACT+'旧的私下细节不能自动分享。');
});

test('canonical local compatibility still rejects a supplied wrong current source rather than auto-mapping it',()=>{
 const {payload,old}=fixture();assert.throws(()=>parseAssistant({kind:'discussion',text:'A local compatibility explanation.',requestDelivery:{mode:'private_help',sourceId:old.id,quote:old.text}},'discussion',payload),/CURRENT intent/);
});

test('canonical local compatibility keeps a private-help and outward-plan conflict strictly invalid',()=>{
 const {payload,current}=fixture();assert.throws(()=>parseAssistant({kind:'discussion',text:'A local incompatible response.',requestDelivery:{mode:'private_help',sourceId:current.id,quote:current.text},draftPlan:{intent:'reply',quotes:[{sourceId:current.id,text:current.text}]}},'discussion',payload),error=>error.code==='request_delivery_unfulfilled');
});

test('raw advise binds current identity and keeps a private why body without constructing a message plan',()=>{
 const app=active(),raw={operation:'advise',text:'因为对方问的是功能，这里先私下解释可用证据。'},before=structuredClone(raw),result=parseAssistant(raw,'discussion',app.context);
 assert.equal(result.kind,'discussion');assert.equal(result.text,raw.text);assert.equal(result.requestDelivery.mode,'private_help');assert.equal(result.requestDelivery.sourceId,app.current.id);assert.equal(result.draftPlan,undefined);assert.equal(result.suggestions,undefined);
 assert.equal(app.context.manifest.primaryOperation.operation,'advise');assert.equal(app.context.manifest.primaryOperation.requiredArtifact,undefined);assert.deepEqual(raw,before);
 assert.deepEqual(parseAssistant(result,'discussion',app.context),result,'canonical second parsing retains its private program operation witness');
 const other=active();assert.throws(()=>parseAssistant(result,'discussion',other.context),/different HTTP offer|canonical|binding/i,'a canonical result cannot be rebound to a different HTTP offer');
});

test('raw prepare_message owns a complete answer and restores optional private material without a plan',()=>{
 const app=active(),raw={operation:'prepare_message',answer:ANSWER,materials:materials(app.wire)},result=parseAssistant(raw,'discussion',app.context),quote=result.materials[0];
 assert.equal(result.requestDelivery.mode,'editable_message');assert.equal(result.requestDelivery.sourceId,app.current.id);assert.equal(quote.sourceId,app.old.id);assert.equal(quote.text,FACT);
 assert.equal(quote.authorization.permission.sourceId,app.current.id);assert.equal(quote.authorization.referent.text,FACT);assert.equal(raw.materials[0].text,undefined);
 assert.equal(app.context.manifest.primaryOperation.operation,'prepare_message');assert.equal(app.context.manifest.primaryOperation.requiredArtifact,'message');assert.equal(result.kind,'draft');assert.equal(result.suggestions[0].text,FACT);assert.equal(result.draftPlan,undefined);
 const control=active(),pure=parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:'这个功能挺有意思的。'}]}},'discussion',control.context);assert.equal(pure.kind,'draft');assert.deepEqual(primaryOperationFor(pure).admittedMaterials,[],'ordinary response has no fabricated material-selection obligation');
});

test('raw lookup declares its continuation and retains valid independent auxiliary metadata without accepting another core branch',()=>{
 const app=active(),sourceId=app.wire.sources[0].id,result=parseAssistant({operation:'lookup',lookup:{sourceIds:[sourceId],offset:0,maxChars:100},continuation:'prepare_message',stateReview:'no_change'},'discussion',app.context);
 assert.deepEqual(result.lookup.sourceIds,[app.old.id]);assert.equal(result.requestDelivery.mode,'editable_message');assert.equal(app.context.manifest.primaryOperation.requiredArtifact,'message');assert.equal(result.stateReview,'no_change');
 for(const raw of [{operation:'lookup',lookup:{query:'具体的旧事'}},{operation:'lookup',lookup:{query:'具体的旧事'},continuation:'draft'},
  {operation:'lookup',lookup:{query:'具体的旧事'},continuation:'advise',draftPlan:{}},
  {operation:'lookup',lookup:{query:'具体的旧事'},continuation:'advise',blocker:{kind:'missing_fact',missing:'A fact',question:'Which fact?'}}]){
  const other=active();assert.throws(()=>parseAssistant(raw,'discussion',other.context),error=>/operation|continuation|lookup/i.test(issue(error)));
 }
});

test('raw clarify owns one canonical why/question body without creating a fresh message promise',()=>{
 const app=active(),question='这次希望表达哪件已确认的小事？',why='需要先确认当前确实可用的事情。',result=parseAssistant({operation:'clarify',blocker:{kind:'missing_fact',missing:'本次可分享的具体小事',question,explanation:why}},'discussion',app.context);
 assert.equal(result.kind,'question');assert.equal(result.text,why+'\n\n'+question);assert.equal(result.discussionExplanation,undefined);assert.equal(result.suggestions,undefined);assert.equal(result.requestDelivery.mode,'private_help');
 assert.equal(result.deliveryBlocker.question,question);assert.equal(app.context.manifest.primaryOperation.operation,'clarify');assert.equal(app.context.manifest.primaryOperation.requiredArtifact,undefined);
 assert.deepEqual(parseAssistant(result,'discussion',app.context),result);
});

test('mixed, malformed and unknown operations fail before inactive refs or legacy DTO fields can be interpreted',()=>{
 const malformed=[{operation:'unknown',text:'Readable but invalid.'},{operation:['advise','prepare_message'],text:'Ambiguous.'},{operation:'advise'},{operation:'advise',text:''},
  {operation:'advise',text:'Private.',draftPlan:{quotes:[{materialRef:'m999',authorityRef:'a999'}]}},
  {operation:'advise',text:'Private.',kind:'discussion'},{operation:'advise',text:'Private.',requestDelivery:{mode:'private_help'}},
  {operation:'prepare_message',answer:ANSWER,draftPlan:'not an object'},{operation:'prepare_message',answer:ANSWER,draftPlan:{clarification:'Different operation.'}},
  {operation:'clarify',text:'An untyped duplicate question.',blocker:{kind:'missing_fact',missing:'A fact',question:'Which fact?'}},
  {operation:'clarify',blocker:{kind:'missing_fact',missing:'A fact',question:'Which fact?'},lookup:{query:'An inactive lookup'}}];
 for(const raw of malformed){const app=active(),before=structuredClone(raw);assert.throws(()=>parseAssistant(raw,'discussion',app.context),error=>String(error.code||'').startsWith('primary_operation_')&&!/Unknown or not-offered source handle/.test(error.message));assert.deepEqual(raw,before);}
});

test('prepare_message itself cannot create new permission, human controls or a selected UI source',()=>{
 const app=active(),bad={operation:'prepare_message',answer:ANSWER,materials:materials(app.wire)};bad.materials[0].authorityRef='a999999';
 assert.throws(()=>parseAssistant(bad,'discussion',app.context),error=>/authority/i.test(issue(error)));
 for(const field of ['currentHumanControl','selectedDirectionControl','requestDelivery']){
  const other=active(),raw={operation:'advise',text:'Private.',[field]:{authority:'CONTROL_ONLY_UI_SELECTION',sourceId:'s999',label:'MODEL_SELF_TAGGED'}};
  assert.throws(()=>parseAssistant(raw,'discussion',other.context),error=>/operation|field|currentHumanControl|selectedDirectionControl|requestDelivery/i.test(issue(error)));
 }
});

test('the named tool and single repair carrier preserve raw operation errors without switching grammar or adding calls',async()=>{
 const {payload,settings}=fixture(),context={payload,manifest:{scope,requestId:'operation-repair',sourceRevisions:Object.fromEntries(payload.sources.map(source=>[source.id,source.revision]))}},calls=[];
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content);calls.push({request,wrapper});
  return response(calls.length===1?{operation:'advise',text:'Private.',draftPlan:{quotes:[]}}:{operation:'advise',text:'Only this private explanation.'});
 });
 assert.equal(result.text,'Only this private explanation.');assert.equal(calls.length,2);assert.equal(calls[1].request.tool_choice.function.name,'assistant_result');
 assert.equal(calls[1].request.tools[0].function.parameters.properties.kind,undefined);assert.equal(calls[1].request.tools[0].function.parameters.properties.requestDelivery,undefined);
 assert.equal(calls[1].wrapper.invalidResponse.includes('"operation":"advise"'),true);assert.ok(calls[1].wrapper.validationIssues.length);assert.equal(calls[1].wrapper.originalInput.operationProtocol.requiredArtifact,undefined);
 const task=calls[1].wrapper.task;assert.match(task,/operation/);for(const operation of ['advise','prepare_message','lookup','clarify'])assert.ok(task.includes(operation));
 assert.equal(task.includes('先保证kind/text'),false);assert.equal(task.includes('"kind":"discussion"'),false);assert.equal(task.includes('requestDelivery仅填写mode'),false,'repair must not teach a second audience/kind grammar');
});

test('a malformed prepare_message cannot spend its repair slot by finishing as advice',async()=>{
 const {payload,settings}=fixture(),context={payload,manifest:{scope,requestId:'operation-malformed-message',sourceRevisions:Object.fromEntries(payload.sources.map(source=>[source.id,source.revision]))}},calls=[];
 await assert.rejects(assistModel(settings,context,undefined,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content);calls.push({request,wrapper});
  return response(calls.length===1?{operation:'prepare_message',answer:{suggestions:[]}}:{operation:'advise',text:'Only a private strategy, not the promised message.'});
 }),error=>/message artifact|artifact_required|still requires/i.test(issue(error)));
 assert.equal(calls.length,2);assert.equal(calls[1].wrapper.originalInput.operationProtocol.requiredArtifact,'message');
 assert.equal(calls[1].request.tool_choice.function.name,'assistant_result');assert.equal(context.manifest.formatRepair.attempts,1);
});

test('image carrier, exact delivered body and serialized text measurement use the same operation request',()=>{
 const {payload,settings}=fixture(),messageId='72057594049927937999';payload.sources.push({id:'qq:'+messageId,type:'qq',role:'contact',text:'[图片]',revision:'image-r1',at:'2026-10-01T10:00:00.000Z'});
 const image={url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',messageId,index:0},prepared=prepareAssistantRequest(settings,payload,[image]);
 assert.equal(prepared.request.messages[1].content[1].image_url.url,image.url);assert.equal(prepared.request.messages[1].content[0].type,'text');
 const wire=JSON.parse(prepared.request.messages[1].content[0].text),old=wire.sources.find(source=>source.at?.startsWith('2026-08'));assert.equal(body(old),payload.sources[0].text);
 assert.ok(wire.operationProtocol);assert.equal(wire.requestDeliveryPolicy,undefined);assert.ok(prepared.requestBytes<=prepared.byteLimit);
 const withoutImage={...prepared.request,messages:[prepared.request.messages[0],{role:'user',content:prepared.request.messages[1].content[0].text}]};assert.equal(prepared.requestBytes,Buffer.byteLength(JSON.stringify(withoutImage)));
});

test('valid material declarations never substitute for the required complete primary answer',()=>{
 const app=active();
 assert.throws(()=>parseAssistant({operation:'prepare_message',materials:materials(app.wire)},'discussion',app.context),error=>error.code==='whole_answer_invalid');
});
