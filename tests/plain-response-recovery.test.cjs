'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Synthetic source-shaped regressions. The original failing proxy response was
// not retained; these fixtures reproduce its observed validation boundary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { buildContext, buildDraftContext, PROMPT_VERSION } = require('../src/assistant-context.cjs');
const { assistModel, parseAssistant, canonicalSourceView } = require('./fixtures/assistant-protocol.cjs');
const { TaskLedger } = require('../src/request-budget.cjs');
const {projectComposerEvidence}=require('../src/context/composer-evidence.cjs');
const { Controller } = require('./fixtures/assistant-protocol.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

const settings = { model: 'claude-sonnet-4-6', baseUrl: 'http://synthetic.invalid/v1', anonymous: true };
const response = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const resultTool = value => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'tool_calls', message: {
  content: null, tool_calls: [{ function: { name: 'assistant_result', arguments: JSON.stringify(value) } }]
} }] }) });
const requestPayload = body => typeof body.messages[1].content === 'string'
  ? JSON.parse(body.messages[1].content) : JSON.parse(body.messages[1].content[0].text);
const badOptionalTopic = { kind: 'discussion', text: 'FIRST_INVALID_DO_NOT_REUSE',
  topicPatch: { operation: 'update', authority: 'MODEL_CANNOT_ASSIGN_AUTHORITY' },
  stateReview: 'no_change', methodIds: [] };
// Optional metadata alone now preserves valid foreground help. These recovery
// cases need an unusable ordinary branch, not merely a rejected auxiliary.
const badOrdinaryHelp = { ...badOptionalTopic, kind: 'unsupported_kind' };
function walkingControls(sourceId) {
  const control=text=>({text,sourceIds:[sourceId]});
  return {objective:control('邀请一起散步'),allowedApproach:control('按本次明确意思直接邀请'),avoidances:[]};
}

function fixture(t, purpose = 'discussion') {
  const store = new Store(':memory:'); t.after(() => store.close());
  const records = [normalize(raw('72057594037927939', false, {
    elements: [{ elementType: 1, textElement: { content: '从对战换成了解谜，昨天刚玩了一会。' } }]
  }), scope)];
  store.add(scope, records); store.setGoal(scope, 'PRIVATE_GOAL_SENTINEL_希望发展双方愿意的关系');
  const prior = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'PRIVATE_MOTIVE_SENTINEL_有些担心。原来先含蓄接话，不直接邀约。' });
  store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '可以保留游戏反差，先轻松接话。', sourceIds: [`private:${prior.id}`] });
  const turn = store.appendTurn(scope, { role: 'user', kind: purpose, text: '现在改成直接邀请一起散步，怎么继续？' });
  const args = { scope, records, companion: store.getCompanion(scope), turn, purpose, settings,
    availableSources: store.memorySources(scope), requestId: `plain-${purpose}`, coverage: { status: 'complete' } };
  return { store, args, context: buildContext(args), prior, turn };
}

