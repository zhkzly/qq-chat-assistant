'use strict';
// Synthetic conversations only. Live mode reads the selected provider connection
// without reading the user's QQ database, private chat or model configuration text.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs');
const argv=process.argv.slice(2),option=name=>{const i=argv.indexOf(name);return i<0?null:argv[i+1]},live=argv.includes('--live');
const output=path.resolve(option('--out')||path.join(os.tmpdir(),`qq-direction-goal-${live?'live':'synthetic'}.json`)),limit=Number(option('--max-http')||24);
if(!Number.isSafeInteger(limit)||limit<1||limit>40)throw new Error('Invalid verification HTTP limit');
let provider={model:'synthetic-direction',baseUrl:'http://synthetic.invalid/v1',anonymous:true};
if(live){if(!option('--settings'))throw new Error('Live mode requires explicit settings');const s=JSON.parse(fs.readFileSync(path.resolve(option('--settings')),'utf8'));const p=s.modelProfiles?.find(p=>p.id===s.activeModelProfileId)||s;provider={model:option('--model')||p.model,baseUrl:p.baseUrl,apiKey:p.apiKey,anonymous:p.anonymous===true};}
const root=path.resolve(__dirname,'..'),loaded=Object.keys(require.cache).filter(file=>file.startsWith(path.join(root,'src')+path.sep));
const hashes=()=>Object.fromEntries(loaded.map(file=>[path.relative(root,file),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report={evidence:live?'live_model_synthetic_conversations_real_controller':'synthetic_real_controller_pipeline',startedAt:new Date().toISOString(),model:provider.model,realChatRead:false,qqMessagesSent:0,relationshipOutcomeVerified:false,desktopIntegrationVerified:false,maximumHttpAttempts:limit,codeAtStart:hashes(),steps:[],requests:[]};
let attempts=0,providerErrors=0,phase='',app;
const scrub=value=>JSON.parse(JSON.stringify(value,(_k,v)=>typeof v==='string'&&provider.apiKey?v.split(provider.apiKey).join('[REDACTED_KEY]'):v));
function save(){fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});fs.writeFileSync(output,JSON.stringify(scrub({...report,httpAttempts:attempts,realHttpAttempts:live?attempts:0}),null,2)+'\n',{mode:0o600});}
function mock(p){
 const id=p.intentAuthority?.sourceId||p.userRequest?.sourceId,source=p.sources.find(s=>s.id===id),active=p.topicContext?.active;
 if(p.purpose==='draft')return {kind:'draft',text:'沿当前商量的方向组织表达',suggestions:[{style:'自然',text:phase==='change'?'你玩的那个能一起玩吗？哪天有空想跟你一起试试。':'从对战换到解谜，画风都变了哈哈。'}],methodIds:['compose']};
 const guide={objective:{text:phase==='change'?'真实邀请一起体验游戏':'自然了解她的游戏体验',sourceIds:[id,...(active?.purposeSourceIds||[])].slice(0,16)},allowedApproach:{text:phase==='change'?'直接但允许对方选择':'先用轻松调侃承接，不追问名字',sourceIds:active?.purposeSourceIds||[id]},avoidances:[{text:'不假装自己有相同游戏经历',sourceIds:[id]}]};
 if(phase==='start')return {kind:'discussion',text:'先顺着体验聊，这轮暂不问游戏名或邀约。',topicPatch:{operation:'create',objective:'自然了解她玩的游戏',direction:'先顺着体验聊',constraints:['暂不直接问游戏名','暂不邀请一起玩'],purposeSourceIds:[id],intentQuote:source.text,interpretationStatus:'user_stated'}};
 if(phase==='correct')return {kind:'discussion',text:'这次轻松接话，暂时不追问。',topicPatch:{operation:'update',topicId:active.id,direction:'轻松调侃接话，暂时不追问',constraints:['暂时不追问','暂不邀约'],purposeSourceIds:[id],intentQuote:source.text}};
 if(['draft','change','feedback'].includes(phase)){const result={draftPlan:{quotes:phase==='change'?[{sourceId:id,text:'想和她一起试试'}]:[],intent:'reply',guidance:guide,style:'natural',askFollowup:phase==='change'}};if(phase==='change')result.topicPatch={operation:'update',topicId:active.id,objective:'邀请一起体验游戏',direction:'直接但允许对方选择',constraints:['不假装玩过她的游戏'],purposeSourceIds:[id],intentQuote:source.text};if(phase==='feedback')result.topicPatch={operation:'update',topicId:active.id,direction:'先轻松接话，暂不直接邀约',constraints:['暂不邀约'],purposeSourceIds:[id],intentQuote:source.text};return result;}
 if(phase==='close')return {kind:'discussion',text:'她已说游戏名称，可以结束这次了解，不等于恋爱目标已达成。',topicPatch:{operation:'complete',topicId:active.id,purposeSourceIds:[id],intentQuote:source.text,progress:['她实际说出游戏名称'],observationSourceIds:[p.sources.filter(s=>s.type==='qq').at(-1).id]}};
 if(phase==='new-topic')return {kind:'discussion',text:'这次按考后关心来帮你，不沿用旧游戏方向。',topicPatch:{operation:'create',objective:'关心她考后的状态',direction:'具体轻松回应，不问成绩',constraints:['不问成绩'],purposeSourceIds:[id],intentQuote:source.text}};
 return {kind:'discussion',text:'继续商量当前实际需要'};
}
async function transport(url,args){
 if(attempts>=limit||providerErrors>=2){const e=new Error('Verification stopped at its transport/provider bound');e.code='verification_limit';throw e;}
 const req=JSON.parse(args.body),entry={sequence:++attempts,phase,request:req};report.requests.push(entry);save();
 const p=JSON.parse(req.messages[1].content);const response=live?await fetch(url,args):new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(mock(p))}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
 entry.httpStatus=response.status;if(response.status>=500||response.status===408)providerErrors++;else providerErrors=0;
 if(response.ok){const value=await response.clone().json();entry.response={choices:value.choices,usage:value.usage};}save();return response;
}
async function step(id,text,checks,action){phase=id;const record={id,request:text,status:'running',checks:[],calls:[]};report.steps.push(record);save();const start=attempts;
 try{const answer=action?await action():await app.controller.assist({text,taskId:`verification-${id}`});record.answer=answer?.feedbackContinuation?{continuation:answer.feedbackContinuation,latest:app.store.getCompanion(scope).turns.filter(t=>t.role==='assistant').at(-1)}:answer;record.topic=app.store.topicView(scope);
  for(const [name,check]of checks){try{check(answer,record);record.checks.push({name,status:'pass'})}catch(e){record.checks.push({name,status:'fail',error:e.message})}}
  record.status=record.checks.some(c=>c.status==='fail')?'objective_failure':'objectives_passed_semantic_review_required';
 }catch(e){record.status='execution_failure';record.error={code:e.code||null,message:e.message};record.topic=app.store.topicView(scope);}
 record.httpAttempts=attempts-start;save();return record;
}
(async()=>{
 const store=new Store(':memory:');const controller=new Controller({store,settings:{...provider,auto:false,assistantRequestLimit:4,realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:provider.model,baseUrl:provider.baseUrl}},read:async command=>command==='bind'?scope:{messages:[]},assistantModel:async(s,context,signal)=>{
  const before=structuredClone(context.payload),result=await assistModel(s,context,signal,transport);const effective=context.resultContext||context;
  const call={phase,purpose:context.payload.purpose,initialPayload:before,payload:structuredClone(effective.payload),manifest:structuredClone(effective.manifest),result};report.steps.at(-1).calls.push(call);return result;
 }});app={store,controller};controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);store.setGoal(scope,'与网上认识、有好感的女生发展成双方愿意的恋爱关系。');
 controller.live({scope,messages:[raw('72057594037927937901',false,{elements:[{textElement:{content:'最近不打对战了，改玩解谜闯关'}}]})]});
 if(argv.includes('--only-feedback-exact')){
  report.fixtureSetup='Synthetic source-grounded topic and a recorded-public-style candidate; only continuation is a live execution.';
  const source=store.appendTurn(scope,{role:'user',kind:'discussion',requestId:'synthetic-seed',text:'我想直接邀请她一起试试，但不假装我玩过她的游戏。'});
  const refs=store.memorySources(scope),sid=`private:${source.id}`;
  const receipt=store.applyTopicPatch(scope,{operation:'create',objective:'邀请她一起试试游戏',direction:'直接邀请但保留能否一起玩的余地',constraints:['不假装玩过她的游戏'],purposeSourceIds:[sid],intentQuote:source.text},{baseRevision:store.getCompanion(scope).revision,baseTopicVersion:0,sourceIds:refs.map(r=>r.id),sourceRevisions:Object.fromEntries(refs.map(r=>[r.id,r.revision])),currentSourceId:sid,origin:'private_discussion',requestId:'synthetic-seed'});
  assert.equal(receipt.applied,true);
  const candidate='要是能一起玩的话，我也想和你一起试试解谜闯关。';
  const previous=store.appendTurn(scope,{role:'assistant',kind:'draft',text:'直接邀请一起试试，保留能否一起玩的余地。',requestId:'synthetic-seed-reply',sourceIds:[sid],suggestions:[{style:'自然',text:candidate}]});
  const args={requestId:previous.requestId,targetRef:{kind:'artifact',artifactRef:previous.suggestions[0].artifactRef},text:'这条具体邀请还是太明显了，先轻松接话，暂时不邀约；请直接给我一句具体可发的话。',clientEventId:'exact-feedback',taskId:'exact-continuation'};
  await step('feedback',args.text,[['the exact selected candidate is hydrated',()=>{const f=store.experiences.listFeedback(scope)[0];assert.equal(store.experiences.hydrateFeedback(scope,f.id).target.body,candidate);assert.deepEqual(f.targetRef,args.targetRef)}],['one feedback source produces a usable new draft',answer=>{assert.equal(answer.feedbackContinuation.status,'complete');assert.equal(store.getCompanion(scope).turns.filter(t=>t.role==='assistant').at(-1).kind,'draft');assert.equal(store.memorySources(scope).filter(s=>s.text===args.text).length,1)}]],()=>controller.continueFeedback(args));
 }else{
 await step('start','我想自然了解她玩的游戏，先顺着体验聊，暂时不要直接问游戏名或邀请一起玩。PRIVATE_MOTIVE_SENTINEL：我担心她觉得我太刻意，这个担心仅供私下商量。先帮我商量方向，暂时不用出稿。',[['current local purpose is actually persisted',()=>assert.ok(store.topicView(scope).active)]]);
 await step('correct','我还想轻松一点，用调侃接话就行，暂时不追问；先把这个方向保留。',[['local correction has current user grounding',()=>assert.ok(store.topicView(scope).active?.purposeSourceIds.includes(`private:${store.getCompanion(scope).turns.filter(t=>t.role==='user').at(-1).id}`))]]);
 await step('draft','那给一句吧',[['a directly usable editable draft is produced',answer=>assert.equal(answer?.kind,'draft')],['draft retains source-bound local control without raw private context',(_a,r)=>{const d=r.calls.find(c=>c.purpose==='draft')?.payload;assert.ok(d?.draftingGuidance);for(const key of ['goal','privateConversation','topicContext','workingState'])assert.equal(d[key],undefined);assert.equal(JSON.stringify(d).includes('PRIVATE_MOTIVE_SENTINEL'),false)}]]);
 await step('change','现在我决定直接邀请她一起玩，不用绕着聊了；想和她一起试试，给我一句可发的话，不要假装我玩过她的游戏。',[['new explicit direction produces a draft',answer=>assert.equal(answer?.kind,'draft')],['current purpose includes new user instruction',()=>assert.ok(store.topicView(scope).active?.purposeSourceIds.includes(`private:${store.getCompanion(scope).turns.filter(t=>t.role==='user').at(-1).id}`))]]);
 const target=store.getCompanion(scope).turns.filter(t=>t.role==='assistant'&&t.artifactRef).at(-1);
 const candidateTarget=target.suggestions?.[0]?.artifactRef||target.artifactRef;
 const feedbackArgs={requestId:target.requestId,targetRef:{kind:'artifact',artifactRef:candidateTarget},text:'这个邀请这次还是太明显了，先轻松接话，暂时不邀约；请直接给我一句具体可发的话。',clientEventId:'verification-feedback',taskId:'verification-feedback-continuation'};
 await step('feedback',feedbackArgs.text,[['explicit feedback continuation completes',answer=>assert.equal(answer.feedbackContinuation.status,'complete')],['one canonical feedback source and exact target',()=>{const all=store.experiences.listFeedback(scope);assert.equal(all.length,1);assert.equal(store.memorySources(scope).filter(s=>s.text===feedbackArgs.text).length,1);assert.ok(store.experiences.hydrateFeedback(scope,all[0].id).target.body)}]],()=>controller.continueFeedback(feedbackArgs));
 controller.live({scope,messages:[raw('72057594037927937902',false,{elements:[{textElement:{content:'我玩的是《灯塔谜题》'}}]})]});
 await step('close','她已经告诉我游戏名了，这个小话题结束吧。',[['local topic closes without claiming long-term romantic success',()=>{assert.equal(store.topicView(scope).active,null);assert.ok(store.topicView(scope).retained.some(t=>t.lifecycle==='completed'));assert.equal(store.getCompanion(scope).goal.text,'与网上认识、有好感的女生发展成双方愿意的恋爱关系。')}]]);
 await step('new-topic','换个话题。我想关心她考试后累不累，先不问成绩。只帮我商量这次的方向。',[['a new user purpose is active with its own grounding',()=>{const active=store.topicView(scope).active;assert.ok(active);assert.ok(active.purposeSourceIds.includes(`private:${store.getCompanion(scope).turns.filter(t=>t.role==='user').at(-1).id}`))}]]);
 }
 report.taskUsage=controller.usage.recent(scope,20);report.noBudgetExceeded=report.taskUsage.every(t=>t.attempts<=t.limit);report.feedback=store.experiences.listFeedback(scope);report.finishedAt=new Date().toISOString();report.codeAtEnd=hashes();report.runtimeCodeUnchanged=JSON.stringify(report.codeAtStart)===JSON.stringify(report.codeAtEnd);save();controller.close();store.close();
 console.log(JSON.stringify({report:output,realHttpAttempts:live?attempts:0,steps:report.steps.map(s=>({id:s.id,status:s.status,httpAttempts:s.httpAttempts})),noBudgetExceeded:report.noBudgetExceeded}));
 if(report.steps.some(s=>s.status!=='objectives_passed_semantic_review_required'))process.exitCode=1;
})().catch(e=>{report.error={name:e.name,message:e.message};save();console.error(e.name+': '+e.message);process.exitCode=1;});
