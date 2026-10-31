'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {definitions,dimensions}=require('../scripts/continuous-conversation-cases.cjs');
const {runHarness}=require('../scripts/goal-help-quality-check.cjs');
const selected=id=>definitions().filter(item=>item.id===id);
const noFailedChecks=report=>report.cases.every(item=>item.status==='executed_semantic_review_required'&&item.checks.every(check=>check.status==='pass'));

test('seven bounded fictional episodes preserve step-specific positive and negative gold',()=>{
  const cases=definitions();assert.equal(cases.length,7);assert.equal(new Set(cases.map(item=>item.id)).size,7);
  assert.equal(dimensions.length,5);assert.ok(cases.every(item=>item.steps.every(step=>step.criteria.expectedGood&&step.criteria.expectedBad)));
  assert.ok(cases.some(item=>item.steps.some(step=>step.action==='observe')));
  assert.ok(cases.some(item=>item.exchange.some(pair=>pair[2]?.image)));
  assert.ok(cases.some(item=>item.distractors===40));
});

test('production continuous pipeline keeps mechanical evidence separate from independent quality review',async()=>{
  const report=await runHarness({continuousCases:definitions(),maxHttp:24});
  assert.equal(report.evidence,'synthetic_transport_pipeline_only');assert.equal(report.realHttpAttempts,0);
  assert.equal(report.independentDeclaration.kind,'independent_continuous_fictional');
  assert.deepEqual(report.independentDeclaration.definitions,definitions());
  assert.equal(report.semanticVerdict,'requires_independent_review');assert.equal(report.cases.length,7);
  assert.ok(noFailedChecks(report),JSON.stringify(report.cases.map(item=>({id:item.id,status:item.status,error:item.error,failed:item.checks.filter(check=>check.status==='fail')}))));
  assert.ok(report.cases.every(item=>item.steps.every(step=>step.semanticVerdict==='requires_independent_review')));
  assert.ok(report.httpAttempts<=24);assert.equal(report.sourceUnchanged,true);
  assert.ok(report.sourceHashesAtStart['src/controller.cjs']);assert.ok(report.sourceHashesAtStart['src/store.cjs']);assert.ok(report.sourceHashesAtStart['ui/app.js']);
  assert.ok(report.sourceHashesAtStart['src/context/planning-view.cjs'],'nested implementation modules belong to the frozen source identity');
});

test('actual-send and next-incoming steps share one history and replace the current QQ binding',async()=>{
  const report=await runHarness({continuousCases:selected('L3-sent-then-next-incoming')});
  const item=report.cases[0],[first,sent,next]=item.steps;
  assert.deepEqual(item.steps.map(step=>step.actualRecords.length),[1,2,3]);
  assert.equal(sent.adviceBefore,null,'the actual outgoing event must invalidate the first current candidate');
  assert.ok(next.revision>first.revision);assert.equal(next.adviceAfter.binding.revision,next.revision);
  assert.ok(next.adviceAfter.binding.messageIds.includes(next.actualRecords.at(-1).messageId));
  assert.notDeepEqual(next.adviceAfter.binding.messageIds,first.adviceAfter.binding.messageIds);
  assert.ok(next.actualRecords.every(record=>typeof record.messageId==='string'));
  assert.ok(noFailedChecks(report));
});

test('the next automatic primary sees the original local correction without treating it as outward material',async()=>{
  const report=await runHarness({continuousCases:selected('L4-correction-survives-next-turn')});
  const item=report.cases[0],request=definitions().find(value=>value.id===item.id).steps[0].request;
  const stages=item.stages.filter(stage=>stage.stepId==='next-incoming-keeps-correction');
  const planner=stages.find(stage=>stage.purpose!=='fidelity_check');
  assert.ok(planner.effectivePayload.sources.some(source=>source.role==='user'&&source.text===request));
  assert.equal(stages.some(stage=>stage.purpose==='fidelity_check'),false,'ordinary suggestions have no automatic critic');
  assert.equal(JSON.stringify(item.steps.at(-1).reply.suggestions).includes(request),false,'private control text is not copied as outward content');
  assert.equal(stages.some(stage=>stage.purpose==='draft'),false,'complete wording is generated in the primary request');
  assert.ok(noFailedChecks(report));
});

