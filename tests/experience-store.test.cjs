'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {ExperienceStore}=require('../src/experience-store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {normalize}=require('../src/messages.cjs');
const key=s=>JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(k=>s[k]));
function setup(t){const store=new Store(':memory:');t.after(()=>store.close());store.experiences ||= new ExperienceStore(store,{scopeKey:key});return store;}
function publish(store,body='周末一起玩一局吗？',requestId='request-1'){
 const user=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我想邀请她一起玩，但不想给她压力。'});
 const turn=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'可以这样表达：',requestId,sourceIds:[`private:${user.id}`],suggestions:[{text:body,style:'自然'}],methodIds:['shared_activity']});
 const refs=store.experiences.recordArtifacts(scope,turn,{deliveredMethodRefs:[{methodId:'shared_activity',version:'1'}]});return {user,turn,refs};
}
function actual(store,id,body,own=true){const message=normalize(raw(id,own,{msgTime:String(Math.floor(Date.now()/1000)),elements:[{textElement:{content:body}}]}),scope);store.add(scope,[message]);store.experiences.observeMessages(scope,[message]);return message;}

test('exact artifacts and feedback targets survive twelve-run eviction and target a specific candidate',t=>{
 const store=setup(t),{turn,refs}=publish(store);const e=store.experiences;
 const feedback=e.addFeedback(scope,{requestId:turn.requestId,targetRef:{kind:'artifact',artifactRef:refs.suggestionRefs[0]},text:'这一句不像我，太正式。',clientEventId:'feedback-one', expectedDigest: e.artifact(scope, refs.suggestionRefs[0]).bodyDigest});
 for(let n=0;n<20;n++)store.saveRun(scope,{id:`later-${n}`,requestId:`later-${n}`,payload:{example:n}});
 assert.equal(store.getCompanion(scope).runs.length,12);
 const hydrated=e.hydrateFeedback(scope,feedback.id);assert.equal(hydrated.target.body,'周末一起玩一局吗？');assert.deepEqual(hydrated.target.artifactRef,refs.suggestionRefs[0]);
 assert.equal(hydrated.target.authority,'generated_evaluation_target');assert.equal(hydrated.feedback.kind,'local');
 assert.deepEqual(e.artifact(scope,refs.suggestionRefs[0]).parentRef,refs.responseRef);
});

test('canonical feedback is idempotent, scoped, and never becomes recurring through a caller kind flag',t=>{
 const store=setup(t),{refs}=publish(store),e=store.experiences;
 // F1: explicit artifact feedback pins its version by digest
 const args={targetRef:{kind:'artifact',artifactRef:refs.responseRef},text:'这次太长',kind:'recurring',clientEventId:'same-op',expectedDigest:e.artifact(scope,refs.responseRef).bodyDigest};
 const a=e.addFeedback(scope,args),b=e.addFeedback(scope,args);assert.equal(a.id,b.id);assert.equal(e.listFeedback(scope).length,1);assert.equal(a.kind,'local');
 assert.throws(()=>e.addFeedback({...scope,peerUid:'other'},args),/unavailable/);
 assert.throws(()=>e.addFeedback(scope,{...args,text:'换一段内容'}),/reused/);
 assert.equal(e.sourceRows(scope).length,1);assert.equal(e.sourceRows(scope)[0].type,'feedback');
});

test('legacy duplicate feedback has one canonical source and exact surviving response; orphan remains local and unresolved',t=>{
 const store=setup(t),e=store.experiences,legacy={turns:[{id:'a1',role:'assistant',requestId:'r1',text:'旧建议原文',createdAt:'2026-10-01T00:00:00Z'},{id:'u1',role:'user',kind:'feedback',requestId:'r1',text:'对助手建议的反馈：太正式',createdAt:'2026-10-01T00:01:00Z'},{id:'u2',role:'user',kind:'feedback',requestId:'missing',text:'对助手建议的反馈：以前那条太像采访',createdAt:'2026-10-02T00:00:00Z'}],feedback:[{id:'f1',requestId:'r1',text:'太正式',kind:'local',createdAt:'2026-10-01T00:01:00Z'}]};
 e.migrateLegacy(scope,legacy);e.migrateLegacy(scope,legacy);assert.equal(e.listFeedback(scope).length,2);assert.equal(e.canonicalSource(scope,'private:u1'),'private:feedback-f1');
 assert.equal(e.hydrateFeedback(scope,'f1').target.body,'旧建议原文');assert.equal(e.listFeedback(scope).find(f=>f.id==='legacy-u2').targetRef.kind,'unresolved_legacy');
 assert.ok(e.sourceRows(scope).every(s=>s.type==='feedback'&&s.kind==='local'));
});

