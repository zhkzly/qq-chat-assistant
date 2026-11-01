'use strict';
// Fictional captured-state contracts. Scripted decisions establish mechanics,
// not semantic entailment, conversational quality or actual QQ integration.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../src/store.cjs'),{writeRelationshipRecords}=require('../src/relationship-store.cjs');
const {prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {consolidateMemory}=require('../src/memory-engine.cjs');
const {buildContext}=require('../src/assistant-context.cjs');
const {normalize}=require('../src/messages.cjs');
const capture=require('./fixtures/activity-uncertainty-039.json');
const rawCounters=require('./fixtures/activity-039-raw-counter-inputs.json');
const settings={model:'gpt-6-luna',modelResponseMode:'result_tool'},copy=value=>structuredClone(value),scope=capture.scope;
const wire=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
const noop=p=>({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[]}});
function app(t,{onlyCancellation=false}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse(capture.pre.asOf)});const store=new Store(':memory:');t.after(()=>store.close());store.setGoal(scope,capture.goal);store.add(scope,copy(capture.pre.messages));
 const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),find=text=>p.sources.find(source=>source.text===text),invite=find(capture.pre.messages[0].text),accept=find(capture.pre.messages[1].text),cancel=find(capture.pre.messages[2].text);
 const activity={ref:'NEW',definition:{sourceId:invite.id,quote:invite.text}},event=(source,eventKind,actor)=>({activity,activityKey:'10月10日看展',eventKind,actor,text:source.text,sourceIds:[source.id],evidence:{statement:{sourceId:source.id,quote:source.text},time:{basis:'qq_statement'}}});
 const events=onlyCancellation?[event(cancel,'cancellation','contact')]:[event(invite,'invitation','self'),event(accept,'acceptance','contact'),event(cancel,'cancellation','contact')];
 const applied=store.applyMemoryBatch(scope,batch,request.decode({...noop(p),relationshipPatch:{claims:[],events,retire:[]}}));assert.equal(applied.applied,true,JSON.stringify(applied));
 const id=store.relationshipView(scope).activities[0].activityId;
 const recall=()=>{t.mock.timers.setTime(Date.parse(capture.recall.at));const m=capture.pre.messages[2],raw={chatType:1,peerUid:scope.peerUid,peerUin:scope.peerUin,senderUid:scope.peerUid,senderUin:scope.peerUin,msgId:m.messageId,msgSeq:m.sequence,msgTime:String(m.timestamp/1000),sendStatus:2,recallTime:String(Date.parse(capture.recall.at)/1000),elements:[{textElement:{content:m.text}}]};store.add(scope,[normalize(raw,scope)]);store.memorySources(scope);};
 return {store,id,recall};
}
test('captured038 M4 old model event shape cannot bypass required activity/statement/time selection',()=>{
 const request=prepareMemoryRequest(settings,capture.batch),p=wire(request);
 const aliases=new Map([...capture.batch.sources.map((s,i)=>[s.id,p.sources[i].id]),...capture.batch.contextSources.map((s,i)=>[s.id,p.contextSources[i].id])]);
 const events=capture.decoded.relationshipPatch.events.map(event=>({...event,sourceIds:event.sourceIds.map(id=>aliases.get(id))}));
 assert.throws(()=>request.decode({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events,retire:[]}}),error=>error.code==='invalid_activity_event'&&error.issues.some(issue=>issue.path==='relationshipPatch.events[0].activity'));
});
function reportFrame(t,store,text,at,id='activity-report'){
 t.mock.timers.setTime(Date.parse(at));const turn=store.appendTurn(scope,{id,role:'user',kind:'discussion',text}),batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),source=p.sources.find(source=>source.text===text);assert.ok(source);return {turn,batch,request,p,source};
}
for(const [name,sourceIndex,worldAt,timeQuote]of [['reconfirmation after source loss',0,'2026-10-07T10:00:00.000Z','今天18:00'],['world reconfirmation before knowledge loss, reported later',1,'2026-10-04T10:00:00.000Z','10月4日18:00（北京时间）']])test(name,t=>{
 const {store,id,recall}=app(t,{onlyCancellation:true});recall();const raw=rawCounters.sources[sourceIndex].cases[0].steps.at(-1).request,f=reportFrame(t,store,raw.text,raw.at||rawCounters.sources[sourceIndex].cases[0].steps.at(-1).as_of);
 const event={activity:{ref:f.p.activityContext.activities[0].ref},activityKey:'看展',eventKind:'acceptance',actor:'both',text:'用户报告重新确认了看展安排。',sourceIds:[f.source.id],evidence:{statement:{sourceId:f.source.id,quote:raw.text},time:{basis:'explicit',at:worldAt,sourceId:f.source.id,quote:timeQuote},plannedFor:{at:'2026-10-10T06:00:00.000Z',sourceId:f.source.id,quote:'10月10日下午两点'}}};
 const result=store.applyMemoryBatch(scope,f.batch,f.request.decode({...noop(f.p),relationshipPatch:{events:[event]}}));assert.equal(result.applied,true,JSON.stringify(result));const view=store.relationshipView(scope),record=view.events.at(-1);
 assert.equal(view.activities.find(item=>item.activityId===id).status,'accepted');assert.equal(record.occurredAt,worldAt);assert.equal(record.plannedFor,'2026-10-10T06:00:00.000Z');assert.equal(record.reportedAt,new Date(raw.at||rawCounters.sources[sourceIndex].cases[0].steps.at(-1).as_of).toISOString());assert.equal(record.origin,'user_report');
 t.mock.timers.setTime(Date.parse('2026-10-12T12:00:00Z'));assert.equal(store.relationshipView(scope).activities.find(item=>item.activityId===id).status,'accepted','passing the planned date does not complete an activity');
});
test('an explicit current-state report stays usable without a fictional reconfirmation timestamp',t=>{
 const {store,id,recall}=app(t,{onlyCancellation:true});recall();const text='我们现在又约好了，只是我记不清重新确认的具体时间。帮我接她一句。',f=reportFrame(t,store,text,'2026-10-07T11:18:00Z');
 const claim={subject:'dyad',aspect:'coordination',text:'用户报告现在又约好了，但重新确认时间未知。',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'temporary',attribution:'user_report',sourceIds:[f.source.id],activity:{ref:f.p.activityContext.activities[0].ref},currentState:{status:'accepted',statement:{sourceId:f.source.id,quote:'我们现在又约好了'}}};
 const applied=store.applyMemoryBatch(scope,f.batch,f.request.decode({...noop(f.p),relationshipPatch:{claims:[claim]}}));assert.equal(applied.applied,true,JSON.stringify(applied));const view=store.relationshipView(scope),activity=view.activities.find(item=>item.activityId===id),stored=view.claims[0];
 assert.equal(view.events.length,0);assert.equal(stored.occurredAt,undefined);assert.equal(activity.status,'accepted');assert.equal(activity.authority,'user_reported_current_state');assert.equal(activity.currentReportedState.asOf,'2026-10-07T11:18:00.000Z');assert.equal(activity.historicalEvidenceGap,true);assert.equal(store.memoryStatus(scope).semanticPending,0);
 const context=buildContext({scope,store,records:store.messages(scope),companion:store.getCompanion(scope),turn:f.turn,requestId:'activity-current-input',purpose:'discussion',coverage:{status:'complete'},availableSources:store.memorySources(scope),relationshipContext:view,asOf:'2026-10-07T11:18:00Z'});
 const offered=context.payload.relationshipContext.activities.find(item=>item.activityId===id);assert.equal(offered.currentReportedState.status,'accepted');assert.equal(offered.historicalEvidenceGap,true);assert.match(context.payload.relationshipContext.activityEvidenceRule,/do not negate/);
});
test('a pure question can finish processing as no-change; private record time cannot become speech-act time',t=>{
 const {store,id,recall}=app(t,{onlyCancellation:true});recall();const source=capture.batch.sources[0],f=reportFrame(t,store,source.text,source.at,source.id.slice(8));
 const invented={activity:{ref:f.p.activityContext.activities[0].ref},activityKey:'看展',eventKind:'cancellation',actor:'unknown',text:'An invented cancellation is not permitted by this carrier.',sourceIds:[f.source.id],evidence:{statement:{sourceId:f.source.id,quote:f.source.text},time:{basis:'qq_statement'}}};
 assert.throws(()=>f.request.decode({...noop(f.p),relationshipPatch:{events:[invented]}}),error=>error.code==='invalid_activity_event'&&error.issues.some(issue=>issue.path.endsWith('.evidence.time.basis')));
 assert.equal(store.applyMemoryBatch(scope,f.batch,f.request.decode(noop(f.p))).applied,true);assert.equal(store.relationshipView(scope).activities.find(item=>item.activityId===id).status,'needs_review');assert.equal(store.memoryStatus(scope).pending,0);assert.equal(store.memoryStatus(scope).semanticPending,0);
});
test('unknown historical occurrence date does not erase a reported shared experience',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-20T11:00:00Z')});const store=new Store(':memory:');t.after(()=>store.close());const text='我和她以前一起做过一次陶艺体验，但具体是哪一天我记不清了。',turn=store.appendTurn(scope,{id:'past-pottery-original',role:'user',kind:'discussion',text}),batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),s=p.sources[0];
 const event={activity:{ref:'NEW',definition:{sourceId:s.id,quote:'一起做过一次陶艺体验'}},activityKey:'陶艺体验',eventKind:'occurred',actor:'both',text,sourceIds:[s.id],evidence:{statement:{sourceId:s.id,quote:text},time:{basis:'unknown'}}};
 const applied=store.applyMemoryBatch(scope,batch,request.decode({...noop(p),relationshipPatch:{events:[event]}}));assert.equal(applied.applied,true,JSON.stringify(applied));const view=store.relationshipView(scope);assert.equal(view.events[0].occurredAt,null);assert.equal(view.events[0].reportedAt,turn.createdAt);assert.equal(view.activities[0].status,'occurred');assert.equal(store.memoryStatus(scope).semanticPending,0);assert.equal(store.experiences.list(scope).cases[0].eventAt,null);
});
test('independent activities can share invite and acceptance sources while only the exhibit gets a gap',t=>{
 const raw=rawCounters.sources[0].cases[1];t.mock.timers.enable({apis:['Date'],now:Date.parse(raw.initial.as_of)});const store=new Store(':memory:');t.after(()=>store.close());
 const messages=raw.initial.qq_events.map((event,index)=>normalize({chatType:1,peerUid:scope.peerUid,peerUin:scope.peerUin,senderUid:event.speaker==='self'?scope.accountUid:scope.peerUid,senderUin:event.speaker==='self'?scope.accountUin:scope.peerUin,msgId:String(72057594003900000n+BigInt(index)),msgSeq:String(index+1),msgTime:String(Date.parse(event.at)/1000),sendStatus:2,recallTime:'0',elements:[{textElement:{content:event.text}}]},scope));store.add(scope,messages);
 const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),[invite,accept,cancel]=p.sources;
 const make=(quote,label,source,kind,statement=source.text)=>({activity:{ref:'NEW',definition:{sourceId:invite.id,quote}},activityKey:label,eventKind:kind,actor:'contact',text:statement,sourceIds:[source.id],evidence:{statement:{sourceId:source.id,quote:statement},time:{basis:'qq_statement'}}});
 const events=[make('10月10日去看展','展览',accept,'acceptance'),make('10月11日去看电影','电影',accept,'acceptance'),make('10月10日去看展','展览',cancel,'cancellation')];assert.equal(store.applyMemoryBatch(scope,batch,request.decode({...noop(p),relationshipPatch:{events}})).applied,true);
 const before=store.relationshipView(scope).activities;assert.equal(before.find(item=>item.activityKey==='10月10日去看展').status,'cancelled');assert.equal(before.find(item=>item.activityKey==='10月11日去看电影').status,'accepted');
 t.mock.timers.setTime(Date.parse(raw.steps[1].source_updates[0].at));store.add(scope,[{...messages[2],recalled:true,recalledAt:Date.now(),text:'[已撤回]'}]);store.memorySources(scope);const after=store.relationshipView(scope).activities;
 assert.equal(after.find(item=>item.activityKey==='10月10日去看展').status,'needs_review');assert.equal(after.find(item=>item.activityKey==='10月11日去看电影').status,'accepted');assert.equal(new Set(after.map(item=>item.activityId)).size,2);
});
test('mixed mechanical errors are delivered together within one correction with unchanged full originals',async t=>{
 const {store}=app(t,{onlyCancellation:true});const text='再核对这次安排。',f=reportFrame(t,store,text,'2026-10-06T11:18:00Z'),requests=[];
 const result=await consolidateMemory({...settings,anonymous:true,baseUrl:'http://fixture.invalid/v1'},f.batch,undefined,async(_url,args)=>{
  const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;requests.push(request);
  if(requests.length===1)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...noop(p),relationshipPatch:{events:[{activity:{ref:'v999'},activityKey:'display',eventKind:'acceptance',actor:'contact',text:'Bad mechanical bindings.',sourceIds:['s999'],evidence:{statement:{sourceId:'s999',quote:'not delivered'},time:{basis:'explicit',at:'bad-date',sourceId:'s998',quote:'also missing'}}}]}})}}]}),{status:200});
  const paths=wrapper.validationError.issues.map(issue=>issue.path);for(const suffix of ['.activity.ref','.evidence.statement','.evidence.time.at','.evidence.time','.sourceIds'])assert.ok(paths.some(path=>path.endsWith(suffix)),suffix);assert.deepEqual(wrapper.originalInput,wire(f.request));assert.deepEqual(request.tools,requests[0].tools);assert.ok(wrapper.validationError.allowedChoices.activityRefs.includes('v1'));
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(noop(p))}}]}),{status:200});
 });
 assert.equal(requests.length,2);assert.equal(result.relationshipPatch.events.length,0);assert.ok(f.request.bytes<=f.request.budget);assert.ok(store.applyMemoryBatch(scope,f.batch,result).applied);
});
test('legacy038 cancellation withdrawal remains visible as opaque unresolved knowledge without its body',t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse(capture.pre.asOf)});const store=new Store(':memory:');t.after(()=>store.close());store.setGoal(scope,capture.goal);store.add(scope,copy(capture.pre.messages));store.memorySources(scope);writeRelationshipRecords(store,scope,[copy(capture.pre.event)]);
 t.mock.timers.setTime(Date.parse(capture.recall.at));store.add(scope,copy(capture.recall.messages));store.memorySources(scope);const view=store.relationshipView(scope);
 assert.equal(view.events.length,0);assert.equal(view.activityUncertainties.length,1);assert.equal(view.activityUncertainties[0].status,'needs_review');
 for(const value of [capture.pre.event.text,capture.pre.event.activityKey])assert.equal(JSON.stringify(view.activityUncertainties).includes(value),false);
});
test('repeated NEW definition in one proposal mints one identity, independent of display labels',t=>{
 const {store,id}=app(t);assert.match(id,/^activity:/);assert.equal(new Set(store.relationshipView(scope).events.map(event=>event.activityId)).size,1);assert.equal(store.relationshipView(scope).activities[0].status,'cancelled');
});
test('gap-only anchored activity retains identity and surviving definition without a world event',t=>{
 const {store,id,recall}=app(t,{onlyCancellation:true});recall();const view=store.relationshipView(scope),activity=view.activities.find(item=>item.activityId===id);
 assert.equal(view.events.length,0);assert.equal(activity.status,'needs_review');assert.equal(activity.activityKey,capture.pre.messages[0].text);assert.equal(activity.knowledgeChangedAt,new Date(capture.recall.at).toISOString());assert.equal(activity.affectedWorldAt,capture.pre.event.occurredAt);
 const gap=JSON.stringify(store.db.prepare('SELECT record FROM memory_gaps').all());assert.equal(gap.includes(capture.pre.event.text),false);assert.equal(gap.includes(capture.pre.event.activityKey),false);
 const batch=store.memoryBatch(scope),p=wire(prepareMemoryRequest(settings,batch));assert.equal(p.activityContext.activities[0].ref,'v1');assert.equal(p.activityContext.activities[0].gaps.length,1);
 assert.equal(store.applyMemoryBatch(scope,batch,prepareMemoryRequest(settings,batch).decode(noop(p))).applied,true);assert.equal(store.memoryStatus(scope).pending,0);assert.equal(store.memoryStatus(scope).semanticPending,0);
});
test('old acceptance and display relabel cannot clear an anchored cancellation evidence gap',t=>{
 const {store,id,recall}=app(t,{onlyCancellation:true});recall();const question=capture.batch.sources.find(source=>source.type==='private');t.mock.timers.setTime(Date.parse(question.at));store.appendTurn(scope,{id:question.id.slice(8),role:'user',kind:question.kind,text:question.text});
 const request=prepareMemoryRequest(settings,store.memoryBatch(scope)),p=wire(request),accept=[...p.sources,...p.contextSources].find(source=>source.text===capture.pre.messages[1].text);
 const event={activity:{ref:p.activityContext.activities[0].ref},activityKey:'看展',eventKind:'acceptance',actor:'contact',text:accept.text,sourceIds:[accept.id],evidence:{statement:{sourceId:accept.id,quote:accept.text},time:{basis:'qq_statement'}}};
 const batch=store.memoryBatch(scope),decoded=request.decode({...noop(p),relationshipPatch:{events:[event]}}),applied=store.applyMemoryBatch(scope,batch,decoded);assert.equal(applied.applied,true,JSON.stringify(applied));
 const view=store.relationshipView(scope);assert.equal(view.activities.find(item=>item.activityId===id).status,'needs_review');assert.equal(view.activities.length,1);
 const creation={...event,activity:{ref:'NEW',definition:p.activityContext.activities[0].definition}};assert.throws(()=>request.decode({...noop(p),relationshipPatch:{events:[creation]}}),error=>error.code==='invalid_activity_event');
});
test('NEW on a different old acceptance anchor remains provisional rather than silently resurrecting an agreement',t=>{
 const {store,recall}=app(t,{onlyCancellation:true});recall();const f=reportFrame(t,store,'撤回后请重新核对现有依据。','2026-10-06T11:18:00Z'),accept=[...f.p.sources,...f.p.contextSources].find(source=>source.text===capture.pre.messages[1].text);
 const event={activity:{ref:'NEW',definition:{sourceId:accept.id,quote:accept.text}},activityKey:'a relabelled arrangement',eventKind:'acceptance',actor:'contact',text:accept.text,sourceIds:[accept.id],evidence:{statement:{sourceId:accept.id,quote:accept.text},time:{basis:'qq_statement'}}};
 assert.equal(store.applyMemoryBatch(scope,f.batch,f.request.decode({...noop(f.p),relationshipPatch:{events:[event]}})).applied,true);const activities=store.relationshipView(scope).activities;assert.equal(activities.length,2);assert.equal(activities.every(activity=>activity.status==='needs_review'),true);assert.ok(activities.some(activity=>activity.authority==='unresolved_prior_activity_scope'));
});
test('source revision and label changes keep the minted identity until explicitly rebound to fresh original proof',t=>{
 const {store,id}=app(t,{onlyCancellation:true});t.mock.timers.setTime(Date.parse(capture.recall.at));const revised={...copy(capture.pre.messages[0]),text:'10月10日一起去新展厅吗？'};store.add(scope,[revised]);store.memorySources(scope);let view=store.relationshipView(scope);assert.equal(view.events.length,0);assert.equal(view.activities[0].activityId,id);assert.equal(view.activities[0].activityKey,null);
 const text='今天18:00我们重新确认了，还是一起去新展厅。',f=reportFrame(t,store,text,'2026-10-07T11:18:00Z'),definition=[...f.p.sources,...f.p.contextSources].find(source=>source.text===revised.text);
 const event={activity:{ref:f.p.activityContext.activities[0].ref,definition:{sourceId:definition.id,quote:definition.text}},activityKey:'changed display wording',eventKind:'acceptance',actor:'both',text:'用户报告重新确认了安排。',sourceIds:[f.source.id],evidence:{statement:{sourceId:f.source.id,quote:text},time:{basis:'explicit',at:'2026-10-07T10:00:00Z',sourceId:f.source.id,quote:'今天18:00'}}};
 const applied=store.applyMemoryBatch(scope,f.batch,f.request.decode({...noop(f.p),relationshipPatch:{events:[event]}}));assert.equal(applied.applied,true,JSON.stringify(applied));view=store.relationshipView(scope);assert.equal(view.activities.length,1);assert.equal(view.activities[0].activityId,id);assert.equal(view.activities[0].activityKey,revised.text);assert.equal(view.activities[0].status,'accepted');
});
test('another contact gap cannot contaminate the scoped activity projection',t=>{
 const {store,id,recall}=app(t);recall();const rows=store.db.prepare('SELECT * FROM memory_gaps WHERE scope_key=?').all(store.scopeKey(scope)),other={...scope,peerUid:'other-activity-contact',peerUin:'4444444444'};store.db.prepare('DELETE FROM memory_gaps WHERE scope_key=?').run(store.scopeKey(scope));for(const row of rows)store.db.prepare('INSERT INTO memory_gaps VALUES(?,?,?)').run(store.scopeKey(other),row.id,row.record);
 const activity=store.relationshipView(scope).activities.find(item=>item.activityId===id);assert.equal(activity.status,'accepted');assert.equal(activity.historicalEvidenceGap,false);
});
test('legacy result envelopes cannot bypass current native event evidence contracts',()=>{
 const request=prepareMemoryRequest(settings,capture.batch),p=wire(request),old={activityKey:'unbound',eventKind:'cancellation',actor:'unknown',text:'No native evidence selection.',sourceIds:[p.sources[0].id]};
 assert.throws(()=>request.decode({...noop(p),items:[],retire:[],relationshipPatch:{events:[old]}}),error=>error.code==='invalid_activity_event');
});
const snapshot=store=>JSON.stringify(['memory_sources','memory_journal','memory_records','memory_dependencies','memory_receipts','memory_meta','memory_gaps'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
for(const mode of ['body','revision','scope','missing-definition','withdrawal','CAS'])test(`new native activity evidence keeps Store authority/atomicity: ${mode}`,t=>{
 const {store,recall}=app(t,{onlyCancellation:true});recall();const f=reportFrame(t,store,'今天18:00重新确认了看展安排。','2026-10-07T11:18:00Z'),event={activity:{ref:f.p.activityContext.activities[0].ref},activityKey:'看展',eventKind:'acceptance',actor:'both',text:'用户报告重新确认了。',sourceIds:[f.source.id],evidence:{statement:{sourceId:f.source.id,quote:f.source.text},time:{basis:'explicit',at:'2026-10-07T10:00:00Z',sourceId:f.source.id,quote:'今天18:00'}}},decoded=f.request.decode({...noop(f.p),relationshipPatch:{events:[event]}}),proof=decoded.originalDelivery.find(source=>source.text===f.source.text);
 if(mode==='body')proof.text+='x';if(mode==='revision')proof.revision='stale';if(mode==='scope')proof.scope.peerUid='foreign';if(mode==='missing-definition'){const definitionId=f.batch.activityContext.activities[0].definition.sourceId;decoded.originalDelivery=decoded.originalDelivery.filter(source=>source.id!==definitionId);}
 if(mode==='withdrawal')store.forgetSource(scope,proof.id);if(mode==='CAS')store.saveNote(scope,{id:'interleaved-note',text:'A separate authorized fictional note.',use:'discussion'});if(['withdrawal','CAS'].includes(mode))store.memorySources(scope);
 const before=snapshot(store),result=store.applyMemoryBatch(scope,f.batch,decoded);assert.equal(result.applied,false,JSON.stringify(result));assert.equal(snapshot(store),before);
});
test('a frozen038 gap database upgrades without rewriting raw IDs/times/permissions/feedback or guessing gap identity',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-activity039-')),filename=path.join(directory,'baseline038.sqlite');t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const frozen=require('./fixtures/activity-baseline-038.cjs')(),restored=frozen.restore(filename),before=restored.expected;
 assert.equal(restored.oldStateVerifiedBeforeCurrent,true);assert.deepEqual(before.scope,scope);t.mock.timers.enable({apis:['Date'],now:Date.parse(before.testAsOf)});
 const store=new Store(filename);t.after(()=>store.close());assert.deepEqual(store.memorySources(scope),before.sources);assert.deepEqual(store.messages(scope),before.messages);const companion=store.getCompanion(scope);assert.deepEqual(companion.notes,before.companion.notes);assert.deepEqual(companion.goal,before.companion.goal);assert.deepEqual(companion.feedback,before.companion.feedback);assert.deepEqual(store.db.prepare('SELECT * FROM memory_gaps').all().map(row=>({...row})),before.gaps);
 const view=store.relationshipView(scope);assert.equal(view.events.length,0);assert.equal(view.activities.length,0);assert.equal(view.activityUncertainties.length,1);assert.equal(view.activityUncertainties[0].identityStatus,'legacy_unresolved');assert.equal(store.memoryStatus(scope).pending,0);
});
test('captured complete M4 initial and all-edge correction envelopes fit without shortening original evidence',()=>{
 const request=prepareMemoryRequest(settings,capture.batch),p=wire(request),aliases=new Map([...capture.batch.sources.map((source,index)=>[source.id,p.sources[index].id]),...capture.batch.contextSources.map((source,index)=>[source.id,p.contextSources[index].id])]),events=capture.decoded.relationshipPatch.events.map(event=>({...event,sourceIds:event.sourceIds.map(id=>aliases.get(id))})),invalid={...noop(p),relationshipPatch:{events}};let error;
 try{request.decode(invalid);}catch(caught){error=caught;}assert.equal(error.code,'invalid_activity_event');const correction=request.correction(JSON.stringify(invalid),error),body=JSON.parse(correction.serialized),wrapper=JSON.parse(body.messages[1].content);
 assert.deepEqual(wrapper.originalInput,p);assert.deepEqual(request.decode(noop(p)).originalDelivery,capture.decoded.originalDelivery);assert.ok(request.bytes<=request.budget);assert.ok(correction.bytes<=correction.budget);assert.ok(wrapper.validationError.issues.length>=4);
 if(process.env.QQ_ACTIVITY039_ARTIFACT_DIR){fs.mkdirSync(process.env.QQ_ACTIVITY039_ARTIFACT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.QQ_ACTIVITY039_ARTIFACT_DIR,'captured-m4-request-budget.json'),JSON.stringify({evidence:'zero-HTTP exact captured source set; no provider calls',initialBytes:request.bytes,correctionBytes:correction.bytes,limit:request.budget,sourceCount:request.decode(noop(p)).originalDelivery.length,issues:wrapper.validationError.issues.map(issue=>issue.path)},null,2)+'\n');}
});
