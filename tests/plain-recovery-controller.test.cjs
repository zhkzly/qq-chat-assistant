'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {Controller}=require('../src/controller.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const privateRecovery=id=>({kind:'private_help',reasonCode:'structured_output_invalid',metadataApplied:false,intentSourceIds:id?[id]:[]});
const draftRecovery=()=>({kind:'restricted_draft',reasonCode:'structured_output_invalid',metadataApplied:false,intentSourceIds:[]});
function setup(t,assistantModel){
  const store=new Store(':memory:'),settings={model:'synthetic',baseUrl:'http://synthetic.invalid/v1',anonymous:true,auto:false};
  settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl};
  const controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},assistantModel});
  controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});t.after(()=>{controller.close();store.close()});
  return {store,controller};
}

test('private help recovery is a marked generated discussion, never a completed state review or new mutation',async t=>{
  const app=setup(t,async(_s,input)=>{
    const id=input.payload.intentAuthority.sourceId;input.manifest.responseRecovery=privateRecovery(id);
    return {kind:'discussion',text:'先回应她刚说的具体内容，保持自然。',stateReview:'no_change',
      actions:[{type:'save_note',evidenceQuote:input.payload.userRequest.text,text:'我今天做了饭'}],
      topicPatch:{operation:'create',objective:'Only an uncommitted metadata proposal',purposeSourceIds:[id],intentQuote:input.payload.userRequest.text},relationshipPatch:{claims:[],events:[],retire:[]}};
  });await app.controller.bind(scope.peerUin);const before=app.store.getCompanion(scope);
  const answer=await app.controller.assist({text:'记住近况：我今天做了饭。',taskId:'private-recovery'});
  assert.equal(answer.text,'先回应她刚说的具体内容，保持自然。');assert.equal(answer.kind,'discussion');assert.equal(answer.responseRecovery.kind,'private_help');
  assert.equal(answer.responseRecovery.metadataApplied,false);assert.equal(answer.suggestions,undefined);assert.deepEqual(answer.expressionOptions,[]);
  const after=app.store.getCompanion(scope);assert.equal(after.state.version,before.state.version);assert.equal(after.state.possiblyStale,true);assert.equal(after.notes.length,0);assert.equal(after.topics.items.length,0);
  const run=after.runs.find(run=>run.id==='private-recovery');assert.equal(run.status,'complete');assert.equal(run.maintenance,'deferred');assert.equal(run.patchReceipt,null);assert.equal(run.privateReviewReceipt,undefined);assert.equal(answer.privateReviewReceipt,undefined);
  assert.equal(app.store.memorySources(scope).some(source=>source.text===answer.text),false);
});

test('a model-authored recovery flag cannot impersonate the trusted program manifest',async t=>{
  const app=setup(t,async()=>({kind:'discussion',text:'An ordinary structured response.',responseRecovery:privateRecovery(),stateReview:'no_change'}));
  await app.controller.bind(scope.peerUin);const answer=await app.controller.assist({text:'Help me understand the next step.',taskId:'forged-output-marker'});
  assert.equal(answer.responseRecovery,undefined);assert.ok(answer.privateReviewReceipt.applied);assert.ok(answer.privateReviewReceipt.sourceIds.length);
});

test('private recovery drops previously queued proposals while preserving actual rejected action receipts',async t=>{
  let calls=0;const app=setup(t,async(_s,input)=>{
    const id=input.payload.intentAuthority.sourceId;
    if(++calls===1)return {kind:'discussion',text:'A structured first response.',actions:[{type:'save_note',evidenceQuote:'not in the user request',text:'not in the user request'}],
      topicPatch:{operation:'create',objective:'Discuss a direct invitation',purposeSourceIds:[id],intentQuote:input.payload.userRequest.text},relationshipPatch:{claims:[],events:[],retire:[]}};
    input.manifest.responseRecovery=privateRecovery(id);return {kind:'discussion',text:'Continue the private help without applying background changes.'};
  });await app.controller.bind(scope.peerUin);let relationships=0;const apply=app.store.applyRelationshipPatch.bind(app.store);app.store.applyRelationshipPatch=(...args)=>{relationships++;return apply(...args)};
  const answer=await app.controller.assist({text:'I want to discuss a direct invitation.',taskId:'queued-proposal-recovery'});
  assert.equal(calls,2);assert.equal(app.store.topicView(scope).active,null);assert.equal(relationships,0);assert.equal(answer.actionReceipts[0].status,'rejected');
});

