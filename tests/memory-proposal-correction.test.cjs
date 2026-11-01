'use strict';
// Decision-split memory write-gate contracts (design B1): the generation
// model proposes content only; preference classification is program/user-owned.
// The old explicitPreference wire-attestation class is gone by construction,
// preference proposals land as first-class candidate receipts, and the wire
// correction round survives only for genuinely invalid protocol output.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {consolidateMemory,maintainMemory,prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {TaskLedger}=require('../src/request-budget.cjs');
const {scope}=require('./fixtures/native.cjs');
const rejectedItem=require('./fixtures/memory-preference-update.cjs');
const settings={baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true};
const input=request=>JSON.parse(JSON.parse(request.body).messages[1].content);
const noop=p=>({batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[]});
const response=(value,mode='json_object')=>({ok:true,status:200,json:async()=>({usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},choices:[{message:
  mode==='result_tool'
  ?{tool_calls:[{function:{name:'memory_result',arguments:typeof value==='string'?value:JSON.stringify(value)}}]}
  :{content:typeof value==='string'?value:JSON.stringify(value)}}]})});
const proposal=(p,change={})=>({...noop(p),items:[{kind:'preference',text:'用户希望只在对方明确忙时简短回复。',sourceIds:['s1'],status:'active',certainty:'stated',...change}],episodes:[],retire:[]});
function storeFor(t){const s=new Store(':memory:');t.after(()=>s.close());return s;}
function append(s,text='只有她明确说忙时我才想简短回复，她有空分享时不用套这个要求。'){return s.appendTurn(scope,{role:'user',kind:'discussion',text});}
function run(s,fetchImpl,overrides={}){return maintainMemory({store:s,scope,settings:{...settings,...overrides},maxBatches:1,
  model:(configured,batch,signal)=>consolidateMemory(configured,batch,signal,fetchImpl)});}
// A legacy preference item can now only exist as pre-decision-split data:
// inject one directly, exactly as an upgraded old database would carry it.
function injectLegacyPreferenceItem(s,sourceId,text){
  const id='legacy-preference-'+text.length,now=new Date().toISOString(),source=s.memorySources(scope).find(row=>row.id===sourceId);
  const record={id,kind:'preference',text,sourceIds:[sourceId],sourceRevisions:{[sourceId]:source.revision},topicKeys:[],status:'active',certainty:'stated',
    reviewComplete:false,semanticReview:{status:'legacy_unreviewed'},firstEvidenceAt:source.at,lastEvidenceAt:source.at,at:source.at,version:1,
    createdAt:now,updatedAt:now,recordType:'item',knowledgeSchemaVersion:2};
  s.db.prepare('INSERT INTO memory_records VALUES(?,?,?,?)').run(s.scopeKey(scope),id,'item',JSON.stringify(record));
  s.db.prepare('INSERT INTO memory_dependencies VALUES(?,?,?,?)').run(s.scopeKey(scope),id,sourceId,source.revision);
  return record;
}
function preferenceUpdate(s){
  const old=append(s,'我以后都想回应具体细节，不想机械用通用话题，也不想编造共同经历。');
  let batch=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,items:[
    {kind:'fact',text:'用户在私下回顾交流',sourceIds:[`private:${old.id}`]}],episodes:[],retire:[]}).applied,true);
  for(let i=0;i<4;i++)append(s,`第${i+1}次交流回顾：我仍想回应具体细节，适度提问，分享真实经历，不编造共同经历。😀`);
  injectLegacyPreferenceItem(s,`private:${old.id}`,rejectedItem.text);
  return s.memoryBatch(scope);
}

