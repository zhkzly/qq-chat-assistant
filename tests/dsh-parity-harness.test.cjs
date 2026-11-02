'use strict';
// DSH parity harness: CC1 admission compiler vs the legacy selection pipeline
// (design docs/dsh-subsystem-redesign.md §C3/C4; integration boundary recorded
// in the CC1 delivery report). Before the legacy optional layers (discovery,
// methods, private-conversation grouping, relationship projection, background
// admission) can be retired, every behavioral difference between the two
// chains must be proven equivalent, classified as a by-design improvement, or
// explicitly recorded as a retirement gap (docs/dsh-parity-report.md).
//
// Method (deterministic, zero model calls, evals/ untouched): for every
// scenario the harness runs buildContext ONCE with the CC1 swap neutralized —
// reproducing the exact pre-integration legacy pipeline — while capturing the
// pristine compiler inputs at the swap seam, then runs the real CC1 compiler
// on those same inputs. Both deliveries are projected onto comparable
// descriptors and diffed.
//
// Diff taxonomy (also used in docs/dsh-parity-report.md):
//   (a) by-design difference — the new chain behaves as the redesign intends;
//   (b) regression — the new chain loses legitimate content the old chain
//       delivered; fixed CC1-side and pinned here (must stay empty);
//   (c) insignificant — field renames/ordering only;
//   (gap) documented scope difference — an optional layer still owned by the
//       legacy engine; a retirement blocker listed in the parity report.
// Classification is enforced as executable rules below: an observed difference
// that violates a rule fails as a (b); a layer diff outside the recorded gap
// list fails as unclassified.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const { bytes } = require('../src/context/shared.cjs');
const { declarationSentences } = require('../src/context/evidence-digest.cjs');
const { discoverConversationEvidence } = require('../src/conversation-discovery.cjs');
const admission = require('../src/context/admission-compiler.cjs');
const { BudgetAuthority } = require('../src/context/budget-authority.cjs');

// ---- instrumentation: neutralize the CC1 swap inside buildContext ----
const realShim = admission.selectPlanningContext;
let captured = null;
const NEUTRAL = { payload: {}, coreItems: [], optionalRawLimit: 0, optionalRawIds: new Set(), optionalRetrieved: [],
  recentContextPlan: null, recentPriorityIds: new Set(), recentInitialAdditionalBytes: 0, degradation: [], consultationSupport: [] };
admission.selectPlanningContext = function (args) { captured = args; return NEUTRAL; };
// planning-view.cjs destructures the shim at require time, so this patch must
// land before the require below (each test file runs in its own process).
const { buildContext } = require('../src/assistant-context.cjs');

// ---- fixtures ----
const HOUR = 3600000;
function message(id, text, ageHours, own) {
  return normalize(raw(String(id), !!own, { msgTime: String(Math.floor((Date.now() - ageHours * HOUR) / 1000)),
    elements: [{ textElement: { content: text } }] }), scope);
}
function para(i) {
  return '第' + i + '项是物件' + i + '。我到整理桌时，师傅已经把它放好。我负责照着登记纸核对这件东西的说明，不负责估价。我们把能确认的现象按原话记下来，不补没有来源的往事。';
}
// Same shape as the reviewed declared-arrangement family: the declaration
// sentence is buried mid-document between numbered entries.
function declarationNote(withDeclaration) {
  const parts = ['这是留给自己的原始手记，方便和你商量真实近况。'];
  for (let i = 1; i <= 24; i++) {
    if (i === 13 && withDeclaration) parts.push('这周末的安排我也在这里给你说清楚：周六三点半以后我有空，也愿意和她一起去看旧物展。');
    parts.push(para(i));
  }
  return parts.join('\n');
}
function baseOptions(store, turn, extra) {
  return { scope, store, records: store.messages(scope), companion: store.getCompanion(scope), turn, purpose: 'discussion',
    requestId: 'dsh-parity', coverage: { status: 'complete' }, viewerTimeZone: 'Asia/Shanghai',
    settings: { model: 'synthetic', assistantRequestBytes: 64000 }, asOf: turn.createdAt, ...extra };
}

