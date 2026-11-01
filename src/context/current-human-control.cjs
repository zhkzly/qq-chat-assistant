'use strict';
const {sameScopeIfPresent}=require('./source-snapshot.cjs');
const {assertDraftSourcesCurrent}=require('./draft-material.cjs');
const {validationError}=require('../validation-issues.cjs');

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
 return {control:{version:1,authority:'CONTROL_ONLY',sourceId,sourceType:source.type,text:source.text},
  dependencies:[{sourceId,revision:source.revision}]};
}
function currentFactQuotes(prepared,facts,info={}){
 if(facts===undefined)return [];
 if(!Array.isArray(facts)||facts.length>8)throw validationError('currentFacts','current_fact_span_invalid','currentFacts must contain at most eight exact current human fact spans');
 if(!facts.length)return [];
 let human;
 try{human=buildCurrentHumanControl(prepared,info).control;}catch(error){throw validationError('currentFacts','current_fact_source_invalid',error.message);}
 if(!human)throw validationError('currentFacts','current_fact_source_invalid','Current facts require the complete original human statement, not an invocation or generated continuation');
 return facts.map((text,index)=>{
  if(typeof text!=='string'||!text.trim()||text.length>4000||!human.text.includes(text))throw validationError(`currentFacts[${index}]`,'current_fact_span_invalid','A current fact must be an exact span of the captured complete human statement');
  return {sourceId:human.sourceId,text,authorization:{permission:{sourceId:human.sourceId,text:human.text},referent:{sourceId:human.sourceId,text}}};
 });
}
module.exports={buildCurrentHumanControl,currentFactQuotes};
