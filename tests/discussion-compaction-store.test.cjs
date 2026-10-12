'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {DISCUSSION_COMPACTION_VERSION,discussionTurnFingerprint,discussionTopicBinding,discussionModelBinding,discussionCompactionEvidence,eligibleDiscussionTurns}=require('../src/discussion-compaction-store.cjs');

function fixture(t,filename=':memory:') {
  const store=new Store(filename);t.after(()=>store.close());
  store.setGoal(scope,'Develop a mutually wanted romantic relationship');
  const qq=normalize(raw(),scope);store.add(scope,[qq]);
  const first=store.appendTurn(scope,{role:'user',kind:'discussion',text:'I want to ask about the exhibition naturally.',requestId:'first-discussion'});
  const firstAnswer=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Original generated discussion. '+'Long explanation. '.repeat(90),sourceIds:[`private:${first.id}`,`qq:${qq.messageId}`],requestId:'first-discussion'});
  const correction=store.appendTurn(scope,{role:'user',kind:'discussion',text:'This time be direct, but do not ask unrelated follow-up questions.',requestId:'correct-direction'});
  const answer=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Use the direct invitation for this request.',sourceIds:[`private:${correction.id}`],requestId:'correct-direction',
    suggestions:[{style:'natural',text:'Would you like to visit the exhibition together?'}],
    expressionOptions:[{label:'Direct exhibition invitation',quotes:[{sourceId:`private:${correction.id}`,text:'This time be direct'}],style:'natural'}]});
  const current=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Give me the concrete sentence.',requestId:'current-discussion'});
  const sourceTurnIds=[first.id,firstAnswer.id,correction.id,answer.id];
  const binding=()=>{const companion=store.getCompanion(scope);return {goalVersion:companion.goal.version,topicVersion:companion.topics.version,topicBinding:discussionTopicBinding(companion),
    model:'synthetic-model',modelBinding:discussionModelBinding('http://synthetic.invalid/v1','synthetic-model'),promptVersion:'synthetic-compaction-prompt',protocolVersion:DISCUSSION_COMPACTION_VERSION};};
  const input=(extra={})=>({...binding(),...discussionCompactionEvidence(store,scope,sourceTurnIds),sourceTurnIds,summary:'The current discussion concerns a direct exhibition invitation, without unrelated follow-ups. Older assistant wording is generated discussion.',quoteRefs:[{turnId:correction.id,role:'user',field:'text',text:'This time be direct'},
    {turnId:answer.id,role:'assistant',field:'suggestions',index:0,text:'Would you like to visit the exhibition together?',artifactRef:answer.suggestions[0].artifactRef}],requestId:'compaction-request',...extra});
  const expected=()=>({...binding(),baseRevision:store.getCompanion(scope).revision,currentTurnId:current.id});
  return {store,qq,first,firstAnswer,correction,answer,current,sourceTurnIds,binding,input,expected};
}
function save(f,extra={}){const result=f.store.saveDiscussionCompaction(scope,f.input(extra),f.expected());assert.equal(result.applied,true,result.detail||result.reason);return result;}

test('derived compaction persists without changing raw history, source generation, facts or assistant artifacts',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-discussion-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'state.sqlite'),f=fixture(t,filename),before=f.store.getCompanion(scope),sources=f.store.memorySources(scope),generation=f.store.contextGeneration(scope);
  const result=save(f),cached=f.store.getDiscussionCompaction(scope,{...f.binding(),currentTurnId:f.current.id});
  assert.equal(cached.id,result.id);assert.equal(cached.summary,f.input().summary);assert.equal(cached.authority,'derived_discussion_checkpoint_not_factual_evidence');
  assert.deepEqual(f.store.getCompanion(scope),before);assert.deepEqual(f.store.memorySources(scope),sources);assert.equal(f.store.contextGeneration(scope),generation);
  assert.equal(cached.quoteRefs[1].authority,'generated_discussion_not_outbound_authorization');assert.equal(cached.quoteRefs[0].authority,'private_user_statement_not_outbound_authorization');
  assert.equal(f.store.messages(scope)[0].messageId,f.qq.messageId);assert.equal(f.store.memorySources(scope).some(s=>s.text===cached.summary),false);
  const second=new Store(filename);t.after(()=>second.close());assert.deepEqual(second.getDiscussionCompaction(scope,f.binding()),cached);
  const persisted=JSON.parse(f.store.db.prepare('SELECT record FROM discussion_compactions WHERE scope_key=?').get(f.store.scopeKey(scope)).record);
  assert.equal(JSON.stringify(persisted).includes(f.firstAnswer.text),false,'cache retains no whole generated input closure');
});

