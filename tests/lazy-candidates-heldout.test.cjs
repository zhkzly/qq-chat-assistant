'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {definitions}=require('../scripts/lazy-candidates-heldout.cjs');
const {runHarness}=require('../scripts/goal-help-quality-check.cjs');

test('independent manual reopening preserves the real trigger and keeps all gold outside requests',async()=>{
  const cases=definitions(),report=await runHarness({independentCases:cases,maxHttp:4});
  assert.equal(report.realHttpAttempts,0);assert.equal(report.independentDeclaration.kind,'independent_held_out');
  assert.equal(report.cases.length,2);const manual=report.cases[0];
  assert.equal(manual.request,null);assert.equal(manual.invocation.trigger,'manual_suggestion');
  assert.equal(manual.stages[0].initialPayload.privateConversation.length,0);
  assert.ok(manual.checks.find(check=>check.name==='no private user turn fabricated by suggestion')?.status==='pass');
  const wire=JSON.stringify(report.requests.map(entry=>entry.request));
  for(const item of cases){
    assert.equal(wire.includes(item.id),false);
    assert.equal(wire.includes(item.criteria.expectedGood),false);
    assert.equal(wire.includes(item.criteria.expectedBad),false);
  }
  // The synthetic manual fixture deliberately waits. Its execution says nothing
  // about the newly declared requirement for a useful renewed opening.
  assert.equal(manual.semanticVerdict,'requires_independent_review');
  assert.equal(report.semanticVerdict,'requires_independent_review');
  await assert.rejects(runHarness({independentCases:[{...cases[0],invocation:'private'}]}),/Independent cases require/);
  await assert.rejects(runHarness({independentCases:[{...cases[1],request:null}]}),/Independent cases require/);
});
