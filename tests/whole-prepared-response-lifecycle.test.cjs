'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional raw Controller/Store/transport checks. Generated explanation targets
// and message leaves stay distinct; no semantic quality or actual send claim.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {TaskLedger}=require('../src/request-budget.cjs'),{postModel}=require('../src/model-http.cjs');
const {projectVisibleTurn,implementationIdentity}=require('../scripts/eval-qq-adapter.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const FACT='今天查找功能已经可以按标题找回自己的摘记。',MESSAGE='这个小网页现在能按标题找到我自己的摘记了。';
const PRIMARY='PRIMARY_PLANNING_ONLY：把今天全部改成昨天。',WHY='FINAL_WHOLE_RESPONSE_WHY：完成日期与现在可用分别保留来源所说的意思。';
const body=source=>source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function prepare(p){const source=p.sources.find(source=>source.type==='note'&&body(source)===FACT);return {operation:'prepare_message',materials:[{materialRef:whole(source),authorityRef:source.authorityChoices.program[0].authorityRef}],...(p.editingReferences?.length?{editingReference:{choice:p.editingReferences[0].choice}}:{}),answer:{privateExplanation:WHY,suggestions:[{text:MESSAGE}]}};}
function response(value,name){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'whole-response-life',type:'function',function:{name,arguments:JSON.stringify(value)}}]}}]}),{status:200});}
async function application(t,producer,{previous=false}={}){
 const store=new Store(':memory:'),calls=[],contexts=[],note=store.saveNote(scope,{text:FACT,use:'draft'}),model='synthetic-whole-response-life',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:6,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(settings,context,signal)=>{contexts.push(context);return assistModel(settings,context,signal,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper,entry={request,wrapper,p,taskId:settings.requestBudget.task.id};calls.push(entry);return response(await producer(p,wrapper,calls.length-1,entry),request.tool_choice.function.name);});}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000000351',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'你那个小网页今天可以查找了吗？'}}]})]});
 const prior=previous?store.appendTurn(scope,{role:'assistant',kind:'draft',origin:'user',requestId:'whole-previous',text:MESSAGE,suggestions:[{style:'自然',text:MESSAGE}],sourceIds:['note:'+note.id]}):null;
 return {store,controller,calls,contexts,note,prior,run:()=>store.getCompanion(scope).runs.at(-1),assist:(text='按这条已选事实准备表达，并解释保留的理由。',taskId='whole-response-life')=>controller.assist({text,taskId,materialIds:[note.id],...(prior?{sourceTurnIds:[prior.id]}:{})})};
}
const allow=p=>({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]});
const complete=p=>p.purpose==='fidelity_check'?allow(p):prepare(p);

test('the final private-explanation artifact and its outward message candidate have separate bodies, kinds and scope/version fences',async t=>{
 const app=await application(t,complete),reply=await app.assist(),parent=app.store.experiences.artifact(scope,reply.artifactRef),leaf=app.store.experiences.artifact(scope,reply.suggestions[0].artifactRef);
 assert.equal(parent.kind,'response');assert.equal(parent.body,WHY);assert.equal(parent.body.includes(MESSAGE),false);assert.equal(reply.text,'');assert.equal(parent.body.includes(PRIMARY),false);assert.equal(leaf.kind,'message_candidate');assert.equal(leaf.body,MESSAGE);assert.equal(leaf.body.includes(WHY),false);assert.deepEqual(leaf.parentRef,parent.ref);
 const selection={turnId:reply.id,suggestionIndex:0,artifactRef:leaf.ref};assert.equal(app.store.experiences.resolveMessageCandidate(scope,selection).text,MESSAGE);
 assert.throws(()=>app.store.experiences.resolveMessageCandidate(scope,{...selection,artifactRef:parent.ref}),/reference|artifact/i,'a generated explanation/whole-help target is not an outgoing leaf');
 assert.throws(()=>app.store.experiences.resolveMessageCandidate({...scope,peerUid:'foreign-contact'},selection),/reference|artifact/i);assert.throws(()=>app.store.experiences.resolveMessageCandidate(scope,{...selection,artifactRef:{...leaf.ref,version:leaf.ref.version+1}}),/reference|artifact/i);
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);assert.equal(app.store.experiences.draft(scope),null);
});

