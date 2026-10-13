'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {scope}=require('./fixtures/native.cjs');
function fixture(t,model){const store=new Store(':memory:'),controller=new Controller({store,settings:{auto:false,anonymous:true,model:'synthetic-errors',baseUrl:'http://fixture.invalid',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic-errors',baseUrl:'http://fixture.invalid'}},read:async()=>{throw Error('No QQ read in this fixture');},assistantModel:model,memoryModel:null});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};t.after(()=>{controller.close();store.close()});return {store,controller};}
test('model failure in QQ assistance appears only in the assistant channel and retains its saved diagnostics',async t=>{
 const failure=Object.assign(new Error('助手模型请求失败： HTTP 429 (capacity)'),{code:'model_http_429_capacity'}),f=fixture(t,async()=>{throw failure});
 await assert.rejects(f.controller.suggest(),/429/);assert.equal(f.controller.assistantError,failure.message);assert.equal(f.controller.error,'');assert.equal(f.controller.busy,false);
 const run=f.store.getCompanion(scope).runs.at(-1);assert.equal(run.status,'failed');assert.equal(run.error,failure.message);
});
test('fresh private attempt clears a copied legacy model error and preserves unrelated native read errors',async t=>{
 for(const oldGlobal of ['助手模型请求失败： HTTP 429 (capacity)','QQ 读取超时：latest']){
  const f=fixture(t,async()=>({kind:'discussion',text:'A successful synthetic answer.'}));f.controller.assistantError='助手模型请求失败： HTTP 429 (capacity)';f.controller.error=oldGlobal;
  const reply=await f.controller.assist({text:'我刚刚还打算和你聊天的。'});assert.equal(reply.text,'A successful synthetic answer.');assert.equal(f.controller.assistantError,'');assert.equal(f.controller.error,oldGlobal.includes('429')?'':oldGlobal);assert.equal(f.store.getCompanion(scope).turns.at(-2).text,'我刚刚还打算和你聊天的。');
 }
});
