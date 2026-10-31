'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseAssistant,requireDraftControlGuidance,assistModel}=require('./fixtures/assistant-protocol.cjs');
const current={id:'private:current',type:'private',role:'user',revision:'current-control-r1',text:'先接游戏吐槽，暂时不要问游戏名，给完整的一句'},
  previous={id:'private:previous',type:'private',role:'user',revision:'previous-control-r1',text:'上次想了解游戏名字'},
  incoming={id:'qq:72057594037927937',type:'qq',role:'contact',revision:'qq-control-r1',text:'我不怎么玩PVP，玩点回合制PVE'};
const payload={sources:[previous,incoming,current],userRequest:{sourceId:current.id,text:current.text},intentAuthority:{sourceId:current.id},
  topicContext:{active:null},taskContext:{draftControlPolicy:{version:1,required:true,requiredFields:['objective','allowedApproach','avoidances'],intentSourceId:current.id}}};
const ref=text=>({text,sourceIds:[current.id]}),complete={objective:ref('回应她的游戏习惯'),allowedApproach:ref('先接吐槽，自然接话'),avoidances:[ref('暂时不直接问游戏名')]};
const envelope=guidance=>({kind:'discussion',text:'先接她的吐槽，保持本次分寸。',draftPlan:{intent:'reply',quotes:[],...(guidance?{guidance}:{})}});
test('a new task requires complete local control evaluation even without a stored topic',()=>{
  assert.throws(()=>parseAssistant(envelope(),'discussion',payload),/objective.*allowedApproach.*avoidances.*sourceIds/);
  for(const field of ['objective','allowedApproach','avoidances']){const partial=structuredClone(complete);delete partial[field];assert.throws(()=>parseAssistant(envelope(partial),'discussion',payload),new RegExp(`guidance\\.${field}`));}
  const parsed=parseAssistant(envelope(complete),'discussion',payload);
  assert.deepEqual(parsed.draftPlan.guidance,complete);assert.equal(parsed.text,envelope(complete).text);
});
test('an explicit empty avoidances array means evaluated none, while omission is rejected',()=>{
  const safe={...complete,avoidances:[]};assert.doesNotThrow(()=>requireDraftControlGuidance(safe,payload));
  assert.deepEqual(parseAssistant(envelope(safe),'discussion',payload).draftPlan.guidance.avoidances,[]);
});
test('old-only and QQ-only controls cannot silently replace the current private intent',()=>{
  const oldOnly={objective:{text:'继续旧目的',sourceIds:[previous.id]},allowedApproach:{text:'采用旧方式',sourceIds:[previous.id]},avoidances:[]};
  assert.throws(()=>parseAssistant(envelope(oldOnly),'discussion',payload),/current intent private:current/);
  const qqOnly={...complete,allowedApproach:{text:'替用户决定现在直接问游戏名',sourceIds:[incoming.id]}};
  assert.throws(()=>parseAssistant(envelope(qqOnly),'discussion',payload),/QQ alone/);
  const linked={...oldOnly,currentStep:ref('根据当前请求重新审核这句')};assert.doesNotThrow(()=>parseAssistant(envelope(linked),'discussion',payload));
});
test('legacy replay keeps its prior planning contract and a clarification does not pretend controls were completed',()=>{
  const legacy={...payload,taskContext:{}};assert.doesNotThrow(()=>parseAssistant(envelope(),'discussion',legacy));
  const question=parseAssistant({kind:'question',text:'我还缺少会影响表达的必要事实。',draftPlan:{clarification:'你说的是哪种情况？'}},'discussion',payload);
  assert.equal(question.kind,'question');assert.equal(question.draftPlan.guidance,undefined);
});
test('one structural repair keeps whole-answer ownership without the isolated legacy guidance contract',async()=>{
  const context={payload:{...payload,purpose:'discussion'},manifest:{}},requests=[],settings={model:'synthetic',anonymous:true,baseUrl:'http://synthetic.invalid/v1'};
  const result=await assistModel(settings,context,undefined,async(_,request)=>{requests.push(JSON.parse(request.body));return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({operation:'prepare_message',answer:requests.length===1?{suggestions:'malformed'}:{suggestions:[{text:'先接住她的吐槽。'}]}})}}]})};});
  assert.equal(requests.length,2);assert.equal(result.kind,'draft');assert.equal(result.draftPlan,undefined);
  const repair=JSON.parse(requests[1].messages[1].content);
  assert.equal(requests[1].messages[0].content.includes('draftControlPolicy.required须objective/allowedApproach/avoidances'),false);assert.match(repair.task,/answer/);
  assert.equal(repair.originalInput.taskContext.draftControlPolicy,undefined);assert.equal(result.kind,'draft');assert.equal(result.draftPlan,undefined);assert.ok(!repair.task.includes('没有当前有效话题，不强制guidance'));
});
