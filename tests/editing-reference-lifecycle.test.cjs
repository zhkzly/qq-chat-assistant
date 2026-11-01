'use strict';
// Fictional current-producer fixtures; these are deterministic store checks,
// not desktop integration or an assessment of generated conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {scope}=require('./fixtures/native.cjs');
const PRIMARY='昨天把读书笔记网页的查找功能弄好了，我挺开心。';
const SECOND='我做了个记读书笔记的小网页，昨天刚把查找做好。';
function fixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());
 const user=store.appendTurn(scope,{role:'user',kind:'discussion',text:'这是我自己的读书笔记网页。昨天刚把查找功能做好，我愿意告诉她。'});
 const prior=store.appendTurn(scope,{role:'assistant',kind:'draft',requestId:'fictional-original',text:'先分享一个真实的小进展。',
  sourceIds:[`private:${user.id}`],suggestions:[{style:'自然',text:PRIMARY},{style:'直接',text:SECOND}],expressionOptions:[{label:'先说做这个网页的原因'}]});
 const selection={turnId:prior.id,suggestionIndex:1,artifactRef:prior.suggestions[1].artifactRef};
 return {store,e:store.experiences,user,prior,selection};
}
function replaceArtifact(e,reference,patch){
 const original=e.artifact(scope,reference);
 e._put(scope,'artifact',`${reference.artifactId}@${reference.version}`,{...original,...patch});
 return ()=>e._put(scope,'artifact',`${reference.artifactId}@${reference.version}`,original);
}
function derived(store,dependency,id,text){
 return store.appendTurn(scope,{id,role:'assistant',kind:'draft',text:'按当前要求修改的参考表达。',
  suggestions:[{style:'自然',text}],artifactMetadata:{inputArtifactRefs:[dependency]}});
}

test('editing resolves the exact current-produced outgoing leaf and rejects other scope, index, version and kinds',t=>{
 const {e,prior,selection}=fixture(t),resolved=e.resolveMessageCandidate(scope,selection);
 assert.equal(resolved.text,SECOND);
 assert.deepEqual(resolved.dependency.artifactRef,prior.suggestions[1].artifactRef);
 assert.equal(resolved.dependency.suggestionIndex,1);
 assert.equal(resolved.dependency.kind,'message_candidate');
 assert.deepEqual(e.assertInputArtifactsCurrent(scope,[resolved.dependency]),[resolved.dependency]);
 const invalid=[
  {...selection,suggestionIndex:0},
  {...selection,suggestionIndex:-1},
  {...selection,suggestionIndex:2},
  {...selection,artifactRef:{...selection.artifactRef,version:selection.artifactRef.version+1}},
  {...selection,artifactRef:prior.artifactRef},
  {...selection,artifactRef:prior.expressionOptions[0].artifactRef},
  {...selection,turnId:'another-assistant-turn'}
 ];
 for(const input of invalid)assert.throws(()=>e.resolveMessageCandidate(scope,input),/Editing reference|artifact reference/);
 assert.throws(()=>e.resolveMessageCandidate({...scope,peerUid:'foreign-contact'},selection),/Editing reference/);
 assert.throws(()=>e.resolveMessageCandidate({...scope,accountUid:'foreign-account'},selection),/Editing reference/);
});

test('redacting one outgoing leaf never restores it from an active parent or retained companion text',t=>{
 const {store,e,prior,selection}=fixture(t),captured=e.resolveMessageCandidate(scope,selection).dependency;
 e.invalidateArtifacts(scope,[selection.artifactRef]);
 assert.equal(e.artifact(scope,prior.artifactRef).availability,'active');
 assert.equal(store._getCompanion(scope).turns.find(turn=>turn.id===prior.id).suggestions[1].text,SECOND);
 assert.equal(store.getCompanion(scope).turns.find(turn=>turn.id===prior.id).suggestions[1].text,'');
 assert.equal(e.artifact(scope,selection.artifactRef).body,'');
 assert.equal(e.artifact(scope,selection.artifactRef).availability,'redacted');
 assert.throws(()=>e.resolveMessageCandidate(scope,selection),/Editing reference/);
 assert.throws(()=>e.assertInputArtifactsCurrent(scope,[captured]),/Editing reference/);
 assert.equal(e.resolveMessageCandidate(scope,{turnId:prior.id,suggestionIndex:0,artifactRef:prior.suggestions[0].artifactRef}).text,PRIMARY);
});

test('editing checks the live artifact body, digest, kind, turn and parent identity as well as availability',t=>{
 const {e,prior,selection}=fixture(t),captured=e.resolveMessageCandidate(scope,selection).dependency;
 const patches=[
  {body:'A changed body without changing its reference'},
  {bodyDigest:'forged-body-digest'},
  {ref:{artifactId:selection.artifactRef.artifactId,version:selection.artifactRef.version+1}},
  {ref:{artifactId:'a-different-live-artifact-id',version:selection.artifactRef.version}},
  {kind:'response'},
  {assistantTurnId:'another-turn'},
  {parentRef:prior.expressionOptions[0].artifactRef},
  {availability:'stale'},
  {availability:'redacted'}
 ];
 for(const patch of patches){
  const restore=replaceArtifact(e,selection.artifactRef,patch);
  assert.throws(()=>e.resolveMessageCandidate(scope,selection),/Editing reference/,JSON.stringify(patch));
  assert.throws(()=>e.assertInputArtifactsCurrent(scope,[captured]),/Editing reference/,JSON.stringify(patch));
  restore();
 }
 assert.equal(e.resolveMessageCandidate(scope,selection).text,SECOND);
 assert.throws(()=>e.assertInputArtifactsCurrent(scope,[{...captured,bodyDigest:'forged-expected-digest'}]),/changed before commit/);
 assert.throws(()=>e.assertInputArtifactsCurrent(scope,[{...captured,witness:'forged-expected-witness'}]),/changed before commit/);
});

