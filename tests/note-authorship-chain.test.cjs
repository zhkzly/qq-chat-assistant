'use strict';
// Note008: trusted note authorship chain. The authenticated UI route is the
// only trust boundary that can mark a note user-authored; model actions and
// legacy records stay unattributed or lineage-derived. The author is the
// record author: it supports an owner report, never external world truth.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {observationSpeaker,ownerAuthoredRecord,assertSpeechAttribution}=require('../src/speaker-identity.cjs');
const {buildFidelityContext}=require('../src/whole-answer-fidelity.cjs');
const {scope}=require('./fixtures/native.cjs');
const {PROMPT_VERSION}=require('../src/context/shared.cjs');

function app(t){
 const store=new Store(':memory:');
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model:'synthetic-authorship',baseUrl:'http://fixture.invalid/v1',modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-authorship',baseUrl:'http://fixture.invalid/v1'}},read:async cmd=>cmd==='bind'?scope:{messages:[]},assistantModel:async()=>({})});
 t.after(()=>{controller.close();store.close();});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 return {store,controller,bind:()=>controller.bind(scope.peerUin)};
}
const derived=store=>store.memorySources(scope).filter(source=>source.type==='note');
const noteSource=(store,id)=>derived(store).find(source=>source.id==='note:'+id);

test('trusted UI-route note persists authorship through derivation, identity and fidelity witness',async t=>{
 const {store,controller,bind}=app(t);await bind();
 const saved=controller.saveNote({text:'我以前给旧帆布包补过内衬。',use:'draft',kind:'material'});
 assert.equal(saved.authoredBy,'user');
 const source=noteSource(store,saved.id);
 assert.equal(source.authoredBy,'user');assert.equal(source.role,'user');
 assert.equal(observationSpeaker(source),'account_owner');
 assert.equal(store.observationLog.identityOf(scope,source.id).speaker,'account_owner');
 assert.equal(ownerAuthoredRecord(source),true);
 const witness=buildFidelityContext({manifest:{scope,sourceRevisions:{[source.id]:source.revision}},payload:{sources:[source]}},{text:'x',suggestions:[{style:'自然',text:'x'}]}).payload.evidence.find(item=>item.sourceId===source.id);
 assert.equal(witness.authority,'user_authored_record');
 assert.equal(witness.lineage,'user_authored');
 assert.equal(witness.role,'user');
 assert.equal(witness.authorship,'user_authored_record_author_is_account_owner_not_external_world_truth');
 assert.doesNotThrow(()=>assertSpeechAttribution({assertionKind:'stated',subject:'self'},[source]));
});
test('store-level trust boundary: only the validated user origin is accepted',async t=>{
 const {store}=app(t);
 assert.throws(()=>store.saveNote(scope,{text:'x',use:'draft',authoredBy:'model'}),/Invalid note authorship/);
 assert.throws(()=>store.saveNote(scope,{text:'x',use:'draft',authoredBy:'assistant'}),/Invalid note authorship/);
 const legacy=store.saveNote(scope,{text:'旧记录，归属不明。',use:'discussion'});
 const source=noteSource(store,legacy.id);
 // Legacy derivation shape is byte-stable: no authorship fields, undetermined.
 assert.equal(Object.keys(source).includes('authoredBy'),false);
 assert.equal(Object.keys(source).includes('role'),false);
 assert.equal(observationSpeaker(source),'undetermined');
 assert.equal(store.observationLog.identityOf(scope,source.id).speaker,'undetermined');
 // Rootless legacy fallback for the speech gate is unchanged.
 assert.equal(ownerAuthoredRecord(source),true);
 const legacyWitness=buildFidelityContext({manifest:{scope,sourceRevisions:{[source.id]:source.revision}},payload:{sources:[source]}},{text:'x',suggestions:[{style:'自然',text:'x'}]}).payload.evidence.find(item=>item.sourceId===source.id);
 assert.equal(legacyWitness.authority,'note_context_not_original_human_statement');
 assert.equal(legacyWitness.lineage,'authored_or_unattributed');
 assert.equal(legacyWitness.role,'unknown');
 assert.equal(legacyWitness.authorship,undefined);
});
test('trusted note with derivation roots stays owner-authored and keeps bound lineage',async t=>{
 const {store,controller,bind}=app(t);await bind();
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我跟你说过补包的事。'});
 const saved=store.saveNote(scope,{text:'我以前补过内衬。',use:'draft',kind:'material',evidenceSourceIds:['private:'+turn.id],authoredBy:'user'});
 const source=noteSource(store,saved.id);
 assert.equal(source.authoredBy,'user');assert.equal(source.role,'user');
 assert.deepEqual(source.evidenceSourceIds,['private:'+turn.id]);
 assert.equal(ownerAuthoredRecord(source),true);
 const witness=buildFidelityContext({manifest:{scope,sourceRevisions:{[source.id]:source.revision}},payload:{sources:[source]}},{text:'x',suggestions:[{style:'自然',text:'x'}]}).payload.evidence.find(item=>item.sourceId===source.id);
 assert.equal(witness.authority,'user_authored_record');assert.equal(witness.lineage,'user_authored');
});
test('model action rewrite drops trusted authorship; undo restore keeps the original',async t=>{
 const {store,controller,bind}=app(t);await bind();
 const saved=controller.saveNote({text:'用户原写。',use:'draft'});
 assert.equal(saved.authoredBy,'user');
 // Exactly the assistant-actions spread: authorship stripped before saveNote.
 const {authoredBy,...previous}=saved;
 const rewritten=store.saveNote(scope,{...previous,text:'模型改写的文本。'});
 assert.equal(rewritten.authoredBy,undefined);
 assert.equal(rewritten.version,saved.version+1);
 // Undo restores the previous saved object verbatim, authorship included.
 const restored=store.saveNote(scope,{...saved});
 assert.equal(restored.authoredBy,'user');
});
test('UI re-save upgrades a legacy note to trusted authorship with an identity-change event',async t=>{
 const {store,controller,bind}=app(t);await bind();
 const legacy=store.saveNote(scope,{text:'同一句旧文本。',use:'draft'});
 const beforeId=noteSource(store,legacy.id);
 assert.equal(observationSpeaker(beforeId),'undetermined');
 const upgraded=controller.saveNote({id:legacy.id,text:'同一句旧文本。',use:'draft'});
 assert.equal(upgraded.authoredBy,'user');
 assert.equal(upgraded.version,legacy.version+1);
 const after=noteSource(store,legacy.id);
 assert.notEqual(after.revision,beforeId.revision);
 assert.equal(observationSpeaker(after),'account_owner');
 const identity=store.observationLog.identityOf(scope,after.id);
 assert.equal(identity.speaker,'account_owner');
});
test('short PROMPT_VERSION restores the consultation metadata budget',t=>{
 assert.ok(PROMPT_VERSION.length<=30,'version label must stay short',PROMPT_VERSION);
 assert.notEqual(PROMPT_VERSION,'goal-context-2026-11-05.18-terminal-disclosure-scope');
});
