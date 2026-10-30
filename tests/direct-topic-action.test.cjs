'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/assistant-protocol.cjs'),{createServer}=require('../src/server.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
function fixture(t,{model}={}){
 const store=new Store(':memory:');let modelCalls=0;
 const controller=new Controller({store,settings:{auto:false,anonymous:true,model:'synthetic-local-control',baseUrl:'http://fixture.invalid/v1',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic-local-control',baseUrl:'http://fixture.invalid/v1'}},read:async()=>{throw Error('No native QQ in this fixture');},memoryModel:null,assistantModel:model||(async()=>{modelCalls++;throw Error('HTTP429 synthetic unavailable model');})});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
 store.setGoal(scope,'希望与她发展双方愿意的恋爱关系');store.add(scope,[require('../src/messages.cjs').normalize(raw(),scope)]);
 const user=store.appendTurn(scope,{role:'user',kind:'discussion',requestId:'synthetic-topic-seed',text:'想顺着她的游戏体验聊，了解平时玩什么。'});
 const sources=store.memorySources(scope),id=`private:${user.id}`,receipt=store.applyTopicPatch(scope,{operation:'create',objective:'了解她平时玩的游戏',direction:'先接住她的分享',constraints:['表达含蓄一些'],purposeSourceIds:[id],intentQuote:user.text},{baseRevision:store.getCompanion(scope).revision,baseTopicVersion:0,activeId:null,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),currentSourceId:id,origin:'private_discussion',requestId:user.requestId});
 assert.equal(receipt.applied,true,JSON.stringify(receipt));
 store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Synthetic historical advice to preserve',sourceIds:[id]});
 const state=store.applyState(scope,{focus:'了解她的游戏',items:[{text:'保留的来源事实',sourceIds:[id]}],openThreads:[{text:'需要复核的旧事项',sourceIds:[id]}],unknowns:['尚未知的其他情况']},{baseRevision:store.getCompanion(scope).revision,sourceIds:[id],coverage:{complete:false,sourceIds:[id]}});assert.equal(state.applied,true);
 t.after(()=>{controller.close();store.close();});
 return {store,controller,topic:store.topicView(scope).active,modelCalls:()=>modelCalls};
}
test('complete, cancel and remove persist locally without model calls and preserve sources, goal and factual state',t=>{
 for(const operation of ['complete','cancel','remove']){
  const f=fixture(t),before=f.store.getCompanion(scope),actual=f.store.messages(scope);
  const receipt=f.controller.topicAction({id:f.topic.id,expectedVersion:f.topic.version,operation});
  assert.equal(receipt.applied,true);assert.equal(f.modelCalls(),0);assert.equal(f.store.topicView(scope).active,null);
  const after=f.store.getCompanion(scope);assert.deepEqual(after.goal,before.goal);assert.deepEqual(f.store.messages(scope),actual);
  assert.deepEqual(after.state.items,before.state.items);assert.deepEqual(after.state.openThreads,before.state.openThreads);assert.deepEqual(after.state.unknowns,before.state.unknowns);
  assert.equal(after.state.focus,'');assert.equal(after.state.possiblyStale,true);assert.ok(after.revision>before.revision);assert.ok(after.topics.version>before.topics.version);
  assert.ok(before.turns.every(turn=>after.turns.some(item=>item.id===turn.id&&item.text===turn.text)));
  const control=after.turns.at(-1);assert.equal(control.role,'user');assert.equal(control.kind,'user_control');assert.equal(receipt.sourceId,`private:${control.id}`);
  assert.equal(operation==='remove'?after.topics.items.some(topic=>topic.id===f.topic.id):after.topics.items.find(topic=>topic.id===f.topic.id).lifecycle,operation==='remove'?false:operation==='complete'?'completed':'cancelled');
  assert.equal(f.store.topicView(scope).active,null,'reload of persisted companion remains closed');
 }
});
test('stale version, wrong target and invalid operation reject atomically without adding a control source',t=>{
 const f=fixture(t),before=f.store.getCompanion(scope);
 for(const args of [{id:f.topic.id,expectedVersion:f.topic.version-1,operation:'remove'},{id:'foreign-topic',expectedVersion:f.topic.version,operation:'complete'},{id:f.topic.id,expectedVersion:f.topic.version,operation:'resume'},{id:f.topic.id,operation:'remove'}])assert.throws(()=>f.controller.topicAction(args),/话题|topic|version/i);
 assert.deepEqual(f.store.getCompanion(scope),before);assert.equal(f.modelCalls(),0);
});
test('authenticated topic actions require all four captured scope fields before any dispatch',async t=>{
 const f=fixture(t),server=createServer({controller:f.controller,token:'synthetic-topic-action',uiDir:path.resolve(__dirname,'../ui')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,post=args=>fetch(base+'/api/topic-action',{method:'POST',headers:{Authorization:'Bearer synthetic-topic-action','Content-Type':'application/json'},body:JSON.stringify(args)}),args={...scope,id:f.topic.id,expectedVersion:f.topic.version,operation:'complete'},before=f.store.getCompanion(scope);
 for(const field of Object.keys(scope))for(const bad of [{...args,[field]:'stale'},Object.fromEntries(Object.entries(args).filter(([key])=>key!==field))])assert.equal((await post(bad)).status,400);
 assert.deepEqual(f.store.getCompanion(scope),before);
 const accepted=await post(args);assert.equal(accepted.status,200);const body=await accepted.json();assert.equal(body.topicAction.applied,true);assert.equal(body.topicContext.active,null);assert.deepEqual(body.scope,scope);assert.equal(f.modelCalls(),0);
});
test('closing a topic cancels an in-flight result that tries to update it and prevents stale resumption',async t=>{
 let finish,started;const ready=new Promise(resolve=>started=resolve);
 const f=fixture(t,{model:async(_settings,input)=>{started();return new Promise(resolve=>finish=()=>resolve({kind:'discussion',text:'Obsolete result must not appear',topicPatch:{operation:'update',topicId:input.payload.topicContext.active.id,direction:'Old game direction revived',purposeSourceIds:[input.payload.userRequest.sourceId],intentQuote:input.payload.userRequest.text}}));}});
 const pending=f.controller.assist({text:'先看看怎么继续。',taskId:'synthetic-stale-topic'});await ready;
 const current=f.store.topicView(scope).active;f.controller.topicAction({id:current.id,expectedVersion:current.version,operation:'complete'});finish();
 assert.equal(await pending,undefined);assert.equal(f.store.topicView(scope).active,null);assert.equal(f.store.getCompanion(scope).turns.some(turn=>turn.text==='Obsolete result must not appear'),false);assert.equal(f.controller.usage.get(scope,'synthetic-stale-topic').status,'cancelled');assert.equal(f.controller.pendingAssist,null);
});
test('removing a retained topic discards a valid closed-topic compaction without erasing original discussion',t=>{
 const f=fixture(t),{DISCUSSION_COMPACTION_VERSION,discussionTopicBinding,discussionModelBinding,discussionCompactionEvidence}=require('../src/discussion-compaction-store.cjs');
 f.controller.topicAction({id:f.topic.id,expectedVersion:f.topic.version,operation:'complete'});
 const before=f.store.getCompanion(scope),covered=before.turns.slice(0,2).map(turn=>turn.id),current=before.turns.at(-1);
 const binding={goalVersion:before.goal.version,topicVersion:before.topics.version,topicBinding:discussionTopicBinding(before),model:f.controller.settings.model,modelBinding:discussionModelBinding(f.controller.settings.baseUrl,f.controller.settings.model),promptVersion:require('../src/assistant-context.cjs').PROMPT_VERSION,protocolVersion:DISCUSSION_COMPACTION_VERSION};
 const evidence=discussionCompactionEvidence(f.store,scope,covered,before),cache={...binding,...evidence,sourceTurnIds:covered,summary:'An earlier generated discussion about games, not an active task.',quoteRefs:[],requestId:'synthetic-closed-cache'};
 const saved=f.store.saveDiscussionCompaction(scope,cache,{...binding,baseRevision:before.revision,currentTurnId:current.id});assert.equal(saved.applied,true,JSON.stringify(saved));assert.ok(f.store.getDiscussionCompaction(scope,binding));
 const closed=f.store.topicView(scope).retained.find(topic=>topic.id===f.topic.id);f.controller.topicAction({id:closed.id,expectedVersion:closed.version,operation:'remove'});
 assert.equal(f.store.getDiscussionCompaction(scope,binding),null);assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_compactions WHERE scope_key=?').get(f.store.scopeKey(scope)).n,0);
 assert.ok(covered.every(id=>f.store.getCompanion(scope).turns.some(turn=>turn.id===id)));
});
test('subsequent vague consultation sees local closure and a stale old summary rather than active game controls',t=>{
 const f=fixture(t);f.controller.topicAction({id:f.topic.id,expectedVersion:f.topic.version,operation:'complete'});
 const control=f.store.getCompanion(scope).turns.at(-1),turn=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'怎么继续？'});
 const payload=require('../src/assistant-context.cjs').buildContext({scope,records:f.store.messages(scope),companion:f.store.getCompanion(scope),turn,availableSources:f.store.memorySources(scope),coverage:f.store.coverage(scope)}).payload;
 assert.equal(payload.topicContext.active,null);assert.equal(payload.topicContext.retained[0].lifecycle,'completed');assert.equal(payload.topicContext.retained[0].authority,'closed_topic_navigation_not_active_control');
 assert.equal(payload.workingState.focus,undefined);assert.equal(payload.workingState.authority,'previous_summary_needs_review');
 assert.ok(payload.sources.some(source=>source.id===`private:${control.id}`&&source.kind==='user_control'&&source.text===control.text));
 const behavior=require('../src/help-behavior.cjs').HELP_BEHAVIOR;
 assert.match(behavior,/模糊[^。]*不恢复旧任务/);
 assert.match(behavior,/明确重选后才恢复/);
});
