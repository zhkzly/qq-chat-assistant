'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const {wireSourceView,canonicalSourceView}=require('./fixtures/source-wire.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs');
const {Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check,label){for(let i=0;i<120;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail(label);}
function plan(p){return withCurrentDraftControls({quotes:[],intent:'reply'},p);}
async function fixture(t,producer,{inputMessageObligation=false}={}){
 const store=new Store(':memory:'),calls=[],invocations=[];let inputBinding;
 const settings={anonymous:true,auto:false,model:'synthetic-lifecycle',baseUrl:'http://fixture.invalid/v1',assistantRequestLimit:8,discussionCompactionEnabled:false,
  realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic-lifecycle',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(configured,context,signal)=>{
   // Explicit fixture input authority remains source/revision-bound.
   if(inputMessageObligation&&context.payload.requestDeliveryPolicy){
    const sourceId=context.payload.intentAuthority.sourceId,revision=context.manifest.sourceRevisions[sourceId];
    inputBinding||={taskId:context.manifest.requestId,sourceId,revision};
    if(context.manifest.requestId===inputBinding.taskId&&sourceId===inputBinding.sourceId&&revision===inputBinding.revision)context.payload.requestDeliveryPolicy.obligation={mode:'editable_message'};
   }
   invocations.push(context);
   return assistModel(configured,context,signal,async(_url,args)=>{
    const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;
    const entry={request,wrapper,p,taskId:configured.requestBudget.task.id};calls.push(entry);
    const value=await producer(p,wrapper,entry,calls.length-1),manifest=(wrapper.originalInput?context.extraRequests?.at(-1)?.manifest:undefined)||context.manifest;
    const receipt=manifest.sourceHandles,canonicalPayload=canonicalSourceView(p,receipt,wrapper.originalInput?context.extraRequests.at(-1).payload.originalInput:context.payload);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(wireSourceView(value,receipt,manifest.primaryReferences,canonicalPayload))}}]}),{status:200});
   });
  }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('91000000000000001',false,{elements:[{textElement:{content:'我的书架终于装好了。'}}]})]});
 t.after(()=>{controller.close();store.close();});
 return {controller,store,calls,invocations,run:()=>store.getCompanion(scope).runs.at(-1)};
}
test('literal forget removes secret-bearing delivery state from the next pass and persistent request diagnostics',async t=>{
 const secret='FICTIONAL_FORGET_DELIVERY_SENTINEL_20261030';let targetId,requestText,afterForgetArgs;
 const app=await fixture(t,(p,wrapper,entry,index)=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  if(index===0)return {operation:'prepare_message',
   actions:[{type:'forget',sourceId:targetId,targetQuote:secret,evidenceQuote:`忘记${secret}`}],answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}};
  afterForgetArgs=structuredClone(app.controller.activeAssist?.args);
  return p.purpose==='draft'?{kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:'书架装好这一下挺有成就感吧。'}]}:
   {operation:'prepare_message',answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}};
 });
 targetId=`note:${app.store.saveNote(scope,{text:secret,use:'discussion'}).id}`;
 requestText=`忘记${secret}这条笔记，然后给我一句不涉及它的可改发表达。`;
 const reply=await app.controller.assist({text:requestText,taskId:'forget-delivery-lifecycle'});
 assert.ok(reply.actionReceipts.some(receipt=>receipt.type==='forget'&&receipt.status==='applied'),'the literal source action must actually apply before taint checks');
 assert.equal(app.store.memorySources(scope).some(source=>source.id===targetId||source.text.includes(secret)),false,'removed source and excluded authorizing turn must not be factual sources');
 assert.ok(app.calls.length>=2);assert.equal(app.calls.slice(1).some(call=>JSON.stringify(call).includes(secret)),false,'no second-pass request field may retain the forgotten sentinel, including obligation quotes');
 assert.equal(JSON.stringify(afterForgetArgs).includes(secret),false,'QQ resume arguments must use the sanitized current request after forget');
 assert.equal(JSON.stringify(app.invocations.slice(1).map(context=>context.manifest)).includes(secret),false,'post-forget model manifests must not carry the forgotten quote');
 const run=app.run();assert.equal(run.status,'complete');assert.equal(JSON.stringify(run).includes(secret),false,'persisted request payloads and manifests must be sanitized');
});
test('QQ-triggered same-task resume preserves the editable obligation and original shared budget',async t=>{
 let finishPending,pendingArgs;
 const app=await fixture(t,(p,wrapper,entry,index)=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  if(p.purpose==='draft')return {kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:'装好之后打算先放哪些书呀？'}]};
  if(wrapper.originalInput)return {operation:'prepare_message',answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}};
  if(index===0)return {operation:'lookup',continuation:'prepare_message',text:'先核对已提供的原话。',lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]}};
  if(index===1)return new Promise(resolve=>{finishPending=()=>resolve({operation:'prepare_message',answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}});});
  return {operation:'advise',text:'只提供策略，不提供完整表达。'};
 },{inputMessageObligation:true});
 const pending=app.controller.assist({text:'帮我给她一条完整能改着发的表达。',taskId:'resume-delivery-lifecycle'});
 await until(()=>!!finishPending,'the initial editable lookup must reach its second pending call');
 app.controller.live({scope,messages:[raw('91000000000000002',false,{elements:[{textElement:{content:'刚装好就想把那套旧书放进去了。'}}]})]});
 pendingArgs=structuredClone(app.controller.pendingAssist?.args);finishPending();await pending;
 await until(()=>!app.controller.pendingAssist&&!app.controller.assistantBusy&&app.run()?.status==='complete','the actual QQ-triggered resume must finish');
 const resumed=app.calls.find((call,index)=>index>=2&&!call.wrapper.originalInput&&call.p.purpose!=='draft');
 assert.equal(resumed.p.operationProtocol.requiredArtifact,'message','same task cannot drop its declared delivery obligation after QQ arrival');
 assert.equal(pendingArgs.requestDeliveryObligation?.mode,'editable_message','the resume owner must carry the request-local obligation');
 assert.equal(app.calls.length,4,'the resumed private-help downgrade must consume one repair before the restricted composer');
 assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1,'resume and repair must retain the original task');
 const usage=app.controller.usage.get(scope,'resume-delivery-lifecycle');
 assert.equal(usage.limit,8);assert.equal(usage.attempts,4);assert.equal(usage.requests.filter(request=>request.purpose==='delivery_repair').length,1);
 assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='user').length,1,'resume must not duplicate the private request');
 assert.equal(app.run().manifest.requestDelivery.status,'delivered');assert.equal(app.store.getCompanion(scope).turns.at(-1).suggestions.length,1);
 await tick();
});
test('same-task resume reinterprets an authority revision changed away and back instead of trusting restored text',async t=>{
 let finishPending;
 const text='帮我给她一条完整能改着发的表达。';
 const app=await fixture(t,(p,wrapper,entry,index)=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  if(index===0)return {operation:'lookup',continuation:'prepare_message',text:'先取回原话。',lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]}};
  if(index===1)return new Promise(resolve=>{finishPending=()=>resolve({operation:'prepare_message',answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}});});
  return {operation:'advise',text:'依据本次重新提供的原话讨论。'};
 },{inputMessageObligation:true});
 const original=app.controller.assist({text,taskId:'changed-authority-delivery-lifecycle'});
 await until(()=>!!finishPending,'the original editable request must reach its pending continuation');
 const user=app.store.getCompanion(scope).turns.find(turn=>turn.role==='user');
 const sourceId=`private:${user.id}`,originalRevision=app.store.memorySources(scope).find(source=>source.id===sourceId).revision;
 app.store.updateTurn(scope,user.id,'这个来源已被用户修改。');app.store.updateTurn(scope,user.id,text);
 const revised=app.store.memorySources(scope).find(source=>source.id===sourceId);
 assert.equal(revised.text,text);assert.notEqual(revised.revision,originalRevision,'restoring the text must not restore the old source version');
 app.controller.live({scope,messages:[raw('91000000000000003',false,{elements:[{textElement:{content:'书已经开始放了。'}}]})]});
 const retry=app.controller.pendingAssist;assert.ok(retry);assert.equal(retry.args.requestDeliveryObligation?.sourceRevision,originalRevision,'the resume must actually carry the old revision before revalidation');clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;
 finishPending();await original;
 app.controller.pendingAssist=null;
 await app.controller.assist({...retry.args,taskId:retry.taskId,resumeTurnId:retry.turnId,resumes:retry.resumes+1});
 const resumed=app.calls.find((call,index)=>index>=2&&call.p.purpose!=='fidelity_check');
 assert.equal(resumed.taskId,'changed-authority-delivery-lifecycle');assert.equal(resumed.p.operationProtocol.requiredArtifact,undefined,'a changed authority revision must trigger fresh interpretation, even when its text is restored');
 assert.equal(app.calls.length,3);assert.equal(app.controller.usage.get(scope,retry.taskId).attempts,3);assert.equal(app.run().manifest.requestDelivery.interpretation.mode,'private_help');
});
test('QQ resume after applied forget restores only the sanitized request and nontext delivery binding',async t=>{
 const secret='FICTIONAL_FORGET_THEN_RESUME_SENTINEL_20261030';let targetId,finishPostForget,resumeArgs;
 const app=await fixture(t,(p,wrapper,entry,index)=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  if(p.purpose==='draft')return {kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:'装好了就能慢慢把喜欢的书放进去啦。'}]};
  if(index===0)return {operation:'prepare_message',
   actions:[{type:'forget',sourceId:targetId,targetQuote:secret,evidenceQuote:`忘记${secret}`}],answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}};
  if(index===1)return new Promise(resolve=>{finishPostForget=()=>resolve({operation:'prepare_message',answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}});});
  if(wrapper.originalInput)return {operation:'prepare_message',answer:{suggestions:[{text:'装好之后打算先放哪些书呀？'}]}};
  return {operation:'advise',text:'这里只给策略。'};
 },{inputMessageObligation:true});
 targetId=`note:${app.store.saveNote(scope,{text:secret,use:'discussion'}).id}`;
 const original=app.controller.assist({text:`忘记${secret}这条笔记，然后给我一句不涉及它的可改发表达。`,taskId:'forget-then-resume-delivery-lifecycle'});
 await until(()=>!!finishPostForget,'the applied forget must reach its next sanitized pending call');
 assert.equal(app.store.memorySources(scope).some(source=>source.id===targetId),false,'the literal source removal must actually apply before resume');
 app.controller.live({scope,messages:[raw('91000000000000004',false,{elements:[{textElement:{content:'我先把最喜欢的几本摆上去了。'}}]})]});
 resumeArgs=structuredClone(app.controller.pendingAssist?.args);finishPostForget();await original;
 await until(()=>!app.controller.pendingAssist&&!app.controller.assistantBusy&&app.run()?.status==='complete','the sanitized post-forget QQ resume must finish');
 assert.equal(JSON.stringify(resumeArgs).includes(secret),false,'resume arguments must not restore the excluded authorizing text');
 assert.equal(resumeArgs.requestDeliveryObligation?.mode,'editable_message');
 assert.deepEqual(Object.keys(resumeArgs.requestDeliveryObligation).sort(),['mode','sourceId','sourceRevision']);
 assert.ok(resumeArgs.requestDeliveryObligation.sourceId.startsWith('request:'),'the excluded user turn must be represented only by its sanitized invocation source');
 assert.equal(app.calls.length,4,'the resumed downgrade must still repair and compose under the same obligation');
 for(const call of app.calls.slice(1)){
  assert.equal(JSON.stringify(call).includes(secret),false,'no post-forget transport field may restore forgotten content');
  if(!['draft','fidelity_check'].includes(call.p.purpose))assert.equal(call.p.operationProtocol.requiredArtifact,'message','the wire receives only the message artifact requirement');
 }
 const resumed=app.calls[2];assert.equal(resumed.p.userRequest.text,resumeArgs.text);assert.equal(canonicalSourceView(resumed.p,app.run().requests.find(request=>request.payload?.userRequest?.text===resumeArgs.text)?.manifest?.sourceHandles||app.invocations[2].manifest.sourceHandles).userRequest.sourceId,resumeArgs.requestDeliveryObligation.sourceId);
 assert.equal(app.calls.every(call=>call.taskId==='forget-then-resume-delivery-lifecycle'),true);
 assert.equal(app.controller.usage.get(scope,'forget-then-resume-delivery-lifecycle').attempts,4);
 assert.equal(app.run().manifest.requestDelivery.status,'delivered');assert.equal(JSON.stringify(app.run()).includes(secret),false);
 assert.equal(JSON.stringify(app.invocations.slice(1).map(context=>context.manifest)).includes(secret),false);
});
