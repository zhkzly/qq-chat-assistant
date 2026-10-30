'use strict';
const {withRequestDelivery,withCurrentStatementAuthority,withPrimaryOperation}=require('./synthetic-request-delivery.cjs');
// Fictional production-path probes. Semantic judgments are deliberately not automated.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const vm = require('node:vm'), { createRequire } = require('node:module');
const RUNNER_ROOT = path.resolve(__dirname, '..');
const MAIN_ROOT = '/home/zhkzly/pycodes/qq-chat-assistant';
const GOAL = '希望与这位网上认识、有好感的女生发展双方愿意的恋爱关系。';
const PRIVATE_MARKER = 'FICTIONAL_PRIVATE_HELP_CHECK';
const AS_OF = '2026-10-16T01:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function definitions() {
  const liveRequest = '想自然接着聊，慢慢了解她的生活。先给我一个具体方向，再给一句完整的话。';
  const shop = [[false,'下班路上看到一家小书店，小猫坐在柜台上'],[true,'哈哈它是收银员吧'],[false,'还一脸不耐烦']];
  const repair = [[false,'咖啡机卡住了，折腾了好一会儿'],[true,'要不明天再弄吧']];
  const personalRequest = '想回应她，也分享一点自己的近况，但还没想好说什么，帮我想想。';
  return [
    { id:'Q0-manual-delayed', family:'Q1', exchange:shop, ageMs:17*3600000, invocation:'manual', request:null },
    { id:'Q0-auto-delayed', family:'Q1', exchange:shop, ageMs:17*3600000, invocation:'automatic', request:null },
    { id:'Q1-live', family:'Q1', exchange:shop, ageMs:60000, request:liveRequest },
    { id:'Q1-delayed', family:'Q1', exchange:shop, ageMs:17*3600000, request:liveRequest },
    { id:'Q2-paused', family:'Q2', exchange:[...repair,[false,'嗯，明天再弄']], ageMs:120000,
      request:'她这是结束聊天了吗？我还想和她多聊一点，帮我判断，再给一句合适的回应。' },
    { id:'Q2-closed', family:'Q2', exchange:[...repair,[false,'嗯，我先睡了，明天再聊']], ageMs:120000,
      request:'她这是结束聊天了吗？我还想和她多聊一点，帮我判断，再给一句合适的回应。' },
    { id:'Q3-unknown', family:'Q3', exchange:[[false,'周末终于能喘口气了']], ageMs:60000, request:personalRequest },
    { id:'Q3-material', family:'Q3', exchange:[[false,'周末终于能喘口气了']], ageMs:60000,
      request:personalRequest+'我今天第一次烤司康，外形歪了但味道不错。这件事我愿意分享，给我一句完整的话。',
      quoteFragments:['我今天第一次烤司康，外形歪了但味道不错'] },
    { id:'Q4-daily-life', family:'Q4', exchange:[[false,'周六我一般去河边走走']], ageMs:60000,
      request:'想更了解她平时的生活，但别像面试。给我一个自然的方向，再给一句。' },
    { id:'Q5-invitation', family:'Q5', exchange:[[false,'周末想画点东西']], ageMs:60000,
      request:'我周日下午有空，想邀请她语音一起画画，明确一点，直接给我完整的一句。',
      quoteFragments:['我周日下午有空','想邀请她语音一起画画'] },
    { id:'Q6-interest', family:'Q6', exchange:[[true,'今天这件小事挺有意思'],[false,'哈哈是挺有意思的']], ageMs:60000,
      request:'我发现挺期待和她聊天的，想多认识她一点，也想让她知道这个意思，但先不表白。帮我表达出来。',
      quoteFragments:['我发现挺期待和她聊天的','想多认识她一点'] },
    { id:'Q7-boundary', family:'Q7', exchange:[[false,'我只想做网友，不想发展恋爱关系']], ageMs:60000,
      request:'听她这么说有点失落，我还是想和她更亲近，现在该怎么办？' },
    { id:'Q8-new-intent', family:'Q8', exchange:[[false,'周末想画点东西']], ageMs:60000,
      prior:'刚才那一轮先不邀请她，只轻松回应她画画的分享。',
      request:'现在我改变主意了。我周日下午有空，想邀请她语音一起画画，直接给我完整的一句。',
      quoteFragments:['我周日下午有空','想邀请她语音一起画画'] }
  ].map(item => ({...item, asOf:item.family==='Q2'?'2026-10-15T14:30:00.000Z':AS_OF}));
}
function selectedDefinitions(ids) {
  const cases = definitions(), lookup = new Map(cases.map(item => [item.id,item]));
  if (ids === undefined) return cases;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw Error('Cases must be a nonempty list of distinct IDs');
  if (ids.some(id => !lookup.has(id))) throw Error('Every case must be a declared scenario ID');
  return ids.map(id => lookup.get(id));
}
function independentDefinitions(items) {
  const builtinIds=new Set(definitions().map(item=>item.id));
  if (!Array.isArray(items) || !items.length || new Set(items.map(item=>item?.id)).size!==items.length) throw Error('Independent cases require distinct definitions');
  for (const item of items) {
    if (!item || typeof item.id!=='string' || !item.id || builtinIds.has(item.id) || typeof item.family!=='string' || !item.family ||
        !Array.isArray(item.exchange) || !item.exchange.length || item.exchange.some(pair=>!Array.isArray(pair) || typeof pair[0]!=='boolean' || typeof pair[1]!=='string' || !pair[1]) ||
        (item.invocation!==undefined&&!['manual','automatic'].includes(item.invocation)) ||
        (item.invocation?item.request!==null:typeof item.request!=='string'||!item.request) ||
        !Number.isSafeInteger(item.ageMs) || item.ageMs<0 || !Number.isFinite(Date.parse(item.asOf)) ||
        typeof item.criteria?.expectedGood!=='string' || !item.criteria.expectedGood || typeof item.criteria?.expectedBad!=='string' || !item.criteria.expectedBad)
      throw Error('Independent cases require new IDs, complete fictional evidence, fixed time and positive/negative criteria');
  }
  return clone(items);
}
function continuousDefinitions(items) {
  if (!Array.isArray(items) || !items.length || items.length>8 || new Set(items.map(item=>item?.id)).size!==items.length)
    throw Error('Continuous cases require one to eight distinct fictional definitions');
  for (const item of items) {
    if (!item?.id || typeof item.family!=='string' || !Array.isArray(item.exchange) || !item.exchange.length ||
        !Number.isSafeInteger(item.ageMs) || item.ageMs<0 || !Number.isFinite(Date.parse(item.asOf)) ||
        !Array.isArray(item.steps) || !item.steps.length || new Set(item.steps.map(step=>step?.id)).size!==item.steps.length ||
        item.steps.some(step=>!step?.id || !['automatic','private','observe'].includes(step.action) ||
          step.action==='private' && (typeof step.request!=='string'||!step.request) ||
          typeof step.criteria?.expectedGood!=='string' || typeof step.criteria?.expectedBad!=='string'))
      throw Error('Continuous cases require fixed time, actual exchanges, distinct steps and report-only gold');
    for (const pair of [...item.exchange,...item.steps.flatMap(step=>step.exchange||[])])
      if (!Array.isArray(pair)||typeof pair[0]!=='boolean'||typeof pair[1]!=='string'||!pair[1]) throw Error('Continuous QQ exchanges require fictional speaker/text pairs');
    if (item.distractors!==undefined && (!Number.isSafeInteger(item.distractors)||item.distractors<0||item.distractors>80)) throw Error('Continuous distractors must be 0..80');
  }
  return clone(items);
}
function declarations() {
  const filename = path.join(RUNNER_ROOT,'docs/goal-help-quality-scenarios.md'), text = fs.readFileSync(filename,'utf8');
  const criteria = {};
  for (const line of text.split('\n')) if (/^\| Q[0-8]-/.test(line)) {
    const parts = line.split('|').map(item => item.trim());
    criteria[parts[1]] = { situation:parts[2], expectedGood:parts[3], expectedBad:parts[4] };
  }
  if (Object.keys(criteria).length !== 13 || definitions().some(item => !criteria[item.id])) throw Error('Thirteen predeclared case criteria are required');
  return { filename,version:'goal-help-quality-2026-10-16.2',sha256:digest(text),criteria };
}

