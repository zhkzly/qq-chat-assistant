'use strict';
// Validation feedback checks only. Actual primary outputs remain unchanged;
// derived malformed inputs are explicit adversarial unit cases, not replays.
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {parseAssistant}=require('../src/assistant-model.cjs');
const {cases}=require('./fixtures/actual020-validation-responses.cjs');
const clone=value=>structuredClone(value),sha=value=>createHash('sha256').update(value).digest('hex');
function recordedResponse(fixture){
 const bindings=new Map(fixture.receipt.bindings.map(item=>[item.handle,item.sourceId]));
 const reference=value=>{assert.ok(bindings.has(value),`recorded offer contains ${value}`);return bindings.get(value);};
 const visit=value=>{
  if(Array.isArray(value))return value.map(visit);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
   key==='sourceId'?reference(item):key==='sourceIds'?item.map(reference):visit(item)]));
 };
 return visit(JSON.parse(fixture.raw));
}
function fixture(index=0){const record=cases[index];return {record,payload:clone(record.canonicalPayload),response:recordedResponse(record)};}
function rejected(fn){try{fn();}catch(error){return error;}assert.fail('the unchanged invalid output must not be admitted');}
function issues(error){
 assert.ok(Array.isArray(error.issues),'the strict rejection must expose all independently checkable issues');
 assert.ok(error.issues.length);assert.equal(error instanceof TypeError,false,'malformed input must produce contract feedback, not a programming exception');
 for(const issue of error.issues)for(const key of ['path','code','message'])assert.ok(typeof issue[key]==='string'&&issue[key].length,`${key} is actionable plain text`);
 return error.issues;
}
function parse(response,payload,diagnostics){return parseAssistant(response,payload.purpose,payload,diagnostics);}
function byPath(error){return new Map(issues(error).map(issue=>[issue.path,issue]));}

test('actual020 primary responses retain exact raw hashes, recorded aliases and full canonical validator inputs',()=>{
 assert.deepEqual(cases.map(item=>item.sha256),[
  'ceb3af51abb5c6351040b4a6b65a09af8e3a0ce144a9a3375ebcd536a14bd4c1',
  '58d283dbaee7b2463dd93625bf51eda570c414e09ea93017425c9b6b0216be71']);
 assert.deepEqual(cases.map(item=>item.httpSequence),[4,7]);
 for(const record of cases){
  assert.equal(sha(record.raw),record.sha256);assert.equal(record.receipt.version,'foreground-source-handles-v1');
  assert.ok(record.canonicalPayload.sources.length>3,'full original context is retained, not an invented minimal permission context');
  const revisions=new Map(record.receipt.bindings.map(item=>[item.sourceId,item.revision]));
  for(const source of record.canonicalPayload.sources)assert.equal(source.revision,revisions.get(source.id),'canonical body revision matches its recorded HTTP offer');
  const response=recordedResponse(record);assert.equal(response.requestDelivery.sourceId,record.canonicalPayload.intentAuthority.sourceId);
  assert.equal(response.requestDelivery.quote,JSON.parse(record.raw).requestDelivery.quote,'alias decoding preserves exact quoted text');
 }
 const {response}=fixture(0);assert.equal(Object.hasOwn(response.draftPlan.quotes[1],'authorization'),false);
 assert.equal(response.draftPlan.quotes[2].authorization.referent.text.includes(response.draftPlan.quotes[2].text),false);
});

test('unchanged actual020 long primary reports missing authorization and independent referent mismatch atomically',()=>{
 const {record,response,payload}=fixture(0),before=clone(response),error=rejected(()=>parse(response,payload)),found=byPath(error);
 assert.equal(error.code,'assistant_validation_failed');
 assert.ok(found.has('draftPlan.quotes[1].authorization'));
 assert.ok(found.has('draftPlan.quotes[2].authorization.referent'));
 assert.equal(found.get('draftPlan.quotes[1].authorization').code,'draft_material_authorization_missing');
 assert.equal(found.get('draftPlan.quotes[2].authorization.referent').code,'draft_material_referent_mismatch');
 assert.equal(found.size,2,'the exact original has two independent material defects');
 assert.deepEqual(response,before);assert.equal(Object.hasOwn(response.draftPlan.quotes[1],'authorization'),false,'validation never fills a missing grant');
 assert.equal(sha(record.raw),record.sha256);
});

