'use strict';
const crypto = require('node:crypto');
const { redact } = require('./model.cjs');
const { selectMethods } = require('./help-methods.cjs');
const PROMPT_VERSION = 'relationship-context-2026-10-12.2';
const METHODS = {
  discussion: '按当前困难选择理清想法、比较下一步或回应分享。意思明确就直接帮助，只问会改变建议的必要问题。允许暂缓或不用助手，不强制每次制定目的。',
  review: '按实际覆盖回顾彼此了解、接续话题、共同经历、双方关心与用户体验。兼顾顺利、不顺利与未知，不计算好感分，不把回复归因为某条建议。',
  reply: '结合当前关系背景与回复重点，回应真实 QQ 来信；可以给参考表达，也可以先处理关键歧义。不重复已经发出的内容。',
  draft_prepare: '只提取用户此次明确想对她表达的原文片段，或用户选中的可分享素材。担忧、私人动机、禁止披露内容不选。含糊且影响分享范围则提一个具体问题。',
  draft: '根据提供的拟表达片段和真实 QQ 语境组织一条自然、可修改的表达。不补造经历、心理或共同约定；不要求延长聊天。'
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
function eligibleQQ(message) { return message.kind === 'actual' && !message.recalled && message.text !== '[已撤回]'; }
function sourcesFor(records, companion) {
  return [
    ...records.filter(eligibleQQ).map(m => ({ id: `qq:${m.messageId}`, type: 'qq', text: redact(m.text),
      at: new Date(m.timestamp).toISOString(), speaker: m.direction === 'outgoing' ? '我' : '对方', revision: digest(m) })),
    ...companion.turns.filter(t => t.role === 'user').map(t => ({ id: `private:${t.id}`, type: 'private', role: 'user',
      text: redact(t.text), at: t.createdAt, revision: digest(t) })),
    ...companion.notes.filter(n => n.use !== 'disabled').map(n => ({ id: `note:${n.id}`, type: 'note',
      text: redact(n.text), use: n.use, at: n.updatedAt || n.createdAt, revision: digest(n) }))
  ];
}
function finish(payload, sources, info, allSources, byteBudget) {
  const inputBytes = bytes(payload);
  if (inputBytes > byteBudget) throw new Error('本次必要内容超过上下文预算，请缩小所选内容或分段讨论；内容未被截断');
  const ids = sources.filter(s => !s.id.startsWith('request:')).map(s => s.id);
  return { payload, manifest: { requestId: info.requestId, scope: info.scope, purpose: payload.purpose,
    promptVersion: PROMPT_VERSION, contextRevision: info.companion.revision, stateVersion: info.companion.state.version,
    sourceIds: ids, sourceRevisions: Object.fromEntries(sources.map(s => [s.id, s.revision])),
    completeReview: allSources.every(s => ids.includes(s.id)), omittedSourceCount: allSources.filter(s => !ids.includes(s.id)).length,
    historyCoverage: info.coverage, inputBytes, byteBudget, tokenizerVerified: false,
    budgetMethod: 'UTF-8 byte ceiling for serialized input; tokenizer and provider window unverified',
    createdAt: new Date().toISOString() } };
}
function buildContext({ scope, records, companion, turn, purpose = 'discussion', coverage, requestId,
  materialIds = [], byteBudget = 48000, availableSources, memoryResult, memoryIndex = [], retrievedSources = [],
  sourceTurnIds = [], selectedOption, replyMessageIds = [], actionReceipts = [], lookupHistory = [], reviewRange }) {
  if (!METHODS[purpose] || purpose === 'draft') throw new Error('未知的上下文用途');
  if (!Number.isFinite(byteBudget) || byteBudget < 4000 || byteBudget > 192000) throw new Error('上下文预算不合法');
  const all = (availableSources || sourcesFor(records, companion)).map(s => ({ ...s, text: redact(s.text),
    ...(s.type === 'qq' ? { speaker: s.direction === 'outgoing' || s.role === 'user' ? '我' : '对方' } : {}) }));
  all.sort((a,b)=>Date.parse(a.at||0)-Date.parse(b.at||0)||a.id.localeCompare(b.id));
  const byId = new Map(all.map(s => [s.id, s]));
  const currentId = `private:${turn.id}`;
  const current = byId.get(currentId) || (turn.transient || turn.memoryExcluded ? { id: `request:${turn.id}`, type: 'request', text: redact(turn.text), revision: digest(turn), role: 'user' } : null);
  if (!current) throw new Error('当前私下请求不存在');
  if (!Array.isArray(materialIds) || materialIds.length>12 || materialIds.some(id => typeof id !== 'string' || !companion.notes.some(n => n.id === id && n.use === 'draft')))
    throw new Error('草稿素材必须是当前联系人允许分享的近况');
  const selected = new Map([[current.id, current]]);
  const validQQ = records.filter(m => eligibleQQ(m) && byId.has(`qq:${m.messageId}`));
  // Protect both complete sides of the latest exchange, including after the
  // user has already replied in several bubbles. Never lose her boundary then.
  let start = validQQ.length;
  for (let group = 0; group < 2 && start > 0; group++) {
    const direction = validQQ[start - 1].direction;
    do { start--; } while (start > 0 && validQQ[start - 1].direction === direction);
  }
  for (const message of validQQ.slice(start)) selected.set(`qq:${message.messageId}`, byId.get(`qq:${message.messageId}`));
  for (const id of materialIds) selected.set(`note:${id}`, byId.get(`note:${id}`));
  for (const id of replyMessageIds) if (byId.has(`qq:${id}`)) selected.set(`qq:${id}`, byId.get(`qq:${id}`));
  const selectedProposal = selectedOption && companion.turns.find(t => t.id === selectedOption.turnId && t.role === 'assistant')?.expressionOptions?.[selectedOption.index];
  if (selectedOption && !selectedProposal) throw new Error('选中的表达方向已变化，请重新选择');
  const proposals = companion.turns.filter(t => t.role === 'assistant' && t.expressionOptions?.length).slice(-4)
    .flatMap(t => t.expressionOptions.map((o, index) => ({ ...o, turnId: t.id, index })));
  for (const proposal of selectedProposal ? [selectedProposal] : []) for (const q of proposal.quotes || [])
    if (byId.has(q.sourceId)) selected.set(q.sourceId, byId.get(q.sourceId));
  const essentialIds = new Set(selected.keys());
  const state = { ...companion.state, authority: companion.state.possiblyStale ? 'previous_summary_needs_review' : 'reviewed_summary_not_independent_evidence' };
  if (state.possiblyStale) state.openThreads = (state.openThreads || []).map(item => ({ ...item,
    previousStatus: item.status || 'open', status: 'needs_review' }));
  const methodSelection = selectMethods({ purpose, text: current.text, focus: state.focus, hasReply: validQQ.at(-1)?.direction === 'incoming' });
  const restrictions = companion.notes.filter(n => n.use === 'discussion' && n.kind !== 'preference').map(n => ({ sourceId: `note:${n.id}`, text: redact(n.text), evidenceSourceIds: n.evidenceSourceIds || [] }));
  const payload = { promptVersion: PROMPT_VERSION, purpose, method: methodSelection.instruction, methodSelection: {
    version: methodSelection.version, selection: methodSelection.selection, candidates: methodSelection.methods.map(m => m.id),
    maxApplied: methodSelection.maxApplied, selectionRule: methodSelection.selectionRule, feedbackRule: methodSelection.feedbackRule }, asOf: new Date().toISOString(),
    userRequest: { sourceId: current.id, text: current.text }, goal: redact(companion.goal.text || ''),
    workingState: state, coverage, selectedMaterialIds: materialIds.map(id => `note:${id}`),
    allowedMaterialIds: [],
    expressionOptions: selectedProposal ? proposals.filter(o=>o.turnId===selectedOption.turnId&&o.index===selectedOption.index) : [], selectedOption: selectedOption || null,
    actionReceipts: actionReceipts.map(r=>({id:r.id,type:r.type,status:r.status,label:r.label,text:r.text||r.preview,reason:r.reason})),
    privateRestrictions: [], preferences: [],
    replyFocus: replyMessageIds, lookupHistory, reviewRange: reviewRange || null,
    retrievedMemory: { items: [], episodes: [], coverage: memoryResult?.coverage || null }, memoryIndex: [],
    sources: [...selected.values()], privateConversation: [],
    evidenceRule: 'historicalOnly=true 的消息仅为历史提及，后续可能有未读的更改，不可据此断言当前约定有效。possiblyStale 的状态只作需要核查的上次理解，新原话与用户纠正优先。',
    omittedStateEntries: 0 };
  const refresh = () => { payload.sources = [...selected.values()]; payload.allowedMaterialIds=payload.sources.filter(s=>s.type==='note'&&s.use==='draft').map(s=>s.id); };
  refresh();
  // A large derived state cannot make a small explicit request unusable. Drop
  // complete low-priority entries, recording the omission, never cutting text.
  for (const key of ['items', 'openThreads', 'unknowns']) {
    state[key] = [...(state[key] || [])];
    while (bytes(payload) > byteBudget && state[key].length) { state[key].pop(); payload.omittedStateEntries++; }
  }
  // No substring truncation: reject if the request and latest complete exchange do not fit.
  if (bytes(payload) > byteBudget) throw new Error('当前问题或最新完整来信超过上下文预算，请分段处理；没有静默截断');
  const trySource = source => {
    if (!source || selected.has(source.id)) return;
    selected.set(source.id, source); refresh();
    if (bytes(payload) > byteBudget) { selected.delete(source.id); refresh(); }
  };
  if(!selectedProposal)for(const option of proposals.reverse()) {
    payload.expressionOptions.unshift(option);
    if(bytes(payload)>byteBudget){payload.expressionOptions.shift();break;}
  }
  for (const source of [...retrievedSources, ...(memoryResult?.sources || [])].sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0))) trySource(byId.get(source.id));
  for (const n of companion.notes.filter(n=>n.kind==='preference'&&n.use!=='disabled').slice(-12)) {
    payload.preferences.push({sourceId:`note:${n.id}`,text:redact(n.text)});
    if(bytes(payload)>byteBudget){payload.preferences.pop();break;}
  }
  for (const id of sourceTurnIds) {
    const t = companion.turns.find(t => t.id === id);
    if (!t) continue;
    if (t.role === 'user') trySource(byId.get(`private:${id}`));
    else for (const sid of t.sourceIds || []) trySource(byId.get(sid));
  }
  for (const kind of ['items', 'episodes']) for (const item of memoryResult?.[kind] || []) {
    const clean = { ...item, text: redact(item.text), authority: item.reviewComplete===false || item.sourceIds.some(id=>!selected.has(id)) ? 'needs_review' : 'source_backed_summary' };
    payload.retrievedMemory[kind].push(clean);
    if (bytes(payload) > byteBudget) { payload.retrievedMemory[kind].pop(); break; }
  }
  for (const item of memoryIndex.slice(0, 30)) {
    payload.memoryIndex.push({ id: item.id, kind: item.kind, text: redact(item.text), topicKeys: item.topicKeys, status: item.status,
      authority:'navigation_only_needs_source_lookup',reviewComplete:item.reviewComplete,sourceIds:item.sourceIds,lastEvidenceAt:item.lastEvidenceAt });
    if (bytes(payload) > byteBudget) { payload.memoryIndex.pop(); break; }
  }
  // Add complete private exchanges rather than orphaning an assistant answer.
  const groups = [];
  for (const t of companion.turns) {
    if (t.id === turn.id || t.memoryExcluded || t.role === 'user' && !byId.has(`private:${t.id}`)) continue;
    if (t.role === 'user' || !groups.length) groups.push([]);
    groups.at(-1).push(t);
  }
  for (const group of groups.slice(-6).reverse()) {
    const previous = new Map(selected), previousTurns = payload.privateConversation;
    payload.privateConversation = group.map(t => ({ id: t.id, role: t.role, kind: t.kind, text: redact(t.text) })).concat(previousTurns);
    for (const t of group) if (t.role === 'user') {
      const source = byId.get(`private:${t.id}`); if (source) selected.set(source.id, source);
    }
    refresh();
    if (bytes(payload) > byteBudget) {
      selected.clear(); for (const [id, source] of previous) selected.set(id, source);
      payload.privateConversation = previousTurns; refresh(); break;
    }
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
    if(bytes(payload)>byteBudget){payload.privateRestrictions.pop();break;}
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
    if (bytes(payload) > byteBudget) { selected.clear(); for (const [id, value] of prior) selected.set(id, value); refresh(); }
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
    if (bytes(payload) <= byteBudget) break;
    const removable = [...selected.keys()].find(id => !essentialIds.has(id));
    if (removable) { selected.delete(removable); refresh(); }
    else if (payload.privateConversation.length) {
      payload.privateConversation.shift();
      while (payload.privateConversation[0]?.role === 'assistant') payload.privateConversation.shift();
    }
    else break;
  }
  // New evidence is serialized chronologically, even when selected by recency/relevance.
  const order = new Map(all.map((s, i) => [s.id, i]));
  payload.sources.sort((a, b) => order.get(a.id) - order.get(b.id));
  const context=finish(payload, payload.sources, { scope, requestId, companion, coverage }, all, byteBudget);
  context.restrictions=restrictions;
  return context;
}
function buildDraftContext(prepared, plan, info) {
  const optionRef = prepared.payload.selectedOption || plan?.option;
  const option = optionRef && prepared.payload.expressionOptions?.find(o => o.turnId === optionRef.turnId && o.index === optionRef.index);
  if (optionRef && !option) throw new Error('先前选择的方向已变化，请重新选择');
  const plannedQuotes = option ? option.quotes : plan?.quotes;
  const replyOnly = plan?.intent === 'reply' && prepared.payload.sources.some(s => s.type === 'qq');
  if (!plan || !Array.isArray(plannedQuotes) || (!plannedQuotes.length && !replyOnly) || plannedQuotes.length > 8)
    throw new Error('需要明确这次想表达的内容，才能组织草稿');
  const allowed = new Set([prepared.payload.userRequest.sourceId, ...(prepared.payload.allowedMaterialIds || prepared.payload.selectedMaterialIds)]);
  const byId = new Map(prepared.payload.sources.map(s => [s.id, s]));
  const explicitlyReferenced = !!prepared.payload.selectedOption || typeof plan.authorizationQuote === 'string' &&
    plan.authorizationQuote.trim().length > 1 && prepared.payload.userRequest.text.includes(plan.authorizationQuote);
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
  const payload = { promptVersion: PROMPT_VERSION, purpose: 'draft', method: METHODS.draft, style, asOf: prepared.payload.asOf,
    outboundQuotes: quotes, sources: qq, coverage: prepared.payload.coverage,
    replyFocus: prepared.payload.replyFocus || [],
    presentation: { language: typeof plan.language==='string'&&/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(plan.language) ? plan.language : 'zh',
      askFollowup: plan.askFollowup===true, useEmoji: plan.useEmoji===true } };
  // Do not serialize the private request, goal, assistant summary or excluded-source negatives.
  const safeSources = [...qq, ...quotes.map(q => ({ id: q.sourceId, revision: byId.get(q.sourceId).revision }))];
  return finish(payload, safeSources, info, safeSources, prepared.manifest.byteBudget);
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
