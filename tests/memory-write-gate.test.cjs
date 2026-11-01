'use strict';
// Deterministic unit fixtures for the M3 decision-split write gate
// (src/memory/write-gate.cjs, greenfield design §2.2 / §4.3 MW1).
// Required coverage:
//   - the B1 same-shape scenario passes (a local correction misfiled as a
//     stable preference no longer jams the review journal),
//   - per-record isolation receipts for quarantined records,
//   - the counterexample: attested stable preferences persist unregressed.
// Fictional inputs and scripted model proposals only; no semantic-quality
// claim and no model/HTTP calls.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {scope,complete}=require('./fixtures/evidence-backed-memory.cjs');
const {createWriteGate,createGatedStore,RECEIPT_CODES}=require('../src/memory/write-gate.cjs');
const {maintainMemory}=require('../src/memory-engine.cjs');

// Integration adaptation (M2 strict candidate channel): a model-proposed
// recurring classification files as a candidate; the durable lane opens via
// the user-attestation channel. Gate tests call this after proposing a
// stable preference, mirroring preference-candidate-lifecycle tests.
function attestStable(store){
  const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
  if(proposals.length)assert.equal(store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'}).applied,true,JSON.stringify(proposals[0]));
}

// Mirrors the frozen counterexample cm-stable-preference-quoted-wish: a quoted,
// recurring, user-owned expression preference declared in the owner's own words.
const STABLE_DECLARATION='以后默认回复简短，不用表情；这只是我的表达偏好，不是要求她也这样。';
// Mirrors cm-local-correction-continuity step r1: a correction scoped to the
// current round's wording, given as feedback on one assistant suggestion.
const LOCAL_CORRECTION='这轮表达太正式了，也太像正式邀约了；先接她说的分别计数，轻松一点，暂时不邀请。';
const STABLE_TEXT='用户默认回复简短，不用表情；这只是用户自己的表达偏好，不是对对方的要求。';
const LOCAL_TEXT='本轮回应先接她说的分别计数，轻松一点，暂时不邀请。';

function fixture(t,{withFeedback=true}={}){
  const store=new Store(':memory:');t.after(()=>store.close());
  const declaration=store.appendTurn(scope,{id:'stable-declaration',role:'user',kind:'discussion',text:STABLE_DECLARATION});
  const created={store,declarationId:'private:'+declaration.id,feedbackId:null};
  if(withFeedback){
    const answer=store.appendTurn(scope,{id:'assistant-answer',role:'assistant',kind:'discussion',text:'一份过于正式的参考表达。',requestId:'local-correction-run'});
    const feedback=store.addFeedback(scope,{text:LOCAL_CORRECTION,targetRef:{kind:'artifact',artifactRef:answer.artifactRef},clientEventId:'local-correction-feedback'});
    created.feedbackId=feedback.sourceId;
  }
  return created;
}
const stableClaim=declarationId=>({subject:'self',aspect:'stated_preference',text:STABLE_TEXT,assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[declarationId]});
const localClaim=feedbackId=>({subject:'self',aspect:'stated_preference',text:LOCAL_TEXT,assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'local',sourceIds:[feedbackId]});
// The B1 recorded failure shape: the current-round correction misread as a
// recurring preference and "attested" by the model itself.
const misfiledClaim=feedbackId=>({...localClaim(feedbackId),applicabilityKind:'recurring'});
const factItem=(sourceId,text='用户有一个给自己记读书笔记的小网页，不是公司项目。')=>({kind:'fact',text,sourceIds:[sourceId],topicKeys:['读书笔记']});
const receiptsOf=result=>result.receipt?.quarantinedRecords||[];

test('a misfiled durable preference is recorded narrower as a scoped overlay beside a valid fact',t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const gate=createWriteGate({store});
  const batch=store.memoryBatch(scope);
  const result=gate.apply(scope,batch,complete(batch,{
    items:[factItem(declarationId)],
    relationshipPatch:{claims:[misfiledClaim(feedbackId)],events:[],retire:[]}
  }));
  assert.equal(result.applied,true,JSON.stringify(result));
  // The valid fact committed; the misfiled promotion became neither a claim
  // nor a rejected batch, but a scoped overlay (recorded narrower).
  assert.ok(store.searchMemory(scope,'读书笔记').items.length,'the valid fact from the same batch is kept');
  assert.ok(!store.relationshipView(scope).claims.some(record=>record.sourceIds.includes(feedbackId)),'the feedback-backed recurring promotion is not stored as a claim');
  const overlays=gate.listOverlays(scope);
  assert.equal(overlays.length,1);
  assert.equal(overlays[0].scope.kind,'next_exchange','narrowest default scope');
  assert.equal(overlays[0].scope.bound.sourceId,feedbackId,'the overlay is bound to the correction observation');
  assert.equal(overlays[0].demotion.fromApplicabilityKind,'recurring');
  assert.ok(receiptsOf(result).some(receipt=>receipt.code===RECEIPT_CODES.PREFERENCE_DEMOTED_TO_OVERLAY&&receipt.field==='relationshipPatch.claims[0]'),'the demotion has an isolation receipt');
  assert.equal(store.memoryStatus(scope).pending,0,'the journal advanced');
});

