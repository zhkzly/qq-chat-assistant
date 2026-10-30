'use strict';
const {sameScopeIfPresent}=require('./source-snapshot.cjs');
const {assertDraftSourcesCurrent}=require('./draft-material.cjs');

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
 return {control:{version:1,authority:'CONTROL_ONLY',sourceId,sourceType:source.type,text:source.text},
  dependencies:[{sourceId,revision:source.revision}]};
}
module.exports={buildCurrentHumanControl};