test('valid foreground help with rejected auxiliary metadata uses one primary without an automatic check while preserving pending intent', async t => {
  const { store, args } = fixture(t), calls = [], text = '按最新意思直接讨论邀请，保留实际交流中的未知。';
  const configured = { ...settings, auto: false, realChatConsent: { accountUid: scope.accountUid,
    peerUin: scope.peerUin, baseUrl: settings.baseUrl, model: settings.model } };
  const controller = new Controller({ store, settings: configured, memoryModel: null, compactionModel: null,
    read: async name => name === 'bind' ? scope : { messages: [] },
    assistantModel: (modelSettings, input, signal) => assistModel(modelSettings, input, signal, async (_url, request) => {
      calls.push(JSON.parse(request.body));const p=requestPayload(calls.at(-1));return p.purpose==='fidelity_check'?response(JSON.stringify({checkRef:p.checkRef,auditProtocol:'sparse-defects-v1',issues:[]})):resultTool({ ...badOptionalTopic, text });
    }) });
  t.after(() => controller.close());
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  await controller.bind(scope.peerUin);
  const before = store.getCompanion(scope), answer = await controller.assist({
    text: '我现在明确想直接邀请，先帮我商量。', taskId: 'retained-foreground-with-pending-metadata' });
  assert.equal(calls.length, 1); assert.equal(answer.text, text); assert.equal(answer.responseRecovery, undefined);
  assert.equal(answer.privateReviewReceipt, undefined); assert.equal(answer.suggestions, undefined);
  assert.equal(answer.metadataReviewPending.reasonCode, 'auxiliary_metadata_rejected');
  const after = store.getCompanion(scope), run = after.runs.find(item => item.id === answer.requestId);
  assert.equal(after.state.version, before.state.version); assert.equal(after.topics.items.length, before.topics.items.length);
  assert.equal(run.status, 'complete'); assert.equal(run.maintenance, 'partial_rejected'); assert.equal(run.requests.length, 1);
  assert.equal(run.auxiliaryErrors.length, 1); assert.equal(run.auxiliaryErrors[0].field, 'topicPatch');
  assert.equal(run.privateReviewReceipt, undefined); assert.equal(run.patchReceipt, null); assert.equal(run.topicReceipt, null);
  assert.equal(JSON.stringify(run).includes('MODEL_CANNOT_ASSIGN_AUTHORITY'), false, 'rejected model metadata is not retained');
  const pendingId = answer.metadataReviewPending.sourceIds[0], source = store.memorySources(scope).find(item => item.id === pendingId);
  assert.equal(answer.metadataReviewPending.sourceRevisions[pendingId], source.revision);
  const next = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '那继续按这个方向商量。' });
  const rebuilt = buildContext({ ...args, turn: next, companion: store.getCompanion(scope),
    availableSources: store.memorySources(scope), requestId: 'after-retained-help' });
  assert.ok(rebuilt.payload.pendingPrivateReview.sourceIds.includes(pendingId));
  assert.equal(rebuilt.payload.sources.find(item => item.id === pendingId).text, source.text);
});

for (const purpose of ['discussion', 'review']) test(`${purpose} repairs unusable primary output with a structured current-request interpretation`, async t => {
  const { context, turn } = fixture(t, purpose), calls = [], fresh = '按你现在的意思直接邀请：可以先确认她这周是否方便出去走走。';
  assert.throws(() => parseAssistant(badOrdinaryHelp, purpose, context.payload), /当前用途.*文字/);
  const result = await assistModel(settings, context, undefined, async (_url, request) => {
    calls.push(JSON.parse(request.body)); return calls.length === 1 ? resultTool(badOrdinaryHelp) : response(JSON.stringify({kind:purpose,text:fresh}));
  });
  assert.equal(calls.length, 2); assert.equal(result.kind,'discussion'); assert.equal(result.text, fresh);
  assert.deepEqual(Object.keys(result).sort(), ['kind', 'requestDelivery', 'text']);
  const repair = requestPayload(calls[1]);
  assert.equal(repair.purpose, purpose); assert.deepEqual(canonicalSourceView(repair.originalInput,context.extraRequests[0].manifest.sourceHandles,context.resultContext?.payload||context.payload),context.payload);
  const changed=structuredClone(repair.originalInput);changed.taskContext.recentHumanContext[0].text='A substituted prior human statement.';
  assert.notDeepEqual(canonicalSourceView(changed,context.extraRequests[0].manifest.sourceHandles,context.resultContext?.payload||context.payload),context.payload,'normalization must not hide a changed original human body');
  assert.equal(repair.originalInput.userRequest.text, turn.text);
  assert.equal(typeof repair.invalidResponse,'string');assert.equal(typeof repair.formatError,'string');assert.match(repair.task,/operation/);assert.doesNotMatch(repair.task,/requestDelivery为核心|private_help|editable_message/);
  assert.equal(calls[1].tool_choice.function.name,'assistant_result');assert.equal(calls[1].response_format,undefined);
  assert.equal(context.manifest.responseRecovery,undefined);assert.equal(context.manifest.formatRepair.deliveryContract,true);assert.equal(result.requestDelivery.sourceId,`private:${turn.id}`);
  assert.equal(context.extraRequests.length, 1); assert.equal(context.extraRequests[0].manifest.methodTrace.reported, null);
});

