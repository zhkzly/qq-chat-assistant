'use strict';
// Source-shaped fictional Controller/Store/model-transport handoffs. The fake
// responses prove delivered instructions and permissions, not model quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const PRIOR='我想找个轻松幽默的说法，邀请她一起试这个双人拼图。因为PRIVATE_PRIOR_REASON我怕显得刻意。';
const CRITICISM='刚才那句“你是否愿意与我共同体验双人拼图项目？”太做作了，不像平时聊天。';
const NEW_MATERIAL='我周六下午有空';
const OBJECTIVE='邀请她一起试这个双人拼图。';
const APPROACH='保留轻松幽默，借各自计数的小玩笑自然邀请，不用正式项目口吻。';
const payloadFor=request=>{const content=request.messages[1].content;return JSON.parse(typeof content==='string'?content:content[0].text);};
const response=value=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(value)}}]})});

function fixture(t,mode){
 const store=new Store(':memory:'),requests=[];let priorId;
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-carrier-recovery',auto:false,assistantRequestLimit:3,
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-carrier-recovery'}};
 const controller=new Controller({store,settings,memoryModel:null,compactionModel:null,read:async()=>{throw Error('This regression cannot read native QQ');},
  assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_url,request)=>{
   const wire=JSON.parse(request.body),payload=payloadFor(wire);requests.push({wire,payload});
   if(requests.length===1)return response({kind:'discussion',text:'保留你想邀请她的意思，换自然的说法。',draftPlan:{intent:'reply',quotes:[]}});
   if(payload.originalInput){
    const original=payload.originalInput,currentId=original.userRequest.sourceId,ref=text=>({text,sourceIds:[priorId,currentId]});
    const quotes=mode==='unauthorized_old_quote'?[{sourceId:priorId,text:PRIOR}]:mode==='new_material'?[{sourceId:currentId,text:NEW_MATERIAL}]:[];
    return response({kind:'discussion',text:'保留邀请与幽默，只改掉做作的措辞。',draftPlan:{intent:'reply',quotes,
     guidance:{objective:ref(OBJECTIVE),allowedApproach:ref(APPROACH),avoidances:[{text:'不用“共同体验项目”式正式措辞。',sourceIds:[currentId]}]}}});
   }
   assert.equal(payload.purpose,'draft','only a validated plan can reach the third call');
   return response({kind:'draft',text:'用计数的小玩笑轻松邀请。',suggestions:[{style:'自然',text:mode==='new_material'?'我周六下午有空，要不要一起拼，看看谁找到的边角多？':'还能分别计数，要不要一起拼，看看谁找到的边角多？'}]});
  })});
 controller.scope={...scope};controller.ingest(scope,[raw('56801',false,{elements:[{elementType:1,textElement:{content:'这个拼图还能两个人一起拼，会显示各自拼了多少块。'}}]})]);
 const prior=store.appendTurn(scope,{role:'user',kind:'discussion',text:PRIOR});priorId=`private:${prior.id}`;
 store.appendTurn(scope,{role:'assistant',origin:'user',kind:'discussion',text:'这一轮先照你说的方向回应。',sourceIds:[priorId]});
 t.after(()=>{controller.close();store.close();});return {store,controller,requests,priorId};
}

for(const mode of ['guidance_only','new_material'])test(`structured repair preserves prior intent and current correction through real wording: ${mode}`,async t=>{
 const {store,controller,requests,priorId}=fixture(t,mode),taskId=`carrier-repair-${mode}`,text=CRITICISM+(mode==='new_material'?`另外${NEW_MATERIAL}，愿意告诉她这点。`:'');
 const answer=await controller.assist({taskId,text});assert.equal(answer.kind,'draft');assert.equal(requests.length,3);
 const normal=requests[0],repair=requests[1],draft=requests[2].payload,currentId=normal.payload.userRequest.sourceId;
 assert.match(normal.wire.messages[0].content,/quotes[^。]*逐字可外发事实\/素材/);
 assert.match(normal.wire.messages[0].content,/提问、邀请、表意动作和口吻归短guidance/);
 assert.match(normal.wire.messages[0].content,/不必将每个交流目的当事实quote/);
 assert.match(repair.payload.task,/求助要求、交流目的和口吻用guidance承接，不作quotes/);
 assert.match(repair.payload.task,/旧私下quote附authorization:\{permission:\{sourceId,text\},referent:\{sourceId,text\}\}/);
 assert.match(repair.payload.task,/完整上下文、指代、已满足条件及最新限制/);
 assert.match(repair.payload.task,/historicalOnly时先lookup\/clarification/);
 assert.match(repair.payload.task,/selectedOption限其原素材/);
 assert.match(repair.payload.task,/authorizationQuote\/生成回答不授全局许可/);
 assert.doesNotMatch(repair.payload.task,/只回应实际QQ时才可quotes:\[\]/);
 assert.ok(repair.payload.task.includes('当前明确的新分享、邀请或表意'),'repair must retain actual newly authorized meaning');
 assert.equal(repair.payload.originalInput.userRequest.text,text);assert.equal(repair.payload.originalInput.sources.find(source=>source.id===priorId).text,PRIOR);
 assert.equal(draft.purpose,'draft');assert.equal(draft.draftingGuidance.objective.text,OBJECTIVE);assert.equal(draft.draftingGuidance.allowedApproach.text,APPROACH);
 assert.deepEqual(draft.draftingGuidance.objective.sourceIds,[priorId,currentId]);assert.deepEqual(draft.draftingGuidance.allowedApproach.sourceIds,[priorId,currentId]);
 assert.deepEqual(draft.outboundQuotes,mode==='new_material'?[{sourceId:currentId,text:NEW_MATERIAL}]:[]);
 assert.ok(draft.sources.every(source=>source.type==='qq'),'private instructions are control references, not raw composer sources');
 for(const privateBody of [PRIOR,CRITICISM,'PRIVATE_PRIOR_REASON'])assert.equal(JSON.stringify(draft).includes(privateBody),false);
 assert.equal(store.getCompanion(scope).turns.find(turn=>turn.id===priorId.slice('private:'.length)).text,PRIOR);
 const budget=controller.usage.get(scope,taskId);assert.equal(budget.status,'complete');assert.equal(budget.attempts,3);assert.equal(budget.limit,3);
 assert.deepEqual(budget.requests.map(request=>request.purpose),['discussion','format_repair','draft']);
});

test('a repaired plan still cannot promote old private instructions into unauthorized outbound quotes',async t=>{
 const {store,controller,requests}=fixture(t,'unauthorized_old_quote'),taskId='carrier-repair-old-quote-denied';
 await assert.rejects(controller.assist({taskId,text:CRITICISM}),/拟表达内容未能对应本次明确请求或已选分享素材/);
 assert.equal(requests.length,2,'the unauthorized repaired plan must not purchase a wording call');
 assert.ok(!requests.some(request=>request.payload.purpose==='draft'));
 const budget=controller.usage.get(scope,taskId);assert.equal(budget.status,'failed');assert.equal(budget.attempts,2);assert.equal(budget.limit,3);
 const run=store.getCompanion(scope).runs.find(run=>run.id===taskId);assert.equal(run.status,'failed');assert.equal(run.manifest.formatRepair.planningCarrier,true);
});
