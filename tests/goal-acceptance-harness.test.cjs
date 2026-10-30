'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runHarness,definitions,declarations,selectedDefinitions}=require('../scripts/goal-acceptance-check.cjs');
const credentialSentinel='SYNTHETIC_AUTH_CREDENTIAL_SENTINEL';
function assertNoCredentials(value){
 const visit=(item,parent='')=>{if(typeof item==='string')assert.doesNotMatch(item,/\bBearer\s+\S+/i);if(item&&typeof item==='object')for(const [key,child]of Object.entries(item)){
  if(key.toLowerCase()==='authorization'){
   assert.notEqual(parent.toLowerCase(),'headers');
   assert.ok(child&&typeof child==='object'&&!Array.isArray(child),'an HTTP authorization header is not a material permission object');
   assert.deepEqual(Object.keys(child).sort(),['permission','referent']);
  }
  visit(child,key);
 }};
 visit(value);assert.equal(JSON.stringify(value).includes(credentialSentinel),false,'scan all keys and values, including material authorization diagnostics');
}
test('acceptance criteria come from eight predeclared scenarios and extended cases keep their semantic review open',()=>{
 const source=declarations();assert.equal(Object.keys(source.criteria).length,10);assert.equal(definitions().length,8);assert.equal(definitions(true).length,13);
 assert.equal(source.originalBoundarySha256,'cc1bef9a1272e7248eba16f3aaa896574cd0d9a652511194de2a76880135a1f1');
 assert.ok(definitions(true).some(item=>item.id==='G8-contrary'&&item.variantCriteria.expectedBad.includes('contradictory')));
 for(const value of Object.values(source.criteria))assert.ok(value.expectedGood&&value.expectedBad&&value.declaration);
});
test('synthetic transport exercises planning, clarification, private explanations and scoped guidance without claiming model quality',async()=>{
 const report=await runHarness({extended:true});assert.equal(report.evidence,'synthetic_transport_pipeline_only');assert.equal(report.realHttpAttempts,0);
 assert.equal(report.semanticVerdict,'requires_independent_review');assert.equal(report.cases.length,13);assert.ok(report.httpAttempts<=28);
 assert.ok(report.cases.every(item=>item.status==='executed_semantic_review_required'&&item.checks.every(check=>check.status==='pass')));
 const clarification=report.cases.find(item=>item.id==='G2');assert.equal(clarification.stages.length,1);assert.equal(clarification.reply.suggestions,undefined);
 const indirect=report.cases.find(item=>item.id==='G3');assert.deepEqual(indirect.stages.map(stage=>stage.purpose),['discussion','draft']);assert.ok(indirect.reply.discussionExplanation.text);
 const experience=report.cases.find(item=>item.id==='G8');assert.equal(experience.guidanceSeeds.length,4);assert.ok(experience.guidanceDelivery[0].entries.every(item=>item.authority==='user_approved_assistance_guidance'));
 const contrary=report.cases.find(item=>item.id==='G8-contrary');assert.ok(contrary.controls[0].allowedApproach.text.includes('最新请求'));assert.deepEqual(contrary.controls[0].avoidances,[]);
 for(const item of report.cases)for(const stage of item.methodDelivery){
  assert.ok(stage.directoryNavigation.every(method=>method.provided&&method.locations.length&&method.authority==='navigation_only'));
  const actual=stage.instructionDelivery.filter(method=>method.provided);
  assert.ok(actual.every(method=>method.locations.length));
  assert.deepEqual(new Set(actual.map(method=>method.id)),new Set(stage.operationalDelivery.ids),'only actual instruction delivery counts in the trace');
  assert.equal(stage.reportedUseAuthority,'model_report_only_not_observed_adoption');
  if(stage.purpose!=='draft'){
   assert.equal(stage.directoryNavigation.length,8);
   assert.ok(stage.expandedCards.length<=1);
   assert.ok(stage.instructionDelivery.some(method=>!method.provided),'directory entries do not imply all eight operations were delivered');
  }
 }
 assertNoCredentials(report);assert.ok(report.sourceHashesAtStart['src/controller.cjs']);
});
test('targeted cases select only declared IDs and preserve the newly requested rationale and both question meanings',async()=>{
 const cases=['G3','G8','G9','G8-two-questions'];assert.deepEqual(selectedDefinitions({cases}).map(item=>item.id),cases);
 assert.throws(()=>selectedDefinitions({cases:['G9','not-declared']}),/declared scenario ID/);assert.throws(()=>selectedDefinitions({cases:['G9','G9']}),/distinct/);
 const report=await runHarness({cases,maxHttp:10});assert.deepEqual(report.cases.map(item=>item.id),cases);assert.equal(report.httpAttempts,8);
 assert.equal(report.limits.hardCeiling,10);await assert.rejects(runHarness({cases,maxHttp:11}),/1\.\.10/);
 const rationale=report.cases.find(item=>item.id==='G9');assert.equal(rationale.request,'为什么建议这样回？说明依据，再给一句。');
 assert.equal(rationale.observedDeliverables.privateRationale,true);assert.equal(rationale.observedDeliverables.editableWordingCount,1);
 assert.ok(rationale.reply.discussionExplanation.text.includes('不问名字也不邀约'));assert.ok(!rationale.reply.suggestions[0].text.includes('长期目标'));
 const questions=report.cases.find(item=>item.id==='G8-two-questions'),approved=questions.guidanceSeeds.find(item=>item.label==='approved_applicable');
 assert.equal(approved.text,'回应具体近况时，先接住分享，避免连续追问。');assert.ok(questions.reply.suggestions[0].text.includes('项目'));assert.ok(questions.reply.suggestions[0].text.includes('吃饭'));
 assert.ok(!questions.reply.suggestions[0].text.includes('晚饭'));assert.ok(questions.controls[0].allowedApproach.text.includes('两个问题'));assert.deepEqual(questions.controls[0].avoidances,[]);
 assert.equal(report.semanticVerdict,'requires_independent_review');
});
test('global caps retain the first incomplete result and prevent later scenario retries',async()=>{
 const report=await runHarness({maxHttp:1});assert.equal(report.httpAttempts,1);assert.equal(report.stopped.reason,'global_http_cap');
 assert.equal(report.cases[0].status,'execution_failure');assert.ok(report.cases[0].stages.length===2);
 assert.ok(report.cases.slice(1).every(item=>item.status==='skipped_verification_stopped'));
 assert.ok(report.cases[0].tasks.every(task=>task.attempts<=4));
 await assert.rejects(runHarness({maxHttp:25}),/1\.\.24/);await assert.rejects(runHarness({extended:true,maxHttp:29}),/1\.\.28/);
});
test('one failed transport is retained and stops rather than spending automatic retry calls',async()=>{
 let calls=0;const report=await runHarness({syntheticResponder:()=>{calls++;throw new Error('Synthetic socket reset');}});
 assert.equal(calls,1);assert.equal(report.httpAttempts,1);assert.equal(report.stopped.reason,'transport_failure');assert.equal(report.cases[0].status,'execution_failure');
 assert.equal(report.requests[0].failure.name,'Error');assert.ok(report.cases.slice(1).every(item=>item.status==='skipped_verification_stopped'));
});
test('report writes cannot overwrite settings or an existing file, and fictional evidence uses private file permissions',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'qq-goal-harness-test-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const out=path.join(folder,'report.json'),report=await runHarness({out,only:['G2']});
 assert.equal(JSON.parse(fs.readFileSync(out,'utf8')).semanticVerdict,report.semanticVerdict);assert.equal(fs.statSync(out).mode&0o777,0o600);
 await assert.rejects(runHarness({out}),/new JSON path/);
 await assert.rejects(runHarness({out:'/home/zhkzly/pycodes/qq-chat-assistant/data/settings.json'}),/private data/);
});

test('credential scan allows disclosure-diagnostic names but never hides their keys or values',()=>{
 assertNoCredentials({ignoredMaterialAuthorizations:[{sourceId:'private:fictional'}]});
 assertNoCredentials({quote:{authorization:{permission:{sourceId:'private:fictional',text:'ordinary'},referent:{sourceId:'private:fact',text:'ordinary'}}}});
 for(const value of [{Authorization:'fictional'}, {headers:{aUtHoRiZaTiOn:'fictional'}}, {headers:{Authorization:{permission:{},referent:{}}}}, {quote:{authorization:{permission:{text:'Bearer fictional-secret'},referent:{}}}}, {materialAuthorization:{text:'Bearer fictional-secret'}}, {ignoredMaterialAuthorizations:{text:credentialSentinel}}, {[credentialSentinel]:'ordinary'}])assert.throws(()=>assertNoCredentials(value));
});
