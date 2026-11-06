'use strict';
// Fictional scripted result-tool transport exercises the actual audit consumer.
// Retained B002 candidates/evidence/auditor outputs provide regression triggers;
// these scripts are not semantic ratings or evidence of model accuracy.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {PROMPT_VERSION}=require('../src/assistant-context.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const frozen=require('./fixtures/terminal-source-facts-b002.json');
const retained=frozen.retained.audits[0],excluded=frozen.excluded.audits[0],regenerated=frozen.excluded.audits[1];
const NOTE=retained.evidence.find(s=>s.type==='note').text;
const GOOD='里面开线我不太确定能不能弄好，可以先问问修包师傅能不能补结实。';
const audit=(p,issues=[],extra={})=>({checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues,...extra});
const issue=(quote,path='suggestions[0].text',{kind='assertion',code='unsupported_fact',claimQuote=quote,...rest}={})=>({path,code,quote,claim:{kind,quote:claimQuote},...rest});
const draft=(text,{style='自然',why,...metadata}={})=>({operation:'prepare_message',answer:{suggestions:[{text,style}],...(why?{privateExplanation:why}:{})},...metadata});
const candidateDraft=candidate=>({operation:'prepare_message',answer:{suggestions:candidate.suggestions, ...(candidate.discussionExplanation?{privateExplanation:candidate.discussionExplanation.text}:{})}});
function response(value,name){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'source-fact-fixture',type:'function',function:{name,arguments:JSON.stringify(value)}}]}}]}),{status:200});}
async function application(t,producer,{limit=4,noteText,noteUse='draft',selectNote=false}={}){
 t.mock.method(globalThis,'fetch',async()=>{throw Error('No unmocked HTTP in fictional functional checks');});
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-terminal-source-facts',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:limit,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async()=>{throw Error('No QQ operations');},
  assistantModel:(settings,input,signal)=>{contexts.push(input);return assistModel(settings,input,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,p,wrapper});return response(await producer(p,wrapper,calls.length-1),request.tool_choice.function.name);
  });}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
 controller.ingest(scope,retained.evidence.filter(s=>s.type==='qq').map(s=>raw(s.sourceId.slice(3),false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:s.text}}]})));
 const note=noteText?store.saveNote(scope,{text:noteText,use:noteUse}):null;
 return {store,controller,calls,contexts,note,run:()=>store.getCompanion(scope).runs.at(-1),assist:(text='她问到这个了，怎么回？',taskId='source-fact-check')=>controller.assist({text,taskId,...(selectNote&&note?{materialIds:[note.id]}:{})})};
}
function unpublished(app){assert.equal(app.store.getCompanion(scope).turns.some(t=>t.role==='assistant'),false);assert.equal(app.controller.advice,null);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);}

test('actual retained B002 permission denial is program-disproved and does not make the audit incomplete',async t=>{
 const app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return candidateDraft(retained.candidate);
  const original=p.evidence.find(s=>s.text===NOTE);assert.ok(original);assert.ok(p.disclosureAuthority.programSources.some(s=>s.sourceId===original.sourceId));assert.deepEqual(p.admittedFragments,[]);
  const findings=retained.reported.issues.map(rawIssue=>issue(rawIssue.quote,rawIssue.path,{code:'private_disclosure',privacyBasis:'absence_of_grant',evidence:rawIssue.evidence.map(ref=>({sourceId:original.sourceId,quote:ref.quote})),reason:rawIssue.reason}));
  return audit(p,findings);
 },{noteText:NOTE}),reply=await app.assist();
 assert.equal(reply.text,retained.candidate.text);assert.equal(app.calls.length,2);const check=app.run().requests.find(r=>r.purpose==='fidelity_check').manifest.fidelity;assert.equal(check.reviewStatus,'reviewed');assert.deepEqual(check.issues,[]);assert.ok(check.diagnostics.some(d=>d.code==='program_disclosure_authority'&&d.blocking===false));assert.equal(reply.semanticReview.exhaustive,false);assert.equal(app.run().manifest.publicationSeal.semanticCheck,false);
});

