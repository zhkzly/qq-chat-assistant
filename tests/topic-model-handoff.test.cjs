'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext, buildDraftContext } = require('../src/assistant-context.cjs');
const { parseAssistant, assistModel, SYSTEM } = require('../src/assistant-model.cjs');
const { prepareTopicPatch } = require('../src/topic-store.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const settings = { baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic', anonymous: true };

// Synthetic private turns use the persisted consumer shape, never real chat data.
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.setGoal(scope, 'PRIVATE_LONG_GOAL_希望发展双方愿意的关系');
  store.add(scope, [normalize(raw('900719925474099899', false, { elements: [{ textElement: { content: '周末应该有空。' } }] }), scope)]);
  const apply = (patch, actor) => {
    const before = store.getCompanion(scope), sources = store.memorySources(scope);
    const receipt = store.applyTopicPatch(scope, patch, { baseRevision: before.revision, baseTopicVersion: before.topics.version,
      sourceIds: sources.map(item => item.id), sourceRevisions: Object.fromEntries(sources.map(item => [item.id, item.revision])),
      currentSourceId: `private:${actor.id}`, origin: 'private_discussion', requestId: actor.requestId });
    assert.equal(receipt.applied, true, receipt.detail || receipt.reason); return receipt;
  };
  const request = store.appendTurn(scope, { role: 'user', kind: 'discussion', requestId: 'synthetic-purpose', text: 'PRIVATE_MOTIVE_我担心被拒绝，但这次想确认周末是否方便一起散步。' });
  const created = apply({ operation: 'create', objective: '确认周末是否方便一起散步', purposeSourceIds: [`private:${request.id}`], intentQuote: '这次想确认周末是否方便一起散步' }, request);
  store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '可以先提议一起散步。' });
  const correction = store.appendTurn(scope, { role: 'user', kind: 'discussion', requestId: 'synthetic-correction', text: '意思先含蓄一点，但不要像普通群发；也别绕成连续查户口。' });
  apply({ operation: 'update', topicId: created.topicId, direction: '先含蓄，但保留单独相处的意思', constraints: ['不绕成连续查户口'],
    purposeSourceIds: [`private:${correction.id}`], intentQuote: '意思先含蓄一点' }, correction);
  store.appendTurn(scope, { role: 'assistant', kind: 'acknowledgment', text: '明白：保留单独相处的意思，轻一点表达，不追加采访式问题。' });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'draft_prepare', text: '那给我具体一句。' });
  const companion = store.getCompanion(scope), records = store.messages(scope);
  const sources = store.memorySources(scope), sourceIds = [request, correction].map(item => `private:${item.id}`), topic = store.topicView(scope).active;
  const args = { scope, records, companion, turn, purpose: 'draft_prepare', requestId: 'synthetic-topic-handoff', coverage: { status: 'partial' }, settings, availableSources: sources };
  const guidance = { objective: { text: '确认周末是否方便一起散步', sourceIds: [sourceIds[0]] }, allowedApproach: { text: '含蓄地提出单独散步的意思', sourceIds: [sourceIds[1]] },
    avoidances: [{ text: '不追加连续无关问题', sourceIds: [sourceIds[1]] }], currentStep: { text: '给出一句可编辑邀请', sourceIds: [`private:${turn.id}`] } };
  return { store, args, topic, request, correction, guidance };
}

test('active purpose and complete local correction precede unrelated optional history', t => {
  const { store, args, topic, correction } = fixture(t);
  args.byteBudget = 9000;
  store.saveNote(scope, { kind: 'material', use: 'discussion', text: 'UNRELATED_HISTORY_'.repeat(150) });
  args.companion.notes = store.getCompanion(scope).notes; args.availableSources = store.memorySources(scope);
  const context = buildContext(args);
  assert.equal(context.payload.topicContext.active.id, topic.id);
  assert.equal(context.payload.topicContext.authority, 'private_direction_not_outbound_authorization');
  for (const id of topic.sourceIds) assert.ok(context.manifest.sourceIds.includes(id));
  assert.equal(context.payload.sources.find(item => item.id === `private:${correction.id}`).text, correction.text);
  assert.ok(context.payload.privateConversation.some(item => item.role === 'assistant' && /轻一点表达/.test(item.text)));
});

