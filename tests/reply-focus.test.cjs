'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');const {Controller}=require('../src/controller.cjs');const {normalize}=require('../src/messages.cjs');const {generate,contextFor,replyFocusFor}=require('../src/model.cjs');const {scope,raw}=require('./fixtures/native.cjs');
const records=Array.from({length:80},(_,i)=>normalize(raw(String(72057594037927000n+BigInt(i)),i===76),scope));
test('recent incoming burst is grouped and old selected messages stay in the bounded model context',()=>{
 assert.deepEqual(replyFocusFor(records,[]).messageIds,records.slice(-3).map(r=>r.messageId));
 const ids=[records[0].messageId,records[1].messageId];const context=contextFor(records,'自然一点',ids);
 assert.ok(ids.every(id=>context.some(m=>m.id===id)));assert.ok(context.reduce((n,m)=>n+m.text.length,0)<=18000);
 assert.throws(()=>replyFocusFor(records,['99999999999']),/当前会话/);
});
test('changing reply focus discards a pending answer and contact binding clears focus',async()=>{
 const store=new Store(':memory:');store.add(scope,records);let finish;const controller=new Controller({store,settings:{apiKey:'fixture',model:'fixture',baseUrl:'http://fixture.invalid/v1',realChatConsent:{...scope,model:'fixture',baseUrl:'http://fixture.invalid/v1'}},read:async command=>command==='bind'?{...scope,peerUid:'u_other'}:{messages:[],source:'fixture'},model:()=>new Promise(r=>{finish=r})});controller.scope=scope;controller.auto=false;
 try{const pending=controller.suggest();controller.configure({replyMessageIds:[records[0].messageId]});finish({analysis:'stale',suggestions:[]});await pending;assert.equal(controller.advice,null);assert.deepEqual(controller.snapshot().replyFocus.messageIds,[records[0].messageId]);await controller.bind(scope.peerUin);assert.deepEqual(controller.snapshot().replyFocus.messageIds,[])}finally{controller.close();store.close()}
});
test('model receives exact selected targets as quoted data, not a QQ send or quote command',async()=>{
 let input;await generate({apiKey:'fixture',model:'fixture',baseUrl:'http://fixture.invalid/v1'},records,'自然一点',undefined,async(url,args)=>{input=JSON.parse(JSON.parse(args.body).messages[1].content);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({analysis:'接住两个话题',suggestions:[{style:'自然',text:'一个合并回应'},{style:'轻松',text:'另一个回应'},{style:'温柔',text:'第三个回应'}]})}}]})}},{replyMessageIds:[records[0].messageId]});assert.deepEqual(input.replyFocus.messageIds,[records[0].messageId]);assert.ok(input.quotedConversation.some(m=>m.id===records[0].messageId));assert.equal(input.replyFocus.mode,'selected');
});