test('a captured existing preference update lands as a candidate in both response modes without any correction',async t=>{
  for(const mode of ['json_object','result_tool'])await t.test(mode,async t=>{
    const s=storeFor(t),batch=preferenceUpdate(s),before=JSON.stringify(batch),requests=[];
    const prior=batch.priorMemory.items.find(item=>item.kind==='preference');
    assert.ok(prior,'the legacy preference item is delivered for rereview');
    let first;
    const decoded=await consolidateMemory({...settings,modelResponseMode:mode},batch,undefined,async(_,request)=>{
      const body=JSON.parse(request.body),p=input(request);requests.push(body);
      first=p;const alias=p.priorMemory.items.find(item=>item.kind==='preference').id;
      assert.match(body.messages[0].content,/single logical knowledge writer/);
      assert.match(body.messages[0].content,/program- and user-owned/);
      // Structural reason (B1): the alias-bound preference update needs no
      // attestation round any more — the wire accepts it and the store files
      // it as a candidate receipt.
      return response({...noop(p),items:[{...rejectedItem,id:alias}]},mode);
    });
    assert.equal(requests.length,1,'no correction round is spent on preference classification');
    assert.equal(JSON.stringify(batch),before);
    const applied=s.applyMemoryBatch(scope,batch,decoded);
    assert.equal(applied.applied,true,JSON.stringify(applied));
    assert.ok(applied.receipt.quarantinedRecords?.some(entry=>entry.code==='preference_candidate'),'the update lands as a candidate');
    const stored=s._memoryRecords(scope).find(row=>row.id===prior.id);
    assert.equal(stored.version,1,'the legacy preference item is never rewritten by a candidate');
    assert.equal(s.memoryStatus(scope).pending,0,'the journal advances past the candidate');
    assert.equal(s.quarantinedProposals(scope,{status:'candidate'}).length,1);
  });
});

test('new and existing preference proposals decode for any flag value and never commit records',async t=>{
  for(const existing of [false,true])await t.test(existing?'existing':'new',async t=>{
    const s=storeFor(t);const batch=existing?preferenceUpdate(s):(append(s),s.memoryBatch(scope));
    const prepared=prepareMemoryRequest(settings,batch),p=JSON.parse(JSON.parse(prepared.serialized).messages[1].content);
    const id=existing?p.priorMemory.items.find(item=>item.kind==='preference').id:undefined;
    for(const flag of [undefined,false,'true',1]){
      const decoded=prepared.decode(proposal(p,{...(id?{id}:{}),...(flag===undefined?{}:{explicitPreference:flag})}));
      assert.equal(decoded.items[0].explicitPreference,undefined,'the deprecated flag never survives the wire');
    }
    let calls=0;const result=await consolidateMemory(settings,batch,undefined,async(_,request)=>{calls++;return response(proposal(input(request),{...(id?{id}:{}),explicitPreference:true}));});
    assert.equal(calls,1);
    const applied=s.applyMemoryBatch(scope,batch,result);
    assert.equal(applied.applied,true);
    assert.ok(!s.searchMemory(scope,'简短回复').items.some(item=>item.kind==='preference'),'no preference record is ever committed');
  });
});

test('correction still exists for invalid protocol output and may omit or reclassify',async t=>{
  for(const kind of ['fact','omit'])await t.test(kind,async t=>{
    const s=storeFor(t);append(s,'这一次我想短一点，今天没心情写长句。');let calls=0;
    const result=await run(s,async(_,request)=>{
      calls++;const p=input(request),original=p.originalInput||p;
      if(calls===1)return response('{malformed',kind);
      assert.equal(p.validationError.code,'invalid_memory_json');
      assert.ok(p.validationError.allowedShape);
      return response(kind==='omit'?noop(original):{...noop(original),items:[{kind:'fact',text:'用户这一次希望短一点。',sourceIds:['s1']}]},kind);
    });
    assert.equal(calls,2);assert.equal(result.pending,0);
    assert.equal(s.searchMemory(scope,'短一点').items.some(item=>item.kind==='preference'),false);
  });
});

test('invalid JSON gets only one correction; a preference-bearing corrected proposal commits as a candidate',async t=>{
  const s=storeFor(t);append(s);const before=s.memoryBatch(scope).events;let calls=0;
  const result=await run(s,async(_,request)=>{
    calls++;const p=input(request),original=p.originalInput||p;
    if(calls===1)return response('{"PRIVATE_SYNTHETIC_SENTENCE":');
    assert.equal(p.validationError.code,'invalid_memory_json');
    assert.ok(p.validationError.field&&p.validationError.allowedShape);
    return response({...proposal(original,{explicitPreference:false}),episodes:[{text:'Would otherwise be valid',sourceIds:['s1']}]});
  });
  assert.equal(calls,2);assert.equal(result.status,'complete');assert.equal(result.pending,0);
  assert.ok(s.quarantinedProposals(scope,{status:'candidate'}).some(entry=>entry.code==='preference_candidate'));
  assert.equal(s.searchMemory(scope,'简短回复').items.some(item=>item.kind==='preference'),false);
  assert.equal(JSON.stringify(result.errors||[]).includes('PRIVATE_SYNTHETIC_SENTENCE'),false);
});