const scenarios = {
  // Multi-source snapshot: 14 QQ messages + two private turns, generic request.
  S1_rich_snapshot: function (store) {
    const records = Array.from({ length: 14 }, function (_, i) {
      return message(70000 + i, i % 3 === 0 ? '这周工作忙得怎么样，周末有安排吗？' : '日常聊天消息' + i + '，最近在看展的消息。', 100 - i * 6, i % 4 === 0); });
    store.add(scope, records);
    store.setGoal(scope, '和她自然交流，分享自己的真实近况。');
    store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '先记一下：她提到想看旧物展。' });
    store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: '可以先问她这周末的时间安排。' });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '帮我看看最近的聊天，想想要怎么回她。' });
    return baseOptions(store, turn, {});
  },
  // Declared arrangement present + invitation-type request (B5 material path).
  S2_declaration_invitation: function (store) {
    const records = [message(71000, '周六下午一起去看旧物展吗？', 3)];
    store.add(scope, records);
    store.setGoal(scope, '和她自然交流。');
    store.appendTurn(scope, { role: 'user', kind: 'discussion', text: declarationNote(true) });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她邀请我周六一起看旧物展，我该怎么回她？' });
    return baseOptions(store, turn, {});
  },
  // Same request shape, no declaration anywhere: honesty of the missing path.
  S3_no_declaration: function (store) {
    const records = [message(71001, '周六下午一起去看旧物展吗？', 3)];
    store.add(scope, records);
    store.setGoal(scope, '和她自然交流。');
    store.appendTurn(scope, { role: 'user', kind: 'discussion', text: declarationNote(false) });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她邀请我周六一起看旧物展，我该怎么回她？' });
    return baseOptions(store, turn, {});
  },
  // Oversized private source under a tight payload budget: ladder parity.
  S4_overbudget: function (store) {
    const records = Array.from({ length: 6 }, function (_, i) { return message(72000 + i, '近期消息' + i, 20 - i, i % 2 === 0); });
    store.add(scope, records);
    store.setGoal(scope, '和她自然交流。');
    store.appendTurn(scope, { role: 'user', kind: 'discussion', text: declarationNote(true) + declarationNote(false) });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '帮我整理一下她这周说的安排。' });
    return baseOptions(store, turn, { byteBudget: 6000 });
  },
  // Closed topic + relationship records (topicContext / relationshipContext).
  S5_topic_relationship: function (store) {
    const records = [message(73000, '最近换工作的事想清楚了。', 30, true), message(73001, '换工作之后轻松一些了吗？', 29)];
    store.add(scope, records);
    store.setGoal(scope, '和她自然交流。');
    const older = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '换工作的事先到这里，以后再说。' });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她问我换工作的事，别再提旧工作了，怎么回？' });
    const privateSource = 'private:' + older.id;
    const topic = { id: 'topic-job', version: 1, lifecycle: 'active', objective: '商量换工作的表达', direction: '不主动提旧工作', sourceIds: [privateSource] };
    const closed = { id: 'topic-old', version: 1, lifecycle: 'closed', objective: '旧工作去留', direction: '已决定不换', sourceIds: [privateSource], stage: 'closed', progress: ['已决定'] };
    const claim = { id: 'claim-job', version: 1, subject: 'self', aspect: 'work', text: '用户最近换了工作', assertionKind: 'stated', epistemicStatus: 'supported', lifecycle: 'active', sourceIds: [privateSource], evidenceValidity: 'valid' };
    const event = { id: 'event-job', version: 1, activityId: 'act-job', activityKey: '换工作', text: '完成入职', eventKind: 'milestone',
      occurredAt: new Date(Date.now() - 40 * HOUR).toISOString(), sourceIds: [privateSource], evidenceValidity: 'valid', lifecycle: 'active' };
    const activity = { activityId: 'act-job', activityKey: '换工作', status: 'active', authority: 'source_backed_summary', eventIds: ['event-job'] };
    return baseOptions(store, turn, {
      topicContext: { version: 1, activeId: topic.id, items: [topic, closed] },
      relationshipContext: { version: 1, claims: [claim], events: [event], activities: [activity], coverage: {},
        understanding: { self: { knownFacts: [claim] }, contact: { knownFacts: [] }, dyad: { knownFacts: [] } } } });
  },
  // Explicit lookups (model read + user source lookup) and a feedback target.
  S6_lookup_feedback: function (store) {
    const records = Array.from({ length: 8 }, function (_, i) { return message(74000 + i, '相关讨论素材' + i + '，周末安排的事。', 50 - i, i % 2 === 0); });
    store.add(scope, records);
    store.setGoal(scope, '和她自然交流。');
    store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '旧的第一轮讨论：周六下午有空。' });
    const answer = store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: '上一版草稿内容：周六下午见面不错，语气正式。',
      suggestions: [{ style: '直白', text: '周六下午我方便，一起去看展。' }] });
    const lookupTurn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '再看看之前那轮的原始记录。' });
    store.addFeedback(scope, { text: '上一次的回复语气太正式，重新组织一下。', targetRef: { kind: 'artifact', artifactRef: answer.artifactRef },
      expectedDigest: store.experiences.artifact(scope, answer.artifactRef).bodyDigest });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '上一次的回复不对，重新组织一下，语气自然点。' });
    const feedbackRecord = store.getCompanion(scope).feedback.slice(-1)[0];
    return baseOptions(store, turn, {
      sourceLookupIds: [lookupTurn.id],
      retrievedSources: [{ id: 'qq:' + records[2].messageId, offset: 0, maxChars: 200 }],
      feedbackTargets: [{ sourceId: feedbackRecord.sourceId, feedbackId: feedbackRecord.id }],
      experienceContext: store.experiences.context(scope, { query: turn.text, limit: 4 }),
      allowExperienceProposals: true });
  },
  // Discovery directory + requested method cards (legacy optional layers the
  // controller feeds through options; CC1 has no counterpart yet).
  S7_discovery_methods: function (store) {
    const records = Array.from({ length: 5 }, function (_, i) { return message(77000 + i, '旧物展的相关讨论' + i + '。', 60 - i, i % 2 === 0); });
    store.add(scope, records);
    store.setGoal(scope, '和她自然交流，聊聊旧物展的事。');
    const noteTurn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她上次提到想看旧物展，一直没去成。' });
    const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '帮我想想旧物展这个话题怎么开口。' });
    const knowledge = [{ id: 'fact-exhibit', recordType: 'item', kind: 'fact', text: '她想看旧物展', topicKeys: ['旧物展'],
      sourceIds: ['private:' + noteTurn.id], reviewComplete: true, status: 'active' }];
    return baseOptions(store, turn, {
      memoryResult: { items: knowledge, episodes: [], coverage: null },
      memoryDiscovery: discoverConversationEvidence({ sources: store.memorySources(scope), records: knowledge,
        query: '旧物展 怎么开口', goal: '和她自然交流，聊聊旧物展的事。', asOf: turn.createdAt, mode: 'broad' }),
      methodLookupIds: ['clarify'] });
  }
};

