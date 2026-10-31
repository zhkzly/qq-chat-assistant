'use strict';
// Captured fictional proposals exercise production persistence without HTTP.
// Passing checks establish transition contracts, not conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('../src/store.cjs');
const {prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const captured=require('./fixtures/memory-self-reaffirmation.json');
const settings={model:'offline-transition-check',memoryInputBytes:100000};
const originalId='qq:720575940379279370000025001';
const payload=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
function decode(request,result){return request.decode({...structuredClone(result),batchId:payload(request).batchId});}
function setup(t){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-01T10:41:00Z')});
 const store=new Store(':memory:');t.after(()=>store.close());
 store.add(scope,[normalize(raw(originalId.slice(3),false,{msgTime:String(Date.parse('2026-09-01T10:30:00Z')/1000),elements:[{textElement:{content:'这周换班有点累，暂时没空跑步，跑步还是喜欢的。'}}]}),scope)]);
 const initial=store.memoryBatch(scope),request=prepareMemoryRequest(settings,initial);
 assert.equal(store.applyMemoryBatch(scope,initial,decode(request,captured.initial)).applied,true);
 const before=store.relationshipView(scope).claims;
 t.mock.timers.tick(7*60000);
 store.appendTurn(scope,{id:'self-reaffirm-question',role:'user',kind:'discussion',text:'关于她现在的生活节奏和跑步，我目前可靠知道什么？'});
 const batch=store.memoryBatch(scope),prepared=prepareMemoryRequest(settings,batch),wire=payload(prepared);
 assert.deepEqual(wire.priorMemory.claims.map(row=>[row.id,row.aspect,row.version]),[['m1','interest',1],['m2','recent_context',1]],'captured alias prestate is reproduced');
 assert.deepEqual(wire.contextSources.map(row=>[row.id,row.text]),[['c1','这周换班有点累，暂时没空跑步，跑步还是喜欢的。']]);
 assert.notEqual(batch.kind,'semantic_recovery','captured failure is normal journal work');
 return {store,batch,prepared,before,wire};
}
function assertReaffirmed(store,before){
 const after=store.relationshipView(scope).claims;
 assert.equal(after.length,before.length,'reaffirmation does not invent a successor');
 for(const previous of before){
  const current=after.find(row=>row.id===previous.id);
  assert.ok(current);assert.equal(current.lifecycle,'active');assert.equal(current.version,previous.version+1);
  assert.equal(current.text,previous.text);assert.deepEqual(current.sourceIds,previous.sourceIds);
  assert.deepEqual(current.sourceRevisions,previous.sourceRevisions);
  for(const field of ['firstEvidenceAt','lastEvidenceAt','at','reportedAt','validFrom','validUntil','condition','applicabilityKind','attribution'])assert.equal(current[field],previous[field],field);
  assert.equal(current.transition.operation,'reaffirm');
  assert.deepEqual(current.transition.targets,[{id:previous.id,expectedVersion:previous.version}]);
  assert.equal(current.revisions.at(-1).version,previous.version);assert.equal(current.revisions.at(-1).operation,'reaffirm');
  assert.equal(current.semanticReview.coverage.complete,true);
  assert.equal(current.semanticSignature,previous.semanticSignature,'transition audit is not a new proposition');
 }
}
function persisted(store){
 return JSON.stringify(['memory_records','memory_journal','memory_receipts','memory_meta'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}
function retain(name,store,batch,prepared,before,decoded,applied){
 const directory=process.env.QQ_SELF_REAFFIRM_ARTIFACT_DIR;if(!directory)return;
 fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,name+'.json'),JSON.stringify({evidence:'zero-HTTP production Store/wire with captured fictional live proposals',semantic_evaluation:'not_run',http_attempts:0,capture_source_sha256:captured.sourceSha256,batch,actual_model_input:JSON.parse(prepared.serialized),decoded,applied,before,after:store.relationshipView(scope),status:store.memoryStatus(scope)},null,2)+'\n');
}
function grounded(store){
 const sources=store.memorySources(scope),read=store.readOriginalEvidence(scope,{sourceIds:sources.map(source=>source.id),maxBytes:100000});
 assert.equal(read.coverage.complete,true);
 return {baseRevision:store.getCompanion(scope).revision,baseMemoryVersion:store.relationshipView(scope).version,sourceIds:sources.map(source=>source.id),sourceRevisions:Object.fromEntries(sources.map(source=>[source.id,source.revision])),deliveredSources:read.sources};
}
function addContact(store,id,text,at){
 store.add(scope,[normalize(raw(id,false,{msgTime:String(Date.parse(at)/1000),elements:[{textElement:{content:text}}]}),scope)]);
}
test('captured HTTP4 outer-id self-reaffirms commit once through the actual memory wire and journal',t=>{
 const {store,batch,prepared,before}=setup(t);
 const decoded=decode(prepared,captured.reaffirm),result=store.applyMemoryBatch(scope,batch,decoded);
 retain('captured-http4',store,batch,prepared,before,decoded,result);
 assert.equal(result.applied,true,JSON.stringify(result));
 assertReaffirmed(store,before);
 assert.equal(store.memoryStatus(scope).pending,0);
 assert.equal(store.applyMemoryBatch(scope,batch,decode(prepared,captured.reaffirm)).reason,'already_reviewed');
});
test('reaffirm with no outer id resolves to the declared target instead of inventing a successor',t=>{
 const {store,batch,prepared,before}=setup(t),result=structuredClone(captured.reaffirm);
 for(const claim of result.relationshipPatch.claims){delete claim.id;delete claim.expectedVersion;}
 const applied=store.applyMemoryBatch(scope,batch,decode(prepared,result));
 assert.equal(applied.applied,true,JSON.stringify(applied));assertReaffirmed(store,before);
});
for(const sequence of [14,15])test(`captured HTTP${sequence} mixed reaffirm and explicit in-place supersession remain one atomic journal update`,t=>{
 const {store,before}=setup(t);
 for(let day=2;day<=9;day++)addContact(store,'7205759403792793700000250'+day,'今天路边的云还挺好看。',`2026-09-${String(day).padStart(2,'0')}T10:30:00Z`);
 addContact(store,'720575940379279370000025021','最近恢复正常下班了，刚过去的周末又去跑了一次。','2026-09-21T10:30:00Z');
 t.mock.timers.tick(20*86400000);
 const batch=store.memoryBatch(scope),prepared=prepareMemoryRequest(settings,batch),wire=payload(prepared);
 assert.equal(wire.sources.length,10);assert.equal(wire.contextSources[0].id,'c1');
 assert.deepEqual(wire.priorMemory.claims.map(row=>[row.id,row.aspect,row.version]),[['m1','interest',1],['m2','recent_context',1]]);
 const decoded=decode(prepared,captured['later'+sequence]),applied=store.applyMemoryBatch(scope,batch,decoded);
 retain('captured-http'+sequence,store,batch,prepared,before,decoded,applied);
 assert.equal(applied.applied,true,JSON.stringify(applied));
 const after=store.relationshipView(scope).claims,interest=after.find(row=>row.id===before.find(row=>row.aspect==='interest').id),historical=after.find(row=>row.id===before.find(row=>row.aspect==='recent_context').id);
 assert.equal(interest.lifecycle,'active');assert.equal(interest.version,2);assert.equal(interest.transition.operation,'reaffirm');
 assert.equal(historical.lifecycle,'superseded');assert.equal(historical.version,2);assert.equal(historical.transition.operation,'supersede');
 assert.equal(historical.text,before.find(row=>row.id===historical.id).text,'a historical revision preserves the original interpretation');
 assert.deepEqual(historical.sourceRevisions,before.find(row=>row.id===historical.id).sourceRevisions);
 assert.equal(historical.transition.proposal.text,captured['later'+sequence].relationshipPatch.claims[1].text,'proposed historical wording survives in audit');
 assert.equal(historical.lastEvidenceAt,before[0].lastEvidenceAt);assert.equal(interest.lastEvidenceAt,before[0].lastEvidenceAt);
 assert.equal(store.memoryStatus(scope).pending,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM memory_receipts').get().n,2,'the captured later batch commits one receipt');
});
for(const [name,mutate]of [
 ['stale outer version',row=>row.expectedVersion++],
 ['stale target version',row=>row.transition.targets[0].expectedVersion++],
 ['conflicting version without outer id',row=>{delete row.id;row.expectedVersion++;}],
 ['different target',row=>row.transition.targets[0].id='m2'],
 ['multiple reaffirm targets',row=>row.transition.targets.push({id:'m2',expectedVersion:1})],
 ['duplicate reaffirm targets',row=>row.transition.targets.push({...row.transition.targets[0]})],
 ['changed subject',row=>row.subject='self'],
 ['changed applicability',row=>row.applicabilityKind='temporary'],
 ['changed attribution',row=>row.attribution='user_report'],
 ['changed assertion',row=>row.assertionKind='reported'],
 ['changed certainty',row=>row.epistemicStatus='tentative'],
 ['changed validity',row=>row.validUntil='2026-10-01T00:00:00Z'],
 ['changed condition',row=>row.condition='Only in a new situation.'],
 ['changed lifecycle',row=>row.lifecycle='superseded'],
 ['competing updates',(_row,result)=>result.relationshipPatch.claims.push({...structuredClone(result.relationshipPatch.claims[0]),topicKeys:['other']})],
 ['self-target merge',row=>row.transition.operation='merge'],
 ['active self-target supersede',row=>row.transition.operation='supersede']
])test(`reaffirm rejects ${name} without advancing journal or writing partial records`,t=>{
 const {store,batch,prepared}=setup(t),result=structuredClone(captured.reaffirm);
 mutate(result.relationshipPatch.claims[0],result);
 const decoded=decode(prepared,result),before=persisted(store),applied=store.applyMemoryBatch(scope,batch,decoded);
 assert.equal(applied.applied,false,JSON.stringify(applied));assert.equal(persisted(store),before);
});
test('a reaffirm paraphrase is audited while the canonical proposition remains unchanged',t=>{
 const {store,batch,prepared,before}=setup(t),result=structuredClone(captured.reaffirm);
 result.relationshipPatch.claims[0].text='她依然表示喜欢跑步。';
 const applied=store.applyMemoryBatch(scope,batch,decode(prepared,result));assert.equal(applied.applied,true,JSON.stringify(applied));
 assertReaffirmed(store,before);
 const current=store.relationshipView(scope).claims.find(row=>row.aspect==='interest');
 assert.equal(current.transition.proposal.text,result.relationshipPatch.claims[0].text);
});
test('a later question can trigger reaffirmation without becoming new contact evidence or refreshing dates',t=>{
 const {store,batch,prepared,before}=setup(t),result=structuredClone(captured.reaffirm);
 for(const claim of result.relationshipPatch.claims)claim.sourceIds.push('s1');
 const applied=store.applyMemoryBatch(scope,batch,decode(prepared,result));assert.equal(applied.applied,true,JSON.stringify(applied));
 assertReaffirmed(store,before);
 assert.ok(store.relationshipView(scope).claims[0].transition.proposal.sourceIds.includes('private:self-reaffirm-question'));
});
test('additional contact corroboration advances source-backed evidence clocks after complete original reading',t=>{
 const {store,before}=setup(t),old=before.find(row=>row.aspect==='interest'),id='720575940379279370000025101';
 addContact(store,id,'跑步还是喜欢的。','2026-09-21T10:30:00Z');t.mock.timers.tick(20*86400000);
 const proposal={...captured.initial.relationshipPatch.claims.find(row=>row.aspect==='interest'),sourceIds:['qq:'+id],transition:{operation:'reaffirm',targets:[{id:old.id,expectedVersion:old.version}]}};
 const options=grounded(store),snapshot=persisted(store);
 const missing={...options,deliveredSources:options.deliveredSources.filter(source=>source.id!==originalId)};
 assert.equal(store.applyRelationshipPatch(scope,{claims:[proposal]},missing).applied,false);assert.equal(persisted(store),snapshot);
 const applied=store.applyRelationshipPatch(scope,{claims:[proposal]},options);assert.equal(applied.applied,true,JSON.stringify(applied));
 const current=store.relationshipView(scope).claims.find(row=>row.id===old.id);
 assert.equal(current.version,2);assert.equal(current.text,old.text);assert.deepEqual(current.sourceIds,[originalId,'qq:'+id]);
 assert.equal(current.firstEvidenceAt,old.firstEvidenceAt);assert.equal(current.lastEvidenceAt,'2026-09-21T10:30:00.000Z');assert.equal(current.reportedAt,current.lastEvidenceAt);
 assert.ok(current.sourceRevisions['qq:'+id]);
 assert.equal(current.semanticReview.coverage.complete,true);
});
test('a new user report advances report time without replacing the original fact validity',t=>{
 const {store}=setup(t),first=store.appendTurn(scope,{id:'reported-running-old',role:'user',kind:'discussion',text:'She told me she enjoys running.'}),oldId='private:'+first.id;
 const template={subject:'contact',aspect:'interest',text:'The user reports that the contact enjoys running.',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'unspecified',attribution:'user_report',sourceIds:[oldId],validFrom:'2026-09-01T10:48:00Z'};
 assert.equal(store.applyRelationshipPatch(scope,{claims:[template]},grounded(store)).applied,true);
 const old=store.relationshipView(scope).claims.find(row=>row.sourceIds.includes(oldId));t.mock.timers.tick(20*86400000);
 const latest=store.appendTurn(scope,{id:'reported-running-new',role:'user',kind:'discussion',text:'She told me again that she still enjoys running.'}),newId='private:'+latest.id;
 const result=store.applyRelationshipPatch(scope,{claims:[{...template,sourceIds:[newId],transition:{operation:'reaffirm',targets:[{id:old.id,expectedVersion:old.version}]}}]},grounded(store));
 assert.equal(result.applied,true,JSON.stringify(result));const after=store.relationshipView(scope).claims.find(row=>row.id===old.id);
 assert.deepEqual(after.sourceIds,[oldId,newId]);assert.equal(after.firstEvidenceAt,old.firstEvidenceAt);assert.equal(after.validFrom,old.validFrom);
 assert.equal(after.reportedAt,store.memorySources(scope).find(source=>source.id===newId).at);assert.equal(after.lastEvidenceAt,after.reportedAt);assert.notEqual(after.reviewedAt,old.reviewedAt);
});
for(const [name,mutate]of [
 ['missing original',result=>result.originalDelivery=result.originalDelivery.filter(source=>source.id!==originalId)],
 ['partial original',result=>{const source=result.originalDelivery.find(source=>source.id===originalId),total=source.text.length;source.text=source.text.slice(0,-1);source.segment={offset:0,end:total-1,total};}],
 ['stale original revision',result=>result.originalDelivery.find(source=>source.id===originalId).revision='changed-revision'],
 ['foreign contact original',result=>result.originalDelivery.find(source=>source.id===originalId).scope.peerUin='99999999999999999999'],
 ['foreign account original',result=>result.originalDelivery.find(source=>source.id===originalId).scope.accountUid='another-account']
])test(`reaffirm rejects ${name} with transaction state intact`,t=>{
 const {store,batch,prepared}=setup(t),result=decode(prepared,captured.reaffirm);mutate(result);
 const before=persisted(store),applied=store.applyMemoryBatch(scope,batch,result);
 assert.equal(applied.applied,false,JSON.stringify(applied));assert.equal(persisted(store),before);
});
test('an interleaved committed write invalidates the captured memory-version CAS',t=>{
 const {store,batch,prepared,before}=setup(t),claim=before[0];
 const changed=store.applyRelationshipPatch(scope,{claims:[{...captured.initial.relationshipPatch.claims.find(row=>row.aspect===claim.aspect),id:claim.id,expectedVersion:claim.version,sourceIds:[originalId],text:claim.text+' Revised.'}]},grounded(store));
 assert.equal(changed.applied,true,JSON.stringify(changed));const snapshot=persisted(store);
 assert.equal(store.applyMemoryBatch(scope,batch,decode(prepared,captured.reaffirm)).reason,'stale_memory_version');
 assert.equal(persisted(store),snapshot);
});
test('reaffirm cannot revive a superseded understanding',t=>{
 const {store,before}=setup(t),old=before.find(row=>row.aspect==='interest'),template=captured.initial.relationshipPatch.claims.find(row=>row.aspect==='interest');
 assert.equal(store.applyRelationshipPatch(scope,{retire:[{id:old.id,expectedVersion:old.version,lifecycle:'superseded',sourceIds:[originalId]}]},grounded(store)).applied,true);
 const current=store.relationshipView(scope).claims.find(row=>row.id===old.id),snapshot=persisted(store);
 assert.equal(store.applyRelationshipPatch(scope,{claims:[{...template,sourceIds:[originalId],transition:{operation:'reaffirm',targets:[{id:current.id,expectedVersion:current.version}]}}]},grounded(store)).applied,false);
 assert.equal(persisted(store),snapshot);
});
test('a distinct successor retires its declared predecessor while preserving another understanding',t=>{
 const {store,before}=setup(t),old=before.find(row=>row.aspect==='recent_context'),untouched=before.find(row=>row.aspect==='interest');
 const id='720575940379279370000025100';addContact(store,id,'现在已经恢复正常下班。','2026-09-21T10:30:00Z');
 const result=store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',text:'The contact reports a normal schedule now.',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',attribution:'speaker',sourceIds:['qq:'+id],transition:{operation:'change_over_time',targets:[{id:old.id,expectedVersion:old.version}]}}]},grounded(store));
 assert.equal(result.applied,true,JSON.stringify(result));const after=store.relationshipView(scope).claims;
 assert.equal(after.length,3);assert.equal(after.find(row=>row.id===untouched.id).version,untouched.version);
 const predecessor=after.find(row=>row.id===old.id),successor=after.find(row=>!before.some(prior=>prior.id===row.id));
 assert.equal(predecessor.lifecycle,'superseded');assert.equal(successor.lifecycle,'active');assert.equal(predecessor.transition.successorId,successor.id);assert.equal(successor.transition.operation,'change_over_time');
});
test('a distinct multi-target merge retains both predecessor histories and one active successor',t=>{
 const {store,before}=setup(t),targets=before.map(row=>({id:row.id,expectedVersion:row.version}));
 const proposal={subject:'contact',aspect:'recent_context',text:'The contact reported a temporary running pause while retaining her interest.',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'temporary',attribution:'speaker',sourceIds:[originalId],transition:{operation:'merge',targets}};
 const applied=store.applyRelationshipPatch(scope,{claims:[proposal]},grounded(store));assert.equal(applied.applied,true,JSON.stringify(applied));
 const after=store.relationshipView(scope).claims,successor=after.find(row=>row.lifecycle==='active');
 assert.equal(after.length,3);assert.ok(successor);assert.equal(successor.transition.operation,'merge');
 for(const target of targets){const predecessor=after.find(row=>row.id===target.id);assert.equal(predecessor.lifecycle,'superseded');assert.equal(predecessor.transition.successorId,successor.id);assert.equal(predecessor.revisions.at(-1).version,target.expectedVersion);}
});
test('a relationship event reaffirms in place without inventing its unknown occurrence time',t=>{
 const {store}=setup(t),report=store.appendTurn(scope,{id:'reaffirm-past-event',role:'user',kind:'discussion',text:'We went running together before, but I do not remember when.'}),id='private:'+report.id;
 const event={activityKey:'past-run',eventKind:'occurred',actor:'both',text:'The user reports a past shared run with an unknown date.',sourceIds:[id]};
 assert.equal(store.applyRelationshipPatch(scope,{events:[event]},grounded(store)).applied,true);
 const old=store.relationshipView(scope).events[0];t.mock.timers.tick(86400000);
 const result=store.applyRelationshipPatch(scope,{events:[{...event,transition:{operation:'reaffirm',targets:[{id:old.id,expectedVersion:old.version}]}}]},grounded(store));
 assert.equal(result.applied,true,JSON.stringify(result));const after=store.relationshipView(scope).events;
 assert.equal(after.length,1);assert.equal(after[0].id,old.id);assert.equal(after[0].version,old.version+1);assert.equal(after[0].occurredAt,null);assert.equal(after[0].occurrenceTimeStatus,'unknown');assert.equal(after[0].reportedAt,old.reportedAt);
});
test('a later event report cannot change the original QQ origin or occurrence clock',t=>{
 const {store}=setup(t),event={activityKey:'contact-run',eventKind:'occurred',actor:'contact',text:'The contact says she went running.',occurredAt:'2026-09-01T09:00:00Z',sourceIds:[originalId]};
 assert.equal(store.applyRelationshipPatch(scope,{events:[event]},grounded(store)).applied,true);
 const old=store.relationshipView(scope).events[0];t.mock.timers.tick(20*86400000);
 const report=store.appendTurn(scope,{id:'reported-original-run',role:'user',kind:'discussion',text:'She had mentioned that run earlier.'}),id='private:'+report.id;
 const result=store.applyRelationshipPatch(scope,{events:[{...event,sourceIds:[id],transition:{operation:'reaffirm',targets:[{id:old.id,expectedVersion:old.version}]}}]},grounded(store));
 assert.equal(result.applied,true,JSON.stringify(result));const after=store.relationshipView(scope).events[0];
 assert.equal(after.id,old.id);assert.equal(after.origin,'qq_observation');assert.equal(after.occurredAt,old.occurredAt);
 assert.equal(after.reportedAt,store.memorySources(scope).find(source=>source.id===id).at);
 const snapshot=persisted(store),changed=store.applyRelationshipPatch(scope,{events:[{...event,occurredAt:'2026-09-21T09:00:00Z',transition:{operation:'reaffirm',targets:[{id:after.id,expectedVersion:after.version}]}}]},grounded(store));
 assert.equal(changed.applied,false);assert.equal(persisted(store),snapshot);
});
