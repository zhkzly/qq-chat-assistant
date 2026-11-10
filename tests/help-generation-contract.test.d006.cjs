'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const {withCurrentStatementAuthority}=require('./fixtures/current-statement-authority.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {responseEnvelope}=require('../src/model-response-format.cjs');
const {parseAssistant,prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const settings={model:'claude-sonnet-4-6'};
const source={id:'private:current',type:'private',role:'user',text:'Please help with this reply.',revision:'r1'};
const foreground={purpose:'reply',generationOrigin:'private_discussion',userRequest:{sourceId:source.id,text:source.text},sources:[source],taskContext:{auxiliaryPolicy:'best_effort'}};
test('ordinary model envelopes require readable help and expose auxiliary writes only for their task',()=>{
 for(const purpose of ['discussion','reply','draft_prepare','review']){
  const schema=responseEnvelope(settings,purpose,{...foreground,purpose}).tools[0].function.parameters;
  assert.deepEqual(schema.required,['operation']);assert.deepEqual(schema.properties.operation.enum,['advise','prepare_message','lookup','clarify']);assert.equal(schema.properties.kind,undefined);assert.equal(schema.properties.requestDelivery,undefined);assert.ok(schema.properties.lookup&&schema.properties.answer&&schema.properties.materials&&schema.properties.currentFacts);
 }
 const ordinary=responseEnvelope(settings,'reply',foreground).tools[0].function.parameters.properties;
 assert.equal(ordinary.relationshipPatch,undefined);assert.equal(ordinary.experienceProposals,undefined);
 for(const payload of [{...foreground,purpose:'review',experienceProposalPolicy:{enabled:true}},{...foreground,generationOrigin:'user_feedback',experienceProposalPolicy:{enabled:true}}]){
  const properties=responseEnvelope(settings,payload.purpose,payload).tools[0].function.parameters.properties;
  assert.equal(properties.relationshipPatch,undefined,'foreground review cannot advertise a parallel semantic profile writer');assert.ok(properties.experienceProposals);
 }
 const observation=responseEnvelope(settings,'reply',{...foreground,generationOrigin:'qq_observation'}).tools[0].function.parameters.properties;
 assert.equal(observation.actions,undefined);
 const unenabledReview=responseEnvelope(settings,'review',{...foreground,purpose:'review'}).tools[0].function.parameters.properties;
 assert.equal(unenabledReview.relationshipPatch,undefined);assert.equal(unenabledReview.experienceProposals,undefined);
 const repair=responseEnvelope(settings,'draft_prepare',{purpose:'draft_prepare',originalInput:{...foreground,generationOrigin:'user_feedback',experienceProposalPolicy:{enabled:true}}}).tools[0].function.parameters.properties;
 assert.equal(repair.relationshipPatch,undefined,'repair cannot reopen the foreground semantic write lane');assert.ok(repair.experienceProposals,'structural repair retains the actual independently enabled experience policy');
 const memory=responseEnvelope(settings,'memory').tools[0].function.parameters;
 assert.deepEqual(new Set(memory.required),new Set(['batchId','reviewedAll','relationshipPatch','episodes']));
 assert.ok(memory.properties.relationshipPatch.properties.claims);assert.ok(memory.properties.relationshipPatch.properties.events);
 assert.equal(memory.properties.items,undefined);assert.equal(memory.properties.retire,undefined,'normal background knowledge uses typed versioned records; legacy top-level retirement is compatibility only');
});
test('model-facing readable lookup/plan branches and legacy pure branches retain parser semantics',()=>{
 const lookup={query:'a concrete earlier exchange'};
 const readable=parseAssistant({kind:'discussion',text:'Checking the earlier exchange.',lookup},'reply',foreground).lookup;
 assert.equal(readable.query,lookup.query);
 assert.deepEqual(parseAssistant({lookup},'reply',foreground).lookup,readable);
 const draftPlan={quotes:[],intent:'reply'};
 assert.deepEqual(parseAssistant({kind:'discussion',text:'Preparing the reply.',draftPlan},'reply',foreground).draftPlan.quotes,[]);
 assert.deepEqual(parseAssistant({draftPlan},'reply',foreground).draftPlan.quotes,[]);
 assert.throws(()=>parseAssistant({},'reply',foreground));
 const clarification='Missing private fact.';
 const question=parseAssistant({kind:'question',text:'A useful explanation and a concrete question for the user.',draftPlan:{clarification}},'reply',foreground);
 assert.equal(question.text,'A useful explanation and a concrete question for the user.');assert.equal(question.kind,'question');
 assert.equal(parseAssistant({draftPlan:{clarification}},'reply',foreground).text,undefined,'legacy pure plans keep their clarification fallback');
});
test('opt-in foreground isolates invalid auxiliary metadata without hiding the failure as a review',()=>{
 const invalid={kind:'discussion',text:'Useful ordinary help.',stateReview:'no_change',topicPatch:{operation:'update',topicId:'missing',progress:['invented progress']}};
 const diagnostics={};const answer=parseAssistant(invalid,'reply',foreground,diagnostics);
 assert.equal(answer.text,invalid.text);assert.equal(answer.topicPatch,undefined);assert.equal(answer.stateReview,undefined);
 assert.match(diagnostics.auxiliaryErrors[0].field,/topicPatch/);
 assert.throws(()=>parseAssistant(invalid,'reply',{...foreground,taskContext:undefined}),/topicPatch/,'legacy validators remain strict');
 const badPlan={...invalid,draftPlan:{quotes:[],intent:'reply'}};
 const planDiagnostics={},prepared=parseAssistant(badPlan,'reply',foreground,planDiagnostics);assert.equal(prepared.topicPatch,undefined);assert.equal(prepared.stateReview,undefined);assert.deepEqual(prepared.draftPlan.quotes,[]);assert.equal(planDiagnostics.auxiliaryErrors[0].field,'topicPatch');assert.throws(()=>parseAssistant({...badPlan,draftPlan:{quotes:[],intent:'invalid'}},'reply',foreground),/拟表达|draftPlan/,'isolating optional bookkeeping does not waive the core plan contract');
});
test('invalid state-source bindings are auxiliary errors and program receipts cannot be spoofed',()=>{
 const diagnostics={};const answer=parseAssistant({kind:'discussion',text:'Keep the actual help.',statePatch:{items:[{text:'A claim.',sourceIds:['private:unavailable']}]},privateReviewReceipt:{applied:true},responseRecovery:{metadataApplied:true}},'reply',foreground,diagnostics);
 assert.equal(answer.statePatch,undefined);assert.equal(answer.privateReviewReceipt,undefined);assert.equal(answer.responseRecovery,undefined);
 assert.equal(diagnostics.auxiliaryErrors[0].field,'statePatch');
});
test('normal, recovery and restricted wording share behavior while protocols follow visible task',()=>{
 const {HELP_BEHAVIOR}=require('../src/help-behavior.cjs');
 const prompts=['reply','draft_prepare','draft','plain_help_recovery','plain_draft_recovery'].map(purpose=>prepareAssistantRequest(settings,{...foreground,purpose}).request.messages[0].content);
 for(const prompt of prompts)assert.ok(prompt.includes(HELP_BEHAVIOR));
 const ordinary=prepareAssistantRequest(settings,foreground).request.messages[0].content;
 const review=prepareAssistantRequest(settings,{...foreground,purpose:'review'}).request.messages[0].content;
 assert.ok(!ordinary.includes('claims: {id?'),'ordinary help does not carry the full relationship write protocol');
 assert.equal(review.includes('claims: {id?'),false,'foreground review no longer repeats the background semantic write protocol');
 assert.match(review,/长期人物理解由后台按原始证据整理/);assert.match(review,/不写人物画像或推断型relationshipPatch/);
 assert.ok(Buffer.byteLength(ordinary)<12000,'foreground instructions have a bounded readable protocol');
 for(const trigger of ['private_request','manual_suggestion','automatic_observation']){
  const prompt=prepareAssistantRequest(settings,{...foreground,taskContext:{...foreground.taskContext,invocation:{trigger,requestedPurpose:'reply'}}}).request.messages[0].content;
  // Same recorded re-anchor as the base contract: c1128f2 exclusion-shape
  // duty + 73c3972 experience-unassertable line; measured floor 5052.
  assert.ok(prompt.length<5150,`${trigger} foreground protocol stays readable: ${prompt.length}`);
  assert.match(prompt,/旧任务仅为候选/);assert.doesNotMatch(prompt,/taskUse|draftControlPolicy/);
  assert.match(prompt,/lookup:\{methodIds/);assert.match(prompt,/lookup:\{discover:true\}/);
  assert.match(prompt,/methodCatalog仅导航/);
 }
});
test('canonical examples keep unknown self facts private and preserve explicitly authorized new intent',()=>{
 const {HELP_BEHAVIOR}=require('../src/help-behavior.cjs');
 assert.match(HELP_BEHAVIOR,/selfEvidenceSourceIds只指向待读/);
 assert.match(HELP_BEHAVIOR,/先私下问用户/);assert.match(HELP_BEHAVIOR,/不把核对问题发给她/);
 assert.match(HELP_BEHAVIOR,/获准原文.*支撑表达/s);assert.match(HELP_BEHAVIOR,/无须先等回复/);
 assert.match(HELP_BEHAVIOR,/即使历史少也帮助表达/);
 assert.doesNotMatch(HELP_BEHAVIOR,/private:[a-z]|qq:\d|\[你的城市\]/);
});
test('malformed primary carrier uses one strict repair and one readonly audit within the same three-call budget',async t=>{
 const {Controller}=require('./fixtures/assistant-protocol.cjs'),{Store}=require('../src/store.cjs'),{assistModel}=require('./fixtures/assistant-protocol.cjs');
 const {scope,raw}=require('./fixtures/native.cjs'),calls=[];
 const store=new Store(':memory:'),configured={...settings,anonymous:true,baseUrl:'http://fixture.invalid/v1',auto:false,assistantRequestLimit:3,
  realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://fixture.invalid/v1',model:settings.model}};
 const response=content=>({ok:true,json:async()=>({choices:[{message:{content}}]})});
 const controller=new Controller({store,settings:configured,compactionModel:null,read:async name=>name==='bind'?scope:{messages:[]},
  assistantModel:(modelSettings,input,signal)=>assistModel(modelSettings,input,signal,async(_url,args)=>{
   const body=JSON.parse(args.body),payload=JSON.parse(body.messages[1].content);calls.push(body);
   if(calls.length===3){
    assert.equal(payload.purpose,'fidelity_check');assert.equal(payload.admittedFragments[0].text,'我住得很近');
    assert.equal(payload.candidate.suggestions[0].text,'不远，我住得挺近的。');
    assert.equal(JSON.stringify(payload.candidate).includes('我住得很近，帮我直接回答她。'),false,'private request remains outside the outward candidate');
    return response(JSON.stringify({checkRef:payload.checkRef,auditProtocol:payload.auditProtocol,issues:[]}));
   }
   const original=payload.originalInput||payload,control=text=>({text,sourceIds:[original.userRequest.sourceId]}),plan={quotes:[{sourceId:original.userRequest.sourceId,text:'我住得很近'}],style:'natural',
    guidance:{objective:control('回答她询问的实际距离'),allowedApproach:control('按已授权事实直接回应'),avoidances:[]}};
   if(calls.length===1)return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{function:{name:'assistant_result',arguments:JSON.stringify({kind:'discussion',text:'准备完整表达。',draftPlan:JSON.stringify({...plan,_:true})+'}'})}}]}}]})};
   assert.equal(body.tool_choice.function.name,'assistant_result');assert.equal(body.response_format,undefined);assert.ok(payload.invalidResponse);assert.equal(payload.purpose,'reply');
   return response(JSON.stringify({operation:'prepare_message',currentFacts:['我住得很近'],answer:{suggestions:[{style:'自然',text:'不远，我住得挺近的。'}]}}));
  })});
 t.after(()=>{controller.close();store.close()});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('72057594037927941',false,{elements:[{textElement:{content:'离你住的地方远吗？'}}]})]});
 const answer=await controller.assist({purpose:'reply',text:'我住得很近，帮我直接回答她。',taskId:'planning-carrier-three-stages'});
 assert.equal(calls.length,3);assert.equal(answer.kind,'draft');assert.equal(answer.responseRecovery,undefined);
 const run=store.getCompanion(scope).runs.find(item=>item.id===answer.requestId);
 assert.deepEqual(run.requests.map(item=>item.purpose),['reply','delivery_repair','fidelity_check']);assert.equal(run.patchReceipt,null);assert.equal(run.topicReceipt,null);
 assert.equal(controller.usage.get(scope,answer.requestId).attempts,3);
});
test('a failed structured planning repair gets no extra fallback and cannot commit auxiliary updates',async t=>{
 const {Controller}=require('./fixtures/assistant-protocol.cjs'),{Store}=require('../src/store.cjs'),{assistModel}=require('./fixtures/assistant-protocol.cjs');
 const {scope}=require('./fixtures/native.cjs');
 for(const mode of ['malformed_again','invalid_auxiliary']){
  const store=new Store(':memory:'),configured={...settings,anonymous:true,baseUrl:'http://fixture.invalid/v1',auto:false,assistantRequestLimit:3,
   realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,baseUrl:'http://fixture.invalid/v1',model:settings.model}};
  let calls=0;
  const controller=new Controller({store,settings:configured,compactionModel:null,read:async name=>name==='bind'?scope:{messages:[]},
   assistantModel:(modelSettings,input,signal)=>assistModel(modelSettings,input,signal,async(_url,args)=>{
    const body=JSON.parse(args.body),p=JSON.parse(body.messages[1].content),original=p.originalInput||p;
    const plan={quotes:[{sourceId:original.userRequest.sourceId,text:'我住得很近'}],style:'natural'};
    if(++calls===1)return {ok:true,json:async()=>({choices:[{message:{tool_calls:[{function:{name:'assistant_result',arguments:JSON.stringify({kind:'discussion',text:'规划表达',draftPlan:JSON.stringify(plan)+'}'})}}]}}]})};
    const value=mode==='malformed_again'?{kind:'discussion',text:'不可接受的计划',draftPlan:JSON.stringify(plan)+'}'}:
     {kind:'discussion',text:'计划带有未授权辅助更新',draftPlan:plan,stateReview:'no_change',topicPatch:{operation:'update',authority:'forged'}};
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})};
   })});
  t.after(()=>{controller.close();store.close()});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
  await controller.bind(scope.peerUin);const before=store.getCompanion(scope);
  await assert.rejects(controller.assist({text:'我住得很近，帮我组织表达。',taskId:`failed-plan-repair-${mode}`}),/结构化结果/);
  const after=store.getCompanion(scope),run=after.runs.find(item=>item.id===`failed-plan-repair-${mode}`);
  assert.equal(calls,2);assert.equal(run.status,'failed');assert.equal(run.requests.length,2);
  assert.equal(after.state.version,before.state.version);assert.equal(after.topics.items.length,before.topics.items.length);
  assert.equal(after.turns.some(item=>item.role==='assistant'),false);assert.equal(after.goal.version,before.goal.version);
 }
});
test('generic planning repair teaches valid escaping and only requires necessary source-bound controls',async()=>{
 const {assistModel}=require('./fixtures/assistant-protocol.cjs');
 for(const active of [null,{lifecycle:'active',objective:'PRIVATE_OBJECTIVE_SENTINEL',direction:'PRIVATE_DIRECTION_SENTINEL',constraints:['PRIVATE_CONSTRAINT_SENTINEL']}]){
  const payload={...foreground,purpose:'discussion',goal:'PRIVATE_GOAL_SENTINEL',topicContext:{active}},bodies=[];
  await assistModel({...settings,anonymous:true,baseUrl:'http://fixture.invalid/v1'},{payload,manifest:{}},undefined,async(_url,args)=>{
   const body=JSON.parse(args.body);bodies.push(body);
   return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(bodies.length===1?
    {kind:'discussion',text:'准备表达',draftPlan:'{malformed planning container'}:{kind:'question',text:'需要先核对一个会改变表达的事实。'})}}]})};
  });
  assert.equal(bodies.length,2);const repair=JSON.parse(bodies[1].messages[1].content),task=repair.task;
  assert.match(task,/从originalInput重新生成/);assert.match(task,/invalidResponse仅诊断/);assert.match(task,/advise\+完整text/);assert.match(task,/prepare_message\+answer/);assert.doesNotMatch(task,/先保证kind\/text|private_help|editable_message/);
  assert.match(task,/双引号.*反斜线.*转义/);assert.match(task,/不增加HTTP调用/);
  assert.match(task,/只保留选中操作的核心字段/);assert.match(task,/完整当前人类意思、否定与条件/);
  for(const secret of ['PRIVATE_OBJECTIVE_SENTINEL','PRIVATE_DIRECTION_SENTINEL','PRIVATE_CONSTRAINT_SENTINEL','PRIVATE_GOAL_SENTINEL'])assert.equal(task.includes(secret),false);
  const example=JSON.parse(task.split('字符串转义格式示例（只示范格式，不作本次事实）：')[1]);
  assert.equal(example.operation,'advise');assert.ok(example.text.includes('"'));assert.ok(example.text.includes('\\'));
  assert.equal(parseAssistant(require('../src/primary-operation.cjs').normalizePrimaryOperation(example,payload).value,'discussion',payload).text,example.text,'the operation example passes the same normalization and canonical admission stages');
  assert.deepEqual(repair.originalInput.topicContext.active,active);assert.match(bodies[1].messages[0].content,/完整当前原话及明确UI选择优先/);assert.match(task,/所有核心问题须一次解决/);
 }
});