test('adopt/edit/copy/fill checkpoints preserve actual versions but never invent a sent QQ message',t=>{
 const store=setup(t),{refs}=publish(store),e=store.experiences;
 for(const [index,type]of ['draft_adopted','draft_edited','clipboard_write','draft_fill'].entries()){
  const saved=e.recordInteraction(scope,{clientEventId:`op${index}`,type,text:index?'周末有空一起玩会儿吗？':'周末一起玩一局吗？',artifactRefs:refs.suggestionRefs,expectedRevision:index,outcome:'succeeded'});
  assert.equal(saved.event.sent,false);assert.equal(saved.draft.revision,Math.min(index+1,2));
 }
 assert.equal(store.messages(scope).length,0);assert.equal(e.list(scope).cases.length,0);
 assert.throws(()=>e.recordInteraction(scope,{clientEventId:'fake-send',type:'actual_send',text:'x'}),/cannot report/);
 assert.throws(()=>e.recordInteraction(scope,{clientEventId:'late-edit',type:'draft_edited',text:'旧修改',expectedRevision:1}),/another window/);
});

test('even a unique exact outgoing match remains candidate until explicit user confirmation; replies never score it',t=>{
 const store=setup(t),{refs}=publish(store),e=store.experiences;
 e.recordInteraction(scope,{clientEventId:'copy',type:'clipboard_write',text:'周末一起玩一局吗？',artifactRefs:refs.suggestionRefs});
 const outgoing=actual(store,'900719925474099399','周末一起玩一局吗？');
 let item=e.list(scope).cases[0];assert.equal(item.actualActions[0].messageId,outgoing.messageId);assert.equal(item.links[0].status,'candidate');
 actual(store,'900719925474099400','我这周忙，不过下周可以。',false);item=e.list(scope).cases[0];assert.equal(item.links[0].status,'candidate');assert.equal(item.observations[0].relevance,'unconfirmed');
 const confirmed=e.confirmLink(scope,{caseId:item.id,linkId:item.links[0].id,status:'user_confirmed'});assert.equal(confirmed.links[0].confirmation.authority,'user_report');
 assert.equal(JSON.stringify(confirmed).includes('romanticScore'),false);assert.equal(e.list(scope).adaptations.length,0);
});

test('independent actual messages and user-reported activities need no AI draft',t=>{
 const store=setup(t),e=store.experiences;actual(store,'900719925474099499','我自己想到的开场');
 const item=e.list(scope).cases[0];assert.equal(item.links.length,0);assert.equal(item.attribution,'unlinked');
 const report=e.review(scope,{text:'后来我们一起玩了游戏，我感觉挺自然，但不知道她是否想约会。',clientEventId:'activity-report'});
 assert.equal(report.experience.attribution,'independent_user_report');assert.equal(report.experience.actualActions.length,0);assert.equal(report.feedback.kind,'local');
 assert.equal(e.list(scope).cases.length,2);
});

test('source correction keeps a stale evaluation target, while forget purges all derived text and rejects late adoption',t=>{
 const store=setup(t),{refs,user}=publish(store,'SENSITIVE_REFERENCE_旧素材'),e=store.experiences;
 const f=e.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:refs.suggestionRefs[0]},text:'SENSITIVE_REFERENCE_旧素材不适合',clientEventId:'feedback', expectedDigest: e.artifact(scope, refs.suggestionRefs[0]).bodyDigest});
 e.recordInteraction(scope,{clientEventId:'adopt',type:'draft_adopted',text:'SENSITIVE_REFERENCE_旧素材',artifactRefs:refs.suggestionRefs});
 e.recordInteraction(scope,{clientEventId:'copy',type:'clipboard_write',text:'SENSITIVE_REFERENCE_旧素材',artifactRefs:refs.suggestionRefs});
 e.invalidateSources(scope,[`private:${user.id}`],{mode:'correct'});
 assert.equal(e.hydrateFeedback(scope,f.id).target.availability,'stale');assert.match(e.hydrateFeedback(scope,f.id).target.body,/SENSITIVE/);
 const version=e.listFeedback(scope)[0].revision;e.invalidateSources(scope,[f.sourceId],{mode:'correct'});assert.equal(e.listFeedback(scope)[0].revision,version,'canonical source revision does not feed back into itself');
 e.invalidateSources(scope,[`private:${user.id}`],{mode:'forget'});
 assert.equal(e.hydrateFeedback(scope,f.id),null);assert.equal(e.draft(scope).text,'');
 assert.equal(JSON.stringify(e._all(scope,'artifact')).includes('SENSITIVE_REFERENCE'),false);assert.equal(JSON.stringify(e._all(scope,'event')).includes('SENSITIVE_REFERENCE'),false);
 assert.throws(()=>e.recordInteraction(scope,{clientEventId:'late',type:'draft_adopted',text:'SENSITIVE_REFERENCE_旧素材',artifactRefs:refs.suggestionRefs}),/removed or changed/);
});

