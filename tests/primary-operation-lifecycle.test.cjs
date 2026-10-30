'use strict';
// Fictional raw model result-tool transport plus real Controller/Store. These
// are routing/state/effect checks, not semantic operation-choice grading.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {projectVisibleTurn,implementationIdentity}=require('../scripts/eval-qq-adapter.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const FACT='这个小网页可以按标题找回我自己的摘记；';
const MESSAGE='我做了个给自己记摘记的小网页，现在可以按标题查回自己的记录。';
const body=source=>source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function messagePlan(p){
 const note=p.sources.find(source=>source.type==='note'&&body(source)===FACT);assert.ok(note,'a genuine draft-usable note is offered');
 const current=p.intentAuthority.sourceId,control=text=>({text,sourceIds:[current]});
 return {intent:'reply',quotes:[{materialRef:whole(note),authorityRef:note.authorityChoices.program[0].authorityRef}],guidance:{objective:control('按这次实际意思介绍已知功能'),allowedApproach:control('只使用独立准入素材'),avoidances:[]}};
}
function preparedMessage(p){return {operation:'prepare_message',text:'按本次范围准备完整表达。',draftPlan:messagePlan(p)};}
function toolResponse(value,name){const args=typeof value==='string'?value:JSON.stringify(value);return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'fictional-operation-life',type:'function',function:{name,arguments:args}}]}}]}),{status:200});}
async function until(check,label){for(let n=0;n<120;n++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(label);}
async function modelStage(pending,check,label){let failure;pending.catch(error=>{failure=error;});await until(()=>check()||failure,label);if(failure)throw failure;}
async function application(t,producer,{limit=8}={}){
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-operation-lifecycle',baseUrl='http://fixture.invalid/v1';
 const settings={anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestBytes:64000,assistantRequestLimit:limit,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}};
 const controller=new Controller({store,settings,compactionModel:null,read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(configured,context,signal)=>{contexts.push(context);return assistModel(configured,context,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),content=request.messages[1].content,wrapper=JSON.parse(typeof content==='string'?content:content.find(item=>item.type==='text').text),p=wrapper.originalInput||wrapper;
   const entry={request,wrapper,p,taskId:configured.requestBudget.task.id,signal};calls.push(entry);const value=await producer(p,wrapper,calls.length-1,entry);
   return toolResponse(value,p.purpose==='draft'?'draft_result':'assistant_result');
  });}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('91000000000000321',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'你说的那个网页主要能做什么？'}}]})]});
 const note=store.saveNote(scope,{text:FACT,use:'draft',kind:'material'});
 return {store,controller,calls,contexts,note,settings,run:()=>store.getCompanion(scope).runs.at(-1),assist:(text,taskId='operation-lifecycle',extra={})=>controller.assist({text,taskId,materialIds:[note.id],...extra})};
}
function noSendOrAdoption(app,beforeDraft){assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);assert.deepEqual(app.store.experiences.draft(scope),beforeDraft);}

test('raw advise offers a genuine private why body in one existing call without entering the composer',async t=>{
 const explanation='因为她问的是功能，不能据此认定她已经使用过；这里先解释这个区别。',app=await application(t,()=>({operation:'advise',text:explanation})),before=app.store.experiences.draft(scope);
 const reply=await app.assist('先不写给她，为什么那个问题会预设她已经用过？','operation-private-why');
 assert.equal(reply.kind,'discussion');assert.equal(reply.text,explanation);assert.equal(reply.suggestions,undefined);assert.equal(app.calls.length,1);assert.equal(app.calls[0].p.operationProtocol.requiredArtifact,undefined);
 assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);assert.equal(app.run().status,'complete');noSendOrAdoption(app,before);
});

