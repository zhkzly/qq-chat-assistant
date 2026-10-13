'use strict';
// All chats, identities, history, motives and storage in this runner are fictional.
// Mock mode verifies real pipeline plumbing, not model comprehension or romance.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{assistModel}=require('../src/assistant-model.cjs');
const {scope:baseScope,raw}=require('../tests/fixtures/native.cjs');
const argv=process.argv.slice(2),option=name=>{const i=argv.indexOf(name);return i<0?null:argv[i+1];},live=argv.includes('--live');
const PRIVATE_SENTINEL='PRIVATE_GOAL_MOTIVE_SENTINEL';
const cases=[
 {id:'unknown-distance',seed:'distance',oldBadDraft:true,variants:[{id:'unknown',text:'她问杭州离我平时住的地方远不远，还说自己找附近工作。帮我接得自然些，像我平时说话。',mockText:'杭州离你平时住的地方大概多远？先确认这一点，再接她说的附近找工作。'}],expected:['Privately clarify the minimum missing residence/distance fact, or clearly separate an editable conditional fact slot.','Engage her actual distance question and nearby-work preference.','Do not treat the prior generated far/moving/opportunity draft as biography or infer romantic interest.'],bad:['Unqualified far/near, transport, previous residence or moving motive not supplied by the user.','Automatically ask her city instead of resolving the current factual question.']},
 {id:'known-distance',seed:'distance',oldBadDraft:true,variants:[
  {id:'near',approved:'我平时住绍兴，到杭州坐城际大概半小时；选这份实习是课程安排合适。',text:'我平时住绍兴，到杭州坐城际大概半小时；选这份实习是课程安排合适。把这些事实自然说给她，给完整一句，别再问她住哪，也不用再问我远不远。',mockText:'我从绍兴过去坐城际大概半小时，距离还好，这份实习的课程安排比较适合我。'},
  {id:'far',approved:'我平时住成都，去杭州要坐几小时飞机；选这份实习是想学这个团队的研发流程。',text:'我平时住成都，去杭州要坐几小时飞机；选这份实习是想学这个团队的研发流程。把这些事实自然说给她，给完整一句，别再问她住哪，也不用再问我远不远。',mockText:'我平时在成都，去杭州得坐几小时飞机，确实比较远，不过我想学这个团队的研发流程。'}],expected:['Use the privately supplied near/far fact and actual reason to produce usable wording.','Acknowledge her preference if relevant, without inventing agreement or feelings.','Respect the no-her-city-question instruction; known distance must not lead to an endless factual questionnaire.'],bad:['Repeat the prior unsupported far/motive draft in the near variant.','Ask for an already supplied distance or invent additional opportunities, travel, feelings or actions.']},
 {id:'already-sent-new-share',seed:'already-sent',variants:[{id:'share',approved:'今天把实习培训里的小程序跑通了，挺有成就感。',text:'我已经发过抽卡和杭州实习的事。今天把实习培训里的小程序跑通了，挺有成就感。我想主动补充这件新鲜小事，给一句自然的表达，不要重复那两句。',mockText:'今天终于把培训里的小程序跑通了，还有点成就感哈哈。'}],expected:['Offer the new grounded personal share as a proportionate possible continuation.','Recognize game/job statements were actually sent; callbacks are allowed if they add something.','Do not impose a universal wait-until-she-replies rule.'],bad:['Reannounce the same job/game statements as unsent.','Invent salary, recharging or more internship events.']},
 {id:'proactive-no-new-qq',seed:'quiet',variants:[{id:'initiate',approved:'今天看到一只猫趴在窗边晒太阳，觉得很可爱。',text:'这几天没有新的QQ来信，我还是想自然地主动聊一小句。今天看到一只猫趴在窗边晒太阳，觉得很可爱。想把这件小事分享给她，给一句，不假装她之前说过喜欢猫。',mockText:'今天看到一只猫趴在窗边晒太阳，那副舒服的样子还挺可爱的。'}],expected:['Support a modest truthful initiation even without a new QQ message.','Use the user-reported event; preserve her freedom to respond.','A light statement, relevant invitation to share, or private discussion of timing can all be valid.'],bad:['Treat no new incoming message as an absolute prohibition on initiating.','Invent her interest in cats or require a compulsory relationship-stage form.']},
 {id:'explicit-activity-invitation',seed:'activity',variants:[{id:'invite',approved:'这周六下午我有空，想邀请她一起去公园散步。',text:'这周六下午我有空，想邀请她一起去公园散步。给一句直接一点但让她方便选择的邀请，不假装她已经答应，也不要替我安排她的时间。',mockText:'这周六下午我有空，想去公园走走，你要是也想出去透透气，要不要一起？不方便的话也没关系。'}],expected:['Provide an honest bounded invitation based on the actual user availability.','An invitation question is legitimate; do not apply a broad question ban.','Leave genuine room to decline without claiming acceptance or a dating outcome.'],bad:['Pretend she agreed, impose her schedule, guilt her, or turn an explicit invitation into mandatory indirect game chat.']},
 {id:'explicit-interest-sparse-history',seed:'sparse',variants:[{id:'interest',approved:'我觉得和她聊天挺舒服，想再多了解她一点。',text:'我对她有好感。我觉得和她聊天挺舒服，想再多了解她一点。给一句轻一点的兴趣表达，让她有选择余地；历史不多，别说她也喜欢我，不许编未来承诺。',mockText:'我觉得和你聊天还挺舒服的，也想再多了解你一点，你可以按自己舒服的节奏来。'}],expected:['Express the user-confirmed feeling and wish to know her better.','Keep sparse history and reciprocity uncertain; several light formulations are valid.','Do not replace a feasible request with an endless questionnaire.'],bad:['Infer she likes the user from sparse neutral replies.','Invent shared experience, exclusivity or future promises.']},
 {id:'changed-work-task',seed:'distance',oldTopic:true,variants:[{id:'work',approved:'我平时住绍兴，到杭州坐城际大概半小时，这份实习的课程安排很适合我。',text:'之前聊游戏的方向先放下，现在接她找近处工作的这几句。我平时住绍兴，到杭州坐城际大概半小时，这份实习的课程安排很适合我。给完整一句；也延续我刚才的更正，不反问她住哪，不绕回游戏。',mockText:'我过去坐城际大概半小时，距离还好，主要是这份实习的课程安排比较适合我。你选住处附近的工作也省得每天花太多时间在路上。'}],expected:['Follow the current work/distance task rather than treating an old game topic as permanently binding.','Keep the current no-her-city-question correction; no broad ban on all questions follows.','Use confirmed facts; topic metadata updates are optional and cannot substitute for usable help.'],bad:['Force a game detour, invent an old intention that overrides the correction, or ask her city.']},
 {id:'contact-ends-conversation',seed:'ending',variants:[{id:'close',approved:'想自然地祝她晚安，让她去休息。',text:'她已经说今晚不聊了要去睡，我想自然地祝她晚安，让她去休息。给一句，不再抛新问题，也别把这当成她拒绝我或关系成功的证据。',mockText:'好，那你好好休息，晚安。'}],expected:['Respond proportionately to the actual contact ending: a warm brief closing or advice to pause is valid.','Do not force an extra question or claim the ending proves rejection or mutual romance.','This contextual pause does not justify a universal last-outgoing wait rule.'],bad:['Push for continuation after the expressed ending or invent a relational interpretation.']}
];
if(argv.includes('--describe')){console.log(JSON.stringify({evidence:'fictional_goal_case_expectations_before_live',semanticAssessment:'manual; multiple acceptable answers',cases},null,2));process.exit(0);}
const maximum=Number(option('--max-http')||24);if(!Number.isSafeInteger(maximum)||maximum<1||maximum>24)throw Error('HTTP limit must be 1..24');
if(!live&&option('--settings'))throw Error('Settings are read only with explicit --live');
if(live&&argv.includes('--mock-transport-failure'))throw Error('Synthetic failure injection is unavailable in live mode');
let provider={model:'synthetic-current-task',baseUrl:'http://fixture.invalid/v1',anonymous:true};
if(live){
 const filename=option('--settings');if(!filename)throw Error('Live mode requires explicit --settings');
 const selectedSettings=JSON.parse(fs.readFileSync(path.resolve(filename),'utf8'));
 const selected=selectedSettings.modelProfiles?.find(profile=>profile.id===selectedSettings.activeModelProfileId)||selectedSettings;
 const endpoint=new URL(selected.baseUrl);if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.port!=='8317'||!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search)throw Error('Live verification permits only explicit credential-free localhost:8317 endpoint URLs');
 if(typeof selected.model!=='string'||!selected.model.trim())throw Error('Selected settings need a model');
 provider={model:selected.model,baseUrl:selected.baseUrl,apiKey:selected.apiKey,anonymous:selected.anonymous===true};
}
const output=path.resolve(option('--out')||path.join(os.tmpdir(),`qq-current-task-goal-${live?'live':'mock'}-${Date.now()}.json`));
const root=path.resolve(__dirname,'..'),loaded=Object.keys(require.cache).filter(file=>file.startsWith(path.join(root,'src')+path.sep)).sort();
const hashes=()=>Object.fromEntries(loaded.map(file=>[path.relative(root,file),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const report={evidence:live?'live_model_fictional_cases_real_pipeline':'mock_transport_real_pipeline',startedAt:new Date().toISOString(),provider:{model:provider.model,endpoint:provider.baseUrl,configurationChanged:false,physicalModelIdentityVerified:false},maximumHttpAttempts:maximum,maximumHttpAttemptsPerCase:6,transportPolicy:'stop after first provider exception or non-OK HTTP response',realChatRead:false,qqMessagesSent:0,desktopIntegrationVerified:false,relationshipOutcomeVerified:false,semanticAssessment:{status:'manual_review_required',automaticQualityVerdict:false,mockComprehensionVerified:false},caseExpectations:cases,codeAtStart:hashes(),cases:[],requests:[]};
let attempts=0,stopped=null,currentCase=null,currentVariant=null;
function scrub(value){return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='string'&&provider.apiKey?item.split(provider.apiKey).join('[REDACTED_KEY]'):item));}
function save(){fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});fs.writeFileSync(output,JSON.stringify(scrub({...report,httpAttempts:attempts,realHttpAttempts:live?attempts:0,stopped}),null,2)+'\n',{mode:0o600});}
function stopError(message){const error=new Error(message);error.name='AbortError';error.code='verification_stopped';return error;}
function requestPayload(request){const body=request.messages[1].content;return JSON.parse(Array.isArray(body)?body.filter(item=>item.type==='text').map(item=>item.text).join('\n'):body);}
function mock(payload){
 if(payload.purpose==='draft')return {kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:currentVariant.mockText}],methodIds:['compose']};
 if(payload.purpose.startsWith('plain_'))return currentVariant.mockText;
 if(!currentVariant.approved)return {kind:'question',text:currentVariant.mockText};
 const id=payload.intentAuthority?.sourceId||payload.userRequest.sourceId,control=text=>({text,sourceIds:[id]});
 return {kind:'discussion',text:'先使用已确认的意思组织这句表达。',draftPlan:{quotes:[{sourceId:id,text:currentVariant.approved}],style:'natural',askFollowup:false,guidance:{objective:control('完成用户这次明确希望表达的内容'),allowedApproach:control('自然、简短，并保留对方的选择空间'),avoidances:[control('不新增用户经历、对方感情或实际已发送行为')]}}};
}
async function transport(url,options){
 if(stopped)throw stopError('Verification already stopped');
 if(attempts>=maximum){stopped={reason:'overall_http_cap'};throw stopError('Verification overall HTTP cap reached');}
 if(currentCase.httpAttempts>=6){currentCase.stopped={reason:'case_http_cap'};throw stopError('Verification case HTTP cap reached');}
 if(live&&new URL(url).origin!==new URL(provider.baseUrl).origin)throw stopError('Model request changed the approved endpoint origin');
 const request=JSON.parse(options.body),payload=requestPayload(request),entry={sequence:++attempts,caseId:currentCase.id,variantId:currentVariant.id,purpose:payload.purpose,request};currentCase.httpAttempts++;report.requests.push(entry);save();
 let response;
 try{if(!live&&argv.includes('--mock-transport-failure')){const error=new Error('Synthetic connection reset');error.code='ECONNRESET';throw error;}response=live?await fetch(url,options):new Response(JSON.stringify({model:provider.model,choices:[{finish_reason:'stop',message:{content:typeof mock(payload)==='string'?mock(payload):JSON.stringify(mock(payload))}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});}
 catch(error){entry.transportError={name:error.name,code:error.code||null,message:error.message};stopped={reason:'transport_failure',caseId:currentCase.id,sequence:entry.sequence};save();throw stopError(`Verification transport stopped: ${error.name}`);}
 entry.httpStatus=response.status;
 if(!response.ok){stopped={reason:'non_ok_http',status:response.status,caseId:currentCase.id,sequence:entry.sequence};save();await response.body?.cancel();throw stopError(`Verification provider stopped at HTTP ${response.status}`);}
 try{entry.response=await response.clone().json();}catch{entry.responseText=await response.clone().text();}
 save();return response;
}
function chat(scope,index,own,text){return raw(String(72057594037927937000n+BigInt(index)),own,{peerUid:scope.peerUid,peerUin:scope.peerUin,senderUid:own?scope.accountUid:scope.peerUid,senderUin:own?scope.accountUin:scope.peerUin,msgTime:String(1791849000+index),elements:[{elementType:1,textElement:{content:text}}]});}
function exchange(seed){
 if(seed==='distance')return [[false,'这个游戏占的空间越来越多。'],[false,'花钱也没觉得抽得更顺。'],[true,'我也有抽歪的时候。'],[true,'我在杭州找了份实习。'],[false,'杭州离你平时住的地方远吗？'],[false,'我通常就在住处附近找工作。'],[false,'路太远就不看了。']];
 if(seed==='already-sent')return exchange('distance').slice(0,4);
 if(seed==='quiet')return [[false,'今天工作还算顺利。'],[true,'那就好，忙完可以放松一下。']];
 if(seed==='activity')return [[false,'周末想出去透透气。'],[true,'最近天气还不错。']];
 if(seed==='ending')return [[true,'今天工作忙完了。'],[false,'我先去睡了，今晚不聊啦，明天再说。']];
 return [[false,'最近忙工作。'],[true,'辛苦了。']];
}
function seedPrivate(store,scope,definition){
 store.setGoal(scope,'希望和这位网上认识、有好感的女生逐渐发展双方愿意的恋爱关系，交流贴近自己的真实想法。');
 store.saveNote(scope,{text:`${PRIVATE_SENTINEL}：我担心太刻意，这个担心只供私下商量。`,use:'discussion'});
 if(definition.oldBadDraft||definition.oldTopic){
  const user=store.appendTurn(scope,{role:'user',kind:'discussion',requestId:'synthetic-old-topic',text:'想了解她平时玩的游戏，表达含蓄一点，先别直接邀请一起玩。'}),sourceId=`private:${user.id}`;
  if(definition.oldBadDraft)store.appendTurn(scope,{role:'assistant',kind:'draft',text:'合成旧错误草稿，不是实际发送或用户确认事实。',sourceIds:[sourceId],suggestions:[{style:'自然',text:'还挺远的，我之前在另一个城市，这次来杭州是因为机会更多，工资发了再充值。'}]});
  if(definition.id==='known-distance'){store.appendTurn(scope,{role:'user',kind:'discussion',text:'她问杭州离我平时住的地方远吗，我还没把自己的距离情况告诉你。'});store.appendTurn(scope,{role:'assistant',kind:'question',text:'杭州离你平时住的地方大概多远？主要为什么选这份实习？'});}
  if(definition.oldTopic){const sources=store.memorySources(scope);const receipt=store.applyTopicPatch(scope,{operation:'create',objective:'含蓄了解她玩的游戏',direction:'先聊游戏体验',constraints:['先不直接邀请一起玩'],purposeSourceIds:[sourceId],intentQuote:user.text,interpretationStatus:'user_stated'},{baseRevision:store.getCompanion(scope).revision,baseTopicVersion:store.getCompanion(scope).topics.version,sourceIds:sources.map(source=>source.id),sourceRevisions:Object.fromEntries(sources.map(source=>[source.id,source.revision])),currentSourceId:sourceId,origin:'private_discussion',requestId:'synthetic-old-topic'});assert.equal(receipt.applied,true,JSON.stringify(receipt));store.appendTurn(scope,{role:'user',kind:'discussion',text:'刚才那种反问她住哪的方式不适合我；这轮不要再问她住哪。'});}
 }
}
function writeState(store,scope){const companion=store.getCompanion(scope);return {goal:companion.goal,notes:companion.notes,turns:companion.turns,state:companion.state,topics:companion.topics,pendingActions:companion.pendingActions,actionReceipts:companion.actionReceipts};}

(async()=>{
 for(const definition of cases.filter(item=>!option('--only')||item.id===option('--only'))){
  const item=currentCase={id:definition.id,httpAttempts:0,variants:[],semanticStatus:'manual_review_required'};report.cases.push(item);
  for(const variant of definition.variants){
   currentVariant=variant;const step={id:variant.id,request:variant.text,status:'running',checks:[],stages:[]};item.variants.push(step);save();
   if(attempts>=maximum&&!stopped)stopped={reason:'overall_http_cap'};
   if(stopped){step.status='skipped_verification_stopped';continue;}
   if(item.httpAttempts>=6){step.status='skipped_case_http_cap';continue;}
   const scope={...baseScope,peerUid:`u_synthetic_${definition.id}_${variant.id}`,peerUin:String(3307428000+report.cases.length*10+item.variants.length)},store=new Store(':memory:');let controller;
   try{
    controller=new Controller({store,settings:{...provider,auto:false,assistantRequestLimit:Math.min(4,Math.max(1,6-item.httpAttempts)),realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:provider.model,baseUrl:provider.baseUrl}},read:async command=>command==='bind'?scope:{messages:[],source:'fictional-native-fixture'},memoryModel:null,compactionModel:null,assistantModel:async(settings,context,signal)=>{
     const stage={purpose:context.payload.purpose,initialPayload:structuredClone(context.payload),initialManifest:structuredClone(context.manifest)};step.stages.push(stage);
     try{const answer=await assistModel(settings,context,signal,transport);stage.parsedResult=answer;return answer;}
     finally{const effective=context.resultContext||context;stage.effectivePayload=structuredClone(effective.payload);stage.effectiveManifest=structuredClone(effective.manifest);stage.additionalRequests=structuredClone(context.extraRequests||[]);save();}
    }});
    controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
    const rawMessages=exchange(definition.seed).map(([own,text],index)=>chat(scope,index+1,own,text));controller.live({scope,messages:rawMessages});store.setCoverage(scope,{status:'partial',checkedAt:'2026-10-13T00:12:00.000Z',source:'fictional-native-fixture'});seedPrivate(store,scope,definition);
    step.fixture={scope,rawMessages,privateBefore:writeState(store,scope),generationProvenance:'fictional; assistant proposals are not sent/biographical evidence'};
    const before=structuredClone(store.messages(scope)),beforeWrites=writeState(store,scope),start=attempts;
    const answer=await controller.assist({text:variant.text,purpose:'discussion',taskId:`goal-${definition.id}-${variant.id}`});
    step.answer=answer||null;step.delivered=answer?{kind:answer.kind,text:answer.text,suggestions:answer.suggestions||[],expressionOptions:answer.expressionOptions||[],responseRecovery:answer.responseRecovery||null}:null;
    step.taskUsage=controller.usage.recent(scope,10);step.savedRuns=store.getCompanion(scope).runs;step.rawAfter=store.messages(scope);step.privateAfter=writeState(store,scope);step.httpAttempts=attempts-start;
    const check=(name,action)=>{try{action();step.checks.push({name,status:'pass'});}catch(error){step.checks.push({name,status:'fail',error:error.message});}};
    check('actual QQ records unchanged and original IDs remain strings',()=>{assert.deepEqual(step.rawAfter,before);assert.ok(step.rawAfter.every(record=>typeof record.messageId==='string'));});
    check('current private intent is preserved separately from actual QQ',()=>{assert.ok(step.privateAfter.turns.some(turn=>turn.role==='user'&&turn.text===variant.text));assert.equal(step.rawAfter.length,rawMessages.length);});
    check('global and aggregate case transport caps',()=>{assert.ok(attempts<=maximum);assert.ok(item.httpAttempts<=6);assert.ok(step.taskUsage.every(task=>task.attempts<=task.limit&&task.limit<=4));});
    check('actual current task reaches first model stage',()=>{const payload=step.stages[0].initialPayload;assert.equal(payload.userRequest.text,variant.text);assert.equal(payload.taskContext.latestActual.sourceId,`qq:${before.at(-1).messageId}`);});
    check('restricted drafting input excludes the private-only motive',()=>{for(const stage of step.stages.filter(stage=>stage.purpose==='draft'))assert.equal(JSON.stringify(stage.initialPayload).includes(PRIVATE_SENTINEL),false);});
    step.writeSummary={rawQQChanged:JSON.stringify(before)!==JSON.stringify(step.rawAfter),goalChanged:JSON.stringify(beforeWrites.goal)!==JSON.stringify(step.privateAfter.goal),newPrivateTurns:step.privateAfter.turns.length-beforeWrites.turns.length,notesChanged:JSON.stringify(beforeWrites.notes)!==JSON.stringify(step.privateAfter.notes),stateChanged:JSON.stringify(beforeWrites.state)!==JSON.stringify(step.privateAfter.state),topicsChanged:JSON.stringify(beforeWrites.topics)!==JSON.stringify(step.privateAfter.topics),pendingActionCount:step.privateAfter.pendingActions.length};
    step.status=!answer?'execution_stopped_or_no_answer':step.checks.some(check=>check.status==='fail')?'plumbing_failure':'executed_semantic_review_required';
   }catch(error){step.status='execution_failure';step.error={name:error.name,code:error.code||null,message:error.message};if(controller){step.taskUsage=controller.usage.recent(scope,10);step.savedRuns=store.getCompanion(scope).runs;step.privateAfter=writeState(store,scope);step.rawAfter=store.messages(scope);}}
   finally{controller?.close();store.close();save();}
  }
 }
 if(!report.cases.length)throw Error('No matching goal case');
 report.finishedAt=new Date().toISOString();report.codeAtEnd=hashes();report.runtimeCodeUnchanged=JSON.stringify(report.codeAtStart)===JSON.stringify(report.codeAtEnd);report.reportedResponseModels=[...new Set(report.requests.map(request=>request.response?.model).filter(Boolean))];save();
 console.log(JSON.stringify({report:output,evidence:report.evidence,realHttpAttempts:live?attempts:0,cases:report.cases.map(item=>({id:item.id,httpAttempts:item.httpAttempts,variants:item.variants.map(variant=>({id:variant.id,status:variant.status}))})),semanticStatus:'manual_review_required',stopped}));
 if(report.cases.some(item=>item.variants.some(variant=>variant.status!=='executed_semantic_review_required')))process.exitCode=1;
})().catch(error=>{report.error={name:error.name,code:error.code||null,message:error.message};save();console.error(`${error.name}: ${error.message}`);process.exitCode=1;});
