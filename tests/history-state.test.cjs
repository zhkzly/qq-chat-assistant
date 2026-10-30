'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Controller}=require('./fixtures/assistant-protocol.cjs');
const {Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
function app(latest) {
 const store=new Store(':memory:');const controller=new Controller({store,settings:{},read:async name=>name==='bind'?scope:latest()});
 controller.auto=false;controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 return {controller,store,close(){controller.close();store.close()}};
}
test('first native read failure remains visible and terminates the loading state',async()=>{
 const a=app(()=>{throw new Error('QQ_CONVERSATION_NOT_READY')});
 await assert.rejects(a.controller.bind(scope.peerUin),/NOT_READY/);
 for(let n=0;n<3;n++){const state=a.controller.snapshot();assert.equal(state.coverage.status,'read_error');assert.match(state.error,/NOT_READY/);assert.equal(state.historyBusy,false)}
 a.close();
});
test('empty completed native read becomes a truthful empty state',async()=>{
 const a=app(()=>({messages:[],source:'synthetic-native'}));await a.controller.bind(scope.peerUin);
 const state=a.controller.snapshot();assert.equal(state.total,0);assert.equal(state.coverage.status,'empty');assert.equal(state.historyBusy,false);a.close();
});
test('739 loaded scoped messages can be paged all the way to the oldest without re-import',()=>{
 const store=new Store(':memory:');const {normalize}=require('../src/messages.cjs');
 store.add(scope,Array.from({length:739},(_,n)=>normalize(raw(String(72057594037927000n+BigInt(n))),scope)));
 let cursor;const collected=[];
 do{const page=store.historyPage(scope,{before:cursor,limit:100});collected.unshift(...page.messages);cursor=page.hasOlder?page.messages[0].messageId:null}while(cursor);
 assert.equal(collected.length,739);assert.equal(new Set(collected.map(m=>m.messageId)).size,739);assert.equal(collected[0].messageId,'72057594037927000');
 assert.equal(store.historyPage({...scope,peerUid:'u_other'},{limit:100}).messages.length,0);store.close();
});
for (const empty of [false,true]) test(`successful older ${empty?'end':'page'} clears its stale native read error`,async()=>{
 const a=app(()=>({messages:empty?[]:[raw('72057594037927936')],source:'synthetic-native'}));
 a.controller.scope=scope;
 a.store.setCoverage(scope,{status:'read_error',error:'QQ IPC is not ready',cursor:'72057594037927937',pages:1});
 a.controller.error='QQ IPC is not ready';await a.controller.loadOlder(1);
 const state=a.controller.snapshot();assert.equal(state.coverage.status,empty?'accessible_end':'partial');
 assert.equal(Object.hasOwn(state.coverage,'error'),false);assert.equal(state.error,'');a.close();
});
test('successful history recovery does not clear an unrelated newer error',async()=>{
 const a=app(()=>({messages:[raw('72057594037927936')],source:'synthetic-native'}));a.controller.scope=scope;
 a.store.setCoverage(scope,{status:'read_error',error:'QQ IPC is not ready',cursor:'72057594037927937',pages:1});
 a.controller.error='Synthetic unrelated model error';await a.controller.loadOlder(1);
 assert.equal(a.controller.error,'Synthetic unrelated model error');assert.equal(Object.hasOwn(a.store.coverage(scope),'error'),false);a.close();
});
test('latest history recovery does not erase an unrelated error arriving while reading',async()=>{
 let resolve;const a=app(()=>new Promise(done=>{resolve=done}));a.controller.scope=scope;
 a.store.setCoverage(scope,{status:'read_error',error:'QQ IPC is not ready',cursor:'72057594037927937',pages:1});a.controller.error='QQ IPC is not ready';
 const pending=a.controller.loadLatest();a.controller.error='Synthetic newer error';resolve({messages:[],source:'synthetic-native'});await pending;
 assert.equal(a.controller.error,'Synthetic newer error');assert.equal(Object.hasOwn(a.store.coverage(scope),'error'),false);a.close();
});
