'use strict';
// Self-built long-history fixtures for the context-budget degradation ladder.
// These cases reproduce the recorded failure family of coverage-long-single-source
// ("memory preparation finished, but the answer was still blocked by the product
// context budget") without importing any frozen eval file: the product analog is
// a user pasting one long original note as the current request, or binding the
// intent to a long archived source, under a request cap that cannot hold it whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext } = require('../src/assistant-context.cjs');
const { digestSource, splitEntries, firstSentence } = require('../src/context/evidence-digest.cjs');
const { parseAssistant } = require('../src/assistant-model.cjs');
const { parseModelJson } = require('../src/model-json.cjs');
const { planDiscussionCompaction } = require('../src/discussion-compaction.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

function message(id, outgoing, text) {
  return normalize(raw(String(id), outgoing, { elements: [{ textElement: { content: text } }] }), scope);
}
function handNote(kb, marker) {
  const item = i => '第' + i + '项是物件' + i + (marker || '') + '。我到整理桌时，师傅已经把它放好。我负责照着登记纸核对这件东西的说明，不负责估价。我们把能确认的现象按原话记下来，不补没有来源的往事。';
  const n = Math.ceil(kb * 1024 / Buffer.byteLength(item(1), 'utf8'));
  return Array.from({ length: n }, (_, i) => item(i + 1)).join('\n');
}
function fixture(t, { requestText = '她问到这些了，帮我回一下。', qqCount = 12, requestBytes } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const records = [];
  for (let i = 0; i < qqCount; i++) records.push(message(7000 + i, i % 2 === 1, '日常消息 ' + i + '，说说这周的事情。'));
  store.add(scope, records);
  store.setGoal(scope, '和她自然交流，分享自己的真实近况。');
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: requestText });
  const settings = { model: 'synthetic-budget' };
  if (requestBytes) settings.assistantRequestBytes = requestBytes;
  return { store, args: { scope, records: store.messages(scope), companion: store.getCompanion(scope), turn,
    purpose: 'discussion', coverage: { status: 'accessible_end' }, requestId: 'budget-degradation-case',
    byteBudget: 48000, settings, store }, turn };
}

test('an oversized pasted request degrades to an explicit range with a continuation handle', t => {
  const requestText = handNote(24, '当前请求') + '\n她问到这些了，帮我回一下。';
  const { args } = fixture(t, { requestText });
  const context = buildContext(args);
  const request = context.payload.sources.find(source => source.id === context.payload.userRequest.sourceId);
  assert.equal(request.delivery.status, 'partial');
  assert.equal(context.payload.userRequest.text, request.text, 'both request views carry the same delivered range');
  assert.equal(request.text, requestText.slice(request.delivery.start, request.delivery.end), 'delivered text is an exact span, never rewritten');
  assert.ok(request.delivery.end < request.delivery.originalCharLength, 'the undelivered remainder stays explicit');
  assert.equal(request.delivery.lookup.sourceId, request.id);
  assert.ok(context.manifest.userRequestDelivery.status === 'partial');
  // Structural adaptation (CC1 switchover): floor degradation is owned by the
  // admission compiler, whose ledger step is degraded_to_ranged with the
  // universal plural lookup handle; the legacy ranged_excerpt step remains
  // for legacy-owned shrink passes. Both vocabularies satisfy the same
  // guarantee: the step is explainable and its handle reaches the original.
  const entry = context.manifest.degradation.find(item => ['ranged_excerpt', 'degraded_to_ranged'].includes(item.step) && item.appliedTo === request.id);
  assert.ok(entry, 'the request degradation is explainable on the manifest');
  assert.ok(entry.lookupHandle && (entry.lookupHandle.sourceId === request.id || entry.lookupHandle.sourceIds?.[0] === request.id));
  assert.ok(context.manifest.inputBytes <= context.manifest.byteBudget);
  assert.ok(context.manifest.serializedTextRequestBytes <= context.manifest.requestByteBudget);
});

