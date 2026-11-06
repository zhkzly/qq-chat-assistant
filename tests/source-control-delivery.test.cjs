'use strict';
// Actual production serialization/parser and controller paths, with explicit
// scripted provider transport. These are functional checks, not model grades.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const ROOT=process.env.SOURCE_CONTROL_PRODUCT_ROOT||path.resolve(__dirname,'..');
const load=name=>require(path.join(ROOT,'src',name));
const {prepareAssistantRequest,parseAssistant,assistModel}=load('assistant-model.cjs');
const {SourceHandleOwner}=load('source-handles.cjs');
const delivery=load('context/source-delivery.cjs');
const {digestSource,declarationSentences,timeWindowTokens}=load('context/evidence-digest.cjs');
const {consumptionContractFor,activeArrangementContract}=load('context/mqa-registry.cjs');
const {declarationsView}=load('context/admission-compiler.cjs');
const {analyzeRequest}=load('context/request-analyzer.cjs');
const {Store}=load('store.cjs'),{Controller}=load('controller.cjs');
const {scope}=require('./fixtures/native.cjs');
const raw=require('./fixtures/source-control-current.json');
const settings={model:'synthetic-source-control',modelResponseMode:'result_tool',baseUrl:'http://fixture.invalid/v1',anonymous:true,discussionCompactionEnabled:false};
const packet=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{tool_calls:[{id:'source-control-result',type:'function',function:{name:'assistant_result',arguments:JSON.stringify(value)}}]}}]}),{status:200});
function app({partial=true,old,contract}={}){
 const original={id:'private:current-source',type:'private',role:'user',kind:'discussion',revision:'source-r1',at:'2026-10-01T10:00:00.000Z',text:raw.text};
 const current=partial?delivery.boundedSource(original,{maxBytes:2000}):{...original,text:'只说已知的内容。'};
 const payload={purpose:'discussion',asOf:'2026-10-01T10:01:00.000Z',generationOrigin:'private_discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:current.id},
  userRequest:{sourceId:current.id,text:current.text,...(current.delivery?{delivery:current.delivery,requestDeliveryRule:'The undelivered remainder is unknown.'}:{})},
  sources:[...(old?[old]:[]),current,{id:'qq:1',type:'qq',direction:'incoming',role:'contact',revision:'qq-r1',at:'2026-10-01T10:00:30.000Z',text:'这个小杯子看起来有点歪。'}],...(contract?{consumptionContract:contract}:{})};
 const configured={...settings,sourceHandleOwner:new SourceHandleOwner({scope,taskId:'source-control-unit'})};
 return {original,current,payload,settings:configured};
}
function committed(original){
 const prepared=prepareAssistantRequest(original.settings,original.payload,[]);prepared.sourceWire.commit();prepared.primaryFrame.commit();
 return {...original,prepared,wire:prepared.wirePayload,context:{payload:original.payload,manifest:{scope,requestId:'source-control-unit',sourceRevisions:Object.fromEntries(original.payload.sources.map(s=>[s.id,s.revision]))},sourceWireSnapshot:prepared.sourceWire,primaryFrameSnapshot:prepared.primaryFrame}};
}
const materialField=prepared=>prepared.request.tools[0].function.parameters.properties.materials;

test('partial current input survives the FINAL wire with exact range and an executable continuation',()=>{
 const x=committed(app()),u=x.wire.userRequest;
 assert.equal(u.text,x.current.text);assert.equal(u.delivery.status,'partial');assert.equal(u.delivery.originalCharLength,raw.text.length);
 assert.equal(u.delivery.start,0);assert.equal(u.delivery.end,u.text.length);assert.ok(u.requestDeliveryRule);
 assert.deepEqual(u.delivery.lookup,{sourceIds:[u.sourceId],offset:u.text.length,maxChars:8000});
 assert.ok(!x.wire.sources.some(s=>s.id===u.sourceId),'current body has one final-wire lane');
 const parsed=parseAssistant({operation:'lookup',lookup:u.delivery.lookup,continuation:'advise'},'discussion',x.context);
 assert.deepEqual(parsed.lookup.sourceIds,[x.current.id]);assert.equal(parsed.lookup.offset,u.text.length);
});

test('complete current input stays complete without introducing a fake continuation',()=>{
 const x=committed(app({partial:false}));assert.equal(x.wire.userRequest.text,x.current.text);assert.equal(x.wire.userRequest.delivery,undefined);
});

