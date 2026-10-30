'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {selectMethods,compactOperationalCards,METHOD_VERSION}=require('../src/help-methods.cjs');
const {HELP_BEHAVIOR}=require('../src/help-behavior.cjs');
const {prepareAssistantRequest}=require('../src/assistant-model.cjs');

test('reply transports remain hints rather than explicit choices of a help method',()=>{
 for(const purpose of ['reply','suggest']){
  const transport=selectMethods({purpose,hasReply:true});
  assert.equal(transport.selection,'transport_hint');
  assert.equal(transport.methods[0].id,'respond');
  assert.equal(transport.catalog.length,8);
  assert.deepEqual(new Set(transport.catalog.map(item=>item.id)),new Set(compactOperationalCards().map(item=>item.id)));
 }
 assert.equal(selectMethods({purpose:'respond'}).selection,'explicit');
 assert.equal(selectMethods({purpose:'review'}).selection,'explicit');
 assert.equal(selectMethods({purpose:'discussion'}).selection,'candidates');
 assert.equal(selectMethods({purpose:'draft'}).methods.length,1);
 assert.match(METHOD_VERSION,/^goal-methods-/);
});

test('production help and recovery lanes share present-task reasoning within the existing instruction budget',()=>{
 const source={id:'request:current',type:'request',role:'user',text:'A fictional current request.',revision:'r1'};
 const payload={purpose:'reply',generationOrigin:'qq_observation',sources:[source],userRequest:{sourceId:source.id,text:source.text}};
 for(const purpose of ['reply','draft_prepare','draft','plain_help_recovery','plain_draft_recovery']){
  const prompt=prepareAssistantRequest({model:'fixture'}, {...payload,purpose}).request.messages[0].content;
  assert.ok(prompt.includes(HELP_BEHAVIOR));
  assert.match(prompt,/invocation/,'the shared workflow must consume the actual invocation instead of inventing a current intent');
  assert.match(prompt,/时间|时刻/);
  assert.match(prompt,/重新联系/);
  assert.match(prompt,/自我分享/);
  assert.match(prompt,/了解/);
  assert.match(prompt,/邀请|活动/);
  assert.match(prompt,/表意|表达好感/);
  assert.match(prompt,/暂缓/);
 }
 assert.ok(Buffer.byteLength(HELP_BEHAVIOR)<=5083,'the rewritten workflow replaces rather than accumulates guidance');
 const foreground=prepareAssistantRequest({model:'fixture'},payload).request.messages[0].content;
 assert.ok(Buffer.byteLength(foreground)<12000);
});

test('restricted wording preserves a chosen relevant question while limiting unsolicited tail questions',()=>{
 for(const purpose of ['draft','plain_draft_recovery']){
  const prompt=prepareAssistantRequest({model:'fixture'},{purpose,sources:[],presentation:{askFollowup:false}}).request.messages[0].content;
  assert.match(prompt,/askFollowup=false[^。]*尾问/);
  assert.match(prompt,/guidance[^。]*相关问题[^。]*保留/);
 }
});