test('planner parser preserves grounded purpose, approach, avoidances, step and topic patch', t => {
  const { args, guidance, topic } = fixture(t), prepared = buildContext(args);
  const patch = { operation: 'update', topicId: topic.id, direction: '含蓄表达', constraints: ['不连问'], purposeSourceIds: [prepared.payload.userRequest.sourceId], intentQuote: '给我具体一句' };
  const parsed = parseAssistant({ draftPlan: { quotes: [], intent: 'reply', guidance }, topicPatch: patch }, 'draft_prepare', prepared.payload);
  assert.deepEqual(parsed.draftPlan.guidance, guidance);
  assert.deepEqual(parsed.topicPatch, patch);
});

test('vague request receives grounded local controls in the serialized final draft without private history or motive', async t => {
  const { args, request, guidance } = fixture(t), prepared = buildContext(args);
  const plan = parseAssistant({ draftPlan: { style: 'natural', authorizationQuote: '给我具体一句', quotes: [{ sourceId: `private:${request.id}`, text: '周末是否方便一起散步' }], guidance, askFollowup: false } }, 'draft_prepare', prepared.payload).draftPlan;
  const draft = buildDraftContext(prepared, plan, args); let body;
  await assistModel(settings, draft, undefined, async (_, request) => {
    body = request.body;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'draft', text: '参考表达', suggestions: [{ style: '自然', text: '周末方便的话，要不要一起出去散个步？' }] }) } }] }) };
  });
  const final = JSON.parse(JSON.parse(body).messages[1].content);
  assert.equal(final.draftingGuidance.objective.text, guidance.objective.text);
  assert.equal(final.draftingGuidance.allowedApproach.text, guidance.allowedApproach.text);
  assert.deepEqual(final.draftingGuidance.avoidances, guidance.avoidances);
  assert.equal(final.draftingGuidance.currentStep.text, guidance.currentStep.text);
  assert.equal(final.draftingGuidance.authority, 'expression_control_not_message_content');
  assert.equal(final.outboundQuotes.length, 1);
  for (const excluded of ['PRIVATE_MOTIVE_', 'PRIVATE_LONG_GOAL_', '不要像普通群发', '明白：']) assert.equal(body.includes(excluded), false, excluded);
  assert.equal(final.privateConversation, undefined); assert.equal(final.workingState, undefined); assert.equal(final.goal, undefined);
  const ids = new Set([...(final.sources || []).map(item => item.id), ...final.outboundQuotes.map(item => item.sourceId), ...[final.draftingGuidance.objective, final.draftingGuidance.allowedApproach, ...final.draftingGuidance.avoidances, final.draftingGuidance.currentStep].flatMap(item => item.sourceIds)]);
  assert.deepEqual([...new Set(draft.manifest.sourceIds)].sort(), [...ids].sort());
  assert.equal(final.presentation.askFollowup, false, 'a requested invitation question remains expressible');
});

test('guidance requires delivered user control sources and cannot cite an assistant acknowledgment or wrong scope', t => {
  const { args, guidance } = fixture(t), prepared = buildContext(args);
  for (const sourceIds of [['private:missing'], ['assistant:ack'], ['qq:900719925474099899']]) {
    assert.throws(() => parseAssistant({ draftPlan: { quotes: [], intent: 'reply', guidance: { ...guidance, objective: { text: 'invented', sourceIds } } } }, 'draft_prepare', prepared.payload), /guidance.*sourceIds/);
  }
  assert.throws(() => parseAssistant({ kind: 'draft', text: '参考', suggestions: [{ style: '自然', text: '你好' }], topicPatch: { operation: 'pause' } }, 'draft', {}), /topicPatch.*草稿/);
});

