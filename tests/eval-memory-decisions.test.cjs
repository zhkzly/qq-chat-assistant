'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const modulePath=path.join(root,'scripts/eval-memory-decisions.cjs');
const api=()=>require(modulePath);

test('component dataset has paired provisional families without product memory records',()=>{
 const {loadCases}=api(),data=loadCases();assert.equal(data.cases.length,16);assert.equal(new Set(data.cases.map(c=>c.family_id)).size,8);
 for(const item of data.cases){assert.equal(item.reviewer_only.reference_status,'provisional_ai_reference');assert.ok(item.source_seed.references.every(s=>s.path&&s.case_id&&s.sha256));assert.equal(item.runtime.memory_records,undefined);}
});
test('runtime export keeps evidence and decision vocabulary but excludes family, seed and reviewer expectations',()=>{
 const {loadCases,modelInput}=api(),item=structuredClone(loadCases().cases[0]);item.reviewer_only.notes=['GOLD_ONLY_SENTINEL'];item.source_seed.transformations.push('SEED_ONLY_SENTINEL');
 const input=modelInput(item),wire=JSON.stringify(input);assert.ok(input.prior_evidence.length);assert.ok(input.new_evidence.length);assert.ok(input.response_contract.axes.relationships);
 assert.equal(wire.includes('GOLD_ONLY_SENTINEL'),false);assert.equal(wire.includes('SEED_ONLY_SENTINEL'),false);assert.equal(input.family_id,undefined);assert.equal(input.case_id,undefined);
 assert.ok([...input.prior_evidence,...input.new_evidence].every(e=>/^s[1-9][0-9]*$/.test(e.id)));assert.equal(wire.includes(item.runtime.prior_evidence[0].id),false,'semantic fixture IDs must not hint at a label');
});
test('blind reference correction preserves all original runtime stimuli and cannot change model export through reviewer fields',()=>{
 const crypto=require('node:crypto'),{loadCases,modelInput}=api(),snapshot=JSON.parse(fs.readFileSync(path.join(root,'evals/memory-decisions/reference-revisions/provisional-ai-v1.json')));
 const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
 for(const item of loadCases().cases){assert.equal(hash(item.runtime),snapshot.runtime_hashes[item.id]);assert.equal(item.reviewer_only.reference_revision,'provisional-ai-v2');const prior={...structuredClone(item),reviewer_only:snapshot.references[item.id]};assert.deepEqual(modelInput(prior),modelInput(item));}
});
test('component validation rejects future evidence, unknown availability targets and runtime hidden fields',()=>{
 const {loadCases,validateCase}=api(),item=loadCases().cases[0];
 for(const mutate of [c=>c.runtime.new_evidence[0].at='2099-01-01T00:00:00Z',c=>c.runtime.availability_updates=[{id:'lost',at:c.runtime.as_of,source_id:'missing',operation:'exclude'}],c=>c.runtime.expected_answer='Hidden gold']){
  const changed=structuredClone(item);mutate(changed);assert.throws(()=>validateCase(changed));
 }
});
test('actual portable adapter receives only raw controlled input and returns full ungraded decision',async()=>{
 const {loadCases,runCase}=api(),item=loadCases().cases[0],seen=[];
 const adapter={identity:{mode:'synthetic',model:'component-fixture'},async decide(input){seen.push(structuredClone(input));const evidence=[...input.prior_evidence,...input.new_evidence];return {axes:{same_subject:'yes',time_scope:'same',relationships:input.new_evidence[0].text.includes('暂时')?['compatible_addition']:['uncertain'],evidence_sufficiency:'sufficient'},evidence_ids:evidence.map(e=>e.id),reason:'Fixture derived from the actual delivered new text; not a semantic quality rating.'};}};
 const result=await runCase({item,adapter});assert.equal(result.status,'executed_review_required');assert.equal(seen.length,1);assert.equal(JSON.stringify(seen).includes('reviewer_only'),false);assert.equal(result.output.axes.relationships.includes('compatible_addition'),true);assert.equal(result.semantic_evaluation,'not_run');assert.equal(result.review.ratings,null);
});
test('malformed decisions retain the full actual output instead of becoming semantic failures',async()=>{
 const {loadCases,runCase}=api(),raw={axes:{same_subject:'made-up'},body:'ACTUAL_INVALID_OUTPUT'},result=await runCase({item:loadCases().cases[0],adapter:{identity:{mode:'synthetic'},async decide(){return raw;}}});
 assert.equal(result.status,'output_contract_error');assert.deepEqual(result.output,raw);assert.ok(result.output_errors.length);assert.equal(result.semantic_evaluation,'not_run');
});
test('adapter failures preserve code and case identity; no replacement answer is inserted',async()=>{
 const {loadCases,runCase}=api(),result=await runCase({item:loadCases().cases[0],adapter:{identity:{mode:'synthetic'},async decide(){throw Object.assign(Error('provider fixture refused'),{code:'fixture_provider_error'});}}});
 assert.equal(result.status,'incomplete');assert.equal(result.error.code,'fixture_provider_error');assert.equal(result.output,null);assert.ok(result.input_hash);assert.equal(result.review.ratings,null);
});
test('decision timeout aborts the adapter signal and remains an unfinished execution',async()=>{
 const {loadCases,runCase}=api();let aborted=false;
 const result=await runCase({item:loadCases().cases[0],timeoutMs:20,adapter:{identity:{mode:'synthetic'},async decide(_input,{signal}){signal.addEventListener('abort',()=>{aborted=true;});await new Promise(()=>{});}}});
 assert.equal(result.status,'incomplete');assert.equal(result.error.code,'component_timeout');assert.equal(aborted,true);
});
test('CLI inspection never loads the supplied adapter and replay writes separate ungraded review',async t=>{
 const {main,loadCases}=api(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-component-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const poison=path.join(dir,'poison.cjs');fs.writeFileSync(poison,"throw Error('INSPECTION_MUST_NOT_IMPORT_ADAPTER');");
 await main(['--check','--adapter',poison],()=>{});await main(['--list','--adapter',poison],()=>{});
 const id=loadCases().cases[0].id,out=path.join(dir,'results'),adapter=path.join(dir,'adapter.cjs');
 fs.writeFileSync(adapter,`exports.createDecisionAdapter=async()=>({identity:{mode:'synthetic',model:'component-fixture'},async decide(input){return {axes:{same_subject:'uncertain',time_scope:'unknown',relationships:['uncertain'],evidence_sufficiency:'insufficient'},evidence_ids:input.new_evidence.map(e=>e.id),reason:'Actual fixture result.'};},async close(){}});`);
 await main(['--adapter',adapter,'--id',id,'--out',out],()=>{});
 const run=JSON.parse(fs.readFileSync(path.join(out,id+'.run.json'))),review=JSON.parse(fs.readFileSync(path.join(out,id+'.review.json'))),manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));
 assert.equal(run.output.reason,'Actual fixture result.');assert.equal(run.reviewer_only,undefined);assert.ok(review.reviewer_only);assert.equal(review.review.ratings,null);assert.equal(manifest.semantic_evaluation,'not_run');assert.equal(manifest.adapter.mode,'synthetic');
});
test('live adapter identity is rejected without explicit live authorization',async t=>{
 const {main,loadCases}=api(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-component-live-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'live.cjs');fs.writeFileSync(file,"exports.wasClosed=false;exports.createDecisionAdapter=()=>({identity:{mode:'live',model:'never-called'},async decide(){throw Error('MUST_NOT_CALL');},async close(){exports.wasClosed=true;}});");
 const out=path.join(dir,'out');await assert.rejects(main(['--adapter',file,'--id',loadCases().cases[0].id,'--out',out],()=>{}),/live/i);
 assert.equal(JSON.parse(fs.readFileSync(path.join(out,'manifest.json'))).status,'incomplete');assert.equal(require(file).wasClosed,true);
});

