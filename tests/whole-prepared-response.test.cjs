'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional raw transport and real Controller/Store/body projections. Injected
// explanations are ownership fixtures, not evidence of model reasoning quality.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Controller}=require('./fixtures/whole-answer-fidelity.cjs'),{Store}=require('../src/store.cjs');
const {assistModel,parseAssistant,prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {projectVisibleTurn}=require('../scripts/eval-qq-adapter.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const YESTERDAY='昨天第一次把读书笔记网页的查找功能弄好了。';
const TODAY='今天查找功能已经可以按标题找回自己的摘记。';
const MESSAGE='这是我给自己记读书笔记的小网页，昨天刚做好查找功能，今天已经可以按标题找摘记了。';
const WRONG='PRIMARY_ONLY_FALSE_CRITICISM：今天不准，应该统一改成昨天。';
const CORRECT='PRIMARY_ONLY_CORRECT_REASON：昨天做成和今天可用可以同时成立。';
const FINAL_WHY='FINAL_PRIVATE_EXPLANATION：昨天说的是首次完成，今天说的是现在可用，两句保留各自的时间意思。';
const sourceBody=source=>source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
function whole(source){const first=source.segments[0].materialRef,last=source.segments.at(-1).materialRef;return first===last?first:source.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function plan(p){const current=p.intentAuthority.sourceId,control=text=>({text,sourceIds:[current]});return {intent:'reply',quotes:p.sources.filter(source=>source.type==='note'&&source.authorityChoices.program?.length).map(source=>({materialRef:whole(source),authorityRef:source.authorityChoices.program[0].authorityRef})),...(p.editingReferences?.length?{editingReference:{choice:p.editingReferences[0].choice}}:{}),guidance:{objective:control('按本次意思说明这两个已知时间事实'),allowedApproach:control('核对来源并保持真实用法'),avoidances:[]}};}
function toolResponse(value,purpose){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'whole-response-fixture',type:'function',function:{name:purpose==='fidelity_check'?'fidelity_result':purpose==='draft'?'draft_result':'assistant_result',arguments:typeof value==='string'?value:JSON.stringify(value)}}]}}]}),{status:200});}
const uiSource=fs.readFileSync(path.resolve(__dirname,'../ui/app.js'),'utf8'),uiFunction=uiSource.match(/function assistantVisibleBody\(turn\)\{[^\n]*\}/)?.[0];assert.ok(uiFunction);const uiBody=vm.runInNewContext(`(${uiFunction})`);
function assertVisible(turn,expected){assert.equal(uiBody(turn),expected);assert.equal(projectVisibleTurn(turn).text,expected);}
// Each test explicitly declares the complete synthetic answer below; this
// maps that declared fixture body into the current primary producer schema.
function completePrimary(value,primary,draftPlan){
 if(typeof value==='string')return value;
 if(value.kind==='question')return {operation:'clarify',blocker:value.deliveryBlocker};
 return {operation:'prepare_message',materials:draftPlan.quotes,...(draftPlan.editingReference?{editingReference:draftPlan.editingReference}:{}),answer:{suggestions:value.suggestions?.length?value.suggestions:[{text:value.text}],...(Object.hasOwn(value,'privateExplanation')?{privateExplanation:value.privateExplanation}:{})}};
}
async function application(t,{primary=WRONG,final=()=>({kind:'draft',text:MESSAGE}),facts=[YESTERDAY,TODAY],previous=false,legacy=false,advise=false}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-30T10:00:00.000Z')});const store=new Store(':memory:'),notes=[];
 notes.push(store.saveNote(scope,{text:facts[0],use:'draft'}));t.mock.timers.setTime(Date.parse('2026-10-01T10:00:00.000Z'));for(const text of facts.slice(1))notes.push(store.saveNote(scope,{text,use:'draft'}));
 const calls=[],contexts=[],model='synthetic-whole-prepared-response',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:6,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:(settings,context,signal)=>{contexts.push(context);if(legacy){const p=context.payload;calls.push({p});if(p.purpose==='fidelity_check')return {checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]};const id=p.intentAuthority.sourceId,c=text=>({text,sourceIds:[id]}),value=final(p,{},calls.length-1);const {operation,...fields}=completePrimary(value,primary,{intent:'reply',quotes:p.sources.filter(source=>source.type==='note'&&source.use==='draft').map(source=>({sourceId:source.id,text:source.text})),guidance:{objective:c('说明实际事实'),allowedApproach:c('保留真实范围'),avoidances:[]}});return {kind:'discussion',...fields,text:primary,draftPlan:{intent:'reply',quotes:p.sources.filter(source=>source.type==='note'&&source.use==='draft').map(source=>({sourceId:source.id,text:source.text})),guidance:{objective:c('说明实际事实'),allowedApproach:c('保留真实范围'),avoidances:[]}}};}
   return assistModel(settings,context,signal,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push({request,wrapper,p});const value=p.purpose==='fidelity_check'?{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[]}:advise?{operation:'advise',text:primary}:completePrimary(await final(p,wrapper,calls.length-1),primary,plan(p));return toolResponse(value,p.purpose);});}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);controller.live({scope,messages:[raw('91000000000000341',false,{msgTime:'1790848740',elements:[{textElement:{content:'你这个小网页现在已经能查找了吗？'}}]})]});
 const prior=previous?store.appendTurn(scope,{role:'assistant',kind:'draft',origin:'user',requestId:'whole-response-prior',text:MESSAGE,suggestions:[{style:'自然',text:MESSAGE}],sourceIds:notes.map(note=>'note:'+note.id)}):null;
 return {store,controller,calls,contexts,notes,prior,run:()=>store.getCompanion(scope).runs.at(-1),assist:(text='按我已选的两条事实准备完整表达，并说明该保留哪些地方。',extra={})=>controller.assist({text,taskId:'whole-response',materialIds:notes.map(note=>note.id),...(prior?{sourceTurnIds:[prior.id]}:{}),...extra})};
}

