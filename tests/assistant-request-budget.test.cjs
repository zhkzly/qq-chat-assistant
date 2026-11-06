'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {normalize}=require('../src/messages.cjs');
const {buildContext,buildDraftContext}=require('../src/assistant-context.cjs');
const {buildAnswerAdmission}=require('../src/context/wording-view.cjs');
const {buildFidelityContext}=require('../src/whole-answer-fidelity.cjs');
const {assistModel,prepareAssistantRequest,canonicalSourceView}=require('./fixtures/assistant-protocol.cjs');
const {withCurrentStatementAuthority}=require('./fixtures/current-statement-authority.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const settings={baseUrl:'http://synthetic.invalid/v1',model:'synthetic-relationship-context',anonymous:true};
const ok=content=>({ok:true,json:async()=>({choices:[{message:{content}}]})});
function currentControls(payload){const control=text=>({text,sourceIds:[payload.intentAuthority?.sourceId||payload.userRequest.sourceId]});return {objective:control('表达想多认识她的真实意愿'),allowedApproach:control('保留获准原意自然表达'),avoidances:[]};}
function fixture(t,overrides={}){
 const store=new Store(':memory:');t.after(()=>store.close());
 // Same consumer shape as native QQ history: strings IDs, bursts, per-source
 // hashes, timestamps and complete Chinese text with JSON-sensitive characters.
 const records=Array.from({length:100},(_,index)=>normalize(raw(String(900719925474099800n+BigInt(index)),index<96?index%2===0:index<98,{msgTime:String(1791792000+index),elements:[{textElement:{content:`第${index}条：${'今天一起讨论了游戏和周末安排。她说："要看时间"，我保存的路径是 D:\\games。\n'.repeat(5)}`}}]}),scope));
 store.add(scope,records);store.setGoal(scope,'与她发展双方愿意的恋爱关系');
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我对她有好感，想多认识她，帮我自然表达。'});
 const args={scope,records,turn,companion:store.getCompanion(scope),requestId:'long-native-shaped-context',coverage:{status:'partial',pages:3},settings:{...settings,...overrides}};
 return {store,args};
}
function checkEssential(wirePayload,args,receipt){
 const payload=canonicalSourceView(wirePayload,receipt);
 assert.equal(payload.userRequest?.text||payload.outboundQuotes[0].text,args.turn.text);
 for(const record of args.records.slice(-4))assert.equal(payload.sources.find(source=>source.messageId===record.messageId)?.text,record.text,'keep the complete latest exchange');
 for(const source of payload.sources.filter(source=>source.type==='qq'))assert.equal(source.text,args.records.find(record=>record.messageId===source.messageId).text,'optional sources are whole entries');
}
for(const requestLimit of [64000,32000])test(`native-shaped long context fits the actual ${requestLimit}-byte request envelope`,async t=>{
 const {args}=fixture(t,{assistantRequestBytes:requestLimit}),context=buildContext(args),calls=[];
 await assistModel(args.settings,context,undefined,async(_,request)=>{calls.push(request.body);return ok(JSON.stringify({kind:'discussion',text:'先自然回应她实际提到的安排。'}));});
 assert.equal(calls.length,1);assert.ok(Buffer.byteLength(calls[0])<=requestLimit);assert.equal(context.manifest.serializedTextRequestBytes,Buffer.byteLength(calls[0]));
 checkEssential(JSON.parse(JSON.parse(calls[0]).messages[1].content),args,context.manifest.sourceHandles);assert.ok(context.manifest.omittedSourceCount>0);assert.ok(context.manifest.inputBytes<=48000);
});
for(const purpose of ['discussion','draft_prepare','draft'])test(`${purpose} recovery or structural repair respects its actual envelope and complete evidence`,async t=>{
 const {args}=fixture(t);
 // Match the real Controller's task owner before tightening its shared
 // settings; a standalone auto-owner keeps its separate captured snapshot.
 if(purpose==='draft_prepare')args.settings.sourceHandleOwner=new SourceHandleOwner({scope,taskId:args.requestId});
 const prepared=buildContext({...args,purpose:purpose==='draft_prepare'?'draft_prepare':'discussion'}),context=purpose==='draft'?buildDraftContext(prepared,{quotes:[{sourceId:prepared.payload.userRequest.sourceId,text:args.turn.text}],guidance:currentControls(prepared.payload)},args):prepared;
 // Lazy context no longer fills the 64KB window. Tighten the fixture around
 // its actual ordinary request so the repair wrapper still exercises eviction.
 if(purpose==='draft_prepare')args.settings.assistantRequestBytes=Math.min(64000,prepareAssistantRequest(args.settings,context.payload).requestBytes+200);
 const invalid='INVALID_RESPONSE_'+('"\\\\\n原本的输出仍需完整修复。'.repeat(purpose==='draft'?700:purpose==='draft_prepare'?140:350)),calls=[];
 const repaired=purpose==='draft_prepare'?JSON.stringify({draftPlan:{quotes:[{sourceId:prepared.payload.userRequest.sourceId,text:args.turn.text}],guidance:currentControls(prepared.payload)},answer:{suggestions:[{text:'我想多认识你一点。'}]}}):purpose==='draft'?JSON.stringify({kind:'draft',text:'我想多认识你一点。',privateExplanation:'保留这次明确表达想多认识她的意思。'}):JSON.stringify({kind:'discussion',text:'先自然回应她实际提到的安排。'});
 await assistModel(args.settings,context,undefined,async(_,request)=>{
  calls.push(request.body);
  if(calls.length===1)return ok(invalid);
  const captured=context.extraRequests?.at(-1)?.payload?.originalInput||context.payload,receipt=context.extraRequests?.at(-1)?.manifest?.primaryReferences||context.manifest.primaryReferences;
  return ok(purpose==='draft_prepare'?JSON.stringify(withCurrentStatementAuthority(JSON.parse(repaired),captured,receipt)):repaired);
 });
 assert.equal(calls.length,2);for(const body of calls)assert.ok(Buffer.byteLength(body)<=64000);
 const first=JSON.parse(JSON.parse(calls[0]).messages[1].content),repair=JSON.parse(JSON.parse(calls[1]).messages[1].content),effective=context.resultContext||context;
 checkEssential(repair.originalInput,args,context.extraRequests[0].manifest.sourceHandles);
 if(purpose!=='draft'){
  assert.equal(repair.invalidResponse,invalid);if(purpose==='draft_prepare')assert.ok(repair.originalInput.sources.length<first.sources.length,'mandatory structural repair evicts optional whole sources to fit its full envelope');
 }else{
  assert.equal(repair.invalidResponse,invalid,'structured repair retains the exact invalid output only as diagnostics');
  assert.ok(repair.originalInput.sources.length<=first.sources.length,'structured whole-response repair may evict only optional source rows');
  for(const field of ['tools','tool_choice','response_format'])assert.deepEqual(JSON.parse(calls[1])[field],JSON.parse(calls[0])[field],'whole-response repair retains the selected structured carrier');assert.equal(context.manifest.responseRecovery,undefined);
 }
 if(purpose==='draft'){for(const key of ['userRequest','goal','privateConversation'])assert.equal(repair.originalInput[key],undefined);}
 assert.equal(context.extraRequests[0].inputBytes,Buffer.byteLength(calls[1]));
 const canonicalRepair=canonicalSourceView(repair.originalInput,context.extraRequests[0].manifest.sourceHandles,effective.payload);
 const delivered=[...new Set([...canonicalRepair.sources.map(source=>source.id),...(canonicalRepair.outboundQuotes||[]).map(quote=>quote.sourceId)])].sort();
 assert.deepEqual([...new Set(context.extraRequests[0].manifest.sourceIds)].sort(),delivered);
 assert.deepEqual([...new Set(effective.manifest.sourceIds)].sort(),delivered);
 assert.deepEqual(context.extraRequests[0].manifest.methodTrace.delivered,repair.originalInput.methodCards.map(({id,version})=>({id,version})));
});
test('oversized QQ evidence has marked source ranges while the current request remains exact',t=>{
 const {store,args}=fixture(t,{assistantRequestBytes:18000});
 for(const record of args.records.slice(-4))record.text=record.text.repeat(12);
 const fullLengths=new Map(args.records.map(record=>[`qq:${record.messageId}`,record.text.length]));
 const context=buildContext(args),packet=prepareAssistantRequest(args.settings,context.payload);
 assert.ok(packet.requestBytes<=18000);
 assert.equal(context.payload.sources.find(source=>source.id===context.payload.userRequest.sourceId).text,args.turn.text);
 assert.ok(context.manifest.sourceDelivery.partialSourceCount>0);
 for(const source of context.payload.sources.filter(source=>source.delivery?.status==='partial')){
  assert.equal(source.delivery.originalCharLength,fullLengths.get(source.id));
  assert.equal(source.delivery.end-source.delivery.start,source.text.length);
  assert.ok(source.delivery.end<=source.delivery.originalCharLength);
 }
 // Source ranges never permit a silent slice of the authoritative user input:
 // an oversized request now degrades to an explicitly marked range carrying
 // its continuation handle; the delivered text stays an exact span of the
 // original and both views agree, with the degradation on the manifest.
 args.turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:args.turn.text.repeat(400)});
 args.companion=store.getCompanion(scope);
 const oversized=buildContext(args),requestSource=oversized.payload.sources.find(source=>source.id===oversized.payload.userRequest.sourceId);
 assert.equal(requestSource.delivery?.status,'partial');
 assert.equal(oversized.payload.userRequest.text,requestSource.text);
 assert.equal(requestSource.text,args.turn.text.slice(requestSource.delivery.start,requestSource.delivery.end));
 assert.ok(requestSource.delivery.end<requestSource.delivery.originalCharLength,'the undelivered remainder must stay explicit');
 assert.equal(requestSource.delivery.lookup?.sourceId,requestSource.id);
 assert.ok(oversized.manifest.degradation?.some(entry=>entry.step==='ranged_excerpt'&&entry.appliedTo===requestSource.id));
 assert.ok(oversized.manifest.userRequestDelivery?.status==='partial');
});
test('automatic controller entry uses the configured envelope and persists the exact repaired evidence',async t=>{
 const {Controller}=require('./fixtures/assistant-protocol.cjs'),{store,args}=fixture(t,{assistantRequestBytes:32000}),calls=[];
 const controller=new Controller({store,settings:{...args.settings,auto:false,instruction:args.turn.text,
   realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl}},
  read:async command=>command==='bind'?scope:{messages:[],source:'synthetic'},
  assistantModel:(configured,context,signal)=>assistModel(configured,context,signal,async(_,request)=>{
   calls.push(request.body);const wrapper=JSON.parse(JSON.parse(request.body).messages[1].content);if(wrapper.purpose==='fidelity_check')return ok(JSON.stringify({checkRef:wrapper.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}));return ok(calls.length===1?JSON.stringify({kind:'discussion',text:''}):JSON.stringify({kind:'discussion',text:'参考她实际说的安排自然回应。',replyDisposition:'unavailable'}));
  })});
 controller.visible=false;t.after(()=>controller.close());controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 await controller.suggest({automatic:true});assert.equal(controller.assistantError,'');assert.equal(calls.length,3);assert.ok(calls.every(body=>Buffer.byteLength(body)<=32000));
 const run=store.getCompanion(scope).runs.find(item=>item.id===controller.advice.requestId),repair=JSON.parse(JSON.parse(calls[1]).messages[1].content);
 assert.equal(run.status,'complete');
 const captured=run.requests[1].payload.originalInput,canonicalRepair=canonicalSourceView(repair.originalInput,run.requests[1].manifest.sourceHandles,captured);
 assert.deepEqual(captured,canonicalRepair,'the exact model repair input stays in its captured request');
 assert.equal(run.payload.purpose,'answer_admission');assert.equal(run.payload.userRequest,undefined);assert.deepEqual(run.payload.outboundQuotes,[]);
 const delivered=canonicalRepair.sources.map(source=>source.id).filter(id=>!id.startsWith('request:')).sort();
 assert.deepEqual([...run.manifest.sourceIds].sort(),delivered);assert.deepEqual([...run.requests[1].manifest.sourceIds].sort(),delivered);
 const usage=controller.usage.get(scope,run.id);assert.equal(usage.attempts,3);assert.equal(usage.requests.filter(r=>r.purpose==='fidelity_check').length,1);assert.equal(usage.origin,'automatic');assert.equal(usage.status,'complete');
});
test('a repaired whole answer retains selected image evidence for explicit legacy checker compatibility',async t=>{
 const {args}=fixture(t),imageMessageId=args.records[0].messageId;
 args.settings.sourceHandleOwner=new SourceHandleOwner({scope,taskId:args.requestId});
 const images=[{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',messageId:imageMessageId,index:0,bytes:24}];
 const prepared=buildContext({...args,purpose:'draft_prepare',imageMessageIds:[imageMessageId],images,mediaContext:{mode:'manual',omitted:[]}}),calls=[];
 args.settings.assistantRequestBytes=prepareAssistantRequest(args.settings,prepared.payload,images).requestBytes+200;
 prepared.images=images;prepared.manifest.images=images.map(({url,...metadata})=>metadata);
 const invalid='INVALID_'+('"\\\n原本的输出仍需完整修复。'.repeat(140));
 const result=await assistModel(args.settings,prepared,undefined,async(_,request)=>{
  calls.push(JSON.parse(request.body));if(calls.length===1)return ok(invalid);
  const captured=prepared.extraRequests?.at(-1)?.payload?.originalInput||prepared.payload,receipt=prepared.extraRequests?.at(-1)?.manifest?.primaryReferences||prepared.manifest.primaryReferences;
  return ok(JSON.stringify(withCurrentStatementAuthority({draftPlan:{quotes:[{sourceId:prepared.payload.userRequest.sourceId,text:args.turn.text}],guidance:currentControls(prepared.payload)},answer:{suggestions:[{text:'我想多认识你一点。'}]}},captured,receipt)));
 });
 const effective=prepared.resultContext;assert.ok(effective);assert.deepEqual(effective.images,images,'repair reconstruction must retain selected image input for the next authorized stage');
 assert.equal(effective.payload.sources.find(source=>source.id===`qq:${imageMessageId}`)?.text,args.records[0].text);
 assert.ok(effective.manifest.sourceRevisions[`qq:${imageMessageId}`]);
 assert.ok(Array.isArray(calls[1].messages[1].content),'delivery repair retains the selected actual image');
 assert.equal(prepared.extraRequests[0].manifest.imageCount,1);assert.deepEqual(prepared.extraRequests[0].manifest.images,images.map(({url,...metadata})=>metadata));
 assert.equal(result.kind,'draft');assert.equal(result.suggestions[0].text,'我想多认识你一点。');assert.equal(result.draftPlan,undefined);
 const admitted=buildAnswerAdmission(effective,result,args),check=buildFidelityContext(effective,result,{...args,admittedContext:admitted});
 await assistModel(args.settings,check,undefined,async(_,request)=>{const body=JSON.parse(request.body),payload=JSON.parse(body.messages[1].content[0].text);calls.push(body);return ok(JSON.stringify({checkRef:payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}));});
 assert.equal(calls[2].messages[1].content[1].image_url.url,images[0].url);
 assert.equal(check.payload.purpose,'fidelity_check');assert.ok(check.manifest.sourceRevisions[`qq:${imageMessageId}`]);
 assert.deepEqual(structuredClone(effective).payload,effective.payload,'internal callbacks must not break plain-data context copies');
});
