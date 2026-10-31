'use strict';
// Fictional contract probes derived from the existing reference/operation
// fixtures. Scripted checker results never establish semantic model quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {PrimaryReferenceOwner}=require('../src/primary-reference-registry.cjs');
const {compilePrimaryFrame}=require('../src/primary-frame.cjs');
const {prepareAssistantRequest,parseAssistant}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {boundedSource}=require('../src/context/source-delivery.cjs');
const {buildFidelityContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
const {scope}=require('./fixtures/native.cjs');
const NOW='2026-10-01T10:00:00.000Z';
const source=(id,text,extra={})=>({id,text,type:'private',role:'user',kind:'discussion',use:'discussion',revision:'revision-'+id,at:NOW,...extra});
function payloadFixture(){
 const qq=source('qq:91000000000000701','今天窗边的花盆冒了两片新叶。',{type:'qq',role:'contact'}),otherQq=source('qq:91000000000000702','我准备把花盆挪到窗边。',{type:'qq',role:'contact'}),privateSource=source('private:older','个人网页按标题查回摘记；家人的安排只在这里讨论。'),current=source('private:current','这次先回应她分享的花盆近况，不发出一起做事的邀请。'),note=source('note:known','我装好过一个两层小书架。',{type:'note',role:undefined,use:'draft'});
 const payload={purpose:'discussion',generationOrigin:'private_discussion',draftMaterialPolicy:{version:1},requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:current.text},sources:[qq,otherQq,privateSource,note,current],allowedMaterialIds:[note.id],taskContext:{auxiliaryPolicy:'best_effort',draftControlPolicy:{version:1,required:true,intentSourceId:current.id}}};
 return {payload,qq,otherQq,privateSource,note,current};
}
function snapshot(payload,owner=new PrimaryReferenceOwner({scope,taskId:'decision-ownership-boundaries'})){const snap=owner.preview(payload);snap.commit();return snap;}
function material(snap,id){return snap.receipt.materials.find(item=>item.sourceId===id).materialRef;}
function program(snap,id){return snap.receipt.authorities.find(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.targetSourceId===id).authorityRef;}
const rawQuote=quote=>({draftPlan:{quotes:[quote]}});
const typed=(error,code)=>error.code===code||error.issues?.some(issue=>issue.code===code);
function active(extra={}){
 const fixture=payloadFixture(),payload={...fixture.payload,...extra},settings={model:'synthetic-decision-ownership',baseUrl:'http://fixture.invalid/v1',anonymous:true,modelResponseMode:'result_tool',sourceHandleOwner:new SourceHandleOwner({scope,taskId:'decision-ownership-boundaries'})},prepared=prepareAssistantRequest(settings,payload,[]);
 prepared.sourceWire.commit();prepared.primaryFrame.commit();
 return {...fixture,payload,wire:prepared.wirePayload,prepared,context:{payload,manifest:{scope,requestId:'decision-ownership-boundaries',sourceRevisions:Object.fromEntries(payload.sources.map(item=>[item.id,item.revision]))},sourceWireSnapshot:prepared.sourceWire,primaryFrameSnapshot:prepared.primaryFrame}};
}
function whole(view){const first=view.segments[0].materialRef,last=view.segments.at(-1).materialRef;return first===last?first:view.materialChoices.find(item=>item.from===first&&item.to===last).materialRef;}
function preparedMessage(){
 return {operation:'prepare_message',answer:{privateExplanation:'顺着她已经分享的近况接一句。',suggestions:[{text:'这两片新叶看着挺精神。'}]}};
}

test('omitted public QQ authority is derived from the currently offered exact program target',()=>{
 const {payload,qq}=payloadFixture(),snap=snapshot(payload),quote={materialRef:material(snap,qq.id)},compiled=compilePrimaryFrame(rawQuote(quote),snap,payload);
 assert.deepEqual(compiled.draftPlan.quotes,[{sourceId:qq.id,text:qq.text}]);
 assert.deepEqual(quote,{materialRef:material(snap,qq.id)},'program resolution must not edit model input');
});

test('explicit wrong or unknown authority stays invalid even when public material has a derivable default',()=>{
 const {payload,qq,otherQq}=payloadFixture(),snap=snapshot(payload),ref=material(snap,qq.id);
 for(const authorityRef of [program(snap,otherQq.id),'a999999'])assert.throws(()=>compilePrimaryFrame(rawQuote({materialRef:ref,authorityRef}),snap,payload),error=>typed(error,authorityRef==='a999999'?'unknown_authority_reference':'authority_target_mismatch'));
 assert.throws(()=>compilePrimaryFrame(rawQuote({materialRef:'m999999'}),snap,payload),error=>typed(error,'unknown_material_reference'));
});

