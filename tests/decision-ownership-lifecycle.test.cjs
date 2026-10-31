'use strict';
// Real Controller/Store and raw fictional result-tool transport. Checker
// verdicts below test admission/repair lifecycle, never semantic classifier quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {visibleCandidate}=require('../src/whole-answer-fidelity.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const HUMAN='这次只接她分享的盆栽近况，先不要邀请，也别假装我有过养植物的经历。';
const GOOD='这两片新叶看着挺精神。';
const PRIVATE_QUESTION='你最近有哪件愿意告诉她的真实小事？';
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function candidate(p,text=GOOD){
 return {operation:'prepare_message',answer:{privateExplanation:'接住她刚说的具体变化。',suggestions:[{style:'自然',text}]}};
}
const allow=p=>({checkRef:p.checkRef,verdict:'allow',issues:[]});
function toolResponse(value,name){return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{tool_calls:[{id:'fictional-decision-owner',type:'function',function:{name,arguments:JSON.stringify(value)}}]}}]}),{status:200});}
async function application(t,producer,{limit=4}={}){
 t.mock.method(globalThis,'fetch',async()=>{throw Error('This fictional test permits no external model call');});
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-decision-ownership',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestBytes:64000,assistantRequestLimit:limit,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(settings,context,signal)=>{contexts.push(context);return assistModel(settings,context,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),content=request.messages[1].content,wrapper=JSON.parse(typeof content==='string'?content:content.find(item=>item.type==='text').text),p=wrapper.originalInput||wrapper;
   const entry={request,wrapper,p,taskId:settings.requestBudget.task.id};calls.push(entry);return toolResponse(await producer(p,wrapper,calls.length-1,entry),request.tool_choice.function.name);
  });}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('91000000000000731',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'今天窗边的花盆冒了两片新叶。'}}]})]});
 return {store,controller,calls,contexts,assist:(text=HUMAN,taskId='decision-ownership-lifecycle')=>controller.assist({text,taskId}),run:()=>store.getCompanion(scope).runs.at(-1)};
}
function unchangedCore(app,before){
 const after=app.store.getCompanion(scope);assert.equal(after.goal.version,before.goal.version);assert.equal(after.state.version,before.state.version);assert.equal(after.topics.version,before.topics.version);
 assert.equal(after.turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);assert.equal(app.store.experiences.draft(scope),null);
}
function currentTopic(p){return {operation:'create',objective:'回应当前盆栽话题',direction:'先聊实际近况',purposeSourceIds:[p.intentAuthority.sourceId],intentQuote:p.userRequest.text};}

test('invalid optional prepared metadata keeps the complete checked candidate and pending human intent without writes or false review',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?allow(p):{...candidate(p),topicPatch:{operation:'update',authority:'MODEL_CANNOT_ASSIGN_AUTHORITY'},stateReview:'no_change'}),before=app.store.getCompanion(scope),reply=await app.assist(),after=app.store.getCompanion(scope),check=app.calls.at(-1).p;
 assert.equal(app.calls.length,2);assert.equal(check.purpose,'fidelity_check');assert.deepEqual(visibleCandidate(reply),check.candidate);assert.equal(reply.suggestions[0].text,GOOD);
 assert.equal(after.goal.version,before.goal.version);assert.equal(after.state.version,before.state.version);assert.equal(after.topics.version,before.topics.version);
 assert.equal(reply.privateReviewReceipt,undefined);assert.equal(reply.metadataReviewPending.reasonCode,'auxiliary_metadata_rejected');
 const id=reply.metadataReviewPending.sourceIds[0],source=app.store.memorySources(scope).find(item=>item.id===id);assert.equal(source.text,HUMAN);assert.equal(reply.metadataReviewPending.sourceRevisions[id],source.revision);
 const run=app.run();assert.equal(run.status,'complete');assert.equal(run.maintenance,'partial_rejected');assert.ok(run.auxiliaryErrors.some(error=>error.field==='topicPatch'));assert.equal(run.privateReviewReceipt,undefined);assert.equal(run.topicReceipt,null);assert.equal(run.patchReceipt,null);assert.equal(app.controller.usage.get(scope,'decision-ownership-lifecycle').requests.some(request=>request.purpose==='delivery_repair'),false);
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('a plausible private pragmatic concern preserves the exact candidate without consuming a repair or showing its warning',async t=>{
 const marker='PRIVATE_UNCERTAIN_SOCIAL_READING',app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,verdict:'reject',issues:[],concerns:[{path:'suggestions[0].text',code:'pragmatic_ambiguity',quote:p.candidate.suggestions[0].text,reason:marker}]}:candidate(p)),reply=await app.assist();
 assert.equal(app.calls.length,2);assert.deepEqual(visibleCandidate(reply),app.calls[1].p.candidate);assert.equal(JSON.stringify(reply).includes(marker),false);assert.equal(JSON.stringify(app.run().requests).includes(marker),true,'private checker diagnostics retain the concern');
 assert.equal(app.controller.usage.get(scope,'decision-ownership-lifecycle').requests.filter(request=>request.purpose==='delivery_repair').length,0);
});

