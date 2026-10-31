'use strict';
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
 const app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,verdict:'allow',issues:[]}:{operation:'advise',text:ADVICE}),reply=await app.assist();
 assert.equal(app.calls.length,2,'ordinary advice also requires the read-only check before publication');assert.equal(app.calls[1].p.purpose,'fidelity_check');assert.equal(app.calls[1].p.candidate.text,ADVICE);
 assert.ok(app.calls[1].p.evidence.some(source=>source.text===HUMAN),'the checker sees the original human no-invite control');assert.equal(reply.text,ADVICE);assert.equal(reply.suggestions,undefined);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false,'the old rewrite/composer is not a substitute checker');
 assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1);assert.equal(app.calls.every(call=>call.request.model==='synthetic-whole-answer-fidelity'),true);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('the primary whole why/message candidate is admitted then checked without a separate composer rewrite',async t=>{
 const message='我以前也装过一个两层小书架，背板对齐时还调整了一阵。',why='依据这段已准许的真实自述组织表达。',app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,verdict:'allow',issues:[]}:prepared(p,{message,why}),{noteText:SELF_MATERIAL}),reply=await app.assist('按已选真实经历给我完整帮助；PRIVATE_CONTROL_ONLY不要当作额外事实。');
 assert.equal(app.calls.length,2);assert.equal(app.calls[1].p.purpose,'fidelity_check');assert.deepEqual(visibleCandidate(reply),app.calls[1].p.candidate);assert.equal(reply.discussionExplanation.text,why);assert.equal(reply.suggestions[0].text,message);
 assert.ok(app.calls[1].p.evidence.some(source=>source.text===SELF_MATERIAL));assert.equal(app.calls[1].p.admittedFragments[0].text,SELF_MATERIAL);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);assert.equal(JSON.stringify(reply).includes('PRIMARY_PLANNING_NOT_THE_WHOLE_ANSWER'),false);
 assert.equal(app.store.experiences.draft(scope),null);assert.equal(app.store.messages(scope).some(record=>record.direction==='outgoing'),false);
});

test('a scripted rejection of a why/body discrepancy regenerates the whole candidate once and rechecks original unselected qualifiers',async t=>{
 let checks=0;const bad='我以前独自装过一个四层书架。',badWhy='原文没有本人组装经历，不能把旁观当成亲历。',app=await application(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check'){checks++;assert.ok(p.evidence.some(source=>source.text===ORIGINAL_QUALIFIER));if(checks===1){assert.equal(p.candidate.suggestions[0].text,bad);assert.equal(p.candidate.discussionExplanation.text,badWhy);return {checkRef:p.checkRef,verdict:'reject',issues:[{path:'suggestions[0].text',code:'internal_conflict',quote:bad,relatedPath:'discussionExplanation.text',relatedQuote:badWhy,reason:'Scripted rejection tests the lifecycle, not model quality.'}]};}return {checkRef:p.checkRef,verdict:'allow',issues:[]};}
  if(!wrapper.originalInput){const value=prepared(p,{message:bad,why:badWhy,fragment:'我只看过朋友组装书架，'});value.statePatch={items:[{text:'REJECTED_CANDIDATE_STATE_NOT_COMMITTED',sourceIds:[p.intentAuthority.sourceId]}]};return value;}
  return prepared(p,{message:OPINION,why:'保留真实看法与未来打算，不补亲历事件。',current:true,fragment:OPINION});
 },{noteText:ORIGINAL_QUALIFIER});
 const before=app.store.getCompanion(scope).state.version,human='这次先不要邀请。'+OPINION+'这两句可以告诉她。',reply=await app.assist(human);assert.equal(app.calls.length,4);assert.equal(checks,2);assert.equal(reply.suggestions[0].text,OPINION);assert.deepEqual(visibleCandidate(reply),app.calls[3].p.candidate);
 assert.equal(app.calls[1].p.admittedFragments[0].text,'我只看过朋友组装书架，');assert.equal(app.calls[3].p.evidence.find(source=>source.text===human).text,human);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(request=>request.purpose==='delivery_repair').length,1);
 assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);assert.equal(JSON.stringify(reply).includes(bad),false);assert.equal(app.store.getCompanion(scope).state.version,before);
});

test('a checker rejection cannot obtain a second shared repair after the primary format repair was already spent',async t=>{
 const bad='我以前独自装过一个四层书架。',app=await application(t,(p,_wrapper,index)=>{if(index===0)return {operation:'prepare_message',draftPlan:'malformed plan',answer:{suggestions:[{text:'Unusable candidate.'}]}};if(p.purpose==='fidelity_check'){const source=p.evidence.find(source=>source.text===SELF_MATERIAL);return {checkRef:p.checkRef,verdict:'reject',issues:[{path:'suggestions[0].text',code:'evidence_mismatch',quote:bad,evidence:[{sourceId:source.sourceId,quote:source.text}],reason:'Scripted terminal rejection preserves the explicit two-layer material.'}]};}const value=prepared(p,{message:bad});value.statePatch={items:[{text:'UNAPPROVED_STATE_EFFECT',sourceIds:[p.intentAuthority.sourceId]}]};return value;},{noteText:SELF_MATERIAL});
 const before=app.store.getCompanion(scope).state.version;await assert.rejects(app.assist('按所选原话准备表达。'),error=>error.code==='request_delivery_repair_exhausted');
 const ledger=app.controller.usage.get(scope,'whole-answer-fidelity');assert.equal(app.calls.length,3);assert.equal(ledger.attempts,3);assert.equal(ledger.requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.equal(app.store.getCompanion(scope).state.version,before);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});

test('invalid material references cannot be laundered by a checker allowance or reach publication',async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check','program admission must reject invalid references before checking');const value=prepared(p);value.materials[0].materialRef='m999999';return value;},{noteText:SELF_MATERIAL});
 await assert.rejects(app.assist());assert.equal(app.calls.length,2);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').status,'failed');
});

