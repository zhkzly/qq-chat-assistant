'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Controller}=require('../src/controller.cjs');
const {Store}=require('../src/store.cjs');
const {assistModel,parseAssistant,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {selectMethods}=require('../src/help-methods.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const actual005={kind:'discussion',text:'可以围着“做它有什么意思”来答：说清它是给自己记读书笔记的小网页，再带上你刚做好的查找功能和开心劲儿，最后问她平时怎么留住读到的东西。'};
const interpretation=(p,mode='editable_message')=>{const sourceId=p.intentAuthority?.sourceId||p.userRequest?.sourceId;return {mode,sourceId,quote:p.sources.find(s=>s.id===sourceId).text.slice(0,1000)};};
const plan=(p,quotes=[],overrides={})=>withCurrentDraftControls({quotes,intent:'reply',...overrides},p);
async function setup(t,producer,{limit=4}={}){
 const store=new Store(':memory:'),calls=[];
 const settings={auto:false,anonymous:true,model:'synthetic',baseUrl:'http://fixture.invalid/v1',assistantRequestLimit:limit,discussionCompactionEnabled:false,
  realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(settings,context,signal)=>assistModel(settings,context,signal,async(_,args)=>{
   const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;
   calls.push({request,wrapper,p});const value=await producer(p,wrapper,request);
   return new Response(JSON.stringify({choices:[{message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}),{status:200});
  })});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 t.after(()=>{controller.close();store.close();});
 return {store,controller,calls,run:()=>store.getCompanion(scope).runs.at(-1)};
}
function actualIncoming(app,text='你说最近总在做那个网页，做它有什么意思呀？'){
 app.controller.live({scope,messages:[raw(undefined,false,{elements:[{textElement:{content:text}}]})]});
}
for(const declared of [false,true])test(`actual005 strategy-only ${declared?'declared editable':'missing contract'} is repaired into a source-bound restricted handoff`,async t=>{
 const app=await setup(t,(p,wrapper)=>{
  if(p.purpose==='draft'){
   assert.equal(p.goal,undefined);assert.equal(p.privateConversation,undefined);assert.equal(p.userRequest,undefined);
   assert.equal(JSON.stringify(p).includes('私人担忧_MARKER'),false);
   assert.deepEqual(p.outboundQuotes.map(q=>q.text),['这是我给自己记读书笔记的小网页。','昨天第一次把查找功能弄好了，我挺开心。']);
   return {kind:'draft',text:'回应为什么做',suggestions:[{style:'自然',text:'就是给自己留读书笔记的，昨天终于能查找了，还挺开心。你平时怎么留住读到的东西？'}]};
  }
  assert.match(p.userRequest.text,/能改着发/);
  if(!wrapper.originalInput)return {...actual005,...(declared?{requestDelivery:interpretation(p)}:{})};
  assert.notEqual(wrapper.purpose,'plain_help_recovery');assert.match(wrapper.task,/requestDelivery/);
  if(declared)assert.equal(p.requestDeliveryPolicy.obligation.mode,'editable_message');
  const material=p.sources.find(s=>s.text.startsWith('这是我给自己'));
  const permission={sourceId:material.id,text:'想告诉她这个小进展'};
  return {kind:'discussion',text:'可以保留你的真实进展，再问她的习惯。',requestDelivery:interpretation(p,'both'),draftPlan:plan(p,
   ['这是我给自己记读书笔记的小网页。','昨天第一次把查找功能弄好了，我挺开心。'].map(text=>({sourceId:material.id,text,authorization:{permission,referent:{sourceId:material.id,text}}})))};
 });
 actualIncoming(app);app.store.appendTurn(scope,{role:'user',kind:'discussion',text:'这是我给自己记读书笔记的小网页。昨天第一次把查找功能弄好了，我挺开心。想告诉她这个小进展，也想听她平时怎么留住读到的东西。私人担忧_MARKER只是背景，不要发。'});
 const reply=await app.controller.assist({text:'帮我接她这个问题，给我能改着发的表达。'});
 assert.equal(app.calls.length,3);assert.equal(reply.kind,'draft');assert.equal(reply.suggestions.length,1);
 assert.match(reply.discussionExplanation.text,/真实进展/);assert.equal(app.run().manifest.requestDelivery.status,'delivered');
 assert.equal(app.run().requests[0].manifest.requestDelivery.status,'planned');
 assert.equal(app.run().requests[1].purpose,'delivery_repair');assert.equal(app.run().requests.some(r=>r.purpose==='plain_response_recovery'),false);
});
for(const [text,purpose]of [
 ['先讨论，不要替我写话。','discussion'],['为什么你觉得这个方向合适？不要给句子。','draft'],
 ['她说“帮我写一段介绍”，我想理解她为什么这么说。','discussion'],['把刚才邀请的目的先结束，不代表她拒绝我。','discussion'],
 ['我只是想比较可能的话题，先头脑风暴。','discussion']
])test(`current private request stays one call across transport: ${text}`,async t=>{
 const app=await setup(t,p=>({kind:'discussion',text:'可以一起理清这次的意思。',requestDelivery:interpretation(p,'private_help')}));
 actualIncoming(app);const reply=await app.controller.assist({text,purpose});
 assert.equal(reply.kind,'discussion');assert.equal(app.calls.length,1);assert.equal(app.run().manifest.requestDelivery.status,'private_help');
 assert.deepEqual(app.calls[0].p.methodCards,purpose==='discussion'?[]:app.calls[0].p.methodCards);
});
test('no incoming QQ is needed for a current authorized self-share; not inviting still allows complete expression',async t=>{
 const text='不要邀请她。今天我的番茄发芽了，给我一条完整表达告诉她这事。';
 const app=await setup(t,p=>p.purpose==='draft'?{kind:'draft',text:'分享',suggestions:[{style:'自然',text:'我今天种的番茄发芽了，突然觉得这盆有希望了哈哈。'}]}:
  {kind:'discussion',text:'只分享这件事。',requestDelivery:interpretation(p),draftPlan:plan(p,[{sourceId:p.userRequest.sourceId,text:'今天我的番茄发芽了'}])});
 const reply=await app.controller.assist({text});assert.equal(reply.suggestions.length,1);assert.equal(app.calls.length,2);assert.equal(app.calls[1].p.sources.length,0);
});
for(const kind of ['missing_fact','missing_authorization'])test(`specific private ${kind} blocker stops before wording`,async t=>{
 const app=await setup(t,p=>({kind:'question',text:'先核对一下：你愿意向她说出具体住址吗？',requestDelivery:{...interpretation(p),blocker:{kind,missing:'是否愿意透露具体住址',question:'你愿意向她说出具体住址吗？'}}}));
 const reply=await app.controller.assist({text:'帮我告诉她住址，但我还没决定分享范围。'});
 assert.equal(reply.kind,'question');assert.equal(app.calls.length,1);assert.equal(app.run().manifest.requestDelivery.status,'blocked');
});
test('missing delivery cannot be salvaged by rejected auxiliary state or plain fallback; one repair only',async t=>{
 const app=await setup(t,p=>({...actual005,requestDelivery:interpretation(p),statePatch:{unauthorized:'bad'}}));
 await assert.rejects(app.controller.assist({text:'给我能改着发的表达。'}),/editable message still missing/);
 assert.equal(app.calls.length,2);assert.equal(app.run().status,'failed');assert.equal(app.calls[1].wrapper.purpose,'discussion');
});
test('shared HTTP quota includes structured fulfillment repair and restricts final compose',async t=>{
 const app=await setup(t,(p,w)=>!w.originalInput?actual005:{kind:'discussion',text:'准备回应',requestDelivery:interpretation(p),draftPlan:plan(p)}, {limit:2});
 actualIncoming(app);await assert.rejects(app.controller.assist({text:'给我能改着发的表达。'}),/预算|上限/);
 assert.equal(app.calls.length,2);assert.equal(app.run().requests[0].manifest.requestDelivery.status,'planned');assert.notEqual(app.run().manifest.requestDelivery?.status,'delivered');
});
test('current authority excludes older quotes, and sticky delivery cannot downgrade after lookup',()=>{
 const p={purpose:'discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:'private:current'},sources:[{id:'private:old',type:'private',role:'user',text:'以前写过'}, {id:'private:current',type:'private',role:'user',text:'现在帮我写话'}],taskContext:{auxiliaryPolicy:'best_effort'}};
 assert.throws(()=>parseAssistant({...actual005,requestDelivery:{mode:'private_help',sourceId:'private:old',quote:'以前写过'}},'discussion',p),/CURRENT/);
 const lookup=parseAssistant({...actual005,requestDelivery:interpretation(p),lookup:{sourceIds:['private:old']}},'discussion',p);assert.ok(lookup.lookup);
 p.requestDeliveryPolicy.obligation=lookup.requestDelivery;
 assert.throws(()=>parseAssistant({...actual005,requestDelivery:interpretation(p,'private_help')},'discussion',p),/downgraded/);
});
test('neutral consultation method navigation ignores incoming hint and exposes optional catalog; result schema requires core contract',()=>{
 assert.deepEqual(selectMethods({purpose:'discussion',hasReply:true}).methods,[]);
 assert.equal(selectMethods({purpose:'discussion'}).catalog.length,8);
 const p={purpose:'discussion',requestDeliveryPolicy:{version:1,intentSourceId:'private:current'}};
 const request=prepareAssistantRequest({model:'claude-sonnet-4-6'},p,[]).request;
 assert.ok(request.tools[0].function.parameters.required.includes('requestDelivery'));
});
test('actual lookup continuation preserves the request-local obligation through structured repair, then releases it for a new user turn',async t=>{
 const app=await setup(t,(p,w)=>{
  if(p.purpose==='draft')return {kind:'draft',text:'参考表达',suggestions:[{style:'自然',text:'你做这个小网页最喜欢哪一部分？'}]};
  if(p.userRequest.text==='现在只讨论为什么，不要写。')return {kind:'discussion',text:'可以私下解释选择依据。',requestDelivery:interpretation(p,'private_help')};
  if(!p.lookupHistory.length)return {...actual005,requestDelivery:interpretation(p),lookup:{sourceIds:[p.sources.find(s=>s.type==='qq').id]}};
  assert.equal(p.requestDeliveryPolicy.obligation.mode,'editable_message');
  if(!w.originalInput)return {...actual005,requestDelivery:interpretation(p,'private_help')};
  return {kind:'discussion',text:'按已确认的本轮意思组织表达。',requestDelivery:interpretation(p),draftPlan:plan(p)};
 });
 actualIncoming(app);await app.controller.assist({text:'帮我给她一句能改着发的话。'});
 assert.equal(app.calls.length,4);assert.equal(app.run().requests[0].manifest.requestDelivery.status,'looking_up');
 assert.equal(app.run().manifest.requestDelivery.status,'delivered');
 await app.controller.assist({text:'现在只讨论为什么，不要写。'});
 assert.equal(app.calls.length,5);assert.equal(app.calls[4].p.requestDeliveryPolicy.obligation,undefined);assert.equal(app.run().manifest.requestDelivery.status,'private_help');
});
for(const kind of ['discussion','question'])test(`terminal ${kind} without a blocker fails instead of completing an editable request`,async t=>{
 const app=await setup(t,p=>p.purpose==='draft'?{kind,text:'先想清楚方向再表达。'}:
  {kind:'discussion',text:'准备组织表达',requestDelivery:interpretation(p),draftPlan:plan(p)});
 actualIncoming(app);await assert.rejects(app.controller.assist({text:'给我能改着发的话。'}),/terminal editable-message delivery missing/);
 assert.equal(app.run().status,'failed');assert.equal(app.calls.length,3);
 assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});
test('terminal strategy uses the one task fulfillment repair with restricted input and produces actual wording',async t=>{
 const app=await setup(t,(p,w)=>p.purpose==='draft'?
  w.originalInput?{kind:'draft',text:'可编辑表达',suggestions:[{style:'自然',text:'你做这个网页最喜欢哪一部分？'}]}:{kind:'discussion',text:'先围着她的具体问题回应。'}:
  {kind:'discussion',text:'准备组织表达',requestDelivery:interpretation(p),draftPlan:plan(p)});
 actualIncoming(app);const reply=await app.controller.assist({text:'给我能改着发的话。 PRIVATE_TERMINAL_MARKER只是私下背景。'});
 assert.equal(reply.suggestions.length,1);assert.equal(app.calls.length,3);assert.equal(app.run().manifest.requestDelivery.status,'delivered');
 const repair=app.calls[2];assert.equal(repair.wrapper.purpose,'draft');assert.equal(repair.p.userRequest,undefined);assert.equal(repair.p.goal,undefined);
 assert.equal(JSON.stringify(repair.request).includes('PRIVATE_TERMINAL_MARKER'),false);
 assert.equal(app.run().requests.filter(request=>request.purpose==='delivery_repair').length,1);
});
for(const kind of ['missing_fact','missing_authorization'])test(`terminal specific ${kind} is a valid private waiting question`,async t=>{
 const blocker={kind,missing:'这周可用的时间与分享范围',question:'你愿意告诉她这周哪天有空吗？'};
 const app=await setup(t,p=>p.purpose==='draft'?{kind:'question',text:blocker.question,deliveryBlocker:blocker}:
  {kind:'discussion',text:'准备组织表达',requestDelivery:interpretation(p),draftPlan:plan(p)});
 actualIncoming(app);const reply=await app.controller.assist({text:'给我能改着发的话。'});
 assert.equal(reply.kind,'question');assert.equal(reply.suggestions,undefined);assert.equal(app.calls.length,2);
 assert.equal(app.run().manifest.requestDelivery.status,'blocked');assert.deepEqual(app.run().manifest.requestDelivery.blocker,blocker);
});
test('third lookup cannot synthesize a generic completed question and uses the same terminal repair contract',async t=>{
 const blocker={kind:'missing_fact',missing:'用户周末是否有空',question:'你周末有空吗？'};
 const app=await setup(t,(p,w)=>w.originalInput?{kind:'question',text:blocker.question,requestDelivery:{...interpretation(p),blocker}}:
  {...actual005,requestDelivery:interpretation(p),lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]}});
 actualIncoming(app);const reply=await app.controller.assist({text:'帮我接话，给我完整表达。'});
 assert.equal(app.calls.length,4);assert.equal(reply.text,blocker.question);assert.equal(app.run().manifest.requestDelivery.status,'blocked');
 assert.equal(app.calls[3].p.requestDeliveryPolicy.lookupExhausted,true);
});
test('lookup exhaustion with no remaining HTTP budget fails visibly and preserves the user input',async t=>{
 const app=await setup(t,p=>({...actual005,requestDelivery:interpretation(p),lookup:{sourceIds:[p.sources.find(source=>source.type==='qq').id]}}),{limit:3});
 actualIncoming(app);await assert.rejects(app.controller.assist({text:'给我完整表达。'}),error=>error.code==='request_budget_exhausted');
 assert.equal(app.calls.length,3);assert.equal(app.run().status,'failed');assert.ok(app.controller.assistantError);
 assert.ok(app.store.getCompanion(scope).turns.some(turn=>turn.role==='user'&&turn.text==='给我完整表达。'));
});
test('a terminal delivery failure cannot obtain a second fulfillment repair after preparation used it',async t=>{
 const app=await setup(t,(p,w)=>p.purpose==='draft'?{kind:'discussion',text:'先围着实际问题回应。'}:
  w.originalInput?{kind:'discussion',text:'准备表达',requestDelivery:interpretation(p),draftPlan:plan(p)}:actual005);
 actualIncoming(app);await assert.rejects(app.controller.assist({text:'给我完整表达。'}),error=>error.code==='request_delivery_repair_exhausted');
 assert.equal(app.calls.length,3);assert.equal(app.run().status,'failed');
});
test('source-bound intent does not grant disclosure of a discussion-only note, even during repair',async t=>{
 let hiddenId;
 const app=await setup(t,p=>({kind:'discussion',text:'准备表达',requestDelivery:interpretation(p),draftPlan:plan(p,[{sourceId:hiddenId,text:'PRIVATE_ONLY_NOTE'}])}));
 hiddenId=`note:${app.store.saveNote(scope,{text:'PRIVATE_ONLY_NOTE',use:'discussion'}).id}`;
 actualIncoming(app);await assert.rejects(app.controller.assist({text:'给我一条完整表达，但私下笔记不可发。'}),/私下讨论|未能对应/);
 assert.equal(app.calls.length,2);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);
});
test('scope change while fulfillment repair is pending prevents publication',async t=>{
 let finish;
 const app=await setup(t,(p,w)=>!w.originalInput?actual005:new Promise(resolve=>{finish=()=>resolve({kind:'discussion',text:'准备表达',requestDelivery:interpretation(p),draftPlan:plan(p)});}));
 actualIncoming(app);const pending=app.controller.assist({text:'给我能改着发的话。'});
 for(let i=0;i<20&&!finish;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(finish);app.controller.scope={...scope,peerUid:'u_other',peerUin:'2222222222'};app.controller.epoch++;app.controller.invalidateAssistant();finish();
 await pending;assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.calls.length,2);
});
test('a wrong private-help interpretation remains visible and is not a semantic guarantee',async t=>{
 const app=await setup(t,p=>({...actual005,requestDelivery:interpretation(p,'private_help')}));
 actualIncoming(app);const reply=await app.controller.assist({text:'帮我给她一条能改着发的表达。'});
 assert.equal(app.calls.length,1);assert.equal(reply.suggestions,undefined);assert.equal(app.run().manifest.requestDelivery.interpretation.mode,'private_help');
 // Independent actual-output review must still reject this task mismatch;
 // core validation cannot prove the model correctly understood the request.
});
test('only one fulfillment correction is allowed across the entire request, including lookup passes',async t=>{
 const app=await setup(t,(p,w)=>w.originalInput?{...actual005,requestDelivery:interpretation(p),lookup:{sourceIds:[p.sources.find(s=>s.type==='qq').id]}}:
  {...actual005,requestDelivery:interpretation(p)}, {limit:8});
 actualIncoming(app);await assert.rejects(app.controller.assist({text:'给我完整可改发的话。'}),error=>error.code==='request_delivery_repair_exhausted');
 assert.equal(app.calls.length,3);assert.equal(app.run().status,'failed');
 assert.equal(app.run().requests.filter(request=>request.purpose==='delivery_repair').length,1);
});
test('both cannot skip the private explanation while supplying a plan',()=>{
 const p={purpose:'discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:'private:c'},sources:[{id:'private:c',type:'private',role:'user',text:'解释并给一句'}]};
 assert.throws(()=>parseAssistant({requestDelivery:interpretation(p,'both'),draftPlan:{quotes:[],intent:'reply'}},'discussion',p),/private explanation/);
});
test('restricted result schema exposes the same terminal wording-or-blocker contract without private input',()=>{
 const p={purpose:'draft',requestDeliveryObligation:{version:1,mode:'editable_message'},sources:[],outboundQuotes:[]};
 const request=prepareAssistantRequest({model:'claude-sonnet-4-6'},p,[]).request;
 const schema=request.tools[0].function.parameters;
 assert.deepEqual(schema.properties.kind.enum,['draft','question']);assert.equal(schema.oneOf,undefined);assert.equal(schema.anyOf,undefined);
 assert.match(schema.properties.deliveryBlocker.description,/Required for kind=question/);assert.match(schema.properties.suggestions.description,/Optional legacy candidates/);assert.ok(schema.properties.deliveryBlocker.required.includes('missing'));
});