test('structured help repair retains explicitly selected image evidence and source identity', async t => {
  const { context, args } = fixture(t), calls = [], messageId = args.records[0].messageId;
  context.images = [{ messageId, index: 0, bytes: 24, url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }];
  context.manifest.images = context.images.map(({ url, ...metadata }) => metadata);
  await assistModel(settings, context, undefined, async (_url, request) => {
    calls.push(JSON.parse(request.body)); return calls.length === 1 ? resultTool(badOrdinaryHelp) : response(JSON.stringify({kind:'discussion',text:'按你选中的图和她实际说的解谜游戏接话，先保留看不到的细节。'}));
  });
  assert.equal(calls.length, 2); assert.equal(calls[1].messages[1].content[1]?.image_url.url, context.images[0].url);
  const canonicalRepair=canonicalSourceView(requestPayload(calls[1]).originalInput,context.extraRequests[0].manifest.sourceHandles);
  assert.equal(canonicalRepair.sources.find(source => source.messageId === messageId).text, args.records[0].text);
  assert.equal(context.extraRequests[0].manifest.imageCount, 1);
  assert.deepEqual(context.extraRequests[0].manifest.images, context.manifest.images);
});

test('restricted final draft repairs the whole typed reply using only its validated payload', async t => {
  const { args, context, turn } = fixture(t), quote = '直接邀请一起散步';
  const draft = buildDraftContext(context, { quotes: [{ sourceId: `private:${turn.id}`, text: quote }],
    guidance: { ...walkingControls(`private:${turn.id}`),currentStep: { text: '按本次明确意思邀请一起散步', sourceIds: [`private:${turn.id}`] } } }, args), calls = [];
  const canonicalBefore=structuredClone(draft.payload);
  const result = await assistModel(settings, draft, undefined, async (_url, request) => {
    calls.push(JSON.parse(request.body)); return response(calls.length === 1 ? '{bad final json' : JSON.stringify({kind:'draft',text:'这周有空一起出去走走吗？'}));
  });
  assert.equal(calls.length, 2); assert.equal(result.kind, 'draft'); assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].text, '这周有空一起出去走走吗？');
  assert.deepEqual(Object.keys(result).sort(), ['kind', 'suggestions', 'text']);
  const repair = requestPayload(calls[1]); assert.equal(repair.purpose, 'draft'); assert.deepEqual(canonicalSourceView(repair.originalInput,draft.extraRequests[0].manifest.sourceHandles,draft.payload),projectComposerEvidence(draft.payload));
  assert.deepEqual(draft.payload,canonicalBefore,'wire projection cannot replace canonical repair evidence');
  assert.deepEqual(draft.extraRequests[0].payload.originalInput,canonicalBefore,'the captured repair keeps full canonical provenance');
  for(const quote of draft.payload.outboundQuotes){assert.equal(quote.provenance.version,1);assert.equal(quote.provenance.source.sourceId,quote.sourceId);assert.equal(quote.provenance.source.revision,draft.manifest.sourceRevisions[quote.sourceId]);}
  for (const forbidden of ['PRIVATE_GOAL_SENTINEL', 'PRIVATE_MOTIVE_SENTINEL', 'pendingPrivateReview', 'privateConversation', 'discussionCompaction'])
    assert.equal(JSON.stringify(calls).includes(forbidden), false, `${forbidden} must never enter final transport`);
  assert.equal(draft.manifest.responseRecovery,undefined);assert.equal(draft.manifest.preparedResponse.privateExplanation,'absent');
  assert.equal(calls[1].response_format, undefined); assert.equal(calls[1].tool_choice.function.name,'draft_result');
});

