'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional Controller/HTTP contracts only. Scripted verdicts do not establish
// natural-language entailment, permission judgment or conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const MESSAGE='Your shelf sounds like a satisfying little project.';
const HUMAN='Respond to her shelf without adding any personal event or invitation.';
const DIAGNOSTIC='PRIVATE_ADVISORY_SENTINEL';

async function application(t,verdict){
 const store=new Store(':memory:'),calls=[],contexts=[];
 t.mock.method(globalThis,'fetch',async()=>{throw Error('Unmocked HTTP forbidden');});
 const settings={anonymous:true,auto:false,model:'synthetic-advisory-boundary',baseUrl:'http://fixture.invalid/v1',modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false};
 settings.realChatConsent={...scope,model:settings.model,baseUrl:settings.baseUrl};
 const controller=new Controller({store,settings,compactionModel:null,read:async command=>command==='bind'?scope:{messages:[]},assistantModel:(configured,input,signal)=>{
  contexts.push(input);
  return assistModel(configured,input,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;
   calls.push(p);
   const value=p.purpose==='fidelity_check'?verdict(p):{operation:'prepare_message',answer:{suggestions:[{text:MESSAGE}]}};
   return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'fictional-advisory-boundary',type:'function',function:{name:request.tool_choice.function.name,arguments:JSON.stringify(value)}}]}}]}),{status:200});
  });
 }});
 t.after(()=>{controller.close();store.close();});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('900719925474099872223',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'I finished a small shelf today.'}}]})]});
 return {store,controller,calls,contexts,assist:()=>controller.assist({text:HUMAN,taskId:'advisory-boundary'})};
}
const badAdvisory={path:'suggestions[0].text',code:'style',sourceIds:['s999'],reason:DIAGNOSTIC};
function noExtraRequests(app){
 const ledger=app.controller.usage.get(scope,'advisory-boundary');
 assert.equal(app.calls.length,2);assert.equal(ledger.attempts,2);assert.equal(ledger.limit,4);
 assert.deepEqual(ledger.requests.map(request=>request.purpose),['discussion','fidelity_check']);
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
 return ledger;
}
function noPublication(app){
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
 assert.ok(app.store.getCompanion(scope).turns.some(turn=>turn.role==='user'&&turn.text===HUMAN));
 assert.equal(app.store.relationshipView(scope).claims.length,0);
 assert.equal(app.store.memoryStatus(scope).pendingProposals,0);
}

test('unusable optional audit witnesses remain private diagnostics and expose incomplete review without new authority',async t=>{
 const app=await application(t,p=>({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[{...badAdvisory,code:'current_boundary',quote:MESSAGE}],concerns:[badAdvisory]})),reply=await app.assist(),ledger=noExtraRequests(app);
 assert.equal(ledger.status,'complete');assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(reply.semanticReview.status,'incomplete');assert.equal(reply.warning,undefined);assert.equal(JSON.stringify(reply).includes(DIAGNOSTIC),false);assert.deepEqual(app.calls[1].admittedFragments,[]);assert.equal(app.store.relationshipView(scope).claims.length,0);assert.equal(app.store.memoryStatus(scope).pendingProposals,0);
 const check=app.contexts.at(-1).manifest.fidelity;assert.equal(check.exhaustive,false);assert.equal(check.issues.length,0);assert.ok(check.diagnostics.length>=2);assert.equal(app.store.memorySources(scope).some(source=>source.id==='s999'),false);
});
test('uncertain private interpretation remains advice and invalid optional witnesses mark the audit incomplete without regeneration',async t=>{
 const app=await application(t,p=>({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[],concerns:[{path:'suggestions[0].text',code:'interpretation',quote:MESSAGE,reason:'This private reading is uncertain.'},badAdvisory]})),reply=await app.assist(),ledger=noExtraRequests(app);
 assert.equal(ledger.status,'complete');assert.equal(reply.semanticReview.status,'incomplete');const check=app.contexts.at(-1).manifest.fidelity;assert.equal(check.concerns.length,1);assert.ok(check.diagnostics.length);assert.equal(check.issues.length,0);
});
test('legacy global rejection cannot become a native pass certificate or override actual nonassertive help',async t=>{
 const app=await application(t,p=>({checkRef:p.checkRef,verdict:'reject',factual:factualReview(p,{}),issues:[],concerns:[badAdvisory]})),reply=await app.assist(),ledger=noExtraRequests(app);
 assert.equal(ledger.status,'complete');assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(reply.semanticReview.status,'incomplete');const check=app.contexts.at(-1).manifest.fidelity;assert.equal(check.exhaustive,false);assert.equal(check.verdict,'incomplete');assert.deepEqual(check.issues,[]);assert.equal(app.store.relationshipView(scope).claims.length,0);assert.equal(app.store.memoryStatus(scope).pendingProposals,0);
});
