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
const {buildConversationWork,CONVERSATION_WORK_VERSION}=require('../conversation-work.cjs');
const {buildMaterialView,VERSION:MATERIAL_VERSION}=require('../conversation-materials.cjs');
const {MATERIAL_POLICY}=require('./draft-material.cjs');

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
  const budget = contextBudget(settings, byteBudget, requestMeasure), fits = budget.fits;
  if (!METHODS[purpose] || purpose === 'draft') throw new Error('未知的上下文用途');
  if (!Number.isFinite(byteBudget) || byteBudget < 4000 || byteBudget > 192000) throw new Error('上下文预算不合法');
  const snapshot=sourceSnapshot({scope,records,companion,availableSources,turn});
  const {actualById,all,byId,current}=snapshot;
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
  for (const id of protectedPendingIds) selected.set(id, byId.get(id));
  // The latest user correction is cheap authoritative context. Prior assistant
  // essays and automatic outputs are loaded only when the task actually needs
  // that discussion, rather than being attached to this user turn by accident.
  const latestPrivateSource=latestPriorUser&&byId.get(`private:${latestPriorUser.id}`);
  const latestPrivateIsCurrent=latestPrivateSource&&(generationOrigin!=='qq_observation'||inRecentWindow(latestPrivateSource.at)||
    relevantTo(recentExchange([...actualById.values()]).map(m=>m.text).join('\n'),latestPrivateSource));
  if(latestPrivateIsCurrent&&!foldedPrivateIds.has(latestPrivateSource.id))selected.set(latestPrivateSource.id,latestPrivateSource);
  const validQQ = records.filter(m => eligibleQQ(m) && sameScope(m,scope) && byId.has(`qq:${m.messageId}`));
  const protectedImageIds=[...new Set([...imageMessageIds,...(images||[]).map(image=>image.messageId)])];
  // Protect both complete sides of the latest exchange, including after the
  // user has already replied in several bubbles. Never lose her boundary then.
  for (const message of recentExchange(validQQ)) selected.set(`qq:${message.messageId}`, byId.get(`qq:${message.messageId}`));
  for(const id of requiredQuoteSources(records,byId,[...replyMessageIds,...protectedImageIds]))selected.set(id,byId.get(id));
  for (const id of materialIds) selected.set(`note:${id}`, byId.get(`note:${id}`));
  for (const id of replyMessageIds) if (byId.has(`qq:${id}`)) selected.set(`qq:${id}`, byId.get(`qq:${id}`));
  for (const id of protectedImageIds) if (byId.has(`qq:${id}`)) selected.set(`qq:${id}`, byId.get(`qq:${id}`));
  const selectedProposal = selectedOption && companion.turns.find(t => t.id === selectedOption.turnId && t.role === 'assistant')?.expressionOptions?.[selectedOption.index];
  if (selectedOption && !selectedProposal) throw new Error('选中的表达方向已变化，请重新选择');
  const proposals = companion.turns.filter(t => t.role === 'assistant' && !automaticTurn(t) && t.expressionOptions?.length).slice(-4)
    .flatMap(t => t.expressionOptions.map((o, index) => ({ ...o, turnId: t.id, index })));
  for (const proposal of selectedProposal ? [selectedProposal] : []) for (const q of proposal.quotes || [])
    if (byId.has(q.sourceId)) { selected.set(q.sourceId, byId.get(q.sourceId)); foldedPrivateIds.delete(q.sourceId); }
  for (const id of sourceLookupIds) {
    const sourceId = id.startsWith('private:') ? id : `private:${id}`;
    if (byId.has(sourceId)) { selected.set(sourceId, byId.get(sourceId)); foldedPrivateIds.delete(sourceId); }
  }
  for(const id of sourceTurnIds){
    const original=companion.turns.find(t=>t.id===id&&t.role==='user');
    if(original&&byId.has(`private:${id}`)){selected.set(`private:${id}`,byId.get(`private:${id}`));foldedPrivateIds.delete(`private:${id}`);}
  }
  const intentSource = intentSourceId ? byId.get(intentSourceId) : current;
  if (!intentSource || !['private','request','feedback'].includes(intentSource.type) || intentSource.role !== 'user')
    throw new Error('当前意图来源已变化，请重新提交');
  selected.set(intentSource.id, intentSource);
  const topicView = topicContext || companion.topics || { version: 0, activeId: null, items: [] };
  const activeTopic = sameScopeIfPresent(topicView, scope) && (topicView.active || (topicView.items || []).find(item => item.id === topicView.activeId));
  const groundedTopic = activeTopic?.lifecycle === 'active' && supportedByAvailable(activeTopic, byId, scope) ? activeTopic : null;
  if (groundedTopic) for (const id of groundedTopic.sourceIds) if (!foldedPrivateIds.has(id)) selected.set(id, byId.get(id));
  const essentialIds = new Set(selected.keys());
  const recentPlan=planRecentContext(validQQ,{replyMessageIds,imageMessageIds:protectedImageIds,byteBudget});
  const timeSegments=recentHistorySegments(validQQ,historyPolicy),timeCandidateIds=new Set(timeSegments.flat().map(m=>`qq:${m.messageId}`)),timePriorityIds=new Set();
  const recentPrivateIds=new Set(eligibleTurns.filter(t=>t.role==='user'&&t.id!==turn.id&&inRecentWindow(t.createdAt)&&byId.has(`private:${t.id}`)).map(t=>`private:${t.id}`));
  const reviewing=purpose==='review';
  const privateRequest=generationOrigin!=='qq_observation';
  const queryText=[turn.transient?'':current.text,...validQQ.filter(m=>recentPlan.candidateMessageIds.includes(m.messageId)).map(m=>m.text),
    ...(privateRequest&&latestPriorUser?[latestPriorUser.text]:[]),groundedTopic?.objective,groundedTopic?.direction].filter(Boolean).join('\n');
  const relevantRecord=record=>reviewing||record.sourceIds?.some(id=>essentialIds.has(id))||relevantTo(queryText,record)||
    (record.sourceIds||[]).some(id=>relevantTo(queryText,byId.get(id)||{}));
  const state = { ...companion.state, authority: companion.state.possiblyStale ? 'previous_summary_needs_review' : 'reviewed_summary_not_independent_evidence' };
  const originalStateCount=['items','openThreads','unknowns'].reduce((n,key)=>n+(state[key]||[]).length,0);
  for(const key of ['items','openThreads']){
    const relevant=(state[key]||[]).filter(relevantRecord);
    state[key]=(relevant.length||!privateRequest?relevant:(state[key]||[]).slice(-2)).slice(0,reviewing?16:4);
  }
  const relevantUnknowns=(state.unknowns||[]).filter(text=>reviewing||relevantTo(queryText,{text}));
  state.unknowns=(relevantUnknowns.length||!privateRequest?relevantUnknowns:(state.unknowns||[]).slice(-2)).slice(0,reviewing?12:4);
  if(!reviewing&&!groundedTopic&&!relevantTo(queryText,{text:state.focus}))state.focus='';
  if (state.possiblyStale) state.openThreads = (state.openThreads || []).map(item => ({ ...item,
    previousStatus: item.status || 'open', status: 'needs_review' }));
  const methodSelection = selectMethods({ purpose, text: current.text, focus: state.focus, hasReply: validQQ.at(-1)?.direction === 'incoming' });
  const restrictions = companion.notes.filter(n => n.use === 'discussion' && n.kind !== 'preference').map(n => ({ sourceId: `note:${n.id}`, text: redact(n.text), evidenceSourceIds: n.evidenceSourceIds || [] }));
  const payload = { promptVersion: PROMPT_VERSION, purpose, method: METHODS[purpose], methodCards: [],methodCatalog:methodSelection.catalog, methodSelection: {
    version: methodSelection.version, selection: methodSelection.selection, candidates: [],
    maxApplied: methodSelection.maxApplied, selectionRule: methodSelection.selectionRule, feedbackRule: methodSelection.feedbackRule }, asOf,viewerTimeZone,
    userRequest: { sourceId: current.id, text: current.text }, goal: redact(companion.goal.text || ''),
    intentAuthority: { sourceId: intentSource.id },draftMaterialPolicy:{...MATERIAL_POLICY},
    generationOrigin,
    currentObservationSourceId: generationOrigin === 'qq_observation' ? currentObservationSourceId || (validQQ.at(-1) && `qq:${validQQ.at(-1).messageId}`) : null,
    topicContext: { version: topicView.version || 0, activeId: groundedTopic?.id || null,
      active: groundedTopic ? modelTopic(pick(groundedTopic, ['id','version','lifecycle','objective','direction','constraints','stage','progress','unknowns','interpretationStatus','purposeBindings','observationBindings','observationAuthorities','purposeSourceIds','observationSourceIds','lifecycleSourceIds','sourceIds'])) : null,
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
    omittedStateEntries: originalStateCount-['items','openThreads','unknowns'].reduce((n,key)=>n+state[key].length,0) };
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
  if (retrievedDiscussion.length) payload.retrievedDiscussion = retrievedDiscussion.map(item => ({ ...sanitize(pick(item, ['id','role','kind','text','discussionExplanation','suggestions','expressionOptions','artifactRef'])), authority: 'generated_discussion_not_outbound_authorization' }));
  const manualAlternative=candidateAlternative===true&&invocation?.origin==='user'&&invocation?.trigger==='manual_suggestion';
  const implicitAnchor=(privateRequest||manualAlternative)&&!sourceTurnIds.length&&!selectedOption?currentCandidateAnchor(companion,currentCandidateRef):null;
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
  const currentRequest=payload.userRequest,position=payload.taskContext;delete payload.userRequest;delete payload.taskContext;
  payload.taskContext=position;payload.userRequest=currentRequest;
  const context=finish(payload, payload.sources, { scope, requestId, companion, coverage }, all, byteBudget, budget);
  attachSelectionManifest(context,{historyPolicy,timeCandidateIds,selected,timeSegments,recentPrivateIds,foldedPrivateIds,coreItems,byId,images,payload,compacted,recentPlan,recentContextPlan,recentPriorityIds,recentInitialAdditionalBytes,optionalRawLimit,optionalRawIds,optionalRetrieved});
  context.manifest.planningViews={workVersion:payload.work?.version||CONVERSATION_WORK_VERSION,materialVersion:payload.materialView?.version||MATERIAL_VERSION,
    materialRefs:(payload.materialView?.items||[]).map(({kind,sourceIds})=>({kind,sourceIds})),projection:payload.materialView?payload.materialView.projection||'full':'omitted_for_required_evidence'};
  if(implicitAnchor){const delivered=payload.privateCandidates?.find(item=>item.selection==='implicit_discussion_anchor'&&item.turnId===implicitAnchor.turnId);
    context.manifest.implicitDiscussionAnchor={turnId:implicitAnchor.turnId,artifactRef:implicitAnchor.artifactRef,field:implicitAnchor.field,...(implicitAnchor.index!==undefined?{index:implicitAnchor.index}:{}),availability:delivered?.availability||'omitted_for_budget'};}
  context.essentialSourceIds=[...essentialIds];
  Object.defineProperty(context, 'fullAvailableSources', { value: all });
  Object.defineProperty(context,'rebuildForRequest',{value:measure=>buildContext({...options,asOf,viewerTimeZone,invocation,requestMeasure:measure})});
  context.restrictions=restrictions;
  return context;
}
module.exports={buildContext,reconcilePlanningViews};
