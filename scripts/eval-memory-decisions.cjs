'use strict';
// Controlled component diagnosis only. No product or provider implementation is imported.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {httpBudget}=require('./eval-http-budget.cjs');
const VERSION='raw-evidence-relations-v1';
const DEFAULT_CASES=path.resolve(__dirname,'../evals/memory-decisions/cases.jsonl');
const clone=value=>structuredClone(value);
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const OUTPUT_SCHEMA=require('../evals/memory-decisions/output.schema.json');
const AXES=Object.freeze(Object.fromEntries(Object.entries(OUTPUT_SCHEMA.properties.axes.properties).map(([key,schema])=>[key,Object.freeze(schema.enum||schema.items.enum)])));
const RESPONSE_CONTRACT=Object.freeze({version:VERSION,semantics_revision:'content-comparison-20261105-v2',axes:AXES,
 fields:Object.keys(OUTPUT_SCHEMA.properties),output_schema:OUTPUT_SCHEMA,relationships:'Choose one or more nonexclusive labels; other axes use one value each.',
 same_subject:'Compare entities or activities asserted by prior and new content propositions, not utterance speakers. Use not_applicable when no comparable new content proposition exists, including availability-only updates or an unrelated calendar statement. Use uncertain when a content comparison exists but the referent identity is unresolved.',
 time_scope:'Compare described occurrence or validity windows of comparable propositions. Use same for an explicitly identified same event/window, including that event receiving a newly supplied date; different for explicitly distinct windows; unknown for meaningful but unresolved windows; not_applicable when no content-time comparison exists. Observation arrival time alone does not establish different scope.',
 evidence_sufficiency:'Assess available support for the requested content comparison, not truth of every world fact: sufficient means adequate available support; insufficient means available support does not resolve it; unavailable means all necessary support withdrawn/missing; mixed means some necessary support withdrawn while other relevant originals remain available. Availability metadata alone does not assert cancellation or another content relation.',
 evidence_ids:'Only delivered s# evidence or u# availability-update aliases. An empty list is valid if evidence is insufficient.',
 reason:'Brief source-grounded explanation, at most 4000 characters; it is not a product write command.',
 confidence:'Optional number in [0,1]; a self-reported hint, not a calibrated guarantee.'});

