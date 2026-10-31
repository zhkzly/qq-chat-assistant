'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional controller regression; the model is a deterministic local stub.
// A private correction may replace or withdraw current wording, but the old
// wording must not remain the primary candidate after the correction succeeds.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('./fixtures/whole-answer-fidelity.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const DIRECT='我想多了解你一点，下次一起去逛逛吧。';
const REVISED='听起来那家小店挺有意思的，难怪你逛了那么久。';
function fixture(t){
 const store=new Store(':memory:'),calls=[];let corrected=false,discussionOnly=false;
 const settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-private-refresh',realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-private-refresh'}};
 const controller=new Controller({store,settings,read:async()=>{throw Error('No native QQ read in this regression');},assistantModel:async(_,input)=>{
  const p=input.payload;calls.push(structuredClone(p));
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  if(corrected&&discussionOnly)return {kind:'discussion',text:'先商量怎样接她的分享，暂不提供另一份表达。'};
  return {kind:'discussion',text:corrected?'接她已分享的小店细节，去掉邀约和直白关系表达。':'先给一份待用户调整的合成参考。',draftPlan:withCurrentDraftControls({quotes:[],intent:'reply'},p),answer:{privateExplanation:'Fictional wording for the current instruction.',suggestions:[{style:corrected?'含蓄':'直白',text:corrected?REVISED:DIRECT}]}};
 }});controller.scope={...scope};controller.ingest(scope,[raw('56001',false,{elements:[{textElement:{content:'今天路过一家小店，里面的手工摆件太多了，我逛了好久。'}}]})]);
 t.after(()=>{controller.close();store.close();});
 return {controller,store,calls,correct:({onlyDiscuss=false}={})=>{corrected=true;discussionOnly=onlyDiscuss;}};
}
test('a private request for subtler wording replaces or withdraws the previous automatic primary candidate',async t=>{
 const {controller,store,calls,correct}=fixture(t);await controller.suggest({automatic:true});
 const first=controller.snapshot().advice;assert.equal(first.suggestions[0].text,DIRECT);
 store.experiences.recordInteraction(scope,{clientEventId:'synthetic-private-refresh-edit',type:'draft_independent',text:'My own unsent edit stays intact.'});
 const qqRevision=controller.revision,generation=store.contextGeneration(scope);correct();
 const revised=await controller.assist({text:'别这么直白，换含蓄一点的说法，接她刚分享的小店细节就好。',purpose:'discussion'});
 assert.equal(revised.suggestions[0].text,REVISED,'the actual private pipeline has delivered the corrected wording');
 assert.equal(controller.revision,qqRevision,'there is no new QQ message to accidentally invalidate the old candidate');
 assert.notEqual(store.contextGeneration(scope),generation,'the applicable private instruction has changed');
 assert.equal(store.messages(scope).length,1);assert.equal(store.experiences.draft(scope).text,'My own unsent edit stays intact.');
 assert.equal(calls.length,4,'the probe executes complete primary generation and read-only checking for both requests');
 const current=controller.snapshot().advice;
 assert.notEqual(current?.suggestions[0]?.text,DIRECT,'the prominently displayed candidate must not contradict the successful private correction');
 if(current)assert.equal(current.suggestions[0].text,REVISED,'a retained primary candidate must point to the revised wording');
});
test('a private correction that pauses drafting withdraws old wording while preserving the consultation',async t=>{
 const {controller,store,correct}=fixture(t);await controller.suggest({automatic:true});assert.equal(controller.snapshot().advice.suggestions[0].text,DIRECT);
 correct({onlyDiscuss:true});const answer=await controller.assist({text:'别这么直白，先不要写新句子，我想商量一下。',purpose:'discussion'});
 assert.equal(answer.kind,'discussion');assert.equal(controller.snapshot().companion.turns.at(-1).text,answer.text);assert.equal(store.messages(scope).length,1);
 assert.equal(controller.snapshot().advice,null,'an explicit private correction must not leave the old automatic wording ready to copy');
});
test('a fresh private explanation can identify the withdrawn current automatic candidate as generated help',async t=>{
 const {controller,calls,correct}=fixture(t);await controller.suggest({automatic:true});const prior=controller.currentAdvice();
 correct({onlyDiscuss:true});await controller.assist({text:'为什么这样说？',purpose:'discussion',taskId:'synthetic-implicit-reference'});
 const input=calls[2],reference=(input.privateCandidates||[]).find(item=>item.turnId===prior.turnId);
 assert.ok(reference,'the new private planning input needs the exact candidate the user is discussing');
 assert.equal(reference.text,DIRECT);assert.deepEqual(reference.artifactRef,prior.suggestions[0].artifactRef);assert.match(reference.authority,/generated/);
 assert.ok(!input.sources.some(source=>source.id===`private:${prior.turnId}`),'generated help is not an original user/factual source');
 assert.equal(controller.currentAdvice(),null,'providing a reference does not revive it as the current candidate');
 const before=calls.length;await controller.assist({text:'为什么这样说？',purpose:'discussion',taskId:'synthetic-implicit-reference'});assert.equal(calls.length,before,'a retry keeps the original explicit-input identity after the current candidate is withdrawn');
});
test('an explicit historical reference takes precedence over the current automatic candidate',async t=>{
 const {controller,store,calls,correct}=fixture(t);await controller.suggest({automatic:true});const automatic=controller.currentAdvice();
 const selected=store.appendTurn(scope,{role:'assistant',kind:'draft',origin:'user',text:'A specifically selected older response.',suggestions:[{style:'自然',text:'Explicitly selected generated wording.'}],sourceIds:['qq:56001']});
 correct({onlyDiscuss:true});await controller.assist({text:'解释我选中的这一份。',purpose:'discussion',sourceTurnIds:[selected.id]});
 const refs=calls[2].privateCandidates||[];assert.ok(refs.some(item=>item.turnId===selected.id));assert.ok(!refs.some(item=>item.turnId===automatic.turnId),'implicit current selection must not override an explicit target');
});
test('the next automatic observation does not inherit the previous automatic candidate history',async t=>{
 const {controller,calls}=fixture(t);await controller.suggest({automatic:true});const prior=controller.currentAdvice();
 controller.live({scope,messages:[raw('56002',false,{elements:[{textElement:{content:'那家店还卖手工明信片。'}}]})]});await controller.suggest({automatic:true});
 assert.ok(!(calls[2].privateCandidates||[]).some(item=>item.turnId===prior.turnId));
});
