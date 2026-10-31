'use strict';
// Fictional storage/transport/scheduling contracts, not semantic quality ratings.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {prepareMemoryRequest,maintainMemory,consolidateMemory}=require('../src/memory-engine.cjs');
const {scope,frozenLegacy,options}=require('./fixtures/evidence-backed-memory.cjs');
const settings={anonymous:true,model:'synthetic-review-recovery',baseUrl:'http://fixture.invalid/v1',modelResponseMode:'result_tool'};
const complete=(batch,extra={})=>({reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[],...extra});
const packet=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
function fixture(t,{body='A fictional old account needing original review.',local=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq023-review-')),filename=path.join(directory,'fictional.sqlite');let old=new (frozenLegacy().Store)(filename),record,sourceId;
 try{
  if(local){old.saveRun(scope,{id:'local-target'});const feedback=old.addFeedback(scope,{requestId:'local-target',text:'Only this answer should be shorter.',kind:'local'});sourceId='private:feedback-'+feedback.id;}
  else sourceId='private:'+old.appendTurn(scope,{id:'recovery-original',role:'user',kind:'discussion',text:body}).id;
  let first=true,batch;while((batch=old.memoryBatch(scope))){assert.equal(old.applyMemoryBatch(scope,batch,complete(batch,first?{items:[{kind:'fact',text:'A legacy interpretation, not independently verified truth.',sourceIds:[sourceId]}]}:{})).applied,true);first=false;}
  record=old._memoryRecords(scope).find(item=>item.recordType==='item');
  if(local){
   // An intentionally misclassified pre-existing artifact. We do not claim
   // the frozen writer accepted a forbidden preference or use this as gold.
   record={...record,kind:'preference'};old.db.prepare('UPDATE memory_records SET record=? WHERE scope_key=? AND id=?').run(JSON.stringify(record),old.scopeKey(scope),record.id);
  }
 }finally{old.close();}
 const store=new Store(filename);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});return {store,filename,record,sourceId};
}
function drain(store){store.maintainLocal(scope);let batch,n=0;while((batch=store.memoryStatus(scope).pending?store.memoryBatch(scope):null)){assert.ok(++n<30);assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,true);}}
function propose(batch,record,{compat=false,version=record.version}={}){
 const request=prepareMemoryRequest(settings,batch),p=packet(request),target=p.priorMemory.items.find(item=>item.id&&item.text===record.text),source=[...p.sources,...p.contextSources].find(item=>item.text===batch.sources.find(item=>item.id===record.sourceIds[0])?.text)||[...p.sources,...p.contextSources][0];assert.ok(target);assert.ok(source);
 const raw=compat?{batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[{id:target.id,status:'superseded',sourceIds:[source.id]}]}:
  {batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{retire:[{id:target.id,expectedVersion:version,lifecycle:'withdrawn',sourceIds:[source.id]}]}};
 return {request,p,raw,decoded:request.decode(raw)};
}
function recordFor(store,id){return store._memoryRecords(scope).find(record=>record.id===id);}

for(const compat of [false,true])test(`${compat?'compatibility':'normal'} retirement of a misclassified local preference never reasserts preference creation authority`,t=>{
 const {store,record,sourceId}=fixture(t,{local:true});
 const note=store.saveNote(scope,{text:'A derived copy of answer-specific feedback.',use:'discussion',evidenceSourceIds:[sourceId]});
 for(const id of [sourceId,'note:'+note.id]){
  const sourceIds=store.memorySources(scope).map(source=>source.id),read=store.readOriginalEvidence(scope,{sourceIds:[id],maxBytes:100000});
  const created=store.applyRelationshipPatch(scope,{claims:[{subject:'self',aspect:'stated_preference',text:'Always use concise wording.',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[id]}]},{...options(store),sourceIds,deliveredSources:read.sources});
  assert.equal(created.applied,false,'local feedback must still not create a recurring preference');
 }
 const batch=store.memoryBatch(scope),result=propose(batch,record,{compat});assert.equal(store.applyMemoryBatch(scope,batch,result.decoded).applied,true);
 const retired=recordFor(store,record.id);assert.notEqual(retired.status,'active');assert.equal(retired.kind,'preference');assert.equal(retired.text,record.text);assert.equal(store.memoryStatus(scope).semanticPending,0);assert.equal(store._memoryRecords(scope).some(row=>row.recordType==='claim'),false);assert.ok(store.getCompanion(scope).notes.some(item=>item.id===note.id));
});

