'use strict';
// Fictional Store/wire contracts only. Scripted proposals are not evidence of
// natural-language interpretation, conversational quality or desktop behavior.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store.cjs');
const {prepareMemoryRequest,maintainMemory}=require('../src/memory-engine.cjs');
const {scope,frozenLegacy}=require('./fixtures/evidence-backed-memory.cjs');
const SETTINGS={model:'synthetic-retirement-contract',baseUrl:'http://fixture.invalid/v1',anonymous:true,modelResponseMode:'result_tool'};
const complete=(batch,extra={})=>({reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[],...extra});
const wire=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
const rows=store=>store._memoryRecords(scope);
function legacy(t,{kind='fact'}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq023-legacy-retire-')),filename=path.join(directory,'fictional.sqlite'),Old=frozenLegacy().Store;
 let store=new Old(filename),current;
 try{
  const turn=store.appendTurn(scope,{id:'retirement-original',role:'user',kind:'discussion',text:kind==='preference'?'I used to request concise default wording.':'A fictional earlier account of a museum visit.'});
  const note=store.saveNote(scope,{id:'retirement-human-note',kind:'preference',use:'discussion',text:'For work discussion, keep the complete handoff details.'});
  const batch=store.memoryBatch(scope),result=store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind,text:kind==='preference'?'An old default concise-wording interpretation.':'An old interpretation to withdraw without inventing another fact.',sourceIds:['private:'+turn.id],...(kind==='preference'?{explicitPreference:true}:{})}]}));
  assert.equal(result.applied,true,JSON.stringify(result));const record=rows(store).find(record=>record.recordType==='item'),source=store.memorySources(scope).find(source=>source.id==='private:'+turn.id);current={record,source,note};
 }finally{store.close();}
 store=new Store(filename);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});return {store,...current};
}
function retirement(store,batch,record,source,{expectedVersion=record.version,lifecycle='withdrawn'}={}){
 const request=prepareMemoryRequest(SETTINGS,batch),p=wire(request),target=p.priorMemory.items.find(item=>item.version===record.version&&item.text===record.text);
 assert.ok(target,'the real prior record and its version must be offered');
 const original=[...p.sources,...p.contextSources].find(item=>item.text===source.text);assert.ok(original,'the complete real original must be delivered');
 const output=request.decode({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[{id:target.id,expectedVersion,lifecycle,sourceIds:[original.id]}]}});
 return {request,p,output};
}

test('normal typed retirement withdraws a legacy item without a successor and preserves its original audit and human notes',t=>{
 const {store,record,source,note}=legacy(t),batch=store.memoryBatch(scope),{request,output}=retirement(store,batch,record,source);
 const schema=JSON.parse(request.serialized).tools[0].function.parameters;assert.equal(schema.properties.items,undefined);assert.ok(schema.properties.relationshipPatch.properties.retire);
 assert.equal(store.applyMemoryBatch(scope,batch,output).applied,true);
 const after=rows(store).find(row=>row.id===record.id);assert.ok(after);assert.equal(after.recordType,'item');assert.equal(after.kind,record.kind);assert.equal(after.text,record.text);assert.equal(after.firstEvidenceAt,record.firstEvidenceAt);assert.equal(after.lastEvidenceAt,record.lastEvidenceAt);assert.deepEqual(after.sourceRevisions,record.sourceRevisions);assert.equal(after.version,record.version+1);assert.notEqual(after.status,'active');
 assert.equal(rows(store).length,1,'retirement must not manufacture a successor claim');assert.equal(store.memoryStatus(scope).semanticPending,0);assert.equal(store.getCompanion(scope).notes.find(item=>item.id===note.id).text,note.text);assert.equal(store.memorySources(scope).find(item=>item.id===source.id).revision,source.revision);
});

test('retiring an offered legacy target may cite its old delivered originals without an unrelated current citation',t=>{
 const {store,record,source}=legacy(t);let batch=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,true);
 const unrelated=store.appendTurn(scope,{role:'user',kind:'discussion',text:'An unrelated current question, not new evidence about that old account.'});batch=store.memoryBatch(scope);
 const {p,output}=retirement(store,batch,record,source);assert.equal(p.contextSources.some(item=>item.text===source.text),true);assert.equal(batch.reviewedSourceIds.includes(source.id),false);assert.ok(batch.reviewedSourceIds.includes('private:'+unrelated.id));assert.equal(store.applyMemoryBatch(scope,batch,output).applied,true);assert.equal(rows(store).find(row=>row.id===record.id).lastEvidenceAt,record.lastEvidenceAt);
});

test('source-journal no-change leaves one bounded normal semantic recovery rather than permanently stranding legacy knowledge',t=>{
 const {store,record,source}=legacy(t);const first=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,first,complete(first)).applied,true);assert.equal(store.memoryStatus(scope).pending,0);assert.equal(store.memoryStatus(scope).semanticPending,1);
 const journal=store.db.prepare('SELECT * FROM memory_journal ORDER BY seq').all(),recovery=store.memoryBatch(scope);
 assert.ok(recovery,'a consumed source journal is not completed semantic review');assert.equal(recovery.kind,'semantic_recovery');assert.deepEqual(recovery.events,[]);assert.ok(recovery.sources.some(item=>item.id===source.id&&item.text===source.text));
 assert.equal(store.applyMemoryBatch(scope,recovery,complete(recovery)).applied,true);assert.deepEqual(store.db.prepare('SELECT * FROM memory_journal ORDER BY seq').all(),journal,'semantic rereading must not reset or consume source cursors');assert.equal(rows(store).find(row=>row.id===record.id).reviewComplete,false);
 assert.equal(store.memoryBatch(scope),null,'unchanged no-decision recovery must not be selected repeatedly');const status=store.memoryStatus(scope);assert.equal(status.semanticPending,1);assert.equal(status.recoveryReady,0);assert.equal(status.recoveryDeferred,1);
});
