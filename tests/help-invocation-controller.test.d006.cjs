'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
function fixture(t){
 const store=new Store(':memory:'),inputs=[],fidelityInputs=[];let now=Date.parse('2026-10-16T00:10:00.000Z');
 const settings={auto:false,anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic',
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic'}};
 const controller=new Controller({store,settings,now:()=>now,viewerTimeZone:'Asia/Shanghai',read:async()=>{throw Error('No native read in this fixture');},
  assistantModel:async(_settings,input)=>{if(input.payload.purpose==='fidelity_check'){fidelityInputs.push(input);return {checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};}inputs.push(input);return {kind:'discussion',text:'Synthetic help, not a semantic verdict.',...(input.payload.purpose==='reply'?{replyDisposition:'wait'}:{})};}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
 store.setGoal(scope,'Develop a mutually desired relationship.');
 store.add(scope,[normalize(raw('41001',false,{msgTime:String(Math.floor(now/1000)-60),elements:[{textElement:{content:'I finally finished the sketch.'}}]}),scope)]);
 return {controller,inputs,fidelityInputs,advance:ms=>{now+=ms;}};
}
test('manual suggestion and automatic observation retain their factual trigger in model input',async t=>{
 const f=fixture(t);await f.controller.suggest();await f.controller.suggest({automatic:true});assert.equal(f.fidelityInputs.length,0);
 assert.deepEqual(f.inputs.map(c=>c.payload.taskContext.invocation),[
  {origin:'user',trigger:'manual_suggestion',requestedPurpose:'reply'},
  {origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'}]);
});
test('private consultation does not become automatic because its quoted text mentions automation',async t=>{
 const f=fixture(t);await f.controller.assist({text:'昨天那个自动更新提醒只是背景，今天我想分享自己的画。'});
 assert.deepEqual(f.inputs[0].payload.taskContext.invocation,{origin:'user',trigger:'private_request',requestedPurpose:'discussion'});
});
test('a stable observation and its budget rebuild share one injected time and viewer zone',async t=>{
 const f=fixture(t);await f.controller.assist({text:'What is a useful next step?'});const input=f.inputs[0];
 assert.equal(input.payload.asOf,'2026-10-16T00:10:00.000Z');assert.equal(input.payload.viewerTimeZone,'Asia/Shanghai');assert.equal(f.fidelityInputs.length,0);
 f.advance(3600000);const rebuilt=input.rebuildForRequest(p=>Buffer.byteLength(JSON.stringify(p))+12000);
 assert.equal(rebuilt.payload.asOf,input.payload.asOf);assert.equal(rebuilt.payload.taskContext.timeContext.localNow,'2026-10-16 08:10');
 await f.controller.assist({text:'A new consultation now.'});assert.equal(f.inputs[1].payload.asOf,'2026-10-16T01:10:00.000Z');assert.equal(f.fidelityInputs.length,0);
});
test('a legacy automatic-result fingerprint cannot hide updated guidance for the same observations',async t=>{
 const f=fixture(t),c=f.controller;
 // The released .2 fingerprint omitted the prompt version entirely.
 const legacy={scope:c.scope,revision:c.revision,generation:c.store.contextGeneration?.(c.scope),model:c.settings.model,baseUrl:c.settings.baseUrl,
  instruction:c.instruction,images:c.selectedImages,autoImages:c.autoImages,automaticImageConsent:c.hasImageConsent({automatic:true}),focus:c.replyMessageIds};
 c.lastAutomaticFingerprint=createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
 await c.suggest({automatic:true});assert.equal(f.inputs.length,1);assert.equal(f.fidelityInputs.length,0);
});
