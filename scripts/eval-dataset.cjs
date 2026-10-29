'use strict';
// Offline authoring checks and clean input exports, never model inference or grading.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const DEFAULT_DIR=path.resolve(__dirname,'../evals/assistant');
const GOALS=['relationship','friendship','work','learning','support'];
const OUTPUTS=['draft','discussion','clarification','wait'];
const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>structuredClone(value);

function validateCase(item){
 const errors=[],ids=new Map();
 const error=(where,message)=>errors.push(`${where}: ${message}`);
 const text=(value,where)=>{if(typeof value!=='string'||!value.trim()){error(where,'expected nonempty string');return false;}return true;};
 const object=(value,where,keys)=>{if(!isObject(value)){error(where,'expected object');return false;}for(const key of Object.keys(value))if(!keys.includes(key))error(`${where}.${key}`,'unknown field');return true;};
 const array=(value,where)=>{if(!Array.isArray(value)){error(where,'expected array');return [];}return value;};
 const strings=(value,where,nonempty=false)=>{const values=array(value,where);if(nonempty&&!values.length)error(where,'must not be empty');values.forEach((v,i)=>text(v,`${where}[${i}]`));if(new Set(values).size!==values.length)error(where,'duplicate values');return values;};
 const choice=(value,where,choices)=>{if(!choices.includes(value))error(where,`expected ${choices.join('|')}`);};
 const timestamp=(value,where)=>{
  const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match){error(where,'expected timezone-aware ISO timestamp');return NaN;}
  const [,year,month,day,hour,minute,second,zone]=match,numbers=[year,month,day,hour,minute,second].map(Number),[,m,d,h,min,sec]=numbers;
  const maxDay=new Date(Date.UTC(Number(year),m,0)).getUTCDate();
  if(m<1||m>12||d<1||d>maxDay||h>23||min>59||sec>59||zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4,6))>59)||!Number.isFinite(Date.parse(value))){error(where,'invalid calendar date or time');return NaN;}
  return Date.parse(value);
 };
 const register=(id,where,at,kind)=>{if(!text(id,where))return;if(ids.has(id))error(where,`duplicate ID ${id}`);else ids.set(id,{at,kind});};
 const events=(value,where,kind,ceiling,floor=-Infinity)=>{
  let previous=-Infinity;
  array(value,where).forEach((event,index)=>{
   const p=`${where}[${index}]`,keys=kind==='qq'?['id','at','speaker','text']:['id','at','role','text'];
   if(!object(event,p,keys))return;const at=timestamp(event.at,`${p}.at`);
   if(at>ceiling||at<floor)error(`${p}.at`,'outside the available replay interval');
   if(at<previous)error(`${p}.at`,'events must be chronological');previous=at;
   choice(kind==='qq'?event.speaker:event.role,`${p}.${kind==='qq'?'speaker':'role'}`,kind==='qq'?['self','contact']:['user','assistant']);
   text(event.text,`${p}.text`);register(event.id,`${p}.id`,at,kind==='private'&&event.role==='assistant'?'assistant':kind);
  });
 };
 if(!object(item,'case',['schema_version','id','family','goal_type','goal','tags','contrast_group','initial_context','steps']))return errors;
 if(item.schema_version!==1)error('case.schema_version','expected 1');
 if(typeof item.id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(item.id))error('case.id','expected stable lowercase ASCII identifier');
 text(item.family,'case.family');choice(item.goal_type,'case.goal_type',GOALS);text(item.goal,'case.goal');strings(item.tags,'case.tags',true);text(item.contrast_group,'case.contrast_group');
 const initial=item.initial_context;
 if(!object(initial,'case.initial_context',['as_of','qq_history','private_discussion','notes']))return errors;
 const initialAt=timestamp(initial.as_of,'case.initial_context.as_of');
 events(initial.qq_history,'case.initial_context.qq_history','qq',initialAt);
 events(initial.private_discussion,'case.initial_context.private_discussion','private',initialAt);
 array(initial.notes,'case.initial_context.notes').forEach((note,index)=>{
  const p=`case.initial_context.notes[${index}]`;
  if(!object(note,p,['id','at','subject','kind','use','text','source_ids']))return;
  const at=timestamp(note.at,`${p}.at`);if(at>initialAt)error(`${p}.at`,'note is not yet available');
  choice(note.subject,`${p}.subject`,['self','contact','dyad']);choice(note.kind,`${p}.kind`,['material','preference','understanding']);choice(note.use,`${p}.use`,['discussion','draft']);text(note.text,`${p}.text`);
  const references=strings(note.source_ids,`${p}.source_ids`,note.kind==='understanding');
  for(const id of references){const source=ids.get(id);if(!source||!['qq','private'].includes(source.kind)||source.at>at)error(`${p}.source_ids`,`requires earlier original QQ/private evidence: ${id}`);}
  register(note.id,`${p}.id`,at,'note');
 });
 const steps=array(item.steps,'case.steps');if(!steps.length)error('case.steps','must not be empty');
 let previousAt=initialAt;
 steps.forEach((step,index)=>{
  const p=`case.steps[${index}]`;
  if(!object(step,p,['id','as_of','qq_updates','private_updates','request','evaluation']))return;
  const at=timestamp(step.as_of,`${p}.as_of`);if(at<previousAt)error(`${p}.as_of`,'steps must be chronological');register(step.id,`${p}.id`,at,'step');
  events(step.qq_updates,`${p}.qq_updates`,'qq',at,previousAt);
  events(step.private_updates,`${p}.private_updates`,'private',at,previousAt);
  if(object(step.request,`${p}.request`,['id','text'])){text(step.request.text,`${p}.request.text`);register(step.request.id,`${p}.request.id`,at,'request');}
  const evaluation=step.evaluation;
  if(object(evaluation,`${p}.evaluation`,['acceptable_outputs','should','should_not','critical_failures','evidence_ids'])){
   for(const output of strings(evaluation.acceptable_outputs,`${p}.evaluation.acceptable_outputs`,true))choice(output,`${p}.evaluation.acceptable_outputs`,OUTPUTS);
   strings(evaluation.should,`${p}.evaluation.should`,true);strings(evaluation.should_not,`${p}.evaluation.should_not`,true);strings(evaluation.critical_failures,`${p}.evaluation.critical_failures`);
   for(const id of strings(evaluation.evidence_ids,`${p}.evaluation.evidence_ids`,true)){const source=ids.get(id);if(!source||source.kind==='step'||source.at>at)error(`${p}.evaluation.evidence_ids`,`unknown or unavailable original evidence: ${id}`);}
  }
  previousAt=at;
 });
 return errors;
}

