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
async function app(t,{text=GOOD,privateSource=false,audit,mutate}={}){
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-manual-review',baseUrl='http://fixture.invalid/v1';
 const original=privateSource?store.appendTurn(scope,{role:'user',kind:'discussion',text:SECRET}):null;
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async cmd=>cmd==='bind'?scope:{messages:[]},assistantModel:(settings,input,signal)=>{contexts.push(input);return assistModel(settings,input,signal,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({p,wrapper});
  const result=p.purpose==='fidelity_check'?await audit?.(p,{store,controller,original})??{checkRef:'c1',auditProtocol:'sparse-defects-v1',issues:[]}:{operation:'prepare_message',answer:{suggestions:[{text}]}};
  if(p.purpose==='fidelity_check')await mutate?.({store,controller,original});return envelope(result,request.tool_choice.function.name);
 });}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000001331',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'拼图终于拼好了。'}}]})]});
 return {store,controller,original,calls,contexts,assist:()=>controller.assist({text:'回应这条，帮我给出可以改着发的话。',taskId:'manual-review-task'}),ledger:()=>controller.usage.get(scope,'manual-review-task')};
}
const critique=(text,reason='This scripted second opinion reports an unsupported event.')=>({checkRef:'c1',auditProtocol:'sparse-defects-v1',issues:[{path:'suggestions[0].text',quote:text,code:'unsupported_fact',reason}]});
for(const [kind,text]of [['wrong-criticism',GOOD],['genuinely-bad-primary',BAD]])test(`${kind}: preserve the actual candidate and privately show criticism without automatic veto or rewrite`,async t=>{
 const application=await app(t,{text,audit:()=>critique(text)}),reply=await application.assist(),visible=projectVisibleTurn(reply),finding=reply.semanticReview.findings[0];
 assert.equal(reply.suggestions[0].text,text);assert.equal(reply.semanticReview.exhaustive,false);assert.equal(finding.kind,'reported_defect');assert.equal(finding.quote,text);assert.equal(finding.path,'suggestions[0].text');assert.equal(visible.references[0].label,notice);assert.ok(visible.references[0].text.includes(text));assert.ok(visible.references[0].text.includes(finding.reason));assert.equal(visible.suggestions[0].text,text);
 assert.equal(application.calls.length,2);assert.equal(application.ledger().attempts,2);assert.equal(application.ledger().requests.some(r=>r.purpose==='delivery_repair'),false);assert.equal(application.calls.some(c=>c.wrapper.fidelityIssues),false);assert.equal(application.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('an unavailable audit is visibly incomplete and distinct from a returned criticism',async t=>{
 const application=await app(t,{audit:()=>{throw Error('Scripted unavailable reviewer');}}),reply=await application.assist(),visible=projectVisibleTurn(reply);
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(reply.semanticReview.status,'incomplete');assert.equal(reply.semanticReview.findings?.length||0,0);assert.ok(visible.notices[0].text.includes('核对未完成'));assert.equal(visible.references,undefined);assert.equal(application.calls.length,2);
});
for(const mutation of ['account','contact','revision','withdrawal','cancel'])test(`a returned criticism cannot bypass late ${mutation} invalidation`,async t=>{
 const application=await app(t,{privateSource:true,audit:()=>critique(GOOD),mutate:async({store,controller,original})=>{
  if(mutation==='account')controller.updateStatus({phase:'ready',account:{uid:'different-account',uin:'990000'}});
  if(mutation==='contact'){controller.scope={...scope,peerUid:'other-contact'};controller.changedContext();}
  if(mutation==='revision')store.updateTurn(scope,original.id,'A corrected original.');
  if(mutation==='withdrawal')store.forgetSource(scope,'private:'+original.id);
  if(mutation==='cancel')controller.invalidateAssistant();
 }});await application.assist().catch(()=>{});assert.equal(application.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&turn.requestId==='manual-review-task'),false);assert.equal(application.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
for(const mutation of ['forget','edit','leaf-withdraw'])test(`persisted finding copies participate in actual ${mutation} invalidation, including an adopted draft`,async t=>{
 const application=await app(t,{text:SECRET,privateSource:true,audit:p=>{const ref=p.evidence.find(e=>e.text===SECRET);return {checkRef:'c1',auditProtocol:'sparse-defects-v1',issues:[{path:'suggestions[0].text',quote:SECRET,code:'private_disclosure',reason:'The user kept this original private.',evidence:[{sourceId:ref.sourceId,quote:ref.text}]}]};}}),reply=await application.assist(),finding=reply.semanticReview.findings[0];
 assert.equal(finding.evidence[0].sourceId,'private:'+application.original.id);assert.ok(finding.evidence[0].revision);
 application.store.experiences.recordInteraction(scope,{clientEventId:'review-adopt',type:'draft_adopted',text:reply.suggestions[0].text,artifactRefs:[reply.suggestions[0].artifactRef]});
 application.store.experiences.recordInteraction(scope,{clientEventId:'review-copy',type:'clipboard_write',text:reply.suggestions[0].text,artifactRefs:[reply.suggestions[0].artifactRef]});
 assert.equal(application.store.experiences.draft(scope).text,SECRET);assert.equal(application.store.experiences.draft(scope).text.includes(notice),false);
 if(mutation==='forget')application.store.forgetSource(scope,'private:'+application.original.id);
 if(mutation==='edit')application.store.updateTurn(scope,application.original.id,'The original was corrected.');
 if(mutation==='leaf-withdraw')application.store.experiences.invalidateArtifacts(scope,[reply.suggestions[0].artifactRef]);
 const companion=application.store.getCompanion(scope),retained=JSON.parse(application.store.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(application.store.scopeKey(scope)).record),rawTurn=retained.turns.find(t=>t.id===reply.id),view=companion.turns.find(t=>t.id===reply.id);
 assert.equal(rawTurn?.semanticReview?.findings?.length||0,0,'private review copies are removed from the retained record, not only hidden by UI');assert.equal(view?.semanticReview?.findings?.length||0,0);
 if(view)assert.equal(projectVisibleTurn(view).references?.some(r=>r.label===notice)||false,false);
 if(mutation!=='edit'){assert.equal(application.store.experiences.draft(scope).text,'');assert.equal(JSON.stringify(companion.turns.filter(turn=>turn.role==='assistant')).includes(SECRET),false);if(mutation==='leaf-withdraw')assert.equal(companion.turns.find(turn=>turn.id===application.original.id).text,SECRET);assert.throws(()=>application.store.experiences.recordInteraction(scope,{clientEventId:'late-review-adopt',type:'draft_adopted',text:SECRET,artifactRefs:[reply.suggestions[0].artifactRef]}),/removed|changed|review/i);}
 assert.equal(application.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});

for(const channel of ['issues','concerns'])for(const code of [undefined,'','   ',' '.repeat(90)+'trailing-code','x'.repeat(180)])test(`actual wire ${channel} unusable code ${JSON.stringify(code?.slice(0,14))} cannot stop coaching`,async t=>{
 const application=await app(t,{audit:()=>({checkRef:'c1',auditProtocol:'sparse-defects-v1',issues:[],[channel]:[{path:'suggestions[0].text',quote:GOOD,code,reason:'A private advisory that cannot own publication.'}]})}),reply=await application.assist();
 assert.equal(reply.suggestions[0].text,GOOD);assert.equal(application.calls.length,2);assert.equal(application.ledger().requests.some(r=>r.purpose==='delivery_repair'),false);assert.equal(reply.semanticReview.exhaustive,false);if(typeof code!=='string'||!code.trim()||code.trim().length>80)assert.equal(reply.semanticReview.status,'incomplete');assert.ok((reply.semanticReview.findings||[]).every(f=>f.code.trim()&&f.code.length<=80));
});
test('actual wire valid finding survives malformed adjacent advisory fields, including whitespace-prefixed reason',async t=>{
 const application=await app(t,{audit:()=>({checkRef:'c1',auditProtocol:'sparse-defects-v1',issues:[{path:'suggestions[0].text',quote:GOOD,code:'unsupported_fact',reason:'Independent concrete report stays visible.'}],concerns:[{path:'suggestions[0].text',quote:GOOD,code:' '.repeat(80)+'style',reason:' '.repeat(1200)+'A trailing valid private advisory.'},{path:'suggestions[0].text',code:'invalid-optional',reason:{sourceId:'s999'}}]})}),reply=await application.assist();
 assert.equal(application.calls.length,2);assert.equal(reply.suggestions[0].text,GOOD);assert.ok(reply.semanticReview.findings.some(f=>f.reason==='Independent concrete report stays visible.'));assert.equal(reply.semanticReview.status,'incomplete');assert.ok((reply.semanticReview.findings||[]).every(f=>f.reason.trim()&&f.reason.length<=1200));
});
