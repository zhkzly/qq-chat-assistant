'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional transport/Store integration only; scripted proposals do not prove
// natural-language entailment, permission judgment or conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {prepareMemoryRequest,consolidateMemory}=require('../src/memory-engine.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const {frozenLegacy,options:legacyOptions}=require('./fixtures/evidence-backed-memory.cjs');
const complete=(batch,extra={})=>({reviewedSourceIds:batch.reviewedSourceIds,items:[],episodes:[],retire:[],...extra});
const opts=store=>({baseRevision:store.getCompanion(scope).revision,sourceIds:store.memorySources(scope).map(source=>source.id),sourceRevisions:Object.fromEntries(store.memorySources(scope).map(source=>[source.id,source.revision])),deliveredSources:store.readOriginalEvidence(scope,{sourceIds:store.memorySources(scope).map(source=>source.id),maxBytes:100000}).sources});
const result=(value,name)=>new Response(JSON.stringify({choices:[{message:name?{tool_calls:[{id:'consumer',type:'function',function:{name,arguments:JSON.stringify(value)}}]}:{content:JSON.stringify(value)}}]}),{status:200});
const text=source=>source.text??source.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
const whole=source=>source.segments.length===1?source.segments[0].materialRef:source.materialChoices.find(choice=>choice.from===source.segments[0].materialRef&&choice.to===source.segments.at(-1).materialRef).materialRef;

test('normal memory schema has one typed writer, and an unread prior source never gets a citation alias',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const old=store.appendTurn(scope,{role:'user',kind:'discussion',text:'A fictional report about a temporary schedule.'}),id='private:'+old.id;
 assert.equal(store.applyRelationshipPatch(scope,{claims:[{subject:'contact',aspect:'recent_context',text:'A reported temporary schedule.',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'temporary',sourceIds:[id]}]},opts(store)).applied,true);
 let batch=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,batch,complete(batch)).applied,true);
 store.appendTurn(scope,{role:'user',kind:'discussion',text:'Please review the temporary schedule understanding.'});batch=store.memoryBatch(scope);
 assert.ok(batch.priorMemory.claims.length);const incomplete=structuredClone(batch);incomplete.contextSources=incomplete.contextSources.filter(source=>source.id!==id);
 const request=prepareMemoryRequest({model:'gpt-6-luna',modelResponseMode:'result_tool'},incomplete),schema=request.serialized&&JSON.parse(request.serialized).tools[0].function.parameters,p=JSON.parse(JSON.parse(request.serialized).messages[1].content);
 assert.equal(schema.properties.items,undefined);assert.equal(schema.properties.retire,undefined);assert.ok(schema.properties.relationshipPatch.properties.claims.items.properties.applicabilityKind);
 assert.equal(p.priorMemory.claims[0].originalsDelivered,false);assert.deepEqual(p.priorMemory.claims[0].sourceIds,[]);assert.equal(JSON.stringify(p).includes(id),false);
 assert.throws(()=>request.decode({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{subject:'contact',aspect:'recent_context',text:'An unsupported revision.',assertionKind:'reported',epistemicStatus:'supported',sourceIds:['c999']}]}}),error=>error.code==='unknown_memory_source_alias');
});

test('a legacy navigation item becomes typed knowledge only through an explicit original-backed versioned transition',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const first=store.appendTurn(scope,{role:'user',kind:'discussion',text:'The contact told me she enjoys ceramics.'}),id='private:'+first.id;
 let batch=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind:'fact',text:'A reported interest in ceramics.',sourceIds:[id]}]})).applied,true);
 const legacy=store._memoryRecords(scope).find(row=>row.recordType==='item');assert.equal(legacy.reviewComplete,false);
 const current=store.appendTurn(scope,{role:'user',kind:'discussion',text:'The contact again told me about enjoying ceramics.'}),currentId='private:'+current.id;batch=store.memoryBatch(scope);
 const patch={claims:[{subject:'contact',aspect:'interest',text:'The user reports that the contact enjoys ceramics.',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'recurring',sourceIds:[id,currentId],transition:{operation:'supersede',targets:[{id:legacy.id,expectedVersion:legacy.version}]}}]};
 assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{relationshipPatch:patch})).applied,true);
 const records=store._memoryRecords(scope),prior=records.find(row=>row.id===legacy.id),claim=records.find(row=>row.recordType==='claim');
 assert.equal(prior.status,'superseded');assert.equal(prior.semanticReview.successorId,claim.id);assert.equal(claim.reviewComplete,true);assert.equal(store.memoryStatus(scope).semanticPending,0);
 assert.equal(store.personUnderstanding(scope).contact.knownFacts[0].id,claim.id);assert.equal(store.ensureKnowledgeMigration(scope).changed,false);
});

