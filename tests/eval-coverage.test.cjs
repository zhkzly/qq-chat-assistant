'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {validateReplayPlan}=require('../scripts/eval-replay-plan.cjs');
const filename=path.resolve(__dirname,'../evals/assistant/replay/coverage-v2.jsonl');
const read=()=>fs.readFileSync(filename,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
const find=(plans,id)=>{const plan=plans.find(item=>item.id===id);assert.ok(plan,id);return plan;};
const readWithdrawals=()=>fs.readFileSync(path.resolve(__dirname,'../evals/assistant/replay/withdrawal-v2.jsonl'),'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));

test('new coverage plans are valid portable observations with complete ungraded behavioral criteria',()=>{
 const plans=read();assert.equal(plans.length,14);assert.equal(new Set(plans.map(plan=>plan.id)).size,plans.length);
 for(const plan of plans){
  assert.equal(plan.policy_version,'observed-history-replay-v2');
  assert.deepEqual(validateReplayPlan(plan),[],plan.id);
  assert.ok(plan.steps.length>=2&&plan.steps.length<=3,plan.id);
  assert.deepEqual(plan.reviewer_only.excluded_understandings,[]);
  assert.equal(plan.reviewer_only.steps.length,plan.steps.length);
  assert.ok(plan.reviewer_only.coverage.length,plan.id);
  for(const row of plan.reviewer_only.steps){
   assert.ok(row.evaluation.should.length);assert.ok(row.evaluation.should_not.length);
   assert.ok(row.evaluation.evidence_ids.length);assert.ok(row.evaluation.acceptable_outputs.length);
   assert.equal(Object.hasOwn(row,'rating'),false,'case authoring never grades an unrun assistant');
  }
 }
});
test('paired scenarios preserve ordinary neutral requests and distinguish welcomed initiative from a decline',()=>{
 const plans=read(),neutral=find(plans,'coverage-ambiguity-neutral'),explicit=find(plans,'coverage-ambiguity-explicit');
 assert.deepEqual(neutral.initial,explicit.initial,'ambiguity pair starts from the same observations');
 assert.equal(neutral.runtime_goal,explicit.runtime_goal);
 assert.equal(neutral.steps[0].request.text,'她这样说，怎么接？');
 assert.notEqual(neutral.steps[0].request.text,explicit.steps[0].request.text);
 for(const id of ['coverage-warm-reciprocity','coverage-low-reciprocity','coverage-emotional-disclosure','coverage-misunderstanding-repair','coverage-explicit-decline','coverage-welcomed-initiative'])find(plans,id);
 const welcome=find(plans,'coverage-welcomed-initiative'),decline=find(plans,'coverage-explicit-decline');
 assert.notEqual(welcome.initial.qq_events.at(-1).text,decline.initial.qq_events.at(-1).text);
 assert.ok(welcome.reviewer_only.coverage.includes('welcomed initiative'));
 assert.ok(decline.reviewer_only.coverage.includes('explicit decline'));
});
test('new external actions refer to real prior sources and actual returned outputs, never an authored replacement answer',()=>{
 const plans=read(),feedback=find(plans,'coverage-observed-output-feedback');
 assert.deepEqual(feedback.steps[1].feedback,{mode:'observed_output',target_step_id:'s1'});
 assert.equal(feedback.steps[1].private_events.some(event=>event.role==='assistant'),false);
 const goal=find(plans,'coverage-permanent-goal-change');
 assert.ok(goal.steps[1].user_controls.goal);assert.notEqual(goal.steps[1].user_controls.goal,goal.runtime_goal);
 assert.equal(goal.steps[2].user_controls,undefined,'a changed purpose persists without repeated controls');
 const withdrawn=find(plans,'coverage-private-source-withdrawal'),action=withdrawn.steps[1].source_updates[0];
 assert.equal(action.operation,'delete');assert.equal(action.channel,'private');
 assert.ok(withdrawn.initial.private_events.some(event=>event.id===action.id));
 const image=find(plans,'coverage-unavailable-image'),event=image.initial.qq_events.at(-1);
 assert.equal(event.text,'');assert.deepEqual(event.attachments,[{id:'img1',kind:'image',availability:'unavailable'}]);
});
test('stress cases retain substantive raw private histories and a segment-sized single source without prepared memory',()=>{
 const plans=read(),history=find(plans,'coverage-long-private-consultation'),single=find(plans,'coverage-long-single-source');
 assert.ok(history.initial.private_events.length>2);
 assert.ok(Buffer.byteLength(JSON.stringify(history.initial.private_events),'utf8')>48000);
 assert.ok(new Set(history.initial.private_events.map(event=>event.text)).size===history.initial.private_events.length,'no duplicated padding turns');
 assert.equal(history.steps[0].request.text,'她刚发这句，怎么回？');
 const users=single.initial.private_events.filter(event=>event.role==='user');assert.equal(users.length,1);
 const han=users[0].text.match(/\p{Script=Han}/gu)||[];
 assert.ok(han.length>=12000&&han.length<=16000,`single raw source has ${han.length} Chinese characters`);
 assert.equal(single.steps[0].request.text,'她问到这些了，帮我回一下。');
 for(const plan of [history,single]){
  assert.deepEqual(plan.reviewer_only.excluded_understandings,[]);
  assert.ok(plan.initial.private_events.every(event=>event.provenance==='archived_context'));
  assert.ok(plan.initial.private_events.every(event=>!Object.hasOwn(event,'memory')));
 }
});
test('note exclusion has a separate behavioral episode with preserved authored material semantics',()=>{
 const plans=readWithdrawals();assert.equal(plans.length,2);
 const plan=find(plans,'coverage-material-note-exclusion');assert.deepEqual(validateReplayPlan(plan),[]);
 assert.equal(plan.steps.length,2);assert.deepEqual(plan.reviewer_only.excluded_understandings,[]);
 assert.equal(plan.initial.private_events.length,1);
 const note=plan.initial.private_events[0];assert.equal(note.provenance,'authored_user_note');
 assert.equal(note.note_kind,'material');assert.equal(note.declared_use,'draft');assert.deepEqual(note.evidence_source_ids,[]);
 assert.deepEqual(plan.steps[1].source_updates,[{id:note.id,at:'2026-10-29T18:20:00+08:00',channel:'note',operation:'exclude'}]);
 assert.equal(plan.steps[1].request.text,'她问到这个了，怎么回？');
 assert.ok(plan.reviewer_only.steps[1].evaluation.acceptable_outputs.includes('clarification'));
 assert.ok(plan.reviewer_only.steps[1].evaluation.acceptable_outputs.includes('draft'));
 for(const row of plan.reviewer_only.steps){assert.ok(row.evaluation.should.length);assert.ok(row.evaluation.should_not.length);assert.ok(row.evaluation.evidence_ids.length);}
});
test('QQ recall is an observed external withdrawal followed by useful new-topic help, without rewriting frozen coverage',()=>{
 const plans=readWithdrawals(),plan=find(plans,'coverage-observed-qq-recall');
 assert.deepEqual(validateReplayPlan(plan),[]);assert.equal(plan.steps.length,2);
 const original=plan.initial.qq_events[0],next=plan.steps[1].qq_events[0];
 assert.deepEqual(plan.steps[1].source_updates,[{id:original.id,at:'2026-10-29T18:20:00+08:00',channel:'qq',operation:'recall'}]);
 assert.equal(next.speaker,'contact');assert.ok(Date.parse(next.at)>Date.parse(plan.steps[1].source_updates[0].at));
 assert.equal(plan.steps[1].request.text,'她换到这个话题了，怎么回？');
 assert.deepEqual(plan.reviewer_only.excluded_understandings,[]);
 assert.ok(plan.reviewer_only.steps[1].evaluation.critical_failures.length);
 const digest=require('node:crypto').createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
 assert.equal(digest,'ad6caf4bb7b2e269fd0fbd96f0d6561682fec41c83ace946c82fc182ea429f8c');
});