test('a batch whose only proposal is a misfiled preference still advances the journal (B1 jam fix)',t=>{
  const {store,feedbackId}=fixture(t,{withFeedback:true});
  const gate=createWriteGate({store});
  const batch=store.memoryBatch(scope);
  const result=gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[misfiledClaim(feedbackId)],events:[],retire:[]}}));
  assert.equal(result.applied,true,JSON.stringify(result));
  assert.equal(result.receipt.kind,'gate_quarantine_commit');
  assert.equal(result.receipt.outcome,'gate_reclassified');
  assert.equal(store.memoryStatus(scope).pending,0,'the journal always advances past fully quarantined sources');
  assert.equal(gate.listOverlays(scope).length,1);
  // A later no-change batch is not double-counted: the batch was consumed.
  assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,false,'the same batch cannot be applied twice');
  assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).reason,'already_reviewed');
});

test('per-record isolation: invalid records quarantine alone with receipts while valid ones commit',t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const gate=createWriteGate({store});
  const batch=store.memoryBatch(scope);
  const result=gate.apply(scope,batch,complete(batch,{
    items:[factItem(declarationId),{kind:'fact',text:'引用不存在来源的事实。',sourceIds:['private:missing-source']}],
    relationshipPatch:{
      claims:[localClaim(feedbackId),{...localClaim(feedbackId),text:'引用缺失来源的转述。',sourceIds:['private:also-missing'],assertionKind:'reported'}],
      events:[],retire:[]
    }
  }));
  assert.equal(result.applied,true,JSON.stringify(result));
  const receipts=receiptsOf(result);
  assert.deepEqual(receipts.map(receipt=>receipt.field).sort(),['items[1]','relationshipPatch.claims[1]']);
  for(const receipt of receipts){
    assert.equal(receipt.code,RECEIPT_CODES.RECORD_VALIDATION_FAILED);
    assert.ok(receipt.message,'each quarantine receipt carries the real validation message');
  }
  assert.ok(store.searchMemory(scope,'读书笔记').items.length,'the valid fact committed');
  assert.equal(store.relationshipView(scope).claims.filter(record=>record.applicabilityKind==='local').length,1,'the valid claim committed');
  assert.equal(store.memoryStatus(scope).pending,0,'the journal advanced');
  const report=gate.quarantineReport(scope);
  assert.equal(report.quarantinedTotal,2);
  assert.equal(report.batches,1);
});

