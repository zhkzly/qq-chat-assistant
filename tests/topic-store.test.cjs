'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

function setup(t, filename = ':memory:') {
  const store = new Store(filename); t.after(() => store.close()); return store;
}
function user(store, text, requestId = `request-${store.getCompanion(scope).turns.length}`) {
  return store.appendTurn(scope, {role:'user',kind:'discussion',text,requestId});
}
function options(store, turn, extra = {}) {
  const sources = store.memorySources(scope);
  return {baseRevision:store.getCompanion(scope).revision,baseTopicVersion:store.topicView(scope).version,
    sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),
    currentSourceId:`private:${turn.id}`,origin:'private_discussion',requestId:turn.requestId,...extra};
}
function create(store, turn, extra = {}) {
  return store.applyTopicPatch(scope, {operation:'create',objective:'Express romantic interest naturally',direction:'Start with the exhibition we discussed',
    constraints:['Avoid discussing my private anxiety'],purposeSourceIds:[`private:${turn.id}`],intentQuote:turn.text,...extra}, options(store,turn));
}

test('bounded local purpose persists without changing global goals or treating drafts as sent evidence', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-topic-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'store.sqlite');let store=new Store(filename);
  const turn=user(store,'I want to show romantic interest through our exhibition topic.');
  store.setGoal(scope,'Develop a mutual romantic relationship');
  const beforeGeneration=store.contextGeneration(scope),result=create(store,turn);
  assert.equal(result.applied,true);assert.equal(result.changes,1);
  const topic=store.topicView(scope).active;
  assert.equal(topic.lifecycle,'active');assert.equal(topic.version,1);assert.equal(store.topicView(scope).version,1);
  assert.notEqual(store.contextGeneration(scope),beforeGeneration);
  store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Here is a draft.',requestId:turn.requestId});
  assert.deepEqual(store.topicView(scope).active,topic);
  assert.equal(store.getCompanion(scope).goal.text,'Develop a mutual romantic relationship');
  assert.equal(store.messages(scope).length,0);
  store.close();store=new Store(filename);t.after(()=>store.close());
  assert.deepEqual(store.topicView(scope).active,topic);
  for(const field of ['accountUid','accountUin','peerUid','peerUin'])assert.equal(store.topicView({...scope,[field]:`${scope[field]}-other`}).active,null);
});

test('purpose updates require delivered current private evidence and a literal intent quote', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');
  assert.equal(create(store,turn).applied,true);const before=store.topicView(scope),topicId=before.active.id;
  const current=user(store,'Actually I want to invite her directly.');
  const patch={operation:'update',topicId,direction:'Invite directly',constraints:[],purposeSourceIds:[`private:${current.id}`],intentQuote:'invite her directly'};
  const valid=options(store,current);
  for(const changed of [{sourceIds:[]},{sourceRevisions:{}},{currentSourceId:`private:${turn.id}`},{requestId:'foreign-request'},{origin:'qq_observation'}]){
    assert.equal(store.applyTopicPatch(scope,patch,{...valid,...changed}).applied,false);
    assert.deepEqual(store.topicView(scope),before);
  }
  assert.equal(store.applyTopicPatch(scope,{...patch,intentQuote:'not in the current message'},valid).applied,false);
  assert.equal(store.applyTopicPatch(scope,{...patch,purposeSourceIds:[`private:${turn.id}`]},valid).applied,false);
  assert.equal(store.applyTopicPatch(scope,patch,valid).applied,true);
  assert.equal(store.topicView(scope).active.id,topicId);assert.equal(store.topicView(scope).active.direction,'Invite directly');
  assert.equal(store.topicView(scope).active.objective,before.active.objective);
  assert.deepEqual(store.topicView(scope).active.constraints,[]);
});

