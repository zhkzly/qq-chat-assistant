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
function editingReferenceView(references) {
 return references.map((item,index)=>({choice:`e${index+1}`,text:item.text,selection:item.selection,authority:item.authority}));
}
function editingContextBinding(context,references) {
 return digest({scope:context.manifest.scope,requestId:context.manifest.requestId,asOf:context.payload.asOf,
  sourceRevisions:context.manifest.sourceRevisions,references});
}
function freezeSnapshot(value) {
 if(value&&typeof value==='object'){for(const child of Object.values(value))freezeSnapshot(child);Object.freeze(value);}return value;
}
function bindEditingReferenceChoices(context,references) {
 const snapshot=freezeSnapshot(structuredClone(references));
 const bindingId=editingContextBinding(context,snapshot);
 context.editingReferenceChoices=Object.freeze({bindingId,references:snapshot});
 context.manifest.inputArtifactRefs=snapshot.map(({text,selection,authority,...dependency})=>dependency);
 context.manifest.editingChoices=snapshot.map((item,index)=>({choice:`e${index+1}`,artifactRef:{...item.artifactRef}}));
}
function editingState(input) {
 const payload=input?.payload||input;
 const state=input?.editingReferenceChoices;
 if(state&&state.bindingId!==editingContextBinding(input,state.references))throw new Error('draftPlan.editingReference: private prepared choices changed');
 return {payload,state,references:state?.references||(payload?.editingReferences||[]).filter(item=>item.artifactRef)};
}
function editingReferenceBinding(input) {return input?.editingReferenceChoices?.bindingId;}
function selectEditingReference(input,selection,bindingId) {
 if(selection===undefined)return undefined;
 const {state,references}=editingState(input);
 if(bindingId!==undefined&&(!state||bindingId!==state.bindingId))throw new Error('draftPlan.editingReference: prepared context binding changed; choose from the current choices');
 if(!selection||typeof selection!=='object'||Array.isArray(selection))throw new Error('draftPlan.editingReference: choose an offered short choice');
 let offered;
 if(Object.hasOwn(selection,'choice')){
  if(Object.keys(selection).length!==1||typeof selection.choice!=='string'||!state)throw new Error('draftPlan.editingReference: short choice requires its private prepared context');
  const index=references.findIndex((_item,index)=>selection.choice===`e${index+1}`);offered=index<0?undefined:references[index];
 }else{
  // Exact legacy references remain strict. Never repair a corrupted ID or an
  // omitted/wrong version by guessing which offered leaf the model meant.
  if(Object.keys(selection).some(key=>!['artifactId','version'].includes(key))||typeof selection.artifactId!=='string'||!Number.isSafeInteger(selection.version))
   throw new Error('draftPlan.editingReference: legacy selection requires exact artifactId/version');
  offered=references.find(item=>sameRef(item.artifactRef,selection));
 }
 if(!offered)throw new Error('draftPlan.editingReference: selected outgoing draft is unavailable or was not offered');
 return {...offered.artifactRef};
}
function resolveEditingReference(prepared,plan,info) {
 if(plan.editingReference?.choice!==undefined)throw new Error('draftPlan.editingReference: short choice must be bound by the preparation parser before wording');
 const selection=selectEditingReference(prepared,plan.editingReference,plan.editingReferenceBinding);
 if(!selection)return undefined;
 const offered=editingState(prepared).references.find(item=>sameRef(item.artifactRef,selection));
 if(!info.store?.experiences)throw new Error('Editing reference requires its live conversation artifact store');
 const {text,dependency}=info.store.experiences.resolveMessageCandidate(info.scope,offered);
 const {text:oldText,selection:origin,authority,...expected}=offered;
 if(text!==oldText||digest(dependency)!==digest(expected))throw new Error('Editing reference artifact changed after planning');
 return {reference:{artifactRef:selection,turnId:dependency.turnId,suggestionIndex:dependency.suggestionIndex,kind:dependency.kind,
  text,bodyDigest:dependency.bodyDigest,authority:AUTHORITY,
  instruction:'FALLIBLE EDITING REFERENCE: 仅作本轮改稿原句。以当前完整人类原话与明确UI选择理解修改目标，guidance仅可修正提议；旧句不能证明事实、分享许可、实际发送或共同经历。事实只依据outboundQuotes和当前有效QQ，缺少依据的旧自述不保留为事实。'},dependency};
}
module.exports={offerEditingReferences,editingReferenceView,bindEditingReferenceChoices,editingReferenceBinding,selectEditingReference,resolveEditingReference};
