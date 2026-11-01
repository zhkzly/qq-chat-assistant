'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { buildContext } = require('../src/assistant-context.cjs');
const { parseAssistant, prepareAssistantRequest } = require('./fixtures/assistant-protocol.cjs');
const { scope } = require('./fixtures/native.cjs');

// Legal persisted consumer shapes only. These are synthetic budget boundaries,
// not a reproduction of the user's screenshot or private records.
function fixture(t, { latestText = '最新完整私下回复。'.repeat(600), byteBudget = 48000 } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const targets = [];
  for (let index = 0; index < 4; index++) {
    const user = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: `过去第${index}次独立讨论。` });
    const answer = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', requestId: `old-${index}`,
      text: `OLD_EVALUATED_${index}_` + 'X'.repeat(4929), sourceIds: [`private:${user.id}`] });
    assert.ok(answer.text.length <= 6000, 'old evaluated responses fit the actual parser limit');
    parseAssistant({ kind: 'discussion', text: answer.text }, 'discussion');
    // Structural adaptation (F1 switchover): explicit artifact feedback pins
    // its version with the expected digest; bare references no longer bind.
    const feedback = store.addFeedback(scope, { text: `仅评价过去第${index}次帮助：当时太正式。`, targetRef: { kind: 'artifact', artifactRef: answer.artifactRef }, expectedDigest: store.experiences.artifact(scope, answer.artifactRef).bodyDigest });
    targets.push(store.experiences.hydrateFeedback(scope, feedback.id));
  }
  const latest = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '这次请保留轻松的表达方式，不要连续追问。' });
  parseAssistant({ kind: 'discussion', text: latestText }, 'discussion');
  const acknowledgment = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: latestText, sourceIds: [`private:${latest.id}`] });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '接着刚才的意思帮我商量。' });
  const args = { scope, records: [], companion: store.getCompanion(scope), turn, purpose: 'discussion', requestId: 'synthetic-overflow',
    availableSources: store.memorySources(scope), coverage: { status: 'empty' }, byteBudget, settings: { model: 'synthetic', assistantRequestBytes: 64000 } };
  return { store, targets, latest, acknowledgment, args };
}
function assertCompleteLatest(context, latest, acknowledgment) {
  assert.equal(context.payload.sources.find(source => source.id === `private:${latest.id}`).text, latest.text);
  assert.equal(context.payload.privateConversation.find(turn => turn.id === acknowledgment.id).text, acknowledgment.text);
  assert.ok(context.manifest.sourceIds.includes(`private:${latest.id}`));
}

test('incidental old feedback cannot displace an otherwise feasible complete latest private exchange', t => {
  const { targets, latest, acknowledgment, args } = fixture(t);
  const without = buildContext(args); assertCompleteLatest(without, latest, acknowledgment);
  const withOldFeedback = buildContext({ ...args, experienceContext: { scope, cases: [], adaptations: [], evaluationTargets: targets } });
  assertCompleteLatest(withOldFeedback, latest, acknowledgment);
  assert.ok(withOldFeedback.manifest.serializedTextRequestBytes <= 64000);
  assert.ok(withOldFeedback.manifest.inputBytes <= 48000);
  assert.ok((withOldFeedback.payload.feedbackTargets || []).filter(item => !item.missing).length < targets.length, 'optional full targets use the remaining budget');
  for (const item of withOldFeedback.payload.feedbackTargets || []) if (!item.missing)
    assert.equal(item.target.body, targets.find(target => target.feedback.id === item.feedback.id).target.body, 'optional artifacts are whole or explicitly unavailable');
});

test('current canonical and explicitly selected feedback targets retain the exact evaluated artifact', t => {
  for (const selection of ['canonical','reference','direct']) {
    const { targets, latest, acknowledgment, args } = fixture(t, { latestText: '最新完整私下回复。'.repeat(120) });
    const chosen = targets[0];
    const reference = args.companion.turns.find(turn => turn.feedbackId === chosen.feedback.id);
    const options = selection === 'canonical' ? { intentSourceId: chosen.feedback.sourceId }
      : selection === 'reference' ? { sourceTurnIds: [reference.id] } : { feedbackTargets: [chosen] };
    const context = buildContext({ ...args, ...options, experienceContext: { scope, cases: [], adaptations: [], evaluationTargets: [...targets].reverse() } });
    const delivered = context.payload.feedbackTargets.find(item => item.feedback.id === chosen.feedback.id);
    assert.equal(delivered.missing, false); assert.equal(delivered.target.body, chosen.target.body);
    assert.deepEqual(delivered.target.artifactRef, chosen.target.artifactRef); assertCompleteLatest(context, latest, acknowledgment);
    assert.ok(context.manifest.sourceIds.includes(chosen.feedback.sourceId));
  }
});