test('paused, complete, stale or foreign topics never become active drafting controls', t => {
  for (const status of ['paused', 'completed', 'cancelled']) {
    const { args } = fixture(t); args.companion.topics.items[0].lifecycle = status;
    assert.equal(buildContext(args).payload.topicContext.active, null);
  }
  const { args } = fixture(t); args.companion.topics.items[0].sourceRevisions[args.companion.topics.items[0].sourceIds[0]] = 'stale';
  assert.equal(buildContext(args).payload.topicContext.active, null);
  const foreign = fixture(t); foreign.args.companion.topics.items[0].scope = { ...scope, peerUid: 'other-contact' };
  assert.equal(buildContext(foreign.args).payload.topicContext.active, null);
});

test('current explicit direction overrides prior cautious approach and topic state is not a ladder', () => {
  assert.match(SYSTEM, /最新.*明确.*(?:优先|覆盖)|此次.*明确.*(?:优先|覆盖)/);
  assert.match(SYSTEM, /topicPatch/);
  assert.match(SYSTEM, /allowedApproach/);
  assert.match(SYSTEM, /askFollowup.*(?:不.*禁止|不.*禁用)|用户本来就想问的问题仍可表达/s);
});

test('a new explicit user direction reaches planner and final instead of restoring the earlier cautious controls', async t => {
  const { store, args, topic } = fixture(t);
  const changed = store.appendTurn(scope, { role: 'user', kind: 'draft_prepare', text: '改一下，我现在想直接说我对她有好感，想多认识她。' });
  Object.assign(args, { turn: changed, companion: store.getCompanion(scope), availableSources: store.memorySources(scope), topicContext: store.topicView(scope) });
  const prepared = buildContext(args), currentId = prepared.payload.userRequest.sourceId;
  assert.equal(prepared.payload.topicContext.active.id, topic.id, 'old topic is context, not authority over new intent');
  const calls = [], plan = await assistModel(settings, prepared, undefined, async (_, request) => {
    calls.push(JSON.parse(JSON.parse(request.body).messages[1].content));
    assert.equal(calls[0].userRequest.text, changed.text);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ draftPlan: { quotes: [{ sourceId: currentId, text: '我对她有好感，想多认识她' }],
      guidance: { objective: { text: '直接表达好感和想多认识对方', sourceIds: [currentId] }, allowedApproach: { text: '直接真诚表达，不沿用之前的含蓄方式', sourceIds: [currentId] },
        avoidances: [{ text: '不追加连续无关问题', sourceIds: topic.purposeBindings.constraints.sourceIds }] } } }) } }] }) };
  });
  const draft = buildDraftContext(prepared, plan.draftPlan, args);
  assert.equal(draft.payload.draftingGuidance.objective.text, '直接表达好感和想多认识对方');
  assert.deepEqual(draft.payload.draftingGuidance.allowedApproach.sourceIds, [currentId]);
  assert.equal(JSON.stringify(draft.payload).includes(topic.direction), false);
  assert.throws(() => buildDraftContext(prepared, plan.draftPlan, { ...args, scope: { ...scope, peerUid: 'other-contact' } }), /联系人已变化/);
});

test('canonical feedback continuation is authoritative without duplicating its body into the neutral request', t => {
  const { store, args, request, guidance } = fixture(t);
  const evaluated = store.appendTurn(scope, { role: 'assistant', kind: 'draft', requestId: 'synthetic-evaluated', text: '参考表达', sourceIds: [`private:${request.id}`],
    suggestions: [{ style: '自然', text: '周末有空一起走走吗？' }] });
  const feedback = store.addFeedback(scope, { targetRef: { kind: 'artifact', artifactRef: evaluated.suggestions[0].artifactRef }, text: '这次直接表达我的好感，给我具体一句。' });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', requestId: 'synthetic-feedback-continue', text: '结合我选中的这条反馈，继续商量并给出相应帮助。' });
  Object.assign(args, { turn, companion: store.getCompanion(scope), availableSources: store.memorySources(scope), intentSourceId: feedback.sourceId,
    feedbackTargets: [store.experiences.hydrateFeedback(scope, feedback.id)], byteBudget: 12000 });
  const prepared = buildContext(args);
  assert.equal(prepared.payload.intentAuthority.sourceId, feedback.sourceId);
  assert.equal(prepared.payload.sources.find(item => item.id === feedback.sourceId).text, feedback.text);
  assert.equal(prepared.payload.feedbackTargets[0].target.body, evaluated.suggestions[0].text);
  assert.equal(prepared.payload.userRequest.text.includes(feedback.text), false);
  const plan = parseAssistant({ draftPlan: { authorizationQuote: '给我具体一句', quotes: [{ sourceId: `private:${request.id}`, text: '周末是否方便一起散步' }],
    guidance: { objective: { text: '按本次反馈直接表达好感', sourceIds: [feedback.sourceId] }, allowedApproach: { text: '按本次反馈直接表达', sourceIds: [feedback.sourceId] },
      avoidances: guidance.avoidances } } }, 'draft_prepare', prepared.payload).draftPlan;
  const final = buildDraftContext(prepared, plan, args);
  assert.deepEqual(final.payload.draftingGuidance.allowedApproach.sourceIds, [feedback.sourceId]);
  assert.equal(final.payload.feedbackTargets, undefined); assert.equal(final.payload.userRequest, undefined);
  assert.ok(final.manifest.sourceIds.includes(feedback.sourceId));
});

