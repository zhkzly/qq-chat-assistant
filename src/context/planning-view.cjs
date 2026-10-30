'use strict';
const {redact}=require('../model.cjs');
const {selectMethods}=require('../help-methods.cjs');
const {validatedCompaction,candidatesForCompaction}=require('../discussion-compaction.cjs');
const {eligibleDiscussionTurns,automaticDiscussionTurnIds}=require('../discussion-compaction-store.cjs');
const {sameScope}=require('../messages.cjs');
const {PROMPT_VERSION,METHODS,sanitize,pick}=require('./shared.cjs');
const {eligibleQQ,sameScopeIfPresent,supportedByAvailable,pendingPrivateReviews,sourceSnapshot}=require('./source-snapshot.cjs');
const {modelTopic,relevantTo,currentCandidateAnchor}=require('./catalog.cjs');
const {requiredQuoteSources,planRecentContext,recentExchange,recentHistoryPolicy,recentHistorySegments}=require('./policy.cjs');
const {contextBudget,finish,attachSelectionManifest}=require('./budget-manifest.cjs');
const {selectPlanningContext}=require('./selection.cjs');
const {SourceHandleOwner}=require('../source-handles.cjs');
const {buildConversationWork,CONVERSATION_WORK_VERSION}=require('../conversation-work.cjs');
const {buildMaterialView,VERSION:MATERIAL_VERSION}=require('../conversation-materials.cjs');
const {boundedSource}=require('./source-delivery.cjs');
const {projectDiscussionReads}=require('./discussion-view.cjs');
const {bytes}=require('./shared.cjs');
const {MATERIAL_POLICY}=require('./draft-material.cjs');
const {offerEditingReferences,editingReferenceView,bindEditingReferenceChoices}=require('./editing-reference.cjs');

