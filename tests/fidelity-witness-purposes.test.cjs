'use strict';
// Actual saved fictional replay packets and scripted functional findings only.
// These checks do not grade language, entailment or conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {buildFidelityContext:buildLegacyContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
// Historical census decoder contract only; native controller uses sparse audit.
const buildFidelityContext=(prepared,result,info={})=>buildLegacyContext(prepared,result,{...info,auditProtocol:'legacy-census-v7'});
const {mapSourceReferences}=require('../src/source-handles.cjs');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const ROOT=path.resolve(__dirname,'../../..');
const EVIDENCE=path.join(ROOT,'.goal-runs/context-051-factual-finding-publication/runs/candidate');
function captured(sequence=8){
 const report=JSON.parse(fs.readFileSync(path.join(EVIDENCE,'conv-share-own-material.run.json'),'utf8'));
 const transport=JSON.parse(fs.readFileSync(path.join(EVIDENCE,'transport.json'),'utf8'));
 const saved=report.diagnostics.snapshot.runs.find(run=>run.id==='replay-request-2').requests.filter(request=>request.purpose==='fidelity_check')[sequence===8?0:1];
 const response=JSON.parse(transport.requests.find(request=>request.sequence===sequence).response_body),message=response.choices[0].message;
 const raw=JSON.parse(message.content||message.tool_calls[0].function.arguments),bindings=new Map(saved.manifest.sourceHandles.bindings.map(item=>[item.handle,item.sourceId]));
 const decoded=mapSourceReferences(raw,id=>bindings.get(id)||id),scope=structuredClone(saved.manifest.scope),originals=new Map(report.diagnostics.snapshot.sources.map(source=>[source.id,source]));
 const sources=saved.payload.evidence.map(item=>{
  const {sourceId,...source}=item,original=originals.get(sourceId);assert.ok(original,'the complete top-level source identity must exist');assert.equal(original.revision,saved.manifest.sourceRevisions[sourceId]);assert.equal(original.text,item.text);
  return {...structuredClone(original),...source,id:sourceId,revision:saved.manifest.sourceRevisions[sourceId]};
 });
 const current=sources.find(source=>source.id===saved.payload.intentAuthority.sourceId);
 const prepared={payload:{purpose:'discussion',asOf:saved.payload.asOf,goal:saved.payload.goal,sources,intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:current.text}},manifest:{...structuredClone(saved.manifest),requestId:'captured051-'+sequence,scope},fullAvailableSources:sources,essentialSourceIds:sources.map(source=>source.id)};
 const candidate=structuredClone(saved.payload.candidate),result={kind:'draft',...candidate};
 const input=buildFidelityContext(prepared,result,{scope,requestId:prepared.manifest.requestId,admittedContext:{payload:{outboundQuotes:saved.payload.admittedFragments||[],currentHumanControl:saved.payload.currentHumanControl},manifest:prepared.manifest},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
 assert.deepEqual(input.payload.candidate,candidate,'the actual complete candidate is reused without editing');
 for(const source of saved.payload.evidence)assert.equal(input.payload.evidence.find(item=>item.sourceId===source.sourceId)?.text,source.text,'the actual complete original body is retained');
 return {report,saved,raw,decoded,prepared,result,input,current,sources};
}

test('captured051 seq8 factual support and opinion cannot be vetoed by an unbound positive-focus qualifier issue',()=>{
 const app=captured(8),field=app.decoded.factual.find(field=>field.path==='suggestions[0].text');
 assert.equal(field.statements.find(statement=>statement.quote==='薄荷还挺顽强的').kind,'opinion');
 assert.ok(field.statements.filter(statement=>statement.kind==='assertion').every(statement=>statement.support==='supported'));
 assert.equal(app.decoded.issues[0].code,'omitted_qualifier');assert.equal(app.decoded.issues[0].quote,'薄荷还挺顽强的');
 const parsed=parseFidelityResult(app.decoded,app.input);assert.equal(parsed.verdict,'allow');assert.ok(approvalFor(parsed,app.input));
});

test('a bare global uncertain report cannot independently veto the complete supported and nonfactual core',()=>{
 const app=captured(8),value={...app.decoded,verdict:'uncertain',issues:[],concerns:[]},parsed=parseFidelityResult(value,app.input);
 assert.equal(parsed.verdict,'allow');assert.ok(approvalFor(parsed,app.input));assert.equal(app.input.manifest.fidelity.reportedVerdict,'uncertain');
});

const NOW='2026-10-29T10:46:00.000Z';
const original=(id,text,extra={})=>({id,text,type:'private',role:'user',kind:'discussion',revision:'revision-'+id,at:NOW,...extra});
function fixture({message='薄荷冒新叶了。',why='',human='先帮我接住她的分享，不编造我自己的近况。',extraSources=[],recentHumanIds=[]}={}){
 const current=original('private:witness-current',human),mint=original('qq:900719925474099876561','薄荷冒新叶了，我前几天还差点把它养没了。',{type:'qq',role:'contact'}),sources=[mint,current,...extraSources].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const manifest={scope:structuredClone(scope),requestId:'witness-purpose-functional',sourceIds:sources.map(source=>source.id),sourceRevisions:Object.fromEntries(sources.map(source=>[source.id,source.revision]))};
 const prepared={payload:{purpose:'discussion',asOf:NOW,sources,intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:human},taskContext:{recentHumanContext:recentHumanIds.map(sourceId=>({sourceId,role:'user',bodyLocation:'sources'}))}},manifest,fullAvailableSources:sources,essentialSourceIds:sources.map(source=>source.id)};
 const result={kind:'draft',text:'',suggestions:[{style:'自然',text:message}],...(why?{discussionExplanation:{kind:'discussion',text:why}}:{})};
 const input=buildFidelityContext(prepared,result,{scope:manifest.scope,admittedContext:{payload:{outboundQuotes:[],currentHumanControl:{sourceId:current.id,text:human,authority:'CONTROL_ONLY'}},manifest},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});return {prepared,result,input,current,mint,sources};
}
const factual=(app,statements={})=>app.input.payload.candidatePaths.map(path=>({path,statements:statements[path]||[]}));
const decision=(app,statements={},extra={})=>({checkRef:'c1',verdict:'allow',issues:[],factual:factual(app,statements),...extra});
const unsupported=quote=>({quote,kind:'assertion',support:'unsupported',basis:'no_support_in_supplied_evidence'});
function cannotApprove(app,value){let parsed;try{parsed=parseFidelityResult(value,app.input);}catch(error){assert.equal(typeof error.code,'string');return;}assert.notEqual(parsed.verdict,'allow');assert.equal(approvalFor(parsed,app.input),undefined);}

