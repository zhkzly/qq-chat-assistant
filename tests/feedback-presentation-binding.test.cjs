'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {CandidateSession}=require('../src/candidate-session.cjs');
const {FeedbackBindingStore}=require('../src/feedback/feedback-binding-store.cjs');
const {PresentationLedger,contentDigest}=require('../src/feedback/presentation-ledger.cjs');
const {PresentationCandidateSession}=require('../src/feedback/presentation-candidate-session.cjs');
const {scope}=require('./fixtures/native.cjs');
const key=s=>JSON.stringify(['accountUid','accountUin','peerUid','peerUin'].map(k=>s[k]));

function setup(t){
 const store=new Store(':memory:');t.after(()=>store.close());
 let clock=1000;const ledger=new PresentationLedger({scopeKey:key});
 const experiences=new FeedbackBindingStore(store,{scopeKey:key,ledger});
 store.experiences=experiences;
 const session=new PresentationCandidateSession({session:new CandidateSession({now:()=>clock}),ledger});
 return {store,experiences,ledger,session,tick:()=>clock+=1000};
}

function display(store,session,{requestId,suggestion,text='可以这样表达：',revision=1,planDigest='plan'}){
 const user=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我想找个自然的开场。'});
 const turn=store.appendTurn(scope,{role:'assistant',kind:'draft',text,requestId,sourceIds:[`private:${user.id}`],suggestions:[{text:suggestion,style:'自然'}],methodIds:[]});
 const ticket=session.begin({scope,revision,requestId,origin:'user'});
 session.bindPlan(ticket,planDigest);
 const candidate=session.publish(ticket,{scope,revision,reply:turn,planDigest,messageIds:[]});
 assert.ok(candidate,'the display must publish');
 return {turn,candidate};
}

// Regeneration semantics of the artifact store: re-recording the same turn
// id with changed content bumps the affected artifact to a new version.
function regenerate(store,experiences,session,turn,suggestion,planDigest='plan-2'){
 const reply={...turn,suggestions:[{text:suggestion,style:'自然'}]};
 const refs=experiences.recordArtifacts(scope,reply,{});
 reply.artifactRef=refs.responseRef;
 reply.suggestions=reply.suggestions.map((item,index)=>({...item,artifactRef:refs.suggestionRefs[index]}));
 const ticket=session.begin({scope,revision:1,requestId:turn.requestId,origin:'user'});
 session.bindPlan(ticket,planDigest);
 const candidate=session.publish(ticket,{scope,revision:1,reply,planDigest,messageIds:[]});
 assert.ok(candidate,'the regenerated display must publish');
 return candidate;
}

test('B8 shape: after regeneration feedback cannot silently bind the pre-regeneration version',t=>{
 const {store,experiences,session,tick}=setup(t);
 const {turn,candidate}=display(store,session,{requestId:'request-1',suggestion:'周六去看那个展怎么样？'});
 const oldPresentationId=candidate.suggestions[0].presentationId;
 tick();
 const next=regenerate(store,experiences,session,turn,'刚看到那个展下周开幕，要不要一起去？');
 assert.equal(next.suggestions[0].artifactRef.artifactId,candidate.suggestions[0].artifactRef.artifactId);
 assert.equal(next.suggestions[0].artifactRef.version,2);
 const stale=experiences.addFeedback(scope,{presentationId:oldPresentationId,text:'这句太突然了。',clientEventId:'fb-old'});
 assert.equal(stale.staleFeedbackTarget?.code,'stale_feedback_target');
 assert.equal(stale.staleFeedbackTarget.current.presentationId,next.suggestions[0].presentationId);
 assert.equal(stale.staleFeedbackTarget.current.artifactRef.version,2);
 // No record was written: the old version was never bound silently.
 assert.equal(experiences.listFeedback(scope).length,0);
 const artifact=experiences.artifact(scope,{artifactId:candidate.suggestions[0].artifactRef.artifactId,version:1});
 assert.ok(artifact&&artifact.body==='周六去看那个展怎么样？','the pre-regeneration version stays readable history');
 // The current presentation binds the regenerated version.
 const saved=experiences.addFeedback(scope,{presentationId:next.suggestions[0].presentationId,text:'这句更自然。',clientEventId:'fb-new'});
 assert.equal(saved.targetRef.artifactRef.version,2);
 assert.equal(saved.presentationId,next.suggestions[0].presentationId);
 assert.equal(experiences.hydrateFeedback(scope,saved.id).target.body,'刚看到那个展下周开幕，要不要一起去？');
});

