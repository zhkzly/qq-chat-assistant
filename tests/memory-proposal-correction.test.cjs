'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {consolidateMemory,maintainMemory,prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {TaskLedger}=require('../src/request-budget.cjs');
const {scope}=require('./fixtures/native.cjs');
const rejectedItem=require('./fixtures/memory-preference-update.cjs');
const settings={baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true};
const input=request=>JSON.parse(JSON.parse(request.body).messages[1].content);
const noop=p=>({batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[]});
const response=(value,mode='json_object')=>({ok:true,status:200,json:async()=>({usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},choices:[{message:mode==='result_tool'
  ?{tool_calls:[{function:{name:'memory_result',arguments:typeof value==='string'?value:JSON.stringify(value)}}]}
  :{content:typeof value==='string'?value:JSON.stringify(value)}}]})});
const proposal=(p,change={})=>({...noop(p),items:[{kind:'preference',text:'用户希望只在对方明确忙时简短回复。',sourceIds:['s1'],status:'active',certainty:'stated',...change}]});
function storeFor(t){const s=new Store(':memory:');t.after(()=>s.close());return s;}
function append(s,text='只有她明确说忙时我才想简短回复，她有空分享时不用套这个要求。'){return s.appendTurn(scope,{role:'user',kind:'discussion',text});}
function run(s,fetchImpl,overrides={}){return maintainMemory({store:s,scope,settings:{...settings,...overrides},maxBatches:1,
  model:(configured,batch,signal)=>consolidateMemory(configured,batch,signal,fetchImpl)});}
function preferenceUpdate(s){
  const old=append(s,'我以后都想回应具体细节，不想机械用通用话题，也不想编造共同经历。');
  let batch=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,items:[
    {kind:'fact',text:'用户在私下回顾交流',sourceIds:[`private:${old.id}`]},
    {...rejectedItem,id:undefined,sourceIds:[`private:${old.id}`],explicitPreference:true}],episodes:[],retire:[]}).applied,true);
  for(let i=0;i<4;i++)append(s,`第${i+1}次交流回顾：我仍想回应具体细节，适度提问，分享真实经历，不编造共同经历。😀`);
  return s.memoryBatch(scope);
}

test('captured failed existing preference update gets one same-batch correction in both response modes',async t=>{
  for(const mode of ['json_object','result_tool'])await t.test(mode,async t=>{
    const s=storeFor(t),batch=preferenceUpdate(s),before=JSON.stringify(batch),requests=[];
    const prior=batch.priorMemory.items.find(item=>item.kind==='preference');
    assert.equal(prior.explicitPreference,undefined,'stored records deliberately do not retain a producer attestation');
    let first,rejected;
    const decoded=await consolidateMemory({...settings,modelResponseMode:mode},batch,undefined,async(_,request)=>{
      const body=JSON.parse(request.body),p=input(request);requests.push(body);
      if(requests.length===1){
        first=p;const alias=p.priorMemory.items.find(item=>item.kind==='preference').id;
        assert.match(body.messages[0].content,/single logical knowledge writer/);
        assert.match(body.messages[0].content,/local feedback is not a recurring preference/);
        // Rebind only the prior-record alias to this independently rebuilt Store.
        rejected={...noop(p),items:[{...rejectedItem,id:alias}]};
        return response(rejected,mode);
      }
      assert.equal(p.purpose,'memory_proposal_correction');assert.deepEqual(p.originalInput,first);
      assert.equal(p.originalInput.batchId,first.batchId);assert.deepEqual(p.originalInput.sources,first.sources);
      assert.deepEqual(p.originalInput.contextSources,first.contextSources);assert.deepEqual(p.originalInput.priorMemory,first.priorMemory);
      assert.deepEqual(JSON.parse(p.invalidResponse),rejected,'the code did not inject the missing flag into rejected output');
      assert.equal(p.validationError.code,'memory_preference_attestation_required');assert.equal(p.validationError.field,'items[0].explicitPreference');
      assert.match(p.validationError.allowedShape,/kind=preference.*explicitPreference:true/);
      if(mode==='result_tool'){
        const properties=body.tools[0].function.parameters.properties;
        assert.equal(properties.items,undefined,'normal schema does not recreate the legacy parallel knowledge lane');
        assert.ok(properties.relationshipPatch.properties.claims.items.properties.applicabilityKind);
        assert.equal(properties.relationshipPatch.anyOf,undefined,'flat schema preserves existing proxy conversion and padding paths');
      }else assert.deepEqual(body.response_format,{type:'json_object'});
      return response({...rejected,items:[{...rejected.items[0],explicitPreference:true}]},mode);
    });
    assert.equal(requests.length,2);assert.equal(JSON.stringify(batch),before);
    assert.equal(decoded.items[0].id,prior.id);assert.equal(decoded.items[0].explicitPreference,true);
    assert.equal(s.applyMemoryBatch(scope,batch,decoded).applied,true);assert.equal(s.memoryStatus(scope).pending,0);
    assert.equal(s.searchMemory(scope,'回应具体细节').items.filter(item=>item.kind==='preference').length,1);
  });
});