test('real incoming and sent QQ update observations without rewriting purpose or restarting a closed topic', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');create(store,turn);
  const topicId=store.topicView(scope).active.id;
  const incoming=normalize(raw(),scope);store.add(scope,[incoming]);
  const source=`qq:${incoming.messageId}`;
  const observed={operation:'update',topicId,stage:'Invitation discussed',progress:['She replied about the exhibition'],unknowns:['Whether she welcomes a romantic invitation'],observationSourceIds:[source]};
  assert.equal(store.applyTopicPatch(scope,observed,options(store,turn,{origin:'qq_observation',currentSourceId:source})).applied,true);
  assert.equal(store.topicView(scope).active.direction,'Start with the exhibition we discussed');
  assert.equal(store.applyTopicPatch(scope,{...observed,direction:'Keep things permanently subtle'},options(store,turn,{origin:'qq_observation',currentSourceId:source})).applied,false);
  const close=user(store,'Pause that topic for now.');
  assert.equal(store.applyTopicPatch(scope,{operation:'pause',topicId,purposeSourceIds:[`private:${close.id}`],intentQuote:'Pause that topic'},options(store,close)).applied,true);
  assert.equal(store.topicView(scope).active,null);
  const sent=normalize({...raw('72057594037927940'),senderUid:scope.accountUid,senderUin:scope.accountUin},scope);store.add(scope,[sent]);
  assert.equal(store.applyTopicPatch(scope,{...observed,observationSourceIds:[`qq:${sent.messageId}`]},options(store,close,{origin:'qq_observation',currentSourceId:`qq:${sent.messageId}`})).applied,false);
  assert.equal(store.topicView(scope).active,null);assert.equal(store.topicView(scope).retained[0].lifecycle,'paused');
});

test('forget and correction remove exact derived fields immediately while preserving independent purpose', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');create(store,turn);
  const topicId=store.topicView(scope).active.id,message=normalize(raw(),scope);store.add(scope,[message]);
  const observation={operation:'update',topicId,stage:'Reply received',progress:['Grounded QQ reply'],observationSourceIds:[`qq:${message.messageId}`]};
  assert.equal(store.applyTopicPatch(scope,observation,options(store,turn,{origin:'qq_observation',currentSourceId:`qq:${message.messageId}`})).applied,true);
  store.add(scope,[{...message,text:'Corrected actual message'}]);
  let topic=store.topicView(scope).active;
  assert.equal(topic.stage,'');assert.deepEqual(topic.progress,[]);assert.deepEqual(topic.observationSourceIds,[]);
  assert.equal(topic.direction,'Start with the exhibition we discussed');
  store.updateTurn(scope,turn.id,'I corrected my earlier purpose.');
  assert.equal(store.topicView(scope).active,null);assert.deepEqual(store.topicView(scope).items,[]);
  const next=user(store,'I want to invite her directly.');create(store,next);
  store.forgetSource(scope,`private:${next.id}`);assert.equal(store.topicView(scope).active,null);
  assert.equal(JSON.stringify(store.getCompanion(scope)).includes('Express romantic interest naturally'),false);
});

test('topic CAS rejects stale results and source revisions after correction or contact changes', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');
  const base=options(store,turn);assert.equal(create(store,turn).applied,true);
  assert.equal(store.applyTopicPatch(scope,{operation:'create',objective:'late',purposeSourceIds:[`private:${turn.id}`],intentQuote:turn.text},base).reason,'stale_topic_version');
  const current=user(store,'I want a different approach.');
  const opts=options(store,current),patch={operation:'update',topicId:store.topicView(scope).active.id,direction:'Different approach',purposeSourceIds:[`private:${current.id}`],intentQuote:'different approach'};
  store.updateTurn(scope,current.id,'Corrected current request');
  assert.equal(store.applyTopicPatch(scope,patch,opts).reason,'stale_revision');
  assert.equal(store.applyTopicPatch({...scope,peerUin:'other'},patch,opts).applied,false);
});