function reconcilePlanningViews(payload){
  const sources=new Map(payload.sources.map(source=>[source.id,source])),available=new Set(sources.keys());
  if(payload.materialView){
    payload.materialView.items=payload.materialView.items.flatMap(item=>{
      const original=item.sourceIds||[],kept=original.filter(id=>available.has(id));
      if(!kept.length)return [];
      const group=['current_exchange','already_expressed'].includes(item.kind);
      if(!group&&kept.length!==original.length)return [];
      let projected=item;
      if(kept.length!==original.length)projected={...item,sourceIds:kept,coverage:'partial_selected_sources',omittedSourceCount:(item.omittedSourceCount||0)+original.length-kept.length};
      if(kept.some(id=>sources.get(id).historicalOnly))projected={...projected,availableAs:'historical_reference',currentStatus:'unknown'};
      return [projected];
    });
    if(payload.materialView.currentIntent&&!available.has(payload.materialView.currentIntent.sourceId))delete payload.materialView.currentIntent;
  }
  if(payload.work){
    if(payload.work.sourceIds)payload.work.sourceIds=payload.work.sourceIds.filter(id=>available.has(id));
    for(const value of [payload.work.focus,payload.work.current,payload.work.pendingPrivateIntent])if(value?.sourceIds)value.sourceIds=value.sourceIds.filter(id=>available.has(id));
  }
}
function projectPlanningViews(payload,budget){
  // Build the local content views once, after source admission. Later budget
  // eviction can only remove unavailable references, never add material.
  payload.work=buildConversationWork(payload);
  payload.materialView=buildMaterialView({sources:payload.sources,taskContext:payload.taskContext,coreMemory:payload.coreMemory,
    relationshipContext:payload.relationshipContext,topicContext:payload.topicContext,allowedMaterialIds:payload.allowedMaterialIds,
    asOf:payload.asOf,recentHours:payload.contextPolicy?.recentHours,work:payload.work});
}
function compactPlanningViews(payload){
  if(!payload.materialView)return false;
  payload.materialView={version:payload.materialView.version,items:payload.materialView.items.slice(0,2).map(item=>pick(item,['kind','sourceIds','coverage','omittedSourceCount','availableAs','currentStatus'])),projection:'source_refs'};
  const work=payload.work;
  payload.work={version:work.version,sourceIds:work.sourceIds||[],projection:'source_refs'};
  return true;
}
function buildContext(options) {
  if(options.store?.experiences)options={...options,companion:options.store.experiences.projectCompanion(options.scope,options.companion)};
  // Standalone canonical API consumers need the same scoped owner as the
  // controller. Rebuilds reuse it rather than inventing a fresh namespace.
  if(!options.settings?.sourceHandleOwner)options={...options,settings:{...options.settings,sourceHandleOwner:new SourceHandleOwner({scope:options.scope,taskId:options.requestId})}};
  const { scope, records, companion, turn, purpose = 'discussion', coverage, requestId,
  materialIds = [], byteBudget = 48000, availableSources, memoryResult, memoryIndex = [], retrievedSources = [],
  sourceTurnIds = [], selectedOption, replyMessageIds = [], imageMessageIds = [], images, mediaContext, actionReceipts = [], lookupHistory = [], reviewRange,
  relationshipContext = null, experienceContext = null, topicContext = null, intentSourceId = null,
  generationOrigin = 'private_discussion', currentObservationSourceId = null,
  asOf:providedAsOf = new Date().toISOString(), viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, invocation,
  discussionCompaction = null, sourceLookupIds = [], retrievedDiscussion = [], currentCandidateRef, candidateAlternative=false,
  feedbackTargets = [], allowExperienceProposals = purpose === 'review', responsePreference, settings = {}, requestMeasure } = options;
  if(typeof providedAsOf!=='string'||!Number.isFinite(Date.parse(providedAsOf)))throw new Error('上下文观察时间不合法');
  const asOf=new Date(providedAsOf).toISOString();
  const historyPolicy=recentHistoryPolicy(asOf,settings),recentSince=Date.parse(historyPolicy.since);
  const inRecentWindow=at=>Number.isFinite(Date.parse(at))&&Date.parse(at)>=recentSince&&Date.parse(at)<=Date.parse(asOf);
  if(typeof viewerTimeZone!=='string'||!viewerTimeZone.trim())throw new Error('上下文查看时区不合法');
  try{new Intl.DateTimeFormat('en-CA',{timeZone:viewerTimeZone});}catch{throw new Error('上下文查看时区不合法');}
  if (!METHODS[purpose] || purpose === 'draft') throw new Error('未知的上下文用途');
  if (!Number.isFinite(byteBudget) || byteBudget < 4000 || byteBudget > 192000) throw new Error('上下文预算不合法');
  const snapshot=sourceSnapshot({scope,records,companion,availableSources,turn});
  const {actualById,all,byId,current}=snapshot;
  const sourceReferenceRevisions=Object.freeze(Object.fromEntries(all.map(source=>[source.id,source.revision])));
  const budget=contextBudget(settings,byteBudget,requestMeasure,{sourceRevisions:sourceReferenceRevisions}),fits=budget.fits;
  const readRequests=new Map(retrievedSources.map(source=>[source.id,source]));
  const privateReadView=id=>{const request=readRequests.get(id);return boundedSource(byId.get(id),{maxBytes:6000,start:request?.delivery?.start??request?.offset??0,maxChars:request?.delivery?request.delivery.end-request.delivery.start:request?.maxChars??Infinity});};
  const pendingIntents = pendingPrivateReviews(companion, byId);
  const explicitTurnIds=new Set([...sourceTurnIds,...sourceLookupIds.map(id=>id.replace(/^private:/,'')),selectedOption?.turnId].filter(Boolean));
  const automaticIds=automaticDiscussionTurnIds(companion,{store:options.store,scope});
  const eligibleTurns=eligibleDiscussionTurns(companion,{store:options.store,scope});
  const automaticTurn=entry=>entry.role==='assistant'&&automaticIds.has(entry.id)&&!explicitTurnIds.has(entry.id);
  const protectedPendingIds = pendingIntents.slice(-3).map(source => source.id);
  const compacted = validatedCompaction(discussionCompaction, { scope, companion, turn, availableSources: all, settings, promptVersion: PROMPT_VERSION,store:options.store });
  const coveredTurnIds = new Set(compacted?.sourceTurnIds || []);
  const protectedPrivateIds = new Set([current.id, intentSourceId, ...protectedPendingIds, ...sourceLookupIds.map(id => id.startsWith('private:') ? id : `private:${id}`)]);
  const latestPriorUser = [...eligibleTurns].reverse().find(item => item.role === 'user' && item.id !== turn.id);
  if (latestPriorUser) protectedPrivateIds.add(`private:${latestPriorUser.id}`);
  for (const id of sourceTurnIds) if (companion.turns.some(item => item.id === id && item.role === 'user')) protectedPrivateIds.add(`private:${id}`);
  const foldedPrivateIds = new Set(compacted ? Object.keys(compacted.sourceRevisions).filter(id => byId.get(id)?.type === 'private' && !protectedPrivateIds.has(id)) : []);
  if (!Array.isArray(materialIds) || materialIds.length>12 || materialIds.some(id => typeof id !== 'string' || !companion.notes.some(n => n.id === id && n.use === 'draft')))
    throw new Error('草稿素材必须是当前联系人允许分享的近况');
  const selected = new Map([[current.id, current]]);
  for (const id of protectedPendingIds) {const source=boundedSource(byId.get(id),{maxBytes:4000});if(source)selected.set(id,source);}
  // The latest user correction is cheap authoritative context. Prior assistant
  // essays and automatic outputs are loaded only when the task actually needs
  // that discussion, rather than being attached to this user turn by accident.
  const latestPrivateSource=latestPriorUser&&byId.get(`private:${latestPriorUser.id}`);
  const latestPrivateIsCurrent=latestPrivateSource&&(generationOrigin!=='qq_observation'||inRecentWindow(latestPrivateSource.at)||
    relevantTo(recentExchange([...actualById.values()]).map(m=>m.text).join('\n'),latestPrivateSource));
  if(latestPrivateIsCurrent&&bytes(latestPrivateSource)<=6000&&!foldedPrivateIds.has(latestPrivateSource.id))selected.set(latestPrivateSource.id,latestPrivateSource);
  const validQQ = records.filter(m => eligibleQQ(m) && sameScope(m,scope) && byId.has(`qq:${m.messageId}`));
  const protectedImageIds=[...new Set([...imageMessageIds,...(images||[]).map(image=>image.messageId)])];
  // Preserve one bounded actual exchange. Source ranges disclose oversized
  // messages; earlier bubbles remain available through the same source registry.
  let exchangeBytes=0;const exchangeLimit=Math.min(12000,Math.floor(byteBudget*0.65));
  for (const message of [...recentExchange(validQQ)].reverse()) {
    const source=byId.get(`qq:${message.messageId}`),projected=boundedSource(source,{maxBytes:Math.min(8000,exchangeLimit-exchangeBytes)});
    if(!projected||exchangeBytes+bytes(projected)>exchangeLimit)break;
    selected.set(projected.id,projected);exchangeBytes+=bytes(projected);
  }
  for(const id of requiredQuoteSources(records,byId,[...replyMessageIds,...protectedImageIds])) {const source=boundedSource(byId.get(id),{maxBytes:Math.min(16000,byteBudget)});if(source)selected.set(id,source);}
  for (const id of materialIds) selected.set(`note:${id}`, boundedSource(byId.get(`note:${id}`),{maxBytes:6000}));
  for (const id of replyMessageIds) if (byId.has(`qq:${id}`)) selected.set(`qq:${id}`, boundedSource(byId.get(`qq:${id}`),{maxBytes:6000}));
  for (const id of protectedImageIds) if (byId.has(`qq:${id}`)) selected.set(`qq:${id}`, boundedSource(byId.get(`qq:${id}`),{maxBytes:6000}));
  const selectedProposal = selectedOption && companion.turns.find(t => t.id === selectedOption.turnId && t.role === 'assistant')?.expressionOptions?.[selectedOption.index];
  if (selectedOption && (!selectedProposal||!selectedProposal.label?.trim()||selectedProposal.availability==='unavailable')) throw new Error('选中的表达方向已变化，请重新选择');
  const proposals = companion.turns.filter(t => t.role === 'assistant' && !automaticTurn(t) && t.expressionOptions?.length).slice(-4)
    .flatMap(t => t.expressionOptions.map((o, index) => ({ ...o, turnId: t.id, index })));
  for (const proposal of selectedProposal ? [selectedProposal] : []) for (const q of proposal.quotes || [])
    if (byId.has(q.sourceId)) { const source=byId.get(q.sourceId),offset=source.text.indexOf(q.text);selected.set(q.sourceId, boundedSource(source,{start:Math.max(0,offset),maxBytes:6000})); foldedPrivateIds.delete(q.sourceId); }
  for (const id of sourceLookupIds) {
    const sourceId = id.startsWith('private:') ? id : `private:${id}`;
    if (byId.has(sourceId)) { selected.set(sourceId,privateReadView(sourceId)); foldedPrivateIds.delete(sourceId); }
  }
  for(const id of sourceTurnIds){
    const original=companion.turns.find(t=>t.id===id&&t.role==='user');
    if(original&&byId.has(`private:${id}`)){selected.set(`private:${id}`,privateReadView(`private:${id}`));foldedPrivateIds.delete(`private:${id}`);}
  }
  const intentSource = intentSourceId ? byId.get(intentSourceId) : current;
  if (!intentSource || !['private','request','feedback'].includes(intentSource.type) || intentSource.role !== 'user')
    throw new Error('当前意图来源已变化，请重新提交');
  selected.set(intentSource.id,intentSource);
  const topicView = topicContext || companion.topics || companion.consultationTask || { version: 0, activeId: null, items: [] };
  const activeTopic = sameScopeIfPresent(topicView, scope) && (topicView.active || (topicView.items || []).find(item => item.id === topicView.activeId));
  const groundedTopic = activeTopic?.lifecycle === 'active' && supportedByAvailable(activeTopic, byId, scope) ? activeTopic : null;
  // A grounded current task is a bounded control view, not a raw-source floor.
  // Original task evidence remains addressable and enters through relevance/read admission.
  const essentialIds = new Set([...selected.keys()].filter(id=>id!==latestPrivateSource?.id||id===current.id||protectedPendingIds.includes(id)||id===intentSource.id));
  const recentPlan=planRecentContext(validQQ,{replyMessageIds,imageMessageIds:protectedImageIds,byteBudget});
  const timeSegments=recentHistorySegments(validQQ,historyPolicy),timeCandidateIds=new Set(timeSegments.flat().map(m=>`qq:${m.messageId}`)),timePriorityIds=new Set();
  const recentPrivateIds=new Set(eligibleTurns.filter(t=>t.role==='user'&&t.id!==turn.id&&inRecentWindow(t.createdAt)&&byId.has(`private:${t.id}`)).map(t=>`private:${t.id}`));
  const reviewing=purpose==='review';
  const privateRequest=generationOrigin!=='qq_observation';
  const queryText=[turn.transient?'':current.text,...validQQ.filter(m=>recentPlan.candidateMessageIds.includes(m.messageId)).map(m=>m.text),
    ...(privateRequest&&latestPrivateSource&&selected.has(latestPrivateSource.id)?[latestPrivateSource.text]:[])].filter(Boolean).join('\n');
  const relevantRecord=record=>reviewing||record.sourceIds?.some(id=>essentialIds.has(id))||relevantTo(queryText,record)||
    (record.sourceIds||[]).some(id=>relevantTo(queryText,byId.get(id)||{}));
  const state = { ...pick(companion.state,['version','items','possiblyStale','lastReviewedAt','updatedAt']), ownership:'evidence_only_task_controls_in_topicContext', authority: companion.state.possiblyStale ? 'previous_summary_needs_review' : 'reviewed_summary_not_independent_evidence' };
  const originalStateCount=(state.items||[]).length;
  for(const key of ['items']){
    const relevant=(state[key]||[]).filter(relevantRecord);
    state[key]=(relevant.length||!privateRequest?relevant:(state[key]||[]).slice(-2)).slice(0,reviewing?16:4);
  }
  const methodSelection = selectMethods({ purpose, hasReply: validQQ.at(-1)?.direction === 'incoming',methodIds:options.methodLookupIds });
  const restrictions = companion.notes.filter(n => n.use === 'discussion' && n.kind !== 'preference').map(n => ({ sourceId: `note:${n.id}`, text: redact(n.text), evidenceSourceIds: n.evidenceSourceIds || [] }));
  const payload = { promptVersion: PROMPT_VERSION, purpose, method: METHODS[purpose], methodCards: [],methodCatalog:methodSelection.catalog, methodSelection: {
    version: methodSelection.version, selection: methodSelection.selection, candidates: [],
    maxApplied: methodSelection.maxApplied,...(methodSelection.operationalInstructionsLocation?{operationalInstructionsLocation:methodSelection.operationalInstructionsLocation}:{}), selectionRule: methodSelection.selectionRule, feedbackRule: methodSelection.feedbackRule }, asOf,viewerTimeZone,
    userRequest: { sourceId: current.id, text: current.text }, goal: redact(companion.goal.text || ''),
    intentAuthority: { sourceId: intentSource.id },
    requestDeliveryPolicy:{version:1,...(options.requestDeliveryObligation?{obligation:{mode:options.requestDeliveryObligation.mode}}:{}),...(options.lookupExhausted?{lookupExhausted:true}:{})},draftMaterialPolicy:{...MATERIAL_POLICY},
    generationOrigin,
    currentObservationSourceId: generationOrigin === 'qq_observation' ? currentObservationSourceId || (validQQ.at(-1) && `qq:${validQQ.at(-1).messageId}`) : null,
    topicContext: { version: topicView.version || 0, activeId: groundedTopic?.id || null,
      active: groundedTopic ? modelTopic({...pick(groundedTopic, ['id','version','lifecycle','objective','direction','constraints','stage','progress','unknowns','interpretationStatus','purposeBindings','observationBindings','observationAuthorities','purposeSourceIds','observationSourceIds','lifecycleSourceIds','sourceIds']),sourceAvailability:groundedTopic.sourceIds.every(id=>selected.has(id))?'delivered':'lookup_required',sourceRefs:groundedTopic.sourceIds.map(id=>({sourceId:id,revision:byId.get(id).revision})),authority:'source_bound_task_control_not_outbound_permission'}) : null,
      retained: [], authority: 'private_direction_not_outbound_authorization' },
    workingState: state, coverage, selectedMaterialIds: materialIds.map(id => `note:${id}`),
    allowedMaterialIds: [],
    expressionOptions: selectedProposal ? proposals.filter(o=>o.turnId===selectedOption.turnId&&o.index===selectedOption.index) : [], selectedOption: selectedOption || null,
    actionReceipts: actionReceipts.map(r=>({id:r.id,type:r.type,status:r.status,label:r.label,text:r.text||r.preview,reason:r.reason})),
    privateRestrictions: [], preferences: [], experienceProposalPolicy: { enabled: false, maxItems: 2, feedbackSourceIds: [], caseIds: [] },
    replyFocus: replyMessageIds, lookupHistory, reviewRange: reviewRange || null,
    retrievedMemory: { items: [], episodes: [], coverage: memoryResult?.coverage || null }, memoryIndex: [],
    sources: [...selected.values()], privateConversation: [],
    evidenceRule: 'historicalOnly=true 的消息仅为历史提及，后续可能有未读的更改，不可据此断言当前约定有效。possiblyStale 的状态只作需要核查的上次理解，新原话与用户纠正优先。',
    contextPolicy:{recentHours:historyPolicy.recentHours,since:historyPolicy.since},
    deferredContext:{lookupAvailable:true,qqSourceCount:0,privateTurnCount:0,relationshipClaimCount:0,recentQQSourceCount:0,recentPrivateSourceCount:0},
    omittedStateEntries: originalStateCount-state.items.length };
  if(payload.topicContext.active){
    const bindings=groundedTopic.purposeBindings||{};let refs=new Map(),currentConfirmed=false;const omittedControlFields=[];
    for(const field of ['objective','direction','constraints']){
      const binding=bindings[field];
      if(payload.topicContext.active[field]===undefined||!binding?.sourceIds?.length||!binding.sourceIds.every(id=>{
        const source=byId.get(id);return source&&source.role==='user'&&['private','feedback'].includes(source.type)&&source.kind!=='feedback_continue'&&binding.sourceRevisions?.[id]===source.revision;
      }))continue;
      currentConfirmed ||= binding.sourceIds.includes(intentSource.id);
      const candidate=new Map([...refs].map(([id,ref])=>[id,{...ref,fields:[...ref.fields]}]));
      for(const id of binding.sourceIds){const ref=candidate.get(id)||{sourceId:id,revision:byId.get(id).revision,fields:[]};ref.fields.push(field);candidate.set(id,ref);}
      if(bytes([...candidate.values()])<=2000)refs=candidate;else omittedControlFields.push(field);
    }
    payload.topicContext.controlRefs=[...refs.values()];
    if(omittedControlFields.length)payload.topicContext.omittedControlFields=omittedControlFields;
    payload.topicContext.active.applicability=currentConfirmed?'current_user_confirmed':'requires_current_request_match';
    payload.topicContext.active.applicabilityRule='current_request_wins_choose_continue_different_or_uncertain_before_using_prior_task_controls';
  }
  if (pendingIntents.length) {
    const recent = pendingIntents.slice(-8);
    const refs = recent.map(source => {
      const originalTurn = source.type === 'private' && companion.turns.find(item => item.role === 'user' && `private:${item.id}` === source.id);
      return { sourceId: source.id, type: source.type, ...(originalTurn ? { turnId: originalTurn.id } : {}),
        bindingStatus: source.pendingBindingStatus,
        availability: selected.has(source.id) ? 'full' : 'needs_lookup' };
    });
    payload.pendingPrivateReview = { authority: 'unreviewed_private_intent_not_external_fact', sourceIds: recent.map(source => source.id),
      protectedSourceIds: protectedPendingIds, refs, lookupTurnIds: refs.filter(ref => ref.turnId).map(ref => ref.turnId),
      omittedCount: pendingIntents.length - recent.length };
    if (payload.topicContext.active) payload.topicContext.active.reviewPending = true;
  }
  if (compacted) {
    payload.discussionCompaction = { id: compacted.id, summary: redact(compacted.summary), sourceTurnIds: [...compacted.sourceTurnIds],
      lookupTurnIds: [...new Set([...compacted.sourceTurnIds, ...[...foldedPrivateIds].map(id => id.slice(8))])],
      coverage: compacted.coverage, authority: 'derived_private_discussion_needs_sources' };
    if (payload.topicContext.active && payload.topicContext.active.sourceIds.some(id => foldedPrivateIds.has(id))) Object.assign(payload.topicContext.active, {
      authority: 'derived_private_discussion_needs_sources', foldedSourceIds: payload.topicContext.active.sourceIds.filter(id => foldedPrivateIds.has(id)), sourceAvailability: 'folded_originals_require_lookup' });
  }
  if(retrievedDiscussion.length){
    const projection=projectDiscussionReads(retrievedDiscussion,{sources:selected,byteBudget,store:options.store,scope});
    payload.retrievedDiscussion=projection.entries;payload.discussionReadCoverage={...pick(projection,['bodyView','offsetUnit','byteLimit','omittedTurnIds']),requestedTurnIds:retrievedDiscussion.map(item=>item.id)};
  }
  const manualAlternative=candidateAlternative===true&&invocation?.origin==='user'&&invocation?.trigger==='manual_suggestion';
  const implicitAnchor=(privateRequest||manualAlternative)&&!sourceTurnIds.length&&!selectedOption?currentCandidateAnchor(companion,currentCandidateRef,{store:options.store,scope}):null;
  const candidatePool = candidatesForCompaction(compacted, companion, { sourceTurnIds, selectedOption, sourceLookupIds,store:options.store,scope }).filter(candidate=>
    !automaticTurn(companion.turns.find(t=>t.id===candidate.turnId)||{})&&(privateRequest||compacted||explicitTurnIds.has(candidate.turnId)));
  if(implicitAnchor){
    for(let index=candidatePool.length-1;index>=0;index--)if(candidatePool[index].turnId===implicitAnchor.turnId)candidatePool.splice(index,1);
    candidatePool.unshift(implicitAnchor);
  }
  const preferredCandidateTurnIds = new Set([...[...eligibleTurns].reverse().filter(item => item.role === 'assistant').slice(0, 1).map(item => item.id), ...sourceTurnIds, selectedOption?.turnId, ...sourceLookupIds].filter(Boolean));
  if(implicitAnchor)preferredCandidateTurnIds.add(implicitAnchor.turnId);
  const candidates={selected,automaticTurn,eligibleTurns,explicitTurnIds,inRecentWindow,validQQ,foldedPrivateIds,essentialIds,recentPlan,timeSegments,timeCandidateIds,timePriorityIds,recentPrivateIds,reviewing,privateRequest,relevantRecord,queryText,protectedPendingIds,selectedProposal,proposals,intentSource,topicView,compacted,coveredTurnIds,candidatePool,preferredCandidateTurnIds};
  const coreInventory=[...(options.coreMemory||options.store?._memoryRecords?.(scope)||[]),...(memoryResult?.items||[]),...memoryIndex,...(relationshipContext?.claims||[])];
  const {coreItems,optionalRawLimit,optionalRawIds,optionalRetrieved,recentContextPlan,recentPriorityIds,recentInitialAdditionalBytes}=selectPlanningContext({options:{...options,asOf,viewerTimeZone},snapshot,candidates,view:{payload,state,methodSelection,restrictions},budget,coreInventory,projectPlanningViews,reconcilePlanningViews,compactPlanningViews});
  const editingReferences=offerEditingReferences({payload,companion,sourceTurnIds,currentCandidateRef:implicitAnchor?currentCandidateRef:undefined,store:options.store,scope});
  if(editingReferences.length){payload.editingReferences=editingReferenceView(editingReferences);if(!fits(payload)){delete payload.editingReferences;if(editingReferences.some(item=>item.selection.startsWith('explicit_')))throw new Error('选定改稿原句超过上下文预算；没有静默截断');}}
  const currentRequest=payload.userRequest,position=payload.taskContext;delete payload.userRequest;delete payload.taskContext;
  payload.taskContext=position;payload.userRequest=currentRequest;
  const context=finish(payload, payload.sources, { scope, requestId, companion, coverage }, all, byteBudget, budget);
  attachSelectionManifest(context,{historyPolicy,timeCandidateIds,selected,timeSegments,recentPrivateIds,foldedPrivateIds,coreItems,byId,images,payload,compacted,recentPlan,recentContextPlan,recentPriorityIds,recentInitialAdditionalBytes,optionalRawLimit,optionalRawIds,optionalRetrieved,taskSourceIds:groundedTopic?.sourceIds||[]});
  context.manifest.planningViews={workVersion:payload.work?.version||CONVERSATION_WORK_VERSION,materialVersion:payload.materialView?.version||MATERIAL_VERSION,
    materialRefs:(payload.materialView?.items||[]).map(({kind,sourceIds})=>({kind,sourceIds})),projection:payload.materialView?payload.materialView.projection||'full':'omitted_for_required_evidence'};
  if(implicitAnchor){const delivered=payload.privateCandidates?.find(item=>item.selection==='implicit_discussion_anchor'&&item.turnId===implicitAnchor.turnId);
    context.manifest.implicitDiscussionAnchor={turnId:implicitAnchor.turnId,artifactRef:implicitAnchor.artifactRef,field:implicitAnchor.field,...(implicitAnchor.index!==undefined?{index:implicitAnchor.index}:{}),availability:delivered?.availability||'omitted_for_budget'};}
  if(payload.editingReferences)bindEditingReferenceChoices(context,editingReferences);
  Object.defineProperty(context,'sourceReferenceRevisions',{value:sourceReferenceRevisions});
  Object.defineProperty(context,'sourceHandleOwner',{value:options.settings?.sourceHandleOwner,writable:true,configurable:true});
  context.essentialSourceIds=[...essentialIds];
  Object.defineProperty(context, 'fullAvailableSources', { value: all });
  Object.defineProperty(context,'rebuildForRequest',{value:measure=>{
    options.store?.experiences.assertInputArtifactsCurrent(scope,context.manifest.inputArtifactRefs||[]);
    return buildContext({...options,asOf,viewerTimeZone,invocation,requestMeasure:measure});
  }});
  context.restrictions=restrictions;
  return context;
}
module.exports={buildContext,reconcilePlanningViews};
