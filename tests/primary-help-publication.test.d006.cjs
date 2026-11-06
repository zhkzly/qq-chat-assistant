'use strict';
// Scripted transport proves publication mechanics, never conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{assistModel}=require('../src/assistant-model.cjs'),{primaryOperationFor}=require('../src/primary-operation.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const BODY='这幅拼图终于完成啦。';
const candidate=text=>({operation:'prepare_message',answer:{privateExplanation:'先回应她分享的实际进展。',suggestions:[{style:'自然',text:text||BODY}]}});
async function app(t,producer=p=>candidate(),{text='接住这条近况，给我可修改的话。',purpose='discussion',observePublication=false}={}){
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-primary-publication',baseUrl='http://fixture.invalid/v1',note=store.saveNote(scope,{text:'A real scoped note.',use:'draft'});let parsed;
 let publicationArgs,ControllerClass=Controller;
 if(observePublication){const seals=require('../src/publication-seal.cjs'),create=seals.createPublicationSeal;t.mock.method(seals,'createPublicationSeal',args=>{publicationArgs=args;return create(args);});delete require.cache[require.resolve('../src/controller.cjs')];ControllerClass=require('../src/controller.cjs').Controller;}
 const controller=new ControllerClass({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async cmd=>cmd==='bind'?scope:{messages:[]},assistantModel:async(settings,input,signal)=>{
  contexts.push(input);const value=await assistModel(settings,input,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({p,wrapper});assert.notEqual(p.purpose,'fidelity_check');
   const result=await producer(p,wrapper,calls.length-1);return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'primary-publication-result',type:'function',function:{name:request.tool_choice.function.name,arguments:typeof result==='string'?result:JSON.stringify(result)}}]}}]}),{status:200});
  });parsed=value;return value;
 }});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000001431',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'拼图终于完成了。'}}]})]});
 return {controller,store,calls,contexts,note,parsed:()=>parsed,publication:()=>publicationArgs,assist:(extra={})=>controller.assist({text,purpose,taskId:'primary-publication',materialIds:[note.id],...extra}),ledger:()=>controller.usage.get(scope,'primary-publication')};
}
test('ordinary prepared help uses one primary call, preserving admission with no critic or review badge',async t=>{
 const a=await app(t),reply=await a.assist();assert.equal(reply.suggestions[0].text,BODY);assert.equal(a.calls.length,1);assert.equal(a.ledger().attempts,1);assert.equal(reply.semanticReview,undefined);assert.equal(a.store.getCompanion(scope).runs.at(-1).manifest.fidelity,undefined);assert.equal(a.store.getCompanion(scope).runs.at(-1).manifest.publicationSeal.semanticCheck,false);assert.equal(a.store.messages(scope).some(m=>m.direction==='outgoing'),false);
});
test('an explicit review request is ordinary primary help rather than an automatic second judge',async t=>{
 const a=await app(t,()=>({operation:'advise',text:'可以从她这次分享的实际进展理解。'}),{text:'先帮我分析依据，不写给她。',purpose:'review'}),reply=await a.assist();assert.equal(reply.kind,'discussion');assert.equal(a.calls.length,1);assert.equal(a.calls[0].p.purpose,'review');assert.equal(reply.semanticReview,undefined);
});
test('a real structural repair is counted and remains the only additional generation call',async t=>{
 const a=await app(t,(_p,_w,index)=>index===0?'MALFORMED_PRIMARY_JSON':candidate()),reply=await a.assist();assert.equal(reply.suggestions[0].text,BODY);assert.equal(a.calls.length,2);assert.equal(a.ledger().requests.filter(r=>r.purpose==='delivery_repair').length,1);assert.equal(a.ledger().requests.some(r=>r.purpose==='fidelity_check'),false);
});
test('a real lookup continues the same primary task without a semantic review stage',async t=>{
 const a=await app(t,(_p,_w,index)=>index===0?{operation:'lookup',lookup:{query:'拼图'},continuation:'prepare_message'}:candidate()),reply=await a.assist();assert.equal(reply.suggestions[0].text,BODY);assert.equal(a.calls.length,2);assert.equal(a.ledger().requests.some(r=>r.purpose==='fidelity_check'),false);
});
for(const [name,mutate]of Object.entries({body:r=>r.suggestions[0].text='Post-parse changed message',style:r=>r.suggestions[0].style='Changed style',reference:r=>r.suggestions[0]={...r.suggestions[0]},array:r=>r.suggestions=[...r.suggestions],kind:r=>r.kind='question',mode:r=>r.requestDelivery.mode='private_help',explanation:r=>r.discussionExplanation.text='Changed private explanation'}))test(`post-parse ${name} mutation cannot publish despite retained canonical-operation identity`,async t=>{
 const a=await app(t,()=>candidate(),{observePublication:true}),bind=a.controller.candidateSession.bindPlan.bind(a.controller.candidateSession);t.mock.method(a.controller.candidateSession,'bindPlan',(...args)=>{const r=a.publication().result;assert.ok(primaryOperationFor(r));mutate(r);assert.ok(primaryOperationFor(r));return bind(...args);});
 await assert.rejects(a.assist(),error=>error.code==='publication_binding_invalid'||error instanceof TypeError);assert.equal(a.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(a.calls.length,1);
});
for(const change of ['source-revision','source-forget','account','contact','cancel'])test(`publication still rejects late ${change} without relying on an auditor`,async t=>{
 const a=await app(t),bind=a.controller.candidateSession.bindPlan.bind(a.controller.candidateSession);t.mock.method(a.controller.candidateSession,'bindPlan',(...args)=>{
  if(change==='source-revision')a.store.saveNote(scope,{id:a.note.id,text:'Corrected scope note.',use:'draft'});
  if(change==='source-forget')a.store.forgetSource(scope,'note:'+a.note.id);
  if(change==='account')a.controller.updateStatus({phase:'ready',account:{uid:'another-account',uin:'990000'}});
  if(change==='contact'){a.controller.scope={...scope,peerUid:'another-contact'};a.controller.changedContext();}
  if(change==='cancel')a.controller.invalidateAssistant();return bind(...args);
 });await a.assist().catch(()=>{});assert.equal(a.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(a.calls.length,1);
});
test('generated editing artifacts retain their own availability resolver, independently of raw source revisions',async t=>{
 const a=await app(t,p=>({...candidate(),...(p.editingReferences?.length?{editingReference:{choice:p.editingReferences[0].choice}}:{})})),prior=a.store.appendTurn(scope,{role:'assistant',kind:'draft',text:'Old generated expression.',suggestions:[{text:'Old generated expression.'}],sourceIds:['qq:91000000000001431']}),bind=a.controller.candidateSession.bindPlan.bind(a.controller.candidateSession);
 t.mock.method(a.controller.candidateSession,'bindPlan',(...args)=>{a.store.experiences.invalidateArtifacts(scope,[prior.suggestions[0].artifactRef]);return bind(...args);});await a.assist({text:'从选中的旧句修改。',sourceTurnIds:[prior.id]}).catch(()=>{});
 assert.equal(a.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'&&turn.requestId==='primary-publication'),false);assert.equal(a.calls.length,1);
});
test('legitimate topic and state writes in the same transaction do not invalidate their own completed primary candidate',async t=>{
 const human='这次专门聊她完成拼图的过程，先不邀请。',a=await app(t,p=>({...candidate(),topicPatch:{operation:'create',objective:'了解完成拼图的过程',direction:'先接住她的分享',constraints:['先不邀请'],stage:'私下商量',purposeSourceIds:[p.intentAuthority.sourceId],intentQuote:human,interpretationStatus:'user_stated'},statePatch:{items:[{text:'当前先聊她的完成过程',sourceIds:[p.intentAuthority.sourceId]}]}}),{text:human}),reply=await a.assist();
 assert.equal(reply.suggestions[0].text,BODY);assert.equal(a.calls.length,1);const companion=a.store.getCompanion(scope);assert.ok(companion.topics.activeId);assert.equal(companion.state.items.length,1);assert.equal(companion.runs.at(-1).topicReceipt.applied,true);
});
