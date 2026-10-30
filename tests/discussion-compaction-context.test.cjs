'use strict';
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const {materialRefForText}=require('./fixtures/current-statement-authority.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { buildContext, buildDraftContext, PROMPT_VERSION } = require('../src/assistant-context.cjs');
const { assistModel, parseAssistant } = require('./fixtures/assistant-protocol.cjs');
const { planDiscussionCompaction, parseDiscussionCompaction, assistDiscussionCompaction } = require('../src/discussion-compaction.cjs');
const { discussionCompactionEvidence, discussionTopicBinding, discussionModelBinding, DISCUSSION_COMPACTION_VERSION } = require('../src/discussion-compaction-store.cjs');
const { scope } = require('./fixtures/native.cjs');
const settings = { model: 'synthetic', baseUrl: 'http://synthetic.invalid/v1', anonymous: true };
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const user = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'PRIVATE_MOTIVE_有点担心，但想确认周末是否方便一起散步。别连续追问。' });
  const first = '周末方便一起散步吗？', second = '这周哪天方便一起出去走走？';
  const assistant = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '私人分析。'.repeat(800) + `第一种：${first}\n第二种：${second}`, sourceIds: [`private:${user.id}`] });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '那给第二个。' });
  const companion = store.getCompanion(scope), ids = [user.id, assistant.id], evidence = discussionCompactionEvidence(store, scope, ids, companion);
  const record = { scope, id: 'synthetic-cache', summary: 'PRIVATE_CACHE_SUMMARY_已商量轻松邀请，保留不连续追问；有两个参考方向。', sourceTurnIds: ids, ...evidence,
    goalVersion: companion.goal.version, topicVersion: companion.topics.version, topicBinding: discussionTopicBinding(companion), model: settings.model,
    modelBinding: discussionModelBinding(settings.baseUrl, settings.model), promptVersion: PROMPT_VERSION, protocolVersion: DISCUSSION_COMPACTION_VERSION,
    quoteRefs: [first, second].map(text => ({ turnId: assistant.id, role: 'assistant', field: 'text', text })) };
  const args = { scope, records: [], store, companion, turn, settings, availableSources: store.memorySources(scope), purpose: 'discussion', requestId: 'compaction-context', coverage: { status: 'empty' }, byteBudget: 10000, promptVersion: PROMPT_VERSION };
  return { store, args, record, user, assistant, first, second };
}
function authorizedInvitation(user) {
  const sourceId = `private:${user.id}`, text = '周末是否方便一起散步';
  return { sourceId, text, authorization: {
    permission: { sourceId, text: '想确认周末是否方便一起散步' },
    referent: { sourceId, text }
  } };
}
test('cached discussion folds a long prior assistant while preserving exact user correction and original candidates', t => {
  const { args, record, user, assistant, first, second } = fixture(t);
  const deferred=buildContext(args);assert.equal(deferred.payload.deferredDiscussion.availability,'needs_lookup');assert.ok(deferred.payload.deferredDiscussion.turnIds.includes(assistant.id));assert.equal(deferred.payload.userRequest.text,args.turn.text);
  const context = buildContext({ ...args, discussionCompaction: record });
  assert.equal(context.payload.discussionCompaction.authority, 'derived_private_discussion_needs_sources');
  assert.equal(context.payload.sources.find(source => source.id === `private:${user.id}`).text, user.text);
  assert.equal(context.payload.privateConversation.find(turn => turn.id === assistant.id).compacted, true);
  assert.equal(JSON.stringify(context.payload).includes('私人分析。'.repeat(100)), false);
  assert.deepEqual(context.payload.privateCandidates.map(item => item.text), [first, second]);
  assert.ok(context.payload.privateCandidates.every(item => item.authority === 'generated_discussion_not_outbound_authorization'));
  assert.deepEqual(context.manifest.discussionCompaction.turnFingerprints, record.turnFingerprints);
  assert.equal(parseAssistant({ lookup: { discussionTurnIds: [assistant.id] } }, 'discussion', context.payload).lookup.discussionTurnIds[0], assistant.id);
  assert.throws(() => parseAssistant({ lookup: { discussionTurnIds: ['foreign-turn'] } }, 'discussion', context.payload), /discussionTurnIds/);
  const plan = { quotes: [authorizedInvitation(user)],
    guidance: { currentStep: { text: '按用户选中的第二个方向表达', sourceIds: [context.payload.userRequest.sourceId] } } };
  const draft = buildDraftContext(context, withCurrentDraftControls({...plan,guidance:undefined},context.payload,{objective:'按选中的第二个方向表达散步邀请',allowedApproach:'轻松组织邀请'}), args);
  for (const key of ['discussionCompaction','privateCandidates','privateConversation']) assert.equal(draft.payload[key], undefined);
  assert.equal(JSON.stringify(draft.payload).includes('PRIVATE_CACHE_SUMMARY_'), false); assert.equal(JSON.stringify(draft.payload).includes('PRIVATE_MOTIVE_'), false);
});
test('foreign or changed original cache is rejected while the complete oversized private group remains retrievable', t => {
  const { args, record } = fixture(t);
  for (const changed of [{ scope: { ...scope, peerUid: 'other' } }, { turnFingerprints: { ...record.turnFingerprints, [record.sourceTurnIds[0]]: 'stale' } },
    { sourceRevisions: Object.fromEntries(Object.keys(record.sourceRevisions).map(id => [id, 'stale'])) }])
    {const context=buildContext({ ...args, discussionCompaction: { ...record, ...changed } });assert.equal(context.payload.discussionCompaction,undefined);assert.equal(context.payload.deferredDiscussion.availability,'needs_lookup');}
});
test('covered older user bodies and topic ancestors stay folded until an explicit raw-source lookup', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const old = store.appendTurn(scope, { role: 'user', kind: 'discussion', requestId: 'old-purpose', text: '想确认周末是否方便一起散步。' + '旧私下背景。'.repeat(1500) });
  const before = store.getCompanion(scope), originalSources = store.memorySources(scope);
  assert.equal(store.applyTopicPatch(scope, { operation: 'create', objective: '确认是否方便一起散步', constraints: ['不连续追问'], purposeSourceIds: [`private:${old.id}`], intentQuote: '想确认周末是否方便一起散步。' },
    { baseRevision: before.revision, baseTopicVersion: before.topics.version, currentSourceId: `private:${old.id}`, origin: 'private_discussion', requestId: old.requestId,
      sourceIds: originalSources.map(source => source.id), sourceRevisions: Object.fromEntries(originalSources.map(source => [source.id, source.revision])) }).applied, true);
  const assistant = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '旧分析。'.repeat(1000), sourceIds: [`private:${old.id}`] });
  const correction = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '现在的纠正要保留：不连着问。' });
  store.appendTurn(scope, { role: 'assistant', kind: 'acknowledgment', text: '明白，保留这个局部纠正。' });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '那继续。' }), companion = store.getCompanion(scope), ids = [old.id, assistant.id];
  const record = { scope, id: 'older-user-cache', summary: '保留散步的目的，旧分析已整理。', sourceTurnIds: ids, ...discussionCompactionEvidence(store, scope, ids, companion),
    goalVersion: companion.goal.version, topicVersion: companion.topics.version, topicBinding: discussionTopicBinding(companion), model: settings.model,
    modelBinding: discussionModelBinding(settings.baseUrl, settings.model), promptVersion: PROMPT_VERSION, protocolVersion: DISCUSSION_COMPACTION_VERSION, quoteRefs: [] };
  const args = { scope, records: [], companion, turn, settings, availableSources: store.memorySources(scope), topicContext: store.topicView(scope),
    discussionCompaction: record, requestId: 'old-fold', byteBudget: 48000, coverage: { status: 'empty' } };
  const context = buildContext(args);
  assert.equal(context.payload.sources.some(source => source.id === `private:${old.id}`), false);
  assert.equal(context.payload.sources.find(source => source.id === `private:${correction.id}`).text, correction.text);
  assert.equal(JSON.stringify(context.payload).includes('旧私下背景。'.repeat(100)), false);
  assert.ok(context.payload.topicContext.active.foldedSourceIds.includes(`private:${old.id}`));
  assert.equal(context.manifest.discussionCompaction.sourceRevisions[`private:${old.id}`], record.sourceRevisions[`private:${old.id}`]);
  const loaded = buildContext({ ...args, sourceLookupIds: [old.id] });
  const delivered=loaded.payload.sources.find(source => source.id === `private:${old.id}`);
  assert.equal(delivered.delivery.status,'partial');assert.equal(delivered.text,old.text.slice(delivered.delivery.start,delivered.delivery.end));
  assert.equal(loaded.fullAvailableSources.find(source=>source.id===delivered.id).text,old.text);
  assert.equal(loaded.manifest.sourceDelivery.explicitLookups.find(item=>item.sourceId===delivered.id).status,'partial');
});
test('planner uses only significant recent uncovered private text, never optional QQ or distant history pressure', t => {
  const { store, args } = fixture(t);
  const plan = planDiscussionCompaction({ ...args, overflow: true }); assert.ok(plan);
  assert.ok(!plan.sourceTurnIds.includes(args.turn.id)); assert.equal(plan.sourceTurnIds.length, 2);
  for (let index = 0; index < 80; index++) { store.appendTurn(scope, { role: 'user', kind: 'discussion', text: `旧讨论${index}` }); store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '已讨论。' }); }
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '当前简短问题' });
  const options = { ...args, turn, companion: store.getCompanion(scope), availableSources: store.memorySources(scope),
    context: { manifest: { serializedTextRequestBytes: 63800, requestByteBudget: 64000 } } };
  assert.equal(planDiscussionCompaction(options), null, 'near-full optional context and 80 distant groups do not trigger compression');
});
test('compactor preserves exact original references and has one bounded format repair', async t => {
  const { args, assistant, second } = fixture(t), plan = planDiscussionCompaction({ ...args, overflow: true });
  assert.throws(() => parseDiscussionCompaction({ summary: '已有两个方向', reviewedTurnIds: plan.sourceTurnIds, quoteRefs: [{ turnId: assistant.id, role: 'assistant', text: '模型改写了候选' }] }, plan), /literal/);
  const calls = [], valid = { summary: '保留轻松邀请和不连续追问。', reviewedTurnIds: plan.sourceTurnIds,
    quoteRefs: [{ turnId: assistant.id, role: 'assistant', field: 'text', text: second }] };
  const result = await assistDiscussionCompaction(settings, plan, undefined, async (_, request) => { calls.push(JSON.parse(request.body)); return response(calls.length === 1 ? 'bad-json' : JSON.stringify(valid)); });
  assert.equal(calls.length, 2); assert.equal(result.quoteRefs[0].text, second); assert.ok(calls.every(call => Buffer.byteLength(JSON.stringify(call)) <= 64000));
  let failedCalls = 0;
  await assert.rejects(assistDiscussionCompaction(settings, plan, undefined, async () => { failedCalls++; return response('bad'); }), /原文已保留/);
  assert.equal(failedCalls, 2);
});
test('wrapped early draft preparation is repaired into a plan and still uses the restricted final stage', async t => {
  const { args, user } = fixture(t), prepared = buildContext({ ...args, purpose: 'draft_prepare', byteBudget: 48000 }), calls = [];
  const early = '先这样表达：\n```json\n' + JSON.stringify({ kind: 'draft', text: '表达', suggestions: [{ style: '自然', text: '周末一起散步吗？' }] }) + '\n```';
  assert.throws(() => parseAssistant(early, 'draft_prepare', prepared.payload), /purpose=draft_prepare.*draftPlan/);
  const planned = { draftPlan: { quotes: [authorizedInvitation(user)] } };
  const result = await assistModel(settings, prepared, undefined, async (_, request) => {
    const wrapper=JSON.parse(JSON.parse(request.body).messages[1].content),input=wrapper.originalInput||wrapper;calls.push(wrapper);
    if(calls.length===1)return response(early);
    const receipt=prepared.extraRequests.at(-1).manifest.sourceHandles,id=receipt.bindings.find(binding=>binding.sourceId===planned.draftPlan.quotes[0].sourceId).handle;
    const material=input.sources.find(source=>source.id===id),body=material.segments.map(segment=>segment.text??segment.parts.map(part=>part[1]).join('')).join('');
    const authorityRef=material.authorityChoices.originalUserStatementCandidates.find(choice=>choice.materialRef===materialRefForText(material,body)).authorityRef;
    const plan={...planned.draftPlan,quotes:[{materialRef:materialRefForText(material,planned.draftPlan.quotes[0].text),authorityRef}]};
    return response(JSON.stringify({draftPlan:withCurrentDraftControls(plan,prepared.payload)}));
  });
  assert.equal(calls.length, 2); assert.match(calls[1].task, /不能直接draft\/suggestions/); assert.equal(result.suggestions, undefined);
  const draft = buildDraftContext(prepared.resultContext || prepared, result.draftPlan, args);
  await assistModel(settings, draft, undefined, async (_, request) => { calls.push(JSON.parse(JSON.parse(request.body).messages[1].content)); return response(JSON.stringify({ kind: 'draft', text: '参考表达', suggestions: [{ style: '自然', text: '周末一起散步吗？' }] })); });
  assert.equal(calls.length, 3); assert.equal(calls[2].purpose, 'draft'); assert.equal(JSON.stringify(calls[2]).includes('PRIVATE_MOTIVE_'), false);
});
test('ordinary uncompressed second-choice requests receive the original latest structured candidates', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const user = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '想邀请她散步，给两个方向。' });
  const choices = ['周末方便一起散步吗？', '这周哪天方便一起出去走走？'];
  const assistant = store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: '两个参考表达：', sourceIds: [`private:${user.id}`], suggestions: choices.map(text => ({ style: '自然', text })) });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '用第二个，再轻松一点。' });
  const context = buildContext({ scope, records: [], companion: store.getCompanion(scope), turn, settings,
    availableSources: store.memorySources(scope), requestId: 'ordinary-second', coverage: { status: 'empty' } });
  assert.equal(context.payload.discussionCompaction, undefined);
  const candidates = context.payload.privateCandidates.filter(item => item.turnId === assistant.id);
  assert.deepEqual(candidates.map(item => item.text), choices);
  assert.deepEqual(candidates.map(item => item.index), [0, 1]);
  assert.ok(candidates.every(item => item.availability === 'full' && item.authority === 'generated_discussion_not_outbound_authorization'));
  assert.deepEqual(candidates[1].artifactRef, assistant.suggestions[1].artifactRef);
  assert.equal(parseAssistant({ lookup: { discussionTurnIds: [assistant.id] } }, 'discussion', context.payload).lookup.discussionTurnIds[0], assistant.id);
});
test('large older candidate sets stay bounded as full choices or explicit lookup references', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); const older = [];
  for (let index = 0; index < 6; index++) {
    const user = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: `过去的方向${index}` });
    older.push(store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: '参考表达', sourceIds: [`private:${user.id}`],
      suggestions: [0, 1, 2].map(choice => ({ style: '自然', text: `旧${index}候选${choice}：` + '旧'.repeat(1180) })) }));
  }
  const user = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '这次再给两个简短方向。' });
  const latest = store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: '两个短方向', sourceIds: [`private:${user.id}`], suggestions: [{ style: '自然', text: '完整短句一' }, { style: '自然', text: '完整短句二' }] });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '这次第二个。' });
  const args = { scope, records: [], companion: store.getCompanion(scope), turn, settings, availableSources: store.memorySources(scope), requestId: 'large-candidates', coverage: { status: 'empty' }, byteBudget: 9000 };
  const context = buildContext(args), candidates = context.payload.privateCandidates;
  assert.deepEqual(candidates.filter(item => item.turnId === latest.id).map(item => item.text), ['完整短句一', '完整短句二']);
  assert.ok(candidates.some(item => item.availability === 'needs_lookup'));
  for (const candidate of candidates) {
    if (candidate.availability === 'full') assert.equal(candidate.text, store.getCompanion(scope).turns.find(item => item.id === candidate.turnId).suggestions[candidate.index].text);
    else assert.equal(candidate.text, undefined, 'a reference never disguises a substring as a whole candidate');
  }
  const selected = buildContext({ ...args, sourceTurnIds: [older[0].id], byteBudget: 48000 });
  assert.equal(selected.payload.privateCandidates.find(item => item.turnId === older[0].id && item.index === 1).text, older[0].suggestions[1].text);
});
