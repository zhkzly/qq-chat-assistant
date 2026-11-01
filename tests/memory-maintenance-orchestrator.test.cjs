'use strict';
// Deterministic unit fixtures for the M5 maintenance orchestrator skeleton
// (src/memory/maintenance-orchestrator.cjs, greenfield design §2.4 / §4.1 M5).
// Covers pass planning, the expiry/applicability pass, withdrawal propagation,
// corruption protection (revision audit + quarantine-rate metric), correction
// integration (program-counted promotion candidates), single-flight/epoch
// guards, and the run-to-completion entry point over the gated engine.
// Fictional inputs and scripted model proposals only; no semantic-quality
// claim and no model/HTTP calls.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {scope,complete,addQQ,claim}=require('./fixtures/evidence-backed-memory.cjs');
const {normalize}=require('../src/messages.cjs');
const {createWriteGate,createGatedStore}=require('../src/memory/write-gate.cjs');
const {createMaintenanceOrchestrator}=require('../src/memory/maintenance-orchestrator.cjs');
const {maintainMemory}=require('../src/memory-engine.cjs');

const STABLE_DECLARATION='以后默认回复简短，不用表情；这只是我的表达偏好，不是要求她也这样。';
const CORRECTION='这轮表达太正式了，先接她说的，轻松一点。';
const misfiled=feedbackId=>({subject:'self',aspect:'stated_preference',text:'用户永远希望轻松一点的表达。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[feedbackId]});
const claimRows=store=>store.db.prepare("SELECT record FROM memory_records WHERE scope_key=? AND kind='claim'").all(store.scopeKey(scope)).map(row=>JSON.parse(row.record));
// Direct relationship patches need the delivered original bodies.
function grounded(store){
  const sources=store.memorySources(scope),read=store.readOriginalEvidence(scope,{sourceIds:sources.map(source=>source.id),maxBytes:100000});
  return {baseRevision:store.getCompanion(scope).revision,sourceIds:sources.map(source=>source.id),
    sourceRevisions:Object.fromEntries(sources.map(source=>[source.id,source.revision])),deliveredSources:read.sources};
}
// Append one feedback correction with a controlled source day (distinct
// episodes for the repetition counter) on a shared store.
function addCorrection(store,day,index){
  const answer=store.appendTurn(scope,{id:'answer-'+index,role:'assistant',kind:'discussion',text:'一份过于正式的参考表达。',requestId:'run-'+index});
  const feedback=store.addFeedback(scope,{text:CORRECTION,targetRef:{kind:'artifact',artifactRef:answer.artifactRef},clientEventId:'feedback-'+index});
  const row=store.db.prepare('SELECT record FROM experience_objects WHERE scope_key=? AND kind=? AND id=?').get(store.scopeKey(scope),'feedback',feedback.id);
  const record=JSON.parse(row.record);record.createdAt=day;
  store.db.prepare('UPDATE experience_objects SET record=? WHERE scope_key=? AND kind=? AND id=?').run(JSON.stringify(record),store.scopeKey(scope),'feedback',feedback.id);
  return feedback.sourceId;
}

test('plan schedules due passes deterministically from status and cadence',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const orchestrator=createMaintenanceOrchestrator({store,config:{corruptionEveryN:5}});
  const idle=orchestrator.plan(scope,{runIndex:2});
  assert.deepEqual(idle.passes.map(pass=>pass.kind),['expiry','withdrawal'],'an up-to-date scope without sources or overlays schedules only the recompute passes');
  store.appendTurn(scope,{id:'new-source',role:'user',kind:'discussion',text:'用户补充了新的情况。'});
  const active=orchestrator.plan(scope,{runIndex:2});
  assert.deepEqual(active.passes.map(pass=>pass.kind),['journal','expiry','withdrawal']);
  assert.equal(active.passes[0].reason,'pending_sources');
  assert.ok(orchestrator.plan(scope,{runIndex:5}).passes.some(pass=>pass.kind==='corruption_protection'&&pass.reason==='periodic_audit'),'every Nth run audits corruption protection');
  assert.ok(orchestrator.plan(scope,{runIndex:0}).passes.some(pass=>pass.kind==='corruption_protection'&&pass.reason==='initial_audit'));
  // A scoped overlay present in gate state adds the correction-integration pass.
  const gate=createWriteGate({store});
  const feedbackId=addCorrection(store,'2026-10-01T09:00:00.000Z',0);
  const batch=store.memoryBatch(scope);
  assert.equal(gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[misfiled(feedbackId)],events:[],retire:[]}})).applied,true);
  assert.equal(gate.listOverlays(scope).length,1);
  const withOverlay=createMaintenanceOrchestrator({store,gate,config:{corruptionEveryN:5}});
  assert.ok(withOverlay.plan(scope,{runIndex:2}).passes.some(pass=>pass.kind==='correction_integration'));
});

