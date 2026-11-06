'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Scripted production consumers test routing/transactions, not semantic quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {buildFidelityContext:buildLegacyContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
// Historical census decoder unit contract; the native controller uses sparse audit.
const buildFidelityContext=(prepared,result,info={})=>buildLegacyContext(prepared,result,{...info,auditProtocol:'legacy-census-v7'});
const {scope,raw}=require('./fixtures/native.cjs');
async function app(t,{close=false}={}){
 const store=new Store(':memory:'),calls=[],settings={auto:false,anonymous:true,model:'synthetic-store-domain',baseUrl:'http://fixture.invalid/v1',realChatConsent:{...scope,model:'synthetic-store-domain',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,compactionModel:null,read:async()=>{throw Error('No native reads');},assistantModel:async(_,input)=>{
  calls.push(input);const p=input.payload;if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  const id=p.intentAuthority.sourceId,control=text=>({text,sourceIds:[id]});
  return {operation:'prepare_message',answer:{suggestions:[{text:'你后面提到的那个进展，现在怎么样啦？'}]},stateReview:'no_change',
   ...(close?{currentFacts:['UNSUPPORTED_CURRENT_FACT']}:{}),
   topicPatch:{operation:close?'complete':'update',topicId:p.topicContext.active.id,progress:['An older optional progress inference.'],observationSourceIds:['qq:91000000000000431'],...(close?{purposeSourceIds:[id],intentQuote:p.userRequest.text}:{})}};
 }});
 t.after(()=>{controller.close();store.close();});controller.scope={...scope};const now=Math.floor(Date.now()/1000);controller.ingest(scope,[raw('91000000000000431',false,{msgTime:String(now-300)}),raw('91000000000000432',false,{msgTime:String(now-60)})]);
 const seed=store.appendTurn(scope,{role:'user',kind:'discussion',text:'先具体回应日常进展，暂不邀约。',requestId:'seed-private-topic'});
 const options=()=>{const companion=store.getCompanion(scope),sources=store.memorySources(scope);return {baseRevision:companion.revision,baseTopicVersion:companion.topics.version,activeId:companion.topics.activeId,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),currentSourceId:'private:'+seed.id,origin:'private_discussion',requestId:seed.requestId};};
 const created=store.applyTopicPatch(scope,{operation:'create',objective:'接住真实日常进展',direction:'具体回应',constraints:['暂不邀约'],purposeSourceIds:['private:'+seed.id],intentQuote:seed.text},options());assert.equal(created.applied,true);
 const progress=store.applyTopicPatch(scope,{operation:'update',topicId:created.topicId,progress:['A newer actual progress record.'],observationSourceIds:['qq:91000000000000432']},options());assert.equal(progress.applied,true);
 return {store,controller,calls,before:store.topicView(scope),assist:()=>controller.assist({text:'现在接她已说过的进展，给一句完整回应。',taskId:'store-domain-optional'})};
}

