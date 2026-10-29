'use strict';
// Replace this versioned boundary when QQ Assistant changes architecture.
// Cases, portable replay and reviewer criteria do not import this implementation.
const fs=require('node:fs'),path=require('node:path');
const {hash}=require('./eval-replay.cjs');
const ROOT=path.resolve(__dirname,'..');
const MAIN_ROOT='/home/zhkzly/pycodes/qq-chat-assistant';
function sourceIdentity(root){
 const names=fs.readdirSync(path.join(root,'src'),{recursive:true}).filter(name=>name.endsWith('.cjs')).sort();
 return hash(names.map(name=>[name,hash(fs.readFileSync(path.join(root,'src',name),'utf8'))]));
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
 const selected=live?selectedSettings(options.settingsFile||path.join(MAIN_ROOT,'data/settings.json')):null;
 const settings=selected?.settings||{model:'synthetic-replay-only',baseUrl:'http://fixture.invalid/v1',anonymous:true};
 const cap=options.maxHttp??16,ceiling=live?64:512;if(!Number.isSafeInteger(cap)||cap<1||cap>ceiling)throw Error(`Replay HTTP cap must be 1..${ceiling} across all selected episodes`);
 let attempts=0;const requests=[],implementationHash=sourceIdentity(sourceRoot);
 const destination=new URL(settings.baseUrl);
 const metadata={name:'qq-assistant-public-api',version:'1',implementation_hash:implementationHash,source_root:sourceRoot,
  adapter_runtime_hash:hash(fs.readFileSync(path.join(__dirname,'eval-runtime-session.cjs'),'utf8')),
  evidence:live?'live_model_synthetic_events_product_integration':'synthetic_transport_product_integration',desktop_qq:false,
  prefix_preparation:'controlled_current_product_memory_rebuild',preparation_is_scheduler_test:false,
  model:settings.model,destination:{origin:destination.origin,path:destination.pathname},settings_hash:selected?.digest||null,max_http:cap};
 const redact=value=>typeof value==='string'&&settings.apiKey?value.split(settings.apiKey).join('[redacted]'):value;
 const clean=value=>JSON.parse(JSON.stringify(value,(_key,v)=>redact(v)));
 const {createReplaySession,makeSyntheticTransport}=require('./eval-runtime-session.cjs');
 const offline=makeSyntheticTransport();
 const transport=async(url,args)=>{
  if(attempts>=cap){const error=Error('Global replay HTTP limit reached');error.code='replay_http_limit';throw error;}
  if(new URL(url).origin!==destination.origin)throw Error('Replay model destination changed');
  if(selected&&hash(fs.readFileSync(selected.filename,'utf8'))!==selected.digest)throw Error('Selected model configuration changed during replay');
  const item={sequence:++attempts,request:JSON.parse(args.body),status:'running'};requests.push(item);
  try{const response=await(live?fetch(url,args):offline(url,args));item.http_status=response.status;item.response_body=await response.clone().text();item.status='received';return response;}
  catch(error){item.status='error';item.error={code:error.code||'transport_error',message:String(error.message)};throw error;}
 };
 return {identity:metadata,redact:clean,summary:()=>({http_attempts:attempts,requests:clean(requests),settings_unchanged:selected?hash(fs.readFileSync(selected.filename,'utf8'))===selected.digest:null}),
  async create(){
   let session,lastOutput=null,requestIndex=0;const knownReplies=new Set();
   const fromTurn=turn=>{
    if(!turn)return null;
    return {reply_id:turn.id,text:turn.text||'',suggestions:(turn.suggestions||[]).map(s=>({text:s.text})),disposition:turn.suggestions?.length?'draft':turn.kind==='question'?'clarification':turn.replyDisposition==='wait'?'wait':turn.replyDisposition==='unavailable'?'unavailable':'discussion'};
   };
   const visible=(snapshot,requestId)=>fromTurn(snapshot.companion?.turns?.filter(t=>t.role==='assistant'&&(!requestId||t.requestId===requestId)).at(-1));
   const restore=async(events)=>{
    const archive=events.filter(e=>e.provenance!=='authored_user_note');if(archive.length)await session.restorePrivate(archive);
    for(const event of events.filter(e=>e.provenance==='authored_user_note'))await session.post('/api/note',{text:event.text,use:event.declared_use||'discussion'});
   };
   return {protocol_version:1,identity:metadata,
    async open(initial,{goal}){
     session=await createReplaySession({sourceRoot,asOf:initial.as_of,history:initial.qq_events,goal,settings:{...settings,auto:false},transport});
     await restore(initial.private_events||[]);
     for(const turn of session.snapshot().companion?.turns||[])if(turn.role==='assistant')knownReplies.add(turn.id);
     // Checkpoint reconstruction is separate from evaluating automatic scheduling.
     // Build this implementation's own derived records from the frozen raw prefix.
     for(let batch=0;session.snapshot().memoryStatus?.pending>0;batch++){
      if(batch>=16)throw Error('Prefix preparation exceeded the declared 16 maintenance checkpoints');
      const before=session.snapshot().memoryStatus.pending;
      await session.post('/api/memory-maintain');
      const after=session.snapshot().memoryStatus;
      if(after.pending>=before)throw Error(`Prefix memory preparation did not progress (${after.errors?.[0]?.code||'pending sources remain'})`);
     }
    },
    async advanceTo(at){await session.advanceTo(at);},
    async observe(events){await session.deliver(events);},
    async observePrivate(events){
     const outputs=[];
     for(const event of events){
      if(event.role!=='user')throw Error('A new assistant answer cannot be supplied by the replay script');
      if(event.provenance==='authored_user_note')await session.post('/api/note',{text:event.text,use:event.declared_use||'discussion'});
      else outputs.push(await this.respond(event));
     }
     return outputs;
    },
    async configure(controls){await session.post('/api/options',{auto:controls.automatic});},
    async respond(request){
     const taskId=`replay-request-${++requestIndex}`;
     const snapshot=await session.post('/api/assistant',{text:request.text,purpose:'discussion',taskId});
     if(snapshot.assistantError)throw Error(snapshot.assistantError);
     lastOutput=visible(snapshot,taskId);if(lastOutput)knownReplies.add(lastOutput.reply_id);return lastOutput;
    },
    async drainOutputs(){const outputs=session.snapshot().companion.turns.filter(turn=>turn.role==='assistant'&&!knownReplies.has(turn.id));for(const turn of outputs)knownReplies.add(turn.id);return outputs.map(fromTurn);},
    async currentOutput(){const snapshot=session.snapshot(),id=snapshot.advice?.turnId;return id?fromTurn(snapshot.companion.turns.find(t=>t.id===id)):null;},
    async diagnostics(){return clean({snapshot:session.snapshot(),trace:session.trace});},
    async close(){if(session)await session.close();}
   };
  }};
}
module.exports={createAdapterFactory};
