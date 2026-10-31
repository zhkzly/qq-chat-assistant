'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Scripted checker verdicts exercise lifecycle/receipt plumbing only. They are
// not conversational-quality judgments or evidence that an LLM reasons safely.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {visibleCandidate}=require('../src/whole-answer-fidelity.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const HUMAN='这次先不要邀请，只聊她刚说的小葱近况。';
const ADVICE='先回应她刚分享的两片新叶。例如：“这两片新叶看着挺精神。”这次不提邀请。';
const SELF_MATERIAL='我以前确实装过一个两层小书架，装好后重新对齐过背板。这个经过我愿意告诉她。';
const ORIGINAL_QUALIFIER='我只看过朋友组装书架，没有自己组装过。';
const OPINION='我觉得木色挺好看，以后想自己尝试。';
const body=source=>source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function materialFor(source,text){
 for(const segment of source.segments)if(body({segments:[segment]})===text)return segment.materialRef;
 for(const choice of source.materialChoices){const first=source.segments.findIndex(segment=>segment.materialRef===choice.from),last=source.segments.findIndex(segment=>segment.materialRef===choice.to);if(body({segments:source.segments.slice(first,last+1)})===text)return choice.materialRef;}
 assert.fail('A genuine offered material span must contain the selected original text');
}
function prepared(p,{message='我以前也装过一个两层小书架，背板对齐时还调整了一阵。',why='依据这段已准许的真实自述组织表达。',current=false,fragment}={}){
 const source=current?null:p.sources.find(source=>source.type==='note');
 return {operation:'prepare_message',...(current?{currentFacts:[fragment]}:{materials:[{materialRef:fragment?materialFor(source,fragment):whole(source),authorityRef:source.authorityChoices.program[0].authorityRef}]}),answer:{privateExplanation:why,suggestions:[{style:'自然',text:message}]}};
}
function jsonResponse(value,name){return new Response(JSON.stringify({choices:[{message:name?{tool_calls:[{id:'fidelity-fixture',type:'function',function:{name,arguments:JSON.stringify(value)}}]}:{content:JSON.stringify(value)}}]}),{status:200});}
async function application(t,producer,{limit=4,noteText}={}){
 t.mock.method(globalThis,'fetch',async()=>{throw Error('No unmocked network calls are permitted in this fictional test');});
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-whole-answer-fidelity',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:limit,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async(command,args)=>command==='bind'?(String(args?.uin)===scope.peerUin?scope:{...scope,peerUid:'another-contact',peerUin:String(args?.uin)}):{messages:[]},
  assistantModel:(settings,context,signal)=>{contexts.push(context);return assistModel(settings,context,signal,async(url,args)=>{const request=JSON.parse(args.body),content=request.messages[1].content,wrapper=JSON.parse(typeof content==='string'?content:content.find(item=>item.type==='text').text),p=wrapper.originalInput||wrapper;const entry={request,wrapper,p,url,taskId:settings.requestBudget.task.id};calls.push(entry);return jsonResponse(await producer(p,wrapper,calls.length-1,entry),request.tool_choice?.function.name);});}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000000381',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'今天我种的小葱多长了两片新叶。'}}]})]});
 const note=noteText?store.saveNote(scope,{text:noteText,use:'draft'}):null;
 return {store,controller,calls,contexts,note,run:()=>store.getCompanion(scope).runs.at(-1),assist:(text=HUMAN,taskId='whole-answer-fidelity')=>controller.assist({text,taskId,...(note?{materialIds:[note.id]}:{})})};
}