test('a current narrow admitted fragment is a second valid permission path without a whole-source grant',async t=>{
 const fact='我以前补过帆布包',app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return draft(fact+'。',{currentFacts:[fact]});
  const source=p.evidence.find(s=>s.type==='private'&&s.text.includes(fact));assert.ok(source);assert.equal(p.disclosureAuthority.programSources.some(s=>s.sourceId===source.sourceId),false);assert.ok(p.admittedFragments.some(f=>f.sourceId===source.sourceId&&f.text===fact));
  return audit(p,[issue(fact,'suggestions[0].text',{code:'private_disclosure',privacyBasis:'absence_of_grant',evidence:[{sourceId:source.sourceId,quote:fact}]})]);
 }),reply=await app.assist(fact+'。这次愿意把这个事实告诉她，给我表达。');
 assert.equal(reply.text,fact+'。');assert.equal(app.calls.length,2);assert.equal(reply.semanticReview.exhaustive,false);
});

test('an explicit restriction remains effective when its witness source itself has a program grant',async t=>{
 const fact='我以前补过帆布包',restriction='这段经历暂时不能告诉她。',app=await application(t,(p,w)=>{
  if(p.purpose!=='fidelity_check')return draft(w.originalInput?GOOD:fact+'。');
  const source=p.evidence.find(s=>s.text.includes(restriction));assert.ok(source);assert.ok(p.disclosureAuthority.programSources.some(s=>s.sourceId===source.sourceId));
  return audit(p,p.candidate.text.includes(fact)?[issue(fact,'suggestions[0].text',{code:'private_disclosure',privacyBasis:'explicit_restriction',evidence:[{sourceId:source.sourceId,quote:restriction}]})]:[]);
 },{noteText:fact+'。'+restriction}),reply=await app.assist();
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);assert.equal(app.run().requests[1].manifest.fidelity.issues[0].privacyBasis,'explicit_restriction');
});

test('discussion-only truth evidence still cannot grant outward sharing',async t=>{
 const fact='我以前补过帆布包',app=await application(t,(p,w)=>{
  if(p.purpose!=='fidelity_check')return draft(w.originalInput?GOOD:fact+'。');
  const source=p.evidence.find(s=>s.text.includes(fact));assert.ok(source);assert.equal(p.disclosureAuthority.programSources.some(s=>s.sourceId===source.sourceId),false);
  return audit(p,p.candidate.text.includes(fact)?[issue(fact,'suggestions[0].text',{code:'private_disclosure',privacyBasis:'absence_of_grant',evidence:[{sourceId:source.sourceId,quote:fact}]})]:[]);
 },{noteText:fact+'。仅供私下理解。',noteUse:'discussion'}),reply=await app.assist();
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);
});

test('a narrow fragment grant does not authorize a second private fact in the same human source',async t=>{
 const fact='我以前补过帆布包',privateFact='我最近有些焦虑',app=await application(t,(p,w)=>{
  if(p.purpose!=='fidelity_check')return draft(w.originalInput?fact+'。':fact+'，'+privateFact+'。',{currentFacts:[fact]});
  const source=p.evidence.find(s=>s.type==='private'&&s.text.includes(privateFact));assert.ok(source);assert.ok(p.admittedFragments.some(f=>f.sourceId===source.sourceId&&f.text===fact));
  return audit(p,p.candidate.text.includes(privateFact)?[issue(privateFact,'suggestions[0].text',{code:'private_disclosure',privacyBasis:'absence_of_grant',evidence:[{sourceId:source.sourceId,quote:privateFact}]})]:[]);
 }),reply=await app.assist(fact+'。这句愿意告诉她；'+privateFact+'，这点只私下讨论。');assert.equal(reply.text,fact+'。');assert.equal(app.calls.length,4);
});

test('a later human restriction takes precedence over an authored-note program grant',async t=>{
 const fact='我以前补过帆布包',restriction='这次先别告诉她我的修包经历',app=await application(t,(p,w)=>{
  if(p.purpose!=='fidelity_check')return draft(w.originalInput?GOOD:fact+'。');
  const source=p.evidence.find(s=>s.type==='private'&&s.text.includes(restriction));assert.ok(source);assert.ok(p.disclosureAuthority.programSources.some(s=>p.evidence.find(e=>e.sourceId===s.sourceId)?.text===fact+'。'));
  return audit(p,p.candidate.text.includes(fact)?[issue(fact,'suggestions[0].text',{code:'private_disclosure',privacyBasis:'explicit_restriction',evidence:[{sourceId:source.sourceId,quote:restriction}]})]:[]);
 },{noteText:fact+'。'}),reply=await app.assist(restriction+'，就顺着她现在说的包怎么补来回应。');assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);
});

