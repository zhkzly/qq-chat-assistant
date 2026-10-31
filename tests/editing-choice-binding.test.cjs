'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const {wireSourceView,canonicalSourceView}=require('./fixtures/source-wire.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {parseAssistant,assistModel,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {responseEnvelope}=require('../src/model-response-format.cjs');
const {scope,raw}=require('./fixtures/native.cjs'),{normalize}=require('../src/messages.cjs');
const f=require('./fixtures/actual013-editing-responses.cjs');
const settings={anonymous:true,model:'synthetic-short-reference',baseUrl:'http://fixture.invalid/v1',auto:false,discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-short-reference',baseUrl:'http://fixture.invalid/v1'}};
function fixture(t,{multiple=false}={}){
 const store=new Store(':memory:');t.after(()=>store.close());const message=normalize(raw('72057594049927937001',false,{elements:[{textElement:{content:'你说最近总在做那个网页，做它有什么意思呀？'}}]}),scope);store.add(scope,[message]);
 store.appendTurn(scope,{id:'p1',role:'user',kind:'discussion',text:f.materialText});
 const prior=store.appendTurn(scope,{id:f.observedOffer.turnId,role:'assistant',kind:'draft',text:'上一轮实际草稿',sourceIds:['private:p1'],suggestions:[{style:'自然',text:f.observedOffer.text},...(multiple?[{style:'另一条',text:'第二条完整的旧表达。'}]:[])]});
 const turn=store.appendTurn(scope,{id:f.currentSourceId.slice(8),role:'user',kind:'discussion',text:f.currentRequestText});
 const args={scope,store,turn,records:[message],companion:store.getCompanion(scope),purpose:'discussion',availableSources:store.memorySources(scope),sourceTurnIds:[prior.id],coverage:{status:'complete'},requestId:'short-editing-reference',asOf:'2026-10-01T10:20:00Z',settings};
 return {store,prior,args,prepared:buildContext(args)};
}
function selectedResponse(choice='e1'){const response=structuredClone(f.repairResponse);response.draftPlan.editingReference={choice};return response;}
test('actual013 producer identities remain exact and the corrupted legacy repair is never upgraded',t=>{
 const {prepared}=fixture(t);for(const name of ['first','repair'])assert.equal(createHash('sha256').update(f[name+'ResponseContent']).digest('hex'),f[name+'ResponseSha256']);
 assert.deepEqual(f.firstResponse.draftPlan.editingReference,f.observedOffer.artifactRef);
 assert.throws(()=>parseAssistant(f.repairResponseContent,'discussion',prepared),/editingReference/);
 const legacy=selectedResponse();legacy.draftPlan.editingReference=f.observedOffer.artifactRef;
 const result=parseAssistant(legacy,'discussion',prepared);assert.deepEqual(result.draftPlan.editingReference,f.observedOffer.artifactRef);
 for(const reference of [{...f.observedOffer.artifactRef,version:99},{artifactId:f.observedOffer.artifactRef.artifactId}, {artifactId:'corrupted',version:1}])
  assert.throws(()=>parseAssistant({...legacy,draftPlan:{...legacy.draftPlan,editingReference:reference}},'discussion',prepared),/editingReference/);
});
test('the model receives only short editing choices while the prepared context retains exact dependencies',t=>{
 const {prepared}=fixture(t);assert.deepEqual(prepared.payload.editingReferences.map(item=>item.choice),['e1']);
 const view=JSON.stringify(prepared.payload.editingReferences);for(const key of ['artifactRef','artifactId','turnId','suggestionIndex','bodyDigest','witness'])assert.equal(view.includes(key),false,key);
 assert.equal(prepared.payload.editingReferences[0].text,f.observedOffer.text);assert.deepEqual(prepared.manifest.inputArtifactRefs[0].artifactRef,f.observedOffer.artifactRef);
 const wire=prepareAssistantRequest(settings,prepared.payload).serialized;assert.ok(wire.includes('e1'));assert.equal(wire.includes(prepared.editingReferenceChoices.bindingId),false);
});
test('a short selector resolves to the exact live old wording and cannot authorize its facts',t=>{
 const {prepared,args}=fixture(t),result=parseAssistant(selectedResponse(),'discussion',prepared);
 assert.deepEqual(result.draftPlan.editingReference,f.observedOffer.artifactRef);const draft=buildDraftContext(prepared,result.draftPlan,args);
 assert.equal(draft.payload.editingReference.text,f.observedOffer.text);assert.deepEqual(draft.payload.editingReference.artifactRef,f.observedOffer.artifactRef);
 assert.ok(draft.payload.outboundQuotes.every(q=>q.sourceId!=='private:'+f.observedOffer.turnId));
 assert.throws(()=>parseAssistant(selectedResponse('e9'),'discussion',prepared),/editingReference/);
 assert.throws(()=>parseAssistant({...selectedResponse(),draftPlan:{...selectedResponse().draftPlan,editingReference:{choice:'e1',artifactId:'ignored'}}},'discussion',prepared),/editingReference/);
});
test('multiple choices are deterministic and a parsed selection cannot rebind against a different prepared map',t=>{
 const {store,prepared,args}=fixture(t,{multiple:true});assert.deepEqual(prepared.payload.editingReferences.map(item=>item.choice),['e1','e2']);
 const second=parseAssistant(selectedResponse('e2'),'discussion',prepared),draft=buildDraftContext(prepared,second.draftPlan,args);assert.equal(draft.payload.editingReference.suggestionIndex,1);
 const same=buildContext(args);assert.deepEqual(same.payload.editingReferences,prepared.payload.editingReferences);
 const another=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'另一个可改的输出',suggestions:[{style:'自然',text:'新候选原句。'}]});
 const nextArgs={...args,companion:store.getCompanion(scope),sourceTurnIds:[another.id,args.sourceTurnIds[0]]},next=buildContext(nextArgs);
 assert.equal(next.payload.editingReferences[0].text,'新候选原句。');assert.throws(()=>buildDraftContext(next,second.draftPlan,nextArgs),/editingReference.*(?:binding|context|prepared|choices)/);
});
test('short choice still rejects dependency withdrawal before restricted wording',t=>{
 const {store,prepared,args}=fixture(t),result=parseAssistant(selectedResponse(),'discussion',prepared);store.forgetSource(scope,'private:p1');
 assert.throws(()=>buildDraftContext(prepared,result.draftPlan,args),/变化|changed|unavailable|已/);
});
test('the normal flat result schema exposes only its short editing choice without a union',()=>{
 const schema=responseEnvelope({model:'claude-sonnet-4-6'},'discussion',{purpose:'discussion'}).tools[0].function.parameters.properties.editingReference;
 assert.equal(schema.properties.choice.type,'string');assert.equal(schema.properties.artifactId,undefined);assert.equal(schema.properties.version,undefined);assert.equal(schema.oneOf,undefined);assert.equal(schema.anyOf,undefined);
});
test('actual013-shaped missing metadata repair uses the short choice again and reaches safe wording in the same task',async t=>{
 const {store,prior}=fixture(t),calls=[];
 const controller=new Controller({store,settings,read:async()=>({messages:[]}),assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,p,wrapper});
  let response;
  if(p.purpose==='fidelity_check'){
   assert.equal(p.priorArtifact.text,f.observedOffer.text);assert.equal(p.userRequest,undefined);assert.equal(p.goal,store.getCompanion(scope).goal.text);
   response={checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  }else{
   if(wrapper.originalInput)assert.match(wrapper.formatError,/materials\[0\]\.authorityRef/);
   response=structuredClone(wrapper.originalInput?f.repairResponse:f.firstResponse);response.draftPlan.editingReference={choice:p.editingReferences[0].choice};response.answer={suggestions:[{style:'自然',text:'就是我给自己记读书笔记用的小网页，昨天查找功能终于弄好了，我挺开心。你平时怎么留住读到的东西？'}]};
  }
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(wireSourceView(response,(wrapper.originalInput?context.extraRequests?.at(-1)?.manifest?.sourceHandles:undefined)||context.manifest.sourceHandles,(wrapper.originalInput?context.extraRequests?.at(-1)?.manifest?.primaryReferences:undefined)||context.manifest.primaryReferences,wrapper.originalInput?context.extraRequests.at(-1).payload.originalInput:context.payload))}}]}),{status:200});
 })});t.after(()=>controller.close());controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
 const reply=await controller.assist({text:f.currentRequestText,resumeTurnId:f.currentSourceId.slice(8),sourceTurnIds:[prior.id],taskId:'short-reference-actual013'});
 assert.equal(reply.suggestions.length,1);assert.equal(calls.length,2);assert.equal(store.getCompanion(scope).runs.at(-1).manifest.requestDelivery.status,'delivered');
});
test('QQ/source changes and foreign scope cannot reuse a parsed editing choice',t=>{
 const {store,args,prepared}=fixture(t),parsed=parseAssistant(selectedResponse(),'discussion',prepared);
 const nextMessage=normalize(raw('72057594049927937002',false,{elements:[{textElement:{content:'我平时会把读到的句子随手记下来。'}}]}),scope);store.add(scope,[nextMessage]);
 const nextArgs={...args,records:store.messages(scope),companion:store.getCompanion(scope),availableSources:store.memorySources(scope)},next=buildContext(nextArgs);
 assert.throws(()=>buildDraftContext(next,parsed.draftPlan,nextArgs),/editingReference.*binding/);
 assert.throws(()=>buildDraftContext(prepared,parsed.draftPlan,{...args,scope:{...scope,peerUin:'2222222222',peerUid:'other'}}),/联系人|scope/);
});
test('restricted handoff rejects an unparsed short choice instead of resolving it against an arbitrary current map',t=>{
 const {prepared,args}=fixture(t);assert.throws(()=>buildDraftContext(prepared,selectedResponse().draftPlan,args),/editingReference.*(?:bound|parser)/);
});
