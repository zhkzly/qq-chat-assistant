'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
function message(id,index,text,old=false){return normalize(raw(String(id),index%2===1,{msgTime:String((old?1786870800:1792140000)+index*60),elements:[{textElement:{content:text}}]}),scope);}
function fixture(t,{old=0,privateHistory=false}={}){
 const store=new Store(':memory:');t.after(()=>store.close());
 const records=[...Array.from({length:old},(_,i)=>message(100+i,i,`UNRELATED_CAFETERIA_${i}`,true)),message(900,0,'你种的花秋天还开着呀'),message(901,1,'不是我种的，是宿舍阿姨种在门口的')];store.add(scope,records);
 if(privateHistory)for(let i=0;i<8;i++){store.appendTurn(scope,{role:'user',kind:'discussion',text:`UNRELATED_PRIVATE_DATABASE_${i}`});store.appendTurn(scope,{role:'assistant',kind:'discussion',text:`UNRELATED_ASSISTANT_ANALYSIS_${i}`.repeat(70)});}
 const correction=store.appendTurn(scope,{role:'user',kind:'discussion',text:'别再写像点评员一样的句子，轻松接她说的花就好。'});
 store.appendTurn(scope,{role:'assistant',kind:'acknowledgment',text:'已理解这次纠正。'});
 const turn={id:'synthetic-observation',role:'user',kind:'reply',transient:true,text:'根据真实 QQ 更新当前交流的帮助；判断现在有什么值得回应。'};
 const args={scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'reply',generationOrigin:'qq_observation',invocation:{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'},coverage:{status:'partial'},requestId:'synthetic-lazy',asOf:'2026-10-16T10:30:00Z',viewerTimeZone:'Asia/Shanghai'};
 return {store,args,correction};
}
test('planning, drafting and rebuild keep chronological sources and zero later count at latest',t=>{
 const {args}=fixture(t);args.records=Array.from({length:10},(_,i)=>message(200+i,i,`Synthetic current message ${i}`));
 const prepared=buildContext(args),plan=withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload);
 const contexts=[prepared,prepared.rebuildForRequest(p=>Buffer.byteLength(JSON.stringify(p))),buildDraftContext(prepared,plan,args)];
 contexts.push(contexts[2].rebuildForRequest(p=>Buffer.byteLength(JSON.stringify(p))));
 for(const context of contexts){const qq=context.payload.sources.filter(s=>s.type==='qq');assert.deepEqual(qq.map(s=>s.messageId),args.records.map(m=>m.messageId));assert.equal(context.payload.taskContext.consultationTask.focus[0].laterAvailableMessageCount,0);}
});
test('automatic current task does not preload unrelated old QQ, private analysis, state and claims',t=>{
 const {args,correction}=fixture(t,{old:80,privateHistory:true});
 args.companion.state.items=Array.from({length:12},(_,i)=>({text:`UNRELATED_STATE_DATABASE_${i}`,sourceIds:[`qq:${100+i}`]}));
 args.relationshipContext={version:1,claims:Array.from({length:12},(_,i)=>({id:`claim-${i}`,text:`UNRELATED_CLAIM_CAFETERIA_${i}`,subject:'contact',aspect:'recent_context',sourceIds:[`qq:${100+i}`]})),events:[],activities:[]};
 const context=buildContext(args),wire=JSON.stringify(context.payload);
 for(const distractor of ['UNRELATED_CAFETERIA_','UNRELATED_PRIVATE_DATABASE_','UNRELATED_ASSISTANT_ANALYSIS_'])assert.equal(wire.includes(distractor),false,distractor);
 assert.deepEqual(context.payload.relationshipContext.claims,[]);assert.deepEqual(context.payload.workingState.items,[]);
 assert.ok(context.payload.memoryIndex.length<=6,'only bounded retrieval titles may mention deferred records');
 assert.equal(context.payload.sources.find(s=>s.id===`private:${correction.id}`).text,correction.text);
 assert.deepEqual(context.payload.sources.filter(s=>s.type==='qq').map(s=>s.messageId),['900','901']);
 assert.ok(context.payload.deferredContext.qqSourceCount>=80);
});
test('explicit older QQ focus and lookup preserve originals without loading every intervening message',t=>{
 const {args}=fixture(t,{old:80});
 args.replyMessageIds=['103'];args.retrievedSources=[{id:'qq:140'}];args.lookupHistory=[{query:'cafeteria',found:1}];
 const context=buildContext(args);
 for(const id of ['103','140','900','901'])assert.ok(context.payload.sources.some(s=>s.id===`qq:${id}`),id);
 assert.equal(context.payload.sources.find(s=>s.id==='qq:140').historicalOnly,true,'missing later chronology never becomes a current claim');
 assert.ok(context.payload.sources.filter(s=>s.type==='qq').length<70);
});
test('private continuation keeps complete latest consultation and explicitly selected original discussion',t=>{
 const {store,args}=fixture(t,{privateHistory:true});
 const answer=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'第一种：轻松说花；第二种：说明花名不确定。'});
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'第二种帮我写自然一点'});
 const context=buildContext({...args,turn,purpose:'discussion',generationOrigin:'private_discussion',invocation:{origin:'user',trigger:'private_request',requestedPurpose:'discussion'},companion:store.getCompanion(scope),sourceTurnIds:[answer.id]});
 assert.equal(context.payload.privateConversation.find(t=>t.id===answer.id).text,answer.text);
 assert.equal(JSON.stringify(context.payload).includes('UNRELATED_ASSISTANT_ANALYSIS_0'),false);
});
test('dated active core facts survive unrelated tasks while withdrawn and inferred evidence cannot become core',t=>{
 const {args}=fixture(t,{old:1}),sourceId='qq:100';
 const coreMemory=[{id:'old-job',kind:'fact',status:'active',certainty:'stated',reviewComplete:true,text:'八月曾说在店里帮忙。',sourceIds:[sourceId],firstEvidenceAt:'2026-08-16T09:00:00Z',lastEvidenceAt:'2026-08-16T09:00:00Z'},
  {id:'retired',kind:'fact',status:'superseded',certainty:'stated',text:'RETIRED_CORE',sourceIds:[sourceId]},
  {id:'guess',subject:'contact',lifecycle:'active',assertionKind:'inferred',epistemicStatus:'tentative',text:'INFERRED_CORE',sourceIds:[sourceId]}];
 const before=buildContext({...args,coreMemory});assert.equal(before.payload.coreMemory.items.length,1);assert.equal(before.payload.coreMemory.items[0].lastEvidenceAt,'2026-08-16T09:00:00Z');
 assert.equal(before.payload.coreMemory.items[0].currentStatus,'not_established_by_old_evidence');
 assert.ok(before.manifest.contextSelection.coreSourceRefs.some(ref=>ref.sourceId===sourceId));
 assert.equal(before.payload.sources.some(source=>source.id===sourceId),false,'dated core summary does not reload the entire old conversation');
 const after=buildContext({...args,coreMemory,availableSources:before.fullAvailableSources.filter(source=>source.id!==sourceId)});
 assert.equal(after.payload.coreMemory,undefined,'core requires the still-live original evidence');
});
test('large recent windows defer complete original sources with explicit coverage instead of a count quota',t=>{
 const {args}=fixture(t);args.records=Array.from({length:30},(_,i)=>message(400+i,i,`RECENT_SEGMENT_${i}:`+'x'.repeat(1300)));
 // Separate complete episodes so an oversized optional segment can be deferred.
 for(const [i,record]of args.records.entries())record.timestamp=Date.parse(args.asOf)-(30-i)*3600000;
 const context=buildContext({...args,settings:{assistantRequestBytes:32000}}),selection=context.manifest.contextSelection;
 assert.equal(selection.recentQQ.candidateSourceIds.length,30);assert.ok(selection.recentQQ.omittedSourceIds.length>0);
 assert.equal(context.payload.deferredContext.recentQQSourceCount,selection.recentQQ.omittedSourceIds.length);
 for(const source of context.payload.sources.filter(source=>source.type==='qq'))assert.equal(source.text,args.records.find(message=>message.messageId===source.messageId).text);
 assert.equal(context.payload.taskContext.consultationTask.focus[0].laterAvailableMessageCount,0);
});
