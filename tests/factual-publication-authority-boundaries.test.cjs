'use strict';
// Fictional source/transport boundary tests. Scripted assessments do not prove
// natural-language entailment, person understanding or conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {buildFidelityContext:buildLegacyContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
// Historical census decoder contract only; native controller uses sparse audit.
const buildFidelityContext=(prepared,result,info={})=>buildLegacyContext(prepared,result,{...info,auditProtocol:'legacy-census-v7'});
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const NOW='2026-10-29T10:40:00.000Z';
const HUMAN='想接她这条，也让她知道一点我的日常，帮我写个自然的回复。';
const MINT='阳台那盆薄荷终于冒新叶了，前几天我还以为它不长了。';
const UNSUPPORTED='我刚忙完手头的事，准备歇一会儿。';
const CAVEAT='这里没有你的真实近况；外发句中的忙完和休息只是占位，实际使用前应换成真实内容。';
const source=(id,text,extra={})=>({id,text,type:'private',role:'user',kind:'discussion',use:'discussion',revision:'revision-'+id,at:NOW,...extra});
function fixture({message=UNSUPPORTED,why=CAVEAT,candidate={},requestId='factual-authority-boundary',extraSources=[],admitted=[]}={}){
 const current=source('private:current-factual-authority',HUMAN),mint=source('qq:900719925474099876401',MINT,{type:'qq',role:'contact'}),sources=[mint,current,...extraSources];
 const manifest={scope:structuredClone(scope),requestId,sourceIds:sources.map(source=>source.id),sourceRevisions:Object.fromEntries(sources.map(source=>[source.id,source.revision]))};
 const prepared={payload:{purpose:'discussion',asOf:NOW,intentAuthority:{sourceId:current.id},sources},manifest,fullAvailableSources:sources,essentialSourceIds:sources.map(source=>source.id)};
 const result={kind:'draft',text:'',suggestions:[{style:'自然',text:message}],...(why?{discussionExplanation:{kind:'discussion',text:why}}:{}),...candidate};
 const input=buildFidelityContext(prepared,result,{scope:manifest.scope,requestId,admittedContext:{payload:{outboundQuotes:admitted,currentHumanControl:{sourceId:current.id,authority:'CONTROL_ONLY',text:current.text}},manifest},requestMeasure:payload=>Buffer.byteLength(JSON.stringify(payload))});
 return {prepared,result,input,current,mint};
}

test('the observed legacy allow plus advisory unsupported personal detail cannot approve an independent copyable self claim',()=>{
 const app=fixture(),legacy={checkRef:'c1',verdict:'allow',issues:[],concerns:[{path:'suggestions[0].text',code:'unsupported_personal_detail',quote:UNSUPPORTED,reason:'The self event has no original source; the private caveat only calls it a placeholder.'}]};
 assert.equal(app.input.payload.evidence.some(source=>source.text===CAVEAT),false,'the generated caveat is candidate text, never independent original support');
 assert.throws(()=>parseFidelityResult(legacy,app.input),error=>typeof error.code==='string','a missing mandatory factual assessment must fail closed, not inherit old allow');
});

// This helper fills program-generated coordinates only. Each fixture explicitly
// declares the statements it is classifying; unlisted fields contain none.
const factual=(input,statements={})=>input.payload.candidatePaths.map(path=>({path,statements:statements[path]||[]}));
const decision=(app,statements={},extra={})=>({checkRef:'c1',verdict:'allow',issues:[],factual:factual(app.input,statements),...extra});
const unsupported=(quote=UNSUPPORTED)=>({quote,kind:'assertion',support:'unsupported',basis:'no_support_in_supplied_evidence',reason:'No actual original supports this personal assertion.'});
function cannotApprove(app,value){
 let parsed;try{parsed=parseFidelityResult(value,app.input);}catch(error){assert.equal(typeof error.code,'string');return;}
 assert.notEqual(parsed.verdict,'allow');assert.equal(approvalFor(parsed,app.input),undefined);
}