test('coverage can be a contiguous inner slice or assistant-only fold while the current request is never covered',t=>{
  const f=fixture(t),ids=[f.correction.id,f.answer.id];
  const record=f.input({...discussionCompactionEvidence(f.store,scope,ids),sourceTurnIds:ids});
  assert.equal(f.store.saveDiscussionCompaction(scope,record,f.expected()).applied,true);
  const assistantOnly=f.input({...discussionCompactionEvidence(f.store,scope,[f.answer.id]),sourceTurnIds:[f.answer.id],quoteRefs:[{turnId:f.answer.id,role:'assistant',field:'text',text:'direct invitation'}]});
  assert.equal(f.store.saveDiscussionCompaction(scope,assistantOnly,f.expected()).applied,true);
  for(const sourceTurnIds of [[f.first.id,f.answer.id],[f.answer.id,f.correction.id],[f.current.id]]){
    const rawRecord=f.input({sourceTurnIds,turnFingerprints:Object.fromEntries(f.store.getCompanion(scope).turns.filter(t=>sourceTurnIds.includes(t.id)).map(t=>[t.id,discussionTurnFingerprint(t)])),coverage:{firstTurnId:sourceTurnIds[0],lastTurnId:sourceTurnIds.at(-1),turnCount:sourceTurnIds.length},quoteRefs:[]});
    assert.equal(f.store.saveDiscussionCompaction(scope,rawRecord,f.expected()).applied,false);
  }
  assert.equal(f.store.getDiscussionCompaction(scope,{...f.binding(),currentTurnId:f.answer.id}),null);
});

test('scope, endpoint/model, goal and prompt bindings cannot reuse another conversation or task interpretation',t=>{
  const f=fixture(t);save(f);
  for(const field of ['accountUid','accountUin','peerUid','peerUin'])assert.equal(f.store.getDiscussionCompaction({...scope,[field]:`${scope[field]}-other`},f.binding()),null);
  for(const changed of [{model:'other-model'},{modelBinding:discussionModelBinding('http://another.invalid/v1','synthetic-model')},{promptVersion:'changed-prompt'},{protocolVersion:'future-protocol'},{goalVersion:99},{topicBinding:'0'.repeat(64)}])assert.equal(f.store.getDiscussionCompaction(scope,{...f.binding(),...changed}),null);
  f.store.setGoal(scope,'Stay friends without romantic pursuit');assert.equal(f.store.getDiscussionCompaction(scope,f.binding()),null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_compactions WHERE scope_key=?').get(f.store.scopeKey(scope)).n,0);
});

test('current purpose changes invalidate cache while purely observed topic progress can reuse it',t=>{
  const f=fixture(t),before=f.store.getCompanion(scope),sources=f.store.memorySources(scope);
  const rootOpts={baseRevision:before.revision,baseTopicVersion:before.topics.version,sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision])),currentSourceId:`private:${f.current.id}`,requestId:f.current.requestId,origin:'private_discussion'};
  assert.equal(f.store.applyTopicPatch(scope,{operation:'create',objective:'Direct exhibition invitation',direction:'Ask directly',constraints:['No unrelated follow-ups'],purposeSourceIds:[`private:${f.current.id}`],intentQuote:f.current.text},rootOpts).applied,true);
  save(f);const topic=f.store.topicView(scope).active,binding=f.binding();
  assert.equal(f.store.applyTopicPatch(scope,{operation:'update',topicId:topic.id,stage:'A QQ reply was observed',observationSourceIds:[`qq:${f.qq.messageId}`]}, {...rootOpts,baseTopicVersion:f.store.topicView(scope).version,currentSourceId:`qq:${f.qq.messageId}`,origin:'qq_observation'}).applied,true);
  assert.notEqual(f.store.topicView(scope).version,binding.topicVersion);assert.equal(f.binding().topicBinding,binding.topicBinding);assert.ok(f.store.getDiscussionCompaction(scope,f.binding()));
  const next=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'Use a lighter approach this time.',requestId:'change-purpose'}),live=f.store.memorySources(scope);
  assert.equal(f.store.applyTopicPatch(scope,{operation:'update',topicId:topic.id,direction:'Use a lighter approach',purposeSourceIds:[`private:${next.id}`],intentQuote:next.text},{...rootOpts,baseRevision:f.store.getCompanion(scope).revision,baseTopicVersion:f.store.topicView(scope).version,currentSourceId:`private:${next.id}`,requestId:next.requestId,sourceIds:live.map(s=>s.id),sourceRevisions:Object.fromEntries(live.map(s=>[s.id,s.revision]))}).applied,true);
  assert.equal(f.store.getDiscussionCompaction(scope,f.binding()),null);
});

