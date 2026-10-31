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
  const authorityRef=material.authorityChoices.originalUserStatementCandidates[0].authorityRef;
  const quote={materialRef:materialRefForText(material,FACT),...(calls.length===1?{}:{authorityRef})};
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({draftPlan:{...plan,quotes:[quote]},answer:{suggestions:[{text:FACT}]}})}}]})};
 });
 assert.equal(calls.length,2);assert.equal(result.kind,'draft');assert.equal(result.draftPlan,undefined);assert.ok(result.materials[0].authorization);const binding=require('../src/primary-operation.cjs').primaryOperationFor(result).admittedMaterials[0];assert.equal(binding.text,FACT);assert.equal(result.materials[0].authorization.permission.text.includes(PRIVATE),true,'permission retains the complete original qualifier-bearing body');
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
 const q=request.tools[0].function.parameters.properties.materials.items;
 assert.equal(q.properties.materialRef.type,'string');assert.equal(q.properties.authorityRef.type,'string');assert.deepEqual(q.required,['materialRef']);assert.match(q.properties.authorityRef.description,/authority|许可|private/i);assert.equal(q.properties.authorization,undefined);
 const option=request.tools[0].function.parameters.properties.expressionOptions.items;
 assert.equal(option.properties.currentFacts.items.type,'string');assert.ok(option.required.includes('label'));assert.equal(option.required.includes('quotes'),false);assert.equal(option.required.includes('currentFacts'),false);
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
 assert.match(packet.request.messages[0].content,/引语或未满足条件/);
 assert.match(packet.request.messages[0].content,/完整.*否定.*条件/);
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

