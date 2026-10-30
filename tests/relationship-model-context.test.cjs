'use strict';
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext, buildDraftContext } = require('../src/assistant-context.cjs');
const { assistModel, parseAssistant, SYSTEM } = require('./fixtures/assistant-protocol.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const settings = { baseUrl: 'http://fixture.invalid/v1', model: 'synthetic', anonymous: true };
const response = value => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) });

function fixture(t, text = '我对她有好感，想多认识她，帮我说出来。') {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const records = [normalize(raw('720575940379279371', true, { elements: [{ textElement: { content: '我也喜欢这个游戏。' } }] }), scope),
    normalize(raw('720575940379279372', false, { elements: [{ textElement: { content: '周末有空可以一起玩。' } }] }), scope)];
  store.add(scope, records);
  store.setGoal(scope, '与她发展双方愿意的恋爱关系');
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text });
  return { store, args: { scope, records, turn, companion: store.getCompanion(scope), requestId: 'method-context', coverage: { status: 'partial' } } };
}

test('actual request delivers navigable purpose-neutral metadata and one applicable instruction card', async t => {
  const { args } = fixture(t);
  const context = buildContext({ ...args, purpose: 'reply' });
  const result = await assistModel(settings, context, undefined, async (_, request) => {
    const body = JSON.parse(request.body), payload = JSON.parse(body.messages[1].content);
    const expression = payload.methodCatalog?.find(item => item.id === 'express_interest');
    assert.ok(expression?.version && expression.name && expression.applicability, 'romantic expression stays discoverable without an operational preload');
    assert.equal(expression.instruction,undefined);
    assert.match(expression.applicability, /表达|邀请|恋爱/);
    assert.match(body.messages[0].content, /即使历史少/, 'shared behavior still permits truthful expression with sparse history');
    assert.equal(payload.methodCards.length,1);
    for (const card of payload.methodCards) for (const key of ['version', 'applicability', 'avoid', 'requiredContext', 'instruction', 'evidenceLimit']) assert.ok(card[key], key);
    assert.ok(payload.methodCards.every(card=>card.outputKinds===undefined),'old output-kind metadata stays in canonical clients, not the operation producer wire');
    assert.ok(payload.methodCards.some(card => card.id === 'respond'), 'a reply request receives full reply guidance');
    assert.equal(JSON.stringify([...payload.methodCards, ...payload.methodCatalog]).includes('https://'), false, 'paper catalog stays outside the hot path');
    assert.equal(payload.goal, '与她发展双方愿意的恋爱关系');
    assert.ok(context.manifest.methodTrace.catalog.some(item => item.id === expression.id && item.version === expression.version));
    assert.deepEqual(context.manifest.methodTrace.delivered.map(item => item.id), payload.methodCards.map(item => item.id));
    assert.deepEqual(context.manifest.methodTrace.operationalDelivery.ids,['respond']);
    return response({ kind: 'discussion', text: '可以直接表达你想多认识她，不用先猜她是否喜欢你。', methodIds: ['express_interest'] });
  });
  assert.deepEqual(result.methodIds, ['express_interest']);
  assert.deepEqual(context.manifest.methodTrace.reported, ['express_interest']);
  assert.equal(context.manifest.methodTrace.operationalDelivery.ids.includes('express_interest'),false,'a model report does not fabricate delivery of its instructions');
});

test('fallback QQ projection preserves actual self/contact identity independently of supplied role labels', t => {
  const { args } = fixture(t);
  const context = buildContext(args);
  assert.equal(context.payload.sources.find(item => item.id === 'qq:720575940379279371').speaker, '我');
  assert.equal(context.payload.sources.find(item => item.id === 'qq:720575940379279372').speaker, '对方');
});

test('unrelated memory index and repeated verbatim summaries do not fill a relationship request', t => {
  const { args } = fixture(t);
  const sourceId = `qq:${args.records[1].messageId}`, text = args.records[1].text;
  const context = buildContext({ ...args, memoryResult: { items: [{ id: 'legacy-match', kind: 'fact', text, sourceIds: [sourceId], topicKeys: ['一起玩'], reviewComplete: true }], episodes: [] },
    memoryIndex: [{ id: 'irrelevant', kind: 'fact', text: 'UNRELATED_DATABASE_MIGRATION_GUIDE', sourceIds: [], topicKeys: ['SQLite'] },
      { id: 'legacy-match', kind: 'fact', text, sourceIds: [sourceId], topicKeys: ['一起玩'] }] });
  assert.equal(JSON.stringify(context.payload).includes('UNRELATED_DATABASE_MIGRATION_GUIDE'), false);
  assert.equal(context.payload.memoryIndex.some(item => item.id === 'legacy-match'), false, 'already included summaries are not repeated as navigation');
  const summary = context.payload.retrievedMemory.items.find(item => item.id === 'legacy-match');
  assert.ok(summary);
  assert.equal(summary.text, undefined, 'verbatim source-backed summary points at one canonical text');
  assert.equal(summary.textFromSource, sourceId);
});