test('normal binding: a presentation binds the exact displayed artifact version',t=>{
 const {store,experiences,session}=setup(t);
 const {turn,candidate}=display(store,session,{requestId:'request-1',suggestion:'周六去看那个展怎么样？'});
 assert.ok(candidate.presentation?.presentationId);
 assert.ok(candidate.suggestions[0].presentationId);
 // Enrichment never mutates the stored companion turn.
 const stored=store.getCompanion(scope).turns.find(item=>item.id===turn.id);
 assert.equal(stored.suggestions[0].presentationId,undefined);
 const saved=experiences.addFeedback(scope,{presentationId:candidate.suggestions[0].presentationId,text:'这一句不像我，太正式。',clientEventId:'feedback-one'});
 assert.equal(saved.targetRef.kind,'artifact');
 assert.deepEqual(saved.targetRef.artifactRef,candidate.suggestions[0].artifactRef);
 assert.equal(saved.targetStatus,'available');
 assert.equal(saved.presentationId,candidate.suggestions[0].presentationId);
 assert.equal(experiences.hydrateFeedback(scope,saved.id).target.body,'周六去看那个展怎么样？');
 // The whole-response presentation binds the response artifact.
 const whole=experiences.addFeedback(scope,{presentationId:candidate.presentation.presentationId,text:'整体解释太长。',clientEventId:'feedback-whole'});
 assert.equal(whole.targetRef.artifactRef.artifactId,candidate.artifactRef.artifactId);
 assert.equal(experiences.sourceRows(scope).length,2);
});

test('clientEventId idempotency survives regeneration and rejects swapped targets',t=>{
 const {store,experiences,session,tick}=setup(t);
 const {turn,candidate}=display(store,session,{requestId:'request-1',suggestion:'第一句太正式。'});
 const presentationId=candidate.suggestions[0].presentationId;
 const saved=experiences.addFeedback(scope,{presentationId,text:'太正式。',clientEventId:'same-op'});
 const again=experiences.addFeedback(scope,{presentationId,text:'太正式。',clientEventId:'same-op'});
 assert.equal(again.id,saved.id);
 assert.equal(experiences.listFeedback(scope).length,1);
 tick();
 const next=regenerate(store,experiences,session,turn,'第二句自然一些。');
 // A replay of the already-saved event still returns the stored record,
 // not a stale notice, even though the presentation has aged out.
 const replay=experiences.addFeedback(scope,{presentationId,text:'太正式。',clientEventId:'same-op'});
 assert.equal(replay.id,saved.id);
 assert.equal(replay.presentationId,presentationId);
 // Reusing the same event id for a different presentation is a violation.
 assert.throws(()=>experiences.addFeedback(scope,{presentationId:next.suggestions[0].presentationId,text:'太正式。',clientEventId:'same-op'}),/reused/);
 assert.equal(experiences.listFeedback(scope).length,1);
});

test('requestId-only legacy resolution is removed',t=>{
 const {store,experiences,session}=setup(t);
 display(store,session,{requestId:'request-1',suggestion:'周六去看那个展怎么样？'});
 assert.throws(()=>experiences.addFeedback(scope,{requestId:'request-1',text:'旧路径反馈'}),/presentationId/);
 assert.equal(experiences.listFeedback(scope).length,0);
});

test('unknown or foreign-scope presentations get an explicit notice, never a fallback bind',t=>{
 const {store,experiences,session}=setup(t);
 const {candidate}=display(store,session,{requestId:'request-1',suggestion:'周六去看那个展怎么样？'});
 const foreign=experiences.addFeedback({...scope,peerUin:'9999999999'},{presentationId:candidate.suggestions[0].presentationId,text:'跨会话反馈'});
 assert.equal(foreign.staleFeedbackTarget?.code,'unknown_presentation');
 const unknown=experiences.addFeedback(scope,{presentationId:'f'.repeat(64),text:'不存在的展示'});
 assert.equal(unknown.staleFeedbackTarget?.code,'unknown_presentation');
 assert.equal(experiences.listFeedback(scope).length,0);
 assert.equal(experiences.listFeedback({...scope,peerUin:'9999999999'}).length,0);
});