test('a terminal advise answer must pass the same exact-candidate checker instead of bypassing it',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}:{operation:'advise',text:ADVICE}),reply=await app.assist();
 assert.equal(app.calls.length,2,'ordinary advice also requires the read-only check before publication');assert.equal(app.calls[1].p.purpose,'fidelity_check');assert.equal(app.calls[1].p.candidate.text,ADVICE);
 assert.ok(app.calls[1].p.evidence.some(source=>source.text===HUMAN),'the checker sees the original human no-invite control');assert.equal(reply.text,ADVICE);assert.equal(reply.suggestions,undefined);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false,'the old rewrite/composer is not a substitute checker');
 assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1);assert.equal(app.calls.every(call=>call.request.model==='synthetic-whole-answer-fidelity'),true);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('the primary whole why/message candidate is admitted then checked without a separate composer rewrite',async t=>{
 const message='我以前也装过一个两层小书架，背板对齐时还调整了一阵。',why='依据这段已准许的真实自述组织表达。',app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,factual:factualReview(p,{'suggestions[0].text':[{quote:message,kind:'assertion',support:'supported',evidence:[{sourceId:p.evidence.find(source=>source.text===SELF_MATERIAL).sourceId,quote:SELF_MATERIAL}]}]}),verdict:'allow',issues:[]}:prepared(p,{message,why}),{noteText:SELF_MATERIAL}),reply=await app.assist('按已选真实经历给我完整帮助；PRIVATE_CONTROL_ONLY不要当作额外事实。');
 assert.equal(app.calls.length,2);assert.equal(app.calls[1].p.purpose,'fidelity_check');assert.deepEqual(visibleCandidate(reply),app.calls[1].p.candidate);assert.equal(reply.discussionExplanation.text,why);assert.equal(reply.suggestions[0].text,message);
 assert.ok(app.calls[1].p.evidence.some(source=>source.text===SELF_MATERIAL));assert.equal(app.calls[1].p.admittedFragments[0].text,SELF_MATERIAL);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);assert.equal(JSON.stringify(reply).includes('PRIMARY_PLANNING_NOT_THE_WHOLE_ANSWER'),false);
 assert.equal(app.store.experiences.draft(scope),null);assert.equal(app.store.messages(scope).some(record=>record.direction==='outgoing'),false);
});

test('a why/body discrepancy retains actual original qualifiers in its private review without regenerating',async t=>{
 let checks=0;const bad='我以前独自装过一个四层书架。',badWhy='原文没有本人组装经历，不能把旁观当成亲历。',app=await application(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check'){checks++;assert.ok(p.evidence.some(source=>source.text===ORIGINAL_QUALIFIER));if(checks===1){assert.equal(p.candidate.suggestions[0].text,bad);assert.equal(p.candidate.discussionExplanation.text,badWhy);return {checkRef:p.checkRef,factual:factualReview(p,{'suggestions[0].text':[{quote:bad,kind:'assertion',support:'unsupported',basis:'source_contradiction',evidence:[{sourceId:p.evidence.find(source=>source.text===ORIGINAL_QUALIFIER).sourceId,quote:ORIGINAL_QUALIFIER}]}],'discussionExplanation.text':[{quote:badWhy,kind:'advice'}]}),verdict:'reject',issues:[{path:'suggestions[0].text',code:'internal_conflict',quote:bad,relatedPath:'discussionExplanation.text',relatedQuote:badWhy,reason:'Scripted rejection tests the lifecycle, not model quality.'}]};}return {checkRef:p.checkRef,factual:factualReview(p,{'suggestions[0].text':[{quote:OPINION,kind:'opinion'}]}),verdict:'allow',issues:[]};}
  if(!wrapper.originalInput){const value=prepared(p,{message:bad,why:badWhy,fragment:'我只看过朋友组装书架，'});value.statePatch={items:[{text:'REJECTED_CANDIDATE_STATE_NOT_COMMITTED',sourceIds:[p.intentAuthority.sourceId]}]};return value;}
  return prepared(p,{message:OPINION,why:'保留真实看法与未来打算，不补亲历事件。',current:true,fragment:OPINION});
 },{noteText:ORIGINAL_QUALIFIER});
 const before=app.store.getCompanion(scope).state.version,human='这次先不要邀请。'+OPINION+'这两句可以告诉她。',reply=await app.assist(human);assert.equal(app.calls.length,2);assert.equal(checks,1);assert.equal(reply.suggestions[0].text,bad);assert.deepEqual(visibleCandidate(reply),app.calls[1].p.candidate);assert.ok(reply.semanticReview.findings.some(f=>f.quote===bad));
 assert.equal(app.calls[1].p.admittedFragments[0].text,'我只看过朋友组装书架，');assert.equal(app.calls[1].p.evidence.find(source=>source.text===human).text,human);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(request=>request.purpose==='delivery_repair').length,0);
 assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);assert.ok(app.store.getCompanion(scope).state.version>=before);
});

