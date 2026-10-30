'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
function fixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());const message=normalize(raw(),scope);store.add(scope,[message]);
 const sourceId=`qq:${message.messageId}`,batch=store.memoryBatch(scope);
 const result=store.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,items:Array.from({length:8},(_,n)=>({kind:'fact',text:`Fictional dated observation ${n}`,sourceIds:[sourceId],topicKeys:['fictional-history'],status:n===0?'resolved':'active'})),episodes:[{text:'Fictional earlier exchange',sourceIds:[sourceId],status:'active'}],retire:[],relationshipPatch:{
  claims:[{subject:'contact',aspect:'recent_context',text:'Fictional reported recent context',assertionKind:'stated',epistemicStatus:'contested',validFrom:'2026-10-01T00:00:00Z',validUntil:'2026-10-20T00:00:00Z',sourceIds:[sourceId]}],
  events:[{activityKey:'fictional-sharing',eventKind:'sharing',actor:'contact',text:'Fictional sharing event',occurredAt:'2026-10-11T11:00:00Z',sourceIds:[sourceId]}]
 }});assert.equal(result.applied,true,result.detail||result.reason);return {store,message,sourceId};
}
test('knowledge directory is an unranked full-fidelity scoped read of existing derived knowledge',t=>{
 const {store,sourceId}=fixture(t),expected=store._memoryRecords(scope),changes=store.db.prepare('SELECT total_changes() AS n').get().n;
 assert.equal(expected.length,11,'fixture includes more than six navigation entries');
 const rawRead=t.mock.method(store,'_rawMemorySources',()=>assert.fail('directory must not rescan raw sources'));
 const rankedRead=t.mock.method(store,'searchMemory',()=>assert.fail('directory must not tokenize or rank raw sources'));
 const directory=store.knowledgeDirectory(scope);assert.deepEqual(directory,expected);
 assert.deepEqual(new Set(directory.map(record=>record.recordType)),new Set(['item','episode','claim','relationship_event']));
 const claim=directory.find(record=>record.recordType==='claim'),event=directory.find(record=>record.recordType==='relationship_event');
 assert.equal(claim.epistemicStatus,'contested');assert.equal(claim.assertionKind,'stated');assert.equal(claim.validUntil,'2026-10-20T00:00:00.000Z');assert.equal(claim.lifecycle,'active');assert.equal(event.occurredAt,'2026-10-11T11:00:00.000Z');assert.equal(directory.find(record=>record.recordType==='item'&&record.status==='resolved').status,'resolved');
 for(const record of directory){assert.ok(record.firstEvidenceAt);assert.ok(record.lastEvidenceAt);assert.deepEqual(record.sourceIds,[sourceId]);assert.equal(typeof record.sourceRevisions[sourceId],'string');}
 for(const field of Object.keys(scope))assert.deepEqual(store.knowledgeDirectory({...scope,[field]:`${scope[field]}-other`}),[]);
 assert.throws(()=>store.knowledgeDirectory({...scope,peerUin:undefined}),/scope/);
 directory[0].text='Caller-local edit';assert.deepEqual(store.knowledgeDirectory(scope),expected,'returned navigation objects cannot mutate stored knowledge');
 assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n,changes,'directory reads introduce no writes');
 rawRead.mock.restore();rankedRead.mock.restore();
});
test('existing source correction and withdrawal invalidate directory records without changing source semantics',t=>{
 for(const operation of ['correct','withdraw']){const {store,message,sourceId}=fixture(t);assert.equal(store.knowledgeDirectory(scope).length,11);
  if(operation==='correct')store.add(scope,[{...message,text:'Fictional corrected actual QQ evidence'}]);else store.forgetSource(scope,sourceId);
  assert.deepEqual(store.knowledgeDirectory(scope),[],`${operation} removes dependent navigation rows`);assert.equal(store.messages(scope).length,1);assert.equal(store.messages(scope)[0].messageId,message.messageId);
 }
});
