'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const {reconcilePlanningViews}=require('../src/context/planning-view.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
function fixture(t){const store=new Store(':memory:');t.after(()=>store.close());store.add(scope,[normalize(raw('91001',false,{elements:[{textElement:{content:'今天路过书店，终于找到了上次说的那本书。'}}]}),scope)]);store.setGoal(scope,'真实地了解彼此');store.saveNote(scope,{kind:'material',use:'discussion',text:'PRIVATE_REASON_CONTEXT_ONLY'});const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'自然接她刚才讲的具体事情，别只重复夸奖。'});const args={scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',requestId:'synthetic-material-consumer'};return {args,context:buildContext(args)};}
test('the real planning facade consumes work and grounded materials while wording excludes full private views',t=>{
 const {args,context}=fixture(t),p=context.payload;
 assert.ok(p.work&&p.materialView,'both local views reach the actual planning request');
 assert.ok(Array.isArray(p.materialView.items)&&p.materialView.items.length>0);
 const sources=new Set(p.sources.map(s=>s.id));
 for(const item of p.materialView.items)for(const id of item.sourceIds||[])assert.ok(sources.has(id)||p.coreMemory?.items.some(core=>core.sourceIds.includes(id)),id);
 const prepared=prepareAssistantRequest({},p);assert.equal(context.manifest.serializedTextRequestBytes,prepared.requestBytes);
 const draft=buildDraftContext(context,withCurrentDraftControls({intent:'reply',quotes:[]},p),args).payload;
 assert.equal(draft.materialView,undefined);assert.equal(draft.work,undefined);assert.equal(draft.privateConversation,undefined);
 assert.equal(JSON.stringify(draft).includes('PRIVATE_REASON_CONTEXT_ONLY'),false);
});
test('material projection is included in rebudgeted request measurements and preserves the current source',t=>{
 const {context}=fixture(t),rebuilt=context.rebuildForRequest(p=>prepareAssistantRequest({},p).requestBytes+5000);
 assert.ok(rebuilt.payload.materialView);assert.equal(rebuilt.payload.sources.find(s=>s.id==='qq:91001').text,context.payload.sources.find(s=>s.id==='qq:91001').text);
 assert.ok(rebuilt.manifest.serializedTextRequestBytes<=rebuilt.manifest.requestByteBudget);
 assert.equal(rebuilt.payload.taskContext.consultationTask.focus[0].laterAvailableMessageCount,0);
});
test('required source evidence wins when even navigation references cannot fit the measured envelope',t=>{
 const {context}=fixture(t),rebuilt=context.rebuildForRequest(payload=>prepareAssistantRequest({},payload).requestBytes+(payload?.materialView?90000:0));
 assert.equal(rebuilt.payload.materialView,undefined);assert.equal(rebuilt.payload.work,undefined);
 assert.equal(rebuilt.manifest.planningViews.projection,'omitted_for_required_evidence');
 assert.equal(rebuilt.payload.userRequest.text,context.payload.userRequest.text);
 assert.equal(rebuilt.payload.sources.find(s=>s.id==='qq:91001').text,context.payload.sources.find(s=>s.id==='qq:91001').text);
 assert.ok(rebuilt.manifest.serializedTextRequestBytes<=rebuilt.manifest.requestByteBudget);
});
test('late source repacking retains the loaded current and sent portions with explicit partial coverage',t=>{
 const {args}=fixture(t);args.records=Array.from({length:10},(_,index)=>normalize(raw(String(92000+index),index%2===1,{msgTime:String(1791726000+index*60),elements:[{textElement:{content:`完整虚构交流${index}`}}]}),scope));
 const context=buildContext({...args,requestMeasure:payload=>prepareAssistantRequest({},payload).requestBytes+(payload?.materialView&&(payload.materialView.projection!=='source_refs'||payload.sources.some(source=>source.id==='qq:92000'))?90000:0)});
 const p=context.payload;assert.equal(p.sources.some(source=>source.id==='qq:92000'),false);
 const current=p.materialView.items.find(item=>item.kind==='current_exchange'),sent=p.materialView.items.find(item=>item.kind==='already_expressed');
 assert.ok(current?.sourceIds.includes('qq:92009'),'the actual latest message remains material after an earlier optional source is removed');
 assert.ok(sent?.sourceIds.includes('qq:92009'),'loaded actual outgoing remains distinguishable from a fresh draft');
 assert.equal(current.coverage,'partial_selected_sources');assert.equal(sent.coverage,'partial_selected_sources');
 assert.equal(p.materialView.projection,'source_refs','the same coverage survives the compact navigation fallback');
 assert.ok(current.sourceIds.every(id=>p.sources.some(source=>source.id===id)));
});
test('late historical evidence downgrades material while multi-source memory and arrangement closures remain complete',t=>{
 const {args}=fixture(t),incoming=args.records[0],outgoing=normalize(raw('94002',true,{elements:[{textElement:{content:'一个实际发出的合成回应。'}}]}),scope),ids=[`qq:${incoming.messageId}`,'qq:94002'];
 const coreMemory=[{id:'synthetic-core',kind:'fact',status:'active',certainty:'stated',text:'合成双方曾讨论过一次活动。',sourceIds:ids}];
 const relationshipContext={version:1,claims:[],events:[{id:'synthetic-event',activityKey:'synthetic-walk',eventKind:'invitation',actor:'both',text:'合成活动提议',sourceIds:ids}],activities:[]};
 const p=buildContext({...args,records:[incoming,outgoing],coreMemory,relationshipContext}).payload;
 assert.ok(p.materialView.items.some(item=>item.kind==='arrangement_evidence'));
 assert.ok(p.materialView.items.some(item=>item.kind==='historical_anchor'&&item.sourceIds.length===2));
 assert.ok(p.materialView.currentIntent);
 p.sources=p.sources.filter(source=>source.id===ids[0]).map(source=>({...source,historicalOnly:true}));
 reconcilePlanningViews(p);
 assert.equal(p.materialView.currentIntent,undefined,'a withdrawn intent reference cannot survive through the material view');
 assert.equal(p.materialView.items.some(item=>['historical_anchor','arrangement_evidence'].includes(item.kind)&&item.sourceIds.length===2),false);
 const current=p.materialView.items.find(item=>item.kind==='current_exchange');
 assert.deepEqual(current.sourceIds,[ids[0]]);assert.equal(current.coverage,'partial_selected_sources');
 assert.equal(current.availableAs,'historical_reference');assert.equal(current.currentStatus,'unknown');
 p.sources=[];reconcilePlanningViews(p);assert.deepEqual(p.materialView.items,[]);
});
