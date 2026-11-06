'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateStreamCase,runtimeCase,runStreamEpisode,loadStreamCases,reviewPacket,argumentsFor,main}=require('../scripts/eval-stream-replay.cjs');

// Shapes derive from the existing raw-memory observer and native adapter tests.
function sample(){return {schema_version:1,policy_version:'raw-stream-replay-v1',id:'stream-contract',family_id:'stream-contract-family',
 start_at:'2026-10-01T12:00:00Z',runtime_goal:'和朋友保持真实交流。',seed:{kind:'project_fictional_adaptation',source:'evals/memory-understanding/cases.jsonl',case_id:'mu-temporary-state-and-later-change'},
 events:[{id:'qq-1',kind:'qq',at:'2026-10-01T12:00:01Z',speaker:'contact',text:'这周换班有点累，跑步还是喜欢的。'},
  {id:'idle-1',kind:'idle',at:'2026-10-01T12:15:01Z',wall_timeout_ms:1000},
  {id:'request-1',kind:'user_request',at:'2026-10-01T12:15:02Z',text:'现在可靠知道什么？'},
  {id:'request-2',kind:'user_request',at:'2026-10-01T12:16:02Z',text:'把刚才的建议说得具体些。',reply_to_event_id:'request-1'}],
 reviewer_only:{sentinel:'REVIEW_ONLY_MARKER',criteria:['REVIEW_ONLY_MARKER']},limitations:['Fictional fixed events are external observations, not causal responses.']};}
function fixture({idleIncomplete=false,missingFirst=false}={}){
 let at,requestCount=0;const calls=[];
 return {calls,protocol_version:1,identity:{name:'portable-test-adapter'},
  async open(initial,options){calls.push({open:initial,options});at=initial.as_of;},async advanceTo(value){calls.push({advance:value});at=value;},
  async observe(events){calls.push({qq:events});},async observePrivate(events){calls.push({private:events});return [];},
  async configure(control){calls.push({control});},async withdrawSources(updates){calls.push({updates});},
  async idleUntil(value,options){calls.push({idle:value,options});at=value;return {status:idleIncomplete?'incomplete':'complete',reason:idleIncomplete?'native_deadline':null,pending_tasks:idleIncomplete?[{owner:'background_memory'}]:[]};},
  async publicMemoryView(){return {as_of:at,memory_status:{pending:idleIncomplete?1:0}};},
  async respond(request){calls.push({request});requestCount++;return missingFirst&&requestCount===1?null:{reply_id:'actual-'+requestCount,text:'Actual runtime answer '+requestCount,suggestions:[],disposition:'discussion'};},
  async drainOutputs(){return [];},async diagnostics(){return {preparation:{schema_version:1,setting:'scheduled_prefix',raw_prefix:{counts:{qq:0,archived_user:0,archived_assistant:0,authored_note:0}},forced_maintenance_requests:0},calls:structuredClone(calls)};},
  async close(){calls.push({closed:true});}
 };
}

test('stream starts empty, applies actual raw chronology, and excludes reviewer criteria',async()=>{
 const item=sample(),adapter=fixture(),result=await runStreamEpisode({item,adapter});
 assert.deepEqual(adapter.calls[0].open,{as_of:item.start_at,qq_events:[],private_events:[]});
 assert.equal(result.status,'executed_review_required');assert.equal(result.events[2].output.reply_id,'actual-1');
 assert.equal(result.events[3].feedback_binding.reply_id,'actual-1');assert.equal(adapter.calls.find(c=>c.request?.id==='request-2').request.reference.reply_id,'actual-1');
 assert.ok(!JSON.stringify(adapter.calls).includes('REVIEW_ONLY_MARKER'));assert.ok(!JSON.stringify(result).includes('REVIEW_ONLY_MARKER'));
 assert.equal(result.setting_receipt.entire_history_reexecuted,true);assert.equal(result.setting_receipt.archived_assistant_turns,0);
 assert.equal(result.semantic_evaluation,'not_run');assert.equal(adapter.calls.at(-1).closed,true);
});

test('explicit idle retains unfinished work and does not advance past the fixed request time',async()=>{
 const item=sample(),adapter=fixture({idleIncomplete:true}),result=await runStreamEpisode({item,adapter});
 const idleCall=adapter.calls.find(c=>c.idle),idleIndex=adapter.calls.indexOf(idleCall);
 assert.notEqual(adapter.calls[idleIndex-1]?.advance,item.events[1].at,'idleUntil owns the interval rather than pre-advancing it');
 assert.equal(result.events[1].checkpoint.status,'incomplete');assert.equal(result.memory_observation_status,'incomplete');
 assert.deepEqual(adapter.calls.find(c=>c.request?.id==='request-1').request,{id:'request-1',at:item.events[2].at,text:item.events[2].text});
 assert.equal(result.status,'executed_review_required');
});

