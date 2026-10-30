'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {consolidateMemory,maintainMemory,prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {memoryRecordFields}=require('../src/model-response-format.cjs');
const {scope}=require('./fixtures/native.cjs');
const rejectedEpisode=require('./fixtures/memory-legacy-episode-update.cjs');
const settings={baseUrl:'http://fixture.invalid/v1',model:'synthetic',anonymous:true};
const input=request=>JSON.parse(JSON.parse(request.body).messages[1].content);
const noop=p=>({batchId:p.batchId,reviewedAll:true,items:[],episodes:[],retire:[]});
const receipt=batch=>({reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[]});
const response=(value,mode)=>({ok:true,status:200,json:async()=>({choices:[{message:mode==='result_tool'
  ?{tool_calls:[{function:{name:'memory_result',arguments:JSON.stringify(value)}}]}:{content:JSON.stringify(value)}}]})});
function setup(t){
  const s=new Store(':memory:');t.after(()=>s.close());
  const old=[s.appendTurn(scope,{role:'user',kind:'discussion',text:'这是我给自己记读书笔记的小网页。'}),
    s.appendTurn(scope,{role:'user',kind:'discussion',text:'昨天第一次把查找功能弄好了，我挺开心，也想听她平时怎么留住读到的东西。'})];
  const batch=s.memoryBatch(scope);
  assert.equal(s.applyMemoryBatch(scope,batch,{...receipt(batch),episodes:[{text:rejectedEpisode.text,sourceIds:old.map(turn=>`private:${turn.id}`),topicKeys:rejectedEpisode.topicKeys}]}).applied,true);
  const current=s.appendTurn(scope,{role:'user',kind:'discussion',text:'我做这个小网页就是给自己记读书笔记，今天按标题找摘录已经能用了。我愿意把这些告诉她。'});
  return {s,old,current};
}

test('actual rejected legacy episode update receives one same-batch correction before Store admission in both modes',async t=>{
  for(const mode of ['json_object','result_tool'])await t.test(mode,async t=>{
    const {s}=setup(t),before=s.memoryBatch(scope),sourceBefore=s.memorySources(scope);let first,rejected,calls=0,commits=0;
    const apply=s.applyMemoryBatch.bind(s);
    s.applyMemoryBatch=(...args)=>{commits++;assert.equal(args[2].episodes[0].expectedVersion,undefined,'only the model-corrected result reaches Store');return apply(...args);};
    const result=await maintainMemory({store:s,scope,settings:{...settings,modelResponseMode:mode},maxBatches:1,
      model:(configured,batch,signal)=>consolidateMemory(configured,batch,signal,async(_,request)=>{
        calls++;const body=JSON.parse(request.body),p=input(request);
        if(calls===1){
          first=p;assert.match(body.messages[0].content,/Only typed claims\/events inside relationshipPatch use expectedVersion/);
          assert.match(body.messages[0].content,/Legacy items, episodes and top-level retire must NEVER include expectedVersion/);
          rejected={...noop(p),episodes:[{...rejectedEpisode,id:p.priorMemory.episodes[0].id}]};
          if(mode==='result_tool'){
            const episodeSchema=body.tools[0].function.parameters.properties.episodes.items;
            assert.equal(episodeSchema.properties.expectedVersion,undefined);assert.equal(episodeSchema.additionalProperties,false);
          }
          return response(rejected,mode);
        }
        assert.equal(p.purpose,'memory_proposal_correction');assert.deepEqual(p.originalInput,first);
        assert.deepEqual(p.originalInput.sources,first.sources);assert.deepEqual(p.originalInput.contextSources,first.contextSources);
        assert.deepEqual(JSON.parse(p.invalidResponse),rejected);assert.equal(JSON.parse(p.invalidResponse).episodes[0].expectedVersion,1);
        assert.equal(p.validationError.code,'unsupported_memory_record_fields');assert.equal(p.validationError.field,'episodes[0].expectedVersion');
        assert.match(p.validationError.allowedShape,/id, text, sourceIds, topicKeys/);assert.match(p.validationError.allowedShape,/only to typed relationshipPatch/);
        // This fixture is the corrected producer output, not local field stripping.
        const {expectedVersion,...correctedEpisode}=rejected.episodes[0];assert.equal(expectedVersion,1);
        return response({...rejected,episodes:[correctedEpisode]},mode);
      })});
    assert.equal(calls,2);assert.equal(commits,1);assert.equal(result.pending,0);assert.equal(result.processed,3);
    assert.equal(result.counts.episodes,1);assert.equal(result.errors.length,0);
    const stored=s.memoryBatch(scope);assert.equal(stored,null);assert.deepEqual(s.memorySources(scope),sourceBefore);
    assert.equal(before.priorMemory.episodes[0].id,s.searchMemory(scope,'reading notes').episodes[0].id);
    assert.equal(s.searchMemory(scope,'reading notes').episodes[0].version,2);
  });
});