// ---- descriptors ----
const EMPTY_LAYERS = { privateConversation: [], relationshipClaims: [], relationshipEvents: [], relationshipActivities: [],
  topicActive: null, topicRetained: [], coreMemory: [], methodCards: [], memoryIndex: [], memoryDiscoveryDirectory: -1,
  retrievedMemory: [], feedbackTargets: [], preferences: [], privateRestrictions: [], privateCandidates: [],
  evidenceDelivery: [], taskContext: null, work: null, materialView: null, goal: null, deferredContext: null };

function tierOfLegacy(source) {
  if (source.delivery && source.delivery.status === 'partial') return 'ranged';
  if (source.delivery && source.delivery.status === 'omitted') return 'marker';
  if (source.digest && source.digest.declarations && source.digest.declarations.length && !(source.digest.entries || []).length) return 'declarations';
  if (source.digest && (source.digest.entries || []).length) return 'digest';
  return 'verbatim';
}
function describeLegacy(context) {
  const payload = context.payload;
  const sources = new Map((payload.sources || []).map(function (source) { return [source.id, tierOfLegacy(source)]; }));
  const sentences = [];
  for (const source of payload.sources || []) {
    for (const found of declarationSentences(String(source.text || ''))) sentences.push({ sourceId: source.id, sentence: found.sentence });
    for (const declaration of (source.digest && source.digest.declarations) || []) sentences.push({ sourceId: source.id, sentence: declaration.sentence });
  }
  return { sources, sentences,
    userRequest: payload.userRequest ? { sourceId: payload.userRequest.sourceId } : null,
    degradation: (context.manifest.degradation || []).map(function (entry) { return entry.step; }),
    layers: {
      privateConversation: (payload.privateConversation || []).map(function (entry) { return entry.id + ':' + entry.role; }),
      relationshipClaims: ((payload.relationshipContext && payload.relationshipContext.claims) || []).map(function (claim) { return claim.id; }),
      relationshipEvents: ((payload.relationshipContext && payload.relationshipContext.events) || []).map(function (event) { return event.id; }),
      relationshipActivities: ((payload.relationshipContext && payload.relationshipContext.activities) || []).map(function (activity) { return activity.activityId; }),
      topicActive: payload.topicContext && payload.topicContext.active ? payload.topicContext.active.id : null,
      topicRetained: ((payload.topicContext && payload.topicContext.retained) || []).map(function (item) { return item.id; }),
      coreMemory: ((payload.coreMemory && payload.coreMemory.items) || []).map(function (item) { return item.id; }),
      methodCards: (payload.methodCards || []).map(function (card) { return card.id; }),
      memoryIndex: (payload.memoryIndex || []).map(function (item) { return item.id; }),
      memoryDiscoveryDirectory: payload.memoryDiscovery ? (payload.memoryDiscovery.directory || []).length : -1,
      retrievedMemory: [].concat((payload.retrievedMemory && payload.retrievedMemory.items) || [], (payload.retrievedMemory && payload.retrievedMemory.episodes) || []).map(function (item) { return item.id; }),
      feedbackTargets: (payload.feedbackTargets || []).map(function (item) { return item.feedback.sourceId + (item.missing ? ':missing' : ''); }),
      preferences: (payload.preferences || []).map(function (item) { return item.sourceId; }),
      privateRestrictions: (payload.privateRestrictions || []).map(function (item) { return item.sourceId; }),
      privateCandidates: (payload.privateCandidates || []).map(function (item) { return item.turnId + ':' + (item.availability || 'full'); }),
      evidenceDelivery: ((payload.evidenceDelivery && payload.evidenceDelivery.explicitLookups) || []).map(function (item) { return item.sourceId + ':' + item.status; }),
      taskContext: payload.taskContext ? 'present' : null,
      work: payload.work ? 'present' : null,
      materialView: payload.materialView ? 'present' : null,
      goal: payload.goal != null ? 'present' : null,
      deferredContext: payload.deferredContext || null
    } };
}
function describeCC1(result) {
  const payload = result.payload;
  const tiers = new Map(((result.admission && result.admission.admissions) || []).map(function (entry) { return [entry.id, entry.tier]; }));
  const sources = new Map((payload.sources || []).map(function (source) { return [source.id, tiers.get(source.id) || 'verbatim']; }));
  const markerOnly = ((result.admission && result.admission.admissions) || [])
    .filter(function (entry) { return entry.tier === 'marker'; }).map(function (entry) { return entry.id; });
  return { sources, markerOnly, views: new Map((payload.sources || []).map(function (source) { return [source.id, source]; })),
    sentences: (payload.mandatoryMaterials || []).map(function (material) { return { sourceId: material.sourceId, sentence: material.sentence }; }),
    userRequest: payload.userRequest ? { sourceId: payload.userRequest.sourceId } : null,
    degradation: result.degradation || [],
    materialOutcomes: ((payload.materialRequirements && payload.materialRequirements.outcomes) || [])
      .map(function (outcome) { return outcome.materialClass + ':' + outcome.status; }),
    layers: JSON.parse(JSON.stringify(EMPTY_LAYERS)) };
}

