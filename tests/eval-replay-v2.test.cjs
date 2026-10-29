'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadReplayPlans,validateReplayPlan}=require('../scripts/eval-replay-plan.cjs');
const {runEpisode,reviewPacket,visibleOutput}=require('../scripts/eval-replay.cjs');
function fixture(){const p=structuredClone(loadReplayPlans().plans.find(p=>p.id==='conv-reconnect-known-anchor'));p.policy_version='observed-history-replay-v2';return p;}
function adapter(extra={}){return {protocol_version:1,async open(){},async advanceTo(){},async observe(){},async observePrivate(){return [];},async respond(request){return {reply_id:`actual-${request.id}`,text:'Actual observed answer',suggestions:[],disposition:'discussion'};},async close(){},...extra};}
test('review projection retains complete visible answer, choice labels and notices',()=>{
 const output={reply_id:'actual',text:'Explanation plus visible body',suggestions:[{text:'Draft',label:'Friendly'}],options:[{label:'Ask about the book'}],notices:[{text:'Background update is pending'}],references:[{label:'Source basis',text:'An actual displayed claim'}],disposition:'draft'};
 assert.deepEqual(visibleOutput(output),output);
});
test('response-relative request references an actually generated earlier reply',async()=>{
 const p=fixture();p.steps[1].request.text='保留刚才这条的意思，写得更轻松一些。';p.steps[1].feedback={mode:'observed_output',target_step_id:p.steps[0].id};
 assert.deepEqual(validateReplayPlan(p),[]);let captured;
 const result=await runEpisode({plan:p,adapter:adapter({async respond(r){captured=r;return {reply_id:`real-${r.id}`,text:'Observed, never a scripted answer',suggestions:[],disposition:'discussion'};}})});
 assert.equal(result.status,'executed_review_required');assert.deepEqual(captured.reference,{reply_id:`real-${p.steps[0].request.id}`});assert.equal(result.steps[1].feedback_binding.status,'bound');
 assert.equal(reviewPacket(p,result,{dimensions:[]}).steps[1].feedback_binding.reply_id,`real-${p.steps[0].request.id}`);
});
test('feedback with no returned reply identity is recorded as unreplayed, not fabricated',async()=>{
 const p=fixture();p.steps[1].request.text='根据刚才这条再给个简短版本。';p.steps[1].feedback={mode:'observed_output',target_step_id:'s1'};let calls=0;
 const result=await runEpisode({plan:p,adapter:adapter({async respond(){calls++;return {text:'No identity provided',suggestions:[],disposition:'discussion'};}})});
 assert.equal(calls,1);assert.equal(result.status,'partial_review_required');assert.equal(result.steps[1].feedback_binding.status,'unavailable');
});
test('portable goal controls and source withdrawal are applied at their declared boundaries',async()=>{
 const p=fixture();p.initial.private_events.push({id:'private-fact',at:p.initial.as_of,role:'user',text:'A private old detail',provenance:'archived_context'});
 p.steps[1].user_controls={goal:'Now coordinate a work handoff.'};p.steps[1].source_updates=[{id:'private-fact',at:p.steps[1].as_of,channel:'private',operation:'delete'}];
 const operations=[];const result=await runEpisode({plan:p,adapter:adapter({async configure(v){operations.push(['goal',v]);},async withdrawSources(v){operations.push(['withdraw',v]);}})});
 assert.equal(result.status,'executed_review_required');assert.deepEqual(operations.map(x=>x[0]),['withdraw','goal']);assert.equal(result.steps[1].input.source_updates[0].id,'private-fact');
});
test('unknown future targets, fabricated output IDs and invalid withdrawals are rejected',()=>{
 for(const mutate of [p=>{p.steps[0].feedback={mode:'observed_output',target_step_id:'s2'};},p=>{p.steps[1].feedback={mode:'observed_output',target_step_id:'missing'};},p=>{p.steps[1].source_updates=[{id:'not-yet-existing',at:p.steps[1].as_of,channel:'private',operation:'delete'}];},p=>{p.steps[1].feedback={mode:'requires_observed_output',reason:'A bound reply',bound_output_id:'actual-r1'};p.steps[1].request=null;},p=>{p.steps[1].source_updates=[{id:'q1',at:p.steps[1].as_of,channel:'qq',operation:'delete'}];}]){
  const p=fixture();mutate(p);assert.ok(validateReplayPlan(p).length);
 }
 const nullRequest=fixture();nullRequest.steps[1].request=null;nullRequest.steps[1].feedback={mode:'requires_observed_output',reason:'Explicitly selected earlier output',bound_output_id:'actual-r1'};nullRequest.reviewer_only.steps[1].evaluation.evidence_ids=['q1'];assert.match(validateReplayPlan(nullRequest).join('\n'),/observed-output feedback requires a current user request/);
 const mislabeled=fixture();mislabeled.policy_version='observed-history-replay-v1';mislabeled.steps[1].user_controls={goal:'A genuinely changed goal'};assert.match(validateReplayPlan(mislabeled).join('\n'),/new observation capabilities require/);
});
test('feedback can explicitly select an earlier recorded automatic answer',async()=>{
 const p=fixture();p.steps[0].request=null;p.reviewer_only.steps[0].evaluation.evidence_ids=['q1'];p.steps[1].feedback={mode:'observed_output',target_step_id:'s1',target_output:{channel:'observed_outputs',index:0}};
 let emitted=false,received;const result=await runEpisode({plan:p,adapter:adapter({async drainOutputs(){if(emitted)return [];emitted=true;return [{reply_id:'actual-automatic',text:'Automatic suggestion',suggestions:[],disposition:'discussion'}];},async currentOutput(){return null;},async respond(r){received=r;return {reply_id:'revised',text:'Revised actual suggestion',suggestions:[],disposition:'discussion'};}})});
 assert.equal(result.status,'executed_review_required');assert.deepEqual(received.reference,{reply_id:'actual-automatic'});
});
test('withdrawn sources cannot support later newly authored notes',()=>{
 const p=fixture();p.initial.private_events.push({id:'old-private',at:p.initial.as_of,role:'user',text:'Historical raw fact',provenance:'archived_context'});
 p.steps[0].source_updates=[{id:'old-private',at:p.steps[0].as_of,channel:'private',operation:'delete'}];
 p.steps[1].private_events=[{id:'new-note',at:p.steps[1].as_of,role:'user',text:'A derived use of removed material',provenance:'authored_user_note',note_kind:'material',declared_use:'discussion',evidence_source_ids:['old-private']}];
 assert.match(validateReplayPlan(p).join('\n'),/already withdrawn/);
});
test('authored assistant answers are allowed only in the frozen prefix',()=>{
 const p=fixture();p.steps[0].private_events=[{id:'fake-new-answer',at:p.steps[0].as_of,role:'assistant',text:'This is not a real runtime answer',provenance:'archived_context'}];assert.match(validateReplayPlan(p).join('\n'),/new assistant answers/);
 p.steps[0].private_events=[];p.initial.private_events.push({id:'real-archive',at:p.initial.as_of,role:'assistant',text:'An already observed historical answer',provenance:'archived_context'});assert.deepEqual(validateReplayPlan(p),[]);
});
test('legacy availability criteria allow a truthful noncommittal draft without changing original inputs',()=>{
 const d=loadReplayPlans(),p=d.plans.find(p=>p.id==='cm-ambiguous-interest-critical-availability'),e=p.reviewer_only.steps.find(s=>s.id==='s3').evaluation;
 assert.ok(e.acceptable_outputs.includes('draft'));assert.ok(e.should.some(s=>s.includes('没有擅自承诺')));assert.ok(p.adaptations.some(a=>a.field==='reviewer_only.steps.s3.evaluation'));
});
test('current-material positive control preserves the failed history-only case as a separate input',()=>{
 const d=loadReplayPlans(),original=d.plans.find(p=>p.id==='coverage-observed-output-feedback'),control=d.plans.find(p=>p.id==='coverage-feedback-current-material');
 assert.deepEqual(control.initial,original.initial);assert.notEqual(control.steps[0].request.text,original.steps[0].request.text);assert.ok(control.steps[0].request.text.includes('我愿意把这些告诉她'));assert.deepEqual(control.steps[1].feedback,original.steps[1].feedback);assert.ok(control.adaptations.some(a=>a.version==='current-material-control-v2'));
});
test('unavailable image facts and original note metadata survive portable input projection',async()=>{
 const p=fixture();p.initial.private_events.push({id:'note-1',at:p.initial.as_of,role:'user',text:'Only use short wording when she is busy.',provenance:'authored_user_note',note_kind:'preference',declared_use:'discussion',evidence_source_ids:['q1']});
 p.steps[0].qq_events=[{id:'missing-image',at:p.steps[0].as_of,speaker:'contact',text:'',provenance:'authored_external_qq',attachments:[{id:'image-1',kind:'image',availability:'unavailable'}]}];
 let initial,incoming=[];const result=await runEpisode({plan:p,adapter:adapter({async open(v){initial=v;},async observe(v){incoming.push(...v);}})});
 assert.equal(result.status,'executed_review_required');assert.equal(initial.private_events.at(-1).note_kind,'preference');assert.deepEqual(initial.private_events.at(-1).evidence_source_ids,['q1']);assert.equal(incoming.find(e=>e.id==='missing-image').attachments[0].availability,'unavailable');
});
