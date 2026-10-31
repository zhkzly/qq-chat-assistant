'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runHarness, definitions, selectedDefinitions, loadRuntime } = require('../scripts/goal-help-quality-check.cjs');
const {materialRefForText}=require('./fixtures/current-statement-authority.cjs');

test('predeclared quality suite has eight families and thirteen distinct tasks', () => {
  const cases = definitions();
  assert.equal(cases.length, 13);
  assert.equal(new Set(cases.map(item => item.family)).size, 8);
  assert.equal(new Set(cases.map(item => item.id)).size, 13);
  assert.throws(() => selectedDefinitions(['Q1-live','Q1-live']), /distinct/);
  assert.throws(() => selectedDefinitions(['unknown']), /declared/);
});

test('synthetic default exercises production controller and separates semantic judgments', async () => {
  const report = await runHarness();
  assert.equal(report.evidence, 'synthetic_transport_pipeline_only');
  assert.equal(report.realHttpAttempts, 0);
  assert.equal(report.cases.length, 13);
  assert.ok(report.cases.every(item => item.status === 'executed_semantic_review_required'));
  assert.ok(report.cases.some(item => item.admittedContext?.payload.purpose==='draft'));
  assert.ok(report.cases.every(item=>item.stages.some(stage=>stage.purpose==='fidelity_check')));
  assert.ok(report.cases.every(item => item.checks.every(check => check.status === 'pass')));
  assert.ok(report.cases.every(item => item.semanticVerdict === 'requires_independent_review'));
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.settingsReadOnly, false);
  assert.equal(report.cases.find(item=>item.id==='Q0-manual-delayed').invocation.trigger,'manual_suggestion');
  assert.equal(report.cases.find(item=>item.id==='Q0-auto-delayed').invocation.trigger,'automatic_observation');
});

test('paired clocks are fixed in actual model input without mutating global Date', async () => {
  const before = Date.now();
  const report = await runHarness({ cases: ['Q1-live','Q1-delayed'] });
  assert.ok(Date.now() >= before);
  for (const item of report.cases) {
    const input = item.stages[0].initialPayload;
    assert.equal(input.asOf, item.fixture.asOf);
    assert.equal(input.taskContext.latestActual.ageMs, item.id === 'Q1-live' ? 60000 : 17 * 3600000);
  }
  const runtime = loadRuntime(require('node:path').resolve(__dirname, '..'), '2026-10-16T01:00:00.000Z');
  assert.equal(runtime.now(), Date.parse('2026-10-16T01:00:00.000Z'));
});

test('rubrics remain report-only and never enter model requests', async () => {
  const report = await runHarness({ cases: ['Q5-invitation'] });
  const wire = JSON.stringify(report.requests.map(item => item.request));
  assert.equal(wire.includes('Positive gold'), false);
  assert.equal(wire.includes('Negative gold'), false);
  assert.equal(wire.includes('Q5-invitation'), false);
  assert.equal(wire.includes('scores'), false);
});

test('non-OK HTTP and transport errors stop all later tasks without retry', async () => {
  for (const syntheticResponder of [() => new Response('capacity', { status: 429 }), () => { throw Error('fictional network failure'); }]) {
    const report = await runHarness({ cases: ['Q1-live','Q5-invitation'], syntheticResponder });
    assert.equal(report.httpAttempts, 1);
    assert.equal(report.cases[0].status, 'execution_failure');
    assert.equal(report.cases[1].status, 'skipped_verification_stopped');
    assert.ok(['non_ok_http','transport_failure'].includes(report.stopped.reason));
  }
});

test('global cap counts every stage and keeps incomplete work visible', async () => {
  const report = await runHarness({ cases: ['Q1-live','Q5-invitation'], maxHttp: 1 });
  assert.equal(report.httpAttempts, 1);
  assert.equal(report.stopped.reason, 'global_http_cap');
  assert.equal(report.cases[1].status, 'skipped_verification_stopped');
  await assert.rejects(runHarness({ maxHttp: 33 }), /1..32/);
});

test('default mode does not read private data and report files cannot overwrite it', async t => {
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
  const originalRead=fs.readFileSync, folder=fs.mkdtempSync(path.join(os.tmpdir(),'qq-help-quality-test-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const reads=[];
  fs.readFileSync=function(filename,...args) { reads.push(String(filename)); return originalRead.call(fs,filename,...args); };
  let report;
  try { report=await runHarness({cases:['Q3-unknown'],out:path.join(folder,'report.json')}); }
  finally { fs.readFileSync=originalRead; }
  assert.ok(!reads.some(filename=>filename.includes('/data/')));
  assert.equal(fs.statSync(path.join(folder,'report.json')).mode&0o777,0o600);
  assert.equal(JSON.stringify(report).includes('Authorization'),false);
  await assert.rejects(runHarness({out:path.join(folder,'report.json')}),/new JSON/);
  await assert.rejects(runHarness({out:'/home/zhkzly/pycodes/qq-chat-assistant/data/never-write-quality-report.json'}),/private data/);
});

test('independent case API records separate criteria without sending gold to the model', async () => {
  const independent={id:'TEST-EXTERNAL',family:'fixture-only',exchange:[[false,'一条虚构消息']],request:'帮我回应这条消息。',
    ageMs:120000,asOf:'2026-10-16T01:00:00.000Z',criteria:{expectedGood:'REPORT_ONLY_EXTERNAL_GOLD',expectedBad:'REPORT_ONLY_EXTERNAL_BAD'}};
  const report=await runHarness({independentCases:[independent]});
  assert.equal(report.independentDeclaration.kind,'independent_held_out');
  assert.equal(report.cases[0].status,'executed_semantic_review_required');
  assert.equal(JSON.stringify(report.requests).includes('REPORT_ONLY_EXTERNAL'),false);
  await assert.rejects(runHarness({independentCases:[{...independent,id:'Q1-live'}]}),/new IDs/);
  await assert.rejects(runHarness({cases:['Q1-live'],independentCases:[independent]}),/cannot be mixed/);
});

test('bounded synthetic material fixture selects only its offered fact sentence and retains the unoffered-substring limitation',async()=>{
 const definition=definitions().find(item=>item.id==='Q3-material'),fact=definition.quoteFragments[0],report=await runHarness({cases:['Q3-material']});
 const input=JSON.parse(report.requests[0].request.messages[1].content),source=input.sources.find(item=>item.id===input.intentAuthority.sourceId);
 assert.equal(source.refinementCoverage.status,'partial');assert.throws(()=>materialRefForText(source,fact),/no exact offered span/);
 const item=report.cases[0],draft=item.admittedContext.payload,quote=draft.outboundQuotes[0];
 assert.equal(item.status,'executed_semantic_review_required');assert.equal(report.httpAttempts,2);assert.equal(report.realHttpAttempts,0);
 assert.ok(quote.text.startsWith(fact));assert.equal(quote.text.slice(fact.length),'。','only the original sentence punctuation accompanies the same exact fact');
 const original=item.stages[0].effectivePayload.sources.find(row=>row.id===item.stages[0].effectivePayload.intentAuthority.sourceId);
 assert.ok(original.text.includes(quote.text));assert.equal(quote.text.includes('这件事我愿意分享'),false);assert.equal(quote.text.includes('给我一句'),false);
 assert.equal(report.sourceUnchanged,true);assert.equal(item.semanticVerdict,'requires_independent_review');
});
