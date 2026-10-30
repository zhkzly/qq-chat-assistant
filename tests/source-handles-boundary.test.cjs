'use strict';
// Functional reference-boundary checks only: no dialogue-quality or desktop
// integration claim. The exact actual019 sequence9 response below is preserved
// from .goal-runs/context-019-candidate-live/transport.json. Its recorded hash and
// the invented hybrid ID match /tmp/qq-019-reference-diagnostic.json. The reduced
// input retains the referenced material, current request and latest QQ source;
// it is a source-derived boundary fixture, not an actual replay output.
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {SourceHandleOwner,VERSION}=require('../src/source-handles.cjs');
const {resolveDraftMaterial,assertDraftSourcesCurrent}=require('../src/context/draft-material.cjs');
const {scope}=require('./fixtures/native.cjs');
const actual019Raw="{\"kind\":\"discussion\",\"text\":\"我会按她这次问的“主要是怎么查的”来回，简单讲清楚你自己的小网页和按标题找摘记的功能。\",\"requestDelivery\":{\"mode\":\"editable_message\",\"sourceId\":\"private:0227f276-c563-4949-b646-8568393d0fb2\",\"quote\":\"帮我回。\"},\"draftPlan\":{\"intent\":\"reply\",\"taskUse\":\"continue\",\"language\":\"zh-CN\",\"style\":\"natural\",\"askFollowup\":false,\"useEmoji\":false,\"quotes\":[{\"sourceId\":\"private:lp-u0\",\"text\":\"我做的是给自己记读书笔记的小网页，不是公司项目，也没有替别人做商业网站。查找功能终于能按标题找回自己的摘记，这个小进展我愿意告诉她。\",\"authorization\":{\"permission\":{\"sourceId\":\"private:0227f276-c563-4949-b646-8568393d0fb2\",\"text\":\"她接着问这些，我想自然讲讲，帮我回。\"},\"referent\":{\"sourceId\":\"private:lp-u0\",\"text\":\"我做的是给自己记读书笔记的小网页，不是公司项目，也没有替别人做商业网站。查找功能终于能按标题找回自己的摘记，这个小进展我愿意告诉她。\"}}},{\"sourceId\":\"qq:72057594049927937002\",\"text\":\"能把以前记的东西找回来就很实用，主要是怎么查的？\"}],\"guidance\":{\"objective\":{\"text\":\"自然回答她问的查找方式，并分享一点自己的小网页进展。\",\"sourceIds\":[\"private:0227f276-0758-46c0-9613-e5e672159b16\",\"private:0227f276-c563-4949-b646-8568393d0fb2\",\"qq:72057594049927937002\"]},\"allowedApproach\":{\"text\":\"用日常说法说明这是给自己记读书笔记的小网页，能按标题找回自己的摘记。\",\"sourceIds\":[\"private:lp-u0\",\"private:0227f276-c563-4949-b646-8568393d0fb2\"]},\"avoidances\":[{\"text\":\"不包装成公司或商业项目，也不编造其他功能或技术细节。\",\"sourceIds\":[\"private:lp-u0\"]}],\"currentStep\":{\"text\":\"回应她关于怎么查的好奇，不重提周六安排。\",\"sourceIds\":[\"qq:72057594049927937002\",\"private:0227f276-c563-4949-b646-8568393d0fb2\"]}}}}";
const actual019Hash="34420b6952a6a5dcd07f1dfb2e03bb6e554031a2508a9464631e785660982813";
const actual019Input={"sources":[{"id":"private:lp-u0","type":"private","text":"我做的是给自己记读书笔记的小网页，不是公司项目，也没有替别人做商业网站。查找功能终于能按标题找回自己的摘记，这个小进展我愿意告诉她。我已经定下十月三日那个周六下午三点以后有空，也愿意在合适的时候让她看这个个人页面；之前的时段另有私事，不想解释给她。家里人的复查安排只在这里和你商量，不写进对外的话。平时可以直接说我自己的开心，不用把一个个人小项目包装成能力展示。","at":"2026-08-31T10:00:00.000Z","role":"user","use":"discussion","kind":"discussion","version":1,"revision":"cd55b0871967666658dfe29e12c36782df866a8d1a2fd264422207109c0b40a9","historicalOnly":true,"continuationCoverage":"later_private_sources_omitted"},{"id":"qq:72057594049927937002","type":"qq","text":"原来是你自己用的呀。能把以前记的东西找回来就很实用，主要是怎么查的？","at":"2026-10-01T10:22:00.000Z","role":"contact","direction":"incoming","use":"discussion","messageId":"72057594049927937002","sequence":"2","senderUid":"eval_replay_contact","senderUin":"3333333333","revision":"cc1e4d8eef1d5179844040867fa34caa61b1ca5f8fb059205debdbbfc3000c64","speaker":"对方"},{"id":"private:0227f276-c563-4949-b646-8568393d0fb2","type":"private","text":"她接着问这些，我想自然讲讲，帮我回。","at":"2026-10-01T10:25:00.000Z","role":"user","use":"discussion","kind":"discussion","version":1,"revision":"9180fcd451f1b3bd254afcf0314235e4e18d1a5a4f6bdb9189af6af6dc1189ee"}],"intentAuthority":{"sourceId":"private:0227f276-c563-4949-b646-8568393d0fb2"},"userRequest":{"sourceId":"private:0227f276-c563-4949-b646-8568393d0fb2","text":"她接着问这些，我想自然讲讲，帮我回。"},"allowedMaterialIds":[],"selectedMaterialIds":[],"draftMaterialPolicy":{"version":1}};
const INVENTED='private:0227f276-0758-46c0-9613-e5e672159b16';
const MATERIAL='private:lp-u0',CURRENT='private:0227f276-c563-4949-b646-8568393d0fb2',QQ='qq:72057594049927937002';
const clone=value=>structuredClone(value);
const fresh=()=>new SourceHandleOwner({scope,taskId:'source-handle-boundary'});
function alias(snapshot,id){const entry=snapshot.receipt.bindings.find(item=>item.sourceId===id);assert.ok(entry,`source offered: ${id}`);return entry.handle;}
function offer(owner,payload){return owner.preview(payload,{sources:payload.sources||[],sourceRevisions:Object.fromEntries((payload.sources||[]).map(source=>[source.id,source.revision]))});}
function source(id=MATERIAL){return clone(actual019Input.sources.find(item=>item.id===id));}
function oneSource(id=MATERIAL){return {purpose:'discussion',sources:[source(id)]};}
function withoutProtocol(value){const result=clone(value);delete result.sourceReferenceProtocol;return result;}
function sourceError(field){return error=>error.code==='unknown_source_handle'&&error.field===field;}