test('private user statement candidates and allowed notes never inherit an omitted public QQ authority',()=>{
 const app=payloadFixture(),snap=snapshot(app.payload);
 for(const original of [app.privateSource,app.current,app.note]){
  assert.ok(snap.receipt.materials.some(item=>item.sourceId===original.id));
  assert.throws(()=>compilePrimaryFrame(rawQuote({materialRef:material(snap,original.id)}),snap,app.payload),error=>typed(error,'primary_authority_reference_missing'),original.id);
 }
 assert.ok(snap.receipt.authorities.some(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&item.sourceId===app.current.id),'current identity remains a statement candidate');
});

test('omitted authority does not revive stale material, a foreign source, or a canonical result from another offer',()=>{
 const {payload,qq}=payloadFixture(),owner=new PrimaryReferenceOwner({scope,taskId:'decision-ownership-boundaries'}),first=snapshot(payload,owner),oldRef=material(first,qq.id),canonical=first.markCanonical({draftPlan:{quotes:[{sourceId:qq.id,text:qq.text}]}}),changed={...payload,sources:payload.sources.map(item=>item.id===qq.id?{...item,text:'现在花盆已经挪走了。',revision:'changed-revision'}:item)},second=snapshot(changed,owner);
 assert.throws(()=>compilePrimaryFrame(rawQuote({materialRef:oldRef}),second,changed),error=>typed(error,'unknown_material_reference'));
 assert.throws(()=>compilePrimaryFrame(canonical,second,changed),error=>typed(error,'primary_reference_binding_invalid'));
 for(const key of ['accountUid','accountUin','peerUid','peerUin'])assert.throws(()=>snapshot({...payload,sources:payload.sources.map(item=>item.id===qq.id?{...item,scope:{...scope,[key]:'foreign'}}:item)}),error=>typed(error,'primary_reference_scope_invalid'));
});

test('a public QQ refinement defaults authority only inside ordered offered boundaries and delivered material',()=>{
 const app=payloadFixture(),snap=snapshot(app.payload),view=snap.payload.sources.find(item=>item.id===app.qq.id),parent=view.segments[0],parts=parent.parts.filter(part=>part[0]);assert.ok(parts.length>=4);
 const from=parts[1][0],to=parts[3][0],ref=`${parent.materialRef}@${from}:${to}`,compiled=compilePrimaryFrame(rawQuote({materialRef:ref}),snap,app.payload);
 assert.equal(compiled.draftPlan.quotes[0].text,parts.slice(1,3).map(part=>part[1]).join(''));
 const foreignBoundary=snap.payload.sources.find(item=>item.id===app.otherQq.id).segments[0].parts[0][0];
 for(const bad of [`${parent.materialRef}@${to}:${from}`,`${parent.materialRef}@${from}:${foreignBoundary}`,`${parent.materialRef}@${from}:b999999`])assert.throws(()=>compilePrimaryFrame(rawQuote({materialRef:bad}),snap,app.payload),error=>typed(error,'material_reference_boundary_invalid'));
 const partial=boundedSource(app.qq,{start:2,maxChars:6,maxBytes:4000}),partialPayload={...app.payload,sources:app.payload.sources.map(item=>item.id===app.qq.id?partial:item)},partialSnap=snapshot(partialPayload);
 assert.equal(compilePrimaryFrame(rawQuote({materialRef:material(partialSnap,app.qq.id)}),partialSnap,partialPayload).draftPlan.quotes[0].text,partial.text);
 assert.equal(partialSnap.receipt.materials.filter(item=>item.sourceId===app.qq.id).every(item=>item.start>=partial.delivery.start&&item.end<=partial.delivery.end),true);
});

test('a prepared core survives malformed or inapplicable optional topic bookkeeping with diagnostics and no false no-change review',()=>{
 for(const topicPatch of [{operation:'update',authority:'MODEL_CANNOT_ASSIGN_AUTHORITY'},{operation:'update',topicId:'not-offered-topic',direction:'An inapplicable proposed direction'},{operation:'create',objective:'An unsupported optional interpretation',purposeSourceIds:['s999999'],intentQuote:'An absent quote'}]){
  const app=active(),raw=preparedMessage(app),diagnostics={};raw.topicPatch=topicPatch;raw.stateReview='no_change';
  const result=parseAssistant(raw,'discussion',app.context,diagnostics);
  assert.equal(result.kind,'draft');assert.equal(result.draftPlan,undefined);assert.equal(result.topicPatch,undefined);assert.equal(result.stateReview,undefined);
  assert.ok(diagnostics.auxiliaryErrors.some(error=>error.field==='topicPatch'));
 }
});