test('typed dyad context retains uncertainty and evidence while excluding unavailable references and duplicate views', t => {
  const { store, args } = fixture(t);
  const source = store.memorySources(scope).find(item => item.id === `private:${args.turn.id}`);
  const claim = { id: 'claim-fixture', version: 1, subject: 'self', aspect: 'romantic_interest', text: '用户说想多认识她', assertionKind: 'stated', epistemicStatus: 'supported', lifecycle: 'active', sourceIds: [source.id], sourceRevisions: { [source.id]: source.revision }, evidenceValidity: 'valid' };
  const hypothesis = { ...claim, id: 'hypothesis-fixture', subject: 'dyad', text: '她的恋爱意愿尚不确定', assertionKind: 'inferred', epistemicStatus: 'undetermined' };
  const context = buildContext({ ...args, availableSources: store.memorySources(scope), relationshipContext: { version: 1, claims: [claim, hypothesis, { ...claim, id: 'stale', text: 'STALE_HIDDEN_CLAIM', sourceIds: ['qq:missing'] }], events: [], self: [claim], contact: [], dyad: [hypothesis], activities: [], coverage: {} } });
  assert.equal(context.payload.relationshipContext.claims.length, 2);
  assert.equal(context.payload.relationshipContext.claims.find(item => item.id === hypothesis.id).epistemicStatus, 'undetermined');
  assert.equal(context.payload.relationshipContext.self, undefined, 'view aliases are not serialized as duplicate claims');
  assert.equal(JSON.stringify(context.payload).includes('STALE_HIDDEN_CLAIM'), false);
  assert.ok(context.payload.sources.some(item => item.id === source.id));
});

test('restricted draft has only compose stage, preserving preparation trace without private views or feedback', async t => {
  const { args } = fixture(t);
  const prepared = buildContext(args);
  const context = buildDraftContext(prepared, withCurrentDraftControls({ style: 'natural', quotes: [{ sourceId: prepared.payload.userRequest.sourceId, text: '我对她有好感，想多认识她' }] },prepared.payload), args);
  await assistModel(settings, context, undefined, async (_, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    assert.deepEqual(payload.methodCards.map(card => card.id), ['compose']);
    for (const key of ['relationshipContext', 'experienceContext', 'feedbackTargets', 'goal', 'privateConversation', 'preferences']) assert.equal(payload[key], undefined, key);
    return response({ kind: 'draft', text: '直接表达真实意思。', suggestions: [{ style: '自然', text: '我对你有好感，也想多认识你。' }] });
  });
  assert.ok(prepared.manifest.methodTrace.catalog.some(item => item.id === 'express_interest'));
  assert.deepEqual(prepared.manifest.methodTrace.delivered.map(item => item.id), prepared.payload.methodCards.map(item => item.id));
  assert.deepEqual(context.manifest.methodTrace.delivered.map(item => item.id), ['compose']);
  assert.equal(context.manifest.methodTrace.reported, null, 'absence of a reported method is not fabricated use');
});

test('reported method must be one of the delivered catalog/card options, not merely a valid registry entry', () => {
  assert.throws(() => parseAssistant({ kind: 'discussion', text: '测试', methodIds: ['express_interest'] }, 'discussion',
    { methodSelection: { candidates: ['respond'] }, methodCards: [{ id: 'respond' }] }), /methodIds|本次|方法/);
  assert.match(SYSTEM, /恋爱/);
});

