'use strict';
// Portable behavioral replay. Product modules and routes belong in an adapter.
const crypto=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const PROTOCOL_VERSION=1;
function stimulus(event){
 const result={};
 for(const key of ['id','at','speaker','role','text','provenance','declared_use'])if(event[key]!==undefined)result[key]=clone(event[key]);
 return result;
}
function initialStimulus(initial){return {as_of:initial.as_of,qq_events:(initial.qq_events||[]).map(stimulus),private_events:(initial.private_events||[]).map(stimulus),...(initial.user_controls?{user_controls:clone(initial.user_controls)}:{})};}
function visibleOutput(output){
 if(output===null||output===undefined)return null;
 if(typeof output!=='object'||Array.isArray(output)||typeof output.text!=='string'||!Array.isArray(output.suggestions)||output.suggestions.some(s=>typeof s?.text!=='string')||!['draft','discussion','clarification','wait','unavailable'].includes(output.disposition))throw Error('Adapter returned an invalid visible output');
 return clone({...(typeof output.reply_id==='string'?{reply_id:output.reply_id}:{}),text:output.text,suggestions:output.suggestions.map(s=>({text:s.text})),disposition:output.disposition});
}
function assertProtocol(adapter){
 if(adapter?.protocol_version!==PROTOCOL_VERSION)throw Error('Unsupported replay adapter protocol');
 for(const name of ['open','advanceTo','observe','observePrivate','respond','close'])if(typeof adapter[name]!=='function')throw Error(`Replay adapter requires ${name}()`);
}
async function runEpisode({plan,adapter,timeoutMs=60000,identity={},onRecord=()=>{}}){
 assertProtocol(adapter);
 const errors=require('./eval-replay-plan.cjs').validateReplayPlan(plan);if(errors.length)throw Error(errors.join('\n'));
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw Error('Invalid wall-clock replay timeout');
 let deadline=Date.now()+timeoutMs;
 const bounded=async(fn)=>{
  const remaining=deadline-Date.now();if(remaining<=0){const error=Error('Replay wall-clock deadline exceeded');error.code='replay_timeout';throw error;}
  let timer;
  try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>{const error=Error('Replay wall-clock deadline exceeded');error.code='replay_timeout';reject(error);},remaining);})]);}
  finally{clearTimeout(timer);}
 };
 const result={schema_version:1,protocol_version:PROTOCOL_VERSION,case_id:plan.id,plan_hash:hash(plan),identity:clone(identity),adapter_identity:clone(adapter.identity||{}),
  semantic_evaluation:'not_run',status:'running',initial:initialStimulus(plan.initial),goal:plan.runtime_goal,steps:[],adaptations:clone(plan.adaptations||[]),limitations:clone(plan.limitations||[]),
  review:{status:'not_run',overall:null,dimension_ratings:{},critical_failures:[],notes:[]}};
 const errorInfo=error=>({code:typeof error.code==='string'?error.code:'adapter_error',message:String(error.message||error).slice(0,1000)});
 const record=async()=>onRecord(clone(result));
 const diagnostics=async(target)=>{
  if(!adapter.diagnostics)return;
  const started=Date.now();let timer;
  try{target.diagnostics=clone(await Promise.race([Promise.resolve().then(()=>adapter.diagnostics()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Optional diagnostics deadline exceeded')),1000);})]));}
  catch(error){target.diagnostics_error=errorInfo(error);}
  finally{clearTimeout(timer);deadline+=Date.now()-started;}
 };
 try{
  await bounded(()=>adapter.open(clone(result.initial),{goal:plan.runtime_goal}));
  if(plan.initial.user_controls){if(!adapter.configure)throw Error('Adapter does not support this declared user control');await bounded(()=>adapter.configure(clone(plan.initial.user_controls)));}
  const initialDiagnostics={};await diagnostics(initialDiagnostics);if(initialDiagnostics.diagnostics)result.initial_diagnostics=initialDiagnostics.diagnostics;if(initialDiagnostics.diagnostics_error)result.initial_diagnostics_error=initialDiagnostics.diagnostics_error;
  await record();
  for(const step of plan.steps){
   const entry={id:step.id,as_of:step.as_of,input:{qq_events:(step.qq_events||[]).map(stimulus),private_events:(step.private_events||[]).map(stimulus),request:step.request?stimulus(step.request):null,
    ...(step.user_controls?{user_controls:clone(step.user_controls)}:{})},status:'running',output:null,observed_outputs:[],diagnostics:null};result.steps.push(entry);
   const drain=async(at,phase)=>{
    if(!adapter.drainOutputs)return;
    const outputs=await bounded(()=>adapter.drainOutputs());
    if(!Array.isArray(outputs))throw Error('Adapter drainOutputs() must return an array');
    for(const output of outputs)entry.observed_outputs.push({at,phase,output:visibleOutput(output)});
   };
   try{
    const conditional=step.feedback?.mode==='requires_observed_output';
    const events=[...entry.input.qq_events.map(event=>({lane:'qq',event})),...(!conditional?entry.input.private_events.map(event=>({lane:'private',event})):[])].sort((a,b)=>Date.parse(a.event.at)-Date.parse(b.event.at));
    for(const {lane,event}of events){
     await bounded(()=>adapter.advanceTo(event.at));
     await drain(event.at,'time_advanced');
     if(lane==='qq')await bounded(()=>adapter.observe([clone(event)]));
     else{const outputs=await bounded(()=>adapter.observePrivate([clone(event)]));entry.intermediate_outputs=[...(entry.intermediate_outputs||[]),...(outputs||[]).map(visibleOutput)];}
     await drain(event.at,'external_event_applied');
    }
    await bounded(()=>adapter.advanceTo(step.as_of));
    await drain(step.as_of,'time_advanced');
    if(step.user_controls){if(!adapter.configure)throw Error('Adapter does not support this declared user control');await bounded(()=>adapter.configure(clone(step.user_controls)));}
    if(step.feedback?.mode==='requires_observed_output'){
     entry.status='not_replayed_response_condition';entry.reason='Authored feedback requires an observed output binding; it was not delivered.';
    }else{
     entry.output=visibleOutput(await bounded(()=>entry.input.request?adapter.respond(clone(entry.input.request)):adapter.currentOutput?.()));
     if(entry.input.request&&!entry.output)throw Error('No completed visible response was returned for the user request');
     entry.status='executed_review_required';
    }
    await drain(step.as_of,'step_completed');
    await diagnostics(entry);
   }catch(error){entry.status='execution_error';entry.error=errorInfo(error);throw error;}
   finally{await record();}
  }
  result.status=result.steps.some(s=>s.status==='not_replayed_response_condition')?'partial_review_required':'executed_review_required';
 }catch(error){result.status='incomplete';result.error=errorInfo(error);await diagnostics(result);}
 finally{
  // Cleanup is independently bounded, even after the episode deadline expires.
  let timer;try{await Promise.race([Promise.resolve().then(()=>adapter.close()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Adapter cleanup deadline exceeded')),5000);})]);}
  catch(error){result.cleanup_error=errorInfo(error);result.status='incomplete';}finally{clearTimeout(timer);}
  await record();
 }
 return result;
}
function reviewPacket(plan,result,rubric){
 if(result.case_id!==plan.id||result.plan_hash!==hash(plan))throw Error('Review plan identity mismatch');
 return {schema_version:1,case_id:plan.id,plan_hash:result.plan_hash,identity:result.identity,adapter_identity:result.adapter_identity,
  goal:result.goal,initial:result.initial,steps:result.steps.map(({diagnostics,...step})=>clone(step)),execution_status:result.status,
  ...(result.error?{error:clone(result.error)}:{}),...(result.cleanup_error?{cleanup_error:clone(result.cleanup_error)}:{}),
  criteria:clone(plan.reviewer_only||{}),rubric:clone(rubric),review:{status:'not_run',overall:null,dimension_ratings:Object.fromEntries((rubric.dimensions||[]).map(d=>[d.id,{rating:null,evidence:[]}])),critical_failures:[],notes:[]}};
}
module.exports={runEpisode,reviewPacket,visibleOutput,PROTOCOL_VERSION,hash};
