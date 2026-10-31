'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const vm=require('node:vm');
const {runtimeCase,loadMemoryCases,validateMemoryCase,runMemoryEpisode,main}=require('../scripts/eval-memory-understanding.cjs');
const {projectPublicMemory}=require('../scripts/eval-runtime-session.cjs');
function sample(){return {schema_version:1,policy_version:'raw-memory-observation-v1',id:'observer-contract',runtime_goal:'理解实际原始近况。',
 initial:{as_of:'2026-10-01T12:00:00Z',qq_events:[{id:'qq-original',at:'2026-10-01T11:59:00Z',speaker:'contact',text:'原始近况。',provenance:'authored_external_qq'}],private_events:[]},
 steps:[{id:'s1',as_of:'2026-10-01T12:01:00Z',qq_events:[],private_events:[],source_updates:[],request:{id:'user-question',at:'2026-10-01T12:01:00Z',text:'现在有什么有依据的认识？'},external_observation:{user_quiet_ms:10000,wall_timeout_ms:1000,before_request:['visible_memory'],after_request:['assistant_answer','visible_memory_after_idle']}}],
 reviewer_only:{expected_profile:'REVIEWER_ONLY_PROFILE_SECRET',criteria:['REVIEWER_ONLY_CRITERIA_SECRET']}};}
