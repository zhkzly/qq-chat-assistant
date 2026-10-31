'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional contract probes derived from decision-ownership boundaries and
// lifecycle fixtures. Scripted verdicts do not measure model semantic quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {buildFidelityContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
const {prepareAssistantRequest,assistModel}=require('../src/assistant-model.cjs');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const NOW='2026-10-01T10:00:00.000Z';
const BAD='我昨天也给自己养的花盆换了土。';
const HUMAN='这次只接她分享的盆栽近况，别假装我有过养植物的经历。';
const source=(id,text,extra={})=>({id,text,type:'private',role:'user',kind:'discussion',use:'discussion',revision:'revision-'+id,at:NOW,...extra});
const typed=code=>error=>error.code===code||error.issues?.some(issue=>issue.code===code);
const pathFailure=(field,received,paths)=>error=>{
 assert.equal(error.code,'fidelity_candidate_path_invalid');assert.equal(error.field,field);assert.ok(error.message.includes(received));
 for(const path of paths)assert.ok(error.message.includes(path),`diagnostic omits offered ${path}`);
 return true;
};
function fixture({text=BAD,requestId='candidate-address-independent',sourceId='private:current',candidate={}}={}){
 const qq=source('qq:91000000000000801','今天窗边的花盆冒了两片新叶。',{type:'qq',role:'contact'}),current=source(sourceId,HUMAN),sources=[qq,current],identity=structuredClone(scope);
 const payload={purpose:'discussion',intentAuthority:{sourceId:current.id},sources},manifest={scope:identity,requestId,sourceIds:sources.map(item=>item.id),sourceRevisions:Object.fromEntries(sources.map(item=>[item.id,item.revision]))};
 const prepared={payload,manifest,fullAvailableSources:sources,essentialSourceIds:[qq.id,current.id]},result={kind:'draft',text:'',discussionExplanation:{kind:'discussion',text:'我没有给自己的花盆换过土。'},suggestions:[{style:'自然',text}],expressionOptions:[{label:'接她分享的近况。'}],...candidate};
 const info={scope:identity,requestId,admittedContext:{payload:{outboundQuotes:[{sourceId:qq.id,text:qq.text}],currentHumanControl:{authority:'CONTROL_ONLY',sourceId:current.id,text:current.text}},manifest},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))};
 return {prepared,result,info,current,qq,context:buildFidelityContext(prepared,result,info)};
}
const unsupported=(app,path='suggestions[0].text',extra={})=>({path,code:'unsupported_fact',quote:app.result.suggestions?.[0]?.text||app.result.text,basis:'no_support_in_supplied_evidence',reason:'Scripted missing-source rejection exercises field addressing only.',...extra});
// This local constructor receives an explicitly chosen scripted fact defect;
// it is not a production compatibility path or a language classifier.
const reject=(app,issue)=>{
 const paths=app.context.payload.candidatePaths,canonical=path=>path?.startsWith('candidate.')?path.slice(10):path,at=paths.indexOf(canonical(issue.path)),index=at<0?0:at;
 const statement={quote:issue.quote,kind:'assertion',support:'unsupported',basis:issue.code==='internal_conflict'?'candidate_fact_conflict':issue.code==='evidence_mismatch'?'source_contradiction':issue.basis,...(issue.evidence?{evidence:issue.evidence}:{}),...(issue.code==='internal_conflict'?{related:{path:issue.relatedPath,quote:issue.relatedQuote}}:{})};
 const factual=factualReview(app.context,{});factual[index]={path:issue.path,statements:[statement]};
 if(issue.code==='internal_conflict'){const related=paths.indexOf(canonical(issue.relatedPath));if(related>=0&&!(related===index&&issue.relatedQuote===issue.quote))factual[related].statements.push({quote:issue.relatedQuote,kind:'assertion',support:'unverifiable'});}
 return {checkRef:'c1',factual,verdict:'reject',issues:[]};
};
const legacy=(app,issue)=>({checkRef:'c1',factual:factualReview(app.context,{}),verdict:'reject',issues:[issue]});
const allow=app=>({checkRef:'c1',factual:factualReview(app.context,{}),verdict:'allow',issues:[]});

test('one candidate prefix resolves to the same canonical unsupported-fact rejection',()=>{
 const app=fixture(),canonical=parseFidelityResult(reject(app,unsupported(app)),app.context),raw=reject(app,unsupported(app,'candidate.suggestions[0].text')),before=structuredClone(raw),qualified=parseFidelityResult(raw,app.context);
 assert.deepEqual(qualified,canonical);assert.equal(qualified.issues[0].path,'suggestions[0].text');assert.deepEqual(raw,before,'address resolution does not edit the model result');assert.equal(approvalFor(qualified,app.context),undefined);
});