// Only reference slots are changed here: exact actual response prose and quote
// bodies remain untouched. The unknown original ID deliberately remains intact.
function actualResponseOnWire(snapshot){
 const response=JSON.parse(actual019Raw),handles=new Map(snapshot.receipt.bindings.map(item=>[item.sourceId,item.handle]));
 response.requestDelivery.sourceId=handles.get(response.requestDelivery.sourceId);
 for(const quote of response.draftPlan.quotes){
  quote.sourceId=handles.get(quote.sourceId);
  if(quote.authorization)for(const part of ['permission','referent'])quote.authorization[part].sourceId=handles.get(quote.authorization[part].sourceId);
 }
 for(const control of [response.draftPlan.guidance.objective,response.draftPlan.guidance.allowedApproach,...response.draftPlan.guidance.avoidances,response.draftPlan.guidance.currentStep])
  control.sourceIds=control.sourceIds.map(id=>handles.get(id)||id);
 return response;
}

test('actual019 mixed valid references and invented hybrid remain a rejection, never a dropped citation',()=>{
 assert.equal(createHash('sha256').update(actual019Raw).digest('hex'),actual019Hash);
 const original=JSON.parse(actual019Raw),ids=original.draftPlan.guidance.objective.sourceIds;
 assert.deepEqual(ids,[INVENTED,CURRENT,QQ]);
 assert.equal(actual019Input.sources.some(item=>item.id===INVENTED),false);
 const owner=fresh(),snapshot=offer(owner,clone(actual019Input));snapshot.commit();
 const response=actualResponseOnWire(snapshot),before=clone(response);
 assert.throws(()=>snapshot.decode(response),sourceError('$.draftPlan.guidance.objective.sourceIds[0]'));
 assert.deepEqual(response,before,'rejected output is retained intact for diagnostics');
 assert.deepEqual(original.draftPlan.guidance.objective.sourceIds,ids,'actual output is never rewritten as passing evidence');
 const validOnly=clone(response);validOnly.draftPlan.guidance.objective.sourceIds.shift();
 assert.deepEqual(snapshot.decode(validOnly).draftPlan.guidance.objective.sourceIds,[CURRENT,QQ],
  'diagnostic-only negative control isolates the invented reference');
});