// Each source-root module receives one lexical Date. The host clock and module cache stay untouched.
function loadRuntime(sourceRoot, asOf) {
  const root = fs.realpathSync(sourceRoot), srcRoot = path.join(root,'src') + path.sep, fixedMs = Date.parse(asOf);
  if (!Number.isFinite(fixedMs)) throw Error('A valid fixed asOf is required');
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [fixedMs])); } static now() { return fixedMs; } }
  const cache = new Map();
  function load(filename) {
    filename = fs.realpathSync(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const local = createRequire(filename), mod = { exports:{},filename,id:filename };
    cache.set(filename,mod);
    function requireSource(request) {
      const resolved = local.resolve(request);
      return resolved.startsWith(srcRoot) && resolved.endsWith('.cjs') ? load(resolved) : local(request);
    }
    requireSource.resolve = local.resolve;
    vm.compileFunction(fs.readFileSync(filename,'utf8'),['exports','require','module','__filename','__dirname','Date'],{filename})(
      mod.exports,requireSource,mod,filename,path.dirname(filename),ClockDate);
    return mod.exports;
  }
  return { root, now:()=>fixedMs,
    Store:load(path.join(srcRoot,'store.cjs')).Store,
    Controller:load(path.join(srcRoot,'controller.cjs')).Controller,
    assistModel:load(path.join(srcRoot,'assistant-model.cjs')).assistModel,
    normalize:load(path.join(srcRoot,'messages.cjs')).normalize,
    visibleResponseText:load(path.join(srcRoot,'experience-store.cjs')).visibleResponseText };
}
function sourceHashes(root) {
  const names = fs.readdirSync(path.join(root,'src'),{recursive:true}).filter(name => name.endsWith('.cjs')&&fs.statSync(path.join(root,'src',name)).isFile()).sort();
  const ui=fs.existsSync(path.join(root,'ui'))?fs.readdirSync(path.join(root,'ui')).filter(name=>/\.(?:js|html|css)$/.test(name)).sort():[];
  return Object.fromEntries([...names.map(name=>`src/${name}`),...ui.map(name=>`ui/${name}`)].map(name=>[name,digest(fs.readFileSync(path.join(root,name)))]));
}
function selectedConnection() {
  // Explicit live mode is the only route to the existing read-only configuration helper.
  return require('./goal-acceptance-check.cjs').selectedConnection();
}
function packetPayload(request) {
  const content = request.messages?.[1]?.content;
  if (typeof content !== 'string') throw Error('Quality fixtures must remain text-only');
  return JSON.parse(content);
}
function stopError(message, code='verification_stopped') {
  const error = new Error(message); error.name='AbortError'; error.code=code; return error;
}
function syntheticResult(payload, definition) {
  const step=definition.activeStep;
  if(step?.syntheticClarification)return payload.operationProtocol?{operation:'clarify',blocker:{kind:'missing_fact',missing:'这轮表达不可绕过的真实信息',question:step.syntheticClarification}}:{kind:'question',text:step.syntheticClarification,replyDisposition:'clarify'};
  if(step && payload.purpose==='draft')return {kind:'draft',text:'Synthetic transport wording; independent semantic review remains required.',
    suggestions:[{style:'自然',text:step.syntheticWording}]};
  if(step){
    const sourceId=payload.intentAuthority?.sourceId||payload.userRequest?.sourceId,control=text=>({text,sourceIds:[sourceId]});
    return {kind:'discussion',text:'Synthetic planning, not evidence of actual conversational usefulness.',draftPlan:{quotes:[],intent:'reply',
      guidance:{objective:control('回应这轮真实交流中的具体内容'),allowedApproach:control('保留当前有效的表达分寸，不虚构自己的经历'),avoidances:[]}}};
  }
  if (definition.invocation) return {kind:'discussion',text:'合成触发路径示例，不提供实际语义质量结论。',replyDisposition:'wait'};
  if (payload.purpose === 'draft') return {kind:'draft',text:'Synthetic transport summary; no quality verdict.',suggestions:[{style:'自然',text:'合成运输示例，仅验证完整交接，不作为建议质量证据。'}]};
  if (definition.id === 'Q3-unknown') return payload.operationProtocol?{operation:'clarify',blocker:{kind:'missing_fact',missing:'尚未提供愿意分享的实际近况',question:'合成运输示例：缺少实际近况，请提供一个你愿意分享的真实事件。'}}:{kind:'question',text:'合成运输示例：缺少实际近况，请提供一个你愿意分享的真实事件。'};
  if (definition.id === 'Q7-boundary') return {kind:'discussion',text:'合成运输示例：这段文本不是实际模型建议，不提供语义质量结论。'};
  const currentId = payload.intentAuthority?.sourceId || payload.userRequest?.sourceId;
  const control = text => ({text,sourceIds:[currentId]});
  let quotes = (definition.quoteFragments || []).map(text => ({sourceId:currentId,text}));
  if(definition.id==='Q3-material'&&payload.primaryReferenceProtocol){
    // This positive fixture selects the actual offered single-fact sentence.
    // Its old punctuation-free substring lies beyond the bounded anchors;
    // neither the source nor the general adapter is normalized or widened.
    const source=payload.sources.find(item=>item.id===currentId),atoms=[];let offset=0,body='';
    for(const segment of source.segments){const start=offset,text=segment.text??segment.parts.map(part=>part[1]).join('');body+=text;offset+=text.length;atoms.push({ref:segment.materialRef,start,end:offset});}
    const parents=[...atoms,...source.materialChoices.map(choice=>({ref:choice.materialRef,start:atoms.find(atom=>atom.ref===choice.from)?.start,end:atoms.find(atom=>atom.ref===choice.to)?.end}))];
    const fact=definition.quoteFragments[0],sentence=parents.find(parent=>{const text=body.slice(parent.start,parent.end);return text.startsWith(fact)&&text.slice(fact.length)==='。';});
    const whole=parents.find(parent=>parent.start===0&&parent.end===body.length),authority=source.authorityChoices.originalUserStatementCandidates.find(choice=>choice.materialRef===whole?.ref);
    if(!sentence||!authority)throw new Error('Synthetic single-fact sentence and current statement candidate must actually be offered');
    quotes=[{materialRef:sentence.ref,authorityRef:authority.authorityRef}];
  }
  return withCurrentStatementAuthority({kind:'discussion',text:'合成运输解释，只验证私下解释与成稿交接，不证明实际帮助质量。',
    draftPlan:{quotes,...(quotes.length ? {} : {intent:'reply'}),guidance:{
      objective:control('按用户本次意思提供表达帮助'),allowedApproach:control('保留本次明确方向'),avoidances:[]}}},payload);
}
function nativeMessage(scope,index,own,text,stamp,options={}) {
  return {chatType:1,peerUid:scope.peerUid,peerUin:scope.peerUin,senderUid:own?scope.accountUid:scope.peerUid,
    senderUin:own?scope.accountUin:scope.peerUin,msgId:String(72057594049927937000n+BigInt(index)),msgSeq:String(index),
    msgTime:String(Math.floor(stamp/1000)),sendStatus:2,recallTime:'0',elements:[{elementType:1,textElement:{content:text}},
      ...(options.image?[{elementType:2,picElement:{fileName:'fictional-unavailable-image.png'}}]:[])]};
}
function message(runtime,scope,index,own,text,stamp,options) {
  return runtime.normalize(nativeMessage(scope,index,own,text,stamp,options),scope);
}
function prepareOutput(output, roots) {
  if (!output) return null;
  const filename = path.resolve(output);
  if (!filename.endsWith('.json') || filename.includes(`${path.sep}.git${path.sep}`) || roots.some(root => {
    const privateRoot = path.join(root,'data'); return filename === privateRoot || filename.startsWith(privateRoot+path.sep);
  }) || fs.existsSync(filename)) throw Error('Report must be a new JSON file outside private data and Git internals');
  fs.mkdirSync(path.dirname(filename),{recursive:true}); fs.writeFileSync(filename,'',{flag:'wx',mode:0o600}); return filename;
}