test('complete empty audit with malformed optional notes remains nonexhaustive and publishable',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?audit(p,[],{concerns:{malformed:'optional'}}):{operation:'advise',text:GOOD}),reply=await app.assist();assert.equal(reply.text,GOOD);assert.equal(app.calls.length,2);const checked=app.run().requests[1].manifest.fidelity;assert.equal(checked.reviewStatus,'reviewed');assert.ok(checked.diagnostics.every(d=>d.blocking===false));assert.equal(reply.semanticReview.exhaustive,false);
});

for(const fault of ['wrong checkRef','unknown source','missing witness','invalid path','missing claim','missing privacy basis'])test(`audit core ${fault} remains blocking rather than becoming an empty pass`,async t=>{
 const quote='我以前补过帆布包',app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return draft(quote+'。');
  if(fault==='wrong checkRef')return audit(p,[],{checkRef:'another-candidate'});
  if(fault==='unknown source')return audit(p,[issue(quote,'suggestions[0].text',{code:'evidence_mismatch',evidence:[{sourceId:'s999',quote:'unoffered original'}]})]);
  if(fault==='missing witness')return audit(p,[issue(quote,'suggestions[0].text',{code:'private_disclosure',privacyBasis:'explicit_restriction'})]);
  if(fault==='invalid path')return audit(p,[issue(quote,'suggestions[999].text')]);
  if(fault==='missing privacy basis'){const source=p.evidence.find(s=>s.type==='qq');return audit(p,[issue(quote,'suggestions[0].text',{code:'private_disclosure',evidence:[{sourceId:source.sourceId,quote:source.text}]})]);}
  return audit(p,[{path:'suggestions[0].text',code:'unsupported_fact',quote}]);
 });await assert.rejects(app.assist(),e=>e.code==='terminal_fact_audit_incomplete');unpublished(app);assert.equal(app.calls.length,2);assert.ok(app.run().requests[1].manifest.fidelity.diagnostics.some(d=>d.blocking===true));
});

test('a valid concrete issue still drives repair beside malformed optional notes and reason',async t=>{
 const quote='我以前补过帆布包',app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidate.text.includes(quote)?[issue(quote,'suggestions[0].text',{reason:{malformed:true}})]:[],p.candidate.text.includes(quote)?{concerns:{malformed:true}}:{}):draft(w.originalInput?GOOD:quote+'。')),reply=await app.assist();
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);const first=app.run().requests[1].manifest.fidelity;assert.equal(first.issues.length,1);assert.equal(first.reviewStatus,'reviewed');assert.ok(first.diagnostics.every(d=>d.blocking===false));
});

test('a valid concrete finding is processed before a sibling core coordinate error',async t=>{
 const quote='我以前没补过帆布包',app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidate.text.includes(quote)?[issue(quote),issue(quote,'suggestions[999].text')]:[]):draft(w.originalInput?GOOD:quote)),reply=await app.assist();assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);const first=app.run().requests[1].manifest.fidelity;assert.equal(first.reviewStatus,'incomplete');assert.equal(first.issues.length,1);assert.ok(first.diagnostics.some(d=>d.blocking===true));assert.equal(app.run().requests[3].manifest.fidelity.reviewStatus,'reviewed');
});

test('program-disproved privacy does not erase an independently witnessed source contradiction',async t=>{
 const profession='我是专业裁缝',supported=retained.candidate.suggestions[0].text,app=await application(t,(p,w)=>{
  if(p.purpose!=='fidelity_check')return draft(w.originalInput?supported:supported+profession+'。');
  const source=p.evidence.find(s=>s.text===NOTE);assert.ok(source);const truth=retained.reported.issues[0].quote,findings=[issue(truth,'suggestions[0].text',{code:'private_disclosure',privacyBasis:'absence_of_grant',evidence:[{sourceId:source.sourceId,quote:retained.reported.issues[0].evidence[0].quote}]})];
  if(p.candidate.text.includes(profession))findings.push(issue(profession,'suggestions[0].text',{code:'evidence_mismatch',evidence:[{sourceId:source.sourceId,quote:NOTE}]}));return audit(p,findings);
 },{noteText:NOTE}),reply=await app.assist();assert.equal(reply.text,supported);assert.equal(app.calls.length,4);assert.equal(app.run().requests[1].manifest.fidelity.issues[0].code,'evidence_mismatch');assert.equal(app.run().requests[3].manifest.fidelity.issues.length,0);
});

