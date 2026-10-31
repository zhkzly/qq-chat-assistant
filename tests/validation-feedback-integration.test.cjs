'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {ValidationIssues}=require('../src/validation-issues.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentStatementAuthority}=require('./fixtures/current-statement-authority.cjs');
async function setup(t,producer){
 const store=new Store(':memory:'),calls=[];
 store.appendTurn(scope,{id:'old-private',role:'user',kind:'discussion',text:'OLD_PRIVATE_FACT'});
 const settings={anonymous:true,auto:false,model:'synthetic-validation',baseUrl:'http://fixture.invalid/v1',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-validation',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,wrapper,p,owner:configured.sourceHandleOwner});
  const value=await producer(p,wrapper,calls.length-1);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{status:200});
 })});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('72057594044000000001',false,{elements:[{textElement:{content:'你最近做了什么？'}}]})]});
 t.after(()=>{controller.close();store.close();});return {store,controller,calls,run:()=>store.getCompanion(scope).runs.at(-1)};
}
const request='记住：今天我完成了查找功能。也愿意告诉她这个进展，给我完整表达。';
const delivery=p=>({mode:'editable_message'});
// Exact material failures stay in the active whole-answer contract. Auxiliary
// actions are valid, but neither may run before all core references validate.
function bad(){return {operation:'prepare_message',answer:{suggestions:[{text:'今天我完成了查找功能。'}]},actions:[{type:'save_note',evidenceQuote:'记住：今天我完成了查找功能',text:'今天我完成了查找功能'}],stateReview:'no_change',materials:[{materialRef:'m999999'},{materialRef:'m999998'}]};}

test('valid actions and state review inside a bad core never partially execute or buy another repair',async t=>{
 const app=await setup(t,p=>bad(p)),before=app.store.getCompanion(scope);
 await assert.rejects(app.controller.assist({text:request,taskId:'atomic-bad-core'}),/materialRef/);
 assert.equal(app.calls.length,2);const after=app.store.getCompanion(scope);assert.equal(after.notes.length,before.notes.length);assert.equal(after.state.version,before.state.version);
 assert.equal(after.turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.run().status,'failed');
 const repair=app.calls[1].wrapper;assert.ok(repair.validationIssues.some(issue=>issue.path==='materials[0].materialRef'));
 assert.ok(repair.validationIssues.some(issue=>issue.path==='materials[1].materialRef'));
 assert.ok(repair.validationIssues.every(issue=>Object.keys(issue).sort().join(',')==='code,message,path'));
});
test('a valid editable interpretation remains sticky when core validation fails',async t=>{
 const app=await setup(t,(p,w,index)=>index===0?bad(p):{operation:'advise',text:'只讨论，不再给表达。'});
 await assert.rejects(app.controller.assist({text:request,taskId:'sticky-atomic-core'}),/still requires a message artifact/);
 assert.equal(app.calls.length,2);assert.equal(app.calls[1].p.operationProtocol.requiredArtifact,'message');
 assert.equal(app.store.getCompanion(scope).notes.length,0);
});
test('the one existing repair receives all issues and can return one fully validated safe plan',async t=>{
 const app=await setup(t,(p,w,index)=>{
  if(p.purpose==='fidelity_check'){
   assert.equal(p.userRequest,undefined);assert.equal(p.goal,app.store.getCompanion(scope).goal.text);assert.equal(JSON.stringify(p.candidate).includes('OLD_PRIVATE_FACT'),false);
   return {checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  }
  if(index===0){const value=bad(p);delete value.actions;return value;}
  assert.equal(w.validationIssues.length,2);const id=p.intentAuthority.sourceId,control=text=>({text,sourceIds:[id]});
  return {operation:'prepare_message',answer:{suggestions:[{text:'今天终于把查找功能做好了。'}]},currentFacts:['今天我完成了查找功能']};
 });
 const answer=await app.controller.assist({text:request,taskId:'atomic-repair-success'});assert.equal(answer.kind,'draft');assert.equal(app.calls.length,2);
 assert.equal(app.run().requests.filter(item=>item.purpose==='delivery_repair').length,1);assert.equal(app.run().manifest.requestDelivery.status,'delivered');
});
test('diagnostic issue strings cannot allocate source handles and oversized feedback is never silently truncated',()=>{
 const owner=new SourceHandleOwner({scope,taskId:'diagnostics'}),payload={purpose:'discussion',sources:[{id:'private:valid',revision:'r1',text:'body'}],validationIssues:[{path:'draftPlan.quotes[0].authorization',code:'missing',message:'private:DO_NOT_REGISTER is only diagnostic prose'}]};
 const wire=owner.preview(payload);assert.equal(wire.receipt.bindings.length,1);assert.equal(wire.wirePayload.validationIssues[0].message,payload.validationIssues[0].message);assert.equal(owner.size,0);
 const issues=new ValidationIssues();assert.throws(()=>{for(let i=0;i<65;i++)issues.check(`field[${i}]`,'invalid',()=>{throw new Error('bad');});},error=>error.code==='validation_feedback_overflow'&&error.issues===undefined);
});
test('enabled experience proposals retain the original 64-source and case contracts',()=>{
 const {parseAssistant}=require('../src/assistant-model.cjs');
 const sources=Array.from({length:12},(_,index)=>({id:`feedback:experience-${index}`,type:'feedback',role:'user',text:`反馈${index}`}));
 const payload={purpose:'review',sources,methodSelection:{candidates:['respond'],maxApplied:2},experienceProposalPolicy:{enabled:true,feedbackSourceIds:[sources[0].id],caseIds:['case:one']}};
 const proposal={text:'保留可复核的经验候选',applicability:'同样需要具体回应时',methodId:'respond',sourceIds:sources.map(source=>source.id),caseIds:['case:one']};
 const result=parseAssistant({kind:'review',text:'先保留为待审经验。',experienceProposals:[proposal]},'review',payload);
 assert.deepEqual(result.experienceProposals,[proposal]);assert.equal(result.experienceProposals[0].sourceIds.length,12);
});
test('a malformed active prepare payload retains its bound message promise before repair',async t=>{
 const app=await setup(t,(p,w,index)=>{
  if(index>0)return {operation:'advise',text:'只私下说说。'};
  const value=bad(p);delete value.actions;value.answer={suggestions:'malformed'};return value;
 });
 await assert.rejects(app.controller.assist({text:request,taskId:'validated-inner-binding'}),/still requires a message artifact/);
 assert.equal(app.calls.length,2);assert.equal(app.calls[1].p.operationProtocol.requiredArtifact,'message');assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});
test('raw mode with invalid current authority never manufactures an editable declaration',()=>{
 const {parseAssistant}=require('../src/assistant-model.cjs');
 const payload={purpose:'discussion',requestDeliveryPolicy:{version:1},draftMaterialPolicy:{version:1},intentAuthority:{sourceId:'private:current'},userRequest:{sourceId:'private:current',text:'帮我表达。'},sources:[{id:'private:current',type:'private',role:'user',text:'帮我表达。'},{id:'private:old',type:'private',role:'user',text:'OLD_PRIVATE_FACT'}]};
 const value={kind:'discussion',text:'准备表达',requestDelivery:{mode:'both',sourceId:'private:old',quote:'帮我表达。'},draftPlan:{quotes:[{sourceId:'private:old',text:'OLD_PRIVATE_FACT'}]}};
 assert.throws(()=>parseAssistant(value,'discussion',payload),error=>error.issues.length>=2&&error.requestDelivery===undefined);
});