test('current-input range remains an eligible deterministic lookup-completion target after wire projection',()=>{
 const x=committed(app());const targets=load('wire/domains.cjs').rangedLookupTargets(x.wire);
 assert.deepEqual(targets.get(x.wire.userRequest.sourceId),{start:0,end:raw.text.length});
});

test('rejected response repair retains current delivery metadata and teaches the exact empty material menu',async()=>{
 const x=app(),context={payload:x.payload,manifest:{scope,requestId:'source-control-repair',sourceRevisions:Object.fromEntries(x.payload.sources.map(s=>[s.id,s.revision]))}},calls=[];
 const invalid={operation:'prepare_message',answer:{suggestions:[{text:'这个小杯子挺特别的。'}],materials:[]}};
 const result=await assistModel(x.settings,context,undefined,async(_url,args)=>{const request=JSON.parse(args.body),wire=JSON.parse(request.messages[1].content);calls.push({request,wire});return packet(calls.length===1?invalid:{operation:'prepare_message',answer:{suggestions:[{text:'这个小杯子挺特别的。'}]},materials:[]});});
 assert.equal(calls.length,2);assert.equal(result.kind,'draft');const repaired=calls[1].wire.originalInput;
 assert.equal(repaired.userRequest.delivery.originalCharLength,raw.text.length);assert.deepEqual(repaired.userRequest.delivery.lookup.sourceIds,[repaired.userRequest.sourceId]);
 assert.equal(calls[1].request.tools[0].function.parameters.properties.materials.maxItems,0);assert.ok(calls[1].wire.task.includes('顶层materials'));
 assert.equal(calls[1].wire.invalidResponse,JSON.stringify(invalid));assert.ok(calls[1].wire.validationIssues.length);
});

test('no offered private materials means a mechanically empty menu, while public QQ still supports a reply',()=>{
 const x=committed(app({partial:false}));assert.equal(materialField(x.prepared).maxItems,0);
 assert.equal(parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:'这个小杯子有点歪，反而挺有手作感。'}]},materials:[]},'discussion',x.context).kind,'draft');
 const y=committed(app({partial:false}));assert.throws(()=>parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:'这个小杯子有点歪。'}]},materials:[{materialRef:'m1'}]},'discussion',y.context),/offered|materialRef/);
});

test('private question material cannot be relabeled as a public QQ fact',()=>{
 const old={id:'private:old-question',type:'private',role:'user',kind:'discussion',revision:'old-r1',at:'2026-09-30T10:00:00.000Z',text:'先帮我弄清楚刚才说的是谁的经历。'};
 const x=committed(app({partial:false,old})),source=x.wire.sources.find(s=>s.segments),m=source.segments[0].materialRef;
 assert.throws(()=>parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:'这个小杯子有点歪。'}]},materials:[{materialRef:m,authorityRef:x.wire.currentPermission.authorityRef,factQuote:'这个小杯子看起来有点歪。'}]},'discussion',x.context),/exact|span|material/);
});

test('exact offered parent IDs and displayed boundary refinements remain legal in the schema and parser',()=>{
 const old={id:'private:old-fact',type:'private',role:'user',kind:'discussion',revision:'old-r1',at:'2026-09-30T10:00:00.000Z',text:'我给这个小网页做了查找功能。'};
 const x=committed(app({partial:false,old})),source=x.wire.sources.find(s=>s.segments),segment=source.segments[0],start=segment.parts[0][0],end=segment.endBoundary;
 const ref=segment.materialRef+'@'+start+':'+end,choices=materialField(x.prepared).items.properties.materialRef.anyOf;
 assert.ok(choices.some(rule=>rule.pattern&&new RegExp(rule.pattern).test(ref)));
 const result=parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:old.text}]},materials:[{materialRef:ref,authorityRef:x.wire.currentPermission.authorityRef}]},'discussion',x.context);
 assert.equal(result.materials[0].sourceId,old.id);assert.equal(result.materials[0].text,old.text);
});

test('quantity wording does not become a clock declaration',()=>{
 for(const text of ['我愿意做一点具体事情。','我愿意提供一点帮助。','我想试一点不同的内容。']){assert.deepEqual(declarationSentences(text),[]);assert.deepEqual(timeWindowTokens(text),[]);}
 assert.ok(declarationSentences('周六三点半以后我有空，也愿意一起去。').length);assert.deepEqual(timeWindowTokens('周六三点半以后我有空。'),['周六','三点半']);
});