test('an unchanged-input older optional backfill cannot invalidate a checked core or overwrite newer topic progress',async t=>{
 const a=await app(t),state=a.store.getCompanion(scope).state.version,reply=await a.assist(),run=a.store.getCompanion(scope).runs.find(r=>r.id===reply.requestId);
 assert.equal(a.calls.length,2);assert.equal(a.calls[1].payload.purpose,'fidelity_check');assert.equal(reply.suggestions.length,1);assert.deepEqual(a.store.topicView(scope),a.before);assert.equal(a.store.getCompanion(scope).state.version,state);assert.equal(run.topicReceipt,null);assert.equal(run.patchReceipt,null);assert.equal(reply.privateReviewReceipt,undefined);assert.equal(reply.metadataReviewPending.reasonCode,'auxiliary_metadata_rejected');assert.ok(run.auxiliaryErrors.some(e=>e.field==='topicPatch'&&e.code==='inapplicable_optional_proposal'));assert.equal(a.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});

test('discarding an inapplicable close proposal cannot make an unsupported current fact valid',async t=>{
 const a=await app(t,{close:true});await assert.rejects(a.assist(),/currentFacts|current.*fact|span/i);assert.equal(a.calls.length,1);assert.deepEqual(a.store.topicView(scope),a.before);assert.equal(a.store.getCompanion(scope).turns.some(t=>t.role==='assistant'),false);
});

test('discarding an older optional backfill preserves declared advice facts and complete permission at the checker',async t=>{
 const a=await app(t),oldFact='我以前补过自己的旧帆布包内衬。',currentFact='我今天整理好了读书摘记',human=`${currentFact}，也愿意把以前补旧包内衬这件事告诉她；只说我自己的经历，PRIVATE_REASON仍只在这里商量。先给我含具体例子的私下建议。`,body='可以用自己的小进展接话。例如：“今天终于把读书摘记整理好了。我以前也补过自己的旧包内衬。”';
 const historical=a.store.appendTurn(scope,{role:'user',kind:'discussion',text:oldFact}),calls=[];
 a.controller.assistantModel=async(_,input)=>{
  calls.push(input);const p=input.payload;
  if(p.purpose==='fidelity_check'){
   // Union private-lane carrier (recorded D4b decision): the sources of the
   // declared advice facts are required audit evidence with their exact
   // originals, even though the facts are never disclosure-eligible outbound
   // quotes. The current fact lives inside the full current human statement.
   const texts=p.evidence.map(source=>source.text);
   assert.ok(texts.includes(oldFact));
   const control=p.evidence.find(source=>source.sourceId===p.currentHumanControl.sourceId);
   assert.equal(control.text,human);assert.ok(control.text.includes(currentFact));
   return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  }
  const receipt=input.manifest.primaryReferences,material=receipt.materials.find(item=>item.sourceId==='private:'+historical.id&&item.end-item.start===oldFact.length),permission=receipt.authorities.find(item=>item.currentInstruction);
  assert.ok(material&&permission);
  return {operation:'advise',text:body,currentFacts:[currentFact],materials:[{materialRef:material.materialRef,authorityRef:permission.authorityRef}],stateReview:'no_change',
   topicPatch:{operation:'update',topicId:p.topicContext.active.id,progress:['An older optional progress inference.'],observationSourceIds:['qq:91000000000000431']}};
 };
 const reply=await a.controller.assist({text:human,sourceTurnIds:[historical.id],taskId:'store-domain-advice-material'}),run=a.store.getCompanion(scope).runs.at(-1),currentId=run.payload.currentHumanControl.sourceId;
 assert.equal(calls.length,2);assert.equal(calls[1].payload.purpose,'fidelity_check');assert.equal(reply.text,body);assert.equal(reply.suggestions,undefined);assert.deepEqual(a.store.topicView(scope),a.before);
 assert.ok(run.auxiliaryErrors.some(error=>error.field==='topicPatch'&&error.code==='inapplicable_optional_proposal'));
 assert.equal(run.payload.purpose,'answer_admission');assert.deepEqual(run.payload.privateEvidence.map(quote=>quote.text),[oldFact,currentFact]);assert.deepEqual(run.payload.outboundQuotes,[],'private-lane advise facts never become disclosure-eligible outbound material');
 assert.deepEqual(run.manifest.disclosureBindings,[],'no outbound permission is minted for private-lane facts; permission stays CONTROL_ONLY on the current human statement');
 assert.equal(run.manifest.preparedResponse.message,'absent');assert.equal(run.manifest.preparedResponse.privateBodyOwner,'text');assert.equal(a.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('targeted factual unverifiability is never promoted to approval by a private nonblocking concern',()=>{
 const source={id:'private:human',type:'private',role:'user',text:'Only discuss the known current situation.',revision:'uncertain-source'},prepared={payload:{purpose:'discussion',sources:[source],intentAuthority:{sourceId:source.id}},manifest:{scope,requestId:'uncertain-concern',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},fullAvailableSources:[source]},input=buildFidelityContext(prepared,{text:'The contact is free this Friday.'},{scope,requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))}),result=parseFidelityResult({checkRef:'c1',factual:factualReview(input,{text:[{quote:'The contact is free this Friday.',kind:'assertion',support:'unverifiable'}]}),verdict:'uncertain',issues:[],concerns:[{path:'text',code:'coverage_gap',reason:'Necessary evidence could not be checked.'}]},input);
 assert.equal(result.verdict,'uncertain');assert.equal(approvalFor(result,input),undefined);
});