test('normal event transition wire can replace a legacy commitment only with its delivered original roots and version',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const old=store.appendTurn(scope,{role:'user',kind:'discussion',text:'The contact accepted the fictional museum visit on October 1.'}),oldId='private:'+old.id;
 let batch=store.memoryBatch(scope);assert.equal(store.applyMemoryBatch(scope,batch,complete(batch,{items:[{kind:'commitment',text:'A reported accepted visit.',sourceIds:[oldId],topicKeys:['museum']}]})).applied,true);
 const current=store.appendTurn(scope,{role:'user',kind:'discussion',text:'The fictional museum visit was cancelled on October 3.'}),currentId='private:'+current.id;batch=store.memoryBatch(scope);
 const request=prepareMemoryRequest({model:'gpt-6-luna',modelResponseMode:'result_tool'},batch),body=JSON.parse(request.serialized),p=JSON.parse(body.messages[1].content),prior=p.priorMemory.items[0];
 assert.ok(body.tools[0].function.parameters.properties.relationshipPatch.properties.events.items.properties.transition);
 const decoded=request.decode({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{events:[{activityKey:'fictional-museum',eventKind:'cancellation',actor:'contact',text:'The user reports cancellation on October 3.',occurredAt:'2026-10-03T10:00:00Z',sourceIds:[p.sources.find(source=>source.text===current.text).id],transition:{operation:'supersede',targets:[{id:prior.id,expectedVersion:prior.version}]}}]}});
 assert.equal(store.applyMemoryBatch(scope,batch,decoded).applied,true);const records=store._memoryRecords(scope),event=records.find(record=>record.recordType==='relationship_event');
 assert.equal(records.find(record=>record.recordType==='item').status,'superseded');assert.equal(event.transition.targets[0].id,records.find(record=>record.recordType==='item').id);assert.ok(event.semanticReview.coverage.completeSourceIds.includes(oldId));assert.ok(event.sourceRevisions[currentId]);
});

test('withdrawing the only event removes private activity labels while retaining only an opaque uncertainty barrier',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const sentinel='PRIVATE_EVENT_LABEL_SENTINEL',source=store.appendTurn(scope,{role:'user',kind:'discussion',text:'A fictional private event report.'}),id='private:'+source.id;
 assert.equal(store.applyRelationshipPatch(scope,{events:[{activityKey:sentinel,eventKind:'occurred',actor:'both',text:'A reported event.',sourceIds:[id]}]},opts(store)).applied,true);
 assert.ok(JSON.stringify(store.relationshipView(scope)).includes(sentinel));store.forgetSource(scope,id);
 for(const view of [store.relationshipView(scope),store.personUnderstanding(scope),store.experiences.list(scope),store.getCompanion(scope)])assert.equal(JSON.stringify(view).includes(sentinel),false);
 assert.equal(JSON.stringify(store.db.prepare('SELECT record FROM memory_gaps').all()).includes(sentinel),false);assert.equal(store.relationshipView(scope).activities.length,0);
});

test('privacy-redacted model evidence cannot attest a complete stable understanding of hidden text',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'My API key is sk-abcdefghijklmnopqrstuvwxy12345 and I currently work on a personal project.'}),id='private:'+turn.id,batch=store.memoryBatch(scope);
 const output=await consolidateMemory({anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic'},batch,undefined,async(_url,args)=>{
  const p=JSON.parse(JSON.parse(args.body).messages[1].content);assert.equal(JSON.stringify(p).includes('sk-abcdefghijklmnopqrstuvwxy12345'),false);
  return result({batchId:p.batchId,reviewedAll:true,episodes:[],relationshipPatch:{claims:[{subject:'self',aspect:'recent_context',text:'The user reports a personal project.',assertionKind:'reported',epistemicStatus:'supported',applicabilityKind:'temporary',sourceIds:[p.sources[0].id]}]}});
 });
 assert.equal(output.originalDelivery[0].redactedForModel,true);assert.equal(store.applyMemoryBatch(scope,batch,output).applied,true);
 const claim=store.relationshipView(scope).claims[0];assert.equal(claim.reviewComplete,false);assert.equal(claim.semanticReview.coverage.complete,false);assert.equal(store.memoryStatus(scope).lastReview.originalCoverage.complete,false);assert.equal(claim.sourceRevisions[id],batch.sources[0].revision);
});

