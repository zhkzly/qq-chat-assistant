'use strict';
// These scripted transport checks prove publication/lifecycle mechanics only.
// The retained selected-model response supplies the concrete regression trigger;
// scripted audit findings are not conversational-quality ratings.
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {assistDiscussionCompaction}=require('../src/discussion-compaction.cjs');
const {recordPendingClarifications,supersedePendingClarifications}=require('../src/response-projection.cjs');
const {canonicalScopeKey}=require('../src/feedback/presentation-ledger.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const frozen=require('./fixtures/material-negative-history-baseline.json');
const BAD=frozen.output.suggestions[0].text,CLAIM='我以前没补过帆布包';
const GOOD='里面开线我不太确定能不能弄好，可以先拿去修包的地方问问，看看能不能补结实。';
const audit=(p,issues=[],extra={})=>({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues,...extra});
const defect=(quote=CLAIM,path='suggestions[0].text',extra={})=>({path,code:'unsupported_fact',quote,claim:{kind:'assertion',quote},...extra});
const draft=(text=BAD,{style='自然',why,...metadata}={})=>({operation:'prepare_message',answer:{suggestions:[{text,style}],...(why?{privateExplanation:why}:{})},...metadata});
const body=source=>source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function materialDraft(p,text=BAD){const source=p.sources.find(s=>s.type==='note');assert.ok(source);return draft(text,{materials:[{materialRef:whole(source),authorityRef:source.authorityChoices.program[0].authorityRef}]});}
function response(value,name){return new Response(JSON.stringify({choices:[{message:name?{tool_calls:[{id:'terminal-fact-fixture',type:'function',function:{name,arguments:JSON.stringify(value)}}]}:{content:JSON.stringify(value)}}]}),{status:200});}
async function application(t,producer,{limit=4,noteText,noteUse='draft',selectNote=true,compaction=false}={}){
 t.mock.method(globalThis,'fetch',async()=>{throw Error('No unmocked network calls in this fictional functional test');});
 const store=new Store(':memory:'),calls=[],inputs=[],model='synthetic-terminal-fact-coverage',baseUrl='http://fixture.invalid/v1';
 const transport=settings=>async(_url,args)=>{
   const request=JSON.parse(args.body),content=request.messages[1].content,wrapper=JSON.parse(typeof content==='string'?content:content.find(item=>item.type==='text').text),p=wrapper.originalInput||wrapper,entry={p,wrapper,request,stage:settings.requestBudget.purpose};calls.push(entry);
   return response(await producer(p,wrapper,calls.length-1,entry),request.tool_choice?.function.name);
 };
 const controller=new Controller({store,compactionModel:compaction?(settings,plan,signal)=>assistDiscussionCompaction(settings,plan,signal,transport(settings)):null,now:()=>Date.parse('2026-10-29T10:25:00.000Z'),settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:limit,discussionCompactionEnabled:compaction,realChatConsent:{...scope,model,baseUrl}},read:async()=>{throw Error('No QQ operation in this check');},
  assistantModel:(settings,input,signal)=>{inputs.push(input);return assistModel(settings,input,signal,transport(settings));}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
 const qq=frozen.available_sources.filter(s=>s.type==='qq').map(source=>raw(source.messageId,false,{msgTime:String(Math.floor(Date.parse(source.at)/1000)),elements:[{textElement:{content:source.text}}]}));controller.ingest(scope,qq);
 const note=noteText?store.saveNote(scope,{text:noteText,use:noteUse}):null;
 return {store,controller,calls,inputs,note,run:()=>store.getCompanion(scope).runs.at(-1),assist:(text=frozen.request.text,taskId='terminal-fact-coverage')=>controller.assist({text,taskId,...(note&&selectNote?{materialIds:[note.id]}:{})})};
}
function noPublished(app){assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.controller.advice,null);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);}