function runScenario(name) {
  const store = new Store(':memory:');
  const options = scenarios[name](store);
  captured = null;
  const legacy = describeLegacy(buildContext(options));
  assert.ok(captured, 'the neutralized swap captured the pristine compiler inputs');
  const cc1 = describeCC1(realShim(captured));
  return { store, legacy, cc1, snapshot: captured.snapshot, captured };
}

// ---- retirement gap list (explicit recorded differences) ----
const RETIREMENT_GAPS = {
  privateConversation: 'private-conversation grouping — legacy selection owns it; design §3.1 step 3 candidate gatherer is the CC1-side target',
  relationshipClaims: 'relationship claim projection with entailment labels — design §3.4',
  relationshipEvents: 'relationship event projection — design §3.4',
  relationshipActivities: 'relationship activity projection — design §3.4',
  topicActive: 'active task control view — design §3.1 step 3 direct references',
  topicRetained: 'closed-topic navigation (negative control) — design §3.2 closed_topic row',
  coreMemory: 'core memory directory — design §2.3 retrieval service',
  methodCards: 'help-method cards — design §3.5 contract fragments',
  memoryIndex: 'memory navigation index — design §2.3 retrieval service',
  memoryDiscoveryDirectory: 'discovery directory — design §2.3 retrieval service',
  retrievedMemory: 'retrieved memory summaries — design §2.3 retrieval service',
  feedbackTargets: 'structured feedback-target records — design §2.5',
  preferences: 'stable expression preference controls — design §2.1 preference ontology',
  privateRestrictions: 'private restriction controls — legacy disclosure surface',
  privateCandidates: 'candidate originals/anchors — design §3.1 step 3',
  evidenceDelivery: 'explicit-lookup delivery manifest — design §3.1 step 6',
  taskContext: 'task frame (recent exchange, draft control policy) — design §3.1 step 3',
  work: 'conversation work view — planning projection built pre-selection',
  materialView: 'material view — planning projection built pre-selection',
  goal: 'redacted goal text — seed payload field, not selection-owned',
  deferredContext: 'deferred-context omission counters — design §3.1 manifest vocabulary'
};
// Surfaces that must show up as gaps in at least one scenario; keeps the
// matrix honest about always-on legacy content.
const GAP_COVERAGE_FLOOR = ['privateConversation', 'taskContext', 'work', 'materialView', 'goal', 'deferredContext'];