test('normal draft_prepare requires a complete structured answer after its shared repair', async t => {
  const purpose = 'draft_prepare';
  const { context, turn } = fixture(t, purpose), control = text => ({ text, sourceIds: [`private:${turn.id}`] });
  context.payload.topicContext.active = { id: 'active-topic', lifecycle: 'active', objective: '一起散步', direction: '直接邀请', constraints: ['不编造共同经历'] };
  const valid = { answer:{suggestions:[{text:'这周有空一起出去走走吗？'}]},draftPlan: { quotes: [], intent: 'reply', guidance: { objective: control('邀请一起散步'), allowedApproach: control('直接邀请'), avoidances: [control('不编造共同经历')] } } };
  const calls = [], result = await assistModel(settings, context, undefined, async (_url, request) => {
    calls.push(JSON.parse(request.body)); return calls.length === 1 ? resultTool({ draftPlan: '<parameter name="_">true' }) : response(JSON.stringify(valid));
  });
  assert.equal(calls.length, 2); assert.equal(result.kind,'draft');assert.equal(result.draftPlan,undefined);assert.deepEqual(result.suggestions.map(item=>item.text),valid.answer.suggestions.map(item=>item.text));
  assert.equal(requestPayload(calls[1]).purpose, purpose);assert.equal(calls[1].tool_choice.function.name,'assistant_result');assert.equal(calls[1].response_format,undefined);assert.equal(context.manifest.formatRepair.deliveryContract,true);
  assert.equal(context.manifest.responseRecovery, undefined);
  let failedCalls = 0;
  await assert.rejects(assistModel(settings, { payload: context.payload, manifest: {} }, undefined, async () => {
    failedCalls++; return failedCalls === 1 ? resultTool({ draftPlan: 'broken' }) : response('这周有空一起出去走走吗？');
  }), /未能返回可用的结构化结果/);
  assert.equal(failedCalls, 2);
  assert.throws(() => parseAssistant({ draftPlan: { quotes: [], intent: 'reply' } }, purpose, context.payload), /draftPlan.guidance.*(?:objective|allowedApproach|avoidances)/);
});

test('reply invalid carriers get one repair while complete answers retain isolated legacy projection coverage', async t => {
  const { args, context, turn } = fixture(t, 'reply'), control = text => ({ text, sourceIds: [`private:${turn.id}`] });
  context.payload.topicContext.active = { id: 'reply-topic', lifecycle: 'active', objective: '一起散步', direction: '直接邀请', constraints: ['不编造共同经历'] };
  const calls = [], help = await assistModel(settings, context, undefined, async (_url, request) => {
    calls.push(JSON.parse(request.body)); return calls.length === 1 ? resultTool({ draftPlan: { quotes: [], intent: 'reply' } }) :
      response(JSON.stringify({kind:'question',text:'你这周有空一起散步吗？',draftPlan:{clarification:'你这周有空一起散步吗？'}}));
  });
  assert.equal(calls.length, 2); assert.equal(help.kind, 'question'); assert.deepEqual(Object.keys(help).sort(), ['deliveryBlocker','kind','replyDisposition','requestDelivery','text']);
  assert.equal(requestPayload(calls[1]).purpose, 'reply');assert.equal(calls[1].tool_choice.function.name,'assistant_result');assert.equal(calls[1].response_format,undefined);
  assert.equal(help.deliveryBlocker.question,'你这周有空一起散步吗？');assert.equal(help.text,help.deliveryBlocker.question);assert.equal(help.draftPlan,undefined); assert.equal(help.suggestions, undefined); assert.equal(context.manifest.responseRecovery, undefined);
  assert.equal(context.manifest.formatRepair.deliveryContract, true); assert.equal(context.extraRequests[0].purpose, 'delivery_repair');
  const prepared = buildContext(args), valid = { answer:{suggestions:[{text:'这周有空一起出去走走吗？'}]},draftPlan: { quotes: [], intent: 'reply', guidance: { objective: control('邀请一起散步'),
    allowedApproach: control('直接邀请'), avoidances: [control('不编造共同经历')] } } };
  prepared.payload.topicContext.active = context.payload.topicContext.active;
  let count = 0;
  const planned = await assistModel(settings, prepared, undefined, async () => { count++; return resultTool(valid); });
  assert.equal(count, 1); assert.equal(planned.kind,'draft');assert.equal(planned.draftPlan,undefined);assert.deepEqual(planned.suggestions.map(item=>item.text),valid.answer.suggestions.map(item=>item.text)); assert.equal(prepared.manifest.responseRecovery, undefined);
  const final = buildDraftContext(prepared, valid.draftPlan, args);
  assert.equal(final.payload.purpose, 'draft'); assert.equal(final.payload.draftingGuidance.objective.text, '邀请一起散步');
  assert.equal(final.payload.privateConversation, undefined); assert.equal(JSON.stringify(final.payload).includes('PRIVATE_MOTIVE_SENTINEL'), false);
});