test('unchanged actual020 closed primary reports private delivery/plan conflict and QQ-only control role together',()=>{
 const {record,response,payload}=fixture(1),before=clone(response),error=rejected(()=>parse(response,payload)),found=byPath(error);
 assert.equal(error.code,'assistant_validation_failed');
 assert.ok(found.has('requestDelivery.mode'));assert.ok(found.has('draftPlan.guidance.currentStep.sourceIds'));
 assert.equal(found.get('requestDelivery.mode').code,'request_delivery_unfulfilled');
 assert.equal(found.get('draftPlan.guidance.currentStep.sourceIds').code,'draft_guidance_source_invalid');
 assert.equal(found.size,2,'delivery conflict does not hide an independently checkable control-source role');
 assert.deepEqual(response,before);assert.equal(sha(record.raw),record.sha256);
});

test('quote reordering preserves each defect code and moves only its indexed field path',()=>{
 const {response,payload}=fixture(0),original=byPath(rejected(()=>parse(response,payload)));
 response.draftPlan.quotes=[response.draftPlan.quotes[2],response.draftPlan.quotes[0],response.draftPlan.quotes[1]];
 const reordered=byPath(rejected(()=>parse(response,payload)));
 assert.equal(reordered.size,2);
 assert.equal(reordered.get('draftPlan.quotes[0].authorization.referent')?.code,original.get('draftPlan.quotes[2].authorization.referent').code);
 assert.equal(reordered.get('draftPlan.quotes[2].authorization')?.code,original.get('draftPlan.quotes[1].authorization').code);
});

test('invalid JSON stays a syntax rejection rather than guessed business issues',()=>{
 const {payload}=fixture(),error=rejected(()=>parse('{"kind":"discussion",',payload));
 assert.equal(error.issues,undefined);assert.equal(error.code==='assistant_validation_failed',false);
 assert.match(error.message,/JSON|json|格式|结构/);
});

test('a malformed draftPlan parent reports its shape without invented descendant failures',()=>{
 const {response,payload}=fixture();response.draftPlan='not an object';
 const found=byPath(rejected(()=>parse(response,payload)));
 assert.deepEqual([...found.keys()],['draftPlan']);
});

test('a malformed quotes container suppresses descendant guesses while valid guidance is checked normally',()=>{
 const {response,payload}=fixture();response.draftPlan.quotes='not an array';
 const found=byPath(rejected(()=>parse(response,payload)));
 assert.deepEqual([...found.keys()],['draftPlan.quotes']);
});

test('a malformed guidance parent leaves independent quote defects visible without guessed guidance children',()=>{
 const {response,payload}=fixture();response.draftPlan.guidance=null;
 const found=byPath(rejected(()=>parse(response,payload)));
 assert.ok(found.has('draftPlan.guidance'));assert.ok(found.has('draftPlan.quotes[1].authorization'));assert.ok(found.has('draftPlan.quotes[2].authorization.referent'));
 assert.equal([...found.keys()].some(path=>path.startsWith('draftPlan.guidance.')),false);
});

test('a malformed guidance item reports its parent while a valid-shaped sibling is still checked',()=>{
 const {response,payload}=fixture(1);response.draftPlan.guidance.objective=null;
 const found=byPath(rejected(()=>parse(response,payload)));
 assert.ok(found.has('draftPlan.guidance.objective'));assert.ok(found.has('draftPlan.guidance.currentStep.sourceIds'));assert.ok(found.has('requestDelivery.mode'));
 assert.equal([...found.keys()].some(path=>path.startsWith('draftPlan.guidance.objective.')),false);
});

test('an invalid topic parent leaves delivered QQ-only control roles checked without guessing dependent topic requirements',()=>{
 const {response,payload}=fixture(1);response.topicPatch='not an object';
 const before=clone(response),diagnostics={},found=byPath(rejected(()=>parse(response,payload,diagnostics)));assert.equal(diagnostics.auxiliaryErrors[0].field,'topicPatch');
 assert.deepEqual([...found.keys()].sort(),['draftPlan.guidance.currentStep.sourceIds','requestDelivery.mode'].sort());
 assert.equal(found.get('draftPlan.guidance.currentStep.sourceIds').code,'draft_guidance_source_invalid');
 assert.equal(found.get('requestDelivery.mode').code,'request_delivery_unfulfilled');
 assert.deepEqual(response,before,'neither a topic repair nor a control source is inferred');
});