test('an oversized bound intent source degrades to an explicit range instead of blocking', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.setGoal(scope, '和她自然交流。');
  const longText = handNote(60, '意图来源');
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '帮我回一下。' });
  const prior = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: longText });
  const context = buildContext({ scope, records: [], companion: store.getCompanion(scope), turn, purpose: 'discussion',
    coverage: { status: 'accessible_end' }, requestId: 'intent-degradation', byteBudget: 48000,
    settings: { model: 'm' }, intentSourceId: 'private:' + prior.id, store });
  const view = context.payload.sources.find(source => source.id === 'private:' + prior.id);
  assert.equal(view.delivery.status, 'partial');
  assert.equal(view.text, longText.slice(view.delivery.start, view.delivery.end));
  // Structural adaptation (CC1 switchover): the compiler's floor ledger
  // vocabulary (degraded_to_ranged) carries the same guarantee as the legacy
  // ranged_excerpt step for the bound intent source.
  assert.ok(context.manifest.degradation.some(entry => entry.appliedTo === view.id && ['ranged_excerpt', 'degraded_to_ranged'].includes(entry.step)));
  assert.equal(context.payload.userRequest.text, '帮我回一下。', 'the short current question itself stays exact');
});

test('oversized background evidence degrades to a deterministic verbatim digest with per-entry handles', t => {
  const source = { id: 'private:digest-case', type: 'private', role: 'user', use: 'discussion',
    at: new Date().toISOString(), revision: 'digest-r1', text: handNote(20, '摘要来源') };
  const digested = digestSource(source);
  assert.ok(digested, 'a structured long source produces a digest view');
  assert.equal(digested.digest.authority, 'derived_digest_needs_lookup');
  assert.ok(digested.digest.entries.length >= 8, 'per-entry lines cover the structure');
  for (const entry of digested.digest.entries) {
    assert.ok(entry.sentence && source.text.includes(entry.sentence.trimEnd()), 'each line is a verbatim leading sentence');
    assert.deepEqual(entry.lookup.sourceIds, [source.id], 'the per-entry handle is copy-ready with an explicit sourceIds array');
    assert.ok(Number.isInteger(entry.lookup.offset) && Number.isInteger(entry.lookup.maxChars) && entry.lookup.maxChars >= 1);
    assert.ok(entry.end > entry.start && entry.end <= source.text.length);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(digested), 'utf8') < 4000, 'the digest itself is bounded');
  assert.equal(digested.delivery.status, 'digest');
});

test('the 6-12KB private-request compaction window still has a usable answer path', t => {
  const requestText = '我想商量这件事：' + '这是本次私下请求的正文。'.repeat(320); // ~8.5KB, inside the 16000-char product bound
  const { args } = fixture(t, { requestText, qqCount: 24, requestBytes: 28000 });
  // Long QQ history plus a mid-sized private request: no compaction plan is
  // admitted (originalBytes far below 12000, no large candidates), so the old
  // controller re-threw the capacity error and the answer was blocked.
  const plan = planDiscussionCompaction({ ...args, context: null, settings: args.settings });
  assert.equal(plan, null, 'fixture admits no compaction plan for this window');
  const context = buildContext(args);
  assert.ok(context.manifest.serializedTextRequestBytes <= 28000);
  const request = context.payload.sources.find(source => source.id === context.payload.userRequest.sourceId);
  assert.ok(request, 'the request itself stays delivered (whole when it fits, ranged when it does not)');
  assert.ok(!request.delivery || request.delivery.status === 'partial', 'never an unmarked slice');
});

test('a budget below the minimal envelope still fails honestly instead of degrading to nothing', t => {
  const { args } = fixture(t, { requestText: '继续聊。' });
  args.byteBudget = 4000;
  assert.throws(() => buildContext(args), /预算.*没有静默截断|预算/);
});

test('a length-truncated response never passes the brace-scan rescue', () => {
  const rescued = '说明文字 {"kind":"draft","text":"完整对象"} 后面是被截断的尾巴';
  assert.equal(parseModelJson(rescued).kind, 'draft', 'a non-truncated response may still be rescued');
  assert.throws(() => parseModelJson(rescued, { truncated: true }), /截断/);
});

