'use strict';
// Supplemental raw-event observations. Product imports and memory formats stay
// behind the replaceable adapter; reviewer expectations never enter that adapter.
const fs=require('node:fs'),path=require('node:path');
const {hash,visibleOutput,preparationEvidence}=require('./eval-replay.cjs');
const DEFAULT_CASES=path.resolve(__dirname,'../evals/memory-understanding/cases.jsonl');
const POLICY='raw-memory-observation-v1';
const CONDITION='scheduled_idle_public_memory_observation_v1';
const FOREGROUND_TIMEOUT_MS=300000;
const clone=value=>structuredClone(value);
const inputFields=['id','at','speaker','role','text','provenance','declared_use','note_kind','evidence_source_ids','attachments'];
function stimulus(event){return Object.fromEntries(inputFields.filter(key=>Object.hasOwn(event,key)).map(key=>[key,clone(event[key])]));}
function runtimeCase(item){
 return {id:item.id,runtime_goal:item.runtime_goal,initial:{as_of:item.initial.as_of,qq_events:item.initial.qq_events.map(stimulus),private_events:item.initial.private_events.map(stimulus)},
  steps:item.steps.map(step=>({id:step.id,as_of:step.as_of,qq_events:step.qq_events.map(stimulus),private_events:step.private_events.map(stimulus),
   source_updates:clone(step.source_updates),request:stimulus(step.request),external_observation:clone(step.external_observation)}))};
}
function validateMemoryCase(item){
 if(!item||item.schema_version!==1||item.policy_version!==POLICY||!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(item.id)||typeof item.runtime_goal!=='string'||!item.runtime_goal.trim())throw Error('Invalid supplemental case identity, policy or goal');
 const time=value=>{if(typeof value!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('Supplemental timestamps must include timezone');return Date.parse(value);};
 const ids=new Set(),sources=new Map();
 const events=(list,lane,floor,ceiling)=>{
  if(!Array.isArray(list))throw Error('Supplemental event lanes must be arrays');let last=floor;
  for(const event of list){const at=time(event.at);
   if(typeof event.id!=='string'||!event.id||ids.has(event.id)||at<last||at>ceiling||typeof event.text!=='string')throw Error('Invalid, duplicate or nonchronological supplemental event');
   if(lane==='qq'&&!['self','contact'].includes(event.speaker)||lane==='private'&&!['user','assistant'].includes(event.role))throw Error('Invalid original event speaker');
   ids.add(event.id);sources.set(event.id,{at,channel:lane==='qq'?'qq':event.provenance==='authored_user_note'?'note':'private'});last=at;
  }
 };
 let previous=time(item.initial?.as_of);
 events(item.initial.qq_events,'qq',-Infinity,previous);events(item.initial.private_events,'private',-Infinity,previous);
 if(!Array.isArray(item.steps)||!item.steps.length)throw Error('Supplemental case requires steps');
 const stepIds=new Set();
 for(const step of item.steps){
  const at=time(step.as_of),observation=step.external_observation;
  if(typeof step.id!=='string'||!step.id||stepIds.has(step.id)||at<previous||time(step.request?.at)!==at||typeof step.request?.text!=='string'||!step.request.text.trim()||ids.has(step.request.id))throw Error('Invalid supplemental step/request clock or identity');
  stepIds.add(step.id);
  if(!observation||!Number.isSafeInteger(observation.user_quiet_ms)||observation.user_quiet_ms<0||observation.user_quiet_ms>86400000||!Number.isSafeInteger(observation.wall_timeout_ms)||observation.wall_timeout_ms<1||observation.wall_timeout_ms>65000||JSON.stringify(observation.before_request)!=='["visible_memory"]'||JSON.stringify(observation.after_request)!=='["assistant_answer","visible_memory_after_idle"]')throw Error('Unsupported declared external observation');
  events(step.qq_events,'qq',previous,at);events(step.private_events,'private',previous,at);
  if(step.private_events.some(event=>event.role!=='user'))throw Error('Step assistant outputs must come from the actual product');
  if(!Array.isArray(step.source_updates))throw Error('Supplemental source updates must be an array');
  let latest=previous;
  for(const event of [...step.qq_events,...step.private_events])latest=Math.max(latest,time(event.at));
  for(const update of step.source_updates){const source=sources.get(update.id),when=time(update.at);
   if(!source||source.channel!==update.channel||when<previous||when>at||!['delete','exclude','recall'].includes(update.operation)||update.operation==='recall'&&update.channel!=='qq'||update.operation==='delete'&&update.channel==='qq')throw Error('Invalid supplemental source update');
   latest=Math.max(latest,when);
  }
  if(at-observation.user_quiet_ms<latest)throw Error('Declared before-request quiet interval overlaps raw observations or the preceding observation');
  ids.add(step.request.id);sources.set(step.request.id,{at,channel:'private'});
  previous=at+observation.user_quiet_ms;
 }
 return item;
}
function loadMemoryCases(filename=DEFAULT_CASES){
 const raw=fs.readFileSync(filename,'utf8'),cases=raw.split(/\r?\n/).filter(line=>line.trim()).map(line=>validateMemoryCase(JSON.parse(line)));
 if(new Set(cases.map(item=>item.id)).size!==cases.length)throw Error('Duplicate supplemental case IDs');
 return {cases,datasetHash:hash(raw),policyVersion:POLICY};
}
const errorInfo=error=>({code:error.code||'observation_error',message:String(error.message||error).slice(0,1500)});
async function bounded(fn,timeoutMs){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Error(`Supplemental observation exceeded ${timeoutMs}ms wall deadline`);error.code='observation_timeout';reject(error);},timeoutMs);})]);}finally{clearTimeout(timer);}}
async function runMemoryEpisode({item,adapter,identity={},onRecord=()=>{}}){
 validateMemoryCase(item);
 for(const method of ['open','advanceTo','idleUntil','observe','observePrivate','withdrawSources','respond','publicMemoryView','close'])if(typeof adapter?.[method]!=='function')throw Error(`Memory observation adapter requires ${method}()`);
 if(adapter.identity?.foreground_wall_timeout_ms!==undefined&&adapter.identity.foreground_wall_timeout_ms!==FOREGROUND_TIMEOUT_MS)throw Error('Adapter and runner foreground observation bounds differ');
 const plan=runtimeCase(item),started=Date.now(),result={schema_version:1,case_id:item.id,input_hash:hash(plan),identity:{...clone(identity),condition:CONDITION,foreground_wall_timeout_ms:FOREGROUND_TIMEOUT_MS},adapter_identity:clone(adapter.identity||{}),
  policy_version:POLICY,condition:CONDITION,foreground_wall_timeout_ms:FOREGROUND_TIMEOUT_MS,status:'running',semantic_evaluation:'not_run',initial:plan.initial,goal:plan.runtime_goal,steps:[]};
 const record=()=>onRecord(clone(result));
 const diagnostics=async target=>{if(adapter.diagnostics)try{target.diagnostics=clone(await bounded(()=>adapter.diagnostics(),1000));}catch(error){target.diagnostics_error=errorInfo(error);}};
 try{
  await bounded(()=>adapter.open(clone(plan.initial),{goal:plan.runtime_goal}),FOREGROUND_TIMEOUT_MS);
  const prepared={};await diagnostics(prepared);
  if(prepared.diagnostics)result.initial_diagnostics=prepared.diagnostics;
  if(prepared.diagnostics_error)result.initial_diagnostics_error=prepared.diagnostics_error;
  result.initial_memory=clone(await bounded(()=>adapter.publicMemoryView(),1000));await record();
  for(const step of plan.steps){
   const entry={id:step.id,as_of:step.as_of,input:clone(step),status:'running',output:null,observed_outputs:[],memory_observations:[]};result.steps.push(entry);await record();
   const timeout=step.external_observation.wall_timeout_ms,quiet=step.external_observation.user_quiet_ms;
   const drain=async phase=>{if(adapter.drainOutputs)for(const output of await bounded(()=>adapter.drainOutputs(),FOREGROUND_TIMEOUT_MS))entry.observed_outputs.push({phase,output:visibleOutput(output)});};
   const observe=async(phase,checkpoint)=>{const view=await bounded(()=>adapter.publicMemoryView(),2000);entry.memory_observations.push({phase,...(checkpoint?{checkpoint:clone(checkpoint)}:{}),view:clone(view)});await record();};
   const advance=async(at,phase)=>{const begin=Date.now();await bounded(()=>adapter.advanceTo(at),FOREGROUND_TIMEOUT_MS);entry.clock_advances=[...(entry.clock_advances||[]),{phase,to:at,wall_elapsed_ms:Date.now()-begin,wall_timeout_ms:FOREGROUND_TIMEOUT_MS}];await drain(phase);};
   const idle=async(at,phase)=>{const checkpoint=await bounded(()=>adapter.idleUntil(at,{wallTimeoutMs:timeout}),timeout+2000);entry.clock_advances=[...(entry.clock_advances||[]),{phase,to:at,checkpoint:clone(checkpoint)}];await drain(phase);return checkpoint;};
   try{
    const events=[...step.qq_events.map(event=>({lane:'qq',event})),...step.private_events.map(event=>({lane:'private',event})),...step.source_updates.map(event=>({lane:'source_update',event}))].sort((a,b)=>Date.parse(a.event.at)-Date.parse(b.event.at));
    for(const {lane,event}of events){await advance(event.at,'external_event_time');
     if(lane==='qq')await bounded(()=>adapter.observe([clone(event)]),FOREGROUND_TIMEOUT_MS);
     else if(lane==='private')entry.intermediate_outputs=[...(entry.intermediate_outputs||[]),...((await bounded(()=>adapter.observePrivate([clone(event)]),FOREGROUND_TIMEOUT_MS))||[]).map(visibleOutput)];
     else await bounded(()=>adapter.withdrawSources([clone(event)]),FOREGROUND_TIMEOUT_MS);
     await drain('external_event_applied');
    }
    await advance(new Date(Date.parse(step.as_of)-quiet).toISOString(),'before_idle_start');await observe('before_user_idle');
    const before=await idle(step.as_of,'before_request_idle');await observe('before_request',before);
    const requestStarted=Date.now();entry.request_receipt={request_id:step.request.id,at:step.request.at,status:'running',wall_started_at:new Date(requestStarted).toISOString(),wall_timeout_ms:FOREGROUND_TIMEOUT_MS};await record();
    try{entry.output=visibleOutput(await bounded(()=>adapter.respond(clone(step.request)),FOREGROUND_TIMEOUT_MS));entry.request_receipt.status='completed';}
    catch(error){entry.request_receipt.status='failed';entry.request_receipt.error=errorInfo(error);throw error;}
    finally{entry.request_wall_elapsed_ms=Date.now()-requestStarted;entry.request_receipt.wall_elapsed_ms=entry.request_wall_elapsed_ms;}
    if(!entry.output)throw Error('No completed visible response for supplemental request');
    await observe('after_request');await drain('request_completed');
    const after=await idle(new Date(Date.parse(step.as_of)+quiet).toISOString(),'after_request_idle');await observe('after_request_idle',after);
    entry.memory_observation_status=[before,after].every(checkpoint=>checkpoint.status==='complete')?'complete':'incomplete';entry.status='executed_review_required';await diagnostics(entry);
   }catch(error){entry.status='execution_error';entry.error=errorInfo(error);await diagnostics(entry);throw error;}
   finally{await record();}
  }
  result.status='executed_review_required';result.memory_observation_status=result.steps.every(step=>step.memory_observation_status==='complete')?'complete':'incomplete';
 }catch(error){result.status='incomplete';result.error=errorInfo(error);await diagnostics(result);}
 finally{
  try{result.cleanup=await bounded(()=>adapter.close(),5000);}catch(error){result.cleanup_error=errorInfo(error);result.status='incomplete';}
  result.unexecuted_steps=plan.steps.filter(step=>!result.steps.some(done=>done.id===step.id)).map(step=>step.id);result.wall_elapsed_ms=Date.now()-started;await record();
 }
 return result;
}
function argumentsFor(argv){const options={};for(let i=0;i<argv.length;i++){const key=argv[i];if(['--list','--all','--live','--continue-on-case-error','--unlimited-http'].includes(key)){options[key.slice(2)]=true;continue;}if(!['--adapter','--source-root','--settings-file','--cases','--id','--out','--max-http'].includes(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(`Invalid supplemental observation option ${key}`);options[key.slice(2)]=argv[++i];}return options;}
async function main(argv){
 const options=argumentsFor(argv),dataset=loadMemoryCases(options.cases||DEFAULT_CASES);
 if(options['unlimited-http']&&options['max-http']!==undefined)throw Error('Choose either --unlimited-http or --max-http');
 if(options.list||!options.id&&!options.all){console.log(JSON.stringify({status:'inventory',dataset_hash:dataset.datasetHash,policy_version:POLICY,cases:dataset.cases.map(item=>({id:item.id,steps:item.steps.length})),inference:'not_run'},null,2));return;}
 if(!options.adapter||!options.out)throw Error('Supplemental observations require explicit --adapter and new --out');
 const selected=options.all?dataset.cases:options.id.split(',').map(id=>{const item=dataset.cases.find(c=>c.id===id);if(!item)throw Error(`Unknown supplemental case ${id}`);return item;});
 if(new Set(selected.map(item=>item.id)).size!==selected.length)throw Error('Duplicate selected supplemental case');
 const adapterFile=fs.realpathSync(path.resolve(options.adapter)),factory=await require(adapterFile).createAdapterFactory({sourceRoot:options['source-root'],settingsFile:options['settings-file'],maxHttp:options['max-http']===undefined?undefined:Number(options['max-http']),unlimitedHttp:options['unlimited-http']===true,live:options.live===true,condition:CONDITION});
 if(options['unlimited-http']&&(factory.identity?.unlimited_http!==true||factory.identity?.max_http!==null))throw Error('Supplemental adapter must explicitly declare unlimited HTTP mode');
 if(factory.identity?.condition!==CONDITION||factory.identity?.foreground_wall_timeout_ms!==FOREGROUND_TIMEOUT_MS)throw Error('Supplemental observations require the explicit scheduled-idle condition and foreground bound');
 const output=path.resolve(options.out);if(fs.existsSync(output)||output.split(path.sep).some(part=>['.git','data'].includes(part)))throw Error('Observation output must be new and outside private data/Git metadata');fs.mkdirSync(output,{recursive:true,mode:0o700});
 const identity={dataset_hash:dataset.datasetHash,policy_version:POLICY,condition:CONDITION,foreground_wall_timeout_ms:FOREGROUND_TIMEOUT_MS,idle_outer_headroom_ms:2000,runner_hash:hash(fs.readFileSync(__filename,'utf8')),adapter_hash:hash(fs.readFileSync(adapterFile,'utf8'))};
 const write=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(factory.redact?factory.redact(value):value,null,2),{mode:0o600});
 const manifest={schema_version:1,identity,adapter:factory.identity||{},selected_cases:selected.map(item=>item.id),semantic_evaluation:'not_run',status:'running',episodes:[]};write('manifest.json',manifest);
 for(const item of selected){let result;
  try{result=await runMemoryEpisode({item,adapter:await factory.create(),identity,onRecord:value=>write(`${item.id}.run.json`,value)});}catch(error){result={case_id:item.id,input_hash:hash(runtimeCase(item)),identity,status:'incomplete',steps:[],unexecuted_steps:item.steps.map(s=>s.id),error:errorInfo(error),semantic_evaluation:'not_run'};write(`${item.id}.run.json`,result);}
  // The separate review artifact alone carries external expected understanding.
  const {diagnostics,initial_diagnostics,...publicResult}=result;
  write(`${item.id}.review.json`,{...publicResult,steps:result.steps.map(({diagnostics,...step})=>step),reviewer_only:clone(item.reviewer_only),review:{status:'not_run',ratings:null}});
  const preparation=preparationEvidence(result);if(preparation)write(`${item.id}.preparation.json`,preparation);
  manifest.episodes.push({id:item.id,status:result.status,memory_observation_status:result.memory_observation_status||'unrun',steps:result.steps.map(s=>({id:s.id,status:s.status,memory_observation_status:s.memory_observation_status||'unrun'})),...(result.error?{error:result.error}:{})});write('transport.json',factory.summary?.()||{});write('manifest.json',manifest);
  if(result.status==='incomplete'&&!options['continue-on-case-error']||factory.identity?.unlimited_http!==true&&Number.isSafeInteger(factory.identity?.max_http)&&factory.summary?.().http_attempts>=factory.identity.max_http)break;
 }
 manifest.unexecuted_cases=selected.map(item=>item.id).filter(id=>!manifest.episodes.some(done=>done.id===id));manifest.status=manifest.episodes.some(item=>item.status==='incomplete')||manifest.unexecuted_cases.length?'incomplete':'executed_review_required';manifest.memory_observation_status=manifest.unexecuted_cases.length||manifest.episodes.some(item=>item.memory_observation_status!=='complete')?'incomplete':'complete';write('manifest.json',manifest);
 console.log(JSON.stringify({status:manifest.status,memory_observation_status:manifest.memory_observation_status,artifacts:output,episodes:manifest.episodes,unexecuted_cases:manifest.unexecuted_cases,semantic_evaluation:'not_run'},null,2));if(manifest.status==='incomplete')process.exitCode=1;
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={loadMemoryCases,validateMemoryCase,runtimeCase,runMemoryEpisode,argumentsFor,main};