test('a real factual qualification loss remains a blocking assessed assertion with a typed original witness',()=>{
 const qualified=original('qq:real-factual-qualification','周六下午三点以后才有空。',{type:'qq',role:'contact'}),message='你周六下午三点有空。',app=fixture({message,extraSources:[qualified]});
 const finding={quote:message,kind:'assertion',support:'unsupported',basis:'necessary_factual_qualification',qualification:'time',evidence:[{sourceId:qualified.id,quote:qualified.text}]};
 const parsed=parseFidelityResult(decision(app,{'suggestions[0].text':[finding]}),app.input);assert.equal(parsed.verdict,'reject');assert.equal(approvalFor(parsed,app.input),undefined);
 for(const patch of [{qualification:undefined},{qualification:'positive_focus'},{evidence:[]},{evidence:[{sourceId:'private:not-offered',quote:qualified.text}]}])cannotApprove(app,decision(app,{'suggestions[0].text':[{...finding,...patch}]}));
});

test('a genuine source contradiction is factual evidence, while an unsupported self claim cannot borrow a private caveat',()=>{
 const human='我没有修过台灯；不要把旁观写成我的经历。',message='我昨天修好了台灯。',app=fixture({message,human,why:'这是一个需要替换的自述占位，未必真实。'});
 const contradiction={quote:message,kind:'assertion',support:'unsupported',basis:'source_contradiction',evidence:[{sourceId:app.current.id,quote:human}]};
 assert.equal(parseFidelityResult(decision(app,{'suggestions[0].text':[contradiction]}),app.input).verdict,'reject');
 assert.equal(parseFidelityResult(decision(app,{'suggestions[0].text':[unsupported(message)]}),app.input).verdict,'reject');
});

test('candidate fact conflict references must identify another assessed assertion rather than advice or opinion',()=>{
 const message='我昨天修好了台灯。',why='你没有修过台灯。',app=fixture({message,why,human:why});
 const value=decision(app,{'suggestions[0].text':[{quote:message,kind:'assertion',support:'unsupported',basis:'candidate_fact_conflict',related:{path:'discussionExplanation.text',quote:why}}],'discussionExplanation.text':[{quote:why,kind:'assertion',support:'supported',evidence:[{sourceId:app.current.id,quote:why}]}]});
 assert.equal(parseFidelityResult(value,app.input).verdict,'reject');
 const missing=structuredClone(value);missing.factual.find(field=>field.path==='discussionExplanation.text').statements=[{quote:why,kind:'opinion'}];cannotApprove(app,missing);
});