test('one active plus three retained and explicit resume preserve lifecycle and stable identities', t=>{
  const store=setup(t);const ids=[];
  for(let n=0;n<6;n++){const turn=user(store,`I want to discuss approach ${n}.`);assert.equal(create(store,turn,{objective:`Local purpose ${n}`}).applied,true);ids.push(store.topicView(scope).active.id);}
  let view=store.topicView(scope);assert.equal(view.items.length,4);assert.equal(view.retained.length,3);
  assert.equal(view.items.filter(t=>t.lifecycle==='active').length,1);assert.deepEqual(new Set(view.items.map(t=>t.id)),new Set(ids.slice(-4)));
  const topicId=view.active.id,finish=user(store,'Complete this local topic.');
  assert.equal(store.applyTopicPatch(scope,{operation:'complete',topicId,purposeSourceIds:[`private:${finish.id}`],intentQuote:'Complete this local topic'},options(store,finish)).applied,true);
  assert.equal(store.topicView(scope).active,null);
  const vague=user(store,'Give me a sentence.');
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId,stage:'Again',observationSourceIds:[`private:${vague.id}`]},options(store,vague)).applied,false);
  const resume=user(store,'Resume the previous invitation topic.');
  assert.equal(store.applyTopicPatch(scope,{operation:'resume',topicId,purposeSourceIds:[`private:${resume.id}`],intentQuote:'Resume the previous invitation topic'},options(store,resume)).applied,true);
  view=store.topicView(scope);assert.equal(view.active.id,topicId);assert.ok(view.retained.length<=3);
});

test('generated, foreign, copied feedback, oversized and unauthorized fields are rejected atomically', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');
  const assistant=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Invented direction',requestId:'assistant-only'});
  // F1: requestId-only resolution removed; bind the retained artifact with its digest
  const feedback=store.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:assistant.artifactRef},expectedDigest:store.experiences.artifact(scope,assistant.artifactRef).bodyDigest,text:'Too subtle',kind:'local'});
  const note=store.saveNote(scope,{text:'Copied feedback',use:'discussion',evidenceSourceIds:[`private:feedback-${feedback.id}`]});
  const patch={operation:'create',objective:'Romantic purpose',purposeSourceIds:[`private:${turn.id}`],intentQuote:turn.text};
  for(const changed of [{purposeSourceIds:[`private:${assistant.id}`]},{purposeSourceIds:[`note:${note.id}`]},{objective:'x'.repeat(801)},{constraints:Array(9).fill('x')},{send:true},{lifecycle:'active'}]){
    assert.equal(store.applyTopicPatch(scope,{...patch,...changed},options(store,turn)).applied,false);assert.equal(store.topicView(scope).version,0);
  }
  const fresh=user(store,'I want to show romantic interest through our exhibition topic.');
  assert.equal(store.applyTopicPatch(scope,{...patch,purposeSourceIds:[`private:${fresh.id}`],intentQuote:fresh.text},options(store,fresh)).applied,true);
  const before=store.topicView(scope);
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId:before.active.id,progress:['Assistant draft sent'],observationSourceIds:[`private:${assistant.id}`]},options(store,fresh)).applied,false);
  assert.deepEqual(store.topicView(scope),before);
});

test('canonical local feedback can explicitly correct direction without becoming a preference or duplicate factual turn', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');create(store,turn);
  const previousAdvice=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Try a subtle invitation.',requestId:'previous-advice'});
  const feedback=store.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:previousAdvice.artifactRef},expectedDigest:store.experiences.artifact(scope,previousAdvice.artifactRef).bodyDigest,text:'I want to be direct for this invitation.',kind:'local'});
  const neutral=store.appendTurn(scope,{role:'user',kind:'feedback_continue',text:'Continue discussing this feedback.',requestId:'feedback-continuation'}),currentSourceId=`private:feedback-${feedback.id}`;
  const patch={operation:'update',topicId:store.topicView(scope).active.id,direction:'Use a direct invitation this time',purposeSourceIds:[currentSourceId],intentQuote:'direct for this invitation',interpretationStatus:'user_stated'};
  const opts=options(store,neutral,{currentSourceId,currentFeedbackId:feedback.id,canonicalActorId:currentSourceId,origin:'user_feedback'});
  assert.equal(store.applyTopicPatch(scope,patch,{...opts,currentFeedbackId:'foreign'}).applied,false);
  assert.equal(store.applyTopicPatch(scope,patch,opts).applied,true);
  assert.equal(store.topicView(scope).active.direction,'Use a direct invitation this time');
  assert.equal(store.topicView(scope).active.interpretationStatus,'user_stated');
  assert.equal(store.getCompanion(scope).notes.length,0);assert.equal(store.getCompanion(scope).goal.text,'');
  assert.equal(store.getCompanion(scope).turns.filter(t=>t.kind!=='feedback_ref'&&t.text===feedback.text).length,0);
  store.forgetSource(scope,currentSourceId);assert.equal(store.topicView(scope).active,null);
});