// ---- the parity matrix ----
const observedGapUnion = new Set();
// Inspection export for docs/dsh-parity-report.md: run with
// DSH_PARITY_REPORT=1 to print the observed matrix as JSON. This is a
// deterministic inspection export, not an evaluation.
const MATRIX = {};
for (const name of Object.keys(scenarios)) {
  test('parity matrix ' + name + ': governed core holds, diffs classified', function (t) {
    const run = runScenario(name);
    t.after(function () { run.store.close(); });
    const legacy = run.legacy, cc1 = run.cc1, snapshot = run.snapshot, capturedArgs = run.captured;

    // (0) never-refuse parity: both chains deliver the current request.
    assert.ok(legacy.userRequest && cc1.userRequest, 'both chains deliver the current request');
    assert.equal(cc1.userRequest.sourceId, legacy.userRequest.sourceId, 'the request mirror binds the same source');

    // (1) governed floor (current request + bound intent): delivered by CC1,
    // never omitted, never marker-only.
    const governed = new Set([snapshot.current.id]);
    if (capturedArgs.candidates.intentSource) governed.add(capturedArgs.candidates.intentSource.id);
    for (const id of governed) {
      assert.ok(cc1.sources.has(id), 'governed floor source delivered by CC1: ' + id);
      assert.equal(cc1.markerOnly.includes(id), false, 'governed floor source never a marker: ' + id);
    }

    // (2) mandatory declaration content parity (B5): any declaration sentence
    // the legacy delivery carries must also reach the CC1 delivery — as MQA
    // mandatory-material metadata or inside a delivered view.
    for (const item of legacy.sentences) {
      const inMetadata = cc1.sentences.some(function (material) { return material.sentence === item.sentence; });
      const inViews = [...cc1.views.values()].some(function (view) {
        return String(view.text || '').includes(item.sentence) || JSON.stringify(view).includes(item.sentence); });
      assert.ok(inMetadata || inViews, 'declaration delivered by legacy must reach the CC1 delivery: ' + item.sentence.slice(0, 18));
    }

    // (3) explicit lookups are user intent (sv-001 Gap-s2): every lookup the
    // legacy path delivered stays addressable in CC1 (delivered or marker).
    const lookupIds = [].concat(capturedArgs.options.sourceLookupIds || [], capturedArgs.options.retrievedSources || []).map(function (item) {
      const id = typeof item === 'string' ? item : item.id;
      return id.startsWith('private:') || id.startsWith('qq:') ? id : 'private:' + id; });
    for (const id of lookupIds) {
      if (legacy.sources.has(id)) assert.ok(cc1.sources.has(id) || cc1.markerOnly.includes(id),
        'explicit lookup stays addressable in CC1: ' + id);
    }

    // (4) feedback targets (b2 pin): when the legacy path delivered the
    // feedback source, CC1 admits the mandatory material and reports it
    // delivered — never a false 'missing'.
    const feedbackIds = (capturedArgs.options.feedbackTargets || []).map(function (item) { return item.sourceId; }).filter(Boolean);
    for (const id of feedbackIds) {
      if (legacy.sources.has(id) && snapshot.byId.has(id)) {
        const outcome = cc1.materialOutcomes.find(function (entry) { return entry.indexOf('feedback_target:') === 0; });
        assert.equal(outcome, 'feedback_target:delivered', 'an admitted feedback target is reported delivered, got ' + outcome);
      }
    }

    // (5) background superset rule (B4 by design): everything the legacy
    // chain delivered stays addressable in the CC1 delivery — delivered, or
    // at worst an explicit marker (never a silent drop).
    for (const id of legacy.sources.keys()) {
      assert.ok(cc1.sources.has(id) || cc1.markerOnly.includes(id),
        'source delivered by legacy must stay addressable in CC1: ' + id);
    }

    // (6) degradation-ledger honesty (CC1 contract): a step naming an
    // individual source carries a copy-ready handle; only aggregate or
    // missing-guarantee steps are handleless by design.
    for (const entry of cc1.degradation) {
      const individual = /^(qq|private|note|feedback):/.test(String(entry.appliedTo));
      if (individual) assert.ok(entry.lookupHandle && Array.isArray(entry.lookupHandle.sourceIds) && entry.lookupHandle.sourceIds.length,
        'degradation step for ' + entry.appliedTo + ' carries a lookup handle');
    }

    // (7) layer inventory: every observed layer difference must be a recorded
    // retirement gap; unknown diffs fail as unclassified.
    const observedGaps = Object.keys(legacy.layers).filter(function (key) {
      return JSON.stringify(legacy.layers[key]) !== JSON.stringify(cc1.layers[key]); });
    for (const key of observedGaps) assert.ok(Object.prototype.hasOwnProperty.call(RETIREMENT_GAPS, key),
      'unclassified layer difference in ' + name + ': ' + key + ' — extend RETIREMENT_GAPS and the parity report');
    for (const key of observedGaps) observedGapUnion.add(key);
    MATRIX[name] = {
      legacyTiers: Object.fromEntries(legacy.sources), cc1Tiers: Object.fromEntries(cc1.sources),
      cc1MarkerOnlyCount: cc1.markerOnly.length,
      legacyDeclarationSentences: legacy.sentences.length, cc1MandatorySentences: cc1.sentences.length,
      materialOutcomes: cc1.materialOutcomes,
      degradationSteps: { legacy: legacy.degradation.length, cc1: cc1.degradation.length },
      gapKeys: observedGaps };
  });
}