async function currentOptionApplication(t,{human,options,wrongSelection=false,rejectConditions=false,actions,currentFacts}){
 const {Controller}=require('./fixtures/whole-answer-fidelity.cjs'),store=new Store(':memory:'),calls=[],checks=[];
 const settings={auto:false,anonymous:true,model:'synthetic-current-option',baseUrl:'http://fixture.invalid/v1',realChatConsent:{...scope,model:'synthetic-current-option',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,compactionModel:null,read:async()=>{throw Error('No native QQ reads');},assistantModel:async(_,input)=>{
  const p=input.payload.originalInput||input.payload;calls.push(input);
  if(p.purpose==='fidelity_check'){
   checks.push(p);
   if(rejectConditions){
    const label=p.candidate.expressionOptions[0].label,current=p.evidence.find(source=>source.sourceId===p.currentHumanControl.sourceId);
    assert.equal(current.text,human);
    return {checkRef:p.checkRef,verdict:'reject',issues:[{path:'expressionOptions[0].label',code:'private_disclosure',quote:label,evidence:[{sourceId:current.sourceId,quote:current.text}],reason:'Scripted refusal tests retention of the complete unmet condition and private reason, not classifier quality.'}]};
   }
   return {checkRef:p.checkRef,verdict:'allow',issues:[]};
  }
  if(p.selectedOption){
   const selected=p.expressionOptions.find(option=>option.turnId===p.selectedOption.turnId&&option.index===p.selectedOption.index);
   assert.ok(selected);
   if(!selected.quotes.length)return {operation:'prepare_message',answer:{suggestions:[{text:'听起来挺有意思的。'}]}};
   const quote=selected.quotes[0],text=wrongSelection?'我周末去爬山了':quote.text,view=input.primaryFrameSnapshot.payload.sources.find(source=>source.id===quote.sourceId),authority=input.primaryFrameSnapshot.receipt.authorities.find(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.targetSourceId===quote.sourceId);
   assert.ok(view&&authority);
   return {operation:'prepare_message',materials:[{materialRef:materialRefForText(view,text),authorityRef:authority.authorityRef}],answer:{suggestions:[{text}]}};
  }
  return {operation:'advise',text:currentFacts?.length?'例如：“实验终于成功了。”另一个方向先接她的小事。':'可以先按你提供的原话比较这些方向。',expressionOptions:structuredClone(typeof options==='function'?options(input,p):options),...(actions?{actions}:{}),...(currentFacts?{currentFacts}:{})};
 }});
 controller.scope={...scope};controller.ingest(scope,[raw('91000000000000451',false,{elements:[{textElement:{content:'最近有什么小进展呀？'}}]})]);
 t.after(()=>{controller.close();store.close();});
 return {store,controller,calls,checks,initial:()=>controller.assist({text:human,taskId:'current-fact-options'}),select:(turn,index)=>controller.assist({text:'按选中的方向组织表达',purpose:'draft',sourceTurnIds:[turn.id],selectedOption:{turnId:turn.id,index},taskId:'selected-current-fact-'+index})};
}
const OPTION_HUMAN='今天实验终于成功了，而且我周末去爬山了。这两件小事愿意告诉她；PRIVATE_OPTION_REASON仍只在这里商量。先帮我比较能分享哪个方向。';
const CURRENT_OPTIONS=[{label:'分享实验进展',currentFacts:['实验终于成功了']},{label:'分享周末爬山',currentFacts:['我周末去爬山了']}];
test('normal current fact options persist separate exact tuples and each UI selection admits only its own fact',async t=>{
 const app=await currentOptionApplication(t,{human:OPTION_HUMAN,options:CURRENT_OPTIONS}),turn=await app.initial(),source=app.store.memorySources(scope).find(source=>source.text===OPTION_HUMAN);
 assert.equal(app.calls.length,2);assert.equal(app.checks[0].evidence.find(item=>item.sourceId===source.id).text,OPTION_HUMAN);assert.deepEqual(app.checks[0].admittedFragments,[]);
 assert.deepEqual(app.checks[0].optionMaterials,[{index:0,fragments:[{sourceId:source.id,text:'实验终于成功了',revision:source.revision}]},{index:1,fragments:[{sourceId:source.id,text:'我周末去爬山了',revision:source.revision}]}]);
 assert.equal(app.calls[0].primaryFrameSnapshot.payload.sources.some(item=>item.id===source.id),false,'the current request has no outward material menu');
 for(const [index,fact]of ['实验终于成功了','我周末去爬山了'].entries()){
  assert.deepEqual(turn.expressionOptions[index].quotes,[{sourceId:source.id,text:fact,revision:source.revision}]);assert.equal(turn.expressionOptions[index].quotes[0].authorization,undefined,'an option stores a tuple, never an enduring grant');
  const reply=await app.select(turn,index),check=app.checks.at(-1),run=app.store.getCompanion(scope).runs.at(-1);
  assert.equal(reply.suggestions[0].text,fact);assert.deepEqual(check.admittedFragments,[{sourceId:source.id,text:fact}]);assert.deepEqual(run.payload.outboundQuotes.map(quote=>quote.text),[fact]);
  assert.equal(check.evidence.find(item=>item.sourceId===source.id).text,OPTION_HUMAN);assert.equal(reply.suggestions[0].text.includes('PRIVATE_OPTION_REASON'),false);
 }
 assert.equal(app.calls.length,6);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
test('a control-only option stores no fact tuple and its selection needs no invented private material',async t=>{
 const human='先接她说的小事，不补我的经历，给我一个方向。',app=await currentOptionApplication(t,{human,options:[{label:'先接她的小事'}]}),turn=await app.initial();
 assert.deepEqual(turn.expressionOptions[0].quotes,[]);const reply=await app.select(turn,0);
 assert.equal(reply.suggestions[0].text,'听起来挺有意思的。');assert.deepEqual(app.checks.at(-1).admittedFragments,[]);assert.equal(app.calls.length,4);
});
test('facts used by the main advice example do not become a control-only option tuple',async t=>{
 const human='实验终于成功了，可以把这个进展告诉她。先给一个例子，再给我一个只接她小事的方向。',app=await currentOptionApplication(t,{human,currentFacts:['实验终于成功了'],options:[{label:'先接她的小事'}]}),turn=await app.initial();
 assert.equal(app.checks[0].admittedFragments[0].text,'实验终于成功了');assert.deepEqual(turn.expressionOptions[0].quotes,[]);assert.ok((app.checks[0].optionMaterials||[]).every(option=>option.fragments.length===0));
 await app.select(turn,0);assert.deepEqual(app.checks.at(-1).admittedFragments,[]);
});
test('one selected current fact cannot borrow the other option fact or its sharing interpretation',async t=>{
 const app=await currentOptionApplication(t,{human:OPTION_HUMAN,options:CURRENT_OPTIONS,wrongSelection:true}),turn=await app.initial(),before=app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length;
 await assert.rejects(app.select(turn,0),/authority|target|原始素材|分享素材/);
 assert.equal(app.checks.length,1,'a sibling fact cannot reach the selected candidate checker');assert.equal(app.store.getCompanion(scope).turns.filter(turn=>turn.role==='assistant').length,before);
});
test('an invalid option fact cannot silently disappear before an otherwise authorized note action',async t=>{
 const human='记住：实验终于成功了。先给我一个方向。',app=await currentOptionApplication(t,{human,options:[{label:'分享进展',currentFacts:['UNPROVIDED_OPTION_FACT']}],actions:[{type:'save_note',text:'实验终于成功了',use:'discussion',evidenceQuote:'记住：实验终于成功了'}]});
 await assert.rejects(app.initial(),/currentFacts|exact|片段/);assert.equal(app.checks.length,0);assert.equal(app.store.getCompanion(scope).notes.length,0);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});
test('an option cannot exceed eight facts by splitting five current and five valid historical declarations',async t=>{
 const app=await currentOptionApplication(t,{human:OPTION_HUMAN,options:input=>{
  const source=input.payload.sources.find(source=>source.type==='note'&&source.text==='旧的独立事实。'),view=input.primaryFrameSnapshot.payload.sources.find(item=>item.id===source.id),authority=input.primaryFrameSnapshot.receipt.authorities.find(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.targetSourceId===source.id);
  assert.ok(view&&authority);const quote={materialRef:materialRefForText(view,source.text),authorityRef:authority.authorityRef};
  return [{label:'过多的合成素材',currentFacts:Array(5).fill('实验终于成功了'),quotes:Array.from({length:5},()=>({...quote}))}];
 }});
 app.store.saveNote(scope,{text:'旧的独立事实。',use:'draft'});
 await assert.rejects(app.initial(),/eight|八|at most|limit|最多|currentFacts and/);assert.equal(app.checks.length,0);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});
test('a scripted private-disclosure refusal retains the whole unmet condition and private reason without publishing an option',async t=>{
 const human='实验终于成功了，但只有确认可以公开之后才告诉她；现在还没有确认。PRIVATE_CONDITION_REASON只在这里讨论。先帮我想一个方向。',app=await currentOptionApplication(t,{human,options:[{label:'分享实验终于成功了',currentFacts:['实验终于成功了']}],rejectConditions:true});
 await assert.rejects(app.initial(),/核对|repair|修复/);assert.ok(app.checks.length>=1);
 assert.ok(app.checks.every(check=>check.evidence.some(source=>source.text===human)));assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
});
for(const change of ['withdraw','revision'])test(`a stored current fact option cannot reuse its exact tuple after source ${change}`,async t=>{
 const app=await currentOptionApplication(t,{human:OPTION_HUMAN,options:CURRENT_OPTIONS}),turn=await app.initial(),quote=turn.expressionOptions[0].quotes[0],before=app.calls.length;
 if(change==='withdraw')app.store.forgetSource(scope,quote.sourceId);else app.store.updateTurn(scope,quote.sourceId.slice('private:'.length),OPTION_HUMAN+'现在已修订。');
 await assert.rejects(app.select(turn,0),/变化|无效|选择|source|版本|unavailable/i);assert.equal(app.calls.length,before,'a withdrawn or changed exact tuple cannot allocate another model call');
});