test('a checker criticism cannot obtain a second shared repair after primary format repair',async t=>{
 const bad='我以前独自装过一个四层书架。',app=await application(t,(p,_wrapper,index)=>{if(index===0)return {operation:'prepare_message',draftPlan:'malformed plan',answer:{suggestions:[{text:'Unusable candidate.'}]}};if(p.purpose==='fidelity_check'){const source=p.evidence.find(source=>source.text===SELF_MATERIAL);return {checkRef:p.checkRef,factual:factualReview(p,{'suggestions[0].text':[{quote:bad,kind:'assertion',support:'unsupported',basis:'source_contradiction',evidence:[{sourceId:source.sourceId,quote:source.text}]}]}),verdict:'reject',issues:[{path:'suggestions[0].text',code:'evidence_mismatch',quote:bad,evidence:[{sourceId:source.sourceId,quote:source.text}],reason:'Scripted terminal rejection preserves the explicit two-layer material.'}]};}const value=prepared(p,{message:bad});value.statePatch={items:[{text:'UNAPPROVED_STATE_EFFECT',sourceIds:[p.intentAuthority.sourceId]}]};return value;},{noteText:SELF_MATERIAL});
 const before=app.store.getCompanion(scope).state.version,reply=await app.assist('按所选原话准备表达。');assert.equal(reply.suggestions[0].text,bad);assert.ok(reply.semanticReview.findings.length);
 const ledger=app.controller.usage.get(scope,'whole-answer-fidelity');assert.equal(app.calls.length,3);assert.equal(ledger.attempts,3);assert.equal(ledger.requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.ok(app.store.getCompanion(scope).state.version>=before);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
});

test('invalid material references cannot be laundered by a checker allowance or reach publication',async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check','program admission must reject invalid references before checking');const value=prepared(p);value.materials[0].materialRef='m999999';return value;},{noteText:SELF_MATERIAL});
 await assert.rejects(app.assist());assert.equal(app.calls.length,2);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').status,'failed');
});

for(const mode of ['uncertain','transport-error','timeout'])test(`checker ${mode} labels incomplete private help without claiming a completed audit`,async t=>{
 const app=await application(t,p=>{if(p.purpose!=='fidelity_check')return {operation:'advise',text:ADVICE};if(mode==='uncertain')return {checkRef:p.checkRef,factual:factualReview(p,{text:[{quote:'她刚分享的两片新叶',kind:'assertion',support:'unverifiable'}]}),verdict:'uncertain',issues:[]};if(mode==='timeout')throw new DOMException('Scripted checker timeout','TimeoutError');throw Error('Scripted checker transport error');});
 const reply=await app.assist();assert.equal(reply.semanticReview.status,'incomplete');assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').status,'complete');assert.equal(app.calls.length,2);
});

test('an exhausted shared HTTP budget labels the unstarted audit without adding HTTP or certifying the primary',async t=>{
 const app=await application(t,()=>({operation:'advise',text:ADVICE}),{limit:1}),reply=await app.assist();assert.equal(reply.semanticReview.status,'incomplete');assert.equal(app.calls.length,1);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').attempts,1);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
});

for(const event of ['account','contact','QQ','withdrawal'])test(`a delayed checker allowance cannot publish after an actual ${event} boundary`,async t=>{
 let release,enter;const entered=new Promise(resolve=>{enter=resolve;}),app=await application(t,p=>p.purpose==='fidelity_check'?new Promise(resolve=>{release=()=>resolve({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]});enter();}):prepared(p),{noteText:SELF_MATERIAL});
 const pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await Promise.race([entered,pending.then(()=>{throw Error('The answer published before the controlled checker');})]);
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false,'no answer is visible while its checker is pending');
 if(event==='account')app.controller.updateStatus({phase:'ready',account:{uid:'different-authenticated-account',uin:'999000'}});
 if(event==='contact')await app.controller.bind('99887766');
 if(event==='QQ'){app.controller.live({scope,messages:[raw('91000000000000382',false,{elements:[{textElement:{content:'新的来信改变了当前交流位置。'}}]})]});clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;}
 if(event==='withdrawal')app.store.forgetSource(scope,'note:'+app.note.id);
 release();await pending.catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.store.messages(scope).some(record=>record.direction==='outgoing'),false);
});