test('actual B002 tentative repairer advice is outside the hard factual-defect responsibility',async t=>{
 const quote=excluded.reported.issues[1].quote,app=await application(t,p=>p.purpose==='fidelity_check'?audit(p,[issue(quote,'suggestions[0].text',{kind:'advice',reason:excluded.reported.issues[1].reason})]):draft(quote+'。')),reply=await app.assist();
 assert.equal(reply.text,quote+'。');assert.equal(app.calls.length,2);assert.equal(app.run().requests[1].manifest.fidelity.issues.length,0);assert.equal(app.run().requests[1].manifest.fidelity.concerns.length,1);
});

test('actual B002 repeated open question is advisory rather than an omitted world-fact qualifier',async t=>{
 const captured=regenerated.reported.issues[1],app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return draft(captured.quote);
  const source=p.evidence.find(s=>s.text===captured.evidence[0].quote);assert.ok(source);return audit(p,[issue(captured.quote,'suggestions[0].text',{kind:'open_question',code:'omitted_qualifier',evidence:[{sourceId:source.sourceId,quote:source.text}],reason:captured.reason})]);
 }),reply=await app.assist();assert.equal(reply.text,captured.quote);assert.equal(app.calls.length,2);assert.equal(app.run().requests[1].manifest.fidelity.issues.length,0);
});

for(const [name,quote,kind]of [['certain repair','这种开线一定能修好','assertion'],['invented premise','你上次补过的帆布包后来还结实吗？','presupposition'],['unknown positive','我以前补过帆布包','assertion'],['unknown negative','我以前没补过帆布包','assertion'],['unknown memory state','我这会儿想不起来具体补过哪种','assertion']])test(`${name} still requires grounded factual support`,async t=>{
 const app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidate.text.includes(quote)?[issue(quote,'suggestions[0].text',{kind})]:[]):draft(w.originalInput?GOOD:quote)),reply=await app.assist();assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);assert.equal(app.run().requests[1].manifest.fidelity.issues[0].claim.kind,kind);
});

for(const fact of ['我以前补过帆布包','我以前没补过帆布包'])test(`supported authored history remains usable: ${fact}`,async t=>{
 const app=await application(t,p=>{if(p.purpose==='fidelity_check'){assert.ok(p.evidence.some(s=>s.text===fact+'。'));return audit(p);}return draft(fact+'。');},{noteText:fact+'。'}),reply=await app.assist();assert.equal(reply.text,fact+'。');assert.equal(app.calls.length,2);
});

test('full regeneration can legally terminate with a missing-fact clarify and fresh audit',async t=>{
 const quote='我以前没补过帆布包',question='你以前实际补过哪种包？如果没有也可以直接说。',app=await application(t,(p,w)=>{
  if(p.purpose==='fidelity_check')return audit(p,p.candidate.text.includes(quote)?[issue(quote)]:[]);
  if(w.originalInput){assert.match(w.task,/clarify/);assert.match(w.task,/lookup/);assert.doesNotMatch(w.task,/不得新增操作或lookup/);return {operation:'clarify',blocker:{kind:'missing_fact',missing:'你真实的修包经历',question}};}
  return draft(quote+'。');
 }),reply=await app.assist();assert.equal(reply.kind,'question');assert.equal(reply.text,question);assert.equal(reply.suggestions,undefined);assert.equal(reply.replyDisposition,'clarify');assert.equal(app.calls.length,4);assert.equal(app.run().manifest.requestDelivery.status,'blocked');assert.equal(app.calls[3].p.candidate.suggestions.length,0);
});