test('a real legacy unknown event date remains unverified across public profile, experience and background read projections',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq022-legacy-event-test-')),filename=path.join(directory,'fictional.sqlite');let store;
 t.after(()=>{store?.close();fs.rmSync(directory,{recursive:true,force:true});});const Old=frozenLegacy().Store;store=new Old(filename);
 const report=store.appendTurn(scope,{role:'user',kind:'discussion',text:'We previously tried a fictional craft, but I do not remember the date.'}),id='private:'+report.id;
 assert.equal(store.applyRelationshipPatch(scope,{events:[{activityKey:'fictional-legacy-craft',eventKind:'occurred',actor:'both',text:'A reported past craft with unknown date.',sourceIds:[id]}]},legacyOptions(store)).applied,true);
 const original=store.memorySources(scope).find(source=>source.id===id),oldRecord=store._memoryRecords(scope).find(record=>record.recordType==='relationship_event'),caseId=store.experiences.list(scope).cases[0].id;
 assert.equal(oldRecord.occurredAt,original.at,'the actual old Store copied the report clock');store.close();store=new Store(filename);
 const view=store.relationshipView(scope),experience=store.experiences.list(scope).cases[0];assert.equal(view.events[0].occurredAt,null);assert.equal(view.events[0].occurrenceTimeStatus,'legacy_unverified');
 assert.equal(experience.id,caseId);assert.equal(experience.eventAt,null);assert.equal(experience.reportedAt,original.at);assert.equal(experience.actualActions[0].eventAt,null);assert.equal(experience.actualActions[0].occurrenceTimeStatus,'legacy_unverified');assert.equal(experience.observations[0].eventAt,null);
 assert.equal(store.experiences.context(scope).cases[0].actualActions[0].eventAt,null);const stored=store._memoryRecords(scope).find(record=>record.id===oldRecord.id);assert.equal(stored.occurredAt,oldRecord.occurredAt,'preserve old bytes as unverified audit history');assert.equal(stored.reviewComplete,false);
 const batch=store.memoryBatch(scope),p=JSON.parse(JSON.parse(prepareMemoryRequest({model:'synthetic'},batch).serialized).messages[1].content);assert.equal(p.priorMemory.events[0].occurredAt,null);assert.equal(store.memorySources(scope).find(source=>source.id===id).revision,original.revision);
});

async function application(t,producer){
 const store=new Store(':memory:'),contexts=[],calls=[];t.mock.method(globalThis,'fetch',async()=>{throw Error('Unmocked HTTP forbidden');});
 const settings={anonymous:true,auto:false,model:'synthetic-evidence-consumer',baseUrl:'http://fixture.invalid/v1',modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false};settings.realChatConsent={...scope,model:settings.model,baseUrl:settings.baseUrl};
 const controller=new Controller({store,settings,compactionModel:null,read:async(command)=>command==='bind'?scope:{messages:[]},assistantModel:(settings,input,signal)=>{
  contexts.push(input);return assistModel(settings,input,signal,async(_url,args)=>{const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content),p=wrapper.originalInput||wrapper;calls.push(p);return result(producer(p,contexts.length-1),request.tool_choice.function.name);});
 }});t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('900719925474099872221',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'I finished a small shelf today.'}}]})]});return {store,controller,contexts,calls};
}

