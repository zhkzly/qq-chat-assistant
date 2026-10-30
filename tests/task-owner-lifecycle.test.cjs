'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const scope={accountUid:'task-owner-account',accountUin:'100001',peerUid:'task-owner-contact',peerUin:'200002'};
function request(store,text){return store.appendTurn(scope,{role:'user',kind:'discussion',text,requestId:`request-${store.getCompanion(scope).turns.length}`});}
function options(store,turn){const c=store.getCompanion(scope),sources=store.memorySources(scope);return {baseRevision:c.revision,baseTopicVersion:c.topics.version,activeId:c.topics.activeId,origin:'private_discussion',requestId:turn.requestId,currentSourceId:`private:${turn.id}`,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision]))};}
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());const turn=request(store,'Discuss inviting our friend to the public exhibition.');
 assert.equal(store.applyState(scope,{focus:'Old independent task focus',openThreads:[{text:'Old independent task follow-up',sourceIds:[`private:${turn.id}`]}]}, {baseRevision:store.getCompanion(scope).revision,sourceIds:[`private:${turn.id}`],coverage:{complete:false,sourceIds:[`private:${turn.id}`]}}).applied,true);
 assert.equal(store.applyTopicPatch(scope,{operation:'create',objective:'Discuss the exhibition invitation',purposeSourceIds:[`private:${turn.id}`],intentQuote:turn.text},options(store,turn)).applied,true);return store;}
test('model and UI closure leave the same single task owner and no independent state controls',t=>{
 for(const origin of ['model','ui']){const store=fixture(t),topic=store.topicView(scope).active;
  if(origin==='ui')assert.equal(store.topicAction(scope,{id:topic.id,expectedVersion:topic.version,operation:'complete'}).applied,true);
  else {const close=request(store,'Complete this exhibition discussion.');assert.equal(store.applyTopicPatch(scope,{operation:'complete',topicId:topic.id,purposeSourceIds:[`private:${close.id}`],intentQuote:close.text},options(store,close)).applied,true);}
  const c=store.getCompanion(scope);assert.equal(c.state.focus,'',`${origin} closure must not leave an independent active focus`);assert.deepEqual(c.state.openThreads,[],`${origin} closure must not leave independent follow-ups`);assert.deepEqual(c.state.unknowns,[]);assert.equal(store.topicView(scope).active,null);
 }
});

test('explicit controls use the same creation, correction, pause, resume and cancellation lifecycle',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());store.setGoal(scope,'Keep a mutually wanted friendship.');
 const first=store.topicAction(scope,{operation:'create',objective:'Discuss visiting the exhibition',direction:'Ask about the opening time',constraints:['Keep the question brief'],stage:'Discuss the direction'});
 assert.equal(first.applied,true);let topic=store.topicView(scope).active;assert.equal(topic.id,first.topicId);assert.equal(topic.observationAuthorities.stage,'private_task_state');
 const update=store.topicAction(scope,{id:topic.id,expectedVersion:topic.version,operation:'update',direction:'Offer my actual available time',progress:['I asked about the opening time']});
 topic=store.topicView(scope).active;assert.equal(topic.id,first.topicId);assert.equal(update.applied,true);assert.equal(topic.direction,'Offer my actual available time');assert.equal(topic.observationAuthorities.progress,'user_reported_progress');
 for(const [operation,lifecycle]of [['pause','paused'],['resume','active'],['cancel','cancelled']]){const current=store.getCompanion(scope).topics.items.find(item=>item.id===first.topicId);const receipt=store.topicAction(scope,{id:current.id,expectedVersion:current.version,operation});assert.equal(receipt.lifecycle,lifecycle);assert.equal(store.getCompanion(scope).consultationTask.active?.id||null,lifecycle==='active'?current.id:null);}
 assert.equal(store.getCompanion(scope).goal.text,'Keep a mutually wanted friendship.');
 const before=store.getCompanion(scope);assert.throws(()=>store.topicAction(scope,{id:first.topicId,expectedVersion:before.topics.items[0].version-1,operation:'resume'}),/话题/);assert.deepEqual(store.getCompanion(scope),before,'stale UI control leaves no synthetic command source');
});