test('a length-truncated main response enters the bounded repair path instead of being parsed', async t => {
  const { assistModel } = require('../src/assistant-model.cjs');
  const settings = { apiKey: 'synthetic', model: 'm', baseUrl: 'http://fixture.invalid/v1' };
  const requestBudget = new (require('../src/request-budget.cjs').TaskLedger)(new Store(':memory:'));
  const budget = requestBudget.create(scope, { id: 'length-main', inputDigest: 'd1' }).forStage('discussion');
  const bodies = [];
  const fetchImpl = async (_url, request) => {
    bodies.push(request.body);
    const content = '说明 {"kind":"discussion","text":"被截断的前导对象"} 尾巴未完';
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'length',
      message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const context = { manifest: { scope, requestId: 'length-main', sourceRevisions: {} },
    payload: { purpose: 'discussion', sources: [], methodCards: [], methodSelection: { candidates: [] } } };
  Object.defineProperty(context, 'sourceHandleOwner', { value: null, writable: true, configurable: true });
  // Both the main response and its repair hit the length limit: the truncated
  // main response is never parsed directly, and the honest truncation error
  // surfaces instead of a silently rescued partial object.
  await assert.rejects(assistModel({ ...settings, requestBudget: budget }, context, undefined, fetchImpl),
    error => error.code === 'model_output_truncated' || /截断/.test(error.message));
  assert.equal(bodies.length, 2, 'the truncated main response was repaired once, never accepted directly');
  assert.ok(context.manifest.formatRepair && /长度上限|截断/.test(context.manifest.formatRepair.reason));
});

test('controller-level long pasted request returns a usable discussion instead of a budget block', async t => {
  const { Controller } = require('./fixtures/assistant-protocol.cjs');
  const { assistModel } = require('./fixtures/assistant-protocol.cjs');
  const store = new Store(':memory:');
  const calls = [];
  const settings = { model: 'synthetic-budget-e2e', baseUrl: 'http://fixture.invalid/v1', anonymous: true, auto: false, assistantRequestBytes: 36000 };
  settings.realChatConsent = { accountUid: scope.accountUid, peerUin: scope.peerUin, model: settings.model, baseUrl: settings.baseUrl };
  let seenPayload = null;
  const transport = async (_url, request) => {
    const envelope = JSON.parse(request.body), payload = JSON.parse(envelope.messages[1].content);
    calls.push(payload.purpose);
    if (payload.purpose === 'fidelity_check') return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checkRef: payload.checkRef, auditProtocol: 'sparse-defects-v1', issues: [] }) } }] }), { status: 200 });
    if (payload.purpose === 'discussion') { seenPayload = payload; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'discussion', text: '基于已交付范围的可用讨论。' }) } }] }), { status: 200 }); }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ kind: 'discussion', text: '占位。' }) } }] }), { status: 200 });
  };
  const controller = new Controller({ store, settings, compactionModel: null,
    read: async command => command === 'bind' ? scope : { messages: [] },
    assistantModel: (s, c, signal) => assistModel(s, c, signal, transport) });
  t.after(() => { controller.close(); store.close(); });
  controller.updateStatus({ phase: 'ready', account: { uid: scope.accountUid, uin: scope.accountUin } });
  await controller.bind(scope.peerUin);
  await controller.setGoal('和她自然交流。');
  controller.live({ scope, messages: Array.from({ length: 10 }, (_, i) => raw(String(9e15 + i), i % 2 === 1, { elements: [{ textElement: { content: '虚构的近况消息 ' + i + '。' } }] })) });
  const requestText = handNote(22, '端到端') + '\n她问到这些了，帮我回一下。';
  const reply = await controller.assist({ text: requestText, purpose: 'discussion', taskId: 'budget-e2e' });
  assert.equal(reply.text, '基于已交付范围的可用讨论。');
  assert.equal(controller.assistantError, '', 'no budget block surfaced to the user');
  const run = store.getCompanion(scope).runs.find(item => item.id === 'budget-e2e');
  assert.equal(run.status, 'complete', 'the completed run is retained with its diagnostics');
  // The wire carries the delivered request view: an exact prefix of the pasted
  // original, strictly shorter than it, so the undelivered remainder is never
  // silently presented as the complete request.
  assert.ok(seenPayload.userRequest && seenPayload.userRequest.text.length < requestText.length,
    'the request was range-delivered rather than blocked or silently whole');
  assert.ok(requestText.startsWith(seenPayload.userRequest.text), 'the delivered range is an exact span of the original');
});

