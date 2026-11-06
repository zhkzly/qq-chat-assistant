'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional inputs and real context assembly/wire consumers. These checks bind
// control provenance; they do not judge model meaning or prove no semantic leak.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {buildCurrentHumanControl}=require('../src/context/current-human-control.cjs');
const {assistModel,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {resolveDraftMaterial}=require('../src/context/draft-material.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const FACT='查找功能可以按标题找回摘记。';
const HUMAN='我想直接邀请她周六一起看看这个小网页，也想问她想先看哪一部分。它只是有这个功能，不代表她已经用过。我自己的PRIVATE_CONTROL_FACT最近还没有用它找回旧笔记。最后的分寸：不要把可能性写成已经共同做过的事，也不要把私下这段理由发给她。';
const clone=value=>structuredClone(value);
function captured(text=HUMAN,patch={}){
 const current={id:'private:human-current',type:'private',role:'user',kind:'discussion',text,revision:'human-r1',scope:clone(scope),...patch};
 return {payload:{purpose:'discussion',intentAuthority:{sourceId:current.id},userRequest:{sourceId:'private:decoy',text:'MODEL_UNTRUSTED_USERREQUEST'},sources:[clone(current)]},fullAvailableSources:[clone(current)],manifest:{scope:clone(scope),sourceRevisions:{[current.id]:current.revision}}};
}
function fixture(t,{text=HUMAN}={}){
 const store=new Store(':memory:');t.after(()=>store.close());
 const asOf=new Date(Date.now()+1000).toISOString();store.add(scope,[normalize(raw('72057594049927937142',false,{msgTime:String(Math.floor(Date.parse(asOf)/1000)-60),elements:[{textElement:{content:'你说的查找功能主要能做什么？'}}]}),scope)]);
 const note=store.saveNote(scope,{text:FACT,use:'draft',kind:'material'}),turn=store.appendTurn(scope,{role:'user',kind:'discussion',text});
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-grounded-composition',assistantRequestBytes:64000};
 const args={scope,store,records:store.messages(scope),availableSources:store.memorySources(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',generationOrigin:'private_discussion',materialIds:[note.id],requestId:'grounded-controls-fictional',asOf,coverage:{status:'partial'},byteBudget:128000,settings,responsePreference:'自然口语，简短，不用表情。'};
 const prepared=buildContext(args),sourceId=prepared.payload.intentAuthority.sourceId,control=text=>({text,sourceIds:[sourceId]});
 const plan={intent:'reply',quotes:[{sourceId:'note:'+note.id,text:FACT}],guidance:{objective:control('介绍查找功能并接着问她的使用进展'),allowedApproach:control('用一个具体问题延续话题'),avoidances:[],currentStep:control('问她已经找回了多少条摘记')}};
 return {store,note,turn,args,prepared,plan,sourceId,settings};
}

test('actual restricted assembly keeps the whole current human statement separate from admitted facts and generated moves',t=>{
 const app=fixture(t),before=clone(app.prepared.payload),draft=buildDraftContext(app.prepared,app.plan,app.args),c=draft.payload.currentHumanControl;
 // D006 currentHumanControl adds honest delivery metadata (local completeness
 // vs producer delivery) on the same CONTROL_ONLY contract shape.
 assert.equal(c.version,1);assert.equal(c.authority,'CONTROL_ONLY');assert.equal(c.sourceId,app.sourceId);assert.equal(c.sourceType,'private');assert.equal(c.text,HUMAN);
 assert.equal(c.localOriginalComplete,true);assert.equal(c.producerDelivery.complete,true);assert.deepEqual(c.producerDelivery.ranges,[{start:0,end:HUMAN.length}]);assert.deepEqual(c.producerDelivery.unreadRanges,[]);assert.equal(c.producerDelivery.sourceId,app.sourceId);assert.equal(typeof c.producerDelivery.revision,'string');
 assert.deepEqual(draft.payload.outboundQuotes.map(({sourceId,text})=>({sourceId,text})),[{sourceId:'note:'+app.note.id,text:FACT}]);
 assert.equal(JSON.stringify(draft.payload.outboundQuotes).includes('PRIVATE_CONTROL_FACT'),false);
 assert.equal(draft.payload.draftingGuidance.authority,'GENERATED_PROPOSAL');assert.equal(draft.payload.draftingGuidance.currentStep.text,app.plan.guidance.currentStep.text);
 assert.notEqual(draft.payload.draftingGuidance.authority,c.authority);assert.equal(c.text.includes('直接邀请她周六'),true);assert.equal(c.text.includes('也想问她想先看哪一部分'),true);assert.equal(c.text.endsWith('也不要把私下这段理由发给她。'),true);
 assert.equal(draft.manifest.sourceRevisions[app.sourceId],app.prepared.manifest.sourceRevisions[app.sourceId]);assert.deepEqual(app.prepared.payload,before);
});

test('a current human statement can also contain an independently admitted fact without the control lane excluding it',t=>{
 const fact='今天刚把查找功能弄好。',text='这是我自己用的读书笔记小网页，'+fact+'我愿意把这个小进展告诉她。PRIVATE_INTERSECTION_REASON只留在这里，别把私下理由写出去。',app=fixture(t,{text});
 const explicit={...app.plan,quotes:[{sourceId:app.sourceId,text:fact}]};
 assert.deepEqual(resolveDraftMaterial(app.prepared.payload,explicit).quotes,[{sourceId:app.sourceId,text:fact}],'the unchanged material admission contract independently admits this exact current fragment');
 const draft=buildDraftContext(app.prepared,explicit,app.args);assert.equal(draft.payload.currentHumanControl.text,text);assert.equal(draft.payload.currentHumanControl.authority,'CONTROL_ONLY');
 assert.deepEqual(draft.payload.outboundQuotes.map(({sourceId,text})=>({sourceId,text})),[{sourceId:app.sourceId,text:fact}]);
 assert.equal(JSON.stringify(draft.payload.outboundQuotes).includes('PRIVATE_INTERSECTION_REASON'),false);
 const controlOnly=buildDraftContext(app.prepared,{...app.plan,quotes:[]},app.args);assert.deepEqual(controlOnly.payload.outboundQuotes,[],'control visibility alone never adds the same fact to admitted outward material');
});

test('a partial planning delivery uses the whole captured human source at the exact revision, including a tail veto',()=>{
 const input=captured(),current=input.payload.sources[0];current.text=HUMAN.slice(0,15);current.delivery={status:'partial',start:0,end:15,originalCharLength:HUMAN.length};
 const result=buildCurrentHumanControl(input,{scope,availableSources:input.fullAvailableSources});
 assert.equal(result.control.text,HUMAN);assert.equal(result.control.authority,'CONTROL_ONLY');assert.deepEqual(result.dependencies,[{sourceId:current.id,revision:'human-r1'}]);assert.equal(result.control.revision,undefined);
});

test('only trusted intentAuthority can select human controls and generated wrappers never fall back to historical text',()=>{
 const missing=captured();delete missing.payload.intentAuthority;assert.deepEqual(buildCurrentHumanControl(missing,{scope}),{dependencies:[]});
 for(const patch of [{type:'request'},{kind:'feedback_continue'},{kind:'user_control'},{role:'assistant'},{type:'note'},{authority:'invocation_control_not_user_evidence'}]){
  const input=captured('GENERATED_WRAPPER_NOT_HUMAN',patch),old={id:'private:old',type:'private',role:'user',text:HUMAN,revision:'old-r1'};input.payload.sources.push(old);input.fullAvailableSources.push(old);input.payload.userRequest={sourceId:old.id,text:HUMAN};
  assert.deepEqual(buildCurrentHumanControl(input,{scope}),{dependencies:[]});
 }
 const sanitized=captured();sanitized.payload.sources[0]={...sanitized.payload.sources[0],type:'request',authority:'invocation_control_not_user_evidence',text:'SANITIZED_INVOCATION'};
 assert.deepEqual(buildCurrentHumanControl(sanitized,{scope}),{dependencies:[]},'a sanitized invocation cannot restore the original text from an older capture');
});

test('canonical original feedback is retained but the generated feedback continuation is not human control',()=>{
 const original=captured('这次仍然直接邀请她，但不要说成她已经接受。',{id:'private:feedback-fixture',type:'feedback',kind:'local',canonicalFeedbackId:'fixture'});
 assert.equal(buildCurrentHumanControl(original,{scope,availableSources:original.fullAvailableSources}).control.sourceType,'feedback');
 assert.equal(buildCurrentHumanControl(original,{scope}).control.text,original.fullAvailableSources[0].text);
 const wrapper=captured('结合选中的反馈继续给帮助。',{kind:'feedback_continue'});wrapper.payload.sources.push(original.payload.sources[0]);wrapper.fullAvailableSources.push(original.fullAvailableSources[0]);
 assert.deepEqual(buildCurrentHumanControl(wrapper,{scope}),{dependencies:[]});
});

test('actual feedback continuation binds the original feedback human rather than its generated wrapper',async t=>{
 const store=new Store(':memory:'),calls=[],feedbackText='我仍然想直接邀请她一起看，但不要问成她已经用过；PRIVATE_FEEDBACK_CONTROL只用于商量。';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model:'synthetic-original-feedback',baseUrl:'http://fixture.invalid/v1',discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-original-feedback',baseUrl:'http://fixture.invalid/v1'}},read:async()=>{throw Error('No native QQ reads in this fictional test');},
  assistantModel:async(_settings,context)=>{calls.push(context);if(context.payload.purpose==='fidelity_check')return {checkRef:context.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
   const id=context.payload.intentAuthority.sourceId,current=context.payload.sources.find(source=>source.id===id),control=text=>({text,sourceIds:[id]});
   return {kind:'discussion',text:'按当前真实反馈修正提议。',requestDelivery:{mode:'editable_message',sourceId:id,quote:current.text},draftPlan:{intent:'reply',quotes:[],guidance:{objective:control('保留本次明确邀请'),allowedApproach:control('按实际材料修正问题'),avoidances:[]}},answer:{privateExplanation:'Synthetic completion.',suggestions:[{style:'自然',text:'先保留邀请的意思。'}]}};}});
 t.after(()=>{controller.close();store.close();});controller.scope=clone(scope);controller.ingest(scope,[raw('72057594049927937144',false)]);
 const previous=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'A fictional previous suggestion.',requestId:'grounded-feedback-target',sourceIds:['qq:72057594049927937144']});
 const answer=await controller.continueFeedback({taskId:'grounded-original-feedback',clientEventId:'grounded-feedback-event',requestId:previous.requestId,targetRef:{kind:'artifact',artifactRef:previous.artifactRef},text:feedbackText});
 assert.equal(answer.feedbackContinuation.status,'complete');assert.equal(calls.length,2);assert.equal(calls.filter(call=>call.payload.purpose==='fidelity_check').length,1);const original=store.experiences.listFeedback(scope)[0],control=controller.assistantContext().run.payload.currentHumanControl;
 assert.equal(control.sourceId,original.sourceId);assert.equal(control.sourceType,'feedback');assert.equal(control.text,feedbackText);assert.equal(control.authority,'CONTROL_ONLY');
 assert.equal(calls[0].payload.intentAuthority.sourceId,original.sourceId);assert.equal(control.text.includes('结合我选中的这条反馈'),false);
 assert.ok(store.getCompanion(scope).turns.some(turn=>turn.kind==='feedback_continue'),'the generated wrapper really exists and is not being mistaken for the human');
 assert.equal(controller.assistantContext().run.payload.outboundQuotes.length,0);assert.equal(calls.filter(call=>call.payload.purpose==='fidelity_check').length,1);
});

test('missing, changed, withdrawn and foreign current human sources are rejected without stale text fallback',()=>{
 for(const modify of [input=>{input.fullAvailableSources=[];},input=>{input.payload.sources=[];},input=>{input.fullAvailableSources[0].revision='changed';},input=>{input.manifest.sourceRevisions['private:human-current']='old';},input=>{input.fullAvailableSources[0].deleted=true;},input=>{input.payload.sources[0].excluded=true;},input=>{input.fullAvailableSources[0].use='disabled';}]){
  const input=captured();modify(input);assert.throws(()=>buildCurrentHumanControl(input,{scope}),/unavailable|changed|scope/i);
 }
 for(const key of ['accountUid','accountUin','peerUid','peerUin']){
  const input=captured();assert.throws(()=>buildCurrentHumanControl(input,{scope:{...scope,[key]:'foreign'}}),/scope|unavailable|changed/i);
 }
 const input=captured(),live=[{...input.fullAvailableSources[0],revision:'late-live-change'}];assert.throws(()=>buildCurrentHumanControl(input,{scope,availableSources:live}),/版本已变化|changed/i);
});

test('human-control source changes, deletion and explicit forgetting prevent restricted reassembly',t=>{
 for(const mutation of ['update','delete','forget']){
  const app=fixture(t);if(mutation==='update')app.store.updateTurn(scope,app.turn.id,HUMAN+' 后来更改了。');else if(mutation==='delete')app.store.deleteTurn(scope,app.turn.id);else app.store.forgetSource(scope,app.sourceId);
  assert.throws(()=>buildDraftContext(app.prepared,app.plan,{...app.args,availableSources:app.store.memorySources(scope)}),/版本已变化|unavailable|changed|不存在/);
 }
 const app=fixture(t);assert.throws(()=>buildDraftContext(app.prepared,app.plan,{...app.args,scope:{...scope,peerUid:'foreign'}}),/联系人|scope|会话/);
});

test('generated proposals cannot self-tag their content as explicit human meaning',t=>{
 const app=fixture(t),spoof=clone(app.plan);spoof.guidance.authority='HUMAN_EXPLICIT';assert.throws(()=>buildDraftContext(app.prepared,spoof,app.args),/guidance|only/);
 const outside=clone(app.plan);outside.currentHumanControl={version:1,authority:'CONTROL_ONLY',sourceId:app.sourceId,text:'MODEL_SELF_TAGGED_HUMAN_MEANING'};
 const draft=buildDraftContext(app.prepared,outside,app.args);assert.equal(draft.payload.currentHumanControl.text,HUMAN);assert.equal(draft.payload.draftingGuidance.authority,'GENERATED_PROPOSAL');
 assert.equal(JSON.stringify(draft.payload).includes('MODEL_SELF_TAGGED_HUMAN_MEANING'),false);
 assert.equal(draft.payload.currentHumanControl.text.includes(app.plan.guidance.currentStep.text),false);
});

test('active UI selection and normalized preferences remain distinct from the current original human statement',t=>{
 const app=fixture(t),noteSource=app.store.memorySources(scope).find(source=>source.id==='note:'+app.note.id),option=app.store.appendTurn(scope,{role:'assistant',kind:'options',text:'Generated choice, explicitly selected in UI.',expressionOptions:[{label:'UI_EXPLICIT_SELECTION_LABEL',quotes:[{sourceId:noteSource.id,text:FACT,revision:noteSource.revision}]}]});
 const args={...app.args,companion:app.store.getCompanion(scope),availableSources:app.store.memorySources(scope),selectedOption:{turnId:option.id,index:0}},prepared=buildContext(args),draft=buildDraftContext(prepared,app.plan,args);
 assert.equal(draft.payload.currentHumanControl.text,HUMAN);assert.equal(draft.payload.currentHumanControl.text.includes('UI_EXPLICIT_SELECTION_LABEL'),false);
 assert.deepEqual(prepared.payload.selectedOption,args.selectedOption);assert.ok(draft.payload.wordingControls.items.some(item=>item.sourceIds.includes('responsePreference')));
 assert.equal(draft.payload.wordingControls.authority==='CONTROL_ONLY',false);assert.equal(draft.payload.outboundQuotes[0].text,FACT);
});

test('program-selected direction meaning survives generated-guidance omission under measured budget pressure',t=>{
 const app=fixture(t,{text:'按选中的方向组织表达'}),noteSource=app.store.memorySources(scope).find(source=>source.id==='note:'+app.note.id),label='直接邀请她周六一起看网页，并问她想先看哪一部分。';
 const option=app.store.appendTurn(scope,{role:'assistant',kind:'options',text:'A fictional generated direction, later explicitly selected.',expressionOptions:[{label,style:'casual',quotes:[{sourceId:noteSource.id,text:FACT,revision:noteSource.revision}]}]});
 const args={...app.args,companion:app.store.getCompanion(scope),availableSources:app.store.memorySources(scope),selectedOption:{turnId:option.id,index:0}},prepared=buildContext(args);
 const measure=value=>prepareAssistantRequest(app.settings,value).requestBytes+(value?.draftingGuidance?app.settings.assistantRequestBytes:0);
 const draft=buildDraftContext(prepared,app.plan,{...args,requestMeasure:measure});
 assert.equal(draft.payload.draftingGuidance,undefined);assert.equal(draft.manifest.compositionProposal.status,'omitted_for_budget');
 assert.equal(draft.payload.currentHumanControl.text,'按选中的方向组织表达');
 assert.equal(JSON.stringify(draft.payload).includes(label),true,'the actual selected direction must remain in an essential control lane after optional generated guidance is omitted');
 assert.deepEqual(draft.payload.selectedDirectionControl,{version:1,authority:'CONTROL_ONLY_UI_SELECTION',selection:args.selectedOption,label,style:'casual'});
 const dependency=draft.manifest.inputArtifactRefs.find(item=>item.kind==='action_option');assert.ok(dependency,'selected direction participates in the existing private artifact fence');
 assert.deepEqual(dependency.artifactRef,option.expressionOptions[0].artifactRef);assert.equal(dependency.turnId,option.id);assert.equal(dependency.optionIndex,0);assert.ok(dependency.tupleDigest);
 assert.deepEqual(draft.manifest.selectedDirectionControl.selection,args.selectedOption);assert.equal(draft.manifest.selectedDirectionControl.tupleDigest,dependency.tupleDigest);
 assert.deepEqual(draft.manifest.selectedDirectionControl.artifactRef,option.expressionOptions[0].artifactRef);assert.equal(JSON.stringify(draft.manifest.selectedDirectionControl).includes(label),false,'private control witness carries identity and hashes, not a duplicate body');
 assert.doesNotThrow(()=>app.store.experiences.assertInputArtifactsCurrent(scope,draft.manifest.inputArtifactRefs));
 const cannotFitSelection=value=>prepareAssistantRequest(app.settings,value).requestBytes+(value?.selectedDirectionControl?app.settings.assistantRequestBytes:0);
 assert.throws(()=>buildDraftContext(prepared,app.plan,{...args,requestMeasure:cannotFitSelection}),/预算|必要|超过|完整/,'an essential selected-direction control must fail explicitly rather than being dropped like a generated proposal');
 assert.deepEqual(draft.payload.outboundQuotes.map(({sourceId,text})=>({sourceId,text})),[{sourceId:noteSource.id,text:FACT}]);
 assert.equal(JSON.stringify(draft.payload.outboundQuotes).includes(label),false,'the selected direction label does not become a factual quotation');
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false,'choosing a direction is neither message adoption nor an actual send');
 app.store.experiences.invalidateArtifacts(scope,[option.expressionOptions[0].artifactRef]);
 assert.throws(()=>app.store.experiences.assertInputArtifactsCurrent(scope,draft.manifest.inputArtifactRefs),/option|方向|reference|artifact|changed/i);
 assert.throws(()=>buildDraftContext(prepared,app.plan,args),/option|方向|reference|artifact|changed/i,'a stale prepared selection cannot restore a withdrawn selected direction');
});