test('raw prepare_message with genuine references reaches a complete candidate without implying adoption or sending',async t=>{
 const app=await application(t,p=>p.purpose==='draft'?{kind:'draft',text:MESSAGE}:preparedMessage(p)),before=app.store.experiences.draft(scope);
 const reply=await app.assist('这次愿意把已选笔记的事实告诉她，给我完整表达。','operation-complete-message');
 assert.equal(reply.kind,'draft');assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(app.calls.length,2);assert.equal(app.run().manifest.requestDelivery.status,'delivered');
 const wording=app.calls[1].p;assert.equal(wording.outboundQuotes[0].text,FACT);assert.equal(wording.currentHumanControl.authority,'CONTROL_ONLY');assert.equal(wording.currentHumanControl.text.includes('给我完整表达'),true);assert.equal(wording.selectedDirectionControl,undefined);
 assert.equal(app.calls[0].request.tool_choice.function.name,'assistant_result');assert.equal(app.calls[1].request.tool_choice.function.name,'draft_result');
 assert.equal(app.calls.every(call=>Buffer.byteLength(JSON.stringify(call.request))<=64000),true);noSendOrAdoption(app,before);
});

test('automatic primary prepare_message uses the same existing composer without forging original human control',async t=>{
 const app=await application(t,p=>p.purpose==='draft'?{kind:'draft',text:MESSAGE}:preparedMessage(p)),before=app.store.experiences.draft(scope);
 const reply=await app.controller.assist({text:'结合实际来信提供参考。',purpose:'reply',transient:true,origin:'automatic',materialIds:[app.note.id],taskId:'operation-automatic-message'});
 assert.equal(reply.kind,'draft');assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(reply.origin,'automatic');assert.equal(app.calls.length,2);
 assert.equal(app.calls[0].p.operationProtocol.requiredArtifact,undefined,'transport purpose and an automatic observation alone do not establish a promise');
 assert.equal(app.calls[1].p.currentHumanControl,undefined,'a generated invocation is not an original private human statement');assert.equal(app.calls[1].p.outboundQuotes[0].text,FACT);assert.equal(app.run().manifest.requestDelivery.status,'delivered');noSendOrAdoption(app,before);
});

test('automatic advise stays private wait with no forced composer or original-human wrapper grant',async t=>{
 const text='先观察她真正想说的细节，这里只提供私下考虑。',app=await application(t,()=>({operation:'advise',text})),before=app.store.experiences.draft(scope);
 const reply=await app.controller.assist({text:'结合实际来信提供参考。',purpose:'reply',transient:true,origin:'automatic',materialIds:[app.note.id],taskId:'operation-automatic-advice'});
 assert.equal(reply.kind,'discussion');assert.equal(reply.text,text);assert.equal(reply.replyDisposition,'wait');assert.equal(reply.suggestions,undefined);assert.equal(app.calls.length,1);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);
 assert.equal(app.run().manifest.primaryOperation.requiredArtifact,undefined);assert.equal(app.calls[0].p.operationProtocol.requiredArtifact,undefined);
 const context=app.contexts[0],current=context.payload.sources.find(source=>source.id===context.payload.intentAuthority.sourceId);assert.equal(current.type,'request');assert.equal(current.authority,'invocation_control_not_user_evidence');
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='user'),false);noSendOrAdoption(app,before);
});

test('lookup for a message carries its program promise through reading and one repair instead of silently ending as advice',async t=>{
 const app=await application(t,(p,wrapper,index)=>{
  if(p.purpose==='draft')return {kind:'draft',text:MESSAGE};
  if(index===0)return {operation:'lookup',lookup:{sourceIds:[p.sources.find(source=>source.type==='note').id]},continuation:'prepare_message'};
  assert.equal(p.operationProtocol.requiredArtifact,'message');
  if(index===1)return {operation:'advise',text:'Only private strategy, not a complete message.'};
  assert.ok(wrapper.originalInput);return preparedMessage(p);
 });
 const reply=await app.assist('结合已选材料给我完整表达。','operation-read-repair');assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(app.calls.length,4);
 const usage=app.controller.usage.get(scope,'operation-read-repair');assert.equal(usage.attempts,4);assert.equal(usage.requests.filter(item=>item.purpose==='delivery_repair').length,1);assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1);
 assert.equal(app.run().manifest.requestDelivery.status,'delivered');assert.equal(app.calls[2].request.tools[0].function.parameters.properties.requestDelivery,undefined);
});

