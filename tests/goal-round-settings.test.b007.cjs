'use strict';
// These are protocol/accounting fixtures, never independent semantic grades.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const goal=require('../scripts/goal-round.cjs'),settings=require('../scripts/goal-round-settings.cjs');
const stream=require('../scripts/eval-stream-replay.cjs'),component=require('../scripts/eval-memory-decisions.cjs');
const {projectPublicMemory,compileUiRenderContract,readUiRenderContract}=require('../scripts/goal-round-public-view.cjs');
const ROOT=path.resolve(__dirname,'..'),read=file=>JSON.parse(fs.readFileSync(file)),write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
function context(t,setting='component',{assessment=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-primary-round-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const goalDir=path.join(dir,'goal'),datasetFile=path.join(dir,'cases.jsonl');fs.mkdirSync(goalDir);
 let cases=setting==='stream'?stream.loadStreamCases().cases.slice(0,2):component.loadCases().cases.slice(0,2);cases=structuredClone(cases);
 if(setting==='component'){cases[0].reviewer_only.notes.push('PROVISIONAL_REFERENCE_SENTINEL');cases[0].source_seed.transformations.push('SOURCE_SEED_SENTINEL');}
 fs.writeFileSync(datasetFile,cases.map(item=>JSON.stringify(item)).join('\n')+'\n');
 write(path.join(goalDir,'goal.json'),{schema_version:1,id:'new-primary-test',version:'test-v1',baseline:{commit:'196cca3'},execution:{artifacts_root:'.goal-runs',max_http_per_round:null,unlimited_http_authorized:true},stages:[{id:'new',dataset_setting:setting,dataset_file:datasetFile,target_cases:cases.map(item=>item.id),guardrail_cases:[cases[0].id]}]});
 fs.copyFileSync(path.join(ROOT,'goals/assistant-improvement/roles.json'),path.join(goalDir,'roles.json'));
 const adapter=path.join(dir,'adapter.cjs');fs.writeFileSync(adapter,"exports.implementationIdentity=()=>({hash:'functional-product-v1',revision:'196cca3',scope:'Protocol fixture; no provider call'});\n");
 const out=path.join(dir,'round'),round=goal.prepareRound({root:ROOT,goalDir,id:'new-primary',stage:'new',hypothesis:'PRIVATE_IMPLEMENTATION_HYPOTHESIS',assessment,unlimitedHttp:true,adapter,out});
 return {dir,goalDir,datasetFile,cases,adapter,out,round,setting};
}
async function replay(c,variant,{live=true,incomplete=false,different=false}={}){
 const folder=path.join(c.dir,variant),adapterFile=different?path.join(c.dir,'candidate-adapter.cjs'):c.adapter;
 if(different)fs.writeFileSync(adapterFile,"exports.implementationIdentity=()=>({hash:'functional-product-v2',scope:'Changed protocol fixture'});\n");
 fs.mkdirSync(folder);const adapterHash=settings.hash(fs.readFileSync(adapterFile));
 const identity={dataset_hash:c.round.dataset_hash,adapter_hash:adapterHash,...(c.setting==='component'?{contract_hash:c.round.contract.semantic_contract_hash}:{}),unlimited_http:true};
 const adapterIdentity=c.setting==='component'?{mode:live?'live':'synthetic',model:'functional-model',provider:'http://fixture.invalid',implementation_hash:adapterHash,http_cap:null,unlimited_http:true,settings_hash:'unit-settings'}:
  {evidence:live?'live_model_protocol_fixture':'synthetic_transport_protocol_fixture',model:'functional-model',destination:{origin:'http://fixture.invalid',path:'/v1'},settings_hash:'unit-settings',implementation_hash:different?'functional-product-v2':'functional-product-v1',source_root:ROOT,max_http:null,unlimited_http:true,prefix_preparation:'scheduled_only_no_forced_prefix'};
 const requests=[];
 for(const item of c.cases){let result;
  if(c.setting==='component'){
   const adapter={identity:adapterIdentity,async decide(input){requests.push({request:{messages:[{role:'user',content:JSON.stringify(input)}]},response:'Fixture transport result'});if(incomplete)throw Object.assign(Error('Fixture provider failed'),{code:'provider_fixture_error'});return {axes:{same_subject:'uncertain',time_scope:'unknown',relationships:['uncertain'],evidence_sufficiency:'insufficient'},evidence_ids:['s1'],reason:different?'Changed actual protocol fixture decision.':'Actual protocol fixture decision.'};}};
   result=await component.runCase({item,adapter,identity});
  }else{
   let counter=0;const adapter={protocol_version:1,identity:adapterIdentity,async open(initial){assert.deepEqual(initial.qq_events,[]);},async advanceTo(){},async observe(){},async observePrivate(){return [];},async withdrawSources(){},async configure(){},async idleUntil(at){return {status:'incomplete',reason:'pending_source_review',as_of:at};},async publicMemoryView(){return {relationship:{contact:[{text:'VISIBLE_PERSON_TEXT',assertionKind:'stated',sourceIds:[]}]},companion:{goal:{text:'Visible goal'},notes:[]},memory_status:{pending:1}};},async diagnostics(){return {HIDDEN_TRACE_SENTINEL:'HIDDEN_TRACE_SENTINEL'};},async drainOutputs(){return [];},async respond(request){requests.push({request:{messages:[{role:'user',content:request.text}]},response:'Fixture answer'});if(incomplete)throw Object.assign(Error('Actual fixture failure'),{code:'provider_fixture_error'});return {reply_id:'reply-'+(++counter),text:(different?'Changed ':'')+'Actual answer for '+request.id,suggestions:[],disposition:'discussion'};},async close(){}};
   result=await stream.runStreamEpisode({item,adapter,identity});
  }
  write(path.join(folder,item.id+'.run.json'),result);write(path.join(folder,item.id+'.review.json'),{review:{status:'not_run'}});
 }
 write(path.join(folder,'manifest.json'),{identity,adapter:adapterIdentity,selected_cases:c.cases.map(item=>item.id),status:incomplete?'incomplete':'executed_review_required'});
 write(path.join(folder,c.setting==='stream'?'transport.json':'adapter-summary.json'),{http_attempts:requests.length,requests});
 return {folder,adapterFile};
}
function reviewFixture(c,packet){
 const bundle=read(path.join(c.out,'review-packet/bundle.json')),map=read(path.join(c.out,'packet-map.json')),review=structuredClone(bundle.review_template);review.reviewer_id='FUNCTIONAL_REVIEW_FIXTURE_NOT_A_REAL_QUALITY_REVIEW';
 for(const rating of review.ratings){const entry=packet.entries.find(item=>item.id===rating.entry_id);rating.overall='usable';rating.evidence=[{location:'output',quote:c.setting==='component'?entry.actual.output.reason:entry.actual.events.find(event=>event.output).output.text}];
  if(c.setting==='component')for(const axis of Object.keys(rating.axis_ratings))rating.axis_ratings[axis]='supported';
  else for(const step of rating.step_ratings){step.overall='usable';step.evidence=[{location:'output',quote:entry.actual.events.find(event=>event.id===step.event_id).output.text}];}
 }
 for(const comparison of review.comparisons){comparison.preferred=Object.keys(map.systems).find(id=>map.systems[id]==='candidate');comparison.basis='quality';comparison.reason='Functional comparison fixture, not a real preference.';const entry=packet.entries.find(item=>item.case_id===comparison.case_id&&map.systems[item.system_id]==='candidate');comparison.evidence=[{entry_id:entry.id,quote:c.setting==='component'?entry.actual.output.reason:entry.actual.events.find(event=>event.output).output.text}];}
 return review;
}

test('new-primary prepare preserves legacy Goal and freezes complete families, common contract and authorized unlimited mode',t=>{
 const original=settings.hash(fs.readFileSync(path.join(ROOT,'goals/assistant-improvement/goal.json'))),c=context(t);
 assert.equal(c.round.dataset_setting,'component');assert.equal(c.round.mode,'assessment');assert.equal(c.round.max_http,null);assert.equal(c.round.unlimited_http,true);assert.equal(c.round.case_ids.length,2);assert.ok(c.round.contract.semantic_contract_hash);
 assert.equal(settings.hash(fs.readFileSync(path.join(ROOT,'goals/assistant-improvement/goal.json'))),original);
 assert.throws(()=>goal.prepareRound({root:ROOT,goalDir:c.goalDir,id:'partial',stage:'new',cases:[c.cases[0].id],guardrails:[c.cases[0].id],hypothesis:'Missing paired case',out:path.join(c.dir,'partial')}),/complete contrast family/);
});
test('actual component native artifacts attach and blind packets omit reference labels, paths and implementation hypotheses',async t=>{
 const c=context(t),r=await replay(c,'baseline');goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile});const p=goal.buildPacket(c.out,{}),text=JSON.stringify(p);
 assert.equal(p.entries.length,2);assert.equal(p.pairs.length,0);assert.ok(p.semantic_contract.evidence_sufficiency);assert.equal(p.cases[0].input.response_contract,undefined);
 for(const secret of ['PROVISIONAL_REFERENCE_SENTINEL','SOURCE_SEED_SENTINEL','PRIVATE_IMPLEMENTATION_HYPOTHESIS',c.dir])assert.equal(text.includes(secret),false);
 assert.equal(p.cases[0].input.shared_context_ref,'shared_input_context');assert.equal(p.shared_input_context.response_contract_ref,'semantic_contract');
 const review=reviewFixture(c,p),file=path.join(c.dir,'review.json');write(file,review);goal.recordReview(c.out,{file});assert.equal(goal.checkRound(c.out).ready_to_accept,true);
});
test('synthetic evidence remains unaccepted despite a protocol-valid review',async t=>{
 const c=context(t),r=await replay(c,'baseline',{live:false});goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile});const p=goal.buildPacket(c.out,{}),review=reviewFixture(c,p),file=path.join(c.dir,'review.json');write(file,review);goal.recordReview(c.out,{file});assert.ok(goal.checkRound(c.out).reasons.some(reason=>reason.includes('live-model')));
 assert.throws(()=>goal.decideRound(c.out,{decision:'accepted',reason:'A fixture cannot establish real quality'}),/not ready/);
});
test('incomplete component decisions preserve null output and cannot become accepted quality',async t=>{
 const c=context(t),r=await replay(c,'baseline',{incomplete:true});goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile});const p=goal.buildPacket(c.out,{}),bundle=read(path.join(c.out,'review-packet/bundle.json')),review=structuredClone(bundle.review_template);review.reviewer_id='FUNCTIONAL_ABSENCE_REVIEW_NOT_QUALITY';
 for(const rating of review.ratings){rating.overall='insufficient_evidence';for(const axis of Object.keys(rating.axis_ratings))rating.axis_ratings[axis]='insufficient_evidence';rating.evidence=[{location:'execution',quote:'output:null'}];}
 const file=path.join(c.dir,'review.json');write(file,review);goal.recordReview(c.out,{file});const checked=goal.checkRound(c.out);assert.equal(checked.ready_to_accept,false);assert.ok(p.entries.every(entry=>entry.actual.output===null));assert.ok(checked.reasons.some(reason=>reason.includes('did not complete')));
});
test('claimed hashes cannot hide changed controlled input, stream event time or missing completed events',async t=>{
 for(const setting of ['component','stream']){
  const c=context(t,setting),r=await replay(c,'baseline'),file=path.join(r.folder,c.cases[0].id+'.run.json'),run=read(file);
  if(setting==='component')run.input.new_evidence[0].text='Different original observation';else run.events[0].at=c.cases[0].start_at;
  write(file,run);assert.throws(()=>goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile}),/input|order|time/i);
 }
 const c=context(t,'stream'),r=await replay(c,'baseline'),file=path.join(r.folder,c.cases[0].id+'.run.json'),run=read(file);run.events.pop();write(file,run);assert.throws(()=>goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile}),/complete stream/);
});
test('stream blind packet keeps every request and UI semantic text while excluding hidden provenance',async t=>{
 const c=context(t,'stream'),r=await replay(c,'baseline');goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile});const p=goal.buildPacket(c.out,{}),bundle=read(path.join(c.out,'review-packet/bundle.json'));
 assert.equal(p.entries[0].actual.events.length,c.cases[0].events.length);assert.ok(p.entries[0].actual.events.some(event=>event.public_memory_ref));assert.equal(JSON.stringify(p).includes('VISIBLE_PERSON_TEXT'),true);assert.equal(JSON.stringify(p).includes('HIDDEN_TRACE_SENTINEL'),false);
 assert.equal(bundle.review_template.ratings[0].step_ratings.length,2);
 const review=reviewFixture(c,p);assert.doesNotThrow(()=>goal.validateReview(p,review));review.ratings[0].step_ratings.pop();assert.throws(()=>goal.validateReview(p,review),/Every stream user request/);
});
test('stream step evidence rejects future input and current-output absence invented over a completed answer',async t=>{
 const c=context(t,'stream'),r=await replay(c,'baseline');goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile});const p=goal.buildPacket(c.out,{}),review=reviewFixture(c,p),first=review.ratings[0].step_ratings[0];
 first.evidence.push({location:'input',quote:c.cases[0].events.find(event=>event.id==='run-new').text});assert.throws(()=>goal.validateReview(p,review),/future event/);first.evidence.pop();first.evidence=[{location:'execution',quote:'output:null'}];assert.throws(()=>goal.validateReview(p,review),/current output/);
});
test('counterpart comparison requires actual supported axes and preserved evidence after binding',async t=>{
 const c=context(t,'component',{assessment:false});for(const variant of ['baseline','candidate']){const r=await replay(c,variant,{different:variant==='candidate'});goal.attachReplay(c.out,{variant,replay:r.folder,adapter:r.adapterFile});}
 const p=goal.buildPacket(c.out,{}),review=reviewFixture(c,p),file=path.join(c.dir,'review.json');write(file,review);goal.recordReview(c.out,{file});assert.equal(goal.checkRound(c.out).ready_to_accept,true);
 const raw=read(path.join(c.out,'review.json'));raw.ratings[0].overall='rewrite';write(path.join(c.out,'review.json'),raw);assert.ok(goal.checkRound(c.out).reasons.some(reason=>reason.includes('Original primary review changed')));
});
test('UI semantic projection preserves consumed claim/note/source/time fields and removes hidden record history',()=>{
 const state={messages:[{messageId:'1',direction:'incoming',text:'Original contact statement.'}],companion:{turns:[],notes:[]}};
 const view={relationship:{understanding:{contact:{knownFacts:[{id:'hidden-record',version:9,text:'VISIBLE_FACT',assertionKind:'stated',condition:'VISIBLE_CONDITION',sourceIds:['qq:1'],sourceRevisions:{'qq:1':'HIDDEN_REVISION'},revisions:[{text:'HIDDEN_OLD_FACT'}]}]}}},companion:{notes:[{id:'hidden-note',version:4,text:'VISIBLE_NOTE',kind:'material',use:'draft'}]},memory_status:{pending:1,semanticPending:2,lastReview:{raw:'HIDDEN_RECEIPT'}}};
 const projected=projectPublicMemory(view,state),text=JSON.stringify(projected);for(const visible of ['VISIBLE_FACT','VISIBLE_CONDITION','VISIBLE_NOTE','Original contact statement.','明确说过'])assert.ok(text.includes(visible));for(const hidden of ['hidden-record','HIDDEN_REVISION','HIDDEN_OLD_FACT','HIDDEN_RECEIPT'])assert.equal(text.includes(hidden),false);assert.equal(projected.memory_status.semantic_pending,2);
});

