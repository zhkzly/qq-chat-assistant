'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');const {scope,raw}=require('./fixtures/native.cjs');const {normalize}=require('../src/messages.cjs');
function setup(t){const s=new Store(':memory:');t.after(()=>s.close());return s;}
function publish(s){const u=s.appendTurn(scope,{role:'user',kind:'discussion',text:'合成私人背景'});const a=s.appendTurn(scope,{role:'assistant',kind:'draft',requestId:'lifecycle',text:'合成建议',sourceIds:[`private:${u.id}`],suggestions:[{text:'合成可修改表达',style:'自然'}]});return {u,a,refs:[a.suggestions[0].artifactRef]};}
function event(e,type,text,refs,extra={}){return e.recordInteraction(scope,{clientEventId:`${type}-${Math.random()}`,type,text,artifactRefs:refs,...extra});}
test('reviewing a stale edited draft retains its ancestry and a later forget purges it',t=>{
 const s=setup(t),{u,refs}=publish(s),e=s.experiences;event(e,'draft_adopted','合成可修改表达',refs,{expectedRevision:0});
 s.updateTurn(scope,u.id,'更正后的合成背景');let draft=e.draft(scope);assert.equal(draft.availability,'stale');
 const edited=event(e,'draft_edited','用户保留的修改',refs,{expectedRevision:draft.revision}).draft;
 assert.equal(edited.reviewStatus,'required');
 assert.throws(()=>event(e,'clipboard_write',edited.text,refs),/review|changed|复核/);
 const states=e.artifactStates(scope,refs),review=event(e,'draft_reviewed',edited.text,refs,{expectedRevision:edited.revision,artifactWitnesses:states.map(x=>({ref:x.ref,witness:x.witness}))}).draft;
 assert.equal(review.reviewStatus,'reviewed');assert.deepEqual(review.artifactRefs,refs);
 const next=event(e,'draft_edited','用户继续修改',refs,{expectedRevision:review.revision}).draft;assert.equal(next.reviewStatus,'reviewed');
 event(e,'clipboard_write',next.text,refs);
 s.forgetSource(scope,`private:${u.id}`);assert.equal(e.draft(scope).text,'');assert.equal(e.draft(scope).availability,'redacted');
 assert.ok(e._all(scope,'event').every(row=>!row.text));assert.equal(e.artifactStates(scope,refs)[0].availability,'redacted');
});
test('a second source correction invalidates the captured review witness and cannot detach ancestry',t=>{
 const s=setup(t),{u,refs}=publish(s),e=s.experiences;event(e,'draft_adopted','合成可修改表达',refs);s.updateTurn(scope,u.id,'第一次更正');
 const stale=e.artifactStates(scope,refs),draft=e.draft(scope);s.updateTurn(scope,u.id,'第二次更正');
 assert.throws(()=>event(e,'draft_reviewed',draft.text,refs,{expectedRevision:draft.revision,artifactWitnesses:stale}),/witness|changed|来源/);
 assert.throws(()=>event(e,'draft_reviewed',draft.text,[],{expectedRevision:draft.revision,artifactWitnesses:[]}),/origin|ref|来源/);
 assert.equal(e.artifactStates({...scope,peerUid:'other'},refs)[0].availability,'unknown');
});
test('deleting a feedback display row forgets its canonical source and descendants',t=>{
 const s=setup(t),{a}=publish(s),f=s.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:a.artifactRef},text:'局部反馈'});
 const row=s.getCompanion(scope).turns.find(t=>t.feedbackId===f.id);s.deleteTurn(scope,row.id);
 assert.equal(s.memorySources(scope).some(x=>x.id===f.sourceId),false);assert.equal(s.experiences.hydrateFeedback(scope,f.id),null);
});
test('deleting an assistant turn purges only its artifact family and dependent copies, not shared raw sources or QQ',t=>{
 const s=setup(t),{u,a,refs}=publish(s),e=s.experiences;
 const other=s.appendTurn(scope,{role:'assistant',kind:'discussion',text:'独立保留的另一个建议',sourceIds:[`private:${u.id}`]});
 const f=s.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:refs[0]},text:'只评价第一条'});event(e,'draft_adopted','合成可修改表达',refs);
 const message=normalize(raw('900719925474099399',true),scope);s.add(scope,[message]);s.deleteTurn(scope,a.id);
 assert.equal(e.artifact(scope,refs[0]).availability,'redacted');assert.equal(e.draft(scope).text,'');assert.equal(e.hydrateFeedback(scope,f.id),null);
 assert.equal(e.artifact(scope,other.artifactRef).body,'独立保留的另一个建议');assert.ok(s.memorySources(scope).some(x=>x.id===`private:${u.id}`));assert.equal(s.messages(scope)[0].messageId,message.messageId);
});
function legacyTurn(s,{sourceIds=[],sourceRevisions={}}={}){
 const record=s.getCompanion(scope),turn={id:'legacy-assistant',role:'assistant',kind:'draft',requestId:'legacy-request',text:'旧答复原文',createdAt:'2026-10-01T00:00:00Z',sourceIds,
  suggestions:[{text:'旧候选表达',style:'自然'}],expressionOptions:[{label:'旧行动方向'}]};
 record.turns.push(turn);record.runs.push({id:'legacy-request',replyId:turn.id,manifest:{sourceIds,sourceRevisions}});
 s.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record').run(s.scopeKey(scope),JSON.stringify(record));return turn;
}
test('legacy answer families retain honest provenance, persist once, and erase reviewed draft copies when their source is forgotten',t=>{
 const s=setup(t),u=s.appendTurn(scope,{role:'user',kind:'discussion',text:'旧答复的私人证据'}),sourceId=`private:${u.id}`;
 const original=legacyTurn(s,{sourceIds:[sourceId],sourceRevisions:{[sourceId]:'recorded-generation-revision'}}),e=s.experiences;
 const turn=s.getCompanion(scope).turns.find(row=>row.id===original.id),refs=[turn.artifactRef,turn.suggestions[0].artifactRef,turn.expressionOptions[0].artifactRef];
 assert.deepEqual(refs.map(reference=>e.artifact(scope,reference).body),['旧答复原文','旧候选表达','旧行动方向']);
 for(const reference of refs){const artifact=e.artifact(scope,reference);assert.equal(artifact.availability,'stale');assert.equal(artifact.provenanceStatus,'generation_trace_incomplete');assert.deepEqual(artifact.sourceRefs,[{sourceId,revision:'recorded-generation-revision'}]);}
 const saved=s.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(s.scopeKey(scope)).record;
 s.getCompanion(scope);assert.equal(s.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(s.scopeKey(scope)).record,saved);assert.equal(e._all(scope,'artifact').length,3);
 assert.throws(()=>event(e,'draft_adopted','旧候选表达',[turn.suggestions[0].artifactRef]),/review|changed/);
 const migrated=event(e,'draft_edited','恢复的用户修改',[turn.artifactRef],{expectedRevision:0}).draft;
 assert.equal(migrated.originStatus,'legacy_origin_recovered');assert.equal(migrated.reviewStatus,'required');
 const reviewed=event(e,'draft_reviewed',migrated.text,migrated.artifactRefs,{expectedRevision:migrated.revision,artifactWitnesses:e.artifactStates(scope,migrated.artifactRefs)}).draft;
 event(e,'clipboard_write',reviewed.text,reviewed.artifactRefs);s.forgetSource(scope,sourceId);
 assert.equal(e.draft(scope).text,'');assert.ok(refs.every(reference=>e.artifact(scope,reference).availability==='redacted'));assert.ok(e._all(scope,'event').every(row=>row.text===''));
});
test('legacy migration never revives unavailable-source text or an explicit missing artifact version',t=>{
 const s=setup(t),e=s.experiences;legacyTurn(s,{sourceIds:['private:already-forgotten']});
 const turn=s._getCompanion(scope).turns.find(row=>row.id==='legacy-assistant');assert.equal(s.getCompanion(scope).turns.some(row=>row.id===turn.id),false);assert.equal(turn.text,'');assert.equal(turn.suggestions[0].text,'');assert.equal(turn.expressionOptions[0].label,'');
 for(const reference of e.refsForTurn(scope,turn.id)){const artifact=e.artifact(scope,reference);assert.equal(artifact.availability,'redacted');assert.equal(artifact.body,'');}
 const record=s._getCompanion(scope);record.turns.push({id:'unknown-version',role:'assistant',kind:'draft',text:'无法验证的显示副本',artifactRef:{artifactId:'absent',version:7}});
 s.db.prepare('UPDATE companion SET record=? WHERE scope_key=?').run(JSON.stringify(record),s.scopeKey(scope));
 const unavailable=s._getCompanion(scope).turns.find(row=>row.id==='unknown-version');assert.equal(s.getCompanion(scope).turns.some(row=>row.id===unavailable.id),false);assert.equal(e.artifact(scope,unavailable.artifactRef),null);assert.equal(e.artifactStates(scope,[unavailable.artifactRef])[0].availability,'unknown');
});