test('invalid structured help receives no second recovery, and each call remains in the original task budget', async t => {
  const { store, context } = fixture(t), ledger = new TaskLedger(store);
  for (const [index, invalid] of ['', 'x'.repeat(6001), '{"actions":[{"type":"set_goal","text":"model claim"}]}', '<parameter name="topicPatch">bad</parameter>'].entries()) {
    const task = ledger.create(scope, { id: `bounded-plain-${index}`, inputDigest: `shape-${index}`, limit: 2 }), calls = [];
    await assert.rejects(assistModel({ ...settings, requestBudget: task.forStage('assistant') }, { payload: context.payload, manifest: {} }, undefined, async (_url, request) => {
      calls.push(request.body); return calls.length === 1 ? resultTool(badOrdinaryHelp) : response(invalid);
    }), /结构化结果|空文字/);
    assert.equal(calls.length, 2); assert.equal(task.snapshot().attempts, 2);
    assert.equal(task.snapshot().requests[1].purpose, 'delivery_repair');
  }
});

test('structured core and final whole-response repair reject malformed, truncated and untyped multi-paragraph output', async t => {
  const { args, context, turn } = fixture(t);
  const draft = buildDraftContext(context, { quotes: [{ sourceId: `private:${turn.id}`, text: '直接邀请一起散步' }],guidance:walkingControls(`private:${turn.id}`) }, args);
  for (const [input, second] of [[context, response('以下是结果：\n{"actions":[]}')],
    [draft, response('第一句。\n第二句说明。')], [draft, response('x'.repeat(1201))],
    [context, { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '这是被截断的普通帮助' } }] }) }]]) {
    let calls = 0;
    await assert.rejects(assistModel(settings, input, undefined, async () => ++calls === 1 ? response('{broken') : second), /结构化结果|分段说明|自然文字|截断/);
    assert.equal(calls, 2);
  }
});

function pendingFixture(t, count = 1) {
  const { store, args, turn } = fixture(t), pending = [];
  // Program-owned metadata injected in a source-shaped companion until Store's
  // producer is wired; it is not supplied by the model response.
  const companion = structuredClone(args.companion); companion.turns = companion.turns.filter(item => item.id !== turn.id);
  const sources = args.availableSources.filter(item => item.id !== `private:${turn.id}`);
  for (let index = 0; index < count; index++) {
    const id = `pending-user-${index}`, sourceId = `private:${id}`, text = `未完成核对的明确纠正${index}：这轮要直接邀请。`;
    companion.turns.push({ id, role: 'user', kind: 'discussion', text, createdAt: new Date(1791750000000 + index * 1000).toISOString() });
    companion.turns.push({ id: `recovered-${index}`, role: 'assistant', kind: 'discussion', text: '本次只提供建议。',
      responseRecovery: { kind: 'private_help', reasonCode: 'structured_output_invalid', metadataApplied: false, intentSourceIds: [sourceId],
        intentSourceRevisions: { [sourceId]: `revision-${index}` } } });
    sources.push({ id: sourceId, type: 'private', role: 'user', text, revision: `revision-${index}` }); pending.push(sourceId);
  }
  companion.turns.push(turn); return { store, args: { ...args, companion, availableSources: [...sources, args.availableSources.find(item => item.id === `private:${turn.id}`)] }, pending };
}