test('transition chains quarantine as a unit: an invalid successor never marks its target',t=>{
  const {store,declarationId}=fixture(t,{withFeedback:false});
  const gate=createWriteGate({store});
  let batch=store.memoryBatch(scope);
  assert.equal(gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[stableClaim(declarationId)],events:[],retire:[]}})).applied,true);
  attestStable(store);
  const target=store.relationshipView(scope).claims.find(record=>record.applicabilityKind==='recurring');
  assert.ok(target,'the prior understanding exists');
  const later=store.appendTurn(scope,{id:'later-source',role:'user',kind:'discussion',text:'用户补充了新的情况。'});
  batch=store.memoryBatch(scope);
  const invalidSuccessor={subject:'self',aspect:'recent_context',text:'基于缺失来源的更新理解。',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'unspecified',
    sourceIds:['private:missing-decision-source'],transition:{operation:'supersede',targets:[{id:target.id,expectedVersion:target.version}]}};
  const result=gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[invalidSuccessor],events:[],retire:[]}}));
  assert.equal(result.applied,true,JSON.stringify(result));
  const receipts=receiptsOf(result);
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].code,RECEIPT_CODES.RECORD_VALIDATION_FAILED);
  assert.deepEqual(receipts[0].chain,{operation:'supersede',targets:[target.id]},'the receipt identifies the atomic chain');
  const claims=store.relationshipView(scope).claims;
  const unchanged=claims.find(record=>record.id===target.id);
  assert.ok(unchanged,'the predecessor still exists');
  assert.equal(unchanged.version,target.version,'a quarantined supersede leaves the target untouched');
  assert.equal(unchanged.lifecycle,'active');
  assert.ok(!claims.some(record=>record.sourceIds.includes('private:'+later.id)),'the invalid successor is not stored');
  assert.equal(store.memoryStatus(scope).pending,0,'the journal still advanced');
});

test('transition chains commit as a unit when valid',t=>{
  const {store,declarationId}=fixture(t,{withFeedback:false});
  const gate=createWriteGate({store});
  let batch=store.memoryBatch(scope);
  assert.equal(gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[stableClaim(declarationId)],events:[],retire:[]}})).applied,true);
  attestStable(store);
  const target=store.relationshipView(scope).claims.find(record=>record.applicabilityKind==='recurring');
  const later=store.appendTurn(scope,{id:'valid-successor-source',role:'user',kind:'discussion',text:'用户说明这不再是固定偏好，只是近期安排。'});
  batch=store.memoryBatch(scope);
  const successor={subject:'self',aspect:'recent_context',text:'用户近期采用较长表达，属于近期安排。',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'temporary',
    sourceIds:['private:'+later.id],transition:{operation:'supersede',targets:[{id:target.id,expectedVersion:target.version}]}};
  const result=gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[successor],events:[],retire:[]}}));
  assert.equal(result.applied,true,JSON.stringify(result));
  const claims=store.relationshipView(scope).claims;
  const predecessor=claims.find(record=>record.id===target.id);
  const next=claims.find(record=>record.sourceIds.includes('private:'+later.id));
  assert.ok(next,'the successor is stored');
  assert.equal(predecessor.lifecycle,'superseded','the predecessor was retired by the same atomic commit');
  assert.equal(next.lifecycle,'active');
});