test('irrelevant history stays locally intact but does not fill a current automatic request',async()=>{
  const report=await runHarness({continuousCases:selected('L5-unrelated-history')});
  const item=report.cases[0],planner=item.stages[0].effectivePayload;
  assert.equal(item.fixture.records.length,41);assert.equal(item.steps[0].actualRecords.length,41);
  assert.equal(JSON.stringify(planner).includes('FICTIONAL_DISTRACTOR_'),false);
  assert.equal(JSON.stringify(planner).includes('FICTIONAL_PRIVATE_DISTRACTOR_'),false);
  assert.ok(noFailedChecks(report));
});

test('report-only gold and illustrative wording never enter a model request',async()=>{
  const scenario=selected('L1-automatic-candidate')[0];scenario.steps[0].criteria.expectedGood='REPORT_ONLY_CONTINUOUS_GOLD';
  scenario.steps[0].criteria.expectedBad='REPORT_ONLY_CONTINUOUS_BAD';scenario.steps[0].syntheticWording='REPORT_ONLY_SYNTHETIC_WORDING';
  const report=await runHarness({continuousCases:[scenario]});
  const wire=JSON.stringify(report.requests.map(item=>item.request));
  assert.equal(wire.includes('REPORT_ONLY_CONTINUOUS'),false);assert.equal(wire.includes('REPORT_ONLY_SYNTHETIC_WORDING'),false);
  assert.equal(wire.includes('L1-automatic-candidate'),false);
});

test('analysis-only and unjustified wait controls cannot mechanically pass the ordinary candidate obligation',async()=>{
  for(const reply of [
    {kind:'discussion',text:'Synthetic known-bad control: only strategy, no actual reply.'},
    {kind:'discussion',text:'Synthetic known-bad control: no reason to respond.',replyDisposition:'wait'}
  ]){
    const report=await runHarness({continuousCases:selected('L1-automatic-candidate'),maxHttp:4,syntheticResponder:payload=>payload.purpose==='fidelity_check'
      ?{checkRef:payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]}:reply});
    assert.equal(report.realHttpAttempts,0);assert.equal(report.semanticVerdict,'requires_independent_review');
    assert.notEqual(report.cases[0].status,'executed_semantic_review_required');
    assert.ok(!report.cases[0].steps[0]?.reply?.suggestions?.length);
  }
});

test('a real critical unknown permits honest private clarification without pretending a candidate exists',async()=>{
  const report=await runHarness({continuousCases:selected('L7-critical-unknown')});
  const step=report.cases[0].steps[0];assert.equal(step.reply.replyDisposition,'clarify');
  assert.ok(!step.reply.suggestions?.length);assert.ok(noFailedChecks(report));
  assert.equal(step.semanticVerdict,'requires_independent_review');
});

test('continuous cases share the global attempt cap and retain incomplete work',async()=>{
  const report=await runHarness({continuousCases:definitions(),maxHttp:1});
  assert.equal(report.httpAttempts,1);assert.equal(report.stopped.reason,'global_http_cap');
  assert.equal(report.cases[0].status,'executed_semantic_review_required','the first one-call case completes before the global cap stops later work');
  assert.equal(report.cases[1].status,'execution_failure','the next independent case records the exhausted budget');
  assert.ok(report.cases.slice(2).every(item=>item.status==='skipped_verification_stopped'));
  await assert.rejects(runHarness({cases:['Q1-live'],continuousCases:definitions()}),/cannot be mixed/);
  await assert.rejects(runHarness({continuousCases:definitions(),maxHttp:25}),/1\.\.24/);
});