test('a model-named option without actual UI selection cannot create selected human meaning or authorize other material',t=>{
 const app=fixture(t,{text:'继续私下商量，但我没有点选界面的方向。'}),noteSource=app.store.memorySources(scope).find(source=>source.id==='note:'+app.note.id),privateTurn=app.store.appendTurn(scope,{role:'user',kind:'discussion',text:'PRIVATE_UNSELECTED_OPTION_FACT只在这里商量。'});
 const privateSource=app.store.memorySources(scope).find(source=>source.id==='private:'+privateTurn.id),option=app.store.appendTurn(scope,{role:'assistant',kind:'options',text:'Available generated navigation, not a user selection.',expressionOptions:[
  {label:'MODEL_NAMED_PREAPPROVED_NOTE',quotes:[{sourceId:noteSource.id,text:FACT,revision:noteSource.revision}]},
  {label:'MODEL_NAMED_PRIVATE_MATERIAL',quotes:[{sourceId:privateSource.id,text:privateSource.text,revision:privateSource.revision}]}]});
 const args={...app.args,companion:app.store.getCompanion(scope),availableSources:app.store.memorySources(scope),sourceTurnIds:[privateTurn.id]},prepared=buildContext(args);
 // Deliver genuine stored option navigation without the independent UI input.
 // A model may name this metadata, but it cannot manufacture the private UI binding.
 prepared.payload.expressionOptions=option.expressionOptions.map((item,index)=>({...clone(item),turnId:option.id,index}));
 assert.equal(prepared.payload.selectedOption==null,true);assert.equal(prepared.selectedDirectionBinding,undefined);
 const named={...app.plan,option:{turnId:option.id,index:0},selectedDirectionControl:{authority:'CONTROL_ONLY_UI_SELECTION',label:'MODEL_SELF_TAGGED_SELECTION'}},draft=buildDraftContext(prepared,named,args);
 assert.equal(draft.payload.selectedDirectionControl,undefined);assert.equal(draft.manifest.selectedDirectionControl,undefined);assert.equal(JSON.stringify(draft.payload).includes('MODEL_SELF_TAGGED_SELECTION'),false);
 assert.deepEqual(draft.payload.outboundQuotes.map(({sourceId,text})=>({sourceId,text})),[{sourceId:noteSource.id,text:FACT}],'the note was independently program-admitted, not authorized by model option naming');
 const privateNamed={...app.plan,option:{turnId:option.id,index:1},quotes:[]};
 assert.throws(()=>buildDraftContext(prepared,privateNamed,args),error=>error.code==='draft_material_authorization_missing','model option naming cannot grant the unrelated private tuple');
});