for(const primary of [WRONG,CORRECT])test(`primary audit rationale is never fabricated into the final explanation when the complete answer supplies none (${primary===WRONG?'wrong':'correct'} rationale)`,async t=>{
 const app=await application(t,{primary}),reply=await app.assist();
 assert.equal(reply.kind,'draft');assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(reply.discussionExplanation,undefined,'neither wrong nor correct planner prose is a final explanation fallback');
 assert.equal(app.calls.length,2);assert.equal(uiBody(reply).includes(primary),false);const saved=app.store.getCompanion(scope).turns.find(turn=>turn.id===reply.id);assert.deepEqual(saved.discussionExplanation,undefined);assertVisible(saved,saved.text);
 assert.deepEqual(app.run().manifest.preparedResponse,{owner:'primary_answer',message:'provided',privateBodyOwner:'answer.privateExplanation',privateExplanation:'absent'});
});

test('the complete raw primary owns its explicit explanation and individually stored outward message',async t=>{
 const app=await application(t,{final:()=>({kind:'draft',text:MESSAGE,privateExplanation:FINAL_WHY})}),reply=await app.assist(),saved=app.store.getCompanion(scope).turns.find(turn=>turn.id===reply.id);
 assert.deepEqual(reply.discussionExplanation,{kind:'discussion',text:FINAL_WHY});assert.equal(reply.suggestions[0].text,MESSAGE);assertVisible(reply,FINAL_WHY);assertVisible(saved,FINAL_WHY);
 assert.equal(JSON.stringify(reply).includes(WRONG),false);assert.equal(app.calls.length,2);assert.equal(app.calls[1].request.tools[0].function.name,'fidelity_result');
 const schema=app.calls[0].request.tools[0].function.parameters.properties.answer;assert.equal(schema.properties.privateExplanation.type,'string');assert.equal(schema.properties.message,undefined);
 assert.deepEqual(app.run().manifest.preparedResponse,{owner:'primary_answer',message:'provided',privateBodyOwner:'answer.privateExplanation',privateExplanation:'provided'});
});