test('an invalid topic parent does not hide either independently checkable material defect',()=>{
 const {response,payload}=fixture();response.topicPatch='not an object';
 const before=clone(response),diagnostics={},found=byPath(rejected(()=>parse(response,payload,diagnostics)));assert.equal(diagnostics.auxiliaryErrors[0].field,'topicPatch');
 assert.deepEqual([...found.keys()].sort(),['draftPlan.quotes[1].authorization','draftPlan.quotes[2].authorization.referent'].sort());
 assert.equal(found.get('draftPlan.quotes[1].authorization').code,'draft_material_authorization_missing');
 assert.equal(found.get('draftPlan.quotes[2].authorization.referent').code,'draft_material_referent_mismatch');
 assert.deepEqual(response,before);assert.equal(Object.hasOwn(response.draftPlan.quotes[1],'authorization'),false);
});

test('a malformed quote reports only its own parent and does not hide valid-shaped sibling defects',()=>{
 const {response,payload}=fixture();response.draftPlan.quotes[0]=null;
 const found=byPath(rejected(()=>parse(response,payload)));
 assert.ok(found.has('draftPlan.quotes[0]'));assert.ok(found.has('draftPlan.quotes[1].authorization'));assert.ok(found.has('draftPlan.quotes[2].authorization.referent'));
 assert.equal([...found.keys()].some(path=>path.startsWith('draftPlan.quotes[0].')),false);
});

test('a malformed authorization parent does not guess permission or referent descendants',()=>{
 const {response,payload}=fixture();response.draftPlan.quotes[2].authorization='not an object';
 const found=byPath(rejected(()=>parse(response,payload)));
 assert.ok(found.has('draftPlan.quotes[1].authorization'));assert.ok(found.has('draftPlan.quotes[2].authorization'));
 assert.equal([...found.keys()].some(path=>path.startsWith('draftPlan.quotes[2].authorization.')),false);
});

test('an unknown core source handle remains an exact boundary rejection before semantic collection',()=>{
 const {SourceHandleOwner}=require('../src/source-handles.cjs'),{response,payload}=fixture();
 const owner=new SourceHandleOwner({scope:{accountUid:'fixture-owner',peerUid:'fixture-contact'},taskId:'validation-unknown-source'});
 const snapshot=owner.preview(payload,{sources:payload.sources});snapshot.commit();
 const wire=snapshot.project(response);wire.requestDelivery.sourceId='s999999';
 const error=rejected(()=>parseAssistant(wire,payload.purpose,{payload,sourceWireSnapshot:snapshot}));
 assert.equal(error.code,'unknown_source_handle');assert.equal(error.field,'$.requestDelivery.sourceId');assert.equal(error.issues,undefined);
});

test('a derived plan with an actual QQ quote retains its source-valid user controls without granting private material',()=>{
 const {response,payload}=fixture();response.draftPlan.quotes=[response.draftPlan.quotes[0]];
 assert.ok(response.draftPlan.guidance.currentStep.sourceIds.includes(payload.intentAuthority.sourceId),'the field keeps its actual private user control source');
 const answer=parse(response,payload);assert.equal(answer.kind,response.kind);assert.deepEqual(answer.draftPlan.quotes,response.draftPlan.quotes);
 assert.equal(answer.draftPlan.quotes[0].sourceId.startsWith('qq:'),true);
 assert.deepEqual(payload.allowedMaterialIds,cases[0].canonicalPayload.allowedMaterialIds);
});

test('ValidationIssues runs each check once, retains sibling results, and throws deterministic deduplicated issues',()=>{
 const {ValidationIssues}=require('../src/validation-issues.cjs'),sink=new ValidationIssues(),calls=[];
 const before=sink.mark(),success=sink.check('valid','valid_shape',()=>{calls.push('valid');return {exact:'value'};});
 assert.deepEqual(success,{ok:true,value:{exact:'value'}});assert.equal(sink.hasSince(before),false);
 const bad=new Error('Exact existing predicate failure.');
 const failure=sink.check('z.parent','shape_invalid',()=>{calls.push('bad');throw bad;});
 assert.equal(failure.ok,false);assert.equal(sink.hasSince(before),true);
 sink.capture('z.parent','shape_invalid',bad);sink.check('a.sibling','source_invalid',()=>{calls.push('sibling');throw new Error('Exact sibling predicate failure.');});
 assert.deepEqual(calls,['valid','bad','sibling']);
 const error=rejected(()=>sink.throwIfAny());assert.equal(error.code,'assistant_validation_failed');
 assert.deepEqual(issues(error).map(({path,code})=>({path,code})),[
  {path:'a.sibling',code:'source_invalid'},{path:'z.parent',code:'shape_invalid'}]);
 assert.deepEqual(success.value,{exact:'value'},'successful siblings remain available internally while aggregate acceptance fails');
});