function settingsFixture(t,extra={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-luna-settings-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'settings.json');fs.writeFileSync(file,JSON.stringify({model:'gpt-6-luna',baseUrl:'http://fixture.invalid/v1',apiKey:'fixture-component-secret',modelResponseMode:'json_object',...extra}));return file;}
const lunaApi=()=>require('../scripts/eval-memory-decisions-luna-adapter.cjs');
test('Luna bridge uses selected read-only settings and records actual requests/responses with injected fetch',async t=>{
 const {createDecisionAdapter}=lunaApi(),file=settingsFixture(t),before=fs.readFileSync(file,'utf8'),requests=[];
 const adapter=await createDecisionAdapter({live:true,settingsFile:file,maxCalls:3,maxHttp:2,fetchImpl:async(url,args)=>{requests.push({url:String(url),args});return new Response(JSON.stringify({model:'gpt-6-luna',usage:{prompt_tokens:20,completion_tokens:5},choices:[{finish_reason:'stop',message:{content:JSON.stringify({axes:{same_subject:'uncertain',time_scope:'unknown',relationships:['uncertain'],evidence_sufficiency:'insufficient'},evidence_ids:['s1'],reason:'Actual injected provider content.'})}}]}),{status:200});}});
 const input=api().modelInput(api().loadCases().cases[0]),output=await adapter.decide(input,{}),summary=await adapter.summary();
 assert.equal(requests.length,1);assert.equal(requests[0].url,'http://fixture.invalid/v1/chat/completions');assert.equal(JSON.parse(requests[0].args.body).model,'gpt-6-luna');assert.equal(output.reason,'Actual injected provider content.');
 assert.equal(summary.http_attempts,1);assert.equal(summary.requests[0].usage.prompt_tokens,20);assert.ok(summary.requests[0].response_body);assert.equal(summary.settings_unchanged,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 assert.equal(adapter.identity.mode,'synthetic','injected fetch is never reported as actual live-provider evidence');assert.equal(JSON.stringify(summary).includes('fixture-component-secret'),false);assert.equal(JSON.stringify(adapter.identity).includes('fixture-component-secret'),false);
});
test('Luna bridge counts failed HTTP against its shared cap and blocks settings drift before dispatch',async t=>{
 const {createDecisionAdapter}=lunaApi(),file=settingsFixture(t);let calls=0;
 const adapter=await createDecisionAdapter({live:true,settingsFile:file,maxCalls:3,maxHttp:1,fetchImpl:async()=>{calls++;return new Response('provider unavailable',{status:503});}});
 const input=api().modelInput(api().loadCases().cases[0]);await assert.rejects(adapter.decide(input,{}),error=>error.code==='component_http_error');await assert.rejects(adapter.decide(input,{}),error=>error.code==='component_http_limit');assert.equal(calls,1);assert.equal((await adapter.summary()).http_attempts,1);
 const other=settingsFixture(t),guarded=await createDecisionAdapter({live:true,settingsFile:other,maxHttp:2,fetchImpl:async()=>{throw Error('MUST_NOT_DISPATCH');}});fs.writeFileSync(other,JSON.stringify({model:'gpt-6-luna',baseUrl:'http://changed.invalid/v1',anonymous:true}));await assert.rejects(guarded.decide(input,{}),error=>error.code==='component_settings_changed');assert.equal((await guarded.summary()).http_attempts,0);
});
test('Luna bridge supports the selected inert result-tool envelope and preserves truncation as a failure',async t=>{
 const {createDecisionAdapter}=lunaApi(),file=settingsFixture(t,{modelResponseMode:'result_tool'}),payload={axes:{same_subject:'yes',time_scope:'same',relationships:['duplicate'],evidence_sufficiency:'sufficient'},evidence_ids:['s1'],reason:'Exact repeated statement.'};let request;
 const adapter=await createDecisionAdapter({live:true,settingsFile:file,maxHttp:2,fetchImpl:async(_url,args)=>{request=JSON.parse(args.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{tool_calls:[{type:'function',function:{name:'memory_relation_result',arguments:JSON.stringify(payload)}}]}}]}),{status:200});}});
 assert.deepEqual(await adapter.decide(api().modelInput(api().loadCases().cases[0]),{}),payload);assert.equal(request.tool_choice.function.name,'memory_relation_result');
 const truncated=await createDecisionAdapter({live:true,settingsFile:file,maxHttp:1,fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"axes":'}}]}),{status:200})});await assert.rejects(truncated.decide(api().modelInput(api().loadCases().cases[0]),{}),error=>error.code==='component_output_truncated');assert.ok((await truncated.summary()).requests[0].response_body.includes('length'));
});
test('Luna bridge requires explicit live settings and rejects a different selected model',async t=>{
 const {createDecisionAdapter}=lunaApi();await assert.rejects(createDecisionAdapter({}),/explicit|live/i);const file=settingsFixture(t,{model:'not-the-requested-model'});await assert.rejects(createDecisionAdapter({live:true,settingsFile:file,fetchImpl:async()=>{throw Error('MUST_NOT_CALL');}}),/Luna/i);
});

