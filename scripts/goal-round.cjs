'use strict';
// Evidence/state plumbing for project Goal work. This does not grade conversations.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {loadReplayPlans}=require('./eval-replay-plan.cjs');
const {visibleOutput}=require('./eval-replay.cjs');
const {FLAGS}=require('./eval-reviewer-calibration.cjs');
const ROOT=path.resolve(__dirname,'..'),GOAL='goals/assistant-improvement';
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value),read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const unique=values=>[...new Set(values)];
function ordered(value){if(Array.isArray(value))return value.map(ordered);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));return value;}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.tmp`;fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
function need(value,message){if(!value)throw Error(message);}
function rolesIdentity(root){const file=path.join(root,GOAL,'roles.json'),roles=read(file),files=[file,path.join(root,roles.coordinator.skill)];for(const role of Object.values(roles.agents))files.push(path.join(root,role.config),path.join(root,role.skill));return {hash:hash(files.map(file=>[path.relative(root,file),hash(fs.readFileSync(file))])),roles};}
function roundAt(directory){const out=fs.realpathSync(directory),round=read(path.join(out,'round.json'));need(round.schema_version===1,'Unsupported round schema');return {out,round};}
function save(out,round){write(path.join(out,'round.json'),round);return round;}
function prepareRound(options={}){
 const root=fs.realpathSync(options.root||ROOT),goal=read(path.join(root,GOAL,'goal.json')),data=loadReplayPlans({datasetDir:path.join(root,'evals/assistant'),replayDir:path.join(root,'evals/assistant/replay')});
 const stage=goal.stages.find(s=>s.id===options.stage);need(stage,'Unknown Goal stage');need(typeof options.id==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/.test(options.id),'Round id must be a stable lowercase slug');need(typeof options.hypothesis==='string'&&options.hypothesis.trim(),'A concrete hypothesis is required');
 const targets=options.cases||stage.target_cases;need(Array.isArray(targets)&&targets.length&&targets.every(id=>stage.target_cases.includes(id)),'Target cases must belong to the selected stage');
 const guards=unique(options.guardrails||stage.guardrail_cases);need(guards.length&&guards.every(id=>data.plans.some(plan=>plan.id===id)),'Choose named frozen-dataset guardrails before execution');const ids=unique([...targets,...guards]);
 const selected=ids.map(id=>{const p=data.plans.find(p=>p.id===id);need(p,`Unknown frozen case ${id}`);return p;});
 const out=path.resolve(options.out||path.join(root,goal.execution.artifacts_root,options.id));need(!fs.existsSync(out),'Round output directory must be new');need(!out.split(path.sep).some(part=>['.git','data'].includes(part)),'Round artifacts must stay outside private data/Git metadata');
 const rubric=read(path.join(root,'evals/assistant/rubric.json')),roles=rolesIdentity(root),max=options.maxHttp??goal.execution.max_http_per_round;
 need(Number.isSafeInteger(max)&&max>0&&max<=goal.execution.max_http_per_round,'Round HTTP cap exceeds the frozen contract');
 const adapter=fs.realpathSync(options.adapter||path.join(root,'scripts/eval-qq-adapter.cjs')),verifier=require(adapter);need(typeof verifier.implementationIdentity==='function','Adapter needs a pure implementationIdentity callback');const baseline=verifier.implementationIdentity({sourceRoot:root,revision:goal.baseline.commit});
 const round={schema_version:1,id:options.id,root,goal_id:goal.id,goal_version:goal.version,goal_hash:hash(goal),stage_id:stage.id,hypothesis:options.hypothesis,status:'prepared',created_at:new Date().toISOString(),adapter_module:adapter,baseline_implementation:baseline,
  dataset_hash:data.datasetHash,policy_version:data.policyVersion,rubric_version:rubric.version,rubric_hash:hash(rubric),roles_hash:roles.hash,target_cases:unique(targets),guardrail_cases:guards,case_ids:ids,
  case_plans:Object.fromEntries(selected.map(p=>[p.id,clone(p)])),evaluator:{role:'qq_evaluator',role_hash:hash(fs.readFileSync(path.join(root,roles.roles.agents.qq_evaluator.config))),skill_hash:hash(fs.readFileSync(path.join(root,roles.roles.agents.qq_evaluator.skill)))},max_http:max,per_variant_http:Math.floor(max/2),http_cap_scope:'baseline_and_candidate_combined',condition_change:options.conditionChange||null,reuse_compatible_baseline:options.reuseCompatibleBaseline===true,variants:{baseline:null,candidate:null},packet:null,review:null,decision:null};
 fs.mkdirSync(out,{recursive:true,mode:0o700});return save(out,round);
}
function frozenReasons(round){
 const reasons=[];try{const goal=read(path.join(round.root,GOAL,'goal.json'));if(hash(goal)!==round.goal_hash)reasons.push('Goal contract changed');const data=loadReplayPlans({datasetDir:path.join(round.root,'evals/assistant'),replayDir:path.join(round.root,'evals/assistant/replay')});if(data.datasetHash!==round.dataset_hash)reasons.push('Frozen dataset changed');if(hash(read(path.join(round.root,'evals/assistant/rubric.json')))!==round.rubric_hash)reasons.push('Frozen rubric changed');if(rolesIdentity(round.root).hash!==round.roles_hash)reasons.push('Frozen role/skill bindings changed');}catch(error){reasons.push(`Frozen source unavailable: ${error.message}`);}return reasons;
}
function attachReplay(directory,{variant,replay,adapter}={}){
 need(['baseline','candidate'].includes(variant),'Unknown comparison variant');const {out,round}=roundAt(directory);need(!round.variants[variant],`${variant} is already attached`);need(!round.review&&!round.decision,'Cannot replace reviewed evidence');
 const src=fs.realpathSync(replay),manifest=read(path.join(src,'manifest.json')),transport=read(path.join(src,'transport.json'));
 need(manifest.identity?.rubric_version===round.rubric_version,'Replay rubric identity mismatch');
 const reused=manifest.identity?.dataset_hash!==round.dataset_hash;need(!reused||variant==='baseline'&&round.reuse_compatible_baseline,'Replay dataset identity mismatch');
 const adapterPath=fs.realpathSync(adapter||round.adapter_module),verifier=require(adapterPath);need(typeof verifier.implementationIdentity==='function','Adapter needs implementationIdentity for source verification');
 const verified=verifier.implementationIdentity(variant==='baseline'?{sourceRoot:round.root,revision:round.baseline_implementation.revision}:{sourceRoot:manifest.adapter?.source_root});need(verified.hash===manifest.adapter?.implementation_hash,'Replay implementation no longer matches its current or declared source');
 if(variant==='baseline')need(verified.hash===round.baseline_implementation.hash,'Baseline implementation differs from the declared frozen baseline');
 if(variant==='candidate')need(manifest.identity?.adapter_hash===hash(fs.readFileSync(adapterPath)),'Candidate adapter changed since execution');
 need(Number.isSafeInteger(transport.http_attempts)&&transport.http_attempts>=0&&Array.isArray(transport.requests)&&transport.requests.length===transport.http_attempts,'Replay HTTP usage/receipts are missing');
 const destination=path.join(out,'runs',variant);fs.mkdirSync(destination,{recursive:true,mode:0o700});const files={},cases={};
 for(const id of round.case_ids){
  if(!fs.existsSync(path.join(src,`${id}.run.json`)))continue;
  const run=read(path.join(src,`${id}.run.json`)),review=read(path.join(src,`${id}.review.json`));
  need(run.case_id===id&&run.plan_hash===hash(round.case_plans[id]),`Replay case input identity mismatch: ${id}`);need(hash(review.rubric)===round.rubric_hash,`Replay rubric content mismatch: ${id}`);
  need(hash(run.identity)===hash(manifest.identity)&&hash(run.adapter_identity)===hash(manifest.adapter),`Replay execution identity mismatch: ${id}`);
  const plan=round.case_plans[id],same=(a,b)=>hash(ordered(a))===hash(ordered(b));
  need(same(run.initial,plan.initial)&&run.goal===plan.runtime_goal,`Actual frozen initial context/goal mismatch: ${id}`);
  const stepIds=new Set();for(const [index,step]of run.steps.entries()){const expected=plan.steps[index];need(expected?.id===step.id&&!stepIds.has(step.id),`Actual step order is not the frozen prefix: ${id}`);stepIds.add(step.id);
   const input=clone(step.input),request=input.request;if(request?.reference){need(expected.feedback.mode!=='independent','Unrequested generated feedback reference');const target=run.steps.find(p=>p.id===expected.feedback.target_step_id);const selection=expected.feedback.target_output||{channel:'output'};const old=selection.channel==='output'?target?.output:selection.channel==='observed_outputs'?target?.observed_outputs?.[selection.index]?.output:target?.intermediate_outputs?.[selection.index];need(old?.reply_id===request.reference.reply_id&&step.feedback_binding?.reply_id===old.reply_id,'Actual feedback reference points to another output');delete request.reference;}
   const expectedInput={qq_events:expected.qq_events,private_events:expected.private_events,request:expected.request,...(expected.user_controls?{user_controls:expected.user_controls}:{}),...(expected.source_updates?{source_updates:expected.source_updates}:{})};
   need(step.as_of===expected.as_of&&same(input,expectedInput),`Actual frozen step inputs mismatch: ${id}/${step.id}`);
  }
  need(review.plan_hash===run.plan_hash&&hash(review.steps)===hash(run.steps.map(({diagnostics,...step})=>step)),`Review/output mismatch: ${id}`);
  for(const name of [`${id}.run.json`,`${id}.review.json`]){const body=fs.readFileSync(path.join(src,name));fs.writeFileSync(path.join(destination,name),body,{mode:0o600});files[name]=hash(body);}cases[id]={status:run.status,plan_hash:run.plan_hash};
 }
 need(Object.keys(cases).length,'No selected case is present in this replay');
 for(const name of ['manifest.json','transport.json']){const body=fs.readFileSync(path.join(src,name));fs.writeFileSync(path.join(destination,name),body,{mode:0o600});files[name]=hash(body);}
 round.variants[variant]={directory:destination,files,cases,status:manifest.status,identity:manifest.identity,adapter:manifest.adapter,adapter_module:adapterPath,verifier_hash:hash(fs.readFileSync(adapterPath)),verified_implementation:verified,selected_cases:manifest.selected_cases||[],http_attempts:transport.http_attempts,reused_compatible_input:reused};
 round.status='evidence_attached';return save(out,round);
}
function publicError(error,paths=[]){if(!error)return undefined;let message=String(error.message||error);for(const p of unique(paths.filter(p=>typeof p==='string'&&p.length>3)).sort((a,b)=>b.length-a.length))message=message.split(p).join('<implementation-root>');return {code:error.code||'execution_error',message};}
function visibleStep(step,paths=[]){
 const value={id:step.id,as_of:step.as_of,input:clone(step.input),status:step.status,output:clone(step.output??null),observed_outputs:clone(step.observed_outputs||[]),intermediate_outputs:clone(step.intermediate_outputs||[])};
 for(const key of ['feedback_binding','reason'])if(step[key]!==undefined)value[key]=clone(step[key]);if(step.error)value.error=publicError(step.error,paths);return value;
}
function outputText(step){
 const outputs=[step.output,...(step.intermediate_outputs||[]),...(step.observed_outputs||[]).map(item=>item.output)].filter(Boolean);
 return outputs.flatMap(value=>[value.text,...(value.suggestions||[]).flatMap(x=>[x.label,x.text]),...(value.options||[]).map(x=>x.label),...(value.notices||[]).map(x=>x.text),...(value.references||[]).flatMap(x=>[x.label,x.text])]).filter(value=>typeof value==='string');
}
function outputEvidence(entry,evidence){
 if(!evidence.source_id)return outputText(entry.actual);
 const outputs=[entry.actual.output,...(entry.actual.intermediate_outputs||[]),...(entry.actual.observed_outputs||[]).map(item=>item.output)].filter(value=>value?.reply_id===evidence.source_id);
 return outputs.flatMap(output=>outputText({output}));
}
function executionEvidence(entry){
 const statuses=[entry.actual.status,entry.case_execution?.status].filter(Boolean);
 return [entry.actual.error?.message,...statuses,...statuses.flatMap(status=>[`"status":${JSON.stringify(status)}`,`"status": ${JSON.stringify(status)}`]),entry.case_execution?.error?.message,entry.case_execution?.cleanup_error?.message,...(entry.actual.output===null?['output:null','"output":null','"output": null']:[])].filter(Boolean);
}
function buildPacket(directory,{out:requested}={}){
 const {out,round}=roundAt(directory);need(Object.values(round.variants).some(Boolean),'No attached evidence to review');need(!round.packet,'Review packet is already frozen');const dest=path.resolve(requested||path.join(out,'review-packet'));need(!fs.existsSync(dest),'Packet directory must be new');
 const packet={schema_version:1,packet_id:crypto.randomUUID(),rubric:read(path.join(round.root,'evals/assistant/rubric.json')),cases:[],systems:[],entries:[],pairs:[],instructions:'Review observable behavior before attribution. System labels are randomized. Resolve initial context once per case and prior entries by ID. Quote output:null for an observed absence when relevant. Metadata integrity is not quality; fixed continuations do not prove relationship outcomes.'};
 const mapping={systems:{},entries:{}};const variants=Object.keys(round.variants).filter(k=>round.variants[k]);if(crypto.randomInt(2))variants.reverse();
 for(const variant of variants){const system=`system_${crypto.randomBytes(4).toString('hex')}`;mapping.systems[system]=variant;packet.systems.push({id:system});
  for(const id of round.case_ids){const file=path.join(round.variants[variant].directory,`${id}.run.json`);if(!fs.existsSync(file))continue;const run=read(file),plan=round.case_plans[id];
   if(!packet.cases.some(c=>c.case_id===id))packet.cases.push({case_id:id,goal:run.goal,initial:clone(run.initial)});
   const paths=[round.root,round.variants[variant].adapter?.source_root];
   for(const expected of plan.steps){const step=run.steps.find(s=>s.id===expected.id),sample=step?visibleStep(step,paths):{id:expected.id,status:'unexecuted',input:{request:expected.request},output:null,observed_outputs:[],intermediate_outputs:[]};
    const entry={id:crypto.randomUUID(),system_id:system,case_id:id,step_id:expected.id,prior_entry_ids:packet.entries.filter(e=>e.system_id===system&&e.case_id===id).map(e=>e.id),actual:sample,case_execution:{status:run.status,...(run.error?{error:publicError(run.error,paths)}:{}),...(run.cleanup_error?{cleanup_error:publicError(run.cleanup_error,paths)}:{}),unexecuted_steps:run.unexecuted_steps||[]},criteria:clone(plan.reviewer_only.steps.find(s=>s.id===expected.id).evaluation)};
    entry.output_hash=hash(sample);mapping.entries[entry.id]={variant,case_id:id,step_id:expected.id,output_hash:entry.output_hash};packet.entries.push(entry);
   }
  }
 }
 for(const id of round.case_ids)for(const step of round.case_plans[id].steps){const entries=packet.entries.filter(e=>e.case_id===id&&e.step_id===step.id);if(entries.length===2)packet.pairs.push({case_id:id,step_id:step.id,entry_ids:entries.map(e=>e.id)});}
 const binding={packet_id:packet.packet_id,packet_hash:hash(packet),reviewer_role:round.evaluator.role,reviewer_role_hash:round.evaluator.role_hash,reviewer_skill_hash:round.evaluator.skill_hash};
 const template={...binding,reviewer_id:null,ratings:packet.entries.map(e=>({entry_id:e.id,output_hash:e.output_hash,overall:null,hard_failures:[],evidence:[]})),comparisons:packet.pairs.map(p=>({case_id:p.case_id,step_id:p.step_id,preferred:null,basis:null,reason:'',evidence:[]}))};
 const bundle={packet,binding,review_template:template,allowed_hard_failures:FLAGS,review_values:{overall:['usable','minor_edit','rewrite','insufficient_evidence'],preferred:['equivalent','inconclusive',...packet.systems.map(s=>s.id)],basis:['wording','delivery']},evidence_format:{ratings:'Quote current visible output using its reply_id as source_id, or omit source_id for current output/execution. Prior actual output IDs may support continuity, alongside at least one current output/execution quote. Raw observations use their source ID.',comparisons:'Use entry_id plus a literal output quote; delivery comparisons may quote bound step/case status/errors. Missing output may be cited as output:null or "output": null. Fill preferred/basis with review_values, not null; use inconclusive when unsupported.'}};
 fs.mkdirSync(dest,{recursive:true,mode:0o700});write(path.join(dest,'packet.json'),packet);write(path.join(dest,'bundle.json'),bundle);write(path.join(out,'packet-map.json'),mapping);round.packet={directory:dest,hash:hash(packet),id:packet.packet_id,map_hash:hash(mapping),bundle_hash:hash(bundle)};round.status='review_pending';save(out,round);return packet;
}
function validateReview(packet,review){
 need(review.packet_id===packet.packet_id&&review.packet_hash===hash(packet),'Review packet binding mismatch');need(typeof review.reviewer_id==='string'&&review.reviewer_id.trim(),'Actual reviewer identity is required');need(Array.isArray(review.ratings)&&Array.isArray(review.comparisons),'Review ratings and comparisons are required');
 const seen=new Set();for(const rating of review.ratings){const entry=packet.entries.find(e=>e.id===rating.entry_id);need(entry&&!seen.has(entry.id),'Unknown or duplicate review entry');seen.add(entry.id);need(rating.output_hash===entry.output_hash,'Review output hash mismatch');need(['usable','minor_edit','rewrite','insufficient_evidence'].includes(rating.overall),'Invalid overall judgment');need(Array.isArray(rating.hard_failures)&&Array.isArray(rating.evidence)&&rating.evidence.length,'Actual grades need failures/evidence fields');
  need(new Set(rating.hard_failures).size===rating.hard_failures.length&&rating.hard_failures.every(flag=>FLAGS.includes(flag)),'Unknown hard-failure classification');
  const context=packet.cases.find(c=>c.case_id===entry.case_id),history=entry.prior_entry_ids.map(id=>packet.entries.find(e=>e.id===id).actual);
  const source=[...context.initial.qq_events,...context.initial.private_events,...history.flatMap(s=>[...(s.input?.qq_events||[]),...(s.input?.private_events||[]),s.input?.request].filter(Boolean)),...(entry.actual.input?.qq_events||[]),...(entry.actual.input?.private_events||[]),entry.actual.input?.request].filter(Boolean);
  const actualTexts=e=>[...outputEvidence(entry,e),...(!e.source_id?executionEvidence(entry):[])];
  need(rating.evidence.some(e=>typeof e.quote==='string'&&actualTexts(e).some(text=>text.includes(e.quote))),'Every actual grade needs visible-output or execution evidence');
  for(const evidence of rating.evidence){need(typeof evidence.quote==='string'&&evidence.quote,'Review quote is required');const texts=[...actualTexts(evidence),...(evidence.source_id?source.filter(s=>s.id===evidence.source_id).map(s=>s.text):[]),...(evidence.source_id?history.flatMap(actual=>outputEvidence({actual},evidence)):[])];need(texts.some(text=>typeof text==='string'&&text.includes(evidence.quote)),'Review evidence quote is absent from the bound output/source');}
 }
 const pairs=new Set();for(const comparison of review.comparisons){const key=`${comparison.case_id}/${comparison.step_id}`,pair=packet.pairs.find(p=>p.case_id===comparison.case_id&&p.step_id===comparison.step_id);need(pair&&!pairs.has(key),'Unknown or duplicate paired comparison');pairs.add(key);need(['equivalent','inconclusive',...packet.systems.map(s=>s.id)].includes(comparison.preferred),'Invalid blinded preference');need(['wording','delivery'].includes(comparison.basis),'Comparison must distinguish wording from delivery');need(typeof comparison.reason==='string'&&comparison.reason.trim(),'Comparison rationale is required');need(Array.isArray(comparison.evidence)&&comparison.evidence.length,'Paired preference requires actual evidence');
  for(const evidence of comparison.evidence){const entry=packet.entries.find(e=>e.id===evidence.entry_id);need(entry&&pair.entry_ids.includes(entry.id),'Comparison evidence points outside the pair');need(typeof evidence.quote==='string'&&evidence.quote,'Comparison quote is required');const texts=[...outputText(entry.actual),...(comparison.basis==='delivery'?executionEvidence(entry):[])];need(texts.some(text=>text.includes(evidence.quote)),'Comparison quote is absent from actual evidence');}
 }
}
function recordReview(directory,{file}={}){const {out,round}=roundAt(directory);need(round.packet,'A frozen packet is required');need(!round.review,'Original review cannot be replaced');const packet=read(path.join(round.packet.directory,'packet.json')),review=read(file);validateReview(packet,review);need(review.reviewer_role===round.evaluator.role&&review.reviewer_role_hash===round.evaluator.role_hash&&review.reviewer_skill_hash===round.evaluator.skill_hash,'Reviewer role/skill binding mismatch');write(path.join(out,'review.json'),review);round.review={file:path.join(out,'review.json'),hash:hash(review)};round.status='reviewed';return save(out,round);}
function checkRound(directory){
 const {out,round}=roundAt(directory),reasons=frozenReasons(round),add=message=>reasons.push(message);let usage=0,packet,mapping,review;
 for(const variant of ['baseline','candidate']){const attached=round.variants[variant];if(!attached){add(`${variant} replay missing`);continue;}usage+=attached.http_attempts;
  for(const [name,digest]of Object.entries(attached.files))if(!fs.existsSync(path.join(attached.directory,name))||hash(fs.readFileSync(path.join(attached.directory,name)))!==digest)add(`${variant} evidence changed: ${name}`);
  if(!String(attached.adapter?.evidence||'').startsWith('live_model_'))add(`${variant} has no live-model evidence`);
  if(variant==='candidate'&&attached.status!=='executed_review_required')add('Candidate replay manifest is incomplete');
  if(attached.adapter?.max_http!==round.per_variant_http)add(`${variant} per-arm HTTP cap differs from the frozen allocation`);
  try{if(hash(fs.readFileSync(attached.adapter_module))!==attached.verifier_hash)add(`${variant} adapter verifier changed`);const source=require(attached.adapter_module).implementationIdentity(variant==='baseline'?{sourceRoot:round.root,revision:round.baseline_implementation.revision}:{sourceRoot:attached.adapter.source_root});if(source.hash!==attached.adapter.implementation_hash)add(`${variant} implementation changed after execution`);}catch(error){add(`${variant} implementation verification unavailable: ${error.message}`);}
  if(hash([...attached.selected_cases].sort())!==hash([...round.case_ids].sort()))add(`${variant} replay case selection differs from the round`);
  for(const id of round.case_ids){if(!attached.cases[id])add(`${variant} case missing: ${id}`);else if(variant==='candidate'&&attached.cases[id].status!=='executed_review_required')add(`Candidate replay incomplete: ${id}`);}
 }
 if(usage>round.max_http)add('Combined baseline/candidate HTTP cap exceeded');
 const a=round.variants.baseline,b=round.variants.candidate;if(a&&b){
  const condition=x=>({model:x.adapter?.model,destination:x.adapter?.destination,settings_hash:x.adapter?.settings_hash,preparation:x.adapter?.prefix_preparation,max_http:x.adapter?.max_http});
  if(!round.condition_change&&hash(condition(a))!==hash(condition(b)))add('Model/preparation conditions changed without a frozen declaration');
  if(a.adapter?.implementation_hash===b.adapter?.implementation_hash&&hash(condition(a))===hash(condition(b)))add('No implementation or declared condition change is evidenced');
 }
 if(!round.packet)add('Independent review packet missing');else try{packet=read(path.join(round.packet.directory,'packet.json'));mapping=read(path.join(out,'packet-map.json'));if(hash(packet)!==round.packet.hash||hash(mapping)!==round.packet.map_hash||hash(read(path.join(round.packet.directory,'bundle.json')))!==round.packet.bundle_hash)add('Frozen review packet/mapping changed');}catch{add('Review packet unavailable');}
 if(!round.review)add('Independent evaluator review missing');else try{review=read(round.review.file);if(hash(review)!==round.review.hash)add('Original evaluator review changed');if(packet)validateReview(packet,review);}catch(error){add(`Review invalid: ${error.message}`);}
 let improved=0;if(packet&&mapping&&review){
  for(const entry of packet.entries){const tag=mapping.entries[entry.id],rating=review.ratings.find(r=>r.entry_id===entry.id);if(!rating){add(`Grade missing: ${entry.case_id}/${entry.step_id}/${tag.variant}`);continue;}if(tag.variant!=='candidate')continue;
   if(entry.actual.status!=='executed_review_required')add(`Candidate step did not execute: ${entry.case_id}/${entry.step_id}`);
   try{if(entry.actual.output)visibleOutput(entry.actual.output);if(entry.actual.input?.request&&!entry.actual.output)add(`Candidate requested answer missing: ${entry.case_id}/${entry.step_id}`);if(entry.actual.output&&!entry.criteria.acceptable_outputs.includes(entry.actual.output.disposition))add(`Candidate response kind outside case contract: ${entry.case_id}/${entry.step_id}`);}catch{add(`Candidate visible answer invalid: ${entry.case_id}/${entry.step_id}`);}
   if(rating.hard_failures.length||['rewrite','insufficient_evidence'].includes(rating.overall))add(`Candidate not acceptable: ${entry.case_id}/${entry.step_id}`);
   if(round.target_cases.includes(entry.case_id)&&rating.overall!=='usable')add(`Target needs usable help: ${entry.case_id}/${entry.step_id}`);
   const old=packet.entries.find(e=>e.case_id===entry.case_id&&e.step_id===entry.step_id&&mapping.entries[e.id].variant==='baseline'),oldGrade=review.ratings.find(r=>r.entry_id===old?.id);
   if(round.guardrail_cases.includes(entry.case_id)&&oldGrade?.overall==='usable'&&rating.overall!=='usable')add(`Guardrail grade regressed: ${entry.case_id}/${entry.step_id}`);
  }
  for(const id of round.case_ids)for(const step of round.case_plans[id].steps){const comparison=review.comparisons.find(p=>p.case_id===id&&p.step_id===step.id);if(!comparison){add(`Paired verdict missing: ${id}/${step.id}`);continue;}const preferred=mapping.systems[comparison.preferred];if(preferred==='baseline'||comparison.preferred==='inconclusive')add(`No non-regression judgment: ${id}/${step.id}`);if(preferred==='candidate'&&round.target_cases.includes(id)){
    const entries=packet.entries.filter(e=>e.case_id===id&&e.step_id===step.id),old=entries.find(e=>mapping.entries[e.id].variant==='baseline'),next=entries.find(e=>mapping.entries[e.id].variant==='candidate');
    if(!old||!next)continue;if(comparison.basis==='wording'&&old.actual.status!=='executed_review_required')add(`Missing baseline cannot yield wording preference: ${id}/${step.id}`);
    else if(hash(outputText(old.actual))===hash(outputText(next.actual))&&comparison.basis==='wording')add(`Identical wording cannot prove improvement: ${id}/${step.id}`);
    else if(comparison.basis==='delivery'&&old.actual.status==='executed_review_required')add(`Successful baseline cannot yield delivery improvement: ${id}/${step.id}`);else improved++;
   }}
  if(!improved)add('No target improvement is evidenced');
 }
 return {schema_version:1,round_id:round.id,status:round.status,ready_to_accept:reasons.length===0,reasons:unique(reasons),http_used:usage,http_remaining:Math.max(0,round.max_http-usage),target_improvements:improved,semantic_truth_proven:false,stage_completed:false,goal_completed:false};
}
function decideRound(directory,{decision,reason}={}){const {out,round}=roundAt(directory);need(!round.decision,'Original round decision cannot be overwritten');need(['accepted','rejected','inconclusive'].includes(decision),'Invalid decision');need(typeof reason==='string'&&reason.trim(),'Decision reason is required');const checked=checkRound(directory);need(decision!=='accepted'||checked.ready_to_accept,'Round is not ready for acceptance');round.decision={status:decision,reason,check:checked,at:new Date().toISOString()};round.status=decision;return save(out,round);}
function status(options={}){if(options.round)return checkRound(options.round);const root=options.root||ROOT;return {goal:read(path.join(root,GOAL,'goal.json')),initial_state:read(path.join(root,GOAL,'state.json')),native_goal_activation:'not_observed_by_local_checker',note:'Local setup/state is not native Goal activation or product completion.'};}
function main(argv){
 const command=argv[0]||'status',o={};if(argv.includes('--help')){console.log('goal-round prepare|attach|packet|review|check|decide|status; no command invokes a model or changes approval settings. See goals/assistant-improvement/GOAL_CN.md.');return;}
 const allowed={prepare:['id','stage','cases','guardrails','hypothesis','out','max-http','condition-change','reuse-compatible-baseline'],attach:['round','variant','replay','adapter'],packet:['round','out'],review:['round','file'],check:['round'],decide:['round','decision','reason'],status:['round']};need(allowed[command],'Unknown goal-round command');
 const flags=new Set(['reuse-compatible-baseline']);for(let i=1;i<argv.length;i++){const key=argv[i].replace(/^--/,'');need(argv[i].startsWith('--')&&allowed[command].includes(key)&&!Object.hasOwn(o,key),'Unknown or duplicate --option');if(flags.has(key)){o[key]=true;continue;}need(argv[i+1]&&!argv[i+1].startsWith('--'),`Missing value for ${key}`);o[key]=argv[++i];}
 const list=value=>value?value.split(','):undefined;let result;
 if(command==='prepare')result=prepareRound({id:o.id,stage:o.stage,cases:list(o.cases),guardrails:list(o.guardrails),hypothesis:o.hypothesis,out:o.out,maxHttp:o['max-http']?Number(o['max-http']):undefined,conditionChange:o['condition-change'],reuseCompatibleBaseline:o['reuse-compatible-baseline']});
 else if(command==='attach')result=attachReplay(o.round,{variant:o.variant,replay:o.replay,adapter:o.adapter});else if(command==='packet')result=buildPacket(o.round,{out:o.out});else if(command==='review')result=recordReview(o.round,{file:o.file});else if(command==='check')result=checkRound(o.round);else if(command==='decide')result=decideRound(o.round,{decision:o.decision,reason:o.reason});else if(command==='status')result=status({round:o.round});else throw Error('Unknown goal-round command');
 console.log(JSON.stringify(result,null,2));if(command==='check'&&!result.ready_to_accept)process.exitCode=1;
}
module.exports={prepareRound,attachReplay,buildPacket,recordReview,checkRound,decideRound,status,validateReview,hash};
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
