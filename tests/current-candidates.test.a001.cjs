'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('./fixtures/whole-answer-fidelity.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
function fixture(t){
 const store=new Store(':memory:');let now=Date.parse('2026-10-16T10:00:00Z');const calls=[];
 const settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic',realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic'}};
 const c=new Controller({store,settings,now:()=>now,read:async()=>{throw Error('No QQ read in this fixture');},assistantModel:async(_,input)=>{
  calls.push(input.payload);
  if(input.payload.purpose==='fidelity_check')return {checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  return {kind:'discussion',text:'Only a generated explanation.',draftPlan:withCurrentDraftControls({quotes:[],intent:'reply'},input.payload),answer:{privateExplanation:'Acknowledge the actual update.',suggestions:[{style:'自然',text:'忙完终于能歇一会啦。'}]}};
 }});c.scope={...scope};c.ingest(scope,[raw('54001')]);
 t.after(()=>{c.close();store.close();});return {c,store,calls,advance:ms=>{now+=ms;}};
}
test('automatic candidates expose their exact QQ binding, expire on outgoing, and retain artifact provenance',async t=>{
 const {c,store}=fixture(t);await c.suggest({automatic:true});
 const advice=c.snapshot().advice;assert.equal(advice.origin,'automatic');assert.equal(advice.binding.revision,c.revision);assert.deepEqual(advice.binding.scope,scope);assert.deepEqual(advice.binding.messageIds,['54001']);assert.ok(Date.parse(advice.expiresAt)>Date.parse(advice.createdAt));
 assert.equal(c.snapshot().companion.turns.length,0,'automatic observations do not fill private consultation history');
 const stored=store.getCompanion(scope).turns.find(turn=>turn.requestId===advice.requestId);assert.equal(stored.origin,'automatic');
 const reference=advice.suggestions[0].artifactRef;assert.equal(store.experiences.artifact(scope,reference).body,advice.suggestions[0].text);
 store.experiences.recordInteraction(scope,{clientEventId:'synthetic-edited',type:'draft_independent',text:'My own unsent revision'});
 c.live({scope,messages:[raw('54002',true)]});assert.equal(c.advice,null);assert.equal(c.snapshot().advice,null);assert.equal(store.experiences.draft(scope).text,'My own unsent revision');
 assert.ok(store.experiences.artifact(scope,reference),'withdrawal of current candidates keeps exact artifacts available for explicit feedback');
 c.live({scope,messages:[raw('54003')]});await c.suggest({automatic:true});assert.deepEqual(c.advice.binding.messageIds,['54003']);
});
test('automatic deduplication has a finite lifetime and never returns a stale candidate',async t=>{
 const {c,calls,advance}=fixture(t);await c.suggest({automatic:true});const first=c.advice.requestId;await c.suggest({automatic:true});assert.equal(calls.length,1);
 advance(6*60000);assert.equal(c.snapshot().advice,null);assert.equal(c.snapshot().candidateStatus.phase,'expired');
 await c.suggest({automatic:true});assert.equal(calls.length,2);assert.notEqual(c.advice.requestId,first);
});
test('private consultations remain visible and switching contacts cannot publish a previous candidate',async t=>{
 const {c,store}=fixture(t);c.assistantModel=async(_,input)=>input.payload.purpose==='fidelity_check'?{checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}:{kind:'discussion',text:'A private consultation remains intact.'};
 await c.assist({text:'Please help me think without drafting.'});assert.equal(c.snapshot().companion.turns.length,2);
 let finish;c.assistantModel=()=>new Promise(resolve=>{finish=resolve});const pending=c.suggest({automatic:true});await new Promise(resolve=>setImmediate(resolve));
 c.scope={...scope,peerUid:'u_another',peerUin:'2200000000'};c.epoch++;c.invalidateAssistant();finish({kind:'discussion',text:'Obsolete observation.',replyDisposition:'wait'});await pending;
 assert.equal(c.snapshot().advice,null);assert.equal(store.getCompanion(scope).turns.length,2);
});
test('private-help recovery is explicitly unavailable rather than a decision to wait or a delivered candidate',async t=>{
 const {c}=fixture(t);c.assistantModel=async(_,input)=>{if(input.payload.purpose==='fidelity_check')return {checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};input.manifest.responseRecovery={kind:'private_help',reasonCode:'structured_output_invalid',metadataApplied:false,intentSourceIds:[]};return {kind:'discussion',text:'Preserved private explanation.',replyDisposition:'unavailable'};};
 await c.suggest({automatic:true});assert.equal(c.advice.replyDisposition,'unavailable');assert.equal(c.advice.suggestions.length,0);assert.equal(c.snapshot().candidateStatus.reason,'unavailable');
});
test('source withdrawal invalidates a current candidate while unrelated derived memory maintenance does not',async t=>{
 const {c,store,calls}=fixture(t);await c.suggest({automatic:true});const first=c.currentAdvice();
 store.touchContext(scope);assert.equal(c.currentAdvice(),first);await c.suggest({automatic:true});assert.equal(calls.length,1,'background generations alone do not spend another automatic request');
 store.forgetSource(scope,'qq:54001');assert.equal(c.currentAdvice(),null);assert.equal(c.snapshot().candidateStatus.reason,'source_changed');
});