test('unknown alias beside a valid alias rejects the complete typed array with an exact field',()=>{
 const owner=fresh(),snapshot=offer(owner,oneSource());snapshot.commit();
 const valid=alias(snapshot,MATERIAL);
 for(const unknown of ['s999',MATERIAL,INVENTED,'s1x']){
  const response={statePatch:{items:[{text:'Keep exact diagnostics.',sourceIds:[valid,unknown,valid]}]}},before=clone(response);
  assert.throws(()=>snapshot.decode(response),sourceError('$.statePatch.items[0].sourceIds[1]'));
  assert.deepEqual(response,before);
 }
 assert.equal(owner.size,1,'rejected response cannot introduce a source binding');
});

test('budget previews do not allocate aliases, reorder committed sources, or count as dispatch',()=>{
 const owner=fresh(),discarded=offer(owner,{sources:[source(QQ),source(CURRENT),source(MATERIAL)]});
 assert.equal(owner.size,0);
 assert.throws(()=>discarded.decode({sourceIds:[alias(discarded,QQ)]}),/not dispatched/);
 const first=offer(owner,oneSource());assert.equal(alias(first,MATERIAL),'s1');first.commit();
 assert.equal(owner.size,1);first.commit();assert.equal(owner.size,1,'dispatch commit is idempotent');
 const estimated=offer(owner,{sources:[source(CURRENT),source(QQ),source(MATERIAL)]});
 assert.equal(owner.size,1);
 const actual=offer(owner,{sources:[source(QQ),source(MATERIAL)]});
 assert.equal(alias(actual,MATERIAL),'s1');assert.equal(alias(actual,QQ),'s2');actual.commit();
 assert.equal(owner.size,2);assert.throws(()=>estimated.commit(),/changed before dispatch/);
 assert.throws(()=>discarded.commit(),/changed before dispatch/);
});

test('snapshot wire payload, nested source values and receipt cannot be changed after preview',()=>{
 const owner=fresh(),payload={...oneSource(),taskContext:{focus:[{sourceId:MATERIAL}]},sourceRevisions:{[MATERIAL]:source().revision}},before=clone(payload);
 const snapshot=offer(owner,payload);
 for(const value of [snapshot,snapshot.wirePayload,snapshot.wirePayload.sources,snapshot.wirePayload.sources[0],
  snapshot.wirePayload.taskContext,snapshot.wirePayload.taskContext.focus,snapshot.wirePayload.taskContext.focus[0],
  snapshot.wirePayload.sourceRevisions,snapshot.wirePayload.sourceReferenceProtocol,snapshot.receipt,snapshot.receipt.bindings,snapshot.receipt.bindings[0]])
  assert.equal(Object.isFrozen(value),true,'the HTTP offer and binding evidence are deeply immutable');
 assert.throws(()=>{snapshot.wirePayload.sources[0].id='s999';},TypeError);
 assert.throws(()=>snapshot.receipt.bindings.push({handle:'s999',sourceId:INVENTED}),TypeError);
 assert.deepEqual(payload,before);
 snapshot.commit();assert.deepEqual(snapshot.decode({sourceId:alias(snapshot,MATERIAL)}),{sourceId:MATERIAL});
 assert.deepEqual(payload,before,'dispatch and decoding do not mutate canonical input');
});

