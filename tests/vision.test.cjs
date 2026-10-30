'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {generate}=require('../src/model.cjs');const {Controller}=require('./fixtures/assistant-protocol.cjs');const {Store}=require('../src/store.cjs');const {scope,raw}=require('./fixtures/native.cjs');const {normalize}=require('../src/messages.cjs');
test('selected images become multimodal content while the text-only path remains text',async()=>{
 let payload;const model={apiKey:'synthetic',model:'synthetic',baseUrl:'http://fixture.invalid/v1'};
 const fetchImpl=async(_,request)=>{payload=JSON.parse(request.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({analysis:'test',suggestions:[1,2,3].map(n=>({style:String(n),text:'🙂 test'}))})}}]})}};
 const image='data:image/png;base64,synthetic';await generate(model,[normalize(raw(),scope)],'自然',undefined,fetchImpl,{images:[image]});assert.equal(payload.messages[1].content[1].image_url.url,image);assert.equal(payload.messages[1].content[0].type,'text');
 await generate(model,[normalize(raw(),scope)],'自然',undefined,fetchImpl);assert.equal(typeof payload.messages[1].content,'string');
});
test('text consent cannot authorize selected-image transmission',async()=>{
 let calls=0;const store=new Store(':memory:');store.add(scope,[normalize(raw(),scope)]);
 const settings={apiKey:'synthetic',model:'synthetic',baseUrl:'http://fixture.invalid/v1',visionEnabled:true,realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async()=>{},model:async()=>{calls++}});controller.scope=scope;controller.configure({images:[{messageId:raw().msgId,index:0}]});
 await assert.rejects(controller.suggest(),/需要启用视觉模型并明确允许图片发送/);assert.equal(calls,0);controller.close();store.close();
});
