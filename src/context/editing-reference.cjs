'use strict';
const {digest}=require('./shared.cjs');
const sameRef=(a,b)=>a?.artifactId===b?.artifactId&&a?.version===b?.version;
const AUTHORITY='fallible_generated_editing_reference_not_facts_or_sharing_permission';
// Only live outgoing wording leaves can cross this channel. The program owns
// their bodies; the planner chooses an offered handle, never supplies new text.
function offerEditingReferences({payload,companion,sourceTurnIds=[],currentCandidateRef,store,scope}) {
 if(!store?.experiences)return [];
 const explicitFeedbackIds=new Set(sourceTurnIds.map(id=>companion.turns.find(turn=>turn.id===id)?.feedbackId).filter(Boolean));
 const targets=(payload.feedbackTargets||[]).filter(item=>item.feedback?.sourceId===payload.intentAuthority?.sourceId||explicitFeedbackIds.has(item.feedback?.id));
 const selections=[];
 if(targets.length){
  for(const item of targets){
   if(item.missing||item.target?.kind!=='message_candidate'||item.feedback?.targetRef?.kind!=='artifact')continue;
   const reference=item.feedback.targetRef.artifactRef;
   for(const turn of companion.turns||[])for(const [suggestionIndex,suggestion]of (turn.suggestions||[]).entries())
    if(sameRef(suggestion.artifactRef,reference))selections.push({turnId:turn.id,suggestionIndex,artifactRef:reference,selection:'explicit_feedback_target'});
  }
 }else if(sourceTurnIds.length){
  // Selecting an observed reply offers its outgoing leaves individually. The
  // response body is never converted to a leaf or an automatic first choice.
  for(const turnId of sourceTurnIds){const turn=companion.turns.find(item=>item.id===turnId&&item.role==='assistant');
   for(const [suggestionIndex,item]of (turn?.suggestions||[]).entries())selections.push({turnId,suggestionIndex,artifactRef:item.artifactRef,selection:'explicit_turn_outgoing_candidate'});
  }
 }else if(currentCandidateRef?.suggestionIndex!==undefined)selections.push({...currentCandidateRef,selection:'offered_current_candidate'});
 const offered=[];
 for(const selection of selections.slice(0,3)){
  try{const {text,dependency}=store.experiences.resolveMessageCandidate(scope,selection);
   if(!offered.some(item=>sameRef(item.artifactRef,dependency.artifactRef)))offered.push({...dependency,text,selection:selection.selection,authority:AUTHORITY});
  }catch{ /* Unavailable artifacts cannot be restored from retained turn text. */ }
 }
 return offered;
}
function selectEditingReference(payload,selection) {
 if(selection===undefined)return undefined;
 if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(key=>!['artifactId','version'].includes(key))||
  typeof selection.artifactId!=='string'||!Number.isSafeInteger(selection.version))throw new Error('draftPlan.editingReference: choose an offered artifactId/version handle');
 const offered=(payload.editingReferences||[]).find(item=>sameRef(item.artifactRef,selection));
 if(!offered)throw new Error('draftPlan.editingReference: selected outgoing draft is unavailable or was not offered');
 return {...selection};
}
function resolveEditingReference(prepared,plan,info) {
 const selection=selectEditingReference(prepared.payload,plan.editingReference);
 if(!selection)return undefined;
 const offered=prepared.payload.editingReferences.find(item=>sameRef(item.artifactRef,selection));
 if(!info.store?.experiences)throw new Error('Editing reference requires its live conversation artifact store');
 const {text,dependency}=info.store.experiences.resolveMessageCandidate(info.scope,offered);
 const {text:oldText,selection:origin,authority,...expected}=offered;
 if(text!==oldText||digest(dependency)!==digest(expected))throw new Error('Editing reference artifact changed after planning');
 return {reference:{artifactRef:selection,turnId:dependency.turnId,suggestionIndex:dependency.suggestionIndex,kind:dependency.kind,
  text,bodyDigest:dependency.bodyDigest,authority:AUTHORITY,
  instruction:'FALLIBLE EDITING REFERENCE: 仅作本轮选定的改稿原句。按当前guidance修改；旧句可能含错，不能证明事实、分享许可、实际发送或共同经历。事实与披露仍只依据outboundQuotes和当前有效QQ；缺少依据的旧自述须删去或私下核对。'},dependency};
}
module.exports={offerEditingReferences,selectEditingReference,resolveEditingReference};