for(const secondFact of [TODAY,'今天查找功能还没有做成，目前还不能使用。'])test(`compatible or genuinely conflicting source facts and the actual e1 remain complete inputs (${secondFact===TODAY?'compatible':'contradictory'})`,async t=>{
 const facts=[YESTERDAY,secondFact],app=await application(t,{facts,previous:true,final:()=>({kind:'draft',text:MESSAGE,privateExplanation:FINAL_WHY})});
 const reply=await app.assist('以你上一轮实际给我的内容为起点，保留有依据的部分并解释你的改法。'),wording=app.calls[1].p;
 assert.deepEqual(wording.admittedFragments.map(item=>item.text),facts);assert.equal(wording.priorArtifact.text,MESSAGE);assert.match(wording.priorArtifact.authority,/generated|reference|not/i);
 assert.equal(wording.evidence.find(source=>source.sourceId===wording.currentHumanControl.sourceId).text,'以你上一轮实际给我的内容为起点，保留有依据的部分并解释你的改法。');assert.equal(wording.currentHumanControl.authority,'CONTROL_ONLY');
 assert.deepEqual(app.notes.map(note=>app.store.memorySources(scope).find(source=>source.id==='note:'+note.id).text),facts);
 assert.deepEqual(wording.evidence.filter(item=>item.type==='note').map(item=>item.at),['2026-09-30T10:00:00.000Z','2026-10-01T10:00:00.000Z']);
 assert.deepEqual(app.run().payload.outboundQuotes.map(quote=>quote.provenance.source.recordedAt),['2026-09-30T10:00:00.000Z','2026-10-01T10:00:00.000Z'],'the canonical source dates remain available privately');
 assert.ok(app.run().payload.outboundQuotes.every(quote=>quote.provenance.source.timeMeaning==='note_edited'));
 assert.equal(wording.admittedFragments.some(item=>item.text===WRONG||item.text===MESSAGE),false,'generated rationale and e1 are not promoted to independent factual quotations');assert.equal(reply.discussionExplanation.text,FINAL_WHY);
});

test('a malformed explicit final explanation uses the same single structured repair and preserves the repaired complete response',async t=>{
 const app=await application(t,{final:(_p,wrapper)=>wrapper.originalInput?{kind:'draft',text:MESSAGE,privateExplanation:FINAL_WHY}:{kind:'draft',text:MESSAGE,privateExplanation:{text:'malformed why'}}}),reply=await app.assist();
 assert.equal(app.calls.length,3);assert.equal(app.calls[1].request.tool_choice.function.name,'assistant_result');assert.ok(app.calls[1].request.tools[0].function.parameters.properties.answer.properties.privateExplanation);assert.equal(app.calls[2].request.tool_choice.function.name,'fidelity_result');
 assert.equal(app.calls[2].p.purpose,'fidelity_check');assert.equal(app.calls.some(call=>call.wrapper?.purpose==='plain_draft_recovery'),false);assert.equal(reply.discussionExplanation.text,FINAL_WHY);assert.equal(reply.suggestions[0].text,MESSAGE);
 assert.equal(app.controller.usage.get(scope,'whole-response').requests.filter(request=>request.purpose==='delivery_repair').length,1);
});

test('repairing to a message without a final why truthfully records absence and never salvages primary rationale',async t=>{
 const app=await application(t,{final:(_p,wrapper)=>wrapper.originalInput?{kind:'draft',text:MESSAGE}:{kind:'draft',text:MESSAGE,privateExplanation:{invalid:'not a final why string'}}}),reply=await app.assist();
 assert.equal(app.calls.length,3);assert.equal(reply.discussionExplanation,undefined);assert.equal(app.run().manifest.preparedResponse.privateExplanation,'absent');assert.equal(uiBody(reply).includes(WRONG),false);assert.equal(reply.suggestions[0].text,MESSAGE);
});

