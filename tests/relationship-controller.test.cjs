'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');const {Controller}=require('./fixtures/whole-answer-fidelity.cjs');const {scope,raw}=require('./fixtures/native.cjs');
function setup(t,model){const store=new Store(':memory:'),fidelityCalls=[];const controller=new Controller({store,assistantModel:async(...args)=>{if(args[1].payload.purpose==='fidelity_check'){fidelityCalls.push(args[1]);return {checkRef:args[1].payload.checkRef,verdict:'allow',issues:[]};}return model(...args);},read:async command=>command==='bind'?scope:{messages:[]},settings:{auto:false,apiKey:'synthetic',model:'synthetic',baseUrl:'http://fixture.invalid',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic',baseUrl:'http://fixture.invalid'}}});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});t.after(()=>{controller.close();store.close()});return {store,controller,fidelityCalls};}
test('foreground navigation waits for the original-evidence writer and exact artifact methods feed the next scoped decision',async t=>{
 let captured,round=0;
 const app=setup(t,async(_settings,context)=>{captured=context;round++;const qq=context.payload.sources.find(source=>source.type==='qq');
  if(round===1)return {kind:'discussion',text:'可以从她明确分享的游戏兴趣接着聊。',methodIds:['choose_next_step'],relationshipPatch:{claims:[{subject:'contact',aspect:'interest',text:'她说喜欢合作游戏',assertionKind:'stated',epistemicStatus:'supported',sourceIds:[qq.id],topicKeys:['合作游戏']}],events:[],retire:[]}};
  return {kind:'discussion',text:'你可以表达想和她一起玩的真实意思。',methodIds:['express_interest']};});
 await app.controller.bind(scope.peerUin);app.controller.live({scope,messages:[raw(undefined,false,{elements:[{textElement:{content:'我挺喜欢合作游戏的'}}]})]});
 await app.controller.assist({text:'想和她多认识一点，从什么聊起？'});
 assert.equal(app.store.relationshipView(scope).contact.length,0,'a foreground proposal is not active person knowledge');
 assert.equal(app.store.memoryStatus(scope).pendingProposals,1);
 const firstRun=app.store.getCompanion(scope).runs.at(-1);assert.equal(firstRun.relationshipReceipt.queued,true);
 const batch=app.store.memoryBatch(scope),source=batch.sources.find(source=>source.type==='qq');assert.ok(source);
 const background=app.store.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,relationshipPatch:{claims:[{subject:'contact',aspect:'interest',text:'她说喜欢合作游戏',assertionKind:'stated',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[source.id],topicKeys:['合作游戏']}],events:[],retire:[]},episodes:[]});
 assert.equal(background.applied,true,JSON.stringify(background));assert.equal(app.store.relationshipView(scope).contact.length,1);
 const answer=app.store.getCompanion(scope).turns.find(turn=>turn.role==='assistant');assert.ok(answer.artifactRef);
 await app.controller.assist({text:'想和她一起玩合作游戏，也想自然表达想多认识她。'});
 assert.ok(captured.payload.methodCatalog.some(method=>method.id==='express_interest'));
 assert.ok(captured.payload.methodSelection.candidates.includes('express_interest'));
 assert.ok(captured.payload.methodCards.length<=2);
 assert.ok(JSON.stringify(captured.payload.relationshipContext).includes('合作游戏'));
 const target=app.store.experiences.artifact(scope,answer.artifactRef);assert.ok(target.generationStages.length);assert.equal(app.store.messages(scope).length,1);
});
test('specific feedback becomes an inactive scoped guidance candidate and helps only after approval',async t=>{
 let latest;
 const app=setup(t,async(_settings,context)=>{
  latest=context.payload;
  if(context.payload.purpose==='review'){
   const feedback=context.payload.feedbackTargets[0].feedback;
   return {kind:'review',text:'普通问候时可以更简短，这只是表达适配经验。',methodIds:['review'],experienceProposals:[{text:'普通问候时简短自然，不连续追问',applicability:'普通问候',methodId:'review',sourceIds:[feedback.sourceId],caseIds:[]}]};
  }
  return {kind:'discussion',text:'你好呀，今天过得怎么样？'};
 });
 await app.controller.bind(scope.peerUin);const first=await app.controller.assist({text:'帮我想一条普通问候。'});
 app.controller.addFeedback({requestId:first.requestId,targetRef:{kind:'artifact',artifactRef:first.artifactRef},text:'这句普通问候太像客服了，先简短一点。'});
 await app.controller.assist({text:'回顾这次普通问候的表达问题。',purpose:'review'});
 assert.ok(latest.feedbackTargets[0].target.body.includes('今天过得怎么样'));
 const candidate=app.store.experiences.list(scope).adaptations[0];assert.ok(candidate);assert.equal(candidate.status,'candidate');
 assert.equal(app.store.experiences.context(scope,{query:'普通问候'}).adaptations.length,0);
 app.controller.experienceAction('adaptation',{id:candidate.id,expectedVersion:candidate.version,operation:'activate'});
 await app.controller.assist({text:'这次也是普通问候，想简短自然地说。'});
 assert.ok(latest.experienceContext.adaptations.some(item=>item.id===candidate.id));
 assert.equal(app.store.messages(scope).length,0);
});
test('idempotent browser submissions do not create duplicate private turns or model requests',async t=>{
 let calls=0;const app=setup(t,async()=>{calls++;return {kind:'discussion',text:'可以先说说你愿意表达的意思。'}});await app.controller.bind(scope.peerUin);
 const args={taskId:'client-retry-one',text:'我想找她聊天。'};const first=await app.controller.assist(args),second=await app.controller.assist(args);
 assert.equal(first.id,second.id);assert.equal(calls,1);assert.equal(app.fidelityCalls.length,1);assert.equal(app.store.getCompanion(scope).turns.length,2);
 await assert.rejects(app.controller.assist({...args,text:'不一样的请求'}),/不同/);
});
test('a late rejected old attempt cannot overwrite the completed resumed task ledger',async t=>{
 let rejectOld,calls=0;const app=setup(t,async()=>{calls++;if(calls===1)return new Promise((_resolve,reject)=>{rejectOld=reject});return {kind:'discussion',text:'按新消息继续考虑。'};});
 await app.controller.bind(scope.peerUin);const first=app.controller.assist({text:'帮我接着聊。'});
 while(!rejectOld)await new Promise(resolve=>setImmediate(resolve));
 app.controller.live({scope,messages:[raw(undefined,false,{elements:[{textElement:{content:'我临时要出门，回来再说'}}]})]});
 const pending=app.controller.pendingAssist;assert.ok(pending);clearTimeout(app.controller.assistantRetryTimer);app.controller.pendingAssist=null;
 await app.controller.assist({...pending.args,taskId:pending.taskId,resumeTurnId:pending.turnId,resumes:1});
 rejectOld(new Error('old request rejected after resume finished'));await first.catch(()=>{});
 assert.equal(app.controller.usage.get(scope,pending.taskId).status,'complete');
});
test('automatic requests deduplicate unchanged context but an explicit regeneration remains available',async t=>{
 let calls=0;const app=setup(t,async()=>{calls++;return {kind:'discussion',text:'合成场景暂不需要新回复。',replyDisposition:'wait',stateReview:'no_change'}});await app.controller.bind(scope.peerUin);
 await app.controller.suggest({automatic:true});await app.controller.suggest({automatic:true});assert.equal(calls,1);assert.equal(app.fidelityCalls.length,1);
 await app.controller.suggest();assert.equal(calls,2);assert.equal(app.fidelityCalls.length,2);
});
test('rejected derived-claim edits return an actionable failure instead of a successful snapshot',async t=>{
 const app=setup(t,async()=>({kind:'discussion',text:'test'}));await app.controller.bind(scope.peerUin);
 const before=app.store.getCompanion(scope).turns.length;
 assert.throws(()=>app.controller.claimAction({id:'not-current',expectedVersion:1,operation:'withdraw'}),/理解|claim/);
 assert.equal(app.store.getCompanion(scope).turns.length,before);
});
test('a semantic store update terminalizes an obsolete request even without a controller cancellation callback',async t=>{
 let app;app=setup(t,async()=>{app.store.touchContext(scope);return {kind:'discussion',text:'这份旧结果不应显示。'}});await app.controller.bind(scope.peerUin);
 const answer=await app.controller.assist({taskId:'obsolete-store-write',text:'考虑一下下一步。'});
 assert.equal(answer,undefined);assert.equal(app.controller.assistantBusy,false);
 assert.equal(app.controller.usage.get(scope,'obsolete-store-write').status,'cancelled');
 assert.match(app.controller.assistantError,/资料已更新/);
});
test('a correction cannot upgrade an earlier staged claim to the replacement source revision',async t=>{
 let calls=0,sourceId;const request='更正“我周六去了展览”为“我周日去了展览”';
 const app=setup(t,async()=>{
  calls++;
  const result={kind:'discussion',text:'合成更正确认',relationshipPatch:{claims:[{subject:'self',aspect:'recent_context',text:calls===1?'用户周六去了展览':'用户周日去了展览',assertionKind:'reported',epistemicStatus:'supported',sourceIds:[sourceId]}]}};
  if(calls===1)result.actions=[{type:'correct_source',sourceId,targetQuote:'我周六去了展览',text:'我周日去了展览',evidenceQuote:request}];
  return result;
 });
 const original=app.store.appendTurn(scope,{role:'user',kind:'discussion',text:'我周六去了展览'});sourceId=`private:${original.id}`;
 await app.controller.bind(scope.peerUin);
 await app.controller.assist({text:request,sourceTurnIds:[original.id],taskId:'no-stale-provenance-upgrade'});
 assert.equal(calls,2);assert.equal(app.fidelityCalls.length,1);
 const source=app.store.memorySources(scope).find(s=>s.id===sourceId);assert.equal(source.text,'我周日去了展览');
 assert.deepEqual(app.store.relationshipView(scope).claims,[],'the replacement foreground proposal still cannot become an active profile');
 const batch=app.store.memoryBatch(scope);assert.equal(batch.pendingProposals.length,1);
 const proposal=batch.pendingProposals[0];assert.deepEqual(proposal.patch.claims.map(c=>c.text),['用户周日去了展览']);
 assert.equal(proposal.sourceRevisions[sourceId],source.revision,'the queued interpretation is bound only to the actual replacement source revision');
 assert.equal(app.store.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,relationshipPatch:proposal.patch,episodes:[]}).applied,true);
 const claims=app.store.relationshipView(scope).claims;assert.deepEqual(claims.map(c=>c.text),['用户周日去了展览']);assert.equal(claims[0].sourceRevisions[sourceId],source.revision);
});
test('old feedback review commits no-change state and an experience candidate without a stale run revision',async t=>{
 const app=setup(t,async(_settings,context)=>{
  if(context.payload.purpose!=='review')return {kind:'discussion',text:'你好呀，今天过得怎么样？'};
  const feedback=context.payload.feedbackTargets[0].feedback;
  return {kind:'review',text:'这次问候可以更贴近你自己的说法。',methodIds:['review'],stateReview:'no_change',experienceProposals:[{text:'普通问候使用自然简短的表达',applicability:'普通问候时',methodId:'review',sourceIds:[feedback.sourceId],caseIds:[]}]};
 });
 await app.controller.bind(scope.peerUin);const first=await app.controller.assist({text:'帮我想一条普通问候。'});
 app.controller.addFeedback({requestId:first.requestId,targetRef:{kind:'artifact',artifactRef:first.artifactRef},text:'这句普通问候太正式了。'});
 const result=await app.controller.assist({taskId:'feedback-state-review',text:'回顾这次普通问候太正式的问题。',purpose:'review'});
 assert.equal(result.kind,'discussion');assert.equal(app.controller.usage.get(scope,'feedback-state-review').status,'complete');
 assert.equal(app.store.experiences.list(scope).adaptations[0].status,'candidate');
 const run=app.store.getCompanion(scope).runs.find(r=>r.id==='feedback-state-review');assert.equal(run.purpose,'answer_admission');assert.equal(run.payload.purpose,'answer_admission');assert.equal(run.requests[0].payload.purpose,'review');assert.equal(run.patchReceipt.applied,true);assert.equal(run.status,'complete');
});