test('QQ completion is local and revision-bound; a recall does not reactivate the purpose', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');create(store,turn);
  store.setGoal(scope,'Mutual romantic relationship');
  const resumed=user(store,'Resume the invitation topic under this goal.');
  const topicId=store.topicView(scope).retained[0].id;
  assert.equal(store.applyTopicPatch(scope,{operation:'resume',topicId,purposeSourceIds:[`private:${resumed.id}`],intentQuote:resumed.text},options(store,resumed)).applied,true);
  const message=normalize(raw(),scope);store.add(scope,[message]);const currentSourceId=`qq:${message.messageId}`;
  const opts=options(store,resumed,{origin:'qq_observation',currentSourceId,activeId:topicId});
  const patch={operation:'complete',topicId,stage:'Local invitation exchange finished',observationSourceIds:[currentSourceId]};
  assert.equal(store.applyTopicPatch(scope,patch,{...opts,activeId:'other'}).reason,'stale_active_topic');
  assert.equal(store.applyTopicPatch(scope,patch,opts).applied,true);
  assert.equal(store.topicView(scope).active,null);assert.equal(store.topicView(scope).retained[0].lifecycle,'completed');
  assert.equal(store.getCompanion(scope).goal.text,'Mutual romantic relationship');
  store.add(scope,[{...message,text:'[已撤回]',recalled:true,media:[]}]);
  assert.equal(store.topicView(scope).active,null);assert.equal(store.topicView(scope).retained[0].lifecycle,'paused');
  assert.equal(store.topicView(scope).retained[0].lifecycleEvidenceStatus,'needs_review');
});

test('explicit broader goal changes pause local purpose; identical goal leaves it active', t=>{
  const store=setup(t);store.setGoal(scope,'Mutual romantic relationship');
  const turn=user(store,'I want to show romantic interest through our exhibition topic.');create(store,turn);
  const before=store.topicView(scope);store.setGoal(scope,'Mutual romantic relationship');assert.deepEqual(store.topicView(scope),before);
  store.setGoal(scope,'Stay friends and do not pursue romance');
  const after=store.topicView(scope);assert.equal(after.active,null);assert.equal(after.retained[0].id,before.active.id);
  assert.equal(after.retained[0].lifecycle,'paused');assert.equal(after.retained[0].lifecycleEvidenceStatus,'goal_changed_needs_review');
  assert.equal(after.version,before.version+1);
});

test('observed progress rejects older QQ backfill and accepts later actual sent messages', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');create(store,turn);
  const topicId=store.topicView(scope).active.id;
  const newest=normalize(raw('72057594037927942',false,{msgTime:'1791726100'}),scope);store.add(scope,[newest]);
  const update=(message,stage)=>store.applyTopicPatch(scope,{operation:'update',topicId,stage,observationSourceIds:[`qq:${message.messageId}`]},options(store,turn,{origin:'qq_observation',currentSourceId:`qq:${message.messageId}`}));
  assert.equal(update(newest,'Latest incoming').applied,true);
  const older=normalize(raw('72057594037927941',false,{msgTime:'1791726000'}),scope);store.add(scope,[older]);
  assert.equal(update(older,'Old backfill').applied,false);assert.equal(store.topicView(scope).active.stage,'Latest incoming');
  const sent=normalize(raw('72057594037927943',true,{msgTime:'1791726200'}),scope);store.add(scope,[sent]);
  assert.equal(update(sent,'Actually sent').applied,true);assert.equal(store.topicView(scope).active.stage,'Actually sent');
});

