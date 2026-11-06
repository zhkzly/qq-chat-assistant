'use strict';
// Actual saved fictional replay input/response and production consumers.
// Scripted transport proves integration, never semantic model quality.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const ROOT=process.env.SOURCE_CONTROL_PRODUCT_ROOT||path.resolve(__dirname,'..'),load=name=>require(path.join(ROOT,'src',name));
const saved=require('./fixtures/source-control-actual-head-seq2.json');
const {resolveAnswerMaterial,buildAnswerAdmission}=load('context/wording-view.cjs');
const {currentFactQuotes,buildCurrentHumanControl}=load('context/current-human-control.cjs');
const {prepareAssistantRequest,assistModel,parseAssistant}=load('assistant-model.cjs');
const {SourceHandleOwner}=load('source-handles.cjs');
const delivery=load('context/source-delivery.cjs');
const {buildContext}=load('assistant-context.cjs'),{Store}=load('store.cjs');
const scope=saved.context.manifest.scope,fact=saved.response.currentFacts[0];
const settings={model:'synthetic-source-consumer',modelResponseMode:'result_tool',baseUrl:'http://fixture.invalid/v1',anonymous:true,assistantRequestBytes:64000,discussionCompactionEnabled:false};
const packet=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{tool_calls:[{id:'consumer-result',type:'function',function:{name:'assistant_result',arguments:JSON.stringify(value)}}]}}]}),{status:200});
function fixture({complete=false}={}){
 const context=structuredClone(saved.context),original=structuredClone(saved.source),id=original.id;
 Object.defineProperty(context,'fullAvailableSources',{value:[original]});
 if(complete){const source=context.payload.sources.find(s=>s.id===id),start=source.delivery.end;context.payload.userRequest.sourceRevision=original.revision;context.payload.userRequest.readRanges=[{start,end:original.text.length,revision:original.revision,text:original.text.slice(start)}];}
 return {context,original,id};
}
function privateFacts(){return {kind:'discussion',text:'只在私下整理已经读到的原文。',requestDelivery:{mode:'private_help'},currentFacts:[fact]};}

test('actual fixture binds15731 original characters/46835 bytes and the failing fact to the served continuation',()=>{
 assert.equal(saved.source.text.length,15731);assert.equal(Buffer.byteLength(saved.source.text),46835);
 const source=saved.context.payload.sources[0],read=saved.context.payload.userRequest.readRanges[0];
 assert.equal(source.delivery.start,0);assert.equal(source.delivery.end,1790);assert.equal(read.start,3798);assert.equal(read.end,11798);
 assert.equal(saved.source.text.indexOf(fact),10940);assert.ok(read.text.includes(fact));assert.ok(!source.text.includes(fact));
});

test('actual continuation fact supports private analysis without minting an outward permission',()=>{
 const {context}=fixture(),material=resolveAnswerMaterial(context,privateFacts());
 assert.equal(material.quotes[0].text,fact);assert.equal(material.privateEvidenceOnly,true);assert.deepEqual(material.bindings,[]);
});

test('complete union consumes the continuation fact and permission without relabeling the base partial source whole',()=>{
 const {context,id}=fixture({complete:true}),view=context.payload.sources.find(s=>s.id===id),material=resolveAnswerMaterial(context,{currentFacts:[fact]});
 assert.equal(material.quotes[0].text,fact);assert.equal(material.bindings[0].material.sourceId,id);
 assert.equal(material.bindings[0].permission.text,saved.source.text);assert.equal(view.delivery.status,'partial');assert.equal(view.text.length,1790);
});

test('complete delivered union can offer current authority using local originals solely for private revision validation',()=>{
 const {context,original}=fixture({complete:true}),prepared=prepareAssistantRequest(settings,context.payload,[],{sourceRevisions:context.manifest.sourceRevisions,capturedSources:[original]});
 assert.ok(prepared.wirePayload.currentPermission);
 assert.equal(prepared.wirePayload.userRequest.delivery.status,'partial');assert.ok(!prepared.wirePayload.sources.some(source=>source.id===prepared.wirePayload.userRequest.sourceId));
 const incomplete=fixture(),missing=prepareAssistantRequest(settings,incomplete.context.payload,[],{capturedSources:[incomplete.original],sourceRevisions:incomplete.context.manifest.sourceRevisions});
 assert.equal(missing.wirePayload.currentPermission,undefined);
});

