'use strict';
// Deterministic reproduction for the coverage-long-private-consultation
// baseline failure: controlled memory preparation rejected a local correction
// that the model classified as a stable preference, so the whole maintenance
// batch was refused and the user request turn was never reached.
// Scope (how far a correction reaches) and stability (whether a preference is
// recurring) are separate judgments and must not be merged into one gate.
// Fictional inputs and scripted model proposals only; no semantic-quality claim.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {scope,complete}=require('./fixtures/evidence-backed-memory.cjs');
const {maintainMemory}=require('../src/memory-engine.cjs');

// Mirrors the frozen counterexample cm-stable-preference-quoted-wish: a quoted,
// recurring, user-owned expression preference.
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
    const feedback=store.addFeedback(scope,{text:LOCAL_CORRECTION,targetRef:{kind:'artifact',artifactRef:answer.artifactRef},clientEventId:'local-correction-feedback', expectedDigest: store.experiences.artifact(scope, answer.artifactRef).bodyDigest});
    created.feedbackId=feedback.sourceId;
  }
  return created;
}
const stableClaim=declarationId=>({subject:'self',aspect:'stated_preference',text:STABLE_TEXT,assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[declarationId]});
const localClaim=feedbackId=>({subject:'self',aspect:'stated_preference',text:LOCAL_TEXT,assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'local',sourceIds:[feedbackId]});

test('a locally scoped correction claim is admitted next to a user-attested stable preference',t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const batch=store.memoryBatch(scope);
  assert.ok(batch,'the fixture sources must form a memory batch');
  assert.ok(batch.sources.some(source=>source.id===feedbackId),'the local correction feedback must be a reviewable source');
  const result=store.applyMemoryBatch(scope,batch,complete(batch,{relationshipPatch:{claims:[stableClaim(declarationId),localClaim(feedbackId)],events:[],retire:[]}}));
  assert.equal(result.applied,true,JSON.stringify(result));
  // Structural reason (B1 decision-split): the model's recurring classification
  // is a candidate, never a committed stability decision. The claim is stored
  // with non-durable applicability and the durable lane opens only after the
  // user confirms the surfaced upgrade proposal.
  let claims=store.relationshipView(scope).claims;
  const degraded=claims.find(record=>record.sourceIds.includes(declarationId));
  assert.ok(degraded,'the declaration-backed claim is persisted');
  assert.equal(degraded.applicabilityKind,'unspecified','the model cannot commit a recurring classification');
  const local=claims.find(record=>record.applicabilityKind==='local');
  assert.ok(local,'the locally scoped correction is persisted');
  assert.deepEqual(local.sourceIds,[feedbackId]);
  assert.ok(result.receipt.quarantinedRecords?.some(entry=>entry.code==='preference_candidate'),'the recurring proposal is filed as a candidate');
  const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
  assert.equal(proposals.length,1,'one pending upgrade proposal surfaces');
  assert.equal(proposals[0].evidenceSourceIds.includes(declarationId),true);
  const upgrade=store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'});
  assert.equal(upgrade.applied,true,JSON.stringify(upgrade));
  claims=store.relationshipView(scope).claims;
  const stable=claims.find(record=>record.id===upgrade.claimId);
  assert.ok(stable,'the user-attested stable preference is persisted');
  assert.equal(stable.applicabilityKind,'recurring');
  assert.ok(stable.sourceIds.includes(declarationId));
});

test('a local correction does not rewrite, retire or share identity with the attested stable preference',t=>{
  const {store,declarationId}=fixture(t,{withFeedback:false});
  let batch=store.memoryBatch(scope);
  assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{relationshipPatch:{claims:[stableClaim(declarationId)],events:[],retire:[]}})).applied,true);
  // Structural reason (B1): the durable lane requires user attestation; the
  // model proposal degraded to an unspecified claim plus a pending proposal.
  const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
  assert.equal(proposals.length,1);
  assert.equal(store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'}).applied,true);
  const stableBefore=store.relationshipView(scope).claims.find(record=>record.applicabilityKind==='recurring');
  assert.ok(stableBefore);
  const answer=store.appendTurn(scope,{id:'assistant-answer-late',role:'assistant',kind:'discussion',text:'又一份过于正式的参考表达。',requestId:'local-correction-run-2'});
  const feedback=store.addFeedback(scope,{text:LOCAL_CORRECTION,targetRef:{kind:'artifact',artifactRef:answer.artifactRef},clientEventId:'local-correction-feedback-2', expectedDigest: store.experiences.artifact(scope, answer.artifactRef).bodyDigest});
  batch=store.memoryBatch(scope);
  assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{relationshipPatch:{claims:[localClaim(feedback.sourceId)],events:[],retire:[]}})).applied,true);
  const claims=store.relationshipView(scope).claims;
  const stableAfter=claims.find(record=>record.id===stableBefore.id);
  assert.ok(stableAfter,'the stable preference record still exists');
  assert.equal(stableAfter.version,stableBefore.version,'a local correction never bumps the stable record');
  assert.equal(stableAfter.text,stableBefore.text);
  assert.equal(stableAfter.lifecycle,'active');
  const local=claims.find(record=>record.applicabilityKind==='local');
  assert.ok(local&&local.id!==stableAfter.id,'the correction is its own locally scoped record');
  // The read model keeps the durable preference and the scoped correction in
  // separate lanes; only the durable one becomes a stable understanding.
  const understanding=store.personUnderstanding(scope);
  assert.ok(understanding.self.knownFacts.some(record=>record.id===stableAfter.id));
  assert.ok(understanding.self.recentCircumstances.some(record=>record.id===local.id));
  assert.ok(!understanding.self.knownFacts.some(record=>record.id===local.id));
});