test('a tentative emotional question and ordinary evaluation are not declarations of a known emotional fact',()=>{
 const message='薄荷终于冒新叶了，听着还挺有成就感的。看到新叶应该挺开心吧？',app=fixture({message});
 const value=decision(app,{'suggestions[0].text':[{quote:'薄荷终于冒新叶了',kind:'assertion',support:'supported',evidence:[{sourceId:app.mint.id,quote:'薄荷冒新叶了'}]},{quote:'听着还挺有成就感的。',kind:'opinion'},{quote:'看到新叶应该挺开心吧？',kind:'question'}]});
 assert.equal(parseFidelityResult(value,app.input).verdict,'allow');
});

test('captured rescue agency remains a hard factual counterexample despite its surrounding reaction',()=>{
 const app=captured(10),value={...app.decoded,verdict:'allow',issues:[],concerns:[]};
 const assertion=value.factual.find(field=>field.path==='suggestions[0].text').statements.find(statement=>statement.kind==='assertion');assert.equal(assertion.quote,'幸好你把它救回来了。');assert.equal(assertion.support,'unsupported');
 assert.equal(parseFidelityResult(value,app.input).verdict,'reject');assert.equal(app.result.suggestions[0].text.includes('幸好你把它救回来了'),true);
});

test('questions with concrete premises and claims of existing plans or preferences still need actual support',()=>{
 for(const [message,quote]of [['你还在X酒吧上班吗？','你还在X酒吧上班'],['我下周要去北京。','我下周要去北京。'],['我一直喜欢爵士。','我一直喜欢爵士。']]){
  const app=fixture({message}),statements=[unsupported(quote),...(message.endsWith('？')?[{quote:message,kind:'question'}]:[])];assert.equal(parseFidelityResult(decision(app,{'suggestions[0].text':statements}),app.input).verdict,'reject');
 }
});

test('private advice and a source-bound candidate inspection do not invent transcript facts',()=>{
 const message='薄荷冒新叶了。',inspection='这句只回应了她的近况。',advice='想补充自己时，可以私下先核对一件真实小事。',app=fixture({message,why:inspection+advice});
 const value=decision(app,{'suggestions[0].text':[{quote:message,kind:'assertion',support:'supported',evidence:[{sourceId:app.mint.id,quote:'薄荷冒新叶了'}]}],'discussionExplanation.text':[{quote:inspection,kind:'inspection',reference:{path:'suggestions[0].text',quote:message}},{quote:advice,kind:'advice'}]});
 assert.equal(parseFidelityResult(value,app.input).verdict,'allow');
 const bad=structuredClone(value);bad.factual.find(field=>field.path==='discussionExplanation.text').statements[0].reference.quote='A sentence absent from the candidate.';cannotApprove(app,bad);
 const copy=fixture({message:inspection});cannotApprove(copy,decision(copy,{'suggestions[0].text':[{quote:inspection,kind:'inspection',reference:{path:'suggestions[0].style',quote:'自然'}}]}));
});

test('truth support never cancels an explicit privacy restriction and invalid privacy witnesses remain strict',()=>{
 const secret='家里有人安排了复查。',human=secret+'这只是私下背景，不要告诉她。',app=fixture({message:secret,human});
 const value=decision(app,{'suggestions[0].text':[{quote:secret,kind:'assertion',support:'supported',evidence:[{sourceId:app.current.id,quote:secret}]}]},{issues:[{path:'suggestions[0].text',code:'private_disclosure',quote:secret,evidence:[{sourceId:app.current.id,quote:human}],reason:'The original human restricts outward disclosure.'}]});
 assert.equal(parseFidelityResult(value,app.input).verdict,'reject');
 const bad=structuredClone(value);bad.issues[0].evidence[0].sourceId='private:not-offered';cannotApprove(app,bad);
});

