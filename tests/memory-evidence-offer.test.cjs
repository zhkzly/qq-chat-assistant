'use strict';
// Zero-HTTP production Store/wire checks. Captured fictional proposals are
// evidence of the offered state, not of model identity choice or answer quality.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('../src/store.cjs');
const {prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const capture=require('./fixtures/memory-evidence-offer-025.json');
const settings={model:'offline-evidence-offer',memoryInputBytes:100000};
const originalId='qq:720575940379279370000027001';
const wire=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
function add(store,id,text,at){store.add(scope,[normalize(raw(id.slice(3),false,{msgTime:String(Date.parse(at)/1000),elements:[{textElement:{content:text}}]}),scope)]);}
function apply(store,batch,patch){const request=prepareMemoryRequest(settings,batch),input=wire(request);return store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[],...patch}}));}
function setup(t,{initial=capture.initial.relationshipPatch,question=capture.questionInput.sources[0].text,text=capture.initialInput.sources[0].text}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-01T10:41:00Z')});
 const store=new Store(':memory:');t.after(()=>store.close());add(store,originalId,text,'2026-09-01T10:30:00Z');
 assert.equal(apply(store,store.memoryBatch(scope),structuredClone(initial)).applied,true);
 const before=store.knowledgeDirectory(scope);t.mock.timers.tick(7*60000);
 store.appendTurn(scope,{id:'evidence-offer-question',role:'user',kind:'discussion',text:question});
 return {store,before,batch:store.memoryBatch(scope)};
}
function retain(name,value){const directory=process.env.QQ_EVIDENCE_OFFER_ARTIFACT_DIR;if(!directory)return;fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,name+'.json'),JSON.stringify({evidence:'zero-HTTP production Store/wire with fictional raw sources',http_attempts:0,semantic_evaluation:'not_run',capture_source_sha256:capture.sourceSha256,...value},null,2)+'\n');}
function assertOffer(store,batch,before){
 const request=prepareMemoryRequest(settings,batch),input=wire(request);
 retain('actual025-english-prestate',{batch,serialized_input:JSON.parse(request.serialized),before});
 assert.deepEqual(new Set(batch.priorMemory.claims.map(row=>row.id)),new Set(before.map(row=>row.id)),'both actual English rows must be offered regardless of Chinese query overlap');
 assert.deepEqual(input.priorMemory.claims.map(row=>[row.id,row.aspect,row.version]),[['m1','interest',1],['m2','recent_context',1]]);
 assert.deepEqual(input.contextSources.map(row=>[row.id,row.text]),[['c1',capture.initialInput.sources[0].text]]);
 assert.equal(input.priorMemory.claims.every(row=>row.originalsDelivered),true);assert.ok(batch.inputBytes<=batch.maxBytes);
 return {request,input};
}
test('actual025 English HTTP1 rows with empty topics are offered beside complete c1 for the actual Chinese question',t=>{
 const {store,batch,before}=setup(t);assert.equal(before.every(row=>row.topicKeys.length===0),true);assertOffer(store,batch,before);
});
for(const question of ['What do I reliably know about her routine and running?','下一步该怎么聊？','An unrelated navigation request.'])test('dependency offer does not depend on question wording: '+question,t=>{
 const {store,batch,before}=setup(t,{question});assertOffer(store,batch,before);
});
for(const question of ['What do I reliably know about her routine and running?','Unrelated request.'])test('Chinese empty-topic summaries are offered for independent English wording: '+question,t=>{
 const initial=structuredClone(capture.initial.relationshipPatch);initial.claims[0].text='她仍然喜欢跑步。';initial.claims[1].text='她说这周换班有点累，暂时没空跑步。';
 const {store,batch,before}=setup(t,{initial,question});assertOffer(store,batch,before);
});
test('explicit offered-ID reaffirm preserves two existing rows and original clocks',t=>{
 const {store,batch,before}=setup(t),{request,input}=assertOffer(store,batch,before);
 const claims=input.priorMemory.claims.map(row=>({id:row.id,expectedVersion:row.version,subject:row.subject,aspect:row.aspect,text:'A translated restatement.',assertionKind:row.assertionKind,epistemicStatus:row.epistemicStatus,applicabilityKind:row.applicabilityKind,attribution:row.attribution,sourceIds:['c1'],transition:{operation:'reaffirm',targets:[{id:row.id,expectedVersion:row.version}]}}));
 const result=store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims,events:[],retire:[]}}));assert.equal(result.applied,true,JSON.stringify(result));
 const after=store.knowledgeDirectory(scope);assert.equal(after.length,2);
 for(const old of before){const current=after.find(row=>row.id===old.id);assert.equal(current.version,2);for(const field of ['text','firstEvidenceAt','lastEvidenceAt','reportedAt','validFrom'])assert.equal(current[field],old[field],field);assert.deepEqual(current.sourceRevisions,old.sourceRevisions);}
 retain('explicit-id-reaffirm',{batch,input,result,before,after});
});
test('no-change leaves actual offered English records and their versions intact',t=>{
 const {store,batch,before}=setup(t);assert.equal(apply(store,batch,{}).applied,true);assert.deepEqual(store.knowledgeDirectory(scope),before);
});
test('a missed birthday from a completely reread old body is independent knowledge with the old source date',t=>{
 const text=capture.initialInput.sources[0].text+' 我的生日是五月六日。';
 const {store,batch,before}=setup(t,{text}),request=prepareMemoryRequest(settings,batch),input=wire(request);
 const result=store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{subject:'contact',aspect:'mutual_knowledge',text:'The contact states that her birthday is May 6.',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'unspecified',attribution:'speaker',sourceIds:['c1']}],events:[],retire:[]}}));
 assert.equal(result.applied,true,JSON.stringify(result));const after=store.knowledgeDirectory(scope),birthday=after.find(row=>row.aspect==='mutual_knowledge');assert.equal(after.length,before.length+1);assert.equal(birthday.lastEvidenceAt,'2026-09-01T10:30:00.000Z');assert.equal(birthday.reportedAt,birthday.lastEvidenceAt);assert.deepEqual(birthday.sourceIds,[originalId]);
 retain('new-missed-fact',{batch,input,result,before,after});
});
test('new independent event from an old complete report keeps report time and unknown occurrence time',t=>{
 const {store}=setup(t);assert.equal(apply(store,store.memoryBatch(scope),{}).applied,true);
 t.mock.timers.tick(86400000);store.appendTurn(scope,{id:'old-event-report',role:'user',kind:'discussion',text:'We visited an exhibition together before; I cannot remember when.'});assert.equal(apply(store,store.memoryBatch(scope),{}).applied,true);
 t.mock.timers.tick(86400000);store.appendTurn(scope,{id:'review-event-question',role:'user',kind:'discussion',text:'What shared experiences do we have?'});
 const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),input=wire(request),old=input.contextSources.find(row=>row.text.startsWith('We visited'));
 const result=store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[{activity:{ref:'NEW',definition:{sourceId:old.id,quote:'visited an exhibition together'}},activityKey:'past-exhibition',eventKind:'occurred',actor:'both',text:'The user reports a previous shared exhibition visit, date unknown.',sourceIds:[old.id],evidence:{statement:{sourceId:old.id,quote:old.text},time:{basis:'unknown'}}}],retire:[]}}));assert.equal(result.applied,true,JSON.stringify(result));
 const event=store.knowledgeDirectory(scope).find(row=>row.recordType==='relationship_event');assert.equal(event.reportedAt,'2026-09-02T10:48:00.000Z');assert.equal(event.occurredAt,null);assert.equal(event.origin,'user_report');
});
const persisted=store=>JSON.stringify(['memory_records','memory_journal','memory_receipts','memory_meta'].map(table=>store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));
const missedFact=()=>({subject:'contact',aspect:'mutual_knowledge',text:'The contact states that her birthday is May 6.',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'unspecified',attribution:'speaker',sourceIds:['c1']});
for(const [name,mutate]of [
 ['unread',value=>value.originalDelivery=value.originalDelivery.filter(source=>source.id!==originalId)],
 ['partial',value=>{const source=value.originalDelivery.find(source=>source.id===originalId),total=source.text.length;source.text=source.text.slice(0,-1);source.segment={offset:0,end:total-1,total};}],
 ['redacted',value=>value.originalDelivery.find(source=>source.id===originalId).redactedForModel=true],
 ['wrong body',value=>value.originalDelivery.find(source=>source.id===originalId).text='A body never supplied by this source'],
 ['stale revision',value=>value.originalDelivery.find(source=>source.id===originalId).revision='stale'],
 ['foreign contact',value=>value.originalDelivery.find(source=>source.id===originalId).scope.peerUin='foreign'],
 ['foreign account',value=>value.originalDelivery.find(source=>source.id===originalId).scope.accountUid='foreign']
])test('new old-source fact rejects '+name+' proof atomically',t=>{
 const {store,batch}=setup(t,{text:capture.initialInput.sources[0].text+' 我的生日是五月六日。'}),request=prepareMemoryRequest(settings,batch),input=wire(request),decoded=request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[missedFact()],events:[],retire:[]}});
 mutate(decoded);const before=persisted(store),result=store.applyMemoryBatch(scope,batch,decoded);assert.equal(result.applied,false,JSON.stringify(result));assert.equal(persisted(store),before);
});
test('adding an unrelated current question cannot license an incomplete old fact body',t=>{
 const {store,batch}=setup(t),request=prepareMemoryRequest(settings,batch),input=wire(request),proposal=missedFact();proposal.sourceIds.push('s1');
 const decoded=request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[proposal],events:[],retire:[]}}),source=decoded.originalDelivery.find(source=>source.id===originalId),total=source.text.length;
 source.text=source.text.slice(0,-1);source.segment={offset:0,end:total-1,total};const before=persisted(store);assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,false);assert.equal(persisted(store),before);
});
test('interleaved memory mutation rejects the old-source discovery snapshot by CAS',t=>{
 const {store,batch}=setup(t),request=prepareMemoryRequest(settings,batch),input=wire(request),decoded=request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[missedFact()],events:[],retire:[]}});
 const old=store.knowledgeDirectory(scope).find(row=>row.aspect==='interest'),sources=store.memorySources(scope),read=store.readOriginalEvidence(scope,{sourceIds:[originalId],maxBytes:100000});
 assert.equal(store.applyRelationshipPatch(scope,{claims:[{...capture.initial.relationshipPatch.claims[0],id:old.id,expectedVersion:old.version,text:'A separate committed interpretation update.',sourceIds:[originalId]}]},
  {baseRevision:store.getCompanion(scope).revision,baseMemoryVersion:store.relationshipView(scope).version,sourceIds:sources.map(row=>row.id),sourceRevisions:Object.fromEntries(sources.map(row=>[row.id,row.revision])),deliveredSources:read.sources}).applied,true);
 const before=persisted(store);assert.equal(store.applyMemoryBatch(scope,batch,decoded).reason,'stale_memory_version');assert.equal(persisted(store),before);
});
test('compatible distinct facts with the same source, subject and aspect coexist',t=>{
 const text='我喜欢跑步，也喜欢画画。',initial={claims:[{...capture.initial.relationshipPatch.claims[0],text:'The contact likes running.'}],events:[],retire:[]};
 const {store,batch,before}=setup(t,{text,initial}),request=prepareMemoryRequest(settings,batch),input=wire(request);
 assert.equal(store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{...initial.claims[0],text:'The contact likes drawing.',sourceIds:['c1']}],events:[],retire:[]}})).applied,true);
 const after=store.knowledgeDirectory(scope);assert.equal(after.length,2);assert.ok(after.find(row=>row.id===before[0].id&&row.text===before[0].text));assert.equal(after.every(row=>row.aspect==='interest'&&row.sourceIds[0]===originalId),true);
});
test('old rereview plus a September21 update commits one batch without forced question evidence',t=>{
 const {store,before}=setup(t);for(let day=2;day<=9;day++)add(store,'qq:7205759403792793700000270'+day,'今天路边的云还挺好看。',`2026-09-${String(day).padStart(2,'0')}T10:30:00Z`);
 add(store,'qq:720575940379279370000027021','最近恢复正常下班了，刚过去的周末又去跑了一次。','2026-09-21T10:30:00Z');t.mock.timers.tick(20*86400000);
 const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),input=wire(request),interest=input.priorMemory.claims.find(row=>row.aspect==='interest'),old=input.priorMemory.claims.find(row=>row.aspect==='recent_context');
 assert.ok(interest);assert.ok(old);assert.equal(input.sources.length,10);
 const result=store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[
  {...capture.initial.relationshipPatch.claims[0],id:interest.id,expectedVersion:interest.version,sourceIds:['c1'],transition:{operation:'reaffirm',targets:[{id:interest.id,expectedVersion:interest.version}]}},
  {...capture.initial.relationshipPatch.claims[1],id:old.id,expectedVersion:old.version,lifecycle:'superseded',sourceIds:['c1'],transition:{operation:'supersede',targets:[{id:old.id,expectedVersion:old.version}]}},
  {...capture.initial.relationshipPatch.claims[1],text:'She now reports returning to normal working hours.',sourceIds:['s10'],validFrom:'2026-09-21'}
 ],events:[{activity:{ref:'NEW',definition:{sourceId:'s10',quote:'跑了一次'}},activityKey:'running',eventKind:'occurred',actor:'contact',text:'She reports running last weekend; exact occurrence date is unknown.',sourceIds:['s10'],evidence:{statement:{sourceId:'s10',quote:input.sources.find(source=>source.id==='s10').text},time:{basis:'unknown'}}}],retire:[]}}));
 assert.equal(result.applied,true,JSON.stringify(result));assert.equal(store.memoryStatus(scope).pending,0);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_receipts').get().n,2);
 const after=store.knowledgeDirectory(scope),historical=after.find(row=>row.id===before.find(row=>row.aspect==='recent_context').id);assert.equal(historical.lifecycle,'superseded');assert.equal(historical.lastEvidenceAt,'2026-09-01T10:30:00.000Z');assert.equal(after.filter(row=>row.recordType==='relationship_event')[0].occurredAt,null);
 retain('mixed-old-review-new-update',{batch,input,result,before,after});
});
function inactive(t,{decisionLength=0,distinct=false}={}){
 const {store}=setup(t),before=store.knowledgeDirectory(scope).find(row=>row.aspect==='recent_context');
 assert.equal(apply(store,store.memoryBatch(scope),{}).applied,true);
 t.mock.timers.tick(20*86400000);const decision='qq:720575940379279370000027022';
 add(store,decision,'恢复正常下班了；先前暂停只适用于换班那周。'+'证'.repeat(decisionLength),'2026-09-21T10:30:00Z');
 const batch=store.memoryBatch(scope,{maxBytes:100000}),request=prepareMemoryRequest(settings,batch),input=wire(request),target=input.priorMemory.claims.find(row=>row.aspect==='recent_context');
 const result=store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{...capture.initial.relationshipPatch.claims[1],...(distinct?{text:'The contact reports returning to normal working hours.'}:{id:target.id,expectedVersion:target.version}),lifecycle:distinct?'active':'superseded',sourceIds:['s1'],transition:{operation:distinct?'change_over_time':'supersede',targets:[{id:target.id,expectedVersion:target.version}]}}],events:[],retire:[]}}));assert.equal(result.applied,true,JSON.stringify(result));
 t.mock.timers.tick(60000);store.appendTurn(scope,{id:'inactive-question',role:'user',kind:'discussion',text:'下一步该怎么聊？'});
 return {store,before,decision};
}
test('inactive target offer contains both canonical and decision originals; omitting decision proof cannot authorize an update',t=>{
 const {store,before,decision}=inactive(t),batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),input=wire(request),target=input.priorMemory.claims.find(row=>row.aspect==='recent_context');
 assert.equal(target.lifecycle,'superseded');assert.equal(target.updateAuthority,'requires_original_read_proof');assert.equal(target.decisionEvidence,'supplied');assert.equal(target.originalsDelivered,true);
 assert.ok(batch.contextSources.some(row=>row.id===originalId));assert.ok(batch.contextSources.some(row=>row.id===decision));assert.equal(JSON.stringify(input).includes('proposal'),false);
 const source=input.contextSources.find(row=>row.text===capture.initialInput.sources[0].text).id,decoded=request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[{id:target.id,expectedVersion:target.version,lifecycle:'withdrawn',sourceIds:[source]}]}});
 decoded.originalDelivery=decoded.originalDelivery.filter(row=>row.id!==decision);const snapshot=persisted(store);assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,false);assert.equal(persisted(store),snapshot);
 retain('inactive-decision-offer',{batch,input,before});
});
test('a direct distinct-successor edge supplies its canonical decision roots and missing proof is rejected',t=>{
 const {store,before,decision}=inactive(t,{distinct:true}),batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),input=wire(request),index=batch.priorMemory.claims.findIndex(row=>row.id===before.id),target=input.priorMemory.claims[index];
 assert.equal(target.lifecycle,'superseded');assert.equal(target.updateAuthority,'requires_original_read_proof');assert.equal(target.decisionEvidence,'supplied');assert.ok(target.decisionSourceIds.length);assert.ok(batch.contextSources.some(row=>row.id===decision));
 const source=input.contextSources.find(row=>row.text===capture.initialInput.sources[0].text).id,decoded=request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[{id:target.id,expectedVersion:target.version,lifecycle:'withdrawn',sourceIds:[source]}]}});
 decoded.originalDelivery=decoded.originalDelivery.filter(row=>row.id!==decision);const snapshot=persisted(store);assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,false);assert.equal(persisted(store),snapshot);
 store.forgetSource(scope,decision);const changed=store.memoryBatch(scope),after=wire(prepareMemoryRequest(settings,changed)),old=after.priorMemory.claims.find(row=>row.lifecycle==='superseded');assert.ok(old);assert.equal(old.updateAuthority,'read_only');assert.equal(old.decisionEvidence,'unavailable');assert.equal(JSON.stringify(after).includes('恢复正常下班了'),false);
 retain('direct-successor-decision',{batch,input,before,after});
});
test('withdrawn decision leaves read-only inactive awareness without its text or revival authority',t=>{
 const {store,before,decision}=inactive(t);store.forgetSource(scope,decision);
 const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),input=wire(request),target=input.priorMemory.claims.find(row=>row.aspect==='recent_context');
 assert.ok(target);assert.equal(target.lifecycle,'superseded');assert.equal(target.updateAuthority,'read_only');assert.equal(target.decisionEvidence,'unavailable');assert.equal(input.contextSources.some(row=>row.text.includes('先前暂停')),false);
 const source=input.contextSources.find(row=>row.text===capture.initialInput.sources[0].text).id;
 const result=store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{...capture.initial.relationshipPatch.claims[1],sourceIds:[source]}],events:[],retire:[]}}));assert.equal(result.applied,true,JSON.stringify(result));
 const after=store.knowledgeDirectory(scope);assert.equal(after.filter(row=>row.aspect==='recent_context'&&row.lifecycle==='active').length,0);assert.equal(after.find(row=>row.id===before.id).lifecycle,'superseded');
 retain('withdrawn-decision-awareness',{batch,input,before,after});
});
test('fresh direct support after a withdrawn decision can create a distinct current fact while old row stays inactive',t=>{
 const {store,before,decision}=inactive(t);store.forgetSource(scope,decision);t.mock.timers.tick(86400000);
 const fresh='qq:720575940379279370000027023';add(store,fresh,capture.initialInput.sources[0].text,'2026-09-22T10:30:00Z');
 const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),input=wire(request),source=input.sources.find(row=>row.text===capture.initialInput.sources[0].text),old=input.priorMemory.claims.find(row=>row.aspect==='recent_context');
 assert.equal(old.updateAuthority,'read_only');
 const result=store.applyMemoryBatch(scope,batch,request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{...capture.initial.relationshipPatch.claims[1],sourceIds:[source.id]}],events:[],retire:[]}}));assert.equal(result.applied,true,JSON.stringify(result));
 const after=store.knowledgeDirectory(scope),active=after.find(row=>row.aspect==='recent_context'&&row.lifecycle==='active');assert.ok(active);assert.notEqual(active.id,before.id);assert.deepEqual(active.sourceIds,[fresh]);assert.equal(active.lastEvidenceAt,'2026-09-22T10:30:00.000Z');assert.equal(after.find(row=>row.id===before.id).lifecycle,'superseded');
 retain('fresh-support-after-unavailable-decision',{batch,input,before,result,after});
});
test('target and all decision originals fit atomically at the byte boundary',t=>{
 const {store,decision}=inactive(t,{decisionLength:1200});
 let low=4000,high=30000;while(low<high){const mid=Math.floor((low+high)/2),batch=store.memoryBatch(scope,{maxBytes:mid}),target=batch.priorMemory.claims.find(row=>row.aspect==='recent_context');if(target&&!target.evidenceOffer)high=mid;else low=mid+1;}
 assert.ok(low>4000);const fit=store.memoryBatch(scope,{maxBytes:low}),short=store.memoryBatch(scope,{maxBytes:low-1});
 const target=fit.priorMemory.claims.find(row=>row.aspect==='recent_context');assert.ok(target&&!target.evidenceOffer);assert.ok(fit.contextSources.some(row=>row.id===decision));assert.ok(fit.contextSources.some(row=>row.id===originalId));assert.ok(fit.inputBytes+150<=low);
 const omitted=short.priorMemory.claims.find(row=>row.aspect==='recent_context');assert.ok(!omitted||omitted.evidenceOffer.authority==='read_only');assert.ok(short.inputBytes+150<=low-1);
 if(omitted){const request=prepareMemoryRequest(settings,short),input=wire(request),old=input.priorMemory.claims.find(row=>row.aspect==='recent_context');assert.equal(old.updateAuthority,'read_only');const decoded=request.decode({batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[{id:old.id,expectedVersion:old.version,lifecycle:'withdrawn',sourceIds:[input.sources[0].id]}]}});assert.equal(store.applyMemoryBatch(scope,short,decoded).applied,false);}
 retain('atomic-budget-boundary',{boundary:low,fit,short});
});
