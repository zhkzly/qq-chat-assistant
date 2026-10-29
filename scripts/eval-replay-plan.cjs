'use strict';
// Data-only compilation. No product imports, inference, state restoration or scoring.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {validateCase,loadDataset}=require('./eval-dataset.cjs');
const REPLAY_POLICY_VERSION='observed-history-replay-v2';
const SUPPORTED_POLICIES=['observed-history-replay-v1',REPLAY_POLICY_VERSION];
const DEFAULT_REPLAY_DIR=path.resolve(__dirname,'../evals/assistant/replay');
const clone=value=>structuredClone(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&!!value.trim();
const LIMITATIONS=[
 'Fixed QQ self/contact events are authored external observations, not adoption of a generated draft or causal replies to it.',
 'Archived assistant messages are observed prefix context, not fresh outputs or expected answers; never regenerate or substitute them.',
 'Each implementation starts from this observed prefix and derives its own state; no memory artifact is shared between implementations.',
 'Keep actual new assistant turns in the running session. Replay plans never insert predicted assistant turns.',
 'Replay data and structural checks do not establish conversational quality, real desktop integration or relationship outcomes.'
];
const qqEvent=event=>({...clone(event),provenance:'authored_external_qq'});
const privateEvent=event=>({...clone(event),provenance:'archived_context'});

function checkedOverride(override,original,where){
 if(!object(override))throw new Error(`${where}: expected a declared adaptation`);
 for(const key of ['version','original_text','replacement_text','reason'])if(!text(override[key]))throw new Error(`${where}.${key}: expected nonempty string`);
 if(override.original_text!==original)throw new Error(`${where}.original_text: adaptation does not match frozen source text`);
 return clone(override);
}
function relativeFeedback(value){
 return /(?:刚才那句|(?:你|助手)(?:刚才|上一轮|上次)的?(?:回复|回答|建议|表达)|(?:刚才|上一轮|上次)(?:你|助手)(?:给|写|说)|(?:刚才|上一轮)那份理解)/u.test(value);
}
function buildReplayPlan(item,options={}){
 const errors=validateCase(item);if(errors.length)throw new Error(errors.join('\n'));
 const initial=item.initial_context,adaptations=[];
 let runtimeGoal=item.goal;
 if(options.goalOverride){const adaptation=checkedOverride(options.goalOverride,item.goal,'goalOverride');adaptations.push({field:'runtime_goal',...adaptation});runtimeGoal=adaptation.replacement_text;}
 const userNotes=initial.notes.filter(note=>['material','preference'].includes(note.kind)).map(note=>({id:note.id,at:note.at,role:'user',text:note.text,provenance:'authored_user_note',declared_use:note.use,note_kind:note.kind,evidence_source_ids:[...note.source_ids]}));
 const privateEvents=[...initial.private_discussion.map(privateEvent),...userNotes].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const steps=item.steps.map(step=>{
  const override=options.requestOverrides?.[step.id];
  let requestText=step.request.text;
  if(override){const adaptation=checkedOverride(override,requestText,`requestOverrides.${step.id}`);adaptations.push({field:`steps.${step.id}.request.text`,...adaptation});requestText=adaptation.replacement_text;}
  const relative=relativeFeedback(requestText)||step.private_updates.some(event=>event.role==='user'&&relativeFeedback(event.text));
  return {id:step.id,as_of:step.as_of,qq_events:step.qq_updates.map(qqEvent),private_events:step.private_updates.map(privateEvent),request:{...clone(step.request),at:step.as_of,text:requestText},feedback:relative?{mode:'requires_observed_output',reason:'This feedback refers to an assistant answer. Bind it to an actually observed output before replaying, or record a versioned independent-instruction adaptation.'}:{mode:'independent'}};
 });
 for(const id of Object.keys(options.requestOverrides||{}))if(!item.steps.some(step=>step.id===id))throw new Error(`requestOverrides.${id}: unknown step`);
 const plan={schema_version:1,policy_version:REPLAY_POLICY_VERSION,id:item.id,source_kind:'legacy_case',goal_type:item.goal_type,runtime_goal:runtimeGoal,initial:{as_of:initial.as_of,qq_events:initial.qq_history.map(qqEvent),private_events:privateEvents},steps,adaptations,reviewer_only:{original_goal:item.goal,excluded_understandings:initial.notes.filter(note=>note.kind==='understanding').map(clone),steps:item.steps.map(step=>({id:step.id,evaluation:clone(step.evaluation)}))},limitations:clone(LIMITATIONS)};
 const planErrors=validateReplayPlan(plan);if(planErrors.length)throw new Error(planErrors.join('\n'));
 return plan;
}

function validateReplayPlan(plan){
 const errors=[],ids=new Set(),availableAtStep=[],sourceInfo=new Map(),priorStepIds=new Set(),withdrawalAt=new Map(),withdrawalMode=new Map(),noteEvidence=[];
 const error=(where,message)=>errors.push(`${where}: ${message}`);
 const record=(value,where,keys)=>{if(!object(value)){error(where,'expected object');return false;}for(const key of Object.keys(value))if(!keys.includes(key))error(`${where}.${key}`,'unknown field');return true;};
 const nonempty=(value,where)=>{if(!text(value))error(where,'expected nonempty string');};
 const array=(value,where)=>{if(!Array.isArray(value)){error(where,'expected array');return [];}return value;};
 const time=(value,where)=>{
  const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match){error(where,'expected timezone-aware ISO timestamp');return NaN;}
  const [,year,month,day,hour,minute,second,zone]=match,[y,m,d,h,min,s]=[year,month,day,hour,minute,second].map(Number);
  if(m<1||m>12||d<1||d>new Date(Date.UTC(y,m,0)).getUTCDate()||h>23||min>59||s>59||zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4))>59)||!Number.isFinite(Date.parse(value))){error(where,'invalid calendar date or time');return NaN;}
  return Date.parse(value);
 };
 const register=(id,where)=>{nonempty(id,where);if(ids.has(id))error(where,`duplicate ID ${id}`);ids.add(id);};
 const controls=(value,where)=>{
  if(value===undefined)return;if(!record(value,where,['automatic','goal']))return;
  if(!Object.keys(value).length)error(where,'must include an observable control');
  if(Object.hasOwn(value,'automatic')&&typeof value.automatic!=='boolean')error(`${where}.automatic`,'expected boolean');
  if(Object.hasOwn(value,'goal'))nonempty(value.goal,`${where}.goal`);
 };
 const events=(value,where,kind,floor,ceiling,archivedPrefix=false)=>{
  let previous=-Infinity;
  array(value,where).forEach((event,index)=>{
   const p=`${where}[${index}]`,keys=kind==='qq'?['id','at','speaker','text','provenance','attachments']:['id','at','role','text','provenance','declared_use','note_kind','evidence_source_ids'];
   if(!record(event,p,keys))return;
   register(event.id,`${p}.id`);if(typeof event.text!=='string'||!event.text.trim()&&!(kind==='qq'&&event.attachments?.length))error(`${p}.text`,'expected text or an explicitly unavailable attachment');const at=time(event.at,`${p}.at`);
   if(at<floor||at>ceiling)error(`${p}.at`,'outside available replay interval');
   if(at<previous)error(`${p}.at`,'events must be chronological');previous=at;
   if(kind==='qq'){
    if(!['self','contact'].includes(event.speaker))error(`${p}.speaker`,'expected self|contact');
    if(event.provenance!=='authored_external_qq')error(`${p}.provenance`,'QQ is an authored external observation');
    if(event.attachments!==undefined)array(event.attachments,`${p}.attachments`).forEach((attachment,i)=>{
     const a=`${p}.attachments[${i}]`;if(!record(attachment,a,['id','kind','availability']))return;
     nonempty(attachment.id,`${a}.id`);if(attachment.kind!=='image'||attachment.availability!=='unavailable')error(a,'only explicitly unavailable image observations are supported by this fixture policy');
    });
   }else{
    if(!['user','assistant'].includes(event.role))error(`${p}.role`,'expected user|assistant');
    if(event.role==='assistant'&&!archivedPrefix)error(`${p}.role`,'new assistant answers must come from the running system, never authored step inputs');
    if(!['archived_context','authored_user_note'].includes(event.provenance))error(`${p}.provenance`,'expected archived context or authored user note, never generated outputs');
    if(event.provenance==='authored_user_note'&&event.role!=='user')error(`${p}.role`,'authored user notes must be user events');
    if(event.declared_use!==undefined&&!['discussion','draft'].includes(event.declared_use))error(`${p}.declared_use`,'expected discussion|draft');
    if(event.note_kind!==undefined&&(!['material','preference'].includes(event.note_kind)||event.provenance!=='authored_user_note'))error(`${p}.note_kind`,'only authored notes have material|preference kinds');
    if(event.evidence_source_ids!==undefined){
     if(event.provenance!=='authored_user_note')error(`${p}.evidence_source_ids`,'only authored notes carry explicit source references');
     for(const id of array(event.evidence_source_ids,`${p}.evidence_source_ids`)){const source=sourceInfo.get(id);if(!source||source.at>at||source.role==='assistant')error(`${p}.evidence_source_ids`,`unknown, generated or later original evidence: ${id}`);noteEvidence.push({id,at,path:`${p}.evidence_source_ids`});}
    }
   }
   sourceInfo.set(event.id,{at,channel:kind==='qq'?'qq':event.provenance==='authored_user_note'?'note':'private',role:event.role,dependencies:event.evidence_source_ids||[]});
  });
 };
 if(!record(plan,'plan',['schema_version','policy_version','id','source_kind','goal_type','runtime_goal','initial','steps','adaptations','reviewer_only','limitations']))return errors;
 if(plan.schema_version!==1)error('plan.schema_version','expected 1');
 if(!SUPPORTED_POLICIES.includes(plan.policy_version))error('plan.policy_version',`expected supported policy ${SUPPORTED_POLICIES.join('|')}`);
 if(plan.policy_version==='observed-history-replay-v1'){
  const newerControls=value=>value&&Object.hasOwn(value,'goal');
  const newerEvents=events=>Array.isArray(events)&&events.some(event=>event&&(event.attachments!==undefined||event.note_kind!==undefined||event.evidence_source_ids!==undefined));
  if(newerControls(plan.initial?.user_controls)||newerEvents(plan.initial?.qq_events)||newerEvents(plan.initial?.private_events)||(Array.isArray(plan.steps)&&plan.steps.some(step=>step&&(step.source_updates!==undefined||newerControls(step.user_controls)||newerEvents(step.qq_events)||newerEvents(step.private_events)||step.feedback?.mode==='observed_output'||step.feedback?.target_output!==undefined))))error('plan.policy_version','new observation capabilities require observed-history-replay-v2');
 }
 if(!text(plan.id)||!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(plan.id))error('plan.id','expected stable lowercase ASCII identifier');
 if(!['legacy_case','event_fixture'].includes(plan.source_kind))error('plan.source_kind','expected legacy_case|event_fixture');
 if(!['relationship','friendship','work','learning','support'].includes(plan.goal_type))error('plan.goal_type','unknown ordinary goal type');
 nonempty(plan.runtime_goal,'plan.runtime_goal');
 let previous=NaN;
 if(record(plan.initial,'plan.initial',['as_of','qq_events','private_events','user_controls'])){
  previous=time(plan.initial.as_of,'plan.initial.as_of');events(plan.initial.qq_events,'plan.initial.qq_events','qq',-Infinity,previous);events(plan.initial.private_events,'plan.initial.private_events','private',-Infinity,previous,true);controls(plan.initial.user_controls,'plan.initial.user_controls');
 }
 const steps=array(plan.steps,'plan.steps');if(!steps.length)error('plan.steps','must not be empty');
 steps.forEach((step,index)=>{
  const p=`plan.steps[${index}]`;if(!record(step,p,['id','as_of','qq_events','private_events','request','feedback','user_controls','source_updates']))return;
  register(step.id,`${p}.id`);const at=time(step.as_of,`${p}.as_of`);if(at<previous)error(`${p}.as_of`,'steps must be chronological');
  events(step.qq_events,`${p}.qq_events`,'qq',previous,at);events(step.private_events,`${p}.private_events`,'private',previous,at);controls(step.user_controls,`${p}.user_controls`);
  if(step.request!==null&&record(step.request,`${p}.request`,['id','at','text'])){
   register(step.request.id,`${p}.request.id`);nonempty(step.request.text,`${p}.request.text`);
   if(time(step.request.at,`${p}.request.at`)!==at)error(`${p}.request.at`,'request timestamp must equal step time');
  }
  if(step.source_updates!==undefined){
   const revised=new Set();array(step.source_updates,`${p}.source_updates`).forEach((update,i)=>{
    const u=`${p}.source_updates[${i}]`;if(!record(update,u,['id','at','channel','operation']))return;
    const source=sourceInfo.get(update.id),when=time(update.at,`${u}.at`);
    if(!source||source.at>when||when<previous||when>at||source.channel!==update.channel)error(u,'withdrawal must target an available original source in this interval');
    if(!['delete','exclude','recall'].includes(update.operation)||update.operation==='recall'&&update.channel!=='qq'||update.operation==='delete'&&update.channel==='qq')error(`${u}.operation`,'unsupported withdrawal operation');
    const earlier=withdrawalMode.get(update.id);if(earlier&&!(earlier==='exclude'&&update.operation==='delete'))error(u,'source has already been withdrawn');
    if(revised.has(update.id))error(u,'duplicate source operation');revised.add(update.id);
    withdrawalAt.set(update.id,Math.min(withdrawalAt.get(update.id)??Infinity,when));withdrawalMode.set(update.id,update.operation);
   });
  }
  if(record(step.feedback,`${p}.feedback`,['mode','reason','bound_output_id','target_step_id','target_output'])){
   if(!['independent','requires_observed_output','observed_output'].includes(step.feedback.mode))error(`${p}.feedback.mode`,'expected independent|requires_observed_output|observed_output');
   if(step.feedback.mode==='requires_observed_output')nonempty(step.feedback.reason,`${p}.feedback.reason`);
   if(step.feedback.mode==='observed_output'&&!priorStepIds.has(step.feedback.target_step_id))error(`${p}.feedback.target_step_id`,'must name an earlier executed step, never a future or authored answer');
   if(step.feedback.mode!=='independent'&&step.request===null)error(`${p}.request`,'observed-output feedback requires a current user request');
   if(step.feedback.target_output!==undefined){
    const selection=step.feedback.target_output,where=`${p}.feedback.target_output`;
    if(record(selection,where,['channel','index'])){
     if(step.feedback.mode!=='observed_output'||!['output','observed_outputs','intermediate_outputs'].includes(selection.channel))error(where,'select an actual observed output channel');
     if(selection.channel==='output'&&selection.index!==undefined||selection.channel!=='output'&&(!Number.isSafeInteger(selection.index)||selection.index<0))error(where,'indexed output channels require a nonnegative integer index');
    }
   }
   if(step.feedback.bound_output_id!==undefined)nonempty(step.feedback.bound_output_id,`${p}.feedback.bound_output_id`);
   if(step.feedback.bound_output_id!==undefined&&step.feedback.mode!=='requires_observed_output')error(`${p}.feedback.bound_output_id`,'explicit runtime IDs require guarded observed-output mode');
   if(step.request&&relativeFeedback(step.request.text)&&step.feedback.mode==='independent')error(`${p}.feedback.mode`,'response-relative feedback needs an observed-output binding');
  }
  availableAtStep.push(new Set(ids));
  if(step.request)sourceInfo.set(step.request.id,{at,channel:'private'});
  priorStepIds.add(step.id);
  previous=at;
 });
 const unavailable=(id,at,visited=new Set())=>{if(visited.has(id))return false;visited.add(id);return (withdrawalAt.get(id)??Infinity)<=at||(sourceInfo.get(id)?.dependencies||[]).some(parent=>unavailable(parent,at,visited));};
 for(const reference of noteEvidence)if(unavailable(reference.id,reference.at))error(reference.path,`source was already withdrawn: ${reference.id}`);
 array(plan.adaptations,'plan.adaptations').forEach((adaptation,index)=>{
  const p=`plan.adaptations[${index}]`;if(record(adaptation,p,['field','version','original_text','replacement_text','reason']))for(const key of ['field','version','original_text','replacement_text','reason'])nonempty(adaptation[key],`${p}.${key}`);
 });
 if(record(plan.reviewer_only,'plan.reviewer_only',['original_goal','excluded_understandings','steps','coverage'])){
  nonempty(plan.reviewer_only.original_goal,'plan.reviewer_only.original_goal');
  const derived=array(plan.reviewer_only.excluded_understandings,'plan.reviewer_only.excluded_understandings'),derivedIds=new Set(derived.map(note=>note?.id));
  const reviews=array(plan.reviewer_only.steps,'plan.reviewer_only.steps');
  if(reviews.length!==steps.length)error('plan.reviewer_only.steps','one review entry is required per step');
  reviews.forEach((review,index)=>{
   const p=`plan.reviewer_only.steps[${index}]`;if(!record(review,p,['id','evaluation']))return;
   if(review.id!==steps[index]?.id)error(`${p}.id`,'review order must match replay steps');
   if(!record(review.evaluation,`${p}.evaluation`,['acceptable_outputs','should','should_not','critical_failures','evidence_ids']))return;
   for(const key of ['acceptable_outputs','should','should_not','critical_failures','evidence_ids']){
    const values=array(review.evaluation[key],`${p}.evaluation.${key}`);
    if(key!=='critical_failures'&&!values.length)error(`${p}.evaluation.${key}`,'must not be empty');
    values.forEach((value,i)=>nonempty(value,`${p}.evaluation.${key}[${i}]`));
    if(key==='acceptable_outputs')for(const value of values)if(!['draft','discussion','clarification','wait'].includes(value))error(`${p}.evaluation.${key}`,'unknown acceptable output');
    if(key==='evidence_ids')for(const id of values)if(!availableAtStep[index]?.has(id)&&!derivedIds.has(id))error(`${p}.evaluation.evidence_ids`,`unknown or unavailable original evidence: ${id}`);
   }
  });
 }
 const limitations=array(plan.limitations,'plan.limitations');if(!limitations.length)error('plan.limitations','must not be empty');limitations.forEach((value,index)=>nonempty(value,`plan.limitations[${index}]`));
 return errors;
}