test('attested stable preferences persist without regression across later corrections (counterexample)',t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const gate=createWriteGate({store});
  let batch=store.memoryBatch(scope);
  assert.equal(gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[stableClaim(declarationId)],events:[],retire:[]}})).applied,true);
  attestStable(store);
  const before=store.relationshipView(scope).claims.find(record=>record.applicabilityKind==='recurring');
  assert.ok(before,'the owner-declared recurring preference is admitted active (user statement evidence)');
  // M2 semantics: the owner-backed proposal files the designed
  // preference_candidate receipt (never a failure-class receipt); the durable
  // lane opened through the attestation channel above.
  const admissionReceipts=receiptsOf({receipt:store.memoryStatus(scope).lastReview});
  assert.ok(admissionReceipts.every(entry=>entry.code==='preference_candidate'),'an owner-backed proposal files only the designed candidate receipt');
  // A later round misfiles the local correction as a recurring preference.
  const answer=store.appendTurn(scope,{id:'assistant-answer-2',role:'assistant',kind:'discussion',text:'又一份过于正式的参考表达。',requestId:'local-correction-run-2'});
  const feedback=store.addFeedback(scope,{text:LOCAL_CORRECTION,targetRef:{kind:'artifact',artifactRef:answer.artifactRef},clientEventId:'local-correction-feedback-2'});
  batch=store.memoryBatch(scope);
  const result=gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[misfiledClaim(feedback.sourceId)],events:[],retire:[]}}));
  assert.equal(result.applied,true,JSON.stringify(result));
  const claims=store.relationshipView(scope).claims;
  const stable=claims.find(record=>record.id===before.id);
  assert.ok(stable,'the stable preference record still exists');
  assert.equal(stable.version,before.version,'a local correction never bumps the stable record');
  assert.equal(stable.text,before.text);
  assert.equal(stable.lifecycle,'active');
  assert.ok(gate.listOverlays(scope).some(overlay=>overlay.scope.bound.sourceId===feedback.sourceId),'the later correction is its own scoped overlay');
  assert.ok(!claims.some(record=>record.sourceIds.includes(feedback.sourceId)),'the correction never becomes durable knowledge');
});

test('model-attested legacy preference items never activate; user attestation promotes them',t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const gate=createWriteGate({store});
  const batch=store.memoryBatch(scope);
  const result=gate.apply(scope,batch,complete(batch,{
    items:[{kind:'preference',text:'永远喜欢短回复',sourceIds:[feedbackId],explicitPreference:true}]
  }));
  assert.equal(result.applied,true,JSON.stringify(result));
  const receipt=receiptsOf(result).find(entry=>entry.code===RECEIPT_CODES.LEGACY_PREFERENCE_REQUIRES_ATTESTATION);
  assert.ok(receipt,'the model attestation is receipted, never honored');
  const candidates=gate.listCandidates(scope,'pending');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].modelAttestationIgnored,true);
  assert.ok(!store.searchMemory(scope,'短回复').items.some(item=>item.kind==='preference'),'no active preference record from model output');
  assert.equal(gate.listPreferences(scope).length,0);
  // Attestation citing someone else's speech is refused: only the account
  // owner's own words (or a UI attestation event) authorize promotion.
  const {normalize}=require('../src/messages.cjs');
  const {raw}=require('./fixtures/native.cjs');
  store.add(scope,[normalize(raw('720575940379279370000099001',false,{elements:[{textElement:{content:'她说她自己喜欢长回复。'}}]}),scope)]);
  const incoming='qq:720575940379279370000099001';
  assert.equal(gate.attestPreference(scope,{candidateId:candidates[0].id,observationId:incoming}).applied,false);
  // User attestation through the owner's own statement activates the preference.
  const attested=gate.attestPreference(scope,{candidateId:candidates[0].id,observationId:declarationId});
  assert.equal(attested.applied,true,JSON.stringify(attested));
  assert.equal(attested.preference.attestation.kind,'owner_statement');
  assert.equal(attested.preference.lifecycle,'active');
  const again=gate.attestPreference(scope,{candidateId:candidates[0].id,observationId:declarationId});
  assert.equal(again.applied,true);
  assert.equal(again.idempotent,true);
  assert.equal(again.preference.id,attested.preference.id,'attestation is idempotent');
  const preferences=gate.listPreferences(scope);
  assert.equal(preferences.length,1);
  assert.equal(preferences[0].text,'永远喜欢短回复');
});