test('unresolved recovery intent survives old topic and recent-group eviction as exact protected sources', t => {
  const { args, pending } = pendingFixture(t, 10), context = buildContext(args);
  assert.equal(context.payload.pendingPrivateReview.authority, 'unreviewed_private_intent_not_external_fact');
  assert.deepEqual(context.payload.pendingPrivateReview.sourceIds, pending.slice(-8));
  assert.equal(context.payload.pendingPrivateReview.omittedCount, 2);
  assert.deepEqual(context.payload.pendingPrivateReview.protectedSourceIds, pending.slice(-3));
  for (const id of pending.slice(-3)) {
    assert.equal(context.payload.sources.find(source => source.id === id).text, args.availableSources.find(source => source.id === id).text);
    assert.ok(context.essentialSourceIds.includes(id));
  }
  assert.deepEqual(parseAssistant({ lookup: { discussionTurnIds: ['pending-user-2'] } }, 'discussion', context.payload).lookup.discussionTurnIds, ['pending-user-2']);
  assert.throws(() => parseAssistant({ lookup: { discussionTurnIds: ['pending-user-0'] } }, 'discussion', context.payload), /discussionTurnIds/);
  assert.equal(context.payload.promptVersion, PROMPT_VERSION);
});

test('only later applied source-covered review receipts resolve a pending intent', t => {
  const { args, pending } = pendingFixture(t), id = pending[0];
  const responseTurn = { id: 'valid-later-review', role: 'assistant', kind: 'discussion', text: '现在按直接邀请继续。' };
  args.companion.turns.splice(-1, 0, responseTurn);
  const valid = { applied: true, sourceIds: [id], sourceRevisions: { [id]: args.availableSources.find(source => source.id === id).revision } };
  for (const invalid of [{ applied: false, sourceIds: [id] }, { applied: true, sourceIds: ['private:other'] }]) {
    responseTurn.privateReviewReceipt = invalid; assert.ok(buildContext(args).payload.pendingPrivateReview.sourceIds.includes(id));
  }
  responseTurn.privateReviewReceipt = valid; assert.equal(buildContext(args).payload.pendingPrivateReview, undefined);
  delete responseTurn.privateReviewReceipt; args.companion.turns[1].privateReviewReceipt = valid;
  assert.ok(buildContext(args).payload.pendingPrivateReview.sourceIds.includes(id), 'an old receipt must not resolve a later correction');
});

test('pending intent marks topic only in the private model projection and never reaches final drafting', t => {
  const { args, pending } = pendingFixture(t), currentId = `private:${args.turn.id}`, source = args.availableSources.find(item => item.id === currentId);
  const topic = { id: 'stale-topic', version: 1, lifecycle: 'active', objective: '继续了解她', direction: '含蓄接话', constraints: [],
    sourceIds: [currentId], sourceRevisions: { [currentId]: source.revision } };
  args.topicContext = { version: 1, activeId: topic.id, active: topic };
  const originalState = structuredClone(args.companion.state);
  const context = buildContext(args); assert.equal(context.payload.topicContext.active.reviewPending, true);
  assert.equal(topic.reviewPending, undefined); assert.deepEqual(args.companion.state, originalState);
  const final = buildDraftContext(context, { quotes: [{ sourceId: currentId, text: '直接邀请一起散步' }],guidance:walkingControls(currentId) }, args);
  assert.equal(final.payload.pendingPrivateReview, undefined); assert.equal(JSON.stringify(final.payload).includes(pending[0]), false);
});

