'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildFidelityContext}=require('../src/whole-answer-fidelity.cjs');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {scope,raw}=require('./fixtures/native.cjs');

test('a checker manifest retains mechanical bindings without inheriting producer result, repair, review or method delivery metadata',()=>{
 const source={id:'private:human',revision:'human-r1',type:'private',role:'user',text:'先私下说明这轮该怎么理解。',scope};
 const original={requestId:'stage-metadata',scope,sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision},promptVersion:'current-prompt',contextRevision:3,stateVersion:2,goalVersion:1,
  methodTrace:{purpose:'discussion',delivered:[{id:'respond',version:'original'}],catalog:[{id:'respond'}],operationalDelivery:{location:'system',ids:['respond']},reported:['respond']},
  auxiliaryErrors:[{field:'topicPatch',code:'primary_error',message:'Producer-only rejected metadata.'}],formatRepair:{attempts:1},responseRecovery:{kind:'private_help'},primaryOperation:{operation:'advise'},requestDelivery:{status:'delivered'},blockerRendering:{question:'Previous result'},stageId:'producer-stage',outputMetadata:{finishReason:'stop'},serializedTextRequestBytes:1234};
 const before=structuredClone(original),prepared={payload:{purpose:'discussion',sources:[source],intentAuthority:{sourceId:source.id}},manifest:original,fullAvailableSources:[source]},input=buildFidelityContext(prepared,{text:'A complete private answer.'},{scope,requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
 assert.equal(input.manifest.requestId,original.requestId);assert.equal(input.manifest.contextRevision,3);assert.equal(input.manifest.sourceRevisions[source.id],source.revision);
 for(const field of ['auxiliaryErrors','formatRepair','responseRecovery','primaryOperation','requestDelivery','blockerRendering','stageId','outputMetadata','serializedTextRequestBytes'])assert.equal(Object.hasOwn(input.manifest,field),false,field);
 assert.deepEqual(input.manifest.methodTrace,{purpose:'fidelity_check',delivered:[],catalog:[],operationalDelivery:{location:'none',ids:[]},reported:null});assert.equal(input.manifest.sourceDelivery.sources[0].sourceId,source.id);assert.deepEqual(original,before,'the captured producer audit remains unchanged');
});

test('real primary auxiliary rejection is recorded once and checker generation stages cannot claim primary method instructions',async t=>{
 const store=new Store(':memory:'),inputs=[],settings={auto:false,anonymous:true,model:'synthetic-stage-metadata',baseUrl:'http://fixture.invalid/v1',realChatConsent:{...scope,model:'synthetic-stage-metadata',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,compactionModel:null,read:async()=>{throw Error('No QQ reads');},assistantModel:async(_,input)=>{inputs.push(input);if(input.payload.purpose!=='fidelity_check'&&!input.payload.methodCards?.some(item=>item.id==='respond'))return {operation:'lookup',lookup:{methodIds:['respond']},continuation:'advise'};return input.payload.purpose==='fidelity_check'?{checkRef:input.payload.checkRef,verdict:'allow',issues:[]}:{operation:'advise',text:'A complete private explanation.',topicPatch:{operation:'update',topicId:'unavailable-topic',authority:'MODEL_CANNOT_ASSIGN_AUTHORITY'}};}});
 t.after(()=>{controller.close();store.close();});controller.scope={...scope};controller.ingest(scope,[raw('91000000000000421')]);const reply=await controller.assist({text:'先帮我私下理解她这句话，不要替我写。',taskId:'stage-metadata-countercheck'}),run=store.getCompanion(scope).runs.find(item=>item.id===reply.requestId),primary=run.requests.filter(item=>item.purpose==='discussion').at(-1),checker=run.requests.find(item=>item.purpose==='fidelity_check'),stages=store.experiences.artifact(scope,reply.artifactRef).generationStages;
 assert.equal(run.auxiliaryErrors.length,1);assert.equal(primary.manifest.auxiliaryErrors.length,1);assert.equal(checker.manifest.auxiliaryErrors,undefined);assert.ok(primary.manifest.methodTrace.delivered.length>0);assert.deepEqual(checker.manifest.methodTrace.delivered,[]);assert.deepEqual(checker.manifest.methodTrace.catalog,[]);assert.deepEqual(checker.manifest.methodTrace.operationalDelivery.ids,[]);assert.equal(checker.payload.methodCards,undefined);assert.equal(checker.payload.methodCatalog,undefined);assert.deepEqual(stages.find(item=>item.purpose==='fidelity_check').deliveredMethodRefs,[]);assert.equal(stages.find(item=>item.purpose==='fidelity_check').reportedUsedMethodRefs,null);assert.ok(stages.filter(item=>item.purpose==='discussion').at(-1).deliveredMethodRefs.length>0);
});

test('one four-stage rejection and regeneration retains the primary auxiliary error once without attributing it to later requests',async t=>{
 const {Controller:ProductController}=require('../src/controller.cjs'),{assistModel}=require('../src/assistant-model.cjs');
 const store=new Store(':memory:'),calls=[],model='synthetic-four-stage-metadata',baseUrl='http://fixture.invalid/v1',settings={auto:false,anonymous:true,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}};
 const controller=new ProductController({store,settings,compactionModel:null,read:async()=>{throw Error('No QQ reads');},assistantModel:(configured,input,signal)=>assistModel(configured,input,signal,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),payload=wrapper.originalInput||wrapper;calls.push({payload,wrapper,stage:configured.requestBudget.purpose});
  let value;
  if(payload.purpose==='fidelity_check')value=calls.length===2?{checkRef:payload.checkRef,verdict:'reject',issues:[{path:'text',code:'internal_conflict',quote:'The action has happened.',relatedPath:'text',relatedQuote:'The action has not happened.',reason:'Scripted explicit contradiction verifies fresh regeneration metadata, not model quality.'}]}:{checkRef:payload.checkRef,verdict:'allow',issues:[]};
  else value=wrapper.originalInput?{operation:'advise',text:'The repaired complete private answer.'}:{operation:'advise',text:'The action has happened. The action has not happened.',topicPatch:{operation:'update',topicId:'unavailable-topic',authority:'MODEL_CANNOT_ASSIGN_AUTHORITY'}};
  return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'synthetic-four-stage-result',type:'function',function:{name:request.tool_choice.function.name,arguments:JSON.stringify(value)}}]}}]}),{status:200});
 })});
 t.after(()=>{controller.close();store.close();});controller.scope={...scope};controller.ingest(scope,[raw('91000000000000422')]);
 const reply=await controller.assist({text:'先私下理解，不要写给她。',taskId:'four-stage-metadata'}),run=store.getCompanion(scope).runs.find(item=>item.id===reply.requestId),ledger=controller.usage.get(scope,reply.requestId);
 assert.equal(calls.length,4);assert.deepEqual(run.requests.map(item=>item.purpose),['discussion','fidelity_check','delivery_repair','fidelity_check']);assert.equal(ledger.attempts,4);assert.equal(ledger.requests.filter(item=>item.purpose==='delivery_repair').length,1);assert.equal(reply.text,'The repaired complete private answer.');
 assert.equal(run.auxiliaryErrors.length,1);assert.equal(run.requests[0].manifest.auxiliaryErrors.length,1);
 for(const stage of run.requests.slice(1))assert.equal(stage.manifest.auxiliaryErrors,undefined,stage.purpose+' must not claim the producer auxiliary error');
 assert.equal(run.requests[2].manifest.primaryOperation.operation,'advise');assert.ok(run.requests[2].manifest.fidelityRegeneration.rejectedCandidateHash);assert.equal(store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