function adapterFixture({failAfterRequest=false,pendingBeforeRequest=false}={}){
 let at,answered=false,closed=false;const received=[];
 return {received,identity:{condition:'scheduled_idle_public_memory_observation_v1'},
  async open(initial,options){received.push({initial,options});at=initial.as_of;},
  async advanceTo(value){received.push({advance:value});at=value;},
  async idleUntil(value,options){received.push({idle:value,options});at=value;const incomplete=answered?failAfterRequest:pendingBeforeRequest;return {status:incomplete?'incomplete':'complete',reason:incomplete?'native_deadline':null,as_of:at,pending_tasks:incomplete?[{owner:'background_memory'}]:[]};},
  async observe(events){received.push({events});},async observePrivate(events){received.push({private:events});return [];},async withdrawSources(events){received.push({updates:events});},
  async respond(request){received.push({request});answered=true;return {reply_id:'actual-reply',text:'ACTUAL_ANSWER',suggestions:[],disposition:'discussion'};},
  async publicMemoryView(){return {as_of:at,relationship:{contact:[{id:answered?'actual-after':'actual-before',text:'ACTUAL_PUBLIC_VIEW'}]},memory_status:{pending:answered?1:0}};},
  async diagnostics(){return {unfinished:failAfterRequest,received:structuredClone(received)};},async drainOutputs(){return [];},async close(){closed=true;},get closed(){return closed;}};
}
test('supplemental runner preserves authored request time, actual views and response without reviewer leakage',async()=>{
 const item=sample(),adapter=adapterFixture(),records=[];
 const result=await runMemoryEpisode({item,adapter,onRecord:value=>records.push(value)});
 assert.equal(result.status,'executed_review_required');assert.equal(result.semantic_evaluation,'not_run');assert.equal(result.steps[0].output.text,'ACTUAL_ANSWER');
 assert.equal(result.foreground_wall_timeout_ms,300000);assert.equal(result.identity.foreground_wall_timeout_ms,300000);assert.equal(result.steps[0].request_receipt.wall_timeout_ms,300000);assert.equal(result.steps[0].request_receipt.status,'completed');assert.ok(Number.isFinite(result.steps[0].request_receipt.wall_elapsed_ms));
 assert.deepEqual(result.steps[0].memory_observations.map(o=>[o.phase,o.view.as_of]),[
  ['before_user_idle','2026-10-01T12:00:50.000Z'],['before_request','2026-10-01T12:01:00Z'],['after_request','2026-10-01T12:01:00Z'],['after_request_idle','2026-10-01T12:01:10.000Z']]);
 assert.equal(result.steps[0].memory_observations[1].view.relationship.contact[0].id,'actual-before');assert.equal(result.steps[0].memory_observations[3].view.relationship.contact[0].id,'actual-after');
 assert.deepEqual(adapter.received.find(row=>row.request).request,item.steps[0].request);
 assert.ok(!JSON.stringify(adapter.received).includes('REVIEWER_ONLY'));assert.ok(!JSON.stringify(result).includes('REVIEWER_ONLY'));
 assert.ok(records.some(value=>value.steps[0]?.status==='running'));assert.equal(adapter.closed,true);
});
test('pending idle deadlines still save actual public views and deliver the fixed foreground question',async()=>{
 const adapter=adapterFixture({failAfterRequest:true,pendingBeforeRequest:true}),result=await runMemoryEpisode({item:sample(),adapter});
 assert.equal(result.status,'executed_review_required');assert.equal(result.memory_observation_status,'incomplete');assert.equal(result.steps[0].status,'executed_review_required');
 assert.equal(result.steps[0].output.text,'ACTUAL_ANSWER');assert.equal(result.steps[0].memory_observations.length,4);
 assert.equal(result.steps[0].memory_observations[1].checkpoint.reason,'native_deadline');assert.equal(result.steps[0].memory_observations[3].checkpoint.status,'incomplete');
 assert.deepEqual(adapter.received.find(row=>row.request).request,sample().steps[0].request);assert.equal(adapter.closed,true);
});
test('source updates and declared raw chronology are forwarded without expected-profile reconstruction',async()=>{
 const item=sample();item.steps[0].source_updates=[{id:'qq-original',at:'2026-10-01T12:00:20Z',channel:'qq',operation:'recall'}];
 const adapter=adapterFixture(),result=await runMemoryEpisode({item,adapter});assert.equal(result.status,'executed_review_required');
 assert.deepEqual(adapter.received.find(row=>row.updates).updates,item.steps[0].source_updates);
 assert.throws(()=>validateMemoryCase({...item,steps:[{...item.steps[0],as_of:'2026-10-01T12:00:25Z',request:{...item.steps[0].request,at:'2026-10-01T12:00:25Z'}}]}),/quiet interval/);
 const wire=runtimeCase(item);assert.equal(wire.reviewer_only,undefined);assert.equal(wire.steps[0].reviewer_only,undefined);
});
test('frozen supplemental inventory is read only and remains four cases/eight observations',()=>{
 const dataset=loadMemoryCases();assert.equal(dataset.cases.length,4);assert.equal(dataset.cases.reduce((n,c)=>n+c.steps.length,0),8);
 assert.equal(dataset.datasetHash,'558be21ed1021bce08c96d061c50d2c865f40027edc6d1eff4272278eb37a5c7');
});
test('all eight frozen questions and withdrawal clocks reach the adapter while all reviewer fields stay outside it',async()=>{
 const dataset=loadMemoryCases(),questions=[];
 for(const item of dataset.cases){const adapter=adapterFixture(),result=await runMemoryEpisode({item,adapter});assert.equal(result.status,'executed_review_required');
  const actual=adapter.received.filter(row=>row.request).map(row=>row.request);assert.deepEqual(actual,item.steps.map(step=>step.request));questions.push(...actual);
  assert.ok(!JSON.stringify(adapter.received).includes('reviewer_only'));assert.ok(!JSON.stringify(adapter.received).includes('memory_should'));
  for(const step of item.steps)for(const update of step.source_updates){const position=adapter.received.findIndex(row=>row.updates?.some(value=>value.id===update.id));assert.ok(position>0);assert.equal(adapter.received[position-1].advance,update.at);}
 }
 assert.equal(questions.length,8);
});
test('public capture includes all background panel inputs while excluding hidden old relationship and closed state facts',()=>{
 const state={scope:{peerUid:'fictional'},relationship:{claims:[{text:'HIDDEN_LEGACY'}],self:[{text:'VISIBLE_BASELINE'}],contact:[{text:'HIDDEN_FLAT'}],
  understanding:{version:2,contact:{knownFacts:[{id:'real',text:'VISIBLE_NEW'}],recentCircumstances:[],uncertainties:[],boundaries:[]}}},
  companion:{goal:{text:'ACTUAL_GOAL'},state:{focus:'ACTUAL_FOCUS',items:[{text:'ACTUAL_ITEM'}],openThreads:[{text:'OPEN_TOPIC',status:'open'},{text:'CLOSED_HIDDEN',status:'closed'}],unknowns:['ACTUAL_UNKNOWN']},
   notes:[{id:'pref',kind:'preference',text:'ACTUAL_PREFERENCE',use:'discussion'},{id:'disabled',text:'ACTUAL_DISABLED_NOTE',use:'disabled'}],pendingActions:[{preview:'ACTUAL_PENDING'}],actionReceipts:[{text:'ACTUAL_RECEIPT'}]},
  experience:{cases:[{actualActions:[{text:'ACTUAL_EVENT'}]}],adaptations:[{text:'ACTUAL_GUIDANCE'}]}};
 const capture=projectPublicMemory(state),wire=JSON.stringify(capture);
 for(const value of ['VISIBLE_BASELINE','VISIBLE_NEW','ACTUAL_GOAL','ACTUAL_FOCUS','ACTUAL_ITEM','OPEN_TOPIC','ACTUAL_UNKNOWN','ACTUAL_PREFERENCE','ACTUAL_DISABLED_NOTE','ACTUAL_PENDING','ACTUAL_RECEIPT','ACTUAL_EVENT','ACTUAL_GUIDANCE'])assert.ok(wire.includes(value),value);
 for(const value of ['HIDDEN_LEGACY','HIDDEN_FLAT','CLOSED_HIDDEN'])assert.ok(!wire.includes(value),value);
 assert.equal(capture.relationship.branch_by_subject.self,'legacy_flat');assert.equal(capture.relationship.branch_by_subject.contact,'person_understanding');assert.deepEqual(capture.companion.preference_note_ids,['pref']);
 assert.equal(capture.source_identities,undefined);assert.equal(capture.capture_scope,'public_read_model_ui_selected_branch_not_rendered_dom');
});
test('supplemental CLI separates reviewer artifact and identifies the scheduled-idle condition',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'qq-memory-observer-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const cases=path.join(directory,'cases.jsonl'),adapterFile=path.join(directory,'adapter.cjs'),output=path.join(directory,'run');fs.writeFileSync(cases,JSON.stringify(sample())+'\n');
 fs.writeFileSync(adapterFile,`const fs=require('node:fs');module.exports.createAdapterFactory=options=>{fs.writeFileSync(${JSON.stringify(path.join(directory,'options.json'))},JSON.stringify(options));return {identity:{condition:'scheduled_idle_public_memory_observation_v1',foreground_wall_timeout_ms:300000,max_http:16},summary:()=>({http_attempts:0,requests:[]}),create:()=>{let at;return {open:async p=>{at=p.as_of},advanceTo:async p=>{at=p},idleUntil:async p=>{at=p;return {status:'complete'}},observe:async()=>{},observePrivate:async()=>[],withdrawSources:async()=>{},respond:async()=>({text:'ACTUAL_CLI_OUTPUT',suggestions:[],disposition:'discussion'}),publicMemoryView:async()=>({as_of:at,relationship:{contact:[]}}),close:async()=>{}}}}};`);
 t.mock.method(console,'log',()=>{});await main(['--cases',cases,'--adapter',adapterFile,'--id','observer-contract','--out',output]);
 const opts=JSON.parse(fs.readFileSync(path.join(directory,'options.json')));assert.equal(opts.condition,'scheduled_idle_public_memory_observation_v1');assert.equal(opts.live,false);assert.equal(opts.prefixPreparation,undefined);
 const run=fs.readFileSync(path.join(output,'observer-contract.run.json'),'utf8'),review=JSON.parse(fs.readFileSync(path.join(output,'observer-contract.review.json')));
 assert.ok(!run.includes('REVIEWER_ONLY'));assert.equal(review.reviewer_only.expected_profile,'REVIEWER_ONLY_PROFILE_SECRET');assert.equal(review.review.status,'not_run');
 assert.equal(JSON.parse(fs.readFileSync(path.join(output,'manifest.json'))).status,'executed_review_required');
 const manifest=JSON.parse(fs.readFileSync(path.join(output,'manifest.json')));assert.equal(manifest.identity.foreground_wall_timeout_ms,300000);assert.equal(manifest.adapter.foreground_wall_timeout_ms,300000);
});
test('actual UI consumer renders grouped read projection, preserves exact correction identity and baseline fallback',()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.open=false;this.textContent='';}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}querySelectorAll(){return flatten(this).filter(e=>e.tag==='details'&&e.dataset.subject&&e.open);}}
 const flatten=root=>[root,...root.children.flatMap(child=>flatten(child))],root=new Element('section'),actions=[],discussion=[];
 const groups=()=>({knownFacts:[],recentCircumstances:[],uncertainties:[],boundaries:[]});
 const understanding={version:'v1',self:groups(),contact:groups(),dyad:groups()};
 understanding.self.knownFacts=[{id:'claim-self',version:3,text:'REAL_SELF_FACT',assertionKind:'reported',sourceIds:['private:source-a']}];
 understanding.contact.recentCircumstances=[{id:'claim-recent',version:1,text:'REAL_RECENT',sourceIds:['qq:12345678901234567890']}];
 understanding.contact.boundaries=[{id:'claim-condition',version:2,text:'REAL_CONDITIONAL',condition:'ORIGINAL_CONDITION',sourceIds:['qq:12345678901234567890']}];
 understanding.dyad.uncertainties=[{id:'claim-uncertain',version:1,text:'REAL_UNCERTAIN',semanticReview:{status:'legacy_unreviewed'},sourceIds:['private:old']}];
 const original={relationship:{understanding,self:[{id:'flat-old',text:'STALE_FLAT_COPY'}]}},selected=projectPublicMemory(original);
 assert.ok(!JSON.stringify(selected).includes('STALE_FLAT_COPY'));
 const context={state:{relationship:selected.relationship},scopeKey:'current',historyEpoch:1,relationshipViewKey:null,
  $:()=>root,document:{createElement:tag=>new Element(tag),createDocumentFragment:()=>new Element('fragment')},sourceDescription:id=>`ORIGINAL_SOURCE:${id}`,
  paragraph:(text,className)=>Object.assign(new Element('p'),{textContent:text,className}),button:(text,action)=>Object.assign(new Element('button'),{textContent:text,action}),
  experienceAction:(route,args)=>actions.push({route,args}),attachDiscussionContext:text=>discussion.push(text)};
 vm.createContext(context);const app=fs.readFileSync(path.resolve(__dirname,'../ui/app.js'),'utf8'),start=app.indexOf('function renderRelationship(){'),end=app.indexOf('\nfunction openExperienceReview',start);
 vm.runInContext(app.slice(start,end),context);context.renderRelationship();
 const all=()=>flatten(root),text=()=>all().map(e=>e.textContent).join('\n');
 for(const expected of ['已核对的认识','近期处境','仍不确定','条件与边界','REAL_SELF_FACT','REAL_RECENT','REAL_UNCERTAIN','ORIGINAL_CONDITION','旧记录，尚待原文核查','ORIGINAL_SOURCE:private:source-a'])assert.ok(text().includes(expected),expected);
 assert.ok(!text().includes('STALE_FLAT_COPY'));assert.deepEqual(actions,[]);
 const card=all().find(e=>e.dataset.claimId==='claim-self');card.children.find(e=>e.textContent==='不再采用').action();
 assert.equal(actions.length,1);assert.equal(actions[0].route,'/api/claim-action');assert.equal(actions[0].args.id,'claim-self');assert.equal(actions[0].args.expectedVersion,3);
 context.scopeKey='different-contact';card.children.find(e=>e.textContent==='更正这点').action();card.children.find(e=>e.textContent==='不再采用').action();assert.equal(actions.length,1);assert.equal(discussion.length,0);
 context.state.relationship.understanding={version:'v2',self:groups(),contact:groups(),dyad:groups()};context.renderRelationship();assert.ok(!text().includes('REAL_SELF_FACT'));
 context.state.relationship={self:[{id:'baseline',version:1,text:'ACTUAL_BASELINE_FLAT',sourceIds:[]}]};context.renderRelationship();assert.ok(text().includes('ACTUAL_BASELINE_FLAT'));
});
