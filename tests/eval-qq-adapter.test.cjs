'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAdapterFactory,projectVisibleTurn,memoryPreparationProgressed}=require('../scripts/eval-qq-adapter.cjs');
const {runMemoryEpisode}=require('../scripts/eval-memory-understanding.cjs');
const sourceRoot=require('node:path').resolve(__dirname,'..'),asOf='2026-10-29T12:00:00.000Z';

// Field shapes and labels derive from ui/app.js assistantVisibleBody and thread rendering.
test('visible projection retains explanation, labeled wording, choices and notices without internal metadata',()=>{
 const turn={id:'actual-reply',role:'assistant',kind:'draft',text:'参考表达，请核对',
  discussionExplanation:{kind:'discussion',text:'先回应她的问题，再说自己的真实情况。'},
  suggestions:[{style:'自然',text:'这是用户看见的参考。'}],expressionOptions:[{label:'先接她的近况'},{intent:'分享自己的日常'}],
  metadataReviewPending:{reasonCode:'auxiliary_metadata_rejected'},artifactMetadata:{secret:'internal'},sourceIds:['private:internal']};
 assert.deepEqual(projectVisibleTurn(turn),{reply_id:'actual-reply',text:'先回应她的问题，再说自己的真实情况。\n\n参考表达，请核对',
  suggestions:[{label:'自然',text:'这是用户看见的参考。'}],options:[{label:'先接她的近况'},{label:'分享自己的日常'}],
  notices:[{text:'建议已保留；这次背景整理待复核。'}],disposition:'draft'});
 assert.equal(projectVisibleTurn({...turn,text:turn.discussionExplanation.text}).text,turn.discussionExplanation.text);
 const recovered=projectVisibleTurn({...turn,responseRecovery:{kind:'private_help',metadataApplied:false}});
 assert.deepEqual(recovered.suggestions,[]);assert.equal(recovered.options,undefined);
 assert.deepEqual(recovered.notices,[{text:'已先给出建议；部分背景整理未完成。'}]);
 assert.deepEqual(projectVisibleTurn({...turn,methodBasis:'This is an actually displayed source claim.',method:{label:'A visible method'}}).references,[{label:'本次参考',text:'This is an actually displayed source claim.'},{label:'模型标记的方法',text:'A visible method'}]);
});
test('prefix preparation accepts committed segment cursor progress and rejects unchanged or invalid receipts',()=>{
 const before={pending:1,processed:0,version:1,lastReview:null};
 const after={pending:1,processed:0,version:2,lastReview:{batchId:'batch-a',segments:[{sourceId:'private:long',offset:0,end:7709}]}};
 assert.equal(memoryPreparationProgressed(before,after),true);
 assert.equal(memoryPreparationProgressed(before,{...after,version:1}),false);
 assert.equal(memoryPreparationProgressed(before,{...after,lastReview:null}),false);
 assert.equal(memoryPreparationProgressed(before,{...after,lastReview:{batchId:'batch-a',segments:[{sourceId:'private:long',offset:7709,end:7709}]}}),false);
 assert.equal(memoryPreparationProgressed(after,{...after,version:3}),false);
});
test('supplemental scheduled-idle condition leaves prefix maintenance to the existing idle timer',async t=>{
 const factory=createAdapterFactory({sourceRoot,maxHttp:12,condition:'scheduled_idle_public_memory_observation_v1'}),adapter=await factory.create();t.after(()=>adapter.close());
 assert.equal(factory.identity.prefix_preparation,'scheduled_only_no_forced_prefix');assert.equal(factory.identity.condition,'scheduled_idle_public_memory_observation_v1');
 assert.equal(factory.identity.foreground_wall_timeout_ms,300000);assert.equal(factory.identity.native_idle_deadline_ms,65000);assert.equal(factory.identity.idle_outer_headroom_ms,2000);
 await adapter.open({as_of:asOf,qq_events:[],private_events:[{id:'idle-private',at:'2026-10-29T11:59:00Z',role:'user',text:'实际原始上下文。',provenance:'archived_context'}]},{goal:'保持真实自然的交流。'});
 const before=await adapter.publicMemoryView();assert.ok(before.memory_status.pending>0);assert.equal(factory.summary().http_attempts,0);
 await adapter.advanceTo('2026-10-29T12:00:10.000Z');
 // Ten seconds is shorter than the unchanged native default idle policy. An
 // observer must retain pending work instead of forcing a ready profile.
 assert.equal(factory.summary().http_attempts,0);
 const checkpoint=await adapter.idleUntil(new Date(before.maintenance_schedule.nextAt).toISOString(),{wallTimeoutMs:1000});assert.equal(checkpoint.status,'complete');
 const after=await adapter.publicMemoryView(),{trace}=await adapter.diagnostics();
 assert.ok(after.memory_status.processed>before.memory_status.processed);
 assert.ok(trace.some(e=>e.component==='controller'&&e.method==='maintainMemory'&&e.event==='call'&&!e.args[0].force));
 assert.ok(!trace.some(e=>e.component==='product_http'&&e.route==='/api/memory-maintain'));
 assert.equal(factory.summary().http_attempts,1);
 assert.throws(()=>createAdapterFactory({sourceRoot,prefixPreparation:'normal_host'}),/explicitly identified/);
 assert.throws(()=>createAdapterFactory({sourceRoot,condition:'force-profile'}),/Unknown supplemental/);
});
test('supplemental global HTTP cap retains actual pending view and incomplete fixed foreground request',async()=>{
 const factory=createAdapterFactory({sourceRoot,maxHttp:1,condition:'scheduled_idle_public_memory_observation_v1'}),adapter=await factory.create();
 const item={schema_version:1,policy_version:'raw-memory-observation-v1',id:'actual-quota-contract',runtime_goal:'只根据真实原文理解。',initial:{as_of:asOf,qq_events:[],private_events:[{id:'original-private',at:'2026-10-29T11:59:00Z',role:'user',text:'原始已知近况。',provenance:'archived_context'}]},
  steps:[{id:'s1',as_of:'2026-10-29T12:18:00Z',qq_events:[],private_events:[],source_updates:[],request:{id:'fixed-after-idle',at:'2026-10-29T12:18:00Z',text:'原定问题不因后台预算而换掉。'},external_observation:{user_quiet_ms:600000,wall_timeout_ms:1000,before_request:['visible_memory'],after_request:['assistant_answer','visible_memory_after_idle']}}]};
 const result=await runMemoryEpisode({item,adapter});assert.equal(result.status,'incomplete');assert.equal(result.steps[0].status,'execution_error');assert.equal(result.steps[0].output,null);
 assert.equal(result.steps[0].request_receipt.wall_timeout_ms,300000);assert.equal(result.steps[0].request_receipt.status,'failed');assert.ok(Number.isFinite(result.steps[0].request_receipt.wall_elapsed_ms));
 assert.ok(result.steps[0].memory_observations.some(row=>row.phase==='before_request'));assert.equal(factory.summary().http_attempts,1);assert.ok(factory.summary().blocked_attempts>=1);
 const requests=result.steps[0].diagnostics.trace.filter(row=>row.component==='product_http'&&row.route==='/api/assistant'&&row.event==='request');assert.equal(requests.length,1);assert.equal(requests[0].args.text,item.steps[0].request.text);
});
test('a valid long private source completes preparation through contiguous committed segments',async t=>{
 const factory=createAdapterFactory({sourceRoot,maxHttp:12}),adapter=await factory.create();t.after(()=>adapter.close());
 const text='长'.repeat(16000);
 await adapter.open({as_of:asOf,qq_events:[],private_events:[{id:'long-private',at:'2026-10-29T11:59:00Z',role:'user',text,provenance:'archived_context'}]},{goal:'保持真实自然的交流。'});
 const {snapshot,trace}=await adapter.diagnostics();assert.equal(snapshot.memoryStatus.pending,0);
 const segments=trace.filter(e=>e.component==='store'&&e.method==='applyMemoryBatch'&&e.event==='result'&&e.result.applied)
  .flatMap(e=>e.result.receipt.segments).filter(s=>s.sourceId==='private:long-private');
 assert.ok(segments.length>=3);assert.equal(segments[0].offset,0);assert.equal(segments.at(-1).end,text.length);
 for(let i=1;i<segments.length;i++)assert.equal(segments[i].offset,segments[i-1].end);
 assert.equal(factory.summary().http_attempts,segments.length);
});
test('feedback binds actual generated outputs, while goal and source actions use current product state',async t=>{
 const factory=createAdapterFactory({sourceRoot,maxHttp:16}),adapter=await factory.create();t.after(()=>adapter.close());
 await adapter.open({as_of:asOf,qq_events:[],private_events:[
  {id:'archived-user',at:'2026-10-28T10:00:00Z',role:'user',text:'旧的私下信息。',provenance:'archived_context'},
  {id:'archived-assistant',at:'2026-10-28T10:01:00Z',role:'assistant',text:'作者冻结的旧回答。',provenance:'archived_context'},
  {id:'old-note',at:'2026-10-28T10:02:00Z',role:'user',text:'愿意分享的小事。',provenance:'authored_user_note',declared_use:'draft',note_kind:'material'}
 ]},{goal:'自然交流。'});
 await assert.rejects(adapter.respond({id:'not-run',at:asOf,text:'这句调整一下。',reference:{reply_id:'archived-assistant'}}),/actual earlier generated/);
 const first=await adapter.respond({id:'r1',at:asOf,text:'先一起想想。'});
 await adapter.respond({id:'r2',at:asOf,text:'把刚才这个回答说具体些。',reference:{reply_id:first.reply_id}});
 await adapter.configure({goal:'只做朋友间交流。',automatic:false});
 await adapter.withdrawSources([{id:'archived-user',at:asOf,channel:'private',operation:'delete'},{id:'old-note',at:asOf,channel:'note',operation:'delete'}]);
 const {snapshot,trace}=await adapter.diagnostics();assert.equal(snapshot.companion.goal.text,'只做朋友间交流。');
 assert.equal(snapshot.sources.some(s=>s.id==='private:archived-user'||s.id==='note:old-note'),false);
 assert.ok(trace.some(e=>e.component==='product_http'&&e.route==='/api/assistant'&&e.args?.sourceTurnIds?.[0]===first.reply_id));
 assert.ok(snapshot.privateAliases.r1);assert.ok(snapshot.privateAliases.r2);
});
