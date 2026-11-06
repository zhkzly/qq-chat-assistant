'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {httpBudget,exhausted,fields}=require('../scripts/eval-http-budget.cjs');
const ROOT=path.resolve(__dirname,'..');
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-http-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('unlimited aggregate budgets serialize explicitly and never coerce null into a zero cap',()=>{
 const budget=httpBudget({unlimitedHttp:true});assert.deepEqual(JSON.parse(JSON.stringify(fields(budget))),{max_http:null,unlimited_http:true});assert.equal(exhausted(1000000,budget),false);
 for(const maxHttp of [null,Infinity,0,513])assert.throws(()=>httpBudget({maxHttp}));
 assert.throws(()=>httpBudget({unlimitedHttp:true,maxHttp:16}),/either/);
 const finite=httpBudget({maxHttp:2});assert.deepEqual(fields(finite),{max_http:2});assert.equal(exhausted(1,finite),false);assert.equal(exhausted(2,finite),true);
});

test('all replay CLI parsers accept explicit unlimited mode and reject contradictory numeric caps',()=>{
 const {argumentsFor:replay}=require('../scripts/eval-replay-cli.cjs'),{argumentsFor:stream}=require('../scripts/eval-stream-replay.cjs'),{argumentsFor:component}=require('../scripts/eval-memory-decisions.cjs'),{argumentsFor:memory}=require('../scripts/eval-memory-understanding.cjs');
 for(const parser of [replay,stream,component,memory])assert.equal(parser(['--unlimited-http'])['unlimited-http'],true);
 assert.equal(stream(['--live','--settings-file','fixture.json','--unlimited-http'])['unlimited-http'],true);
 for(const parser of [stream,component])assert.throws(()=>parser(['--unlimited-http','--max-http','2']),/either/);
});

test('Luna bridge records more than the former 512-request ceiling in explicit unlimited mode',async t=>{
 const dir=temp(t),file=path.join(dir,'settings.json');fs.writeFileSync(file,JSON.stringify({model:'gpt-6-luna',baseUrl:'http://fixture.invalid/v1',anonymous:true}));
 const {createDecisionAdapter}=require('../scripts/eval-memory-decisions-luna-adapter.cjs'),{loadCases,modelInput}=require('../scripts/eval-memory-decisions.cjs');
 const input=modelInput(loadCases().cases[0]);let calls=0;
 const fetchImpl=async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({axes:{same_subject:'uncertain',time_scope:'unknown',relationships:['uncertain'],evidence_sufficiency:'insufficient'},evidence_ids:[],reason:'Synthetic traffic-count fixture, not a semantic rating.'})}}]}));};
 const adapter=await createDecisionAdapter({live:true,settingsFile:file,unlimitedHttp:true,fetchImpl});t.after(()=>adapter.close());
 assert.equal(adapter.identity.http_cap,null);assert.equal(adapter.identity.unlimited_http,true);
 for(let i=0;i<513;i++)await adapter.decide(input);
 const summary=await adapter.summary();assert.equal(calls,513);assert.equal(summary.http_attempts,513);assert.equal(summary.blocked_attempts,0);assert.equal(summary.requests.length,513);assert.equal(summary.adapter.unlimited_http,true);
 const capped=await createDecisionAdapter({live:true,settingsFile:file,maxHttp:1,fetchImpl});t.after(()=>capped.close());await capped.decide(input);await assert.rejects(capped.decide(input),error=>error.code==='component_http_limit');
});

test('component unlimited CLI runs the full selected workset instead of a hidden sixteen-call quota',async t=>{
 const {main,loadCases}=require('../scripts/eval-memory-decisions.cjs'),dir=temp(t),file=path.join(dir,'cases.jsonl'),adapter=path.join(dir,'adapter.cjs'),out=path.join(dir,'run');
 const base=loadCases().cases[0],cases=Array.from({length:24},(_,i)=>({...structuredClone(base),id:`traffic-fixture-${i}`}));fs.writeFileSync(file,cases.map(c=>JSON.stringify(c)).join('\n')+'\n');
 fs.writeFileSync(adapter,`exports.createDecisionAdapter=async options=>({identity:{mode:'synthetic',model:'traffic-fixture',http_cap:null,unlimited_http:options.unlimitedHttp},async decide(){return {axes:{same_subject:'uncertain',time_scope:'unknown',relationships:['uncertain'],evidence_sufficiency:'insufficient'},evidence_ids:[],reason:'Synthetic invocation count, not a quality score.'};},async summary(){return {http_attempts:0,network_evidence:'none'};}});`);
 await main(['--cases',file,'--adapter',adapter,'--all','--unlimited-http','--out',out],()=>{});
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));assert.equal(manifest.adapter_calls,24);assert.equal(manifest.max_adapter_calls,null);assert.equal(manifest.requested_max_http,null);assert.equal(manifest.unlimited_http,true);assert.deepEqual(manifest.unexecuted_cases,[]);assert.equal(manifest.http_attempts,0);
});