test('already applied preferences and their receipts survive a later private-help recovery',async t=>{
  let calls=0;const text='Remember my preference: from now on keep expressions direct.';
  const app=setup(t,async(_s,input)=>{
    if(++calls===1)return {kind:'discussion',text:'Apply the explicit preference.',actions:[{type:'set_preference',evidenceQuote:text,text:'keep expressions direct'}]};
    input.manifest.responseRecovery=privateRecovery(input.payload.intentAuthority.sourceId);return {kind:'discussion',text:'Here is private help under your preference.'};
  });await app.controller.bind(scope.peerUin);const answer=await app.controller.assist({text,taskId:'applied-pref-recovery'});
  const note=app.store.getCompanion(scope).notes.find(note=>note.kind==='preference');assert.equal(note.text,'keep expressions direct');assert.equal(answer.actionReceipts[0].status,'applied');
  assert.equal(answer.responseRecovery.kind,'private_help');assert.equal(answer.privateReviewReceipt,undefined);
});

test('restricted-draft recovery preserves verified preparation metadata and receives only the safe projected draft',async t=>{
  const app=setup(t,async(_s,input)=>{
    const p=input.payload;
    if(p.purpose==='draft'){
      assert.equal(p.userRequest,undefined);assert.equal(p.privateConversation,undefined);assert.equal(p.topicContext,undefined);
      input.manifest.responseRecovery=draftRecovery();return {kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:'周末要不要一起散步？'}]};
    }
    const id=p.intentAuthority.sourceId;return {draftPlan:{quotes:[{sourceId:id,text:'一起散步'}],guidance:{objective:{text:'邀请一起散步',sourceIds:[id]},allowedApproach:{text:'直接自然地邀请',sourceIds:[id]}}},
      topicPatch:{operation:'create',objective:'邀请她一起散步',direction:'直接自然地邀请',purposeSourceIds:[id],intentQuote:p.userRequest.text},stateReview:'no_change'};
  });await app.controller.bind(scope.peerUin);app.controller.live({scope,messages:[raw()]});
  const answer=await app.controller.assist({text:'我想邀请她周末一起散步，给我具体一句。',purpose:'draft',taskId:'restricted-draft-recovery'});
  assert.equal(answer.kind,'draft');assert.equal(answer.responseRecovery.kind,'restricted_draft');assert.equal(app.store.topicView(scope).active.direction,'直接自然地邀请');
  assert.equal(answer.privateReviewReceipt.applied,true);assert.ok(answer.privateReviewReceipt.sourceIds.length);
});

test('failed invoke keeps stage diagnostics but never persists the invalid raw response body',async t=>{
  const secret='UNVALIDATED_RAW_PRIVATE_RESPONSE_SENTINEL';
  const app=setup(t,async(_s,input)=>{
    input.manifest.outputMetadata={contentShape:'message_text'};
    input.extraRequests=[{purpose:'format_repair',manifest:{...input.manifest,purpose:'format_repair',stageId:'repair-stage',serializedTextRequestBytes:1000},payload:{purpose:'discussion',originalInput:input.payload,formatError:'unauthorized topic field',invalidResponse:secret}}];
    throw new Error('Synthetic repaired output remained invalid');
  });await app.controller.bind(scope.peerUin);await assert.rejects(app.controller.assist({text:'Help me discuss the next step.',taskId:'failed-recovery-trace'}),/Synthetic repaired/);
  const companion=app.store.getCompanion(scope),run=companion.runs.find(run=>run.id==='failed-recovery-trace');
  assert.equal(run.status,'failed');assert.equal(run.requests.length,2);assert.equal(run.requests[1].purpose,'format_repair');assert.equal(run.requests[1].manifest.stageId,'repair-stage');
  assert.equal(JSON.stringify(run).includes(secret),false);assert.ok(companion.turns.some(turn=>turn.role==='user'));assert.equal(companion.turns.some(turn=>turn.role==='assistant'),false);
});

