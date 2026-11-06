'use strict';
// QQ-specific preparation attribution. Matching raw restoration is not a
// claim that historical assistant calls were rerun or understood correctly.
const {hash}=require('./eval-replay.cjs');
const VERSION='qq-prefix-preparation-v1';
const copy=value=>value===undefined?null:structuredClone(value);
const iso=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
function checkpoint(snapshot){
 if(!snapshot)return null;
 return {as_of:snapshot.asOf,memory_status:copy(snapshot.memoryStatus),
  raw_source_count:snapshot.sources?.length??null,derived_record_count:snapshot.derivedMemory?.length??null};
}
function compareRawPrefix(initial,snapshot){
 const counts={qq:0,archived_user:0,archived_assistant:0,authored_note:0},entries=[];
 const sources=new Map((snapshot?.sources||[]).map(source=>[source.id,source]));
 const aliases={...snapshot?.sourceAliases,...snapshot?.privateAliases,...snapshot?.noteAliases};
 const add=(event,channel,observed,extra={})=>{
  const sourceId=aliases[event.id]||null,media=channel==='qq'&&event.attachments?.length>0;
  const expectedRole=channel==='qq'?(event.speaker==='self'?'user':'contact'):event.role||'user';
  const observedRole=channel==='note'&&observed?'user':observed?.role;
  const expectedAt=channel==='qq'?new Date(Math.floor(Date.parse(event.at)/1000)*1000).toISOString():iso(event.at);
  const observedAt=iso(observed?.at||observed?.createdAt);
  const checks={present:!!observed,body:media?null:typeof observed?.text==='string'&&observed.text===event.text,
   role:observedRole===expectedRole,time:observedAt===expectedAt,...extra};
  const values=Object.values(checks),integrity=values.some(value=>value===false)?'mismatch':values.some(value=>value===null)?'unverifiable':'matched';
  entries.push({input_id:event.id,source_id:sourceId,channel,expected_role:expectedRole,observed_role:observedRole||null,
   expected_at:expectedAt,observed_at:observedAt,input_text_sha256:hash(event.text),observed_text_sha256:typeof observed?.text==='string'?hash(observed.text):null,
   ...(media?{body_comparison:'media_normalization_not_compared'}:{}),checks,integrity});
 };
 for(const event of initial.qq_events||[]){counts.qq++;add(event,'qq',sources.get(aliases[event.id]));}
 for(const event of initial.private_events||[]){
  if(event.provenance==='authored_user_note'){
   counts.authored_note++;
   const observed=(snapshot?.companion?.notes||[]).find(note=>`note:${note.id}`===aliases[event.id]);
   const expectedRefs=(event.evidence_source_ids||[]).map(id=>aliases[id]);
   add(event,'note',observed,{use:observed?.use===(event.declared_use||'discussion'),kind:observed?.kind===(event.note_kind||'material'),
    evidence_references:expectedRefs.every(Boolean)&&hash(expectedRefs)===hash(observed?.evidenceSourceIds||[])});
  }else{
   counts[event.role==='assistant'?'archived_assistant':'archived_user']++;
   const observed=(snapshot?.companion?.turns||[]).find(turn=>`private:${turn.id}`===aliases[event.id]);
   add(event,'private_archive',observed);
  }
 }
 return {integrity:!snapshot?'unverifiable':entries.some(entry=>entry.integrity==='mismatch')?'mismatch':entries.some(entry=>entry.integrity==='unverifiable')?'unverifiable':'matched',
  counts,entries,qq_timestamp_precision:'native_boundary_seconds',scope:'restored_originals_only_not_historical_execution_or_semantic_quality'};
}
function buildPreparationReceipt({initial,goal,setting,before,after,trace=[],modelRequests,blockedRequests,error,wallElapsedMs=0}){
 const selected={as_of:initial.as_of,qq_events:initial.qq_events||[],private_events:initial.private_events||[]};
 const requests=trace.filter(row=>row.component==='product_http'&&row.event==='request');
 const forced=requests.filter(row=>row.route==='/api/memory-maintain').length;
 return {version:VERSION,setting,status:error?'failed':'prepared',raw_input_sha256:hash(selected),goal_sha256:hash(goal||''),
  raw_prefix:compareRawPrefix(initial,after),before:checkpoint(before),after:checkpoint(after),
  forced_maintenance_requests:forced,model_requests:Number.isSafeInteger(modelRequests)?modelRequests:null,
  blocked_model_requests:Number.isSafeInteger(blockedRequests)?blockedRequests:null,
  transport_invocations:trace.filter(row=>row.component==='model_transport'&&row.event==='request').length,
  preparation_wall_elapsed_ms:wallElapsedMs,entire_history_reexecuted:false,scheduler_behavior_evaluated:false,semantic_quality:'not_evaluated',
  ...(error?{error:{code:error.code||'preparation_error',message:String(error.message||error).slice(0,1500)}}:{}),
  limits:['Raw text/role/time/use matching verifies restoration, not accurate derived understanding.',
   'Archived assistant turns are supplied checkpoint context, not newly generated outputs.',
   'Journal pending=0 does not establish semantic-review completion.',
   'QQ native events and source time are replayed; desktop UI, restart persistence and concurrent ingress are not established.']};
}
module.exports={VERSION,compareRawPrefix,buildPreparationReceipt};