test('committed aliases survive lookup, larger source bodies, repair and restricted wording offers',()=>{
 const owner=fresh(),metadata={sources:actual019Input.sources,sourceRevisions:Object.fromEntries(actual019Input.sources.map(item=>[item.id,item.revision]))};
 // Production dispatch passes fullAvailableSources/manifest revisions even when
 // the restricted payload carries only the permitted quote/control fragments.
 const preview=payload=>owner.preview(payload,metadata),first=preview(oneSource()),initial=alias(first,MATERIAL);first.commit();
 const larger=oneSource();larger.sources[0].text+='\nAn additional visible source segment.';
 const read=preview({...larger,sourceIds:[MATERIAL],contextSources:[source(QQ)]});
 assert.equal(alias(read,MATERIAL),initial);assert.equal(owner.size,1);read.commit();
 const qq=alias(read,QQ),repair=preview({purpose:'draft_prepare',originalInput:{...larger,userRequest:clone(actual019Input.userRequest)},invalidResponse:'literal s1 and '+MATERIAL});
 assert.equal(alias(repair,MATERIAL),initial);assert.notEqual(alias(repair,CURRENT),initial);repair.commit();
 const wording=preview({purpose:'draft',outboundQuotes:[{sourceId:MATERIAL,text:source().text}],guidance:[{text:'A useful sourced instruction.',sourceIds:[CURRENT]}]});
 assert.equal(alias(wording,MATERIAL),initial);assert.equal(alias(wording,CURRENT),alias(repair,CURRENT));wording.commit();
 assert.deepEqual(wording.decode({sourceIds:[initial]}).sourceIds,[MATERIAL]);
 assert.throws(()=>wording.decode({sourceIds:[qq]}),sourceError('$.sourceIds[0]'),
  'a known owner alias absent from this HTTP offer is not accepted');
 assert.equal(owner.size,3);
});

test('omitted revision metadata reuses the committed address and discarded previews cannot rebind it',()=>{
 const owner=fresh(),first=offer(owner,oneSource());first.commit();
 const handle=alias(first,MATERIAL),revision=source().revision;
 const discarded=owner.preview({sourceId:MATERIAL},{sourceRevisions:{[MATERIAL]:'speculative-uncommitted-version'}});
 assert.notEqual(alias(discarded,MATERIAL),handle);assert.equal(owner.size,1);
 const restricted=owner.preview({purpose:'draft',outboundQuotes:[{sourceId:MATERIAL,text:source().text}]});
 assert.equal(alias(restricted,MATERIAL),handle,'a fragment-only payload retains its committed canonical address');
 assert.equal(restricted.receipt.bindings[0].revision,revision,'budget probes cannot replace committed revision fallback');
 restricted.commit();assert.equal(owner.size,1);assert.throws(()=>discarded.commit(),/changed before dispatch/);
 const changed=owner.preview({sourceId:MATERIAL},{sourceRevisions:{[MATERIAL]:'authoritative-new-version'}});changed.commit();
 assert.notEqual(alias(changed,MATERIAL),handle);assert.equal(owner.size,2);
 const later=owner.preview({sourceIds:[MATERIAL]});assert.equal(alias(later,MATERIAL),alias(changed,MATERIAL));
 assert.equal(later.receipt.bindings[0].revision,'authoritative-new-version');later.commit();
 assert.throws(()=>later.decode({sourceId:handle}),sourceError('$.sourceId'),'the prior revision is not offered under the current address');
});