test('new and existing preferences need fresh true attestation; valid first response uses one HTTP',async t=>{
  for(const existing of [false,true])await t.test(existing?'existing':'new',async t=>{
    const s=storeFor(t);const batch=existing?preferenceUpdate(s):(append(s),s.memoryBatch(scope));
    const prepared=prepareMemoryRequest(settings,batch),p=JSON.parse(JSON.parse(prepared.serialized).messages[1].content);
    const id=existing?p.priorMemory.items.find(item=>item.kind==='preference').id:undefined;
    for(const flag of [undefined,false,'true',1])assert.throws(()=>prepared.decode(proposal(p,{...(id?{id}:{}),...(flag===undefined?{}:{explicitPreference:flag})})),error=>error.code==='memory_preference_attestation_required');
    let calls=0;const result=await consolidateMemory(settings,batch,undefined,async(_,request)=>{calls++;return response(proposal(input(request),{...(id?{id}:{}),explicitPreference:true}));});
    assert.equal(calls,1);assert.equal(s.applyMemoryBatch(scope,batch,result).applied,true);
  });
});

test('correction may reclassify or omit a one-off proposal, without adding preference authority',async t=>{
  for(const kind of ['fact','omit'])await t.test(kind,async t=>{
    const s=storeFor(t);append(s,'这一次我想短一点，今天没心情写长句。');let calls=0;
    const result=await run(s,async(_,request)=>{
      calls++;const p=input(request),original=p.originalInput||p;
      if(calls===1)return response(proposal(original,{explicitPreference:false}));
      assert.equal(JSON.parse(p.invalidResponse).items[0].explicitPreference,false);
      return response(kind==='omit'?noop(original):{...noop(original),items:[{kind:'fact',text:'用户这一次希望短一点。',sourceIds:['s1']}]});
    });
    assert.equal(calls,2);assert.equal(result.pending,0);assert.equal(s.searchMemory(scope,'短一点').items.some(item=>item.kind==='preference'),false);
  });
});

test('invalid JSON gets only one correction and failed corrected proposals commit no partial changes',async t=>{
  for(const first of ['json','missing'])await t.test(first,async t=>{
    const s=storeFor(t);append(s);const before=s.memoryBatch(scope).events;let calls=0;
    const result=await run(s,async(_,request)=>{
      calls++;const p=input(request),original=p.originalInput||p;
      if(calls===1)return response(first==='json'?'{"PRIVATE_SYNTHETIC_SENTENCE":':proposal(original));
      assert.equal(p.validationError.code,first==='json'?'invalid_memory_json':'memory_preference_attestation_required');
      assert.ok(p.validationError.field&&p.validationError.allowedShape);
      return response({...proposal(original,{explicitPreference:false}),episodes:[{text:'Would otherwise be valid',sourceIds:['s1']}]});
    });
    assert.equal(calls,2);assert.equal(result.status,'error');assert.equal(result.processed,0);assert.equal(result.pending,1);
    assert.equal(result.counts.items,0);assert.equal(result.counts.episodes,0);assert.equal(result.lastReview,null);
    assert.deepEqual(s.memoryBatch(scope).events,before);assert.equal(result.errors[0].code,'memory_preference_attestation_required');
    assert.equal(JSON.stringify(result.errors).includes('PRIVATE_SYNTHETIC_SENTENCE'),false);
  });
});

test('true flag cannot bypass canonical, copied or wrapped local feedback authority',async t=>{
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
    assert.equal(calls,1,'Store authority failures are never sent for wire correction');
    assert.equal(result.status,'rejected');assert.equal(result.processed,0);assert.equal(result.counts.items,0);
    assert.ok(result.pending>0);assert.equal(result.lastReview,null);
  });
});

