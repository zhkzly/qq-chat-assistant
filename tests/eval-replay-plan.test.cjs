'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadDataset}=require('../scripts/eval-dataset.cjs');
const {buildReplayPlan,validateReplayPlan,loadReplayPlans,REPLAY_POLICY_VERSION}=require('../scripts/eval-replay-plan.cjs');
const cases=loadDataset().cases;
const byId=id=>structuredClone(cases.find(item=>item.id===id));
const runtimeView=plan=>({goal:plan.runtime_goal,initial:plan.initial,steps:plan.steps});

test('legacy compilation preserves raw chronology, IDs, goals and incremental observations without flattening',()=>{
 for(const item of cases){
  const original=structuredClone(item),plan=buildReplayPlan(item);
  assert.deepEqual(validateReplayPlan(plan),[],item.id);
  assert.equal(plan.runtime_goal,item.goal);
  assert.deepEqual(plan.initial.qq_events.map(({provenance,...event})=>event),item.initial_context.qq_history);
  assert.equal(plan.steps.length,item.steps.length);
  for(let i=0;i<item.steps.length;i++){
   assert.deepEqual(plan.steps[i].qq_events.map(({provenance,...event})=>event),item.steps[i].qq_updates);
   assert.equal(plan.steps[i].request.id,item.steps[i].request.id);
   assert.equal(plan.steps[i].request.text,item.steps[i].request.text);
   assert.equal(plan.steps[i].private_events.some(event=>item.steps.some(step=>step.request.id===event.id)),false,'prior requests are generated runtime history, not re-injected');
  }
  assert.deepEqual(item,original,'compilation is immutable');
 }
});
test('derived understandings and judging criteria remain reviewer-only; archives are explicitly historical',()=>{
 const item=byId('cm-new-job-corrects-old-understanding');
 item.initial_context.notes[0].text='DERIVED_UNDERSTANDING_SENTINEL';
 item.steps[0].evaluation.should=['REVIEW_CRITERION_SENTINEL'];
 const plan=buildReplayPlan(item),visible=JSON.stringify(runtimeView(plan));
 assert.equal(visible.includes('DERIVED_UNDERSTANDING_SENTINEL'),false);
 assert.equal(visible.includes('REVIEW_CRITERION_SENTINEL'),false);
 assert.equal(plan.reviewer_only.excluded_understandings[0].text,'DERIVED_UNDERSTANDING_SENTINEL');
 const archived=buildReplayPlan(byId('cm-local-correction-continuity')).initial.private_events;
 assert.ok(archived.some(event=>event.role==='assistant'));
 assert.ok(archived.every(event=>event.provenance==='archived_context'));
 assert.equal(archived.some(event=>event.provenance==='actual_generated'),false);
 const note=buildReplayPlan(byId('conv-share-own-material')).initial.private_events.find(event=>event.id==='n1');
 assert.equal(note.role,'user');assert.equal(note.provenance,'authored_user_note');assert.equal(note.declared_use,'draft');
});
test('diagnostic goals only change under checked, declared per-case adaptations',()=>{
 const item=byId('cm-generated-invitation-vs-actual');
 assert.equal(buildReplayPlan(item).runtime_goal,item.goal);
 const override={version:'test-v1',original_text:item.goal,replacement_text:'想邀请她一起做陶艺，把活动商量清楚。',reason:'Keep ordinary purpose without diagnostic instructions.'};
 const plan=buildReplayPlan(item,{goalOverride:override});
 assert.equal(plan.runtime_goal,override.replacement_text);assert.equal(plan.reviewer_only.original_goal,item.goal);
 assert.equal(plan.adaptations[0].version,'test-v1');
 assert.throws(()=>buildReplayPlan(item,{goalOverride:{...override,original_text:'stale'}}),/original_text/);
 assert.throws(()=>buildReplayPlan(item,{goalOverride:{...override,reason:''}}),/reason/);
});
test('response-relative feedback is guarded or explicitly adapted; it never silently judges an unobserved reply',()=>{
 const item=byId('cm-local-correction-continuity'),guarded=buildReplayPlan(item);
 assert.equal(guarded.steps[0].feedback.mode,'requires_observed_output');
 assert.ok(guarded.steps[0].feedback.reason);
 const override={version:'test-v1',original_text:item.steps[0].request.text,replacement_text:'这轮先接她说的分别计数，轻松一点，暂时不邀请。',reason:'Independent current intent, without asserting actual output was awkward.'};
 const adapted=buildReplayPlan(item,{requestOverrides:{s1:override}});
 assert.equal(adapted.steps[0].feedback.mode,'independent');
 assert.equal(adapted.steps[0].request.text,override.replacement_text);
 assert.equal(adapted.adaptations[0].original_text,item.steps[0].request.text);
 // A previously unseen relative correction must be guarded as well.
 const other=byId('conv-reconnect-no-anchor');other.steps[0].request.text='你刚才的回复太冷淡了，重写。';
 assert.equal(buildReplayPlan(other).steps[0].feedback.mode,'requires_observed_output');
});
test('native observable fixtures retain long histories, future evidence and automatic user controls',()=>{
 const loaded=loadReplayPlans({includeLegacy:false}),plans=loaded.plans;
 assert.ok(plans.length>=3);assert.match(loaded.datasetHash,/^[a-f0-9]{64}$/);assert.equal(loaded.policyVersion,REPLAY_POLICY_VERSION);
 for(const plan of plans){assert.deepEqual(validateReplayPlan(plan),[],plan.id);assert.equal(plan.source_kind,'event_fixture');}
 for(const plan of plans.filter(p=>['replay-mixed-history-reciprocity','replay-job-change-later-recall','replay-incoming-then-human-send'].includes(p.id))){assert.ok(plan.steps.length>=3);assert.equal(plan.initial.private_events.some(event=>event.role==='assistant'),false);}
 const mixed=plans.find(plan=>plan.id==='replay-mixed-history-reciprocity');assert.ok(mixed.initial.qq_events.length>=80);assert.ok(mixed.steps.some(step=>step.qq_events.some(event=>event.speaker==='self')));
 const job=plans.find(plan=>plan.id==='replay-job-change-later-recall');assert.ok(job.initial.qq_events.length>=80);assert.ok(job.steps.reduce((n,step)=>n+step.qq_events.length,0)>=45);assert.equal(job.reviewer_only.excluded_understandings.length,0);
 const automatic=plans.find(plan=>plan.id==='replay-incoming-then-human-send');assert.equal(automatic.initial.user_controls.automatic,true);assert.equal(automatic.steps[0].user_controls.automatic,true);assert.equal(automatic.steps[0].request,null);assert.equal(automatic.steps[1].request,null);assert.ok(automatic.steps[1].qq_events.some(event=>event.speaker==='self'));assert.equal(automatic.steps.at(-1).user_controls.automatic,false);
});
test('replay validation rejects future, regressing, duplicate and internal implementation data',()=>{
 const plan=buildReplayPlan(byId('conv-reconnect-known-anchor'));
 for(const change of [
  p=>{p.initial.qq_events[0].at='2026-11-01T00:00:00Z'},
  p=>{p.steps[1].qq_events[0].at=p.initial.qq_events[0].at},
  p=>{p.steps[1].request.id=p.steps[0].request.id},
  p=>{p.steps[0].qq_events.push({...p.initial.qq_events[0]})},
  p=>{p.steps[0].memory_shape={expected:'summary'}},
  p=>{p.reviewer_only.steps[0].evaluation.evidence_ids=['q5']},
  p=>{p.initial.private_events.push({id:'fake',at:p.initial.as_of,role:'assistant',text:'solved answer',provenance:'actual_generated'})},
  p=>{p.steps[0].user_controls={automatic:'yes'}},
  p=>{p.steps[0].as_of='2026-02-30T19:00:00+08:00'}
 ]){const changed=structuredClone(plan);change(changed);assert.ok(validateReplayPlan(changed).length);}
});
test('loader validates all legacy and native plans, checks adaptation identity, and reports row locations',t=>{
 const loaded=loadReplayPlans();assert.equal(loaded.plans.length,cases.length+loadReplayPlans({includeLegacy:false}).plans.length);
 assert.ok(loaded.plans.filter(plan=>plan.source_kind==='legacy_case').every(plan=>plan.steps.every(step=>step.feedback.mode==='independent')),'frozen reviewed adaptations make the supplied cases replayable without blind response-relative feedback');
 const legacy=loaded.plans.find(plan=>plan.id==='cm-local-correction-continuity');assert.equal(legacy.steps[0].feedback.mode,'independent');assert.ok(legacy.adaptations.length);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-replay-plan-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'bad.jsonl'),'{broken\n');assert.throws(()=>loadReplayPlans({includeLegacy:false,replayDir:dir}),/bad.jsonl:1/);
 fs.writeFileSync(path.join(dir,'bad.jsonl'),JSON.stringify(loaded.plans.at(-1))+'\n'+JSON.stringify(loaded.plans.at(-1))+'\n');assert.throws(()=>loadReplayPlans({includeLegacy:false,replayDir:dir}),/duplicate/i);
});