test('standalone CLI initializes the shared contract before loading a Luna adapter',t=>{
 const {spawnSync}=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-luna-entrypoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=settingsFixture(t),wrapper=path.join(dir,'injected-luna.cjs'),out=path.join(dir,'artifacts'),luna=path.join(root,'scripts/eval-memory-decisions-luna-adapter.cjs');
 fs.writeFileSync(wrapper,`const {createDecisionAdapter}=require(${JSON.stringify(luna)});exports.createDecisionAdapter=options=>createDecisionAdapter({...options,live:true,fetchImpl:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({axes:{same_subject:'uncertain',time_scope:'unknown',relationships:['uncertain'],evidence_sufficiency:'insufficient'},evidence_ids:['s1'],reason:'Standalone injected result.'})}}]}),{status:200})});`);
 const child=spawnSync(process.execPath,[modulePath,'--adapter',wrapper,'--id',api().loadCases().cases[0].id,'--settings-file',file,'--max-calls','1','--max-http','1','--out',out],{cwd:root,encoding:'utf8',timeout:10000});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);assert.equal(/circular|non-existent property/.test(child.stderr),false,child.stderr);
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'))),run=JSON.parse(fs.readFileSync(path.join(out,api().loadCases().cases[0].id+'.run.json')));
 assert.equal(manifest.adapter.mode,'synthetic');assert.equal(manifest.status,'executed_review_required');assert.equal(run.output.reason,'Standalone injected result.');assert.equal(run.semantic_evaluation,'not_run');
});