test('a preparation response preserves sourced understanding alongside its draft plan and final drafting cannot mutate it', t => {
  const { args } = fixture(t), prepared = buildContext(args), sourceId = prepared.payload.userRequest.sourceId;
  const patch = { claims: [{ subject: 'self', aspect: 'relationship_intent', text: '用户想表达好感并进一步认识她', assertionKind: 'stated', epistemicStatus: 'supported', sourceIds: [sourceId] }], events: [], retire: [] };
  const statePatch = { focus: '表达真实好感', items: [{ text: '用户愿意表达好感', sourceIds: [sourceId] }], openThreads: [], unknowns: ['她是否愿意发展恋爱尚不明确'] };
  const result = parseAssistant({ draftPlan: withCurrentDraftControls({ quotes: [{ sourceId, text: '我对她有好感，想多认识她' }] },prepared.payload), relationshipPatch: patch, statePatch, stateReview: 'no_change', methodIds: ['express_interest'] }, 'discussion', prepared.payload);
  assert.deepEqual(result.relationshipPatch.claims[0].sourceIds, [sourceId]);
  assert.deepEqual(result.statePatch, statePatch);
  assert.equal(result.stateReview, 'no_change');
  const draft = { kind: 'draft', text: '表达', suggestions: [{ style: '自然', text: '我想多认识你。' }] };
  for (const field of ['relationshipPatch','statePatch','actions']) assert.throws(() => parseAssistant({ ...draft, [field]: field === 'actions' ? [] : {} }, 'draft'), /受限草稿/);
  for (const [invalid, expected] of [
    [{ ...patch.claims[0], sourceIds: ['qq:undelivered'] }, /sourceIds/],
    [{ ...patch.claims[0], assertionKind: 'inferred', epistemicStatus: 'supported' }, /epistemicStatus/]
  ]) {
    const invalidPatch = { claims: [invalid] }, diagnostics = {};
    const readable = parseAssistant({ kind: 'discussion', text: '尝试保存', relationshipPatch: invalidPatch, stateReview: 'no_change' }, 'discussion', prepared.payload, diagnostics);
    assert.equal(readable.text, '尝试保存'); assert.equal(readable.relationshipPatch, undefined); assert.equal(readable.stateReview, undefined);
    assert.equal(diagnostics.auxiliaryErrors[0].field, 'relationshipPatch'); assert.match(diagnostics.auxiliaryErrors[0].message, expected);
    assert.throws(() => parseAssistant({ draftPlan: { quotes: [{ sourceId, text: '我对她有好感，想多认识她' }] }, relationshipPatch: invalidPatch }, 'discussion', prepared.payload), expected,
      'source-bound preparation retains its strict evidence contract');
  }
});

test('feedback context hydrates the exact full evaluated artifact without creating a second factual source or leaking it to drafts', async t => {
  const { store, args } = fixture(t);
  const artifactText = `PRIVATE_EVALUATED_PROPOSAL ${'完整的被评价建议。'.repeat(80)}`;
  const output = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: artifactText, requestId: 'old-evaluated-request', sourceIds: [`private:${args.turn.id}`] });
  const feedback = store.addFeedback(scope, { text: '这次建议太像采访了，我想直接表达喜欢。', targetRef: { kind: 'artifact', artifactRef: output.artifactRef }, requestId: 'old-evaluated-request' });
  const contextArgs = { ...args, companion: store.getCompanion(scope), availableSources: store.memorySources(scope),
    experienceContext: store.experiences.context(scope, { query: '采访', limit: 4 }) };
  const prepared = buildContext(contextArgs), evaluation = prepared.payload.feedbackTargets[0];
  assert.equal(evaluation.target.body, artifactText, 'evaluated text must not be replaced by a title or latest reply');
  assert.equal(evaluation.feedback.sourceId, feedback.sourceId);
  assert.match(evaluation.target.authority, /evaluation_target_not_factual_evidence/);
  assert.equal(prepared.payload.sources.filter(source => source.id === feedback.sourceId).length, 1);
  assert.equal(prepared.payload.sources.some(source => source.text === artifactText), false);
  const draft = buildDraftContext(prepared, withCurrentDraftControls({ quotes: [{ sourceId: prepared.payload.userRequest.sourceId, text: '想多认识她' }] },prepared.payload), contextArgs);
  assert.equal(JSON.stringify(draft.payload).includes('PRIVATE_EVALUATED_PROPOSAL'), false);
  const fallback = buildContext({ ...contextArgs, availableSources: undefined });
  const feedbackTurns = store.getCompanion(scope).turns.filter(turn => ['feedback','feedback_ref'].includes(turn.kind));
  assert.ok(feedbackTurns.length);
  for (const turn of feedbackTurns) assert.equal(fallback.payload.sources.some(source => source.id === `private:${turn.id}`), false);
});