for(const defect of ['invented_self_event'])test(`a grounded ${defect} rejects once, regenerates the whole candidate and rechecks within one shared repair`,async t=>{
 const bad=defect==='invented_self_event'?'我昨天也给自己养的花盆换了土。':'下次我们一起去给花盆换土吧。';let checks=0;
 const app=await application(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check'){
   checks++;if(checks>1)return allow(p);
   const current=p.evidence.find(source=>source.sourceId===p.intentAuthority.sourceId),issue={path:'suggestions[0].text',code:defect==='invented_self_event'?'unsupported_fact':'current_boundary',quote:bad,reason:'Scripted concrete defect exercises the repair boundary only.',...(defect==='invented_self_event'?{basis:'no_support_in_supplied_evidence'}:{evidence:[{sourceId:current.sourceId,quote:current.text}]})};
   assert.equal(p.candidate.suggestions[0].text,bad);return {checkRef:p.checkRef,verdict:'reject',issues:[issue]};
  }
  return candidate(p,wrapper.originalInput?GOOD:bad);
 });
 const reply=await app.assist();assert.equal(app.calls.length,4);assert.equal(checks,2);assert.equal(reply.suggestions[0].text,GOOD);assert.deepEqual(visibleCandidate(reply),app.calls[3].p.candidate);assert.equal(JSON.stringify(reply).includes(bad),false);
 const ledger=app.controller.usage.get(scope,'decision-ownership-lifecycle');assert.equal(ledger.requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1);assert.equal(app.calls.every(call=>call.request.model==='synthetic-decision-ownership'),true);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('a sourced current social-boundary concern retains the exact answer without a repair',async t=>{
 const text='下次我们一起去给花盆换土吧。',app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return candidate(p,text);
  const current=p.evidence.find(source=>source.sourceId===p.intentAuthority.sourceId);
  return {checkRef:p.checkRef,verdict:'reject',issues:[{path:'suggestions[0].text',code:'current_boundary',quote:text,evidence:[{sourceId:current.sourceId,quote:current.text}],reason:'Scripted social interpretation remains privately advisory.'}]};
 }),reply=await app.assist();
 assert.equal(app.calls.length,2);assert.equal(reply.suggestions[0].text,text);assert.equal(app.run().requests.filter(request=>request.purpose==='delivery_repair').length,0);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('a later sourced explicit invitation replaces the prior local action under its fresh human-control frame',async t=>{
 let invitation=false;const outward='这周末要不要一起看看附近的花市？',app=await application(t,p=>p.purpose==='fidelity_check'?allow(p):candidate(p,invitation?outward:GOOD));
 await app.assist(HUMAN,'decision-before-invite');invitation=true;const current='现在我改变主意，想邀请她这周末一起看看附近的花市，但不假装她已经答应。',reply=await app.assist(current,'decision-current-invite'),check=app.calls.at(-1).p;
 assert.equal(reply.suggestions[0].text,outward);assert.equal(app.calls.length,4);assert.ok(check.evidence.some(source=>source.text===HUMAN));assert.equal(check.evidence.find(source=>source.sourceId===check.currentHumanControl.sourceId).text,current);assert.equal(check.currentHumanControl.sourceId,check.intentAuthority.sourceId);assert.notEqual(app.calls[1].taskId,app.calls[3].taskId,'each human intent has its own source-handle namespace');
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);assert.equal(app.store.experiences.draft(scope),null);
});

test('missing self material still permits a checked private question without fabricating or mechanically blocking the known QQ topic',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?allow(p):{operation:'clarify',blocker:{kind:'missing_fact',missing:'用户愿意分享的真实近况',question:PRIVATE_QUESTION,explanation:'可以先接她的花盆新叶；补充自己的日常还需要一件真实小事。'}}),reply=await app.assist('也想分享一点自己的近况，但你还不知道我最近做过什么。');
 assert.equal(app.calls.length,2);assert.equal(reply.kind,'question');assert.ok(reply.text.includes(PRIVATE_QUESTION));assert.equal(reply.suggestions,undefined);assert.equal(app.calls[1].p.candidate.text,reply.text);assert.equal(app.calls[1].p.evidence.some(source=>source.type==='qq'),true);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