test('feedback, copied or wrapped local evidence can never authorize a durable preference',async t=>{
  for(const source of ['canonical','copy','wrapper'])await t.test(source,async t=>{
    const s=storeFor(t);s.saveRun(scope,{id:'fixture-run'});
    const f=s.addFeedback(scope,{requestId:'fixture-run',text:'这一次太正式',kind:'local'});
    const id=`private:feedback-${f.id}`;
    if(source!=='canonical'){
      const copy=s.saveNote(scope,{text:'只因这一次太正式',use:'discussion',evidenceSourceIds:[id]});
      if(source==='wrapper')s.saveNote(scope,{kind:'material',text:'包裹的本地反馈',use:'discussion',evidenceSourceIds:[`note:${copy.id}`]});
    }
    let calls=0;const result=await run(s,async(_,request)=>{
      calls++;const p=input(request),target=source==='canonical'?p.sources.find(s=>s.type==='feedback'):p.sources.find(s=>s.type==='note'&&s.text===(source==='copy'?'只因这一次太正式':'包裹的本地反馈'));
      return response(proposal(p,{sourceIds:[target.id],explicitPreference:true}));
    });
    assert.equal(calls,1,'no correction round is spent on preference classification');
    assert.equal(result.status,'complete');
    const proposals=s.preferenceUpgradeProposals(scope,{status:'pending'});
    assert.equal(proposals.length,1,'the candidate surfaces for user decision');
    const decision=s.resolvePreferenceUpgrade(scope,{id:proposals[0].id,decision:'authorize'});
    assert.equal(decision.applied,false,'local feedback lineage never authorizes durability');
    assert.equal(s.relationshipView(scope).claims.filter(claim=>claim.applicabilityKind==='recurring').length,0);
  });
});

test('source edit, withdrawal, stopped scope and abort during correction never commit stale progress',async t=>{
  for(const action of ['edit','withdraw','scope','abort'])await t.test(action,async t=>{
    const s=storeFor(t),u=append(s),abort=new AbortController();let calls=0,allowed=true;
    const result=await maintainMemory({store:s,scope,settings,signal:abort.signal,maxBatches:1,shouldContinue:()=>allowed,
      model:(configured,batch,signal)=>consolidateMemory(configured,batch,signal,async(_,request)=>{
        calls++;const p=input(request);if(calls===1)return response('{',"result_tool");
        if(action==='edit')s.updateTurn(scope,u.id,'后来纠正了这段原话');
        if(action==='withdraw')s.forgetSource(scope,`private:${u.id}`);
        if(action==='scope')allowed=false;
        if(action==='abort')abort.abort();
        return response(proposal(p.originalInput,{explicitPreference:true}),"result_tool");
      })});
    assert.equal(calls,2);assert.equal(result.status,['scope','abort'].includes(action)?'stopped':'rejected');
    assert.equal(result.counts.items,0);
  });
});

test('same captured aliases and full Unicode segment survive caller batch mutation before repair',async t=>{
  const s=storeFor(t);append(s,'完整原始段😀引用"与\\转义\n'.repeat(1300));
  const batch=s.memoryBatch(scope,{maxBytes:5000});assert.ok(batch.sources[0].segment.end<batch.sources[0].segment.total);
  let first,calls=0;const result=await consolidateMemory(settings,batch,undefined,async(_,request)=>{
    calls++;const p=input(request);
    if(calls===1){first=p;batch.sources[0].text='MUTATED_CALLER_TEXT';batch.reviewedSourceIds.length=0;return response('{');}
    assert.deepEqual(p.originalInput,first);assert.ok(p.originalInput.sources[0].text.endsWith('😀')||!/[�-�]$/.test(p.originalInput.sources[0].text));
    assert.equal(p.originalInput.sources[0].segment.end,first.sources[0].segment.end);
    return response({...noop(p.originalInput),items:[{kind:'fact',text:'仅供部分片段的理解',sourceIds:['s1']}]});
  });
  assert.equal(calls,2);assert.equal(result.reviewedSourceIds.length,1);
  assert.equal(s.applyMemoryBatch(scope,batch,result).applied,false,'mutating caller batch still fails the Store fingerprint');
});