test('targeted unverifiable assertions still abstain, and missing coverage or frame/source drift cannot approve',()=>{
 const message='我今天修好了台灯。',app=fixture({message}),value=decision(app,{'suggestions[0].text':[{quote:message,kind:'assertion',support:'unverifiable'}]});
 assert.equal(parseFidelityResult(value,app.input).verdict,'uncertain');cannotApprove(app,{checkRef:'c1',verdict:'allow',issues:[]});cannotApprove(app,{...value,factual:[]});
 for(const kind of ['revision','scope','candidate']){
  const changed=fixture({message}),raw=decision(changed,{'suggestions[0].text':[unsupported(message)]});
  if(kind==='revision')changed.prepared.manifest.sourceRevisions[changed.current.id]='changed-revision';
  else if(kind==='scope')changed.prepared.manifest.scope.peerUid='foreign-contact';
  else changed.result.suggestions[0].text='A changed body.';
  cannotApprove(changed,raw);
 }
});

const BAN='这轮先别邀请她一起买花，只接住薄荷近况。';
function prohibition(app,{path='suggestions[0].text',quote=app.result.suggestions[0].text,source=app.current,applicability='active',current,override}={}){
 return {path,quote,code:'explicit_outward_prohibition',reason:'An actual scoped human instruction forbids this offered outward action.',prohibition:{sourceId:source.id,quote:source.text,action:'invitation',applicability,...(current?{current}:{}),...(override?{override}:{})}};
}
test('a model classification of invitation prohibition remains advisory beside ordinary social concerns',()=>{
 const message='要不要一起去买花？',app=fixture({message,human:BAN});
 const value=decision(app,{'suggestions[0].text':[{quote:message,kind:'question'}]},{issues:[prohibition(app)]}),checked=parseFidelityResult(value,app.input);assert.equal(checked.verdict,'allow');assert.equal(checked.concerns[0].code,'explicit_outward_prohibition');
 const reaction='薄荷冒新叶了，还挺顽强的。',safe=fixture({message:reaction,human:BAN});
 const parsed=parseFidelityResult(decision(safe,{'suggestions[0].text':[{quote:'薄荷冒新叶了',kind:'assertion',support:'supported',evidence:[{sourceId:safe.mint.id,quote:'薄荷冒新叶了'}]},{quote:'还挺顽强的。',kind:'opinion'}]},{concerns:[{path:'suggestions[0].text',code:'current_boundary',quote:reaction,reason:'A possible social interpretation remains advisory.'}]}),safe.input);assert.equal(parsed.verdict,'allow');
});

test('QQ quotations cannot become a hard semantic assistant-control veto merely because a human authored them',()=>{
 for(const role of ['user','contact']){
  const message='要不要一起去买花？',qq=original('qq:quoted-ban-'+role,BAN,{type:'qq',role}),app=fixture({message,human:'我现在想邀请她一起买花。',extraSources:[qq]});
  assert.equal(parseFidelityResult(decision(app,{'suggestions[0].text':[{quote:message,kind:'question'}]},{issues:[prohibition(app,{source:qq})]}),app.input).verdict,'allow');
 }
});

test('an explicit later current-human override can replace a scoped older invitation prohibition',()=>{
 const old=original('private:earlier-no-invite',BAN,{at:'2026-10-29T10:45:00Z'}),human='现在可以邀请她一起买花，帮我问问她愿不愿意。',message='要不要一起去买花？',app=fixture({message,human,extraSources:[old],recentHumanIds:[old.id]});
 const current={sourceId:app.current.id,quote:human},value=decision(app,{'suggestions[0].text':[{quote:message,kind:'question'}]},{issues:[prohibition(app,{source:old,applicability:'overridden',current,override:current})]});
 const parsed=parseFidelityResult(value,app.input);assert.equal(parsed.verdict,'allow');assert.ok(approvalFor(parsed,app.input));
 const bad=structuredClone(value);bad.issues[0].prohibition.override={sourceId:old.id,quote:BAN};assert.equal(parseFidelityResult(bad,app.input).verdict,'allow','unreliable semantic applicability metadata is not a permission gate');
});