test('a ranged lookup without explicit IDs is completed from the digest handle instead of failing', () => {
  const source = { id: 'private:lookup-completion', type: 'private', role: 'user', use: 'discussion',
    at: new Date().toISOString(), revision: 'lookup-r1', text: handNote(20, '续读来源') };
  const digested = digestSource(source);
  const input = { payload: { purpose: 'discussion', sources: [digested], methodCards: [],
    methodSelection: { candidates: [] }, userRequest: { sourceId: 'private:other', text: 'q' } } };
  // The observed live malformation: the model emits a bounded range with no
  // sourceIds/discussionTurnIds. With exactly one ranged candidate the ID is
  // deterministic program knowledge and is completed, not re-asked.
  const result = parseAssistant({ kind: 'discussion', text: '续读摘要条目。', lookup: { offset: 1200, maxChars: 2000 } },
    'discussion', input, {});
  assert.deepEqual(result.lookup.sourceIds, ['private:lookup-completion']);
  assert.equal(result.lookup.offset, 1200);
  assert.equal(result.lookup.maxChars, 2000);
});

test('a query-form lookup may carry maxChars as a result-size bound without source IDs', () => {
  // Exact recorded shapes from the live 002d candidate-live-4 failure: the
  // model bounded its SEARCH results with maxChars, which the range-read rule
  // misread as a source range; once the single delivery repair was spent, the
  // second identical shape died as request_delivery_repair_exhausted.
  const input = { payload: { purpose: 'discussion', sources: [], methodCards: [],
    methodSelection: { candidates: [] }, userRequest: { sourceId: 'private:x', text: 'q' } } };
  const first = parseAssistant({ kind: 'discussion', text: '查历史。', lookup: { query: '小网页 读书笔记 三点 周六 变更', types: ['private'], maxChars: 8000 } },
    'discussion', input, {});
  assert.equal(first.lookup.query, '小网页 读书笔记 三点 周六 变更');
  const second = parseAssistant({ kind: 'discussion', text: '查历史。', lookup: { query: '小网页 读书笔记 十月三日 周六 下午 三点 改动 时间', types: ['private'], after: '2026-08-31T10:00:00.000Z', maxChars: 8000 } },
    'discussion', input, {});
  assert.equal(second.lookup.after, '2026-08-31T10:00:00.000Z');
  // A pure range read (no query) still requires completed or explicit IDs.
  assert.throws(() => parseAssistant({ kind: 'discussion', text: 'r。', lookup: { maxChars: 4000 } },
    'discussion', input, {}), /lookup ranges require explicit sourceIds/);
});

test('an ambiguous ranged lookup without IDs still fails, naming the copy-ready candidates', () => {
  const first = digestSource({ id: 'private:cand-a', type: 'private', role: 'user', use: 'discussion',
    at: new Date().toISOString(), revision: 'ra', text: handNote(8, '候选甲') });
  const second = digestSource({ id: 'private:cand-b', type: 'private', role: 'user', use: 'discussion',
    at: new Date().toISOString(), revision: 'rb', text: handNote(8, '候选乙') });
  const input = { payload: { purpose: 'discussion', sources: [first, second], methodCards: [],
    methodSelection: { candidates: [] }, userRequest: { sourceId: 'private:other', text: 'q' } } };
  // Both candidates cover the offset: the target cannot be completed without
  // guessing, so the explicit error survives — now listing both handles.
  assert.throws(() => parseAssistant({ kind: 'discussion', text: '续读。', lookup: { offset: 300, maxChars: 1000 } },
    'discussion', input, {}), error => /lookup ranges require explicit sourceIds/.test(error.message)
    && error.message.includes('private:cand-a') && error.message.includes('private:cand-b'));
  // With an offset beyond the first digest's covered entries but inside the
  // second's, exactly one candidate covers it and the completion resolves
  // deterministically.
  first.digest.coveredCharRange = { ...first.digest.coveredCharRange, end: 500 };
  const withinSecondOnly = Math.min(700, second.digest.coveredCharRange.end - 1);
  const resolved = parseAssistant({ kind: 'discussion', text: '续读。', lookup: { offset: withinSecondOnly, maxChars: 1000 } },
    'discussion', input, {});
  assert.deepEqual(resolved.lookup.sourceIds, ['private:cand-b']);
});