test('unread original gaps do not grant current private disclosure permission despite a locally complete original',()=>{
 const {context}=fixture();assert.throws(()=>currentFactQuotes(context,[fact]),error=>error.code==='current_fact_permission_incomplete');
});

test('a local original or generated summary cannot supply a fact absent from every delivered span',()=>{
 const {context,original}=fixture();let unknown;
 const spans=[context.payload.sources[0].text,...context.payload.userRequest.readRanges.map(part=>part.text)];
 for(let offset=12000;offset<original.text.length-80;offset++){const candidate=original.text.slice(offset,offset+80);if(spans.every(text=>!text.includes(candidate))){unknown=candidate;break;}}
 assert.ok(unknown,'choose an actual unread span, avoiding this notebook\'s repeated boilerplate');
 assert.throws(()=>currentFactQuotes(context,[unknown],{privateEvidenceOnly:true}),/actually delivered|unread|span/i);
});

test('wrong read revision and body substitution reject rather than borrowing the local original',()=>{
 for(const kind of ['revision','body']){
  const {context}=fixture();const part=context.payload.userRequest.readRanges[0];if(kind==='revision')part.revision='different-revision';else part.text='错'.repeat(part.text.length);
  assert.throws(()=>resolveAnswerMaterial(context,privateFacts()),/revision|range|captured|original/i);
 }
});

test('delivered-span validation rejects a same-ID body from a different contact scope',()=>{
 const {context,original}=fixture();original.scope={...scope,peerUid:'another-contact'};
 assert.throws(()=>resolveAnswerMaterial(context,privateFacts()),/source|scope|revision/i);
});

test('current restrictions still reject outward fact use with a complete delivered union',()=>{
 const {context,id}=fixture({complete:true});context.restrictions=[{sourceId:id,text:'Only private discussion is permitted.'}];
 assert.throws(()=>resolveAnswerMaterial(context,{currentFacts:[fact]}),/仅供私下|分享范围/);
});

test('private evidence is separately recorded and local completeness is distinct from producer delivery',()=>{
 const {context}=fixture(),human=buildCurrentHumanControl(context).control,admitted=buildAnswerAdmission(context,privateFacts(),{scope});
 assert.equal(human.localOriginalComplete,true);assert.equal(human.producerDelivery.complete,false);assert.ok(human.producerDelivery.unreadRanges.length);
 assert.deepEqual(admitted.payload.outboundQuotes,[]);assert.equal(admitted.payload.privateEvidence[0].text,fact);
 assert.equal(admitted.manifest.currentHumanControl.localOriginalComplete,true);assert.equal(admitted.manifest.currentHumanControl.complete,undefined);
});

test('actual premature prepare response can repair to private help without a model-created sticky artifact',async t=>{
 const {context}=fixture(),calls=[];
 // The saved diagnostic JSON omits the live context's nonenumerable callback.
 // Restore it with the production builder and the same original/source read.
 const store=new Store(':memory:');t.after(()=>store.close());const companion=store.getCompanion(scope),original=saved.source;
 const turn={id:original.id.slice(8),role:'user',kind:original.kind||'discussion',text:original.text,createdAt:original.at};
 companion.turns=[turn];companion.goal={...companion.goal,text:context.payload.goal};companion.revision=context.manifest.contextRevision;
 const read={...delivery.boundedSource(original,{start:3798,maxChars:8000,maxBytes:48000}),requestedRange:{offset:3798,maxChars:8000}};
 context.rebuildForRequest=measure=>buildContext({scope,records:[],companion,turn,availableSources:[original],retrievedSources:[read],asOf:context.payload.asOf,requestId:context.manifest.requestId,settings:{...settings,sourceHandleOwner:context.sourceHandleOwner},byteBudget:48000,requestMeasure:measure});
 const result=await assistModel(settings,context,undefined,async(_url,args)=>{const request=JSON.parse(args.body),wire=JSON.parse(request.messages[1].content);calls.push({request,wire});return packet(calls.length===1?saved.response:{operation:'advise',text:'先在私下整理实际读到的范围；未读部分不作判断。'});});
 assert.equal(calls.length,2);assert.equal(result.requestDelivery.mode,'private_help');
 assert.equal(calls[1].wire.originalInput.operationProtocol.requiredArtifact,undefined);
 assert.ok(calls[1].wire.task.includes('不能创造人类义务'));assert.ok(calls.every(c=>Buffer.byteLength(JSON.stringify(c.request))<=64000));
});