test('a successfully repaired partial segment advances only its original cursor and remains incomplete evidence',async t=>{
  const s=storeFor(t),original='长来源中的完整原话😀。'.repeat(1600),u=append(s,original);
  const batch=s.memoryBatch(scope,{maxBytes:5000}),before=JSON.stringify(batch),segment=batch.sources[0].segment;
  assert.ok(segment.end<segment.total);let calls=0;
  const result=await consolidateMemory(settings,batch,undefined,async(_,request)=>{
    calls++;const p=input(request);if(calls===1)return response('{');
    assert.equal(p.originalInput.sources[0].text,batch.sources[0].text);assert.deepEqual(p.originalInput.sources[0].segment,segment);
    return response({...noop(p.originalInput),items:[{kind:'fact',text:'仅是长来源里已读片段的描述',sourceIds:['s1']}]});
  });
  assert.equal(calls,2);assert.equal(JSON.stringify(batch),before);
  assert.equal(s.applyMemoryBatch(scope,batch,result).applied,true);
  const next=s.memoryBatch(scope,{maxBytes:5000});assert.equal(next.sources[0].segment.offset,segment.end);
  assert.equal(s.memoryStatus(scope).pending,1);assert.equal(s.memoryStatus(scope).processed,0);
  assert.equal(s.searchMemory(scope,'已读片段').items[0].reviewComplete,false);
  assert.equal(s.memorySources(scope).find(source=>source.id===`private:${u.id}`).text,original);
});

test('an oversized correction degrades its diagnostic echo and still completes without truncating evidence',async t=>{
  // Structural reason (stream-B correction degradation ladder, kept intact by
  // the decision-split change): a correction that cannot carry the full echo
  // of a large invalid response degrades the echo, never the bound evidence.
  const s=storeFor(t);append(s,'原始Unicode😀与JSON"\\\n'.repeat(200));
  let calls=0;const echoes=[];
  const result=await run(s,async(_,request)=>{
    calls++;const p=input(request);
    if(calls===1)return response(('{malformed').repeat(400));
    echoes.push(JSON.stringify(p.invalidResponse).length);
    assert.ok(p.originalInput.sources.length>=1,'the bound originalInput is never truncated');
    return response(noop(p.originalInput));
  });
  assert.equal(calls,2);
  assert.equal(result.status,'complete');assert.equal(result.pending,0);
  assert.ok(echoes[0]<=('{malformed'.repeat(400)).length+16,'the degraded echo stays bounded');
});

test('transport retries and logical correction share the existing request ledger and limit',async t=>{
  for(const limit of [1,3])await t.test(`limit ${limit}`,async t=>{
    const s=storeFor(t);append(s);let calls=0;const budget=new TaskLedger(s).create(scope,{inputDigest:'synthetic-memory-correction',origin:'maintenance',limit});
    const result=await run(s,async(_,request)=>{
      calls++;const p=input(request);
      if(calls===1)return {ok:false,status:500,headers:{get:()=>null}};
      if(calls===2)return response('{malformed');
      return response(noop(p.originalInput||p));
    },{requestBudget:budget.forStage('memory_maintenance')});
    const ledger=budget.snapshot();assert.equal(calls,limit);assert.equal(ledger.attempts,limit);
    if(limit===1){assert.equal(result.status,'error');assert.equal(result.processed,0);assert.equal(result.errors[0].code,'request_budget_exhausted');}
    else{assert.equal(result.processed,1);assert.deepEqual(ledger.requests.map(r=>r.purpose),['memory_maintenance','memory_maintenance','memory_proposal_correction']);}
  });
});

test('HTTP authentication failures and an already aborted request do not trigger logical correction',async t=>{
  const s=storeFor(t);append(s);const batch=s.memoryBatch(scope);let calls=0;
  await assert.rejects(()=>consolidateMemory(settings,batch,undefined,async()=>{calls++;return {ok:false,status:401,json:async()=>({error:{message:'Unauthorized fixture'}})};}),/Unauthorized fixture|401|Model request failed/);
  assert.equal(calls,1);const abort=new AbortController();abort.abort();
  await assert.rejects(()=>consolidateMemory(settings,batch,abort.signal,async()=>{calls++;throw new Error('must not run');}),error=>error.name==='AbortError');
});
