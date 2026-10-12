'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {scope}=require('./fixtures/native.cjs');
const {TaskLedger}=require('../src/request-budget.cjs');
const {postModel}=require('../src/model-http.cjs');

test('transport retries and resumed stages share one durable request cap',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const ledger=new TaskLedger(store),task=ledger.create(scope,{inputDigest:'same-task',limit:3});
 let calls=0;
 const failThenSuccess=async()=>{calls++;return {ok:calls%2===0,status:calls%2===0?200:503,body:{cancel:async()=>{}}}};
 await postModel('http://fixture.invalid', {body:'synthetic'},failThenSuccess,async()=>{},task.forStage('discussion'));
 const resumed=ledger.resume(scope,task.id);
 await postModel('http://fixture.invalid',{body:'synthetic'},async()=>{calls++;return {ok:true,status:200}},async()=>{},resumed.forStage('draft'));
 await assert.rejects(postModel('http://fixture.invalid',{},async()=>{calls++;return {ok:true,status:200}},async()=>{},resumed.forStage('format_repair')),error=>error.code==='request_budget_exhausted');
 assert.equal(calls,3);assert.equal(ledger.get(scope,task.id).attempts,3);
 assert.deepEqual(ledger.get(scope,task.id).requests.map(r=>r.purpose),['discussion','discussion','draft']);
});
test('task identity is scope-bound and diagnostic usage does not assume missing token reports',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const ledger=new TaskLedger(store);
 const task=ledger.create(scope,{id:'client-task',inputDigest:'first',limit:4});
 assert.equal(ledger.create(scope,{id:'client-task',inputDigest:'first'}).reused,true);
 assert.throws(()=>ledger.create(scope,{id:'client-task',inputDigest:'different'}),/不同|different/);
 assert.throws(()=>ledger.resume({...scope,peerUid:'u_other'},task.id),/会话|scope/);
 const stage=task.forStage('discussion'),attempt=stage.reserveAttempt({inputBytes:32,attempt:1});stage.finishAttempt(attempt,{status:200});
 assert.equal(ledger.get(scope,task.id).usage.totalTokens,null);
 stage.recordUsage({prompt_tokens:20,completion_tokens:10,total_tokens:30});
 assert.equal(ledger.get(scope,task.id).usage.totalTokens,30);
 ledger.finish(scope,task.id,'complete');assert.throws(()=>stage.reserveAttempt({}),/完成|finished/);
});
test('model errors cannot leak echoed private content into request accounting',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const ledger=new TaskLedger(store),task=ledger.create(scope,{inputDigest:'opaque',limit:2});
 await assert.rejects(postModel('http://fixture.invalid',{body:'PRIVATE_INPUT'},async()=>{throw new Error('PRIVATE_INPUT secret')},async()=>{},task.forStage('discussion')));
 const report=ledger.get(scope,task.id);assert.equal(report.attempts,2);assert.equal(JSON.stringify(report).includes('PRIVATE_INPUT'),false);
});
