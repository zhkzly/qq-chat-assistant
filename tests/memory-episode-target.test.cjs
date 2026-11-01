'use strict';
// Captured fictional Store/transport contracts only; scripted output is not a
// semantic memory-quality rating or an actual desktop integration test.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const crypto=require('node:crypto'),nativeUuid=crypto.randomUUID;let forcedUuid;
crypto.randomUUID=()=>{if(forcedUuid){const value=forcedUuid;forcedUuid=undefined;return value;}return nativeUuid();};
const {Store}=require('../src/store.cjs');crypto.randomUUID=nativeUuid;
const {prepareMemoryRequest,consolidateMemory,maintainMemory}=require('../src/memory-engine.cjs');
const capture=require('./fixtures/memory-episode-target-038.json'),scope=capture.scope;
const settings={model:'gpt-6-luna',modelResponseMode:'result_tool',baseUrl:'http://fixture.invalid/v1',anonymous:true};
const copy=value=>structuredClone(value),wire=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
// Structural reason (D1 speaker-fingerprint cutover): the upgraded store
// re-hashes every source revision by design, so frozen captures keep their
// structure here while revision VALUES (and content-hash batch ids derived
// from them) are normalized away on BOTH sides of every deep comparison.
const stripRevisions=value=>{
  if(Array.isArray(value))return value.map(stripRevisions);
  if(!value||typeof value!=='object')return value;
  const out={};
  for(const [key,child]of Object.entries(value)){
    if(key==='revision'&&typeof child==='string')continue;
    if((key==='id'||key==='batchId')&&typeof child==='string'&&/^[a-f0-9]{64}$/.test(child))continue;
    if(/Revisions$/.test(key)&&child&&typeof child==='object'&&!Array.isArray(child))continue;
    out[key]=stripRevisions(child);
  }
  return out;
};
const nativeDeepEqual=assert.deepEqual.bind(assert);
// Captured results embed old-formula revisions (originalDelivery rows, source
// refs). Re-key them to the live fingerprinted projection before feeding the
// Store, mirroring what a same-version client would send.
const rekeyToLive=(store,value)=>{
  const live=new Map(store.memorySources(scope).map(source=>[source.id,source.revision]));
  const remap=item=>{
    if(Array.isArray(item))return item.map(remap);
    if(!item||typeof item!=='object')return item;
    const out={...item};
    for(const [key,child]of Object.entries(out)){
      if(/Revisions$/.test(key)&&child&&typeof child==='object'&&!Array.isArray(child)){
        const revised={};for(const [id,revision]of Object.entries(child))revised[id]=live.has(id)?live.get(id):revision;
        out[key]=revised;
      } else out[key]=remap(child);
    }
    for(const key of ['sourceId','id'])if(typeof out[key]==='string'&&live.has(out[key]))out[key==='id'?'revision':'revision']=live.get(out[key]);
    return out;
  };
  return remap(copy(value));
};
assert.deepEqual=(actual,expected,message)=>message===undefined?nativeDeepEqual(stripRevisions(actual),stripRevisions(expected)):nativeDeepEqual(stripRevisions(actual),stripRevisions(expected),message);
const noop=p=>({batchId:p.batchId,reviewedAll:true,relationshipPatch:{claims:[],events:[],retire:[]},episodes:[]});
function clock(t){t.mock.timers.enable({apis:['Date'],now:Date.parse(capture.initialAsOf)});return at=>t.mock.timers.setTime(Date.parse(at));}
function setup(t,filename=':memory:'){
 const at=clock(t),store=new Store(filename);let closed=false;t.after(()=>{if(!closed)store.close();});store.setGoal(scope,capture.goal);
 at(capture.first.at);assert.deepEqual(store.appendTurn(scope,copy(capture.first.input)),capture.first.result);
 at(capture.seedBatch.at);const seed=store.memoryBatch(scope,copy(capture.seedBatch.options));assert.deepEqual(seed,capture.seedBatch.result);
 forcedUuid=capture.batch.result.priorMemory.episodes[0].id;at(capture.seedApply.at);
 assert.deepEqual(store.applyMemoryBatch(scope,seed,rekeyToLive(store,capture.seedApply.result)),capture.seedApply.receipt);assert.equal(forcedUuid,undefined);
 at(capture.current.at);assert.deepEqual(store.appendTurn(scope,copy(capture.current.input)),capture.current.result);
 at(capture.batch.at);const batch=store.memoryBatch(scope,copy(capture.batch.options));assert.deepEqual(batch,capture.batch.result);
 return {store,batch,at,close:()=>{store.close();closed=true;}};
}
function proposal(p,id){return {...noop(p),episodes:[{...copy(capture.rejectedWire.episodes[0]),...(id===undefined?{}:{id})}]};}
function response(value){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{function:{name:'memory_result',arguments:JSON.stringify(value)}}]}}]}),{status:200});}
function ledger(store){return JSON.stringify(['memory_sources','memory_journal','memory_records','memory_dependencies','memory_receipts','memory_meta'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));}
test('actual M3 native and same-batch correction schemas explicitly offer NEW or writable episode IDs',t=>{
 const {batch}=setup(t),request=prepareMemoryRequest(settings,batch),p=wire(request),body=JSON.parse(request.serialized),schema=body.tools[0].function.parameters.properties.episodes.items;
 assert.ok(schema.required.includes('id'));assert.deepEqual(schema.properties.id.enum,['NEW',p.priorMemory.episodes[0].id]);
 const error=Object.assign(Error('missing target'),{code:'memory_navigation_target_required',field:'episodes[0].id'}),repair=JSON.parse(request.correction(JSON.stringify(proposal(p)),error).serialized),wrapper=JSON.parse(repair.messages[1].content);
 assert.deepEqual(repair.tools,body.tools);assert.deepEqual(wrapper.originalInput,p);assert.match(wrapper.task,/NEW/);assert.match(body.messages[0].content,/NEW/);
});
test('actual M3 omitted or explicit NEW old-only navigation fails before Store, offered ID and no-change remain valid',t=>{
 const {store,batch}=setup(t),request=prepareMemoryRequest(settings,batch),p=wire(request),id=p.priorMemory.episodes[0].id;
 assert.throws(()=>request.decode(proposal(p)),error=>error.code==='memory_navigation_target_required'&&error.field==='episodes[0].id');
 assert.throws(()=>request.decode(proposal(p,'NEW')),error=>error.code==='memory_navigation_creation_invalid'&&error.field==='episodes[0].id');
 const decoded=request.decode(proposal(p,id)),before=copy(batch.priorMemory.episodes[0]),sources=copy(store.memorySources(scope));
 assert.equal(decoded.episodes[0].id,before.id);assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,true);
 const current=store.searchMemory(scope,'陶艺').episodes[0];assert.equal(current.id,before.id);assert.equal(current.version,before.version+1);
 for(const field of ['sourceIds','sourceRevisions','firstEvidenceAt','lastEvidenceAt'])assert.deepEqual(current[field],before[field]);
 assert.deepEqual(store.memorySources(scope),sources);
});
test('one existing correction can select the offered episode without adding a current citation',async t=>{
 const {store,batch}=setup(t);let calls=0;const decoded=await consolidateMemory(settings,batch,undefined,async(_url,args)=>{
  const body=JSON.parse(args.body),wrapper=JSON.parse(body.messages[1].content),p=wrapper.originalInput||wrapper;calls++;
  if(calls===1)return response(proposal(p));
  assert.equal(wrapper.validationError.field,'episodes[0].id');assert.equal(wrapper.validationError.code,'memory_navigation_target_required');assert.match(wrapper.validationError.allowedShape,/NEW/);
  assert.deepEqual(wrapper.originalInput,wire(prepareMemoryRequest(settings,batch)));return response(proposal(p,p.priorMemory.episodes[0].id));
 });
 assert.equal(calls,2);assert.deepEqual(decoded.episodes[0].sourceIds,capture.rejected.result.episodes[0].sourceIds);
 assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,true);
});
test('invalid repeated episode choice leaves the whole batch and progress unchanged after one correction',async t=>{
 const {store,batch}=setup(t),before=ledger(store);let calls=0;
 await assert.rejects(consolidateMemory(settings,batch,undefined,async(_url,args)=>{calls++;const w=JSON.parse(JSON.parse(args.body).messages[1].content);return response(proposal(w.originalInput||w));}),error=>error.code==='memory_navigation_target_required');
 assert.equal(calls,2);assert.equal(ledger(store),before);assert.deepEqual(store.memoryBatch(scope,copy(capture.batch.options)),batch);
});
test('NEW current creation decodes to a genuine new Store record; legacy current creation remains compatible',t=>{
 const {store,batch}=setup(t),request=prepareMemoryRequest(settings,batch),p=wire(request),episode={id:'NEW',text:p.sources[0].text,sourceIds:[p.sources[0].id]};
 const decoded=request.decode({...noop(p),episodes:[episode]});assert.equal(Object.hasOwn(decoded.episodes[0],'id'),false);assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,true);
 assert.equal(store.memoryStatus(scope).counts.episodes,2);
 const legacy=prepareMemoryRequest(settings,capture.seedBatch.result),q=wire(legacy);assert.doesNotThrow(()=>legacy.decode({batchId:q.batchId,reviewedAll:true,items:[],episodes:[{text:q.sources[0].text,sourceIds:['s1']}],retire:[]}));
});
test('legacy implicit navigation creation cannot bypass the current reviewed-evidence requirement',t=>{
 const {batch}=setup(t),request=prepareMemoryRequest(settings,batch),p=wire(request);
 for(const kind of ['items','episodes']){
  const record={text:capture.rejectedWire.episodes[0].text,sourceIds:['c1'],...(kind==='items'?{kind:'fact',status:'active',certainty:'stated'}:{})};
  assert.throws(()=>request.decode({batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[],[kind]:[record]}),error=>error.code==='memory_navigation_creation_invalid'&&error.field===`${kind}[0].id`);
 }
});
test('actual semantic recovery rereads cannot create navigation or fabricate completion',t=>{
 const {store,batch}=setup(t),current=batch.sources[0];
 assert.equal(store.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,items:[{kind:'fact',text:'The user asked to check an old shared experience.',sourceIds:[current.id]}],episodes:[],retire:[]}).applied,true);
 const recovery=store.memoryBatch(scope);assert.equal(recovery.kind,'semantic_recovery');const request=prepareMemoryRequest(settings,recovery),p=wire(request),body=JSON.parse(request.serialized),before=copy(store.memorySources(scope));
 assert.equal(body.tools[0].function.parameters.properties.episodes.maxItems,0);
 assert.throws(()=>request.decode({...noop(p),episodes:[{id:'NEW',text:p.sources[0].text,sourceIds:[p.sources[0].id]}]}),error=>error.code==='memory_navigation_creation_invalid');
 const applied=store.applyMemoryBatch(scope,recovery,request.decode(noop(p)));assert.equal(applied.applied,true);assert.equal(applied.receipt.outcome,'semantic_review_unfinished');assert.deepEqual(store.memorySources(scope),before);
});
test('a provided negative and its later explicit correction retain original IDs, dates and revisions',t=>{
 const at=clock(t),store=new Store(':memory:');t.after(()=>store.close());at('2026-09-20T12:00:00Z');
 const negative=store.appendTurn(scope,{id:'negative-radio-original',role:'user',kind:'discussion',text:'我以前没有修过收音机。'}),first=store.memoryBatch(scope),request=prepareMemoryRequest(settings,first),p=wire(request);
 assert.equal(store.applyMemoryBatch(scope,first,request.decode({...noop(p),episodes:[{id:'NEW',text:negative.text,sourceIds:[p.sources[0].id]}]})).applied,true);
 const old=store._memoryRecords(scope)[0];at('2026-09-21T12:00:00Z');const correction=store.appendTurn(scope,{id:'radio-correction-original',role:'user',kind:'discussion',text:'刚才说错了，我去年修过家里的收音机。'}),batch=store.memoryBatch(scope),next=prepareMemoryRequest(settings,batch),q=wire(next);
 const result=next.decode({...noop(q),episodes:[{id:q.priorMemory.episodes[0].id,text:correction.text,sourceIds:[q.contextSources[0].id,q.sources[0].id]}]});assert.equal(store.applyMemoryBatch(scope,batch,result).applied,true);
 const after=store._memoryRecords(scope)[0];assert.equal(after.id,old.id);assert.equal(after.version,old.version+1);assert.equal(after.firstEvidenceAt,old.firstEvidenceAt);assert.equal(after.lastEvidenceAt,'2026-09-21T12:00:00.000Z');
 assert.deepEqual(after.sourceIds,[`private:${negative.id}`,`private:${correction.id}`]);assert.equal(after.sourceRevisions[`private:${negative.id}`],old.sourceRevisions[`private:${negative.id}`]);
});
test('wrong kind, unoffered, read-only and incomplete originals never become episode update authority',t=>{
 const {batch}=setup(t),p=wire(prepareMemoryRequest(settings,batch));
 assert.throws(()=>prepareMemoryRequest(settings,batch).decode(proposal(p,'m999')),error=>error.code==='unknown_memory_record_alias');
 const wrong=copy(batch);wrong.priorMemory.items=[{...wrong.priorMemory.episodes[0],recordType:'item'}];wrong.priorMemory.episodes=[];
 const w=prepareMemoryRequest(settings,wrong),wp=wire(w);assert.throws(()=>w.decode(proposal(wp,wp.priorMemory.items[0].id)),error=>error.code==='wrong_memory_record_type');
 for(const patch of ['read_only','missing_original']){
  const b=copy(batch);if(patch==='read_only')b.priorMemory.episodes[0].evidenceOffer={authority:'read_only'};else b.contextSources=[];
  const request=prepareMemoryRequest(settings,b),input=wire(request),id=input.priorMemory.episodes[0].id;
  const invalid=proposal(input,id);
  // A current citation cannot repair missing original support for this target.
  if(patch==='missing_original')invalid.episodes[0].sourceIds=[input.sources[0].id];
  assert.equal(input.priorMemory.episodes[0].updateAuthority,'read_only');assert.throws(()=>request.decode(invalid),error=>error.code==='memory_navigation_target_read_only');
 }
});
for(const mode of ['wrong_revision','wrong_body','foreign_scope','withdrawn','missing_original'])test(`actual original proof remains guarded and atomic: ${mode}`,t=>{
 const {store,batch}=setup(t),request=prepareMemoryRequest(settings,batch),p=wire(request),decoded=request.decode(proposal(p,p.priorMemory.episodes[0].id));
 const id=batch.priorMemory.episodes[0].sourceIds[0],proof=decoded.originalDelivery.find(source=>source.id===id);
 if(mode==='wrong_revision')proof.revision='wrong';if(mode==='wrong_body')proof.text+='x';if(mode==='foreign_scope')proof.scope.peerUid='foreign';if(mode==='withdrawn')store.forgetSource(scope,id);if(mode==='missing_original')decoded.originalDelivery=decoded.originalDelivery.filter(source=>source.id!==id);
 const before=ledger(store);assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,false);assert.equal(ledger(store),before);
});
test('no-change preserves original episode version while finishing this actual reviewed journal prefix',t=>{
 const {store,batch}=setup(t),request=prepareMemoryRequest(settings,batch),p=wire(request),before=copy(batch.priorMemory.episodes[0]);assert.equal(store.applyMemoryBatch(scope,batch,request.decode(noop(p))).applied,true);
 assert.deepEqual(store._memoryRecords(scope).find(row=>row.id===before.id),before);assert.equal(store.memoryStatus(scope).pending,0);
});
test('a baseline-created rejected persistent batch reopens and retries under the new wire without source migration',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qq-episode038-')),filename=path.join(folder,'memory.sqlite');t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const {store,batch,close}=setup(t,filename);assert.deepEqual(store.applyMemoryBatch(scope,batch,rekeyToLive(store,capture.rejected.result)),capture.rejected.receipt);store.recordMemoryError(scope,{code:'invalid_memory_result',message:capture.rejected.receipt.detail});
 const sources=copy(store.memorySources(scope));close();const reopened=new Store(filename);t.after(()=>reopened.close());let calls=0;
 const result=await maintainMemory({store:reopened,scope,settings,maxBatches:1,model:(configured,b,signal)=>consolidateMemory(configured,b,signal,async(_url,args)=>{calls++;const p=JSON.parse(JSON.parse(args.body).messages[1].content);return response(proposal(p,p.priorMemory.episodes[0].id));})});
 assert.equal(calls,1);assert.equal(result.errors.length,0);assert.equal(result.pending,0);assert.deepEqual(reopened.memorySources(scope),sources);assert.equal(result.counts.episodes,1);
});