test('actual unsupported negative history is fully regenerated and freshly audited within default4',async t=>{
 const app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidate.text.includes(CLAIM)?[defect()]:[]):draft(w.originalInput?GOOD:BAD,{style:w.originalInput?'自然':frozen.output.suggestions[0].label})),reply=await app.assist();
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(app.calls.length,4);assert.deepEqual(app.calls.map(c=>c.stage),['discussion','fidelity_check','delivery_repair','fidelity_check']);
 assert.equal(app.calls[2].wrapper.rejectedCandidate.text,BAD);assert.equal(app.calls[3].p.candidate.text,GOOD);assert.equal(app.calls[3].p.evidence.some(s=>s.text===BAD),false);
 const run=app.run();assert.equal(run.manifest.publicationSeal.semanticCheck,false);assert.equal(reply.semanticReview.status,'reviewed');assert.equal(reply.semanticReview.exhaustive,false);assert.notEqual(run.requests[1].manifest.fidelity.candidateHash,run.requests[3].manifest.fidelity.candidateHash);
 assert.equal(app.controller.usage.get(scope,reply.requestId).attempts,4);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,1);
});

test('a label caveat does not fix the retained unsupported body after the only regeneration',async t=>{
 const app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,[defect()]):draft(BAD,{style:w.originalInput?'按实际经历调整':'自然'}));
 await assert.rejects(app.assist(),error=>error.code==='terminal_fact_defect_unresolved');noPublished(app);assert.equal(app.calls.length,4);assert.equal(app.run().status,'failed');assert.ok(app.run().requests.filter(r=>r.purpose==='fidelity_check').every(r=>r.payload.candidate.text===BAD));
});

test('a complete no-defect sparse audit permits ordinary advice as nonexhaustive',async t=>{
 const text='先顺着她舍不得换包的心情接一句，再问修包店能不能补结实。',app=await application(t,p=>p.purpose==='fidelity_check'?audit(p):{operation:'advise',text}),reply=await app.assist();
 assert.equal(reply.text,text);assert.equal(app.calls.length,2);assert.equal(reply.semanticReview.exhaustive,false);assert.equal(app.run().manifest.publicationSeal.semanticCheck,false);assert.equal(app.run().manifest.terminalFactCoverage.status,'no_concrete_defect_reported');
});

test('valid defect is processed before malformed optional audit metadata',async t=>{
 const app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidate.text.includes(CLAIM)?[defect(CLAIM,'suggestions[0].text',{reason:{malformed:true}})]:[],p.candidate.text.includes(CLAIM)?{concerns:{malformed:true}}:{}):draft(w.originalInput?GOOD:BAD)),reply=await app.assist();
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);const first=app.run().requests.find(r=>r.purpose==='fidelity_check').manifest.fidelity;assert.equal(first.reviewStatus,'reviewed');assert.equal(first.issues.length,1);assert.equal(first.derivedVerdict,'reject');assert.ok(first.diagnostics.every(d=>d.blocking===false));
});

for(const mode of ['unavailable','incomplete'])test(`required ${mode} audit keeps the request but publishes no candidate`,async t=>{
 const app=await application(t,p=>{if(p.purpose!=='fidelity_check')return draft();if(mode==='unavailable')throw Error('fictional audit transport unavailable');return {checkRef:p.checkRef,issues:[]};});
 await assert.rejects(app.assist(),error=>error.code==='terminal_fact_audit_incomplete');noPublished(app);assert.equal(app.calls.length,2);assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='user').at(-1).text,frozen.request.text);assert.equal(app.run().status,'failed');
});

test('one remaining request is reserved rather than regenerating without a fresh audit',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?audit(p,[defect()]):draft(),{limit:3});
 await assert.rejects(app.assist(),error=>error.code==='terminal_fact_repair_budget');noPublished(app);assert.equal(app.calls.length,2);assert.equal(app.controller.usage.get(scope,'terminal-fact-coverage').remaining,1);
});

test('unsupported positive personal history takes the same whole-candidate repair path',async t=>{
 const positive='我以前补过帆布包，这种开线可以处理。',quote='我以前补过帆布包',app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidate.text.includes(quote)?[defect(quote)]:[]):draft(w.originalInput?GOOD:positive)),reply=await app.assist();
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);assert.equal(app.store.memorySources(scope).some(s=>s.text===positive),false);
});

test('supported negative history remains available with exact authored material and no forced clarification',async t=>{
 const original='我以前没补过帆布包。这段经历可以告诉她。',app=await application(t,p=>{if(p.purpose==='fidelity_check'){assert.ok(p.evidence.some(s=>s.text===original));assert.ok(p.admittedFragments.some(s=>s.text===original));return audit(p);}return materialDraft(p);},{noteText:original}),reply=await app.assist();
 assert.equal(reply.text,BAD);assert.equal(reply.kind,'draft');assert.equal(app.calls.length,2);assert.equal(app.run().payload.outboundQuotes[0].text,original);assert.equal(reply.semanticReview.exhaustive,false);
});

