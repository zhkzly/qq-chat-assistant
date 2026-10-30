'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepareRound,attachReplay,buildPacket,recordReview,checkRound,decideRound,hash}=require('../scripts/goal-round.cjs');
const {runEpisode,reviewPacket}=require('../scripts/eval-replay.cjs');
const {implementationIdentity}=require('../scripts/eval-qq-adapter.cjs');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
// Cache immutable Git bytes, not a mutable checkout shared between tests. Each
// baseline fixture receives its own tree at the round's frozen source revision.
const baselineSnapshots=new Map();
function materializeBaseline(directory,revision){
 if(!baselineSnapshots.has(revision)){
  const gitOptions={cwd:ROOT,maxBuffer:32*1024*1024};
  const names=execFileSync('git',['ls-tree','-r','-z','--name-only',revision,'--','src'],gitOptions).toString('utf8').split('\0').filter(Boolean);
  assert.ok(names.length,'Frozen baseline revision must contain product source');
  baselineSnapshots.set(revision,Object.freeze(names.map(name=>Object.freeze({name,body:execFileSync('git',['show',`${revision}:${name}`],gitOptions).toString('base64')}))));
 }
 for(const {name,body}of baselineSnapshots.get(revision)){
  const file=path.join(directory,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(body,'base64'));
 }
 return directory;
}
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-goal-round-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function prepare(t){const dir=directory(t),out=path.join(dir,'round');return {dir,out,round:prepareRound({root:ROOT,id:'source-fix',stage:'delivery_provenance',cases:['coverage-observed-output-feedback'],hypothesis:'PRIVATE_HYPOTHESIS_SENTINEL',out})};}
test('round preparation freezes actual contracts, cases, standards and role bindings without running models',t=>{
 const {round}=prepare(t);assert.equal(round.status,'prepared');assert.equal(round.max_http,32);assert.ok(round.case_plans['coverage-observed-output-feedback']);assert.ok(round.case_ids.length>1);assert.equal(round.variants.baseline,null);assert.equal(round.variants.candidate,null);assert.match(round.rubric_hash,/^[a-f0-9]{64}$/);assert.match(round.roles_hash,/^[a-f0-9]{64}$/);
});
test('missing runs and reviews cannot pass or manufacture completion',t=>{
 const {out}=prepare(t),checked=checkRound(out);assert.equal(checked.ready_to_accept,false);assert.ok(checked.reasons.some(x=>x.includes('baseline')));assert.throws(()=>decideRound(out,{decision:'accepted',reason:'Looks good'}),/not ready/i);assert.equal(JSON.parse(fs.readFileSync(path.join(out,'round.json'))).status,'prepared');
});
test('attachments and review packets reject unknown, missing and altered input identities',t=>{
 const {dir,out}=prepare(t),run=path.join(dir,'bad-run');fs.mkdirSync(run);fs.writeFileSync(path.join(run,'manifest.json'),JSON.stringify({identity:{dataset_hash:'wrong',rubric_version:'wrong'},adapter:{evidence:'synthetic_transport_product_integration'},episodes:[]}));fs.writeFileSync(path.join(run,'transport.json'),JSON.stringify({http_attempts:0}));
 assert.throws(()=>attachReplay(out,{variant:'other',replay:run}),/variant/);assert.throws(()=>attachReplay(out,{variant:'baseline',replay:run}),/identity|dataset|rubric/i);assert.throws(()=>buildPacket(out,{out:path.join(dir,'packet')}),/no attached/i);
});
test('stale or made-up review identities cannot be attached as actual evaluator evidence',t=>{
 const {dir,out}=prepare(t),file=path.join(dir,'fake-review.json');fs.writeFileSync(file,JSON.stringify({packet_hash:'fake',reviewer_id:'self',ratings:[],comparisons:[]}));assert.throws(()=>recordReview(out,{file}),/packet/i);
});
test('rejected and inconclusive decisions preserve the reason and do not accept a stage',t=>{
 const {out}=prepare(t);const result=decideRound(out,{decision:'inconclusive',reason:'No real execution yet'});assert.equal(result.status,'inconclusive');assert.equal(result.decision.reason,'No real execution yet');assert.equal(checkRound(out).ready_to_accept,false);
 assert.throws(()=>decideRound(out,{decision:'rejected',reason:'Change the old decision'}),/cannot be overwritten/);
});
// Unit fixtures use the real portable producer and complete fictional metadata.
// They validate the gate, never claim an actual live experiment or improvement.
async function replayFixture(directory,round,variant,{live=true,http=1}={}){
 fs.mkdirSync(directory);const rubric=JSON.parse(fs.readFileSync(path.join(ROOT,'evals/assistant/rubric.json'))),identity={dataset_hash:round.dataset_hash,rubric_version:round.rubric_version,adapter_hash:hash(fs.readFileSync(path.join(ROOT,'scripts/eval-qq-adapter.cjs')))};
 let sourceRoot;
 if(variant==='candidate'){sourceRoot=path.join(directory,'candidate-checkout');fs.cpSync(path.join(ROOT,'src'),path.join(sourceRoot,'src'),{recursive:true});fs.appendFileSync(path.join(sourceRoot,'src/controller.cjs'),'\n// Isolated provenance fixture version.\n');}
 else sourceRoot=materializeBaseline(path.join(directory,'baseline-checkout'),round.baseline_implementation.revision);
 const adapterIdentity={evidence:live?'live_model_synthetic_events_product_integration':'synthetic_transport_product_integration',source_root:sourceRoot,implementation_hash:implementationIdentity({sourceRoot}).hash,max_http:round.per_variant_http,model:'functional-fixture',destination:{origin:'http://fictional.invalid',path:'/v1'},settings_hash:'fixed',prefix_preparation:'unit-fixture'};
 if(variant==='baseline')assert.equal(adapterIdentity.implementation_hash,round.baseline_implementation.hash,'Fixture baseline must match the frozen revision, even when the working source changes');
 const manifest={identity,adapter:adapterIdentity,selected_cases:round.case_ids,episodes:[],status:'executed_review_required'};
 for(const id of round.case_ids){const plan=round.case_plans[id];const sut={protocol_version:1,identity:adapterIdentity,async open(){},async advanceTo(){},async observe(){},async observePrivate(){return [];},async configure(){},async withdrawSources(){},async respond(request){return {reply_id:`actual-${variant}-${request.id}`,text:`${variant} observed response to ${request.id}`,suggestions:[],disposition:'discussion'};},async currentOutput(){return null;},async close(){}};
  const run=await runEpisode({plan,adapter:sut,identity});fs.writeFileSync(path.join(directory,`${id}.run.json`),JSON.stringify(run));fs.writeFileSync(path.join(directory,`${id}.review.json`),JSON.stringify(reviewPacket(plan,run,rubric)));manifest.episodes.push({id,status:run.status});}
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'transport.json'),JSON.stringify({http_attempts:http,requests:Array.from({length:http},(_,i)=>({sequence:i+1,status:'unit_fixture_not_real_http'}))}));
}
async function compared(t,options={}){const c=prepare(t);await replayFixture(path.join(c.dir,'baseline'),c.round,'baseline',options.baseline);await replayFixture(path.join(c.dir,'candidate'),c.round,'candidate',options.candidate);attachReplay(c.out,{variant:'baseline',replay:path.join(c.dir,'baseline')});attachReplay(c.out,{variant:'candidate',replay:path.join(c.dir,'candidate')});c.packet=buildPacket(c.out,{out:path.join(c.dir,'packet')});c.bundle=JSON.parse(fs.readFileSync(path.join(c.dir,'packet','bundle.json')));c.mapping=JSON.parse(fs.readFileSync(path.join(c.out,'packet-map.json')));return c;}
function reviewFixture(c,preference='candidate'){
 return {...c.bundle.binding,reviewer_id:'qq_evaluator_functional_fixture_not_live',ratings:c.packet.entries.map(e=>({entry_id:e.id,output_hash:e.output_hash,overall:'usable',hard_failures:[],evidence:[{quote:e.actual.output?.text||'output:null'}]})),comparisons:c.packet.pairs.map(pair=>{const entries=pair.entry_ids.map(id=>c.packet.entries.find(e=>e.id===id)),selected=entries.find(e=>c.mapping.entries[e.id].variant===preference);const hasOutputs=entries.every(e=>e.actual.output);return {case_id:pair.case_id,step_id:pair.step_id,preferred:hasOutputs?selected.system_id:'equivalent',basis:hasOutputs?'wording':'delivery',reason:'Declared functional fixture comparison, not an observed model judgment',evidence:entries.map(e=>({entry_id:e.id,quote:e.actual.output?.text||e.actual.status}))};})};
}
test('blinded packet hides implementation/hypothesis, deduplicates raw context and binds actual outputs',async t=>{
 const c=await compared(t),text=JSON.stringify(c.bundle);assert.equal(text.includes('PRIVATE_HYPOTHESIS_SENTINEL'),false);assert.equal(text.includes(ROOT),false);assert.equal(text.includes('functional-fixture-baseline'),false);assert.ok(c.packet.entries.some(e=>e.actual.feedback_binding?.status==='bound'));assert.equal(c.packet.cases.length,c.round.case_ids.length);assert.ok(c.packet.entries.every(e=>!Object.hasOwn(e,'initial')));
});
test('complete evidence and a real paired verdict are required; better candidate does not complete the Goal',async t=>{
 const c=await compared(t);const review=reviewFixture(c),file=path.join(c.dir,'review.json');fs.writeFileSync(file,JSON.stringify(review));recordReview(c.out,{file});const checked=checkRound(c.out);assert.equal(checked.ready_to_accept,true,checked.reasons.join('\n'));assert.equal(checked.goal_completed,false);assert.equal(checked.stage_completed,false);assert.equal(decideRound(c.out,{decision:'accepted',reason:'Functional acceptance-path fixture only'}).status,'accepted');
});
test('synthetic replay, combined budget overflow and a worse candidate are rejected',async t=>{
 const synthetic=await compared(t,{candidate:{live:false}});const budget=await compared(t,{baseline:{http:20},candidate:{http:20}});const worse=await compared(t);
 for(const c of [synthetic,budget,worse]){const file=path.join(c.dir,'review.json');fs.writeFileSync(file,JSON.stringify(reviewFixture(c,c===worse?'baseline':'candidate')));recordReview(c.out,{file});assert.equal(checkRound(c.out).ready_to_accept,false);}
 assert.ok(checkRound(synthetic.out).reasons.some(x=>x.includes('live-model')));assert.ok(checkRound(budget.out).reasons.some(x=>x.includes('cap exceeded')));assert.ok(checkRound(worse.out).reasons.some(x=>x.includes('non-regression')));
});
test('edited artifacts or false output quotes cannot be accepted as evaluator evidence',async t=>{
 const c=await compared(t),review=reviewFixture(c),file=path.join(c.dir,'review.json');review.ratings[0].evidence=[{quote:'INVENTED_OUTPUT_QUOTE'}];fs.writeFileSync(file,JSON.stringify(review));assert.throws(()=>recordReview(c.out,{file}),/quote is absent|visible-output/);
 fs.writeFileSync(path.join(c.out,'runs','candidate','manifest.json'),'{}');assert.ok(checkRound(c.out).reasons.some(x=>x.includes('evidence changed')));
});
test('claimed plan hashes do not hide changed raw inputs or reordered execution',async t=>{
 for(const mutation of ['initial','order']){
  const c=prepare(t),where=path.join(c.dir,'candidate');await replayFixture(where,c.round,'candidate');const id=c.round.target_cases[0],file=path.join(where,`${id}.run.json`),raw=JSON.parse(fs.readFileSync(file));
  if(mutation==='initial')raw.initial.qq_events[0].text='A different historical observation';else raw.steps.reverse();
  fs.writeFileSync(file,JSON.stringify(raw));const review=JSON.parse(fs.readFileSync(path.join(where,`${id}.review.json`)));review.steps=raw.steps.map(({diagnostics,...s})=>s);fs.writeFileSync(path.join(where,`${id}.review.json`),JSON.stringify(review));
  assert.throws(()=>attachReplay(c.out,{variant:'candidate',replay:where}),mutation==='initial'?/initial context\/goal mismatch/:/step order/);
 }
});
test('old replay cannot be attached after the candidate source changes',async t=>{
 const c=prepare(t),where=path.join(c.dir,'candidate');await replayFixture(where,c.round,'candidate');fs.appendFileSync(path.join(where,'candidate-checkout/src/controller.cjs'),'\n// Changed after execution.\n');assert.throws(()=>attachReplay(c.out,{variant:'candidate',replay:where}),/implementation no longer matches/);
});
test('a usable self-report cannot hide a missing requested output',async t=>{
 const c=prepare(t);for(const variant of ['baseline','candidate'])await replayFixture(path.join(c.dir,variant),c.round,variant);
 const id=c.round.target_cases[0],file=path.join(c.dir,'candidate',`${id}.run.json`),raw=JSON.parse(fs.readFileSync(file));raw.steps.at(-1).output=null;fs.writeFileSync(file,JSON.stringify(raw));const rfile=path.join(c.dir,'candidate',`${id}.review.json`),r=JSON.parse(fs.readFileSync(rfile));r.steps=raw.steps.map(({diagnostics,...s})=>s);fs.writeFileSync(rfile,JSON.stringify(r));
 attachReplay(c.out,{variant:'baseline',replay:path.join(c.dir,'baseline')});attachReplay(c.out,{variant:'candidate',replay:path.join(c.dir,'candidate')});c.packet=buildPacket(c.out,{out:path.join(c.dir,'packet')});c.bundle=JSON.parse(fs.readFileSync(path.join(c.dir,'packet/bundle.json')));c.mapping=JSON.parse(fs.readFileSync(path.join(c.out,'packet-map.json')));const review=path.join(c.dir,'review.json');fs.writeFileSync(review,JSON.stringify(reviewFixture(c)));recordReview(c.out,{file:review});assert.ok(checkRound(c.out).reasons.some(x=>x.includes('requested answer missing')));
});
test('per-round guard subset and equal arm caps are frozen before runs',async t=>{
 const dir=directory(t),out=path.join(dir,'round'),r=prepareRound({root:ROOT,id:'focused',stage:'delivery_provenance',cases:['coverage-observed-output-feedback'],guardrails:['conv-share-own-material-missing'],hypothesis:'A frozen focused experiment',out});assert.deepEqual(r.guardrail_cases,['conv-share-own-material-missing']);assert.equal(r.per_variant_http,16);
});
test('actual reviewer may cite the bound reply ID, but another output ID is rejected',async t=>{
 const c=await compared(t),review=reviewFixture(c),file=path.join(c.dir,'review.json');
 const index=c.packet.entries.findIndex(e=>e.actual.output),entry=c.packet.entries[index];review.ratings[index].evidence=[{source_id:entry.actual.output.reply_id,quote:entry.actual.output.text}];
 fs.writeFileSync(file,JSON.stringify(review));recordReview(c.out,{file});assert.equal(checkRound(c.out).ready_to_accept,true);
 const {validateReview}=require('../scripts/goal-round.cjs');review.ratings[index].evidence[0].source_id='an-unrelated-output';assert.throws(()=>validateReview(c.packet,review),/visible-output/);
});
test('pre-step setup failures remain citable execution evidence for grades and delivery comparisons',async t=>{
 const c=await compared(t),review=reviewFixture(c),entry=c.packet.entries[0];entry.case_execution.error={message:'Prefix preparation rejected authored-note permissions'};
 review.packet_hash=hash(c.packet);review.ratings[0].evidence=[{quote:entry.case_execution.error.message}];review.ratings[0].overall='insufficient_evidence';
 const pair=review.comparisons.find(p=>p.case_id===entry.case_id&&p.step_id===entry.step_id);pair.basis='delivery';pair.evidence=[{entry_id:entry.id,quote:entry.case_execution.error.message}];
 const {validateReview}=require('../scripts/goal-round.cjs');assert.doesNotThrow(()=>validateReview(c.packet,review));
});

test('cross-stage countercases can be frozen without turning them into stage targets', t=>{
 const dir=directory(t),out=path.join(dir,'round');
 const r=prepareRound({root:ROOT,id:'cross-stage',stage:'delivery_provenance',cases:['coverage-observed-output-feedback'],guardrails:['conv-share-own-material'],hypothesis:'Changing material selection also affects its positive counterpart',out});
 assert.deepEqual(r.target_cases,['coverage-observed-output-feedback']);
 assert.deepEqual(r.guardrail_cases,['conv-share-own-material']);
 assert.ok(r.case_plans['conv-share-own-material']);
 assert.throws(()=>prepareRound({root:ROOT,id:'unknown',stage:'delivery_provenance',cases:['coverage-observed-output-feedback'],guardrails:['not-a-real-case'],hypothesis:'Invalid countercase',out:path.join(dir,'bad')}),/guardrail|frozen case/i);
 assert.equal(fs.existsSync(path.join(dir,'bad')),false);
});