test('actual serialized audit and repair contracts consume the new bound prompt/version and small claim protocol',async t=>{
 const quote='我以前补过帆布包',app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidate.text.includes(quote)?[issue(quote)]:[]):draft(w.originalInput?GOOD:quote)),reply=await app.assist();
 assert.match(PROMPT_VERSION,/2026-11-05/);assert.equal(app.calls[0].p.promptVersion,PROMPT_VERSION);const checker=app.calls[1],schema=checker.request.tools[0].function.parameters.properties.issues.items;assert.equal(checker.p.promptVersion,PROMPT_VERSION);assert.equal(checker.p.version,'whole-answer-fidelity-v11');
 assert.ok(schema.required.includes('claim'));assert.deepEqual(schema.properties.privacyBasis.enum,['absence_of_grant','explicit_restriction']);assert.match(checker.request.messages[0].content,/programSources.*或|程序.*或/);assert.match(checker.request.messages[0].content,/absence_of_grant/);assert.match(checker.request.messages[0].content,/explicit_restriction/);assert.match(checker.request.messages[0].content,/open_question/);assert.match(app.calls[2].wrapper.task,/clarify/);assert.equal(reply.text,GOOD);
});

const PRIVATE_PHRASE='我最近因为家里的事准备搬走';
const RESTRICTION='这段细节暂时只供私下讨论，不能告诉她。';
const privateBody=kind=>({open_question:'你愿意听我聊聊“'+PRIVATE_PHRASE+'”这件事吗？',opinion:'我觉得“'+PRIVATE_PHRASE+'”这个决定很重要。',intent:'我想和你聊聊“'+PRIVATE_PHRASE+'”。'})[kind];
for(const noteUse of ['discussion','draft'])for(const kind of ['open_question','opinion','intent'])test(`${kind} cannot erase an exact copyable restriction from a ${noteUse==='draft'?'program-authorized':'discussion-only'} witness source`,async t=>{
 const original=PRIVATE_PHRASE+'。'+RESTRICTION,app=await application(t,(p,w)=>{
  if(p.purpose!=='fidelity_check')return draft(w.originalInput?GOOD:privateBody(kind));
  const source=p.evidence.find(s=>s.text===original);assert.ok(source);assert.equal(p.disclosureAuthority.programSources.some(s=>s.sourceId===source.sourceId),noteUse==='draft');
  return audit(p,p.candidate.text.includes(PRIVATE_PHRASE)?[issue(PRIVATE_PHRASE,'suggestions[0].text',{kind,code:'private_disclosure',privacyBasis:'explicit_restriction',evidence:[{sourceId:source.sourceId,quote:original}]})]:[]);
 },{noteText:original,noteUse,selectNote:noteUse==='draft'}),reply=await app.assist('先核对“'+PRIVATE_PHRASE+'”这段细节的表达。');assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);assert.equal(app.run().requests[1].manifest.fidelity.issues[0].claim.kind,kind);assert.equal(app.run().requests[1].manifest.fidelity.issues[0].privacyBasis,'explicit_restriction');
});
for(const kind of ['open_question','opinion','intent'])test(`a ${kind} can use a real current program grant without a fictitious second permission requirement`,async t=>{
 const original=PRIVATE_PHRASE+'。这一点愿意告诉她。',text=privateBody(kind),app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return draft(text);
  const source=p.evidence.find(s=>s.text===original);assert.ok(source);return audit(p,[issue(PRIVATE_PHRASE,'suggestions[0].text',{kind,code:'private_disclosure',privacyBasis:'absence_of_grant',evidence:[{sourceId:source.sourceId,quote:PRIVATE_PHRASE}]})]);
 },{noteText:original,selectNote:true}),reply=await app.assist();assert.equal(reply.text,text);assert.equal(app.calls.length,2);assert.equal(app.run().requests[1].manifest.fidelity.issues.length,0);
});
test('nonassertion disclosure checks retain private-analysis and unrestricted-advice boundaries',async t=>{
 const original=PRIVATE_PHRASE+'。'+RESTRICTION,text='私下先考虑“'+PRIVATE_PHRASE+'”是否影响你现在的打算。',app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return {operation:'advise',text};const source=p.evidence.find(s=>s.text===original);assert.ok(source);return audit(p,[issue(PRIVATE_PHRASE,'text',{kind:'open_question',code:'private_disclosure',privacyBasis:'explicit_restriction',evidence:[{sourceId:source.sourceId,quote:original}]})]);
 },{noteText:original,noteUse:'discussion'}),reply=await app.assist('先私下讨论“'+PRIVATE_PHRASE+'”这段情况。');assert.equal(reply.text,text);assert.equal(reply.suggestions,undefined);assert.equal(app.calls.length,2);assert.equal(app.run().requests[1].manifest.fidelity.issues.length,0);
});
