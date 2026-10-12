'use strict';
const crypto = require('node:crypto');
const { redact } = require('./model.cjs');
const PROMPT_VERSION = 'relationship-context-2026-10-12.1';
const METHODS = {
  discussion: '按当前困难选择理清想法、比较下一步或回应分享。意思明确就直接帮助，只问会改变建议的必要问题。允许暂缓或不用助手，不强制每次制定目的。',
  review: '按实际覆盖回顾彼此了解、接续话题、共同经历、双方关心与用户体验。兼顾顺利、不顺利与未知，不计算好感分，不把回复归因为某条建议。',
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
  const ids = sources.map(s => s.id);
  return { payload, manifest: { requestId: info.requestId, scope: info.scope, purpose: payload.purpose,
    promptVersion: PROMPT_VERSION, contextRevision: info.companion.revision, stateVersion: info.companion.state.version,
    sourceIds: ids, sourceRevisions: Object.fromEntries(sources.map(s => [s.id, s.revision])),
    completeReview: allSources.every(s => ids.includes(s.id)), omittedSourceCount: allSources.filter(s => !ids.includes(s.id)).length,
    historyCoverage: info.coverage, inputBytes, byteBudget, tokenizerVerified: false,
    budgetMethod: 'UTF-8 byte ceiling for serialized input; tokenizer and provider window unverified',
    createdAt: new Date().toISOString() } };
}
function buildContext({ scope, records, companion, turn, purpose = 'discussion', coverage, requestId,
  materialIds = [], byteBudget = 48000 }) {
  if (!METHODS[purpose] || purpose === 'draft') throw new Error('未知的上下文用途');
  if (!Number.isFinite(byteBudget) || byteBudget < 4000 || byteBudget > 192000) throw new Error('上下文预算不合法');
  const all = sourcesFor(records, companion), byId = new Map(all.map(s => [s.id, s]));
  const currentId = `private:${turn.id}`;
  const current = byId.get(currentId);
  if (!current) throw new Error('当前私下请求不存在');
  if (!Array.isArray(materialIds) || materialIds.some(id => typeof id !== 'string' || !companion.notes.some(n => n.id === id && n.use === 'draft')))
    throw new Error('草稿素材必须是当前联系人允许分享的近况');
  const selected = new Map([[current.id, current]]);
  const validQQ = records.filter(eligibleQQ);
  // Protect both complete sides of the latest exchange, including after the
  // user has already replied in several bubbles. Never lose her boundary then.
  let start = validQQ.length;
  for (let group = 0; group < 2 && start > 0; group++) {
    const direction = validQQ[start - 1].direction;
    do { start--; } while (start > 0 && validQQ[start - 1].direction === direction);
  }
  for (const message of validQQ.slice(start)) selected.set(`qq:${message.messageId}`, byId.get(`qq:${message.messageId}`));
  for (const id of materialIds) selected.set(`note:${id}`, byId.get(`note:${id}`));
  const essentialIds = new Set(selected.keys());
  const state = { ...companion.state, authority: companion.state.possiblyStale ? 'previous_summary_needs_review' : 'reviewed_summary_not_independent_evidence' };
  if (state.possiblyStale) state.openThreads = (state.openThreads || []).map(item => ({ ...item,
    previousStatus: item.status || 'open', status: 'needs_review' }));
  const payload = { promptVersion: PROMPT_VERSION, purpose, method: METHODS[purpose], asOf: new Date().toISOString(),
    userRequest: { sourceId: current.id, text: current.text }, goal: redact(companion.goal.text || ''),
    workingState: state, coverage, selectedMaterialIds: materialIds.map(id => `note:${id}`),
    sources: [...selected.values()], privateConversation: [],
    evidenceRule: 'historicalOnly=true 的消息仅为历史提及，后续可能有未读的更改，不可据此断言当前约定有效。possiblyStale 的状态只作需要核查的上次理解，新原话与用户纠正优先。',
    omittedStateEntries: 0 };
  const refresh = () => { payload.sources = [...selected.values()]; };
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
  // Add complete private exchanges rather than orphaning an assistant answer.
  const groups = [];
  for (const t of companion.turns) {
    if (t.id === turn.id) continue;
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
  for (const n of companion.notes) trySource(byId.get(`note:${n.id}`));
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
  return finish(payload, payload.sources, { scope, requestId, companion, coverage }, all, byteBudget);
}
function buildDraftContext(prepared, plan, info) {
  if (!plan || !Array.isArray(plan.quotes) || !plan.quotes.length || plan.quotes.length > 8)
    throw new Error('需要明确这次想表达的内容，才能组织草稿');
  const allowed = new Set([prepared.payload.userRequest.sourceId, ...prepared.payload.selectedMaterialIds]);
  const byId = new Map(prepared.payload.sources.map(s => [s.id, s]));
  const quotes = plan.quotes.map(q => {
    const source = byId.get(q.sourceId);
    if (!allowed.has(q.sourceId) || !source || typeof q.text !== 'string' || !q.text.trim() ||
        q.text.length > 4000 || !source.text.includes(q.text)) throw new Error('拟表达内容未能对应本次明确请求或已选分享素材，请具体说明想说哪件事');
    return { sourceId: q.sourceId, text: q.text };
  });
  const style = ['natural', 'short', 'casual'].includes(plan.style) ? plan.style : 'natural';
  const qq = prepared.payload.sources.filter(s => s.type === 'qq');
  const payload = { promptVersion: PROMPT_VERSION, purpose: 'draft', method: METHODS.draft, style, asOf: prepared.payload.asOf,
    outboundQuotes: quotes, sources: qq, coverage: prepared.payload.coverage };
  // Do not serialize the private request, goal, assistant summary or excluded-source negatives.
  const safeSources = [...qq, ...quotes.map(q => ({ id: q.sourceId, revision: byId.get(q.sourceId).revision }))];
  return finish(payload, safeSources, info, safeSources, prepared.manifest.byteBudget);
}
module.exports = { buildContext, buildDraftContext, sourcesFor, PROMPT_VERSION, METHODS, digest };