test('related and concern paths canonicalize before comparing distinct candidate statements',()=>{
 const app=fixture(),text=app.result.suggestions[0].text,why=app.result.discussionExplanation.text;
 const valid={path:'candidate.suggestions[0].text',code:'internal_conflict',quote:text,relatedPath:'candidate.discussionExplanation.text',relatedQuote:why,reason:'Scripted exact distinct-field witnesses.'};
 const parsed=parseFidelityResult(reject(app,valid),app.context);assert.equal(parsed.issues[0].path,'suggestions[0].text');assert.equal(parsed.issues[0].relatedPath,'discussionExplanation.text');
 for(const [path,relatedPath]of [['suggestions[0].text','candidate.suggestions[0].text'],['candidate.suggestions[0].text','suggestions[0].text']])assert.throws(()=>parseFidelityResult(reject(app,{...valid,path,relatedPath,relatedQuote:text}),app.context),typed('factual_reference_invalid'));
 const concern={path:'candidate.suggestions[0].style',code:'style',quote:app.result.suggestions[0].style,reason:'Scripted nonblocking style concern.'},soft=parseFidelityResult({checkRef:'c1',factual:factualReview(app.context,{}),verdict:'reject',issues:[],concerns:[concern]},app.context);
 assert.equal(soft.verdict,'allow');assert.equal(soft.concerns[0].path,'suggestions[0].style');assert.ok(approvalFor(soft,app.context));
});

test('only currently offered field coordinates survive qualification',()=>{
 const app=fixture();
 for(const path of ['candidate','candidate.candidate.suggestions[0].text','candidate.evidence[0].text','evidence[0].text','candidate.draftPlan.guidance','candidate.privateExplanation','foreign.suggestions[0].text','candidate.suggestions[1].text','candidate.suggestions[-1].text','candidate.suggestions[00].text','candidate.suggestions[0].text.extra','candidate.expressionOptions[1].label','candidate.suggestions.0.text'])assert.throws(()=>parseFidelityResult(reject(app,unsupported(app,path)),app.context),pathFailure('factual[0].path',path,app.context.payload.candidatePaths),path);
 const discussion=fixture({candidate:{kind:'discussion',text:'先回应她分享的花盆近况。',suggestions:[],expressionOptions:[],discussionExplanation:undefined}});
 for(const path of ['candidate.suggestions[0].text','candidate.discussionExplanation.text','candidate.expressionOptions[0].label'])assert.throws(()=>parseFidelityResult(reject(discussion,unsupported(discussion,path,{quote:discussion.result.text})),discussion.context),pathFailure('factual[0].path',path,discussion.context.payload.candidatePaths),path);
 const conflict={...unsupported(app),code:'internal_conflict',relatedPath:'candidate.evidence[0].text',relatedQuote:app.current.text};assert.throws(()=>parseFidelityResult(reject(app,conflict),app.context),pathFailure('factual[2].statements[0].related.path',conflict.relatedPath,app.context.payload.candidatePaths));
 const concern={path:'candidate.suggestions[1].text',code:'style',reason:'Not an offered candidate.'};const allowed=parseFidelityResult({checkRef:'c1',factual:factualReview(app.context,{}),verdict:'allow',issues:[],concerns:[concern]},app.context);assert.equal(allowed.verdict,'allow');assert.equal(allowed.concerns,undefined);const diagnostic=app.context.manifest.fidelity.unusableAdvisory.at(-1);assert.equal(diagnostic.code,'fidelity_candidate_path_invalid');assert.ok(diagnostic.message.includes(concern.path));for(const path of app.context.payload.candidatePaths)assert.ok(diagnostic.message.includes(path));
});

test('field qualification does not rewrite quote text, source IDs or evidence witnesses',()=>{
 const app=fixture({text:'candidate.suggestions[0].text 是这个虚构字符串。',sourceId:'candidate.private:current'}),issue={path:'candidate.suggestions[0].text',code:'current_boundary',quote:app.result.suggestions[0].text,sourceIds:[app.current.id],evidence:[{sourceId:app.current.id,quote:app.current.text}],reason:'Scripted original witness identifiers remain exact.'},parsed=parseFidelityResult(legacy(app,issue),app.context);
 assert.equal(parsed.verdict,'allow');assert.deepEqual(parsed.concerns[0],{...issue,path:'suggestions[0].text'});
 for(const patch of [{quote:'candidate.'+issue.quote},{quote:'suggestions[0].text 是另一个字符串。'},{evidence:[{sourceId:'private:current',quote:app.current.text}]},{evidence:[{sourceId:app.current.id,quote:'candidate.'+app.current.text}]}]){
  assert.throws(()=>parseFidelityResult(reject(app,{...issue,code:'evidence_mismatch',...patch}),app.context),typed(Object.hasOwn(patch,'quote')?'factual_statement_invalid':'factual_evidence_invalid'));
 }
 assert.equal(parseFidelityResult(legacy(app,{...issue,evidence:[]}),app.context).verdict,'allow','a social concern may state uncertainty without an original fact witness');
});

