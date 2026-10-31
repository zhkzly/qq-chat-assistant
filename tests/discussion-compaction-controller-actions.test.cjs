'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {Controller}=require('./fixtures/assistant-protocol.cjs');
const {assistModel}=require('./fixtures/assistant-protocol.cjs');
const {assistDiscussionCompaction}=require('../src/discussion-compaction.cjs');
const {scope,raw}=require('./fixtures/native.cjs');

// Before the applied-action barrier fix, the read-only Controller probe returned:
// {error:'Original discussion turn dependency changed or disappeared',
//  compactCalls:1,helperCalls:2,currentSource:'NEW_PRIVATE_DIRECTION',
//  assistantCount:0,task:'failed'}.
// The original tool output and review message retain this red evidence. All
// values below are synthetic persisted consumer shapes, never private records.
test('a correction after compaction clears retired request provenance and delivers the fresh scoped response',async t=>{
  const store=new Store(':memory:'),calls=[],settings={model:'synthetic',baseUrl:'http://fixture.invalid/v1',anonymous:true,auto:false};
  settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl};
  const command='Correct the earlier text "OLD_PRIVATE_DIRECTION" to "NEW_PRIVATE_DIRECTION" and continue helping.';
  let originalUser,originalAssistant,helperCalls=0;
  const transport=async(_url,request)=>{
    const envelope=JSON.parse(request.body),payload=JSON.parse(envelope.messages[1].content);calls.push(payload);
    const result=payload.purpose==='fidelity_check'?{checkRef:payload.checkRef,verdict:'allow',issues:[]}:payload.purpose==='discussion_compaction'
      ?{summary:'Earlier private direction and generated discussion, without an actual message being sent.',reviewedTurnIds:payload.turns.map(turn=>turn.id),quoteRefs:[]}
      :++helperCalls===1
        ?{kind:'discussion',text:'Apply the requested source correction.',actions:[{type:'correct_source',sourceId:`private:${originalUser.id}`,targetQuote:originalUser.text,evidenceQuote:command,text:'NEW_PRIVATE_DIRECTION'}]}
        :{kind:'discussion',text:'Here is help under the corrected direction.'};
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},
    assistantModel:(s,c,signal)=>assistModel(s,c,signal,transport),compactionModel:(s,p,signal)=>assistDiscussionCompaction(s,p,signal,transport)});
  t.after(()=>{controller.close();store.close()});
  controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
  originalUser=store.appendTurn(scope,{role:'user',kind:'discussion',text:'OLD_PRIVATE_DIRECTION'});
  originalAssistant=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'旧的私下讨论解释。'.repeat(550),sourceIds:[`private:${originalUser.id}`]});
  const answer=await controller.assist({text:command,taskId:'correct-after-compaction'});
  assert.equal(answer.text,'Here is help under the corrected direction.');
  assert.equal(calls.filter(p=>p.purpose==='discussion_compaction').length,1);assert.equal(helperCalls,2);
  const task=controller.usage.get(scope,'correct-after-compaction');assert.equal(task.status,'complete');assert.equal(task.attempts,4);
  const companion=store.getCompanion(scope);assert.equal(companion.turns.find(turn=>turn.id===originalUser.id).text,'NEW_PRIVATE_DIRECTION');
  assert.equal(companion.turns.some(turn=>turn.id===originalAssistant.id),false);
  assert.equal(answer.discussionTurnFingerprints?.[originalAssistant.id],undefined);
  const run=companion.runs.find(run=>run.id==='correct-after-compaction');
  assert.equal(run.requests.some(request=>request.manifest?.discussionCompaction?.turnFingerprints?.[originalAssistant.id]),false);
  assert.equal(run.requests.some(request=>request.payload?.sources?.some(source=>source.id===`private:${originalUser.id}`&&source.text==='OLD_PRIVATE_DIRECTION')),false);
  assert.equal(store.db.prepare('SELECT count(*) n FROM discussion_compactions').get().n,0);
});