test('a new private why turn does not inherit an earlier request message promise',async t=>{
 let why=false;const app=await application(t,p=>p.purpose==='draft'?{kind:'draft',text:MESSAGE}:why?{operation:'advise',text:'这里解释刚才那种问法的前提。'}:preparedMessage(p));
 await app.assist('给我完整表达。','operation-prior-message');why=true;const reply=await app.assist('现在只商量为什么，不重新写消息。','operation-new-private-why');
 assert.equal(reply.kind,'discussion');assert.equal(reply.suggestions,undefined);assert.equal(app.calls.length,3);assert.equal(app.calls.at(-1).p.operationProtocol.requiredArtifact,undefined);assert.notEqual(app.calls[0].taskId,app.calls.at(-1).taskId);
});

for(const variant of ['mixed','unknown','bad-reference'])test(`raw ${variant} core rejects atomically before valid independent state or forget actions`,async t=>{
 const secret='FICTIONAL_UNCOMMITTED_OPERATION_SECRET';let target;
 const app=await application(t,p=>{
  const source=p.sources.find(item=>item.type==='note'&&body(item).includes(secret)),actions=[{type:'forget',sourceId:source.id,targetQuote:secret,evidenceQuote:'忘记'+secret}],statePatch={items:[{text:'UNCOMMITTED_OPERATION_STATE',sourceIds:[p.intentAuthority.sourceId]}]};
  if(variant==='mixed')return {operation:'advise',text:'Private.',draftPlan:messagePlan(p),actions,statePatch};
  if(variant==='unknown')return {operation:'not_an_operation',text:'Private.',actions,statePatch};
  const value=preparedMessage(p);value.draftPlan.quotes[0].materialRef='m999999';return {...value,actions,statePatch};
 });
 target=app.store.saveNote(scope,{text:secret,use:'discussion'});const before=app.store.getCompanion(scope).state.version;
 await assert.rejects(app.assist('忘记'+secret+'；然后按这次真正的范围帮助我。','operation-atomic-'+variant));
 assert.equal(app.calls.length,2,'only the existing one repair may be spent');assert.equal(app.store.getCompanion(scope).state.version,before);assert.equal(app.store.memorySources(scope).some(source=>source.id==='note:'+target.id),true);
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.run().status,'failed');assert.equal((app.run().actionReceipts||[]).some(receipt=>receipt.status==='applied'),false);
});

test('a genuinely applied forget before lookup remains truthful when a later operation fails',async t=>{
 const secret='FICTIONAL_APPLIED_OPERATION_FORGET';let target;
 const app=await application(t,(p,_wrapper,index)=>{
  if(index===0){const source=p.sources.find(item=>item.type==='note'&&body(item).includes(secret));return {operation:'lookup',lookup:{query:'仍可使用的已选笔记'},continuation:'prepare_message',actions:[{type:'forget',sourceId:source.id,targetQuote:secret,evidenceQuote:'忘记'+secret}]};}
  assert.equal(p.operationProtocol.requiredArtifact,'message');return {operation:'not_an_operation',text:'Subsequent failure.'};
 });
 target=app.store.saveNote(scope,{text:secret,use:'discussion'});await assert.rejects(app.assist('忘记'+secret+'，然后继续准备已选事实的表达。','operation-applied-receipt'));
 assert.equal(app.store.memorySources(scope).some(source=>source.id==='note:'+target.id),false);assert.equal(app.run().status,'failed');
 assert.ok(app.run().actionReceipts.some(receipt=>receipt.type==='forget'&&receipt.status==='applied'),'a real earlier effect must not be erased from failed-run evidence');
 assert.equal(app.calls.slice(1).some(call=>JSON.stringify(call).includes(secret)),false);assert.equal(JSON.stringify(app.run()).includes(secret),false);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});