test('program repetition counting proposes promotion candidates but never activates them',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const gate=createWriteGate({store,config:{repetitionThreshold:3}});
  const days=['2026-10-01T09:00:00.000Z','2026-10-04T09:00:00.000Z','2026-10-09T09:00:00.000Z'];
  const texts=['这轮先别连续提问。','这轮也别连续提问，先接她说的。','这轮同样别连续提问，放松一点。'];
  days.forEach((day,index)=>{
    const answer=store.appendTurn(scope,{id:'answer-'+index,role:'assistant',kind:'discussion',text:'连续提问的参考表达。',requestId:'run-'+index});
    const feedback=store.addFeedback(scope,{text:texts[index],targetRef:{kind:'artifact',artifactRef:answer.artifactRef},clientEventId:'feedback-'+index});
    // Distinct source days make the three corrections distinct episodes.
    const record=JSON.parse(store.db.prepare('SELECT record FROM experience_objects WHERE scope_key=? AND kind=? AND id=?').get(store.scopeKey(scope),'feedback',feedback.id).record);
    record.createdAt=day;
    store.db.prepare('UPDATE experience_objects SET record=? WHERE scope_key=? AND kind=? AND id=?').run(JSON.stringify(record),store.scopeKey(scope),'feedback',feedback.id);
    const batch=store.memoryBatch(scope);
    const misfiled={...localClaim(feedback.sourceId),text:texts[index],applicabilityKind:'recurring'};
    const result=gate.apply(scope,batch,complete(batch,{relationshipPatch:{claims:[misfiled],events:[],retire:[]}}));
    assert.equal(result.applied,true,JSON.stringify(result));
  });
  const state=gate.promotionState(scope);
  assert.equal(state.groups.length,1);
  assert.equal(state.groups[0].distinctEpisodes,3,'three corrections from distinct episodes');
  assert.equal(state.groups[0].eligible,true);
  const latest=gate.listOverlays(scope).at(-1);
  const filed=gate.filePromotionCandidate(scope,{promotionKey:state.groups[0].promotionKey,
    text:texts[2],evidenceSourceIds:[latest.scope.bound.sourceId]});
  assert.equal(filed.filed,true);
  assert.equal(filed.candidate.basis,'repetition_count');
  assert.equal(gate.listPreferences(scope).length,0,'counting alone never activates a preference');
  assert.ok(!store.relationshipView(scope).claims.some(record=>record.applicabilityKind==='recurring'),'counting alone never writes durable knowledge');
  // Dismissal is user-owned and blocks re-filing for the same key.
  assert.equal(gate.dismissCandidate(scope,{candidateId:filed.candidate.id}).applied,true);
  const blocked=gate.filePromotionCandidate(scope,{promotionKey:state.groups[0].promotionKey,text:texts[2],evidenceSourceIds:[]});
  assert.equal(blocked.filed,false);
  assert.equal(blocked.reason,'key_dismissed_by_user');
});

test('clean results pass through the legacy apply path with zero drift',t=>{
  // Random record/source ids, content hashes and timestamps differ between
  // fresh stores; normalize exactly those so only structural drift remains.
  const normalize=value=>JSON.stringify(value)
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g,'<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,'<uuid>')
    .replace(/"b[0-9a-f]{16}"/g,'"<batch>"')
    .replace(/[0-9a-f]{64}/g,'<sha>');
  const run=apply=>{
    const {store,declarationId,feedbackId}=fixture(t);
    const batch=store.memoryBatch(scope);
    const result=complete(batch,{
      items:[factItem(declarationId)],
      relationshipPatch:{claims:[localClaim(feedbackId)],events:[],retire:[]}
    });
    const applied=apply(store,batch,result);
    assert.equal(applied.applied,true,JSON.stringify(applied));
    const records=JSON.parse(normalize(store.db.prepare('SELECT kind,record FROM memory_records ORDER BY id').all()
      .map(row=>({kind:row.kind,record:JSON.parse(row.record)}))));
    records.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const journal=JSON.parse(normalize(store.db.prepare('SELECT source_id,status,cursor FROM memory_journal ORDER BY seq').all()));
    const receipts=store.db.prepare('SELECT record FROM memory_receipts').all()
      .map(row=>JSON.parse(normalize(JSON.parse(row.record))));
    return {records,journal,receipts};
  };
  const legacy=run((store,batch,result)=>store.applyMemoryBatch(scope,batch,result));
  const gated=run((store,batch,result)=>createWriteGate({store}).apply(scope,batch,result));
  assert.deepEqual(gated.records,legacy.records,'persisted records are identical');
  assert.deepEqual(gated.journal,legacy.journal,'journal state is identical');
  assert.equal(gated.receipts.length,legacy.receipts.length);
  const legacyReceipt=legacy.receipts[0],gatedReceipt=gated.receipts[0];
  assert.equal(gatedReceipt.kind,legacyReceipt.kind);
  assert.equal(gatedReceipt.updates,legacyReceipt.updates);
  assert.equal(gatedReceipt.outcome,legacyReceipt.outcome);
  assert.equal(gatedReceipt.gate,undefined,'the clean path leaves no gate metadata');
  assert.deepEqual(gatedReceipt.quarantinedRecords||[],legacyReceipt.quarantinedRecords||[]);
});