test('explicit artifact feedback requires a digest; a mismatch notices instead of binding',t=>{
 const {store,experiences,session}=setup(t);
 const {candidate}=display(store,session,{requestId:'request-1',suggestion:'周六去看那个展怎么样？'});
 const reference=candidate.suggestions[0].artifactRef,artifact=experiences.artifact(scope,reference);
 assert.throws(()=>experiences.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:reference},text:'缺少摘要'}),/presentationId|expected artifact digest/);
 const saved=experiences.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:reference},expectedDigest:artifact.bodyDigest,text:'明确评价这一版。',clientEventId:'explicit'});
 assert.equal(saved.targetRef.artifactRef.version,reference.version);
 const stale=experiences.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:reference},expectedDigest:'0'.repeat(64),text:'版本变了。',clientEventId:'wrong-digest'});
 assert.equal(stale.staleFeedbackTarget?.code,'stale_feedback_target');
 assert.equal(experiences.listFeedback(scope).length,1);
});

test('re-displaying identical content does not stale the earlier presentation',t=>{
 const {store,experiences,session,tick}=setup(t);
 const {turn,candidate}=display(store,session,{requestId:'request-1',suggestion:'相同的一句'});
 tick();
 const ticket=session.begin({scope,revision:1,requestId:'request-1',origin:'user'});
 session.bindPlan(ticket,'plan-2');
 const again=session.publish(ticket,{scope,revision:1,reply:turn,planDigest:'plan-2',messageIds:[]});
 assert.notEqual(again.suggestions[0].presentationId,candidate.suggestions[0].presentationId);
 assert.equal(again.suggestions[0].artifactRef.version,candidate.suggestions[0].artifactRef.version,'identical content keeps one artifact version');
 const saved=experiences.addFeedback(scope,{presentationId:candidate.suggestions[0].presentationId,text:'还是这句。',clientEventId:'re-display'});
 assert.ok(saved.id);
});

test('a regenerated different candidate does not stale earlier presentations',t=>{
 const {store,experiences,session}=setup(t);
 const first=display(store,session,{requestId:'request-1',suggestion:'第一句开场'});
 display(store,session,{requestId:'request-2',suggestion:'换了一个切口的新候选'});
 const saved=experiences.addFeedback(scope,{presentationId:first.candidate.suggestions[0].presentationId,text:'对旧候选的具体反馈。',clientEventId:'old-turn'});
 assert.ok(saved.id);
 assert.equal(saved.targetRef.artifactRef.artifactId,first.candidate.suggestions[0].artifactRef.artifactId);
});

test('ledger minting is immutable and idempotent; drifted digests never bind',t=>{
 const ledger=new PresentationLedger({scopeKey:key});
 const args={scope,artifactRef:{artifactId:'turn:x',version:1},bodyDigest:contentDigest('body'),requestId:'r',displayedAt:'2026-11-01T00:00:00.000Z'};
 const a=ledger.mint(args),b=ledger.mint(args);
 assert.equal(a,b,'the same display mints the same immutable record');
 assert.throws(()=>ledger.mint({...args,artifactRef:{artifactId:'turn:x'}}),/Invalid artifact reference/);
 assert.throws(()=>ledger.mint({...args,bodyDigest:'not-a-digest'}),/Invalid presentation artifact digest/);
 const {store,experiences,session}=setup(t);
 const {candidate}=display(store,session,{requestId:'request-1',suggestion:'展示内容'});
 const drifted=experiences.presentationLedger.mint({scope,artifactRef:candidate.suggestions[0].artifactRef,bodyDigest:contentDigest('tampered'),requestId:'request-1',displayedAt:'2026-11-01T00:00:01.000Z'});
 const stale=experiences.addFeedback(scope,{presentationId:drifted.presentationId,text:'摘要漂移'});
 assert.equal(stale.staleFeedbackTarget?.code,'stale_feedback_target');
 assert.equal(experiences.listFeedback(scope).length,0);
});

test('the wrapped session keeps the CandidateSession surface on the enriched projection',t=>{
 const {store,session}=setup(t);
 const {candidate}=display(store,session,{requestId:'request-1',suggestion:'周六去看那个展怎么样？'});
 assert.equal(session.current({scope,revision:1}).suggestions[0].presentationId,candidate.suggestions[0].presentationId);
 assert.equal(session.candidate.suggestions[0].presentationId,candidate.suggestions[0].presentationId);
 session.invalidate('context_changed');
 assert.equal(session.current({scope,revision:1}),null);
 assert.equal(session.status({scope,revision:1}).reason,'context_changed');
});
