'use strict';
// Replace this versioned boundary when QQ Assistant changes architecture.
// Cases, portable replay and reviewer criteria do not import this implementation.
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {hash}=require('./eval-replay.cjs');
const {OBSERVATION_CONDITION}=require('./eval-runtime-session.cjs');
const ROOT=path.resolve(__dirname,'..');
const MAIN_ROOT='/home/zhkzly/pycodes/qq-chat-assistant';
// Match ui/app.js assistantVisibleBody and assistant-thread rendering. These
// are user-visible explanations and notices, not internal model reasoning.
function projectVisibleTurn(turn){
 if(!turn)return null;
 const recovery=['private_help','restricted_draft'].includes(turn.responseRecovery?.kind)?turn.responseRecovery.kind:null;
 const suggestions=recovery==='private_help'?[]:(turn.suggestions||[]).map(s=>({text:s.text,label:s.style||'参考表达'}));
 const options=recovery==='private_help'?[]:(turn.expressionOptions||[]).map(choice=>({label:choice.label||choice.intent||'一个可表达的方向'}));
 const notices=[];
 const references=[];
 if(turn.methodBasis)references.push({label:'本次参考',text:typeof turn.methodBasis==='string'?turn.methodBasis:JSON.stringify(turn.methodBasis)});
 if(turn.method)references.push({label:'模型标记的方法',text:typeof turn.method==='string'?turn.method:turn.method.label||turn.method.id||''});
 if(recovery&&turn.responseRecovery.metadataApplied===false)notices.push({text:recovery==='private_help'?'已先给出建议；部分背景整理未完成。':'表达参考 · 请核对'});
 else if(turn.metadataReviewPending?.reasonCode==='auxiliary_metadata_rejected')notices.push({text:'建议已保留；这次背景整理待复核。'});
 return {reply_id:turn.id,text:[...new Set([turn.discussionExplanation?.text,turn.text].filter(text=>typeof text==='string'&&text.length))].join('\n\n'),suggestions,
  ...(options.length?{options}:{}),...(notices.length?{notices}:{}),...(references.length?{references}:{}),
  disposition:suggestions.length?'draft':turn.kind==='question'||turn.replyDisposition==='clarify'?'clarification':turn.replyDisposition==='wait'?'wait':turn.replyDisposition==='unavailable'?'unavailable':'discussion'};
}
function memoryPreparationProgressed(before,after){
 const receipt=after?.lastReview,segments=receipt?.segments;
 return after?.version>before?.version&&typeof receipt?.batchId==='string'&&receipt.batchId!==before?.lastReview?.batchId&&
  Array.isArray(segments)&&segments.length>0&&segments.every(s=>typeof s.sourceId==='string'&&Number.isSafeInteger(s.offset)&&Number.isSafeInteger(s.end)&&s.offset>=0&&s.end>=s.offset)&&
  (after.pending<before.pending||segments.some(s=>s.end>s.offset));
}
function sourceIdentity(root){
 const names=fs.readdirSync(path.join(root,'src'),{recursive:true}).filter(name=>name.endsWith('.cjs')).sort();
 return hash(names.map(name=>[name,hash(fs.readFileSync(path.join(root,'src',name),'utf8'))]));
}
// Optional pure provenance callback for architecture-independent experiment tools.
// A replacement adapter defines its own scope; this backend uses src/**/*.cjs.
const revisionIdentities=new Map();
function implementationIdentity({sourceRoot=ROOT,revision}={}){
 const root=fs.realpathSync(sourceRoot);
 if(!revision)return {hash:sourceIdentity(root),scope:'isolated QQ Assistant backend src/**/*.cjs'};
 if(!/^[a-f0-9]{7,40}$/.test(revision))throw Error('Implementation revision must be a Git commit hash');
 const gitOptions={cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000};
 const resolved=execFileSync('git',['rev-parse','--verify',`${revision}^{commit}`],gitOptions).trim(),key=`${root}:${resolved}`;
 if(revisionIdentities.has(key))return {...revisionIdentities.get(key)};
 const names=execFileSync('git',['ls-tree','-r','--name-only',resolved,'--','src'],gitOptions).trim().split('\n').filter(name=>name.endsWith('.cjs')).sort();
 if(!names.length)throw Error('No implementation sources at the frozen baseline revision');
 const result={hash:hash(names.map(name=>[name.slice(4),hash(execFileSync('git',['show',`${resolved}:${name}`],gitOptions))])),scope:'isolated QQ Assistant backend src/**/*.cjs',revision:resolved};revisionIdentities.set(key,result);return {...result};
}
function selectedSettings(filename){
 const bytes=fs.readFileSync(filename),saved=JSON.parse(bytes),profile=saved.modelProfiles?.find(item=>item.id===saved.activeModelProfileId)||saved;
 const result={};
 for(const key of ['model','baseUrl','apiKey','anonymous','modelResponseMode','modelTimeoutMs','assistantContextBytes','assistantRequestBytes','assistantRequestLimit','discussionCompactionEnabled','memoryBatchThreshold','memoryIdleMs','memoryWindowRequests']){
  const value=Object.hasOwn(profile,key)?profile[key]:saved[key];if(value!==undefined)result[key]=value;
 }
 const url=new URL(result.baseUrl);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!result.model||!result.apiKey&&!result.anonymous)throw Error('Selected model configuration is not ready for a replay');
 return {settings:result,digest:hash(bytes.toString()),filename};
}
function createAdapterFactory(options={}){
 const sourceRoot=fs.realpathSync(options.sourceRoot||ROOT),live=options.live===true;
 const supplemental=options.condition===OBSERVATION_CONDITION;
 if(options.condition!==undefined&&!supplemental)throw Error('Unknown supplemental observation condition');
 if(options.prefixPreparation!==undefined&&options.prefixPreparation!=='controlled_rebuild')throw Error('Use the explicitly identified supplemental condition instead of normal-host identity');
 const selected=live?selectedSettings(options.settingsFile||path.join(MAIN_ROOT,'data/settings.json')):null;
 const settings=selected?.settings||{model:'synthetic-replay-only',baseUrl:'http://fixture.invalid/v1',anonymous:true};
 const cap=options.maxHttp??16,ceiling=live?64:512;if(!Number.isSafeInteger(cap)||cap<1||cap>ceiling)throw Error(`Replay HTTP cap must be 1..${ceiling} across all selected episodes`);
 let attempts=0,blockedAttempts=0;const requests=[],implementationHash=sourceIdentity(sourceRoot);
 const destination=new URL(settings.baseUrl);
 const metadata={name:'qq-assistant-public-api',version:'2',implementation_hash:implementationHash,source_root:sourceRoot,
  adapter_runtime_hash:hash(fs.readFileSync(path.join(__dirname,'eval-runtime-session.cjs'),'utf8')),
  evidence:live?'live_model_synthetic_events_product_integration':'synthetic_transport_product_integration',desktop_qq:false,
  prefix_preparation:supplemental?'scheduled_only_no_forced_prefix':'controlled_current_product_memory_rebuild',preparation_is_scheduler_test:false,
  ...(supplemental?{condition:OBSERVATION_CONDITION,native_idle_deadline_ms:65000,idle_outer_headroom_ms:2000,foreground_wall_timeout_ms:300000,ordinary_actions_wait:'foreground_only',idle_wait:'declared_scheduled_work_only',clock:'virtual_source_events_native_provider_elapsed'}:{}),
  model:settings.model,destination:{origin:destination.origin,path:destination.pathname},settings_hash:selected?.digest||null,max_http:cap};
 const redact=value=>typeof value==='string'&&settings.apiKey?value.split(settings.apiKey).join('[redacted]'):value;
 const clean=value=>JSON.parse(JSON.stringify(value,(_key,v)=>redact(v)));
 const {createReplaySession,makeSyntheticTransport}=require('./eval-runtime-session.cjs');
 const offline=makeSyntheticTransport();
 const transport=async(url,args)=>{
  if(attempts>=cap){blockedAttempts++;const error=Error('Global replay HTTP limit reached');error.code='replay_http_limit';throw error;}
  if(new URL(url).origin!==destination.origin)throw Error('Replay model destination changed');
  if(selected&&hash(fs.readFileSync(selected.filename,'utf8'))!==selected.digest)throw Error('Selected model configuration changed during replay');
  const started=Date.now(),item={sequence:++attempts,request:JSON.parse(args.body),status:'running',wall_started_at:new Date(started).toISOString()};requests.push(item);
  const onAbort=()=>{item.abort_requested=true;item.abort_elapsed_ms=Date.now()-started;};args.signal?.addEventListener('abort',onAbort,{once:true});if(args.signal?.aborted)onAbort();
  try{const response=await(live?fetch(url,args):offline(url,args));item.http_status=response.status;item.response_body=await response.clone().text();item.status='received';return response;}
  catch(error){item.status='error';item.error={code:error.code||'transport_error',message:String(error.message)};throw error;}
  finally{item.wall_elapsed_ms=Date.now()-started;args.signal?.removeEventListener('abort',onAbort);}
 };
 return {identity:metadata,redact:clean,summary:()=>({http_attempts:attempts,blocked_attempts:blockedAttempts,requests:clean(requests),settings_unchanged:selected?hash(fs.readFileSync(selected.filename,'utf8'))===selected.digest:null}),
  async create(){
   let session,requestIndex=0;const knownReplies=new Set(),generatedReplies=new Set();
   const fromTurn=projectVisibleTurn;
   const visible=(snapshot,requestId)=>fromTurn(snapshot.companion?.turns?.filter(t=>t.role==='assistant'&&(!requestId||t.requestId===requestId)).at(-1));
   const restore=async(events)=>{
    const archive=events.filter(e=>e.provenance!=='authored_user_note');if(archive.length)await session.restorePrivate(archive);
    const notes=events.filter(e=>e.provenance==='authored_user_note');if(notes.length)await session.restoreNotes(notes);
   };
   return {protocol_version:1,identity:metadata,
    async open(initial,{goal}){
     session=await createReplaySession({sourceRoot,asOf:initial.as_of,history:initial.qq_events,goal,settings:{...settings,auto:false},transport,...(supplemental?{condition:OBSERVATION_CONDITION}:{})});
     await restore(initial.private_events||[]);
     for(const turn of session.snapshot().companion?.turns||[])if(turn.role==='assistant')knownReplies.add(turn.id);
     // Checkpoint reconstruction is separate from evaluating automatic scheduling.
     // Build this implementation's own derived records from the frozen raw prefix.
     for(let batch=0;!supplemental&&session.snapshot().memoryStatus?.pending>0;batch++){
      if(batch>=16)throw Error('Prefix preparation exceeded the declared 16 maintenance checkpoints');
      const before=session.snapshot().memoryStatus;
      await session.post('/api/memory-maintain');
      const after=session.snapshot().memoryStatus;
      if(!memoryPreparationProgressed(before,after))throw Error(`Prefix memory preparation did not progress (${after.errors?.[0]?.code||'no committed source progress'})`);
     }
    },
    async advanceTo(at){await session.advanceTo(at);},
    async idleUntil(at,options){return clean(await session.idleUntil(at,options));},
    async publicMemoryView(){return clean(await session.publicMemoryView());},
    async observe(events){await session.deliver(events);},
    async observePrivate(events){
     const outputs=[];
     for(const event of events){
      if(event.role!=='user')throw Error('A new assistant answer cannot be supplied by the replay script');
      if(event.provenance==='authored_user_note')await session.addNote(event);
      else outputs.push(await this.respond(event));
     }
     return outputs;
    },
    async configure(controls){
     if(Object.hasOwn(controls,'automatic'))await session.post('/api/options',{auto:controls.automatic});
     if(Object.hasOwn(controls,'goal'))await session.post('/api/goal',{text:controls.goal});
    },
    async withdrawSources(events){await session.withdrawSources(events);},
    async respond(request){
     const reference=request.reference?.reply_id;
     if(reference&&!generatedReplies.has(reference))throw Error('Feedback must reference an actual earlier generated assistant reply');
     const taskId=`replay-request-${++requestIndex}`;
     const snapshot=await session.post('/api/assistant',{text:request.text,purpose:'discussion',taskId,...(reference?{sourceTurnIds:[reference]}:{})});
     if(snapshot.assistantError)throw Error(snapshot.assistantError);
     session.registerPrivateInput(request,snapshot.companion.turns.find(t=>t.role==='user'&&t.requestId===taskId));
     const output=visible(snapshot,taskId);if(output){knownReplies.add(output.reply_id);generatedReplies.add(output.reply_id);}return output;
    },
    async drainOutputs(){const outputs=session.snapshot().companion.turns.filter(turn=>turn.role==='assistant'&&!knownReplies.has(turn.id));for(const turn of outputs){knownReplies.add(turn.id);generatedReplies.add(turn.id);}return outputs.map(fromTurn);},
    async currentOutput(){const snapshot=session.snapshot(),id=snapshot.advice?.turnId;return id?fromTurn(snapshot.companion.turns.find(t=>t.id===id)):null;},
    async diagnostics(){return clean({snapshot:session.snapshot(),trace:session.trace});},
    async close(){if(session)return await session.close();}
   };
  }};
}
module.exports={createAdapterFactory,projectVisibleTurn,memoryPreparationProgressed,implementationIdentity};