test('catalog handles stay navigation and become neither delivered bodies nor sharing permission',()=>{
 const owner=fresh(),material=source(),catalog={purpose:'discussion',sources:[],allowedMaterialIds:[],selectedMaterialIds:[],
  memoryDiscovery:{entries:[{sourceId:MATERIAL,revision:material.revision,preview:'Navigation-only excerpt.',authority:'navigation_only_needs_source_lookup'}]}};
 const navigation=owner.preview(catalog,{sourceRevisions:{[MATERIAL]:material.revision}});navigation.commit();
 const handle=alias(navigation,MATERIAL),plan=navigation.decode({quotes:[{sourceId:handle,text:material.text}]});
 assert.throws(()=>resolveDraftMaterial(catalog,plan),/未能对应/,'a source address does not deliver its original body');
 const delivered={...clone(catalog),sources:[material]},read=offer(owner,delivered);assert.equal(alias(read,MATERIAL),handle);read.commit();
 const readPlan=read.decode({quotes:[{sourceId:handle,text:material.text}]});
 assert.throws(()=>resolveDraftMaterial(delivered,readPlan),error=>error.code==='draft_material_authorization_missing',
  'reading a catalog source does not create a grant');
 assert.deepEqual(catalog.allowedMaterialIds,[]);assert.deepEqual(delivered.allowedMaterialIds,[]);
 const permitted={...delivered,allowedMaterialIds:[MATERIAL]},explicit=offer(owner,permitted);explicit.commit();
 assert.deepEqual(resolveDraftMaterial(permitted,explicit.decode({quotes:[{sourceId:alias(explicit,MATERIAL),text:material.text}]})).sourceIds,[MATERIAL]);
});

test('new source revisions receive distinct aliases and stale dependencies still fail the business boundary',()=>{
 const owner=fresh(),payload={...oneSource(),allowedMaterialIds:[MATERIAL]},first=offer(owner,payload);first.commit();
 const oldHandle=alias(first,MATERIAL),oldPlan=first.decode({quotes:[{sourceId:oldHandle,text:source().text}]}),resolved=resolveDraftMaterial(payload,oldPlan);
 const prepared={manifest:{sourceRevisions:{[MATERIAL]:source().revision}}};
 assert.doesNotThrow(()=>assertDraftSourcesCurrent(prepared,resolved.sourceIds,{scope,availableSources:payload.sources}));
 const newer=clone(payload);newer.sources[0].revision='changed-after-lookup';
 const second=offer(owner,newer);assert.notEqual(alias(second,MATERIAL),oldHandle);second.commit();
 assert.throws(()=>second.decode({sourceId:oldHandle}),sourceError('$.sourceId'));
 assert.throws(()=>assertDraftSourcesCurrent(prepared,resolved.sourceIds,{scope,availableSources:newer.sources}),/来源版本已变化/);
 for(const key of ['accountUid','accountUin','peerUid','peerUin']){
  const rebound={...payload.sources[0],scope:{...scope,[key]:'another-identity'}};
  assert.throws(()=>assertDraftSourcesCurrent(prepared,resolved.sourceIds,{scope,availableSources:[rebound]}),/来源版本已变化/,key);
 }
 assert.deepEqual(first.receipt.bindings.find(item=>item.sourceId===MATERIAL).revision,source().revision,'original dispatch evidence retains its old revision');
});

