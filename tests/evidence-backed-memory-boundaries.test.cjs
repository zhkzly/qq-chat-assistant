'use strict';
// Functional evidence/admission tests use fictional inputs and scripted model
// proposals. They do not establish natural-language entailment or chat quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,complete,options,addQQ,claim}=require('./fixtures/evidence-backed-memory.cjs');
const user=(store,id,text)=>store.appendTurn(scope,{id,role:'user',kind:'discussion',text});
function app(t){const store=new Store(':memory:');t.after(()=>store.close());return store;}
function delivered(batch,id){
 const originals=Array.isArray(batch.originalEvidence)?batch.originalEvidence:batch.originalEvidence?.sources||[];
 return [...batch.sources,...batch.contextSources,...originals].find(s=>s.id===id&&!s.deleted);
}
function fullOriginal(source,original){return !!source&&source.revision===original.revision&&source.text===original.text&&(!source.segment||source.segment.offset===0&&source.segment.end===source.segment.total);}
function grounded(store,sourceIds,extra={}){
 const read=store.readOriginalEvidence(scope,{sourceIds,maxBytes:100000});
 assert.equal(read.coverage.complete,true,'the fixture requires complete actual originals');
 return options(store,{deliveredSources:read.sources,...extra});
}
function accepted(store,patch,sourceIds){const receipt=store.applyRelationshipPatch(scope,patch,grounded(store,sourceIds));assert.equal(receipt.applied,true,JSON.stringify(receipt));return receipt;}
function personRows(view){return ['self','contact','dyad'].flatMap(subject=>['knownFacts','recentCircumstances','uncertainties','boundaries'].flatMap(field=>view[subject]?.[field]||[]));}

test('an offered old memory cannot become a complete revised fact without delivery of its original evidence',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-01T10:00:00Z')});
 const store=app(t),old=user(store,'boundary-old','I liked the film exhibition last month.');
 let batch=store.memoryBatch(scope),oldId='private:'+old.id;
 assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind:'fact',text:'The user enjoyed a film exhibition.',sourceIds:[oldId],topicKeys:['film']}]})).applied,true);
 const original=store.memorySources(scope).find(s=>s.id===oldId);
 for(let i=0;i<8;i++){
  t.mock.timers.tick(60000);user(store,'filler-'+i,'A later unrelated conversation '+i+'.');
  batch=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,true);
 }
 t.mock.timers.tick(60000);const newest=user(store,'boundary-new','About the film exhibition, update that old understanding.');batch=store.memoryBatch(scope);
 const previous=batch.priorMemory.items.find(item=>item.sourceIds.includes(oldId));
 if(!previous)return; // A budgeted omission defers that old record.
 const applied=store.applyMemoryBatch(scope,batch,complete(batch,{items:[{id:previous.id,kind:'fact',text:'The user enjoyed that film exhibition.',sourceIds:[oldId,'private:'+newest.id],topicKeys:['film']}]}));
 if(applied.applied){
  const current=store.searchMemory(scope,'film').items.find(item=>item.id===previous.id);
  assert.ok(fullOriginal(delivered(batch,oldId),original)||current?.reviewComplete===false,
   'a summary/alias is not delivered original evidence and cannot attest complete revision');
 }
});

test('a reported past event without an occurrence date keeps occurrence unknown instead of copying the report clock',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-20T11:00:00Z')});
 const store=app(t),report=user(store,'unknown-occurrence','We tried pottery together before, but I do not remember the date.');
 const receipt=store.applyRelationshipPatch(scope,{events:[{activityKey:'past-pottery',eventKind:'occurred',actor:'both',text:'The user reports a past pottery activity with an unknown date.',sourceIds:['private:'+report.id]}]},grounded(store,['private:'+report.id]));
 assert.equal(receipt.applied,true,JSON.stringify(receipt));
 const event=store.relationshipView(scope).events.find(e=>e.activityKey==='past-pottery');
 assert.ok(event);assert.equal(event.occurredAt??null,null,'the report timestamp is not the unknown event timestamp');
 assert.equal(event.origin,'user_report');
 const source=store.memorySources(scope).find(s=>s.id==='private:'+report.id);
 assert.equal(event.lastEvidenceAt,source.at);
 assert.equal(event.reportedAt,source.at);assert.equal(event.occurrenceTimeStatus,'unknown');
 assert.equal(event.reviewedAt,new Date().toISOString());
});