test('typed unsupported assertion overrides reported allow despite its private placeholder caveat',()=>{
 const app=fixture(),value=decision(app,{'suggestions[0].text':[unsupported()]}),before=structuredClone(value),parsed=parseFidelityResult(value,app.input);
 assert.equal(parsed.verdict,'reject');assert.equal(approvalFor(parsed,app.input),undefined);assert.equal(parsed.issues[0].code,'unsupported_fact');assert.equal(parsed.issues[0].quote,UNSUPPORTED);assert.deepEqual(value,before);assert.equal(app.input.manifest.fidelity.reportedVerdict,'allow');
});

test('an explicit unverifiable factual assessment cannot grant publication',()=>{
 const app=fixture(),parsed=parseFidelityResult(decision(app,{'suggestions[0].text':[{quote:UNSUPPORTED,kind:'assertion',support:'unverifiable',reason:'Necessary original support cannot be checked.'}]},{concerns:{bad:'optional container'}}),app.input);
 assert.equal(parsed.verdict,'uncertain');assert.equal(approvalFor(parsed,app.input),undefined);
});

test('actual authorized self material with a full original witness remains usable',()=>{
 const text='我今天修好了自己的台灯。',note=source('note:authorized-self',text+'这个真实小进展可以告诉她。',{type:'note',kind:'material',use:'draft'}),app=fixture({message:text,why:'依据已选真实素材组织表达。',extraSources:[note],admitted:[{sourceId:note.id,text}]}),parsed=parseFidelityResult(decision(app,{'suggestions[0].text':[{quote:text,kind:'assertion',support:'supported',evidence:[{sourceId:note.id,quote:note.text}]}]}),app.input);
 assert.equal(parsed.verdict,'allow');assert.ok(approvalFor(parsed,app.input));assert.equal(app.result.suggestions[0].text,text);
});

test('mere intent, opinion and a question without an asserted personal premise remain nonblocking',()=>{
 const message='我想多跟你聊聊。听起来挺有意思。你想聊哪一部分？',app=fixture({message,why:''}),parsed=parseFidelityResult(decision(app,{'suggestions[0].text':[
  {quote:'我想多跟你聊聊。',kind:'intent'},{quote:'听起来挺有意思。',kind:'opinion'},{quote:'你想聊哪一部分？',kind:'question'}
 ]}),app.input);
 assert.equal(parsed.verdict,'allow');assert.ok(approvalFor(parsed,app.input));
});

for(const [name,message,quote]of [
 ['reported personal plan','我下周要去北京。','我下周要去北京。'],
 ['reported recurring preference','我一直喜欢爵士。','我一直喜欢爵士。'],
 ['question with an asserted premise','你还在X酒吧上班吗？','你还在X酒吧上班']
])test(`an explicitly assessed unsupported ${name} is not exempted by future, preference or question form`,()=>{
 const app=fixture({message,why:''}),statements=[unsupported(quote),...(name.startsWith('question')?[{quote:message,kind:'question'}]:[])],parsed=parseFidelityResult(decision(app,{'suggestions[0].text':statements}),app.input);
 assert.equal(parsed.verdict,'reject');assert.equal(approvalFor(parsed,app.input),undefined);
});

test('a genuine complete conditional example can remain in its own private field',()=>{
 const condition='如果你今天确实修好了台灯，而且愿意告诉她',example='我今天修好了台灯。',context=condition+'，可以参考：“'+example+'”',app=fixture({why:'',candidate:{kind:'discussion',text:context,suggestions:[]}}),parsed=parseFidelityResult(decision(app,{text:[{quote:example,kind:'private_conditional',condition,contextQuote:context}]}),app.input);
 assert.equal(parsed.verdict,'allow');assert.ok(approvalFor(parsed,app.input));assert.equal(app.result.suggestions.length,0);
});

test('a conditional or caveat in a different private field cannot exempt an independent copyable assertion',()=>{
 const condition='如果你今天确实修好了台灯，而且愿意告诉她',message='我今天修好了台灯。',context=condition+'，可以参考：“'+message+'”',app=fixture({message,why:context});
 cannotApprove(app,decision(app,{'suggestions[0].text':[{quote:message,kind:'private_conditional',condition,contextQuote:context}]}));
 const privateApp=fixture({why:'',candidate:{kind:'discussion',text:context,suggestions:[]}});
 cannotApprove(privateApp,decision(privateApp,{text:[{quote:message,kind:'private_conditional',condition:'A condition absent from this field.',contextQuote:context}]}));
 cannotApprove(privateApp,decision(privateApp,{text:[{quote:message,kind:'private_conditional',condition,contextQuote:message}]}));
});