test('unknown fields on each legacy record remain rejected after the one correction and cannot advance progress',async t=>{
  for(const mode of ['json_object','result_tool'])for(const kind of ['items','episodes','retire'])await t.test(`${mode} ${kind}`,async t=>{
    const {s}=setup(t),batch=s.memoryBatch(scope),before=s.memoryStatus(scope);let calls=0,commits=0;
    s.applyMemoryBatch=()=>{commits++;throw new Error('invalid wire records must never reach Store');};
    const result=await maintainMemory({store:s,scope,settings:{...settings,modelResponseMode:mode},maxBatches:1,
      model:(configured,captured,signal)=>consolidateMemory(configured,captured,signal,async(_,request)=>{
        calls++;const p=input(request),original=p.originalInput||p;
        if(calls===2){assert.equal(p.validationError.field,`${kind}[0].unexpected`);assert.ok(p.validationError.allowedShape.includes(memoryRecordFields[kind].join(', ')));}
        const record=kind==='items'?{kind:'fact',text:'Only a fictional sourced observation',sourceIds:['s1']}
          :kind==='episodes'?{text:'Only a fictional event summary',sourceIds:['s1']}
          :{id:original.priorMemory.episodes[0].id,status:'superseded',sourceIds:['s1']};
        return response({...noop(original),[kind]:[{...record,unexpected:'PRIVATE_SYNTHETIC_FIELD_VALUE'}]},mode);
      })});
    assert.equal(calls,2);assert.equal(commits,0);assert.equal(result.status,'error');assert.equal(result.processed,before.processed);
    assert.equal(result.pending,before.pending);assert.deepEqual(s.memoryBatch(scope).events,batch.events);
    assert.deepEqual(result.lastReview,before.lastReview);assert.equal(result.errors[0].code,'unsupported_memory_record_fields');
    assert.equal(JSON.stringify(result.errors).includes('PRIVATE_SYNTHETIC_FIELD_VALUE'),false);
  });
});

test('wire field lists match existing flat producer schemas, legacy expectedVersion is rejected without stripping',t=>{
  const {s}=setup(t),batch=s.memoryBatch(scope),request=prepareMemoryRequest({...settings,modelResponseMode:'result_tool'},batch);
  const body=JSON.parse(request.serialized),p=JSON.parse(body.messages[1].content);
  for(const kind of ['items','episodes','retire']){
    const schema=body.tools[0].function.parameters.properties[kind].items;
    assert.deepEqual(memoryRecordFields[kind],Object.keys(schema.properties));assert.equal(schema.properties.expectedVersion,undefined);
    const value=kind==='items'?{kind:'fact',text:'Fictional statement',sourceIds:['s1'],expectedVersion:1}
      :kind==='episodes'?{...rejectedEpisode,id:p.priorMemory.episodes[0].id}
      :{id:p.priorMemory.episodes[0].id,sourceIds:['s1'],status:'superseded',expectedVersion:1};
    const rejected={...noop(p),[kind]:[value]},before=JSON.stringify(rejected);
    assert.throws(()=>request.decode(rejected),error=>error.code==='unsupported_memory_record_fields'&&error.field===`${kind}[0].expectedVersion`);
    assert.equal(JSON.stringify(rejected),before);
  }
});

test('typed relationship updates still accept expectedVersion and reject missing, invalid or stale versions',async t=>{
  for(const mode of ['json_object','result_tool'])await t.test(mode,async t=>{
    const {s,old}=setup(t),sourceId=`private:${old[0].id}`;
    assert.equal(s.applyRelationshipPatch(scope,{claims:[{subject:'self',aspect:'recent_context',text:'用户说这是自己的读书笔记网页',assertionKind:'stated',epistemicStatus:'supported',sourceIds:[sourceId]}],
      events:[{activityKey:'reading-notes-page',eventKind:'sharing',actor:'self',text:'用户私下说起自己的读书笔记网页',sourceIds:[sourceId]}]},
    {baseRevision:s.getCompanion(scope).revision,sourceIds:[sourceId]}).applied,true);
    const batch=s.memoryBatch(scope),request=prepareMemoryRequest({...settings,modelResponseMode:mode},batch),p=JSON.parse(JSON.parse(request.serialized).messages[1].content);
    assert.ok(p.priorMemory.claims.length&&p.priorMemory.events.length);
    const claim={id:p.priorMemory.claims[0].id,expectedVersion:p.priorMemory.claims[0].version,subject:'self',aspect:'recent_context',text:'用户说按标题查找自己的读书摘录已经可用',assertionKind:'stated',epistemicStatus:'supported',sourceIds:['s1']};
    const event={id:p.priorMemory.events[0].id,expectedVersion:p.priorMemory.events[0].version,activityKey:'reading-notes-page',eventKind:'sharing',actor:'self',text:'用户私下补充网页按标题查找已能使用',sourceIds:['s1']};
    for(const version of [undefined,0,'1'])assert.throws(()=>request.decode({...noop(p),relationshipPatch:{claims:[{...claim,expectedVersion:version}]}}),/expectedVersion/);
    const stale=request.decode({...noop(p),relationshipPatch:{claims:[{...claim,expectedVersion:claim.expectedVersion+1}]}});
    assert.equal(s.applyMemoryBatch(scope,batch,stale).applied,false);assert.equal(s.memoryStatus(scope).pending,1);
    let calls=0;const decoded=await consolidateMemory({...settings,modelResponseMode:mode},batch,undefined,async(_,wire)=>{calls++;assert.deepEqual(input(wire),p);return response({...noop(p),relationshipPatch:{claims:[claim],events:[event]}},mode);});
    assert.equal(calls,1);assert.equal(decoded.relationshipPatch.claims[0].expectedVersion,claim.expectedVersion);
    assert.equal(decoded.relationshipPatch.events[0].expectedVersion,event.expectedVersion);assert.equal(s.applyMemoryBatch(scope,batch,decoded).applied,true);
    assert.equal(s.memoryStatus(scope).pending,0);
  });
});