test('bounded plain drafting repair retains guidance provenance and chosen image sources', async t => {
  const { store, args, request, guidance } = fixture(t);
  const more = Array.from({ length: 100 }, (_, index) => normalize(raw(String(900719925474200000n + BigInt(index)), index % 2 === 1,
    { msgTime: String(1791792000 + index), elements: [{ textElement: { content: `合成历史${index}：${'普通背景，不代表新的表达目的。'.repeat(20)}` } }] }), scope));
  store.add(scope, more);
  const imageId = args.records[0].messageId;
  Object.assign(args, { records: store.messages(scope), availableSources: store.memorySources(scope), imageMessageIds: [imageId] });
  const prepared = buildContext(args);
  const plan = { quotes: [{ sourceId: `private:${request.id}`, text: '周末是否方便一起散步' }], authorizationQuote: '给我具体一句', guidance };
  const draft = buildDraftContext(prepared, plan, args);
  const images = [{ messageId: imageId, url: 'data:image/png;base64,iVBORw0KGgo=', bytes: 8, index: 0 }];
  draft.images = images; draft.manifest.images = images.map(({ url, ...metadata }) => metadata);
  const calls = [], invalid = 'INVALID_' + '原响应需要完整修复。'.repeat(1200);
  const result = await assistModel(settings, draft, undefined, async (_, request) => {
    calls.push(request.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: calls.length === 1 ? invalid : '周末有空一起散步吗？' } }] }) };
  });
  assert.equal(calls.length, 2); assert.ok(calls.every(body => Buffer.byteLength(body) < 64000 + JSON.stringify(images).length));
  assert.equal(result.suggestions[0].text, '周末有空一起散步吗？');
  const repaired = draft.resultContext || draft;
  // The smaller plain recovery envelope no longer includes the invalid output;
  // reassembly is unnecessary when the validated final input already fits.
  assert.deepEqual(repaired.payload.draftingGuidance, draft.payload.draftingGuidance);
  assert.deepEqual(repaired.images, images);
  assert.ok(repaired.payload.sources.some(item => item.id === `qq:${imageId}`));
  for (const id of Object.values(guidance).flatMap(item => Array.isArray(item) ? item.flatMap(control => control.sourceIds) : item.sourceIds)) {
    assert.ok(repaired.manifest.sourceIds.includes(id)); assert.ok(draft.extraRequests[0].manifest.sourceIds.includes(id));
    assert.equal(repaired.manifest.sourceRevisions[id], prepared.manifest.sourceRevisions[id]);
  }
  assert.equal(draft.extraRequests[0].manifest.imageCount, 1); assert.deepEqual(draft.extraRequests[0].manifest.images, draft.manifest.images);
  const recoveryRequest = JSON.parse(calls[1]), recoveryPayload = JSON.parse(recoveryRequest.messages[1].content[0].text);
  assert.equal(recoveryPayload.invalidResponse, undefined); assert.deepEqual(recoveryPayload.originalInput.draftingGuidance, draft.payload.draftingGuidance);
  assert.equal(recoveryRequest.messages[1].content[1].image_url.url, images[0].url);
  recoveryRequest.messages[1].content = JSON.stringify(recoveryPayload);
  assert.equal(draft.extraRequests[0].inputBytes, Buffer.byteLength(JSON.stringify(recoveryRequest)));
  for (const forbidden of ['PRIVATE_MOTIVE_', 'PRIVATE_LONG_GOAL_']) assert.ok(calls.every(body => !body.includes(forbidden)));
});

