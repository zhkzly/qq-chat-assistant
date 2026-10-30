'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/assistant-protocol.cjs');
const {TaskLedger}=require('../src/request-budget.cjs');
const {discussionTurnFingerprint}=require('../src/discussion-compaction-store.cjs');
const {scope}=require('./fixtures/native.cjs');

function fixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());
 const user=store.appendTurn(scope,{role:'user',kind:'discussion',text:'解释我明确选中的生成建议。'});
 // These records predate persisted origin metadata and the ledger backfill.
 const automatic=store.appendTurn(scope,{role:'assistant',kind:'discussion',requestId:'legacy-auto-projection',text:'An older generated target.'});
 const derived=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'A legitimate private explanation of that exact target.',sourceIds:[`private:${user.id}`],
  artifactMetadata:{discussionTurnFingerprints:{[automatic.id]:discussionTurnFingerprint(automatic)}}});
 const ledger=new TaskLedger(store);ledger.create(scope,{id:automatic.requestId,inputDigest:'fictional',origin:'automatic'});
 return {store,automatic,derived};
}

test('classifying a legacy automatic target cannot alter its fingerprint or delete a legitimate private explanation on ordinary writes',t=>{
 const {store,automatic,derived}=fixture(t);
 store.getCompanion(scope);
 store.appendTurn(scope,{role:'user',kind:'discussion',text:'现在继续商量新内容。'});
 const current=store.getCompanion(scope),target=current.turns.find(turn=>turn.id===automatic.id);
 assert.ok(current.turns.some(turn=>turn.id===derived.id),'origin classification is not a source edit and must preserve the earlier private explanation');
 assert.equal(discussionTurnFingerprint(target),discussionTurnFingerprint(automatic));
 assert.equal(store.experiences.artifactStates(scope,[derived.artifactRef])[0].availability,'active');
 const saved=JSON.parse(store.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(store.scopeKey(scope)).record);
 assert.equal(saved.turns.find(turn=>turn.id===automatic.id).origin,undefined,'derived origin must not be silently written into original records');
});

test('the public consultation snapshot hides ledger-confirmed automatic turns without changing their original fields',t=>{
 const {store,automatic,derived}=fixture(t);
 const controller=new Controller({store,settings:{auto:false},read:async()=>{throw Error('Native reads are not part of this fixture');}});t.after(()=>controller.close());controller.scope={...scope};
 const snapshot=controller.snapshot();
 assert.ok(!snapshot.companion.turns.some(turn=>turn.id===automatic.id));
 assert.ok(snapshot.companion.turns.some(turn=>turn.id===derived.id));
 const original=store.getCompanion(scope).turns.find(turn=>turn.id===automatic.id);
 assert.equal(original.origin,undefined);
 assert.equal(discussionTurnFingerprint(original),discussionTurnFingerprint(automatic));
});