test('digest and declaration tiers retain original navigation without prescribing an invitation or adoption',()=>{
 const source={id:'private:notes',type:'private',role:'user',revision:'r1',text:'第一项是旧物说明。周六三点半以后我有空，也愿意一起去。'};
 for(const view of [digestSource(source),declarationsView(source)]){assert.ok(view.digest.declarations.some(x=>x.sentence==='周六三点半以后我有空，也愿意一起去。'));assert.ok(view.digest.declarationRule.includes('不是当前行动'));assert.ok(!/直接采用|给可发送的接受|按used/.test(view.digest.declarationRule));}
});

test('locally negated invitation wording does not create a positive arrangement task signal',()=>{
 for(const text of ['这不是邀请，先帮我理解这件事。','我目前不想发邀约，先私下分析。','这是背景，不等于现在让我发邀请；先讨论范围。'])assert.notEqual(analyzeRequest({text}).intentClass,'invitation_arrangement');
 assert.equal(analyzeRequest({text:'她约我周六下午一起去看旧物展，怎么回？'}).intentClass,'invitation_arrangement');
});

const declaration={materialClass:'declared_arrangement',sourceId:'note:1',sentence:'周六三点半以后我有空，也愿意一起去。',start:0,end:24,current:true};
test('declarations alone cannot activate arrangement schema or parser obligations',async()=>{
 const x=app({partial:false});x.payload.mandatoryMaterials=[declaration];const context={payload:x.payload,manifest:{}};let calls=0;
 const result=await assistModel(x.settings,context,undefined,async(_url,args)=>{calls++;const request=JSON.parse(args.body);assert.equal(request.tools[0].function.parameters.properties.arrangementHandling,undefined);return packet({operation:'prepare_message',answer:{suggestions:[{text:'这个小杯子看起来有点歪。'}]},arrangementHandling:{disposition:'used',evidenceRefs:['s999999']}});});
 assert.equal(calls,1);assert.equal(result.arrangementHandling,undefined);
});

test('one explicit active contract gates schema and parser; a declared time-window guard remains live',async()=>{
 assert.ok(activeArrangementContract({consumptionContract:consumptionContractFor('invitation_arrangement')}));
 assert.equal(activeArrangementContract({consumptionContract:consumptionContractFor('invitation_arrangement'),contextRequest:{intentClass:'generic_consultation'}}),null);
 const x=app({partial:false,contract:consumptionContractFor('invitation_arrangement')});x.payload.mandatoryMaterials=[declaration];let calls=0;
 const result=await assistModel(x.settings,{payload:x.payload,manifest:{}},undefined,async(_url,args)=>{calls++;const request=JSON.parse(args.body),wire=JSON.parse(request.messages[1].content),p=wire.originalInput||wire;assert.ok(request.tools[0].function.parameters.properties.arrangementHandling);
  return packet({operation:'prepare_message',answer:{suggestions:[{text:calls===1?'周六可以一起去。':'周六三点半以后可以一起去。'}]},arrangementHandling:{disposition:'used',evidenceRefs:[p.mandatoryMaterials[0].sourceId]}});});
 assert.equal(calls,2);assert.ok(result.suggestions[0].text.includes('三点半'));
});

test('consecutive exact read receipts keep earlier ranges by revision without concatenating a fake source body',()=>{
 const original={id:'private:test',revision:'r1',text:'头部原文。中间原文。尾部原文。'};
 const make=(start,end)=>({...delivery.boundedSource(original,{start,maxChars:end-start,maxBytes:1000}),requestedRange:{offset:start,maxChars:end-start}});
 const first=delivery.mergeSourceReads([],[make(6,10)]),both=delivery.mergeSourceReads(first,[make(10,original.text.length)]);
 assert.equal(both[0].text,original.text.slice(10));assert.equal(both[0].readRanges.length,2);
 const changed=delivery.mergeSourceReads(both,[{...original,revision:'r2',text:'新的来源修订。'}]);assert.equal(changed[0].readRanges,undefined);
});

test('current range rendering removes overlap and never claims an unread gap or wrong-revision body',()=>{
 const original={id:'private:test',revision:'r1',text:'0123456789ABCDEFGHIJ'+'Z'.repeat(1600)},head=delivery.boundedSource(original,{maxChars:5,maxBytes:1000});
 const read={id:original.id,revision:'r1',readRanges:[{start:3,end:9,revision:'r1'},{start:15,end:20,revision:'r1'},{start:0,end:20,revision:'wrong'}]};
 const view=delivery.currentRequestView(head,original,[read]);assert.deepEqual(view.readRanges.slice(0,2).map(({start,end,text})=>({start,end,text})),[{start:5,end:9,text:'5678'},{start:15,end:20,text:'FGHIJ'}]);assert.ok(view.readRanges.every(part=>part.revision===original.revision));assert.ok(view.delivery.unreadRanges.some(range=>range.start===9&&range.end===15));
 const receipt=delivery.sourceDeliveryManifest([original],[head],[{id:original.id,offset:15,maxChars:5}],view);assert.equal(receipt.explicitLookups[0].requestStatus,'delivered');
 const missing=delivery.sourceDeliveryManifest([original],[head],[{id:original.id,offset:9,maxChars:6}],view);assert.equal(missing.explicitLookups[0].requestStatus,'omitted');
});

