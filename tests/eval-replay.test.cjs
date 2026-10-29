'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runEpisode}=require('../scripts/eval-replay.cjs');
const plan=()=>({schema_version:1,policy_version:'observed-history-replay-v1',id:'portable',source_kind:'event_fixture',goal_type:'friendship',runtime_goal:'Keep in touch with a friend.',
 initial:{as_of:'2026-10-29T10:00:00Z',qq_events:[],private_events:[]},adaptations:[],limitations:['Fixed inputs are not causal human responses.'],
 steps:[{id:'s1',as_of:'2026-10-29T10:01:00Z',qq_events:[{id:'q1',at:'2026-10-29T10:00:30Z',speaker:'contact',text:'Hello',provenance:'authored_external_qq'}],private_events:[],request:{id:'r1',at:'2026-10-29T10:01:00Z',text:'Help me reply.'},feedback:{mode:'independent'}},
 {id:'s2',as_of:'2026-10-29T10:02:00Z',qq_events:[],private_events:[],request:{id:'r2',at:'2026-10-29T10:02:00Z',text:'Make the previous wording warmer.'},feedback:{mode:'independent'}}],
 reviewer_only:{original_goal:'Do not leak GOLD_MARKER',excluded_understandings:[{text:'GOLD_MARKER'}],steps:['s1','s2'].map((id,index)=>({id,evaluation:{acceptable_outputs:['discussion'],should:['GOLD_MARKER'],should_not:['Invent source facts'],critical_failures:[],evidence_ids:[`r${index+1}`]}}))}});