async function runHarness(options={}) {
  if (options.live !== undefined && typeof options.live !== 'boolean') throw Error('Live mode requires an explicit boolean');
  const hardCeiling=options.continuousCases?24:32,maxHttp = options.maxHttp ?? hardCeiling;
  if (!Number.isSafeInteger(maxHttp) || maxHttp < 1 || maxHttp > hardCeiling) throw Error(`Global HTTP cap must be 1..${hardCeiling}`);
  if ([options.independentCases,options.continuousCases,options.cases].filter(Boolean).length>1) throw Error('Independent, continuous and built-in selection cannot be mixed');
  const cases = options.continuousCases ? continuousDefinitions(options.continuousCases) : options.independentCases ? independentDefinitions(options.independentCases) : selectedDefinitions(options.cases), declared = declarations();
  const sourceRoot = fs.realpathSync(options.sourceRoot || RUNNER_ROOT), hashesBefore = sourceHashes(sourceRoot);
  const selected = options.live ? selectedConnection() : {provider:{model:'synthetic-help-quality',baseUrl:'http://fictional.invalid/v1',anonymous:true}};
  const provider = selected.provider, destination = new URL(provider.baseUrl), out = prepareOutput(options.out,[MAIN_ROOT,RUNNER_ROOT,sourceRoot]);
  const report = {schemaVersion:1,evidence:options.live?'live_model_with_fictional_context':'synthetic_transport_pipeline_only',
    semanticVerdict:'requires_independent_review',sourceRoot,declarations:declared,sourceHashesAtStart:hashesBefore,
    runnerSha256:digest(fs.readFileSync(__filename)),selectedModel:provider.model,
    selectedDestination:{origin:destination.origin,path:destination.pathname},settingsReadOnly:!!options.live,
    settingsHashAtStart:selected.settingsHash || null,
    limits:{globalHttp:maxHttp,hardCeiling,perTask:4,memoryModel:false,compactionModel:false,images:false,
      failurePolicy:'stop on first transport or non-OK HTTP failure; no external retry'},
    startedAt:new Date().toISOString(),requests:[],cases:[]};
  if (options.independentCases) report.independentDeclaration={kind:'independent_held_out',sha256:digest(JSON.stringify(cases)),caseCount:cases.length};
  if (options.continuousCases) report.independentDeclaration={kind:'independent_continuous_fictional',sha256:digest(JSON.stringify(cases)),caseCount:cases.length,definitions:clone(cases),
    scenarioDocumentSha256:digest(fs.readFileSync(path.join(RUNNER_ROOT,'docs/lazy-candidate-quality-scenarios.md')))};
  let attempts=0, stopped=null, current;
  const save = () => { if (out) fs.writeFileSync(out,JSON.stringify(report,(_key,value)=> typeof value === 'string' && provider.apiKey ? value.split(provider.apiKey).join('[redacted]') : value,2),{mode:0o600}); };
  const transport = async (url,args) => {
    if (stopped) throw stopError('Quality verification already stopped');
    if (selected.settingsFile && digest(fs.readFileSync(selected.settingsFile)) !== selected.settingsHash) {
      stopped={reason:'selected_connection_changed',caseId:current.id}; throw stopError('Selected MAIN configuration changed');
    }
    if (attempts >= maxHttp) { stopped={reason:'global_http_cap',caseId:current.id}; throw stopError('Global HTTP ceiling reached'); }
    if ((current.stepHttpAttempts??current.httpAttempts) >= 4) { stopped={reason:'per_task_http_cap',caseId:current.id}; throw stopError('Per-task HTTP ceiling reached'); }
    if (new URL(url).origin !== destination.origin) { stopped={reason:'destination_changed',caseId:current.id}; throw stopError('Destination changed'); }
    const request=JSON.parse(args.body), wrapper=packetPayload(request), payload=wrapper.originalInput || wrapper;
    const entry={sequence:++attempts,caseId:current.id,...(current.stepId?{stepId:current.stepId}:{}),purpose:payload.purpose,request,requestBytes:Buffer.byteLength(args.body)};
    current.httpAttempts++; report.requests.push(entry); save();
    if(current.stepHttpAttempts!==undefined)current.stepHttpAttempts++;
    options.onProgress?.({event:'model_request',caseId:current.id,...(current.stepId?{stepId:current.stepId}:{}),sequence:entry.sequence,purpose:payload.purpose});
    let response;
    try {
      if (options.live) response=await (options.fetchImpl || fetch)(url,args);
      else {
        const produced=await (options.syntheticResponder || syntheticResult)(payload,current.definition);
        const result=withRequestDelivery(options.syntheticResponder?produced:withPrimaryOperation(produced,payload),payload);
        response=result instanceof Response ? result : new Response(JSON.stringify({model:provider.model,
          choices:[{finish_reason:'stop',message:{content:typeof result === 'string' ? result : JSON.stringify(result)}}],
          usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200});
      }
    } catch (error) {
      entry.failure={name:error.name,code:error.code || null}; stopped={reason:'transport_failure',caseId:current.id}; save();
      throw stopError('Transport failed; quality verification stopped');
    }
    entry.httpStatus=response.status;
    if (!response.ok) {
      stopped={reason:'non_ok_http',status:response.status,caseId:current.id}; await response.body?.cancel?.(); save();
      throw stopError(`Model returned HTTP ${response.status}; quality verification stopped`);
    }
    try { entry.response=await response.clone().json(); } catch { entry.responseShape='not_json'; }
    save(); return response;
  };
  for (let index=0; index<cases.length; index++) {
    const definition=cases[index], item=current={id:definition.id,family:definition.family,definition,request:definition.request,
      criteria:definition.criteria || declared.criteria[definition.id],semanticVerdict:'requires_independent_review',httpAttempts:0,status:'running',stages:[],checks:[]};
    report.cases.push(item);
    if (stopped) { item.status='skipped_verification_stopped'; delete item.definition; save(); continue; }
    const runtime=loadRuntime(sourceRoot,definition.asOf), scope={accountUid:'fictional_owner',accountUin:'1111111111',
      peerUid:'fictional_contact',peerUin:'3333333333'}, store=new runtime.Store(':memory:'); let controller;
    const check=(name,valid) => item.checks.push({name,status:valid?'pass':'fail'});
    try {
      const latestAt=runtime.now()-definition.ageMs;
      let nextMessageIndex=1;
      const historical=definition.distractors?loadRuntime(sourceRoot,new Date(runtime.now()-60*86400000).toISOString()):null;
      if(definition.distractors)for(let i=0;i<definition.distractors;i++){
        const text=`FICTIONAL_DISTRACTOR_${i}: 旧路由器维护记录，固件备份校验端口${41000+i}。`;
        store.add(scope,[message(runtime,scope,nextMessageIndex++,i%2===0,text,runtime.now()-60*86400000+i*30000)]);
        if(i<6)historical.Store.prototype.appendTurn.call(store,scope,{role:'user',kind:'discussion',text:`FICTIONAL_PRIVATE_DISTRACTOR_${i}: 仅讨论旧路由器维护，不用于发送。`});
      }
      store.add(scope,definition.exchange.map(([own,text,options],i)=>message(runtime,scope,nextMessageIndex++,own,text,latestAt-(definition.exchange.length-1-i)*30000,options)));
      store.setCoverage(scope,{status:'partial',checkedAt:definition.asOf,source:'fictional-native-shaped-seed'});
      store.setGoal(scope,GOAL);
      if (!definition.invocation) store.saveNote(scope,{text:`${PRIVATE_MARKER}：私下讨论担心太刻意，不是发给她的材料。`,use:'discussion'});
      if (definition.prior) {
        const prior=store.appendTurn(scope,{role:'user',kind:'discussion',text:definition.prior});
        store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'这一轮先照你说的方向回应。',sourceIds:[`private:${prior.id}`]});
      }
      const recordsBefore=clone(store.messages(scope)), goalBefore=clone(store.getCompanion(scope).goal);
      let expectedRecords=recordsBefore;
      item.fixture={scope,records:recordsBefore,goal:goalBefore,asOf:definition.asOf,viewerTimeZone:'Asia/Shanghai',priorPrivateDirection:definition.prior || null};
      const settings={...provider,auto:false,autoImages:false,visionEnabled:false,assistantRequestLimit:4,
        realChatConsent:{...scope,model:provider.model,baseUrl:provider.baseUrl}};
      controller=new runtime.Controller({store,settings,now:runtime.now,viewerTimeZone:'Asia/Shanghai',memoryModel:null,compactionModel:null,
        read:async()=>{throw Error('Real QQ access is unavailable in fictional quality checks');},
        assistantModel:async(configured,input,signal)=>{
          const stage={purpose:input.payload.purpose,...(item.stepId?{stepId:item.stepId}:{}),initialPayload:clone(input.payload),initialManifest:clone(input.manifest)}; item.stages.push(stage);
          try { const result=await runtime.assistModel(configured,input,signal,transport); stage.result=clone(result); return result; }
          finally { const effective=input.resultContext || input; stage.effectivePayload=clone(effective.payload); stage.effectiveManifest=clone(effective.manifest); stage.extraRequests=clone(input.extraRequests || []); save(); }
        }});
      controller.visible=false; controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}}); controller.scope={...scope};
      let reply;
      if(definition.steps){
        item.steps=[];
        for(let stepIndex=0;stepIndex<definition.steps.length;stepIndex++){
          const step=definition.steps[stepIndex], stageStart=item.stages.length;
          if(stopped){item.steps.push({id:step.id,status:'skipped_verification_stopped',criteria:step.criteria});continue;}
          item.stepId=step.id;item.stepHttpAttempts=0;definition.activeStep=step;
          const observed={id:step.id,action:step.action,criteria:clone(step.criteria),delivery:step.delivery,semanticVerdict:'requires_independent_review',checks:[]};item.steps.push(observed);
          const stepCheck=(name,valid)=>{observed.checks.push({name,status:valid?'pass':'fail'});check(`${step.id}: ${name}`,valid);};
          if(step.exchange?.length){
            controller.live({scope,messages:step.exchange.map(([own,text,options],i)=>nativeMessage(scope,nextMessageIndex++,own,text,latestAt+(stepIndex+1)*15000+i*1000,options))});
            expectedRecords=clone(store.messages(scope));
          }
          observed.actualRecords=clone(expectedRecords);observed.revision=controller.revision;
          observed.adviceBefore=clone(controller.snapshot().advice);
          if(step.action==='observe'){
            stepCheck('actual send expires the current candidate',controller.snapshot().advice===null);
          }else{
            if(step.action==='automatic'){
              await controller.suggest({automatic:true});
              reply=store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').at(-1);
            }else reply=await controller.assist({text:step.request,purpose:'discussion'});
            observed.reply=reply?clone(reply):null;observed.visibleHelp=reply?runtime.visibleResponseText(reply):null;
            observed.adviceAfter=clone(controller.snapshot().advice);observed.httpAttempts=item.stepHttpAttempts;
            stepCheck('a completed visible reply exists',!!reply&&!!observed.visibleHelp);
            stepCheck('candidate or explicit no-candidate disposition',!!reply?.suggestions?.length||['wait','clarify','unavailable'].includes(reply?.replyDisposition));
            if(step.delivery==='candidate')stepCheck('normal incoming or requested wording has editable candidate',!!reply?.suggestions?.length);
            if(step.action==='automatic'&&reply?.suggestions?.length){
              const advice=controller.snapshot().advice;
              stepCheck('current candidate binds this scope and QQ revision',JSON.stringify(advice?.binding?.scope)===JSON.stringify(scope)&&advice.binding.revision===controller.revision);
              stepCheck('candidate binding includes latest incoming',advice?.binding?.messageIds?.includes(store.messages(scope).at(-1)?.messageId));
            }
            const newStages=item.stages.slice(stageStart);
            for(const stage of newStages){
              const payload=stage.effectivePayload,qq=(payload.sources||[]).filter(source=>source.type==='qq');
              if(definition.distractors)stepCheck(`${stage.purpose} unrelated old raw history stays outside current request`,!JSON.stringify(payload).includes('FICTIONAL_DISTRACTOR_')&&!JSON.stringify(payload).includes('FICTIONAL_PRIVATE_DISTRACTOR_'));
              stepCheck(`${stage.purpose} QQ sources are chronological`,qq.every((source,i)=>!i||Date.parse(qq[i-1].at)<=Date.parse(source.at)));
              const task=payload.taskContext,latest=task?.latestActual?.sourceId;
              stepCheck(`${stage.purpose} latest focus has zero later messages`,!(task?.consultationTask?.focus||[]).some(focus=>focus.sourceId===latest&&focus.laterAvailableMessageCount!==0));
            }
          }
          stepCheck('model output does not alter actual QQ messages',JSON.stringify(store.messages(scope))===JSON.stringify(expectedRecords));
          observed.status=observed.checks.some(value=>value.status==='fail')?'deterministic_failure':'executed_semantic_review_required';
        }
        delete definition.activeStep;delete item.stepId;delete item.stepHttpAttempts;
      } else if (definition.invocation) {
        await controller.suggest({automatic:definition.invocation==='automatic'});
        reply=store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').at(-1);
      } else reply=await controller.assist({text:definition.request,purpose:'discussion'});
      item.reply=reply?clone(reply):null;
      item.visibleHelp=reply?runtime.visibleResponseText(reply):null;
      const after=store.getCompanion(scope); item.tasks=controller.usage.recent(scope,4);
      check('actual messages and original string IDs preserved',JSON.stringify(expectedRecords)===JSON.stringify(store.messages(scope)) && expectedRecords.every(record=>typeof record.messageId==='string'));
      check('user-owned goal preserved',JSON.stringify(goalBefore)===JSON.stringify(after.goal));
      if (definition.invocation) {
        item.invocation=clone(item.stages[0]?.initialPayload.taskContext?.invocation || null);
        check('no private user turn fabricated by suggestion',!after.turns.some(turn=>turn.role==='user'));
        check('actual manual or automatic trigger delivered',item.invocation?.trigger===(definition.invocation==='automatic'?'automatic_observation':'manual_suggestion'));
      } else if(!definition.steps)check('original request preserved',item.stages[0]?.initialPayload.userRequest?.text===definition.request);
      check('fixed observation time delivered',item.stages[0]?.initialPayload.asOf===definition.asOf);
      check('scope preserved',item.stages.every(stage=>JSON.stringify(stage.effectiveManifest.scope)===JSON.stringify(scope)));
      check('bounded HTTP calls',attempts<=maxHttp && (definition.steps?item.steps.every(step=>(step.httpAttempts||0)<=4):item.httpAttempts<=4));
      check('draft excludes private rationale and note',item.stages.filter(stage=>stage.purpose==='draft').every(stage=>{
        const value=JSON.stringify(stage.effectivePayload); return !value.includes(PRIVATE_MARKER) && !stage.effectivePayload.privateConversation && !stage.effectivePayload.goal;
      }));
      if (reply) {
        check('whole-help artifact matches displayed help',store.experiences.artifact(scope,reply.artifactRef)?.body===item.visibleHelp);
        check('draft artifacts contain editable wording only',(reply.suggestions || []).every(suggestion=>store.experiences.artifact(scope,suggestion.artifactRef)?.body===suggestion.text));
      }
      item.status=!reply?'no_completed_reply':item.checks.some(value=>value.status==='fail')?'deterministic_failure':'executed_semantic_review_required';
    } catch(error) { item.status='execution_failure'; item.error={name:error.name,code:error.code || null,message:error.message}; }
    finally { controller?.close(); store.close(); delete item.definition; save(); options.onProgress?.({event:'case_finished',caseId:item.id,status:item.status,httpAttempts:item.httpAttempts}); }
  }
  report.finishedAt=new Date().toISOString(); report.httpAttempts=attempts; report.realHttpAttempts=options.live?attempts:0; report.stopped=stopped;
  report.sourceHashesAtEnd=sourceHashes(sourceRoot); report.sourceUnchanged=JSON.stringify(report.sourceHashesAtStart)===JSON.stringify(report.sourceHashesAtEnd);
  report.mainSettingsUnchanged=selected.settingsFile?digest(fs.readFileSync(selected.settingsFile))===selected.settingsHash:null;
  report.reportedResponseModels=[...new Set(report.requests.map(item=>item.response?.model).filter(Boolean))]; report.physicalProviderIdentityVerified=false;
  save(); return report;
}
function argument(argv,name) { const index=argv.indexOf(name); return index<0?undefined:argv[index+1]; }
async function main(argv) {
  const cases=argument(argv,'--cases')?.split(',').map(value=>value.trim()), sourceRoot=argument(argv,'--source-root') || RUNNER_ROOT;
  const continuousCases=argv.includes('--continuous')?require('./continuous-conversation-cases.cjs').definitions():undefined;
  if(continuousCases&&cases)throw Error('Continuous and built-in selection cannot be mixed');
  if (argv.includes('--describe')) { console.log(JSON.stringify({sourceRoot,declarations:declarations(),scenarios:continuousCases||selectedDefinitions(cases),limits:{globalHttp:continuousCases?24:32,perTask:4}},null,2)); return; }
  const out=argument(argv,'--out') || `/tmp/qq-help-quality-${Date.now()}-${process.pid}.json`;
  const report=await runHarness({cases,continuousCases,sourceRoot,out,live:argv.includes('--live'),maxHttp:argument(argv,'--max-http')?Number(argument(argv,'--max-http')):continuousCases?24:undefined,
    onProgress:event=>console.log(JSON.stringify(event))});
  console.log(JSON.stringify({report:path.resolve(out),evidence:report.evidence,semanticVerdict:report.semanticVerdict,httpAttempts:report.httpAttempts,realHttpAttempts:report.realHttpAttempts,
    sourceUnchanged:report.sourceUnchanged,mainSettingsUnchanged:report.mainSettingsUnchanged,stopped:report.stopped,cases:report.cases.map(item=>({id:item.id,status:item.status}))}));
  if (!report.sourceUnchanged || report.mainSettingsUnchanged===false || report.cases.some(item=>item.status!=='executed_semantic_review_required')) process.exitCode=1;
}
module.exports={definitions,selectedDefinitions,declarations,loadRuntime,runHarness,continuousDefinitions};
if (require.main===module) main(process.argv.slice(2)).catch(error=>{console.error(`${error.name}: ${error.message}`);process.exitCode=1;});