test('an existing explicit input message obligation remains binding during repair',async()=>{
 const source={id:'private:requested-message',type:'private',role:'user',revision:'r1',text:'现在给我一句能直接回复的话。'};
 const context={payload:{purpose:'discussion',generationOrigin:'private_discussion',intentAuthority:{sourceId:source.id},userRequest:{sourceId:source.id,text:source.text},requestDeliveryPolicy:{version:1,obligation:{mode:'editable_message'}},sources:[source]},manifest:{scope,requestId:'explicit-message',sourceRevisions:{[source.id]:'r1'}}};let calls=0;
 await assert.rejects(assistModel(settings,context,undefined,async()=>{calls++;return packet(calls===1?{operation:'prepare_message',answer:{suggestions:[]}}:{operation:'advise',text:'Only private strategy.'});}),/artifact|message|structured|usable|未能返回/);
 assert.equal(calls,2);
});

test('actual long current input reaches final ordinary and repair wire with generic head/tail ranges under unchanged byte caps',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());store.setGoal(scope,'围绕真实原文提供本轮帮助。');
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:saved.source.text,createdAt:saved.source.at}),context=buildContext({scope,records:[],companion:store.getCompanion(scope),turn,asOf:saved.source.at,requestId:'actual-long-edge',settings,byteBudget:48000}),calls=[];
 await assistModel(settings,context,undefined,async(_url,args)=>{const request=JSON.parse(args.body),wire=JSON.parse(request.messages[1].content);calls.push({request,wire});return packet(calls.length===1?{operation:'advise',text:''}:{operation:'advise',text:'这里只提供当前原文范围内的私下整理。'});});
 for(const call of calls){const input=call.wire.originalInput||call.wire,u=input.userRequest;assert.ok(u.text.startsWith(saved.source.text.slice(0,40)));assert.ok(u.readRanges.some(part=>part.end===saved.source.text.length&&part.text===saved.source.text.slice(part.start,part.end)));assert.ok(Buffer.byteLength(JSON.stringify(call.request))<=64000);}
 assert.ok(context.manifest.inputBytes<=48000);assert.ok(context.manifest.canonicalInputBytes>=context.manifest.inputBytes);
});

function historical(){
 const source={...structuredClone(saved.context.payload.sources[0]),id:'private:old-partial',historicalOnly:false},current={id:'private:current-small',type:'private',role:'user',revision:'current-r1',text:'按实际已读原文写一句，别补没读到的经历；我愿意分享已明确的相关事实。'};
 const payload={purpose:'discussion',generationOrigin:'private_discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:current.text},sources:[source,current]};
 const configured={...settings,sourceHandleOwner:new SourceHandleOwner({scope,taskId:'historical-partial'})};
 const prepared=prepareAssistantRequest(configured,payload);prepared.sourceWire.commit();prepared.primaryFrame.commit();
 return {payload,source,current,configured,prepared,wire:prepared.wirePayload,context:{payload,manifest:{scope,requestId:'historical-partial',sourceRevisions:{[source.id]:source.revision,[current.id]:current.revision}},sourceWireSnapshot:prepared.sourceWire,primaryFrameSnapshot:prepared.primaryFrame}};
}

test('every material lane has the same exact offered ID/empty menu on the ordinary and repair carrier',async()=>{
 const x=historical(),calls=[];
 await assistModel({...settings,sourceHandleOwner:undefined},{payload:x.payload,manifest:{scope,requestId:'all-material-lanes'}},undefined,async(_url,args)=>{const request=JSON.parse(args.body);calls.push(request);return packet(calls.length===1?{operation:'advise',text:''}:{operation:'advise',text:'Private help.'});});
 for(const request of calls){const p=request.tools[0].function.parameters.properties;assert.deepEqual(p.expressionOptions.items.properties.quotes.items,p.materials.items);assert.deepEqual(p.expressionOptions.items.properties.quotes.maxItems,p.materials.maxItems);}
 const current={id:'private:empty',type:'private',role:'user',revision:'r1',text:'只按QQ原话回应。'},p=prepareAssistantRequest(settings,{purpose:'discussion',intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:current.text},sources:[current]}).request.tools[0].function.parameters.properties;
 assert.equal(p.materials.maxItems,0);assert.equal(p.expressionOptions.items.properties.quotes.maxItems,0);
});