test('unrecoverable private prose cannot become a message-only plain recovery or a fabricated final explanation',async t=>{
 const privateOnly='PRIVATE_UNFRAMED_WHY_ONLY：我先解释自己的考虑，这并不是给对方的消息。',app=await application(t,{final:()=>privateOnly});
 await assert.rejects(app.assist());assert.equal(app.calls.length,2);assert.equal(app.calls.some(call=>call.wrapper?.purpose==='plain_draft_recovery'),false);assert.equal(app.store.getCompanion(scope).turns.some(turn=>turn.role==='assistant'),false);
 assert.equal(app.run().status,'failed');assert.notEqual(app.run().manifest.preparedResponse?.privateExplanation,'provided');assert.equal(app.store.experiences.draft(scope),null);
});

test('even a standalone draft without an existing obligation cannot reinterpret private prose as plain outward recovery',async()=>{
 const context={payload:{purpose:'draft',outboundQuotes:[{sourceId:'note:known',text:TODAY}],sources:[]},manifest:{scope,requestId:'whole-response-no-obligation',sourceRevisions:{'note:known':'known-r1'}}},settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-whole-no-obligation',modelResponseMode:'result_tool'},calls=[];
 await assert.rejects(assistModel(settings,context,undefined,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content);calls.push({request,wrapper});return new Response(JSON.stringify({choices:[{message:{content:'PRIVATE_UNTYPED_WHY_NOT_AN_OUTWARD_MESSAGE'}}]}),{status:200});}));
 assert.equal(calls.length,2);assert.equal(calls[1].request.tool_choice.function.name,'draft_result');assert.equal(calls[1].wrapper.purpose,'draft');assert.equal(calls.some(call=>call.wrapper.purpose==='plain_draft_recovery'),false);
 assert.notEqual(context.manifest.preparedResponse?.message,'provided');
});

for(const repaired of [true,false])test(`configured plain-text carrier still requires a complete typed final response (${repaired?'successful repair':'unrecoverable private prose'})`,async()=>{
 const context={payload:{purpose:'draft',outboundQuotes:[{sourceId:'note:known',text:TODAY}],sources:[]},manifest:{scope,requestId:'whole-response-plain-'+repaired}},settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-whole-plain',modelResponseMode:'plain_text'},calls=[];
 const run=assistModel(settings,context,undefined,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content);calls.push({request,wrapper});const content=calls.length===2&&repaired?JSON.stringify({kind:'draft',text:MESSAGE,privateExplanation:FINAL_WHY}):'PRIVATE_PLAIN_REASON_IS_NOT_AN_OUTWARD_BODY';return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200});});
 if(repaired){const result=await run;assert.equal(result.suggestions[0].text,MESSAGE);assert.equal(result.discussionExplanation.text,FINAL_WHY);}
 else await assert.rejects(run);
 assert.equal(calls.length,2);for(const call of calls){assert.equal(call.request.tools,undefined);assert.equal(call.request.response_format,undefined);assert.match(call.request.messages[0].content,/privateExplanation/);assert.equal(call.wrapper.purpose==='plain_draft_recovery',false);}
 assert.equal(calls[1].wrapper.purpose,'draft');
});

test('legacy canonical primary DTO compatibility does not restore automatic planning-explanation concatenation',async t=>{
 const app=await application(t,{legacy:true,primary:CORRECT}),reply=await app.assist();assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(reply.discussionExplanation,undefined);assert.equal(uiBody(reply).includes(CORRECT),false);assert.equal(app.calls.length,2);
});