test('owner binding captures account, contact and task identity instead of following mutable scope',()=>{
 const mutable=clone(scope),owner=new SourceHandleOwner({scope:mutable,taskId:'task-a'});
 assert.equal(owner.matches(clone(scope),'task-a'),true);assert.equal(owner.matches(scope,'task-b'),false);
 for(const key of ['accountUid','accountUin','peerUid','peerUin'])assert.equal(owner.matches({...scope,[key]:'another-identity'},'task-a'),false,key);
 mutable.peerUid='changed-after-construction';assert.equal(owner.matches(scope,'task-a'),true);assert.equal(owner.matches(mutable,'task-a'),false);
 const first=offer(owner,oneSource());first.commit();
 for(const [otherScope,taskId]of [[scope,'task-b'],[{...scope,peerUid:'other-contact'},'task-a']]){
  const other=offer(new SourceHandleOwner({scope:otherScope,taskId}),oneSource());other.commit();
  assert.notEqual(other.receipt.bindingId,first.receipt.bindingId);
  const result=first.markCanonical(first.decode({sourceIds:[alias(first,MATERIAL)]}));
  assert.throws(()=>other.decode(result),/different HTTP offer/);
 }
});

test('typed source-keyed maps round-trip while record, turn, artifact and case identities stay distinct',()=>{
 const owner=fresh(),literal='Literal s1 '+MATERIAL+' and '+CURRENT;
 const payload={sources:[source(),source(CURRENT)],contextSources:[source(QQ)],
  sourceRevisions:{[MATERIAL]:source().revision},evidenceRevisions:{[CURRENT]:'revision-value-s1'},intentSourceRevisions:{[QQ]:'revision-'+MATERIAL},
  sourceRefs:[{sourceId:QQ,revision:'unchanged-source-revision',quote:{sourceId:MATERIAL,text:literal}}],
  topicContext:{active:{id:'s1',topicId:MATERIAL,purposeSourceIds:[CURRENT]}},
  privateConversation:[{id:'s1',turnId:MATERIAL,requestId:CURRENT,text:literal,sourceIds:[CURRENT]}],
  retrievedMemory:[{id:'s1',recordId:CURRENT,text:literal,sourceIds:[MATERIAL]}],
  experienceContext:{cases:[{id:'s1',caseId:MATERIAL,artifactRef:{artifactId:CURRENT,version:1},sourceIds:[MATERIAL]}]},
  selectedOption:{turnId:CURRENT,index:0},editingReference:{choice:'e1',artifactId:MATERIAL,version:1},
  text:literal,summary:literal,quote:literal,style:literal,invalidResponse:literal,formatError:literal,task:literal,guidanceText:literal};
 const before=clone(payload),snapshot=offer(owner,payload),wire=snapshot.wirePayload;
 assert.equal(wire.sources[0].id,alias(snapshot,MATERIAL));assert.equal(wire.contextSources[0].id,alias(snapshot,QQ));
 assert.deepEqual(wire.sourceRevisions,{[alias(snapshot,MATERIAL)]:source().revision});
 assert.deepEqual(wire.evidenceRevisions,{[alias(snapshot,CURRENT)]:'revision-value-s1'});
 assert.deepEqual(wire.intentSourceRevisions,{[alias(snapshot,QQ)]:'revision-'+MATERIAL});
 assert.deepEqual(wire.sourceRefs[0].quote,{sourceId:alias(snapshot,MATERIAL),text:literal},'a quote object still contains a typed reference while its literal text is preserved');
 for(const field of ['text','summary','quote','style','invalidResponse','formatError','task','guidanceText'])assert.equal(wire[field],literal,field);
 assert.equal(wire.topicContext.active.id,'s1');assert.equal(wire.topicContext.active.topicId,MATERIAL);
 assert.equal(wire.privateConversation[0].id,'s1');assert.equal(wire.privateConversation[0].turnId,MATERIAL);assert.equal(wire.privateConversation[0].requestId,CURRENT);
 assert.equal(wire.retrievedMemory[0].id,'s1');assert.equal(wire.retrievedMemory[0].recordId,CURRENT);
 assert.deepEqual(wire.experienceContext.cases[0].artifactRef,payload.experienceContext.cases[0].artifactRef);
 assert.equal(wire.experienceContext.cases[0].caseId,MATERIAL);assert.deepEqual(wire.selectedOption,payload.selectedOption);assert.deepEqual(wire.editingReference,payload.editingReference);
 snapshot.commit();assert.deepEqual(withoutProtocol(snapshot.decode(wire)),before);
 assert.deepEqual(payload,before);assert.equal(snapshot.receipt.version,VERSION);
});

