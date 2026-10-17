'use strict';
// Real Controller/Store consumers with deterministic local model responses.
// These checks prove delivery and authority boundaries, not wording quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const PREFERENCE='自然口语，简短，别用emoji，因为PRIVATE_CONFIG_REASON我怕显得太认真。';
const UPDATED='语气轻松，可以加点emoji。';
const REQUEST='这次我明确想直接邀请她一起逛展，用轻松幽默的一句话。';
const WORDING='周末一起去逛展吧，看看能不能认出几幅画。';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<30;i++){if(check())return;await tick();}assert.fail('The synthetic consumer did not reach the expected stage');}
function fixture(t,model){
 const store=new Store(':memory:'),calls=[];
 const settings={auto:false,anonymous:true,model:'synthetic-preference-handoff',baseUrl:'http://fixture.invalid/v1',instruction:PREFERENCE,
  realChatConsent:{...scope,model:'synthetic-preference-handoff',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async()=>{throw Error('This regression cannot read native QQ');},
  assistantModel:async(_settings,input)=>{calls.push(structuredClone(input.payload));return model?model(input.payload,calls.length):input.payload.purpose==='draft'
   ?{kind:'draft',text:'按本次明确意思组织的合成参考。',suggestions:[{style:'自然',text:WORDING}]}
   :{kind:'discussion',text:'按本次明确意思组织表达。',draftPlan:plan(input.payload)};}});
 controller.scope={...scope};controller.ingest(scope,[raw('56701',false,{elements:[{textElement:{content:'周末我打算去看那个展。'}}]})]);
 t.after(()=>{controller.close();store.close();});return {controller,store,calls};
}
function plan(payload){return withCurrentDraftControls({intent:'reply',quotes:[]},payload,
 {objective:'这次直接邀请她一起逛展',allowedApproach:'用轻松的邀请句表达用户这次明确确认的意思'});}
function assertSafeDefault(planning,draft){
 assert.equal(planning.taskContext.responsePreference,PREFERENCE);
 assert.ok(draft.wordingControls?.items.some(item=>item.sourceIds.includes('responsePreference')&&/口语/.test(item.text)));
 assert.ok(draft.wordingControls.items.some(item=>/简短/.test(item.text)));
 assert.ok(draft.wordingControls.items.some(item=>/不额外添加 emoji/.test(item.text)));
 assert.equal(JSON.stringify(draft).includes('PRIVATE_CONFIG_REASON'),false);
 assert.equal(draft.taskContext?.responsePreference,undefined);assert.equal(draft.responsePreference,undefined);
 assert.ok(!draft.sources.some(source=>source.id==='responsePreference'),'a configured control is not outbound evidence');
}

test('private assistance delivers the configured preference to planning and safe controls without replacing the current meaning',async t=>{
 const {controller,calls}=fixture(t);const answer=await controller.assist({text:REQUEST,taskId:'private-configured-preference'});
 assert.equal(answer.suggestions[0].text,WORDING);assert.equal(calls.length,2);assert.equal(calls[0].userRequest.text,REQUEST);
 assertSafeDefault(calls[0],calls[1]);assert.equal(calls[1].draftingGuidance.objective.text,'这次直接邀请她一起逛展');
});

test('canonical feedback continuation receives the same configured preference and preserves the exact local feedback',async t=>{
 const {controller,store,calls}=fixture(t),target=store.appendTurn(scope,{role:'assistant',origin:'user',kind:'discussion',text:'一份之前的邀请参考。',requestId:'preference-feedback-target',sourceIds:['qq:56701']});
 const text='我只是不喜欢人工感，这次仍然想直接邀请她逛展。';
 const result=await controller.continueFeedback({taskId:'feedback-configured-preference',clientEventId:'synthetic-preference-feedback',requestId:target.requestId,
  targetRef:{kind:'artifact',artifactRef:target.artifactRef},text});
 assert.equal(result.feedbackContinuation.status,'complete');assert.equal(calls.length,2);assertSafeDefault(calls[0],calls[1]);
 assert.equal(calls[0].sources.find(source=>source.id===calls[0].intentAuthority.sourceId).text,text);
 assert.equal(store.experiences.listFeedback(scope).length,1);
});