test('private inspection and a conditional future example mentioning the ban are not offered forbidden utterances',()=>{
 const message='薄荷冒新叶了。',inspection='你要求这轮先不邀请，我们先分析这点。',app=fixture({message,human:BAN,why:inspection});
 const statements={'suggestions[0].text':[{quote:message,kind:'assertion',support:'supported',evidence:[{sourceId:app.mint.id,quote:'薄荷冒新叶了'}]}],'discussionExplanation.text':[{quote:inspection,kind:'inspection',reference:{path:'suggestions[0].text',quote:message}}]};
 assert.equal(parseFidelityResult(decision(app,statements,{issues:[prohibition(app,{path:'discussionExplanation.text',quote:'先不邀请'})]}),app.input).verdict,'allow');
 const condition='如果以后你明确决定邀请',example='要不要一起买花？',why=condition+'，才可以参考：“'+example+'”',conditional=fixture({message,human:BAN,why});
 const value=decision(conditional,{'suggestions[0].text':[{quote:message,kind:'assertion',support:'supported',evidence:[{sourceId:conditional.mint.id,quote:'薄荷冒新叶了'}]}],'discussionExplanation.text':[{quote:example,kind:'private_conditional',condition,contextQuote:why}]},{issues:[prohibition(conditional,{path:'discussionExplanation.text',quote:example})]});
 assert.equal(parseFidelityResult(value,conditional.input).verdict,'allow');
});

test('a semantic concern about a private invitation recommendation does not become an execution gate',()=>{
 const message='薄荷冒新叶了。',why='你也可以现在邀请她一起去买花。',app=fixture({message,human:BAN,why});
 const value=decision(app,{'suggestions[0].text':[{quote:message,kind:'assertion',support:'supported',evidence:[{sourceId:app.mint.id,quote:'薄荷冒新叶了'}]}],'discussionExplanation.text':[{quote:why,kind:'advice',outwardAction:'invitation'}]},{issues:[prohibition(app,{path:'discussionExplanation.text',quote:'邀请她一起去买花'})]});
 const checked=parseFidelityResult(value,app.input);assert.equal(checked.verdict,'allow');assert.equal(checked.concerns[0].code,'explicit_outward_prohibition');
});

test('the initial call receives shared missing-material guidance and can deliver the known reply plus one private question',async t=>{
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-witness-repair',baseUrl='http://fixture.invalid/v1';let primaries=0,checks=0;
 t.mock.method(globalThis,'fetch',async()=>{throw Error('Unmocked HTTP forbidden');});
 const configured={model,baseUrl,anonymous:true,auto:false,modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}};
 const invented='我今天刚忙完，终于能歇一会儿。',known='薄荷终于冒新叶了。',question='你最近有什么愿意分享的真实小事？',mint='阳台那盆薄荷终于冒新叶了，前几天我还以为它不长了。';
 const controller=new Controller({store,settings:configured,compactionModel:null,read:async command=>command==='bind'?scope:{messages:[]},assistantModel:(settings,input,signal)=>{
  contexts.push(input);return assistModel(settings,input,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({p,wrapper,request});let value;
   if(p.purpose==='fidelity_check'){
    checks++;const statements={'suggestions[0].text':[{quote:known,kind:'assertion',support:'supported',evidence:[{sourceId:p.evidence.find(source=>source.text===mint).sourceId,quote:mint}]}],'discussionExplanation.text':[{quote:question,kind:'question'}]};
    value={checkRef:p.checkRef,verdict:checks===1?'allow':'uncertain',issues:[],factual:p.candidatePaths.map(path=>({path,statements:statements[path]||[]})),concerns:{malformed:'optional diagnostic'}};
   }else{
    primaries++;if(wrapper.originalInput)assert.doesNotMatch(wrapper.task,/原文不足则明确clarify/,'lack of self material must not force abandoning the known QQ response');
    value={operation:'prepare_message',answer:{suggestions:[{text:known}],privateExplanation:question}};
   }
   return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'witness-raw-result',type:'function',function:{name:request.tool_choice.function.name,arguments:JSON.stringify(value)}}]}}]}),{status:200});
  });
 }});t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('900719925474099876562',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:mint}}]})]});
 const reply=await controller.assist({text:'想接她这条，也让她知道一点我的日常，帮我写个自然的回复。',taskId:'truthful-partial-repair'});
 assert.equal(calls.length,1);assert.equal(primaries,1);assert.equal(checks,0);assert.equal(reply.suggestions[0].text,known);assert.equal(reply.discussionExplanation.text,question);assert.equal(reply.text,'');assert.equal(JSON.stringify(reply).includes(invented),false);
 const usage=controller.usage.get(scope,'truthful-partial-repair');assert.equal(usage.attempts,1);assert.equal(usage.limit,4);assert.equal(usage.requests.filter(request=>request.purpose==='delivery_repair').length,0);assert.equal(contexts.filter(input=>input.payload.purpose==='fidelity_check').length,0);assert.match(calls[0].request.messages[0].content,/privateExplanation.*真实小事|真实近况/);assert.equal(store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