test('validator rejects authored assistant/context seeds, chronology errors and unavailable feedback before adapter open',async()=>{
 for(const modify of [
  c=>{c.initial={memory:[{text:'EXPECTED_MEMORY'}]};},
  c=>{c.events[0]={...c.events[0],kind:'assistant',role:'assistant'};},
  c=>{c.events[0].at='2026-09-30T12:00:00Z';},
  c=>{c.events[0].at='2026-02-30T12:00:00Z';},
  c=>{c.events[2].reply_to_event_id='future-request';},
  c=>{c.events[1].wall_timeout_ms=65001;},
  c=>{c.events[0].expected_memory='EXPECTED_MEMORY';},
  c=>{c.seed.source_sha256='not-a-sha256';}
 ]){const item=sample();modify(item);assert.ok(validateStreamCase(item).length);const adapter=fixture();await assert.rejects(runStreamEpisode({item,adapter}));assert.equal(adapter.calls.length,0);}
 assert.ok(!JSON.stringify(runtimeCase(sample())).includes('REVIEW_ONLY_MARKER'));
 const wrongProtocol=fixture();wrongProtocol.protocol_version=99;await assert.rejects(runStreamEpisode({item:sample(),adapter:wrongProtocol}),/protocol/);assert.equal(wrongProtocol.calls.length,0);
 const unavailable=sample();unavailable.events.splice(1,0,{id:'recall-1',kind:'source_update',at:'2026-10-01T12:00:02Z',source_id:'qq-1',channel:'qq',operation:'recall'},
  {id:'note-after-recall',kind:'note',at:'2026-10-01T12:00:03Z',text:'A derived note must not revive recalled evidence.',evidence_source_ids:['qq-1']});
 assert.ok(validateStreamCase(unavailable).some(error=>error.includes('still-available')));
});

test('notes, controls and withdrawals use their portable runtime boundaries with original metadata',async()=>{
 const item=sample();item.events.splice(1,0,
  {id:'note-1',kind:'note',at:'2026-10-01T12:00:02Z',text:'我愿意分享自己补过包。',declared_use:'draft',note_kind:'material',evidence_source_ids:[]},
  {id:'control-1',kind:'control',at:'2026-10-01T12:00:03Z',controls:{goal:'只做朋友间交流。',automatic:false}},
  {id:'withdraw-1',kind:'source_update',at:'2026-10-01T12:00:04Z',source_id:'note-1',channel:'note',operation:'exclude'});
 const adapter=fixture(),result=await runStreamEpisode({item,adapter});assert.equal(result.status,'executed_review_required');
 assert.deepEqual(adapter.calls.find(c=>c.private).private[0],{id:'note-1',at:'2026-10-01T12:00:02Z',role:'user',text:'我愿意分享自己补过包。',provenance:'authored_user_note',declared_use:'draft',note_kind:'material',evidence_source_ids:[]});
 assert.deepEqual(adapter.calls.find(c=>c.updates).updates,[{id:'note-1',at:'2026-10-01T12:00:04Z',channel:'note',operation:'exclude'}]);
});

test('review packet preserves criteria but strips diagnostics and preparation attribution',async()=>{
 const item=sample(),result=await runStreamEpisode({item,adapter:fixture()}),review=reviewPacket(item,result);
 assert.equal(review.reviewer_only.sentinel,'REVIEW_ONLY_MARKER');assert.equal(review.review.status,'not_run');
 assert.equal(review.initial_diagnostics,undefined);assert.ok(!JSON.stringify(review).includes('forced_maintenance_requests'));
 assert.ok(review.events.every(e=>e.diagnostics===undefined));assert.equal(review.setting_receipt.scope,'backend_e2e_stream_with_declared_adapter_boundaries');
 assert.equal(review.events[1].checkpoint.pending_tasks,undefined);assert.equal(review.cleanup,undefined);
});

test('a foreground failure retains the failed event and unexecuted tail without filling an answer',async()=>{
 const adapter=fixture();adapter.respond=async()=>{const error=Error('provider unavailable');error.code='provider_error';throw error;};
 const item=sample(),result=await runStreamEpisode({item,adapter});assert.equal(result.status,'incomplete');assert.equal(result.events[2].status,'execution_error');
 assert.equal(result.events[2].output,null);assert.equal(result.events[2].error.code,'provider_error');assert.deepEqual(result.unexecuted_events,['request-2']);
 assert.equal(result.setting_receipt.entire_history_reexecuted,false);assert.equal(adapter.calls.at(-1).closed,true);
});