test('final privateExplanation is explicit, draft-only and preserved on canonical second parsing',()=>{
 const context={payload:{purpose:'draft',outboundQuotes:[{sourceId:'note:known',text:TODAY}],sources:[],requestDeliveryObligation:{mode:'editable_message'}},manifest:{scope}},raw={kind:'draft',text:MESSAGE,privateExplanation:FINAL_WHY},result=parseAssistant(raw,'draft',context);
 assert.deepEqual(result.discussionExplanation,{kind:'discussion',text:FINAL_WHY});assert.deepEqual(parseAssistant(result,'draft',context),result);
 assert.equal(parseAssistant({kind:'draft',text:MESSAGE,privateExplanation:'x'.repeat(6000)},'draft',context).discussionExplanation.text.length,6000);
 for(const privateExplanation of [undefined,null,'','   '])assert.equal(parseAssistant({kind:'draft',text:MESSAGE,privateExplanation},'draft',context).discussionExplanation,undefined);
 for(const privateExplanation of [{},['wrong'],6000,'x'.repeat(6001)])assert.throws(()=>parseAssistant({kind:'draft',text:MESSAGE,privateExplanation},'draft',context));
 assert.throws(()=>parseAssistant({kind:'question',text:'哪件小事？',privateExplanation:FINAL_WHY,deliveryBlocker:{kind:'missing_fact',missing:'具体事情',question:'哪件小事？'}},'draft',context));
});

for(const [name,value]of [['empty',''],['whitespace','  \n '],['null',null]])test(`an optional ${name} final explanation is absent without a new repair or primary fallback`,async t=>{
 const app=await application(t,{final:()=>({kind:'draft',text:MESSAGE,privateExplanation:value})}),reply=await app.assist();
 assert.equal(reply.suggestions[0].text,MESSAGE);assert.equal(reply.discussionExplanation,undefined);assert.equal(app.calls.length,2);assert.equal(app.run().manifest.preparedResponse.privateExplanation,'absent');assert.equal(uiBody(reply).includes(WRONG),false);
});

test('ordinary private why remains a single primary answer followed by a read-only check',async t=>{
 const explanation='这里先私下说明日期的区别，不需要重写给对方的消息。',app=await application(t,{advise:true,primary:explanation}),reply=await app.assist('只想知道为什么这样理解，先不要改写消息。');
 assert.equal(reply.kind,'discussion');assert.equal(reply.text,explanation);assert.equal(reply.suggestions,undefined);assert.equal(reply.discussionExplanation,undefined);assert.equal(app.calls.length,2);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);assertVisible(reply,explanation);
});

test('an unbound provider discussionExplanation cannot self-tag as an explicit final explanation',()=>{
 const context={payload:{purpose:'draft',outboundQuotes:[],sources:[]},manifest:{scope}},result=parseAssistant({kind:'draft',text:MESSAGE,discussionExplanation:{kind:'discussion',text:'PROVIDER_FORGED_CANONICAL_WHY'}},'draft',context);
 assert.equal(result.discussionExplanation,undefined);assert.equal(JSON.stringify(result).includes('PROVIDER_FORGED_CANONICAL_WHY'),false);
});

test('a final blocker has only its typed why/question owner and cannot recover a planning explanation',async t=>{
 const question='现在具体希望表达哪一件事？',why='需要先确定当前确实可用的事情。',app=await application(t,{final:()=>({kind:'question',text:'OLD_UNTYPED_FINAL_PARAPHRASE',deliveryBlocker:{kind:'missing_fact',missing:'本次具体想表达的事情',question,explanation:why}})}),reply=await app.assist();
 assert.equal(reply.text,why+'\n\n'+question);assert.equal(reply.discussionExplanation,undefined);assert.equal(reply.suggestions,undefined);assertVisible(reply,why+'\n\n'+question);assert.equal(uiBody(reply).includes(WRONG),false);
 assert.equal(app.calls.length,2);assert.equal(app.run().manifest.requestDelivery.status,'blocked');
});