test('QQ adapter preparation loop exceeds sixteen progressing checkpoints only in explicit unlimited mode',async t=>{
 const {createAdapterFactory}=require('../scripts/eval-qq-adapter.cjs'),runtime=require('../scripts/eval-runtime-session.cjs'),original=runtime.createReplaySession;
 // Isolate the adapter's checkpoint loop. The real-product normalization and
 // contiguous-segment paths remain covered by eval-qq-adapter.test.cjs.
 runtime.createReplaySession=async()=>{
  let count=0;const trace=[];
  return {trace,snapshot(){return {asOf:'2026-10-29T12:00:00Z',sources:[],derivedMemory:[],companion:{turns:[],notes:[]},
   memoryStatus:{pending:count<17?1:0,version:count,lastReview:count?{batchId:`batch-${count}`,segments:[{sourceId:'private:fixture',offset:count-1,end:count}]}:null}};},
  async post(route){assert.equal(route,'/api/memory-maintain');trace.push({component:'product_http',event:'request',route});count++;},async close(){}};
 };
 let factory,cappedFactory;try{factory=createAdapterFactory({sourceRoot:ROOT,unlimitedHttp:true});cappedFactory=createAdapterFactory({sourceRoot:ROOT,maxHttp:512});}finally{runtime.createReplaySession=original;}
 const adapter=await factory.create(),capped=await cappedFactory.create();t.after(()=>adapter.close());t.after(()=>capped.close());
 assert.equal(factory.identity.max_http,null);assert.equal(factory.identity.unlimited_http,true);
 const initial={as_of:'2026-10-29T12:00:00Z',qq_events:[],private_events:[]};
 await adapter.open(initial,{goal:'Keep a factual conversation with a friend.'});
 const result=await adapter.diagnostics();assert.equal(result.snapshot.memoryStatus.pending,0);assert.equal(result.preparation.forced_maintenance_requests,17);assert.equal(factory.summary().blocked_attempts,0);
 await assert.rejects(capped.open(initial,{goal:'Keep a factual conversation with a friend.'}),/16 maintenance checkpoints/);
});

test('unlimited QQ preparation still preserves provider failure rather than looping past it',async t=>{
 const {createAdapterFactory}=require('../scripts/eval-qq-adapter.cjs');let calls=0;
 const factory=createAdapterFactory({sourceRoot:ROOT,unlimitedHttp:true,transport:async()=>{calls++;throw Object.assign(Error('Synthetic provider failure'),{code:'fixture_provider_error'});}}),adapter=await factory.create();t.after(()=>adapter.close());
 await assert.rejects(adapter.open({as_of:'2026-10-29T12:00:00Z',qq_events:[],private_events:[{id:'raw',at:'2026-10-29T11:59:00Z',role:'user',text:'An original statement.',provenance:'archived_context'}]},{goal:'Keep a factual conversation.'}));
 const {preparation}=await adapter.diagnostics();assert.equal(preparation.status,'failed');assert.ok(preparation.after.memory_status.pending>0);assert.ok(calls>0);assert.ok(calls<10);assert.equal(factory.summary().blocked_attempts,0);
});

function goalFixture(t,authorized=true){
 const dir=temp(t),goalDir=path.join(dir,'new-goal');fs.mkdirSync(goalDir);
 const original=path.join(ROOT,'goals/assistant-improvement/goal.json'),goal=JSON.parse(fs.readFileSync(original));goal.id='new-unlimited-fixture';goal.execution={...goal.execution,max_http_per_round:null,unlimited_http_authorized:authorized};
 fs.writeFileSync(path.join(goalDir,'goal.json'),JSON.stringify(goal));fs.copyFileSync(path.join(ROOT,'goals/assistant-improvement/roles.json'),path.join(goalDir,'roles.json'));fs.writeFileSync(path.join(goalDir,'state.json'),JSON.stringify({status:'fixture'}));
 return {dir,goalDir,original,originalBytes:fs.readFileSync(original)};
}
test('new Goal directories freeze authorized unlimited budgets without changing the legacy Goal',t=>{
 const {prepareRound,checkRound,status}=require('../scripts/goal-round.cjs'),fixture=goalFixture(t);
 const round=prepareRound({root:ROOT,goalDir:fixture.goalDir,id:'unlimited-fixture',stage:'delivery_provenance',cases:['coverage-observed-output-feedback'],guardrails:['conv-share-own-material-missing'],hypothesis:'Budget identity fixture only.',out:path.join(fixture.dir,'round'),unlimitedHttp:true});
 assert.equal(round.goal_directory,fixture.goalDir);assert.equal(round.max_http,null);assert.equal(round.per_variant_http,null);assert.equal(round.unlimited_http,true);
 assert.equal(checkRound(path.join(fixture.dir,'round')).http_remaining,null);assert.equal(status({root:ROOT,goalDir:fixture.goalDir}).goal.id,'new-unlimited-fixture');
 assert.deepEqual(fs.readFileSync(fixture.original),fixture.originalBytes);
 const finite=prepareRound({root:ROOT,goalDir:fixture.goalDir,id:'finite-fixture',stage:'delivery_provenance',cases:['coverage-observed-output-feedback'],guardrails:['conv-share-own-material-missing'],hypothesis:'Finite remains an explicit choice.',out:path.join(fixture.dir,'finite-round'),maxHttp:32});
 assert.equal(finite.max_http,32);assert.equal(finite.unlimited_http,undefined);
});
test('unlimited Goal round creation rejects absent authorization and mixed flags',t=>{
 const {prepareRound}=require('../scripts/goal-round.cjs'),fixture=goalFixture(t,false),options={root:ROOT,goalDir:fixture.goalDir,id:'not-authorized',stage:'delivery_provenance',cases:['coverage-observed-output-feedback'],guardrails:['conv-share-own-material-missing'],hypothesis:'Negative budget fixture.',out:path.join(fixture.dir,'round'),unlimitedHttp:true};
 assert.throws(()=>prepareRound(options),/authorization/);
 const allowed=goalFixture(t,true);assert.throws(()=>prepareRound({...options,goalDir:allowed.goalDir,out:path.join(allowed.dir,'round'),maxHttp:32}),/either/);
});