test('oversized protected pending originals fail without silently cutting the correction', t => {
  const { args, pending } = pendingFixture(t, 3);
  for (const id of pending) {
    const source = args.availableSources.find(source => source.id === id); source.text += '完整私下纠正。'.repeat(1700);
    args.companion.turns.find(turn => `private:${turn.id}` === id).text = source.text;
  }
  for (let index = 0; index < 8; index++) {
    const id = `later-user-${index}`, text = '稍后简短讨论。';
    args.companion.turns.splice(-1, 0, { id, role: 'user', kind: 'discussion', text }, { id: `later-assistant-${index}`, role: 'assistant', kind: 'discussion', text: '简短回应。' });
    args.availableSources.push({ id: `private:${id}`, type: 'private', role: 'user', text, revision: `later-${index}` });
  }
  args.byteBudget = 10000;
  // The ladder degrades protected pending corrections to explicit ranges or
  // digests instead of dead-ending: each delivered view is an exact span of
  // the original, the undelivered remainder is disclosed as unknown, and the
  // degradation stays recorded on the manifest for review.
  const degraded = buildContext(args);
  for (const id of pending) {
    const original = args.availableSources.find(source => source.id === id);
    const view = degraded.payload.sources.find(source => source.id === id);
    if (view) {
      assert.ok(view.delivery?.status === 'partial' || view.digest, `${id} must be explicitly ranged or digested, never silently cut`);
      if (view.delivery?.status === 'partial') assert.equal(view.text, original.text.slice(view.delivery.start, view.delivery.end));
    }
  }
  assert.ok(degraded.manifest.degradation?.some(entry => pending.includes(entry.appliedTo)),'pending degradation is explainable');
});

test('pending canonical feedback keeps its exact evaluated object or explicitly rejects its budget', t => {
  const { store, args } = fixture(t), evaluated = store.appendTurn(scope, { role: 'assistant', kind: 'discussion',
    text: '原始完整评价对象。'.repeat(650), sourceIds: [`private:${args.turn.id}`] });
  const feedback = store.addFeedback(scope, { targetRef: { kind: 'artifact', artifactRef: evaluated.artifactRef }, text: '这句多问了，不要再连着追问。' , expectedDigest: store.experiences.artifact(scope, evaluated.artifactRef).bodyDigest});
  const companion = store.getCompanion(scope);
  const feedbackRevision = store.memorySources(scope).find(source => source.id === feedback.sourceId).revision;
  companion.turns.push({ id: 'feedback-help', role: 'assistant', kind: 'discussion', text: '本次先按反馈继续帮助。',
    responseRecovery: { kind: 'private_help', reasonCode: 'structured_output_invalid', metadataApplied: false, intentSourceIds: [feedback.sourceId],
      intentSourceRevisions: { [feedback.sourceId]: feedbackRevision } } });
  const sources = store.memorySources(scope);
  for (let index = 0; index < 8; index++) {
    const id = `after-feedback-${index}`, text = '稍后简短交流。';
    companion.turns.push({ id, role: 'user', kind: 'discussion', text }, { id: `ack-feedback-${index}`, role: 'assistant', kind: 'discussion', text: '简短回复。' });
    sources.push({ id: `private:${id}`, type: 'private', role: 'user', text, revision: `feedback-later-${index}` });
  }
  const turn = { id: 'continue-pending-feedback', role: 'user', kind: 'discussion', text: '那继续。' };
  companion.turns.push(turn); sources.push({ id: `private:${turn.id}`, type: 'private', role: 'user', text: turn.text, revision: 'feedback-current' });
  const target = store.experiences.hydrateFeedback(scope, feedback.id), options = { ...args, turn, companion, availableSources: sources,
    feedbackTargets: [], experienceContext: { evaluationTargets: [target] }, byteBudget: 48000 };
  const context = buildContext(options);
  assert.equal(context.payload.sources.filter(source => source.id === feedback.sourceId).length, 1);
  assert.equal(context.payload.sources.find(source => source.id === feedback.sourceId).text, feedback.text);
  assert.equal(context.payload.sources.find(source => source.id === feedback.sourceId).type, 'feedback');
  assert.equal(context.payload.feedbackTargets[0].target.body, evaluated.text);
  assert.equal(context.payload.pendingPrivateReview.refs[0].turnId, undefined, 'canonical feedback is not cloned into an ordinary user fact');
  assert.equal(context.payload.pendingPrivateReview.refs[0].targetAvailability, 'full');
  const unavailable = buildContext({ ...options, experienceContext: null });
  assert.equal(unavailable.payload.pendingPrivateReview.refs[0].targetAvailability, 'needs_lookup');
  assert.equal(unavailable.payload.feedbackTargets, undefined);
  // A required feedback target that cannot fit degrades to an explicit
  // missing marker instead of blocking the whole request on the budget.
  const tight = buildContext({ ...options, byteBudget: 10000 });
  const marked = tight.payload.feedbackTargets.find(item => item.feedback.id === feedback.id);
  assert.equal(marked.missing, true);
  assert.ok(marked.reason.includes('未能放入本次上下文'));
  assert.ok(tight.manifest.degradation?.some(entry => entry.step === 'feedback_target_missing_marker' && entry.appliedTo === feedback.sourceId));
});