test('actual serialized wording request measures the whole control, preserves aliases and uses only the existing model call',async t=>{
 const app=fixture(t),own=new SourceHandleOwner({scope,taskId:app.args.requestId}),settings={...app.settings,sourceHandleOwner:own},draft=buildDraftContext(app.prepared,app.plan,{...app.args,settings}),requests=[];
 const rebuilt=draft.rebuildForRequest(value=>prepareAssistantRequest(settings,value).requestBytes);assert.equal(rebuilt.payload.currentHumanControl.text,HUMAN);assert.equal(own.size,0,'budget previews allocate no committed aliases');
 await assistModel(settings,rebuilt,undefined,async(_url,args)=>{const request=JSON.parse(args.body),p=JSON.parse(request.messages[1].content);requests.push({request,p,bytes:Buffer.byteLength(args.body)});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'draft',text:'Synthetic wording.',suggestions:[{style:'自然',text:FACT}]})}}]}),{status:200});});
 assert.equal(requests.length,1);const [{p,bytes}]=requests,alias=rebuilt.manifest.sourceHandles.bindings.find(item=>item.sourceId===app.sourceId).handle;
 assert.equal(p.currentHumanControl.text,HUMAN);assert.equal(p.currentHumanControl.sourceId,alias);assert.equal(p.currentHumanControl.authority,'CONTROL_ONLY');assert.equal(p.draftingGuidance.authority,'GENERATED_PROPOSAL');
 assert.equal(rebuilt.manifest.serializedTextRequestBytes,bytes);assert.ok(bytes<=settings.assistantRequestBytes);assert.equal(p.outboundQuotes.some(item=>item.text.includes('PRIVATE_CONTROL_FACT')),false);
});

