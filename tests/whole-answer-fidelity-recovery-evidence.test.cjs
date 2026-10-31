'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Source/lifecycle checks use scripted transport; they do not rate model quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {boundedSource,sourceDeliveryManifest}=require('../src/context/source-delivery.cjs');
const {buildFidelityContext,buildFidelityRepairContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const FULL='我看过朋友组装书架。那次只是旁观，我没有亲手组装过。';
const PREFIX='我看过朋友组装书架。';
const body=source=>source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function candidate(p,text){const note=p.sources.find(source=>source.type==='note');return {operation:'prepare_message',materials:[{materialRef:whole(note),authorityRef:note.authorityChoices.program[0].authorityRef}],answer:{suggestions:[{text}]}};}
async function app(t,producer,{partial=false}={}){
 const store=new Store(':memory:'),calls=[],model='synthetic-recovery-evidence',baseUrl='http://fixture.invalid/v1',settings={anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestBytes:64000,assistantRequestLimit:8,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}};
 let initial=true;
 const controller=new Controller({store,settings,compactionModel:null,read:async command=>command==='bind'?scope:{messages:[]},assistantModel:(configured,input,signal)=>{
  if(partial&&initial){initial=false;input.payload.sources=input.payload.sources.map(source=>source.type==='note'?boundedSource(source,{maxChars:PREFIX.length,maxBytes:2000}):source);input.manifest.sourceDelivery=sourceDeliveryManifest(input.fullAvailableSources,input.payload.sources);}
  return assistModel(configured,input,signal,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,wrapper,p});const value=await producer(p,wrapper,calls.length-1);return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'fictional-evidence-check',type:'function',function:{name:request.tool_choice.function.name,arguments:JSON.stringify(value)}}]}}]}),{status:200});});}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000000401')]});const note=store.saveNote(scope,{text:FULL,use:'draft'});
 return {store,controller,calls,note,assist:()=>controller.assist({text:'用已选原话回应她，准确保留我的实际经历。',materialIds:[note.id],taskId:'recovery-evidence'})};
}

test('the single regeneration receives the complete original qualifier first restored only for the checker',async t=>{
 let checks=0;const repaired='我看过朋友装书架，不过那次只是旁观，还没有亲手装过。',a=await app(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check'){checks++;assert.ok(p.evidence.some(source=>source.text===FULL));const source=p.evidence.find(source=>source.text===FULL);return checks===1?{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'reject',issues:[{path:'suggestions[0].text',code:'omitted_qualifier',quote:p.candidate.suggestions[0].text,evidence:[{sourceId:source.sourceId,quote:source.text}],reason:'The candidate drops a decisive original qualification.'}]}:{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]};}
  const note=p.sources.find(source=>source.type==='note');if(!wrapper.originalInput){assert.equal(body(note),PREFIX);return candidate(p,'我亲手装过书架。');}
  assert.equal(body(note),FULL,'repair must read the actual omitted qualifier, not infer it from a checker reason');return candidate(p,repaired);
 },{partial:true});
 const reply=await a.assist();assert.equal(a.calls.length,4);assert.equal(reply.suggestions[0].text,repaired);assert.equal(a.calls.some(call=>call.p.purpose==='draft'),false);const run=a.store.getCompanion(scope).runs.at(-1);assert.ok(run.requests.find(request=>request.purpose==='delivery_repair').manifest.fidelityRestoration.sourceIds.includes('note:'+a.note.id));assert.equal(a.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('every retained earlier-only body gets its original revision fence and stale earlier bodies are omitted',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const note=store.saveNote(scope,{text:FULL,use:'discussion'}),turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'先私下解释这件事。'}),all=store.memorySources(scope),source=all.find(source=>source.id==='note:'+note.id),human=all.find(source=>source.id==='private:'+turn.id),prepared={payload:{purpose:'discussion',sources:[human],intentAuthority:{sourceId:human.id}},manifest:{scope,requestId:'earlier-evidence',sourceIds:[human.id],sourceRevisions:{[human.id]:human.revision}},fullAvailableSources:all};
 const earlier={payload:{sources:[source]},manifest:{sourceRevisions:{[source.id]:source.revision}}},info={scope,sourceContexts:[earlier],requestMeasure:value=>Buffer.byteLength(JSON.stringify(value)),settings:{assistantRequestBytes:64000}};
 const input=buildFidelityContext(prepared,{text:'这次仅解释。'},info);assert.equal(input.manifest.sourceRevisions[source.id],source.revision);assert.ok(input.payload.evidence.some(item=>item.sourceId===source.id&&item.text===FULL));
 const revised={...prepared,fullAvailableSources:all.map(item=>item.id===source.id?{...item,revision:'new-original-revision'}:item)};const next=buildFidelityContext(revised,{text:'这次仅解释。'},info);assert.equal(next.payload.evidence.some(item=>item.sourceId===source.id),false);assert.equal(next.manifest.sourceRevisions[source.id],undefined);
});

