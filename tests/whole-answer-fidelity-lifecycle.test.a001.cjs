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

// Ordinary publication no longer has a semantic reviewer. These probes keep
// the same program-owned material and lifecycle boundaries on primary help.
test('terminal private advice is one primary call with source-bound publication and no checker',async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check');return {operation:'advise',text:ADVICE};}),reply=await app.assist();assert.equal(app.calls.length,1);assert.equal(reply.text,ADVICE);assert.equal(reply.suggestions,undefined);assert.equal(reply.semanticReview,undefined);assert.ok(app.contexts[0].payload.sources.some(source=>source.text===HUMAN));assert.equal(app.run().manifest.publicationSeal.semanticCheck,false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('the primary whole why/message candidate is admitted and published without a composer or reviewer rewrite',async t=>{
 const message='我以前也装过一个两层小书架，背板对齐时还调整了一阵。',why='依据这段已准许的真实自述组织表达。',app=await application(t,p=>prepared(p,{message,why}),{noteText:SELF_MATERIAL}),reply=await app.assist('按已选真实经历给我完整帮助；PRIVATE_CONTROL_ONLY不要当作额外事实。');assert.equal(app.calls.length,1);assert.equal(reply.discussionExplanation.text,why);assert.equal(reply.suggestions[0].text,message);assert.equal(app.run().payload.outboundQuotes[0].text,SELF_MATERIAL);assert.equal(app.calls.some(call=>call.p.purpose==='draft'||call.p.purpose==='fidelity_check'),false);assert.equal(app.store.experiences.draft(scope),null);
});
test('a scripted contradictory primary is not automatically rewritten or certified by another model',async t=>{
 const bad='我以前独自装过一个四层书架。',app=await application(t,p=>prepared(p,{message:bad,why:'原文没有本人组装经历。',fragment:'我只看过朋友组装书架，'}),{noteText:ORIGINAL_QUALIFIER}),reply=await app.assist();assert.equal(reply.suggestions[0].text,bad);assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,1);assert.equal(app.run().manifest.publicationSeal.semanticCheck,false);
});
test('a primary format repair cannot buy an extra automatic review request',async t=>{
 const app=await application(t,(p,_w,index)=>index===0?{operation:'prepare_message',answer:'Malformed'}:prepared(p),{noteText:SELF_MATERIAL}),reply=await app.assist();assert.ok(reply.suggestions.length);assert.equal(app.calls.length,2);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(r=>r.purpose==='delivery_repair').length,1);assert.equal(reply.semanticReview,undefined);
});
test('invalid material references cannot be laundered by an absent checker or reach publication',async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check');const value=prepared(p);value.materials[0].materialRef='m999999';return value;},{noteText:SELF_MATERIAL});await assert.rejects(app.assist());assert.equal(app.calls.length,2);assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'),false);
});
for(const mode of ['uncertain','transport-error','timeout'])test(`an unrequested ${mode} critic never creates a review or warning`,async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check');return {operation:'advise',text:ADVICE};}),reply=await app.assist();assert.equal(reply.text,ADVICE);assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,1);
});
test('one-call budget can deliver primary advice without an automatic audit',async t=>{
 const app=await application(t,()=>({operation:'advise',text:ADVICE}),{limit:1}),reply=await app.assist();assert.equal(reply.text,ADVICE);assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,1);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').attempts,1);
});
for(const event of ['account','contact','QQ','withdrawal'])test(`a delayed primary response cannot publish after an actual ${event} boundary`,async t=>{
 let release,enter;const entered=new Promise(resolve=>{enter=resolve;}),app=await application(t,p=>new Promise(resolve=>{release=()=>resolve(prepared(p));enter();}),{noteText:SELF_MATERIAL}),pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await entered;
 if(event==='account')app.controller.updateStatus({phase:'ready',account:{uid:'different-account',uin:'999000'}});
 if(event==='contact')await app.controller.bind('99887766');
 if(event==='QQ'){app.controller.live({scope,messages:[raw('91000000000000382',false,{elements:[{textElement:{content:'新的实际来信。'}}]})]});clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;}
 if(event==='withdrawal')app.store.forgetSource(scope,'note:'+app.note.id);release();await pending.catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('source withdrawal in the final publication window cannot release a stale candidate',async t=>{
 const app=await application(t,p=>prepared(p),{noteText:SELF_MATERIAL}),bind=app.controller.candidateSession.bindPlan.bind(app.controller.candidateSession);t.mock.method(app.controller.candidateSession,'bindPlan',(...args)=>{app.store.forgetSource(scope,'note:'+app.note.id);return bind(...args);});await app.assist().catch(()=>{});assert.equal(app.calls.length,1);assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'),false);
});
test('a later explicit invitation retains the fresh human intent without adding a critic',async t=>{
 let invite=false;const invitation='周六要不要一起看看小葱？',app=await application(t,p=>invite?{operation:'prepare_message',answer:{suggestions:[{text:invitation}]}}:{operation:'advise',text:ADVICE});await app.assist(HUMAN,'before-invite');invite=true;const current='这次我改变主意，想直接邀请她周六一起看看小葱。',reply=await app.assist(current,'later-invite');assert.equal(reply.suggestions[0].text,invitation);assert.equal(app.calls.length,2);assert.ok(app.contexts[1].payload.sources.some(source=>source.text===HUMAN));assert.ok(app.contexts[1].payload.sources.some(source=>source.text===current));assert.notEqual(app.calls[0].taskId,app.calls[1].taskId);
});
for(const event of ['account','contact','QQ','withdrawal'])test(`the sealed publication window preserves the actual ${event} boundary`,async t=>{
 const app=await application(t,p=>prepared(p),{noteText:SELF_MATERIAL}),bind=app.controller.candidateSession.bindPlan.bind(app.controller.candidateSession);
 t.mock.method(app.controller.candidateSession,'bindPlan',(...args)=>{if(event==='account')app.controller.updateStatus({phase:'ready',account:{uid:'different-account',uin:'999000'}});if(event==='contact'){app.controller.scope={...scope,peerUid:'different-contact'};app.controller.changedContext();}if(event==='QQ'){app.controller.live({scope,messages:[raw('91000000000000383',false,{elements:[{textElement:{content:'新的实际来信。'}}]})]});clearTimeout(app.controller.assistantRetryTimer);app.controller.assistantRetryTimer=null;app.controller.pendingAssist=null;}if(event==='withdrawal')app.store.forgetSource(scope,'note:'+app.note.id);return bind(...args);});await app.assist().catch(()=>{});assert.equal(app.calls.length,1);assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('malformed primary structure is repaired once without any incomplete-review metadata',async t=>{
 const app=await application(t,(_p,_w,index)=>index===0?{operation:'prepare_message',answer:'Malformed'}:{operation:'prepare_message',answer:{suggestions:[{text:'新叶看着挺精神。'}]}}),reply=await app.assist();assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,2);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.filter(r=>r.purpose==='delivery_repair').length,1);
});
test('a scripted bad primary stays unverified rather than producing invented reviewer advice',async t=>{
 const bad='我今天刚忙完，最近过得很充实。',app=await application(t,()=>({operation:'prepare_message',answer:{suggestions:[{text:bad}]}})),reply=await app.assist();assert.equal(reply.suggestions[0].text,bad);assert.equal(reply.semanticReview,undefined);assert.equal(app.calls.length,1);assert.equal(app.controller.usage.get(scope,'whole-answer-fidelity').requests.some(r=>r.purpose==='delivery_repair'||r.purpose==='fidelity_check'),false);
});
test('exact currentFacts admission still binds work facts after a structural repair',async t=>{
 const human='我们只是同事。把明天十点交接要确认的两项说清楚：负责人和缺的附件，别催她现在立刻回。',message='明天十点交接，我们确认负责人和缺的附件，不用现在回。',app=await application(t,(_p,_w,index)=>index===0?{operation:'prepare_message',answer:'Malformed'}:{operation:'prepare_message',currentFacts:['明天十点交接','负责人和缺的附件'],answer:{suggestions:[{text:message}]}}),reply=await app.assist(human);assert.equal(reply.suggestions[0].text,message);assert.equal(app.calls.length,2);assert.equal(app.run().payload.outboundQuotes.length,2);assert.equal(app.run().payload.outboundQuotes.some(q=>q.text===human),false);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
