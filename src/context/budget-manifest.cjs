'use strict';
const {prepareAssistantRequest}=require('../assistant-model.cjs');
const {PROMPT_VERSION,bytes}=require('./shared.cjs');
function methodTrace(payload) {
  return { purpose: payload.purpose, delivered: (payload.methodCards || []).map(({ id, version }) => ({ id, version })),
    catalog:(payload.methodCatalog||[]).map(({id,version})=>({id,version:version||payload.methodSelection?.version})),
    operationalDelivery:{location:payload.methodSelection?.operationalInstructionsLocation||'payload',ids:(payload.methodCatalog||[]).filter(method=>method.instruction||payload.methodSelection?.operationalInstructionsLocation==='system').map(method=>method.id)},reported: null };
}
function contextBudget(settings, byteBudget, requestMeasure) {
  const base=prepareAssistantRequest(settings,null),measure=requestMeasure||(payload=>prepareAssistantRequest(settings,payload).requestBytes);
  const envelopeBytes=measure(null)-4;
  return {measure,requestByteBudget:base.byteLimit,envelopeBytes,payloadWireByteBudget:base.byteLimit-envelopeBytes,model:settings.model||'',
    fits:payload=>bytes(payload)<=byteBudget&&measure(payload)<=base.byteLimit};
}
function trimEmptyNavigation(payload){
  for(const key of ['actionReceipts','expressionOptions','privateRestrictions','memoryIndex','lookupHistory','preferences','selectedMaterialIds'])
    if(Array.isArray(payload[key])&&!payload[key].length)delete payload[key];
  for(const key of ['selectedOption','reviewRange','currentObservationSourceId'])if(payload[key]===null)delete payload[key];
  if(payload.experienceProposalPolicy?.enabled===false)delete payload.experienceProposalPolicy;
}
function finish(payload, sources, info, allSources, byteBudget, budget) {
  const inputBytes = bytes(payload);
  if (!budget.fits(payload)) throw new Error('本次必要内容超过上下文预算，请缩小所选内容或分段讨论；内容未被截断');
  const ids = sources.filter(s => !s.id.startsWith('request:')).map(s => s.id);
  return { payload, manifest: { requestId: info.requestId, scope: info.scope, purpose: payload.purpose,
    promptVersion: PROMPT_VERSION, contextRevision: info.companion.revision, stateVersion: info.companion.state.version,
    sourceIds: ids, sourceRevisions: Object.fromEntries(sources.map(s => [s.id, s.revision])),
    completeReview: allSources.every(s => ids.includes(s.id)), omittedSourceCount: allSources.filter(s => !ids.includes(s.id)).length,
    historyCoverage: info.coverage, inputBytes, byteBudget, tokenizerVerified: false,
    serializedTextRequestBytes:budget.measure(payload),requestByteBudget:budget.requestByteBudget,requestEnvelopeBytes:budget.envelopeBytes,
    payloadWireByteBudget:budget.payloadWireByteBudget,requestModel:budget.model,
    budgetMethod: 'Complete serialized UTF-8 request envelope plus payload ceiling; tokenizer and provider window unverified',
    methodTrace: methodTrace(payload), createdAt: new Date().toISOString() } };
}

function attachSelectionManifest(context,{historyPolicy,timeCandidateIds,selected,timeSegments,recentPrivateIds,foldedPrivateIds,coreItems,byId,images,payload,compacted,recentPlan,recentContextPlan,recentPriorityIds,recentInitialAdditionalBytes,optionalRawLimit,optionalRawIds,optionalRetrieved}){
  context.manifest.contextSelection={policy:historyPolicy,
    recentQQ:{candidateSourceIds:[...timeCandidateIds],loadedSourceIds:[...timeCandidateIds].filter(id=>selected.has(id)),omittedSourceIds:[...timeCandidateIds].filter(id=>!selected.has(id)),
      segments:timeSegments.map(segment=>({sourceIds:segment.map(m=>`qq:${m.messageId}`),loadedCount:segment.filter(m=>selected.has(`qq:${m.messageId}`)).length}))},
    recentPrivate:{candidateSourceIds:[...recentPrivateIds],loadedSourceIds:[...recentPrivateIds].filter(id=>selected.has(id)),foldedSourceIds:[...recentPrivateIds].filter(id=>foldedPrivateIds.has(id)),omittedSourceIds:[...recentPrivateIds].filter(id=>!selected.has(id)&&!foldedPrivateIds.has(id))},
    coreSourceRefs:[...new Set(coreItems.flatMap(item=>item.sourceIds))].map(id=>({sourceId:id,revision:byId.get(id).revision})),reasons:['current_episode_and_explicit_sources','confirmed_preferences_and_dated_core','recent_time_window','ranked_or_explicit_lookup']};
  if(images)context.images=structuredClone(images);
  if(payload.imageContext)context.mediaContext={mode:payload.imageContext.mode,omitted:structuredClone(payload.imageContext.omitted)};
  if (compacted) context.manifest.discussionCompaction = { cacheId: compacted.id, identity: compacted.identity, reused: true,
    coveredTurns: compacted.sourceTurnIds.length, coveredTurnIds: [...compacted.sourceTurnIds], sourceRevisions: { ...compacted.sourceRevisions }, turnFingerprints: { ...compacted.turnFingerprints },
    foldedSourceIds: [...foldedPrivateIds], authority: 'derived_private_discussion_needs_sources' };
  context.manifest.optionalRawRetrieval={limit:optionalRawLimit,admittedCount:optionalRawIds.size,deferredCount:optionalRetrieved.filter(source=>!selected.has(source.id)).length,ordering:'retrieval_score_then_recency'};
  context.manifest.recentQQContext={limits:recentPlan.limits,projection:recentContextPlan?'loaded':'omitted_for_budget',candidateSourceIds:recentPlan.candidateMessageIds.map(id=>`qq:${id}`),
    admittedPrioritySourceIds:[...recentPriorityIds].filter(id=>selected.has(id)),initialAdditionalBytes:recentInitialAdditionalBytes,ordering:'current_neighborhood_before_optional_history'};
}
module.exports={contextBudget,finish,attachSelectionManifest,trimEmptyNavigation};