for(const [name,source,stage,code] of [
 ['module-throws',"throw Object.assign(Error('MODULE_SETUP_SENTINEL'),{code:'fixture_module_error'});",'adapter_load','fixture_module_error'],
 ['factory-throws',"exports.createDecisionAdapter=async()=>{throw Object.assign(Error('FACTORY_SETUP_SENTINEL'),{code:'fixture_factory_error'});};",'adapter_factory','fixture_factory_error'],
 ['factory-hangs',"exports.createDecisionAdapter=async()=>{await new Promise(()=>{});};",'adapter_factory','component_timeout']
])test(`standalone CLI retains incomplete artifacts when ${name}`,t=>{
 const {spawnSync}=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-component-setup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const adapter=path.join(dir,'adapter.cjs'),out=path.join(dir,'artifacts'),ids=api().loadCases().cases.slice(0,2).map(c=>c.id);fs.writeFileSync(adapter,source);
 const child=spawnSync(process.execPath,[modulePath,'--adapter',adapter,'--id',ids.join(','),'--out',out,'--timeout-ms','30'],{cwd:root,encoding:'utf8',timeout:10000});
 assert.ifError(child.error);assert.equal(child.status,1,child.stderr);
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'))),run=JSON.parse(fs.readFileSync(path.join(out,ids[0]+'.run.json'))),review=JSON.parse(fs.readFileSync(path.join(out,ids[0]+'.review.json')));
 assert.equal(manifest.status,'incomplete');assert.equal(manifest.adapter,null);assert.deepEqual(manifest.selected_cases,ids);assert.deepEqual(manifest.unexecuted_cases,ids);assert.equal(manifest.adapter_calls,0);assert.equal(manifest.http_attempts,null);assert.equal(manifest.initialization_stage,stage);
 assert.equal(run.status,'incomplete');assert.equal(run.error.code,code);assert.equal(run.adapter_call_started,false);assert.equal(run.input_delivery,'not_dispatched');assert.equal(run.output,null);assert.ok(run.input_hash);assert.equal(run.reviewer_only,undefined);
 assert.equal(review.review.status,'not_run');assert.equal(review.review.ratings,null);assert.equal(review.semantic_evaluation,'not_run');assert.ok(review.reviewer_only);
});

test('standalone invalid-identity factory closes its partial adapter and retains setup evidence',t=>{
 const {spawnSync}=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-component-identity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const adapter=path.join(dir,'adapter.cjs'),marker=path.join(dir,'closed'),out=path.join(dir,'artifacts'),id=api().loadCases().cases[0].id;
 fs.writeFileSync(adapter,`exports.createDecisionAdapter=()=>({identity:{mode:'wrong'},async decide(){throw Error('MUST_NOT_CALL');},async close(){require('node:fs').writeFileSync(${JSON.stringify(marker)},'closed');}});`);
 const child=spawnSync(process.execPath,[modulePath,'--adapter',adapter,'--id',id,'--out',out,'--timeout-ms','30'],{cwd:root,encoding:'utf8',timeout:10000});assert.ifError(child.error);assert.equal(child.status,1,child.stderr);
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json')));assert.equal(manifest.status,'incomplete');assert.equal(manifest.initialization_stage,'adapter_identity');assert.equal(manifest.adapter_calls,0);assert.equal(fs.readFileSync(marker,'utf8'),'closed');assert.equal(manifest.cleanup_error,undefined);
});