test('personal guidance requires concrete scope and user activation, can retire, and is not a relationship-success claim',t=>{
 const store=setup(t),{refs,user}=publish(store),e=store.experiences;
 const proposed=e.adapt(scope,{operation:'propose',text:'先回应她说过的具体事，少加泛泛问题。',applicability:'回应具体近况时',sourceIds:[`private:${user.id}`],methodRef:{methodId:'respond',version:'1'}});
 assert.equal(proposed.status,'candidate');assert.equal(e.context(scope,{query:''}).adaptations.length,0);
 const active=e.adapt(scope,{id:proposed.id,operation:'activate',expectedVersion:1});assert.equal(active.status,'active');assert.equal(active.claim,'assistance_fit_not_romantic_causality');
 assert.equal(e.context({...scope,peerUid:'other'},{query:''}).adaptations.length,0);
 const retired=e.adapt(scope,{id:active.id,operation:'retire',expectedVersion:2});assert.equal(retired.status,'retired');assert.equal(e.context(scope,{query:''}).adaptations.length,0);
});
test('activated guidance is offered across equivalent phrasing without asserting relevance for unrelated or negated requests',t=>{
 const store=setup(t),{user}=publish(store),e=store.experiences;
 const proposed=e.adapt(scope,{operation:'propose',text:'先回应她分享的具体细节，不追加泛泛连问。',applicability:'回应近况已有足够信息时',sourceIds:[`private:${user.id}`],methodRef:{methodId:'respond',version:'1'}});
 const active=e.adapt(scope,{id:proposed.id,operation:'activate',expectedVersion:1});
 const match=e.context(scope,{query:'回应近况'}).adaptations[0];assert.equal(match.id,active.id);assert.equal(match.matchBasis,'lexical');
 for(const query of ['Please answer the details of her update.','We are reviewing a contract; do not apply old conversation advice.','这次不要采用之前的回应近况规则。']){
  const candidate=e.context(scope,{query}).adaptations.find(item=>item.id===active.id);
  assert.ok(candidate);assert.equal(candidate.applicabilityStatus,'needs_model_check');assert.equal(candidate.applicable,undefined);
 }
 assert.equal(e.context(scope,{query:'Please answer the details of her update.'}).adaptations[0].matchBasis,'recent_active_fallback');
 assert.equal(e._get(scope,'adaptation',active.id).applicabilityStatus,undefined,'retrieval candidacy never mutates activated guidance');
 assert.equal(e.context({...scope,peerUid:'other'},{query:'回应近况'}).adaptations.length,0);
 e.adapt(scope,{id:active.id,operation:'retire',expectedVersion:active.version});assert.equal(e.context(scope,{query:'回应近况'}).adaptations.length,0);
});
test('fallback considers only two recent active live guides and excludes stale or unapproved replayed records',t=>{
 const store=setup(t),{user}=publish(store),e=store.experiences,active=[];
 for(let index=0;index<4;index++){
  const proposed=e.adapt(scope,{operation:'propose',text:`私下帮助规则${index}`,applicability:`限定场景${index}`,sourceIds:[`private:${user.id}`],methodRef:{methodId:'respond',version:'1'}});
  const saved=e.adapt(scope,{id:proposed.id,operation:'activate',expectedVersion:1});saved.updatedAt=new Date(1791972000000+index*1000).toISOString();e._put(scope,'adaptation',saved.id,saved);active.push(saved);
 }
 const updated={...active[0],updatedAt:new Date(1791972010000).toISOString()};e._put(scope,'adaptation',updated.id,updated);
 assert.deepEqual(e.context(scope,{query:'unrelatedwords',limit:8}).adaptations.map(item=>item.id),[active[0].id,active[3].id]);
 const unapproved={...updated,authority:'provisional_assistance_guidance'};e._put(scope,'adaptation',updated.id,unapproved);
 assert.ok(!e.context(scope,{query:'unrelatedwords'}).adaptations.some(item=>item.id===updated.id));
 const missing={...updated,sourceIds:['private:missing'],sourceRefs:[{sourceId:'private:missing'}]};e._put(scope,'adaptation',updated.id,missing);
 assert.ok(!e.context(scope,{query:'unrelatedwords'}).adaptations.some(item=>item.id===updated.id),'missing source and missing revision cannot agree as undefined');
 store.updateTurn(scope,user.id,'Changed synthetic current evidence.');
 e._put(scope,'adaptation',active[3].id,active[3]);
 assert.equal(e.context(scope,{query:'限定场景'}).adaptations.length,0,'live-source verification independently rejects stale activated replay');
});
test('whole-response artifact includes visible explanation while drafts/options stay separate and legacy bodies are unchanged',t=>{
 const store=setup(t),{turn,refs}=publish(store),e=store.experiences;
 const explanation='先接住她的分享，再给一个可以自由选择的邀请。';
 const value={...turn,discussionExplanation:{kind:'discussion',text:explanation},expressionOptions:[{label:'一个可选择方向'}]};
 const newRefs=e.recordArtifacts(scope,value,{deliveredMethodRefs:[{methodId:'shared_activity',version:'1'}]});
 assert.equal(e.artifact(scope,newRefs.responseRef).body,`${explanation}\n\n${turn.text}`);
 assert.equal(e.artifact(scope,newRefs.suggestionRefs[0]).body,turn.suggestions[0].text);
 assert.equal(e.artifact(scope,newRefs.optionRefs[0]).body,'一个可选择方向');
 assert.equal(e.artifact(scope,refs.responseRef).body,turn.text,'the older artifact version remains unchanged');
 const {visibleResponseText}=require('../src/experience-store.cjs');
 assert.equal(visibleResponseText(turn),turn.text);assert.equal(visibleResponseText({...turn,discussionExplanation:{kind:'discussion',text:turn.text}}),turn.text);
 const feedback=e.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:newRefs.responseRef},text:'这段分析和稿子一起更清楚。', expectedDigest: e.artifact(scope, newRefs.responseRef).bodyDigest});
 assert.equal(e.hydrateFeedback(scope,feedback.id).target.body,visibleResponseText(value));
});