test('actual candidate UI consumer adds its displayed headings, applicability line and evidence clocks without changing claims',()=>{
 const candidate=compileUiRenderContract(fs.readFileSync(path.join(ROOT,'tests/fixtures/reported-understanding-ui-renderer.js'),'utf8')),baseline=readUiRenderContract({sourceRoot:ROOT}).contract;
 const claim={text:'ORIGINAL_REPORTED_TEXT',assertionKind:'reported',applicability:'unspecified',firstEvidenceAt:'2026-09-01T18:30:00+08:00',lastEvidenceAt:'2026-09-21T18:30:00+08:00',sourceIds:[]},view={relationship:{understanding:{contact:{recentCircumstances:[claim],uncertainties:[{...claim,text:'ORIGINAL_UNCERTAIN_TEXT'}]}}},companion:{notes:[]}};
 const original=structuredClone(view),old=projectPublicMemory(view,{},baseline),next=projectPublicMemory(view,{},candidate),oldCard=old.persons.contact.recentCircumstances[0],newCard=next.persons.contact.recentCircumstances[0];
 assert.equal(old.person_group_headings.contact.recentCircumstances,'近期处境');assert.equal(next.person_group_headings.contact.recentCircumstances,'近期处境／有据报告');assert.equal(next.person_group_headings.contact.uncertainties,'仍待核对的理解或适用情况');
 assert.equal(oldCard.applicability_text,undefined);assert.equal(oldCard.firstEvidenceAt,undefined);assert.equal(newCard.applicability_text,'适用情况：适用期限未确认，不代表当前仍适用');assert.equal(newCard.firstEvidenceAt,claim.firstEvidenceAt);assert.equal(newCard.lastEvidenceAt,claim.lastEvidenceAt);assert.ok(newCard.evidence_date_text.includes('原始依据：'));assert.ok(newCard.evidence_date_text.includes('最近依据：'));
 assert.equal(newCard.text,oldCard.text);assert.equal(newCard.text,claim.text);assert.deepEqual(view,original,'observer never reclassifies or edits model content');
});