test('qualified coordinates preserve private candidate, evidence and scope binding',()=>{
 const app=fixture(),parsed=parseFidelityResult(allow(app),app.context),other=fixture({requestId:'foreign-candidate-frame'});
 assert.equal(approvalFor(parsed,other.context),undefined);assert.throws(()=>parseFidelityResult(parsed,other.context),typed('fidelity_binding_invalid'));
 assert.throws(()=>parseFidelityResult(reject(app,unsupported(app,'candidate.suggestions[0].text')),{...app.context}),typed('fidelity_binding_invalid'));
 app.result.suggestions[0].text='Changed unverified candidate.';assert.throws(()=>parseFidelityResult(reject(app,unsupported(app,'candidate.suggestions[0].text')),app.context),typed('fidelity_binding_invalid'));
 const evidence=fixture();evidence.context.payload={...evidence.context.payload,evidence:evidence.context.payload.evidence.map(item=>item.sourceId===evidence.current.id?{...item,text:'Changed original body.'}:item)};assert.throws(()=>parseFidelityResult(allow(evidence),evidence.context),typed('fidelity_binding_invalid'));
 const changedScope=fixture();changedScope.info.scope.peerUid='foreign';assert.throws(()=>parseFidelityResult(allow(changedScope),changedScope.context),typed('fidelity_binding_invalid'));
 const foreign=fixture();foreign.prepared.payload.sources[0].scope={...scope,accountUid:'foreign'};assert.throws(()=>buildFidelityContext(foreign.prepared,foreign.result,foreign.info),typed('fidelity_binding_invalid'));
});

function modelPayload(request){const content=request.messages[1].content;return JSON.parse(typeof content==='string'?content:content.find(item=>item.type==='text').text);}
const fieldEnums=schema=>[schema.properties.issues.items.properties.path.enum,schema.properties.concerns.items.properties.path.enum,schema.properties.factual.items.properties.path.enum,...['related','reference'].map(field=>schema.properties.factual.items.properties.statements.items.properties[field].properties.path.enum)];
test('request-local path choices agree with the captured visible fields across tool, JSON and plain carriers',()=>{
 const app=fixture(),expected=['text','discussionExplanation.text','suggestions[0].text','suggestions[0].style','expressionOptions[0].label'],settings={model:'synthetic-candidate-address',baseUrl:'http://fixture.invalid/v1',anonymous:true,modelResponseMode:'result_tool'},first=prepareAssistantRequest(settings,app.context.payload,[]),schema=first.request.tools[0].function.parameters,before=structuredClone(schema);
 assert.deepEqual(app.context.payload.candidatePaths,expected);assert.deepEqual([...app.context.fidelityFrameSnapshot.paths],expected);assert.deepEqual(modelPayload(first.request).candidatePaths,expected);
 for(const list of fieldEnums(schema))assert.deepEqual(list,expected);
 const other=fixture({requestId:'candidate-address-second',candidate:{kind:'question',text:'你最近有哪件愿意分享的真实小事？',suggestions:[],expressionOptions:[],discussionExplanation:undefined}}),second=prepareAssistantRequest(settings,other.context.payload,[]),secondSchema=second.request.tools[0].function.parameters;
 assert.deepEqual(other.context.payload.candidatePaths,['text']);for(const list of fieldEnums(secondSchema))assert.deepEqual(list,['text']);assert.deepEqual(schema,before,'later checker requests do not edit an already prepared schema');assert.notEqual(fieldEnums(schema)[0],fieldEnums(secondSchema)[0]);
 for(const modelResponseMode of ['json_object','plain_text']){const request=prepareAssistantRequest({...settings,modelResponseMode},app.context.payload,[]).request;assert.deepEqual(modelPayload(request).candidatePaths,expected);assert.equal(request.tools,undefined);if(modelResponseMode==='json_object')assert.deepEqual(request.response_format,{type:'json_object'});}
});