test('parity matrix inspection export (DSH_PARITY_REPORT=1)', function () {
  if (process.env.DSH_PARITY_REPORT) console.log('[dsh-parity-matrix]\n' + JSON.stringify(MATRIX, null, 1));
});

test('parity matrix coverage: the always-on legacy surfaces are exercised as gaps', function () {
  for (const key of GAP_COVERAGE_FLOOR) {
    assert.ok(observedGapUnion.has(key), 'expected gap surface missing from the matrix: ' + key);
  }
});

// ---- regression pins for the (b) findings this harness produced ----

test('fix b1 pin: a short background source is delivered verbatim, never as a digest', function () {
  const current = { id: 'private:cur', type: 'private', role: 'user', use: 'discussion', at: '2026-11-01T07:00:00Z', revision: 'rc',
    text: '帮我看看最近的聊天，想想要怎么回她。' };
  const small = { id: 'qq:small', type: 'qq', role: 'contact', use: 'discussion', at: '2026-10-31T01:00:00Z', revision: 'r0',
    text: '周末有安排吗？' };
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 48000,
    requestByteBudget: Number.POSITIVE_INFINITY, measureRequest: function () { return 0; } });
  const result = admission.compileContext({ asOf: '2026-11-01T08:00:00Z', purpose: 'discussion',
    request: { text: current.text, feedbackTargets: [], goalText: '' }, current, intentSource: current,
    candidateSources: [small], budget: authority });
  const entry = result.admissions.find(function (item) { return item.id === small.id; });
  assert.equal(entry.tier, 'verbatim', 'rank order must win even when marker metadata outweighs the verbatim body');
  assert.equal(result.degradation.filter(function (step) { return step.appliedTo === small.id; }).length, 0,
    'no bogus degradation entry for an undegraded source');
  assert.equal(result.payload.sources.find(function (source) { return source.id === small.id; }).text, small.text,
    'the whole verbatim body is delivered');
});

