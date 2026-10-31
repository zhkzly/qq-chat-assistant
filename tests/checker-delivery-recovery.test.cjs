'use strict';
// Exact fictional 028 captures plus scripted format corrections. These are
// parser, authority and lifecycle checks; no conversational output is graded.
const test=require('node:test'),assert=require('node:assert/strict');
const captures=require('./fixtures/checker-delivery-028.json');
const {buildFidelityContext:buildLegacyContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
// Historical census decoder contract only; native controller uses sparse audit.
const buildFidelityContext=(prepared,result,info={})=>buildLegacyContext(prepared,result,{...info,auditProtocol:'legacy-census-v7'});
const {assistModel}=require('../src/assistant-model.cjs');
const {mapSourceReferences}=require('../src/source-handles.cjs');
const {Store}=require('../src/store.cjs'),{TaskLedger}=require('../src/request-budget.cjs');
function captured(key){
 const saved=structuredClone(captures[key]),sources=saved.sources.map(source=>{const {sourceId,...evidence}=saved.payload.evidence.find(item=>item.sourceId===source.id);return {...source,...evidence};}),current=saved.payload.intentAuthority?.sourceId;
 const manifest={scope:saved.scope,requestId:'captured028-'+key,sourceIds:sources.map(source=>source.id),sourceRevisions:saved.sourceRevisions};
 const prepared={payload:{purpose:'discussion',asOf:saved.payload.asOf,goal:saved.payload.goal,sources,intentAuthority:{sourceId:current},userRequest:{sourceId:current,text:sources.find(source=>source.id===current)?.text},taskContext:{recentHumanContext:saved.payload.humanInstructions.map(item=>({sourceId:item.sourceId}))}},manifest,fullAvailableSources:sources,essentialSourceIds:sources.map(source=>source.id)};
 const result={kind:'draft',...structuredClone(saved.payload.candidate)},input=buildFidelityContext(prepared,result,{scope:saved.scope,admittedContext:{payload:{outboundQuotes:saved.payload.admittedFragments,currentHumanControl:saved.payload.currentHumanControl},manifest},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
 const bindings=new Map(saved.sourceHandles.bindings.map(item=>[item.handle,item.sourceId])),decoded=mapSourceReferences(saved.raw,id=>bindings.get(id)||id);
 assert.deepEqual(input.payload.candidate,saved.payload.candidate);
 assert.deepEqual(input.payload.evidence,saved.payload.evidence,'all captured original bodies and roles survive reconstruction');
 return {saved,prepared,result,input,decoded};
}
const settings={anonymous:true,model:'synthetic-checker-repair',baseUrl:'http://fixture.invalid/v1',modelResponseMode:'result_tool',assistantRequestBytes:128000};
function native(value,name='fidelity_result'){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'captured-checker-repair',type:'function',function:{name,arguments:JSON.stringify(value)}}]},finish_reason:'tool_calls'}]}),{status:200});}
function wireValue(input,value){const bindings=new Map(input.sourceWireSnapshot.receipt.bindings.map(item=>[item.sourceId,item.handle]));return mapSourceReferences(value,id=>bindings.get(id)||id);}
function task(t,input,{limit=4,primary=true}={}){const store=new Store(':memory:');t.after(()=>store.close());const ledger=new TaskLedger(store),budget=ledger.create(input.manifest.scope,{id:'checker-output-repair',inputDigest:'exact-capture',limit});if(primary){const stage=budget.forStage('discussion'),id=stage.reserveAttempt();stage.finishAttempt(id,{status:200});}return budget;}

