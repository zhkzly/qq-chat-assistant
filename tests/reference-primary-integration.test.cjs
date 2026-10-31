'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareAssistantRequest,parseAssistant,assistModel}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {primaryOperationFor}=require('../src/primary-operation.cjs');
const {scope}=require('./fixtures/native.cjs');
const TEXT='网页是我做来记下自己的摘记；查找功能已经能按标题找回。';
const MESSAGE='我做了个记摘记的小网页，后来也加上了按标题查找。';
const answer={suggestions:[{text:MESSAGE}]};
function fixture(){
 const payload={purpose:'discussion',intentAuthority:{sourceId:'private:current'},userRequest:{sourceId:'private:current',text:'我愿把网页用途和查找进展告诉她，给我完整表达。'},requestDeliveryPolicy:{version:1},draftMaterialPolicy:{version:1},sources:[
  {id:'private:old',revision:'old-v1',type:'private',role:'user',text:TEXT,at:'2026-08-31T10:00:00.000Z'},
  {id:'private:current',revision:'current-v1',type:'private',role:'user',text:'我愿把网页用途和查找进展告诉她，给我完整表达。',at:'2026-10-01T10:00:00.000Z'}]};
 const settings={model:'gpt-6-luna',anonymous:true,baseUrl:'http://fixture.invalid/v1',sourceHandleOwner:new SourceHandleOwner({scope,taskId:'reference-primary'})};
 return {payload,settings};
}
test('whole-primary wire advertises explicit operations and exact material references',()=>{
 const {payload,settings}=fixture(),prepared=prepareAssistantRequest(settings,payload,[]),wire=prepared.wirePayload;
 assert.equal(wire.primaryReferenceProtocol.version,'primary-reference-choices-v1');
 const old=wire.sources.find(source=>source.type==='private'&&source.at.startsWith('2026-08'));
 assert.equal(old.text,undefined);assert.equal(body(old),TEXT);
 const schema=prepared.request.tools[0].function.parameters;
 assert.deepEqual(Object.keys(schema.properties.materials.items.properties).sort(),['authorityRef','materialRef']);
 assert.deepEqual(schema.properties.operation.enum,['advise','prepare_message','lookup','clarify']);assert.deepEqual(schema.required,['operation']);assert.equal(schema.properties.kind,undefined);assert.equal(schema.properties.requestDelivery,undefined);assert.equal(wire.operationProtocol.version,'primary-operation-v2');assert.equal(wire.requestDeliveryPolicy,undefined);
 assert.equal(schema.properties.draftPlan,undefined);assert.equal(wire.sources.some(source=>source.id===wire.intentAuthority.sourceId),false);assert.equal(wire.userRequest.text,payload.userRequest.text);
 assert.match(prepared.request.messages[0].content,/currentPermission.*非程序许可/);
 assert.equal(payload.sources[0].text,TEXT,'canonical payload is not rewritten');
});
function body(source){return source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');}
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(choice=>choice.from===first&&choice.to===last).materialRef;}
function planFrom(wire){
 const old=wire.sources.find(source=>source.type==='private'&&source.at.startsWith('2026-08'));
 return {operation:'prepare_message',materials:[{materialRef:whole(old),authorityRef:wire.currentPermission.authorityRef}],answer};
}
function admitted(result){return primaryOperationFor(result).admittedMaterials;}
function response(value){return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{status:200});}
test('actual primary refs reconstruct the exact semicolon/body/permission and second parse stays canonical',async()=>{
 const {payload,settings}=fixture(),context={payload,manifest:{scope,requestId:'reference-primary'}},raw=[];
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{const p=JSON.parse(JSON.parse(args.body).messages[1].content);const output=planFrom(p);raw.push(structuredClone(output));return response(output);});
 assert.equal(raw.length,1);assert.equal(admitted(result)[0].text,TEXT);assert.equal(admitted(result)[0].sourceId,'private:old');
 assert.equal(result.materials[0].authorization.permission.sourceId,'private:current');
 assert.equal(result.materials[0].authorization.referent.text,TEXT);
 assert.equal(result.requestDelivery.sourceId,'private:current');assert.equal(result.requestDelivery.quote,payload.userRequest.text);
 assert.deepEqual(parseAssistant(result,'discussion',context),result);
 assert.equal(raw[0].materials[0].text,undefined);assert.equal(raw[0].draftPlan,undefined);assert.equal(raw[0].requestDelivery,undefined);assert.equal(raw[0].operation,'prepare_message');assert.equal(result.suggestions[0].text,MESSAGE);
 assert.equal(context.payload.sources[0].text,TEXT);assert.ok(context.manifest.primaryReferences.materials.every(ref=>!Object.hasOwn(ref,'text')));
});
test('explicit private advice remains one call and an unoffered optional state field is wholly rejected',async()=>{
 const {payload,settings}=fixture();payload.taskContext={auxiliaryPolicy:'best_effort'};
 const context={payload,manifest:{scope,requestId:'private-help'}},calls=[];
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{calls.push(JSON.parse(args.body));return response({operation:'advise',text:'先私下分析这件事。',statePatch:{items:[{text:'不能写入',sourceIds:['s999']}]}});});
 assert.equal(calls.length,1);assert.equal(result.kind,'discussion');assert.equal(result.draftPlan,undefined);assert.equal(result.statePatch,undefined);
 assert.equal(context.manifest.auxiliaryErrors[0].field,'statePatch');assert.equal(result.requestDelivery.mode,'private_help');
});
test('unknown material ref uses one structured repair and cannot abandon the declared message artifact',async()=>{
 const {payload,settings}=fixture(),context={payload,manifest:{scope,requestId:'sticky-ref'}},calls=[];
 await assert.rejects(assistModel(settings,context,undefined,async(_url,args)=>{
  const wrapper=JSON.parse(JSON.parse(args.body).messages[1].content);calls.push(wrapper);
  if(calls.length===1){const output=planFrom(wrapper);output.materials[0].materialRef='m999';return response(output);}
  return response({operation:'advise',text:'只给策略。'});
 }),/still requires a message artifact/);
 assert.equal(calls.length,2);assert.equal(calls[1].originalInput.operationProtocol.requiredArtifact,'message');assert.equal(calls[1].originalInput.requestDeliveryPolicy,undefined);
 assert.equal(calls[1].validationIssues[0].path,'materials[0].materialRef');assert.equal(calls[1].validationIssues[0].code,'unknown_material_reference');
 assert.match(calls[1].task,/materials/);assert.ok(calls[1].originalInput.currentPermission.authorityRef);assert.equal(calls[1].invalidResponse.includes('m999'),true);
});
test('canonical local API retains exact legacy current bindings and rejects wrong supplied authority',()=>{
 const {payload}=fixture();
 assert.throws(()=>parseAssistant({kind:'discussion',text:'私下解释',requestDelivery:{mode:'private_help',sourceId:'private:old',quote:TEXT}},'discussion',payload),/CURRENT intent/);
 const result=parseAssistant({kind:'discussion',text:'私下解释',requestDelivery:{mode:'private_help',sourceId:'private:current',quote:payload.userRequest.text}},'discussion',payload);
 assert.equal(result.requestDelivery.sourceId,'private:current');
});
async function application(t,producer){
 const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs'),{raw}=require('./fixtures/native.cjs');
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-08-31T10:00:00.000Z')});
 const store=new Store(':memory:'),old=store.appendTurn(scope,{role:'user',kind:'discussion',text:TEXT});
 t.mock.timers.setTime(Date.parse('2026-10-01T10:00:00.000Z'));
 const model='synthetic-primary-ref',baseUrl='http://fixture.invalid/v1',calls=[],contexts=[];
 const settings={anonymous:true,auto:false,model,baseUrl,assistantRequestLimit:6,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}};
 const controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},assistantModel:(configured,context,signal)=>{
  contexts.push(context);return assistModel(configured,context,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;
   calls.push({request,wrapper,p,taskId:configured.requestBudget.task.id});return response(await producer(p,wrapper,calls.length-1));
  });
 }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('91000000000000123',false,{msgTime:'1790848500',elements:[{textElement:{content:'你那个网页主要做什么？'}}]})]});
 t.after(()=>{controller.close();store.close();});
 return {store,controller,calls,contexts,old,settings,run:()=>store.getCompanion(scope).runs.at(-1),assist:text=>controller.assist({text,sourceTurnIds:[old.id],taskId:'whole-primary-ref'})};
}
test('controller reference primary records admitted wording with exact text, recording provenance and canonical storage',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]}:planFrom(p));
 const result=await app.assist('我愿把网页用途和查找进展告诉她，给我完整表达。');
 assert.equal(result.kind,'draft');assert.equal(app.calls.length,2);assert.equal(app.run().manifest.requestDelivery.status,'delivered');
 const canonical=app.run(),quote=canonical.payload.outboundQuotes[0];
 assert.equal(canonical.payload.purpose,'answer_admission');assert.equal(quote.text,TEXT);
 assert.equal(quote.provenance.source.role,'user');assert.equal(quote.provenance.source.recordedAt,'2026-08-31T10:00:00.000Z');
 assert.equal(quote.provenance.version,1);assert.equal(quote.provenance.source.sourceId,quote.sourceId);
 assert.equal(quote.provenance.source.revision,canonical.manifest.sourceRevisions[quote.sourceId]);assert.equal(typeof quote.provenance.source.revision,'string');
 assert.equal(quote.provenance.source.recordedAt,'2026-08-31T10:00:00.000Z');assert.equal(quote.provenance.source.timeMeaning,'private_statement_recorded');
 assert.equal(canonical.payload.userRequest,undefined);assert.equal(canonical.payload.privateConversation,undefined);assert.equal(canonical.payload.primaryReferenceProtocol,undefined);
 assert.equal(app.calls[1].p.purpose,'fidelity_check');assert.equal(app.calls[1].p.admittedFragments[0].text,TEXT);
 assert.ok(app.contexts.every(context=>(context.payload.sources||context.payload.evidence).every(source=>/^(private|qq|request|note):/.test(source.id||source.sourceId))));
 assert.ok(app.run().requests[0].manifest.primaryReferences.materials.every(entry=>entry.sourceId.startsWith('private:')||entry.sourceId.startsWith('qq:')));
 assert.equal(app.run().requests[0].payload.primaryReferenceProtocol,undefined);assert.equal(app.store.getCompanion(scope).turns.at(-1).suggestions[0].text,result.suggestions[0].text);
 assert.ok(app.calls.every(call=>Buffer.byteLength(JSON.stringify(call.request))<=64000));
});
test('private advice keeps its declared historical fact through the actual admission and checker consumers',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]}:
  {operation:'advise',text:'可以用已完成的标题查找来回答她，私下先比较这条表达是否自然。',materials:planFrom(p).materials});
 const result=await app.assist('网页用途和查找进展这两件事实可以作为表达例子，但这次先只和我分析，不要给最终稿。');
 assert.equal(result.kind,'discussion');assert.equal(app.calls.length,2);
 assert.equal(app.calls[1].p.purpose,'fidelity_check');assert.equal(app.calls[1].p.admittedFragments[0]?.text,TEXT);
 assert.equal(app.calls[1].p.evidence.find(source=>source.sourceId===app.calls[1].p.admittedFragments[0].sourceId).role,'user');
 assert.equal(app.calls[1].p.evidence.find(source=>source.sourceId===app.calls[1].p.currentHumanControl.sourceId).text,'网页用途和查找进展这两件事实可以作为表达例子，但这次先只和我分析，不要给最终稿。');
 assert.equal(typeof app.run().manifest.sourceRevisions[app.old.sourceId||`private:${app.old.id}`],'string');
});
test('private advice retains an exact new fact and the full current permission through checker admission',async t=>{
 const fact='我今天把台灯修好了',request=fact+'，可以拿这件事作表达例子，但先只和我讨论，PRIVATE_REASON不要转出去。';
 const app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]}:
  {operation:'advise',text:'先私下分析：修好台灯是具体的日常进展，可以围绕这件小事找表达方向。',currentFacts:[fact]});
 const result=await app.assist(request);
 assert.equal(result.kind,'discussion');assert.equal(app.calls.length,2);
 assert.equal(app.calls[1].p.admittedFragments[0]?.text,fact);
 assert.equal(app.calls[1].p.currentHumanControl.authority,'CONTROL_ONLY');
 assert.equal(app.calls[1].p.evidence.find(source=>source.sourceId===app.calls[1].p.currentHumanControl.sourceId).text,request);
 assert.equal(app.calls[1].p.admittedFragments[0].sourceId,app.calls[1].p.currentHumanControl.sourceId);
 assert.equal(typeof app.run().manifest.sourceRevisions[app.contexts[1].payload.currentHumanControl.sourceId],'string');
});
test('missing authority is not inferred from willingness and bad primary commits no valid actions or state',async t=>{
 const app=await application(t,p=>{
  const output=planFrom(p);delete output.materials[0].authorityRef;
  output.actions=[{type:'save_note',evidenceQuote:'记住：安全记录',text:'安全记录'}];output.stateReview='no_change';return output;
 });
 const before=app.store.getCompanion(scope);
 await assert.rejects(app.assist('记住：安全记录。我愿把网页用途和查找进展告诉她，给我完整表达。'),/authorityRef/);
 const after=app.store.getCompanion(scope);assert.equal(app.calls.length,2);assert.equal(after.notes.length,before.notes.length);assert.equal(after.state.version,before.state.version);
 assert.equal(after.turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.run().status,'failed');
 assert.equal(app.calls[1].wrapper.validationIssues[0].path,'materials[0].authorityRef');
});
test('expressionOptions use the same exact ref compiler and never retain a permission grant',async()=>{
 const {payload,settings}=fixture(),context={payload,manifest:{scope,requestId:'reference-options'}};
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{
  const p=JSON.parse(JSON.parse(args.body).messages[1].content),output=planFrom(p);
  return response({operation:'advise',text:'这个方向可以再商量。',expressionOptions:[{label:'分享真实进展',quotes:output.materials}]});
 });
 assert.equal(result.expressionOptions[0].quotes[0].text,TEXT);
 const {expressionOptionsFor}=require('../src/context/wording-view.cjs'),stored=expressionOptionsFor(context,result.expressionOptions);
 assert.deepEqual(stored[0].quotes,[{sourceId:'private:old',text:TEXT,revision:'old-v1'}]);assert.equal(stored[0].quotes[0].authorization,undefined);
});
test('malformed JSON retains the selected carrier and exact offered choices through one structural repair',async()=>{
 const {payload,settings}=fixture(),context={payload,manifest:{scope,requestId:'reference-repair'}},calls=[],malformed='{"kind":"discussion","draftPlan":{"quotes":[';
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,wrapper,p});
  return calls.length===1?new Response(JSON.stringify({choices:[{message:{content:malformed}}]}),{status:200}):response(planFrom(p));
 });
 assert.equal(calls.length,2);assert.equal(calls[1].wrapper.invalidResponse,malformed);assert.equal(calls[1].wrapper.validationIssues,undefined);
 assert.equal(calls[0].request.tool_choice.function.name,'assistant_result');assert.equal(calls[1].request.tool_choice.function.name,'assistant_result');
 assert.deepEqual(calls[0].p.sources,calls[1].p.sources);assert.equal(admitted(result)[0].text,TEXT);
 assert.equal(context.extraRequests[0].purpose,'delivery_repair');assert.equal(context.extraRequests[0].manifest.primaryReferences.version,'primary-reference-choices-v1');
});
test('shape-valid references cannot bypass a current private-only restriction and repair points to the selector',async()=>{
 const {payload,settings}=fixture();payload.privateRestrictions=[{sourceId:'private:old',text:TEXT}];
 const context={payload,manifest:{scope,requestId:'restricted-ref'}},calls=[];
 await assert.rejects(assistModel(settings,context,undefined,async(_url,args)=>{
  const wrapper=JSON.parse(JSON.parse(args.body).messages[1].content),p=wrapper.originalInput||wrapper;calls.push(wrapper);return response(planFrom(p));
 }),/仅供私下讨论/);
 assert.equal(calls.length,2);assert.equal(calls[1].validationIssues[0].path,'materials[0]');
 assert.equal(calls[1].validationIssues[0].code,'draft_material_invalid');assert.equal(payload.sources[0].text,TEXT);
});
test('already allowed note uses its target-bound program choice without counterfeit original-user proof',async()=>{
 const {payload,settings}=fixture();payload.sources[0]={...payload.sources[0],id:'note:allowed',type:'note',role:undefined,use:'draft'};payload.allowedMaterialIds=['note:allowed'];
 const context={payload,manifest:{scope,requestId:'program-note'}};
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{
  const p=JSON.parse(JSON.parse(args.body).messages[1].content),note=p.sources.find(source=>source.type==='note');
  assert.equal(note.authorityChoices.originalUserStatementCandidates?.length||0,0);
  return response({operation:'prepare_message',materials:[{materialRef:whole(note),authorityRef:note.authorityChoices.program[0].authorityRef}],answer});
 });
 assert.equal(admitted(result)[0].sourceId,'note:allowed');assert.equal(admitted(result)[0].text,TEXT);assert.equal(admitted(result)[0].authorization,undefined);
});
test('standalone canonical context owns its scope-bound namespace through measured rebuild',t=>{
 const {Store}=require('../src/store.cjs'),{buildContext}=require('../src/assistant-context.cjs');
 const store=new Store(':memory:');t.after(()=>store.close());const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'现在只私下分析。'});
 const settings={model:'synthetic-primary-standalone'},args={scope,store,records:[],companion:store.getCompanion(scope),turn,requestId:'standalone-scope',settings,
  availableSources:store.memorySources(scope).map(source=>({...source,scope}))};
 const context=buildContext(args);assert.ok(context.sourceHandleOwner.matches(scope,'standalone-scope'));
 const rebuilt=context.rebuildForRequest(payload=>prepareAssistantRequest({...settings,sourceHandleOwner:context.sourceHandleOwner},payload).requestBytes);
 assert.equal(rebuilt.sourceHandleOwner,context.sourceHandleOwner);assert.equal(settings.sourceHandleOwner,undefined);
});
test('raw primary binds an exact current fact while keeping the intact instruction outside material selection',async()=>{
 const {payload,settings}=fixture(),request='改一下，我现在想直接说我对她有好感，想多认识她。',meaning='我对她有好感，想多认识她';
 payload.userRequest.text=request;payload.sources[1].text=request;
 const context={payload,manifest:{scope,requestId:'interior-primary',sourceRevisions:Object.fromEntries(payload.sources.map(source=>[source.id,source.revision]))}},calls=[];
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{
  const wrapper=JSON.parse(JSON.parse(args.body).messages[1].content),p=wrapper.originalInput||wrapper;calls.push(p);
  assert.equal(p.sources.some(source=>source.id===p.intentAuthority.sourceId),false,'the current instruction has no outward material menu');
  assert.equal(p.currentPermission.authority,'original_current_human_statement_candidate_not_grant');assert.equal(p.userRequest.text,request);
  return response({operation:'prepare_message',currentFacts:[meaning],answer:{suggestions:[{text:'我对你有好感，也想多认识你。'}]}});
 });
 const material=require('../src/context/wording-view.cjs').resolveAnswerMaterial(context,result);
 assert.equal(calls.length,1);assert.equal(admitted(result)[0].text,meaning);assert.equal(material.bindings[0].permission.text,request);
 assert.equal(material.bindings[0].referent.text,meaning);assert.equal(admitted(result)[0].text.includes('我现在想直接说'),false);
});