test('check/list require no adapter and live requires explicit config and global cap',async()=>{
 assert.throws(()=>argumentsFor(['--live','--adapter','x','--out','y','--id','z']),/settings-file|max-http/);
 const outputs=[],log=value=>outputs.push(JSON.parse(value));
 await main(['--check'],{log});await main(['--list'],{log});
 assert.equal(outputs[0].status,'valid');assert.equal(outputs[0].inference,'not_run');assert.ok(outputs[1].cases.length>=2);
 assert.equal(loadStreamCases().cases.length,outputs[1].cases.length);
});

test('CLI exports actual outputs, transport and ungraded review separately',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-stream-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cases=path.join(dir,'cases.jsonl'),adapterFile=path.join(dir,'adapter.cjs'),out=path.join(dir,'out');fs.writeFileSync(cases,JSON.stringify(sample())+'\n');
 fs.writeFileSync(adapterFile,`const fs=require('node:fs');module.exports={createAdapterFactory(options){fs.writeFileSync(${JSON.stringify(path.join(dir,'options.json'))},JSON.stringify(options));return {identity:{name:'fixture',max_http:2},summary:()=>({http_attempts:0}),create:async()=>{let n=0;return {protocol_version:1,async open(){},async advanceTo(){},async observe(){},async observePrivate(){return []},async idleUntil(){return {status:'incomplete',reason:'native_deadline'}},async respond(){return {reply_id:'actual-'+(++n),text:'Actual fixture output',suggestions:[],disposition:'discussion'}},async diagnostics(){return {preparation:{schema_version:1,setting:'scheduled_prefix',forced_maintenance_requests:0}}},async close(){}}}}}};`);
 await main(['--cases',cases,'--adapter',adapterFile,'--id','stream-contract','--max-http','2','--out',out],{log:()=>{}});
 const opts=JSON.parse(fs.readFileSync(path.join(dir,'options.json')));assert.equal(opts.condition,'scheduled_idle_public_memory_observation_v1');assert.equal(opts.live,false);assert.equal(opts.maxHttp,2);
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'stream-contract.run.json'))).events[2].output.text,'Actual fixture output');
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'stream-contract.review.json'))).review.status,'not_run');
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'stream-contract.preparation.json'))).forced_maintenance_requests,0);assert.ok(fs.existsSync(path.join(out,'transport.json')));
});

test('factory setup failures persist a declared incomplete run rather than disappearing',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-stream-setup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const adapterFile=path.join(dir,'adapter.cjs'),out=path.join(dir,'out');fs.writeFileSync(adapterFile,"module.exports={createAdapterFactory(){const error=Error('declared setup failure');error.code='setup_failure';throw error;}};");
 const previous=process.exitCode;try{await main(['--adapter',adapterFile,'--id','stream-temporary-state-unchanged','--out',out],{log:()=>{}});assert.equal(process.exitCode,1);}finally{process.exitCode=previous;}
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));assert.equal(manifest.status,'incomplete');assert.equal(manifest.error.code,'setup_failure');assert.deepEqual(manifest.unexecuted_cases,['stream-temporary-state-unchanged']);
});

test('real project adapter streams from empty through normal product routes without forced preparation',async t=>{
 const {createAdapterFactory}=require('../scripts/eval-qq-adapter.cjs');
 const factory=createAdapterFactory({sourceRoot:path.resolve(__dirname,'..'),maxHttp:16,condition:'scheduled_idle_public_memory_observation_v1'}),adapter=await factory.create();
 const item=loadStreamCases().cases.find(c=>c.id==='stream-material-excluded');
 const result=await runStreamEpisode({item,adapter,eventTimeoutMs:10000});assert.equal(result.status,'executed_review_required',JSON.stringify(result.error));
 assert.equal(result.initial_diagnostics.snapshot.total,0);assert.equal(result.initial_diagnostics.snapshot.companion.turns.length,0);
 const trace=result.terminal_diagnostics.trace;
 assert.ok(!trace.some(e=>e.component==='product_http'&&e.route==='/api/memory-maintain'));
 assert.ok(!trace.some(e=>e.component==='private_boundary'&&e.event==='restore'));
 assert.ok(trace.some(e=>e.component==='product_http'&&e.route==='/api/assistant'&&e.event==='request'));
 const withdrawn=result.terminal_diagnostics.snapshot.noteAliases.n1;
 assert.ok(trace.some(e=>e.component==='external_action'&&e.event==='source_withdrawn'&&e.sourceId===withdrawn));
 assert.ok(!result.terminal_diagnostics.snapshot.sources.some(source=>source.id===withdrawn));
 assert.ok(result.events.filter(e=>e.kind==='user_request').every(e=>e.output?.text));
 assert.ok(result.terminal_diagnostics.snapshot.messages.every(m=>typeof m.messageId==='string'));
 assert.ok(factory.summary().http_attempts>0);assert.equal(factory.identity.evidence,'synthetic_transport_product_integration');
 assert.equal(result.semantic_evaluation,'not_run');assert.equal(result.setting_receipt.entire_history_reexecuted,true);
});

