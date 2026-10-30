'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/assistant-protocol.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {scope}=require('./fixtures/native.cjs');
const FACT='我这周终于跑完了五公里';
function fixture(t,{pause=false}={}){
 const store=new Store(':memory:');
 const material=store.appendTurn(scope,{role:'user',kind:'discussion',text:FACT});
 const permission=store.appendTurn(scope,{role:'user',kind:'discussion',text:'跑步这个进展愿意告诉她，其他私人原因不要说。'});
 const inputs=[];let release,started;
 const waiting=new Promise(resolve=>{started=resolve});
 const settings={auto:false,anonymous:true,model:'synthetic-disclosure',baseUrl:'http://synthetic.invalid/v1',
  realChatConsent:{...scope,model:'synthetic-disclosure',baseUrl:'http://synthetic.invalid/v1'}};
 const controller=new Controller({store,settings,read:async()=>({messages:[],source:'synthetic'}),assistantModel:async(_,context)=>{
  inputs.push(context);
  if(context.payload.purpose==='draft'){
   if(pause){started();await new Promise(resolve=>{release=resolve});}
   return {kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:FACT}]};
  }
  return {draftPlan:withCurrentDraftControls({quotes:[{sourceId:`private:${material.id}`,text:FACT,authorization:{
   permission:{sourceId:`private:${permission.id}`,text:'跑步这个进展愿意告诉她'},referent:{sourceId:`private:${material.id}`,text:FACT}}}]},context.payload)};
 }});
 controller.visible=false;controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
 t.after(()=>{controller.close();store.close()});
 const respond=()=>controller.assist({text:'分享刚才那件事，给我一句。',purpose:'discussion',sourceTurnIds:[material.id,permission.id]});
 return {store,controller,material,permission,inputs,respond,waiting,release:()=>release()};
}
test('separate permission evidence is an artifact dependency and its deletion purges dependent output feedback',async t=>{
 const {store,permission,inputs,respond}=fixture(t),reply=await respond(),id=`private:${permission.id}`;
 const draft=inputs.find(input=>input.payload.purpose==='draft');
 assert.ok(draft.manifest.sourceRevisions[id]);
 assert.equal(JSON.stringify(draft.payload).includes('私人原因'),false);
 assert.equal(JSON.stringify(draft.payload).includes('愿意告诉她'),false);
 const artifact=store.experiences.artifact(scope,reply.suggestions[0].artifactRef);
 assert.ok(artifact.sourceRefs.some(ref=>ref.sourceId===id&&ref.revision===draft.manifest.sourceRevisions[id]));
 const feedback=store.addFeedback(scope,{targetRef:{kind:'artifact',artifactRef:reply.suggestions[0].artifactRef},text:'这句需要自然一点'});
 store.forgetSource(scope,id);
 assert.equal(store.experiences.artifact(scope,reply.suggestions[0].artifactRef).availability,'redacted');
 assert.equal(store.experiences.hydrateFeedback(scope,feedback.id),null);
});
test('permission withdrawal during restricted composition discards the late output',async t=>{
 const app=fixture(t,{pause:true}),pending=app.respond();await app.waiting;
 app.controller.deleteTurn(app.permission.id);app.release();assert.equal(await pending,undefined);
 assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,0);
});