test('parser rejects closed-topic updates and active-topic resumes before a terminal Store rejection', t => {
  const { args, topic } = fixture(t), prepared = buildContext(args), currentId = prepared.payload.userRequest.sourceId;
  for (const lifecycle of ['paused','completed','cancelled']) {
    const payload = { ...prepared.payload, topicContext: { ...prepared.payload.topicContext, active: null, activeId: null,
      retained: [{ ...prepared.payload.topicContext.active, lifecycle }] } };
    for (const operation of ['update','pause','complete','cancel']) assert.throws(() => parseAssistant({ kind: 'discussion', text: '继续帮助',
      topicPatch: { operation, topicId: topic.id, direction: '新方向', purposeSourceIds: [currentId], intentQuote: prepared.payload.userRequest.text } }, 'discussion', payload), /topicPatch.*(?:lifecycle|closed|active)/);
  }
  assert.throws(() => parseAssistant({ kind: 'discussion', text: '继续帮助', topicPatch: { operation: 'resume', topicId: topic.id,
    purposeSourceIds: [currentId], intentQuote: prepared.payload.userRequest.text } }, 'discussion', prepared.payload), /topicPatch.*(?:lifecycle|active)/);
});

test('QQ-only completion requires an actual transient observation origin and its current QQ source', t => {
  const { args, topic } = fixture(t), prepared = buildContext(args), qqId = `qq:${args.records[0].messageId}`;
  const output = { kind: 'review', text: '这次安排已确认', topicPatch: { operation: 'complete', topicId: topic.id, observationSourceIds: [qqId] } };
  assert.throws(() => parseAssistant(output, 'review', { ...prepared.payload, generationOrigin: 'user', currentObservationSourceId: qqId }), /topicPatch.*(?:purposeSourceIds|intentQuote)/);
  const transient = { id: 'request:observation', type: 'request', role: 'user', text: '结合最新来信帮我看看', revision: 'synthetic' };
  const automatic = { ...prepared.payload, generationOrigin: 'qq_observation', currentObservationSourceId: qqId,
    userRequest: { sourceId: transient.id, text: transient.text }, intentAuthority: { sourceId: transient.id }, sources: [...prepared.payload.sources, transient] };
  assert.equal(parseAssistant(output, 'reply', automatic).topicPatch.operation, 'complete');
  assert.throws(() => parseAssistant(output, 'reply', { ...automatic, currentObservationSourceId: 'qq:missing' }), /topicPatch.*(?:purposeSourceIds|intentQuote)/);
});

test('old working-state navigation cannot evict the latest complete private correction and acknowledgment', t => {
  const { args, correction } = fixture(t);
  args.byteBudget = 13000;
  args.companion.state.items = Array.from({ length: 16 }, () => ({ text: 'UNRELATED_SUMMARY_' + 'past unrelated topic '.repeat(30), sourceIds: [args.companion.topics.items[0].sourceIds[0]] }));
  const context = buildContext(args);
  assert.ok(context.payload.privateConversation.some(item => item.sourceId === `private:${correction.id}`));
  assert.ok(context.payload.privateConversation.some(item => item.role === 'assistant' && /轻一点表达/.test(item.text)));
  assert.ok(context.payload.omittedStateEntries > 0);
  assert.ok(context.payload.workingState.items.length < 16);
});

test('an oversized latest private exchange fails explicitly instead of silently keeping old summaries', t => {
  const { store, args } = fixture(t);
  store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '完整的最新讨论'.repeat(4000) });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '接着刚才的意思。' });
  Object.assign(args, { turn, companion: store.getCompanion(scope), availableSources: store.memorySources(scope), byteBudget: 9000 });
  assert.throws(() => buildContext(args), /最近完整私下讨论.*预算.*没有静默截断/);
});