test('a late report of an older acceptance cannot overwrite a later cancellation on the activity timeline',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-03T11:00:00Z')});
 const store=app(t),cancel=addQQ(store,normalize,'720575940379279370000023002','The October 10 visit is cancelled.',{at:'2026-10-03T10:00:00Z'}),cancelId='qq:'+cancel.messageId;
 accepted(store,{events:[{activityKey:'october-visit',eventKind:'cancellation',actor:'contact',text:'The contact cancelled the visit.',occurredAt:'2026-10-03T10:00:00Z',sourceIds:[cancelId]}]},[cancelId]);
 t.mock.timers.tick(2*86400000);const report=user(store,'late-acceptance','On October 1, the contact had accepted the October 10 visit.'),id='private:'+report.id;
 accepted(store,{events:[{activityKey:'october-visit',eventKind:'acceptance',actor:'contact',text:'The user reports an earlier acceptance.',occurredAt:'2026-10-01T10:00:00Z',sourceIds:[id]}]},[id]);
 const view=store.relationshipView(scope),event=view.events.find(row=>row.sourceIds.includes(id));
 assert.equal(event.occurredAt,'2026-10-01T10:00:00.000Z');assert.equal(event.reportedAt,'2026-10-05T11:00:00.000Z');
 assert.equal(view.activities.find(activity=>activity.activityKey==='october-visit').status,'cancelled');
});

test('withdrawing a cancellation source cannot turn an earlier acceptance into a renewed agreement',t=>{
 const store=app(t),accept=addQQ(store,normalize,'720575940379279370000023003','I accept the visit.',{at:'2026-10-01T10:00:00Z'}),cancel=addQQ(store,normalize,'720575940379279370000023004','The visit is cancelled.',{at:'2026-10-03T10:00:00Z'});
 const acceptId='qq:'+accept.messageId,cancelId='qq:'+cancel.messageId;
 accepted(store,{events:[{activityKey:'withdrawn-visit',eventKind:'acceptance',actor:'contact',text:'The contact accepted the visit.',occurredAt:'2026-10-01T10:00:00Z',sourceIds:[acceptId]},{activityKey:'withdrawn-visit',eventKind:'cancellation',actor:'contact',text:'The contact cancelled the visit.',occurredAt:'2026-10-03T10:00:00Z',sourceIds:[cancelId]}]},[acceptId,cancelId]);
 assert.equal(store.relationshipView(scope).activities[0].status,'cancelled');
 store.add(scope,[{...cancel,recalled:true,text:'[已撤回]'}]);store.add(scope,[cancel]);
 const view=store.relationshipView(scope);assert.equal(view.events.some(event=>event.sourceIds.includes(cancelId)),false,'withdrawn text is unavailable evidence');
 assert.notEqual(view.activities.find(activity=>activity.activityKey==='withdrawn-visit')?.status,'accepted','the evidence gap is not a new acceptance');
 assert.equal(store.memorySources(scope).some(source=>source.id===cancelId),false);
});