test('partial historical parent requires an actual fact witness in top-level and option lanes; summary-only fact rejects',()=>{
 for(const lane of ['materials','option']){
  const x=historical(),old=x.wire.sources.find(s=>s.segments),parent=old.materialChoices.find(m=>m.selectedExactFragment)||old.materialChoices.at(-1)||old.segments[0],selection={materialRef:parent.materialRef,authorityRef:x.wire.currentPermission.authorityRef};
  const value=lane==='materials'?{operation:'prepare_message',answer:{suggestions:[{text:'回应已知事实。'}]},materials:[selection]}:{operation:'advise',text:'一个方向。',expressionOptions:[{label:'相关方向',quotes:[selection]}]};
  assert.throws(()=>parseAssistant(value,'discussion',x.context),/factQuote|fact witness|partially delivered/);
  const y=historical(),other=y.wire.sources.find(s=>s.segments),ref=other.materialChoices.at(-1)?.materialRef||other.segments[0].materialRef;
  assert.throws(()=>parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:fact}]},materials:[{materialRef:ref,authorityRef:y.wire.currentPermission.authorityRef,factQuote:fact}]},'discussion',y.context),/exact|span|inside|fact/);
 }
});

test('a delivered historical fact witness and a legal narrow refinement remain usable',()=>{
 for(const refined of [false,true]){
  const x=historical(),old=x.wire.sources.find(s=>s.segments),segment=old.segments[0],selection={materialRef:segment.materialRef,authorityRef:x.wire.currentPermission.authorityRef};
  if(refined)selection.materialRef+='@'+segment.parts[0][0]+':'+(segment.endBoundary||old.segments[1]?.parts?.[0]?.[0]);else selection.factQuote=segment.parts.map(part=>part[1]).join('');
  const result=parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:'只使用所选的已读原文片段。'}]},materials:[selection]},'discussion',x.context);assert.equal(result.kind,'draft');assert.ok(result.materials[0].text);
 }
});

test('actual tail r2 material m67 cannot turn a0..700 raw heading or prior assistant summary into the unread recording fact',()=>{
 const tail=require('./fixtures/source-control-actual-tail-r2.json'),owner=new SourceHandleOwner({scope,taskId:'replay-request-2'});let prepared,last;
 for(const raw of tail.contexts){
  last=structuredClone(raw);Object.defineProperty(last,'fullAvailableSources',{value:structuredClone(tail.originals)});
  prepared=prepareAssistantRequest({...settings,sourceHandleOwner:owner},last.payload,[],{capturedSources:last.fullAvailableSources,sourceRevisions:last.manifest.sourceRevisions});
  prepared.primaryFrame.commit();prepared.sourceWire.commit();
 }
 last.primaryFrameSnapshot=prepared.primaryFrame;last.sourceWireSnapshot=prepared.sourceWire;
 const selection=tail.response.materials[0];assert.equal(selection.materialRef,'m67');assert.ok(prepared.primaryFrame.receipt.materials.some(item=>item.materialRef==='m67'));
 assert.throws(()=>parseAssistant(tail.response,'discussion',last),/factQuote|partially delivered/);
 const copied=structuredClone(tail.response);copied.materials[0].factQuote=fact;
 assert.throws(()=>parseAssistant(copied,'discussion',last),/exact|span|inside/);
 const source=last.payload.sources.find(item=>item.type==='private'&&item.id!==last.payload.userRequest.sourceId),original=tail.originals.find(item=>item.id===source.id);
 assert.equal(source.delivery.start,0);assert.equal(source.delivery.end,700);assert.equal(original.text.indexOf(fact),10855);assert.ok(!source.text.includes(fact));
});