test('expiry pass flags stale dated understandings once, preserving original wording',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  addQQ(store,normalize,'720575940379279370000077001','上周她说这周开始倒班。',{at:'2026-09-01T10:00:00Z'});
  assert.equal(store.applyRelationshipPatch(scope,{claims:[claim('qq:720575940379279370000077001',{validUntil:'2026-09-05T00:00:00.000Z'})]},grounded(store)).applied,true);
  const orchestrator=createMaintenanceOrchestrator({store});
  const stale=orchestrator.staleUnderstandings(scope,{asOf:'2026-11-01T00:00:00.000Z'});
  assert.equal(stale.length,1);
  assert.equal(stale[0].interpretation,'needs_current_interpretation');
  const before=claimRows(store)[0];
  const first=orchestrator.expiryPass(scope,{asOf:'2026-11-01T00:00:00.000Z'});
  assert.deepEqual(first.flagged.map(entry=>entry.reason),['valid_until_passed']);
  assert.equal(first.changed,true);
  const flagged=claimRows(store)[0];
  assert.equal(flagged.text,before.text,'original wording preserved');
  assert.equal(flagged.semanticReview.needsCurrentInterpretation.reason,'valid_until_passed');
  const second=orchestrator.expiryPass(scope,{asOf:'2026-11-02T00:00:00.000Z'});
  assert.equal(second.changed,false);
  assert.equal(second.alreadyFlagged,1,'the flag is monotonic and never rewritten');
  // A not-yet-valid claim is listed without being destroyed.
  addQQ(store,normalize,'720575940379279370000077002','她说下周开始休假。',{at:'2026-09-02T10:00:00Z'});
  assert.equal(store.applyRelationshipPatch(scope,{claims:[claim('qq:720575940379279370000077002',{aspect:'recent_context',text:'休假安排尚未生效。',validFrom:'2099-01-01T00:00:00.000Z'})]},grounded(store)).applied,true);
  const future=orchestrator.staleUnderstandings(scope,{asOf:'2026-11-01T00:00:00.000Z'});
  assert.ok(future.some(entry=>entry.interpretation==='not_yet_valid'));
});

test('withdrawal pass rescopes active records whose evidence escaped cleanup, preserving wording',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  addQQ(store,normalize,'720575940379279370000078001','她说她喜欢爬山。',{at:'2026-09-01T10:00:00Z'});
  assert.equal(store.applyRelationshipPatch(scope,{claims:[claim('qq:720575940379279370000078001',{aspect:'interest',text:'The contact likes climbing.'})]},grounded(store)).applied,true);
  const before=claimRows(store)[0];
  // Simulate a legacy-path leak: the stored source revision no longer matches
  // the live source table while the derived record stayed active.
  store.db.prepare('UPDATE memory_sources SET revision=? WHERE scope_key=? AND source_id=?')
    .run('0000000000000000000000000000000000000000000000000000000000000000',store.scopeKey(scope),'qq:720575940379279370000078001');
  const orchestrator=createMaintenanceOrchestrator({store});
  const first=orchestrator.withdrawalPass(scope);
  assert.equal(first.flagged.length,1);
  assert.deepEqual(first.flagged[0].sources,['qq:720575940379279370000078001']);
  const after=claimRows(store)[0];
  assert.equal(after.text,before.text,'the original wording survives the rescope');
  assert.equal(after.semanticReview.evidenceRescope.to,'until_evidence');
  assert.equal(after.semanticReview.evidenceRescope.reason,'source_withdrawn_or_revised');
  const second=orchestrator.withdrawalPass(scope);
  assert.equal(second.changed,false,'the rescope flag is written once');
});