test('fix b1 pin: plan upgrades stay rank-ordered when the verbatim rung is smaller than the held rung', function () {
  const source = { id: 'private:tiny', type: 'private', role: 'user', use: 'discussion', at: '2026-10-31T01:00:00Z', revision: 'r1', text: '很短的原始记录。' };
  const sizes = admission.tierSizesFor(source);
  const held = sizes.find(function (size) { return size.tier === 'marker'; });
  const verbatim = sizes.find(function (size) { return size.tier === 'verbatim'; });
  assert.ok(held.bytes > verbatim.bytes, 'fixture precondition: marker metadata outweighs the verbatim body');
  const authority = new BudgetAuthority({ purpose: 'answer_context', payloadByteBudget: 48000,
    requestByteBudget: Number.POSITIVE_INFINITY, measureRequest: function () { return 0; } });
  const plan = authority.plan([{ id: source.id, kind: 'background', floorTier: 'marker',
    lookupHandle: { sourceIds: [source.id] }, tierSizes: sizes }]);
  const entry = plan.admissions.find(function (item) { return item.id === source.id; });
  assert.equal(entry.tier, 'verbatim', 'pass 2 must take the highest fitting RANK, not be blocked by a byte guard');
});

test('fix b2 pin: materialRequirements reports an admitted feedback target as delivered', function (t) {
  const store = new Store(':memory:');
  t.after(function () { store.close(); });
  const records = [message(75000, '这周末一起去看展吗？', 5)];
  store.add(scope, records);
  store.setGoal(scope, '和她自然交流。');
  const answer = store.appendTurn(scope, { role: 'assistant', kind: 'draft', text: '上一版草稿：周六下午见面不错。',
    suggestions: [{ style: '直白', text: '周六下午我方便。' }] });
  store.addFeedback(scope, { text: '上一次的回复语气太正式，重新组织一下。', targetRef: { kind: 'artifact', artifactRef: answer.artifactRef },
    expectedDigest: store.experiences.artifact(scope, answer.artifactRef).bodyDigest });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '上一次的回复不对，重新组织一下。' });
  const feedbackRecord = store.getCompanion(scope).feedback.slice(-1)[0];
  const { sourceSnapshot } = require('../src/context/source-snapshot.cjs');
  const snapshot = sourceSnapshot({ scope, records: store.messages(scope), companion: store.getCompanion(scope), turn });
  // realShim: the module-level export is patched for the matrix runs above.
  const result = realShim({
    options: { asOf: turn.createdAt, purpose: 'discussion', byteBudget: 48000,
      budget: { measure: function () { return 0; }, requestByteBudget: 256000 }, replyMessageIds: [],
      feedbackTargets: [{ sourceId: feedbackRecord.sourceId, feedbackId: feedbackRecord.id }] },
    snapshot, candidates: { intentSource: snapshot.current } });
  assert.equal(result.payload.contextRequest.intentClass, 'feedback_continue', 'fixture classifies as feedback continuation');
  const outcome = result.payload.materialRequirements.outcomes.find(function (item) { return item.materialClass === 'feedback_target'; });
  assert.ok(outcome, 'the feedback_target outcome row exists');
  assert.equal(outcome.status, 'delivered', 'the admitted feedback source must be reported delivered');
  assert.ok(outcome.sources.some(function (source) { return source.sourceId === feedbackRecord.sourceId; }), 'the outcome names its source');
});