// ---- CC1 requirement-driven compiler path (design §4.3 CC1 acceptance) ----
// The greenfield admission compiler must give every oversized scenario above
// a deliverable plan plus an explainable manifest, throwing only under the
// minimal envelope. Same self-built fixture shapes, compiler seam: no legacy
// selection wiring involved.
const { compileContext } = require('../src/context/admission-compiler.cjs');
const { BudgetAuthority } = require('../src/context/budget-authority.cjs');
const { sourceSnapshot } = require('../src/context/source-snapshot.cjs');

test('CC1: every oversized scenario yields a compiler plan + manifest at each budget', t => {
  const scenarios = [
    ['oversized pasted request', { requestText: handNote(24, '当前请求') + '\n她问到这些了，帮我回一下。', notes: [] }],
    ['oversized archived intent note', { requestText: '帮我回一下。', notes: [handNote(60, '意图来源')] }],
    ['oversized background evidence', { requestText: '她问到这些了，帮我回一下。', notes: [handNote(20, '摘要来源')] }],
    ['mid-band 8.5KB request', { requestText: '我想商量这件事：' + '这是本次私下请求的正文。'.repeat(320), notes: [] }]
  ];
  for (const [name, { requestText, notes }] of scenarios) {
    const store = new Store(':memory:');
    t.after(() => store.close());
    store.setGoal(scope, '和她自然交流，分享自己的真实近况。');
    for (const note of notes) store.appendTurn(scope, { role: 'user', kind: 'discussion', text: note });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: requestText });
    const snapshot = sourceSnapshot({ scope, records: store.messages(scope), companion: store.getCompanion(scope), turn });
    const intentSource = notes.length ? snapshot.all.find(source => source.text === notes[0]) : null;
    for (const byteBudget of [48000, 16000, 9000]) {
      const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: byteBudget,
        requestByteBudget: 256000, measureRequest: () => 0 });
      const result = compileContext({ asOf: turn.createdAt, purpose: 'discussion', request: { text: snapshot.current.text },
        current: snapshot.current, intentSource, candidateSources: snapshot.all.filter(source => source.id !== snapshot.current.id), budget: authority });
      assert.equal(result.plan.deliverable, true, `${name} @${byteBudget}: plan delivers`);
      assert.ok(authority.fits(result.payload), `${name} @${byteBudget}: payload fits`);
      assert.equal(result.manifest.version, 'budget-authority-v1', `${name} @${byteBudget}: manifest present`);
      const tier = result.admissions.find(admission => admission.id === snapshot.current.id).tier;
      assert.ok(['verbatim', 'ranged'].includes(tier), `${name} @${byteBudget}: floor never below a marked range (got ${tier})`);
    }
  }
});

test('CC1: the compiler path fails honestly only under the minimal envelope', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: handNote(10, '超预算请求') });
  const snapshot = sourceSnapshot({ scope, records: [], companion: store.getCompanion(scope), turn });
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 400,
    requestByteBudget: 256000, measureRequest: () => 0 });
  assert.throws(() => compileContext({ asOf: turn.createdAt, purpose: 'discussion', request: { text: snapshot.current.text },
    current: snapshot.current, candidateSources: [], budget: authority }), /预算.*没有静默截断|预算/);
});
