'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {buildContext}=require('../src/assistant-context.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const NOW=Date.parse('2026-10-30T08:00:00Z');
function message(id,text,index=0,own=false){return normalize(raw(String(id),own,{msgTime:String(NOW/1000-120+index),elements:[{textElement:{content:text}}]}),scope);}
function fixture(t,records,request='Help with this current request.'){
 const store=new Store(':memory:');t.after(()=>store.close());store.add(scope,records);
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:request});
 return {store,args:{scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',requestId:'synthetic-compiler-bounds',asOf:new Date(NOW).toISOString(),viewerTimeZone:'Asia/Shanghai',settings:{model:'synthetic',assistantRequestBytes:64000}}};
}
test('same-direction bubbles do not form an unbounded mandatory floor',t=>{
 const {args}=fixture(t,Array.from({length:30},(_,i)=>message(90000+i,`Current bubble ${i}.`,i)));
 const result=buildContext(args),qq=result.essentialSourceIds.filter(id=>id.startsWith('qq:'));
 assert.ok(qq.length<=24,`mandatory=${qq.length}`);
 assert.ok(result.payload.taskContext.recentExchange.length<=24);
 assert.equal(result.essentialSourceIds.includes('qq:90000'),false,'excess bubbles are optional history rather than mandatory current exchange');
});
test('unrelated active task source cannot make a small request fail',t=>{
 const {store,args}=fixture(t,[message(90000,'Current short message.')]);
 const old=store.appendTurn(scope,{role:'user',kind:'discussion',text:'OLD_PRIVATE_SENTINEL '+ 'z'.repeat(66500)});
 args.companion=store.getCompanion(scope);args.companion.topics={version:1,activeId:'old-task',items:[{id:'old-task',version:1,lifecycle:'active',objective:'Discuss an unrelated archive migration',direction:'Inspect old database archive',sourceIds:[`private:${old.id}`]}]};
 const result=buildContext({...args,topicContext:args.companion.topics});
 assert.equal(result.payload.userRequest.text,args.turn.text);
 assert.ok(result.manifest.inputBytes<=48000);
 assert.equal(result.essentialSourceIds.includes(`private:${old.id}`),false);
 assert.equal(result.payload.sources.some(source=>source.id===`private:${old.id}`),false);
 assert.equal(result.payload.topicContext.active.sourceAvailability,'lookup_required');
});
test('explicit lookup evidence precedes optional recent distractors and reports read status',t=>{
 const records=[message(80000,'Requested archive evidence '+ 'Q'.repeat(5000),-1000000),...Array.from({length:40},(_,i)=>message(91000+i,`Recent unrelated ${i} `+'d'.repeat(1400),i,i%2===0))];
 records.slice(1).forEach((record,index)=>{record.timestamp=NOW-(40-index)*3600000;});
 const {args}=fixture(t,records,'Find the requested archive evidence.');
 const result=buildContext({...args,byteBudget:24000,settings:{...args.settings,assistantRequestBytes:32000},retrievedSources:[{id:'qq:80000'}],lookupHistory:[{query:'requested archive',found:1}]});
 assert.ok(result.payload.sources.some(source=>source.id==='qq:80000'));
 assert.equal(result.manifest.sourceDelivery.explicitLookups[0].status,'delivered');
 assert.ok(result.manifest.contextSelection.recentQQ.omittedSourceIds.length>0);
});
test('huge direct source is bounded with exact revision-bound span, never whole-source authority',t=>{
 const text='BEGIN_LONG_SOURCE '+ 'v'.repeat(66500)+' END_LONG_SOURCE';
 const {args}=fixture(t,[message(92000,text)]);
 const result=buildContext(args),source=result.payload.sources.find(source=>source.id==='qq:92000');
 assert.equal(source.delivery.status,'partial');assert.equal(source.text,text.slice(source.delivery.start,source.delivery.end));
 assert.equal(source.delivery.originalCharLength,text.length);assert.ok(source.delivery.end<text.length);
 assert.equal(result.manifest.completeReview,false);
 assert.equal(result.manifest.sourceDelivery.partialSourceCount,1);
 assert.equal(result.fullAvailableSources.find(s=>s.id===source.id).text,text);
});
test('canonical sources carry raw text once across chronology and private task views',t=>{
 const {store,args}=fixture(t,[message(93000,'UNIQUE_QQ_LITERAL')]);
 const prior=store.appendTurn(scope,{role:'user',kind:'discussion',text:'UNIQUE_PRIVATE_LITERAL'});
 store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'Historical assistant response'});
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Continue.'});
 const result=buildContext({...args,turn,companion:store.getCompanion(scope)}),wire=JSON.stringify(result.payload);
 for(const literal of ['UNIQUE_QQ_LITERAL','UNIQUE_PRIVATE_LITERAL'])assert.equal(wire.split(literal).length-1,1,literal);
 assert.equal(result.payload.privateConversation.find(entry=>entry.id===prior.id).text,undefined);
});
test('an explicit offset read replaces a previous span without concatenation or false completeness',t=>{
 const body='PREFIX_SEGMENT '+ 'x'.repeat(9000)+' REQUESTED_TAIL '+ 'y'.repeat(9000);
 const {args}=fixture(t,[message(94000,body)]);
 const offset=body.indexOf('REQUESTED_TAIL');
 const result=buildContext({...args,retrievedSources:[{id:'qq:94000',offset,maxChars:300}],lookupHistory:[{query:'tail',found:1}]}),source=result.payload.sources.find(source=>source.id==='qq:94000');
 assert.equal(source.text,body.slice(offset,offset+300));assert.equal(source.delivery.start,offset);assert.equal(source.delivery.end,offset+300);
 assert.equal(source.text.includes('PREFIX_SEGMENT'),false);assert.equal(result.manifest.sourceDelivery.explicitLookups[0].status,'partial');
});
test('explicit reads that exceed the complete request ceiling report omitted evidence instead of found equals read',t=>{
 const records=[...Array.from({length:8},(_,i)=>message(95000+i,`ARCHIVE_${i} `+'a'.repeat(18000),-1000000+i)),message(96000,'Latest direct focus.')];
 const {args}=fixture(t,records),retrievedSources=records.slice(0,8).map(record=>({id:`qq:${record.messageId}`}));
 const result=buildContext({...args,byteBudget:18000,retrievedSources,lookupHistory:[{query:'archives',found:8}]});
 const statuses=result.manifest.sourceDelivery.explicitLookups;
 assert.equal(statuses.length,8);assert.ok(statuses.some(item=>item.status==='omitted'));
 assert.ok(statuses.some(item=>['partial','delivered'].includes(item.status)));assert.equal(result.payload.userRequest.text,args.turn.text);
 assert.ok(result.manifest.inputBytes<=18000);
});
test('core candidate knowledge ranks current relevance before inventory position and represents distinct aspects',t=>{
 const records=Array.from({length:12},(_,i)=>message(97000+i,`Grounding source ${i}`,-1000000+i));
 const {args}=fixture(t,records,'Tell me about the ceramic workshop.');
 const coreMemory=records.map((record,i)=>({id:`knowledge-${i}`,kind:'fact',status:'active',certainty:'stated',reviewComplete:true,subject:i===10?'self':'contact',aspect:i===10?'activity':'employment',lifecycle:'active',assertionKind:'stated',epistemicStatus:'supported',text:i===10?'The ceramic workshop is an explicitly discussed hobby.':`Unrelated office fact ${i}`,sourceIds:[`qq:${record.messageId}`]}));
 const result=buildContext({...args,coreMemory});assert.equal(result.payload.coreMemory.items[0].id,'knowledge-10');
 assert.ok(new Set(result.payload.coreMemory.items.map(item=>item.aspect)).size>1);
});
test('oversized task projections defer complete control fields and retain provenance without failing current request',t=>{
 const {args}=fixture(t,[message(98000,'Current direct focus.')]);
 const sourceId=`private:${args.turn.id}`,topic={id:'large-task',version:1,lifecycle:'active',objective:'Current meaning',direction:'d'.repeat(3000),constraints:Array.from({length:8},(_,i)=>`${i} `+'c'.repeat(1000)),progress:['p'.repeat(2000)],sourceIds:[sourceId]};
 const result=buildContext({...args,topicContext:{version:1,activeId:topic.id,items:[topic]}});
 assert.equal(result.payload.topicContext.active.controlCoverage,'partial_requires_original_lookup');
 assert.ok(result.payload.topicContext.active.omittedFields.length>0);assert.ok(Buffer.byteLength(JSON.stringify(result.payload.topicContext.active))<4500);
 assert.equal(result.manifest.contextSelection.taskSourceRefs[0].sourceId,sourceId);
});
test('delivered quote bindings use canonical source offsets and reject inconsistent declared spans',()=>{
 const {boundedSourceView,deliveredQuote}=require('../src/context/source-delivery.cjs');
 const source={id:'private:synthetic',revision:'revision-1',type:'private',text:'before MATERIAL after'},span=boundedSourceView(source,{offset:7,maxChars:8,maxBytes:1000});
 assert.deepEqual(deliveredQuote(span,'MATERIAL'),{sourceId:source.id,revision:source.revision,start:7,end:15});
 assert.equal(deliveredQuote(span,'before'),null);assert.equal(deliveredQuote({...span,delivery:{...span.delivery,end:999}},'MATERIAL'),null);
 assert.equal(deliveredQuote({...span,delivery:{...span.delivery,start:-1,end:7}},'MATERIAL'),null);
 assert.equal(deliveredQuote({...span,delivery:{...span.delivery,originalCharLength:undefined}},'MATERIAL'),null);
});
test('current task control references are field-bound private purpose evidence and never QQ observations',t=>{
 const {store,args}=fixture(t,[message(99000,'An actual contact observation.')]);
 const source=store.memorySources(scope).find(item=>item.id===`private:${args.turn.id}`),qq=store.memorySources(scope).find(item=>item.id==='qq:99000');
 const topic={id:'bound-task',version:1,lifecycle:'active',objective:'The user current purpose',direction:'Do not treat QQ observation as user instruction',sourceIds:[source.id,qq.id],sourceRevisions:{[source.id]:source.revision,[qq.id]:qq.revision},purposeBindings:{objective:{sourceIds:[source.id],sourceRevisions:{[source.id]:source.revision}},direction:{sourceIds:[qq.id],sourceRevisions:{[qq.id]:qq.revision}}}};
 const result=buildContext({...args,topicContext:{version:1,activeId:topic.id,items:[topic]}});
 assert.deepEqual(result.payload.topicContext.controlRefs,[{sourceId:source.id,revision:source.revision,fields:['objective']}]);
 assert.equal(result.payload.topicContext.active.applicability,'current_user_confirmed');
 const later=store.appendTurn(scope,{role:'user',kind:'discussion',text:'A different current request.'});
 const candidate=buildContext({...args,turn:later,companion:store.getCompanion(scope),topicContext:{version:1,activeId:topic.id,items:[topic]}});
 assert.equal(candidate.payload.topicContext.active.applicability,'requires_current_request_match');
 assert.equal(candidate.manifest.contextSelection.taskControlRefs[0].revision,source.revision);
});
test('a found handle with a different delivered span cannot claim that the requested range was read',()=>{
 const {boundedSourceView,sourceDeliveryManifest}=require('../src/context/source-delivery.cjs');
 const source={id:'qq:offset-handle',revision:'full-source-revision',text:'a'.repeat(10000)};
 const prefix=boundedSourceView(source,{offset:0,maxChars:100,maxBytes:1000});
 const manifest=sourceDeliveryManifest([source],[prefix],[{id:source.id,offset:9000,maxChars:100}]);
 assert.equal(manifest.explicitLookups[0].status,'omitted');assert.equal(manifest.explicitLookups[0].requestStatus,'omitted');
 assert.deepEqual(manifest.explicitLookups[0].requestedRange,{start:9000,end:9100});
 assert.equal(manifest.sources[0].status,'partial');
});
test('canonical current feedback intent remains exact even when its helper request is short',t=>{
 const {store,args}=fixture(t,[message(99100,'A short actual focus.')]);
 const intent=store.appendTurn(scope,{role:'user',kind:'discussion',text:'CURRENT_INTENT '+ 'i'.repeat(9000)});
 const helper=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Continue with the canonical feedback.'});
 const result=buildContext({...args,turn:helper,companion:store.getCompanion(scope),intentSourceId:`private:${intent.id}`});
 const source=result.payload.sources.find(source=>source.id===`private:${intent.id}`);assert.equal(source.text,intent.text);assert.equal(source.delivery,undefined);
 // Under a tight budget the bound intent degrades to an explicitly marked
 // range (never a silent slice, never dropped), while the short helper request
 // itself stays exact and the degradation stays explainable on the manifest.
 const tight=buildContext({...args,turn:helper,companion:store.getCompanion(scope),intentSourceId:`private:${intent.id}`,byteBudget:6000});
 const tightSource=tight.payload.sources.find(item=>item.id===`private:${intent.id}`);
 if(tightSource.delivery?.status==='partial'){
  assert.equal(tightSource.text,intent.text.slice(tightSource.delivery.start,tightSource.delivery.end));
  assert.ok(tightSource.delivery.lookup?.sourceId===tightSource.id);
  assert.ok(tight.manifest.degradation?.some(entry=>entry.appliedTo===tightSource.id));
  assert.equal(tight.payload.userRequest.text,helper.text);
 } else assert.equal(tightSource.text,intent.text);
});
test('an old oversized QQ observation referenced by an unrelated active task is navigation rather than mandatory raw evidence',t=>{
 const old=message('900719925474099899','OLD_QQ_SENTINEL '+ 'o'.repeat(66500),-1000000),latest=message('900719925474099900','A short current incoming message.');
 const {args}=fixture(t,[old,latest]);
 const topic={id:'unrelated-old-observation',version:1,lifecycle:'active',objective:'Review a different past archive topic',sourceIds:[`qq:${old.messageId}`]};
 const result=buildContext({...args,topicContext:{version:1,activeId:topic.id,items:[topic]}});
 assert.equal(result.essentialSourceIds.includes(`qq:${old.messageId}`),false);assert.equal(result.payload.sources.some(source=>source.id===`qq:${old.messageId}`),false);
 assert.equal(result.payload.topicContext.active.applicability,'requires_current_request_match');
 assert.ok(result.manifest.contextSelection.taskSourceRefs.some(ref=>ref.sourceId===`qq:${old.messageId}`));
 assert.equal(result.payload.sources.find(source=>source.type==='qq').messageId,latest.messageId);
});
test('explicit method reads deliver selected full cards once before optional recent distractors',t=>{
 const {args}=fixture(t,Array.from({length:40},(_,i)=>message(99200+i,`Optional current distractor ${i} `+'d'.repeat(1000),i,i%2===0)));
 const ids=['express_interest','shared_activity'],result=buildContext({...args,methodLookupIds:ids});
 assert.deepEqual(result.payload.methodCards.map(card=>card.id).sort(),[...ids].sort());
 assert.ok(result.payload.methodCatalog.every(card=>card.instruction===undefined));
 assert.equal(result.payload.methodSelection.operationalInstructionsLocation,'methodCards');
 const wire=JSON.stringify(result.payload);
 for(const card of result.payload.methodCards)assert.equal(wire.split(JSON.stringify(card.instruction).slice(1,-1)).length-1,1);
 assert.ok(result.payload.methodSelection.lookupDelivery.every(item=>item.status==='delivered'));
 assert.deepEqual([...result.manifest.methodTrace.operationalDelivery.ids].sort(),[...ids].sort());
});
test('broad discovery candidates precede recent distractors while remaining optional and privately scoped',t=>{
 const records=Array.from({length:40},(_,i)=>message(99300+i,`Recent distractor ${i} `+'r'.repeat(1400),i,i%2===0));
 records.forEach((record,index)=>{record.timestamp=NOW-(40-index)*3600000;});
 const {store,args}=fixture(t,records,'What real material could we talk about?');
 const note=store.saveNote(scope,{kind:'material',use:'discussion',text:'PRIVATE_DISCOVERY_MATERIAL '+ 'm'.repeat(2000)}),sources=store.memorySources(scope),source=sources.find(source=>source.id===`note:${note.id}`);
 const memoryDiscovery={version:'synthetic-discovery',directory:[{id:'old-material',kind:'raw_source',subject:'self',text:source.text.slice(0,110),temporalStatus:'source_time_not_current_state',requiresOriginalRead:true,sourceIds:[source.id],sourceRefs:[{sourceId:source.id,revision:source.revision}]}],sourceIds:[source.id],sources:[source]};
 const options={...args,companion:store.getCompanion(scope),availableSources:sources,memoryDiscovery,byteBudget:24000,settings:{...args.settings,assistantRequestBytes:32000}},result=buildContext(options);
 assert.ok(result.payload.sources.some(item=>item.id===source.id));assert.equal(result.essentialSourceIds.includes(source.id),false);
 assert.equal(result.payload.allowedMaterialIds.includes(source.id),false);assert.equal(result.payload.memoryDiscovery.delivery[0].status,'delivered');
 const directoryView=buildContext({...options,byteBudget:48000,settings:{...args.settings,assistantRequestBytes:64000}});
 assert.equal(directoryView.payload.memoryDiscovery.directory[0].text,undefined);assert.equal(directoryView.payload.memoryDiscovery.directory[0].textFromSource,source.id);
 assert.equal(directoryView.payload.memoryDiscovery.directory[0].temporalStatus,'source_time_not_current_state');
 if(!result.payload.memoryDiscovery.directory.length)assert.ok(result.payload.memoryDiscovery.omittedEntryCount>0);
 const withdrawn=buildContext({...options,availableSources:sources.filter(item=>item.id!==source.id)});
 assert.equal(JSON.stringify(withdrawn.payload).includes('PRIVATE_DISCOVERY_MATERIAL'),false);assert.equal(withdrawn.payload.sources.some(item=>item.id===source.id),false);
});
test('retrieval uses the long-term goal only as a soft query hint and excludes an old task objective',()=>{
 const {retrievalQuery}=require('../src/context/policy.cjs');
 const query=retrievalQuery({text:'Current request',records:[],companion:{goal:{text:'GOAL_SOFT_HINT'},turns:[],topics:{activeId:'stale',items:[{id:'stale',lifecycle:'active',objective:'OLD_TASK_BIAS'}]}}});
 assert.ok(query.includes('GOAL_SOFT_HINT'));assert.equal(query.includes('OLD_TASK_BIAS'),false);
});
test('huge generated discussion reads use fingerprint-bound composite ranges without factual source authority',t=>{
 const {store,args}=fixture(t,[message(99400,'A short actual focus.')]);
 const assistant=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'GENERATED_HEAD '+ 'g'.repeat(66500),discussionExplanation:{kind:'discussion',text:'GENERATED_REASON '+ 'e'.repeat(5000)},suggestions:[{style:'natural',text:'GENERATED_CHOICE'}]});
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Read the earlier explanation segment.'}),companion=store.getCompanion(scope),original=companion.turns.find(item=>item.id===assistant.id);
 const {discussionReadBody}=require('../src/context/discussion-view.cjs'),{discussionTurnFingerprint}=require('../src/discussion-compaction-store.cjs');
 const body=discussionReadBody(original),offset=body.text.indexOf('GENERATED_REASON');
 const result=buildContext({...args,turn,companion,retrievedDiscussion:[{...original,requestedOffset:offset,requestedMaxChars:300}]}),read=result.payload.retrievedDiscussion[0];
 assert.equal(read.text,body.text.slice(offset,offset+300));assert.equal(read.originalTurnId,original.id);assert.equal(read.bodyView,'discussion-body-v1');
 assert.equal(read.turnFingerprint,discussionTurnFingerprint(original));assert.equal(read.delivery.status,'partial');assert.equal(read.delivery.offsetUnit,'utf16_redacted_discussion_body_v1');
 assert.equal(read.delivery.lookup.offset,offset+300);assert.deepEqual(read.delivery.lookup.discussionTurnIds,[original.id]);assert.match(read.authority,/generated.*not_factual/);
 assert.equal(read.discussionExplanation,undefined);assert.equal(result.payload.sources.some(source=>source.id===original.id),false);
 assert.equal(store.getCompanion(scope).turns.find(item=>item.id===original.id).text,original.text);assert.equal(result.manifest.discussionReads[0].turnFingerprint,read.turnFingerprint);
});
test('requested private discussion spans stay canonical references and cannot be expanded by whole-group admission',t=>{
 const {store,args}=fixture(t,[message(99500,'A current actual focus.')]);
 const old=store.appendTurn(scope,{role:'user',kind:'discussion',text:'PRIVATE_PREFIX '+ 'p'.repeat(6000)+' REQUESTED_PRIVATE_TAIL '+ 'q'.repeat(6000)});
 store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'A short generated acknowledgment.'});
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Read that specific private segment.'}),companion=store.getCompanion(scope),original=companion.turns.find(item=>item.id===old.id),sources=store.memorySources(scope),source=sources.find(item=>item.id===`private:${old.id}`);
 const offset=source.text.indexOf('REQUESTED_PRIVATE_TAIL'),{boundedSourceView}=require('../src/context/source-delivery.cjs');
 const chunk=boundedSourceView(source,{offset,maxChars:100,maxBytes:18000});chunk.requestedRange={offset,maxChars:100};
 const result=buildContext({...args,turn,companion,availableSources:sources,sourceLookupIds:[old.id],retrievedSources:[chunk],retrievedDiscussion:[{...original,requestedOffset:offset,requestedMaxChars:100}]}),delivered=result.payload.sources.find(item=>item.id===source.id),read=result.payload.retrievedDiscussion[0];
 assert.equal(delivered.text,source.text.slice(offset,offset+100));assert.equal(delivered.delivery.start,offset);assert.equal(read.sourceId,source.id);assert.equal(read.text,undefined);
 assert.equal(result.manifest.sourceDelivery.explicitLookups.find(item=>item.sourceId===source.id).requestStatus,'delivered');
 assert.equal(result.fullAvailableSources.find(item=>item.id===source.id).text,source.text);
});