for(const limit of [4,5])test(limit===4?'a goal change keeps its new cache but cannot publish unchecked help beyond cap four':'a goal change publishes freshly bound help and reuses its new cache with declared five-call unit budget',async t=>{
  const store=new Store(':memory:'),calls=[],settings={model:'synthetic',baseUrl:'http://fixture.invalid/v1',anonymous:true,auto:false,assistantRequestLimit:limit};
  settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl};
  const command='Set my goal to NEW_ROMANTIC_GOAL and continue helping.';let compactCalls=0,helperCalls=0;
  const transport=async(_url,request)=>{
    const envelope=JSON.parse(request.body),payload=JSON.parse(envelope.messages[1].content);calls.push(payload);
    const result=payload.purpose==='fidelity_check'?{checkRef:payload.checkRef,verdict:'allow',issues:[]}:payload.purpose==='discussion_compaction'
      ?{summary:`COMPACT_META_${++compactCalls}: earlier private discussion and generated explanation; no actual sending.`,reviewedTurnIds:payload.turns.map(turn=>turn.id),quoteRefs:[]}
      :++helperCalls===1
        ?{kind:'discussion',text:'Updating your goal.',actions:[{type:'set_goal',evidenceQuote:command,text:'NEW_ROMANTIC_GOAL'}]}
        :{kind:'discussion',text:'Help with the new goal.'};
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},
    assistantModel:(s,c,signal)=>assistModel(s,c,signal,transport),compactionModel:(s,p,signal)=>assistDiscussionCompaction(s,p,signal,transport)});
  t.after(()=>{controller.close();store.close()});
  controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
  const originalUser=store.appendTurn(scope,{role:'user',kind:'discussion',text:'OLDER_ROMANTIC_GOAL'});
  const originalAssistant=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'重复的讨论解释。'.repeat(550),sourceIds:[`private:${originalUser.id}`]});
  controller.live({scope,messages:[raw('90071992547409931001',false,{elements:[{textElement:{content:'虚构的游戏近况。'.repeat(560)}}]}),
    raw('90071992547409931002',true,{elements:[{textElement:{content:'虚构的近期回应。'.repeat(560)}}]})]});
  if(limit===4)await assert.rejects(controller.assist({text:command,taskId:'goal-after-compaction'}),error=>error.code==='request_budget_exhausted');
  else {const answer=await controller.assist({text:command,taskId:'goal-after-compaction'});assert.equal(answer.text,'Help with the new goal.');}
  assert.equal(compactCalls,2);assert.equal(helperCalls,2);
  const task=controller.usage.get(scope,'goal-after-compaction');assert.equal(task.status,limit===4?'failed':'complete');assert.equal(task.attempts,limit);assert.equal(task.remaining,0);
  const companion=store.getCompanion(scope);assert.equal(companion.goal.text,'NEW_ROMANTIC_GOAL');assert.equal(companion.goal.version,1);
  assert.equal(companion.turns.find(turn=>turn.id===originalAssistant.id).text,originalAssistant.text);
  const caches=store.db.prepare('SELECT record FROM discussion_compactions').all().map(row=>JSON.parse(row.record));
  assert.equal(caches.length,1);assert.equal(caches[0].goalVersion,1);assert.ok(caches[0].summary.startsWith('COMPACT_META_2'));
  const run=companion.runs.find(run=>run.id==='goal-after-compaction');assert.equal(JSON.stringify(run.requests).includes('COMPACT_META_1'),false);assert.equal(companion.turns.filter(turn=>turn.role==='assistant').length,limit===4?1:2,'only checked fresh help is added; the original private discussion remains');
  assert.deepEqual(calls.map(payload=>payload.purpose),['discussion_compaction','discussion','discussion_compaction','discussion',...(limit===5?['fidelity_check']:[])]);
  if(limit===5){
    assert.equal(run.manifest.fidelity.verdict,'allow');assert.equal(controller.snapshot().discussionCompaction.phase,'applied');
    const reused=await controller.assist({text:'Continue helping under the current new goal.',taskId:'goal-after-compaction-reuse'});
    assert.equal(reused.text,'Help with the new goal.');assert.equal(compactCalls,2);assert.equal(helperCalls,3);
    assert.equal(controller.usage.get(scope,'goal-after-compaction-reuse').attempts,2);assert.equal(controller.snapshot().discussionCompaction.phase,'reused');
    assert.equal(store.getCompanion(scope).goal.text,'NEW_ROMANTIC_GOAL');
  }
});

test('a repaired first compaction cannot buy an unbounded second goal epoch beyond the remaining task budget',async t=>{
  const store=new Store(':memory:'),calls=[],settings={model:'synthetic',baseUrl:'http://fixture.invalid/v1',anonymous:true,auto:false,assistantRequestLimit:4};
  settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl};
  const command='Set my goal to NEW_ROMANTIC_GOAL and continue helping.';let compactionHttp=0;
  const transport=async(_url,request)=>{
    const envelope=JSON.parse(request.body),payload=JSON.parse(envelope.messages[1].content);calls.push(payload);let result;
    if(payload.purpose==='discussion_compaction'){
      const original=payload.turns?payload:payload.originalInput;
      result={summary:'Original private discussion; no actual sending.',reviewedTurnIds:++compactionHttp===1?[]:original.turns.map(turn=>turn.id),quoteRefs:[]};
    }else result={kind:'discussion',text:'Update the requested goal.',actions:[{type:'set_goal',evidenceQuote:command,text:'NEW_ROMANTIC_GOAL'}]};
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140}}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},
    assistantModel:(s,c,signal)=>assistModel(s,c,signal,transport),compactionModel:(s,p,signal)=>assistDiscussionCompaction(s,p,signal,transport)});
  t.after(()=>{controller.close();store.close()});
  controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
  const originalUser=store.appendTurn(scope,{role:'user',kind:'discussion',text:'OLDER_ROMANTIC_GOAL'});
  const originalAssistant=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'重复的讨论解释。'.repeat(550),sourceIds:[`private:${originalUser.id}`]});
  controller.live({scope,messages:[raw('90071992547409931001',false,{elements:[{textElement:{content:'虚构的游戏近况。'.repeat(560)}}]}),
    raw('90071992547409931002',true,{elements:[{textElement:{content:'虚构的近期回应。'.repeat(560)}}]})]});
  await assert.rejects(controller.assist({text:command,taskId:'goal-after-repaired-compaction'}),error=>error.code==='compaction_budget_insufficient'&&/原始输入已保留/.test(error.message));
  const task=controller.usage.get(scope,'goal-after-repaired-compaction');assert.equal(task.status,'failed');assert.equal(task.attempts,3);assert.equal(task.remaining,1);
  assert.equal(calls.length,3);assert.equal(compactionHttp,2,'the second HTTP call is the one bounded repair, not a second plan');
  const companion=store.getCompanion(scope);assert.equal(companion.goal.text,'NEW_ROMANTIC_GOAL');assert.equal(companion.turns.find(turn=>turn.id===originalAssistant.id).text,originalAssistant.text);
  assert.equal(companion.turns.filter(turn=>turn.role==='assistant').length,1,'only the original discussion remains');
  assert.equal(store.db.prepare('SELECT count(*) n FROM discussion_compactions').get().n,0,'the old goal checkpoint remains invalid');
});