for(const mode of ['uncertain','transport-error','timeout'])test(`checker ${mode} never publishes an unchecked private answer`,async t=>{
 const app=await application(t,p=>{if(p.purpose!=='fidelity_check')return {operation:'advise',text:ADVICE};if(mode==='uncertain')return {checkRef:p.checkRef,verdict:'uncertain',issues:[]};if(mode==='timeout')throw new DOMException('Scripted checker timeout','TimeoutError');throw Error('Scripted checker transport error');});
 await assert.rejects(app.assist());assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').status,'failed');assert.ok(app.calls.length<=4);
});

test('an exhausted shared HTTP budget cannot skip the checker and publish the primary advice',async t=>{
 const app=await application(t,()=>({operation:'advise',text:ADVICE}),{limit:1});await assert.rejects(app.assist(),error=>error.code==='request_budget_exhausted');assert.equal(app.calls.length,1);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').attempts,1);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});

for(const event of ['account','contact','QQ','withdrawal'])test(`a delayed checker allowance cannot publish after an actual ${event} boundary`,async t=>{
 let release,enter;const entered=new Promise(resolve=>{enter=resolve;}),app=await application(t,p=>p.purpose==='fidelity_check'?new Promise(resolve=>{release=()=>resolve({checkRef:p.checkRef,verdict:'allow',issues:[]});enter();}):prepared(p),{noteText:SELF_MATERIAL});
 const pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await Promise.race([entered,pending.then(()=>{throw Error('The answer published before the controlled checker');})]);
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false,'no answer is visible while its checker is pending');
 if(event==='account')app.controller.updateStatus({phase:'ready',account:{uid:'different-authenticated-account',uin:'999000'}});
 if(event==='contact')await app.controller.bind('99887766');
 if(event==='QQ'){app.controller.live({scope,messages:[raw('91000000000000382',false,{elements:[{textElement:{content:'新的来信改变了当前交流位置。'}}]})]});clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;}
 if(event==='withdrawal')app.store.forgetSource(scope,'note:'+app.note.id);
 release();await pending.catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.store.messages(scope).some(record=>record.direction==='outgoing'),false);
});

test('source withdrawal during the one candidate-regeneration repair cannot publish or recheck a stale answer',async t=>{
 let release,enter;const bad='我以前装过一个四层书架。',entered=new Promise(resolve=>{enter=resolve;}),app=await application(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check'){const source=p.evidence.find(source=>source.text===SELF_MATERIAL);return {checkRef:p.checkRef,verdict:'reject',issues:[{path:'suggestions[0].text',code:'evidence_mismatch',quote:bad,evidence:[{sourceId:source.sourceId,quote:source.text}],reason:'Scripted rejection starts the one repair against the supplied two-layer original.'}]};}
  if(wrapper.originalInput)return new Promise(resolve=>{release=()=>resolve(prepared(p));enter();});return prepared(p,{message:bad});
 },{noteText:SELF_MATERIAL});
 const pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await Promise.race([entered,pending.then(()=>{throw Error('Expected a controlled regeneration repair');})]);app.store.forgetSource(scope,'note:'+app.note.id);release();await pending.catch(()=>{});
 assert.equal(app.calls.length,3);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});

test('a new explicit-invitation candidate is checked against both original turns under its own current intent',async t=>{
 let invite=false;const invitation='周六要不要一起看看小葱？',app=await application(t,p=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,verdict:'allow',issues:[]};
  if(!invite)return {operation:'advise',text:ADVICE};const id=p.intentAuthority.sourceId,c=text=>({text,sourceIds:[id]});return {operation:'prepare_message',answer:{privateExplanation:'按这次原话中的明确邀请提出选择。',suggestions:[{text:invitation}]}};
 });
 await app.assist(HUMAN,'fidelity-no-invite');invite=true;const current='这次我改变主意，想直接邀请她周六一起看看小葱。',reply=await app.assist(current,'fidelity-later-invite'),packet=app.calls.at(-1).p;
 assert.equal(reply.suggestions[0].text,invitation);assert.ok(packet.evidence.some(source=>source.text===HUMAN));assert.ok(packet.evidence.some(source=>source.text===current));assert.equal(packet.currentHumanControl.bodyLocation,'evidence');assert.equal(packet.currentHumanControl.sourceId,packet.intentAuthority.sourceId);assert.equal(packet.evidence.find(source=>source.sourceId===packet.currentHumanControl.sourceId).text,current);assert.equal(app.calls.length,4);assert.notEqual(app.calls[0].taskId,app.calls[2].taskId);
});