test('corruption pass reports stale derived rows and the quarantine-rate alert',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const gate=createWriteGate({store});
  const days=['2026-10-01T09:00:00.000Z','2026-10-04T09:00:00.000Z','2026-10-09T09:00:00.000Z'];
  days.forEach((day,index)=>{
    const feedbackId=addCorrection(store,day,index);
    const batch=store.memoryBatch(scope);
    assert.equal(gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[misfiled(feedbackId)],events:[],retire:[]}})).applied,true);
  });
  const orchestrator=createMaintenanceOrchestrator({store,gate});
  const audit=orchestrator.corruptionPass(scope);
  assert.ok(audit.quarantine.alert,'persistent misfiling raises the protocol alert');
  assert.equal(audit.quarantine.batches,3);
  assert.ok(audit.quarantine.rate>0.99,'all three batches were fully quarantined');
  assert.deepEqual(audit.staleDerived,[]);
  // A stale derived row (source revision changed underneath) is flagged for
  // semantic recovery, never silently kept.
  const feedbackId=addCorrection(store,'2026-10-12T09:00:00.000Z',3);
  const batch=store.memoryBatch(scope);
  assert.equal(gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[{subject:'self',aspect:'recent_context',text:'用户这轮想要短一点的表达。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'local',sourceIds:[feedbackId]}],events:[],retire:[]}})).applied,true);
  store.db.prepare('UPDATE memory_sources SET revision=? WHERE scope_key=? AND source_id=?')
    .run('0000000000000000000000000000000000000000000000000000000000000000',store.scopeKey(scope),feedbackId);
  const recheck=orchestrator.corruptionPass(scope);
  assert.ok(recheck.staleDerived.length>=1,'the stale derived row is reported');
  assert.ok(recheck.flagged.some(entry=>entry.id===recheck.staleDerived[0]));
  const flagged=claimRows(store).find(row=>row.id===recheck.staleDerived[0]);
  assert.equal(flagged.semanticReview.needsRevalidation.basis,'source_revision_mismatch');
});

test('correction integration files counted promotion candidates without activating them',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const gate=createWriteGate({store});
  const days=['2026-10-01T09:00:00.000Z','2026-10-04T09:00:00.000Z','2026-10-09T09:00:00.000Z'];
  days.forEach((day,index)=>{
    const feedbackId=addCorrection(store,day,index);
    const batch=store.memoryBatch(scope);
    assert.equal(gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[misfiled(feedbackId)],events:[],retire:[]}})).applied,true);
  });
  const orchestrator=createMaintenanceOrchestrator({store,gate});
  const pass=orchestrator.correctionIntegrationPass(scope);
  assert.equal(pass.filed.length,1,'three distinct-episode corrections file one candidate');
  assert.equal(pass.filed[0].basis,'repetition_count');
  assert.equal(pass.filed[0].text,CORRECTION,'the candidate text is the user own latest correction words');
  assert.equal(gate.listPreferences(scope).length,0,'counting never activates a preference');
  assert.ok(!claimRows(store).some(row=>row.applicabilityKind==='recurring'),'counting never writes durable knowledge');
  const again=orchestrator.correctionIntegrationPass(scope);
  assert.equal(again.filed.length,0,'filing is idempotent while the candidate is pending');
});