test('source edit, withdrawal, stopped scope and abort during correction never commit stale progress',async t=>{
  for(const action of ['edit','withdraw','scope','abort'])await t.test(action,async t=>{
    const s=storeFor(t),u=append(s),abort=new AbortController();let calls=0,allowed=true;
    const result=await maintainMemory({store:s,scope,settings,signal:abort.signal,maxBatches:1,shouldContinue:()=>allowed,
      model:(configured,batch,signal)=>consolidateMemory(configured,batch,signal,async(_,request)=>{
        calls++;const p=input(request);if(calls===1)return response(proposal(p));
        if(action==='edit')s.updateTurn(scope,u.id,'后来纠正了这段原话');
        if(action==='withdraw')s.forgetSource(scope,`private:${u.id}`);
        if(action==='scope')allowed=false;
        if(action==='abort')abort.abort();
        return response(proposal(p.originalInput,{explicitPreference:true}));
      })});
    assert.equal(calls,2);assert.equal(result.status,['scope','abort'].includes(action)?'stopped':'rejected');
    assert.equal(result.processed,0);assert.equal(result.counts.items,0);assert.equal(result.lastReview,null);
  });
});

test('same captured aliases and full Unicode segment survive caller batch mutation before repair',async t=>{
  const s=storeFor(t);append(s,'完整原始段😀引用"与\\转义\n'.repeat(1300));
  const batch=s.memoryBatch(scope,{maxBytes:5000});assert.ok(batch.sources[0].segment.end<batch.sources[0].segment.total);
  let first,calls=0;const result=await consolidateMemory(settings,batch,undefined,async(_,request)=>{
    calls++;const p=input(request);
    if(calls===1){first=p;batch.sources[0].text='MUTATED_CALLER_TEXT';batch.reviewedSourceIds.length=0;return response('{');}
    assert.deepEqual(p.originalInput,first);assert.ok(p.originalInput.sources[0].text.endsWith('😀')||!/[\uD800-\uDBFF]$/.test(p.originalInput.sources[0].text));
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

test('complete oversized correction fails before a second HTTP without truncation or cursor progress',async t=>{
  const s=storeFor(t);append(s,'原始Unicode😀与JSON"\\\n'.repeat(200));
  const batch=s.memoryBatch(scope),initial=prepareMemoryRequest(settings,batch);let calls=0;
  const result=await run(s,async(_,request)=>{calls++;assert.ok(Buffer.byteLength(request.body,'utf8')<=initial.bytes+10);return response(proposal(input(request)));},
    {memoryInputBytes:initial.bytes+10});
  assert.equal(calls,1);assert.equal(result.status,'error');assert.equal(result.errors[0].code,'memory_request_budget_exceeded');
  assert.match(result.errors[0].message,/correction request.*complete serialized/);assert.ok(result.errors[0].requiredBytes>initial.bytes+10);
  assert.equal(result.pending,1);assert.equal(result.processed,0);assert.equal(result.lastReview,null);
  assert.deepEqual(s.memoryBatch(scope).events,batch.events);
});

test('transport retries and logical correction share the existing request ledger and limit',async t=>{
  for(const limit of [1,3])await t.test(`limit ${limit}`,async t=>{
    const s=storeFor(t);append(s);const budget=new TaskLedger(s).create(scope,{inputDigest:'synthetic-memory-correction',origin:'maintenance',limit});let calls=0;
    const result=await run(s,async(_,request)=>{
      calls++;if(limit===3&&calls===1)return {ok:false,status:500,headers:{get:()=>null}};
      const p=input(request);return response(proposal(p.originalInput||p,p.originalInput?{explicitPreference:true}:{}));
    },{requestBudget:budget.forStage('memory_maintenance')});
    const ledger=budget.snapshot();assert.equal(calls,limit);assert.equal(ledger.attempts,limit);
    if(limit===1){assert.equal(result.status,'error');assert.equal(result.processed,0);assert.equal(result.errors[0].code,'request_budget_exhausted');}
    else{assert.equal(result.processed,1);assert.deepEqual(ledger.requests.map(r=>r.purpose),['memory_maintenance','memory_maintenance','memory_proposal_correction']);assert.equal(ledger.usage.totalTokens,30);}
  });
});

test('HTTP authentication failures and an already aborted request do not trigger logical correction',async t=>{
  const s=storeFor(t);append(s);const batch=s.memoryBatch(scope);let calls=0;
  await assert.rejects(()=>consolidateMemory(settings,batch,undefined,async()=>{calls++;return {ok:false,status:401,json:async()=>({error:{message:'Unauthorized'}})};}),error=>error.code==='model_http_401_authentication');
  assert.equal(calls,1);const abort=new AbortController();abort.abort();
  await assert.rejects(()=>consolidateMemory(settings,batch,abort.signal,async()=>{calls++;throw new Error('must not run');}),error=>error.name==='AbortError');assert.equal(calls,1);
});