test('foreign and numeric actual message identities are rejected at the experience boundary',t=>{
 const store=setup(t),message=normalize(raw('900719925474099599',true),scope);
 assert.throws(()=>store.experiences.observeMessages(scope,[{...message,peerUid:'other'}]),/scope/);
 assert.throws(()=>store.experiences.observeMessages(scope,[{...message,messageId:9}]),/string/);
});

test('late checkpoint arrival can add a candidate but cannot overwrite an independent draft or confirm use',t=>{
 const store=setup(t),{refs}=publish(store),e=store.experiences;
 e.recordInteraction(scope,{clientEventId:'own-draft',type:'draft_independent',text:'我还没写完自己的另一件事'});
 const outgoing=actual(store,'900719925474099699','周末一起玩一局吗？');assert.equal(e.list(scope).cases[0].links.length,0);
 e.recordInteraction(scope,{clientEventId:'late-copy',type:'clipboard_write',text:outgoing.text,artifactRefs:refs.suggestionRefs,eventAt:new Date(outgoing.timestamp-1000).toISOString(),expectedRevision:0});
 assert.equal(e.draft(scope).text,'我还没写完自己的另一件事');assert.equal(e.draft(scope).revision,1);
 assert.equal(e.list(scope).cases[0].links[0].status,'candidate');
});

test('identical advice alternatives stay separate candidates rather than crediting both',t=>{
 const store=setup(t),first=publish(store,'你今天怎么样？','first'),second=publish(store,'你今天怎么样？','second'),e=store.experiences;
 for(const [index,refs]of [first.refs,second.refs].entries())e.recordInteraction(scope,{clientEventId:`copy-${index}`,type:'clipboard_write',text:'你今天怎么样？',artifactRefs:refs.suggestionRefs});
 actual(store,'900719925474099799','你今天怎么样？');let item=e.list(scope).cases[0];assert.equal(item.links.length,2);
 e.confirmLink(scope,{caseId:item.id,linkId:item.links[0].id,status:'user_confirmed'});item=e.list(scope).cases[0];assert.equal(item.links[1].status,'candidate');
});