test('dropping optional topic proposals preserves whole-answer ownership and private material permission',()=>{
 const app=active(),raw=preparedMessage(app);raw.topicPatch={operation:'update',authority:'MODEL_CANNOT_ASSIGN_AUTHORITY'};
 const answer=parseAssistant(raw,'discussion',app.context,{});assert.equal(answer.kind,'draft');assert.equal(answer.draftPlan,undefined);
 const privateApp=active(),privateRaw=preparedMessage(privateApp),privateView=privateApp.wire.sources.find(item=>item.id!==privateApp.wire.intentAuthority.sourceId&&item.type==='private');privateRaw.materials=[{materialRef:whole(privateView)}];privateRaw.topicPatch={operation:'update',authority:'MODEL_CANNOT_ASSIGN_AUTHORITY'};
 assert.throws(()=>parseAssistant(privateRaw,'discussion',privateApp.context,{}),error=>typed(error,'primary_authority_reference_missing'));
});

function checkerFixture(text='这两片新叶看着挺精神。'){
 const {payload,qq,current}=payloadFixture(),manifest={scope,requestId:'decision-ownership-checker',sourceIds:payload.sources.map(item=>item.id),sourceRevisions:Object.fromEntries(payload.sources.map(item=>[item.id,item.revision]))},prepared={payload,manifest,fullAvailableSources:payload.sources,essentialSourceIds:[qq.id,current.id]},result={kind:'draft',text:'',discussionExplanation:{kind:'discussion',text:'先回应她分享的花盆近况。'},suggestions:[{style:'自然',text}]},context=buildFidelityContext(prepared,result,{scope,requestId:manifest.requestId,admittedContext:{payload:{outboundQuotes:[{sourceId:qq.id,text:qq.text}],currentHumanControl:{authority:'CONTROL_ONLY',sourceId:current.id,text:current.text}},manifest},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
 return {context,result,current,qq};
}

test('a plausible pragmatic reading is a private nonblocking concern without creating a user-visible warning',()=>{
 const app=checkerFixture(),quote=app.result.suggestions[0].text,verdict=parseFidelityResult({checkRef:'c1',verdict:'reject',issues:[],concerns:[{path:'suggestions[0].text',code:'pragmatic_ambiguity',quote,reason:'A possible social reading is uncertain rather than an attributable action defect.'}]},app.context);
 assert.equal(verdict.verdict,'allow');assert.ok(approvalFor(verdict,app.context));assert.equal(verdict.concerns.length,1);assert.equal(app.context.payload.candidate.suggestions[0].text,quote);assert.equal(app.result.warning,undefined);
});

test('social concerns retain exact witnesses while unsupported factual claims remain blocking',()=>{
 const app=checkerFixture('这周末要不要一起去给花盆换土？'),quote=app.result.suggestions[0].text,issue={path:'suggestions[0].text',code:'current_boundary',quote,evidence:[{sourceId:app.current.id,quote:app.current.text}],reason:'Scripted grounded current-action rejection exercises the contract only.'};
 const advisory=parseFidelityResult({checkRef:'c1',verdict:'reject',issues:[issue]},app.context);assert.equal(advisory.verdict,'allow');assert.deepEqual(advisory.concerns,[issue]);assert.ok(approvalFor(advisory,app.context));
 for(const patch of [{quote:'An absent candidate body.'},{evidence:[{sourceId:app.current.id,quote:'An absent original sentence.'}]},{evidence:[{sourceId:'private:unoffered',quote:app.current.text}]}])assert.throws(()=>parseFidelityResult({checkRef:'c1',verdict:'reject',issues:[{...issue,...patch}]},app.context),error=>typed(error,'fidelity_result_invalid'));
 const factual=checkerFixture('我昨天也给自己养的花盆换了土。'),unsupported={path:'suggestions[0].text',code:'unsupported_fact',quote:factual.result.suggestions[0].text,basis:'no_support_in_supplied_evidence',reason:'Scripted unsupported-event defect.'};assert.equal(parseFidelityResult({checkRef:'c1',verdict:'reject',issues:[unsupported]},factual.context).verdict,'reject');
 for(const value of [{checkRef:'c1',verdict:'reject',issues:[]},{checkRef:'c1',verdict:'unknown',issues:[]}])assert.throws(()=>parseFidelityResult(value,app.context),error=>typed(error,'fidelity_result_invalid'));
 assert.equal(approvalFor(parseFidelityResult({checkRef:'c1',verdict:'uncertain',issues:[]},app.context),app.context),undefined,'a well-formed unresolved check still cannot approve publication');
});
