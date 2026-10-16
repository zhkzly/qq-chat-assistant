'use strict';
const VERSION='conversation-work-2026-10-16.1';
const unique=values=>[...new Set(values.filter(value=>typeof value==='string'))];
function buildConversationWork(payload={}){
 const sources=new Map((payload.sources||[]).map(source=>[source.id,source]));
 const available=ids=>unique(ids||[]).filter(id=>sources.has(id));
 const focus=available([...(payload.taskContext?.consultationTask?.focus||[]).map(item=>item.sourceId),...(payload.replyFocus||[]).map(id=>`qq:${id}`)]);
 if(payload.purpose==='draft'){
  const guidance=payload.draftingGuidance||{},controls=[guidance.objective,guidance.allowedApproach,guidance.currentStep,...(guidance.avoidances||[])].filter(Boolean);
  const sourceIds=available([...focus,...controls.flatMap(control=>control.sourceIds||[]),...(payload.outboundQuotes||[]).map(quote=>quote.sourceId)]);
  return {version:VERSION,authority:'derived_work_view_not_factual_evidence',scope:'this_relationship',purpose:'draft',focus:{sourceIds:focus},
   wording:{guidanceFrom:'draftingGuidance',materialFrom:'outboundQuotes',authority:'validated_wording_controls_and_authorized_quotes'},sourceIds,outputUse:'restricted_wording_only'};
 }
 const invocation=payload.taskContext?.invocation||{},sourceId=payload.intentAuthority?.sourceId||payload.taskContext?.currentRequestSourceId||payload.userRequest?.sourceId;
 const topic=payload.topicContext?.active,active=topic?.lifecycle==='active';
 const current=active?{topicId:topic.id,version:topic.version,meaningFrom:'topicContext.active',interpretation:topic.interpretationStatus||'tentative',sourceIds:available(topic.sourceIds)}:null;
 const pending=available(payload.pendingPrivateReview?.sourceIds).filter(id=>{const source=sources.get(id);return source.role==='user'&&['private','feedback'].includes(source.type);});
 const request={sourceId,purpose:invocation.requestedPurpose||payload.purpose,origin:invocation.origin||'user',trigger:invocation.trigger||'private_request',meaningFromSource:sourceId,
  authority:payload.generationOrigin==='qq_observation'?'current_request_not_actual_qq':'current_user_meaning_not_outbound_authorization'};
 return {version:VERSION,authority:'derived_work_view_not_factual_evidence',scope:'this_relationship',request,
  goal:{available:!!payload.goal,meaningFrom:'goal',authority:'user_owned_long_term_direction_not_wording'},current,
  focus:{sourceIds:focus,positionFrom:'taskContext.latestActual'},pendingPrivateIntent:{sourceIds:pending},
  controlsFrom:{current:'topicContext.active',responsePreference:'taskContext.responsePreference',authority:'applicable_controls_not_shareable_facts'},
  sourceIds:available([sourceId,...focus,...(current?.sourceIds||[]),...pending]),outputUse:'planning_only_not_outbound_authorization'};
}
module.exports={buildConversationWork,CONVERSATION_WORK_VERSION:VERSION};
