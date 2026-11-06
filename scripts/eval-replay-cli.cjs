'use strict';
// No product imports: --adapter is the only implementation-specific boundary.
const fs=require('node:fs'),path=require('node:path');
const {runEpisode,reviewPacket,preparationEvidence,hash}=require('./eval-replay.cjs');
const {loadReplayPlans}=require('./eval-replay-plan.cjs');
function argumentsFor(argv){
 const options={};
 for(let i=0;i<argv.length;i++){
  const name=argv[i];
  if(['--list','--live','--all','--continue-on-case-error','--unlimited-http'].includes(name)){options[name.slice(2)]=true;continue;}
  if(!['--adapter','--id','--out','--source-root','--max-http','--timeout-ms','--settings-file'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(`Invalid replay option ${name}`);
  options[name.slice(2)]=argv[++i];
 }
 return options;
}
async function main(argv){
 const options=argumentsFor(argv),dataset=loadReplayPlans();
 if(options['unlimited-http']&&options['max-http']!==undefined)throw Error('Choose either --unlimited-http or --max-http');
 const timeoutMs=options['timeout-ms']===undefined?120000:Number(options['timeout-ms']);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw Error('--timeout-ms must be 1..3600000');
 const deadline=async(fn,label)=>{let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Error(`${label} exceeded wall-clock deadline`);error.code='replay_timeout';reject(error);},timeoutMs);})]);}finally{clearTimeout(timer);}};
 if(options.list||!options.id&&!options.all){
  console.log(JSON.stringify({status:'inventory',policy_version:dataset.policyVersion,dataset_hash:dataset.datasetHash,cases:dataset.plans.map(p=>({id:p.id,cutoff:p.initial.as_of,prefix_qq:p.initial.qq_events.length,prefix_private:p.initial.private_events.length,steps:p.steps.length,adaptations:p.adaptations.length})),inference:'not_run'},null,2));return;
 }
 if(!options.adapter)throw Error('An explicit --adapter is required; replay cases do not choose a product implementation');
 if(!options.out)throw Error('--out must name a new artifact directory');
 const selected=options.all?dataset.plans:options.id.split(',').map(id=>{const plan=dataset.plans.find(p=>p.id===id);if(!plan)throw Error(`Unknown replay case ${id}`);return plan;});
 if(new Set(selected.map(p=>p.id)).size!==selected.length)throw Error('Replay case IDs must be distinct');
 const adapterFile=fs.realpathSync(path.resolve(options.adapter)),module=require(adapterFile);
 if(typeof module.createAdapterFactory!=='function')throw Error('Adapter module must export createAdapterFactory(options)');
 const factory=await deadline(()=>module.createAdapterFactory({live:options.live===true,sourceRoot:options['source-root'],settingsFile:options['settings-file'],maxHttp:options['max-http']===undefined?undefined:Number(options['max-http']),unlimitedHttp:options['unlimited-http']===true}),'Adapter factory initialization');
 if(options['unlimited-http']&&(factory.identity?.unlimited_http!==true||factory.identity?.max_http!==null))throw Error('Replay adapter must explicitly declare unlimited HTTP mode');
 if(typeof factory.create!=='function')throw Error('Adapter factory must create independent episodes');
 const output=path.resolve(options.out);
 if(output.split(path.sep).some(part=>['.git','data'].includes(part))||fs.existsSync(output))throw Error('Artifact directory must be new and outside private data/Git metadata');
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 const rubric=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../evals/assistant/rubric.json'),'utf8'));
 const identity={dataset_hash:dataset.datasetHash,policy_version:dataset.policyVersion,rubric_version:rubric.version,
  runner_hash:hash(fs.readFileSync(__filename,'utf8')),harness_hash:hash(fs.readFileSync(path.join(__dirname,'eval-replay.cjs'),'utf8')),adapter_hash:hash(fs.readFileSync(adapterFile,'utf8'))};
 identity.plan_compiler_hash=hash(fs.readFileSync(path.join(__dirname,'eval-replay-plan.cjs'),'utf8'));
 const clean=value=>factory.redact?factory.redact(value):value;
 const write=(filename,value)=>fs.writeFileSync(path.join(output,filename),JSON.stringify(clean(value),null,2),{mode:0o600});
 const manifest={schema_version:1,identity,adapter:factory.identity||{},selected_cases:selected.map(p=>p.id),continue_on_case_error:options['continue-on-case-error']===true,semantic_evaluation:'not_run',status:'running',episodes:[]};
 write('manifest.json',manifest);
 for(const plan of selected){
  let result;
  try{
   const adapter=await deadline(()=>factory.create(),'Adapter creation');
   result=await runEpisode({plan,adapter,identity,timeoutMs,onRecord:value=>write(`${plan.id}.run.json`,value)});
  }catch(error){
   result={schema_version:1,case_id:plan.id,plan_hash:hash(plan),identity,adapter_identity:factory.identity||{},goal:plan.runtime_goal,initial:plan.initial,steps:[],unexecuted_steps:plan.steps.map(step=>step.id),status:'incomplete',semantic_evaluation:'not_run',error:{code:error.code||'adapter_setup_error',message:String(error.message)},review:{status:'not_run',overall:null}};
   write(`${plan.id}.run.json`,result);
  }
  write(`${plan.id}.review.json`,reviewPacket(plan,result,rubric));
  const preparation=preparationEvidence(result);
  if(preparation)write(`${plan.id}.preparation.json`,preparation);
  manifest.episodes.push({id:plan.id,status:result.status,steps:result.steps.map(s=>({id:s.id,status:s.status})),unexecuted_steps:result.unexecuted_steps||[],...(preparation?{preparation_artifact:`${plan.id}.preparation.json`}:{}),...(result.error?{error:result.error}:{})});
  write('transport.json',factory.summary?.()||{});write('manifest.json',manifest);
  // A broken provider or global cap is not a reason to burn through more cases.
  if(result.status==='incomplete'&&!options['continue-on-case-error'])break;
  if(factory.identity?.unlimited_http!==true&&Number.isSafeInteger(factory.identity?.max_http)&&factory.summary?.().http_attempts>=factory.identity.max_http)break;
 }
 manifest.status=manifest.episodes.some(e=>e.status==='incomplete')?'incomplete':manifest.episodes.length<selected.length?'incomplete':manifest.episodes.some(e=>e.status==='partial_review_required')?'partial_review_required':'executed_review_required';
 manifest.unexecuted_cases=selected.map(p=>p.id).filter(id=>!manifest.episodes.some(e=>e.id===id));
 write('manifest.json',manifest);
 console.log(JSON.stringify({status:manifest.status,artifacts:output,identity,episodes:manifest.episodes,unexecuted_cases:manifest.unexecuted_cases,semantic_evaluation:'not_run'},null,2));
 if(manifest.status==='incomplete')process.exitCode=1;
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main,argumentsFor};