test('superseded corrections do not accumulate as current support; unchanged objective retains its grounding', t=>{
  const store=setup(t),initial=user(store,'I want to show romantic interest through our exhibition topic.');create(store,initial);
  const topicId=store.topicView(scope).active.id,corrections=[];
  for(let n=0;n<20;n++){
    const turn=user(store,`Use direction ${n} for this local invitation.`);corrections.push(turn);
    const patch={operation:'update',topicId,direction:`Direction ${n}`,purposeSourceIds:[`private:${turn.id}`],intentQuote:turn.text};
    assert.equal(store.applyTopicPatch(scope,patch,options(store,turn)).applied,true);
  }
  let topic=store.topicView(scope).active;
  assert.deepEqual(new Set(topic.purposeSourceIds),new Set([`private:${initial.id}`,`private:${corrections.at(-1).id}`]));
  store.forgetSource(scope,`private:${corrections[0].id}`);
  topic=store.topicView(scope).active;assert.equal(topic.id,topicId);assert.equal(topic.direction,'Direction 19');
  store.forgetSource(scope,`private:${initial.id}`);assert.equal(store.topicView(scope).active,null);
});

test('two connections cannot overwrite an already committed topic or revised source; failed QQ batches preserve topic', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-topic-cas-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'state.sqlite'),first=setup(t,filename),second=setup(t,filename);
  const turn=user(first,'I want to show romantic interest through our exhibition topic.'),before=options(second,turn);
  const patch={operation:'create',objective:'Current purpose',purposeSourceIds:[`private:${turn.id}`],intentQuote:turn.text};
  assert.equal(first.applyTopicPatch(scope,patch,before).applied,true);
  assert.equal(second.applyTopicPatch(scope,patch,before).reason,'stale_topic_version');
  const topic=first.topicView(scope),message=normalize(raw(),scope);first.add(scope,[message]);
  const recorded=first.getCompanion(scope);
  assert.throws(()=>first.add(scope,[{...message,text:'Uncommitted change'},{...message,messageId:'invalid-draft',kind:'draft'}]),/provenance/);
  assert.deepEqual(first.getCompanion(scope),recorded);assert.deepEqual(first.topicView(scope),topic);
  // Structural reason (D1): schema 3 adds the observation log, fingerprinted
  // revisions and M2 quarantine/overlay/upgrade storage.
  assert.equal(first.db.prepare('PRAGMA user_version').get().user_version,3);
  assert.equal(second.db.prepare('PRAGMA user_version').get().user_version,3);
});

test('a source-grounded private task phase and unknowns do not require inventing QQ observations', t=>{
  const store=setup(t),turn=user(store,'I want to care about her state after the exam, without asking scores. Just discuss the direction first.');
  const result=create(store,turn,{objective:'Ask how she feels after the exam',direction:'Care lightly without assuming she is tired',constraints:['Do not ask exam scores'],stage:'Discuss the direction of this care',progress:[],unknowns:['Her actual state is unknown'],observationSourceIds:[]});
  assert.equal(result.applied,true,result.detail||result.reason);
  const topic=store.topicView(scope).active;
  assert.equal(topic.stage,'Discuss the direction of this care');assert.deepEqual(topic.progress,[]);
  assert.equal(topic.observationAuthorities.stage,'private_task_state');assert.equal(topic.observationAuthorities.unknowns,'private_task_state');
  assert.deepEqual(topic.observationBindings.progress.sourceIds,[`private:${turn.id}`]);
  assert.deepEqual(new Set(topic.observationSourceIds),new Set([`private:${turn.id}`]));
  store.forgetSource(scope,`private:${turn.id}`);assert.equal(store.topicView(scope).active,null);
});

test('private task fallback cannot establish nonempty progress, relax source checks, or authorize QQ purpose changes', t=>{
  const store=setup(t),turn=user(store,'I want to care about her exam state.');
  assert.equal(create(store,turn,{stage:'Private planning',progress:['She accepted'],observationSourceIds:[]}).applied,false);
  assert.equal(create(store,turn,{stage:'Private planning',purposeSourceIds:[],observationSourceIds:[]}).applied,false);
  assert.equal(create(store,turn,{stage:'Private planning',intentQuote:'unavailable quote',observationSourceIds:[]}).applied,false);
  assert.equal(create(store,turn).applied,true);const topicId=store.topicView(scope).active.id;
  const message=normalize(raw(),scope);store.add(scope,[message]);
  const patch={operation:'update',topicId,stage:'Observed progress',unknowns:['Whether she accepted'],observationSourceIds:[]};
  assert.equal(store.applyTopicPatch(scope,patch,options(store,turn,{origin:'qq_observation',currentSourceId:`qq:${message.messageId}`})).applied,false);
  const current=user(store,'Change this purpose to exam care.');
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId,direction:'Care about exam state',stage:'Discuss how to care',unknowns:['Her state'],purposeSourceIds:[`private:${current.id}`],intentQuote:current.text},options(store,current)).applied,true);
  assert.equal(store.topicView(scope).active.observationAuthorities.stage,'private_task_state');
});