test('portable replay retains the actual episode and keeps reviewer data outside adapters',async()=>{
 const inputs=[];let previous,closed=false;
 const adapter={protocol_version:1,identity:{name:'unrelated-implementation'},async open(initial,options){inputs.push({initial,options});},async advanceTo(at){inputs.push({at});},async observe(events){inputs.push({events});},
 async observePrivate(events){inputs.push({private:events});},async respond(request){inputs.push({request,previous});previous=`actual ${inputs.length}`;return {text:previous,suggestions:[],disposition:'discussion'};},async diagnostics(){return {arbitrary:'not a memory schema'};},async close(){closed=true;}};
 const result=await runEpisode({plan:plan(),adapter});
 assert.equal(result.status,'executed_review_required');assert.equal(result.steps.length,2);assert.equal(result.steps[1].output.text,previous);
 assert.ok(inputs.some(input=>input.request?.id==='r2'&&input.previous));assert.ok(closed);
 assert.ok(!JSON.stringify(inputs).includes('GOLD_MARKER'));assert.ok(!JSON.stringify(inputs[0]).includes('q1'));
 assert.equal(result.semantic_evaluation,'not_run');assert.equal(result.review.status,'not_run');assert.equal(result.review.overall,null);
});
test('behavioral execution has no dependency on an implementation trace or tool names',async()=>{
 const adapter={protocol_version:1,identity:{name:'no-tools'},async open(){},async advanceTo(){},async observe(){},async observePrivate(){},async respond(){return {text:'A useful visible answer',suggestions:[],disposition:'discussion'};},async close(){}};
 const result=await runEpisode({plan:plan(),adapter});assert.equal(result.status,'executed_review_required');assert.equal(result.steps[0].diagnostics,null);
 assert.equal(result.review.overall,null);
});
test('adapter failure keeps partial outputs and closes without inventing semantic ratings',async()=>{
 let count=0,closed=false;
 const adapter={protocol_version:1,identity:{name:'failing'},async open(){},async advanceTo(){},async observe(){},async observePrivate(){},async respond(){if(++count===2)throw Error('runtime unavailable');return {text:'First real output',suggestions:[],disposition:'discussion'};},async close(){closed=true;}};
 const result=await runEpisode({plan:plan(),adapter});assert.equal(result.status,'incomplete');assert.equal(result.steps[0].output.text,'First real output');assert.match(result.steps[1].error.message,/unavailable/);assert.ok(closed);assert.equal(result.review.overall,null);
});
test('unbound response-dependent criticism is not falsely delivered to a different output',async()=>{
 const p=plan();p.steps[1].feedback={mode:'requires_observed_output',reason:'The authored complaint assumes an invitation.'};p.steps[1].private_events=[{id:'p2',at:p.steps[1].as_of,role:'user',text:'Your previous answer was too pushy',provenance:'archived_context'}];let calls=0,privateDelivered=false;
 const adapter={protocol_version:1,identity:{name:'plain'},async open(){},async advanceTo(){},async observe(){},async observePrivate(){privateDelivered=true;},async respond(){calls++;return {text:'No invitation here',suggestions:[],disposition:'discussion'};},async close(){}};
 const result=await runEpisode({plan:p,adapter});assert.equal(calls,1);assert.equal(result.steps[1].status,'not_replayed_response_condition');assert.equal(result.status,'partial_review_required');
 assert.equal(privateDelivered,false);
});
test('optional diagnostics failure does not decide behavioral execution',async()=>{
 let calls=0;
 const adapter={protocol_version:1,async open(){},async advanceTo(){},async observe(){},async observePrivate(){},async diagnostics(){throw Error('Unsupported internal trace');},async respond(){calls++;return {text:'Observed answer',suggestions:[],disposition:'discussion'};},async close(){}};
 const result=await runEpisode({plan:plan(),adapter});assert.equal(calls,2);assert.equal(result.status,'executed_review_required');assert.match(result.initial_diagnostics_error.message,/Unsupported/);assert.ok(result.steps.every(s=>s.diagnostics_error));
});
test('portable boundary rejects a future prefix before an implementation sees it',async()=>{
 const p=plan();p.initial.qq_events=[{id:'future',at:'2026-10-30T00:00:00Z',speaker:'contact',text:'Future information',provenance:'authored_external_qq'}];let opened=false;
 const adapter={protocol_version:1,async open(){opened=true;},async advanceTo(){},async observe(){},async observePrivate(){},async respond(){},async close(){}};
 await assert.rejects(runEpisode({plan:p,adapter}),/outside available/);assert.equal(opened,false);
});
test('initial user controls are applied through the public portable boundary',async()=>{
 const p=plan();p.initial.user_controls={automatic:true};let control;
 const adapter={protocol_version:1,async open(){},async configure(c){control=c;},async advanceTo(){},async observe(){},async observePrivate(){},async respond(){return {text:'Observed answer',suggestions:[],disposition:'discussion'};},async close(){}};
 const result=await runEpisode({plan:p,adapter});assert.equal(result.status,'executed_review_required');assert.deepEqual(control,{automatic:true});
});
test('automatic visible outputs are retained before a later manual response replaces them',async()=>{
 let emitted=false;const queued=[];
 const adapter={protocol_version:1,async open(){},async advanceTo(){if(!emitted){emitted=true;queued.push({reply_id:'automatic-1',text:'Automatic visible advice',suggestions:[],disposition:'discussion'});}},async observe(){},async observePrivate(){},async drainOutputs(){return queued.splice(0);},async respond(){return {reply_id:'manual-1',text:'Manual response',suggestions:[],disposition:'discussion'};},async close(){}};
 const result=await runEpisode({plan:plan(),adapter});assert.equal(result.steps[0].observed_outputs[0].output.reply_id,'automatic-1');assert.equal(result.steps[0].output.reply_id,'manual-1');assert.equal(result.steps[0].observed_outputs.length,1);
});
test('a hanging adapter is bounded by wall time independently of scenario time',async()=>{
 const p=plan();let closed=false;
 const adapter={protocol_version:1,identity:{name:'hang'},async open(){await new Promise(()=>{});},async advanceTo(){},async observe(){},async observePrivate(){},async respond(){},async close(){closed=true;}};
 const result=await runEpisode({plan:p,adapter,timeoutMs:20});assert.equal(result.status,'incomplete');assert.equal(result.error.code,'replay_timeout');assert.ok(closed);
});