test('recorded LIVE new-topic shape accepts current private task phase without invented observation evidence', t => {
  const { store, args } = fixture(t);
  // Derived verbatim from the failed synthetic LIVE new-topic response. Only
  // transient source IDs are rebound to this isolated consumer fixture.
  const text = '换个话题。我想关心她考试后累不累，先不问成绩。只帮我商量这次的方向。';
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', requestId: 'recorded-new-topic', text });
  const sources = store.memorySources(scope), companion = store.getCompanion(scope);
  const context = buildContext({ ...args, turn, companion, availableSources: sources, generationOrigin: 'private_discussion', requestId: turn.requestId });
  const output = { kind: 'discussion', text: '这次先商量自然关心考后状态的方向。', topicPatch: { operation: 'create', objective: '关心她考试后累不累，暂不问成绩。',
    direction: '轻松询问考后状态，根据她实际回应接续，不预设她疲惫或考试不顺。', stage: '商量本次关心的方向。', intentQuote: text,
    constraints: ['这次只商量方向，不生成可发送草稿。', '暂不主动询问成绩。'], progress: [], unknowns: ['她考试后的实际状态尚不清楚。'],
    purposeSourceIds: [`private:${turn.id}`], observationSourceIds: [], interpretationStatus: 'user_stated' } };
  const parsed = parseAssistant(output, 'discussion', context.payload);
  const prepared = prepareTopicPatch(companion, sources, parsed.topicPatch, { sourceIds: context.manifest.sourceIds, sourceRevisions: context.manifest.sourceRevisions,
    currentSourceId: `private:${turn.id}`, origin: 'private_discussion', requestId: turn.requestId });
  assert.equal(prepared.changes, 1);
  const topic = prepared.topics.items.find(item => item.id === prepared.topicId);
  assert.equal(topic.observationAuthorities.stage, 'private_task_state');
  assert.equal(topic.observationAuthorities.unknowns, 'private_task_state');
});

test('unsupported external progress reaches the existing bounded format repair instead of a late Store rejection', async t => {
  const { args, topic } = fixture(t), context = buildContext(args), currentId = context.payload.userRequest.sourceId;
  const invalid = { kind: 'discussion', text: '继续商量', topicPatch: { operation: 'update', topicId: topic.id, direction: '当前方式',
    purposeSourceIds: [currentId], intentQuote: context.payload.userRequest.text, progress: ['已给她发出了邀请'], observationSourceIds: [] } };
  assert.throws(() => parseAssistant(invalid, 'discussion', context.payload), /topicPatch.observationSourceIds.*progress/);
  const calls = [], result = await assistModel(settings, context, undefined, async (_, request) => {
    calls.push(JSON.parse(JSON.parse(request.body).messages[1].content));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(calls.length === 1 ? invalid : { kind: 'discussion', text: '当前只是在准备表达，尚未观察到发送。' }) } }] }) };
  });
  assert.equal(calls.length, 2); assert.match(calls[1].formatError, /topicPatch.observationSourceIds.*progress/);
  assert.equal(result.topicPatch, undefined);
});

test('a current private draft task can refresh its phase without changing objective or recording an actual send', t => {
  const { store, args, topic, guidance } = fixture(t);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', requestId: 'stage-only-request', text: '现在按这个方向给一句。' });
  const sources = store.memorySources(scope), companion = store.getCompanion(scope), currentId = `private:${turn.id}`;
  const context = buildContext({ ...args, turn, companion, availableSources: sources, requestId: turn.requestId });
  const output = { draftPlan: { quotes: [], intent: 'reply', guidance: { ...guidance, currentStep: { text: '提供一句待用户选择的参考表达', sourceIds: [currentId] } } },
    topicPatch: { operation: 'update', topicId: topic.id, stage: '参考表达待用户选择，尚未观察实际QQ发送', purposeSourceIds: [currentId], intentQuote: turn.text } };
  const parsed = parseAssistant(output, 'discussion', context.payload);
  const prepared = prepareTopicPatch(companion, sources, parsed.topicPatch, { sourceIds: context.manifest.sourceIds, sourceRevisions: context.manifest.sourceRevisions,
    currentSourceId: currentId, origin: 'private_discussion', requestId: turn.requestId });
  const updated = prepared.topics.items.find(item => item.id === topic.id);
  assert.equal(updated.objective, topic.objective); assert.equal(updated.direction, topic.direction);
  assert.equal(updated.stage, output.topicPatch.stage); assert.equal(updated.observationAuthorities.stage, 'private_task_state');
  assert.equal(updated.progress.length, 0); assert.equal(store.messages(scope).some(item => item.direction === 'outgoing'), false);
});