test('foreground semantic admission rejects reference-only, wrong-body and stale-revision evidence without writes',t=>{
 const store=app(t),report=user(store,'original-admission','The contact told me she enjoys ceramics.'),id='private:'+report.id;
 const proposal={claims:[claim(id,{aspect:'interest',text:'The user reports that the contact enjoys ceramics.'})]};
 const read=store.readOriginalEvidence(scope,{sourceIds:[id],maxBytes:100000});assert.equal(read.coverage.complete,true);
 const before=store.relationshipView(scope).claims;
 for(const deliveredSources of [[],read.sources.map(source=>({...source,text:'A replacement body never observed.'})),read.sources.map(source=>({...source,revision:'invented-revision'}))]){
  const result=store.applyRelationshipPatch(scope,proposal,options(store,{deliveredSources}));
  assert.equal(result.applied,false,JSON.stringify(result));assert.deepEqual(store.relationshipView(scope).claims,before);
 }
 accepted(store,proposal,[id]);
 assert.equal(store.relationshipView(scope).claims.length,1);
 const captured=grounded(store,[id]);store.updateTurn(scope,report.id,'Correction: the contact did not say that.');
 assert.equal(store.applyRelationshipPatch(scope,proposal,captured).applied,false);
 assert.equal(store.relationshipView(scope).claims.length,0);
});

test('original delivery is account/contact bound even if another scope has identical source text and identifiers',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-01T10:00:00Z')});
 const store=app(t),id='private:colliding-local-id',text='A fictional report with identical local bytes.';user(store,'colliding-local-id',text);
 const wrong=store.readOriginalEvidence(scope,{sourceIds:[id],maxBytes:100000});
 for(const field of ['accountUid','accountUin','peerUid','peerUin']){
  const other={...scope,[field]:'another-'+field};store.appendTurn(other,{id:'colliding-local-id',role:'user',kind:'discussion',text});
  const right=store.readOriginalEvidence(other,{sourceIds:[id],maxBytes:100000}),sources=store.memorySources(other),opts={baseRevision:store.getCompanion(other).revision,sourceIds:[id],sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision]))};
  const patch={claims:[claim(id,{text:'A reported fact for the selected contact.'})]};
  assert.equal(store.applyRelationshipPatch(other,patch,{...opts,deliveredSources:wrong.sources}).applied,false,'same-byte source aliases cannot cross '+field);
  assert.equal(store.relationshipView(other).claims.length,0);
  const applied=store.applyRelationshipPatch(other,patch,{...opts,deliveredSources:right.sources});assert.equal(applied.applied,true,JSON.stringify(applied));
 }
});

test('bounded original reads preserve exact character ranges and partial input cannot become a stable person fact',t=>{
 const store=app(t),body='Fictional original 😀 with quoted text. '.repeat(1000),source=user(store,'segmented-original',body),id='private:'+source.id;
 const read=store.readOriginalEvidence(scope,{sourceIds:[id],maxBytes:4000});
 assert.equal(read.coverage.complete,false);assert.ok(read.sources.length);
 const coverage=read.coverage.reads.find(entry=>entry.sourceId===id);assert.ok(coverage);
 assert.equal(coverage.total,body.length);assert.equal(coverage.complete,false);
 assert.equal(read.sources.find(s=>s.id===id).text,body.slice(coverage.start,coverage.end));
 const result=store.applyRelationshipPatch(scope,{claims:[claim(id,{subject:'self',aspect:'stated_preference',text:'The user has a recurring preference.',assertionKind:'stated',applicabilityKind:'recurring'})]},options(store,{deliveredSources:read.sources}));
 if(result.applied){
  const row=store.relationshipView(scope).claims[0];assert.equal(row.reviewComplete,false);
  assert.equal(row.evidenceValidity,'partial');assert.notEqual(row.applicability,'current');
  assert.equal(personRows(store.personUnderstanding(scope)).some(item=>item.id===row.id&&item.reviewComplete===true),false);
 }
});

test('derived-note provenance requires actual parent originals and preserves the source revision closure',t=>{
 const store=app(t),source=user(store,'provenance-parent','The contact described a temporary schedule change.'),id='private:'+source.id;
 const note=store.saveNote(scope,{text:'A short account of the temporary schedule.',use:'discussion',evidenceSourceIds:[id]}),noteId='note:'+note.id;
 const read=store.readOriginalEvidence(scope,{sourceIds:[noteId],maxBytes:100000});
 assert.ok(read.sources.some(source=>source.id===id),'a note does not replace the actual underlying source');
 const proposal={claims:[claim(noteId,{applicabilityKind:'temporary'})]};
 assert.equal(store.applyRelationshipPatch(scope,proposal,options(store,{deliveredSources:read.sources.filter(source=>source.id!==id)})).applied,false);
 accepted(store,proposal,[noteId]);
 const row=store.relationshipView(scope).claims[0];assert.ok(row.sourceRevisions[id]);
 store.updateTurn(scope,source.id,'The original report was corrected.');
 assert.equal(store.relationshipView(scope).claims.some(current=>current.id===row.id),false);
 assert.equal(personRows(store.personUnderstanding(scope)).some(current=>current.id===row.id),false);
});