test('canonical feedback same-ID edits invalidate old recovery and cannot be cleared by stale or unbound review receipts', t => {
  const { store, args } = fixture(t), first = store.experiences.review(scope, { text: '先保持含蓄。', clientEventId: 'hash-original-feedback' });
  const id = first.feedback.sourceId, oldRevision = store.memorySources(scope).find(source => source.id === id).revision;
  store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '私下帮助，尚未更新背景。', sourceIds: [id],
    responseRecovery: { kind: 'private_help', reasonCode: 'structured_output_invalid', metadataApplied: false, intentSourceIds: [id] } });
  store.experiences.review(scope, { caseId: first.experience.id, feedbackId: first.feedback.id, expectedVersion: first.feedback.revision,
    text: '改成直接邀请。', clientEventId: 'hash-edited-feedback' });
  const sources = store.memorySources(scope), revision = sources.find(source => source.id === id).revision;
  assert.notEqual(revision, oldRevision);
  let companion = store.getCompanion(scope);
  const contextOptions = () => ({ ...args, companion, availableSources: sources });
  assert.equal(buildContext(contextOptions()).payload.pendingPrivateReview, undefined, 'a recovery about the replaced body cannot become current intent');
  const currentRecovery = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '按新的原话先帮助，背景待核对。', sourceIds: [id],
    responseRecovery: { kind: 'private_help', reasonCode: 'structured_output_invalid', metadataApplied: false, intentSourceIds: [id] } });
  companion = store.getCompanion(scope);
  // Deliberately replay stale/unbound historical receipt shapes at a later
  // position. The consumer must independently verify the saved source hash.
  companion.turns.push({ id: 'stale-replayed-receipt', role: 'assistant', kind: 'discussion', text: '旧回执',
    privateReviewReceipt: { applied: true, sourceIds: [id], sourceRevisions: { [id]: oldRevision } } });
  companion.turns.push({ id: 'legacy-unbound-receipt', role: 'assistant', kind: 'discussion', text: '旧无哈希回执', privateReviewReceipt: { applied: true, sourceIds: [id] } });
  const pending = buildContext(contextOptions()).payload.pendingPrivateReview;
  assert.deepEqual(pending.sourceIds, [id]); assert.equal(pending.refs[0].bindingStatus, 'source_bound');
  assert.equal(pending.refs[0].sourceRevisions, undefined); assert.equal(pending.refs[0].revision, undefined);
  companion.turns.push({ id: 'current-hash-receipt', role: 'assistant', kind: 'discussion', text: '新回执',
    privateReviewReceipt: { applied: true, sourceIds: [id], sourceRevisions: { [id]: revision } } });
  assert.equal(buildContext(contextOptions()).payload.pendingPrivateReview, undefined);
  const legacy = companion.turns.find(turn => turn.id === currentRecovery.id); delete legacy.responseRecovery.intentSourceRevisions;
  companion.turns = companion.turns.filter(turn => !['stale-replayed-receipt', 'legacy-unbound-receipt', 'current-hash-receipt'].includes(turn.id));
  assert.equal(buildContext(contextOptions()).payload.pendingPrivateReview.refs[0].bindingStatus, 'legacy_hash_missing_needs_review');
});
