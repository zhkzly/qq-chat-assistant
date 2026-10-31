'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentStatementAuthority}=require('./fixtures/current-statement-authority.cjs');
const fact='今天我读完一本书',literal='private:quoted-id';
const currentText=`${fact}，想把这个近况和字符串“${literal}”原样告诉她，给我完整表达。`;
const intent=p=>p.intentAuthority.sourceId;
const currentFacts=()=>[fact,literal];
async function setup(t,producer){
 const store=new Store(':memory:'),calls=[],contexts=[];
 const settings={anonymous:true,model:'synthetic-wire',baseUrl:'http://fixture.invalid/v1',auto:false,assistantRequestLimit:8,discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-wire',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},assistantModel:(configured,context,signal)=>{
  contexts.push(context);return assistModel(configured,context,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;
   calls.push({request,wrapper,p,taskId:configured.requestBudget.task.id,owner:configured.sourceHandleOwner});
   const result=await producer(p,wrapper,calls.length-1,context);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{status:200});
  });
 }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('72057594049900000001',false,{elements:[{textElement:{content:'最近读到什么了吗？'}}]})]});
 t.after(()=>{controller.close();store.close();});return {controller,store,calls,contexts,run:()=>store.getCompanion(scope).runs.at(-1)};
}
const draft={kind:'draft',text:`今天读完了这本书，顺便记下这个字符串：${literal}。`};
const answer={suggestions:[{text:draft.text}]},allow=p=>({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]});
test('actual foreground wire is compact while controller, stored provenance and quoted literals remain canonical',async t=>{
 const app=await setup(t,p=>p.purpose==='fidelity_check'?allow(p):{operation:'prepare_message',currentFacts:currentFacts(),answer});
 const reply=await app.controller.assist({text:currentText});assert.equal(app.calls.length,2);assert.equal(reply.suggestions[0].text,draft.text);
 for(const call of app.calls){assert.equal(call.p.sourceReferenceProtocol?.version||call.wrapper.sourceReferenceProtocol.version,'foreground-source-handles-v1');assert.ok((call.p.sources||call.p.evidence).every(source=>/^s\d+$/.test(source.id||source.sourceId)));assert.ok(JSON.stringify(call.p).includes(literal));}
 assert.equal(app.calls[0].p.intentAuthority.sourceId,app.calls[1].p.admittedFragments[0].sourceId,'same task retains source handle through restricted wording');
 const current=app.store.getCompanion(scope).turns.find(turn=>turn.role==='user');assert.ok(reply.sourceIds.includes(`private:${current.id}`));
 for(const context of app.contexts){assert.equal(context.payload.sourceReferenceProtocol,undefined);assert.ok((context.payload.sources||context.payload.evidence).every(source=>/^(qq|private|note|request):/.test(source.id||source.sourceId)));}
 assert.equal(app.run().requests.length,2);assert.ok(app.run().requests.every(request=>request.manifest.sourceHandles.bindings.every(binding=>!/^s\d+$/.test(binding.sourceId))));assert.equal(app.run().manifest.requestDelivery.status,'delivered');
});
test('unknown hybrid reference is rejected exactly beside the correct current handle in an active lookup',async t=>{
 const hybrid='private:0227f276-0758-46c0-9613-e5e672159b16';
 const app=await setup(t,p=>{return {operation:'lookup',continuation:'prepare_message',lookup:{sourceIds:[intent(p),hybrid]}};});
 await assert.rejects(app.controller.assist({text:currentText}),/Unknown or not-offered source handle/);assert.equal(app.calls.length,2);assert.equal(app.run().status,'failed');
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.ok(app.calls[1].wrapper.invalidResponse.includes(hybrid));
});
test('lookup, same-task structured repair and wording use append-only offers without resending canonical typed IDs',async t=>{
 const app=await setup(t,(p,w,index)=>{
  if(p.purpose==='fidelity_check')return allow(p);
  if(index===0)return {operation:'lookup',continuation:'prepare_message',text:'先读取当前已知来源。',lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]}};
  if(!w.originalInput)return {operation:'prepare_message',text:'只给策略还不够。'};
  return {operation:'prepare_message',currentFacts:currentFacts(),answer};
 });
 const reply=await app.controller.assist({text:currentText});assert.equal(reply.kind,'draft');assert.equal(app.calls.length,4);assert.equal(new Set(app.calls.map(call=>call.owner)).size,1);
 assert.equal(new Set(app.calls.slice(0,3).map(call=>call.p.intentAuthority.sourceId)).size,1);
 const canonicalId=app.contexts[0].payload.intentAuthority.sourceId;assert.equal(app.calls[2].wrapper.task.includes(canonicalId),false);assert.match(app.calls[2].wrapper.task,/prepare_message/);assert.match(app.calls[2].request.messages[0].content,/materials:\[\{materialRef,authorityRef\}\]/);
 assert.ok(app.calls[2].wrapper.validationIssues.some(issue=>issue.path==='text'&&issue.code==='primary_operation_inactive_payload'));
 const materialSchema=prepareAssistantRequest({...app.controller.settings,modelResponseMode:'result_tool'},app.contexts[0].payload).request.tools[0].function.parameters.properties.materials.items;
 assert.deepEqual(Object.keys(materialSchema.properties).sort(),['authorityRef','factQuote','materialRef','permissionQuote']);assert.ok(materialSchema.required.includes('materialRef'));
 assert.equal(app.run().requests.filter(request=>request.purpose==='delivery_repair').length,1);
});
test('budget preview serializes aliased bytes without registering speculative handles',()=>{
 const owner=new SourceHandleOwner({scope,taskId:'budget'}),settings={model:'synthetic-wire',sourceHandleOwner:owner};
 const p={purpose:'discussion',sources:[{id:'private:long-canonical-uuid-000000000000000000',revision:'r1',text:literal}],userRequest:{sourceId:'private:long-canonical-uuid-000000000000000000',text:literal}};
 const before=JSON.stringify(p),first=prepareAssistantRequest(settings,p,[]),second=prepareAssistantRequest(settings,p,[]);
 assert.equal(owner.size,0);assert.equal(first.serialized,second.serialized);assert.equal(first.requestBytes,Buffer.byteLength(first.serialized));assert.equal(JSON.stringify(p),before);
 assert.equal(first.payload,p);assert.notEqual(first.wirePayload.userRequest.sourceId,p.sources[0].id);assert.equal(first.wirePayload.userRequest.text,literal);assert.deepEqual(first.wirePayload.sources,[]);
});
test('same-task QQ resume retains its source owner and original budget; a fresh user request gets a new owner',async t=>{
 let finishPending;
 const app=await setup(t,(p,w,index)=>{
  if(p.purpose==='fidelity_check')return allow(p);
  if(index===0)return {operation:'lookup',continuation:'prepare_message',text:'先读当前原话。',lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]}};
  if(index===1)return new Promise(resolve=>{finishPending=()=>resolve({operation:'prepare_message',currentFacts:currentFacts(),answer});});
  if(p.userRequest.text==='现在只私下解释。')return {operation:'advise',text:'可以先私下解释。'};
  return {operation:'prepare_message',currentFacts:currentFacts(),answer};
 });
 const pending=app.controller.assist({text:currentText,taskId:'source-handle-qq-resume'});
 for(let i=0;i<30&&!finishPending;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(finishPending);
 app.controller.live({scope,messages:[raw('72057594049900000002',false,{elements:[{textElement:{content:'我也刚读完一本。'}}]})]});
 finishPending();await pending;
 for(let i=0;i<100&&(app.controller.pendingAssist||app.controller.assistantBusy);i++)await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(app.run().status,'complete');assert.equal(app.calls.length,4);assert.equal(new Set(app.calls.map(call=>call.owner)).size,1);assert.equal(app.calls[0].p.intentAuthority.sourceId,app.calls[2].p.intentAuthority.sourceId);
 assert.equal(app.controller.usage.get(scope,'source-handle-qq-resume').attempts,4);
 const oldOwner=app.calls[0].owner;await app.controller.assist({text:'现在只私下解释。'});assert.notEqual(app.calls.at(-1).owner,oldOwner);
});
test('forget keeps the task namespace but does not re-offer withdrawn aliases or retain private bodies',async t=>{
 const secret='HANDLE_FORGET_PRIVATE_SENTINEL';let noteId,oldHandle;
 const app=await setup(t,(p,w,index)=>{
  if(p.purpose==='fidelity_check')return allow(p);
  if(index===0){const note=p.sources.find(source=>source.type==='note');oldHandle=note.id;return {operation:'clarify',blocker:{kind:'missing_fact',missing:secret,question:`移除${secret}后想先聊什么？`,explanation:`先移除${secret}再确认。`},actions:[{type:'forget',sourceId:note.id,evidenceQuote:`忘记${secret}`,targetQuote:secret}]};}
  assert.equal(JSON.stringify(p).includes(secret),false);assert.equal(p.sources.some(source=>source.id===oldHandle),false);
  return {operation:'clarify',blocker:{kind:'missing_fact',missing:'新的分享范围',question:'接下来想先分享哪一段？'}};
 });
 noteId=`note:${app.store.saveNote(scope,{text:secret,use:'discussion'}).id}`;
 const reply=await app.controller.assist({text:`忘记${secret}这条笔记，然后继续给我表达。`});assert.equal(reply.kind,'question');assert.equal(app.calls.length,3);assert.equal(app.calls[0].owner,app.calls[1].owner);
 assert.equal(app.store.memorySources(scope).some(source=>source.id===noteId),false);assert.equal(JSON.stringify(app.run()).includes(secret),false);
 assert.equal(app.run().manifest.sourceHandles.bindings.some(binding=>binding.sourceId===noteId),false);
});
test('source withdrawal during read-only checking still discards the late decoded result',async t=>{
 let finish;
 const app=await setup(t,p=>p.purpose==='fidelity_check'?new Promise(resolve=>{finish=()=>resolve(allow(p));}):{operation:'prepare_message',currentFacts:currentFacts(),answer});
 const pending=app.controller.assist({text:currentText});for(let i=0;i<30&&!finish;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(finish);
 const current=app.store.getCompanion(scope).turns.find(turn=>turn.role==='user');app.controller.deleteTurn(current.id);finish();assert.equal(await pending,undefined);
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});
test('unknown handle in a whole optional auxiliary field preserves checked private help without committing state',async t=>{
 const app=await setup(t,p=>p.purpose==='fidelity_check'?allow(p):({operation:'advise',text:'我们先私下理清想法。',stateReview:'no_change',statePatch:{items:[{text:'不能提交的辅助状态',sourceIds:[intent(p),'s999']}]}}));
 const before=app.store.getCompanion(scope).state.version;
 const reply=await app.controller.assist({text:'先私下理清为什么，不要写表达。'});
 assert.equal(app.calls.length,2);assert.equal(reply.text,'我们先私下理清想法。');assert.equal(app.store.getCompanion(scope).state.version,before);
 assert.ok(app.run().requests[0].manifest.auxiliaryErrors.some(error=>error.field==='statePatch'));assert.equal(app.run().privateReviewReceipt,undefined);
 assert.equal(JSON.stringify(app.run()).includes('不能提交的辅助状态'),false);
});
test('budget previews use the same revision-bound wire width as the dispatch snapshot',()=>{
 const {contextBudget}=require('../src/context/budget-manifest.cjs');
 const owner=new SourceHandleOwner({scope,taskId:'revision-budget'}),sources=Array.from({length:9},(_,i)=>({id:`private:catalog-${i}`,revision:'r1',type:'private',role:'user',text:'source'}));
 owner.preview({sources}).commit();const settings={model:'synthetic-wire',sourceHandleOwner:owner},id=sources[8].id;
 const p={purpose:'discussion',sources:[],memoryIndex:[{sourceIds:[id]}]},options={sourceRevisions:{[id]:'r2'}};
 const budget=contextBudget(settings,48000,undefined,options),actual=prepareAssistantRequest(settings,p,[],options);
 assert.equal(budget.measure(p),actual.requestBytes);assert.equal(owner.size,9,'revision-aware measurement is still pure');
});
test('core references and strict auxiliary references remain exact failures',()=>{
 const {parseAssistant}=require('../src/assistant-model.cjs');
 const owner=new SourceHandleOwner({scope,taskId:'strict-aux'}),payload={purpose:'discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:'private:current'},userRequest:{sourceId:'private:current',text:'先私下商量。'},sources:[{id:'private:current',revision:'r1',type:'private',role:'user',text:'先私下商量。'}]};
 const frame=owner.preview(payload);frame.commit();const id=frame.wirePayload.intentAuthority.sourceId;
 const response={kind:'discussion',text:'先私下商量。',requestDelivery:{mode:'private_help',sourceId:id,quote:'先私下商量。'},statePatch:{items:[{text:'不要提交',sourceIds:[id,'s999']}]}};
 const before=structuredClone(response);assert.throws(()=>parseAssistant(response,'discussion',{payload,sourceWireSnapshot:frame}),/Unknown or not-offered/);
 const best={...payload,taskContext:{auxiliaryPolicy:'best_effort'}},wrong={...response,requestDelivery:{...response.requestDelivery,sourceId:'s999'}};
 assert.throws(()=>parseAssistant(wrong,'discussion',{payload:best,sourceWireSnapshot:frame}),/Unknown or not-offered/);assert.deepEqual(response,before);
});