test('a later question and review clock do not refresh a contact statement or extend its temporal validity',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-01T10:00:00Z')});
 const store=app(t),message=addQQ(store,normalize,'720575940379279370000023001','This week I am on evening shifts.');
 const id='qq:'+message.messageId,original=claim(id,{applicabilityKind:'temporary',validUntil:'2026-09-08T00:00:00Z'});
 accepted(store,{claims:[original]},[id]);const first=store.relationshipView(scope).claims[0];
 t.mock.timers.tick(20*86400000);const question=user(store,'clock-question','What is the contact doing now?'),questionId='private:'+question.id;
 const result=store.applyRelationshipPatch(scope,{claims:[{...original,id:first.id,expectedVersion:first.version,sourceIds:[id,questionId]}]},grounded(store,[id,questionId]));
 assert.equal(result.applied,true,JSON.stringify(result));
 const after=store.relationshipView(scope).claims.find(row=>row.id===first.id);
 assert.equal(after.lastEvidenceAt,first.lastEvidenceAt);assert.equal(after.validUntil,first.validUntil);assert.equal(after.applicability,'expired');
});

test('compatible interests coexist and an explicit versioned change retires only its declared target',t=>{
 const store=app(t),a=user(store,'interest-a','The contact enjoys ceramics.'),b=user(store,'interest-b','The contact enjoys mountain walks.');
 const aid='private:'+a.id,bid='private:'+b.id;
 accepted(store,{claims:[claim(aid,{aspect:'interest',text:'The contact enjoys ceramics.',applicabilityKind:'recurring'}),claim(bid,{aspect:'interest',text:'The contact enjoys mountain walks.',applicabilityKind:'recurring'})]},[aid,bid]);
 const before=store.relationshipView(scope).claims;assert.equal(before.length,2,'subject/aspect equality is not semantic identity');
 const ceramics=before.find(row=>row.sourceIds.includes(aid)),walks=before.find(row=>row.sourceIds.includes(bid));
 const next=user(store,'interest-change','The contact says she no longer enjoys ceramics.'),nextId='private:'+next.id;
 const proposal=claim(nextId,{aspect:'interest',text:'The contact no longer enjoys ceramics.',applicabilityKind:'recurring',transition:{operation:'change_over_time',targets:[{id:ceramics.id,expectedVersion:ceramics.version}]}});
 const stale=structuredClone(proposal);stale.transition.targets[0].expectedVersion++;
 assert.equal(store.applyRelationshipPatch(scope,{claims:[stale]},grounded(store,[aid,nextId])).applied,false);
 assert.deepEqual(store.relationshipView(scope).claims,before);
 accepted(store,{claims:[proposal]},[aid,nextId]);
 const after=store.relationshipView(scope).claims;
 assert.equal(after.find(row=>row.id===walks.id).lifecycle,'active');
 assert.notEqual(after.find(row=>row.id===ceramics.id).lifecycle,'active');
 assert.equal(after.filter(row=>row.lifecycle==='active').length,2);
});

test('semantic revisions cannot use an old target summary or new source alone as its original evidence',t=>{
 const store=app(t),old=user(store,'old-root','The contact reports temporary evening shifts.'),oldId='private:'+old.id;
 accepted(store,{claims:[claim(oldId,{applicabilityKind:'temporary'})]},[oldId]);
 const previous=store.relationshipView(scope).claims[0],newer=user(store,'new-root','The contact reports that her regular schedule resumed.'),newId='private:'+newer.id;
 const proposal={claims:[claim(newId,{text:'The contact reports a regular schedule now.',applicabilityKind:'temporary',transition:{operation:'change_over_time',targets:[{id:previous.id,expectedVersion:previous.version}]}})]};
 assert.equal(store.applyRelationshipPatch(scope,proposal,grounded(store,[newId])).applied,false,'all necessary target roots must be read again');
 accepted(store,proposal,[oldId,newId]);
});