test('recovery rejects stale target versions and missing, wrong-body, stale or foreign original delivery atomically',t=>{
 const {store,record}=fixture(t);drain(store);const batch=store.memoryBatch(scope),before=JSON.stringify(store.db.prepare('SELECT * FROM memory_journal ORDER BY seq').all());
 const badVersion=propose(batch,record,{version:record.version+1});assert.equal(store.applyMemoryBatch(scope,batch,badVersion.decoded).applied,false);
 const valid=propose(batch,record),proof=valid.decoded.originalDelivery;
 for(const originalDelivery of [[],proof.map(source=>({...source,text:'Not the captured body.'})),proof.map(source=>({...source,revision:'not-current'})),proof.map(source=>({...source,scope:{...scope,peerUid:'other-contact'}}))]){
  assert.equal(store.applyMemoryBatch(scope,batch,{...valid.decoded,originalDelivery}).applied,false);assert.equal(recordFor(store,record.id).version,record.version);assert.equal(recordFor(store,record.id).semanticReview.recoveryAttempt,undefined);assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM memory_journal ORDER BY seq').all()),before);
 }
 assert.throws(()=>valid.request.decode({...valid.raw,relationshipPatch:{retire:[{...valid.raw.relationshipPatch.retire[0],id:'m999'}]}}),error=>error.code==='unknown_memory_record_alias');
 assert.equal(store.applyMemoryBatch(scope,batch,valid.decoded).applied,true);assert.equal(store.applyMemoryBatch(scope,batch,valid.decoded).applied,false);
});

test('a source correction during recovery cannot commit a stale retirement or consume a rereview attempt',t=>{
 const {store,record,sourceId}=fixture(t);drain(store);const batch=store.memoryBatch(scope),result=propose(batch,record);store.updateTurn(scope,sourceId.slice(8),'The actual original has been corrected.');
 assert.equal(store.applyMemoryBatch(scope,batch,result.decoded).applied,false);assert.equal(recordFor(store,record.id),undefined);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_receipts WHERE batch_id=?').get(batch.id).n,0);assert.ok(store.memoryStatus(scope).pending>0);
});

test('no-decision recovery survives reopening and does not reset for clock, query or summary wording',t=>{
 const {store,filename,record,sourceId}=fixture(t);drain(store);const recovery=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,recovery,complete(recovery)).applied,true);
 const attempt=recordFor(store,record.id).semanticReview.recoveryAttempt;assert.ok(attempt?.key);
 store.appendTurn(scope,{role:'user',kind:'discussion',text:'An unrelated new question, not new evidence about the old event.'});const batch=store.memoryBatch(scope);
 assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{items:[{id:record.id,kind:'fact',text:'A differently phrased legacy navigation summary.',sourceIds:[sourceId]}]})).applied,true);
 assert.equal(recordFor(store,record.id).semanticReview.recoveryAttempt.key,attempt.key);assert.equal(store.memoryBatch(scope),null);
 const second=new Store(filename);try{second.maintainLocal(scope);assert.equal(second.memoryBatch(scope),null);assert.equal(second.memoryStatus(scope).recoveryDeferred,1);assert.equal(second.memoryStatus(scope).semanticPending,1);}finally{second.close();}
});