test('real-message feedback keeps actual QQ attribution rather than labeling the evaluated message as an AI proposal', t => {
  const { store, args } = fixture(t);
  const feedback = store.addFeedback(scope, { text: '我实际发出去的这句太绕了。', targetRef: { kind: 'actual_message', messageId: args.records[0].messageId } });
  const context = buildContext({ ...args, companion: store.getCompanion(scope), availableSources: store.memorySources(scope), feedbackTargets: [store.experiences.hydrateFeedback(scope, feedback.id)] });
  const target = context.payload.feedbackTargets[0].target;
  assert.equal(target.messageId, args.records[0].messageId);
  assert.equal(target.body, args.records[0].text);
  assert.equal(target.authority, 'actual_qq_evaluation_target');
});

test('only an explicitly enabled review can propose inactive local guidance from delivered canonical feedback', t => {
  const { store, args } = fixture(t, '回顾一下上次参考表达，怎样更像我自己？');
  const output = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '合成的被评价表达', requestId: 'proposal-target', sourceIds: [`private:${args.turn.id}`] });
  const feedback = store.addFeedback(scope, { text: '这次连续三个问题让我觉得像采访。', targetRef: { kind: 'artifact', artifactRef: output.artifactRef } });
  const options = { ...args, companion: store.getCompanion(scope), availableSources: store.memorySources(scope), experienceContext: store.experiences.context(scope, { query: '采访' }) };
  const review = buildContext({ ...options, purpose: 'review', allowExperienceProposals: true, methodLookupIds: ['respond'] });
  const proposal = { text: '在相似分享情境中先接住具体内容，减少连续追问。', applicability: '用户正在回应个人近况、且已有足够内容可以回应时', methodId: 'respond', sourceIds: [feedback.sourceId], caseIds: [] };
  const result = parseAssistant({ kind: 'review', text: '这次可以减少连问，保留你真正想说的部分。', experienceProposals: [proposal] }, 'review', review.payload);
  assert.deepEqual(result.experienceProposals, [proposal]);
  assert.equal(review.payload.experienceProposalPolicy.enabled, true);
  const catalogMethod = review.manifest.methodTrace.catalog.find(method => method.id === proposal.methodId);
  assert.ok(catalogMethod, 'the proposed method has a version in the actually delivered catalog');
  const operational=new Set(review.manifest.methodTrace.operationalDelivery.ids);
  const provided=review.manifest.methodTrace.delivered.filter(method=>operational.has(method.id));
  assert.deepEqual(provided.map(method=>method.id),['respond']);
  assert.throws(() => store.experiences.proposeFromModel(scope, result.experienceProposals[0], { allowedSourceIds: review.manifest.sourceIds,
    allowedCaseIds: [], deliveredMethods: provided.filter(method => method.id !== proposal.methodId) }), /method.*delivered/i);
  const saved = store.experiences.proposeFromModel(scope, result.experienceProposals[0], { allowedSourceIds: review.manifest.sourceIds,
    allowedCaseIds: [], deliveredMethods: provided });
  assert.equal(saved.status, 'candidate');
  assert.notEqual(saved.authority, 'user_approved_assistance_guidance');
  assert.deepEqual(saved.methodRef, { methodId: proposal.methodId, version: catalogMethod.version });
  const ordinary = buildContext({ ...options, allowExperienceProposals: false });
  assert.equal(ordinary.payload.experienceProposalPolicy.enabled, false);
  const disabledDiagnostics = {}, disabled = parseAssistant({ kind: 'discussion', text: '聊新话题', experienceProposals: [proposal] }, 'discussion', ordinary.payload, disabledDiagnostics);
  assert.equal(disabled.text, '聊新话题'); assert.equal(disabled.experienceProposals, undefined);
  assert.equal(disabledDiagnostics.auxiliaryErrors[0].field, 'experienceProposals'); assert.match(disabledDiagnostics.auxiliaryErrors[0].message, /未开启|复盘/);
  for (const change of [{ sourceIds: ['qq:undelivered'] }, { sourceIds: [`private:${args.turn.id}`] }, { caseIds: ['another-contact-case'] }, { status: 'active' }]) {
    const invalid = { ...proposal, ...change }, diagnostics = {};
    const readable = parseAssistant({ kind: 'review', text: '候选', experienceProposals: [invalid] }, 'review', review.payload, diagnostics);
    assert.equal(readable.text, '候选'); assert.equal(readable.experienceProposals, undefined);
    assert.equal(diagnostics.auxiliaryErrors[0].field, 'experienceProposals'); assert.match(diagnostics.auxiliaryErrors[0].message, /experienceProposals/);
    assert.throws(() => store.experiences.proposeFromModel(scope, invalid, { allowedSourceIds: review.manifest.sourceIds,
      allowedCaseIds: [], deliveredMethods: provided }), /proposal|feedback|case|evidence/i);
  }
});