for(const [name,text,privateHelp]of [
 ['stance','我觉得这包还挺耐看的，能补好的话继续用也不错。',false],
 ['uncertainty','我不确定里面开线能不能补结实，可以先问问修包师傅。',false],
 ['private conditional','如果你确实补过包，可以私下核对当时的做法；这里只是条件示例。',true]
])test(`a legitimate ${name} is not rejected by a blanket autobiographic material requirement`,async t=>{
 const app=await application(t,p=>{if(p.purpose==='fidelity_check'){if(privateHelp)assert.equal(p.candidateScopes.find(s=>s.path==='text').scope,'private');return audit(p);}return privateHelp?{operation:'advise',text}:draft(text);}),reply=await app.assist();
 assert.equal(reply.text,text);assert.equal(app.calls.length,2);assert.equal(reply.kind,privateHelp?'discussion':'draft');
});

test('a private note is truth evidence without acquiring outward permission from the auditor',async t=>{
 const privateText='我以前补过帆布包，但这个经历只供私下理解，不能告诉她。',quote='我以前补过帆布包',app=await application(t,(p,w)=>{
  if(p.purpose==='fidelity_check'){
   const source=p.evidence.find(s=>s.text===privateText);assert.ok(source);assert.equal(p.admittedFragments.some(s=>s.text.includes(privateText)),false);
   return audit(p,p.candidate.text.includes(quote)?[{path:'suggestions[0].text',code:'private_disclosure',quote,claim:{kind:'assertion',quote},privacyBasis:'explicit_restriction',evidence:[{sourceId:source.sourceId,quote:privateText}]}]:[]);
  }
  return draft(w.originalInput?GOOD:quote+'，这种开线应该能补。');
 },{noteText:privateText,noteUse:'discussion',selectNote:false}),reply=await app.assist('帮我回应修帆布包的问题，私下经历不能外说。');
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);assert.deepEqual(app.run().payload.outboundQuotes,[]);assert.equal(app.run().requests[1].manifest.fidelity.issues[0].code,'private_disclosure');
});

test('excluded authored material is absent from primary, auditor and repair evidence',async t=>{
 const excluded='我以前补过帆布包，把里面开线缝好了。',app=await application(t,(p,w)=>{
  if(p.purpose==='fidelity_check'){assert.equal(p.evidence.some(s=>s.text===excluded),false);return audit(p,p.candidate.text.includes(CLAIM)?[defect()]:[]);}
  assert.equal(p.sources.some(s=>s.type==='note'&&body(s)===excluded),false);return draft(w.originalInput?GOOD:BAD);
 },{noteText:excluded,noteUse:'disabled',selectNote:false}),reply=await app.assist();
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);assert.equal(app.run().requests.some(r=>(r.payload.evidence||[]).some(s=>s.text===excluded)),false);
});

test('audit covers main body, explanations, suggestion bodies/styles and direction labels',async t=>{
 const label='我以前补过帆布包',why='我以前没补过帆布包，所以这样说。',app=await application(t,(p,w)=>{
  if(p.purpose==='fidelity_check'){
   if(p.candidate.expressionOptions.length){assert.deepEqual(p.candidatePaths,['text','expressionOptions[0].label']);return audit(p,[defect(label,'expressionOptions[0].label')]);}
   assert.deepEqual(p.candidatePaths,['text','discussionExplanation.text','suggestions[0].text','suggestions[0].style']);assert.equal(p.candidate.discussionExplanation.text,'只回应已知问题。');return audit(p);
  }
  return w.originalInput?draft(GOOD,{why:'只回应已知问题。'}):{operation:'advise',text:'可以围绕她提到的开线问题继续聊。',expressionOptions:[{label}]};
 }),reply=await app.assist();
 assert.equal(reply.text,GOOD);assert.equal(app.calls.length,4);assert.equal(reply.discussionExplanation.text,'只回应已知问题。');assert.deepEqual(reply.expressionOptions,[]);
});

