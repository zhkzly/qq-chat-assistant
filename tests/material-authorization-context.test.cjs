'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {resolveDraftMaterial,DRAFT_MATERIAL_PROTOCOL}=require('../src/context/draft-material.cjs');
const {parseAssistant,assistModel,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {buildConversationWork}=require('../src/conversation-work.cjs');
const {buildMaterialView}=require('../src/conversation-materials.cjs');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {firstResponse,firstResponseContent,firstResponseSha256,currentSourceId,currentRequestText}=require('./fixtures/actual012-material-responses.cjs');
const text='这是我给自己记读书笔记的小网页。昨天第一次把查找功能弄好了，我挺开心。想告诉她这个小进展，也想听她平时怎么留住读到的东西。';
const source=(id,text,extra={})=>({id,type:'private',role:'user',text,revision:`revision-${id}`,...extra});
function payload(){return {purpose:'discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:currentSourceId},userRequest:{sourceId:currentSourceId,text:currentRequestText},draftMaterialPolicy:{version:1},sources:[source('private:p1',text),source(currentSourceId,currentRequestText)],taskContext:{invocation:{trigger:'private_request'}}};}
function factualPlan(){const plan=structuredClone(firstResponse.draftPlan);plan.quotes=plan.quotes.slice(0,2);return plan;}
function bindCurrent(plan,p){return {...plan,quotes:plan.quotes.map(q=>({...q,authorization:{permission:{sourceId:p.intentAuthority.sourceId,text:p.userRequest.text},referent:{sourceId:q.sourceId,text:q.text}}}))};}
test('actual012 omitted bindings report both exact fragment paths and the allowed reference shape',()=>{
 const p=payload();let error;try{parseAssistant(firstResponseContent,'discussion',p);}catch(caught){error=caught;}
 assert.ok(error);assert.match(error.message,/draftPlan\.quotes\[0\]\.authorization/);assert.match(error.message,/draftPlan\.quotes\[1\]\.authorization/);
 assert.doesNotMatch(error.message,/draftPlan\.quotes\[2\]\.authorization/,'the already bound fragment is not missing');
 for(const key of ['permission','referent','sourceId','text'])assert.ok(error.message.includes(key));
 assert.equal(firstResponseSha256,'4f25f18b85c32cef8d6590fca47da41a6e528b7a57e83419a07e455de9ef25ea');
});
test('a clear current reply request is an original permission reference, while the derived pointer itself is not a grant',()=>{
 const p=payload(),before=structuredClone(p),work=buildConversationWork(p),view=buildMaterialView({sources:p.sources,work});
 assert.match(work.request.authority,/pointer/);assert.match(view.currentIntent.authority,/pointer/);
 assert.doesNotMatch(work.request.authority,/current_user_meaning_not_outbound_authorization/);
 assert.match(view.instruction,/原始用户/);assert.match(DRAFT_MATERIAL_PROTOCOL,/当前.*QQ/);assert.match(DRAFT_MATERIAL_PROTOCOL,/无需.*授权/);
 const plan=bindCurrent(factualPlan(),p),material=resolveDraftMaterial(p,plan);
 assert.equal(material.bindings.length,2);assert.ok(material.bindings.every(binding=>binding.permission.sourceId===currentSourceId&&binding.referent.sourceId==='private:p1'));
 assert.deepEqual(material.quotes,factualPlan().quotes);assert.deepEqual(p,before,'view and material resolution cannot write a grant');
});
test('indexed missing-reference feedback preserves a real restricted handoff with the same factual quotes',async t=>{
 const store=new Store(':memory:'),calls=[];
 const settings={anonymous:true,auto:false,model:'synthetic-material-context',baseUrl:'http://fixture.invalid/v1',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model:'synthetic-material-context',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,wrapper,p});
  if(p.purpose==='draft'){
   assert.deepEqual(p.outboundQuotes,factualPlan().quotes);assert.equal(p.userRequest,undefined);assert.equal(p.goal,undefined);assert.equal(p.privateConversation,undefined);
   assert.equal(JSON.stringify(p).includes('想告诉她这个小进展'),false);
   return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({kind:'draft',text:'分享真实进展',suggestions:[{style:'自然',text:'是我给自己记读书笔记的小网页，昨天查找功能终于做好了，还挺开心。你平时怎么留住读到的东西？'}]})}}]}),{status:200});
  }
  let response=firstResponse;
  if(wrapper.originalInput){
   assert.match(wrapper.formatError,/draftPlan\.quotes\[0\]\.authorization/);assert.match(wrapper.formatError,/draftPlan\.quotes\[1\]\.authorization/);
   response={...structuredClone(firstResponse),draftPlan:bindCurrent(factualPlan(),p)};
  }
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}]}),{status:200});
 })});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('72057594049927937001',false,{elements:[{textElement:{content:'你说最近总在做那个网页，做它有什么意思呀？'}}]})]});
 store.appendTurn(scope,{id:'p1',role:'user',kind:'discussion',text});store.appendTurn(scope,{id:currentSourceId.slice(8),role:'user',kind:'discussion',text:currentRequestText});
 t.after(()=>{controller.close();store.close();});
 const reply=await controller.assist({text:currentRequestText,resumeTurnId:currentSourceId.slice(8),taskId:'actual012-material-bindings'});
 assert.equal(calls.length,3);assert.equal(reply.suggestions.length,1);assert.equal(store.getCompanion(scope).runs.at(-1).manifest.requestDelivery.status,'delivered');
});
test('derived work, requestDelivery and unrelated private material cannot replace original per-fragment references',()=>{
 const p=payload();p.work=buildConversationWork(p);p.requestDelivery=structuredClone(firstResponse.requestDelivery);
 assert.throws(()=>resolveDraftMaterial(p,factualPlan()),/authorization/);
 p.sources.push(source('private:unrelated','UNRELATED_PRIVATE_FACT'));
 assert.throws(()=>resolveDraftMaterial(p,{quotes:[{sourceId:'private:unrelated',text:'UNRELATED_PRIVATE_FACT'}]}),/authorization/);
 for(const type of ['request','feedback_continue']){
  const pointer=source('request:control',currentRequestText,type==='request'?{type:'request'}:{kind:'feedback_continue'});p.sources.push(pointer);
  const plan=bindCurrent(factualPlan(),{...p,intentAuthority:{sourceId:pointer.id},userRequest:{sourceId:pointer.id,text:pointer.text}});
  assert.throws(()=>resolveDraftMaterial(p,plan),/referent/,'a program request/control body must not be permission authority');p.sources.pop();
 }
});
for(const update of [{excluded:true},{deleted:true},{use:'disabled'}])test(`unusable material stays unusable with current-reference metadata ${JSON.stringify(update)}`,()=>{
 const p=payload(),plan=bindCurrent(factualPlan(),p);Object.assign(p.sources[0],update);
 assert.throws(()=>resolveDraftMaterial(p,plan),/未能对应/);
});
test('explicit discussion-only restrictions reject even syntactically valid current-reference metadata',()=>{
 const p=payload();p.privateRestrictions=[{sourceId:'private:p1',text}];assert.throws(()=>resolveDraftMaterial(p,bindCurrent(factualPlan(),p)),/仅供私下讨论/);
});
test('quoted, negated and unfulfilled conditional permission remains a semantic context check, never a view-generated grant',()=>{
 for(const request of ['她说“把你的项目介绍给我”，但我只想先私下想想。','不要把网页用途告诉她，先只和我商量。','如果我确认愿意，再告诉她网页的用途；现在还没确认。']){
  const p=payload();p.sources[1].text=request;p.userRequest.text=request;
  const work=buildConversationWork(p),view=buildMaterialView({sources:p.sources,work});
  assert.equal(p.sources[1].text,request);assert.match(view.currentIntent.authority,/pointer/);assert.throws(()=>resolveDraftMaterial(p,factualPlan()),/authorization/);
  const requestWire=prepareAssistantRequest({model:'synthetic'},p,[]).request;
  assert.ok(JSON.stringify(requestWire).includes(request));assert.match(DRAFT_MATERIAL_PROTOCOL,/引用.*否定.*条件/);
 }
});