for(const verdict of ['malformed','unknown'])test(`${verdict} checker output fails closed without fallback, another model or an extra repair`,async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?{...allow(p),...(verdict==='malformed'?{unchecked:true}:{verdict:'looks_good'})}:candidate(p)),before=app.store.getCompanion(scope);
 await assert.rejects(app.assist(),error=>error.code==='fidelity_result_invalid');assert.equal(app.calls.length,2);unchangedCore(app,before);assert.equal(app.run().status,'failed');assert.equal(app.controller.usage.get(scope,'decision-ownership-lifecycle').requests.some(request=>request.purpose==='delivery_repair'),false);
});

test('a real late Store topic CAS rejection remains fatal and rolls back candidate, state and goal writes',async t=>{
 const taskId='decision-late-topic-cas',app=await application(t,p=>p.purpose==='fidelity_check'?allow(p):{...candidate(p),topicPatch:currentTopic(p),statePatch:{focus:'MUST_NOT_COMMIT_AFTER_CAS'}}),before=app.store.getCompanion(scope),apply=app.store.applyTopicPatch.bind(app.store),receipts=[];let injected=false;
 t.mock.method(app.store,'applyTopicPatch',(identity,patch,options)=>{
  if(options.requestId===taskId&&!injected){injected=true;const competing=apply(identity,{...patch,objective:'Concurrent task transition'},options);assert.equal(competing.applied,true);receipts.push(competing);}
  const receipt=apply(identity,patch,options);receipts.push(receipt);return receipt;
 });
 await assert.rejects(app.assist(HUMAN,taskId),error=>error.code==='topic_patch_rejected'&&/stale_topic_version/.test(error.message));
 assert.equal(receipts.length,2);assert.equal(receipts[1].reason,'stale_topic_version','the real Store, rather than a fabricated rejection reason, performs the CAS check');assert.equal(app.calls.length,2);unchangedCore(app,before);assert.equal(app.run().status,'failed');
});

test('a changed current human source while checking invalid optional bookkeeping cannot publish a stale core',async t=>{
 let entered,release;const waiting=new Promise(resolve=>{entered=resolve;}),app=await application(t,p=>p.purpose==='fidelity_check'?new Promise(resolve=>{release=()=>resolve(allow(p));entered();}):{...candidate(p),topicPatch:{operation:'update',authority:'MODEL_CANNOT_ASSIGN_AUTHORITY'}}),pending=app.assist();
 pending.catch(()=>{});t.after(()=>release?.());await Promise.race([waiting,pending.then(()=>{throw Error('Expected to reach the pending read-only check');})]);
 const turn=app.store.getCompanion(scope).turns.find(item=>item.role==='user');app.store.updateTurn(scope,turn.id,'现在按我更正后的当前意思重新商量。');const afterCorrection=app.store.getCompanion(scope);release();const reply=await pending;
 assert.equal(reply,undefined);assert.equal(app.calls.length,2);unchangedCore(app,afterCorrection);
});

test('an exhausted structural repair preserves the original nested typed core failure and commits no candidate or goal',async t=>{
 const app=await application(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check')assert.fail('A malformed core cannot reach checking');
  if(!wrapper.originalInput&&app.calls.length===1)return {operation:'prepare_message',draftPlan:'malformed core plan',answer:{suggestions:[{text:GOOD}]}};
  if(wrapper.originalInput){const qq=p.sources.find(source=>source.type==='qq');return {operation:'lookup',lookup:{sourceIds:[qq.id],offset:0,maxChars:1000},continuation:'prepare_message'};}
  const raw=candidate(p);raw.materials=[{materialRef:whole(p.sources.find(source=>source.type==='note')),authorityRef:'a999999'}];raw.topicPatch=currentTopic(p);raw.statePatch={focus:'CORE_FAILURE_STATE_MUST_NOT_COMMIT'};return raw;
 }),before=app.store.getCompanion(scope),note=app.store.saveNote(scope,{text:'BOUND_SOURCE_FACT',use:'draft'});
 await assert.rejects(app.controller.assist({text:HUMAN,taskId:'decision-ownership-lifecycle',materialIds:[note.id]}),error=>{
  assert.equal(error.code,'request_delivery_repair_exhausted');assert.equal(error.originalFailure.code,'unknown_authority_reference');assert.equal(error.originalFailure.field,'materials[0].authorityRef');assert.ok(error.originalFailure.issues.some(issue=>issue.path==='materials[0].authorityRef'&&issue.code==='unknown_authority_reference'));assert.ok(error.originalFailure.message);return true;
 });
 assert.equal(app.calls.length,3);unchangedCore(app,before);assert.equal(app.controller.usage.get(scope,'decision-ownership-lifecycle').requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.equal(app.run().status,'failed');
});