test('archive trace labels have a positive control outside the empty-start setting',async t=>{
 const {createAdapterFactory}=require('../scripts/eval-qq-adapter.cjs');
 const factory=createAdapterFactory({sourceRoot:path.resolve(__dirname,'..'),maxHttp:4,condition:'scheduled_idle_public_memory_observation_v1'}),adapter=await factory.create();t.after(()=>adapter.close());
 await adapter.open({as_of:'2026-10-01T12:00:00Z',qq_events:[],private_events:[
  {id:'archive-human-control',at:'2026-10-01T11:58:00Z',role:'user',text:'A real archived original.',provenance:'archived_context'},
  {id:'archive-assistant-control',at:'2026-10-01T11:59:00Z',role:'assistant',text:'An archived generated suggestion.',provenance:'archived_context'}
 ]},{goal:'保持朋友间真实交流。'});
 const {trace}=await adapter.diagnostics(),restores=trace.filter(e=>e.component==='private_boundary'&&e.event==='restore');
 assert.equal(restores.length,2);assert.equal(restores[1].input_event.role,'assistant');assert.equal(factory.summary().http_attempts,0);
});

test('post-pilot source attestation preserves the exact frozen v1 data and all runtime events/criteria',()=>{
 const crypto=require('node:crypto'),frozenFile=path.resolve(__dirname,'../evals/assistant-stream/versions/v1/cases.jsonl'),frozenBytes=fs.readFileSync(frozenFile);
 assert.equal(crypto.createHash('sha256').update(frozenBytes).digest('hex'),'541b7176a1ca2c725123a335300de3caafc622326e815e0250039c266e45d8ab');
 const legacy=loadStreamCases(frozenFile),current=loadStreamCases();assert.equal(legacy.seedProvenance.status,'contains_legacy_unattested');assert.equal(current.seedProvenance.status,'verified');
 assert.equal(current.cases.length,legacy.cases.length);
 for(let i=0;i<current.cases.length;i++){
  assert.deepEqual(runtimeCase(current.cases[i]),runtimeCase(legacy.cases[i]));assert.deepEqual(current.cases[i].reviewer_only,legacy.cases[i].reviewer_only);
  assert.match(current.cases[i].seed.source_sha256,/^[a-f0-9]{64}$/);
 }
});

test('declared seed bytes, cited case and raw IDs are verified before accepting provenance',t=>{
 const crypto=require('node:crypto'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-stream-seed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'evals'));const source=path.join(dir,'evals/source.jsonl'),cases=path.join(dir,'cases.jsonl');
 fs.writeFileSync(source,JSON.stringify({id:'seed-original',initial:{qq_events:[{id:'seed-qq',speaker:'contact',text:'Original evidence.'}],private_events:[]},steps:[]})+'\n');
 const item=sample();item.seed={kind:'project_fictional_adaptation',source:'evals/source.jsonl',case_id:'seed-original',raw_ids:['seed-qq'],source_sha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex')};
 const write=()=>fs.writeFileSync(cases,JSON.stringify(item)+'\n');write();assert.equal(loadStreamCases(cases,{seedRoot:dir}).seedProvenance.status,'verified');
 item.seed.raw_ids=['unknown-original'];write();assert.throws(()=>loadStreamCases(cases,{seedRoot:dir}),/original seed ID/);
 item.seed.raw_ids=['seed-qq'];item.seed.case_id='unknown-case';write();assert.throws(()=>loadStreamCases(cases,{seedRoot:dir}),/seed case/);
 item.seed.case_id='seed-original';write();fs.appendFileSync(source,'\n');assert.throws(()=>loadStreamCases(cases,{seedRoot:dir}),/SHA-256 mismatch/);
});