test('a private clarify owns one canonical why/question body without declaring a message promise',async t=>{
 const question='你现在愿意讨论哪一件具体的小事？',why='需要先确认讨论对象。',app=await application(t,()=>({operation:'clarify',blocker:{kind:'missing_fact',missing:'具体的小事',question,explanation:why}}));
 const append=app.store.appendTurn.bind(app.store);let observed=false,commitObligation;
 app.store.appendTurn=(identity,turn)=>{if(turn.role==='assistant'){observed=true;commitObligation=app.controller.activeAssist?.args?.requestDeliveryObligation;}return append(identity,turn);};
 const reply=await app.assist('先私下理清，不要替我写给她。','operation-private-clarify');assert.equal(reply.text,why+'\n\n'+question);assert.equal(reply.kind,'question');assert.equal(reply.suggestions,undefined);assert.equal(reply.discussionExplanation,undefined);assert.equal(app.calls.length,1);
 assert.equal(app.run().manifest.primaryOperation.requiredArtifact,undefined);assert.equal(app.run().manifest.requestDelivery.interpretation.mode,'private_help');assert.equal(observed,true);assert.equal(commitObligation,undefined,'canonical parser/controller normalization must not manufacture a message obligation for private clarification');
 assert.equal(app.run().manifest.requestDelivery.status,'blocked');assert.equal(projectVisibleTurn(reply).text,reply.text);
});

test('private clarify can apply an authorized local save then freshly clarify without inventing a message promise or external progress',async t=>{
 const noteText='我周六下午有空',question='这次想先商量哪件具体的事？',why='需要确认当前讨论对象。';
 const app=await application(t,(_p,_wrapper,index)=>({operation:'clarify',blocker:{kind:'missing_fact',missing:'当前具体讨论对象',question,explanation:why},
  ...(index===0?{actions:[{type:'save_note',text:noteText,use:'discussion',evidenceQuote:'记住'+noteText}]}:{})}));
 const reply=await app.assist('记住'+noteText+'。先私下核对，不要替我写给她。','operation-private-clarify-save');
 assert.equal(app.calls.length,2,'the existing post-action fresh pass is preserved');assert.equal(reply.text,why+'\n\n'+question);assert.equal(reply.kind,'question');assert.equal(reply.suggestions,undefined);
 assert.ok(reply.actionReceipts.some(receipt=>receipt.type==='save_note'&&receipt.status==='applied'));const saved=app.store.memorySources(scope).find(source=>source.type==='note'&&source.text===noteText);assert.ok(saved);assert.equal(saved.use,'discussion');
 assert.ok(app.run().actionReceipts.some(receipt=>receipt.type==='save_note'&&receipt.status==='applied'&&receipt.sourceId===saved.id));
 assert.equal(app.calls.every(call=>call.p.operationProtocol.requiredArtifact===undefined),true);assert.equal(app.run().manifest.primaryOperation.requiredArtifact,undefined);assert.equal(app.run().manifest.requestDelivery.interpretation.mode,'private_help');
 assert.equal(app.store.relationshipView(scope).events.length,0);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);assert.equal(projectVisibleTurn(reply).text,reply.text);
});

test('clarify after a message lookup remains a truthful blocked result instead of advice or a fabricated candidate',async t=>{
 const question='这次具体愿意分享哪一部分？',app=await application(t,(p,_wrapper,index)=>index===0?{operation:'lookup',lookup:{query:'当前完整意思'},continuation:'prepare_message'}:
  {operation:'clarify',blocker:{kind:'missing_authorization',missing:'仍需确认的分享范围',question}});
 const append=app.store.appendTurn.bind(app.store);let commitObligation;
 app.store.appendTurn=(identity,turn)=>{if(turn.role==='assistant')commitObligation=app.controller.activeAssist?.args?.requestDeliveryObligation;return append(identity,turn);};
 const reply=await app.assist('先核对，再给表达。','operation-message-clarify');assert.equal(reply.kind,'question');assert.equal(reply.text,question);assert.equal(reply.suggestions,undefined);assert.equal(app.calls.length,2);
 assert.equal(app.calls[1].p.operationProtocol.requiredArtifact,'message');assert.equal(app.run().manifest.primaryOperation.requiredArtifact,'message');assert.equal(app.run().manifest.requestDelivery.status,'blocked');
 assert.equal(app.run().manifest.requestDelivery.interpretation.mode,'editable_message');assert.equal(commitObligation.mode,'editable_message');assert.ok(commitObligation.sourceId);assert.ok(commitObligation.sourceRevision);
});