test('recorded feedback output promotes a candidate only after loading its actual instruction card', async t => {
  for(const loadCard of [false,true]){
  const { Controller } = require('./fixtures/assistant-protocol.cjs');
  const recorded = require('./fixtures/live-feedback-response.json');
  const store = new Store(':memory:');
  const earlier = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她说今天考完很累，我想回应她。' });
  const answer = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '原建议：你今天考了什么？感觉难不难？晚上准备做什么？', requestId: 'recorded-old-target', sourceIds: [`private:${earlier.id}`] });
  store.saveRun(scope, { id: 'recorded-old-target', status: 'complete', replyId: answer.id });
  for (let index = 0; index < 14; index++) store.saveRun(scope, { id: `recorded-later-${index}`, status: 'complete' });
  const feedback = store.addFeedback(scope, { text: '这条建议连续问了三个问题，让我感觉像采访。我希望对她分享的事情先有具体回应。', targetRef: { kind: 'artifact', artifactRef: answer.artifactRef } });
  const result = structuredClone(recorded.response);
  for (const proposal of result.experienceProposals) proposal.sourceIds = proposal.sourceIds.map(id => id.startsWith('private:feedback-') ? feedback.sourceId : `private:${earlier.id}`);
  const controller = new Controller({ store, settings: { ...settings, auto: false,
    realChatConsent: { accountUid: scope.accountUid, peerUin: scope.peerUin, model: settings.model, baseUrl: settings.baseUrl } },
    read: async command => command === 'bind' ? scope : { messages: [], source: 'synthetic' }, assistantModel: async (_settings,context) => {
      if(loadCard&&!context.payload.methodCards.some(card=>card.id==='respond'))return {kind:'discussion',text:'Read the relevant assistance card.',lookup:{methodIds:['respond']}};
      return structuredClone(result);
    } });
  controller.visible = false;
  t.after(() => { controller.close(); store.close(); });
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  await controller.bind(scope.peerUin);
  const previous = store.getCompanion(scope), feedbackTurn = previous.turns.find(turn => turn.feedbackId === feedback.id);
  assert.equal(previous.runs.some(run => run.id === 'recorded-old-target'), false);
  const reply = await controller.assist({ text: recorded.request, purpose: 'review', sourceTurnIds: [feedbackTurn.id] });
  assert.equal(reply?.text, result.text);
  const current = store.getCompanion(scope);
  assert.equal(current.revision, previous.revision + 1, 'only the new user request advances source revision');
  assert.equal(store.getCompanion(scope).revision, current.revision, 'normal reads must not normalize an already canonical write again');
  assert.equal(current.runs.find(run => run.id === reply.requestId).status, 'complete');
  const candidates = store.experiences.list(scope).adaptations;
  assert.equal(candidates.length, loadCard?1:0, 'directory metadata alone cannot support candidate promotion');
  if(loadCard){
    assert.equal(candidates[0].status, 'candidate');
    assert.ok(candidates[0].sourceIds.includes(feedback.sourceId));
  }
  }
});

