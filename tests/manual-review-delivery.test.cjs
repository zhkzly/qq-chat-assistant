'use strict';
// Product execution with scripted transport. Semantic critique is deliberately
// fallible; these checks do not grade wording or make bad primary text usable.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{assistModel}=require('../src/assistant-model.cjs');
const {projectVisibleTurn}=require('../scripts/eval-qq-adapter.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const GOOD='你的拼图终于拼好啦。',BAD='我昨晚也拼好了同样的拼图。',SECRET='PRIVATE_REVIEW_SOURCE_家人的检查安排只在这里说。';
const notice='核对提示（模型意见，可能有误）';
function envelope(value,name){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'manual-review-result',type:'function',function:{name,arguments:typeof value==='string'?value:JSON.stringify(value)}}]}}]}),{status:200});}
async function app(t,{text=GOOD,repairText=GOOD,privateSource=false,audit,mutate}={}){
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-manual-review',baseUrl='http://fixture.invalid/v1';
 const original=privateSource?store.appendTurn(scope,{role:'user',kind:'discussion',text:SECRET}):null;
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async cmd=>cmd==='bind'?scope:{messages:[]},assistantModel:(settings,input,signal)=>{contexts.push(input);return assistModel(settings,input,signal,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({p,wrapper});
  const result=p.purpose==='fidelity_check'?await audit?.(p,{store,controller,original})??{checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:[]}:{operation:'prepare_message',answer:{suggestions:[{text:wrapper.originalInput?repairText:text}]}};
  if(p.purpose==='fidelity_check')await mutate?.({store,controller,original});return envelope(result,request.tool_choice.function.name);
 });}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000001331',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'拼图终于拼好了。'}}]})]});
 return {store,controller,original,calls,contexts,assist:()=>controller.assist({text:'回应这条，帮我给出可以改着发的话。',taskId:'manual-review-task'}),ledger:()=>controller.usage.get(scope,'manual-review-task')};
}
// Every report below is scripted for a concrete publication/lifecycle case.
for(const [kind,text]of [['wrong-criticism',GOOD],['reported-bad-primary',BAD]])test(`${kind}: the required auditor respects source authority and bounded regeneration`,async t=>{
 let audits=0;const application=await app(t,{text,audit:p=>{audits++;const quote=kind==='wrong-criticism'?GOOD:BAD,source=p.evidence.find(source=>source.type==='qq');return {checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:p.candidate.text.includes(quote)?[{path:'suggestions[0].text',quote,code:kind==='wrong-criticism'?'private_disclosure':'unsupported_fact',claim:{kind:'assertion',quote},...(kind==='wrong-criticism'?{privacyBasis:'absence_of_grant',evidence:[{sourceId:source.sourceId,quote:source.text}]}:{})}]:[]};}}),reply=await application.assist(),visible=projectVisibleTurn(reply),repair=kind==='reported-bad-primary';
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.status,'reviewed');assert.equal(reply.semanticReview.exhaustive,false);assert.equal(visible.references,undefined);assert.equal(application.calls.length,repair?4:2);assert.equal(audits,repair?2:1);assert.equal(application.ledger().attempts,repair?4:2);assert.equal(application.ledger().requests.filter(r=>r.purpose==='delivery_repair').length,repair?1:0);assert.equal(application.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('an unavailable required reviewer retains the question and publishes no assistant artifact',async t=>{
 const application=await app(t,{audit:()=>{throw Error('Fictional required reviewer unavailable');}});await assert.rejects(application.assist(),error=>error.code==='terminal_fact_audit_incomplete');assert.equal(application.calls.length,2);assert.equal(application.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(application.store.getCompanion(scope).turns.filter(turn=>turn.role==='user').at(-1).text,'回应这条，帮我给出可以改着发的话。');assert.equal(application.controller.advice,null);
});
for(const mutation of ['account','contact','revision','withdrawal','cancel'])test(`primary publication cannot bypass late ${mutation} invalidation`,async t=>{
 const application=await app(t,{privateSource:true}),bind=application.controller.candidateSession.bindPlan.bind(application.controller.candidateSession);
 t.mock.method(application.controller.candidateSession,'bindPlan',(...args)=>{
  const {store,controller,original}=application;
  if(mutation==='account')controller.updateStatus({phase:'ready',account:{uid:'different-account',uin:'990000'}});
  if(mutation==='contact'){controller.scope={...scope,peerUid:'other-contact'};controller.changedContext();}
  if(mutation==='revision')store.updateTurn(scope,original.id,'A corrected original.');
  if(mutation==='withdrawal')store.forgetSource(scope,'private:'+original.id);
  if(mutation==='cancel')controller.invalidateAssistant();return bind(...args);
 });await application.assist().catch(()=>{});assert.equal(application.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&turn.requestId==='manual-review-task'),false);assert.equal(application.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
for(const mutation of ['forget','edit','leaf-withdraw'])test(`historical stored finding copies obey actual ${mutation} invalidation and adopted draft cleanup`,async t=>{
 const application=await app(t,{privateSource:true});await application.assist();const original=application.store.memorySources(scope).find(s=>s.id==='private:'+application.original.id),evidence={sourceId:original.id,quote:original.text,revision:original.revision};
 const reply=application.store.appendTurn(scope,{role:'assistant',kind:'draft',text:'',suggestions:[{text:SECRET}],sourceIds:[original.id],artifactMetadata:{inputSourceRefs:[{sourceId:original.id,revision:original.revision}]},semanticReview:{status:'reviewed',candidateHash:'a'.repeat(64),bindingHash:'b'.repeat(64),exhaustive:false,findings:[{kind:'reported_defect',path:'suggestions[0].text',quote:SECRET,code:'private_disclosure',reason:'A retained historical review.',evidence:[evidence]}]}});
 assert.ok(projectVisibleTurn(reply).references.some(r=>r.label===notice));application.store.experiences.recordInteraction(scope,{clientEventId:'review-adopt',type:'draft_adopted',text:reply.suggestions[0].text,artifactRefs:[reply.suggestions[0].artifactRef]});application.store.experiences.recordInteraction(scope,{clientEventId:'review-copy',type:'clipboard_write',text:reply.suggestions[0].text,artifactRefs:[reply.suggestions[0].artifactRef]});
 assert.equal(application.store.experiences.draft(scope).text,SECRET);assert.equal(application.store.experiences.draft(scope).text.includes(notice),false);
 if(mutation==='forget')application.store.forgetSource(scope,original.id);if(mutation==='edit')application.store.updateTurn(scope,application.original.id,'The original was corrected.');if(mutation==='leaf-withdraw')application.store.experiences.invalidateArtifacts(scope,[reply.suggestions[0].artifactRef]);
 const companion=application.store.getCompanion(scope),retained=JSON.parse(application.store.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(application.store.scopeKey(scope)).record),rawTurn=retained.turns.find(t=>t.id===reply.id),view=companion.turns.find(t=>t.id===reply.id);
 assert.equal(rawTurn?.semanticReview?.findings?.length||0,0);assert.equal(view?.semanticReview?.findings?.length||0,0);if(view)assert.equal(projectVisibleTurn(view).references?.some(r=>r.label===notice)||false,false);
 if(mutation!=='edit'){assert.equal(application.store.experiences.draft(scope).text,'');assert.equal(JSON.stringify(companion.turns.filter(turn=>turn.role==='assistant')).includes(SECRET),false);if(mutation==='leaf-withdraw')assert.equal(companion.turns.find(turn=>turn.id===application.original.id).text,SECRET);assert.throws(()=>application.store.experiences.recordInteraction(scope,{clientEventId:'late-review-adopt',type:'draft_adopted',text:SECRET,artifactRefs:[reply.suggestions[0].artifactRef]}),/removed|changed|review/i);}
 assert.equal(application.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
for(const channel of ['issues','concerns'])for(const code of [undefined,'','   ',' '.repeat(90)+'trailing-code','x'.repeat(180)])test(`malformed ${channel} code ${JSON.stringify(code?.slice(0,14))} ${channel==='issues'?'prevents publication':'stays optional diagnostic metadata'}`,async t=>{
 let audits=0;const application=await app(t,{audit:p=>{audits++;return {checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:[],[channel]:[{path:'suggestions[0].text',quote:GOOD,claim:{kind:'assertion',quote:GOOD},code,reason:'Malformed scripted metadata.'}]};}});
 if(channel==='issues'){const pending=application.assist(),observed=await pending.then(reply=>({published:true,text:reply.text,semanticReview:reply.semanticReview}),error=>({published:false,errorCode:error.code})),run=application.store.getCompanion(scope).runs.at(-1);t.diagnostic(JSON.stringify({codePresent:code!==undefined,code:code??null,observed,audit:run.requests.find(request=>request.purpose==='fidelity_check')?.manifest.fidelity,attempts:application.ledger().attempts}));await assert.rejects(pending,error=>error.code==='terminal_fact_audit_incomplete');assert.equal(application.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);}
 else {const reply=await application.assist();assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.status,'reviewed');assert.equal(reply.semanticReview.exhaustive,false);}
 assert.equal(application.calls.length,2);assert.equal(audits,1);assert.equal(application.ledger().attempts,2);
});
test('a valid concrete defect remains blocking beside malformed optional advisory metadata',async t=>{
 let audits=0;const application=await app(t,{repairText:GOOD,audit:p=>{audits++;return {checkRef:p.checkRef,auditProtocol:p.auditProtocol,issues:[{path:'suggestions[0].text',quote:GOOD,code:'unsupported_fact',claim:{kind:'assertion',quote:GOOD},reason:'Scripted persistent finding.'}],concerns:[{reason:{sourceId:'s999'}}]};}});await assert.rejects(application.assist(),error=>error.code==='terminal_fact_defect_unresolved');assert.equal(audits,2);assert.equal(application.calls.length,4);assert.equal(application.ledger().requests.filter(r=>r.purpose==='delivery_repair').length,1);assert.equal(application.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(application.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