test('recovery turn markers and private review receipts require scoped delivered original user authority',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());const user=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Current private intent'}),id=`private:${user.id}`;
  const good=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Private help',sourceIds:[id],responseRecovery:privateRecovery(id)});assert.equal(good.responseRecovery.kind,'private_help');
  for(const marker of [{...privateRecovery(id),metadataApplied:true},{...privateRecovery(id),reasonCode:'other'},{...privateRecovery(id),send:true},{...privateRecovery('private:missing')},draftRecovery()])assert.throws(()=>store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Rejected marker',sourceIds:[id],responseRecovery:marker}),/recovery|source|draft/i);
  assert.throws(()=>store.appendTurn(scope,{role:'user',kind:'discussion',text:'Forged user marker',responseRecovery:privateRecovery(id)}),/recovery|assistant/i);
  assert.throws(()=>store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Forged completed review',sourceIds:[id],privateReviewReceipt:{applied:true,sourceIds:['private:missing']}}),/review|source/i);
  assert.throws(()=>store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Cannot combine private fallback with review',sourceIds:[id],responseRecovery:privateRecovery(id),privateReviewReceipt:{applied:true,sourceIds:[id]}}),/review|recovery/i);
});

test('durable recovery and review source hashes cannot falsely review a revised canonical feedback body',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const first=store.experiences.review(scope,{text:'Earlier local feedback to discuss.',clientEventId:'feedback-original'}),id=first.feedback.sourceId;
  const oldRevision=store.memorySources(scope).find(source=>source.id===id).revision;
  const pending=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'A private fallback about the earlier feedback.',sourceIds:[id],responseRecovery:privateRecovery(id)});
  const reviewed=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'A valid structured review of that earlier feedback.',sourceIds:[id],privateReviewReceipt:{applied:true,sourceIds:[id]}});
  assert.equal(pending.responseRecovery.intentSourceRevisions[id],oldRevision);assert.equal(reviewed.privateReviewReceipt.sourceRevisions[id],oldRevision);
  store.experiences.review(scope,{caseId:first.experience.id,feedbackId:first.feedback.id,expectedVersion:first.feedback.revision,text:'Changed local feedback requires a fresh interpretation.',clientEventId:'feedback-corrected'});
  const current=store.memorySources(scope).find(source=>source.id===id);assert.notEqual(current.revision,oldRevision);
  const turns=store.getCompanion(scope).turns;assert.equal(turns.find(turn=>turn.id===pending.id).responseRecovery.intentSourceRevisions[id],oldRevision);
  assert.notEqual(turns.find(turn=>turn.id===reviewed.id).privateReviewReceipt.sourceRevisions[id],current.revision);
  assert.throws(()=>store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Cannot retag an old review as current.',sourceIds:[id],privateReviewReceipt:reviewed.privateReviewReceipt}),/source/i);
});

test('automatic QQ reply may recover private advice without granting an outbound plan or pending user intent',async t=>{
  const {assistModel}=require('../src/assistant-model.cjs');let calls=0;
  const app=setup(t,(settings,input,signal)=>assistModel(settings,input,signal,async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:++calls===1?JSON.stringify({kind:'discussion',text:'Not delivered',topicPatch:{operation:'update',version:1},actions:[{type:'save_note',text:'not authorized'}]}):'先接住她分享的游戏变化，保持这次自然的交流分寸。'}}]})})));
  await app.controller.bind(scope.peerUin);app.controller.live({scope,messages:[raw('90071992547409999921',false,{elements:[{textElement:{content:'我最近改玩解谜闯关了。'}}]})]});
  const before=app.store.getCompanion(scope);await app.controller.suggest({automatic:true});
  const after=app.store.getCompanion(scope),answer=after.turns.filter(turn=>turn.role==='assistant').at(-1);
  assert.equal(calls,2);assert.equal(answer.kind,'discussion');assert.equal(answer.responseRecovery.kind,'private_help');assert.deepEqual(answer.responseRecovery.intentSourceIds,[]);assert.equal(answer.suggestions,undefined);assert.deepEqual(answer.expressionOptions,[]);
  assert.equal(after.turns.filter(turn=>turn.role==='user').length,before.turns.filter(turn=>turn.role==='user').length);
  assert.equal(after.notes.length,before.notes.length);assert.equal(after.state.version,before.state.version);assert.equal(after.topics.items.length,before.topics.items.length);
  assert.equal(app.controller.advice.suggestions.length,0);assert.ok(app.controller.advice.analysis);assert.equal(after.runs.at(-1).maintenance,'deferred');
  const usage=app.controller.usage.get(scope,after.runs.at(-1).id);assert.equal(usage.attempts,2);assert.equal(usage.limit,4);assert.equal(usage.status,'complete');
});