for(const targetKind of ['private-explanation','message'])test(`actual feedback targets the final ${targetKind} artifact without turning generated explanation into factual material`,async t=>{
 let feedback=false;const app=await application(t,p=>p.purpose==='fidelity_check'?allow(p):feedback?{operation:'advise',text:'这是针对实际选中产物的私下解释，不重新出稿。'}:complete(p)),reply=await app.assist();feedback=true;
 const reference=targetKind==='private-explanation'?reply.artifactRef:reply.suggestions[0].artifactRef,feedbackText=targetKind==='private-explanation'?'请再解释这个帮助中的日期理由，先不要改写消息。':'请解释给对方这句表达的口吻，先不要改写消息。';
 const result=await app.controller.continueFeedback({taskId:'whole-feedback-'+targetKind,clientEventId:'whole-feedback-event-'+targetKind,requestId:reply.requestId,targetRef:{kind:'artifact',artifactRef:reference},text:feedbackText});
 assert.equal(result.feedbackContinuation.status,'complete');assert.equal(app.calls.length,2);const targets=app.calls[1].p.feedbackTargets,target=targets.find(item=>item.target?.artifactRef?.artifactId===reference.artifactId).target;
 assert.equal(target.authority,'generated_evaluation_target_not_factual_evidence');assert.equal(target.kind,targetKind==='private-explanation'?'response':'message_candidate');assert.equal(target.body,targetKind==='private-explanation'?WHY:MESSAGE);assert.equal(target.body.includes(PRIMARY),false);
 const input=app.contexts.at(-1).payload,current=input.sources.find(source=>source.id===input.intentAuthority.sourceId);assert.equal(current.type,'feedback');assert.equal(current.text,feedbackText);assert.equal(input.sources.some(source=>source.id==='private:'+reply.id),false);
 assert.equal(app.calls[1].p.operationProtocol.requiredArtifact,undefined);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);assert.equal(app.store.experiences.draft(scope),null);
});

test('withdrawing the final parent response invalidates both its feedback target and message leaf',async t=>{
 const app=await application(t,complete),reply=await app.assist(),leaf=reply.suggestions[0].artifactRef;
 const saved=app.store.addFeedback(scope,{requestId:reply.requestId,targetRef:{kind:'artifact',artifactRef:reply.artifactRef},text:'解释还需要核对。',clientEventId:'whole-withdrawn-feedback', expectedDigest: app.store.experiences.artifact(scope, reply.artifactRef).bodyDigest});
 assert.equal(app.store.experiences.hydrateFeedback(scope,saved.id).target.body,WHY);app.store.deleteTurn(scope,reply.id);
 assert.equal(app.store.experiences.hydrateFeedback(scope,saved.id)?.target==null,true);assert.throws(()=>app.store.experiences.resolveMessageCandidate(scope,{turnId:reply.id,suggestionIndex:0,artifactRef:leaf}),/reference|artifact/i);
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.id===reply.id),false);
});

for(const mutation of ['cancel','contact','source-version','forget','editing-leaf-withdrawal'])test(`late whole prepared response cannot publish either part after ${mutation}`,async t=>{
 let release,enter;const entered=new Promise(resolve=>{enter=resolve;}),taskId='whole-late-'+mutation;
 const app=await application(t,p=>new Promise(resolve=>{release=()=>resolve(prepare(p));enter();}),{previous:mutation==='editing-leaf-withdrawal'});
 const pending=app.assist('核对当前事实与实际旧句，并说明完整帮助。',taskId);pending.catch(()=>{});t.after(()=>release?.());await Promise.race([entered,pending.then(()=>{throw Error('The request ended before the controlled final response');})]);
 if(mutation==='cancel')app.controller.invalidateAssistant();
 if(mutation==='contact'){app.controller.scope={...scope,peerUid:'another-contact',peerUin:'77889900'};app.controller.changedContext();}
 if(mutation==='source-version')app.store.saveNote(scope,{id:app.note.id,text:FACT+' 这是新的修订。',use:'draft'});
 if(mutation==='forget')app.store.forgetSource(scope,'note:'+app.note.id);
 if(mutation==='editing-leaf-withdrawal')app.store.experiences.invalidateArtifacts(scope,[app.prior.suggestions[0].artifactRef]);
 release();await pending.catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&turn.requestId===taskId),false);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);assert.equal(app.store.experiences.draft(scope),null);
});