for(const key of ['052-8','052-10'])test(`captured ${key}: uncalibrated subject/focus/invitation prohibition is a private concern`,()=>{
 const app=captured(key),checked=parseFidelityResult(app.decoded,app.input);
 assert.equal(checked.verdict,'allow');assert.ok(approvalFor(checked,app.input));assert.ok(checked.concerns.some(item=>item.code==='explicit_outward_prohibition'));
});
test('captured 055-8: a privacy finding cannot invent a restriction on program-authorized QQ material',()=>{
 const app=captured('055-8'),checked=parseFidelityResult(app.decoded,app.input);
 assert.ok(app.input.payload.disclosureAuthority.programSources.some(item=>app.decoded.issues[0].evidence.some(ref=>ref.sourceId===item.sourceId)));
 assert.equal(checked.issues.some(item=>item.quote==='你今天培训辛苦了'),false);assert.ok(app.input.manifest.fidelity.unusableAdvisory.some(item=>item.code==='program_disclosure_authority'));
 // The original primary declared no private fact fragments. Do not turn the
 // separate work-request facts into a blanket current-control permission.
 assert.equal(checked.verdict,'reject');assert.ok(checked.issues.some(item=>item.quote==='明天十点交接时'));
});
test('captured 055-6: extra metadata remains diagnostic and targeted unverifiable assertions stay uncertain',()=>{
 const app=captured('055-6'),value=structuredClone(app.decoded);
 // This capture also contains a separate absent candidate quotation; that
 // defect still needs native same-frame correction, never approximate matching.
 assert.equal(value.factual[0].statements.pop().quote,'她接着说想临摹');
 const checked=parseFidelityResult(value,app.input);
 assert.equal(checked.verdict,'uncertain');assert.equal(approvalFor(checked,app.input),undefined);assert.ok(checked.factual.flatMap(field=>field.statements).filter(item=>item.support==='unverifiable').length===2);
 assert.ok(app.input.manifest.fidelity.unusableAdvisory.some(item=>item.code==='unverifiable_truth_diagnostic'));
});
for(const key of ['053-9','054-6'])test(`captured ${key}: inexact checker quotations use one same-frame correction without changing the answer`,async t=>{
 const app=captured(key),budget=task(t,app.input),before={candidate:structuredClone(app.input.payload.candidate),sources:structuredClone(app.input.payload.evidence),fidelity:structuredClone(app.input.manifest.fidelity)},calls=[];
 assert.throws(()=>parseFidelityResult(app.decoded,app.input),error=>error.code==='factual_statement_invalid');
 const corrected=structuredClone(app.decoded);
 if(key==='053-9')corrected.factual.find(field=>field.path==='discussionExplanation.text').statements=corrected.factual.find(field=>field.path==='discussionExplanation.text').statements.filter(item=>item.quote!=='她有空分享时不用套这个要求');
 else corrected.factual[0].statements.find(item=>item.quote==='我不会把这理解成她拒绝了你').quote='也不会把这理解成她拒绝了你';
 const checked=await assistModel({...settings,requestBudget:budget.forStage('fidelity_check')},app.input,undefined,async(_url,args)=>{const request=JSON.parse(args.body),p=JSON.parse(request.messages[1].content);calls.push({request,p});return native(wireValue(app.input,calls.length===1?app.decoded:corrected));});
 assert.equal(calls.length,2);assert.equal(checked.verdict,'allow');assert.deepEqual(app.input.payload.candidate,before.candidate);assert.deepEqual(app.input.payload.evidence,before.sources);
 const repaired=calls[1].p.originalInput;assert.deepEqual(repaired.candidate,calls[0].p.candidate);assert.deepEqual(repaired.evidence,calls[0].p.evidence);assert.equal(repaired.version,calls[0].p.version);assert.equal(repaired.checkRef,calls[0].p.checkRef);
 assert.ok(calls[1].p.invalidResponse);assert.equal(app.input.manifest.fidelity.candidateHash,before.fidelity.candidateHash);assert.equal(app.input.manifest.fidelity.bindingHash,before.fidelity.bindingHash);
 assert.equal(budget.snapshot().attempts,3);assert.equal(budget.snapshot().requests.filter(request=>request.purpose==='delivery_repair').length,1);assert.ok(app.input.manifest.formatRepair);assert.ok(app.input.manifest.fidelityOutputRepair.raw);
});
test('captured 054-4: unknown commitment kind is resolved by the checker, never locally aliased',async t=>{
 const app=captured('054-4'),budget=task(t,app.input),calls=[];
 assert.throws(()=>parseFidelityResult(app.decoded,app.input),error=>error.code==='factual_statement_invalid');
 const corrected=structuredClone(app.decoded),statement=corrected.factual.flatMap(field=>field.statements).find(item=>item.kind==='commitment');
 // Scripted future-proposal decision; production must ask its checker rather
 // than erasing an unsupported finding when it encounters an unknown kind.
 Object.assign(statement,{kind:'intent'});delete statement.support;delete statement.evidence;delete statement.disclosure;
 const checked=await assistModel({...settings,requestBudget:budget.forStage('fidelity_check')},app.input,undefined,async(_url,args)=>{calls.push(JSON.parse(args.body));return native(wireValue(app.input,calls.length===1?app.decoded:corrected));});
 assert.equal(calls.length,2);assert.equal(checked.verdict,'allow');assert.equal(checked.factual.flatMap(field=>field.statements).find(item=>item.quote==='我给你看看').kind,'intent');
});
test('captured 053-3: an unsupported past or current fact plus an unknown kind can never become approval',async t=>{
 const app=captured('053-3'),budget=task(t,app.input),corrected=structuredClone(app.decoded);let calls=0;
 const unknown=corrected.factual.flatMap(field=>field.statements).find(item=>item.kind==='commitment');Object.assign(unknown,{kind:'intent'});delete unknown.support;delete unknown.basis;
 const checked=await assistModel({...settings,requestBudget:budget.forStage('fidelity_check')},app.input,undefined,async()=>native(wireValue(app.input,++calls===1?app.decoded:corrected)));
 assert.equal(calls,2);assert.equal(checked.verdict,'reject');assert.ok(checked.issues.some(item=>item.quote==='还没想好说哪件'));assert.equal(approvalFor(checked,app.input),undefined);
});
for(const mode of ['unknown-kind','wrong-quote'])test(`a repeated ${mode} checker failure cannot obtain another repair or approval`,async t=>{
 const app=captured(mode==='unknown-kind'?'054-4':'054-6'),budget=task(t,app.input);let calls=0;
 await assert.rejects(assistModel({...settings,requestBudget:budget.forStage('fidelity_check')},app.input,undefined,async()=>{calls++;return native(wireValue(app.input,app.decoded));}));
 assert.equal(calls,2);assert.equal(budget.snapshot().attempts,3);assert.equal(budget.snapshot().requests.filter(request=>request.purpose==='delivery_repair').length,1);
});
test('the normal two-call cap cannot expand for a checker-output repair',async t=>{
 const app=captured('054-6'),budget=task(t,app.input,{limit:2});let calls=0;
 await assert.rejects(assistModel({...settings,requestBudget:budget.forStage('fidelity_check')},app.input,undefined,async()=>{calls++;return native(wireValue(app.input,app.decoded));}),error=>error.code==='request_budget_exhausted');assert.equal(calls,1);assert.equal(budget.snapshot().attempts,2);
});
for(const mode of ['already-used','aborted','stale-frame'])test(`${mode} checker parse failure cannot dispatch a format repair`,async t=>{
 const app=captured('054-6'),budget=task(t,app.input),abort=new AbortController();let calls=0;
 if(mode==='already-used'){const stage=budget.forStage('delivery_repair'),id=stage.reserveAttempt();stage.finishAttempt(id,{status:200});}
 await assert.rejects(assistModel({...settings,requestBudget:budget.forStage('fidelity_check')},app.input,abort.signal,async()=>{calls++;if(mode==='aborted')abort.abort();if(mode==='stale-frame')app.prepared.manifest.scope.peerUid='foreign-contact';return native(wireValue(app.input,app.decoded));}));assert.equal(calls,1);
});
for(const mode of ['transport','http'])test(`a checker format-repair ${mode} failure consumes a single attempt without transport retry`,async t=>{
 const app=captured('054-6'),budget=task(t,app.input);let calls=0;
 await assert.rejects(assistModel({...settings,requestBudget:budget.forStage('fidelity_check')},app.input,undefined,async()=>{if(++calls===1)return native(wireValue(app.input,app.decoded));if(mode==='transport')throw Error('Scripted repair connection failure');return new Response('{}',{status:503});}));
 assert.equal(calls,2);assert.equal(budget.snapshot().attempts,3);assert.equal(budget.snapshot().requests.filter(request=>request.purpose==='delivery_repair').length,1);
});