test('model-derived personal guidance requires delivered canonical feedback and remains inactive',t=>{
 const store=setup(t),{turn,refs}=publish(store),e=store.experiences;
 const f=store.addFeedback(scope,{requestId:turn.requestId,targetRef:{kind:'artifact',artifactRef:refs.suggestionRefs[0]},text:'只回应具体细节更像我。', expectedDigest: store.experiences.artifact(scope, refs.suggestionRefs[0]).bodyDigest});
 const proposal={text:'先回应具体细节。',applicability:'对方分享近况时',methodId:'respond',sourceIds:[f.sourceId],caseIds:[]};
 const options={allowedSourceIds:[f.sourceId],allowedCaseIds:[],deliveredMethods:[{id:'respond',version:'1'}]};
 const before=store.contextGeneration?.(scope),p=e.proposeFromModel(scope,proposal,options);
 assert.equal(p.status,'candidate');assert.equal(store.contextGeneration?.(scope),before,'inactive candidates must not self-invalidate the main answer');
 assert.equal(e.proposeFromModel(scope,proposal,options).id,p.id);assert.equal(e.list(scope).adaptations.length,1);
 assert.throws(()=>e.proposeFromModel(scope,{...proposal,sourceIds:[`private:${turn.id}`]},options),/not delivered/);
 assert.throws(()=>e.proposeFromModel(scope,{...proposal,methodId:'not-delivered'},options),/method/);
 assert.equal(e.context(scope,{query:''}).adaptations.length,0);
});

test('feedback alias migration changes authority references without deleting retained evaluation text',t=>{
 const store=setup(t),{refs,user}=publish(store,'需要评价的旧建议'),e=store.experiences;
 const f=store.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:refs.responseRef},text:'这是局部反馈。', expectedDigest: store.experiences.artifact(scope, refs.responseRef).bodyDigest}),source=store.memorySources(scope).find(s=>s.id===f.sourceId);
 e.remapSources(scope,[{from:`private:${user.id}`,to:f.sourceId,revision:source.revision}]);
 const artifact=e.artifact(scope,refs.suggestionRefs[0]);assert.equal(artifact.availability,'stale');assert.equal(artifact.body,'需要评价的旧建议');assert.deepEqual(artifact.sourceIds,[f.sourceId]);
});

test('deep evaluated-answer dependency chains are invalidated atomically and then forgotten without retained text',t=>{
 const store=setup(t),e=store.experiences,root=store.appendTurn(scope,{role:'user',kind:'discussion',text:'DEEP_PRIVATE_SOURCE'});let sourceId=`private:${root.id}`;const refs=[];
 for(let index=0;index<14;index++){
  const reply=store.appendTurn(scope,{role:'assistant',kind:'discussion',requestId:`chain-${index}`,text:`DEEP_PRIVATE_SOURCE derived ${index}`,sourceIds:[sourceId]});
  refs.push(reply.artifactRef);const feedback=store.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:reply.artifactRef},text:`DEEP_PRIVATE_SOURCE feedback ${index}`, expectedDigest: store.experiences.artifact(scope, reply.artifactRef).bodyDigest});sourceId=feedback.sourceId;
 }
 store.updateTurn(scope,root.id,'CORRECTED_SOURCE');assert.ok(refs.every(r=>e.artifact(scope,r).availability==='stale'));
 store.deleteTurn(scope,root.id);assert.equal(e.listFeedback(scope).length,0);assert.ok(refs.every(r=>e.artifact(scope,r).availability==='redacted'));
 assert.equal(JSON.stringify(e._all(scope,'artifact')).includes('DEEP_PRIVATE_SOURCE'),false);
});

test('a local experience review can be corrected without creating a second feedback identity',t=>{
 const store=setup(t),e=store.experiences,first=e.review(scope,{text:'这次我觉得有点紧张。',clientEventId:'first-review'});
 const corrected=e.review(scope,{caseId:first.experience.id,feedbackId:first.feedback.id,expectedVersion:1,text:'更准确地说，我只是担心表达不清楚。'});
 assert.equal(corrected.feedback.id,first.feedback.id);assert.equal(corrected.feedback.revision,2);assert.equal(e.listFeedback(scope).length,1);
 assert.throws(()=>e.review(scope,{caseId:first.experience.id,feedbackId:first.feedback.id,expectedVersion:1,text:'迟到的修改'}),/Review changed/);
});