test('read-range degradation stays inside the same byte budget and preserves exact UTF-16 text',()=>{
 const original={id:'private:unicode',revision:'r1',text:'头部。'+'原始文字🙂'.repeat(600)},head=delivery.boundedSource(original,{maxChars:3,maxBytes:1000});
 const range={start:100,end:original.text.length,revision:'r1'},reads=[{id:original.id,revision:'r1',readRanges:[range]}];
 const limited=delivery.currentRequestView(head,original,reads,{maxReadBytes:600});
 assert.ok(Buffer.byteLength(JSON.stringify(limited.readRanges||[]))<=602);
 for(const part of limited.readRanges||[]){assert.equal(part.text,original.text.slice(part.start,part.end));assert.ok(!/[\uD800-\uDBFF]$/.test(part.text));}
 assert.ok(limited.delivery.unreadRanges.length);assert.ok(limited.delivery.continuationAvailable);
});

test('read metadata supplied on a changed incoming revision cannot restore old range authority',()=>{
 const old={id:'private:same',revision:'r1',text:'旧版本正文。',readRanges:[{start:0,end:6,revision:'r1'}]};
 const next={id:old.id,revision:'r2',text:'新的版本。',readRanges:old.readRanges};
 assert.equal(delivery.mergeSourceReads([old],[next])[0].readRanges,undefined);
});

test('stale or mismatched-contract declarations are inert consistently in schema and before source-handle decoding',async()=>{
 for(const state of ['stale','mismatch']){
  const x=app({partial:false,contract:consumptionContractFor('invitation_arrangement')});x.payload.mandatoryMaterials=[{...declaration,current:state!=='stale'}];
  if(state==='mismatch')x.payload.contextRequest={intentClass:'generic_consultation'};
  const result=await assistModel(x.settings,{payload:x.payload,manifest:{}},undefined,async(_url,args)=>{const request=JSON.parse(args.body);assert.equal(request.tools[0].function.parameters.properties.arrangementHandling,undefined);return packet({operation:'prepare_message',answer:{suggestions:[{text:'这个小杯子有点歪。'}]},arrangementHandling:{disposition:'used',evidenceRefs:['s999999']}});});
  assert.equal(result.arrangementHandling,undefined);
 }
});

test('real Controller continuation requests retain both actual current-source reads in the FINAL third HTTP input',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());let calls=0;const seen=[];
 const controller=new Controller({store,settings:{...settings,auto:false,assistantRequestLimit:4,realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl}},read:async(method)=>method==='bind'?scope:{messages:[],source:'fictional'},
  assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_url,args)=>{const request=JSON.parse(args.body),wire=JSON.parse(request.messages[1].content);seen.push(wire);calls++;
   if(wire.purpose==='fidelity_check')return packet({checkRef:wire.checkRef,auditProtocol:'sparse-defects-v1',issues:[]});
   if(calls<=2)return packet({operation:'lookup',lookup:{sourceIds:[wire.userRequest.sourceId],offset:calls===1?raw.text.length-180:Math.floor(raw.text.length/2),maxChars:100},continuation:'advise'});
   return packet({operation:'advise',text:'按已经交付的原文范围整理，未读间隙仍保持未知。'});
  })});
 controller.visible=false;t.after(()=>controller.close());controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);await controller.assist({text:raw.text,taskId:'source-control-multiread'});
 // Union contract: the B007 terminal fact audit adds one scripted HTTP call
 // after the advise; the delivery invariant under test is unchanged — the
 // final advise-carrying wire (seen[2]) must retain both actual reads.
 assert.equal(controller.assistantError,'');assert.equal(calls,4);const u=seen[2].userRequest;
 for(const start of [raw.text.length-180,Math.floor(raw.text.length/2)])assert.ok(u.readRanges.some(range=>range.start<=start&&range.end>=start+100&&range.text.slice(start-range.start,start-range.start+100)===raw.text.slice(start,start+100)));
 assert.ok(u.delivery.unreadRanges.length);assert.ok(u.delivery.status==='partial');assert.ok(!seen[2].sources.some(source=>source.id===u.sourceId));
});
