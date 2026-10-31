'use strict';
// Fictional zero-HTTP checks for inactive understanding and decision evidence.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const {Store}=require('../src/store.cjs');
const {prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const captured=require('./fixtures/memory-self-reaffirmation.json');
const settings={model:'offline-lifecycle-check',memoryInputBytes:100000};
const originalId='qq:720575940379279370000025201',decisionId='qq:720575940379279370000025202';
const originalText='这周换班有点累，暂时没空跑步，跑步还是喜欢的。';
const decisionText='恢复正常下班了；先前的暂停跑步只适用于换班那周。';
const proposalText='Historical proposal containing the now withdrawn decision detail.';
const snapshotPins={
 available:{logical:'9fced1bf9d323ce0ec53a5b1647ca2b04af556abda173ca44f834a29f3b963d5',source:'224ad624497aacc2ed3f56408ba6588f3319d9e8af416b2f2b3e8f6e1603cdca'},
 withdrawn:{logical:'f648810f39c45f85cad7a44dc0d5fcb8480f7507fa86f299504994fc4c23a2db',source:'946a98df72dc8da82c7eb4d9149d10f980f30b5922d8faeeecd3b739ed9ce533'}
};
const sha=value=>createHash('sha256').update(value).digest('hex');
const sqlName=value=>'"'+value.replaceAll('"','""')+'"';
function logicalSnapshot(db){
 const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
 const tables=schema.filter(row=>row.type==='table').map(table=>({name:table.name,columns:db.prepare('PRAGMA table_info('+sqlName(table.name)+')').all().map(column=>column.name),rows:db.prepare('SELECT rowid AS snapshot_rowid,* FROM '+sqlName(table.name)+' ORDER BY rowid').all()}));
 return {user_version:db.prepare('PRAGMA user_version').get().user_version,schema,tables,sequences:db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all()};
}
function restoreOldSnapshot(filename,label){
 const fixture=require('./fixtures/self-supersede-pre-review-'+label+'.json'),{snapshot,provenance,expected}=fixture;
 assert.equal(fixture.format,'qq-fictional-sqlite-logical-snapshot-v1');
 assert.equal(provenance.source_revision,'58858d2c44fffac0c75a2cb3183514246d80c389');assert.equal(provenance.source_backend_hash,'6843582469cd697db6aadc7c23c4595f8564ef1ea9971cd2cd4ce8a14733aeff');
 assert.equal(provenance.synthetic_only,true);assert.equal(provenance.http_attempts,0);
 assert.equal(provenance.logical_snapshot_sha256,snapshotPins[label].logical);assert.equal(sha(JSON.stringify(snapshot)),snapshotPins[label].logical);assert.equal(provenance.source_db_sha256,snapshotPins[label].source);
 assert.equal(JSON.stringify(fixture).includes('/tmp/'),false);assert.equal(JSON.stringify(fixture).includes('/home/'),false);
 const db=new DatabaseSync(filename);
 try{
  db.exec('BEGIN IMMEDIATE');
  for(const entry of snapshot.schema.filter(entry=>entry.type==='table'))db.exec(entry.sql);
  for(const table of snapshot.tables){
   const columns=['rowid',...table.columns],insert=db.prepare('INSERT INTO '+sqlName(table.name)+'('+columns.map(sqlName).join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
   for(const row of table.rows)insert.run(row.snapshot_rowid,...table.columns.map(column=>row[column]));
  }
  for(const entry of snapshot.schema.filter(entry=>entry.type!=='table'))db.exec(entry.sql);
  db.exec('DELETE FROM sqlite_sequence');for(const row of snapshot.sequences)db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name,row.seq);
  assert.equal(snapshot.user_version,2);db.exec('PRAGMA user_version=2; COMMIT');
  assert.equal(sha(JSON.stringify(logicalSnapshot(db))),snapshotPins[label].logical,'restored tables, schema, rowids and sequence must match the actual old database logically');
  // Inspect the old SQLite rows directly, before current Store can migrate or
  // repair anything. Expected view-only fields are not stored record fields.
  const row=db.prepare('SELECT scope_key,record FROM memory_records WHERE id=?').get(expected.record_id),historical=JSON.parse(row.record);
  const {retrievalScore,applicability,...expectedStored}=expected.historical;assert.deepEqual(historical,expectedStored);
  assert.equal(expected.before.id,expected.record_id);assert.equal(historical.id,expected.record_id);assert.equal(expected.original_id,originalId);assert.equal(expected.decision_id,decisionId);
  assert.equal(historical.lifecycle,'superseded');assert.equal(historical.version,2);assert.equal(historical.retiredSemanticSignatures,undefined);
  for(const field of ['sourceIds','sourceRevisions','evidenceValidity'])assert.equal(historical.transition[field],undefined,'old transition must lack '+field);
  assert.equal(historical.transition.proposal.text,proposalText);assert.deepEqual(historical.transition.proposal.sourceIds,[decisionId]);
  assert.equal(historical.revisions.find(revision=>revision.version===expected.before.version).semanticSignature,expected.before.semanticSignature);
  for(const field of ['firstEvidenceAt','lastEvidenceAt','at','reportedAt'])assert.equal(historical[field],expected.before[field]);
  assert.deepEqual(historical.sourceIds,expected.before.sourceIds);assert.deepEqual(historical.sourceRevisions,expected.before.sourceRevisions);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_dependencies WHERE scope_key=? AND id=? AND source_id=?').get(row.scope_key,historical.id,decisionId).n,0,'pre-fix decision dependency really is absent');
  const decision=db.prepare('SELECT deleted FROM memory_sources WHERE scope_key=? AND source_id=?').get(row.scope_key,decisionId);
  assert.equal(decision.deleted,label==='withdrawn'?1:0);assert.equal(expected.withdraw_before_upgrade,label==='withdrawn');
 }finally{db.close();}
 return {fixture,loaded_db_sha256:sha(fs.readFileSync(filename))};
}
const wire=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
function add(store,id,text,at){store.add(scope,[normalize(raw(id.slice(3),false,{msgTime:String(Date.parse(at)/1000),elements:[{textElement:{content:text}}]}),scope)]);}
function applyWire(store,make){
 const batch=store.memoryBatch(scope,{maxBytes:100000}),request=prepareMemoryRequest(settings,batch),input=wire(request);
 const output={batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[],...make(input,batch)}};
 const result=store.applyMemoryBatch(scope,batch,request.decode(output));assert.equal(result.applied,true,JSON.stringify(result));
 return {batch,input,output,result};
}
function alias(input,id,batch){
 const source=[...batch.sources,...batch.contextSources].find(source=>source.id===id);assert.ok(source);
 return [...input.sources,...input.contextSources].find(value=>value.text===source.text).id;
}
function setup(t,{privateDecision=false}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-01T10:41:00Z')});
 const store=new Store(':memory:');t.after(()=>store.close());
 add(store,originalId,originalText,'2026-09-01T10:30:00Z');
 applyWire(store,()=>structuredClone(captured.initial.relationshipPatch));
 const before=store.relationshipView(scope).claims.find(row=>row.aspect==='recent_context');
 t.mock.timers.tick(20*86400000);
 let decision=decisionId;
 if(privateDecision){store.appendTurn(scope,{id:'self-supersede-decision',role:'user',kind:'discussion',text:decisionText});decision='private:self-supersede-decision';}
 else add(store,decisionId,decisionText,'2026-09-21T10:30:00Z');
 const applied=applyWire(store,(input,batch)=>{
  const prior=input.priorMemory.claims.find(row=>row.aspect==='recent_context');
  return {claims:[{...structuredClone(captured.later14.relationshipPatch.claims[1]),id:prior.id,expectedVersion:prior.version,text:proposalText,
   sourceIds:[alias(input,decision,batch)],transition:{operation:'supersede',targets:[{id:prior.id,expectedVersion:prior.version}]}}]};
 });
 return {store,before,decision,applied};
}
function reindexOriginal(store){
 store.db.prepare('UPDATE memory_meta SET processor_version=NULL WHERE scope_key=?').run(store.scopeKey(scope));
 return applyWire(store,(input,batch)=>({claims:[{...structuredClone(captured.initial.relationshipPatch.claims.find(row=>row.aspect==='recent_context')),
  sourceIds:[alias(input,originalId,batch)]}]}));
}
function assertCanonical(current,before){
 for(const field of ['id','text','subject','aspect','assertionKind','epistemicStatus','applicabilityKind','attribution','condition','validFrom','validUntil','firstEvidenceAt','lastEvidenceAt','at','reportedAt'])assert.equal(current[field],before[field],field);
 assert.deepEqual(current.sourceIds,before.sourceIds);assert.deepEqual(current.sourceRevisions,before.sourceRevisions);
 assert.equal(current.lifecycle,'superseded');
}
function retain(name,value){
 if(!process.env.QQ_SELF_SUPERSEDE_ARTIFACT_DIR)return;
 fs.mkdirSync(process.env.QQ_SELF_SUPERSEDE_ARTIFACT_DIR,{recursive:true});
 fs.writeFileSync(path.join(process.env.QQ_SELF_SUPERSEDE_ARTIFACT_DIR,name+'.json'),JSON.stringify({evidence:'zero-HTTP production Store and wire; fictional sources',http_attempts:0,semantic_evaluation:'not_run',...value},null,2)+'\n');
}
test('self-superseded original cannot revive through idless transitionless normal-wire reindex',t=>{
 const {store,before}=setup(t),historical=store.relationshipView(scope).claims.find(row=>row.id===before.id);
 assertCanonical(historical,before);const replay=reindexOriginal(store),after=store.relationshipView(scope);
 retain('reindex-retirement-barrier',{before,historical,replay,after});
 assert.equal(after.claims.filter(row=>row.aspect==='recent_context'&&row.lifecycle==='active').length,0);
 assert.equal(after.claims.length,2);assert.ok(after.claims.find(row=>row.id===before.id).retiredSemanticSignatures.includes(before.semanticSignature));
});
test('new direct support can establish a new understanding after self-supersession without changing old fact clocks',t=>{
 const {store,before}=setup(t);t.mock.timers.tick(86400000);
 const id='qq:720575940379279370000025203';add(store,id,originalText,'2026-09-22T10:30:00Z');
 const applied=applyWire(store,(input,batch)=>{
  const old=input.priorMemory.claims.find(row=>row.aspect==='recent_context');assert.ok(old);
  return {claims:[{...structuredClone(captured.initial.relationshipPatch.claims.find(row=>row.aspect==='recent_context')),sourceIds:[alias(input,id,batch)],transition:{operation:'change_over_time',targets:[{id:old.id,expectedVersion:old.version}]}}]};
 });
 const after=store.relationshipView(scope),current=after.claims.find(row=>row.aspect==='recent_context'&&row.lifecycle==='active');
 assert.ok(current);assert.notEqual(current.id,before.id);assert.deepEqual(current.sourceIds,[id]);assert.equal(current.lastEvidenceAt,'2026-09-22T10:30:00.000Z');
 assertCanonical(after.claims.find(row=>row.id===before.id),before);retain('new-direct-support',{before,applied,after});
});
test('a later question plus the old original cannot bypass the retired signature or freshen evidence clocks',t=>{
 const {store,before}=setup(t);t.mock.timers.tick(86400000);store.appendTurn(scope,{id:'self-supersede-later-question',role:'user',kind:'discussion',text:'关于她换班那周的情况，原来知道什么？'});
 applyWire(store,(input,batch)=>({claims:[{...structuredClone(captured.initial.relationshipPatch.claims.find(row=>row.aspect==='recent_context')),
  sourceIds:[alias(input,originalId,batch),alias(input,'private:self-supersede-later-question',batch)]}]}));
 const after=store.relationshipView(scope);assert.equal(after.claims.filter(row=>row.aspect==='recent_context'&&row.lifecycle==='active').length,0);assertCanonical(after.claims.find(row=>row.id===before.id),before);
});
test('self-supersede decision dependencies use their own revisions and leave fact provenance unchanged',t=>{
 const {store,before,decision}=setup(t),current=store.relationshipView(scope).claims.find(row=>row.id===before.id);
 assertCanonical(current,before);assert.deepEqual(current.transition.sourceIds,[decision]);
 const revision=store.memorySources(scope).find(source=>source.id===decision).revision;
 assert.equal(current.transition.sourceRevisions[decision],revision);assert.equal(current.transition.evidenceValidity,'valid');
 const indexed=store.db.prepare('SELECT source_id,revision FROM memory_dependencies WHERE scope_key=? AND id=? ORDER BY source_id').all(store.scopeKey(scope),before.id);
 assert.deepEqual(indexed.map(row=>[row.source_id,row.revision]).sort(),[[originalId,before.sourceRevisions[originalId]],[decision,revision]].sort());
});
for(const mode of ['edit','forget','recall'])test(`${mode} of self-supersede decision marks the inactive reason uncertain and purges proposal text`,t=>{
 const {store,before,decision}=setup(t,{privateDecision:mode!=='recall'});
 if(mode==='edit')store.updateTurn(scope,decision.slice(8),'Correction: I do not know whether her schedule recovered.');
 if(mode==='forget')store.forgetSource(scope,decision);
 if(mode==='recall'){const message=store.messages(scope).find(message=>'qq:'+message.messageId===decision);store.add(scope,[{...message,recalled:true,text:'[已撤回]'}]);}
 store.memorySources(scope);const after=store.relationshipView(scope),current=after.claims.find(row=>row.id===before.id);
 assert.ok(current,'canonical inactive fact and opaque retirement barrier survive decision-only invalidation');assertCanonical(current,before);
 assert.equal(current.reviewComplete,false);assert.equal(current.semanticReview.status,'inactive_decision_needs_review');assert.equal(current.transition.evidenceValidity,'unavailable');assert.equal(current.transition.proposal,undefined);
 assert.ok(current.retiredSemanticSignatures.includes(before.semanticSignature));
 const exposed={view:after,directory:store.knowledgeDirectory(scope),batch:store.memoryBatch(scope,{maxBytes:100000})};
 assert.equal(JSON.stringify(exposed).includes(proposalText),false);assert.equal(JSON.stringify(exposed).includes(decisionText),false);
 assert.equal(store.personUnderstanding(scope).contact.recentCircumstances.some(row=>row.id===before.id),false);
 reindexOriginal(store);assert.equal(store.relationshipView(scope).claims.some(row=>row.aspect==='recent_context'&&row.lifecycle==='active'),false);
 retain('decision-'+mode,{before,after,exposed});
});
test('withdrawing shared fact and decision support removes the canonical body through ordinary invalidation',t=>{
 const {store,before}=setup(t);store.forgetSource(scope,originalId);
 assert.equal(store.relationshipView(scope).claims.some(row=>row.id===before.id),false);
 assert.equal(JSON.stringify(store.knowledgeDirectory(scope)).includes(before.text),false);
});
test('decision original revision, scope, complete body and memory CAS remain mandatory',t=>{
 const {store,before}=setup(t);store.appendTurn(scope,{id:'decision-recheck',role:'user',kind:'discussion',text:decisionText});
 const batch=store.memoryBatch(scope,{maxBytes:100000}),request=prepareMemoryRequest(settings,batch),input=wire(request),old=input.priorMemory.claims.find(row=>row.aspect==='recent_context');
 const output={batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{...captured.later14.relationshipPatch.claims[1],id:old.id,expectedVersion:old.version,sourceIds:[alias(input,'private:decision-recheck',batch)],transition:{operation:'supersede',targets:[{id:old.id,expectedVersion:old.version}]}}],events:[],retire:[]}};
 for(const mutate of [value=>value.originalDelivery.find(source=>source.id==='private:decision-recheck').revision='stale',value=>value.originalDelivery.find(source=>source.id==='private:decision-recheck').scope.peerUin='foreign',value=>value.originalDelivery=value.originalDelivery.filter(source=>source.id!=='private:decision-recheck')]){
  const decoded=request.decode(structuredClone(output));mutate(decoded);const snapshot=JSON.stringify(store.knowledgeDirectory(scope));assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,false);assert.equal(JSON.stringify(store.knowledgeDirectory(scope)),snapshot);
 }
 const current=store.relationshipView(scope).claims.find(row=>row.id===before.id);assert.equal(current.version,2);
 const sources=store.memorySources(scope),read=store.readOriginalEvidence(scope,{sourceIds:sources.map(source=>source.id),maxBytes:100000}),interest=store.relationshipView(scope).claims.find(row=>row.aspect==='interest');
 const changed=store.applyRelationshipPatch(scope,{claims:[{...captured.initial.relationshipPatch.claims.find(row=>row.aspect==='interest'),id:interest.id,expectedVersion:interest.version,sourceIds:[originalId],text:'Revised canonical interest description.'}]},
  {baseRevision:store.getCompanion(scope).revision,baseMemoryVersion:store.relationshipView(scope).version,sourceIds:sources.map(source=>source.id),sourceRevisions:Object.fromEntries(sources.map(source=>[source.id,source.revision])),deliveredSources:read.sources});
 assert.equal(changed.applied,true,JSON.stringify(changed));assert.equal(store.applyMemoryBatch(scope,batch,request.decode(structuredClone(output))).reason,'stale_memory_version');
});
test('portable frozen old snapshots preserve logical state before any candidate Store is opened',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-self-supersede-snapshot-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 for(const label of ['available','withdrawn']){
  const restored=restoreOldSnapshot(path.join(directory,label+'.db'),label);
  retain('portable-old-state-'+label,{provenance:restored.fixture.provenance,expected:restored.fixture.expected,loaded_db_sha256:restored.loaded_db_sha256,logical_state:'exact_snapshot_match_before_candidate_Store'});
 }
});
for(const withdrawBeforeUpgrade of [false,true])test(`frozen pre-review Store database upgrades safely with decision ${withdrawBeforeUpgrade?'already withdrawn':'still available'}`,t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-self-supersede-baseline-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const filename=path.join(directory,'baseline-restored.db'),label=withdrawBeforeUpgrade?'withdrawn':'available',restored=restoreOldSnapshot(filename,label);
 const created={before:restored.fixture.expected.before,historical:restored.fixture.expected.historical,decisionId:restored.fixture.expected.decision_id,withdrawBeforeUpgrade};
 const artifactDirectory=process.env.QQ_SELF_SUPERSEDE_ARTIFACT_DIR;
 if(artifactDirectory){fs.mkdirSync(artifactDirectory,{recursive:true});fs.copyFileSync(filename,path.join(artifactDirectory,'baseline-'+label+'.db'));}
 const store=new Store(filename);t.after(()=>store.close());
 // This is the first candidate public read; do not pre-sync or overwrite the
 // baseline-created row before checking legacy proposal privacy.
 const migrated=store.relationshipView(scope).claims.find(row=>row.id===created.before.id);assert.ok(migrated);assertCanonical(migrated,created.before);
 assert.ok(migrated.retiredSemanticSignatures.includes(created.before.semanticSignature));
 if(!withdrawBeforeUpgrade){
  assert.equal(migrated.transition.evidenceValidity,'valid');assert.ok(store.db.prepare('SELECT 1 FROM memory_dependencies WHERE scope_key=? AND id=? AND source_id=?').get(store.scopeKey(scope),created.before.id,decisionId));
  store.forgetSource(scope,decisionId);
 }
 const after=store.relationshipView(scope),current=after.claims.find(row=>row.id===created.before.id);
 assertCanonical(current,created.before);assert.equal(current.transition.evidenceValidity,'unavailable');assert.equal(current.transition.proposal,undefined);
 assert.equal(JSON.stringify({after,directory:store.knowledgeDirectory(scope)}).includes(proposalText),false);
 reindexOriginal(store);assert.equal(store.relationshipView(scope).claims.some(row=>row.aspect==='recent_context'&&row.lifecycle==='active'),false);
 if(artifactDirectory)fs.copyFileSync(filename,path.join(artifactDirectory,'upgraded-'+label+'.db'));
 retain('baseline-upgrade-'+label,{provenance:restored.fixture.provenance,loaded_db_sha256:restored.loaded_db_sha256,created,migrated,after});
});
