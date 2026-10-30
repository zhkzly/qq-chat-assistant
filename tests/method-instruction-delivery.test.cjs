'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest,parseAssistant}=require('../src/assistant-model.cjs');
const {methodFor,runtimeCard,selectMethods,compactOperationalCards,operationsFor}=require('../src/help-methods.cjs');
const {scope,raw}=require('./fixtures/native.cjs'),{withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
function fixture(t,purpose='reply'){
  const store=new Store(':memory:');t.after(()=>store.close());
  store.add(scope,[normalize(raw('91001',false,{msgTime:'1792112340',elements:[{elementType:1,textElement:{content:'桌上的台灯终于修好了'}}]}),scope)]);
  const turn=store.appendTurn(scope,{role:'user',kind:purpose,text:'帮我接她这句，轻松一点。'});
  return {scope,records:store.messages(scope),availableSources:store.memorySources(scope),companion:store.getCompanion(scope),turn,purpose,
    generationOrigin:'private_discussion',coverage:{status:'partial'},requestId:'synthetic-method-delivery',methodLookupIds:['respond','choose_next_step'],asOf:'2026-10-16T01:00:00.000Z',
    settings:{model:'synthetic',anonymous:true,baseUrl:'http://fixture.invalid/v1'}};
}

test('eight stable method families share one canonical operation and only selected full cards carry two fictional examples',()=>{
  const compact=compactOperationalCards(),reply=selectMethods({purpose:'reply',hasReply:true,methodIds:['respond','choose_next_step']});
  assert.equal(compact.length,8);
  for(const item of compact){assert.equal(item.instruction,methodFor(item.id).instruction);assert.equal(item.examples,undefined);}
  const selected=reply.methods.map(runtimeCard),examples=selected.flatMap(card=>card.examples||[]);
  assert.equal(examples.length,2);assert.ok(examples.every(example=>example.authority==='fictional_illustration_not_task_evidence'));
  assert.ok(examples.every(example=>example.situation&&example.approach&&example.wording));
  assert.equal(selectMethods({purpose:'review'}).methods.map(runtimeCard).flatMap(card=>card.examples||[]).length,0);
  assert.equal(selectMethods({purpose:'draft'}).methods.map(runtimeCard).flatMap(card=>card.examples||[]).length,0);
  assert.equal(operationsFor(['respond']),`respond: ${methodFor('respond').instruction}`);
  assert.ok(examples.every(example=>!operationsFor(compact.map(item=>item.id)).includes(example.wording)));
});

test('selected examples reach the actual request, count toward bytes and never become current source authority',t=>{
  const args=fixture(t),prepared=buildContext(args),packet=prepareAssistantRequest(args.settings,prepared.payload);
  const examples=prepared.payload.methodCards.flatMap(card=>card.examples||[]);
  assert.equal(examples.length,2);
  for(const example of examples){
    assert.ok(packet.serialized.includes(example.wording));
    assert.ok(!prepared.payload.sources.some(source=>source.text.includes(example.wording)));
  }
  const withoutExamples=structuredClone(prepared.payload);for(const card of withoutExamples.methodCards)delete card.examples;
  assert.ok(packet.requestBytes>prepareAssistantRequest(args.settings,withoutExamples).requestBytes);
  const forged=withCurrentDraftControls({intent:'reply',quotes:[{sourceId:'method-example:fictional',text:examples[0].wording}]},prepared.payload);
  assert.throws(()=>parseAssistant({kind:'discussion',text:'Synthetic invalid example-as-material probe.',draftPlan:forged},'reply',prepared.payload),/拟表达内容未能对应本次明确请求或已选分享素材/);
  assert.throws(()=>buildDraftContext(prepared,forged,args),/拟表达内容未能对应本次明确请求或已选分享素材/);
});

test('request pressure omits optional full cards but preserves navigable IDs without claiming instructions were delivered',t=>{
  const args=fixture(t),full=buildContext(args),fullPacket=prepareAssistantRequest(args.settings,full.payload);
  assert.equal(full.payload.methodCards.flatMap(card=>card.examples||[]).length,2);
  // Removing shared metadata can absorb a small fixed deficit. Charge the
  // complete serialized expanded-card footprint to reach the card fallback.
  const expandedCardBytes=Buffer.byteLength(JSON.stringify(full.payload.methodCards));
  const limit=Math.max(8000,fullPacket.requestBytes-expandedCardBytes),settings={...args.settings,assistantRequestBytes:limit};
  assert.ok(limit<fullPacket.requestBytes);
  const limited=buildContext({...args,settings}),packet=prepareAssistantRequest(settings,limited.payload);
  assert.ok(packet.requestBytes<=limit,`${packet.requestBytes} > ${limit}`);
  assert.ok(limited.payload.sources.some(source=>source.id==='qq:91001'));
  assert.ok(limited.payload.methodCards.flatMap(card=>card.examples||[]).length<2,'full optional instruction cards cannot evade actual request measurement');
  for(const id of ['respond','choose_next_step']){
    const operation=methodFor(id).instruction;
    assert.ok(limited.payload.methodCatalog.some(card=>card.id===id));
    const delivered=limited.payload.methodCards.some(card=>card.id===id&&card.instruction===operation)||packet.request.messages[0].content.includes(operation);
    assert.equal(limited.manifest.methodTrace.operationalDelivery.ids.includes(id),delivered);
  }
});