test('local feedback cannot become a recurring preference through canonical or derived-note evidence',t=>{
 const store=app(t);store.saveRun(scope,{id:'local-feedback-run'});
 const feedback=store.addFeedback(scope,{requestId:'local-feedback-run',text:'For this answer, be shorter.',kind:'local'}),id='private:feedback-'+feedback.id;
 const note=store.saveNote(scope,{text:'A copy of this answer-specific feedback.',use:'discussion',evidenceSourceIds:[id]});
 for(const sourceId of [id,'note:'+note.id]){
  const result=store.applyRelationshipPatch(scope,{claims:[claim(sourceId,{subject:'self',aspect:'stated_preference',text:'The user always wants shorter replies.',assertionKind:'stated',applicabilityKind:'recurring'})]},grounded(store,[sourceId]));
  assert.equal(result.applied,false,JSON.stringify(result));
 }
 assert.equal(store.relationshipView(scope).claims.length,0);
});

test('conditional preference preserves its application condition in the read projection',t=>{
 const store=app(t),source=user(store,'conditional-preference','For work matters, show me the complete wording before an explanation; casual chat need not follow that.'),id='private:'+source.id;
 const conditional=claim(id,{subject:'self',aspect:'stated_preference',text:'For work matters the user prefers complete wording before an explanation.',assertionKind:'stated',applicabilityKind:'conditional',condition:'Only when communicating about work matters.'});
 const missingCondition={...conditional};delete missingCondition.condition;
 assert.equal(store.applyRelationshipPatch(scope,{claims:[missingCondition]},grounded(store,[id])).applied,false,'a declared conditional preference needs its condition');
 accepted(store,{claims:[conditional]},[id]);
 const stored=store.relationshipView(scope).claims[0];assert.equal(stored.applicabilityKind,'conditional');
 const projected=personRows(store.personUnderstanding(scope)).find(row=>row.id===stored.id);assert.ok(projected);assert.equal(projected.condition,stored.condition);assert.equal(projected.applicabilityKind,'conditional');
});

test('person understanding is rebuilt after correction, withdrawal and source deletion',t=>{
 const store=app(t),source=user(store,'projection-original','The contact told me about a current work project.'),id='private:'+source.id;
 accepted(store,{claims:[claim(id,{text:'The contact reports a current work project.',applicabilityKind:'temporary'})]},[id]);
 const old=store.relationshipView(scope).claims[0];assert.ok(personRows(store.personUnderstanding(scope)).some(row=>row.id===old.id));
 const corrected=store.correctRelationshipClaim(scope,{id:old.id,expectedVersion:old.version,operation:'correct',text:'The project belongs to her colleague, not the contact.'});assert.equal(corrected.applied,true,JSON.stringify(corrected));
 let rows=personRows(store.personUnderstanding(scope));assert.equal(rows.some(row=>row.id===old.id),false);assert.ok(rows.some(row=>row.id===corrected.claimId));
 const replacement=store.relationshipView(scope).claims.find(row=>row.id===corrected.claimId);
 assert.equal(store.correctRelationshipClaim(scope,{id:replacement.id,expectedVersion:replacement.version,operation:'withdraw'}).applied,true);
 rows=personRows(store.personUnderstanding(scope));assert.equal(rows.some(row=>row.id===replacement.id),false);
 store.forgetSource(scope,id);assert.equal(personRows(store.personUnderstanding(scope)).some(row=>row.sourceIds?.includes(id)),false);
 assert.equal(personRows(store.personUnderstanding({...scope,peerUid:'another-contact',peerUin:'another-uin'})).length,0);
});