for(const repropose of [false,true])test(`a valid pre-read relationship proposal ${repropose?'requires an explicit terminal reproposal to commit':'does not commit when the terminal result does not repropose it'}`,async t=>{
 const statement='我周六下午有空',claim=p=>({text:statement,sourceIds:[p.intentAuthority.sourceId],subject:'self',aspect:'recent_context',assertionKind:'reported',epistemicStatus:'supported'});
 const app=await application(t,(p,_wrapper,index)=>index===0?{operation:'lookup',lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]},continuation:'advise',relationshipPatch:{claims:[claim(p)]}}:
  {operation:'advise',text:'补读后只保留这次重新核对的判断。',...(repropose?{relationshipPatch:{claims:[claim(p)]}}:{})});
 const reply=await app.assist(statement+'。先补读当前资料，再回顾已有事实。','operation-pre-read-proposal-'+repropose,{purpose:'review'});
 assert.equal(reply.kind,'discussion');assert.equal(app.calls.length,2);const first=app.run().requests.find(request=>request.manifest?.deferredProposals);
 assert.ok(first,'pre-read proposal deferral remains in the recorded product audit');assert.equal(first.manifest.deferredProposals.reason,'lookup_requires_terminal_reproposal');assert.ok(first.manifest.deferredProposals.fields.includes('relationshipPatch'));
 const claims=app.store.relationshipView(scope).claims.filter(item=>item.text===statement);assert.equal(claims.length,repropose?1:0);
 if(repropose){assert.equal(app.run().relationshipReceipt.applied,true);const id=app.contexts.at(-1).payload.intentAuthority.sourceId;assert.deepEqual(claims[0].sourceIds,[id]);}
 else assert.equal(app.run().relationshipReceipt?.applied===true,false);
 assert.equal(app.calls.every(call=>call.p.operationProtocol.requiredArtifact===undefined),true);
});

test('same-task QQ resume retains the captured source/revision message promise through reading and repair',async t=>{
 let releasePending;const app=await application(t,(p,wrapper,index)=>{
  if(p.purpose==='draft')return {kind:'draft',text:MESSAGE};
  if(index===0)return {operation:'lookup',lookup:{sourceIds:[p.sources.find(source=>source.type==='note').id]},continuation:'prepare_message'};
  if(index===1)return new Promise(resolve=>{releasePending=()=>resolve(preparedMessage(p));});
  assert.equal(p.operationProtocol.requiredArtifact,'message');if(index===2)return {operation:'advise',text:'Only private strategy.'};assert.ok(wrapper.originalInput);return preparedMessage(p);
 });
 const first=app.assist('按这次意思给完整表达。','operation-same-resume');t.after(()=>releasePending?.());await modelStage(first,()=>!!releasePending,'original request reached its pending post-read model response');
 app.controller.live({scope,messages:[raw('91000000000000322',false,{elements:[{textElement:{content:'她又补充了一个具体问题。'}}]})]});
 const pending=app.controller.pendingAssist;assert.ok(pending);assert.equal(pending.args.requestDeliveryObligation.mode,'editable_message');assert.ok(pending.args.requestDeliveryObligation.sourceId.startsWith('private:'));assert.ok(pending.args.requestDeliveryObligation.sourceRevision);
 clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;
 const resumed=app.controller.assist({...pending.args,taskId:pending.taskId,resumeTurnId:pending.turnId,resumes:pending.resumes+1});releasePending();await first;const reply=await resumed;
 assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1);assert.equal(app.calls.length,5);assert.equal(app.controller.usage.get(scope,pending.taskId).attempts,5);assert.equal(app.run().manifest.requestDelivery.status,'delivered');
});