test('consumed leaf dependencies persist on the output family and invalidate a later edit chain, feedback and draft events',t=>{
 const {store,e,prior,selection}=fixture(t),dependency=e.resolveMessageCandidate(scope,selection).dependency;
 const revised=derived(store,dependency,'fictional-revised','昨天刚把我那个读书笔记网页的查找做好，挺开心的。');
 assert.deepEqual(e.artifact(scope,revised.artifactRef).inputArtifactRefs,[dependency]);
 assert.deepEqual(e.artifact(scope,revised.suggestions[0].artifactRef).inputArtifactRefs,[dependency]);
 assert.deepEqual(e.artifact(scope,revised.artifactRef).sourceIds,[],'this dependency is an artifact input edge, not invented raw evidence');
 assert.deepEqual(e.artifact(scope,revised.artifactRef).parentRef,undefined,'a prior input is not the output-family parent');
 const nextDependency=e.resolveMessageCandidate(scope,{turnId:revised.id,suggestionIndex:0,artifactRef:revised.suggestions[0].artifactRef}).dependency;
 const next=derived(store,nextDependency,'fictional-revised-again','查找功能昨天终于能用了，做这个小网页还挺有成就感的。');
 const nextRef=next.suggestions[0].artifactRef;
 const feedback=store.addFeedback(scope,{text:'最后这句保留自己的小进展就好。',targetRef:{kind:'artifact',artifactRef:nextRef}, expectedDigest: store.experiences.artifact(scope, nextRef).bodyDigest});
 e.recordInteraction(scope,{clientEventId:'fictional-adopted-edit',type:'draft_adopted',text:next.suggestions[0].text,artifactRefs:[nextRef],expectedRevision:0});
 e.recordInteraction(scope,{clientEventId:'fictional-copy-edit',type:'clipboard_write',text:next.suggestions[0].text,artifactRefs:[nextRef]});
 e.invalidateArtifacts(scope,[selection.artifactRef],{mode:'correct'});
 for(const reference of [selection.artifactRef,revised.artifactRef,revised.suggestions[0].artifactRef,next.artifactRef,nextRef])assert.equal(e.artifact(scope,reference).availability,'stale');
 assert.equal(e.artifact(scope,prior.artifactRef).availability,'active','invalidating an input leaf leaves its original parent active');
 assert.equal(e._get(scope,'feedback',feedback.id).targetStatus,'stale');
 assert.equal(e.draft(scope).availability,'stale');
 assert.ok(e._all(scope,'event').every(event=>event.availability==='stale'&&event.sent===false));
 e.invalidateArtifacts(scope,[selection.artifactRef],{mode:'forget'});
 for(const reference of [selection.artifactRef,revised.artifactRef,revised.suggestions[0].artifactRef,next.artifactRef,nextRef]){
  assert.equal(e.artifact(scope,reference).availability,'redacted');assert.equal(e.artifact(scope,reference).body,'');
 }
 assert.equal(e.hydrateFeedback(scope,feedback.id),null);
 assert.equal(e.draft(scope).availability,'redacted');assert.equal(e.draft(scope).text,'');
 assert.ok(e._all(scope,'event').every(event=>event.availability==='redacted'&&event.text===''&&event.sent===false));
 assert.equal(store.messages(scope).length,0,'draft adoption and clipboard events never become actual QQ sends');
});

test('an atomic output append rejects a consumed leaf invalidated after resolution',t=>{
 const {store,e,selection}=fixture(t),dependency=e.resolveMessageCandidate(scope,selection).dependency;
 const artifactCount=e._all(scope,'artifact').length,turnCount=store.getCompanion(scope).turns.length;
 e.invalidateArtifacts(scope,[selection.artifactRef]);
 assert.throws(()=>derived(store,dependency,'fictional-racing-output','This stale edit must not persist.'),/Editing reference/);
 assert.equal(e._all(scope,'artifact').length,artifactCount);
 assert.equal(store.getCompanion(scope).turns.length,turnCount);
 assert.ok(!store.getCompanion(scope).turns.some(turn=>turn.id==='fictional-racing-output'));
});

test('raw source corrections invalidate a previously captured editing dependency before commit',t=>{
 const {store,e,user,selection}=fixture(t),dependency=e.resolveMessageCandidate(scope,selection).dependency;
 store.updateTurn(scope,user.id,'更正：那个查找功能还没做完，这个进展不能再说。');
 assert.equal(e.artifactStates(scope,[selection.artifactRef])[0].availability,'stale');
 assert.throws(()=>e.assertInputArtifactsCurrent(scope,[dependency]),/Editing reference/);
 assert.throws(()=>derived(store,dependency,'fictional-source-racing-output','The old completion claim must not persist.'),/Editing reference/);
});