test('continuing consultation reuses only admitted original facts independently of candidate TTL and original private conditions remain present',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-01T10:00:00Z')});
 const fact='I repaired my reading lamp yesterday.',human=fact+' I want to tell her that; my family appointment is private and must not be shared.';
 let primary=0;const app=await application(t,p=>{
  if(p.purpose==='fidelity_check'){
   const material=p.admittedFragments[0],source=p.evidence.find(source=>source.sourceId===material.sourceId);assert.ok(source);
   return {checkRef:p.checkRef,factual:factualReview(p,{'suggestions[0].text':[{quote:p.candidate.suggestions[0].text,kind:'assertion',support:'supported',evidence:[{sourceId:source.sourceId,quote:source.text}],disclosure:[{sourceId:material.sourceId,quote:material.text}]}]}),verdict:'allow',issues:[]};
  }
  primary++;if(primary===1)return {operation:'prepare_message',currentFacts:[fact],answer:{suggestions:[{text:fact}]}};
  const source=p.sources.find(source=>source.type==='private'&&text(source)===human);assert.ok(source,'the actual original survives the outgoing-candidate lifetime');
  return {operation:'prepare_message',materials:[{materialRef:whole(source),authorityRef:source.authorityChoices.originalUserStatementCandidates[0].authorityRef}],answer:{suggestions:[{text:'The repaired lamp now lights my reading corner.'}],privateExplanation:'This refers back to the real lamp repair; the unrelated family reason stays private.'}};
 });
 await app.controller.assist({text:human,taskId:'first-support'});const firstRun=app.store.getCompanion(scope).runs.at(-1),sourceId=firstRun.payload.outboundQuotes[0].sourceId;
 t.mock.timers.tick(3*86400000);await app.controller.assist({text:'Continue the earlier real sharing direction.',taskId:'continued-support'});
 const primaryContext=app.contexts[2];assert.equal(primaryContext.payload.sources.find(source=>source.id===sourceId).text,human);
 assert.deepEqual(primaryContext.manifest.consultationSupport.fragments.map(({text})=>text),[fact]);assert.ok(primaryContext.payload.taskContext.recentHumanContext.some(source=>source.sourceId===sourceId&&source.bodyLocation==='sources'));assert.ok(app.calls[2].taskContext.recentHumanContext.some(source=>source.text===human));
 assert.ok(app.calls[3].evidence.some(source=>source.text===human));assert.equal(app.calls.length,4);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});

test('known QQ response and one private material question can be delivered together without an invented self event',async t=>{
 const app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}:{operation:'prepare_message',answer:{suggestions:[{text:'The shelf sounds like a satisfying little project.'}],privateExplanation:'I can respond to the shelf already mentioned. What real recent detail would you like to share about yourself?'}});
 const reply=await app.controller.assist({text:'Respond to her shelf and help me share something real; I have not supplied my own recent detail.',taskId:'partial-help'});
 assert.equal(app.calls.length,2);assert.equal(reply.text,'');assert.equal(reply.suggestions.length,1);assert.match(reply.discussionExplanation.text,/What real recent detail/);assert.deepEqual(app.calls[1].admittedFragments,[]);
});

test('an actual factual report survives a bad optional source handle without automatic regeneration',async t=>{
 let checks=0,primaries=0;const invented='I repaired a shelf yesterday.';
 const app=await application(t,p=>{
  if(p.purpose==='fidelity_check'){
   checks++;return checks===1?{checkRef:p.checkRef,factual:factualReview(p,{'suggestions[0].text':[{quote:invented,kind:'assertion',support:'unsupported',basis:'no_support_in_supplied_evidence'}]}),verdict:'reject',issues:[{path:'candidate.suggestions[0].text',code:'unsupported_fact',quote:invented,basis:'no_support_in_supplied_evidence',reason:'Scripted factual rejection.'}],concerns:[{path:'suggestions[0].text',code:'new_optional_diagnostic',reason:'Unusable advisory source coordinate.',sourceIds:['s999']}]}:{checkRef:p.checkRef,factual:factualReview(p,{}),verdict:'allow',issues:[],concerns:'malformed optional container'};
  }
  primaries++;return {operation:'prepare_message',answer:{suggestions:[{text:primaries===1?invented:'Your shelf sounds like a satisfying project.'}]}};
 });
 const reply=await app.controller.assist({text:'Respond to the known shelf, without inventing any personal history.',taskId:'valid-reject-invalid-advisory'});
 assert.equal(app.calls.length,2);assert.equal(primaries,1);assert.equal(checks,1);assert.equal(reply.suggestions[0].text,invented);assert.ok(reply.semanticReview.findings.some(f=>f.quote===invented));
 const run=app.store.getCompanion(scope).runs.at(-1),checksRun=run.requests.filter(request=>request.purpose==='fidelity_check');assert.ok(checksRun[0].manifest.fidelity.diagnostics.some(item=>item.code==='audit_invalid_concern'));
 assert.equal(app.controller.usage.get(scope,'valid-reject-invalid-advisory').requests.filter(request=>request.purpose==='delivery_repair').length,0);assert.equal(app.store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