test('all-empty observation clearing needs no fabricated evidence and preserves user purpose', t=>{
  const store=setup(t),turn=user(store,'I want to show romantic interest through our exhibition topic.');create(store,turn);
  const topicId=store.topicView(scope).active.id,message=normalize(raw(),scope);store.add(scope,[message]);
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId,stage:'Received a reply',progress:['Actual reply'],unknowns:['Next opportunity'],observationSourceIds:[`qq:${message.messageId}`]},options(store,turn,{origin:'qq_observation',currentSourceId:`qq:${message.messageId}`})).applied,true);
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId,stage:'',progress:[],unknowns:[],observationSourceIds:[]},options(store,turn)).applied,true);
  const topic=store.topicView(scope).active;assert.equal(topic.stage,'');assert.deepEqual(topic.progress,[]);assert.deepEqual(topic.unknowns,[]);
  assert.deepEqual(topic.observationSourceIds,[`private:${turn.id}`]);assert.equal(topic.objective,'Express romantic interest naturally');
  assert.equal(topic.observationAuthorities.progress,'cleared');
  const wrongActor=options(store,turn,{currentSourceId:'private:unknown',requestId:'wrong'});
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId,progress:[]},wrongActor).applied,false);
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId,progress:[]},options(store,turn,{origin:'qq_observation',currentSourceId:`qq:${message.messageId}`})).applied,false);
  assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId,progress:[],observationSourceIds:[`qq:${message.messageId}`]},options(store,turn,{origin:'qq_observation',currentSourceId:`qq:${message.messageId}`})).applied,true);
});

test('a new explicit output request can refresh the private task phase without rewriting the conversational purpose', t=>{
  const store=setup(t),initial=user(store,'Just discuss how to care about her exam state first.');create(store,initial);
  const before=store.topicView(scope).active,current=user(store,'Now give me a concrete editable sentence.');
  const patch={operation:'update',topicId:before.id,stage:'Reference expression ready for user review; sending not observed',unknowns:['Her state remains unknown'],progress:[],purposeSourceIds:[`private:${current.id}`],intentQuote:current.text};
  assert.equal(store.applyTopicPatch(scope,patch,options(store,current)).applied,true);
  const after=store.topicView(scope).active;assert.equal(after.objective,before.objective);assert.equal(after.direction,before.direction);assert.deepEqual(after.constraints,before.constraints);
  assert.equal(after.observationAuthorities.stage,'private_task_state');assert.equal(after.stage,patch.stage);
  assert.deepEqual(after.observationBindings.progress.sourceIds,[`private:${current.id}`]);
});

test('canonical feedback and its note copies control a task but cannot establish external progress', t=>{
  const store=setup(t),initial=user(store,'Discuss this invitation.');create(store,initial);
  const evaluated=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'An invitation draft.',requestId:'feedback-evaluated'});
  const feedback=store.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:evaluated.artifactRef},expectedDigest:store.experiences.artifact(scope,evaluated.artifactRef).bodyDigest,text:'Use a lighter direction for this draft.'});
  const note=store.saveNote(scope,{text:'Copied local feedback',use:'discussion',evidenceSourceIds:[feedback.sourceId]});
  const current=user(store,'Review the observed progress.');
  for(const id of [feedback.sourceId,`note:${note.id}`])assert.equal(store.applyTopicPatch(scope,{operation:'update',topicId:store.topicView(scope).active.id,progress:['She accepted the invitation'],observationSourceIds:[id]},options(store,current)).applied,false);
});