test('source withdrawal while a concrete review is pending cannot publish the stale candidate or review copies',async t=>{
 let release,enter;const entered=new Promise(resolve=>{enter=resolve;}),app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return prepared(p);
  return new Promise(resolve=>{release=()=>resolve({checkRef:'c1',auditProtocol:'sparse-defects-v1',issues:[{path:'suggestions[0].text',quote:p.candidate.suggestions[0].text,code:'unsupported_fact',reason:'A pending private review is not publication authority.'}]});enter();});
 },{noteText:SELF_MATERIAL});
 const pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await entered;app.store.forgetSource(scope,'note:'+app.note.id);release();await pending.catch(()=>{});
 assert.equal(app.calls.length,2);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(request=>request.purpose==='delivery_repair').length,0);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});

test('a new explicit-invitation candidate is checked against both original turns under its own current intent',async t=>{
 let invite=false;const invitation='周六要不要一起看看小葱？',app=await application(t,p=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  if(!invite)return {operation:'advise',text:ADVICE};const id=p.intentAuthority.sourceId,c=text=>({text,sourceIds:[id]});return {operation:'prepare_message',answer:{privateExplanation:'按这次原话中的明确邀请提出选择。',suggestions:[{text:invitation}]}};
 });
 await app.assist(HUMAN,'fidelity-no-invite');invite=true;const current='这次我改变主意，想直接邀请她周六一起看看小葱。',reply=await app.assist(current,'fidelity-later-invite'),packet=app.calls.at(-1).p;
 assert.equal(reply.suggestions[0].text,invitation);assert.ok(packet.evidence.some(source=>source.text===HUMAN));assert.ok(packet.evidence.some(source=>source.text===current));assert.equal(packet.currentHumanControl.bodyLocation,'evidence');assert.equal(packet.currentHumanControl.sourceId,packet.intentAuthority.sourceId);assert.equal(packet.evidence.find(source=>source.sourceId===packet.currentHumanControl.sourceId).text,current);assert.equal(app.calls.length,4);assert.notEqual(app.calls[0].taskId,app.calls[2].taskId);
});

for(const event of ['account','contact','QQ','withdrawal'])test(`an incomplete checker result cannot publish after an actual ${event} boundary`,async t=>{
 let release,enter,checks=0;const entered=new Promise(resolve=>{enter=resolve;}),app=await application(t,(p,wrapper)=>{
  if(p.purpose!=='fidelity_check')return prepared(p);
  checks++;return new Promise(resolve=>{release=()=>resolve({checkRef:p.checkRef,unchecked:true,issues:[]});enter();});
 },{noteText:SELF_MATERIAL});
 const pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await Promise.race([entered,pending.then(()=>{throw Error('Expected a controlled incomplete checker response');})]);
 if(event==='account')app.controller.updateStatus({phase:'ready',account:{uid:'different-authenticated-account',uin:'999000'}});
 if(event==='contact')await app.controller.bind('99887766');
 if(event==='QQ'){app.controller.live({scope,messages:[raw('91000000000000383',false,{elements:[{textElement:{content:'新的实际来信。'}}]})]});clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;}
 if(event==='withdrawal')app.store.forgetSource(scope,'note:'+app.note.id);
 release();await pending.catch(()=>{});assert.equal(app.calls.length,2);assert.equal(checks,1);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(request=>request.purpose==='delivery_repair').length,0);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.store.messages(scope).some(record=>record.direction==='outgoing'),false);
});

