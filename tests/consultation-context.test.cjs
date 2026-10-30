'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {assistModel,prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {withoutCurrentControl}=require('./fixtures/wording-lanes.cjs');
function message(id,at,own=false,text='Synthetic actual message'){
 return normalize(raw(String(id),own,{msgTime:String(Date.parse(at)/1000),elements:[{textElement:{content:text}}]}),scope);
}
function fixture(t,{asOf='2026-10-16T08:00:00Z',records=[],text='先商量怎样继续了解她',replyMessageIds=[],purpose='discussion',invocation={origin:'user',trigger:'private_request',requestedPurpose:purpose}}={}){
 const store=new Store(':memory:');t.after(()=>store.close());store.setGoal(scope,'PRIVATE_GOAL_发展双方愿意的恋爱关系');if(records.length)store.add(scope,records);
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text});
 const args={scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose,coverage:{status:'partial'},
  availableSources:store.memorySources(scope),asOf,viewerTimeZone:'Asia/Shanghai',invocation,replyMessageIds};
 return {store,args,context:buildContext(args)};
}
test('consultation clock projects the viewer calendar instead of using UTC dates as local dates',t=>{
 const f=fixture(t,{asOf:'2026-10-16T00:00:00Z',records:[message(1001,'2026-10-15T16:10:00Z')]});const p=f.context.payload;
 assert.equal(p.asOf,'2026-10-16T00:00:00.000Z');assert.equal(p.viewerTimeZone,'Asia/Shanghai');
 assert.equal(p.taskContext.timeContext.localNow,'2026-10-16 08:00');
 assert.equal(p.taskContext.latestActual.localAt,'2026-10-16 00:10');assert.equal(p.taskContext.latestActual.elapsedMinutes,470);
 assert.equal(p.taskContext.recentExchange[0].localAt,'2026-10-16 00:10');
 assert.equal(p.sources.find(s=>s.id==='qq:1001').at,'2026-10-15T16:10:00.000Z','canonical source timestamp stays UTC');
});
test('two minutes over local midnight are two minutes and do not become a contact-action classification',t=>{
 const p=fixture(t,{asOf:'2026-10-15T16:01:00Z',records:[message(1101,'2026-10-15T15:59:00Z')]}).context.payload;
 assert.equal(p.taskContext.timeContext.localNow,'2026-10-16 00:01');assert.equal(p.taskContext.latestActual.localAt,'2026-10-15 23:59');
 assert.equal(p.taskContext.latestActual.elapsedMinutes,2);assert.equal(p.taskContext.latestActual.ageMs,120000);
 assert.equal(p.taskContext.mustWait,undefined);assert.equal(p.taskContext.consultationTask.action,undefined);
 assert.equal(p.taskContext.consultationTask.relationshipStage,undefined);
});
test('seventeen-hour exchange retains exact elapsed time while an explicit old focus stays a reference',t=>{
 const records=[message(1201,'2026-10-15T15:00:00Z'),message(1202,'2026-10-15T15:01:00Z',true),message(1203,'2026-10-15T15:02:00Z')];
 const p=fixture(t,{records,text:'回复昨天我选中的原话，不是重新发起聊天',replyMessageIds:['1201']}).context.payload;
 assert.equal(p.taskContext.latestActual.elapsedMinutes,1018);
 assert.deepEqual(p.taskContext.consultationTask,{purpose:'discussion',focusOrigin:'explicit_selection',focus:[{sourceId:'qq:1201',localAt:'2026-10-15 23:00',elapsedMinutes:1020,laterAvailableMessageCount:2}]});
 assert.match(p.userRequest.text,/回复昨天/);assert.equal(p.taskContext.consultationTask.action,undefined);
 assert.equal(p.taskContext.invocation.trigger,'private_request');assert.equal(p.taskContext.requestOrigin,'private_discussion');
});
test('future source time is exposed as an anomaly instead of a negative-time relationship signal',t=>{
 const p=fixture(t,{records:[message(1301,'2026-10-16T08:03:00Z')],replyMessageIds:['1301']}).context.payload;
 assert.equal(p.taskContext.latestActual.elapsedMinutes,-3);assert.equal(p.taskContext.latestActual.clockAnomaly,'future_timestamp');
 assert.equal(p.taskContext.consultationTask.focus[0].clockAnomaly,'future_timestamp');
 assert.equal(p.taskContext.consultationTask.focus[0].laterAvailableMessageCount,0);
});
test('request rebuilds retain a fixed clock and a compact whitelisted invocation',async t=>{
 const f=fixture(t,{invocation:{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply',privateReason:'PRIVATE_REASON'},records:[message(1401,'2026-10-15T15:00:00Z')]});
 const rebuilt=f.context.rebuildForRequest(payload=>Buffer.byteLength(JSON.stringify(payload),'utf8'));
 assert.equal(rebuilt.payload.asOf,f.context.payload.asOf);assert.deepEqual(rebuilt.payload.taskContext.timeContext,f.context.payload.taskContext.timeContext);
 assert.deepEqual(rebuilt.payload.taskContext.invocation,{origin:'automatic',trigger:'automatic_observation',requestedPurpose:'reply'});
 assert.equal(JSON.stringify(rebuilt.payload).includes('PRIVATE_REASON'),false);
 const unpinned=buildContext({...f.args,asOf:undefined});await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(unpinned.rebuildForRequest(payload=>Buffer.byteLength(JSON.stringify(payload),'utf8')).payload.asOf,unpinned.payload.asOf,'implicit clock also freezes at first build');
});
test('restricted draft keeps QQ navigation and complete current controls without adding private facts',t=>{
 const f=fixture(t,{records:[message(1501,'2026-10-15T15:00:00Z'),message(1502,'2026-10-15T15:01:00Z',true)],replyMessageIds:['1501'],text:'PRIVATE_REASON_想让她更在意我，仅供私下商量，给一句接话'});
 const draft=buildDraftContext(f.context,withCurrentDraftControls({intent:'reply',quotes:[]},f.context.payload),{scope,companion:f.args.companion,requestId:'synthetic-safe-clock-draft'}).payload;
 assert.equal(draft.asOf,f.context.payload.asOf);assert.deepEqual(draft.taskContext.timeContext,f.context.payload.taskContext.timeContext);
 assert.deepEqual(draft.taskContext.invocation,f.context.payload.taskContext.invocation);assert.equal(draft.taskContext.requestOrigin,'restricted_draft');
 assert.equal(draft.taskContext.consultationTask.purpose,undefined,'private task carrier is replaced by safe QQ focus');
 assert.deepEqual(draft.taskContext.consultationTask.focus,f.context.payload.taskContext.consultationTask.focus);
 const otherLanes=withoutCurrentControl(draft,f.args.turn.text);
 assert.equal(draft.currentHumanControl.sourceId,f.context.payload.intentAuthority.sourceId);assert.deepEqual(draft.outboundQuotes,[]);
 assert.equal(JSON.stringify(otherLanes).includes('PRIVATE_REASON'),false);assert.equal(JSON.stringify(otherLanes).includes('PRIVATE_GOAL'),false);
 assert.equal(draft.userRequest,undefined);assert.equal(draft.goal,undefined);
});
test('removed and missing focus refs do not reappear through consultation metadata',t=>{
 const f=fixture(t,{records:[message(1601,'2026-10-15T15:00:00Z'),message(1602,'2026-10-15T15:01:00Z')],replyMessageIds:['1601','9999']});
 const context=buildContext({...f.args,availableSources:f.args.availableSources.filter(s=>s.id!=='qq:1601')});
 assert.equal(JSON.stringify(context.payload.taskContext).includes('qq:1601'),false);assert.deepEqual(context.payload.taskContext.consultationTask.focus,[]);
 assert.equal(context.payload.taskContext.consultationTask.focusOrigin,'explicit_selection','a removed explicit choice is not silently replaced with another message');
 const draft=buildDraftContext(context,withCurrentDraftControls({intent:'reply',quotes:[]},context.payload),{scope,companion:f.args.companion,requestId:'synthetic-removed-focus'}).payload;
 assert.deepEqual(draft.taskContext.consultationTask.focus,[]);assert.equal(JSON.stringify(draft.taskContext).includes('qq:1601'),false);
});
test('actual format repair reassembly preserves the observation clock and selected older QQ focus',async t=>{
 const records=Array.from({length:14},(_,i)=>message(1700+i,new Date(Date.parse('2026-10-15T15:00:00Z')+i*60000).toISOString(),i%2===0,`Synthetic evidence ${i}. `.repeat(10)));
 const f=fixture(t,{records,replyMessageIds:['1702']});
 const baseSettings={model:'synthetic-consultation',baseUrl:'http://fixture.invalid/v1',anonymous:true,assistantRequestBytes:64000};
 const first=buildContext({...f.args,settings:baseSettings});
 const settings={...baseSettings,assistantRequestBytes:prepareAssistantRequest(baseSettings,first.payload).requestBytes+100};
 const context=buildContext({...f.args,settings}),requests=[];let rebuilds=0;
 const observed={...context,rebuildForRequest:measure=>{rebuilds++;return context.rebuildForRequest(measure);}};
 const result=await assistModel(settings,observed,undefined,async(_url,request)=>{
  const body=JSON.parse(request.body),payload=JSON.parse(body.messages[1].content);requests.push({body,payload,bytes:Buffer.byteLength(request.body,'utf8')});
  const answer=requests.length===1?{kind:'discussion',text:'Synthetic incomplete planning carrier',draftPlan:{intent:'reply',quotes:[]}}:{kind:'discussion',text:'Synthetic repaired consultation',draftPlan:withCurrentDraftControls({intent:'reply',quotes:[]},payload.originalInput)};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)}}]}),{status:200,headers:{'content-type':'application/json'}});
 });
 assert.equal(result.text,'Synthetic repaired consultation');assert.equal(requests.length,2);assert.equal(rebuilds,1,'repair wrapper must actually force a measured rebuild');
 const repaired=requests[1].payload.originalInput;
 assert.equal(repaired.asOf,context.payload.asOf);assert.equal(repaired.viewerTimeZone,'Asia/Shanghai');
 assert.deepEqual(repaired.taskContext.timeContext,context.payload.taskContext.timeContext);assert.deepEqual(repaired.taskContext.invocation,context.payload.taskContext.invocation);
 const focusedSource=repaired.sources.find(source=>source.messageId==='1702');assert.ok(focusedSource);assert.equal(repaired.taskContext.consultationTask.focus[0].sourceId,focusedSource.id);
 assert.ok(requests.every(request=>request.bytes<=settings.assistantRequestBytes));
});
test('same-millisecond private sources follow actual turn order and fit without false omitted-later markers',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-16T08:00:00Z')});
 const store=new Store(':memory:');t.after(()=>store.close());
 for(let i=0;i<4;i++){
  const user=store.appendTurn(scope,{id:`ffffffff-ffff-ffff-ffff-00000000000${i}`,role:'user',kind:'discussion',text:`过去第${i}次独立讨论。`});
  const answer=store.appendTurn(scope,{role:'assistant',kind:'discussion',requestId:`old-${i}`,text:`OLD_EVALUATED_${i}_`+'X'.repeat(4929),sourceIds:[`private:${user.id}`]});
  store.addFeedback(scope,{text:`仅评价过去第${i}次帮助：当时太正式。`,targetRef:{kind:'artifact',artifactRef:answer.artifactRef}});
 }
 const latest=store.appendTurn(scope,{id:'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',role:'user',kind:'discussion',text:'这次请保留轻松的表达方式，不要连续追问。'});
 const answer=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'最新完整私下回复。'.repeat(80),sourceIds:[`private:${latest.id}`]});
 const turn=store.appendTurn(scope,{id:'bbbbbbbb-bbbb-bbbb-bbbb-000000000001',role:'user',kind:'discussion',text:'接着刚才的意思帮我商量。'});
 const context=buildContext({scope,records:[],companion:store.getCompanion(scope),turn,purpose:'discussion',availableSources:store.memorySources(scope),coverage:{status:'empty'},byteBudget:7000,settings:{model:'synthetic',assistantRequestBytes:64000},asOf:'2026-10-16T08:00:00Z',viewerTimeZone:'Asia/Shanghai'});
 assert.ok(context.manifest.inputBytes<=7000);assert.equal(context.payload.privateConversation.find(item=>item.id===answer.id).text,answer.text);
 for(const id of [latest.id,turn.id])assert.equal(context.payload.sources.find(source=>source.id===`private:${id}`).historicalOnly,undefined,'omitted earlier turns cannot invalidate the newest private meaning');
 assert.equal(context.payload.taskContext.timeContext.localNow,'2026-10-16 16:00');assert.equal(context.payload.taskContext.timeContext.asOf,undefined,'UTC clock and viewer zone already exist at payload root');
 assert.equal(context.payload.taskContext.timeContext.viewerTimeZone,undefined);assert.equal(context.payload.asOf,'2026-10-16T08:00:00.000Z');
});