test('a single collected error preserves the original strict code and message',()=>{
 const {ValidationIssues}=require('../src/validation-issues.cjs'),sink=new ValidationIssues(),original=new Error('Exact legacy single failure.');
 original.code='legacy_strict_failure';sink.check('draftPlan','parent_invalid',()=>{throw original;});
 const error=rejected(()=>sink.throwIfAny());assert.equal(error.code,original.code);assert.equal(error.message,original.message);
 assert.equal(issues(error).length,1);assert.equal(error.issues[0].path,'draftPlan');
});

test('a valid enabled experience proposal preserves the original 64-source contract and delivered feedback, case and method',()=>{
 // Synthetic parser countercheck derived from the unchanged proposal contract;
 // it is not a replay answer, permission grant, or experience-quality rating.
 const sourceIds=Array.from({length:64},(_,index)=>index===0?'feedback:proposal-counter':`private:proposal-counter-${index}`);
 const payload={purpose:'review',sources:sourceIds.map(id=>({id,type:id.startsWith('feedback:')?'feedback':'private',role:'user',text:'Fictional proposal source.'})),
  experienceProposalPolicy:{enabled:true,feedbackSourceIds:[sourceIds[0]],caseIds:['case:proposal-counter']},methodSelection:{candidates:['respond']}};
 const proposal={text:'Respond to the specific content in this local scenario.',applicability:'Only within the supplied feedback scope.',methodId:'respond',sourceIds,caseIds:['case:proposal-counter']};
 const response={kind:'review',text:'Review the supplied fictional feedback.',experienceProposals:[proposal]},before=clone(response);
 const answer=parse(response,payload);assert.deepEqual(answer.experienceProposals,[proposal]);assert.equal(answer.experienceProposals[0].sourceIds.length,64);
 assert.deepEqual(response,before);
});

test('an invalid task binding defers retained-reference membership while preserving field shape and delivered QQ-role checks',()=>{
 const current='private:binding-current',retained='private:binding-retained',qq='qq:binding-counter',currentText='帮我按当前意思写表达。';
 const payload={purpose:'discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:current},userRequest:{sourceId:current,text:currentText},
  sources:[{id:current,type:'private',role:'user',text:currentText},{id:qq,type:'qq',text:'实际来信'}],
  topicContext:{controlRefs:[{sourceId:retained,revision:'retained-r1',fields:['direction']}]}};
 const response={kind:'discussion',text:'准备表达',requestDelivery:{mode:'editable_message',sourceId:current,quote:currentText},
  draftPlan:{quotes:[],intent:'reply',taskUse:'continue',guidance:{objective:{text:'当前目的',sourceIds:[current]},allowedApproach:{text:'当前方式',sourceIds:[current]},
   avoidances:[],currentStep:{text:'沿已保留的控制',sourceIds:[retained]}}}};
 assert.equal(payload.sources.some(source=>source.id===retained),false,'the retained user control is metadata, not a delivered body');
 assert.deepEqual(parse(clone(response),payload).draftPlan.guidance.currentStep.sourceIds,[retained],'the original retained control reference is valid under a usable binding');
 for(const [invalidPath,invalidate]of [['draftPlan.taskUse',value=>{value.draftPlan.taskUse='INVALID';}],['topicPatch',value=>{value.topicPatch='not an object';}]]){
  const invalid=clone(response);invalidate(invalid);const before=clone(invalid),found=byPath(rejected(()=>parse(invalid,payload)));
  assert.deepEqual([...found.keys()],[invalidPath],'binding-dependent membership/role is deferred instead of rejecting a retained user control');
  assert.deepEqual(invalid,before);
  for(const [label,ids]of [['malformed shape',[null]],['fully delivered QQ-only role',[qq]]]){
   const independent=clone(invalid);independent.draftPlan.guidance.currentStep.sourceIds=ids;
   const checked=byPath(rejected(()=>parse(independent,payload)));
   assert.deepEqual([...checked.keys()].sort(),[invalidPath,'draftPlan.guidance.currentStep.sourceIds'].sort(),`${invalidPath}: ${label} remains independently checkable`);
   assert.equal(checked.get('draftPlan.guidance.currentStep.sourceIds').code,'draft_guidance_source_invalid');
  }
 }
});
