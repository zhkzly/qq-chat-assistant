'use strict';
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');const {Controller}=require('./fixtures/assistant-protocol.cjs');const {scope,raw}=require('./fixtures/native.cjs');
function setup(t,model){const store=new Store(':memory:');const controller=new Controller({store,assistantModel:model,read:async command=>command==='bind'?scope:{messages:[]},settings:{auto:false,apiKey:'synthetic',model:'synthetic',baseUrl:'http://fixture.invalid',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic',baseUrl:'http://fixture.invalid'}}});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});t.after(()=>{controller.close();store.close()});return {store,controller};}
const intent=p=>p.intentAuthority.sourceId;
const start=p=>({operation:'create',objective:'自然了解她的游戏兴趣',direction:'先顺着游戏体验聊',constraints:['暂不直接邀约'],interpretationStatus:'user_stated',purposeSourceIds:[intent(p)],intentQuote:p.sources.find(s=>s.id===intent(p)).text});
function guide(active){return {objective:{text:'自然了解对方的游戏体验',sourceIds:active.purposeSourceIds},allowedApproach:{text:active.direction,sourceIds:active.purposeSourceIds},avoidances:active.constraints.map(text=>({text,sourceIds:active.purposeSourceIds}))};}
test('actual controller preserves a corrected local purpose into vague-followup drafting and atomic topic receipt',async t=>{
 let round=0,lastDraft;const app=setup(t,async(_settings,input)=>{const p=input.payload;
  if(p.purpose==='draft'){lastDraft=p;assert.equal(p.draftingGuidance.avoidances[0].text,'先不直接问游戏名字');return {kind:'draft',text:'沿当前方向组织表达',suggestions:[{style:'自然',text:'换成益智闯关，画风都变了哈哈。'}]};}
  round++;if(round===1)return {kind:'discussion',text:'可以先顺着游戏体验聊。',topicPatch:start(p)};
  if(round===2)return {kind:'discussion',text:'这次先不直接问名字。',topicPatch:{operation:'update',topicId:p.topicContext.active.id,direction:'先聊体验，再看她是否自然展开',constraints:['先不直接问游戏名字'],purposeSourceIds:[intent(p)],intentQuote:p.userRequest.text}};
  assert.equal(p.topicContext.active.constraints[0],'先不直接问游戏名字');return {draftPlan:withCurrentDraftControls({quotes:[],intent:'reply',guidance:guide(p.topicContext.active),style:'natural',askFollowup:false},p)};
 });await app.controller.bind(scope.peerUin);app.controller.live({scope,messages:[raw(undefined,false,{elements:[{textElement:{content:'我现在改玩益智闯关了'}}]})]});
 await app.controller.assist({text:'想自然了解她玩的游戏，暂时不直接约她。',taskId:'topic-start'});
 const initial=app.store.topicView(scope).active;assert.ok(initial);
 await app.controller.assist({text:'先不直接问游戏名字，顺着体验聊。',taskId:'topic-correct'});
 const corrected=app.store.topicView(scope).active;assert.equal(corrected.id,initial.id);assert.ok(corrected.version>initial.version);
 const answer=await app.controller.assist({text:'给出一句话吧',taskId:'topic-draft'});assert.equal(answer.kind,'draft');assert.equal(app.store.topicView(scope).active.id,initial.id);
 assert.equal(lastDraft.privateConversation,undefined);assert.equal(lastDraft.topicContext,undefined);assert.equal(lastDraft.goal,undefined);assert.ok(answer.artifactRef);
 const firstRun=app.store.getCompanion(scope).runs.find(r=>r.id==='topic-start');assert.equal(firstRun.topicReceipt.applied,true);
});
test('feedback continuation uses one canonical feedback and survives idempotent retries without duplicated calls',async t=>{
 let calls=0,last;const app=setup(t,async(_settings,input)=>{calls++;last=input.payload;if(calls===1)return {kind:'discussion',text:'可以先围绕游戏体验聊。',topicPatch:start(last)};
  const feedback=last.sources.find(s=>s.id===intent(last));assert.equal(feedback.type,'feedback');assert.ok(last.feedbackTargets[0].target.body);
  return {kind:'discussion',text:'按这条局部反馈调整方向。',topicPatch:{operation:'update',topicId:last.topicContext.active.id,direction:'先给一句具体且不直接邀约的表达',purposeSourceIds:[feedback.id],intentQuote:feedback.text}};
 });await app.controller.bind(scope.peerUin);const first=await app.controller.assist({text:'想自然了解她玩的游戏，暂时不直接约她。',taskId:'first-answer'});
 const args={text:'这次给一句具体的话，但先不直接邀约。',requestId:first.requestId,targetRef:{kind:'artifact',artifactRef:first.artifactRef},clientEventId:'one-feedback',taskId:'one-continuation'};
 const a=await app.controller.continueFeedback(args),b=await app.controller.continueFeedback(args);assert.equal(a.feedbackContinuation.status,'complete');assert.equal(b.feedbackContinuation.status,'complete');assert.equal(calls,2);
 const canonical=app.store.experiences.listFeedback(scope);assert.equal(canonical.length,1);
 assert.equal(app.store.memorySources(scope).filter(s=>s.text===args.text).length,1);
 assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.kind==='feedback_continue').length,1);
 assert.ok(app.store.topicView(scope).active.purposeSourceIds.includes(canonical[0].sourceId));
});
test('concurrent continuation duplicates share the same request and retain a failed saved feedback for explicit retry',async t=>{
 let rejectPending,calls=0;const app=setup(t,async()=>{calls++;if(calls===1)return {kind:'discussion',text:'原参考'};if(calls===2)return new Promise((_resolve,reject)=>{rejectPending=reject});return {kind:'discussion',text:'按反馈继续'};});await app.controller.bind(scope.peerUin);
 const first=await app.controller.assist({text:'帮我想一个方向'});const args={text:'请先回应具体内容',requestId:first.requestId,targetRef:{kind:'artifact',artifactRef:first.artifactRef},clientEventId:'saved-once',taskId:'failed-once'};
 const a=app.controller.continueFeedback(args);while(!rejectPending)await new Promise(resolve=>setImmediate(resolve));const b=app.controller.continueFeedback(args);
 rejectPending(new Error('synthetic provider unavailable'));const results=await Promise.all([a,b]);assert.equal(calls,2);assert.ok(results.every(x=>x.feedbackContinuation.status==='failed'));assert.equal(app.store.experiences.listFeedback(scope).length,1);
 const same=await app.controller.continueFeedback(args);assert.equal(same.feedbackContinuation.status,'failed');assert.equal(calls,2);
 const retry=await app.controller.continueFeedback({...args,taskId:'explicit-new-attempt'});assert.equal(retry.feedbackContinuation.status,'complete');assert.equal(calls,3);assert.equal(app.store.experiences.listFeedback(scope).length,1);
});
test('ordinary help survives a rejected topic update with bound pending intent and no false review receipt',async t=>{
 const text='可以先讨论你想了解的游戏体验，不急着直接邀约。';
 const app=setup(t,async(_s,input)=>({kind:'discussion',text,topicPatch:start(input.payload),stateReview:'no_change'}));await app.controller.bind(scope.peerUin);
 t.mock.method(app.store,'applyTopicPatch',()=>({applied:false,reason:'synthetic_rejected'}));
 const answer=await app.controller.assist({text:'想自然了解她的游戏兴趣',taskId:'rejected-topic'}),companion=app.store.getCompanion(scope),user=companion.turns.find(x=>x.role==='user');
 assert.equal(answer.text,text);assert.equal(answer.kind,'discussion');assert.equal(app.store.topicView(scope).active,null);assert.equal(app.store.topicView(scope).version,0);
 assert.equal(companion.turns.filter(x=>x.role==='assistant').length,1);assert.equal(companion.turns.filter(x=>x.role==='user').length,1);
 assert.equal(user.text,'想自然了解她的游戏兴趣');assert.equal(answer.privateReviewReceipt,undefined);assert.equal(answer.responseRecovery,undefined);
 const source=app.store.memorySources(scope).find(s=>s.id===`private:${user.id}`);
 assert.deepEqual(answer.metadataReviewPending,{reasonCode:'auxiliary_metadata_rejected',sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}});
 assert.deepEqual(companion.turns.find(x=>x.id===answer.id).metadataReviewPending,answer.metadataReviewPending);
 const run=companion.runs.find(r=>r.id==='rejected-topic');assert.equal(run.status,'complete');assert.equal(run.topicReceipt.applied,false);assert.equal(run.maintenance,'partial_rejected');assert.equal(run.privateReviewReceipt,undefined);
 assert.ok(run.auxiliaryErrors.some(e=>e.field==='topicPatch'&&e.message==='synthetic_rejected'));assert.equal(run.requests.length,1);
});
test('source-bound draft planning still rolls back final output when Store rejects topic authority',async t=>{
 const phases=[],question='你最近最喜欢哪种游戏？';
 const app=setup(t,async(_s,input)=>{const p=input.payload;phases.push(p.purpose);
  if(p.purpose==='draft_prepare'){const topicPatch=start(p);return {kind:'discussion',text:'按你明确想问的意思组织表达。',topicPatch,
    draftPlan:{quotes:[{sourceId:intent(p),text:question}],guidance:guide(topicPatch),style:'natural'}};}
  assert.equal(p.purpose,'draft');assert.deepEqual(p.outboundQuotes,[{sourceId:p.draftingGuidance.objective.sourceIds[0],text:question}]);
  assert.equal(p.userRequest,undefined);assert.equal(p.goal,undefined);
  return {kind:'draft',text:'一条完整参考表达',suggestions:[{style:'自然',text:question}]};
 });await app.controller.bind(scope.peerUin);t.mock.method(app.store,'applyTopicPatch',()=>({applied:false,reason:'synthetic_rejected_planning_authority'}));
 const request=`想含蓄了解她的游戏兴趣，先不直接邀约。请帮我问：${question}`;
 await assert.rejects(app.controller.assist({text:request,purpose:'draft',taskId:'strict-planning-rejection'}),error=>error.code==='topic_patch_rejected'&&/synthetic_rejected_planning_authority/.test(error.message));
 assert.deepEqual(phases,['draft_prepare','draft'],'a valid source-bound plan must actually reach restricted composition before the Store rejection');
 const companion=app.store.getCompanion(scope);assert.equal(app.store.topicView(scope).active,null);assert.equal(companion.turns.filter(x=>x.role==='assistant').length,0);
 assert.equal(companion.turns.filter(x=>x.role==='user').length,1);assert.equal(companion.turns.find(x=>x.role==='user').text,request);
 assert.equal(app.store.experiences._all(scope,'artifact').length,0);assert.equal(companion.runs.find(r=>r.id==='strict-planning-rejection').status,'failed');
});