test('every offered visible field is covered exactly once and arbitrary roots or hidden coordinates cannot pass',()=>{
 const app=fixture(),valid=decision(app,{'suggestions[0].text':[unsupported()]}),paths=app.input.payload.candidatePaths;
 for(const factual of [undefined,[],valid.factual.slice(1),[...valid.factual,valid.factual[0]],valid.factual.map((field,index)=>index?field:{...field,path:'evidence[0].text'}),valid.factual.map((field,index)=>index?field:{...field,path:'candidate.candidate.text'})])cannotApprove(app,{...valid,factual});
 assert.ok(paths.includes('suggestions[0].style'));assert.ok(paths.includes('discussionExplanation.text'));
});

test('assertions require an exact candidate quote and actual full original evidence or an explicit unsupported basis',()=>{
 const app=fixture(),path='suggestions[0].text';
 for(const statement of [
  {...unsupported(),quote:'A candidate sentence never offered.'},
  {...unsupported(),basis:undefined},
  {quote:UNSUPPORTED,kind:'assertion',support:'supported',evidence:[]},
  {quote:UNSUPPORTED,kind:'assertion',support:'supported',evidence:[{sourceId:'private:unoffered',quote:HUMAN}]},
  {quote:UNSUPPORTED,kind:'assertion',support:'supported',evidence:[{sourceId:app.current.id,quote:'An original sentence never delivered.'}]}
 ])cannotApprove(app,decision(app,{[path]:[statement]}));
 const body='我确实修过台灯。',partial=source('note:partial',body,{type:'note',use:'draft',delivery:{status:'partial',start:0,end:body.length,originalCharLength:body.length+50}}),partialApp=fixture({message:body,why:'',extraSources:[partial],admitted:[{sourceId:partial.id,text:body}]});
 cannotApprove(partialApp,decision(partialApp,{[path]:[{quote:body,kind:'assertion',support:'supported',evidence:[{sourceId:partial.id,quote:body}]}]}));
 const unknownRevision=source('note:unknown-revision',body,{type:'note',use:'draft',revision:undefined}),unversioned=fixture({message:body,why:'',extraSources:[unknownRevision],admitted:[{sourceId:unknownRevision.id,text:body}]});
 cannotApprove(unversioned,decision(unversioned,{[path]:[{quote:body,kind:'assertion',support:'supported',evidence:[{sourceId:unknownRevision.id,quote:body}]}]}));
});

test('optional malformed advisory cannot cancel a valid core allow or a valid unsupported factual reject',()=>{
 const intent='我想多跟你聊聊。',allowed=fixture({message:intent,why:''}),bad={path:'suggestions[9].text',code:'style',sourceIds:['not-offered'],reason:'Unusable private advisory.'};
 const yes=parseFidelityResult(decision(allowed,{'suggestions[0].text':[{quote:intent,kind:'intent'}]},{concerns:[bad]}),allowed.input);assert.equal(yes.verdict,'allow');assert.ok(approvalFor(yes,allowed.input));
 const rejected=fixture(),no=parseFidelityResult(decision(rejected,{'suggestions[0].text':[unsupported()]},{concerns:[bad]}),rejected.input);assert.equal(no.verdict,'reject');assert.equal(approvalFor(no,rejected.input),undefined);
 assert.ok(allowed.input.manifest.fidelity.unusableAdvisory.length);assert.ok(rejected.input.manifest.fidelity.unusableAdvisory.length);
});

