'use strict';
// Exact fictional provider output contracts. Decoder/Store checks do not grade
// model semantics or demonstrate conversational/desktop improvement.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../src/store.cjs'),{prepareMemoryRequest,consolidateMemory,maintainMemory}=require('../src/memory-engine.cjs');
const {responseEnvelope}=require('../src/model-response-format.cjs');
const {scope,raw}=require('./fixtures/native.cjs'),{normalize}=require('../src/messages.cjs');
const capture=require('./fixtures/qq-clock-echo-040.json'),copy=value=>structuredClone(value),settings={...capture.settings,anonymous:true,baseUrl:'http://fixture.invalid/v1'};
const wire=request=>JSON.parse(JSON.parse(request.serialized).messages[1].content);
function bound(request){const value=copy(capture.proposal),before=copy(value);value.batchId=wire(request).batchId;delete before.batchId;const after=copy(value);delete after.batchId;assert.deepEqual(after,before,'scripted producer rebinds ONLY the program-owned opaque request fingerprint');return value;}
function minimal(value){value=copy(value);for(const event of value.relationshipPatch.events)if(event.evidence.time.basis==='qq_statement')event.evidence.time={basis:'qq_statement'};return value;}
function issueAt(error,path){return error.code==='invalid_activity_event'&&error.issues?.some(issue=>issue.path===path);}
const ledger=store=>JSON.stringify(['memory_sources','memory_journal','memory_records','memory_dependencies','memory_receipts','memory_meta','memory_gaps'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
function app(t,{message='10月10日一起去看看那个展吗？',secondTime=1790848800}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-03T11:18:00Z')});const store=new Store(':memory:');t.after(()=>store.close());store.add(scope,[normalize(raw('72057594004000001',true,{msgTime:'1790848800',elements:[{textElement:{content:message}}]}),scope),normalize(raw('72057594004000002',false,{msgTime:String(secondTime),elements:[{textElement:{content:'好呀，可以。'}}]}),scope)]);return store;
}
function eventFor(source,time,{kind='invitation',actor='self'}={}){return {activity:{ref:'NEW',definition:{sourceId:source.id,quote:source.text}},activityKey:'clock fixture',eventKind:kind,actor,text:source.text,sourceIds:[source.id],evidence:{statement:{sourceId:source.id,quote:source.text},time}};}
const noop=p=>({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[],events:[],retire:[]}});
test('captured rich QQ echoes and basis-only output decode identically with original clocks and planned dates',()=>{
 const batch=copy(capture.batch),before=copy(batch),request=prepareMemoryRequest(settings,batch),rich=bound(request),decoded=request.decode(rich),small=request.decode(minimal(rich));assert.deepEqual(decoded,small);assert.deepEqual(batch,before);
 for(const[index,event]of decoded.relationshipPatch.events.entries()){const source=decoded.originalDelivery.find(source=>source.id===event.activityProof.statement.sourceId);assert.equal(event.activityProof.occurrence.at,source.at);assert.equal(event.activityProof.statement.revision,source.revision);assert.equal(event.actor,rich.relationshipPatch.events[index].actor);assert.equal(event.activityProof.planned.at.slice(0,10),'2026-10-10');}
 assert.deepEqual(capture.proposal.relationshipPatch.events[0].evidence.time,{basis:'qq_statement',at:'2026-10-01T10:00:00.000Z',sourceId:'s1',quote:'10月10日一起去看看那个展吗？'});
});
test('equivalent zoned instants and optional independent echo subsets retain the canonical QQ clock',()=>{
 const request=prepareMemoryRequest(settings,capture.batch),rich=bound(request),expected=request.decode(minimal(rich));
 for(const event of rich.relationshipPatch.events)event.evidence.time.at=new Date(Date.parse(event.evidence.time.at)+8*3600000).toISOString().replace('Z','+08:00');assert.deepEqual(request.decode(rich),expected);
 for(const key of ['at','sourceId','quote']){const value=bound(request);for(const event of value.relationshipPatch.events){const time=event.evidence.time;event.evidence.time={basis:time.basis,[key]:time[key]};}assert.deepEqual(request.decode(value),expected);}
 const span=bound(request);span.relationshipPatch.events[1].evidence.time.quote='好呀';assert.deepEqual(request.decode(span),expected,'optional quote is a verified same-source locator, not a replacement occurrence witness');
});
for(const [key,value]of [['at','2026-10-01T11:00:00Z'],['sourceId','s2'],['quote','FORGED_QQ_QUOTE']])test(`a conflicting QQ ${key} echo has its precise field and expected/actual feedback`,()=>{
 const request=prepareMemoryRequest(settings,capture.batch),proposal=bound(request);proposal.relationshipPatch.events[0].evidence.time[key]=value;
 assert.throws(()=>request.decode(proposal),error=>{assert.ok(issueAt(error,`relationshipPatch.events[0].evidence.time.${key}`));const issue=error.issues.find(issue=>issue.path.endsWith('.'+key));assert.match(issue.message,/expected/i);assert.match(issue.message,/actual/i);assert.match(issue.message,/qq_statement/);assert.ok(issue.message.includes(value));return true;});
});
test('all conflicting echo leaves are reported in one existing correction, without changing the full original frame',async()=>{
 const request=prepareMemoryRequest(settings,capture.batch),invalid=bound(request);Object.assign(invalid.relationshipPatch.events[0].evidence.time,{at:'2026-10-01T11:00:00Z',sourceId:'s999',quote:'FORGED_QUOTE'});let calls=0;
 const result=await consolidateMemory(settings,capture.batch,undefined,async(_url,args)=>{calls++;const body=JSON.parse(args.body),wrapper=JSON.parse(body.messages[1].content),p=wrapper.originalInput||wrapper;
  if(calls===2){for(const suffix of ['.at','.sourceId','.quote'])assert.ok(wrapper.validationError.issues.some(issue=>issue.path==='relationshipPatch.events[0].evidence.time'+suffix));assert.deepEqual(wrapper.originalInput,wire(request));assert.deepEqual(body.tools,JSON.parse(request.serialized).tools);}
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?invalid:minimal(bound(request)))}}]}),{status:200});});assert.equal(calls,2);assert.deepEqual(result,request.decode(minimal(bound(request))));
});
test('a different statement source is rejected even when both actual QQ source timestamps are identical',t=>{
 const store=app(t),batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),first=p.sources[0],second=p.sources[1];assert.equal(first.at,second.at);
 const event=eventFor(first,{basis:'qq_statement',at:first.at,sourceId:second.id,quote:first.text});event.sourceIds.push(second.id);assert.throws(()=>request.decode({...noop(p),relationshipPatch:{events:[event]}}),error=>issueAt(error,'relationshipPatch.events[0].evidence.time.sourceId'));
});
test('private reports/questions and physical occurrences cannot become QQ clocks even with matching echoes',t=>{
 const store=app(t,{message:'刚才一起看完展回来了。'});store.appendTurn(scope,{id:'private-report-clock',role:'user',kind:'discussion',text:'我刚才向她提出过邀请，现在该怎么接？'});const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),privateSource=p.sources.find(source=>source.type==='private'),qq=p.sources.find(source=>source.type==='qq');
 for(const [source,kind]of [[privateSource,'invitation'],[qq,'occurred']]){const event=eventFor(source,{basis:'qq_statement',at:source.at,sourceId:source.id,quote:source.text},{kind});assert.throws(()=>request.decode({...noop(p),relationshipPatch:{events:[event]}}),error=>issueAt(error,'relationshipPatch.events[0].evidence.time.basis'));}
});
test('basis-specific schema admits minimal/rich QQ, forbids all unknown clock fields, and requires explicit witnesses',()=>{
 for(const payload of [undefined,wire(prepareMemoryRequest(settings,capture.batch))]){const schema=responseEnvelope(settings,'memory',payload).tools[0].function.parameters.properties.relationshipPatch.properties.events.items.properties.evidence.properties.time;
  assert.ok(Array.isArray(schema.anyOf));const byBasis=new Map(schema.anyOf.map(branch=>[branch.properties.basis.enum[0],branch]));assert.deepEqual(Object.keys(byBasis.get('unknown').properties),['basis']);assert.deepEqual(byBasis.get('qq_statement').required,['basis']);assert.deepEqual(byBasis.get('explicit').required,['basis','at','sourceId','quote']);
 }
 const request=prepareMemoryRequest(settings,capture.batch),value=minimal(bound(request));value.relationshipPatch.events[0].evidence.time={basis:'unknown',at:'2026-10-01T10:00:00Z'};assert.throws(()=>request.decode(value),error=>issueAt(error,'relationshipPatch.events[0].evidence.time.at'));
});
test('reported occurrence still needs its actual original time witness and unknown remains undated',t=>{
 const store=app(t);store.appendTurn(scope,{id:'reported-actual-time',role:'user',kind:'discussion',text:'我们10月2日18:00在语音里确认了。'});const batch=store.memoryBatch(scope),request=prepareMemoryRequest(settings,batch),p=wire(request),source=p.sources.find(source=>source.type==='private'),event=eventFor(source,{basis:'unknown'},{kind:'acceptance',actor:'both'});assert.equal(request.decode({...noop(p),relationshipPatch:{events:[event]}}).relationshipPatch.events[0].activityProof.occurrence.at,undefined);
 event.evidence.time={basis:'explicit',at:'2026-10-02T10:00:00Z',sourceId:source.id,quote:'10月2日18:00'};assert.equal(request.decode({...noop(p),relationshipPatch:{events:[event]}}).relationshipPatch.events[0].activityProof.occurrence.at,'2026-10-02T10:00:00.000Z');
 for(const key of ['at','sourceId','quote']){const bad=copy(event);delete bad.evidence.time[key];assert.throws(()=>request.decode({...noop(p),relationshipPatch:{events:[bad]}}),error=>error.code==='invalid_activity_event');}
});
test('plannedFor citation membership is separate and remains mandatory after QQ echo normalization',()=>{
 const request=prepareMemoryRequest(settings,capture.batch),proposal=bound(request),accept=proposal.relationshipPatch.events[1];accept.sourceIds=accept.sourceIds.filter(alias=>alias!==accept.evidence.plannedFor.sourceId);assert.throws(()=>request.decode(proposal),error=>issueAt(error,'relationshipPatch.events[1].sourceIds'));
});
test('legacy result envelopes cannot escape conflict checks and current initial/correction envelopes retain complete evidence',()=>{
 const request=prepareMemoryRequest(settings,capture.batch),proposal=bound(request);proposal.items=[];proposal.retire=[];proposal.relationshipPatch.events[0].evidence.time.sourceId='s2';let error;try{request.decode(proposal);}catch(caught){error=caught;}assert.ok(issueAt(error,'relationshipPatch.events[0].evidence.time.sourceId'));
 const correction=request.correction(JSON.stringify(proposal),error),body=JSON.parse(correction.serialized);assert.deepEqual(JSON.parse(body.messages[1].content).originalInput,wire(request));assert.ok(request.bytes<=request.budget);assert.ok(correction.bytes<=correction.budget);assert.deepEqual(request.decode(minimal(bound(request))).originalDelivery,[...capture.batch.sources,...capture.batch.contextSources].filter(source=>!source.deleted));
 if(process.env.QQ_CLOCK040_ARTIFACT_DIR){fs.mkdirSync(process.env.QQ_CLOCK040_ARTIFACT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.QQ_CLOCK040_ARTIFACT_DIR,'captured-request-budget.json'),JSON.stringify({initialBytes:request.bytes,correctionBytes:correction.bytes,limit:request.budget,originalCount:request.decode(minimal(bound(request))).originalDelivery.length,providerHttp:0},null,2)+'\n');}
});
const capturedScope=Object.fromEntries(['accountUid','accountUin','peerUid','peerUin'].map((key,index)=>[key,JSON.parse(capture.batch.scopeKey)[index]]));
function seedCaptured(t,{Ctor=Store,filename=':memory:'}={}){
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-03T11:01:00Z')});const store=new Ctor(filename);store.setGoal(capturedScope,'和这位朋友保持联系，商量一起看展的安排。');
 for(const source of capture.batch.sources){assert.equal(source.type,'qq');store.add(capturedScope,[normalize({chatType:1,peerUid:capturedScope.peerUid,peerUin:capturedScope.peerUin,senderUid:source.senderUid,senderUin:source.senderUin,msgId:source.messageId,msgSeq:source.sequence,msgTime:String(Date.parse(source.at)/1000),sendStatus:2,recallTime:'0',elements:[{textElement:{content:source.text}}]},capturedScope)]);}
 const actual=new Map(store.memorySources(capturedScope).map(source=>[source.id,source]));for(const source of capture.batch.sources)for(const key of ['id','text','at','revision'])assert.equal(actual.get(source.id)[key],source[key]);return store;
}
for(const mode of ['body','revision','scope','withdrawal','CAS'])test(`accepting rich echoes does not weaken Store ${mode} authority or atomicity`,t=>{
 const store=seedCaptured(t);t.after(()=>store.close());const batch=store.memoryBatch(capturedScope),request=prepareMemoryRequest(settings,batch),decoded=request.decode(bound(request));
 if(mode==='body')decoded.originalDelivery[0].text+='x';if(mode==='revision')decoded.originalDelivery[0].revision='wrong';if(mode==='scope')decoded.originalDelivery[0].scope.peerUid='foreign';
 if(mode==='withdrawal')store.forgetSource(capturedScope,batch.sources[0].id);if(mode==='CAS')store.saveNote(capturedScope,{id:'independent-cas',text:'An independently authored fictional note.',use:'discussion'});if(['withdrawal','CAS'].includes(mode))store.memorySources(capturedScope);
 const before=ledger(store),result=store.applyMemoryBatch(capturedScope,batch,decoded);assert.equal(result.applied,false,JSON.stringify(result));assert.equal(ledger(store),before);
});
test('a frozen039 echo-failed pending database reopens under the new contract without changing raw sources',async t=>{
 const old=require('./fixtures/clock-baseline-039.cjs')(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-clock040-')),filename=path.join(directory,'pending039.sqlite');t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const restored=old.restore(filename),before=restored.expected,sources=before.sources;
 assert.equal(restored.oldStateVerifiedBeforeCurrent,true);assert.deepEqual(before.scope,capturedScope);assert.equal(before.scriptedRequests,2);assert.equal(before.baselineResult.status,'error');assert.equal(before.baselineResult.pending,3);t.mock.timers.enable({apis:['Date'],now:Date.parse(before.testAsOf)});
 const store=new Store(filename);t.after(()=>store.close());let calls=0,newInput;const result=await maintainMemory({store,scope:capturedScope,settings,maxBatches:1,model:(configured,batch,signal)=>consolidateMemory(configured,batch,signal,async(_url,args)=>{calls++;newInput=JSON.parse(JSON.parse(args.body).messages[1].content);const value=copy(capture.proposal);value.batchId=newInput.batchId;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{status:200});})});
 assert.equal(calls,1);assert.notEqual(newInput.version,before.oldInputVersion);assert.notEqual(newInput.batchId,before.oldInputBatchId);assert.equal(result.pending,0);assert.equal(result.errors.length,0);assert.equal(store.relationshipView(capturedScope).activities[0].status,'cancelled');assert.deepEqual(store.memorySources(capturedScope),sources);
});