test('an interrupted repair of invalid prepare_message retains its early bound promise and already spent repair slot on QQ resume',async t=>{
 let releaseRepair,enterRepair;const enteredRepair=new Promise(resolve=>{enterRepair=resolve;}),taskId='operation-invalid-prepare-resume',sourceHash=implementationIdentity().hash;
 const app=await application(t,(p,wrapper,index)=>{
  if(index===0)return {operation:'prepare_message',draftPlan:'invalid plan, recognized message operation'};
  if(index===1){assert.ok(wrapper.originalInput);assert.equal(p.operationProtocol.requiredArtifact,'message');return new Promise(resolve=>{releaseRepair=()=>resolve(preparedMessage(p));enterRepair();});}
  return {operation:'advise',text:'Only private advice after the interruption.'};
 });
 const first=app.assist('按本次已选事实给完整表达。',taskId);first.catch(()=>{});t.after(()=>releaseRepair?.());
 await Promise.race([enteredRepair,first.then(()=>{throw new Error('The original request ended before entering its pending repair');})]);
 const input=app.contexts[0],currentId=input.payload.intentAuthority.sourceId,currentRevision=input.manifest.sourceRevisions[currentId],before=app.controller.usage.get(scope,taskId);
 assert.equal(input.payload.requestDeliveryPolicy.obligation.mode,'editable_message','the early promise really exists in the in-flight client input before interruption');
 assert.equal(before.attempts,2);assert.equal(before.requests.filter(item=>item.purpose==='delivery_repair').length,1);
 app.controller.live({scope,messages:[raw('91000000000000323',false,{elements:[{textElement:{content:'她又补充一个需要接住的问题。'}}]})]});
 const pending=app.controller.pendingAssist;assert.ok(pending);const captured=pending.args.requestDeliveryObligation;
 clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;
 const resumed=app.controller.assist({...pending.args,taskId:pending.taskId,resumeTurnId:pending.turnId,resumes:pending.resumes+1});
 const outcome=resumed.then(value=>({value}),error=>({error}));releaseRepair();await first;const result=await outcome,ledger=app.controller.usage.get(scope,taskId);
 t.diagnostic(JSON.stringify({sourceHash,currentId,currentRevision,pendingObligation:captured||null,resumedRequiredArtifact:app.calls[2]?.p.operationProtocol.requiredArtifact||null,resultKind:result.value?.kind||null,errorCode:result.error?.code||null,ledgerStatus:ledger.status,attempts:ledger.attempts,repairCount:ledger.requests.filter(item=>item.purpose==='delivery_repair').length}));
 assert.deepEqual(captured,{mode:'editable_message',sourceId:currentId,sourceRevision:currentRevision},'QQ resume must carry the early program-bound promise, not just completed primary results');
 assert.deepEqual(pending.scope,scope);assert.equal(pending.taskId,taskId);assert.equal(app.calls[2].p.operationProtocol.requiredArtifact,'message');
 assert.equal(result.error?.code,'request_delivery_repair_exhausted');assert.equal(result.value,undefined);assert.equal(ledger.status,'failed');assert.equal(ledger.attempts,3);assert.equal(app.calls.length,3);assert.equal(ledger.requests.filter(item=>item.purpose==='delivery_repair').length,1);assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1);
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&turn.requestId===taskId),false);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

for(const mutation of ['cancel','withdraw','source-version','contact'])test(`pending operation wording cannot publish after ${mutation}`,async t=>{
 let release;const app=await application(t,p=>p.purpose==='draft'?new Promise(resolve=>{release=()=>resolve({kind:'draft',text:'OBSOLETE_OPERATION_CANDIDATE'});}):preparedMessage(p));
 const pending=app.assist('给完整表达。','operation-late-'+mutation);t.after(()=>release?.());await modelStage(pending,()=>!!release,'the restricted existing composer is pending');
 if(mutation==='cancel')app.controller.invalidateAssistant();
 if(mutation==='withdraw')app.store.saveNote(scope,{id:app.note.id,text:FACT,use:'disabled'});
 if(mutation==='source-version')app.store.saveNote(scope,{id:app.note.id,text:FACT+' 新的修订。',use:'draft'});
 if(mutation==='contact'){app.controller.scope={...scope,peerUid:'another-contact',peerUin:'99887766'};app.controller.changedContext();}
 release();await pending;assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&JSON.stringify(turn).includes('OBSOLETE_OPERATION_CANDIDATE')),false);
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