test('a malformed checker labels incomplete after a primary structural repair without buying another slot',async t=>{
 const app=await application(t,(p,_wrapper,index)=>index===0?{operation:'prepare_message',answer:'Malformed'}:p.purpose==='fidelity_check'?{checkRef:p.checkRef,factual:factualReview(p,{'suggestions[0].text':[{quote:'Absent checker quotation.',kind:'intent'}]}),issues:[]}:{operation:'prepare_message',answer:{suggestions:[{text:'新叶看着挺精神。'}]}});
 const reply=await app.assist();assert.equal(reply.semanticReview.status,'incomplete');assert.equal(app.calls.length,3);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
});

test('a factual criticism survives malformed optional diagnostics without a whole-candidate regeneration',async t=>{
 let checks=0;const bad='我今天刚忙完，最近过得很充实。',known='今天你种的小葱又多了两片新叶。',question='你最近愿意分享的哪件真实小事，让你印象最深？',app=await application(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,factual:factualReview(p,++checks===1?{'suggestions[0].text':[{quote:bad,kind:'assertion',support:'unsupported',basis:'no_support_in_supplied_evidence',reason:{sourceId:'s999'}}]}:{}),issues:[],concerns:{sourceId:'s999'}};
  if(wrapper.originalInput){assert.match(wrapper.task,/通用忙碌近况/);return {operation:'prepare_message',answer:{suggestions:[{text:known}],privateExplanation:question}};}
  return {operation:'prepare_message',answer:{suggestions:[{text:bad}],privateExplanation:'这是一个没有具体编造的填空框架。'}};
 });
 const reply=await app.assist('先接她这条，也让我分享一点真实近况。');assert.equal(app.calls.length,2);assert.equal(reply.suggestions[0].text,bad);assert.ok(reply.semanticReview.findings.some(f=>f.quote===bad));assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(request=>request.purpose==='delivery_repair').length,0);
});

test('existing exact currentFacts admission supports requested work facts after structural repair without licensing private reasons',async t=>{
 const human='我们只是同事。把明天十点交接要确认的两项说清楚：负责人和缺的附件，别催她现在立刻回。',message='明天十点交接，我们确认负责人和缺的附件。你今天培训辛苦了，不用现在回。',app=await application(t,(p,wrapper,index)=>{
  if(index===0)return {operation:'prepare_message',answer:'Malformed'};
  if(p.purpose==='fidelity_check'){
   const current=p.evidence.find(source=>source.sourceId===p.intentAuthority.sourceId),qq=p.evidence.find(source=>source.type==='qq'&&source.text==='今天培训一整天。');
   return {checkRef:p.checkRef,issues:[{path:'suggestions[0].text',code:'private_disclosure',quote:'你今天培训辛苦了',evidence:[{sourceId:qq.sourceId,quote:qq.text}]}],factual:factualReview(p,{'suggestions[0].text':[
    {quote:'明天十点交接',kind:'assertion',support:'supported',evidence:[{sourceId:current.sourceId,quote:'明天十点交接'}]},
    {quote:'我们确认负责人和缺的附件',kind:'intent'},
    {quote:'你今天培训辛苦了',kind:'assertion',support:'supported',evidence:[{sourceId:qq.sourceId,quote:qq.text}]},
    {quote:'不用现在回',kind:'intent'}]})};
  }
  assert.match(wrapper.task,/通用忙碌近况/);assert.match(app.calls.at(-1).request.messages[0].content,/通用忙碌近况/);
  return {operation:'prepare_message',currentFacts:['明天十点交接','负责人和缺的附件'],answer:{suggestions:[{text:message}]}};
 });
 app.controller.live({scope,messages:[raw('91000000000000384',false,{elements:[{textElement:{content:'今天培训一整天。'}}]})]});
 const reply=await app.assist(human);assert.equal(reply.suggestions[0].text,message);assert.equal(app.calls.length,3);assert.equal(app.calls.at(-1).p.admittedFragments.length,2);assert.equal(app.calls.at(-1).p.admittedFragments.some(fragment=>fragment.text===human),false);assert.equal(app.store.messages(scope).some(record=>record.direction==='outgoing'),false);
});
