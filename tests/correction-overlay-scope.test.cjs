'use strict';
// M2 scoped-correction-overlay semantics: corrections are additive overlays,
// never record rewrites. Scope rules (design 5/M2): a correction wins inside
// its scope; evidence currency wins everywhere; a correction overtaken by
// later legitimate re-review is flagged needs_current_interpretation.
// Fictional inputs only.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {scope}=require('./fixtures/native.cjs');
const user=(store,text,id)=>store.appendTurn(scope,{id,role:'user',kind:'discussion',text});

function base(t){
  const store=new Store(':memory:');t.after(()=>store.close());
  const evidence=user(store,'她说这周在准备考试','overlay-evidence');
  const sources=store.memorySources(scope);
  const options={baseRevision:store.getCompanion(scope).revision,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),deliveredSources:sources.map(s=>({...s,scope}))};
  const patch=store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',text:'她忙于考试',assertionKind:'stated',epistemicStatus:'supported',sourceIds:['private:'+evidence.id]}]},options);
  // Direct QQ speech is required for stated contact claims; refile as reported.
  if(!patch.applied)store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',text:'她忙于考试',assertionKind:'reported',epistemicStatus:'supported',sourceIds:['private:'+evidence.id]}]},options);
  return {store,evidenceId:'private:'+evidence.id,options};
}

test('a correction overlay never rewrites the stored claim',t=>{
  const {store,evidenceId}=base(t);
  const claim=store.relationshipView(scope).claims[0];
  const before=store._memoryRecords(scope).find(r=>r.id===claim.id);
  const result=store.correctRelationshipClaim(scope,{id:claim.id,expectedVersion:claim.version,operation:'correct',text:'考试是上个月的事了'});
  assert.equal(result.applied,true,JSON.stringify(result));
  const after=store._memoryRecords(scope).find(r=>r.id===claim.id);
  assert.equal(after.text,before.text,'the stored wording is untouched');
  assert.equal(after.version,before.version,'the stored version is untouched');
  assert.deepEqual(after.sourceIds,before.sourceIds,'the stored evidence is untouched');
  const view=store.relationshipView(scope).claims.find(c=>c.id===claim.id);
  assert.equal(view.text,'考试是上个月的事了');
  assert.equal(view.originalText,before.text);
  assert.ok(view.correctedByOverlay.overlayId===result.overlayId);
});

test('an overlay whose sources were withdrawn is stale and not applied',t=>{
  const {store,evidenceId}=base(t);
  const claim=store.relationshipView(scope).claims[0];
  const correction=user(store,'更正：她说的其实是工作考核','overlay-correction');
  const revisions={[ 'private:'+correction.id]:store.memorySources(scope).find(s=>s.id==='private:'+correction.id).revision};
  const overlay=store.applyCorrectionOverlay(scope,{targetRecordId:claim.id,targetVersion:claim.version,targetKind:'claim',operation:'annotate',content:'她忙于工作考核',sourceIds:['private:'+correction.id],sourceRevisions:revisions});
  assert.ok(overlay.id);
  // Withdraw the correction utterance: evidence currency wins everywhere.
  store.forgetSource(scope,'private:'+correction.id);
  const view=store.relationshipView(scope).claims.find(c=>c.id===claim.id);
  assert.equal(view.text,claim.text,'the stale correction is not applied');
  assert.ok(view.staleCorrection,'the stale correction stays visible');
});