for(const target of ['discussionExplanation.text','suggestions[0].style'])test(`facts in ${target} cannot evade the complete visible candidate audit`,async t=>{
 const label='我以前补过帆布包',app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,p.candidatePaths.includes(target)&&(target.endsWith('.style')?p.candidate.suggestions[0].style:p.candidate.discussionExplanation?.text)?.includes(label)?[defect(label,target)]:[]):draft(GOOD,w.originalInput?{why:'只回应已知问题。'}:{style:target.endsWith('.style')?label:'自然',why:target.startsWith('discussion')?label:'只回应已知问题。'})),reply=await app.assist();
 assert.equal(app.calls.length,4);assert.equal(reply.suggestions[0].style,'自然');assert.equal(reply.discussionExplanation.text,'只回应已知问题。');
});

test('required audit cannot silently publish a one-call-budget candidate',async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check','transport reserve fails before an audit HTTP request');return draft();},{limit:1});
 await assert.rejects(app.assist(),e=>e.code==='terminal_fact_audit_incomplete');noPublished(app);assert.equal(app.calls.length,1);assert.equal(app.controller.usage.get(scope,'terminal-fact-coverage').attempts,1);
});

test('an earlier lookup consumes the actual allowance and cannot buy an unaudited regeneration',async t=>{
 const app=await application(t,(p,_w,index)=>p.purpose==='fidelity_check'?audit(p,[defect()]):index===0?{operation:'lookup',lookup:{sourceIds:[p.sources.find(s=>s.type==='qq').id]},continuation:'prepare_message'}:draft());
 await assert.rejects(app.assist(),e=>e.code==='terminal_fact_repair_budget');noPublished(app);assert.equal(app.calls.length,3);assert.equal(app.controller.usage.get(scope,'terminal-fact-coverage').remaining,1);
});

for(const change of ['source revision','source withdrawal','contact','model'])test(`a delayed audit cannot publish after ${change} changes`,async t=>{
 let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),app=await application(t,p=>p.purpose==='fidelity_check'?new Promise(resolve=>{release=()=>resolve(audit(p));entered();}):materialDraft(p),{noteText:'我以前没补过帆布包。这段可以告诉她。'}),pending=app.assist();pending.catch(()=>{});t.after(()=>release?.());await ready;
 if(change==='source revision')app.store.saveNote(scope,{...app.note,text:'我刚补过帆布包。'});
 if(change==='source withdrawal')app.store.forgetSource(scope,'note:'+app.note.id);
 if(change==='contact'){app.controller.scope={...scope,peerUid:'another-fictional-contact',peerUin:'9999999999'};app.controller.invalidateAssistant();}
 if(change==='model')app.controller.settings.model='another-fictional-model';
 release();await pending.catch(()=>{});noPublished(app);assert.equal(app.calls.length,2);assert.equal(app.controller.usage.get(scope,'terminal-fact-coverage').status,'cancelled');
});

test('source withdrawal after audit still fails the final atomic publication fence',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?audit(p):materialDraft(p),{noteText:'我以前没补过帆布包。这段可以告诉她。'}),bind=app.controller.candidateSession.bindPlan.bind(app.controller.candidateSession);
 t.mock.method(app.controller.candidateSession,'bindPlan',(...args)=>{app.store.forgetSource(scope,'note:'+app.note.id);return bind(...args);});await app.assist().catch(()=>{});noPublished(app);assert.equal(app.calls.length,2);
});

