'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('./fixtures/whole-answer-fidelity.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs'),{withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
function fixture(t){
 const store=new Store(':memory:'),calls=[];
 const settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-variation',realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-variation'}};
 const controller=new Controller({store,settings,read:async()=>{throw Error('No QQ read in variation fixtures');},assistantModel:async(_,input)=>{
  calls.push(structuredClone(input.payload));
  if(input.payload.purpose==='fidelity_check')return {checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  return {draftPlan:withCurrentDraftControls({quotes:[],intent:'reply'},input.payload),answer:{privateExplanation:'A fictional complete response.',suggestions:[{style:'自然',text:`Synthetic wording ${calls.length}.`}]}};
 }});controller.scope={...scope};controller.ingest(scope,[raw('57001',false,{elements:[{textElement:{content:'今天逛了家摆满手工小物的小店。'}}]})]);
 t.after(()=>{controller.close();store.close();});return {controller,calls};
}
test('asking for another opening gives a different user intent and exactly one generated comparison target',async t=>{
 const {controller,calls}=fixture(t);await controller.suggest();const prior=controller.currentAdvice();await controller.suggest({alternative:true});
 assert.equal(calls.length,4,'variation uses one complete primary answer and one read-only check per request');
 assert.notEqual(calls[2].userRequest.text,calls[0].userRequest.text,'a variation request must not be indistinguishable from the normal manual entry');
 assert.match(calls[2].userRequest.text,/切口|方向/);assert.match(calls[2].userRequest.text,/不只|不是只|实质/);
 const anchors=(calls[2].privateCandidates||[]).filter(item=>item.selection==='implicit_discussion_anchor');assert.equal(anchors.length,1);assert.equal(anchors[0].turnId,prior.turnId);assert.deepEqual(anchors[0].artifactRef,prior.suggestions[0].artifactRef);assert.match(anchors[0].authority,/generated/);
 assert.ok(!calls[2].sources.some(source=>source.id===`private:${prior.turnId}`));assert.equal(calls[3].purpose,'fidelity_check');assert.equal(calls[3].privateCandidates,undefined,'generated comparison wording is not outbound permission');assert.equal(calls[3].candidate.suggestions[0].text,controller.currentAdvice().suggestions[0].text);
});
test('variation without a current candidate falls back to ordinary manual help',async t=>{
 const {controller,calls}=fixture(t);await controller.suggest({alternative:true});assert.match(calls[0].userRequest.text,/我现在想和她聊/);assert.ok(!(calls[0].privateCandidates||[]).some(item=>item.selection==='implicit_discussion_anchor'));
});
test('automatic observation never inherits the manual variation action or target',async t=>{
 const {controller,calls}=fixture(t);await controller.suggest({automatic:true});const old=controller.currentAdvice();controller.live({scope,messages:[raw('57002')]});await controller.suggest({automatic:true,alternative:true});
 assert.equal(calls[2].taskContext.invocation.origin,'automatic');assert.ok(!/不只|不是只|实质/.test(calls[2].userRequest.text));assert.ok(!(calls[2].privateCandidates||[]).some(item=>item.turnId===old.turnId));
});
