'use strict';
function admittedQuotes(quotes){
 return quotes.map(quote=>{assert.equal(quote.provenance?.version,1);assert.equal(quote.provenance.source.sourceId,quote.sourceId);return {sourceId:quote.sourceId,text:quote.text};});
}

const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {parseAssistant,assistModel,prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {materialRefForText}=require('./fixtures/current-statement-authority.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const FACT='今天做的陶杯终于烧好了';
const PRIVATE='家人的检查结果只在这里聊';
function fixture(t){
 const store=new Store(':memory:');t.after(()=>store.close());
 store.add(scope,[normalize(raw('72057594037927939111',false,{elements:[{textElement:{content:'最近在忙什么呀？'}}]}),scope)]);
 const material=store.appendTurn(scope,{role:'user',kind:'discussion',text:`${FACT}，这件小事愿意告诉她。${PRIVATE}。`});
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'接她的问题，给一句自然的话。'});
 const args={scope,store,records:store.messages(scope),companion:store.getCompanion(scope),turn,requestId:'synthetic-material-authorization',coverage:{status:'partial'}};
 const prepared=buildContext(args),id=`private:${material.id}`;
 const quote={sourceId:id,text:FACT,authorization:{permission:{sourceId:id,text:'这件小事愿意告诉她'},referent:{sourceId:id,text:FACT}}};
 const plan=withCurrentDraftControls({intent:'reply',quotes:[quote]},prepared.payload);
 return {store,args,prepared,quote,plan,id};
}
test('an earlier explicit permission is bound to its material fragment, separate from wording and rationale',t=>{
 const {args,prepared,plan,id}=fixture(t);
 const parsed=parseAssistant({draftPlan:plan},'discussion',prepared.payload);
 const draft=buildDraftContext(prepared,parsed.draftPlan,args);
 assert.deepEqual(admittedQuotes(draft.payload.outboundQuotes),[{sourceId:id,text:FACT}]);
 assert.equal(JSON.stringify(draft.payload).includes(PRIVATE),false);
 assert.equal(JSON.stringify(draft.payload).includes('愿意告诉她'),false);
 assert.equal(draft.manifest.disclosureBindings.length,1);
 assert.equal(draft.manifest.disclosureBindings[0].intentSourceId,prepared.payload.intentAuthority.sourceId);
 assert.equal(draft.manifest.disclosureBindings[0].permission.revision,prepared.manifest.sourceRevisions[id]);
});
test('a material referent cannot transfer permission to another private fragment in the same source',t=>{
 const {args,prepared,plan,quote}=fixture(t),wrong={...plan,quotes:[{...quote,text:PRIVATE}]};
 assert.throws(()=>parseAssistant({draftPlan:wrong},'discussion',prepared.payload),/referent|披露依据/);
 assert.throws(()=>buildDraftContext(prepared,wrong,args),/referent|披露依据/);
});
test('missing permission is rejected by the planning parser, within its existing bounded repair',async t=>{
 const {prepared,plan}=fixture(t),invalid={...plan,quotes:plan.quotes.map(({authorization,...quote})=>quote)};
 assert.throws(()=>parseAssistant({draftPlan:invalid},'discussion',prepared.payload),/authorization|披露依据/);
 const calls=[],result=await assistModel({model:'synthetic',baseUrl:'http://synthetic.invalid/v1',anonymous:true},prepared,undefined,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),input=wrapper.originalInput||wrapper;calls.push(request);
  const receipt=(wrapper.originalInput?prepared.extraRequests.at(-1).manifest.sourceHandles:prepared.manifest.sourceHandles),id=receipt.bindings.find(binding=>binding.sourceId===plan.quotes[0].sourceId).handle;
  const material=input.sources.find(source=>source.id===id),body=material.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
  const authorityRef=material.authorityChoices.originalUserStatementCandidates.find(choice=>choice.materialRef===materialRefForText(material,body)).authorityRef;
  const quote={materialRef:materialRefForText(material,FACT),...(calls.length===1?{}:{authorityRef})};
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({draftPlan:{...plan,quotes:[quote]},answer:{suggestions:[{text:FACT}]}})}}]})};
 });
 assert.equal(calls.length,2);assert.ok(result.draftPlan.quotes[0].authorization);
 assert.equal(prepared.manifest.formatRepair.attempts,1);
});
test('global legacy authorizationQuote cannot authorize arbitrary historical private material',t=>{
 const {args,prepared,plan}=fixture(t),old={...plan,authorizationQuote:prepared.payload.userRequest.text,quotes:plan.quotes.map(({authorization,...quote})=>quote)};
 assert.throws(()=>buildDraftContext(prepared,old,args),/authorization|披露依据/);
});
test('later omitted private context withholds historical permission until current intent resolves it',t=>{
 const {args,prepared,plan,id}=fixture(t);
 const old=prepared.payload.sources.find(s=>s.id===id);old.historicalOnly=true;old.continuationCoverage='later_private_sources_omitted';
 assert.throws(()=>buildDraftContext(prepared,plan,args),/后续|历史|omitted/);
});
test('authorization and referent require delivered original user sources and current revisions',t=>{
 const {store,args,prepared,plan,quote,id}=fixture(t);
 for(const permission of [{sourceId:'private:missing',text:'愿意告诉她'},{sourceId:'qq:72057594037927939111',text:'最近在忙什么呀？'},{sourceId:id,text:'不存在的许可'}]){
  assert.throws(()=>buildDraftContext(prepared,{...plan,quotes:[{...quote,authorization:{...quote.authorization,permission}}]},args),/authorization|披露依据/);
 }
 store.updateTurn(scope,id.slice('private:'.length),`${FACT}，现在不分享了。`);
 assert.throws(()=>buildDraftContext(prepared,plan,args),/变化|revision/);
});
test('provider schema advertises required selectors while canonical legacy admission remains available',t=>{
 const {prepared}=fixture(t),request=prepareAssistantRequest({model:'synthetic',modelResponseMode:'result_tool'},prepared.payload).request;
 const q=request.tools[0].function.parameters.properties.draftPlan.properties.quotes.items;
 assert.equal(q.properties.materialRef.type,'string');assert.equal(q.properties.authorityRef.type,'string');assert.deepEqual(q.required,['materialRef']);assert.match(q.properties.authorityRef.description,/non-QQ.*public QQ/s);assert.equal(q.properties.authorization,undefined);
});
test('explicit UI option selection authorizes only its exact live original tuple',t=>{
 const {store,args,prepared,plan,id}=fixture(t),source=prepared.payload.sources.find(source=>source.id===id);
 const proposal=store.appendTurn(scope,{role:'assistant',kind:'options',text:'一个表达方向',expressionOptions:[{label:'分享陶杯',quotes:[{sourceId:id,text:FACT,revision:source.revision}],style:'natural'}]});
 const selection={turnId:proposal.id,index:0};
 const selected=buildContext({...args,companion:store.getCompanion(scope),selectedOption:selection});
 const draft=buildDraftContext(selected,{...plan,quotes:[{sourceId:id,text:PRIVATE}]},args);
 assert.deepEqual(admittedQuotes(draft.payload.outboundQuotes),[{sourceId:id,text:FACT}]);
 selected.payload.expressionOptions[0].quotes[0].revision='stale';
 assert.throws(()=>buildDraftContext(selected,plan,args),/版本已变化/);
});
test('quoted, negated or unresolved conditional disclosure can use existing private clarification without exporting material',t=>{
 const {prepared}=fixture(t);
 for(const text of ['你是在引用别人的许可，还是想自己分享？','你刚才说不想分享，这轮要调整范围吗？','这个条件现在满足了吗？']){
  const result=parseAssistant({kind:'question',text,draftPlan:{clarification:text}},'discussion',prepared.payload);
  assert.equal(result.draftPlan.clarification,text);assert.equal(result.draftPlan.quotes,undefined);
 }
 const packet=prepareAssistantRequest({model:'synthetic'},prepared.payload);
 assert.match(packet.request.messages[0].content,/引语\/否定\/未满足条件非许可/);
 assert.match(packet.request.messages[0].content,/完整来源和当前QQ上下文.*指代、否定、引用、已满足条件及最新限制/);
 // This verifies the clarification contract and delivered interpretation rule,
 // not that a scripted transport can judge semantic permission correctly.
});
test('a natural-language option reference preserves matching per-fragment evidence without granting its other sources',t=>{
 const {args,prepared,plan,id}=fixture(t),source=prepared.payload.sources.find(source=>source.id===id);
 prepared.payload.expressionOptions=[{turnId:'synthetic-options',index:1,label:'分享陶杯',quotes:[{sourceId:id,text:FACT,revision:source.revision}]}];
 const selected={...plan,option:{turnId:'synthetic-options',index:1}};
 const parsed=parseAssistant({draftPlan:selected},'discussion',prepared.payload).draftPlan;
 assert.ok(parsed.quotes[0].authorization);
 assert.deepEqual(admittedQuotes(buildDraftContext(prepared,parsed,args).payload.outboundQuotes),[{sourceId:id,text:FACT}]);
 assert.throws(()=>parseAssistant({draftPlan:{...selected,quotes:[]}},'discussion',prepared.payload),/authorization/);
 const wrong={...selected,quotes:[{...selected.quotes[0],text:PRIVATE}]};
 assert.throws(()=>parseAssistant({draftPlan:wrong},'discussion',prepared.payload),/authorization/);
});
test('a current specific permission can resolve historical material without treating omitted turns as revocation',t=>{
 const {args,prepared,plan,id}=fixture(t),old=prepared.payload.sources.find(source=>source.id===id);
 old.historicalOnly=true;old.continuationCoverage='later_private_sources_omitted';
 const current=prepared.payload.sources.find(source=>source.id===prepared.payload.intentAuthority.sourceId);
 const permitted={...plan,quotes:plan.quotes.map(quote=>({...quote,authorization:{...quote.authorization,permission:{sourceId:current.id,text:current.text}}}))};
 assert.deepEqual(admittedQuotes(buildDraftContext(prepared,permitted,args).payload.outboundQuotes),[{sourceId:id,text:FACT}]);
});
test('a delivered discussion-only restriction still blocks material carrying a permission reference',t=>{
 const {args,prepared,plan,id}=fixture(t);
 prepared.restrictions=[{sourceId:'note:private-fragment',text:FACT}];
 assert.throws(()=>buildDraftContext(prepared,plan,args),/仅供私下/);
 assert.ok(prepared.payload.sources.some(source=>source.id===id));
});