test('necessary whole human controls that cannot fit fail explicitly rather than clipping their tail',t=>{
 const text='这段只用于本次表达控制。'+ 'CONTROL_ONLY_CURRENT_STATEMENT '.repeat(320)+'TAIL_VETO_MUST_NOT_BE_CLIPPED',app=fixture(t,{text});
 assert.throws(()=>buildDraftContext(app.prepared,app.plan,{...app.args,settings:{...app.settings,assistantRequestBytes:8000}}),/预算|必要|超过|完整/);
});

test('cancelling while the primary response is pending cannot publish a result bound to the old human-control request',async t=>{
 const store=new Store(':memory:'),calls=[];let resolveWording;
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model:'synthetic-cancel-control',baseUrl:'http://fixture.invalid/v1',discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-cancel-control',baseUrl:'http://fixture.invalid/v1'}},read:async()=>{throw Error('No native QQ reads in this fictional test');},
  assistantModel:async(_settings,context)=>{calls.push(context);const id=context.payload.intentAuthority.sourceId,control=text=>({text,sourceIds:[id]});return new Promise(resolve=>{resolveWording=()=>resolve({kind:'discussion',text:'Prepare an evidence-bound response.',requestDelivery:{mode:'editable_message',sourceId:id,quote:context.payload.sources.find(item=>item.id===id).text},draftPlan:{intent:'reply',quotes:[],guidance:{objective:control('回应实际来信'),allowedApproach:control('保持本次明确邀请的方向'),avoidances:[]}},answer:{suggestions:[{style:'自然',text:'OBSOLETE_WORDING'}]}});});}});
 t.after(()=>{controller.close();store.close();});controller.scope=clone(scope);controller.ingest(scope,[raw('72057594049927937143',false)]);
 const pending=controller.assist({text:HUMAN,taskId:'cancel-current-human-control'});for(let n=0;n<30&&!resolveWording;n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(resolveWording);
 const primaryInput=calls[0];controller.invalidateAssistant();resolveWording();await pending;
 assert.equal(primaryInput.payload.purpose,'discussion');assert.equal(primaryInput.payload.sources.find(source=>source.id===primaryInput.payload.intentAuthority.sourceId).text,HUMAN);
 assert.equal(store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&JSON.stringify(turn).includes('OBSOLETE_WORDING')),false);
 assert.equal(controller.usage.get(scope,'cancel-current-human-control').status,'cancelled');assert.equal(calls.length,1);
});
