'use strict';
// Scripted production consumers test routing/transactions, not semantic quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {buildFidelityContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
async function app(t,{close=false}={}){
 const store=new Store(':memory:'),calls=[],settings={auto:false,anonymous:true,model:'synthetic-store-domain',baseUrl:'http://fixture.invalid/v1',realChatConsent:{...scope,model:'synthetic-store-domain',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,compactionModel:null,read:async()=>{throw Error('No native reads');},assistantModel:async(_,input)=>{
  calls.push(input);const p=input.payload;if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,verdict:'allow',issues:[]};
  const id=p.intentAuthority.sourceId,control=text=>({text,sourceIds:[id]});
  return {operation:'prepare_message',answer:{suggestions:[{text:'你后面提到的那个进展，现在怎么样啦？'}]},stateReview:'no_change',
   draftPlan:{quotes:[],intent:'reply',taskUse:'continue',guidance:{objective:control('回应已知的后续进展'),allowedApproach:control('只用当前真实交流'),avoidances:close?[]:[control('保留当前商量的表达分寸')]}},
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
 assert.equal(a.calls.length,2);assert.equal(reply.suggestions.length,1);assert.deepEqual(a.store.topicView(scope),a.before);assert.equal(a.store.getCompanion(scope).state.version,state);assert.equal(run.topicReceipt,null);assert.equal(run.patchReceipt,null);assert.equal(reply.privateReviewReceipt,undefined);assert.equal(reply.metadataReviewPending.reasonCode,'auxiliary_metadata_rejected');assert.ok(run.auxiliaryErrors.some(e=>e.field==='topicPatch'&&e.code==='inapplicable_optional_proposal'));assert.equal(a.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});

test('discarding an inapplicable close proposal revalidates the original core against still-active controls',async t=>{
 const a=await app(t,{close:true});await assert.rejects(a.assist(),/avoidances|topic requires/);assert.equal(a.calls.length,1);assert.deepEqual(a.store.topicView(scope),a.before);assert.equal(a.store.getCompanion(scope).turns.some(t=>t.role==='assistant'),false);
});

test('explicit uncertainty is never promoted to approval by a private nonblocking concern',()=>{
 const source={id:'private:human',type:'private',role:'user',text:'Only discuss the known current situation.',revision:'uncertain-source'},prepared={payload:{purpose:'discussion',sources:[source],intentAuthority:{sourceId:source.id}},manifest:{scope,requestId:'uncertain-concern',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},fullAvailableSources:[source]},input=buildFidelityContext(prepared,{text:'A complete private answer.'},{scope,requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))}),result=parseFidelityResult({checkRef:'c1',verdict:'uncertain',issues:[],concerns:[{path:'text',code:'coverage_gap',reason:'Necessary evidence could not be checked.'}]},input);
 assert.equal(result.verdict,'uncertain');assert.equal(approvalFor(result,input),undefined);
});