test('a protected full feedback target that cannot fit degrades to an explicit missing marker, never silently', t => {
  const { targets, args } = fixture(t, { latestText: '最新完整私下回复。'.repeat(80), byteBudget: 7000 });
  assert.doesNotThrow(() => buildContext(args));
  // The budget ladder no longer dead-ends on a required feedback target: the
  // answer proceeds with an explicit missing marker and reason, and the
  // degradation stays recorded and reviewable on the manifest.
  const degraded = buildContext({ ...args, intentSourceId: targets[0].feedback.sourceId,
    experienceContext: { scope, cases: [], adaptations: [], evaluationTargets: [targets[0]] } });
  const marked = (degraded.payload.feedbackTargets || []).find(item => item.feedback.id === targets[0].feedback.id);
  assert.ok(marked, 'the feedback entry itself is still delivered');
  assert.equal(marked.missing, true);
  assert.ok(typeof marked.reason === 'string' && marked.reason.includes('未能放入本次上下文'));
  assert.ok(degraded.manifest.degradation?.some(entry => entry.step === 'feedback_target_missing_marker' && entry.appliedTo === targets[0].feedback.sourceId));
});

test('topic wire projection removes repeated hashes while source CAS and field bindings remain exact', t => {
  const { store, args } = fixture(t, { latestText: '最新完整私下回复。'.repeat(80) });
  const actor = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '这次想确认是否方便一起散步。', requestId: 'topic-create' });
  const sources = store.memorySources(scope), companion = store.getCompanion(scope), ids = sources.filter(source => source.type === 'private').map(source => source.id);
  const receipt = store.applyTopicPatch(scope, { operation: 'create', objective: '确认是否方便一起散步', direction: '轻松直接确认', constraints: ['不追加连续无关问题'],
    purposeSourceIds: ids, intentQuote: actor.text, interpretationStatus: 'user_stated' }, { baseRevision: companion.revision, baseTopicVersion: companion.topics.version,
    currentSourceId: `private:${actor.id}`, origin: 'private_discussion', requestId: actor.requestId, sourceIds: sources.map(source => source.id),
    sourceRevisions: Object.fromEntries(sources.map(source => [source.id, source.revision])) });
  assert.equal(receipt.applied, true, receipt.detail || receipt.reason);
  const original = store.topicView(scope).active;
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '沿用这个方向。' });
  const availableSources = store.memorySources(scope);
  const context = buildContext({ ...args, turn, companion: store.getCompanion(scope), availableSources, topicContext: store.topicView(scope) });
  const projected = context.payload.topicContext.active;
  assert.equal(projected.objective, original.objective); assert.equal(projected.direction, original.direction);
  assert.deepEqual(projected.constraints, original.constraints); assert.deepEqual(projected.sourceIds, original.sourceIds);
  for (const [field, binding] of Object.entries(original.purposeBindings)) {
    assert.deepEqual(projected.purposeBindings[field].sourceIds, binding.sourceIds);
    assert.equal(projected.purposeBindings[field].sourceRevisions, undefined);
  }
  for (const field of ['sourceRevisions','purposeSourceRevisions','observationSourceRevisions','lifecycleSourceRevisions']) assert.equal(projected[field], undefined);
  for (const id of original.sourceIds) {
    const source = availableSources.find(item => item.id === id);
    assert.equal(context.manifest.sourceRevisions[id], source.revision);
    assert.equal(context.payload.sources.find(item => item.id === id).revision, source.revision, 'source consumers keep their existing contract');
  }
  assert.deepEqual(store.topicView(scope).active, original, 'model projection must not alter persistent provenance');
  const stale = structuredClone(store.topicView(scope)); stale.active.sourceRevisions[original.sourceIds[0]] = 'stale';
  assert.equal(buildContext({ ...args, turn, companion: store.getCompanion(scope), availableSources, topicContext: stale }).payload.topicContext.active, null);
  assert.ok(prepareAssistantRequest(args.settings, context.payload).requestBytes <= 64000);
});
