'use strict';
// Runs only against an explicitly supplied immutable pre-review source copy.
// The input and database contain fictional messages and never call a model.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const {Store}=require(path.join(config.sourceRoot,'src/store.cjs'));
const {prepareMemoryRequest}=require(path.join(config.sourceRoot,'src/memory-engine.cjs'));
const {normalize}=require(path.join(config.sourceRoot,'src/messages.cjs'));
const {scope,raw}=require('./native.cjs'),captured=require('./memory-self-reaffirmation.json');
const store=new Store(config.filename),settings={model:'offline-legacy-upgrade',memoryInputBytes:100000};
const originalId='qq:720575940379279370000025201',decisionId='qq:720575940379279370000025202';
function add(id,text,at){store.add(scope,[normalize(raw(id.slice(3),false,{msgTime:String(Date.parse(at)/1000),elements:[{textElement:{content:text}}]}),scope)]);}
function apply(make){
 const batch=store.memoryBatch(scope,{maxBytes:100000}),request=prepareMemoryRequest(settings,batch),input=JSON.parse(JSON.parse(request.serialized).messages[1].content);
 const output={batchId:input.batchId,reviewedAll:true,episodes:[],relationshipPatch:make(input,batch)};
 const result=store.applyMemoryBatch(scope,batch,request.decode(output));assert.equal(result.applied,true,JSON.stringify(result));
}
add(originalId,'这周换班有点累，暂时没空跑步，跑步还是喜欢的。','2026-09-01T10:30:00Z');
apply(()=>structuredClone(captured.initial.relationshipPatch));
const before=store.relationshipView(scope).claims.find(row=>row.aspect==='recent_context');
add(decisionId,'恢复正常下班了；先前的暂停跑步只适用于换班那周。','2026-09-21T10:30:00Z');
apply((input,batch)=>{
 const prior=input.priorMemory.claims.find(row=>row.aspect==='recent_context'),source=input.sources[batch.sources.findIndex(row=>row.id===decisionId)];
 return {claims:[{...captured.later14.relationshipPatch.claims[1],id:prior.id,expectedVersion:prior.version,text:'Historical proposal containing the now withdrawn decision detail.',sourceIds:[source.id],transition:{operation:'supersede',targets:[{id:prior.id,expectedVersion:prior.version}]}}],events:[],retire:[]};
});
if(config.withdrawBeforeUpgrade)store.forgetSource(scope,decisionId);
const historical=store.relationshipView(scope).claims.find(row=>row.id===before.id);
assert.equal(historical.retiredSemanticSignatures,undefined,'fixture must really use the pre-fix Store');
assert.equal(historical.transition.sourceRevisions,undefined,'fixture must really lack decision dependencies');
store.close();fs.writeFileSync(config.resultFile,JSON.stringify({before,historical,decisionId,withdrawBeforeUpgrade:config.withdrawBeforeUpgrade}));