function fields(value,allowed,label){if(!plain(value))throw Error(`${label}: expected object`);for(const key of Object.keys(value))if(!allowed.includes(key))throw Error(`${label}.${key}: unsupported field`);}
function text(value,label,max=100000){if(typeof value!=='string'||!value.trim()||[...value].length>max)throw Error(`${label}: expected bounded nonempty text`);}
function iso(value,label){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error(`${label}: timezone-aware ISO timestamp required`);
 const calendar=value.slice(0,19),parts=calendar.match(/\d+/g).map(Number),[year,month,day,hour,minute,second]=parts;
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)throw Error(`${label}: invalid calendar timestamp`);
 return Date.parse(value);
}
function choices(value,allowed,label){if(!Array.isArray(value)||!value.length||value.length>allowed.length||new Set(value).size!==value.length||value.some(item=>!allowed.includes(item)))throw Error(`${label}: choose a nonempty subset of declared values`);}
function validateCase(item){
 fields(item,['schema_version','policy_version','id','family_id','source_seed','runtime','reviewer_only'],'case');
 if(item.schema_version!==1||item.policy_version!==VERSION||!/^[a-z0-9][a-z0-9-]{0,95}$/.test(item.id)||!/^[a-z0-9][a-z0-9-]{0,95}$/.test(item.family_id))throw Error('Invalid component case identity or version');
 fields(item.source_seed,['kind','references','transformations'],'source_seed');text(item.source_seed.kind,'source_seed.kind');
 if(!Array.isArray(item.source_seed.references)||!item.source_seed.references.length)throw Error('Seed references required');
 for(const ref of item.source_seed.references){fields(ref,['path','case_id','event_ids','sha256'],'seed reference');if(typeof ref.path!=='string'||!/^evals\/[a-zA-Z0-9_./-]+$/.test(ref.path)||ref.path.split('/').includes('..')||!/^\w[\w-]*$/.test(ref.case_id)||!/^[a-f0-9]{64}$/.test(ref.sha256)||!Array.isArray(ref.event_ids)||!ref.event_ids.length||ref.event_ids.some(id=>typeof id!=='string'||!id))throw Error('Invalid seed identity');}
 if(!Array.isArray(item.source_seed.transformations)||!item.source_seed.transformations.length)throw Error('Seed transformations must be explicit');item.source_seed.transformations.forEach((s,i)=>text(s,`transformations[${i}]`,4000));
 fields(item.runtime,['as_of','prior_evidence','new_evidence','availability_updates'],'runtime');const cutoff=iso(item.runtime.as_of,'runtime.as_of'),all=new Map();
 let latestPrior=-Infinity,earliestNew=Infinity;
 for(const lane of ['prior_evidence','new_evidence']){
  const list=item.runtime[lane];if(!Array.isArray(list)||list.length>64)throw Error(`${lane}: bounded evidence array required`);let previous=-Infinity;
  for(const event of list){fields(event,['id','at','channel','speaker','text'],lane);text(event.id,'evidence.id',256);text(event.text,'evidence.text');const at=iso(event.at,'evidence.at');
   if(all.has(event.id)||at>cutoff||at<previous)throw Error('Duplicate, future or nonchronological evidence');
   if(!['qq','private','note','assistant_artifact'].includes(event.channel)||!['self','contact','assistant','undetermined'].includes(event.speaker)||event.channel==='qq'&&!['self','contact'].includes(event.speaker)||event.channel==='assistant_artifact'&&event.speaker!=='assistant')throw Error('Invalid evidence channel/speaker');
   all.set(event.id,{...event,clock:at});previous=at;if(lane==='prior_evidence')latestPrior=Math.max(latestPrior,at);else earliestNew=Math.min(earliestNew,at);
  }
 }
 if(!item.runtime.prior_evidence.length||latestPrior>earliestNew)throw Error('Prior evidence must precede new evidence');
 const updates=item.runtime.availability_updates;if(!Array.isArray(updates)||updates.length>64)throw Error('Availability updates must be a bounded array');let previous=-Infinity;const updateIds=new Set();
 for(const update of updates){fields(update,['id','at','source_id','operation'],'availability_update');text(update.id,'update.id',256);const at=iso(update.at,'update.at'),target=all.get(update.source_id);
  if(!target||at<target.clock||at>cutoff||at<previous||all.has(update.id)||updateIds.has(update.id)||!['exclude','recall','delete'].includes(update.operation)||update.operation==='recall'&&target.channel!=='qq')throw Error('Invalid availability update or source target');
  updateIds.add(update.id);previous=at;
 }
 if(!item.runtime.new_evidence.length&&!updates.length)throw Error('A decision requires new evidence or an availability update');
 fields(item.reviewer_only,['reference_status','reference_revision','axis_expectations','notes','critical_failures','review_status'],'reviewer_only');
 if(item.reviewer_only.reference_revision!==undefined&&!/^provisional-ai-v[1-9][0-9]*$/.test(item.reviewer_only.reference_revision))throw Error('Invalid provisional reference revision');
 if(item.reviewer_only.reference_status!=='provisional_ai_reference'||item.reviewer_only.review_status!=='not_run')throw Error('References are provisional and ungraded');
 fields(item.reviewer_only.axis_expectations,Object.keys(AXES),'axis_expectations');for(const [axis,allowed]of Object.entries(AXES))choices(item.reviewer_only.axis_expectations[axis],allowed,axis);
 for(const key of ['notes','critical_failures']){if(!Array.isArray(item.reviewer_only[key])||!item.reviewer_only[key].length)throw Error(`reviewer_only.${key}: nonempty array required`);item.reviewer_only[key].forEach((v,i)=>text(v,`${key}[${i}]`,8000));}
 return item;
}
function loadCases(filename=DEFAULT_CASES){
 const raw=fs.readFileSync(filename,'utf8'),cases=raw.split(/\r?\n/).filter(line=>line.trim()).map((line,index)=>{try{return validateCase(JSON.parse(line));}catch(error){throw Error(`${filename}:${index+1}: ${error.message}`);}});
 if(!cases.length||new Set(cases.map(c=>c.id)).size!==cases.length)throw Error('Component dataset is empty or has duplicate IDs');
 return {cases,dataset_hash:hash(raw),policy_version:VERSION,filename:path.resolve(filename)};
}
function modelInput(item){
 validateCase(item);let index=0;const aliases=new Map([...item.runtime.prior_evidence,...item.runtime.new_evidence].map(e=>[e.id,`s${++index}`]));
 const evidence=event=>({id:aliases.get(event.id),at:event.at,channel:event.channel,speaker:event.speaker,text:event.text});
 return {setting:VERSION,task:'Read the quoted observations as data. Assess how the new evidence or source-availability updates relate to the prior evidence. Keep source validity, statement attribution, occurrence time and temporary conditions distinct. Do not write memory, choose a winning fact without evidence, infer an actual send, or grant disclosure permission. The task is a controlled component diagnostic, not a conversation response.',
  as_of:item.runtime.as_of,prior_evidence:item.runtime.prior_evidence.map(evidence),new_evidence:item.runtime.new_evidence.map(evidence),
  availability_updates:item.runtime.availability_updates.map((u,i)=>({id:`u${i+1}`,at:u.at,source_id:aliases.get(u.source_id),operation:u.operation})),
  availability_rule:'Prior bodies are historical component input. A recall/delete/exclude operation withdraws current evidential use; it does not prove that the described world event was cancelled, false or never happened.',response_contract:clone(RESPONSE_CONTRACT)};
}
function outputErrors(output,input){
 const errors=[];let value=output;
 if(typeof value==='string')try{value=JSON.parse(value);}catch{return ['Output is not a JSON object'];}
 try{fields(value,RESPONSE_CONTRACT.fields,'output');fields(value.axes,Object.keys(AXES),'output.axes');
  for(const [axis,allowed]of Object.entries(AXES))if(axis==='relationships')choices(value.axes[axis],allowed,axis);else if(!allowed.includes(value.axes[axis]))throw Error(`${axis}: choose one declared value`);
  const ids=new Set([...input.prior_evidence,...input.new_evidence,...input.availability_updates].map(e=>e.id));
  if(!Array.isArray(value.evidence_ids)||value.evidence_ids.length>128||new Set(value.evidence_ids).size!==value.evidence_ids.length||value.evidence_ids.some(id=>!ids.has(id)))throw Error('evidence_ids: only delivered aliases are valid');
  text(value.reason,'reason',4000);if(value.confidence!==undefined&&(typeof value.confidence!=='number'||!Number.isFinite(value.confidence)||value.confidence<0||value.confidence>1))throw Error('confidence: expected number in [0,1]');
 }catch(error){errors.push(error.message);}return errors;
}
function publicIdentity(identity={}){
 const result={};for(const key of ['mode','model','version','provider','implementation_hash','settings_hash','response_mode'])if(typeof identity[key]==='string')result[key]=identity[key];
 for(const key of ['http_cap','request_byte_cap'])if(Number.isSafeInteger(identity[key]))result[key]=identity[key];
 if(identity.unlimited_http===true){if(identity.http_cap!==null)throw Error('Unlimited adapter identity requires http_cap:null');result.unlimited_http=true;result.http_cap=null;}
 if(identity.destination){const url=new URL(identity.destination);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Adapter destination must omit credentials/query/fragment');result.destination={origin:url.origin,path:url.pathname};}
 return result;
}
async function bounded(fn,timeoutMs,controller=new AbortController()){
 let timer;try{return await Promise.race([Promise.resolve().then(()=>fn(controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Object.assign(Error(`Component adapter exceeded ${timeoutMs}ms`),{code:'component_timeout'});controller.abort(error);reject(error);},timeoutMs);})]);}finally{clearTimeout(timer);}
}
async function runCase({item,adapter,timeoutMs=30000,identity={}}){
 validateCase(item);if(typeof adapter?.decide!=='function')throw Error('Decision adapter requires decide(input,{signal})');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw Error('Component timeout must be 1..300000ms');
 const input=modelInput(item),start=Date.now(),result={schema_version:1,setting:VERSION,case_id:item.id,case_hash:hash(item),input_hash:hash(input),raw_input_hash:hash(item.runtime),identity:clone(identity),adapter_identity:publicIdentity(adapter.identity),input,output:null,status:'running',semantic_evaluation:'not_run',review:{status:'not_run',ratings:null}};
 try{result.output=clone(await bounded(signal=>adapter.decide(clone(input),{signal}),timeoutMs));result.output_errors=outputErrors(result.output,input);result.status=result.output_errors.length?'output_contract_error':'executed_review_required';}
 catch(error){result.status='incomplete';result.error={code:error.code||'adapter_error',message:String(error.message||error).slice(0,2000)};}
 result.wall_elapsed_ms=Date.now()-start;return result;
}
function argumentsFor(argv){
 const opts={};for(let i=0;i<argv.length;i++){const key=argv[i];if(['--check','--list','--all','--live','--continue-on-case-error','--unlimited-http'].includes(key)){opts[key.slice(2)]=true;continue;}
  if(!['--cases','--id','--view','--adapter','--out','--max-calls','--max-http','--settings-file','--timeout-ms'].includes(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(`Unknown or incomplete component option ${key}`);opts[key.slice(2)]=argv[++i];}
 if(opts.id&&opts.all)throw Error('Choose --id or --all, not both');if(opts.view&&!['model','review'].includes(opts.view))throw Error('--view must be model or review');if(opts['unlimited-http']&&opts['max-http']!==undefined)throw Error('Choose either --unlimited-http or --max-http');return opts;
}
async function main(argv,emit=value=>console.log(JSON.stringify(value,null,2))){
 const options=argumentsFor(argv),data=loadCases(options.cases||DEFAULT_CASES),families=new Set(data.cases.map(c=>c.family_id));
 if(options.check){emit({status:'valid',setting:VERSION,cases:data.cases.length,families:families.size,dataset_hash:data.dataset_hash,reference_status:'provisional_ai_reference',semantic_evaluation:'not_run',inference:'not_run'});return;}
 if(options.list||!options.id&&!options.all){emit({status:'inventory',setting:VERSION,dataset_hash:data.dataset_hash,cases:data.cases.map(c=>({id:c.id,family_id:c.family_id,prior_sources:c.runtime.prior_evidence.length,new_sources:c.runtime.new_evidence.length,availability_updates:c.runtime.availability_updates.length})),inference:'not_run'});return;}
 const selected=options.all?data.cases:options.id.split(',').map(id=>{const item=data.cases.find(c=>c.id===id);if(!item)throw Error(`Unknown component case ${id}`);return item;});
 if(new Set(selected.map(c=>c.id)).size!==selected.length)throw Error('Duplicate selected case');
 if(options.view){if(selected.length!==1)throw Error('Inspection export requires one case');emit(options.view==='model'?modelInput(selected[0]):{case:clone(selected[0]),model_input:modelInput(selected[0]),review:{status:'not_run',ratings:null}});return;}
 if(!options.adapter||!options.out)throw Error('Component replay requires explicit --adapter and a new --out; inspection uses --view model/review');
 const maxCalls=options['unlimited-http']&&options['max-calls']===undefined?null:Number(options['max-calls']||16),timeoutMs=Number(options['timeout-ms']||30000);
 const budget=httpBudget({unlimitedHttp:options['unlimited-http']===true,maxHttp:options['max-http']===undefined?undefined:Number(options['max-http']),defaultCap:maxCalls??16,label:'Component HTTP'}),maxHttp=budget.cap;
 if(maxCalls!==null&&(!Number.isSafeInteger(maxCalls)||maxCalls<1||maxCalls>512)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw Error('Invalid component call cap or timeout');
 const out=path.resolve(options.out);if(fs.existsSync(out)||out.split(path.sep).some(part=>['data','.git'].includes(part)))throw Error('Output directory must be new and outside private data/Git metadata');
 const identity={dataset_hash:data.dataset_hash,contract_hash:hash(RESPONSE_CONTRACT),runner_hash:hash(fs.readFileSync(__filename,'utf8')),adapter_hash:null,setting:VERSION};
 let adapter,setupComplete=false,executionError;const started=Date.now();
 // Establish evidence before loading caller-supplied code. Inspection paths
 // above deliberately never reach this boundary or import an adapter.
 fs.mkdirSync(out,{recursive:true,mode:0o700});
 const clean=value=>adapter?.redact?adapter.redact(value):value,write=(name,value)=>fs.writeFileSync(path.join(out,name),JSON.stringify(clean(value),null,2)+'\n',{mode:0o600});
 const writeCase=(item,result)=>{write(item.id+'.run.json',result);write(item.id+'.review.json',{...result,reviewer_only:clone(item.reviewer_only),source_seed:clone(item.source_seed),review:{status:'not_run',ratings:null}});};
 const manifest={schema_version:1,setting:VERSION,identity,adapter:null,selected_cases:selected.map(c=>c.id),max_adapter_calls:maxCalls,requested_max_http:maxHttp,...(budget.unlimited?{unlimited_http:true}:{}),http_cap:'adapter_owned_not_verified_by_portable_runner',http_attempts:null,http_evidence:'unavailable',adapter_calls:0,initialization_stage:'adapter_load',initialization_status:'running',episodes:[],semantic_evaluation:'not_run',status:'running'};write('manifest.json',manifest);
 try{
  const adapterFile=fs.realpathSync(path.resolve(options.adapter));identity.adapter_hash=hash(fs.readFileSync(adapterFile,'utf8'));write('manifest.json',manifest);
  const factory=require(adapterFile);if(typeof factory.createDecisionAdapter!=='function')throw Error('Adapter module must export createDecisionAdapter(options)');
  manifest.initialization_stage='adapter_factory';write('manifest.json',manifest);
  adapter=await bounded(async signal=>{
   const candidate=await factory.createDecisionAdapter({live:options.live===true,maxCalls,maxHttp:budget.unlimited?undefined:maxHttp,unlimitedHttp:budget.unlimited,settingsFile:options['settings-file'],timeoutMs,signal,setting:VERSION});
   // A cooperative factory may resolve just after its deadline. Dispose of
   // that late result instead of adopting it after the incomplete receipt.
   if(signal.aborted){if(candidate?.close)try{await bounded(()=>candidate.close(),5000);}catch(error){write('late-factory-cleanup.json',{status:'incomplete',error:{code:error.code||'cleanup_error',message:String(error.message)},semantic_evaluation:'not_run'});}throw signal.reason;}
   return candidate;
  },timeoutMs);
  manifest.initialization_stage='adapter_identity';write('manifest.json',manifest);
  if(!['synthetic','live'].includes(adapter?.identity?.mode)||adapter.identity.mode!==(options.live?'live':'synthetic'))throw Error('Adapter declared live/synthetic identity must match explicit --live selection');
  if(options.live&&(!adapter.identity.model||!adapter.identity.provider))throw Error('Live adapter must declare model and provider');
  if(budget.unlimited&&(adapter.identity.unlimited_http!==true||adapter.identity.http_cap!==null))throw Error('Component adapter must explicitly declare unlimited HTTP mode');
  if(typeof adapter.decide!=='function')throw Error('Adapter must implement decide(input,{signal})');
  manifest.adapter=publicIdentity(adapter.identity);manifest.initialization_status='complete';manifest.initialization_stage='complete';setupComplete=true;write('manifest.json',manifest);
  for(const item of selected){if(maxCalls!==null&&manifest.adapter_calls>=maxCalls)break;manifest.adapter_calls++;const result=await runCase({item,adapter,timeoutMs,identity});
   writeCase(item,result);manifest.episodes.push({id:item.id,status:result.status,wall_elapsed_ms:result.wall_elapsed_ms,adapter_call_started:true});write('manifest.json',manifest);
   if(result.status==='incomplete'&&!options['continue-on-case-error'])break;
  }
 }catch(error){
  executionError=error;const reported={code:error.code||(setupComplete?'component_runner_error':'component_adapter_setup_error'),message:String(error.message||error).slice(0,2000)};manifest.error=reported;
  if(!setupComplete){
   manifest.initialization_status='failed';const item=selected[0],input=modelInput(item),result={schema_version:1,setting:VERSION,case_id:item.id,case_hash:hash(item),input_hash:hash(input),raw_input_hash:hash(item.runtime),identity:clone(identity),adapter_identity:null,input,input_delivery:'not_dispatched',adapter_call_started:false,output:null,status:'incomplete',initialization_stage:manifest.initialization_stage,error:reported,wall_elapsed_ms:Date.now()-started,semantic_evaluation:'not_run',review:{status:'not_run',ratings:null}};
   writeCase(item,result);manifest.episodes.push({id:item.id,status:'incomplete',adapter_call_started:false,initialization_stage:manifest.initialization_stage,error:reported,wall_elapsed_ms:result.wall_elapsed_ms});
  }
 }finally{
  if(adapter?.close)try{await bounded(()=>adapter.close(),5000);}catch(error){manifest.cleanup_error={code:error.code||'cleanup_error',message:String(error.message)};}
  if(adapter?.summary)try{const summary=await bounded(()=>adapter.summary(),1000);write('adapter-summary.json',summary);if(Number.isSafeInteger(summary?.http_attempts)&&summary.http_attempts>=0){manifest.http_attempts=summary.http_attempts;manifest.http_evidence='adapter_reported';}}catch(error){manifest.summary_error=String(error.message);}
  manifest.unexecuted_cases=selected.map(c=>c.id).filter(id=>!manifest.episodes.some(e=>e.id===id&&e.adapter_call_started));manifest.status=executionError||manifest.cleanup_error||manifest.unexecuted_cases.length||manifest.episodes.some(e=>e.status==='incomplete')?'incomplete':manifest.episodes.some(e=>e.status==='output_contract_error')?'output_contract_errors_review_required':'executed_review_required';write('manifest.json',manifest);
 }
 emit({status:manifest.status,setting:VERSION,artifacts:out,adapter_calls:manifest.adapter_calls,unexecuted_cases:manifest.unexecuted_cases,semantic_evaluation:'not_run'});if(executionError)throw executionError;return manifest;
}
module.exports={VERSION,AXES,OUTPUT_SCHEMA,RESPONSE_CONTRACT,validateCase,loadCases,modelInput,outputErrors,runCase,argumentsFor,main};
if(require.main===module)main(process.argv.slice(2)).then(result=>{if(result?.status==='incomplete')process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});