test('bounded task views preserve all source-valid persisted history and can explicitly resume an older task',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const ids=[];
 for(let n=0;n<7;n++)ids.push(store.topicAction(scope,{operation:'create',objective:`Fictional consultation ${n}`}).topicId);
 const before=store.getCompanion(scope);assert.equal(before.topics.items.length,7);assert.equal(before.consultationTask.items.length,4);assert.equal(before.consultationTask.retainedCount,6);assert.equal(store.topicView(scope).items.length,4);
 const old=before.topics.items.find(item=>item.id===ids[0]);const resumed=store.topicAction(scope,{id:old.id,expectedVersion:old.version,operation:'resume'});assert.equal(resumed.topicId,ids[0]);assert.equal(store.topicView(scope).active.id,ids[0]);assert.equal(store.getCompanion(scope).topics.items.length,7);assert.ok(before.turns.every(turn=>store.getCompanion(scope).turns.some(current=>current.id===turn.id&&current.text===turn.text)));
});

test('a concurrent task closure cannot be overwritten by an older evidence-state CAS',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-task-state-cas-'));
 const filename=path.join(dir,'fictional.sqlite'),first=new Store(filename),second=new Store(filename);t.after(()=>{first.close();second.close();fs.rmSync(dir,{recursive:true,force:true});});
 const created=first.topicAction(scope,{operation:'create',objective:'Discuss the exhibition invitation'}),close=request(first,'Complete the exhibition discussion now.'),base=first.getCompanion(scope),readSources=first._sourceIds.bind(first);
 first._sourceIds=(...args)=>{first._sourceIds=readSources;const opts=options(second,close);assert.equal(second.applyTopicPatch(scope,{operation:'complete',topicId:created.topicId,purposeSourceIds:[`private:${close.id}`],intentQuote:close.text},opts).applied,true);return readSources(...args);};
 const result=first.applyState(scope,{items:[{text:'The user explicitly ended that discussion.',sourceIds:[`private:${close.id}`]}]},{baseRevision:base.revision,baseStateVersion:base.state.version,sourceIds:[`private:${close.id}`],coverage:{complete:false,sourceIds:[`private:${close.id}`]}});
 assert.equal(result.reason,'stale_topic_version');assert.equal(first.topicView(scope).active,null);assert.equal(first.topicView(scope).retained.at(-1).lifecycle,'completed');assert.equal(first.getCompanion(scope).revision,base.revision,'model metadata closure does not invent a new raw user message');
});

test('model and explicit UI task controls both invalidate old discussion checkpoints',t=>{
 const {DISCUSSION_COMPACTION_VERSION,discussionTopicBinding,discussionModelBinding,discussionCompactionEvidence}=require('../src/discussion-compaction-store.cjs');
 for(const origin of ['model','ui']){const store=fixture(t),first=store.getCompanion(scope).turns[0];store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Fictional generated exhibition discussion.',sourceIds:[`private:${first.id}`],requestId:first.requestId});const close=request(store,'Complete this exhibition discussion.'),c=store.getCompanion(scope),sourceTurnIds=c.turns.slice(0,2).map(turn=>turn.id);
 const binding={goalVersion:c.goal.version,topicVersion:c.topics.version,topicBinding:discussionTopicBinding(c),model:'synthetic',modelBinding:discussionModelBinding('http://fixture.invalid','synthetic'),promptVersion:'task-owner-probe',protocolVersion:DISCUSSION_COMPACTION_VERSION};
 const saved=store.saveDiscussionCompaction(scope,{...binding,...discussionCompactionEvidence(store,scope,sourceTurnIds),sourceTurnIds,summary:'An earlier discussion checkpoint.',quoteRefs:[],requestId:'checkpoint-probe'},{...binding,baseRevision:c.revision,currentTurnId:close.id});assert.equal(saved.applied,true,saved.detail||saved.reason);assert.ok(store.getDiscussionCompaction(scope,binding));
 const topic=store.topicView(scope).active;
 if(origin==='ui')store.topicAction(scope,{id:topic.id,expectedVersion:topic.version,operation:'complete'});
 else assert.equal(store.applyTopicPatch(scope,{operation:'complete',topicId:topic.id,purposeSourceIds:[`private:${close.id}`],intentQuote:close.text},options(store,close)).applied,true);
 assert.equal(store.getDiscussionCompaction(scope,binding),null,origin);assert.equal(store.db.prepare('SELECT count(*) n FROM discussion_compactions WHERE scope_key=?').get(store.scopeKey(scope)).n,0,origin);
 }
});
