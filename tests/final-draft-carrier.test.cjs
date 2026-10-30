'use strict';
const {wireSourceView,canonicalSourceView}=require('./fixtures/source-wire.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {parseAssistant,assistModel}=require('../src/assistant-model.cjs');
const {Controller}=require('../src/controller.cjs');
const {Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
// Exact actual014 selected-model content from fictional development transport.
// These outputs are protocol fixtures, not expected conversational judgments.
const actualContents=["{\"kind\":\"draft\",\"text\":\"就是给自己记读书笔记用的，昨天刚把查找功能弄好，我还挺开心的。你平时怎么留住读到的东西呀？\",\"suggestions\":[{\"style\":\"自然\",\"text\":\"主要是想方便自己记读书笔记，昨天终于把查找功能弄好了，挺有成就感的。你平时会怎么记读到的东西？\"}]}", "{\"kind\":\"draft\",\"text\":\"这是我给自己记读书笔记的小网页，昨天刚把查找功能弄好，还挺开心的。你平时会怎么记读到的东西？\",\"suggestions\":[{\"style\":\"自然\",\"text\":\"这是我给自己记读书笔记的小网页，昨天刚把查找功能弄好，还挺开心的。你平时会怎么记读到的东西？\"}]}", "{\"kind\":\"draft\",\"text\":\"外面还好好的确实有点舍不得换。我以前也给旧帆布包补过内衬，最难的是把里面的布角对齐。\"}"];
const actualHashes=["8652f3561c67e090ebc479ba6c07b9bbbcb5b2544e92ca50f5f7a62b64ab04a0", "bd2c4022c3b1ea362d063ad62c574cdb1b7a10c22633f12692126cc0b19fa007", "440b08c411264aca1dd997f16390cc56c5b6f0415bbe0600e49022aa80398bdb"];
const actualNoteText="我以前给一个旧帆布包补过内衬，最难的是把里面的布角对齐。我愿意把这件小经历告诉她，但没有修过她的包，也不是专业裁缝。";
const actualQuote={"sourceId": "note:n1", "text": "我以前给一个旧帆布包补过内衬，最难的是把里面的布角对齐。"};
const actualFinal=JSON.parse(actualContents[2]),body=actualFinal.text,sha=text=>createHash('sha256').update(text).digest('hex');
const finalPayload=()=>({purpose:'draft',requestDeliveryObligation:{mode:'editable_message'},sources:[],outboundQuotes:[structuredClone(actualQuote)]});
test('actual014 final carrier and legacy candidates retain exact raw-content hashes',()=>{
 assert.deepEqual(actualContents.map(sha),actualHashes);
 assert.equal(actualHashes[2],'440b08c411264aca1dd997f16390cc56c5b6f0415bbe0600e49022aa80398bdb');
 assert.equal(actualFinal.kind,'draft');assert.equal(Object.hasOwn(actualFinal,'suggestions'),false);assert.ok(body.length<=1200);
});
for(const empty of [false,true])test(`restricted kind:draft text-only carrier with ${empty?'empty':'absent'} suggestions becomes exactly one editable candidate`,()=>{
 const value={...actualFinal,...(empty?{suggestions:[]}:{})},original=structuredClone(value),result=parseAssistant(value,'draft',finalPayload(),{});
 assert.equal(result.kind,'draft');assert.equal(result.suggestions.length,1);assert.equal(result.suggestions[0].style,'自然');assert.equal(result.suggestions[0].text,body);
 assert.deepEqual(value,original,'compatibility must not mutate the original provider object');
});
for(const size of [1,1200])test(`restricted text-only candidate accepts exact nonempty body boundary ${size}`,()=>{
 const text='字'.repeat(size),result=parseAssistant({kind:'draft',text},'draft',finalPayload(),{});assert.equal(result.suggestions.length,1);assert.equal(result.suggestions[0].text,text);
});
for(const value of [
 {kind:'draft',text:body,suggestions:null},
 {kind:'draft',text:body,suggestions:'not an array'},
 {kind:'draft',text:body,suggestions:{}},
 {kind:'draft',text:body,suggestions:[null]},
 {kind:'draft',text:body,suggestions:[{}]},
 {kind:'draft',text:body,suggestions:[{style:'自然',text:''}]},
 {kind:'draft',text:body,suggestions:[{style:7,text:'不合法样式'}]},
 {kind:'draft',text:body,suggestions:[{style:'自然',text:'字'.repeat(1201)}]},
 {kind:'draft',text:'字'.repeat(1201)},
 {kind:'draft',text:''},
 {kind:'draft',text:'   '},
 {kind:'discussion',text:body},
 {kind:'question',text:body},
 {kind:'unknown',text:body},
 {text:body},
 {kind:'draft',text:body,deliveryBlocker:{kind:'missing_fact',missing:'时间',question:'哪天方便？'}},
 {kind:'draft',text:body,blocker:{kind:'missing_fact',missing:'时间',question:'哪天方便？'}},
 {kind:'draft',text:body,requestDelivery:{blocker:{kind:'missing_authorization',missing:'范围',question:'可以分享哪部分？'}}}
])test(`malformed or non-draft carrier is not repaired by treating text as a candidate: ${JSON.stringify(value).slice(0,90)}`,()=>{
 assert.throws(()=>parseAssistant(structuredClone(value),'draft',finalPayload(),{}));
});
for(const index of [0,1])test(`actual014 sequence${index===0?3:7} nonempty legacy suggestions remain authoritative over text`,()=>{
 const value=JSON.parse(actualContents[index]),result=parseAssistant(actualContents[index],'draft',finalPayload(),{});
 assert.deepEqual(result.suggestions,value.suggestions);if(index===0)assert.notEqual(result.suggestions[0].text,value.text);
});
test('valid nonempty legacy string suggestions remain authoritative',()=>{
 const result=parseAssistant({kind:'draft',text:body,suggestions:['既有候选原文。']},'draft',finalPayload(),{});
 assert.deepEqual(result.suggestions,[{style:'自然',text:'既有候选原文。'}]);
});
test('private primary discussion is never coerced into an outgoing message',()=>{
 const value={kind:'discussion',text:body},result=parseAssistant(value,'discussion',{purpose:'discussion',sources:[]},{});
 assert.equal(result.kind,'discussion');assert.equal(result.text,body);assert.equal(result.suggestions,undefined);
 assert.throws(()=>parseAssistant(actualFinal,'discussion',{purpose:'discussion',sources:[]},{}),/不能直接返回draft/);
});
test('a genuine final structured question stays private and produces no candidate',()=>{
 const blocker={kind:'missing_fact',missing:'本次具体时间',question:'你哪天方便？'},result=parseAssistant({kind:'question',text:'你哪天方便？',deliveryBlocker:blocker},'draft',finalPayload(),{});
 assert.equal(result.kind,'question');assert.equal(result.suggestions,undefined);assert.deepEqual(result.deliveryBlocker,blocker);
});
async function integrationFixture(t,{privateOnly=false}={}){
 const store=new Store(':memory:'),calls=[];
 const settings={anonymous:true,auto:false,baseUrl:'http://fixture.invalid/v1',model:'synthetic-final-carrier',assistantRequestLimit:4,discussionCompactionEnabled:false,
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-final-carrier'}};
 const controller=new Controller({store,settings,read:async command=>command==='bind'?scope:{messages:[]},assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,wrapper,p});
  let content=actualContents[2];
  if(p.purpose!=='draft'){
   const sourceId=p.intentAuthority.sourceId,quote=p.sources.find(source=>source.id===sourceId).text,requestDelivery={mode:'editable_message',sourceId,quote};
   if(p.lookupHistory.length<2){
    const id=p.lookupHistory.length===0?p.sources.find(source=>source.type==='qq').id:'note:n1';
    content=JSON.stringify({kind:'discussion',text:'核对已提供的原始材料。',requestDelivery,lookup:{sourceIds:[id]}});
   }else{
    const control=text=>({text,sourceIds:[sourceId]});
    content=JSON.stringify({kind:'discussion',text:'按这次允许分享的经历回应。',requestDelivery,draftPlan:{quotes:[structuredClone(actualQuote)],intent:'reply',guidance:{objective:control('回应她当前对旧包的分享'),allowedApproach:control('仅用已经允许分享的真实旧包经历'),avoidances:[]}}});
   }
  }
  content=JSON.stringify(wireSourceView(JSON.parse(content),(wrapper.originalInput?context.extraRequests?.at(-1)?.manifest?.sourceHandles:undefined)||context.manifest.sourceHandles));
  return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200});
 })});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('72057594049927937001',false,{elements:[{textElement:{content:'这个包外面还好好的，就是里面坏了，有点舍不得换。'}}]})]});
 store.saveNote(scope,{id:'n1',text:actualNoteText,use:privateOnly?'discussion':'draft'});
 store.appendTurn(scope,{role:'user',kind:'discussion',text:'PRIVATE_REASON_DO_NOT_DISCLOSE只是背景，不用于外发。'});
 t.after(()=>{controller.close();store.close();});
 return {store,controller,calls,run:()=>store.getCompanion(scope).runs.at(-1)};
}
test('the actual final text body succeeds after all four task calls are consumed without another repair',async t=>{
 const app=await integrationFixture(t),reply=await app.controller.assist({text:'回应她现在的包；只使用我明确允许分享的小经历，给我完整表达。',taskId:'final-carrier-four-call-task'});
 assert.equal(app.calls.length,4);assert.deepEqual(app.calls.map(call=>call.p.purpose),['discussion','discussion','discussion','draft']);
 const wording=app.calls[3].p,canonical=canonicalSourceView(wording,app.run().requests.at(-1).manifest.sourceHandles);assert.deepEqual(canonical.outboundQuotes,[actualQuote]);
 assert.equal(wording.userRequest,undefined);assert.equal(wording.privateConversation,undefined);assert.equal(wording.goal,undefined);assert.equal(JSON.stringify(wording).includes('PRIVATE_REASON_DO_NOT_DISCLOSE'),false);
 assert.equal(reply.suggestions.length,1);assert.equal(reply.suggestions[0].text,body);assert.equal(app.run().status,'complete');assert.equal(app.run().manifest.requestDelivery.status,'delivered');
 assert.equal(app.run().requests.some(request=>request.purpose==='delivery_repair'||request.purpose==='plain_response_recovery'),false);
 const usage=app.controller.usage.get(scope,'final-carrier-four-call-task');assert.equal(usage.limit,4);assert.equal(usage.attempts,4);assert.equal(usage.remaining,0);assert.equal(usage.status,'complete');
 assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
test('final carrier compatibility cannot bypass a private-only source at the planning handoff',async t=>{
 const app=await integrationFixture(t,{privateOnly:true});
 await assert.rejects(app.controller.assist({text:'给我完整表达，但私下资料仍不能分享。',taskId:'final-carrier-private-only'}),/私下讨论|未能对应/);
 assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);assert.equal(app.run().status,'failed');
});