test('offered path metadata is immutable and cannot be supplied by a checker as new authority',()=>{
 const app=fixture(),paths=app.context.payload.candidatePaths;assert.ok(Object.isFrozen(paths));assert.throws(()=>paths.push('evidence[0].text'),TypeError);
 assert.throws(()=>parseFidelityResult({...allow(app),candidatePaths:['evidence[0].text']},app.context),typed('fidelity_result_invalid'));
 const changed=fixture();changed.context.payload={...changed.context.payload,candidatePaths:[...changed.context.payload.candidatePaths,'evidence[0].text']};assert.throws(()=>parseFidelityResult(reject(changed,unsupported(changed,'candidate.evidence[0].text')),changed.context),typed('fidelity_binding_invalid'));
});

const GOOD='这两片新叶看着挺精神。',QUESTION='你最近有哪件愿意告诉她的真实小事？';
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function candidate(p,text){
 return {operation:'prepare_message',answer:{privateExplanation:'接住她刚说的具体变化。',suggestions:[{style:'自然',text}]}};
}
function toolResponse(value,name){return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{tool_calls:[{id:'fictional-candidate-address',type:'function',function:{name,arguments:JSON.stringify(value)}}]}}]}),{status:200});}
async function application(t,producer){
 t.mock.method(globalThis,'fetch',async()=>{throw Error('This fictional test permits no external model call');});
 const store=new Store(':memory:'),calls=[],model='synthetic-candidate-address',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestBytes:64000,assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(settings,context,signal)=>assistModel(settings,context,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=modelPayload(request),p=wrapper.originalInput||wrapper,entry={request,wrapper,p,context,taskId:settings.requestBudget.task.id};calls.push(entry);
   return toolResponse(await producer(p,wrapper,calls.length-1),request.tool_choice.function.name);
  })});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('91000000000000811',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'今天窗边的花盆冒了两片新叶。'}}]})]});
 return {store,controller,calls,assist:()=>controller.assist({text:'想接她这条，也想分享一点自己的真实近况。',taskId:'candidate-address-independent-lifecycle'}),run:()=>store.getCompanion(scope).runs.at(-1)};
}

test('a qualified factual reject reaches full regeneration and recheck inside the existing four-request budget',async t=>{
 for(const repairKind of ['grounded_candidate','private_question'])await t.test(repairKind,async t=>{
  let checks=0;const app=await application(t,(p,wrapper)=>{
   if(p.purpose==='fidelity_check'){
    checks++;if(checks===1){const issue={path:'candidate.suggestions[0].text',code:'unsupported_fact',quote:p.candidate.suggestions[0].text,basis:'no_support_in_supplied_evidence',reason:'Scripted qualified factual rejection reaches the existing shared repair.'};const factual=factualReview(p,{'suggestions[0].text':[{quote:issue.quote,kind:'assertion',support:'unsupported',basis:issue.basis}]});factual.find(field=>field.path==='suggestions[0].text').path=issue.path;return {checkRef:p.checkRef,verdict:'reject',issues:[issue],factual};}
    const path=p.candidate.suggestions.length?'suggestions[0].text':'text',quote=p.candidate.suggestions.length?p.candidate.suggestions[0].text:p.candidate.text;
    return {checkRef:p.checkRef,verdict:'allow',issues:[],factual:factualReview(p,{[path]:[{quote,kind:p.candidate.suggestions.length?'opinion':'question'}]})};
   }
   if(wrapper.originalInput&&repairKind==='private_question')return {operation:'clarify',blocker:{kind:'missing_fact',missing:'用户愿意分享的真实近况',question:QUESTION}};
   return candidate(p,wrapper.originalInput?GOOD:BAD);
  }),reply=await app.assist(),ledger=app.controller.usage.get(scope,'candidate-address-independent-lifecycle');
  assert.equal(app.calls.length,4);assert.equal(checks,2);assert.equal(ledger.requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.deepEqual(app.calls.map(call=>call.p.purpose),['discussion','fidelity_check','discussion','fidelity_check']);assert.equal(new Set(app.calls.map(call=>call.taskId)).size,1);
  assert.equal(app.calls[1].context.manifest.fidelity.addressNormalizations[0].canonical,'suggestions[0].text');assert.equal(app.calls[1].context.manifest.fidelityOutput.raw.includes('candidate.suggestions[0].text'),true,'raw checker evidence retains its original model address');
  if(repairKind==='private_question'){assert.equal(reply.kind,'question');assert.equal(reply.text,QUESTION);assert.deepEqual(app.calls[3].p.candidatePaths,['text']);assert.equal(reply.suggestions,undefined);}else{assert.equal(reply.suggestions[0].text,GOOD);assert.equal(app.calls[3].p.candidate.suggestions[0].text,GOOD);}
  assert.equal(JSON.stringify(reply).includes(BAD),false);assert.equal(app.run().status,'complete');assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
 });
});
