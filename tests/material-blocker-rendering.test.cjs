'use strict';
const {wireSourceView,canonicalSourceView}=require('./fixtures/source-wire.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {parseAssistant,assistModel}=require('../src/assistant-model.cjs');
const {Controller}=require('../src/controller.cjs');
const {Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {firstResponse,repairResponse,firstResponseContent,repairResponseContent,firstResponseSha256,repairResponseSha256,currentSourceId,currentRequestText}=require('./fixtures/actual012-material-responses.cjs');
const sha=text=>createHash('sha256').update(text).digest('hex');
const question=repairResponse.requestDelivery.blocker.question,rationale=repairResponse.text;
const materialText='这是我给自己记读书笔记的小网页。昨天第一次把查找功能弄好了，我挺开心。想告诉她这个小进展，也想听她平时怎么留住读到的东西。';
function primaryPayload(){return {purpose:'discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:currentSourceId},userRequest:{sourceId:currentSourceId,text:currentRequestText},sources:[
 {id:'private:p1',type:'private',role:'user',text:materialText},
 {id:currentSourceId,type:'private',role:'user',text:currentRequestText}]};}
function finalResponse(){return {kind:'question',text:rationale,deliveryBlocker:structuredClone(repairResponse.requestDelivery.blocker)};}
function finalPayload(){return {purpose:'draft',requestDeliveryObligation:{mode:'editable_message'},sources:[],outboundQuotes:[]};}
async function controllerFixture(t,{restricted=false,requestText=currentRequestText,responder}={}){
 const store=new Store(':memory:'),calls=[],contexts=[];
 const settings={anonymous:true,auto:false,baseUrl:'http://fixture.invalid/v1',model:'synthetic-actual012-blocker',assistantRequestLimit:4,discussionCompactionEnabled:false,
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-actual012-blocker'}};
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(configured,context,signal)=>{
   contexts.push(context);
   return assistModel(configured,context,signal,async(_url,args)=>{
    const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;
    const receipt=(wrapper.originalInput?context.extraRequests?.at(-1)?.manifest?.sourceHandles:undefined)||context.manifest.sourceHandles;
    const primary=(wrapper.originalInput?context.extraRequests?.at(-1)?.manifest?.primaryReferences:undefined)||context.manifest.primaryReferences;
    const canonical=canonicalSourceView(p,receipt,wrapper.originalInput?context.extraRequests.at(-1).payload.originalInput:context.payload);
    calls.push({request,wrapper,p});
    let content=p.purpose==='fidelity_check'?JSON.stringify({checkRef:p.checkRef,verdict:'allow',issues:[]}):repairResponseContent;
    if(restricted&&p.purpose!=='fidelity_check'){
     content=JSON.stringify(!p.lookupHistory.length?{operation:'lookup',continuation:'prepare_message',text:'先核对当前真实来信。',lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]}}:{operation:'clarify',blocker:structuredClone(repairResponse.requestDelivery.blocker)});
    }
    if(responder){const value=await responder(canonical,wrapper,calls.length-1);content=typeof value==='string'?value:JSON.stringify(value);}
    content=JSON.stringify(wireSourceView(JSON.parse(content),receipt,primary,canonical));calls.at(-1).content=content;
    return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200});
   });
  }});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('72057594049927937001',false,{elements:[{textElement:{content:'你说最近总在做那个网页，做它有什么意思呀？'}}]})]});
 store.appendTurn(scope,{id:'p1',role:'user',kind:'discussion',text:materialText});
 store.appendTurn(scope,{id:currentSourceId.slice('private:'.length),role:'user',kind:'discussion',text:requestText});
 t.after(()=>{controller.close();store.close();});
 return {store,controller,calls,contexts,run:()=>store.getCompanion(scope).runs.at(-1),respond:()=>controller.assist({text:requestText,purpose:'discussion',resumeTurnId:currentSourceId.slice('private:'.length),taskId:restricted?'actual012-final-blocker':'actual012-primary-blocker'})};
}
test('actual012 response fixtures retain exact raw-content hashes and original current source identity',()=>{
 assert.equal(sha(firstResponseContent),firstResponseSha256);assert.equal(sha(repairResponseContent),repairResponseSha256);
 assert.equal(firstResponseSha256,'4f25f18b85c32cef8d6590fca47da41a6e528b7a57e83419a07e455de9ef25ea');
 assert.equal(repairResponseSha256,'b08223d3851c27e231124f722adb0bb33c74bccd23a99a1aef10274cb6d8d81b');
 assert.deepEqual(JSON.parse(firstResponseContent),firstResponse);assert.deepEqual(JSON.parse(repairResponseContent),repairResponse);
 assert.equal(firstResponse.requestDelivery.sourceId,currentSourceId);assert.equal(repairResponse.requestDelivery.sourceId,currentSourceId);
 assert.equal(rationale.includes(question),false,'the observed response rationale did not duplicate the structured question');
});
test('actual012 primary blocker renders only its structured question while legacy rationale stays diagnostic',()=>{
 const diagnostics={},result=parseAssistant(repairResponseContent,'discussion',primaryPayload(),diagnostics);
 assert.equal(result.kind,'question');assert.equal(result.text,question);assert.equal(result.discussionExplanation,undefined);
 assert.deepEqual(diagnostics.blockerRendering,{rawResponse:repairResponseContent,question,originalText:rationale});
 assert.deepEqual(result.requestDelivery.blocker,repairResponse.requestDelivery.blocker);assert.equal(result.suggestions,undefined);
 assert.equal(sha(repairResponseContent),repairResponseSha256,'rendering cannot rewrite the preserved producer content');
});
test('restricted final blocker renders its structured question without promoting untyped legacy rationale',()=>{
 const rawFinal=finalResponse(),original=structuredClone(rawFinal),diagnostics={},result=parseAssistant(rawFinal,'draft',finalPayload(),diagnostics);
 assert.equal(result.kind,'question');assert.equal(result.text,question);assert.equal(result.discussionExplanation,undefined);
 assert.deepEqual(diagnostics.blockerRendering,{rawResponse:original,question,originalText:rationale});assert.deepEqual(rawFinal,original,'rendering must not mutate the caller raw response');
 assert.deepEqual(result.deliveryBlocker,repairResponse.requestDelivery.blocker);assert.equal(result.suggestions,undefined);
});
for(const restricted of [false,true])test(`${restricted?'restricted final':'actual012 primary'} controller publishes a canonical private blocker without draft delivery or extra repair`,async t=>{
 const app=await controllerFixture(t,{restricted}),reply=await app.respond();
 assert.equal(reply.kind,'question');assert.equal(reply.text,question);assert.equal(reply.discussionExplanation,undefined);
 assert.equal(reply.suggestions,undefined);assert.equal(app.run().status,'complete');assert.equal(app.run().manifest.requestDelivery.status,'blocked');
 assert.deepEqual(app.run().manifest.requestDelivery.blocker,repairResponse.requestDelivery.blocker);
 const rawContent=app.calls.filter(call=>call.p.purpose!=='fidelity_check').at(-1).content;
 const operation=JSON.parse(rawContent);assert.equal(operation.operation,'clarify');assert.equal(operation.text,undefined);assert.deepEqual(operation.blocker,repairResponse.requestDelivery.blocker);
 assert.equal(app.run().manifest.primaryOperation.operation,'clarify');assert.equal(app.run().manifest.primaryOperation.requiredArtifact,restricted?'message':undefined);assert.equal(app.run().manifest.blockerRendering,undefined,'the new operation has no untyped second body; raw legacy final rendering remains covered separately');
 assert.equal(app.calls.at(-1).p.purpose,'fidelity_check');assert.equal(app.calls.at(-1).p.candidate.text,question);
 assert.equal(app.calls.length,restricted?3:2,'the complete blocker requires one read-only check, without a fulfillment repair');
 assert.equal(app.run().requests.some(request=>request.purpose==='delivery_repair'),false);
 const saved=app.store.getCompanion(scope).turns.at(-1);assert.equal(saved.text,question);assert.equal(saved.discussionExplanation,undefined);
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
const malformed=[
 ['non-question kind',value=>({...value,kind:'discussion'})],
 ['unknown blocker category',value=>({...value,blocker:{...value.blocker,kind:'unknown'}})],
 ['missing specific fact',value=>({...value,blocker:{...value.blocker,missing:''}})],
 ['missing structured question',value=>({...value,blocker:{...value.blocker,question:''}})],
 ['missing structured blocker',value=>({...value,blocker:undefined})],
 ['blocker mixed with outgoing wording',value=>({...value,suggestions:[{style:'自然',text:'未经完成核对的表达。'}]})]
];
for(const [name,alter]of malformed)for(const restricted of [false,true])test(`${restricted?'final':'primary'} blocker remains invalid for ${name}`,()=>{
 const raw={kind:'question',text:rationale,blocker:structuredClone(repairResponse.requestDelivery.blocker)},changed=alter(raw);
 const value=restricted?{kind:changed.kind,text:changed.text,deliveryBlocker:changed.blocker,...(changed.suggestions?{suggestions:changed.suggestions}:{})}:
  {kind:changed.kind,text:changed.text,requestDelivery:{...structuredClone(repairResponse.requestDelivery),blocker:changed.blocker},...(changed.suggestions?{suggestions:changed.suggestions}:{})};
 assert.throws(()=>parseAssistant(value,restricted?'draft':'discussion',restricted?finalPayload():primaryPayload(),{}),/requestDelivery/);
});
test('applied forget clears a normalized blocker sentinel before every subsequent request and persisted diagnostic',async t=>{
 const secret='FICTIONAL_NORMALIZED_BLOCKER_FORGET_SENTINEL_20261030';let targetId,afterForgetArgs;
 const requestText=`忘记${secret}这条笔记，然后仅用仍然可用的材料帮我组织表达。`;
 const app=await controllerFixture(t,{requestText,responder:(p,wrapper,index)=>{
  if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,verdict:'allow',issues:[]};
  const sourceId=p.intentAuthority?.sourceId||p.userRequest.sourceId,source=p.sources.find(item=>item.id===sourceId);
  if(index===0)return {kind:'question',text:`你要求不再使用${secret}，需要先执行移除。`,
   requestDelivery:{mode:'editable_message',sourceId,quote:source.text,blocker:{kind:'missing_authorization',missing:`确认${secret}是否仍可用于表达`,question:`${secret}还可以向她提及吗？`,explanation:`移除${secret}后才能重新确认分享范围。`}},
   actions:[{type:'forget',sourceId:targetId,targetQuote:secret,evidenceQuote:`忘记${secret}`}]};
  afterForgetArgs=structuredClone(app.controller.activeAssist?.args);
  return {kind:'question',text:'原有材料已不再使用，需要确认仍希望分享的具体事情。',
   requestDelivery:{mode:'editable_message',sourceId,quote:source.text,blocker:{kind:'missing_fact',missing:'本次仍希望表达的具体近况',question:'这次愿意表达哪件仍可用的小事？'}}};
 }});
 targetId=`note:${app.store.saveNote(scope,{text:secret,use:'discussion'}).id}`;
 const reply=await app.respond();
 assert.ok(reply.actionReceipts.some(receipt=>receipt.type==='forget'&&receipt.status==='applied'),'the source removal must actually apply before taint checks');
 assert.equal(app.store.memorySources(scope).some(source=>source.id===targetId||source.text.includes(secret)),false);
 assert.equal(app.calls.length,3);assert.equal(app.calls.slice(1).some(call=>JSON.stringify(call).includes(secret)),false,'no post-forget serialized field may contain the removed blocker content');
 assert.equal(JSON.stringify(afterForgetArgs).includes(secret),false);
 assert.equal(JSON.stringify(app.contexts.slice(1).map(context=>({payload:context.payload,manifest:context.manifest}))).includes(secret),false);
 assert.equal(JSON.stringify(app.run()).includes(secret),false,'normalized explanation, blocker witness and captured requests must all be sanitized');
 assert.equal(reply.kind,'question');assert.equal(reply.text,'这次愿意表达哪件仍可用的小事？');assert.equal(reply.suggestions,undefined);
 assert.equal(app.run().manifest.requestDelivery.status,'blocked');assert.equal(app.run().requests.some(request=>request.purpose==='delivery_repair'),false);
});
for(const restricted of [false,true])test(`${restricted?'restricted':'primary'} blocker rendering uses only its declared phase field`,()=>{
 const wrongPhaseQuestion='WRONG_PHASE_QUESTION_不应显示';
 const wrongPhaseBlocker={kind:'missing_fact',missing:'错误阶段字段不能替代当前协议',question:wrongPhaseQuestion};
 const value=restricted?{...finalResponse(),requestDelivery:{...structuredClone(repairResponse.requestDelivery),blocker:wrongPhaseBlocker}}:
  {...structuredClone(repairResponse),deliveryBlocker:wrongPhaseBlocker};
 const payload=restricted?finalPayload():primaryPayload(),purpose=restricted?'draft':'discussion';
 const rendered=parseAssistant(value,purpose,payload,{});
 assert.equal(rendered.text,question,'an extra field from another phase must not override the canonical structured question');
 assert.equal(rendered.text.includes(wrongPhaseQuestion),false);assert.equal(rendered.suggestions,undefined);
 const missingRequired=structuredClone(value);
 if(restricted)delete missingRequired.deliveryBlocker;else delete missingRequired.requestDelivery.blocker;
 assert.throws(()=>parseAssistant(missingRequired,purpose,payload,{}),/requestDelivery/,'an extra blocker from another phase cannot fulfill the required current phase contract');
 const malformedRequired=structuredClone(value);
 if(restricted)malformedRequired.deliveryBlocker={kind:'unknown',missing:'invalid',question:'invalid'};
 else malformedRequired.requestDelivery.blocker={kind:'unknown',missing:'invalid',question:'invalid'};
 assert.throws(()=>parseAssistant(malformedRequired,purpose,payload,{}),/requestDelivery/,'an invalid required blocker cannot be replaced by a valid blocker from another phase');
});
