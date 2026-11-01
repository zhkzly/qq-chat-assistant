'use strict';
// B1 decision-split preference lifecycle: the model proposes candidates only;
// the program repetition counter and the user attestation channel are the
// only recurring-upgrade paths; quarantine receipts are first-class rows.
// Fictional inputs only.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {scope}=require('./fixtures/native.cjs');
const complete=(batch,extra={})=>({reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[],...extra});

function declare(store,id,text){store.appendTurn(scope,{id,role:'user',kind:'discussion',text});}

function proposeRecurring(store,sourceId,text){
  const batch=store.memoryBatch(scope);
  if(!batch)return null;
  return store.applyMemoryBatch(scope,batch,complete(batch,{relationshipPatch:{claims:[{subject:'self',aspect:'stated_preference',text,assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[sourceId]}],events:[],retire:[]}}));
}

test('a model recurring proposal degrades to a non-durable claim plus a candidate receipt',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  declare(store,'declare-1','以后回复默认简短，这是我的表达偏好。');
  const result=proposeRecurring(store,'private:declare-1','用户默认回复简短');
  assert.equal(result.applied,true,JSON.stringify(result));
  const claims=store.relationshipView(scope).claims;
  const claim=claims.find(c=>c.sourceIds.includes('private:declare-1'));
  assert.ok(claim,'the evidence-bound claim is kept');
  assert.equal(claim.applicabilityKind,'unspecified','the model cannot commit a recurring classification');
  const candidates=store.quarantinedProposals(scope,{status:'candidate'});
  assert.equal(candidates.filter(entry=>entry.code==='preference_candidate').length,1);
  assert.equal(candidates[0].proposal.proposedApplicability,'recurring');
  assert.equal(store.memoryStatus(scope).preferenceCandidates,1);
});

test('the program repetition counter widens only across independent batches',async t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  // Three independent declaration episodes, one candidate per review batch.
  for(let n=1;n<=3;n++){
    declare(store,'declare-'+n,'第'+n+'次：回复默认简短，这是我的长期偏好。');
    const result=proposeRecurring(store,'private:declare-'+n,'用户默认回复简短');
    assert.equal(result.applied,true);
    const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
    assert.equal(proposals.length,1,'the same normalized text groups into one proposal');
    if(n<3)assert.equal(proposals[0].repetition.eligibleForProgramWidening,false,
      'below the repetition threshold the proposal is user-confirmable but not program-widened');
    else assert.equal(proposals[0].repetition.eligibleForProgramWidening,true,
      'three independent episodes cross the program repetition threshold');
    assert.equal(proposals[0].repetition.count,n);
    // Drain the journal so the next declaration forms its own batch.
    for(;;){const batch=store.memoryBatch(scope);if(!batch)break;assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,true);}
  }
});

test('authorize promotes through the foreground gate with the candidate evidence',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  declare(store,'declare-auth','以后回复默认简短，这是我的表达偏好。');
  assert.equal(proposeRecurring(store,'private:declare-auth','用户默认回复简短').applied,true);
  const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
  assert.equal(proposals.length,1);
  const decision=store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'});
  assert.equal(decision.applied,true,JSON.stringify(decision));
  const stable=store.relationshipView(scope).claims.find(c=>c.id===decision.claimId);
  assert.ok(stable);
  assert.equal(stable.applicabilityKind,'recurring','the user-attested claim is durable');
  assert.equal(stable.sourceIds.includes('private:declare-auth'),true);
  assert.equal(store.preferenceUpgradeProposals(scope,{status:'pending'}).length,0,'the proposal is resolved');
  assert.equal(store.quarantinedProposals(scope,{status:'candidate'}).length,0,'its candidate receipts are consumed');
});

test('dismiss keeps the non-durable claim and closes the proposal',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  declare(store,'declare-dismiss','以后都简短回复。');
  assert.equal(proposeRecurring(store,'private:declare-dismiss','用户默认回复简短').applied,true);
  const proposals=store.preferenceUpgradeProposals(scope,{status:'pending'});
  assert.equal(store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'dismiss'}).applied,true);
  assert.equal(store.preferenceUpgradeProposals(scope,{status:'pending'}).length,0);
  assert.equal(store.relationshipView(scope).claims.filter(c=>c.applicabilityKind==='recurring').length,0,'dismissal never creates a durable preference');
  assert.deepEqual(store.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'}),{applied:false,reason:'already_resolved'});
});

test('the memory wire strips the deprecated explicitPreference flag before the write gate',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  declare(store,'declare-wire','以后回复默认简短。');
  const batch=store.memoryBatch(scope);
  // A model still following the old wire contract (explicitPreference:true)
  // is accepted; the flag is inert and the item still lands as a candidate.
  const result=store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind:'preference',text:'用户默认回复简短',sourceIds:['private:declare-wire'],explicitPreference:true}]}));
  assert.equal(result.applied,true);
  assert.ok(result.receipt.quarantinedRecords.some(entry=>entry.code==='preference_candidate'));
  assert.equal(store.memoryStatus(scope).preferenceCandidates,1);
});
