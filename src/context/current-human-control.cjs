'use strict';
const {sameScopeIfPresent}=require('./source-snapshot.cjs');
const {assertDraftSourcesCurrent}=require('./draft-material.cjs');
const {validationError}=require('../validation-issues.cjs');
const {sourceEvidence}=require('./source-delivery.cjs');

const originalHuman=source=>source?.role==='user'&&['private','feedback'].includes(source.type)&&
 !['feedback_continue','user_control'].includes(source.kind)&&source.authority!=='invocation_control_not_user_evidence';
const usable=source=>source&&!source.deleted&&!source.excluded&&source.use!=='disabled';
const unavailable=()=>new Error('Current human control source is unavailable, changed, or outside the captured scope');

// This lane preserves what the current person said, including conditions,
// quotations and private facts. It confers neither material nor sharing rights.
function buildCurrentHumanControl(prepared,info={}){
 const payload=prepared?.payload,sourceId=payload?.intentAuthority?.sourceId;
 if(sourceId===undefined||sourceId===null)return {dependencies:[]};
 if(typeof sourceId!=='string'||!sourceId)throw unavailable();
 const delivered=(payload.sources||[]).find(source=>source.id===sourceId);
 const captured=(prepared.fullAvailableSources||payload.sources||[]).find(source=>source.id===sourceId);
 // Excluded originals must not reappear through a sanitized invocation or a
 // generated feedback wrapper, even if an older capture still has their body.
 const candidate=delivered||captured;
 if(!candidate)throw unavailable();
 if(!originalHuman(candidate))return {dependencies:[]};
 const source=captured,scope=info.scope||prepared.manifest?.scope;
 const withinScope=value=>!value?.scope||typeof value.scope!=='object'
  ?sameScopeIfPresent(value,scope):!!scope&&sameScopeIfPresent(value,scope);
 if(!source||!delivered||!originalHuman(source)||!usable(source)||!usable(delivered)||
  !withinScope({scope:prepared.manifest?.scope})||!withinScope(source)||!withinScope(delivered)||
  typeof source.revision!=='string'||!source.revision||source.revision!==delivered.revision||
  prepared.manifest?.sourceRevisions?.[sourceId]!==source.revision||
  typeof source.text!=='string'||!source.text.trim())throw unavailable();
 assertDraftSourcesCurrent(prepared,[sourceId],{...info,scope});
 // The control lane always carries the complete captured original, even when
 // the planning delivery was range-limited: a tail veto beyond any delivered
 // range must still govern the draft. If the whole statement cannot fit the
 // draft budget, the caller fails explicitly instead of clipping it.
 const deliveredEvidence=sourceEvidence(prepared,sourceId,info);
 return {control:{version:1,authority:'CONTROL_ONLY',sourceId,sourceType:source.type,text:source.text,
   localOriginalComplete:deliveredEvidence.originalComplete,producerDelivery:deliveredEvidence.coverage},
  dependencies:[{sourceId,revision:source.revision}]};
}
function currentFactQuotes(prepared,facts,info={}){
 if(facts===undefined)return [];
 if(!Array.isArray(facts)||facts.length>8)throw validationError('currentFacts','current_fact_span_invalid','currentFacts must contain at most eight exact current human fact spans');
 if(!facts.length)return [];
 let human;
 try{human=buildCurrentHumanControl(prepared,info).control;}catch(error){throw validationError('currentFacts','current_fact_source_invalid',error.message);}
 if(!human)throw validationError('currentFacts','current_fact_source_invalid','Current facts require the complete original human statement, not an invocation or generated continuation');
 const evidence=sourceEvidence(prepared,human.sourceId,info);
 if(!info.privateEvidenceOnly&&!evidence.complete)throw validationError('currentFacts','current_fact_permission_incomplete','The current permission context has unread original ranges. Read its remaining ranges, use private analysis, or obtain a complete current permission; a delivered fact does not grant unseen disclosure scope');
 return facts.map((text,index)=>{
  // Handle-based citation (C2 structural fix): cite a delivered span handle @r<n>\n'th delivered span of the current human statement; the program resolves the exact verbatim text, so citation exactness no longer depends on model character-copying. Verbatim spans stay accepted and containment-validated.
  let span=typeof text==='string'?text:'';
  const handle=typeof text==='string'?new RegExp('^@r([1-9]\d*)$').exec(text.trim()):null;
  if(handle){
   const pick=evidence.spans[Number(handle[1])-1];
   if(!pick||typeof pick.text!=='string'||!pick.text.trim())throw validationError('currentFacts['+index+']','current_fact_span_invalid','The cited range handle does not match any delivered span of the current human statement');
   span=pick.text;
  }
  if(typeof span!=='string'||!span.trim()||span.length>4000||!evidence.contains(span))throw validationError('currentFacts['+index+']','current_fact_span_invalid','A current fact must be an exact actually delivered original span at the captured revision, not an unread gap or generated summary');
  const factText=span;
  return {sourceId:human.sourceId,text:factText,...(!info.privateEvidenceOnly?{authorization:{permission:{sourceId:human.sourceId,text:evidence.completeText},referent:{sourceId:human.sourceId,text}}}:{})};
 });
}
module.exports={buildCurrentHumanControl,currentFactQuotes};
