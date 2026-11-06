'use strict';
// Portable stream evaluation. Only an explicitly selected adapter knows product modules.
const fs=require('node:fs'),path=require('node:path');
const {hash,visibleOutput}=require('./eval-replay.cjs');
const {httpBudget,exhausted}=require('./eval-http-budget.cjs');
const POLICY='raw-stream-replay-v1',CONDITION='scheduled_idle_public_memory_observation_v1';
const DEFAULT_CASES=path.resolve(__dirname,'../evals/assistant-stream/cases.jsonl');
const SEED_PROVENANCE_REVISION='local-seed-source-sha256-v2-2026-11-05';
const FOREGROUND_TIMEOUT_MS=300000;
const clone=value=>structuredClone(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function eventTime(value){
 const match=typeof value==='string'&&/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match)return NaN;
 const [,year,month,day,hour,minute,second,zone]=match,[y,m,d,h,min,s]=[year,month,day,hour,minute,second].map(Number);
 if(m<1||m>12||d<1||d>new Date(Date.UTC(y,m,0)).getUTCDate()||h>23||min>59||s>59||zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4))>59))return NaN;
 return Date.parse(value);
}
function validateStreamCase(item){
 const errors=[],error=(where,message)=>errors.push(`${where}: ${message}`);
 const fields=(value,allowed,where)=>{if(!object(value)){error(where,'expected object');return false;}for(const key of Object.keys(value))if(!allowed.includes(key))error(`${where}.${key}`,'unknown field');return true;};
 const nonempty=(value,where)=>{if(typeof value!=='string'||!value.trim())error(where,'expected nonempty string');};
 if(!fields(item,['schema_version','policy_version','id','family_id','start_at','runtime_goal','seed','events','reviewer_only','limitations'],'case'))return errors;
 if(item.schema_version!==1||item.policy_version!==POLICY)error('case','unsupported schema or policy');
 for(const key of ['id','family_id','runtime_goal'])nonempty(item[key],key);
 if(!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(item.id||''))error('id','invalid artifact-safe ID');
 let previous=eventTime(item.start_at);if(!Number.isFinite(previous))error('start_at','expected valid timezone-aware timestamp');
 if(!fields(item.seed,['kind','source','source_sha256','case_id','raw_ids','adaptation'],'seed'))return errors;
 for(const key of ['kind','source','case_id'])nonempty(item.seed[key],`seed.${key}`);
 if(item.seed.source_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(item.seed.source_sha256))error('seed.source_sha256','expected lowercase SHA-256');
 if(item.seed.raw_ids!==undefined&&(!Array.isArray(item.seed.raw_ids)||!item.seed.raw_ids.length||item.seed.raw_ids.some(id=>typeof id!=='string'||!id.trim())||new Set(item.seed.raw_ids).size!==item.seed.raw_ids.length))error('seed.raw_ids','expected distinct nonempty original IDs');
 if(!Array.isArray(item.limitations)||!item.limitations.length||item.limitations.some(v=>typeof v!=='string'||!v.trim()))error('limitations','at least one explicit evidence limitation is required');
 if(!object(item.reviewer_only))error('reviewer_only','expected separate review criteria');
 if(!Array.isArray(item.events)||!item.events.length){error('events','at least one event is required');return errors;}
 const ids=new Set(),sources=new Map(),withdrawn=new Set(),requests=new Set();let requestCount=0;
 const common=['id','kind','at'];
 const extra={qq:['speaker','text'],user_request:['text','reply_to_event_id'],note:['text','declared_use','note_kind','evidence_source_ids'],control:['controls'],source_update:['source_id','channel','operation'],idle:['wall_timeout_ms']};
 item.events.forEach((event,index)=>{
  const p=`events[${index}]`;
  if(!object(event)||!Object.hasOwn(extra,event.kind)){error(p,'expected qq|user_request|note|control|source_update|idle; authored assistant/context seeds are forbidden');return;}
  if(!fields(event,[...common,...extra[event.kind]],p))return;
  nonempty(event.id,`${p}.id`);if(ids.has(event.id))error(`${p}.id`,'duplicate event/source ID');ids.add(event.id);
  const at=eventTime(event.at);if(!Number.isFinite(at)||at<previous)error(`${p}.at`,'invalid or nonchronological timestamp');previous=at;
  if(['qq','user_request','note'].includes(event.kind))nonempty(event.text,`${p}.text`);
  if(event.kind==='qq'){
   if(!['self','contact'].includes(event.speaker))error(`${p}.speaker`,'expected self|contact');sources.set(event.id,'qq');
  }else if(event.kind==='user_request'){
   if(event.reply_to_event_id!==undefined&&!requests.has(event.reply_to_event_id))error(`${p}.reply_to_event_id`,'feedback must name an earlier runtime request event');
   requests.add(event.id);sources.set(event.id,'private');requestCount++;
  }else if(event.kind==='note'){
   if(event.declared_use!==undefined&&!['discussion','draft'].includes(event.declared_use))error(`${p}.declared_use`,'expected discussion|draft');
   if(event.note_kind!==undefined&&!['material','preference'].includes(event.note_kind))error(`${p}.note_kind`,'expected material|preference');
   if(event.evidence_source_ids!==undefined&&(!Array.isArray(event.evidence_source_ids)||new Set(event.evidence_source_ids).size!==event.evidence_source_ids.length||event.evidence_source_ids.some(id=>!sources.has(id)||withdrawn.has(id))))error(`${p}.evidence_source_ids`,'expected distinct, still-available original source IDs');
   sources.set(event.id,'note');
  }else if(event.kind==='control'){
   if(fields(event.controls,['automatic','goal'],`${p}.controls`)){
    if(!Object.keys(event.controls).length)error(`${p}.controls`,'empty control');
    if(event.controls.automatic!==undefined&&typeof event.controls.automatic!=='boolean')error(`${p}.controls.automatic`,'expected boolean');
    if(event.controls.goal!==undefined)nonempty(event.controls.goal,`${p}.controls.goal`);
   }
  }else if(event.kind==='source_update'){
   if(!sources.has(event.source_id)||sources.get(event.source_id)!==event.channel)error(`${p}.source_id`,'unknown source or mismatched channel');
   if(!['delete','exclude','recall'].includes(event.operation)||event.operation==='recall'&&event.channel!=='qq'||event.operation==='delete'&&event.channel==='qq')error(`${p}.operation`,'unsupported observed source operation');
   withdrawn.add(event.source_id);
  }else if(!Number.isSafeInteger(event.wall_timeout_ms)||event.wall_timeout_ms<1||event.wall_timeout_ms>65000)error(`${p}.wall_timeout_ms`,'idle native deadline must be 1..65000ms');
 });
 if(!requestCount)error('events','at least one actual runtime user request is required');
 return errors;
}
function runtimeCase(item){
 return {id:item.id,start_at:item.start_at,runtime_goal:item.runtime_goal,events:item.events.map(event=>clone(event))};
}
function verifySeedProvenance(item,seedRoot){
 const seed=item.seed;
 // Historical pilot bytes remain readable, but never gain an invented hash.
 if(seed.source_sha256===undefined)return {case_id:item.id,status:'legacy_unattested',source:seed.source,reason:'Frozen seed metadata did not record source bytes.'};
 const root=fs.realpathSync(seedRoot),allowed=path.join(root,'evals')+path.sep,target=path.resolve(root,seed.source);
 if(path.isAbsolute(seed.source)||!target.startsWith(allowed)||!target.endsWith('.jsonl'))throw Error(`${item.id}: seed source must be a local evals/**/*.jsonl file`);
 const real=fs.realpathSync(target);if(!real.startsWith(allowed))throw Error(`${item.id}: seed source resolves outside the evaluation tree`);
 const raw=fs.readFileSync(real),actual=hash(raw.toString());if(actual!==seed.source_sha256)throw Error(`${item.id}: seed source SHA-256 mismatch`);
 const rows=raw.toString().split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line)),original=rows.find(row=>row.id===seed.case_id);
 if(!original)throw Error(`${item.id}: cited seed case does not exist`);
 const initial=original.initial||{},context=original.initial_context||{},steps=original.steps||[];
 const originals=[...(initial.qq_events||[]),...(initial.private_events||[]),...(context.qq_history||[]),...(context.private_discussion||[]),...(context.notes||[]),
  ...steps.flatMap(step=>[...(step.qq_events||step.qq_updates||[]),...(step.private_events||step.private_updates||[]),...(step.request?[step.request]:[])])];
 const ids=new Set(originals.map(event=>event.id));for(const id of seed.raw_ids||[])if(!ids.has(id))throw Error(`${item.id}: cited original seed ID does not exist: ${id}`);
 return {case_id:item.id,status:'verified',source:seed.source,source_sha256:actual,seed_case_id:seed.case_id,raw_ids:clone(seed.raw_ids||[]),scope:'file bytes, cited case and source IDs; semantic adaptation reviewed separately'};
}
function loadStreamCases(filename=DEFAULT_CASES,{seedRoot=path.resolve(__dirname,'..')}={}){
 const raw=fs.readFileSync(filename,'utf8'),cases=raw.split(/\r?\n/).filter(line=>line.trim()).map((line,index)=>{
  let item;try{item=JSON.parse(line);}catch(error){throw Error(`${filename}:${index+1}: ${error.message}`);}
  const errors=validateStreamCase(item);if(errors.length)throw Error(`${filename}:${index+1}: ${errors.join('; ')}`);return item;
 });
 if(!cases.length||new Set(cases.map(item=>item.id)).size!==cases.length)throw Error('Stream cases must be nonempty and have distinct IDs');
 const records=cases.map(item=>verifySeedProvenance(item,seedRoot));
 return {cases,datasetHash:hash(raw),policyVersion:POLICY,seedProvenance:{revision:SEED_PROVENANCE_REVISION,status:records.every(record=>record.status==='verified')?'verified':'contains_legacy_unattested',records}};
}
function errorInfo(error){return {code:error?.code||'stream_adapter_error',message:String(error?.message||error).slice(0,1500)};}
async function bounded(fn,timeoutMs,label){
 let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Error(`${label} exceeded ${timeoutMs}ms wall deadline`);error.code='stream_wall_timeout';reject(error);},timeoutMs);})]);}finally{clearTimeout(timer);}
}
async function runStreamEpisode({item,adapter,identity={},onRecord=()=>{},eventTimeoutMs=FOREGROUND_TIMEOUT_MS}){
 const errors=validateStreamCase(item);if(errors.length)throw Error(errors.join('\n'));
 if(!Number.isSafeInteger(eventTimeoutMs)||eventTimeoutMs<1||eventTimeoutMs>3600000)throw Error('eventTimeoutMs must be 1..3600000');
 if(adapter?.protocol_version!==1)throw Error('Unsupported streaming adapter protocol; expected protocol_version 1');
 for(const name of ['open','advanceTo','observe','observePrivate','respond','close'])if(typeof adapter?.[name]!=='function')throw Error(`Stream adapter requires ${name}()`);
 const plan=runtimeCase(item),started=Date.now(),replyByEvent=new Map();
 const result={schema_version:1,policy_version:POLICY,case_id:item.id,input_hash:hash(plan),identity:clone(identity),adapter_identity:clone(adapter.identity||{}),
  setting:'stream_from_empty',semantic_evaluation:'not_run',status:'running',goal:plan.runtime_goal,
  initial:{as_of:plan.start_at,qq_events:[],private_events:[]},events:[],memory_observation_status:'not_observed',
  setting_receipt:{scope:'backend_e2e_stream_with_declared_adapter_boundaries',empty_open_payload:true,archived_assistant_turns:0,derived_memory_seeded_by_runner:false,entire_history_reexecuted:false,
   input_attestation_scope:'runner-supplied inputs; adapter preparation and trace attest implementation-side restoration separately',
   event_clock:'authored_virtual_time',provider_clock:'native_adapter_deadlines',ordinary_actions:'foreground_wait_only_when_adapter_supports_declared_condition',idle:'explicit_idleUntil_only',
   concurrency_tested:false,desktop_qq_tested:false,persistence_restart_tested:false,semantic_quality:'not_evaluated'}};
 const record=async()=>onRecord(clone(result));
 const diagnose=async target=>{if(typeof adapter.diagnostics!=='function')return;try{target.diagnostics=clone(await bounded(()=>adapter.diagnostics(),1000,'optional diagnostics'));}catch(error){target.diagnostics_error=errorInfo(error);}};
 const view=async target=>{if(typeof adapter.publicMemoryView!=='function')return;try{target.memory_view=clone(await bounded(()=>adapter.publicMemoryView(),2000,'public memory view'));}catch(error){target.memory_view_error=errorInfo(error);}};
 const drain=async(target,phase)=>{
  if(typeof adapter.drainOutputs!=='function')return;
  const outputs=await bounded(()=>adapter.drainOutputs(),eventTimeoutMs,'visible-output drain');if(!Array.isArray(outputs))throw Error('Adapter drainOutputs must return an array');
  for(const output of outputs)target.observed_outputs.push({phase,created_at:typeof output?.created_at==='string'?output.created_at:null,output:visibleOutput(output)});
 };
 try{
  await bounded(()=>adapter.open(clone(result.initial),{goal:plan.runtime_goal}),eventTimeoutMs,'empty stream open');
  const first={};await diagnose(first);if(first.diagnostics)result.initial_diagnostics=first.diagnostics;if(first.diagnostics_error)result.initial_diagnostics_error=first.diagnostics_error;
  await record();
  for(const event of plan.events){
   const entry={id:event.id,kind:event.kind,at:event.at,input:clone(event),status:'running',output:null,observed_outputs:[]};result.events.push(entry);await record();
   const begin=Date.now();entry.wall_timeout_ms=event.kind==='idle'?event.wall_timeout_ms:eventTimeoutMs;
   const action=async(fn,label)=>{const remaining=begin+eventTimeoutMs-Date.now();if(remaining<=0){const error=Error(`Stream event ${event.id} exceeded its foreground wall deadline`);error.code='stream_wall_timeout';throw error;}return bounded(fn,remaining,label);};
   try{
    if(event.kind==='idle'){
     if(typeof adapter.idleUntil!=='function')throw Error('Stream idle requires an explicit adapter idleUntil boundary');
     entry.checkpoint=clone(await bounded(()=>adapter.idleUntil(event.at,{wallTimeoutMs:event.wall_timeout_ms}),event.wall_timeout_ms+2000,'declared idle observation'));
     await drain(entry,'idle_completed');await view(entry);
    }else{
     await action(()=>adapter.advanceTo(event.at),'event time advance');await action(()=>drain(entry,'before_external_event'),'pre-event visible outputs');
     if(event.kind==='qq')await action(()=>adapter.observe([{id:event.id,at:event.at,speaker:event.speaker,text:event.text,provenance:'authored_external_qq'}]),'QQ observation');
     else if(event.kind==='note'){
      const note={id:event.id,at:event.at,role:'user',text:event.text,provenance:'authored_user_note',declared_use:event.declared_use||'discussion',note_kind:event.note_kind||'material',evidence_source_ids:event.evidence_source_ids||[]};
      entry.intermediate_outputs=(await action(()=>adapter.observePrivate([note]),'authored user note')||[]).map(visibleOutput);
     }else if(event.kind==='control'){
      if(typeof adapter.configure!=='function')throw Error('Stream control requires adapter.configure');
      await action(()=>adapter.configure(clone(event.controls)),'observed user control');
     }else if(event.kind==='source_update'){
      if(typeof adapter.withdrawSources!=='function')throw Error('Stream source update requires adapter.withdrawSources');
      await action(()=>adapter.withdrawSources([{id:event.source_id,at:event.at,channel:event.channel,operation:event.operation}]),'observed source update');
     }else{
      const request={id:event.id,at:event.at,text:event.text};
      if(event.reply_to_event_id){const replyId=replyByEvent.get(event.reply_to_event_id);if(!replyId)throw Error('Feedback target has no actual earlier runtime reply ID');request.reference={reply_id:replyId};entry.feedback_binding={event_id:event.reply_to_event_id,reply_id:replyId,status:'bound'};}
      entry.output=visibleOutput(await action(()=>adapter.respond(request),'actual user request'));
      if(!entry.output)throw Error('No completed visible response for the fixed stream request');
      if(entry.output.reply_id)replyByEvent.set(event.id,entry.output.reply_id);
      await view(entry);
     }
     await action(()=>drain(entry,'external_event_applied'),'post-event visible outputs');
    }
    entry.status='executed_review_required';await diagnose(entry);
   }catch(error){entry.status='execution_error';entry.error=errorInfo(error);await diagnose(entry);throw error;}
   finally{entry.wall_elapsed_ms=Date.now()-begin;await record();}
  }
  result.status='executed_review_required';result.setting_receipt.entire_history_reexecuted=true;
 }catch(error){result.status='incomplete';result.error=errorInfo(error);await diagnose(result);}
 finally{
  const final={};await diagnose(final);if(final.diagnostics)result.terminal_diagnostics=final.diagnostics;if(final.diagnostics_error)result.terminal_diagnostics_error=final.diagnostics_error;
  try{result.cleanup=clone(await bounded(()=>adapter.close(),5000,'stream cleanup'));}catch(error){result.cleanup_error=errorInfo(error);result.status='incomplete';}
  result.unexecuted_events=plan.events.filter(event=>!result.events.some(done=>done.id===event.id)).map(event=>event.id);
  const idle=result.events.filter(event=>event.kind==='idle');result.memory_observation_status=!idle.length?'not_observed':idle.some(event=>event.checkpoint?.status!=='complete')?'incomplete':'complete';
  result.setting_receipt.runtime_assistant_outputs=result.events.reduce((n,event)=>n+(event.output?1:0)+event.observed_outputs.length+(event.intermediate_outputs?.length||0),0);
  result.wall_elapsed_ms=Date.now()-started;await record();
 }
 return result;
}
function reviewPacket(item,result){
 if(result.case_id!==item.id||result.input_hash!==hash(runtimeCase(item)))throw Error('Stream review input identity mismatch');
 const {initial_diagnostics,initial_diagnostics_error,terminal_diagnostics,terminal_diagnostics_error,diagnostics,diagnostics_error,cleanup,...publicResult}=result;
 const publicEvent=({diagnostics,diagnostics_error,...event})=>{
  const view=clone(event);
  if(view.checkpoint){const {pending_tasks,failures,...checkpoint}=view.checkpoint;view.checkpoint=checkpoint;}
  return view;
 };
 return {...clone(publicResult),...(cleanup?.status?{cleanup_status:cleanup.status}:{}),events:result.events.map(publicEvent),reviewer_only:clone(item.reviewer_only),
  limitations:clone(item.limitations),review:{status:'not_run',ratings:null,critical_failures:[],notes:[]}};
}
function argumentsFor(argv){
 const options={};for(let i=0;i<argv.length;i++){
  const name=argv[i];if(['--check','--list','--all','--live','--continue-on-case-error','--unlimited-http'].includes(name)){options[name.slice(2)]=true;continue;}
  if(!['--cases','--adapter','--id','--out','--source-root','--settings-file','--max-http','--event-timeout-ms'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(`Invalid stream option ${name}`);
  options[name.slice(2)]=argv[++i];
 }
 if(options['unlimited-http']&&options['max-http']!==undefined)throw Error('Choose either --unlimited-http or --max-http');
 if(options.live&&!options.check&&!options.list&&(!options['settings-file']||options['max-http']===undefined&&!options['unlimited-http']))throw Error('Live stream replay requires explicit --settings-file and --max-http or --unlimited-http');
 return options;
}
async function main(argv,{log=console.log}={}){
 const options=argumentsFor(argv),dataset=loadStreamCases(options.cases||DEFAULT_CASES);
 if(options.check||options.list||!options.id&&!options.all){log(JSON.stringify({status:options.check?'valid':'inventory',policy_version:POLICY,dataset_hash:dataset.datasetHash,inference:'not_run',
  seed_provenance:dataset.seedProvenance,
  cases:dataset.cases.map(item=>({id:item.id,family_id:item.family_id,events:item.events.length,requests:item.events.filter(e=>e.kind==='user_request').length})),evidence:'visible fictional development streams; no quality rating'},null,2));return;}
 if(!options.adapter||!options.out)throw Error('Stream replay requires explicit --adapter and new --out');
 const selected=options.all?dataset.cases:options.id.split(',').map(id=>{const item=dataset.cases.find(c=>c.id===id);if(!item)throw Error(`Unknown stream case ${id}`);return item;});
 if(new Set(selected.map(item=>item.id)).size!==selected.length)throw Error('Duplicate selected stream case');
 const budget=httpBudget({unlimitedHttp:options['unlimited-http']===true,maxHttp:options['max-http']===undefined?undefined:Number(options['max-http']),label:'Stream HTTP'}),cap=budget.cap;
 const eventTimeoutMs=options['event-timeout-ms']===undefined?FOREGROUND_TIMEOUT_MS:Number(options['event-timeout-ms']);if(!Number.isSafeInteger(eventTimeoutMs)||eventTimeoutMs<1||eventTimeoutMs>3600000)throw Error('event timeout must be 1..3600000');
 const output=path.resolve(options.out);if(fs.existsSync(output)||output.split(path.sep).some(part=>['.git','data'].includes(part)))throw Error('Stream output directory must be new and outside private data/Git metadata');
 const adapterFile=fs.realpathSync(path.resolve(options.adapter));
 const identity={dataset_hash:dataset.datasetHash,policy_version:POLICY,setting:'stream_from_empty',adapter_condition:CONDITION,
  seed_provenance_revision:SEED_PROVENANCE_REVISION,seed_provenance_hash:hash(dataset.seedProvenance),
  runner_hash:hash(fs.readFileSync(__filename,'utf8')),portable_projection_hash:hash(fs.readFileSync(require.resolve('./eval-replay.cjs'),'utf8')),adapter_hash:hash(fs.readFileSync(adapterFile,'utf8')),global_http_cap:cap,...(budget.unlimited?{unlimited_http:true}:{}),event_wall_timeout_ms:eventTimeoutMs};
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 let factory;
 const write=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(factory?.redact?factory.redact(value):value,null,2),{mode:0o600});
 const manifest={schema_version:1,identity,adapter:{},selected_cases:selected.map(item=>item.id),status:'initializing',semantic_evaluation:'not_run',episodes:[]};write('manifest.json',manifest);
 try{factory=await bounded(()=>require(adapterFile).createAdapterFactory({live:options.live===true,sourceRoot:options['source-root'],settingsFile:options['settings-file'],maxHttp:budget.unlimited?undefined:cap,unlimitedHttp:budget.unlimited,condition:CONDITION}),eventTimeoutMs,'stream adapter factory');if(typeof factory?.create!=='function')throw Error('Stream adapter factory must expose create()');if(budget.unlimited&&(factory.identity?.unlimited_http!==true||factory.identity?.max_http!==null))throw Error('Stream adapter must explicitly declare unlimited HTTP mode');}
 catch(error){manifest.status='incomplete';manifest.error=errorInfo(error);manifest.unexecuted_cases=selected.map(item=>item.id);write('manifest.json',manifest);log(JSON.stringify({status:'incomplete',artifacts:output,error:manifest.error,unexecuted_cases:manifest.unexecuted_cases,semantic_evaluation:'not_run'},null,2));process.exitCode=1;return;}
 manifest.adapter=factory.identity||{};manifest.status='running';write('manifest.json',manifest);
 for(const item of selected){let result;
  try{const adapter=await bounded(()=>factory.create(),eventTimeoutMs,'stream adapter creation');result=await runStreamEpisode({item,adapter,identity,eventTimeoutMs,onRecord:value=>write(`${item.id}.run.json`,value)});}
  catch(error){result={schema_version:1,case_id:item.id,input_hash:hash(runtimeCase(item)),identity,status:'incomplete',semantic_evaluation:'not_run',events:[],unexecuted_events:item.events.map(e=>e.id),error:errorInfo(error)};write(`${item.id}.run.json`,result);}
  write(`${item.id}.review.json`,reviewPacket(item,result));
  const preparation=result.initial_diagnostics?.preparation||result.diagnostics?.preparation||result.terminal_diagnostics?.preparation;if(preparation)write(`${item.id}.preparation.json`,preparation);
  manifest.episodes.push({id:item.id,status:result.status,memory_observation_status:result.memory_observation_status||'not_observed',events:result.events.map(e=>({id:e.id,status:e.status})),unexecuted_events:result.unexecuted_events||[],...(result.error?{error:result.error}:{})});
  write('transport.json',factory.summary?.()||{});write('manifest.json',manifest);
  if(result.status==='incomplete'&&!options['continue-on-case-error']||exhausted(factory.summary?.().http_attempts,budget))break;
 }
 manifest.unexecuted_cases=selected.map(item=>item.id).filter(id=>!manifest.episodes.some(done=>done.id===id));manifest.status=manifest.unexecuted_cases.length||manifest.episodes.some(e=>e.status==='incomplete')?'incomplete':'executed_review_required';write('manifest.json',manifest);
 log(JSON.stringify({status:manifest.status,artifacts:output,episodes:manifest.episodes,unexecuted_cases:manifest.unexecuted_cases,semantic_evaluation:'not_run'},null,2));
 if(manifest.status==='incomplete')process.exitCode=1;
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={POLICY,CONDITION,validateStreamCase,runtimeCase,loadStreamCases,runStreamEpisode,reviewPacket,argumentsFor,main};