function loadReplayPlans(options={}){
 const replayDir=path.resolve(options.replayDir||DEFAULT_REPLAY_DIR),plans=[],files=[],hash=crypto.createHash('sha256'),seen=new Set();
 let declared={};
 const adaptationPath=path.join(replayDir,'legacy-adaptations.json');
 if(options.applyLegacyAdaptations!==false&&fs.existsSync(adaptationPath)){
  const body=fs.readFileSync(adaptationPath,'utf8'),data=JSON.parse(body);files.push(adaptationPath);hash.update(body);
  if(data.schema_version!==1||!text(data.version)||!object(data.cases))throw new Error(`${adaptationPath}: invalid declared adaptation map`);
  declared=Object.fromEntries(Object.entries(data.cases).map(([id,value])=>[id,{goalOverride:value.goal?{...value.goal,version:data.version}:undefined,requestOverrides:Object.fromEntries(Object.entries(value.requests||{}).map(([step,override])=>[step,{...override,version:data.version}]))}]));
 }
 let corrections={};
 const correctionPath=path.join(replayDir,'evaluation-corrections.json');
 if(options.includeLegacy!==false&&fs.existsSync(correctionPath)){
  const body=fs.readFileSync(correctionPath,'utf8'),data=JSON.parse(body);files.push(correctionPath);hash.update('evaluation-corrections.json\0').update(body);
  if(data.schema_version!==1||!text(data.version)||!object(data.cases))throw new Error(`${correctionPath}: invalid evaluation corrections`);
  corrections=data.cases;
  for(const values of Object.values(corrections))for(const correction of values)if(!text(correction.step_id)||!text(correction.original_hash)||!object(correction.replacement)||!text(correction.reason))throw new Error(`${correctionPath}: incomplete versioned correction`);
  corrections=Object.fromEntries(Object.entries(corrections).map(([id,values])=>[id,values.map(value=>({...value,version:data.version}))]));
 }
 const add=(plan,location)=>{
  for(const correction of corrections[plan.id]||[]){
   const target=plan.reviewer_only.steps.find(step=>step.id===correction.step_id),original=target?.evaluation;
   if(!original||crypto.createHash('sha256').update(JSON.stringify(original)).digest('hex')!==correction.original_hash)throw new Error(`${correctionPath}: stale evaluation correction ${plan.id}/${correction.step_id}`);
   target.evaluation=clone(correction.replacement);
   plan.adaptations.push({field:`reviewer_only.steps.${correction.step_id}.evaluation`,version:correction.version,original_text:JSON.stringify(original),replacement_text:JSON.stringify(target.evaluation),reason:correction.reason});
  }
  const errors=validateReplayPlan(plan);if(errors.length)throw new Error(`${location}: ${errors.join('\n')}`);if(seen.has(plan.id))throw new Error(`${location}: duplicate replay ID ${plan.id}`);seen.add(plan.id);plans.push(plan);
 };
 if(options.includeLegacy!==false){
  const dataset=loadDataset(options.datasetDir);hash.update(dataset.datasetHash);files.push(...dataset.files.map(file=>path.join(dataset.directory,file)));
  for(const id of Object.keys(declared))if(!dataset.cases.some(item=>item.id===id))throw new Error(`${adaptationPath}: unknown case ${id}`);
  for(const item of dataset.cases)add(buildReplayPlan(item,declared[item.id]),`legacy:${item.id}`);
 }
 const names=fs.readdirSync(replayDir,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.jsonl')).map(entry=>entry.name).sort();
 for(const name of names){
  const filename=path.join(replayDir,name),body=fs.readFileSync(filename,'utf8');files.push(filename);hash.update(name).update('\0').update(body).update('\0');
  body.split(/\r?\n/).forEach((line,index)=>{if(!line.trim())return;let plan;const location=`${name}:${index+1}`;try{plan=JSON.parse(line);}catch{throw new Error(`${location}: invalid JSON`);}add(plan,location);});
 }
 if(!plans.length)throw new Error(`${replayDir}: no replay plans`);
 for(const id of Object.keys(corrections))if(!seen.has(id))throw new Error(`${correctionPath}: unknown case ${id}`);
 return {plans,datasetHash:hash.update(REPLAY_POLICY_VERSION).digest('hex'),policyVersion:REPLAY_POLICY_VERSION,files};
}
module.exports={buildReplayPlan,validateReplayPlan,loadReplayPlans,REPLAY_POLICY_VERSION};