test('frame rejections pass through unchanged with the journal unmoved',t=>{
  const {store,feedbackId}=fixture(t);
  const gate=createWriteGate({store});
  const batch=store.memoryBatch(scope);
  const broken={...batch,baseMemoryVersion:batch.baseMemoryVersion+1};
  const result=gate.apply(scope,broken,complete(batch,{relationshipPatch:{claims:[localClaim(feedbackId)],events:[],retire:[]}}));
  assert.equal(result.applied,false);
  assert.equal(result.reason,'changed_batch');
  assert.equal(store.memoryStatus(scope).pending,batch.events.length,'the journal did not advance');
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_receipts').get().n,0,'no receipt was written');
});

test('gated maintenance completes the B1 same-shape scenario end to end',async t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const gated=createGatedStore(store);
  const settings={model:'synthetic-replay-only',anonymous:true,baseUrl:'http://fixture.invalid/v1'};
  const model=async(_settings,batch)=>{
    if(batch.kind==='semantic_recovery')return {reviewedSourceIds:[...batch.reviewedSourceIds],items:[],episodes:[],retire:[]};
    const delivered=id=>batch.sources.some(source=>source.id===id&&!source.deleted);
    return {reviewedSourceIds:[...batch.reviewedSourceIds],
      items:[factItem(declarationId)].filter(()=>delivered(declarationId)),
      episodes:[],retire:[],
      relationshipPatch:{claims:[
        ...(delivered(declarationId)?[stableClaim(declarationId)]:[]),
        ...(delivered(feedbackId)?[misfiledClaim(feedbackId)]:[])
      ],events:[],retire:[]}};
  };
  const status=await maintainMemory({store:gated,scope,settings,model,maxBatches:4});
  assert.notEqual(status.status,'rejected',JSON.stringify(status));
  assert.notEqual(status.status,'error',JSON.stringify(status));
  attestStable(store);
  const final=store.memoryStatus(scope);
  assert.equal(final.pending,0,'the journal fully drained past the misfiled preference');
  assert.ok(!final.errors?.length,JSON.stringify(final.errors));
  const claims=store.relationshipView(scope).claims;
  assert.ok(claims.some(record=>record.applicabilityKind==='recurring'&&record.sourceIds.includes(declarationId)),'the attested stable preference persisted');
  assert.ok(!claims.some(record=>record.sourceIds.includes(feedbackId)),'the misfiled promotion never became knowledge');
  assert.ok(store.searchMemory(scope,'读书笔记').items.length,'the valid fact from the same batch is kept');
  const gate=gated.__writeGate;
  assert.equal(gate.listOverlays(scope).length,1,'the correction was recorded narrower as an overlay');
  assert.ok(gate.activeOverlays(scope).length===1,'the overlay still applies (no later feedback yet)');
});
