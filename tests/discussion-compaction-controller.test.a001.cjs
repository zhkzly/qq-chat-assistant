'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/assistant-protocol.cjs');
const {assistModel}=require('./fixtures/assistant-protocol.cjs');
const {assistDiscussionCompaction}=require('../src/discussion-compaction.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const FIRST='从对战换到解谜，画风都变了哈哈。',SECOND='这是改成跟关卡斗智斗勇了哈哈。';
function setup(t,{badCompaction=false}={}){
 const store=new Store(':memory:'),calls=[],settings={model:'synthetic',baseUrl:'http://fixture.invalid/v1',anonymous:true,auto:false};
 settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl};
 let oldAssistant,oldUser,folded=null;
 const transport=async(_url,request)=>{
  const envelope=JSON.parse(request.body),p=JSON.parse(envelope.messages[1].content);calls.push(p);
  let result;
  if(p.purpose==='discussion_compaction'){
   const original=p.turns?.length?p:p.originalInput;
   result={summary:'用户想先轻松接话，暂不直接问游戏名字或邀约；助手提出两个候选，尚未发送。',reviewedTurnIds:original.turns.map(x=>x.id),
    quoteRefs:[{turnId:oldAssistant.id,role:'assistant',field:'text',text:badCompaction?'伪造并非原文的候选':FIRST},{turnId:oldAssistant.id,role:'assistant',field:'text',text:SECOND}]};
  }else if(p.purpose==='fidelity_check'){
   result={checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  }else{
   // Compaction is optional: an unfolded payload is acceptable only when it
   // carries its own explicit degradation (ranged/digested views) instead of
   // silently pretending the whole discussion was delivered.
   folded=!!p.discussionCompaction;
   if(p.privateCandidates)assert.ok(p.privateCandidates.some(c=>c.text===SECOND),'the second literal candidate must survive when candidates are offered');
   else assert.ok(JSON.stringify(p.privateConversation||[]).includes(SECOND)||JSON.stringify(p.sources||[]).includes(SECOND),'without folding the candidate stays reachable through the delivered discussion body');
   const intent=p.userRequest.sourceId;
   result={draftPlan:{quotes:[],intent:'reply',style:'natural',askFollowup:false,guidance:{objective:{text:'自然承接她的游戏分享',sourceIds:[intent]},
    allowedApproach:{text:'先轻松调侃，暂不直接追问',sourceIds:[intent]},avoidances:[{text:'不直接邀约，不编造共同经历',sourceIds:[intent]}]}},answer:{privateExplanation:'可编辑的参考表达',suggestions:[{style:'自然',text:SECOND}]}};
  }
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(s,c,signal)=>assistModel(s,c,signal,transport),compactionModel:(s,p,signal)=>assistDiscussionCompaction(s,p,signal,transport)});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 t.after(()=>{controller.close();store.close()});
 return {store,controller,calls,get folded(){return folded;},async seed(){await controller.bind(scope.peerUin);store.setGoal(scope,'和她自然互相了解，发展双方愿意的关系。');
  oldUser=store.appendTurn(scope,{role:'user',kind:'discussion',text:'PRIVATE_MOTIVE_SENTINEL。我想自然接她的话，先不直接问游戏名字，也不邀约。'});
  oldAssistant=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'重复的讨论解释。'.repeat(550)+`\n候选一：${FIRST}\n候选二：${SECOND}`,sourceIds:[`private:${oldUser.id}`]});
  // Source-shaped large consecutive exchange plus legal long assistant text.
  // No actual user records or private model output is used.
  controller.live({scope,messages:[raw('90071992547409931001',false,{elements:[{textElement:{content:'虚构的游戏近况。'.repeat(470)}}]}),
   raw('90071992547409931002',true,{elements:[{textElement:{content:'虚构的近期回应。'.repeat(470)}}]})]});
  return {oldUser,oldAssistant};
 }};
}
test('long discussion automatically compacts once, drafts safely and reuses the validated cache on the next request',async t=>{
 const app=setup(t);const original=await app.seed();
 const first=await app.controller.assist({text:'按第二个给一句完整的话',purpose:'draft',taskId:'compaction-first'});
 const admitted=app.controller.assistantContext().run.payload;assert.equal(JSON.stringify(admitted).includes('PRIVATE_MOTIVE_SENTINEL'),false);assert.equal(admitted.discussionCompaction,undefined);assert.equal(app.calls.at(-1).purpose,'draft_prepare');
 assert.equal(first.suggestions[0].text,SECOND);assert.equal(app.calls.filter(x=>x.purpose==='discussion_compaction').length,1);
 assert.equal(app.store.getCompanion(scope).turns.find(x=>x.id===original.oldAssistant.id).text,original.oldAssistant.text);
 const task=app.controller.usage.get(scope,'compaction-first');assert.equal(task.attempts,2);assert.equal(task.status,'complete');
 assert.equal(app.controller.snapshot().discussionCompaction.phase,'applied');
 const again=await app.controller.assist({text:'沿这个方向再给一句',purpose:'draft',taskId:'compaction-reuse'});
 assert.equal(again.kind,'draft');assert.equal(app.calls.filter(x=>x.purpose==='discussion_compaction').length,1);
 assert.equal(app.controller.usage.get(scope,'compaction-reuse').attempts,1);assert.equal(app.controller.snapshot().discussionCompaction.phase,'reused');
});
test('automatic/quick reply can compact private history without recording a virtual request as evidence',async t=>{
 const app=setup(t);await app.seed();
 const answer=await app.controller.assist({text:'自然接话',purpose:'reply',transient:true,origin:'automatic',taskId:'virtual-reply'});
 assert.equal(answer.kind,'draft');assert.equal(app.controller.usage.get(scope,'virtual-reply').attempts,2);
 assert.equal(app.store.getCompanion(scope).turns.some(x=>x.id==='virtual-reply'&&x.role==='user'),false);
});
test('a failed compaction keeps all originals, counts its bounded repair and proceeds on the degraded context',async t=>{
 const app=setup(t,{badCompaction:true});const original=await app.seed();
 // Compaction failure no longer blocks the request: the answer proceeds on
 // the deterministically degraded context, still bounded by the task budget.
 const answer=await app.controller.assist({text:'按第二个给一句',purpose:'draft',taskId:'bad-compaction'});
 assert.ok(answer,'the assistance stage still produced a usable draft');
 assert.equal(app.calls.filter(x=>x.purpose==='discussion_compaction').length,2,'initial call plus its one bounded repair');
 assert.equal(app.calls.some(p=>p.purpose==='draft'||p.purpose==='draft_prepare'),true);
 assert.equal(app.folded,false,'the degraded path is explicitly unfolded, never a fake fold');
 assert.equal(app.store.getCompanion(scope).turns.find(x=>x.id===original.oldAssistant.id).text,original.oldAssistant.text);
 assert.ok(app.store.getCompanion(scope).turns.some(x=>x.text==='按第二个给一句'));
});