test('an old relative-week claim without an end date reaches the model as unspecified, not a fresh current arrangement', t => {
  const { RELATIONSHIP_PROTOCOL } = require('./fixtures/assistant-protocol.cjs');
  const { MEMORY_SYSTEM } = require('../src/memory-engine.cjs');
  const store = new Store(':memory:'); t.after(() => store.close());
  const at = '2026-10-11T08:00:00.000Z';
  const record = normalize(raw('720575940379279399', false, { msgTime: String(Date.parse(at) / 1000), elements: [{ textElement: { content: '这周忙着考试，周五考完。' } }] }), scope);
  store.add(scope, [record]);
  const sourceId = `qq:${record.messageId}`;
  const applied = store.applyRelationshipPatch(scope, { claims: [{ subject: 'contact', aspect: 'recent_context', text: '她说这周备考、周五考完', assertionKind: 'stated', epistemicStatus: 'supported', validFrom: at, sourceIds: [sourceId] }] },
    { baseRevision: store.getCompanion(scope).revision, sourceIds: [sourceId] });
  assert.equal(applied.applied, true);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '现在可以按这个周五约她吗？' });
  const context = buildContext({ scope, records: store.messages(scope), companion: store.getCompanion(scope), turn, requestId: 'relative-week', coverage: { status: 'partial' },
    availableSources: store.memorySources(scope), relationshipContext: store.relationshipView(scope, { asOf: '2026-10-12T08:00:00.000Z' }) });
  assert.equal(context.payload.sources.find(source => source.id === sourceId).at, at);
  assert.equal(context.payload.relationshipContext.claims[0].applicability, 'unspecified');
  assert.equal(context.payload.relationshipContext.claims[0].validUntil, undefined);
  assert.match(RELATIONSHIP_PROTOCOL, /anchored to the original source at/);
  assert.ok(SYSTEM.includes(RELATIONSHIP_PROTOCOL) && MEMORY_SYSTEM.includes(RELATIONSHIP_PROTOCOL), 'both real model stages receive the same time-grounding rule');
});

test('a source-backed user-reported shared activity reaches context with its reported authority and never becomes a QQ send', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const activityText = 'ACTIVITY_SYNTHETIC_PRIVATE 昨晚我们一起玩了合作游戏，我觉得相处挺轻松。';
  const report = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: activityText });
  const sourceId = `private:${report.id}`;
  assert.equal(store.applyRelationshipPatch(scope, { events: [{ activityKey: 'cooperative-game', eventKind: 'occurred', actor: 'both', text: '用户报告一起玩过合作游戏', sourceIds: [sourceId] }] },
    { baseRevision: store.getCompanion(scope).revision, sourceIds: [sourceId] }).applied, true);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '回顾一下这次一起玩的体验，然后考虑下次怎么继续认识。' });
  const experienceContext = store.experiences.context(scope, { query: '合作游戏' });
  const args = { scope, records: [], companion: store.getCompanion(scope), turn, requestId: 'reported-activity', coverage: { status: 'empty' }, availableSources: store.memorySources(scope), experienceContext };
  const context = buildContext(args);
  const action = context.payload.experienceContext.cases.flatMap(item => item.actualActions).find(action => action.kind === 'user_reported_activity');
  assert.ok(action);
  assert.equal(action.authority, 'reported_not_directly_observed');
  assert.deepEqual(action.sourceIds, [sourceId]);
  assert.equal(action.messageId, undefined);
  assert.equal(context.payload.sources.find(source => source.id === sourceId).text, activityText);
  const stale = structuredClone(experienceContext);
  for (const item of stale.cases) for (const action of item.actualActions) if (action.kind === 'user_reported_activity') action.sourceRevisions[sourceId] = 'stale';
  const staleContext = buildContext({ ...args, experienceContext: stale });
  assert.equal(staleContext.payload.experienceContext.cases.some(item => item.actualActions.some(action => action.kind === 'user_reported_activity')), false);
  assert.equal(store.messages(scope).length, 0);
});

test('forgotten user-reported activity cannot return through a captured experience view', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const report = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'FORGOTTEN_ACTIVITY_SYNTHETIC 我们昨天一起去看展了。' });
  const sourceId = `private:${report.id}`;
  assert.equal(store.applyRelationshipPatch(scope, { events: [{ activityKey: 'exhibition', eventKind: 'occurred', actor: 'both', text: '用户报告一起看展', sourceIds: [sourceId] }] },
    { baseRevision: store.getCompanion(scope).revision, sourceIds: [sourceId] }).applied, true);
  const staleExperience = store.experiences.context(scope, { query: '看展' });
  assert.ok(staleExperience.cases.length);
  assert.equal(store.forgetSource(scope, sourceId), true);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '现在有哪些确定的信息可以参考？' });
  const context = buildContext({ scope, records: [], companion: store.getCompanion(scope), turn, requestId: 'forgotten-activity', coverage: { status: 'empty' },
    availableSources: store.memorySources(scope), experienceContext: staleExperience });
  assert.equal(context.payload.experienceContext.cases.length, 0);
  assert.equal(JSON.stringify(context.payload).includes('FORGOTTEN_ACTIVITY_SYNTHETIC'), false);
});