test('canonical marker is private, prevents double decode, and cannot move to a different offer',()=>{
 const owner=fresh(),first=offer(owner,oneSource());first.commit();
 const result=first.decode({text:'A result with literal s1.',sourceIds:[alias(first,MATERIAL)]});
 assert.throws(()=>first.decode(result),sourceError('$.sourceIds[0]'),'unmarked canonical IDs are not accepted as model aliases');
 const before=JSON.stringify(result);assert.equal(first.markCanonical(result),result);
 assert.equal(first.decode(result),result,'the exact privately marked object is not decoded twice');
 assert.equal(JSON.stringify(result),before,'marking adds no enumerable or serialized trust flag');
 assert.deepEqual(Object.keys(result),['text','sourceIds']);assert.deepEqual(Object.getOwnPropertySymbols(result),[]);
 assert.throws(()=>first.decode(clone(result)),sourceError('$.sourceIds[0]'),'copying model-visible fields cannot copy private canonical authority');
 const second=offer(owner,oneSource());second.commit();assert.throws(()=>second.decode(result),/different HTTP offer/);
 assert.throws(()=>second.markCanonical(result),/another HTTP offer|different HTTP offer/,'another offer cannot overwrite the existing private binding');
 assert.equal(first.decode(result),result,'a rejected rebind preserves the original owner');
 const spoof={...clone(result),canonical:true,sourceReferenceProtocol:{version:VERSION},receipt:clone(first.receipt)};
 assert.throws(()=>second.decode(spoof),sourceError('$.sourceIds[0]'));
});

test('responsePreference is an input control marker and never becomes an evidence alias',()=>{
 const owner=fresh(),snapshot=offer(owner,{...oneSource(),controls:{sourceIds:['responsePreference',MATERIAL]}});
 assert.deepEqual(snapshot.wirePayload.controls.sourceIds,['responsePreference',alias(snapshot,MATERIAL)]);
 assert.equal(snapshot.receipt.bindings.some(item=>item.sourceId==='responsePreference'),false);snapshot.commit();
 assert.throws(()=>snapshot.decode({sourceIds:[alias(snapshot,MATERIAL),'responsePreference']}),sourceError('$.sourceIds[1]'));
});

test('preview, commit, project and decode leave canonical store and original QQ IDs unchanged',t=>{
 const {Store}=require('../src/store.cjs'),store=new Store(':memory:');t.after(()=>store.close());
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'A fictional private request containing literal s1.'});
 const before=store.getCompanion(scope),sources=store.memorySources(scope),sourceBefore=clone(sources),payload={sources,sourceIds:sources.map(item=>item.id)};
 const owner=fresh(),snapshot=offer(owner,payload);snapshot.commit();
 const decoded=snapshot.decode({sourceId:alias(snapshot,'private:'+turn.id),quote:'s1 '+turn.id});
 assert.equal(decoded.sourceId,'private:'+turn.id);assert.equal(decoded.quote,'s1 '+turn.id);
 assert.deepEqual(snapshot.project(decoded),{sourceId:alias(snapshot,'private:'+turn.id),quote:'s1 '+turn.id});
 assert.deepEqual(store.getCompanion(scope),before);assert.deepEqual(store.memorySources(scope),sourceBefore);assert.deepEqual(sources,sourceBefore);
 const originalQQ=source(QQ);assert.equal(typeof originalQQ.messageId,'string');assert.equal(originalQQ.messageId,'72057594049927937002');
});
