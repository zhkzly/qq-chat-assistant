'use strict';
// Fictional goal cases exercise the production Controller and model protocol.
// Synthetic transport demonstrates plumbing only; semantic judgments stay open.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {normalize}=require('../src/messages.cjs'),{methodFor,operationsFor}=require('../src/help-methods.cjs');
const {visibleResponseText}=require('../src/experience-store.cjs');
const sourceRoot=path.resolve(__dirname,'..'),MAIN_ROOT='/home/zhkzly/pycodes/qq-chat-assistant';
const PRIVATE_MARKER='PRIVATE_ONLY_GOAL_ACCEPTANCE_MOTIVE';
const GOAL='希望与这位网上认识、有好感的女生发展双方愿意的恋爱关系。';
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function declarations(){
 const filename=path.join(sourceRoot,'docs/goal-acceptance-scenarios.md'),text=fs.readFileSync(filename,'utf8');
 const criteria={};for(const line of text.split('\n'))if(/^\| (G[1-9]|G8-two-questions) /.test(line)){const parts=line.split('|').map(value=>value.trim()),id=parts[1].split(' ')[0];criteria[id]={declaration:parts[2],expectedGood:parts[3],expectedBad:parts[4]};}
 if(!Array.from({length:8},(_,index)=>`G${index+1}`).every(id=>criteria[id])||!criteria.G9||!criteria['G8-two-questions'])throw Error('The original and appended predeclared goal scenarios are required');
 const original=text.split('\n## Additional boundaries: 2026-10-14 v2')[0];
 return {filename,version:'2026-10-14-v2',sha256:digest(text),originalBoundarySha256:digest(original),criteria};
}
function definitions(extended=false){
 const cases=[
  {id:'G1',label:'user-sharing',request:'今天小苗终于发芽了，想和她分享这个小进展，帮我说一句。',exchange:[[false,'这张游戏截图有点逗'],[true,'哈哈，确实挺逗']]},
  {id:'G2',label:'responding-to-her',request:'她问我离她那边远吗，我该怎么回答？',exchange:[[false,'你离这边远吗？']]},
  {id:'G3',label:'indirect-local-direction',request:'那给一句。',prior:'想慢慢了解她玩的游戏，这轮先轻松接她说不玩 PVP 了的分享，不直接问游戏名，也不邀约。',exchange:[[false,'我不怎么玩PVP，玩点回合制PVE的']]},
  {id:'G4',label:'activity-invitation',request:'这周六下午我有空，想邀请她一起去公园散步，直接一点但方便她选择。',exchange:[[false,'最近下班想出去透透气']]},
  {id:'G5',label:'sparse-interest',request:'我觉得和她聊天挺舒服，想再多了解她一点，帮我轻一点表达。',exchange:[[false,'哈哈，今天还挺巧的']]},
  {id:'G6',label:'reciprocity-uncertainty',request:'最近这些互动，我可以和她更亲近一点吗？下一步怎么做更合适？',exchange:[[true,'今天试着做了道菜'],[false,'听起来不错呀，你做的是什么？'],[true,'简单的番茄炒蛋'],[false,'第一次做这样已经挺好了'],[false,'今天忙完了吗？我刚下班']]},
  {id:'G7',label:'explicit-boundary',request:'听她这么说我有点失落，不知道现在该怎么做。',exchange:[[false,'我只想和你做朋友，不想发展恋爱关系。']]},
  {id:'G8',label:'experience-generalization',request:'她讲今天的加班，我该如何接话？给我一句。',exchange:[[false,'今天加班到现在，刚把事情忙完']],experience:true}
 ];
 if(extended)cases.push({...cases[2],id:'G3-direct',baseId:'G3',label:'explicit-local-direction-change',request:'现在直接问她游戏名吧。'},
  {...cases[5],id:'G6-weak',baseId:'G6',label:'weak-reciprocity-evidence',exchange:[[true,'今天做了道菜'],[false,'哦哦']]},
  {...cases[7],id:'G8-contrary',baseId:'G8',label:'latest-intent-overrides-older-no-questions',contrary:true,
   request:'本轮直接问问她这个项目大概要忙到什么时候，给我一句。',exchange:[[false,'今天加班赶项目，刚收工，后面几天还要继续。']],
   variantCriteria:{expectedGood:'Keep the latest explicit project-time question despite an older approved no-questions approach; retain genuine uncertainty and do not invent project facts.',
    expectedBad:'Apply the old no-questions rule as permanent authority, or mechanically include contradictory allow-question and prohibit-question controls.'}},
  {...cases[2],id:'G9',label:'rationale-request',request:'为什么建议这样回？说明依据，再给一句。',requestedDeliverables:{privateRationale:true,editableWording:true}},
  {...cases[7],id:'G8-two-questions',baseId:'G8',criteriaId:'G8-two-questions',label:'latest-explicit-two-questions',twoQuestions:true,
   request:'本轮我想直接问她这个项目大概要忙多久，以及她现在吃饭了没有，帮我自然地把这两个问题放进一句里。',
   exchange:[[false,'今天加班赶项目，刚收工，后面几天还要继续。']],requestedDeliverables:{editableWording:true,meanings:['project_expected_duration','whether_she_has_eaten']}});
 return cases;
}
function selectedDefinitions(options={}){
 const ids=options.cases||options.only;if(options.cases&&options.only)throw Error('Use either --cases or --only, not both');
 const available=definitions(ids?.length?true:options.extended===true),byId=new Map(available.map(item=>[item.id,item]));
 if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!byId.has(id))))throw Error('Every selected case must be a distinct declared scenario ID');
 return ids?ids.map(id=>byId.get(id)):available;
}
function budgetLimits(options={}){
 const followup=['G3','G8','G9','G8-two-questions'],targeted=options.cases?.length===4&&options.cases.every(id=>followup.includes(id));
 const hardCeiling=targeted?10:options.extended===true?28:24,maxHttp=options.maxHttp??hardCeiling;
 if(!Number.isSafeInteger(maxHttp)||maxHttp<1||maxHttp>hardCeiling)throw Error(`Global HTTP cap must be 1..${hardCeiling}`);
 return {hardCeiling,maxHttp};
}
function hashes(){const files=fs.readdirSync(path.join(sourceRoot,'src')).filter(name=>name.endsWith('.cjs')).map(name=>`src/${name}`);files.push('scripts/goal-acceptance-check.cjs','docs/goal-acceptance-scenarios.md');return Object.fromEntries(files.map(name=>[name,digest(fs.readFileSync(path.join(sourceRoot,name)))]));}
function selectedConnection(){
 const filename=path.join(MAIN_ROOT,'data/settings.json'),bytes=fs.readFileSync(filename),saved=JSON.parse(bytes);
 const profile=saved.modelProfiles?.find(item=>item.id===saved.activeModelProfileId)||saved;
 const provider={model:profile.model,baseUrl:profile.baseUrl,apiKey:profile.apiKey,anonymous:profile.anonymous===true,
  ...(saved.modelResponseMode?{modelResponseMode:saved.modelResponseMode}:{}),
  ...(saved.assistantRequestBytes?{assistantRequestBytes:saved.assistantRequestBytes}:{}),...(saved.assistantContextBytes?{assistantContextBytes:saved.assistantContextBytes}:{})};
 const url=new URL(provider.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Selected model destination contains unsupported credentials or URL parameters');
 if(!provider.model||(!provider.apiKey&&!provider.anonymous))throw Error('The selected MAIN model connection is not ready');
 return {provider,settingsFile:filename,settingsHash:digest(bytes)};
}
function message(scope,index,own,text){return normalize({chatType:1,peerUid:scope.peerUid,peerUin:scope.peerUin,senderUid:own?scope.accountUid:scope.peerUid,
 senderUin:own?scope.accountUin:scope.peerUin,msgId:String(72057594039927937000n+BigInt(index)),msgSeq:String(index),msgTime:String(1791939600+index),
 sendStatus:2,recallTime:'0',elements:[{elementType:1,textElement:{content:text}}]},scope);}
function seed(store,scope,definition){
 store.setGoal(scope,GOAL);store.saveNote(scope,{text:`${PRIVATE_MARKER}：我担心看起来太刻意，这个担心仅供私下讨论。`,use:'discussion'});
 if(definition.prior){const prior=store.appendTurn(scope,{role:'user',kind:'discussion',text:definition.prior});store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'先接她对PVP的分享，保持这轮商量的分寸。',sourceIds:[`private:${prior.id}`]});}
 if(!definition.experience)return [];
 const source=store.appendTurn(scope,{role:'user',kind:'discussion',text:definition.contrary?'以前这类工作分享我希望先回应，不追加问题。':'她分享工作近况时，我希望具体接住内容，不连续追问。'}),sourceId=`private:${source.id}`;
 const output=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'先回应她分享的具体事情，给她表达的空间。',sourceIds:[sourceId],methodIds:['respond']});
 const feedback=store.addFeedback(scope,{text:definition.contrary?'这种先接住分享、暂时不追加问题的帮助适合我。':'这种先接住分享、不连续追问的帮助适合我。',targetRef:{kind:'artifact',artifactRef:output.artifactRef},clientEventId:'fictional-guidance-feedback'});
 const proposals=[
  {label:'approved_applicable',text:definition.contrary?'回应具体工作近况时，先接住分享，不追加问题。':'回应具体近况时，先接住分享，避免连续追问。',
   applicability:definition.contrary?'对方分享工作近况时；这是此前商量的方式，可由最新明确请求调整。':'对方分享日常经历且用户希望自然回应时，不强制禁止必要问题或邀请。',activate:true},
  {label:'unapproved_candidate',text:'每次都应连续问三个问题让聊天继续。',applicability:'对方分享日常近况时。'},
  {label:'withdrawn_guidance',text:'不要回应工作分享，直接换一个话题。',applicability:'对方谈工作日常时。',activate:true,retire:true},
  {label:'approved_unrelated',text:'仅在2026年9月5日下午的公园邀请中确认是否带伞。',applicability:'仅限2026年9月5日那次公园散步邀请，不适用工作近况。',activate:true}
 ];
 return proposals.map(item=>{
  const proposed=store.experiences.proposeFromModel(scope,{text:item.text,applicability:item.applicability,methodId:'respond',sourceIds:[feedback.sourceId],caseIds:[]},
   {allowedSourceIds:[feedback.sourceId],allowedCaseIds:[],deliveredMethods:[methodFor('respond')]});
  let record=proposed;if(item.activate)record=store.experiences.adapt(scope,{operation:'activate',id:record.id,expectedVersion:record.version});
  if(item.retire)record=store.experiences.adapt(scope,{operation:'retire',id:record.id,expectedVersion:record.version});
  return {label:item.label,...record};
 });
}
function fakeResult(payload,definition){
 const id=definition.baseId||definition.id,currentId=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId;
 if(payload.purpose==='draft'){
  const text={G1:'小苗今天终于发芽啦，跟你分享一下这个小进展',G3:definition.id==='G3-direct'?'那你现在玩的是哪款游戏呀？':'PVP有时候确实挺容易上头的哈哈',
   G4:'这周六下午我有空，要不要一起去公园走走？你不方便的话也可以另约时间。',G5:'和你聊天还挺舒服的，想再多了解你一点。',
   G8:definition.twoQuestions?'辛苦啦，这个项目大概要忙多久呀，你现在吃饭了吗？':definition.contrary?'辛苦啦，你这个项目大概还要忙到什么时候呀？':'辛苦啦，终于忙完可以歇一会儿了',
   G9:'哦哦，回合制PVE呀，跟PVP是另一种画风了哈哈'}[id];
  return {kind:'draft',text:'根据这次商量组织一条参考表达。',suggestions:[{style:'自然',text}]};
 }
 if(id==='G2')return {kind:'question',text:'还不知道你现在离她那边大概多远，这会改变怎么回答。',draftPlan:{clarification:'你现在离她那边大概多远？'}};
 if(id==='G6')return {kind:'discussion',text:definition.id==='G6-weak'?'这条普通回应不足以判断恋爱意愿。可以按你的真实想法分享近况，不必先猜她的态度。':'她有回应和主动联系的具体表现，但还不能据此确定恋爱意愿。可以考虑分享一点近况或一个方便她选择的邀请。',methodIds:['choose_next_step','express_interest']};
 if(id==='G7')return {kind:'discussion',text:'失落可以理解，她已经明确表示只想做朋友。可以先想清楚友情是否适合你，或者给自己一点距离；这不等于你已经决定更改长期目标。',methodIds:['review']};
 const control=text=>({text,sourceIds:[currentId]}),guidance={objective:control('按本次真实意思提供帮助'),allowedApproach:control('保持最新商量的表达方式'),avoidances:[]};
 if(id==='G3'||id==='G9'){guidance.allowedApproach=control(definition.id==='G3-direct'?'本轮直接询问她玩的游戏名':'先轻松接住PVP的分享');guidance.avoidances=definition.id==='G3-direct'?[]:[control('本轮不直接问游戏名，也不邀约')];}
 if(definition.contrary)guidance.allowedApproach=control('按本轮最新请求询问项目后续时间，覆盖此前不追加问题的方式');
 if(definition.twoQuestions)guidance.allowedApproach=control('本轮按最新请求保留项目预计时长和是否吃饭两个问题，不让旧经验删掉其中一个');
 const quotes=id==='G1'?['今天小苗终于发芽了']:id==='G4'?['这周六下午我有空','邀请她一起去公园散步']:id==='G5'?['我觉得和她聊天挺舒服','想再多了解她一点']:[];
 return {kind:'discussion',text:id==='G9'?'她明确说不怎么玩PVP、玩点回合制PVE；你的长期目标是自然发展关系，但这轮已经明确不问名字也不邀约。因此先接她分享的内容，给她自然展开空间；这种回复不能证明关系一定会更亲近。':'这是合成运输夹具提供的解释，只证明上下文交接和界面产物能够保留，不证明模型理解或恋爱效果。',
  draftPlan:{quotes:quotes.map(text=>({sourceId:currentId,text})),...(quotes.length?{}:{intent:'reply'}),guidance},methodIds:[id==='G4'?'shared_activity':id==='G5'?'express_interest':'respond']};
}
function stopError(message,code='verification_stopped'){const error=new Error(message);error.name='AbortError';error.code=code;return error;}
function packetPayload(request){const content=request.messages?.[1]?.content;if(typeof content!=='string')throw Error('Acceptance harness must remain text-only');return JSON.parse(content);}
function redacted(value,key){return JSON.stringify(value,(_name,item)=>typeof item==='string'&&key?item.split(key).join('[redacted]'):item,2);}
function methodDelivery(stage,wire){
 const entries=wire.filter(entry=>{const payload=packetPayload(entry.request);return (payload.originalInput||payload).purpose===stage.purpose;});
 const directoryNavigation=(stage.effectivePayload.methodCatalog||[]).map(method=>{
  const locations=[];
  for(const entry of entries){const input=packetPayload(entry.request),payload=input.originalInput||input;
   if(payload.methodCatalog?.some(item=>item.id===method.id&&item.version===method.version))locations.push({sequence:entry.sequence,location:'payload.methodCatalog.metadata'});
  }
  return {id:method.id,version:method.version,provided:locations.length>0,locations,authority:'navigation_only'};
 });
 const methods=[...new Map([...(stage.effectivePayload.methodCatalog||[]),...(stage.effectivePayload.methodCards||[])].map(method=>[method.id,method])).values()];
 const instructionDelivery=methods.map(method=>{
  const expected=operationsFor([method.id]),locations=[];
  for(const entry of entries){const input=packetPayload(entry.request),payload=input.originalInput||input;
   if(payload.methodCatalog?.some(item=>item.id===method.id&&item.instruction))locations.push({sequence:entry.sequence,location:'payload.methodCatalog.instruction'});
   if(payload.methodCards?.some(item=>item.id===method.id&&item.instruction))locations.push({sequence:entry.sequence,location:'payload.methodCards.instruction'});
   if(expected&&entry.request.messages[0].content.includes(expected))locations.push({sequence:entry.sequence,location:'system.canonicalOperations'});
  }
  return {id:method.id,version:method.version,provided:locations.length>0,locations};
 });
 return {purpose:stage.purpose,directoryNavigation,instructionDelivery,operationalDelivery:stage.effectiveManifest.methodTrace?.operationalDelivery||null,
  expandedCards:(stage.effectivePayload.methodCards||[]).map(method=>({id:method.id,version:method.version,location:'payload.methodCards.instruction',provided:!!method.instruction})),
  reportedApplied:stage.effectiveManifest.methodTrace?.reported||null,reportedUseAuthority:'model_report_only_not_observed_adoption'};
}
async function runHarness(options={}){
 if(options.live!==undefined&&typeof options.live!=='boolean')throw Error('Live mode requires an explicit boolean');
 const declared=declarations(),{hardCeiling,maxHttp}=budgetLimits(options);
 const cases=selectedDefinitions(options),selected=options.live?selectedConnection():{provider:{model:'synthetic-goal-acceptance',baseUrl:'http://fictional.invalid/v1',anonymous:true}};
 const provider=selected.provider,modelOrigin=new URL(provider.baseUrl).origin;
 if(!cases.length)throw Error('No matching predeclared scenarios');
 if(options.out){const output=path.resolve(options.out),privateRoots=[path.join(MAIN_ROOT,'data'),path.join(sourceRoot,'data')];
  if(!output.endsWith('.json')||privateRoots.some(root=>output===root||output.startsWith(root+path.sep))||output.includes(`${path.sep}.git${path.sep}`)||fs.existsSync(output))throw Error('Report must use a new JSON path outside private data and Git internals');
  options={...options,out:output};fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,'',{flag:'wx',mode:0o600});
 }
 const report={schemaVersion:1,evidence:options.live?'live_model_with_fictional_context':'synthetic_transport_pipeline_only',semanticVerdict:'requires_independent_review',sourceRoot,
  declarations:{path:declared.filename,version:declared.version,sha256:declared.sha256,originalBoundarySha256:declared.originalBoundarySha256},sourceHashesAtStart:hashes(),selectedModel:provider.model,selectedDestination:{origin:modelOrigin,path:new URL(provider.baseUrl).pathname},
  settingsReadOnly:!!options.live,limits:{globalHttp:maxHttp,hardCeiling,perTask:4,automatic:false,memoryModel:false,compactionModel:false,images:false,
   transportPolicy:'stop suite on first transport failure or non-ok HTTP; production automatic retry prevented by harness AbortError'},startedAt:new Date().toISOString(),requests:[],cases:[]};
 let attempts=0,stopped=null,current;
 const save=()=>{if(options.out)fs.writeFileSync(options.out,redacted(report,provider.apiKey),{mode:0o600});};
 const transport=async(url,args)=>{
  if(stopped)throw stopError('Acceptance already stopped');
  if(selected.settingsFile&&digest(fs.readFileSync(selected.settingsFile))!==selected.settingsHash){stopped={reason:'selected_connection_changed'};throw stopError('Selected MAIN connection changed; acceptance stopped');}
  if(attempts>=maxHttp){stopped={reason:'global_http_cap'};throw stopError('Global HTTP cap reached','acceptance_http_cap');}
  if(new URL(url).origin!==modelOrigin)throw stopError('Model destination changed');
  const request=JSON.parse(args.body),payload=packetPayload(request),entry={sequence:++attempts,caseId:current.id,purpose:payload.purpose,request,
   requestBytes:Buffer.byteLength(args.body),model:request.model,responseMode:request.tools?'result_tool':request.response_format?.type||'plain_text'};
  report.requests.push(entry);current.httpAttempts++;save();
  options.onProgress?.({event:'model_request',caseId:current.id,sequence:entry.sequence,purpose:payload.purpose});
  let response;
  try{if(options.live)response=await (options.fetchImpl||fetch)(url,args);else{const value=await (options.syntheticResponder||fakeResult)(payload.originalInput||payload,current.definition);
   response=new Response(JSON.stringify({model:provider.model,choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200});}}
  catch(error){entry.failure={name:error.name,code:error.code||null};stopped={reason:'transport_failure',caseId:current.id};save();throw stopError('Model transport failed; bounded acceptance stopped');}
  entry.httpStatus=response.status;
  if(!response.ok){stopped={reason:'non_ok_http',status:response.status,caseId:current.id};await response.body?.cancel?.();save();throw stopError(`Model returned HTTP ${response.status}; acceptance stopped`);}
  try{entry.response=await response.clone().json();}catch{entry.responseShape='not_json';}
  save();return response;
 };
 for(const definition of cases){
  const baseId=definition.criteriaId||definition.baseId||definition.id,item=current={id:definition.id,label:definition.label,request:definition.request,definition,
   criteria:{...declared.criteria[baseId],...(definition.variantCriteria?{variant:definition.variantCriteria}:{})},requestedDeliverables:definition.requestedDeliverables||null,
   semanticVerdict:'requires_independent_review',httpAttempts:0,status:'running',stages:[],checks:[]};
  report.cases.push(item);if(stopped){item.status='skipped_verification_stopped';save();continue;}
  const scope={accountUid:'fictional_owner',accountUin:'1111111111',peerUid:`fictional_${definition.id}`,peerUin:String(3307000000+report.cases.length)},store=new Store(':memory:');let controller;
  const check=(name,valid,detail=null)=>item.checks.push({name,status:valid?'pass':'fail',...(detail?{detail}:{})});
  try{
   const records=definition.exchange.map(([own,text],index)=>message(scope,index+1,own,text));store.add(scope,records);
   store.setCoverage(scope,{status:'partial',checkedAt:'2026-10-14T01:00:00.000Z',source:'fictional-native-shaped-seed'});
   item.guidanceSeeds=seed(store,scope,definition);const before=clone(store.messages(scope)),goalBefore=clone(store.getCompanion(scope).goal);
   item.fixture={scope,records:before,priorPrivateDirection:definition.prior||null,privateMarker:PRIVATE_MARKER,goal:goalBefore};
   const settings={...provider,auto:false,autoImages:false,visionEnabled:false,assistantRequestLimit:4,
    realChatConsent:{...scope,model:provider.model,baseUrl:provider.baseUrl}};
   controller=new Controller({store,settings,memoryModel:null,compactionModel:null,read:async()=>{throw Error('No actual QQ read is available in goal acceptance');},
    assistantModel:async(configured,input,signal)=>{
     const stage={purpose:input.payload.purpose,initialPayload:clone(input.payload),initialManifest:clone(input.manifest)};item.stages.push(stage);
     try{const result=await assistModel(configured,input,signal,transport);stage.result=clone(result);return result;}
     finally{const effective=input.resultContext||input;stage.effectivePayload=clone(effective.payload);stage.effectiveManifest=clone(effective.manifest);stage.extraRequests=clone(input.extraRequests||[]);save();}
    }});
   controller.visible=false;controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
   const reply=await controller.assist({text:definition.request,purpose:'discussion',taskId:`acceptance-${definition.id}`});item.reply=reply?clone(reply):null;
   item.visibleHelp=reply?visibleResponseText(reply):null;item.controls=item.stages.filter(stage=>stage.purpose==='draft').map(stage=>stage.effectivePayload.draftingGuidance||null);
   item.observedDeliverables={privateRationale:!!reply?.discussionExplanation?.text,editableWordingCount:reply?.suggestions?.length||0};
   const after=store.getCompanion(scope);item.goalAfter=after.goal;item.actualRecordsAfter=store.messages(scope);item.tasks=controller.usage.recent(scope,4);item.savedRuns=after.runs;
   check('actual QQ records and string message IDs preserved',JSON.stringify(item.actualRecordsAfter)===JSON.stringify(before)&&item.actualRecordsAfter.every(record=>typeof record.messageId==='string'));
   check('four-field scoped evidence preserved',item.stages.every(stage=>JSON.stringify(stage.effectiveManifest.scope)===JSON.stringify(scope)));
   check('long-term goal remains user-owned',JSON.stringify(goalBefore)===JSON.stringify(after.goal));
   check('current request preserved in first planning input',item.stages[0]?.initialPayload.userRequest.text===definition.request);
   check('per-task and global calls bounded',attempts<=maxHttp&&item.tasks.every(task=>task.limit<=4&&task.attempts<=task.limit));
   check('no image content enters model requests',report.requests.filter(entry=>entry.caseId===item.id).every(entry=>typeof entry.request.messages[1].content==='string'));
   check('restricted drafts exclude private marker and rationale',item.stages.filter(stage=>stage.purpose==='draft').every(stage=>!JSON.stringify(stage.effectivePayload).includes(PRIVATE_MARKER)&&
    !stage.effectivePayload.userRequest&&!stage.effectivePayload.goal&&!stage.effectivePayload.privateConversation&&(!reply?.discussionExplanation||!JSON.stringify(stage.effectivePayload).includes(reply.discussionExplanation.text))));
   if(reply){const responseArtifact=store.experiences.artifact(scope,reply.artifactRef);check('response artifact equals visible private help',responseArtifact?.body===item.visibleHelp);
    check('draft artifacts contain only editable wording',(reply.suggestions||[]).every(suggestion=>store.experiences.artifact(scope,suggestion.artifactRef)?.body===suggestion.text));}
   item.guidanceDelivery=item.stages.map(stage=>({purpose:stage.purpose,entries:stage.effectivePayload.experienceContext?.adaptations||[]}));
   if(definition.experience){const delivered=item.guidanceDelivery.flatMap(stage=>stage.entries),blocked=new Set(item.guidanceSeeds.filter(record=>['candidate','retired'].includes(record.status)).map(record=>record.id));
    check('unapproved and withdrawn guidance absent as authority',delivered.every(record=>!blocked.has(record.id)));
    const approved=item.guidanceSeeds.find(record=>record.label==='approved_applicable');check('approved paraphrased guidance supplied for applicability review',delivered.some(record=>record.id===approved.id&&record.applicabilityStatus==='needs_model_check'));
   }
   item.status=!reply?'no_completed_reply':item.checks.some(check=>check.status==='fail')?'deterministic_failure':'executed_semantic_review_required';
  }catch(error){item.status='execution_failure';item.error={name:error.name,code:error.code||null,message:error.message};if(controller){item.tasks=controller.usage.recent(scope,4);item.savedRuns=store.getCompanion(scope).runs;}}
  finally{item.methodDelivery=item.stages.map(stage=>methodDelivery(stage,report.requests.filter(entry=>entry.caseId===item.id)));delete item.definition;controller?.close();store.close();save();
   options.onProgress?.({event:'case_finished',caseId:item.id,status:item.status,httpAttempts:item.httpAttempts});}
 }
 report.finishedAt=new Date().toISOString();report.httpAttempts=attempts;report.realHttpAttempts=options.live?attempts:0;report.stopped=stopped;
 report.sourceHashesAtEnd=hashes();report.sourceUnchanged=JSON.stringify(report.sourceHashesAtStart)===JSON.stringify(report.sourceHashesAtEnd);
 report.mainSettingsUnchanged=selected.settingsFile?digest(fs.readFileSync(selected.settingsFile))===selected.settingsHash:null;
 report.reportedResponseModels=[...new Set(report.requests.map(entry=>entry.response?.model).filter(Boolean))];report.physicalProviderIdentityVerified=false;save();return report;
}
function argument(argv,name){const index=argv.indexOf(name);return index<0?undefined:argv[index+1];}
async function main(argv){
 const extended=argv.includes('--extended'),declared=declarations(),selection={extended,cases:argument(argv,'--cases')?.split(',').map(id=>id.trim()),only:argument(argv,'--only')?.split(',').map(id=>id.trim())},
  requestedMax=argument(argv,'--max-http')?Number(argument(argv,'--max-http')):undefined;
 if(argv.includes('--describe')){const limits=budgetLimits({...selection,maxHttp:requestedMax});console.log(JSON.stringify({sourceRoot,declarations:declared,scenarios:selectedDefinitions(selection),limits:{globalHttp:limits.maxHttp,hardCeiling:limits.hardCeiling,perTask:4},semanticVerdict:'requires_independent_review'},null,2));return;}
 const output=path.resolve(argument(argv,'--out')||`/tmp/qq-goal-acceptance-${Date.now()}-${process.pid}.json`);
 const report=await runHarness({extended,live:argv.includes('--live'),out:output,maxHttp:requestedMax,
  ...selection,onProgress:event=>console.log(JSON.stringify(event))});
 console.log(JSON.stringify({report:output,evidence:report.evidence,selectedModel:report.selectedModel,httpAttempts:report.httpAttempts,realHttpAttempts:report.realHttpAttempts,
  cases:report.cases.map(item=>({id:item.id,status:item.status})),sourceUnchanged:report.sourceUnchanged,mainSettingsUnchanged:report.mainSettingsUnchanged,semanticVerdict:report.semanticVerdict,stopped:report.stopped}));
 if(report.cases.some(item=>item.status!=='executed_semantic_review_required')||!report.sourceUnchanged||report.mainSettingsUnchanged===false)process.exitCode=1;
}
module.exports={runHarness,definitions,declarations,selectedDefinitions,selectedConnection};
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(`${error.name}: ${error.message}`);process.exitCode=1;});