test('evidence-date projection follows actual UI validity and display-distinctness conditions',()=>{
 const contract=compileUiRenderContract(fs.readFileSync(path.join(ROOT,'tests/fixtures/reported-understanding-ui-renderer.js'),'utf8'));
 const render=claim=>projectPublicMemory({relationship:{contact:[{text:'Unchanged original.',sourceIds:[],...claim}]},companion:{}},{},contract).persons.contact.legacy[0];
 const same=render({firstEvidenceAt:'2026-09-01T18:30:00+08:00',lastEvidenceAt:'2026-09-01T10:30:00Z'});assert.ok(same.firstEvidenceAt);assert.equal(same.lastEvidenceAt,undefined);assert.equal(same.evidence_date_text.includes('最近依据：'),false);
 const invalid=render({firstEvidenceAt:'not-a-date',lastEvidenceAt:'2026-09-21T18:30:00+08:00'});assert.equal(invalid.firstEvidenceAt,undefined);assert.ok(invalid.lastEvidenceAt);assert.equal(invalid.evidence_date_text.includes('原始依据：'),false);
 const none=render({firstEvidenceAt:'bad',lastEvidenceAt:null});assert.equal(none.evidence_date_text,undefined);
});

test('unsupported source consumers fail explicitly instead of inventing visible date or applicability fields',()=>{
 const source=fs.readFileSync(path.join(ROOT,'tests/fixtures/reported-understanding-ui-renderer.js'),'utf8');
 assert.throws(()=>compileUiRenderContract(source.replace('const first=evidenceDate(claim.firstEvidenceAt)','const first=evidenceDate(claim.reviewedAt)')),/evidence-date consumer/);
 assert.throws(()=>compileUiRenderContract(source.replace('适用情况：${applicability}','A different unhandled consumer')),/applicability consumer/);
});