function validateRubric(rubric){
 if(!isObject(rubric)||rubric.schema_version!==1||typeof rubric.version!=='string'||!rubric.version.trim()||!Array.isArray(rubric.dimensions)||!rubric.dimensions.length)throw new Error('rubric.json: invalid rubric version or dimensions');
 const ids=rubric.dimensions.map(d=>d?.id);
 if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length||rubric.dimensions.some(d=>typeof d.question!=='string'||!d.question))throw new Error('rubric.json: dimension IDs/questions must be distinct and nonempty');
 for(const field of ['dimension_ratings','overall_ratings','hard_failure_rules','review_rules'])if(!Array.isArray(rubric[field])||!rubric[field].length||rubric[field].some(v=>typeof v!=='string'||!v))throw new Error(`rubric.json: invalid ${field}`);
}

function loadDataset(directory=DEFAULT_DIR){
 const dir=path.resolve(directory),names=fs.readdirSync(dir,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.jsonl')).map(entry=>entry.name).sort();
 const cases=[],seen=new Map(),hash=crypto.createHash('sha256');
 if(!names.length)throw new Error(`${dir}: no JSONL cases found`);
 for(const name of names){
  const body=fs.readFileSync(path.join(dir,name),'utf8');hash.update(name).update('\0').update(body).update('\0');
  body.split(/\r?\n/).forEach((line,index)=>{
   if(!line.trim())return;let item;const location=`${name}:${index+1}`;
   try{item=JSON.parse(line);}catch{throw new Error(`${location}: invalid JSON`);}
   const errors=validateCase(item);if(errors.length)throw new Error(`${location}: ${errors.join('\n')}`);
   if(seen.has(item.id))throw new Error(`${location}: duplicate case ID ${item.id}, first at ${seen.get(item.id)}`);
   seen.set(item.id,location);cases.push(item);
  });
 }
 if(!cases.length)throw new Error(`${dir}: dataset is empty`);
 const rubricBody=fs.readFileSync(path.join(dir,'rubric.json'),'utf8'),rubric=JSON.parse(rubricBody);validateRubric(rubric);hash.update('rubric.json\0').update(rubricBody);
 return {cases,rubric,datasetHash:hash.digest('hex'),files:names,directory:dir};
}

function stepIndex(item,stepId){const index=stepId===undefined?0:item.steps.findIndex(step=>step.id===stepId);if(index<0)throw new Error(`Unknown step ${stepId} in ${item.id}`);return index;}
function modelInput(item,stepId){
 const errors=validateCase(item);if(errors.length)throw new Error(errors.join('\n'));
 const index=stepIndex(item,stepId),initial=item.initial_context,qq=[...initial.qq_history],discussion=[...initial.private_discussion];
 for(let i=0;i<=index;i++){
  const step=item.steps[i];qq.push(...step.qq_updates);discussion.push(...step.private_updates);
  if(i<index)discussion.push({...step.request,at:step.as_of,role:'user'});
 }
 const step=item.steps[index];
 return clone({as_of:step.as_of,goal:item.goal,qq_history:qq,private_discussion:discussion.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)),notes:initial.notes,current_request:{...step.request,at:step.as_of}});
}
function reviewView(item,stepId,{rubric,datasetHash}){
 const index=stepIndex(item,stepId),step=item.steps[index];
 return {case_id:item.id,step_id:step.id,input:modelInput(item,step.id),evaluation:clone(step.evaluation),rubric:clone(rubric),review:{status:'not_run',dataset_hash:datasetHash,rubric_version:rubric.version,actual_response:null,response_version:null,dimension_ratings:Object.fromEntries(rubric.dimensions.map(d=>[d.id,{rating:null,evidence:[]}])),critical_failures:[],overall:null,notes:[]}};
}

