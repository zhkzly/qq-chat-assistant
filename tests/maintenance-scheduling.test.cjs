'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');const {Controller}=require('./fixtures/assistant-protocol.cjs');const {scope}=require('./fixtures/native.cjs');
test('a lone new private source waits for batch or idle threshold instead of invoking a model immediately',async t=>{
 const store=new Store(':memory:');let calls=0;
 const controller=new Controller({store,read:async(command)=>command==='bind'?scope:{messages:[]},settings:{auto:false,model:'synthetic',baseUrl:'http://fixture.invalid',apiKey:'synthetic',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic',baseUrl:'http://fixture.invalid'}},
 memoryModel:async(_,batch)=>{calls++;return {reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[]}}});
 t.after(()=>{controller.close();store.close()});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 store.appendTurn(scope,{role:'user',kind:'discussion',text:'今天去了一个展览。'});controller.scheduleMemory(1);
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(calls,0);assert.ok(store.memoryStatus(scope).pending>0);
 await controller.maintainMemory({force:true});assert.equal(calls,1);
});

test('automatic maintenance cannot spend a retry beyond the remaining rolling window',async t=>{
 const store=new Store(':memory:');let calls=0;
 const settings={auto:false,model:'synthetic',baseUrl:'http://fixture.invalid',apiKey:'synthetic',memoryWindowRequests:2,realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic',baseUrl:'http://fixture.invalid'}};
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},memoryModel:async(received,batch)=>{
  const stage=received.requestBudget;const first=stage.reserveAttempt({inputBytes:1});calls++;stage.finishAttempt(first,{status:503});
  assert.throws(()=>stage.reserveAttempt({inputBytes:1}),/上限/);
  return {reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[]};
 }});t.after(()=>{controller.close();store.close()});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 const previous=controller.usage.create(scope,{origin:'maintenance',inputDigest:'previous',limit:1});const stage=previous.forStage('memory_maintenance');stage.finishAttempt(stage.reserveAttempt(),{status:200});controller.usage.finish(scope,previous.id,'complete');
 store.appendTurn(scope,{role:'user',text:'今天去了展览。',kind:'discussion'});
 await controller.maintainMemory();assert.equal(calls,1);assert.equal(controller.usage.maintenanceWindow(scope).requestsInWindow,2);
 store.appendTurn(scope,{role:'user',text:'刚才又想到一个话题。',kind:'discussion'});assert.equal((await controller.maintainMemory()).status,'deferred');assert.equal(calls,1);
});