test('budget-excluded originals remain explicitly unread and do not exhaust another offered target',t=>{
 const {store,record,sourceId}=fixture(t,{body:'Complete fictional original. '.repeat(230)});drain(store);
 assert.equal(store.memoryBatch(scope,{maxBytes:4000}),null);let row=recordFor(store,record.id);assert.equal(row.semanticReview.recoveryAttempt,undefined);assert.equal(row.semanticReview.recoveryDeferred.reason,'original_set_exceeds_batch_budget');assert.equal(row.semanticReview.recoveryDeferred.readCoverage.complete,false);
 const pending=store.appendTurn(scope,{role:'user',kind:'discussion',text:'A small independent old-style navigation fact.'}),smallId='private:'+pending.id,batch=store.memoryBatch(scope);
 assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind:'fact',text:'A small legacy navigation row.',sourceIds:[smallId]}]})).applied,true);const small=store._memoryRecords(scope).find(item=>item.id!==record.id);
 const recovery=store.memoryBatch(scope,{maxBytes:4000});assert.ok(recovery);assert.deepEqual(recovery.recoveryTargets.map(target=>target.id),[small.id]);assert.equal(store.applyMemoryBatch(scope,recovery,complete(recovery)).applied,true);
 assert.equal(recordFor(store,record.id).semanticReview.recoveryAttempt,undefined);assert.ok(recordFor(store,small.id).semanticReview.recoveryAttempt);assert.equal(store.memoryStatus(scope).semanticPending,2);
 const restored=store.memoryBatch(scope,{maxBytes:24000});assert.ok(restored,'a genuinely larger existing budget can reconsider an unoffered target');assert.deepEqual(restored.recoveryTargets.map(target=>target.id),[record.id]);assert.ok(restored.sources.some(source=>source.id===sourceId));assert.ok(prepareMemoryRequest(settings,restored).bytes<=48000);
});

test('normal scheduled recovery uses the existing request budget once and remains unfinished without a timer loop',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-31T10:00:00Z')});const {store}=fixture(t);drain(store);let calls=0;
 const configured={...settings,auto:false,memoryIdleMs:1000,memoryBatchThreshold:100,memoryWindowRequests:1,realChatConsent:{...scope,baseUrl:settings.baseUrl,model:settings.model}};
 const controller=new Controller({store,settings:configured,compactionModel:null,read:async command=>command==='bind'?scope:{messages:[]},memoryModel:(settings,batch,signal)=>consolidateMemory(settings,batch,signal,async(_url,args)=>{
  calls++;const p=JSON.parse(JSON.parse(args.body).messages[1].content);assert.equal(p.review.purpose,'semantic_recovery');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({batchId:p.batchId,reviewedAll:true,relationshipPatch:{claims:[],events:[],retire:[]},episodes:[]})}}]}),{status:200});
 })});t.after(()=>controller.close());controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);assert.equal(calls,0);
 t.mock.timers.tick(2000);for(let n=0;n<20&&controller.memoryBusy;n++)await new Promise(setImmediate);
 assert.equal(calls,1);assert.equal(store.memoryStatus(scope).pending,0);assert.equal(store.memoryStatus(scope).semanticPending,1);assert.equal(store.memoryStatus(scope).recoveryReady,0);assert.equal(store.memoryStatus(scope).recoveryDeferred,1);assert.equal(controller.usage.maintenanceWindow(scope).requestsInWindow,1);
 assert.equal((await controller.maintainMemory()).status,'unfinished');controller.scheduleMemory(1);t.mock.timers.tick(3600000);await new Promise(setImmediate);assert.equal(calls,1,'no forced maintenance, HTTP retry or zero-delay recovery loop');
});

test('an impossible native serialized recovery request defers without HTTP, attempt consumption or repeated work',async t=>{
 const {store,record}=fixture(t);drain(store);const journal=store.db.prepare('SELECT * FROM memory_journal ORDER BY seq').all();let calls=0;
 const restricted={...settings,memoryInputBytes:8000};
 const model=async(_settings,batch)=>{calls++;return complete(batch);};
 const first=await maintainMemory({store,scope,settings:restricted,model,maxBatches:2});assert.equal(calls,0);assert.equal(first.status,'unfinished');assert.equal(first.semanticPending,1);assert.equal(first.recoveryReady,0);assert.equal(first.recoveryDeferred,1);
 const recordAfter=recordFor(store,record.id);assert.equal(recordAfter.semanticReview.recoveryAttempt,undefined);assert.ok(['original_set_exceeds_batch_budget','serialized_request_budget'].includes(recordAfter.semanticReview.recoveryDeferred.reason));
 const meta=store.memoryStatus(scope).version;const second=await maintainMemory({store,scope,settings:restricted,model,maxBatches:2});assert.equal(second.status,'unfinished');assert.equal(calls,0);assert.equal(store.memoryStatus(scope).version,meta);assert.deepEqual(store.db.prepare('SELECT * FROM memory_journal ORDER BY seq').all(),journal);
});

