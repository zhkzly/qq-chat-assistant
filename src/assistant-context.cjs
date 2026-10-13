'use strict';
const crypto = require('node:crypto');
const { redact } = require('./model.cjs');
const { prepareAssistantRequest, parseDraftGuidance } = require('./assistant-model.cjs');
const { selectMethods, runtimeCard } = require('./help-methods.cjs');
const { validatedCompaction, candidatesForCompaction } = require('./discussion-compaction.cjs');
const { eligibleDiscussionTurns } = require('./discussion-compaction-store.cjs');
const {qqSourceMetadata}=require('./messages.cjs');
const {requiredQuoteSources,taskContext}=require('./context-task.cjs');
const {sourceRevision}=require('./store.cjs');
const PROMPT_VERSION = 'relationship-context-2026-10-13.7';
const METHODS = {
  discussion: '围绕用户真正希望的恋爱发展选择当前帮助，可接续、邀请、表达好感或讨论。意思明确就直接帮助，只问会改变建议的必要问题。允许暂缓或不用助手，不强制每次制定目的。',
  review: '按实际覆盖回顾相处、共同经历、用户体验与双方明确的浪漫方向，分别说普通友好、活动意愿和恋爱意图。兼顾反证与未知，不计算好感分，不把回复归因为某条建议。',
  reply: '结合当前关系背景与回复重点，回应真实 QQ 来信；可以给参考表达，也可以先处理关键歧义。不重复已经发出的内容。',
  draft_prepare: '只提取用户此次明确想对她表达的原文片段，或用户选中的可分享素材。担忧、私人动机、禁止披露内容不选。含糊且影响分享范围则提一个具体问题。',
  draft: '根据提供的拟表达片段和真实 QQ 语境组织一条自然、可修改的表达。不补造经历、心理或共同约定；不要求延长聊天。'
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sanitize = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item));
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
function modelTopic(record) {
  const projected = sanitize(record);
  // Revisions have already been checked against full sources. Keep source IDs
  // and field authority in the model view; the manifest owns the exact hashes.
  for (const key of ['sourceRevisions','purposeSourceRevisions','observationSourceRevisions','lifecycleSourceRevisions']) delete projected[key];
  for (const key of ['purposeBindings','observationBindings']) if (projected[key]) projected[key] = Object.fromEntries(
    Object.entries(projected[key]).map(([field, binding]) => {
      const copy = { ...binding }; delete copy.sourceRevisions; return [field, copy];
    }));
  return projected;
}
function relevantTo(text, item) {
  const ignored = new Set(['今天','最近','什么','怎么','这个','那个','我们','你们','她的','我的','帮我','一下','觉得','想要','可以','现在','已经']);
  const terms = [...new Set([...(String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) || []),
    ...(String(text).match(/[\p{Script=Han}]{2}/gu) || []).filter(term => !ignored.has(term))])];
  const haystack = `${item.text || ''} ${(item.topicKeys || []).join(' ')}`.toLowerCase();
  return terms.some(term => haystack.includes(term));
}
function sameScopeIfPresent(value, scope) {
  if (!value?.scope) return true;
  if (typeof value.scope !== 'object') return value.scope === 'this_relationship';
  return ['accountUid', 'accountUin', 'peerUid', 'peerUin'].every(key => value.scope[key] === scope[key]);
}
function supportedByAvailable(record, byId, scope) {
  return sameScopeIfPresent(record, scope) && record.evidenceValidity !== 'invalid' && record.evidenceValidity !== 'unavailable' &&
    Object.entries(record.sourceRevisions || {}).every(([id, revision]) => byId.get(id)?.revision === revision) &&
    (record.sourceRefs || []).every(ref => byId.get(ref.sourceId)?.revision === ref.revision) &&
    Array.isArray(record.sourceIds) && record.sourceIds.length > 0 && record.sourceIds.every(id => {
      const source = byId.get(id);
      return source && !source.deleted && !source.excluded && (!record.sourceRevisions?.[id] || record.sourceRevisions[id] === source.revision);
    });
}
function pendingPrivateReviews(companion, byId) {
  const pending = new Map();
  const directIntent = id => {
    const source = byId.get(id);
    return source?.role === 'user' && (source.type === 'feedback' || source.type === 'private' &&
      !['feedback', 'feedback_ref', 'feedback_continue'].includes(source.kind));
  };
  const runReceipts = new Map((companion.runs || []).filter(run => run.status === 'complete' && run.replyId && run.privateReviewReceipt?.applied === true)
    .map(run => [run.replyId, run.privateReviewReceipt]));
  // These fields are verified program receipts, never model-reported patches.
  // Apply them in turn order so an older review cannot erase a later correction.
  for (const turn of companion.turns) {
    if (turn.role !== 'assistant' || turn.memoryExcluded) continue;
    const receipt = turn.privateReviewReceipt || runReceipts.get(turn.id);
    if (receipt?.applied === true) for (const id of receipt.sourceIds || []) {
      const expected = receipt.sourceRevisions?.[id];
      if (directIntent(id) && typeof expected === 'string' && expected === byId.get(id).revision) pending.delete(id);
    }
    const recovery = turn.responseRecovery,pendingMarker=turn.metadataReviewPending;
    const ordinaryPending=pendingMarker?.reasonCode==='auxiliary_metadata_rejected';
    if (!ordinaryPending&&(recovery?.kind !== 'private_help' || recovery.metadataApplied !== false || recovery.reasonCode !== 'structured_output_invalid')) continue;
    for (const id of (ordinaryPending?pendingMarker.sourceIds:recovery.intentSourceIds)||[]) if (directIntent(id)) {
      const expected = (ordinaryPending?pendingMarker.sourceRevisions:recovery.intentSourceRevisions)?.[id], source = byId.get(id);
      if (expected !== undefined && (typeof expected !== 'string' || expected !== source.revision)) continue;
      // Older saved markers cannot prove which source body was interpreted.
      // Keep that uncertainty visible; an unbound receipt never resolves it.
      pending.delete(id); pending.set(id, { ...source,
        pendingBindingStatus: expected === undefined ? 'legacy_hash_missing_needs_review' : 'source_bound' });
    }
  }
  return [...pending.values()];
}
function methodTrace(payload) {
  return { purpose: payload.purpose, delivered: (payload.methodCards || []).map(({ id, version }) => ({ id, version })),
    catalog:(payload.methodCatalog||[]).map(({id,version})=>({id,version})),reported: null };
}
function projectActualActions(actions, byId, scope) {
  return (actions || []).flatMap(action => {
    if (action.kind === 'user_reported_activity') {
      if (!action.sourceRevisions || !action.sourceIds?.every(id => action.sourceRevisions[id]) || !supportedByAvailable(action, byId, scope)) return [];
      return [{ ...pick(action, ['kind','activityId','eventAt','sourceIds','sourceRevisions']), authority: 'reported_not_directly_observed' }];
    }
    const id = `qq:${action.messageId}`;
    if (byId.get(id)?.type !== 'qq') return [];
    return [{ ...pick(action, ['kind','messageId','eventAt','availability']), sourceId: id }];
  });
}
function projectObservations(observations, byId, scope) {
  return (observations || []).flatMap(observation => {
    if (observation.kind === 'activity_event') {
      if (!observation.sourceRevisions || !observation.sourceIds?.every(id => observation.sourceRevisions[id]) || !supportedByAvailable(observation, byId, scope)) return [];
      return [{ ...pick(observation, ['kind','relationshipEventId','eventKind','text','sourceIds','sourceRevisions','eventAt','lifecycle']),
        authority: observation.sourceIds.every(id => byId.get(id)?.type === 'qq') ? 'derived_from_qq_statements' : 'derived_from_user_report' }];
    }
    const id = observation.sourceId || `qq:${observation.messageId}`;
    if (byId.get(id)?.type !== 'qq') return [];
    return [{ ...pick(observation, ['kind','messageId','eventAt','relevance','authority']), sourceId: id }];
  });
}
const actionSources = items => items.flatMap(item => item.sourceIds || [item.sourceId]).filter(Boolean);
function eligibleQQ(message) { return message.kind === 'actual' && !message.recalled && message.text !== '[已撤回]'; }
function sourcesFor(records, companion) {
  return [
    ...records.filter(eligibleQQ).map(m => {const source={id:`qq:${m.messageId}`,type:'qq',text:m.text,at:new Date(m.timestamp).toISOString(),role:m.direction==='outgoing'?'user':'contact',direction:m.direction,use:'discussion',messageId:m.messageId,...qqSourceMetadata(m)};
      return {...source,text:redact(source.text),speaker:m.direction==='outgoing'?'我':'对方',revision:sourceRevision(source)};}),
    ...companion.turns.filter(t => t.role === 'user' && !t.memoryExcluded && !['feedback','feedback_ref'].includes(t.kind)).map(t => {const source={id:`private:${t.id}`,type:'private',text:t.text,at:t.createdAt,role:'user',use:'discussion',kind:t.kind,version:t.version||1};return {...source,text:redact(t.text),revision:sourceRevision(source)};}),
    ...companion.notes.filter(n => n.use !== 'disabled').map(n => {const source={id:`note:${n.id}`,type:'note',text:n.text,at:n.updatedAt||n.createdAt,use:n.use,kind:n.kind||'material',version:n.version,...(n.evidenceSourceIds?{evidenceSourceIds:n.evidenceSourceIds}:{}),...(n.evidenceRevisions?{evidenceRevisions:n.evidenceRevisions}:{})};return {...source,text:redact(n.text),revision:sourceRevision(source)};}),
    ...(companion.feedback || []).filter(item => !item.redacted).map(item => ({ id: item.sourceId || `private:feedback-${item.id}`,
      type: 'feedback', role: 'user', kind: 'local', text: redact(item.text), targetRef: item.targetRef, at: item.createdAt, revision: digest(item) }))
  ];
}
function contextBudget(settings, byteBudget, requestMeasure) {
  const base=prepareAssistantRequest(settings,null),measure=requestMeasure||(payload=>prepareAssistantRequest(settings,payload).requestBytes);
  const envelopeBytes=measure(null)-4;
  return {measure,requestByteBudget:base.byteLimit,envelopeBytes,payloadWireByteBudget:base.byteLimit-envelopeBytes,model:settings.model||'',
    fits:payload=>bytes(payload)<=byteBudget&&measure(payload)<=base.byteLimit};
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
function buildContext(options) {
  const { scope, records, companion, turn, purpose = 'discussion', coverage, requestId,
  materialIds = [], byteBudget = 48000, availableSources, memoryResult, memoryIndex = [], retrievedSources = [],
  sourceTurnIds = [], selectedOption, replyMessageIds = [], imageMessageIds = [], actionReceipts = [], lookupHistory = [], reviewRange,
  relationshipContext = null, experienceContext = null, topicContext = null, intentSourceId = null,
  generationOrigin = 'private_discussion', currentObservationSourceId = null,
  discussionCompaction = null, sourceLookupIds = [], retrievedDiscussion = [],
  feedbackTargets = [], allowExperienceProposals = purpose === 'review', responsePreference, settings = {}, requestMeasure } = options;
  const budget = contextBudget(settings, byteBudget, requestMeasure), fits = budget.fits;
  if (!METHODS[purpose] || purpose === 'draft') throw new Error('未知的上下文用途');
  if (!Number.isFinite(byteBudget) || byteBudget < 4000 || byteBudget > 192000) throw new Error('上下文预算不合法');
  const actualById = new Map(records.filter(eligibleQQ).map(record => [`qq:${record.messageId}`, record]));
  const all = (availableSources || sourcesFor(records, companion)).filter(source => !source.deleted && !source.excluded && source.use !== 'disabled' && sameScopeIfPresent(source, scope))
    .filter(source => source.type !== 'qq' || actualById.has(source.id)).map(source => {
      const actual = source.type === 'qq' && actualById.get(source.id);
      return { ...source, text: redact(source.text), ...(actual ? { direction: actual.direction, speaker: actual.direction === 'outgoing' ? '我' : '对方',...qqSourceMetadata(actual) } : {}) };
    });
  const actualOrder=new Map(records.map((m,i)=>[`qq:${m.messageId}`,i]));
  all.sort((a,b)=>Date.parse(a.at||0)-Date.parse(b.at||0)||(a.type==='qq'&&b.type==='qq'?actualOrder.get(a.id)-actualOrder.get(b.id):a.id.localeCompare(b.id)));
  const byId = new Map(all.map(s => [s.id, s]));
  const currentId = `private:${turn.id}`;
  const current = byId.get(currentId) || (turn.transient || turn.memoryExcluded ? { id: `request:${turn.id}`, type: 'request', text: redact(turn.text), revision: digest(turn), role: 'user' } : null);
  if (!current) throw new Error('当前私下请求不存在');
  const pendingIntents = pendingPrivateReviews(companion, byId);
  const protectedPendingIds = pendingIntents.slice(-3).map(source => source.id);
  const compacted = validatedCompaction(discussionCompaction, { scope, companion, turn, availableSources: all, settings, promptVersion: PROMPT_VERSION });
  const coveredTurnIds = new Set(compacted?.sourceTurnIds || []);
  const protectedPrivateIds = new Set([current.id, intentSourceId, ...protectedPendingIds, ...sourceLookupIds.map(id => id.startsWith('private:') ? id : `private:${id}`)]);
  const latestPriorUser = [...eligibleDiscussionTurns(companion)].reverse().find(item => item.role === 'user' && item.id !== turn.id);
  if (latestPriorUser) protectedPrivateIds.add(`private:${latestPriorUser.id}`);
  for (const id of sourceTurnIds) if (companion.turns.some(item => item.id === id && item.role === 'user')) protectedPrivateIds.add(`private:${id}`);
  const foldedPrivateIds = new Set(compacted ? Object.keys(compacted.sourceRevisions).filter(id => byId.get(id)?.type === 'private' && !protectedPrivateIds.has(id)) : []);
  if (!Array.isArray(materialIds) || materialIds.length>12 || materialIds.some(id => typeof id !== 'string' || !companion.notes.some(n => n.id === id && n.use === 'draft')))
    throw new Error('草稿素材必须是当前联系人允许分享的近况');
  const selected = new Map([[current.id, current]]);
  for (const id of protectedPendingIds) selected.set(id, byId.get(id));
  const validQQ = records.filter(m => eligibleQQ(m) && byId.has(`qq:${m.messageId}`));
  // Protect both complete sides of the latest exchange, including after the
  // user has already replied in several bubbles. Never lose her boundary then.
  let start = validQQ.length;
  for (let group = 0; group < 2 && start > 0; group++) {
    const direction = validQQ[start - 1].direction;
    do { start--; } while (start > 0 && validQQ[start - 1].direction === direction);
  }
  for (const message of validQQ.slice(start)) selected.set(`qq:${message.messageId}`, byId.get(`qq:${message.messageId}`));
  for(const id of requiredQuoteSources(records,byId,[...replyMessageIds,...imageMessageIds]))selected.set(id,byId.get(id));
  for (const id of materialIds) selected.set(`note:${id}`, byId.get(`note:${id}`));
  for (const id of replyMessageIds) if (byId.has(`qq:${id}`)) selected.set(`qq:${id}`, byId.get(`qq:${id}`));
  for (const id of imageMessageIds) if (byId.has(`qq:${id}`)) selected.set(`qq:${id}`, byId.get(`qq:${id}`));
  const selectedProposal = selectedOption && companion.turns.find(t => t.id === selectedOption.turnId && t.role === 'assistant')?.expressionOptions?.[selectedOption.index];
  if (selectedOption && !selectedProposal) throw new Error('选中的表达方向已变化，请重新选择');
  const proposals = companion.turns.filter(t => t.role === 'assistant' && t.expressionOptions?.length).slice(-4)
    .flatMap(t => t.expressionOptions.map((o, index) => ({ ...o, turnId: t.id, index })));
  for (const proposal of selectedProposal ? [selectedProposal] : []) for (const q of proposal.quotes || [])
    if (byId.has(q.sourceId)) { selected.set(q.sourceId, byId.get(q.sourceId)); foldedPrivateIds.delete(q.sourceId); }
  for (const id of sourceLookupIds) {
    const sourceId = id.startsWith('private:') ? id : `private:${id}`;
    if (byId.has(sourceId)) { selected.set(sourceId, byId.get(sourceId)); foldedPrivateIds.delete(sourceId); }
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
  const privatePriorityIds = new Set();
  const requiredPrivateTurnIds = new Set();
  const state = { ...companion.state, authority: companion.state.possiblyStale ? 'previous_summary_needs_review' : 'reviewed_summary_not_independent_evidence' };
  if (state.possiblyStale) state.openThreads = (state.openThreads || []).map(item => ({ ...item,
    previousStatus: item.status || 'open', status: 'needs_review' }));
  const methodSelection = selectMethods({ purpose, text: current.text, focus: state.focus, hasReply: validQQ.at(-1)?.direction === 'incoming' });
  const restrictions = companion.notes.filter(n => n.use === 'discussion' && n.kind !== 'preference').map(n => ({ sourceId: `note:${n.id}`, text: redact(n.text), evidenceSourceIds: n.evidenceSourceIds || [] }));
  const payload = { promptVersion: PROMPT_VERSION, purpose, method: METHODS[purpose], methodCards: [],methodCatalog:methodSelection.catalog, methodSelection: {
    version: methodSelection.version, selection: methodSelection.selection, candidates: [],
    maxApplied: methodSelection.maxApplied, selectionRule: methodSelection.selectionRule, feedbackRule: methodSelection.feedbackRule }, asOf: new Date().toISOString(),
    userRequest: { sourceId: current.id, text: current.text }, goal: redact(companion.goal.text || ''),
    intentAuthority: { sourceId: intentSource.id },
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
    omittedStateEntries: 0 };
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
  if (retrievedDiscussion.length) payload.retrievedDiscussion = retrievedDiscussion.map(item => ({ ...sanitize(pick(item, ['id','role','kind','text','suggestions','expressionOptions','artifactRef'])), authority: 'generated_discussion_not_outbound_authorization' }));
  const candidatePool = candidatesForCompaction(compacted, companion, { sourceTurnIds, selectedOption, sourceLookupIds });
  const preferredCandidateTurnIds = new Set([...[...eligibleDiscussionTurns(companion)].reverse().filter(item => item.role === 'assistant').slice(0, 1).map(item => item.id), ...sourceTurnIds, selectedOption?.turnId, ...sourceLookupIds].filter(Boolean));
  let taskTextReferences=false;
  const refresh = () => {
    payload.sources = [...selected.values()]; payload.allowedMaterialIds=payload.sources.filter(s=>s.type==='note'&&s.use==='draft').map(s=>s.id);
    payload.methodSelection.candidates=[...new Set([...(payload.methodCatalog||[]).map(m=>m.id),...payload.methodCards.map(m=>m.id)])];
    payload.taskContext=taskContext({records,sources:payload.sources,scope,coverage,generationOrigin,currentSourceId:current.id,responsePreference});
    if(taskTextReferences){
      payload.taskContext.sourceTextLocation='sources';
      for(const item of payload.taskContext.recentExchange){delete item.text;if(item.quote)delete item.quote.text;}
    }
    const feedbackSourceIds = (payload.feedbackTargets || []).filter(item => !item.missing && selected.get(item.feedback.sourceId)?.type === 'feedback').map(item => item.feedback.sourceId);
    payload.experienceProposalPolicy = { enabled: allowExperienceProposals === true && feedbackSourceIds.length > 0, maxItems: 2,
      feedbackSourceIds: allowExperienceProposals ? feedbackSourceIds : [], caseIds: allowExperienceProposals ? (payload.experienceContext?.cases || []).map(item => item.id) : [] };
    if (payload.pendingPrivateReview) for (const ref of payload.pendingPrivateReview.refs) {
      ref.availability = selected.has(ref.sourceId) ? 'full' : 'needs_lookup';
      if (ref.type === 'feedback') {
        const evaluated = payload.feedbackTargets?.find(item => item.feedback.sourceId === ref.sourceId);
        ref.targetAvailability = evaluated && !evaluated.missing && evaluated.target.body ? 'full' : 'needs_lookup';
      }
    }
  };
  refresh();
  // A large derived state cannot make a small explicit request unusable. Drop
  // complete low-priority entries, recording the omission, never cutting text.
  for (const key of ['items', 'openThreads', 'unknowns']) state[key] = [...(state[key] || [])];
  const trimStateNavigation = () => {
    // Keep each original body intact in sources. Under pressure, chronology
    // points to that body instead of serializing the same QQ text twice.
    if(!fits(payload)&&!taskTextReferences){taskTextReferences=true;refresh();}
    for (const key of ['items', 'openThreads', 'unknowns']) while (!fits(payload) && state[key].length) { state[key].pop(); payload.omittedStateEntries++; }
    if (!fits(payload) && state.focus) { state.focus = ''; payload.omittedStateEntries++; }
    if(!fits(payload)&&payload.methodCatalog.some(m=>m.brief)){payload.methodCatalog=payload.methodCatalog.map(({id,version,name})=>({id,version,name}));refresh();}
    while(!fits(payload)&&payload.methodCatalog.length){payload.methodCatalog.pop();refresh();}
  };
  trimStateNavigation();
  // No substring truncation: reject if the request and latest complete exchange do not fit.
  if (!fits(payload)) throw new Error('当前问题或最新完整来信超过上下文预算，请分段处理；没有静默截断');
  const trySource = source => {
    if (!source || selected.has(source.id) || foldedPrivateIds.has(source.id)) return;
    selected.set(source.id, source); refresh();
    if (!fits(payload)) { selected.delete(source.id); refresh(); }
  };
  const includeGrounded = (record, target, fields, priority = false, allowFolded = false) => {
    if (!supportedByAvailable(record, byId, scope)) return false;
    if (!allowFolded && record.sourceIds.some(id => foldedPrivateIds.has(id))) return false;
    const before = new Map(selected);
    for (const id of record.sourceIds) if (!foldedPrivateIds.has(id)) selected.set(id, byId.get(id));
    const clean = sanitize(pick(record, fields));
    if (allowFolded && record.sourceIds.some(id => foldedPrivateIds.has(id))) clean.foldedSourceIds = record.sourceIds.filter(id => foldedPrivateIds.has(id));
    clean.authority ||= record.reviewComplete === false ? 'needs_review' : 'source_backed_summary_not_independent_evidence';
    target.push(clean); refresh();
    if (priority) trimStateNavigation();
    if (fits(payload)) return true;
    target.pop(); selected.clear(); for (const [id, source] of before) selected.set(id, source); refresh(); return false;
  };
  const evaluationTargets = [...feedbackTargets, ...(experienceContext?.evaluationTargets || [])];
  const requiredFeedbackSources = new Set(feedbackTargets.map(item => item.feedback?.sourceId).filter(Boolean));
  for (const id of protectedPendingIds) if (byId.get(id)?.type === 'feedback') requiredFeedbackSources.add(id);
  if (intentSource.type === 'feedback') requiredFeedbackSources.add(intentSource.id);
  for (const id of sourceTurnIds) {
    const turn = companion.turns.find(item => item.id === id);
    if (turn?.feedbackId) requiredFeedbackSources.add(companion.feedback?.find(item => item.id === turn.feedbackId)?.sourceId || `private:feedback-${turn.feedbackId}`);
  }
  if (evaluationTargets.length) payload.feedbackTargets = [];
  const seenFeedback = new Set();
  const includeEvaluationTargets = (items, required = false) => {
    for (const item of items) {
      if (seenFeedback.size >= 8) break;
      const id = item.feedback?.sourceId;
      if (!id || seenFeedback.has(id) || !byId.has(id)) continue;
      const record = { ...item, sourceIds: [...new Set([id, ...(item.sourceIds || [])])] };
      const target = pick(item.target, ['artifactRef','body','kind','messageId','availability','authority','deliveredMethodRefs','reportedUsedMethodRefs','generationStages']);
      if (item.missing || ['purged','deleted','redacted','unavailable'].includes(target.availability)) delete target.body;
      if (item.feedback.targetRef?.kind === 'experience' && item.target) {
        const actualActions = projectActualActions(item.target.actualActions, byId, scope);
        const observations = projectObservations(item.target.observations, byId, scope);
        const reviews = (item.target.reviews || []).filter(review => byId.has(review.sourceId)).map(review => pick(review, ['id','sourceId','targetRef']));
        Object.assign(target, pick(item.target, ['id','status','attribution']), { actualActions, observations, reviews, authority: 'experience_evaluation_target_not_independent_evidence' });
        record.sourceIds = [...new Set([...record.sourceIds, ...actionSources(actualActions), ...actionSources(observations), ...reviews.map(review=>review.sourceId)])];
      }
      else target.authority = item.target?.kind === 'actual_message' ? 'actual_qq_evaluation_target' : 'generated_evaluation_target_not_factual_evidence';
      const projected = { ...record, feedback: pick(item.feedback, ['id','sourceId','kind','targetRef']), target,
        correctionContext: (item.correctionContext || []).filter(item => byId.has(item.sourceId)).map(item => ({ sourceId: item.sourceId })) };
      if (includeGrounded(projected, payload.feedbackTargets, ['feedback','target','missing','sourceIds','correctionContext'], required, true)) {
        seenFeedback.add(id);
        if (required) for (const sourceId of record.sourceIds) essentialIds.add(sourceId);
      } else if (required) throw new Error('所选反馈的完整对象或必要证据超过上下文预算或已经变化；输入已保留，内容未被截断');
      else if (includeGrounded({ feedback: projected.feedback, target: pick(target, ['artifactRef','kind','authority']), missing: true,
        reason: '完整评价对象或其必要证据未能放入本次上下文，不能推断反馈针对哪句话。', sourceIds: [id] }, payload.feedbackTargets,
        ['feedback','target','missing','reason','sourceIds'])) seenFeedback.add(id);
    }
  };
  includeEvaluationTargets(evaluationTargets.filter(item => requiredFeedbackSources.has(item.feedback?.sourceId)), true);
  // Current private meaning and the correction/acknowledgment exchange precede
  // optional summaries, methods and unrelated history. Preserve whole turns.
  const groups = []; let activeGroup = null;
  for (const t of companion.turns) {
    if (t.role === 'user') {
      activeGroup = null;
      if (t.id === turn.id || t.memoryExcluded || !byId.has(`private:${t.id}`) || foldedPrivateIds.has(`private:${t.id}`)) continue;
      activeGroup = []; groups.push(activeGroup);
    }
    if (activeGroup) activeGroup.push(t);
  }
  const recentGroups = groups.slice(-6).reverse();
  for (const [index, group] of recentGroups.entries()) {
    const previous = new Map(selected), previousTurns = payload.privateConversation;
    payload.privateConversation = group.map(t => t.role === 'user'
      ? { id: t.id, role: t.role, kind: t.kind, sourceId: `private:${t.id}`,text:byId.get(`private:${t.id}`).text,at:t.createdAt,requestId:t.requestId||null }
      : coveredTurnIds.has(t.id) && !sourceTurnIds.includes(t.id) && !sourceLookupIds.includes(t.id)
        ? { id: t.id, role: t.role, kind: t.kind, compacted: true, authority: 'derived_private_discussion_needs_sources' }
        : { id: t.id, role: t.role, kind: t.kind, text: redact(t.text),at:t.createdAt,requestId:t.requestId||null, authority: 'assistant_discussion_not_factual_evidence' }).concat(previousTurns);
    for (const t of group) if (t.role === 'user' && !foldedPrivateIds.has(`private:${t.id}`)) selected.set(`private:${t.id}`, byId.get(`private:${t.id}`));
    refresh();
    trimStateNavigation();
    if (!fits(payload)) {
      if (index === 0) throw new Error('最近完整私下讨论与当前必要内容超过上下文预算，请分段处理；没有静默截断');
      selected.clear(); for (const [id, source] of previous) selected.set(id, source);
      payload.privateConversation = previousTurns; refresh(); break;
    }
    for (const t of group) if (t.role === 'user') privatePriorityIds.add(`private:${t.id}`);
    if (index === 0) for (const t of group) {
      requiredPrivateTurnIds.add(t.id);
      if (t.role === 'user') essentialIds.add(`private:${t.id}`);
    }
  }
  // Candidate originals are available even without compaction. A whole choice
  // either fits or remains an explicit original-turn lookup reference.
  if (candidatePool.length) payload.privateCandidates = [];
  for (const candidate of candidatePool) {
    payload.privateCandidates.push(candidate); trimStateNavigation();
    if (!fits(payload)) {
      const reference = { ...candidate, availability: 'needs_lookup' }; delete reference.text; delete reference.quotes;
      payload.privateCandidates[payload.privateCandidates.length - 1] = reference;
      if (!fits(payload)) { payload.privateCandidates.pop(); break; }
    }
  }
  // Incidental evaluations cannot consume the room reserved for the current
  // meaning and its complete latest acknowledgment. Selected targets stay exact.
  includeEvaluationTargets(evaluationTargets.filter(item => !requiredFeedbackSources.has(item.feedback?.sourceId)));
  for (const n of companion.notes.filter(n => n.kind === 'preference' && n.use !== 'disabled').slice(-12).reverse()) {
    const id = `note:${n.id}`;
    includeGrounded({ sourceId: id, text: redact(n.text), sourceIds: [id] }, payload.preferences, ['sourceId','text','sourceIds']);
  }
  if (sameScopeIfPresent(topicView, scope)) for (const topic of (topicView.retained || topicView.items || []).filter(item => item.lifecycle !== 'active').slice(-3).reverse()) {
    const included = includeGrounded({ ...topic, authority: 'closed_topic_navigation_not_active_control' }, payload.topicContext.retained,
      ['id','version','lifecycle','objective','direction','constraints','stage','progress','unknowns','interpretationStatus','observationAuthorities','sourceIds','authority']);
    if (included) payload.topicContext.retained[payload.topicContext.retained.length - 1] = modelTopic(payload.topicContext.retained.at(-1));
  }
  if (relationshipContext && sameScopeIfPresent(relationshipContext, scope)) {
    payload.relationshipContext = { version: relationshipContext.version, asOf: relationshipContext.asOf,
      claims: [], events: [], activities: [], coverage: sanitize(relationshipContext.coverage || {}) };
    const common = ['id','version','text','sourceIds','sourceRevisions','evidenceValidity','applicability','currentApplicability','reviewComplete','topicKeys','firstEvidenceAt','lastEvidenceAt'];
    for (const claim of (relationshipContext.claims || []).slice(0, 24))
      includeGrounded(claim, payload.relationshipContext.claims, [...common,'subject','aspect','assertionKind','epistemicStatus','lifecycle','validFrom','validUntil','context']);
    for (const event of (relationshipContext.events || []).slice(-24).reverse())
      includeGrounded(event, payload.relationshipContext.events, [...common,'activityKey','eventKind','actor','occurredAt','lifecycle','assertionKind','epistemicStatus','origin']);
    payload.relationshipContext.events.sort((a,b)=>String(a.occurredAt||a.lastEvidenceAt||'').localeCompare(String(b.occurredAt||b.lastEvidenceAt||'')));
    const eventIds = new Set(payload.relationshipContext.events.map(event => event.id));
    for (const activity of (relationshipContext.activities || []).slice(0, 8)) {
      const ids = activity.eventIds || activity.events?.map(event => typeof event === 'string' ? event : event.id) || [];
      if (!ids.length || ids.some(id => !eventIds.has(id))) continue;
      const compact = sanitize({ ...pick(activity, ['activityKey','status','currentState','latestEventId','occurredAt']), eventIds: ids });
      payload.relationshipContext.activities.push(compact);
      if (!fits(payload)) payload.relationshipContext.activities.pop();
    }
  }
  if (experienceContext && sameScopeIfPresent(experienceContext, scope)) {
    payload.experienceContext = { cases: [], adaptations: [], constraints: ['仅为局部经验；不是她的心理或方法因果效果证据。'] };
    for (const item of (experienceContext.cases || []).slice(0, 4)) {
      const actualActions = projectActualActions(item.actualActions, byId, scope);
      const observations = projectObservations(item.observations, byId, scope);
      const reviewSourceIds = (item.reviews || []).map(review => review.sourceId).filter(id => byId.has(id));
      const sourceIds = [...new Set([...(item.sourceIds || []), ...actionSources(actualActions), ...actionSources(observations), ...reviewSourceIds])];
      const links = (item.links || []).slice(0, 8).map(link => ({ ...pick(link, ['id','status','reason','artifactRefs','actualMessageIds','confirmation']),
        artifacts: (link.artifacts || []).map(artifact => ({ ...pick(artifact, ['ref','availability']),
          ...(artifact.availability === 'redacted' ? {} : { text: artifact.text }), authority: 'generated_proposal_not_actual_communication' })) }));
      includeGrounded({ ...item, actualActions, observations, links, sourceIds, reviewSourceIds }, payload.experienceContext.cases,
        ['id','status','goalVersion','actualActions','observations','linkStatus','attribution','links','reviewSourceIds','sourceIds']);
    }
    for (const item of (experienceContext.adaptations || []).slice(0, 4)) {
      if (item.status !== 'active' || item.authority !== 'user_approved_assistance_guidance') continue;
      includeGrounded(item, payload.experienceContext.adaptations, ['id','version','text','applicability','methodRef','status','scope','authority','sourceIds']);
    }
  }
  // Complete evidence and evaluated artifacts precede optional method cards.
  // Missing cards never require asking the user a ritual question.
  for (const method of methodSelection.methods) {
    payload.methodCards.push(runtimeCard(method));
    if (!fits(payload)) payload.methodCards.pop();
  }
  refresh();
  if(!selectedProposal)for(const option of proposals.reverse()) {
    payload.expressionOptions.unshift(option);
    if(!fits(payload)){payload.expressionOptions.shift();break;}
  }
  for (const source of [...retrievedSources, ...(memoryResult?.sources || [])].sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0))) trySource(byId.get(source.id));
  for (const id of sourceTurnIds) {
    const t = companion.turns.find(t => t.id === id);
    if (!t) continue;
    if (t.role === 'user') trySource(byId.get(`private:${id}`));
    else for (const sid of t.sourceIds || []) trySource(byId.get(sid));
  }
  const summarized = new Set();
  for (const kind of ['items', 'episodes']) for (const item of memoryResult?.[kind] || []) {
    if (!Array.isArray(item.sourceIds) || item.sourceIds.some(id => !byId.has(id))) continue;
    const signature = digest([item.text, [...item.sourceIds].sort()]);
    if (summarized.has(signature)) continue;
    const clean = { ...item, text: redact(item.text), authority: item.reviewComplete===false || item.sourceIds.some(id=>!selected.has(id)) ? 'needs_review' : 'source_backed_summary' };
    const verbatim = item.sourceIds.find(id => selected.get(id)?.text === clean.text);
    if (verbatim) { delete clean.text; clean.textFromSource = verbatim; }
    payload.retrievedMemory[kind].push(clean);
    if (!fits(payload)) { payload.retrievedMemory[kind].pop(); break; }
    summarized.add(signature);
  }
  const includedMemories = new Set([...payload.retrievedMemory.items, ...payload.retrievedMemory.episodes].map(item => item.id));
  for (const item of memoryIndex.filter(item => !includedMemories.has(item.id) && relevantTo(current.text, item)).slice(0, 8)) {
    if (!Array.isArray(item.sourceIds) || !item.sourceIds.length || item.sourceIds.some(id => !byId.has(id))) continue;
    payload.memoryIndex.push({ id: item.id, kind: item.kind, text: redact(item.text), topicKeys: item.topicKeys, status: item.status,
      authority:'navigation_only_needs_source_lookup',reviewComplete:item.reviewComplete,sourceIds:item.sourceIds,lastEvidenceAt:item.lastEvidenceAt });
    if (!fits(payload)) { payload.memoryIndex.pop(); break; }
  }
  // Even a stale state may identify useful original evidence. Re-read it rather
  // than trusting its old interpretation, so cross-day topics are not lost.
  for (const item of [...(companion.state.items || []), ...(companion.state.openThreads || [])])
    for (const id of item.sourceIds || []) trySource(byId.get(id));
  // Relevant notes arrive through search. Keep a small recent fallback for open
  // requests such as "what could we talk about", never fill the budget with all notes.
  for (const n of companion.notes.filter(n=>n.use!=='disabled').slice(-3).reverse()) trySource(byId.get(`note:${n.id}`));
  for (const r of restrictions) {
    if(!selected.has(r.sourceId)&&!r.evidenceSourceIds.some(id=>selected.has(id)))continue;
    const compact={sourceId:r.sourceId,evidenceSourceIds:r.evidenceSourceIds};
    payload.privateRestrictions.push(compact);
    if(!fits(payload)){payload.privateRestrictions.pop();break;}
  }
  for (const m of validQQ.slice(-60).reverse()) trySource(byId.get(`qq:${m.messageId}`));
  const words = [...new Set(current.text.match(/[\p{L}\p{N}]{2,}/gu) || [])];
  const matches = source => words.some(w => source.text.includes(w)) ||
    (current.text.match(/[\p{Script=Han}]{2}/gu) || []).some(w => source.text.includes(w));
  const historical = validQQ.slice(0, -60).filter(m => matches(byId.get(`qq:${m.messageId}`))).slice(-8);
  for (const m of historical) {
    const index = validQQ.indexOf(m);
    for (const adjacent of validQQ.slice(Math.max(0, index - 1), index + 3)) trySource(byId.get(`qq:${adjacent.messageId}`));
  }
  // When an old event is retrieved, prefer its entire later chronology to an
  // isolated invitation. If it does not fit, explicitly forbid treating it as
  // a current arrangement: the cancellation may be in the omitted interval.
  const earliest = validQQ.findIndex(m => selected.has(`qq:${m.messageId}`));
  if (earliest >= 0 && earliest < validQQ.length - 60) {
    const prior = new Map(selected);
    for (const m of validQQ.slice(earliest)) selected.set(`qq:${m.messageId}`, byId.get(`qq:${m.messageId}`));
    refresh();
    if (!fits(payload)) { selected.clear(); for (const [id, value] of prior) selected.set(id, value); refresh(); }
  }
  for (;;) {
    let allLaterIncluded = true;
    for (let i = validQQ.length - 1; i >= 0; i--) {
      const id = `qq:${validQQ[i].messageId}`, source = selected.get(id);
      if (!source) { allLaterIncluded = false; continue; }
      if (!allLaterIncluded) selected.set(id, { ...source, historicalOnly: true, continuationCoverage: 'later_messages_omitted' });
    }
    let laterPrivateIncluded=true;
    for(const source of all.filter(s=>s.type==='private'||s.type==='feedback').reverse()) {
      if(!selected.has(source.id)){laterPrivateIncluded=false;continue;}
      if(!laterPrivateIncluded)selected.set(source.id,{...selected.get(source.id),historicalOnly:true,continuationCoverage:'later_private_sources_omitted'});
    }
    refresh();
    if (fits(payload)) break;
    const optionalCandidate = payload.privateCandidates?.findLastIndex(item => item.availability === 'full' && !preferredCandidateTurnIds.has(item.turnId)) ?? -1;
    if (optionalCandidate >= 0) {
      const reference = { ...payload.privateCandidates[optionalCandidate], availability: 'needs_lookup' }; delete reference.text; delete reference.quotes;
      payload.privateCandidates[optionalCandidate] = reference; continue;
    }
    const optional = [...selected.keys()].filter(id => !essentialIds.has(id));
    const removable = optional.find(id => !privatePriorityIds.has(id));
    if (removable) { selected.delete(removable); refresh(); }
    else if (payload.methodCards.length) {
      payload.methodCards.pop();
    }
    else if (optional.length) { selected.delete(optional[0]); refresh(); }
    else if (payload.privateConversation.length) {
      const index = payload.privateConversation.findIndex(entry => entry.role === 'user' && !requiredPrivateTurnIds.has(entry.id));
      if (index < 0) break;
      let end = index + 1; while (end < payload.privateConversation.length && payload.privateConversation[end].role === 'assistant') end++;
      payload.privateConversation.splice(index, end - index);
    }
    else break;
  }
  // Late budget eviction and chronology checks must also change the authority
  // of every derived view. A source appearing earlier is not proof of current state.
  const groundFinal = record => record.sourceIds?.every(id => selected.has(id));
  payload.topicContext.retained = payload.topicContext.retained.filter(groundFinal);
  if(payload.topicContext.active?.sourceIds.some(id=>selected.get(id)?.historicalOnly))Object.assign(payload.topicContext.active,{reviewPending:true,authority:'needs_review'});
  for (const key of ['claims', 'events']) if (payload.relationshipContext) {
    payload.relationshipContext[key] = payload.relationshipContext[key].filter(groundFinal).map(item => ({ ...item,
      authority: item.sourceIds.some(id => selected.get(id).historicalOnly) || item.reviewComplete === false
        ? 'needs_review' : item.authority }));
  }
  if (payload.relationshipContext) {
    const keptEvents = new Set(payload.relationshipContext.events.map(item => item.id));
    payload.relationshipContext.activities = payload.relationshipContext.activities.filter(item => item.eventIds.every(id => keptEvents.has(id)));
  }
  for (const key of ['cases', 'adaptations']) if (payload.experienceContext) payload.experienceContext[key] = payload.experienceContext[key].filter(groundFinal);
  if (payload.feedbackTargets) payload.feedbackTargets = payload.feedbackTargets.filter(item => item.sourceIds?.every(id => selected.has(id) || item.foldedSourceIds?.includes(id) && compacted?.sourceRevisions[id] === byId.get(id)?.revision));
  const privateGroups = []; let currentGroup = null;
  for (const entry of payload.privateConversation) {
    if (entry.role === 'user') { currentGroup = selected.has(entry.sourceId) ? [] : null; if (currentGroup) privateGroups.push(currentGroup); }
    if (currentGroup) currentGroup.push(entry);
  }
  payload.privateConversation = privateGroups.flat();
  for (const kind of ['items', 'episodes']) for (const item of payload.retrievedMemory[kind]) {
    if (item.sourceIds.some(id => !selected.has(id) || selected.get(id).historicalOnly)) item.authority = 'needs_review';
    if (item.textFromSource && !selected.has(item.textFromSource)) { item.text = redact(memoryResult[kind].find(original => original.id === item.id)?.text || ''); delete item.textFromSource; }
  }
  refresh();
  // New evidence is serialized chronologically, even when selected by recency/relevance.
  const order = new Map(all.map((s, i) => [s.id, i]));
  payload.sources.sort((a, b) => order.get(a.id) - order.get(b.id));
  // End with the current factual position and exact current request. Neither
  // derived summaries nor old assistant prose becomes the active instruction.
  const currentRequest=payload.userRequest,position=payload.taskContext;delete payload.userRequest;delete payload.taskContext;
  payload.taskContext=position;payload.userRequest=currentRequest;
  const context=finish(payload, payload.sources, { scope, requestId, companion, coverage }, all, byteBudget, budget);
  if (compacted) context.manifest.discussionCompaction = { cacheId: compacted.id, identity: compacted.identity, reused: true,
    coveredTurns: compacted.sourceTurnIds.length, coveredTurnIds: [...compacted.sourceTurnIds], sourceRevisions: { ...compacted.sourceRevisions }, turnFingerprints: { ...compacted.turnFingerprints },
    foldedSourceIds: [...foldedPrivateIds], authority: 'derived_private_discussion_needs_sources' };
  context.essentialSourceIds=[...essentialIds];
  Object.defineProperty(context, 'fullAvailableSources', { value: all });
  Object.defineProperty(context,'rebuildForRequest',{value:measure=>buildContext({...options,requestMeasure:measure})});
  context.restrictions=restrictions;
  return context;
}
function buildDraftContext(prepared, plan, info) {
  if (!sameScopeIfPresent({ scope: prepared.manifest.scope }, info.scope)) throw new Error('当前联系人已变化，请重新组织草稿');
  const settings=info.settings||{model:prepared.manifest.requestModel,assistantRequestBytes:prepared.manifest.requestByteBudget};
  const budget=contextBudget(settings,prepared.manifest.byteBudget,info.requestMeasure);
  const optionRef = prepared.payload.selectedOption || plan?.option;
  const option = optionRef && prepared.payload.expressionOptions?.find(o => o.turnId === optionRef.turnId && o.index === optionRef.index);
  if (optionRef && !option) throw new Error('先前选择的方向已变化，请重新选择');
  const plannedQuotes = option ? option.quotes : plan?.quotes;
  const replyOnly = plan?.intent === 'reply' && prepared.payload.sources.some(s => s.type === 'qq');
  if (!plan || !Array.isArray(plannedQuotes) || (!plannedQuotes.length && !replyOnly) || plannedQuotes.length > 8)
    throw new Error('需要明确这次想表达的内容，才能组织草稿');
  const allowed = new Set([prepared.payload.userRequest.sourceId, prepared.payload.intentAuthority?.sourceId,
    ...(prepared.payload.allowedMaterialIds || prepared.payload.selectedMaterialIds)]);
  const byId = new Map(prepared.payload.sources.map(s => [s.id, s]));
  const authorizationText = byId.get(prepared.payload.intentAuthority?.sourceId)?.text || prepared.payload.userRequest.text;
  const explicitlyReferenced = !!prepared.payload.selectedOption || typeof plan.authorizationQuote === 'string' &&
    plan.authorizationQuote.trim().length > 1 && authorizationText.includes(plan.authorizationQuote);
  const quotes = plannedQuotes.map(q => {
    const source = byId.get(q.sourceId);
    const priorUserAuthorized = explicitlyReferenced && source?.type === 'private' && source.role === 'user';
    if ((!allowed.has(q.sourceId) && !priorUserAuthorized && source?.type !== 'qq') || !source || typeof q.text !== 'string' || !q.text.trim() ||
        q.text.length > 4000 || !source.text.includes(q.text)) throw new Error('拟表达内容未能对应本次明确请求或已选分享素材，请具体说明想说哪件事');
    if ((prepared.restrictions || prepared.payload.privateRestrictions || []).some(r => r.sourceId === q.sourceId ||
        r.text?.length > 2 && (q.text.includes(r.text) || r.text.includes(q.text)) && q.text.length > 2))
      throw new Error('这段内容仍标记为仅供私下讨论，请先明确更改它的分享范围');
    return { sourceId: q.sourceId, text: q.text };
  });
  const style = ['natural', 'short', 'casual'].includes(plan.style) ? plan.style : 'natural';
  const qq = prepared.payload.sources.filter(s => s.type === 'qq');
  const selection = selectMethods({ purpose: 'draft' });
  const guidance = parseDraftGuidance(plan.guidance, prepared.payload);
  const payload = { promptVersion: PROMPT_VERSION, purpose: 'draft', method: METHODS.draft, methodCards: selection.methods.map(runtimeCard),
    methodSelection: { version: selection.version, candidates: ['compose'], maxApplied: 1 }, style, asOf: prepared.payload.asOf,
    outboundQuotes: quotes, sources: [...qq], coverage: prepared.payload.coverage,
    replyFocus: prepared.payload.replyFocus || [],
    presentation: { language: typeof plan.language==='string'&&/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(plan.language) ? plan.language : 'zh',
      askFollowup: plan.askFollowup===true, useEmoji: plan.useEmoji===true } };
  let draftTaskTextReferences=prepared.payload.taskContext?.sourceTextLocation==='sources';
  const refreshDraftTask=()=>{if(!prepared.payload.taskContext)return;const task=prepared.payload.taskContext,ids=new Map(payload.sources.map(s=>[s.id,s]));
    const recent=task.recentExchange.filter(m=>ids.has(m.sourceId)).map(m=>({...m,...(ids.get(m.sourceId).historicalOnly?{historicalOnly:true}:{}),...(m.quote?{quote:m.quote.sourceId&&!ids.has(m.quote.sourceId)?{availability:'unavailable'}:{...m.quote,...(ids.get(m.quote.sourceId)?.historicalOnly?{historicalOnly:true}:{})}}:{})}));
    payload.taskContext={version:task.version,requestOrigin:'restricted_draft',latestActual:task.latestActual&&ids.has(task.latestActual.sourceId)?task.latestActual:null,
      recentExchange:recent,selfMessagesAfterLastContact:task.selfMessagesAfterLastContact.filter(id=>ids.has(id)),contactMessagesAfterLastSelf:task.contactMessagesAfterLastSelf.filter(id=>ids.has(id)),observationCoverage:task.observationCoverage,factsRule:task.factsRule};
    if(draftTaskTextReferences){payload.taskContext.sourceTextLocation='sources';for(const item of recent){delete item.text;if(item.quote)delete item.quote.text;}}
  };
  refreshDraftTask();
  if (guidance && Object.keys(guidance).length) payload.draftingGuidance = { ...guidance,
    authority: 'expression_control_not_message_content',
    instruction: '这些短控制只约束表达任务与用法，不是可发送原文。不要写出控制说明、私下理由或来源标识；保持outboundQuotes授权的意思，askFollowup:false不排除本来要表达的问题。' };
  const controlIds = guidance ? [...new Set([guidance.objective,guidance.allowedApproach,...(guidance.avoidances || []),guidance.currentStep].filter(Boolean).flatMap(item => item.sourceIds))] : [];
  const essentialIds=new Set([...(prepared.essentialSourceIds||qq.map(source=>source.id)),...quotes.map(q=>q.sourceId),...controlIds,...payload.replyFocus.map(id=>`qq:${id}`)]);
  for (;;) {
    const kept=new Set(payload.sources.map(source=>source.id));let laterComplete=true;
    for(const source of [...qq].reverse()){
      if(!kept.has(source.id)){laterComplete=false;continue;}
      if(!laterComplete)payload.sources=payload.sources.map(item=>item.id===source.id?{...item,historicalOnly:true,continuationCoverage:'later_messages_omitted'}:item);
    }
    refreshDraftTask();
    if(budget.fits(payload))break;
    if(payload.taskContext&&!draftTaskTextReferences){draftTaskTextReferences=true;continue;}
    const removable=payload.sources.findIndex(source=>!essentialIds.has(source.id));
    if(removable<0)throw new Error('当前拟表达内容或最新完整来信超过上下文预算，请分段处理；没有静默截断');
    payload.sources.splice(removable,1);
  }
  // Do not serialize the private request, goal, assistant summary or excluded-source negatives.
  const referencedSources=[...new Set([...quotes.map(q => q.sourceId), ...controlIds])].map(id=>({id,revision:byId.get(id).revision}));
  const uniqueSources = entries => [...new Map(entries.map(source => [source.id, source])).values()];
  const safeSources=uniqueSources([...payload.sources,...referencedSources]),allSafeSources=uniqueSources([...qq,...referencedSources]);
  const context=finish(payload,safeSources,info,allSafeSources,prepared.manifest.byteBudget,budget);
  context.essentialSourceIds=[...essentialIds];
  Object.defineProperty(context,'rebuildForRequest',{value:measure=>buildDraftContext(prepared,plan,{...info,requestMeasure:measure})});
  return context;
}
function expressionOptionsFor(context, options = []) {
  if (!Array.isArray(options) || options.length > 3) throw new Error('表达方向最多三项');
  return options.map(option => {
    if (!option || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 300 || !Array.isArray(option.quotes) || !option.quotes.length || option.quotes.length > 8)
      throw new Error('表达方向必须带有可核对的原话');
    const quotes = option.quotes.map(q => {
      const source = context.payload.sources.find(s => s.id === q.sourceId);
      if (!source || !['private','note','qq'].includes(source.type) || typeof q.text !== 'string' || !q.text.trim() || !source.text.includes(q.text)) throw new Error('表达方向引用的来源无效');
      if (source.type === 'note' && source.use !== 'draft') throw new Error('私下素材不能作为可直接分享的方向');
      if ((context.restrictions || context.payload.privateRestrictions || []).some(r => r.text?.length > 2 && q.text.length > 2 && (r.text.includes(q.text) || q.text.includes(r.text)))) throw new Error('表达方向包含仅供私下的内容');
      return { sourceId: q.sourceId, text: q.text, revision: source.revision };
    });
    return { label: option.label, quotes, style: ['short','casual'].includes(option.style) ? option.style : 'natural' };
  });
}
module.exports = { buildContext, buildDraftContext, expressionOptionsFor, sourcesFor, PROMPT_VERSION, METHODS, digest };