test('targeted uncertainty and source, candidate or scope drift cannot reuse an old frame approval',()=>{
 const intent='我想多跟你聊聊。',app=fixture({message:intent,why:''}),value=decision(app,{'suggestions[0].text':[{quote:intent,kind:'intent'}]}),uncertainApp=fixture({message:'我周五会去北京。',why:''}),uncertain=parseFidelityResult(decision(uncertainApp,{'suggestions[0].text':[{quote:'我周五会去北京。',kind:'assertion',support:'unverifiable'}]}),uncertainApp.input);assert.equal(approvalFor(uncertain,uncertainApp.input),undefined);
 const parsed=parseFidelityResult(value,app.input),other=fixture({message:intent,why:'',requestId:'another-factual-frame'});assert.equal(approvalFor(parsed,other.input),undefined);
 for(const field of ['candidate','evidence','scope']){
  const current=fixture({message:intent,why:''}),valid=decision(current,{'suggestions[0].text':[{quote:intent,kind:'intent'}]});
  if(field==='candidate')current.result.suggestions[0].text='Changed unsupported candidate.';
  else if(field==='evidence')current.prepared.manifest.sourceRevisions[current.current.id]='changed-source-revision';
  else current.prepared.manifest.scope.peerUid='another-contact';
  cannotApprove(current,valid);
 }
});

async function application(t,producer,{limit=4,human=HUMAN}={}){
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-factual-authority',baseUrl='http://fixture.invalid/v1';
 t.mock.method(globalThis,'fetch',async()=>{throw Error('Unmocked HTTP forbidden');});
 const settings={anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:limit,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}};
 const controller=new Controller({store,settings,compactionModel:null,read:async command=>command==='bind'?scope:{messages:[]},assistantModel:(configured,input,signal)=>{
  contexts.push(input);return assistModel(configured,input,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({p,wrapper,request});const value=await producer(p,wrapper,calls.length-1);
   return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'factual-authority-transport',type:'function',function:{name:request.tool_choice.function.name,arguments:JSON.stringify(value)}}]}}]}),{status:200});
  });
 }});t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('900719925474099876401',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:MINT}}]})]});
 return {store,controller,calls,contexts,assist:()=>controller.assist({text:human,taskId:'factual-authority-task'})};
}
const wireDecision=(p,statements={},extra={})=>({checkRef:p.checkRef,verdict:'allow',issues:[],factual:p.candidatePaths.map(path=>({path,statements:statements[path]||[]})),...extra});

test('raw typed unsupported survives optional metadata errors and requires complete regeneration and fresh audit',async t=>{
 let checks=0,primaries=0;const repaired='薄荷终于冒新叶了。',question='你最近有什么愿意分享的真实小事？';
 const app=await application(t,p=>{
  if(p.purpose==='fidelity_check'){
   checks++;if(checks===1)return wireDecision(p,{'suggestions[0].text':[unsupported()]},{concerns:[{path:'suggestions[0].text',code:'style',sourceIds:['s999'],reason:'Unusable optional source coordinate.'}]});
   const mint=p.evidence.find(source=>source.type==='qq'&&source.text===MINT);assert.ok(mint);assert.equal(p.candidate.suggestions[0].text,repaired);return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  }
  primaries++;return {operation:'prepare_message',answer:{suggestions:[{text:primaries===1?UNSUPPORTED:repaired}],privateExplanation:primaries===1?CAVEAT:question}};
 });
 const reply=await app.assist();assert.equal(app.calls.length,4);assert.equal(primaries,2);assert.equal(checks,2);assert.equal(reply.suggestions[0].text,repaired);assert.equal(reply.semanticReview.exhaustive,false);const ledger=app.controller.usage.get(scope,'factual-authority-task');assert.equal(ledger.attempts,4);assert.deepEqual(ledger.requests.map(r=>r.purpose),['discussion','fidelity_check','delivery_repair','fidelity_check']);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});

for(const limit of [2,4])test(`an unsupported factual report cannot publish after bounded task budget ${limit}`,async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?wireDecision(p,{'suggestions[0].text':[unsupported()]}):{operation:'prepare_message',answer:{suggestions:[{text:UNSUPPORTED}],privateExplanation:CAVEAT}},{limit});
 await assert.rejects(app.assist(),e=>e.code===(limit===2?'terminal_fact_repair_budget':'terminal_fact_defect_unresolved'));assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);const ledger=app.controller.usage.get(scope,'factual-authority-task');assert.equal(ledger.attempts,limit);assert.equal(ledger.limit,limit);assert.equal(ledger.requests.filter(r=>r.purpose==='fidelity_check').length,limit===2?1:2);
});