test('an overtaken correction is flagged needs_current_interpretation',t=>{
  const {store,evidenceId}=base(t);
  const claim=store.relationshipView(scope).claims[0];
  const correction=user(store,'更正：那是上个月的情况','overtaken-correction');
  store.applyCorrectionOverlay(scope,{targetRecordId:claim.id,targetVersion:claim.version,targetKind:'claim',operation:'annotate',content:'上个月她忙于考试',sourceIds:['private:'+correction.id],sourceRevisions:{[ 'private:'+correction.id]:store.memorySources(scope).find(s=>s.id==='private:'+correction.id).revision}});
  // Later legitimate re-review updates the record itself (new evidence).
  const fresh=user(store,'这个月她说项目收尾了','overtaken-fresh');
  const sources=store.memorySources(scope);
  // A plain versioned update of the same record (new evidence, no transition).
  const updated=store.applyRelationshipPatch(scope,{claims:[{id:claim.id,expectedVersion:claim.version,subject:'contact',aspect:'recent_context',text:'她忙于项目收尾',assertionKind:'reported',epistemicStatus:'supported',sourceIds:['private:'+fresh.id]}]},{baseRevision:store.getCompanion(scope).revision,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),deliveredSources:sources.map(s=>({...s,scope}))});
  assert.equal(updated.applied,true,JSON.stringify(updated));
  const view=store.relationshipView(scope).claims.find(c=>c.id===claim.id);
  assert.equal(view.text,'她忙于项目收尾','the current record text wins');
  assert.ok(view.priorCorrection&&view.priorCorrection.status==='needs_current_interpretation','the overtaken correction is flagged for review');
});

test('overlay scope kinds are origin-bound',t=>{
  const {store,evidenceId}=base(t);
  const claim=store.relationshipView(scope).claims[0];
  const correction=user(store,'范围检查','scope-check');
  const revisions={[ 'private:'+correction.id]:store.memorySources(scope).find(s=>s.id==='private:'+correction.id).revision};
  const common={targetRecordId:claim.id,targetVersion:claim.version,operation:'annotate',content:'x',sourceIds:['private:'+correction.id],sourceRevisions:revisions};
  assert.throws(()=>store.applyCorrectionOverlay(scope,{...common,origin:'model_scoped',scope:{kind:'record'}}),/not allowed/,'a model correction can never claim record-wide scope');
  const narrow=store.applyCorrectionOverlay(scope,{...common,origin:'model_scoped',scope:{kind:'next_exchange'}});
  assert.equal(narrow.scope.kind,'next_exchange');
  assert.throws(()=>store.applyCorrectionOverlay(scope,{...common,targetRecordId:'missing-record',origin:'user_correction',scope:{kind:'record'}}),/target unavailable/);
});

test('a suppressed claim renders withdrawn and cannot be recreated from the same evidence',t=>{
  const {store}=base(t);
  const claim=store.relationshipView(scope).claims[0];
  assert.equal(store.correctRelationshipClaim(scope,{id:claim.id,expectedVersion:claim.version,operation:'withdraw'}).applied,true);
  let view=store.relationshipView(scope).claims.find(c=>c.id===claim.id);
  assert.equal(view.lifecycle,'withdrawn','the view renders the suppression');
  assert.ok(view.suppressedByOverlay);
  const stored=store._memoryRecords(scope).find(r=>r.id===claim.id);
  assert.equal(stored.text,claim.text,'suppression does not rewrite the record');
  // Re-proposing the same understanding from the same evidence stays blocked.
  const sources=store.memorySources(scope);
  const options={baseRevision:store.getCompanion(scope).revision,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),deliveredSources:sources.map(s=>({...s,scope}))};
  const again=store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',text:'她忙于考试',assertionKind:'reported',epistemicStatus:'supported',sourceIds:[...claim.sourceIds]}]},options);
  assert.equal(again.applied,true);
  view=store.relationshipView(scope).claims.find(c=>c.id===claim.id);
  assert.equal(view.lifecycle,'withdrawn','the retired signature blocks resurrection');
});

test('retiring an overlay restores the uncorrected view',t=>{
  const {store}=base(t);
  const claim=store.relationshipView(scope).claims[0];
  const result=store.correctRelationshipClaim(scope,{id:claim.id,expectedVersion:claim.version,operation:'correct',text:'临时更正'});
  assert.equal(store.retireCorrectionOverlay(scope,result.overlayId),true);
  const view=store.relationshipView(scope).claims.find(c=>c.id===claim.id);
  assert.equal(view.text,claim.text,'retiring the overlay restores the original understanding');
  assert.equal(view.correctedByOverlay,undefined);
});