test('local wording criticism carries the prior invitation and humor through guidance without authorizing old private text',async t=>{
 const priorText='我想找个轻松幽默的说法，邀请她一起去看这个展。';
 const criticism='刚才那句“你是否愿意与我共同参观艺术展览？”太做作了，不像平时聊天。';
 const objective='邀请她一起去看这个展。',approach='保留轻松幽默的邀请，用认画的小玩笑接她提到的展览，像平时聊天。';
 // Exercise both real handoffs: valid controls and an unauthorized old quote.
 for(const quotePrior of [false,true]){
  let priorId;const {controller,store,calls}=fixture(t,payload=>{
   if(payload.purpose==='draft')return {kind:'draft',text:'按原邀请意思换成自然表达。',suggestions:[{style:'自然',text:WORDING}]};
   const currentId=payload.userRequest.sourceId;
   assert.equal(payload.sources.find(source=>source.id===priorId).text,priorText);
   return {kind:'discussion',text:'保留你想邀请她的意思，只改掉做作的措辞。',draftPlan:{intent:'reply',quotes:quotePrior?[{sourceId:priorId,text:priorText}]:[],
    guidance:{objective:{text:objective,sourceIds:[priorId,currentId]},allowedApproach:{text:approach,sourceIds:[priorId,currentId]},
     avoidances:[{text:'不用“是否愿意与我共同参观”这种正式措辞。',sourceIds:[currentId]}]}}};
  });
  const prior=store.appendTurn(scope,{role:'user',kind:'discussion',text:priorText});priorId=`private:${prior.id}`;
  store.appendTurn(scope,{role:'assistant',origin:'user',kind:'discussion',text:'这一轮先照你说的方向回应。',sourceIds:[priorId]});
  const request={text:criticism,taskId:quotePrior?'local-criticism-unauthorized-quote':'local-criticism-guidance'};
  if(quotePrior){
   await assert.rejects(controller.assist(request),/拟表达内容未能对应本次明确请求或已选分享素材/);
   assert.equal(calls.length,1,'an old private quote without authorization cannot reach the composer');
   assert.equal(controller.usage.get(scope,request.taskId).status,'failed');
  }else{
   const answer=await controller.assist(request);assert.equal(answer.suggestions[0].text,WORDING);assert.equal(calls.length,2);
   const draft=calls[1],currentId=calls[0].userRequest.sourceId;
   assert.equal(draft.purpose,'draft');assert.deepEqual(draft.outboundQuotes,[]);
   assert.equal(draft.draftingGuidance.objective.text,objective);assert.equal(draft.draftingGuidance.allowedApproach.text,approach);
   for(const control of [draft.draftingGuidance.objective,draft.draftingGuidance.allowedApproach])assert.deepEqual(control.sourceIds,[priorId,currentId]);
   assert.ok(draft.sources.some(source=>source.id==='qq:56701'));
   assert.ok(draft.sources.every(source=>source.type==='qq'),'guidance source IDs do not ship raw private sources');
   assert.equal(JSON.stringify(draft).includes(priorText),false);assert.equal(JSON.stringify(draft).includes(criticism),false);
   assert.equal(controller.usage.get(scope,request.taskId).status,'complete');
  }
 }
});

for(const [name,value,expected]of [['string','直接一点','直接一点'],['empty string','',undefined],['null',null,undefined],['undefined',undefined,PREFERENCE]]){
 test(`an explicit ${name} preference keeps its existing override semantics`,async t=>{
  const {controller,calls}=fixture(t);await controller.assist({text:REQUEST,taskId:`preference-override-${name.replace(' ','-')}`,responsePreference:value});
  assert.equal(calls[0].taskContext.responsePreference,expected);assert.equal(controller.instruction,PREFERENCE);
  if(expected===undefined)assert.ok(!calls[1].wordingControls?.items.some(item=>item.sourceIds.includes('responsePreference')));
  else if(value==='直接一点')assert.ok(calls[1].wordingControls?.items.some(item=>/直接表达用户此次已确认的意思/.test(item.text)));
 });
}

test('lookup reassembly retains the preference captured at entry and does not add an extra call for preference handling',async t=>{
 let controller;const app=fixture(t,(payload,index)=>{
  if(index===1){controller.instruction=UPDATED;return {lookup:{query:'展览'}};}
  return payload.purpose==='draft'?{kind:'draft',text:'合成参考',suggestions:[{style:'自然',text:WORDING}]}:{kind:'discussion',text:'查看已有来源后按本次意思表达。',draftPlan:plan(payload)};
 });controller=app.controller;
 await controller.assist({text:REQUEST,taskId:'lookup-configured-preference'});
 assert.equal(app.calls.length,3);assert.equal(app.calls[0].taskContext.responsePreference,PREFERENCE);assertSafeDefault(app.calls[1],app.calls[2]);
 assert.equal(controller.instruction,UPDATED,'a later property value cannot rewrite this request snapshot');
});

test('incoming-message resume carries the original captured default without duplicating private input',async t=>{
 let finishFirst;const {controller,store,calls}=fixture(t,(payload,index)=>index===1?new Promise(resolve=>{finishFirst=resolve}):
  payload.purpose==='draft'?{kind:'draft',text:'合成参考',suggestions:[{style:'自然',text:WORDING}]}:{kind:'discussion',text:'按新实际消息继续同一商量。',draftPlan:plan(payload)});
 const first=controller.assist({text:REQUEST,taskId:'resume-configured-preference'});await until(()=>!!finishFirst);
 controller.ingest(scope,[raw('56702',false,{elements:[{textElement:{content:'展览还有一个互动区。'}}]})]);
 const pending=controller.pendingAssist;assert.ok(pending);clearTimeout(controller.assistantRetryTimer);controller.pendingAssist=null;
 assert.equal(pending.args.responsePreference,PREFERENCE);controller.instruction=UPDATED;
 finishFirst({kind:'discussion',text:'Obsolete synthetic result'});await first;
 await controller.assist({...pending.args,taskId:pending.taskId,resumeTurnId:pending.turnId,resumes:1});
 assert.equal(calls.length,3);assertSafeDefault(calls[1],calls[2]);
 assert.equal(store.getCompanion(scope).turns.filter(turn=>turn.role==='user').length,1);
});

test('a completed task keeps its original retry identity while a new private request reads updated configuration',async t=>{
 const {controller,store,calls}=fixture(t,()=>({kind:'discussion',text:'只讨论本次表达意思。'}));
 const args={text:'先商量，不写句子。',taskId:'preference-original-task'},first=await controller.assist(args);
 assert.equal(calls.length,1,'default preference delivery does not purchase another model call');assert.equal(calls[0].taskContext.responsePreference,PREFERENCE);
 controller.configure({instruction:UPDATED});
 const retried=await controller.assist(args);assert.equal(retried.id,first.id);assert.equal(calls.length,1,'the same taskId remains the original request');
 await controller.assist({...args,taskId:'preference-new-task'});assert.equal(calls.length,2);assert.equal(calls[1].taskContext.responsePreference,UPDATED);
 assert.equal(store.getCompanion(scope).turns.filter(turn=>turn.role==='user').length,2);
});
