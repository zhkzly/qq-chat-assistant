'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseAssistant,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {Store}=require('../src/store.cjs');
const scope={accountUid:'a',accountUin:'100',peerUid:'p',peerUin:'200'};
const payload={purpose:'reply',sources:[],taskContext:{auxiliaryPolicy:'best_effort',invocation:{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'}}};

test('a current automatic reply cannot silently succeed as analysis without a candidate decision',()=>{
 assert.throws(()=>parseAssistant({kind:'discussion',text:'Only a general explanation.'},'reply',payload),/replyDisposition/);
 for(const replyDisposition of ['wait','clarify','unavailable']){
  const result=parseAssistant({kind:replyDisposition==='clarify'?'question':'discussion',text:'A specific reason for this exchange.',replyDisposition},'reply',payload);
  assert.equal(result.replyDisposition,replyDisposition);
 }
 assert.throws(()=>parseAssistant({kind:'discussion',text:'A reason.',replyDisposition:'ignore'},'reply',payload),/replyDisposition/);
 assert.equal(parseAssistant({kind:'discussion',text:'Ordinary private help.'},'discussion',{purpose:'discussion'}).text,'Ordinary private help.');
});

test('restricted automatic wording also distinguishes a missing candidate from completed wording',()=>{
 const draft={...payload,purpose:'draft',taskContext:{...payload.taskContext,requestOrigin:'restricted_draft'}};
 assert.throws(()=>parseAssistant({kind:'discussion',text:'No actual wording.'},'draft',draft),/replyDisposition/);
 assert.equal(parseAssistant({kind:'draft',text:'One direction.',suggestions:[{style:'轻松接住',text:'这颜色确实很显眼。'}]},'draft',draft).suggestions.length,1);
 const normalized=parseAssistant({kind:'draft',text:'One direction.',suggestions:[{style:'自然',text:'这颜色确实很显眼。'}],replyDisposition:'wait'},'draft',draft);
 assert.equal(normalized.replyDisposition,undefined,'actual wording delivery has one unambiguous status');
});

test('legacy automatic output is filtered by scoped task identity beyond retained runs without rewriting original origin',()=>{
 const store=new Store(':memory:');
 try{
  const {TaskLedger}=require('../src/request-budget.cjs'),ledger=new TaskLedger(store);
  const automatic=ledger.create(scope,{inputDigest:'legacy-auto',origin:'automatic'});
  const foreign=ledger.create({...scope,peerUid:'another-peer',peerUin:'300'},{inputDigest:'foreign',origin:'automatic'});
  const known=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Legacy automatic observation.',requestId:automatic.id});
  const unknown=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Unidentified historical help.',requestId:foreign.id});
  const current=store.getCompanion(scope);
  assert.equal(current.runs.length,0);
  assert.equal(current.turns.find(x=>x.id===known.id).origin,undefined);
  assert.equal(current.turns.find(x=>x.id===unknown.id).origin,undefined);
  const {Controller}=require('../src/controller.cjs');
  const controller=new Controller({store,settings:{},read:async()=>{throw Error('No native read in this fixture');}});
  try{
   controller.scope={...scope};const visible=controller.snapshot().companion.turns;
   assert.ok(!visible.some(x=>x.id===known.id));assert.ok(visible.some(x=>x.id===unknown.id));
  }finally{controller.close();}
 }finally{store.close();}
});

test('the delivered auto contract asks for wording and permits honest uncertainty and closure',()=>{
 const system=prepareAssistantRequest({model:'fixture'},payload).request.messages[0].content;
 assert.match(system,/replyDisposition/);
 assert.match(system,/draftPlan/);
 assert.match(system,/未知花名\/缺图片\/无今日经历不妨碍其他表达/);
 assert.match(system,/不编经历\/承诺\/心理/);
 assert.match(system,/clarify[^。]*缺决定内容且无法绕开的用户事实/);
 assert.match(system,/实质不同才≤3条，否则1条/);
});

test('automatic origin and delivery decisions persist only on assistant turns',()=>{
 const store=new Store(':memory:');
 try{
  const t=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'The current exchange is complete.',origin:'automatic',replyDisposition:'wait'});
  const saved=store.getCompanion(scope).turns.find(x=>x.id===t.id);
  assert.equal(saved.origin,'automatic');assert.equal(saved.replyDisposition,'wait');
  assert.throws(()=>store.appendTurn(scope,{role:'user',kind:'discussion',text:'A private request.',origin:'automatic'}),/origin/);
 }finally{store.close();}
});