test('incoming QQ during primary whole-response repair cannot reset the existing message promise or one-repair ledger',async t=>{
 let releaseRepair,enter;const entered=new Promise(resolve=>{enter=resolve;}),taskId='whole-response-repair-resume',hash=implementationIdentity().hash;
 const app=await application(t,(p,wrapper,index)=>{
  if(index===0){const value=prepare(p);value.answer.privateExplanation={malformed:'why'};return value;}
  if(index===1){assert.ok(wrapper.originalInput);return new Promise(resolve=>{releaseRepair=()=>resolve(prepare(p));enter();});}
  return {operation:'advise',text:'Only private advice after the interruption.'};
 });
 const first=app.assist('给完整帮助和消息，并说明理由。',taskId);first.catch(()=>{});t.after(()=>releaseRepair?.());await Promise.race([entered,first.then(()=>{throw Error('The request ended before the controlled final repair');})]);
 assert.equal(app.controller.usage.get(scope,taskId).attempts,2);app.controller.live({scope,messages:[raw('91000000000000352',false,{elements:[{textElement:{content:'她补充了一个新的细节。'}}]})]});
 const retry=app.controller.pendingAssist;assert.ok(retry);assert.equal(retry.args.requestDeliveryObligation.mode,'editable_message');clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;
 const resumed=app.controller.assist({...retry.args,taskId:retry.taskId,resumeTurnId:retry.turnId,resumes:retry.resumes+1}),outcome=resumed.then(value=>({value}),error=>({error}));releaseRepair();await first;const result=await outcome,ledger=app.controller.usage.get(scope,taskId);
 assert.equal(result.error?.code,'request_delivery_repair_exhausted');assert.equal(result.value,undefined);assert.equal(app.calls[2].p.operationProtocol.requiredArtifact,'message');assert.equal(ledger.attempts,3);assert.equal(ledger.requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.equal(ledger.status,'failed');
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&turn.requestId===taskId),false);t.diagnostic(JSON.stringify({sourceHash:hash,attempts:ledger.attempts,repairCount:1,status:ledger.status,errorCode:result.error.code}));
});

test('an already spent task repair cannot be silently replaced by a standalone final format-repair slot',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const ledger=new TaskLedger(store),task=ledger.create(scope,{id:'whole-prior-repair',inputDigest:'fictional-whole-response',limit:4});
 await postModel('http://fixture.invalid/v1',{body:'fictional-prior-structured-repair'},async()=>({ok:true,status:200}),async()=>{},task.forStage('delivery_repair'));
 const context={payload:{purpose:'draft',outboundQuotes:[{sourceId:'note:known',text:FACT}],sources:[]},manifest:{scope,requestId:task.id}},settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-whole-budget',modelResponseMode:'result_tool',requestBudget:task.forStage('draft')};let calls=0;
 await assert.rejects(assistModel(settings,context,undefined,async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:'PRIVATE_PROSE_WITHOUT_COMPLETE_TYPED_RESPONSE'}}]}),{status:200});}),error=>error.code==='request_delivery_repair_exhausted');
 assert.equal(calls,1);assert.equal(ledger.get(scope,task.id).attempts,2);assert.deepEqual(ledger.get(scope,task.id).requests.map(request=>request.purpose),['delivery_repair','draft']);assert.notEqual(context.manifest.preparedResponse?.message,'provided');
});