test('new stream packets freeze actual UI bytes outside blind packets and survive later origin removal',async t=>{
 const c=context(t,'stream'),r=await replay(c,'baseline'),uiRoot=path.join(c.dir,'actual-ui-source');fs.mkdirSync(path.join(uiRoot,'ui'),{recursive:true});fs.copyFileSync(path.join(ROOT,'tests/fixtures/reported-understanding-ui-renderer.js'),path.join(uiRoot,'ui/app.js'));
 const manifest=read(path.join(r.folder,'manifest.json'));manifest.adapter.source_root=uiRoot;write(path.join(r.folder,'manifest.json'),manifest);
 for(const item of c.cases){const file=path.join(r.folder,item.id+'.run.json'),run=read(file);run.adapter_identity=manifest.adapter;write(file,run);}
 goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile});const packet=goal.buildPacket(c.out,{}),round=read(path.join(c.out,'round.json')),receipt=round.projection_sources.baseline;
 assert.equal(receipt.fallback_used,false);assert.equal(settings.hash(fs.readFileSync(receipt.frozen_file)),receipt.sha256);assert.equal(fs.readFileSync(receipt.frozen_file,'utf8'),fs.readFileSync(path.join(uiRoot,'ui/app.js'),'utf8'));assert.equal(JSON.stringify(packet).includes(uiRoot),false);assert.equal(JSON.stringify(packet).includes(receipt.sha256),false);
 fs.unlinkSync(path.join(uiRoot,'ui/app.js'));assert.equal(goal.checkRound(c.out).reasons.some(reason=>reason.includes('UI projection source')),false,'checks use frozen UI copy, never the mutable origin');
 fs.appendFileSync(receipt.frozen_file,'\n// Changed historical engineering evidence.\n');assert.ok(goal.checkRound(c.out).reasons.some(reason=>reason.includes('frozen UI projection source changed')));
});

test('baseline missing-UI fallback is declared and checked against its frozen product revision',async t=>{
 const c=context(t,'stream'),r=await replay(c,'baseline'),emptyRoot=path.join(c.dir,'backend-only');fs.mkdirSync(emptyRoot);
 const manifest=read(path.join(r.folder,'manifest.json'));manifest.adapter.source_root=emptyRoot;write(path.join(r.folder,'manifest.json'),manifest);
 for(const item of c.cases){const file=path.join(r.folder,item.id+'.run.json'),run=read(file);run.adapter_identity=manifest.adapter;write(file,run);}
 goal.attachReplay(c.out,{variant:'baseline',replay:r.folder,adapter:r.adapterFile});goal.buildPacket(c.out,{});const receipt=read(path.join(c.out,'round.json')).projection_sources.baseline;
 assert.equal(receipt.fallback_used,true);assert.equal(receipt.origin_path,path.join(ROOT,'ui/app.js'));assert.equal(receipt.baseline_reference.verified_against_declared_baseline,true);assert.ok(fs.existsSync(receipt.frozen_file));
});
