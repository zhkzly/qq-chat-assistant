'use strict';
// Synthetic production-pipeline checks. These do not judge conversational quality.
const test=require('node:test'),assert=require('node:assert/strict');
const {definitions}=require('../scripts/style-priority-cases.cjs');
const {runHarness,continuousDefinitions}=require('../scripts/goal-help-quality-check.cjs');
const {withCurrentStatementAuthority}=require('./fixtures/current-statement-authority.cjs');
const selected=id=>definitions().filter(item=>item.id===id);
const stages=(item,stepId,purpose)=>item.stages.filter(stage=>stage.stepId===stepId&&(!purpose||stage.purpose===purpose));
function responder(payload,definition){
 const step=definition.activeStep;
 if(payload.purpose==='fidelity_check')return {checkRef:payload.checkRef,verdict:'allow',issues:[]};
 const reply={operation:'prepare_message',...(step.id==='invite-now'?{currentFacts:['我周六下午有空']}:{}),answer:{privateExplanation:'Synthetic transport output, not a quality verdict.',suggestions:[{style:'自然',text:step.syntheticWording}]}};
 if(step.id==='save-defaults'){
  const text=step.request.slice(step.request.indexOf('以后'),step.request.indexOf('。'));
  reply.actions=[{type:'set_preference',text,evidenceQuote:step.request}];
 }
 return reply;
}
const run=cases=>runHarness({continuousCases:cases,maxHttp:18,syntheticResponder:responder});

test('three predeclared trajectories fit the existing continuous runner without new production fields',()=>{
 const cases=definitions();assert.equal(cases.length,3);assert.deepEqual(continuousDefinitions(cases),cases);
 const tasks=cases.flatMap(item=>item.steps).filter(step=>step.action!=='observe');
 assert.equal(tasks.length,7);assert.equal(tasks.length*2,14);
 assert.ok(cases.every(item=>item.steps.every(step=>step.criteria.expectedGood&&step.criteria.expectedBad)));
 assert.ok(cases.some(item=>item.steps.some(step=>step.action==='observe')));
});

test('work correction, actual send and next incoming retain one history and the real correction source',async()=>{
 const report=await run(selected('S1-work-not-old-activity')),item=report.cases[0];
 assert.equal(item.status,'executed_semantic_review_required',JSON.stringify(item.error||item.checks));
 const [initial,corrected,sent,next]=item.steps;
 assert.deepEqual(item.steps.map(step=>step.actualRecords.length),[1,1,2,3]);
 assert.equal(sent.adviceBefore,null);assert.equal(next.adviceAfter.binding.revision,next.revision);
 assert.notEqual(next.adviceAfter.requestId,initial.adviceAfter.requestId);
 assert.ok(next.adviceAfter.binding.messageIds.includes(next.actualRecords.at(-1).messageId));
 const correction=definitions()[0].steps.find(step=>step.id==='stay-with-current-work').request;
 assert.ok(stages(item,'next-work-detail')[0].effectivePayload.sources.some(source=>source.role==='user'&&source.text===correction));
 assert.equal(corrected.reply.suggestions[0].text,definitions()[0].steps[1].syntheticWording);
 assert.equal(report.realHttpAttempts,0);assert.equal(report.semanticVerdict,'requires_independent_review');
});

test('the current factual time and complete invitation intent reach the admission view separately',async()=>{
 const report=await run(selected('S2-now-invite')),item=report.cases[0];
 assert.equal(item.status,'executed_semantic_review_required',JSON.stringify(item.error||item.checks));const draft=item.steps.find(step=>step.id==='invite-now').admittedContext.payload;
 assert.equal(item.status,'executed_semantic_review_required',JSON.stringify(item.error||item.checks));
 assert.deepEqual(draft.outboundQuotes.map(quote=>quote.text),['我周六下午有空']);
 assert.equal(draft.purpose,'answer_admission');assert.equal(draft.draftingGuidance,undefined);assert.ok(draft.currentHumanControl.text.includes('想约她语音一起拼一会儿'));
 assert.equal(draft.privateConversation,undefined);assert.equal(draft.goal,undefined);
});

test('a real saved preference is overridden for one request and remains intact after quoted third-party text',async()=>{
 const report=await run(selected('S3-one-off-expression')),item=report.cases[0];
 assert.equal(item.status,'executed_semantic_review_required',JSON.stringify(item.error||item.checks));
 const receipt=item.steps[0].reply.actionReceipts.find(value=>value.type==='set_preference');
 assert.equal(receipt?.status,'applied','the old default must really be saved through the existing action path');
 const override=stages(item,'this-turn-complete-emoji')[0],later=stages(item,'third-party-is-not-my-default')[0];
 const saved=override.effectivePayload.preferences.find(value=>value.sourceId===receipt.sourceId);
 assert.ok(saved&&/简短/.test(saved.text)&&/不要额外加表情/.test(saved.text));
 assert.deepEqual(later.effectivePayload.preferences.find(value=>value.sourceId===receipt.sourceId),saved);
 assert.equal(later.effectiveManifest.sourceRevisions[receipt.sourceId],override.effectiveManifest.sourceRevisions[receipt.sourceId]);
 const currentControls=item.steps.find(step=>step.id==='this-turn-complete-emoji').admittedContext.payload.wordingControls?.items||[];
 assert.ok(!currentControls.some(value=>/用简短句子|不额外添加 emoji/.test(value.text)),`opposing saved defaults must not contradict this one-off request: ${JSON.stringify(currentControls)}`);
 const restored=item.steps.find(step=>step.id==='third-party-is-not-my-default').admittedContext.payload.wordingControls?.items||[];
 assert.ok(restored.some(value=>/用简短句子/.test(value.text)));
 assert.ok(restored.some(value=>/不额外添加 emoji/.test(value.text)));
 assert.ok(!item.steps.slice(1).some(step=>step.reply.actionReceipts.some(value=>value.status==='applied')),'one-off and reported wishes do not rewrite saved preferences');
});

test('report-only judgements stay outside prompts and a wrong old-topic sentence is not called quality success',async()=>{
 const scenario=selected('S1-work-not-old-activity')[0];scenario.steps=scenario.steps.slice(0,1);
 scenario.steps[0].criteria.expectedGood='REPORT_ONLY_STYLE_GOOD';scenario.steps[0].criteria.expectedBad='REPORT_ONLY_STYLE_BAD';
 scenario.steps[0].syntheticWording='要不要现在一起玩之前那个双人拼图？';
 const report=await run([scenario]),wire=JSON.stringify(report.requests.map(value=>value.request)),primaryWire=JSON.stringify(report.requests.filter(value=>value.purpose!=='fidelity_check').map(value=>value.request));
 assert.equal(report.cases[0].status,'executed_semantic_review_required','the harness measures transport, not whether an old-topic invitation is natural');
 assert.equal(report.semanticVerdict,'requires_independent_review');assert.equal(wire.includes('REPORT_ONLY_STYLE_'),false);
 assert.equal(primaryWire.includes(scenario.steps[0].syntheticWording),false,'the synthetic bad wording is not a primary generation hint');
 const checked=stages(report.cases[0],scenario.steps[0].id,'fidelity_check')[0].effectivePayload.candidate;assert.equal(checked.suggestions[0].text,scenario.steps[0].syntheticWording,'read-only checking receives the actual generated candidate, including synthetic bad controls');
 assert.equal(report.realHttpAttempts,0);
});