test('privacy-redacted necessary originals never consume a complete recovery attempt or invoke a recovery model',async t=>{
 const secret='sk-'+'x'.repeat(30),{store,record}=fixture(t,{body:'A fictional old report containing '+secret});drain(store);let calls=0;
 const result=await maintainMemory({store,scope,settings,model:async(_settings,batch)=>{calls++;return complete(batch);},maxBatches:2});
 assert.equal(calls,0);assert.equal(result.status,'unfinished');assert.equal(result.semanticPending,1);assert.equal(result.recoveryReady,0);assert.equal(result.recoveryDeferred,1);assert.equal(recordFor(store,record.id).semanticReview.recoveryAttempt,undefined);assert.equal(recordFor(store,record.id).semanticReview.recoveryDeferred.reason,'originals_redacted');
});

test('combined packet pressure cannot permanently defer a target that fits the unchanged native budget by itself',async t=>{
 const {store,record}=fixture(t,{body:'A small original.'});drain(store);
 const heavy=store.appendTurn(scope,{role:'user',kind:'discussion',text:'A complete fictional long original. '+'v'.repeat(19500)}),heavyId='private:'+heavy.id;
 const sourceBatch=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,sourceBatch,complete(sourceBatch,{items:[{kind:'fact',text:'A second old-style interpretation.',sourceIds:[heavyId]}]})).applied,true);
 const combined=store.memoryBatch(scope),targets=combined.recoveryTargets;assert.equal(targets.length,2,'both target closures fit the ordinary raw source budget');
 const one=target=>{const batch=structuredClone(combined),ids=new Set(target.sourceIds);batch.recoveryTargets=[target];batch.sources=batch.sources.filter(source=>ids.has(source.id));batch.reviewedSourceIds=batch.sources.map(source=>source.id);for(const field of Object.keys(batch.priorMemory))batch.priorMemory[field]=batch.priorMemory[field].filter(row=>row.id===target.id);return prepareMemoryRequest(settings,batch).bytes;};
 const largest=Math.max(...targets.map(one)),allBytes=prepareMemoryRequest(settings,combined).bytes;assert.ok(allBytes>largest+10);
 const limit=Math.floor((largest+allBytes)/2),seen=[];
 const result=await maintainMemory({store,scope,settings:{...settings,memoryInputBytes:limit},maxBatches:4,model:async(configured,batch)=>{assert.ok(prepareMemoryRequest(configured,batch).bytes<=limit);seen.push(...batch.recoveryTargets.map(target=>target.id));return complete(batch);}});
 assert.deepEqual(new Set(seen),new Set(targets.map(target=>target.id)));assert.equal(result.recoveryReady,0);assert.equal(result.semanticPending,2);assert.ok(recordFor(store,record.id).semanticReview.recoveryAttempt);assert.ok(recordFor(store,targets.find(target=>target.id!==record.id).id).semanticReview.recoveryAttempt);assert.equal(store.memoryStatus(scope).recoveryReasons.includes('original_set_exceeds_batch_budget'),false);
});

test('compatibility retirement preserves old evidence dates when a later human withdrawal supplies the retirement reason',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T10:00:00Z')});const {store,record}=fixture(t);drain(store);t.mock.timers.tick(5*86400000);
 const withdrawal=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Please withdraw the old interpretation; do not replace it with a new claim.'}),batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=packet(request),target=p.priorMemory.items.find(row=>row.text===record.text),source=p.sources.find(row=>row.text===withdrawal.text);
 const decoded=request.decode({batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[{id:target.id,status:'superseded',sourceIds:[source.id]}]});assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,true);
 const after=recordFor(store,record.id);assert.equal(after.firstEvidenceAt,record.firstEvidenceAt);assert.equal(after.lastEvidenceAt,record.lastEvidenceAt);assert.equal(after.at,record.at);assert.equal(after.reportedAt,record.reportedAt);assert.equal(after.semanticReview.reviewedAt,new Date().toISOString());
});