for(const failure of ['transport','http'])test(`a checker ${failure} failure consumes exactly one attempt without retry or publication`,async t=>{
 const a=await app(t,p=>{if(p.purpose==='fidelity_check')throw Error('Scripted checker failure');return {operation:'advise',text:'A complete private answer.'};});
 if(failure==='http'){const old=a.controller.assistantModel;a.controller.assistantModel=(settings,input,signal)=>input.payload.purpose==='fidelity_check'?assistModel(settings,input,signal,async()=>{a.calls.push({p:{purpose:'fidelity_check'}});return new Response('{}',{status:503});}):old(settings,input,signal);}
 await assert.rejects(a.assist());assert.equal(a.calls.length,2);assert.equal(a.controller.usage.get(scope,'recovery-evidence').attempts,2);assert.equal(a.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});

for(const allow of [true,false])test(`terminal state and pending understanding proposals ${allow?'commit only after allowance':'do not survive a rejected candidate regeneration'}`,async t=>{
 let checks=0;const marker='我周六下午有空',a=await app(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check'){assert.equal(a.store.relationshipView(scope).claims.length,0);assert.equal(a.store.getCompanion(scope).state.items.length,0);checks++;const source=p.evidence.find(source=>source.text===FULL);return !allow&&checks===1?{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'reject',issues:[{path:'text',code:'evidence_mismatch',quote:p.candidate.text,evidence:[{sourceId:source.sourceId,quote:source.text}],reason:'Scripted concrete first-hand claim rejection tests proposal staging.'}]}:{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]};}
  return {operation:'advise',text:!allow&&!wrapper.originalInput?'我昨天亲手装过一个四层书架。':'A complete private explanation.',...(!wrapper.originalInput?{statePatch:{items:[{text:marker,sourceIds:[p.intentAuthority.sourceId]}]},relationshipPatch:{claims:[{text:marker,sourceIds:[p.intentAuthority.sourceId],subject:'self',aspect:'recent_context',assertionKind:'reported',epistemicStatus:'supported'}]}}:{})};
 });
 await a.assist();assert.equal(a.store.relationshipView(scope).claims.length,0,'foreground proposals never become active profile knowledge');assert.equal(a.store.memoryStatus(scope).pendingProposals,allow?1:0);if(allow)assert.equal(a.store.getCompanion(scope).runs.at(-1).relationshipReceipt.queued,true);assert.equal(a.store.getCompanion(scope).state.items.length,allow?1:0);assert.equal(a.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
});


test('checker and regeneration preserve known unread later continuity without invalidating original dates',t=>{
 const source={id:'qq:91000000000000402',type:'qq',role:'contact',text:'这周六下午我会去看展。',at:'2026-10-29T10:00:00.000Z',revision:'qq-original-revision',scope},selected={...source,historicalOnly:true,continuationCoverage:'later_messages_omitted'},prepared={payload:{purpose:'discussion',asOf:'2026-10-30T10:00:00.000Z',sources:[selected]},manifest:{scope,requestId:'continuity',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},fullAvailableSources:[source],essentialSourceIds:[source.id]},input=buildFidelityContext(prepared,{text:'她原话明确说这周六下午。'},{scope,sourceContexts:[{payload:{sources:[source]},manifest:prepared.manifest}],requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
 const evidence=input.payload.evidence[0];assert.equal(evidence.text,source.text);assert.equal(evidence.at,source.at);assert.equal(evidence.historicalOnly,true);assert.equal(evidence.continuationCoverage,'later_messages_omitted');const retry=buildFidelityRepairContext(prepared,input);assert.equal(retry.payload.sources[0].historicalOnly,true);assert.equal(retry.payload.sources[0].continuationCoverage,'later_messages_omitted');
});

test('the actual checker image array is immutable and replacing its pixels invalidates approval',t=>{
 const source={id:'qq:91000000000000403',type:'qq',role:'contact',text:'[图片]',revision:'image-source-original',scope},images=[{messageId:'91000000000000403',index:0,url:'data:image/png;base64,b3JpZ2luYWw='}],prepared={payload:{purpose:'discussion',sources:[source]},manifest:{scope,requestId:'image-binding',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},fullAvailableSources:[source],images},input=buildFidelityContext(prepared,{text:'只依据已送入图片讨论。'},{scope,settings:{assistantRequestBytes:18000}});
 const {prepareAssistantRequest}=require('../src/assistant-model.cjs');assert.equal(prepareAssistantRequest({assistantRequestBytes:18000},input.payload,input.images).requestBytes,prepareAssistantRequest({assistantRequestBytes:18000},input.payload,undefined).requestBytes);
 assert.throws(()=>{input.images[0].url='data:image/png;base64,b3RoZXI=';},TypeError);input.images=[{...images[0],url:'data:image/png;base64,b3RoZXI='}];assert.throws(()=>approvalFor(parseFidelityResult({checkRef:'c1',factual:factualReview(input,{}),verdict:'allow',issues:[]},input),input),error=>error.code==='fidelity_binding_invalid');
});