test('run is single-flight per scope and records epoch bounds without drift',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.appendTurn(scope,{id:'pending-source',role:'user',kind:'discussion',text:'用户补充了新的情况。'});
  let release;
  const journalResult=new Promise(resolve=>{release=()=>resolve({status:'complete',batches:1,pending:0});});
  const orchestrator=createMaintenanceOrchestrator({store,runMaintenance:()=>journalResult});
  const first=orchestrator.run(scope);
  const second=await orchestrator.run(scope);
  assert.equal(second.status,'already_running');
  release();
  const report=await first;
  assert.equal(report.status,'complete');
  assert.equal(report.epochDrift.length,0,'non-journal passes did not move the epoch');
  assert.equal(typeof report.epoch.start,'number');
  assert.equal(report.epoch.end,report.epoch.start,'a no-op expiry/withdrawal pass leaves the epoch unchanged');
});

test('runToCompletion drains the journal through the gated engine without touching gate receipts',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const declaration=store.appendTurn(scope,{id:'stable-declaration',role:'user',kind:'discussion',text:STABLE_DECLARATION});
  const declarationId='private:'+declaration.id;
  const answer=store.appendTurn(scope,{id:'assistant-answer',role:'assistant',kind:'discussion',text:'一份过于正式的参考表达。',requestId:'local-correction-run'});
  const feedback=store.addFeedback(scope,{text:CORRECTION,targetRef:{kind:'artifact',artifactRef:answer.artifactRef},clientEventId:'local-correction-feedback'});
  const gated=createGatedStore(store);
  const settings={model:'synthetic-replay-only',anonymous:true,baseUrl:'http://fixture.invalid/v1'};
  const model=async(_settings,batch)=>{
    if(batch.kind==='semantic_recovery')return {reviewedSourceIds:[...batch.reviewedSourceIds],items:[],episodes:[],retire:[]};
    const delivered=id=>batch.sources.some(source=>source.id===id&&!source.deleted);
    return {reviewedSourceIds:[...batch.reviewedSourceIds],items:[],episodes:[],retire:[],
      relationshipPatch:{claims:[
        ...(delivered(declarationId)?[{subject:'self',aspect:'stated_preference',text:'用户默认回复简短，不用表情。',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[declarationId]}]:[]),
        ...(delivered(feedback.sourceId)?[misfiled(feedback.sourceId)]:[])
      ],events:[],retire:[]}};
  };
  const orchestrator=createMaintenanceOrchestrator({store:gated,gate:gated.__writeGate,
    runMaintenance:options=>maintainMemory({...options,settings,model,maxBatches:4})});
  const result=await orchestrator.runToCompletion(scope);
  assert.ok(result.rounds.length>=1);
  assert.equal(result.status.pending,0,'the journal drained');
  const receiptsBefore=store.db.prepare('SELECT count(*) n FROM memory_receipts').get().n;
  await orchestrator.runToCompletion(scope);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_receipts').get().n,receiptsBefore,'maintenance passes never rewrite gate receipts');
  // Integration adaptation (M2 strict candidate channel): the model-proposed
  // recurring classification files as a candidate; the durable lane opens via
  // the user-attestation channel (resolvePreferenceUpgrade), as delivered by
  // the M2 storage stream and covered by preference-candidate-lifecycle tests.
  const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
  if(proposals.length)assert.equal(store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'}).applied,true);
  assert.ok(store.relationshipView(scope).claims.some(record=>record.applicabilityKind==='recurring'&&record.sourceIds.includes(declarationId)),'the attested stable preference persisted');
  assert.equal(gated.__writeGate.listOverlays(scope).length,1,'the correction was recorded as a scoped overlay');
  assert.ok(!store.relationshipView(scope).claims.some(record=>record.sourceIds.includes(feedback.sourceId)),'the misfiled promotion never became knowledge');
});
