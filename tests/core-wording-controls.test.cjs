'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {assistModel,prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const {scope,raw}=require('./fixtures/native.cjs'),{withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const DECLARATION='以后给我的参考回复用短句，不用表情，因为PRIVATE_CORE_REASON我担心显得太急。';
const SUMMARY='参考回复优先用短句，不用表情。';
function fixture(t,{text=DECLARATION,summary=SUMMARY,kind='preference',actor='user',claim={}}={}){
 const store=new Store(':memory:');t.after(()=>store.close());const asOf=new Date(Date.now()+4*86400000).toISOString();let sourceId,sourceIds=[];
 if(actor==='contact'){const m=normalize(raw('58001',false,{msgTime:String(Math.floor(Date.now()/1000)),elements:[{textElement:{content:text}}]}),scope);store.add(scope,[m]);sourceId=`qq:${m.messageId}`;}
 else if(actor==='unknown_note'){const note=store.saveNote(scope,{kind:'material',use:'discussion',text});sourceId=`note:${note.id}`;}
 else {for(const statement of Array.isArray(text)?text:[text]){const declaration=store.appendTurn(scope,{role:'user',kind:'discussion',text:statement});sourceIds.push(`private:${declaration.id}`);}sourceId=sourceIds[0];}
 if(!sourceIds.length)sourceIds=[sourceId];
 const batch=store.memoryBatch(scope),result={reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[]};
 if(kind==='claim')result.relationshipPatch={claims:[{subject:'self',aspect:'stated_preference',text:summary,assertionKind:'stated',epistemicStatus:'supported',sourceIds,...claim}]};
 else result.items=[{kind,text:summary,sourceIds,...(kind==='preference'?{explicitPreference:true}:{})}];
 const applied=store.applyMemoryBatch(scope,batch,result);assert.equal(applied.applied,true,JSON.stringify(applied));
 store.add(scope,[normalize(raw('58002',false,{msgTime:String(Math.floor(Date.parse(asOf)/1000)-60),elements:[{textElement:{content:'窗台的小苗又长出两片叶子。'}}]}),scope)]);
 const args={scope,store,records:store.messages(scope),availableSources:store.memorySources(scope),companion:store.getCompanion(scope),
  turn:{id:'core-wording-observation',role:'user',kind:'reply',text:'根据实际来信给完整参考。',transient:true},purpose:'reply',generationOrigin:'qq_observation',
  invocation:{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'},asOf,requestId:'synthetic-core-wording',viewerTimeZone:'Asia/Shanghai'};
 const prepared=buildContext(args),draft=()=>buildDraftContext(prepared,withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload),args);
 return {store,args,prepared,draft,sourceId,sourceIds};
}
test('the user recurring request to avoid blunt wording survives a synonymous core summary',t=>{
 const {draft,sourceId}=fixture(t,{text:'以后给我的参考回复别太直白，因为PRIVATE_CORE_BLUNT_REASON我怕显得急。',summary:'参考表达委婉一点。'});
 const wording=draft();assert.ok(wording.payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)&&/表达含蓄/.test(item.text)));
 assert.deepEqual(wording.payload.outboundQuotes,[]);assert.equal(JSON.stringify(wording.payload).includes('PRIVATE_CORE_BLUNT_REASON'),false);
});
test('asking for less indirect wording cannot become a requirement to be indirect',t=>{
 const {draft,sourceId}=fixture(t,{text:'以后给我的参考回复不要太含蓄。',summary:'用户明确不想表达得太含蓄。'});
 assert.ok(!draft().payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)&&/表达含蓄/.test(item.text)));
});
test('a legal durable core preference reaches restricted wording without reopening its private raw body',t=>{
 const {prepared,draft,sourceId,args}=fixture(t);assert.ok(prepared.payload.coreMemory.items.some(item=>item.kind==='preference'&&item.text===SUMMARY));
 assert.ok(!prepared.payload.sources.some(source=>source.id===sourceId),'the old preference evidence stays outside optional raw history');
 const wording=draft();assert.ok(wording.payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)&&/短句/.test(item.text)),'a planner-visible durable expression preference must reach wording');
 assert.ok(wording.payload.wordingControls.items.some(item=>item.sourceIds.includes(sourceId)&&/不额外添加 emoji/.test(item.text)));
 assert.equal(wording.manifest.sourceRevisions[sourceId],args.availableSources.find(source=>source.id===sourceId).revision);
 assert.ok(!wording.payload.sources.some(source=>source.id===sourceId));assert.deepEqual(wording.payload.outboundQuotes,[]);
 const wire=prepareAssistantRequest({},wording.payload).serialized;for(const secret of ['PRIVATE_CORE_REASON',DECLARATION])assert.equal(wire.includes(secret),false,secret);
});
test('a source-bound self stated-preference claim is accepted through the same safe projection',t=>{
 const {prepared,draft,sourceId}=fixture(t,{kind:'claim'});assert.ok(prepared.payload.coreMemory.items.some(item=>item.subject==='self'&&item.aspect==='stated_preference'));
 assert.ok(draft().payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)&&/短句/.test(item.text)));
});
// These memories pass the existing Store admission. Remembering a contact or
// a material note still does not make it a user-owned expression instruction.
for(const entry of [
 {name:'a Store-admitted contact preference',actor:'contact',text:'以后回复用短句，不用表情。'},
 {name:'a Store-admitted unknown material owner',actor:'unknown_note',text:'以后参考回复用短句，不用表情。'},
 {name:'reported contact quotation',text:'她说：以后回复用短句，不用表情。'},
 {name:'a third-party report whose subject carries across commas',text:'我听她说，回复用短句，不用表情，因为PRIVATE_REPORT_REASON她觉得这样好。'},
 {name:'a personal preference unrelated to expression',text:'我以后更喜欢自然风景和轻松的徒步。',summary:'用户更喜欢自然风景和轻松的徒步。'},
 {name:'a factual memory',kind:'fact',text:'我以前用过短句介绍自然风景。',summary:'用户用短句介绍过自然风景。'},
 {name:'a conditional preference',text:'如果她忙的时候，回复用短句。',summary:'如果她忙的时候，回复用短句。'},
 {name:'a contact typed preference',kind:'claim',actor:'contact',claim:{subject:'contact'}},
 {name:'an expired typed preference',kind:'claim',claim:{validUntil:new Date(Date.now()+86400000).toISOString()}},
 {name:'a contextual typed preference',kind:'claim',claim:{context:'只在她说很忙的时候适用'}}
])test(`${entry.name} cannot become an unconditional user wording control`,t=>{
 const {draft,sourceId}=fixture(t,entry);assert.ok(!draft().payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)));
});
for(const operation of ['withdraw','correct'])test(`wording rejects source ${operation} instead of trusting an earlier prepared core snapshot`,t=>{
 const {store,args,prepared,sourceId}=fixture(t);
 if(operation==='withdraw')store.forgetSource(scope,sourceId);else store.updateTurn(scope,sourceId.slice('private:'.length),'更正：以后不要求简短，不用原来的表达偏好了。');
 const wording=buildDraftContext(prepared,withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload),{...args,availableSources:store.memorySources(scope)});
 assert.ok(!wording.payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)));
});
test('retiring a core preference prevents a frozen prepared snapshot from restoring the old instruction',t=>{
 const {store,args,prepared,sourceId}=fixture(t),correction=store.appendTurn(scope,{role:'user',kind:'discussion',text:'更正：以后不要求短句，之前那条表达偏好停用。'}),batch=store.memoryBatch(scope);
 const previous=batch.priorMemory.items.find(item=>item.kind==='preference');assert.ok(previous);
 assert.equal(store.applyMemoryBatch(scope,batch,{reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[{id:previous.id,status:'superseded',sourceIds:[`private:${correction.id}`]}]}).applied,true);
 const wording=buildDraftContext(prepared,withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload),{...args,availableSources:store.memorySources(scope)});
 assert.ok(!wording.payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)));
});
test('multi-source preferences retain all dependencies and abstain if one original is unavailable',t=>{
 const {args,prepared,draft,sourceIds}=fixture(t,{text:['以后参考回复用短句。','以后回复不用表情，因为PRIVATE_SECOND_REASON我不想显得太急。']});
 const wording=draft();for(const id of sourceIds){assert.ok(wording.payload.wordingControls.items.some(item=>item.sourceIds.includes(id)));assert.ok(wording.manifest.wordingControlEvidence.sourceRefs.some(ref=>ref.sourceId===id));}
 const missing=buildDraftContext(prepared,withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload),{...args,availableSources:args.availableSources.filter(source=>source.id!==sourceIds[1])});
 assert.ok(!missing.payload.wordingControls?.items.some(item=>sourceIds.some(id=>item.sourceIds.includes(id))));assert.equal(JSON.stringify(wording.payload).includes('PRIVATE_SECOND_REASON'),false);
});
test('core preferences preserve negation',t=>{
 const text='以后回复不要用短句，不想太含蓄，别用emoji。';const {draft}=fixture(t,{text,summary:text});const normalized=draft().payload.wordingControls.items.map(item=>item.text).join(' ');assert.doesNotMatch(normalized,/简短|含蓄/);assert.match(normalized,/不额外添加 emoji/);
});
test('valid core preferences coexist with note preferences and the current response preference',t=>{
 const {store,args,sourceId}=fixture(t);const note=store.saveNote(scope,{kind:'preference',use:'discussion',text:'以后表达含蓄一点。'});
 const fresh={...args,availableSources:store.memorySources(scope),companion:store.getCompanion(scope),responsePreference:'自然一点'};
 const prepared=buildContext(fresh),wording=buildDraftContext(prepared,withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload),fresh),items=wording.payload.wordingControls.items;
 assert.ok(items.some(item=>item.sourceIds.includes(sourceId)&&/短句/.test(item.text)));assert.ok(items.some(item=>item.sourceIds.includes(`note:${note.id}`)&&/含蓄/.test(item.text)));assert.ok(items.some(item=>item.sourceIds.includes('responsePreference')&&/口语/.test(item.text)));
});
test('a direct user expression preference survives a separate private reason about her response',t=>{
 const {draft,sourceId}=fixture(t,{text:'以后给我的参考回复用短句，不用表情，因为担心她说我太急，PRIVATE_DIRECT_REASON不应写出去。'}),wording=draft();
 assert.ok(wording.payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)&&/短句/.test(item.text)));assert.ok(wording.payload.wordingControls.items.some(item=>/不额外添加 emoji/.test(item.text)));assert.equal(JSON.stringify(wording.payload).includes('PRIVATE_DIRECT_REASON'),false);
});
test('lookup-style reassembly, request rebuilding and restricted-wording recovery retain normalized core controls',async t=>{
 const {args,prepared,sourceId}=fixture(t),rebuilt=prepared.rebuildForRequest(payload=>prepareAssistantRequest({},payload).requestBytes+1000);
 const retrieved=buildContext({...args,retrievedSources:args.availableSources.filter(source=>source.id===sourceId)});
 const outputs=[prepared,rebuilt,retrieved].map(context=>buildDraftContext(context,withCurrentDraftControls({intent:'reply',quotes:[]},context.payload),args));
 assert.ok(outputs[0].payload.wordingControls?.items.some(item=>item.sourceIds.includes(sourceId)));
 for(const output of outputs.slice(1))assert.deepEqual(output.payload.wordingControls,outputs[0].payload.wordingControls);
 const requests=[];const result=await assistModel({anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic'},outputs[0],undefined,async(_url,options)=>{
  const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content);requests.push(input);
  return {ok:true,json:async()=>({choices:[{message:{content:requests.length===1?'malformed synthetic response':JSON.stringify({kind:'draft',text:'小苗又有新进展啦。'})}}]})};
 });
 assert.equal(result.suggestions.length,1);assert.equal(requests.length,2);assert.deepEqual(requests[1].originalInput.wordingControls,requests[0].wordingControls);assert.equal(JSON.stringify(requests).includes('PRIVATE_CORE_REASON'),false);
});
test('a structurally repaired planning carrier still hands the same core controls to wording',async t=>{
 const {args,prepared,draft}=fixture(t),requests=[];
 const plan=withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload);
 const result=await assistModel({anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic'},prepared,undefined,async(_url,options)=>{
  const body=JSON.parse(options.body);requests.push(JSON.parse(body.messages[1].content));return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(requests.length===1?{draftPlan:'{malformed container'}:{draftPlan:plan,answer:{suggestions:[{text:'Synthetic complete response under the same wording controls.'}]}})}}]})};
 });
 assert.equal(requests.length,2);assert.equal(prepared.extraRequests[0].purpose,'delivery_repair');
 assert.equal(result.kind,'draft');assert.equal(result.draftPlan,undefined);const repaired=require('../src/context/wording-view.cjs').buildAnswerAdmission(prepared.resultContext||prepared,result,args);assert.deepEqual(repaired.payload.wordingControls,draft().payload.wordingControls);assert.equal(JSON.stringify(repaired.payload).includes('PRIVATE_CORE_REASON'),false);
});