test('rejected producer and readonly auditor cannot commit their auxiliary proposals',async t=>{
 const marker='我周六下午有空',app=await application(t,(p,w)=>{
  if(p.purpose==='fidelity_check'){
   assert.equal(app.store.memoryStatus(scope).pendingProposals,0);assert.equal(app.store.topicView(scope).active,null);assert.equal(app.store.getCompanion(scope).state.items.length,0);assert.equal(app.store.experiences.list(scope).adaptations.length,0);
   return audit(p,p.candidate.text.includes(CLAIM)?[defect(CLAIM,'text')]:[],p.candidate.text.includes(CLAIM)?{relationshipPatch:{claims:[]}}:{});
  }
  if(w.originalInput)return {operation:'advise',text:'只保留重新核对后的私下建议。'};
  const sourceId=p.intentAuthority.sourceId,feedbackId=p.experienceProposalPolicy.feedbackSourceIds[0];assert.ok(feedbackId);
  return {operation:'advise',text:CLAIM+'。',statePatch:{items:[{text:marker,sourceIds:[sourceId]}]},relationshipPatch:{claims:[{text:marker,sourceIds:[sourceId],subject:'self',aspect:'recent_context',assertionKind:'reported',epistemicStatus:'supported'}]},
   topicPatch:{operation:'create',objective:'核对修包表达',direction:'围绕她的问题回应',constraints:[],interpretationStatus:'user_stated',purposeSourceIds:[sourceId],intentQuote:p.userRequest.text},
   experienceProposals:[{text:'修包问题先回应已知情况。',applicability:'回应修包问题时',methodId:'review',sourceIds:[feedbackId],caseIds:[]}]};
 });
 app.store.addFeedback(scope,{text:'之前的修包建议有未确认经历，先核对事实。',targetRef:{kind:'actual_message',messageId:frozen.available_sources[0].messageId}});
 const commits=[];for(const name of ['queueUnderstandingProposal','applyState','applyTopicPatch']){const original=app.store[name].bind(app.store);t.mock.method(app.store,name,(...args)=>{commits.push(name);return original(...args);});}
 const propose=app.store.experiences.proposeFromModel.bind(app.store.experiences);t.mock.method(app.store.experiences,'proposeFromModel',(...args)=>{commits.push('experience');return propose(...args);});
 const reply=await app.controller.assist({text:marker+'。回顾修包回应，核对修包表达；围绕她的问题回应。',purpose:'review',taskId:'terminal-aux-discard'});
 assert.equal(reply.text,'只保留重新核对后的私下建议。');assert.equal(app.calls.length,4);assert.deepEqual(commits,[]);assert.equal(app.run().relationshipReceipt,null);assert.equal(app.run().topicReceipt,null);assert.equal(app.store.getCompanion(scope).state.items.length,0);assert.equal(app.store.experiences.list(scope).adaptations.length,0);
 const first=app.run().requests.find(r=>r.purpose==='review');assert.equal(first.manifest.auxiliaryErrors?.some(e=>['relationshipPatch','topicPatch','experienceProposals','statePatch'].includes(e.field))||false,false,'producer proposals were valid before semantic rejection');
});

test('an earlier format repair can exhaust the regeneration reserve safely at default4',async t=>{
 const app=await application(t,(p,_w,index)=>p.purpose==='fidelity_check'?audit(p,[defect()]):index===0?{operation:'prepare_message',answer:'malformed'}:draft());
 await assert.rejects(app.assist(),e=>e.code==='terminal_fact_repair_budget');noPublished(app);assert.equal(app.calls.length,3);const usage=app.controller.usage.get(scope,'terminal-fact-coverage');assert.deepEqual(usage.requests.map(r=>r.purpose),['discussion','delivery_repair','fidelity_check']);assert.equal(usage.remaining,1);
});

test('fresh audit failure after a repaired body still blocks publication',async t=>{
 const app=await application(t,(p,w)=>{if(p.purpose==='fidelity_check'){if(!p.candidate.text.includes(CLAIM))throw Error('fictional fresh audit unavailable');return audit(p,[defect()]);}return draft(w.originalInput?GOOD:BAD);});
 await assert.rejects(app.assist(),e=>e.code==='terminal_fact_audit_incomplete');noPublished(app);assert.equal(app.calls.length,4);assert.equal(app.run().manifest.terminalFactCoverage.audits[1].reviewStatus,'incomplete');
});

test('regeneration cannot execute an extra lookup operation to bypass the bounded terminal policy',async t=>{
 const app=await application(t,(p,w)=>p.purpose==='fidelity_check'?audit(p,[defect()]):w.originalInput?{operation:'lookup',lookup:{query:'extra rejected-candidate lookup'},continuation:'prepare_message'}:draft());
 await assert.rejects(app.assist(),e=>e.code==='terminal_fact_repair_operation');noPublished(app);assert.equal(app.calls.length,3);assert.equal(app.run().requests.some(r=>r.payload.lookupHistory?.some(h=>h.query==='extra rejected-candidate lookup')),false);
});

