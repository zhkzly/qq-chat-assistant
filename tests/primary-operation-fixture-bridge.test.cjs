'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareAssistantRequest,parseAssistant}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {canonicalSourceView,wireSourceView}=require('./fixtures/source-wire.cjs');
const {scope}=require('./fixtures/native.cjs');
function fixture({policy=true,intent=true,required=false}={}){
 const current={id:'private:current',revision:'current-r1',type:'private',role:'user',text:'想把已选笔记告诉她，给我完整表达。'};
 const payload={purpose:'discussion',...(intent?{intentAuthority:{sourceId:current.id}}:{}),userRequest:{sourceId:current.id,text:current.text},...(policy?{requestDeliveryPolicy:{version:1,...(required?{obligation:{mode:'editable_message'}}:{})}}:{}),draftMaterialPolicy:{version:1},allowedMaterialIds:['note:allowed'],
  sources:[current,{id:'private:old',revision:'old-r1',type:'private',role:'user',text:'OLD_PRIVATE_FACT'},{id:'note:allowed',revision:'note-r1',type:'note',use:'draft',text:'已选的真实笔记事实'}],methodCards:[{id:'respond',version:'fixture-v1',instruction:'Fixture instruction.',outputKinds:['discussion']}]};
 const prepared=prepareAssistantRequest({model:'synthetic',sourceHandleOwner:new SourceHandleOwner({scope,taskId:'fixture-operation'})},payload,[]);
 prepared.sourceWire.commit();prepared.primaryFrame.commit();
 const context={payload,manifest:{scope},sourceWireSnapshot:prepared.sourceWire,primaryFrameSnapshot:prepared.primaryFrame};
 const bridge=value=>wireSourceView(value,prepared.sourceWire.receipt,prepared.primaryFrame.receipt,payload);
 const declaration=(mode='editable_message')=>({mode,sourceId:current.id,quote:current.text});
 const plan={quotes:[{sourceId:'note:allowed',text:'已选的真实笔记事实'}]};
 return {payload,prepared,context,bridge,declaration,plan};
}
test('canonical operation input DTO restores only exact captured private policy and card witnesses',()=>{
 const f=fixture(),wire=f.prepared.wirePayload,raw=JSON.stringify(wire);
 assert.equal(wire.requestDeliveryPolicy,undefined);assert.equal(wire.operationProtocol.version,'primary-operation-v1');assert.equal(wire.methodCards[0].outputKinds,undefined);
 assert.deepEqual(canonicalSourceView(wire,f.prepared.sourceWire.receipt,f.payload),f.payload);
 const unbound=canonicalSourceView(wire,f.prepared.sourceWire.receipt);assert.equal(unbound.requestDeliveryPolicy,undefined);assert.equal(unbound.methodCards[0].outputKinds,undefined);
 const different={...f.payload,methodCards:[{...f.payload.methodCards[0],instruction:'Different captured instruction.'}]};
 assert.equal(canonicalSourceView(wire,f.prepared.sourceWire.receipt,different).methodCards[0].outputKinds,undefined,'do not guess omitted card metadata from a different capture');
 assert.equal(JSON.stringify(wire),raw,'DTO restoration never changes the actual request');
});
test('declared message plan becomes prepare_message and still passes exact material admission',()=>{
 const f=fixture(),old={kind:'discussion',text:'准备已选笔记。',requestDelivery:f.declaration('both'),draftPlan:f.plan},original=structuredClone(old),wire=f.bridge(old);
 assert.equal(wire.operation,'prepare_message');assert.equal(wire.kind,undefined);assert.equal(wire.requestDelivery,undefined);assert.equal(wire.draftPlan.quotes[0].text,undefined);
 assert.equal(parseAssistant(wire,'discussion',f.context).draftPlan.quotes[0].text,'已选的真实笔记事实');assert.deepEqual(old,original);
});
for(const [mode,continuation]of [['private_help','advise'],['editable_message','prepare_message'],['both','prepare_message']])test(`declared ${mode} lookup preserves its explicit continuation`,()=>{
 const f=fixture(),wire=f.bridge({kind:'discussion',text:'先读取。',requestDelivery:f.declaration(mode),lookup:{sourceIds:['note:allowed']}});
 assert.equal(wire.operation,'lookup');assert.equal(wire.continuation,continuation);assert.equal(parseAssistant(wire,'discussion',f.context).lookup.sourceIds[0],'note:allowed');
});
test('private_help plus a plan never becomes preparation and retains the mixed-branch error',()=>{
 const f=fixture(),wire=f.bridge({kind:'discussion',text:'只讨论。',requestDelivery:f.declaration('private_help'),draftPlan:f.plan});
 assert.equal(wire.operation,'advise');assert.ok(wire.draftPlan);assert.throws(()=>parseAssistant(wire,'discussion',f.context),/not active for advise/);
});
test('editable strategy without plan stays a missing-plan preparation instead of being salvaged as advice',()=>{
 const f=fixture(),wire=f.bridge({kind:'discussion',text:'只有策略。',requestDelivery:f.declaration()});
 assert.equal(wire.operation,'prepare_message');assert.equal(wire.draftPlan,undefined);assert.throws(()=>parseAssistant(wire,'discussion',f.context),/requires a plan object/);
});
test('structured clarification owns its body and never promotes old untyped text',()=>{
 const f=fixture(),blocker={kind:'missing_fact',missing:'具体时间',question:'你哪天有空？',explanation:'安排取决于实际空闲时间。'},wire=f.bridge({kind:'question',text:'OLD_UNTYPED_你什么时候方便？',requestDelivery:{...f.declaration(),blocker}});
 assert.equal(wire.operation,'clarify');assert.deepEqual(wire.blocker,blocker);assert.equal(wire.text,undefined);
 const result=parseAssistant(wire,'discussion',f.context);assert.equal(result.text,blocker.explanation+'\n\n'+blocker.question);assert.equal(result.discussionExplanation,undefined);
});
test('pure legacy clarification can translate without inventing a question from prose',()=>{
 const f=fixture({policy:false}),wire=f.bridge({draftPlan:{clarification:'你愿意分享哪个真实近况？'}});
 assert.equal(wire.operation,'clarify');assert.equal(wire.blocker.question,'你愿意分享哪个真实近况？');assert.equal(wire.draftPlan,undefined);
 const privateQuestion=f.bridge({kind:'question',text:'你更在意哪一部分？'});assert.equal(privateQuestion.operation,'advise');assert.equal(privateQuestion.blocker,undefined);
});
test('wrong current source and missing required old declaration remain invalid',()=>{
 for(const alter of [f=>({kind:'discussion',text:'准备。',requestDelivery:{...f.declaration(),sourceId:'private:old'},draftPlan:f.plan}),f=>({kind:'discussion',text:'准备。',draftPlan:f.plan})]){
  const f=fixture(),wire=f.bridge(alter(f));assert.throws(()=>parseAssistant(wire,'discussion',f.context));assert.notEqual(wire.operation,'prepare_message');
 }
});
test('wrong proof and missing historical authority are never filled or fixed',()=>{
 for(const authorization of [undefined,{permission:{sourceId:'private:current',text:'想把已选笔记告诉她，给我完整表达。'},referent:{sourceId:'note:allowed',text:'已选的真实笔记事实'}}]){
  const f=fixture(),wire=f.bridge({kind:'discussion',text:'准备。',requestDelivery:f.declaration(),draftPlan:{quotes:[{sourceId:'private:old',text:'OLD_PRIVATE_FACT',...(authorization?{authorization}:{})}]}});
  assert.equal(wire.operation,'prepare_message');assert.throws(()=>parseAssistant(wire,'discussion',f.context));
  if(!authorization)assert.equal(wire.draftPlan.quotes[0].authorityRef,undefined);else assert.deepEqual(wire.draftPlan.quotes[0].authorization.referent.text,'已选的真实笔记事实');
 }
});
test('mixed cores and malformed kind/text remain rejected while auxiliary data is retained',()=>{
 const f=fixture(),wire=f.bridge({kind:'discussion',text:'准备。',requestDelivery:f.declaration(),draftPlan:f.plan,lookup:{sourceIds:['note:allowed']},actions:[{type:'save_note',evidenceQuote:'未授权动作'}]});
 assert.ok(wire.draftPlan&&wire.lookup);assert.equal(wire.actions[0].evidenceQuote,'未授权动作');assert.throws(()=>parseAssistant(wire,'discussion',f.context),/not active/);
 for(const invalid of [{kind:'draft',text:'错误主阶段'}, {kind:'discussion',text:''}, {kind:'discussion',text:42}])assert.throws(()=>parseAssistant(f.bridge({...invalid,requestDelivery:f.declaration(),draftPlan:f.plan}),'discussion',f.context));
});
test('new operations and non-primary carriers are not legacy-upgraded',()=>{
 const f=fixture(),unknown={operation:'unknown',kind:'discussion',text:'保留非法字段'};assert.deepEqual(f.bridge(unknown),unknown);assert.throws(()=>parseAssistant(f.bridge(unknown),'discussion',f.context));
 for(const purpose of ['draft','memory','discussion_compaction','plain_help_recovery','plain_draft_recovery']){
  const value={kind:'discussion',text:'原有载体',requestDelivery:{mode:'private_help'}},wire=wireSourceView(value,f.prepared.sourceWire.receipt,f.prepared.primaryFrame.receipt,{...f.payload,purpose});
  assert.equal(wire.operation,undefined);assert.equal(wire.kind,value.kind);
 }
});
test('only valid obsolete reply dispositions are removed during otherwise valid legacy conversion',()=>{
 for(const replyDisposition of ['wait','clarify','unavailable']){
  const f=fixture(),wire=f.bridge({kind:'discussion',text:'私下说明。',replyDisposition,requestDelivery:f.declaration('private_help')});
  assert.equal(wire.operation,'advise');assert.equal(wire.replyDisposition,undefined);assert.equal(parseAssistant(wire,'discussion',f.context).text,'私下说明。');
 }
 const f=fixture();assert.throws(()=>parseAssistant(f.bridge({kind:'discussion',text:'私下说明。',replyDisposition:'send',requestDelivery:f.declaration('private_help')}),'discussion',f.context));
});
test('central fixture plumbing restores captured policy for legacy declaration but never adds one to a new operation',async()=>{
 const {assistModel}=require('./fixtures/assistant-protocol.cjs');
 for(const value of [{kind:'discussion',text:'旧夹具私下说明。'},{operation:'advise',text:'新操作私下说明。'}]){
  const f=fixture(),context={payload:structuredClone(f.payload),manifest:{scope}},calls=[];
  const result=await assistModel({model:'synthetic',anonymous:true,baseUrl:'http://fixture.invalid/v1'},context,undefined,async(_url,args)=>{
   calls.push(JSON.parse(args.body));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{status:200});
  });
  assert.equal(calls.length,1);assert.equal(result.text,value.text);assert.equal(context.manifest.primaryOperation.operation,'advise');
 }
});
test('central fixture leaves an explicitly unknown operation byte-identical for the strict bounded repair',async()=>{
 const {assistModel}=require('./fixtures/assistant-protocol.cjs'),f=fixture(),context={payload:f.payload,manifest:{scope}},raw=JSON.stringify({operation:'unknown',text:'不可更改未知操作'});let calls=0;
 await assert.rejects(assistModel({model:'synthetic',anonymous:true,baseUrl:'http://fixture.invalid/v1'},context,undefined,async()=>{
  calls++;return new Response(JSON.stringify({choices:[{message:{content:raw}}]}),{status:200});
 }),/choose advise, prepare_message, lookup or clarify/);
 assert.equal(calls,2);assert.equal(context.extraRequests[0].payload.invalidResponse,raw);
});
test('a message fixture without an actual captured intent binding needs an explicit caller update',()=>{
 const f=fixture({intent:false}),wire=f.bridge({kind:'discussion',text:'准备。',requestDelivery:f.declaration(),draftPlan:f.plan});
 assert.equal(wire.operation,undefined);assert.equal(wire.requestDelivery.sourceId,'s1');assert.throws(()=>parseAssistant(wire,'discussion',f.context));
});
test('a wire artifact obligation never becomes an invented legacy declaration during DTO restoration',()=>{
 const f=fixture({required:true}),wire=f.prepared.wirePayload;
 assert.equal(wire.operationProtocol.requiredArtifact,'message');assert.equal(canonicalSourceView(wire,f.prepared.sourceWire.receipt).requestDeliveryPolicy,undefined);
 assert.deepEqual(canonicalSourceView(wire,f.prepared.sourceWire.receipt,f.payload).requestDeliveryPolicy,f.payload.requestDeliveryPolicy);
});
test('an invalid private_help blocker is retained as inactive payload instead of upgraded to clarify',()=>{
 const f=fixture(),blocker={kind:'missing_fact',missing:'具体时间',question:'你哪天有空？'};
 const wire=f.bridge({kind:'question',text:blocker.question,requestDelivery:{...f.declaration('private_help'),blocker}});
 assert.equal(wire.operation,'advise');assert.deepEqual(wire.blocker,blocker);assert.throws(()=>parseAssistant(wire,'discussion',f.context),/not active for advise/);
});
test('private_help with a pure clarification plan remains a contradictory private plan',()=>{
 const f=fixture(),plan={clarification:'你哪天有空？'},wire=f.bridge({kind:'question',text:plan.clarification,requestDelivery:f.declaration('private_help'),draftPlan:plan});
 assert.equal(wire.operation,'advise');assert.deepEqual(wire.draftPlan,plan);assert.throws(()=>parseAssistant(wire,'discussion',f.context),/not active for advise/);
});
test('required-policy editable clarification needs its existing typed blocker rather than a fabricated one',()=>{
 const f=fixture(),legacy={kind:'question',text:'旧的未类型化正文',draftPlan:{clarification:'你哪天有空？'}};
 const invalid=f.bridge({...legacy,requestDelivery:f.declaration()});assert.equal(invalid.operation,'prepare_message');assert.equal(invalid.blocker,undefined);assert.deepEqual(invalid.draftPlan,legacy.draftPlan);
 assert.throws(()=>parseAssistant(invalid,'discussion',f.context),/clarification/);
 const {withRequestDelivery}=require('../scripts/synthetic-request-delivery.cjs');
 const permitted=f.bridge(withRequestDelivery(legacy,f.payload));assert.equal(permitted.operation,'clarify');assert.equal(permitted.text,undefined);assert.equal(permitted.blocker.question,legacy.draftPlan.clarification);
 assert.equal(parseAssistant(permitted,'discussion',f.context).text,legacy.draftPlan.clarification);
});
