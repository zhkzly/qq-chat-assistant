'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
test('actual generated-read fingerprints persist and deletion prunes only dependent help',async t=>{
 const scope={accountUid:'fictional-dependency-review',accountUin:'11',peerUid:'fictional-peer',peerUin:'22'},store=new Store(':memory:');
 store.appendTurn(scope,{role:'user',kind:'discussion',text:'Discuss an exhibition.'});
 const old=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'HEAD '+'x'.repeat(66000)+' TAIL_EXPLANATION'});
 const unrelated=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'An unrelated actual help artifact.'});
 let calls=0,reads;const settings={model:'synthetic-readonly',baseUrl:'http://fictional.invalid/v1',anonymous:true,auto:false,discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-readonly',baseUrl:'http://fictional.invalid/v1'}};
 const controller=new Controller({store,settings,read:async()=>({messages:[]}),assistantModel:async(_s,input)=>{calls++;if(calls===1)return {kind:'discussion',text:'Read earlier generated explanation.',lookup:{discussionTurnIds:[old.id],offset:66000,maxChars:200}};reads=input.payload.retrievedDiscussion;return {kind:'discussion',text:'A derivative based on TAIL_EXPLANATION.'};}});
 controller.visible=false;controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};t.after(()=>{controller.close();store.close();});
 const reply=await controller.assist({text:'Explain the old discussion tail.',taskId:'fictional-generated-read-review'});assert.equal(calls,2);assert.ok(reads.some(read=>read.text?.includes('TAIL_EXPLANATION')));
 const run=store.getCompanion(scope).runs.find(r=>r.id==='fictional-generated-read-review'),read=run.requests.flatMap(r=>r.manifest.discussionReads||[]).find(read=>read.turnId===old.id);
 assert.ok(read?.turnFingerprint);assert.equal(reply.discussionTurnFingerprints?.[old.id],read.turnFingerprint);
 store.deleteTurn(scope,old.id);const after=store.getCompanion(scope);assert.ok(!after.turns.some(turn=>turn.id===reply.id));assert.ok(after.turns.some(turn=>turn.id===unrelated.id));
});