test('fix b3 pin: the shim authority enforces the serialized-request cap, not an invented infinite one', function (t) {
  const { contextBudget } = require('../src/context/budget-manifest.cjs');
  const settings = { model: 'synthetic', assistantRequestBytes: 20000 };
  const budget = contextBudget(settings, 48000);
  assert.ok(budget.requestByteBudget < Number.POSITIVE_INFINITY, 'fixture precondition: a finite request cap exists');
  const store = new Store(':memory:');
  t.after(function () { store.close(); });
  const records = Array.from({ length: 10 }, function (_, i) { return message(76000 + i, '预算压测消息' + i + '。'.repeat(80), 30 - i, i % 2 === 0); });
  store.add(scope, records);
  store.setGoal(scope, '和她自然交流。');
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '帮我总结这批消息的要点。' });
  const { sourceSnapshot } = require('../src/context/source-snapshot.cjs');
  const snapshot = sourceSnapshot({ scope, records: store.messages(scope), companion: store.getCompanion(scope), turn });
  // realShim: the module-level export is patched for the matrix runs above.
  const result = realShim({
    options: { asOf: turn.createdAt, purpose: 'discussion', byteBudget: 48000,
      budget: { measure: budget.measure, requestByteBudget: budget.requestByteBudget }, replyMessageIds: [], feedbackTargets: [] },
    snapshot, candidates: { intentSource: snapshot.current } });
  assert.ok(result.payload.sources.length > 0, 'the compiler produced a real delivery for the cap check');
  assert.ok(budget.measure(result.payload) <= budget.requestByteBudget,
    'the compiled payload respects the serialized-request ceiling');
});