test('an active topic rejects legacy or empty guidance plans that would drop the direction again', t => {
  const { args } = fixture(t), prepared = buildContext(args);
  for (const guidance of [undefined, {}]) {
    assert.throws(() => parseAssistant({ draftPlan: { quotes: [], intent: 'reply', style: 'natural', ...(guidance ? { guidance } : {}) } },
      'draft_prepare', prepared.payload), /draftPlan.guidance.*(?:objective|allowedApproach|avoidances)/);
  }
});

test('effective topic fields require guidance while explicitly removed restrictions and closed topics do not', t => {
  const { args, topic, guidance } = fixture(t), prepared = buildContext(args), currentId = prepared.payload.userRequest.sourceId;
  const patch = { operation: 'update', topicId: topic.id, direction: '', constraints: [], purposeSourceIds: [currentId], intentQuote: prepared.payload.userRequest.text };
  const output = { topicPatch: patch, draftPlan: { quotes: [], intent: 'reply', guidance: { objective: guidance.objective } } };
  assert.deepEqual(parseAssistant(output, 'draft_prepare', prepared.payload).draftPlan.guidance, { objective: guidance.objective });
  const created = { operation: 'create', objective: '此轮确认是否方便见面', direction: '直接确认', constraints: ['不追加无关问题'], purposeSourceIds: [currentId], intentQuote: prepared.payload.userRequest.text };
  assert.throws(() => parseAssistant({ topicPatch: created, draftPlan: { quotes: [], intent: 'reply' } }, 'draft_prepare',
    { ...prepared.payload, topicContext: { active: null, retained: [] } }), /draftPlan.guidance/);
  const closed = { operation: 'complete', topicId: topic.id, purposeSourceIds: [currentId], intentQuote: prepared.payload.userRequest.text };
  assert.equal(parseAssistant({ topicPatch: closed, draftPlan: { quotes: [], intent: 'reply' } }, 'draft_prepare', prepared.payload).draftPlan.intent, 'reply');
  assert.equal(parseAssistant({ draftPlan: { quotes: [{ sourceId: currentId, text: '给我具体一句' }] } }, 'draft_prepare',
    { ...prepared.payload, topicContext: { active: null, retained: [] } }).draftPlan.quotes.length, 1);
});

test('legacy active-topic draft preparation is repaired once into source-bound guidance before restricted drafting', async t => {
  const { args, guidance } = fixture(t), prepared = buildContext({ ...args, purpose: 'draft_prepare' }), calls = [];
  const result = await assistModel(settings, prepared, undefined, async (_, request) => {
    calls.push(JSON.parse(JSON.parse(request.body).messages[1].content));
    const draftPlan = calls.length === 1 ? { intent: 'reply', quotes: [], style: 'natural' } : { intent: 'reply', quotes: [], style: 'natural', guidance };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ draftPlan }) } }] }) };
  });
  assert.equal(calls.length, 2); assert.match(calls[1].formatError, /draftPlan.guidance/);
  const effective = prepared.resultContext || prepared, draft = buildDraftContext(effective, result.draftPlan, args);
  assert.equal(draft.payload.draftingGuidance.objective.text, guidance.objective.text);
  assert.equal(draft.payload.draftingGuidance.allowedApproach.text, guidance.allowedApproach.text);
  assert.deepEqual(draft.payload.draftingGuidance.avoidances, guidance.avoidances);
  for (const privateText of ['PRIVATE_MOTIVE_', 'PRIVATE_LONG_GOAL_']) assert.equal(JSON.stringify(draft.payload).includes(privateText), false);
});