test('source corrections, forgetting and deleted covered outputs immediately remove derived cached text',t=>{
  for(const action of ['user-correction','source-forget','assistant-delete','qq-recall']){
    const f=fixture(t);save(f);
    if(action==='user-correction')f.store.updateTurn(scope,f.correction.id,'Corrected purpose');
    if(action==='source-forget')f.store.forgetSource(scope,`private:${f.first.id}`);
    if(action==='assistant-delete')f.store.deleteTurn(scope,f.answer.id);
    if(action==='qq-recall')f.store.add(scope,[{...f.qq,recalled:true,text:'[已撤回]',media:[]}]);
    assert.equal(f.store.getDiscussionCompaction(scope,f.binding()),null,action);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_compactions WHERE scope_key=?').get(f.store.scopeKey(scope)).n,0,action);
  }
});

test('late save cannot commit after a source or companion revision changed',t=>{
  const f=fixture(t),record=f.input(),expected=f.expected();f.store.updateTurn(scope,f.correction.id,'Changed during compaction');
  assert.equal(f.store.saveDiscussionCompaction(scope,record,expected).applied,false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_compactions').get().n,0);
});

test('turn fingerprint covers generated candidate fields and artifact versions even without a user revision change',t=>{
  const f=fixture(t);save(f);
  const before=f.store.getCompanion(scope),generation=f.store.contextGeneration(scope),record=structuredClone(before);
  record.turns.find(t=>t.id===f.answer.id).suggestions[0].text='Changed candidate body';
  f.store.db.prepare('UPDATE companion SET record=? WHERE scope_key=?').run(f.store._serializeCompanion(record),f.store.scopeKey(scope));
  assert.equal(f.store.contextGeneration(scope),generation);assert.equal(f.store.getDiscussionCompaction(scope,f.binding()),null);
  const original=before.turns.find(t=>t.id===f.answer.id);
  for(const field of ['text','suggestions','expressionOptions','artifactRef']){const changed=structuredClone(original);changed[field]=field==='text'?'different':field==='artifactRef'?{...changed[field],version:999}:[];assert.notEqual(discussionTurnFingerprint(changed),discussionTurnFingerprint(original));}
});

test('quote references are literal role/field/index references and cannot promote generated wording to QQ fact',t=>{
  const f=fixture(t);
  for(const quoteRefs of [[{turnId:f.answer.id,role:'user',text:'direct invitation'}],[{turnId:f.answer.id,role:'assistant',field:'text',text:'Invented wording'}],[{turnId:f.answer.id,role:'assistant',field:'suggestions',index:8,text:'missing'}],[{turnId:f.current.id,role:'user',field:'text',text:f.current.text}],[{turnId:f.answer.id,role:'assistant',field:'suggestions',index:0,text:'Would you like',artifactRef:{artifactId:'wrong',version:1}}]])assert.equal(f.store.saveDiscussionCompaction(scope,f.input({quoteRefs}),f.expected()).applied,false);
  const quoteRefs=[{turnId:f.answer.id,role:'assistant',field:'expressionOptions',index:0,text:'Direct exhibition invitation'}, {turnId:f.answer.id,role:'assistant',field:'expressionOptions',index:0,quoteIndex:0,text:'This time be direct',sourceIds:[`private:${f.correction.id}`]}];
  const saved=save(f,{quoteRefs});assert.ok(saved.record.quoteRefs.every(q=>q.authority==='generated_discussion_not_outbound_authorization'));
  assert.equal(f.store.saveDiscussionCompaction(scope,f.input({qqMessagesSent:1}),f.expected()).applied,false);
});

test('cache summary is UTF-8 bounded, idempotent and retained at most three per scope',t=>{
  const f=fixture(t);assert.equal(f.store.saveDiscussionCompaction(scope,f.input({summary:'中'.repeat(2667)}),f.expected()).applied,false);
  const first=save(f,{summary:'中'.repeat(2666)});assert.equal(save(f,{summary:'中'.repeat(2666)}).id,first.id);
  for(let n=0;n<5;n++)save(f,{summary:`Current task checkpoint ${n}`});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_compactions WHERE scope_key=?').get(f.store.scopeKey(scope)).n,3);
  assert.equal(f.store.getDiscussionCompaction(scope,f.binding()).summary,'Current task checkpoint 4');
});

test('excluded user groups and canonical feedback aliases are not original compaction turns',t=>{
  const f=fixture(t);f.store.markTurnControl(scope,f.first.id);
  const remaining=eligibleDiscussionTurns(f.store.getCompanion(scope));assert.equal(remaining.some(t=>t.id===f.first.id||t.id===f.firstAnswer.id),false);
  assert.throws(()=>discussionCompactionEvidence(f.store,scope,[f.first.id]),/turn|excluded|coverage/i);
  const evaluated=f.store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Feedback target',requestId:'target-only'}),feedback=f.store.addFeedback(scope,{requestId:evaluated.requestId,text:'Local complaint'});
  const alias=f.store.getCompanion(scope).turns.find(t=>t.feedbackId===feedback.id);assert.equal(eligibleDiscussionTurns(f.store.getCompanion(scope)).some(t=>t.id===alias.id),false);
  assert.throws(()=>discussionCompactionEvidence(f.store,scope,[alias.id]),/turn|excluded|coverage/i);
});

test('transient quick replies may cache original history without storing or summarizing the virtual current request',t=>{
  const f=fixture(t),expected={...f.expected(),currentTurnId:'virtual-quick-reply',transient:true},generation=f.store.contextGeneration(scope),before=f.store.getCompanion(scope);
  assert.equal(f.store.saveDiscussionCompaction(scope,f.input(),{...expected,transient:false}).applied,false);
  assert.equal(f.store.saveDiscussionCompaction(scope,f.input(),expected).applied,true);
  assert.deepEqual(f.store.getCompanion(scope),before);assert.equal(f.store.contextGeneration(scope),generation);
  assert.equal(f.store.getDiscussionCompaction(scope,{...f.binding(),currentTurnId:'virtual-quick-reply'}).sourceTurnIds.includes('virtual-quick-reply'),false);
  assert.equal(f.store.saveDiscussionCompaction(scope,f.input(),{...expected,currentTurnId:f.answer.id}).applied,false);
  assert.equal(f.store.saveDiscussionCompaction(scope,f.input(),{...expected,baseRevision:0}).applied,false);
});

test('deleting an original summarized assistant invalidates dependent answers and feedback through the derived chain',t=>{
  const f=fixture(t),cache=save(f).record,refs=Object.entries(cache.sourceRevisions).map(([sourceId,revision])=>({sourceId,revision}));
  const answer=f.store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'A response that consumed the checkpoint.',requestId:'derived-response',sourceIds:Object.keys(cache.sourceRevisions),artifactMetadata:{inputSourceRefs:refs,discussionTurnFingerprints:cache.turnFingerprints}});
  assert.deepEqual(answer.discussionTurnFingerprints,cache.turnFingerprints);
  f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'Continue this explanation.',requestId:'derived-follow-up'});
  const childRefs={...cache.turnFingerprints,[answer.id]:discussionTurnFingerprint(answer)};
  const child=f.store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Later dependent explanation.',requestId:'derived-child',sourceIds:Object.keys(cache.sourceRevisions),artifactMetadata:{inputSourceRefs:refs,discussionTurnFingerprints:childRefs}});
  f.store.addFeedback(scope,{requestId:child.requestId,text:'A local response evaluation.'});
  assert.equal(f.store.deleteTurn(scope,f.answer.id),true);
  const current=f.store.getCompanion(scope);
  assert.equal(current.turns.some(turn=>turn.id===answer.id||turn.id===child.id),false);
  assert.equal(f.store.experiences.artifact(scope,answer.artifactRef).availability,'redacted');
  assert.equal(f.store.experiences.artifact(scope,child.artifactRef).availability,'redacted');
  assert.equal(f.store.experiences.listFeedback(scope).length,0);
  assert.equal(current.turns.some(turn=>turn.id===f.current.id),true);assert.equal(f.store.messages(scope).length,1);
  assert.equal(f.store.getDiscussionCompaction(scope,f.binding()),null);
});

test('dependent answer metadata rejects missing, changed or forged original turn fingerprints',t=>{
  const f=fixture(t),cache=save(f).record;
  for(const discussionTurnFingerprints of [{'unknown-original':'0'.repeat(64)},{[f.answer.id]:'0'.repeat(64)}, {[f.answer.id]:discussionTurnFingerprint(f.answer),authorization:true}]){
    assert.throws(()=>f.store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Never committed',artifactMetadata:{discussionTurnFingerprints}}),/discussion|turn|fingerprint/i);
  }
  assert.equal(f.store.getCompanion(scope).turns.some(turn=>turn.text==='Never committed'),false);
});