for(const complete of [true,false])test(`visible projection is checked before publication and ${complete?'consumed after save':'not consumed for a failed audit'}`,async t=>{
 const question='你以前补过哪种包？',kept='先回应她舍不得换包的心情。',app=await application(t,p=>{if(p.purpose==='fidelity_check'){assert.equal(p.candidate.text,kept);return complete?audit(p):{checkRef:p.checkRef,issues:[]};}return {operation:'advise',text:question+'\n'+kept};});
 recordPendingClarifications(app.controller.pendingClarifications,{scopeKey:canonicalScopeKey(scope),questions:[question],turnId:'earlier-fictional-question'});supersedePendingClarifications(app.controller.pendingClarifications,{scopeKey:canonicalScopeKey(scope)});
 const before=structuredClone(app.controller.pendingClarifications);
 if(complete){const reply=await app.assist();assert.equal(reply.text,kept);assert.notDeepEqual(app.controller.pendingClarifications,before);assert.equal(reply.semanticReview.candidateHash,app.run().requests.find(r=>r.purpose==='fidelity_check').manifest.fidelity.candidateHash);assert.equal(app.run().manifest.publicationSeal.semanticCheck,false);}
 else{await assert.rejects(app.assist(),e=>e.code==='terminal_fact_audit_incomplete');noPublished(app);assert.deepEqual(app.controller.pendingClarifications,before);}
});

test('actually authorized local save and its receipt survive rejection of a later producer',async t=>{
 const noteText='我周六下午有空',app=await application(t,(p,w,index)=>{
  if(p.purpose==='fidelity_check')return audit(p,p.candidate.text.includes(CLAIM)?[defect()]:[]);
  if(index===0)return {operation:'advise',text:'先保存明确的私下事实。',actions:[{type:'save_note',text:noteText,use:'discussion',evidenceQuote:'记住'+noteText}]};
  return draft(w.originalInput?GOOD:BAD);
 },{limit:8});
 const reply=await app.assist('记住'+noteText+'。再帮我回应她问修包的话。','terminal-applied-receipt');assert.equal(reply.text,GOOD);assert.equal(app.calls.length,5);assert.equal(app.store.getCompanion(scope).notes.filter(n=>n.text===noteText&&n.use==='discussion').length,1);assert.ok(reply.actionReceipts.some(r=>r.type==='save_note'&&r.status==='applied'));assert.ok(app.run().actionReceipts.some(r=>r.type==='save_note'&&r.status==='applied'));assert.equal(app.store.getCompanion(scope).turns.filter(t=>t.role==='assistant').length,1);assert.equal(app.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});

for(const [purpose,limit,compact]of [['discussion',2,false],['discussion',3,true],['reply',3,false],['reply',4,true],['draft',3,false],['draft',4,true]])test(`optional compaction ${compact?'proceeds':'skips'} for ${purpose} with ${limit} remaining calls and preserves the required audit`,async t=>{
 const text='先回应她已经说清楚的修包问题。',app=await application(t,p=>p.purpose==='discussion_compaction'?{summary:'早先私下讨论过修包表达，没有实际发送消息。',reviewedTurnIds:p.turns.map(t=>t.id),quoteRefs:[]}:p.purpose==='fidelity_check'?audit(p):purpose==='discussion'?{operation:'advise',text}:draft(GOOD),{limit,compaction:true});
 const older=app.store.appendTurn(scope,{role:'user',kind:'discussion',text:'早先先核对修包回应，不编写经历。'});app.store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'早先的私下说明。'.repeat(550),sourceIds:['private:'+older.id]});
 const reply=await app.controller.assist({text:'继续根据她刚说的修包问题给我建议。',purpose,taskId:'terminal-compaction-'+purpose+'-'+limit}),usage=app.controller.usage.get(scope,reply.requestId);
 assert.equal(reply.text,purpose==='discussion'?text:GOOD);assert.equal(app.calls.filter(c=>c.p.purpose==='discussion_compaction').length,compact?1:0);assert.equal(app.calls.filter(c=>c.p.purpose==='fidelity_check').length,1);assert.equal(usage.limit,limit);assert.equal(usage.attempts,compact?3:2);assert.equal(usage.remaining,limit-(compact?3:2));assert.equal(app.controller.snapshot().discussionCompaction.phase,compact?'applied':'skipped');assert.equal(reply.semanticReview.exhaustive,false);assert.equal(app.run().manifest.publicationSeal.semanticCheck,false);
});