test('one misclassified stable preference is quarantined without refusing the rest of the batch',t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const batch=store.memoryBatch(scope);
  // The model misreads the current-round correction as a recurring preference
  // (attested, evidenced by the local feedback): the recorded failure shape.
  const result=store.applyMemoryBatch(scope,batch,complete(batch,{
    items:[{kind:'fact',text:'用户有一个给自己记读书笔记的小网页，不是公司项目。',sourceIds:[declarationId],topicKeys:['读书笔记','个人网页']}],
    episodes:[],retire:[],
    relationshipPatch:{claims:[{...localClaim(feedbackId),applicabilityKind:'recurring'}],events:[],retire:[]}
  }));
  assert.equal(result.applied,true,JSON.stringify(result));
  assert.ok(result.receipt.quarantinedRecords?.some(record=>record.code==='preference_candidate'),'the refused promotion is recorded as a candidate receipt, not silently ignored');
  const claims=store.relationshipView(scope).claims;
  assert.ok(!claims.some(record=>record.sourceIds.includes(feedbackId)),'the feedback-backed recurring promotion is not stored');
  assert.ok(store.searchMemory(scope,'读书笔记').items.some(item=>item.kind==='fact'),'the valid fact from the same batch survives');
});

test('a batch whose only proposal is a preference candidate commits it as a receipt and advances the journal',t=>{
  const {store,feedbackId}=fixture(t);
  const batch=store.memoryBatch(scope);
  const result=store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind:'preference',text:'永远喜欢短回复',sourceIds:[feedbackId],explicitPreference:true}]}));
  // Structural reason (B1 decision-split write gate): preference classification
  // is program/user-owned, so a preference proposal is a receipt, not a batch
  // failure. The journal must always advance — the coverage-long-private-
  // consultation jam cannot recur through this path.
  assert.equal(result.applied,true,'a candidate alone still commits the review');
  assert.ok(result.receipt.quarantinedRecords?.some(record=>record.code==='preference_candidate'));
  assert.ok(store.quarantinedProposals(scope,{status:'candidate'}).some(entry=>entry.proposal?.text==='永远喜欢短回复'));
  assert.equal(store.memoryStatus(scope).pending,0,'the sources are fully reviewed');
  assert.ok(!store.searchMemory(scope,'短回复').items.some(item=>item.kind==='preference'),'no preference record was committed');
});

test('memory maintenance completes past a misclassified preference so the request round stays reachable',async t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const settings={model:'synthetic-replay-only',anonymous:true,baseUrl:'http://fixture.invalid/v1'};
  let calls=0;
  const model=async(_settings,batch)=>{
    calls++;
    // Semantic-recovery rereads allow no legacy rewrites; answer them no-change.
    if(batch.kind==='semantic_recovery')return {reviewedSourceIds:[...batch.reviewedSourceIds],items:[],episodes:[],retire:[]};
    return {reviewedSourceIds:[...batch.reviewedSourceIds],
      items:[{kind:'fact',text:'用户有一个给自己记读书笔记的小网页，不是公司项目。',sourceIds:batch.sources.filter(source=>!source.deleted&&source.id===declarationId).map(source=>source.id),topicKeys:['读书笔记']}],
      episodes:[],retire:[],
      relationshipPatch:{claims:[{...localClaim(feedbackId),applicabilityKind:'recurring'}].filter(()=>batch.sources.some(source=>source.id===feedbackId)),events:[],retire:[]}};
  };
  const status=await maintainMemory({store,scope,settings,model,maxBatches:4});
  assert.notEqual(status.status,'rejected',JSON.stringify(status));
  assert.notEqual(status.status,'error',JSON.stringify(status));
  assert.ok(calls>=1);
  const final=store.memoryStatus(scope);
  assert.equal(final.pending,0,'the source journal is fully reviewed');
  assert.ok(!final.errors?.length,JSON.stringify(final.errors));
  assert.ok(!store.relationshipView(scope).claims.some(record=>record.sourceIds.includes(feedbackId)),'the misclassified promotion never becomes knowledge');
  assert.ok(store.searchMemory(scope,'读书笔记').items.length,'the valid knowledge from the same proposals is kept');
});

test('memory maintenance admits a correctly scoped local correction alongside a stable preference',async t=>{
  const {store,declarationId,feedbackId}=fixture(t);
  const settings={model:'synthetic-replay-only',anonymous:true,baseUrl:'http://fixture.invalid/v1'};
  const model=async(_settings,batch)=>{
    if(batch.kind==='semantic_recovery')return {reviewedSourceIds:[...batch.reviewedSourceIds],items:[],episodes:[],retire:[]};
    return {reviewedSourceIds:[...batch.reviewedSourceIds],items:[],episodes:[],retire:[],
      relationshipPatch:{claims:[stableClaim(declarationId),localClaim(feedbackId)].filter(claim=>claim.sourceIds.every(id=>batch.sources.some(source=>source.id===id&&!source.deleted))),events:[],retire:[]}};
  };
  const status=await maintainMemory({store,scope,settings,model,maxBatches:4});
  assert.notEqual(status.status,'rejected',JSON.stringify(status));
  assert.notEqual(status.status,'error',JSON.stringify(status));
  // Structural reason (B1): maintenance files the declaration claim as a
  // non-durable candidate; the user confirms the surfaced proposal here.
  const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
  assert.equal(proposals.length,1,'the stable-preference candidate surfaces for attestation');
  assert.equal(store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'}).applied,true);
  const claims=store.relationshipView(scope).claims;
  assert.ok(claims.some(record=>record.applicabilityKind==='recurring'&&record.sourceIds.includes(declarationId)),'the attested stable preference persisted');
  assert.ok(claims.some(record=>record.applicabilityKind==='local'&&record.sourceIds.includes(feedbackId)),'the local correction persisted with local scope');
});