function main(argv){
 const command=argv[0]||'check',args=argv.slice(1),options={};
 for(let i=0;i<args.length;i+=2){if(!['--dir','--id','--step','--view'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Invalid option ${args[i]}`);options[args[i].slice(2)]=args[i+1];}
 if(!['check','list','show'].includes(command))throw new Error('Use check, list, or show; this command never runs a model.');
 const dataset=loadDataset(options.dir);
 if(command==='check')return console.log(JSON.stringify({status:'valid',cases:dataset.cases.length,steps:dataset.cases.reduce((n,c)=>n+c.steps.length,0),goal_types:[...new Set(dataset.cases.map(c=>c.goal_type))],dataset_hash:dataset.datasetHash,rubric_version:dataset.rubric.version,semantic_evaluation:'not_run'},null,2));
 if(command==='list')return console.log(JSON.stringify(dataset.cases.map(c=>({id:c.id,family:c.family,goal_type:c.goal_type,goal:c.goal,steps:c.steps.map(s=>s.id),contrast_group:c.contrast_group})),null,2));
 const item=dataset.cases.find(c=>c.id===options.id);if(!item)throw new Error('show requires a known --id; use list to see case IDs');
 const view=options.view||'model';if(!['model','review'].includes(view))throw new Error('--view must be model or review');
 console.log(JSON.stringify(view==='model'?modelInput(item,options.step):reviewView(item,options.step,dataset),null,2));
}
module.exports={validateCase,loadDataset,modelInput,reviewView,validateRubric};
if(require.main===module){try{main(process.argv.slice(2));}catch(error){console.error(error.message);process.exitCode=1;}}
