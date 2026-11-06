'use strict';
// Deterministic coverage for declared-arrangement material in invitation-type
// answers. Root cause fixed here: the latest prior private source that exceeds
// the verbatim admission cap previously disappeared from delivered evidence
// until a model lookup happened to read the right range, so a user-declared
// availability ("周六三点半以后我有空，也愿意一起去") never participated and the
// model re-asked the user for what was already declared. Fictional fixtures,
// no frozen eval import: the shapes mirror the reviewed failure family only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext } = require('../src/assistant-context.cjs');
const { digestSource, declarationSentences } = require('../src/context/evidence-digest.cjs');
const { helpSystemForPayload } = require('../src/help-behavior.cjs');
const { scope, raw } = require('./fixtures/native.cjs');

function incoming(id, text, at) {
  return normalize(raw(String(id), false, { msgTime: String(Math.floor(Date.parse(at) / 1000)),
    elements: [{ textElement: { content: text } }] }), scope);
}
function entryParagraph(i) {
  return '第' + i + '项是物件' + i + '。我到整理桌时，师傅已经把它放好。我负责照着登记纸核对这件东西的说明，不负责估价。我们把能确认的现象按原话记下来，不补没有来源的往事。';
}
// Mirrors the reviewed note: numbered entries plus an unmarked schedule
// paragraph in the middle of the document body.
function declarationNote(extraEntries) {
  const head = '这是留给自己的原始手记，方便和你商量真实近况。里面有他人的登记信息，不能自动变成对外可说的故事。';
  const middle = '这周末的安排我也在这里给你说清楚：周六三点半以后我有空，也愿意和她一起去看旧物展；之前还有一件自己的事，不需要拿去和她解释。';
  const parts = [head];
  for (let i = 1; i <= (extraEntries || 8); i++) parts.push(entryParagraph(i));
  parts.push(middle);
  for (let i = (extraEntries || 8) + 1; i <= (extraEntries || 8) + 6; i++) parts.push(entryParagraph(i));
  return parts.join('\n');
}
function plainNote(extraEntries) {
  const parts = ['这是留给自己的原始手记，方便和你商量真实近况。'];
  for (let i = 1; i <= (extraEntries || 14); i++) parts.push(entryParagraph(i));
  return parts.join('\n');
}
function scenario(t, { noteText, invitation = '你前阵子说帮旧物展录了点什么？周六下午能一起去看看吗？', budget = 48000 } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.add(scope, [incoming(9001, invitation, '2026-10-01T18:00:00+08:00')]);
  store.setGoal(scope, '和她自然交流，分享自己的真实近况，也找到双方愿意做的事。');
  const note = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: noteText, createdAt: '2026-09-30T18:00:00+08:00' });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: '她问到这些了，帮我回一下。', createdAt: '2026-10-01T18:10:00+08:00' });
  return { store, note, args: { scope, records: store.messages(scope), companion: store.getCompanion(scope), turn,
    purpose: 'discussion', coverage: { status: 'partial', pages: 1 }, requestId: 'declared-arrangement-case',
    byteBudget: budget, asOf: '2026-10-01T18:10:00+08:00',
    invocation: { origin: 'user', trigger: 'private_request', requestedPurpose: 'discussion' }, store } };
}

test('digest surfaces a declared arrangement hidden inside an entry body, verbatim with an exact range', () => {
  const text = declarationNote(8);
  const source = { id: 'private:note', type: 'private', role: 'user', use: 'discussion',
    at: '2026-09-30T18:00:00+08:00', revision: 'r1', text };
  const view = digestSource(source);
  assert.ok(view, 'a structured long note yields a digest view');
  assert.equal(view.delivery.status, 'digest');
  const declarations = view.digest.declarations || [];
  const declaration = declarations.find(item => item.sentence.includes('周六三点半以后我有空'));
  assert.ok(declaration, 'the mid-document declared arrangement is a digest line of its own');
  // Verbatim and exact: the range slices the original precisely, no rewriting.
  assert.equal(text.slice(declaration.start, declaration.end), declaration.sentence);
  // Copy-ready array form (stream B round 4 protocol): the model copies the
  // handle verbatim instead of assembling identifiers.
  assert.deepEqual(declaration.lookup.sourceIds, [source.id]);
  assert.equal(declaration.lookup.offset, declaration.start);
  assert.equal(declaration.lookup.maxChars, declaration.end - declaration.start);
  // The declaration is not an entry first sentence: the entry covering it
  // leads with its own numbered heading, which is exactly why digest lines
  // alone could not surface it before.
  const covering = view.digest.entries.find(item => item.start <= declaration.start && item.end >= declaration.end);
  if (covering) assert.notEqual(covering.sentence, declaration.sentence);
  assert.ok(Buffer.byteLength(JSON.stringify(view), 'utf8') < 6000, 'the digest stays bounded');
});

test('notes without declared availability produce no availability declarations', () => {
  const text = plainNote(14);
  assert.deepEqual(declarationSentences(text), []);
  const view = digestSource({ id: 'private:plain', type: 'private', role: 'user', use: 'discussion',
    at: '2026-09-30T18:00:00+08:00', revision: 'r1', text });
  assert.ok(view, 'the structural digest still exists');
  assert.equal(view.digest.declarations, undefined, 'no availability is invented or asserted');
});

test('invitation answers receive the declared availability as delivered evidence', t => {
  const noteText = declarationNote(180);
  assert.ok(Buffer.byteLength(noteText, 'utf8') > 38000, 'fixture mirrors the reviewed case: the whole source cannot fit the default budget');
  const { note, args } = scenario(t, { noteText });
  const context = buildContext(args);
  const delivered = context.payload.sources.find(source => source.id === 'private:' + note.id);
  assert.ok(delivered, 'the oversized latest private source is no longer dropped from evidence');
  assert.equal(delivered.delivery.status, 'digest');
  const declaration = (delivered.digest.declarations || []).find(item => item.sentence.includes('周六三点半以后我有空'));
  assert.ok(declaration, 'the declared Saturday availability reaches the model verbatim');
  assert.ok(declaration.sentence.includes('也愿意和她一起去看旧物展'), 'the declared willingness travels with the time');
  assert.equal(delivered.digest.declarationRule.includes('逐字原句'), true, 'the declaration lines are labeled as verbatim navigation, not permission');
  // The invitation itself stays whole, and the complete original stays
  // retrievable: honest degradation, never a silent replacement.
  const invitation = context.payload.sources.find(source => source.type === 'qq');
  assert.equal(invitation.text, '你前阵子说帮旧物展录了点什么？周六下午能一起去看看吗？');
  assert.equal(context.payload.deferredDiscussion.availability, 'needs_lookup');
  assert.ok(context.payload.deferredDiscussion.turnIds.includes(note.id));
  assert.ok(context.manifest.degradation.some(entry => entry.step === 'deterministic_digest' && entry.appliedTo === delivered.id),
    'the applied ladder step stays explainable on the manifest');
});

test('a conflicting declared availability is still delivered verbatim, never smoothed away', t => {
  const conflicting = declarationNote(180).replace('周六三点半以后我有空，也愿意和她一起去看旧物展；', '周六全天都没空，去不了旧物展；');
  const { note, args } = scenario(t, { noteText: conflicting });
  const context = buildContext(args);
  const delivered = context.payload.sources.find(source => source.id === 'private:' + note.id);
  assert.ok(delivered && delivered.digest, 'the declaration-bearing note is still digested');
  const declaration = (delivered.digest.declarations || []).find(item => item.sentence.includes('周六全天都没空'));
  assert.ok(declaration, 'an unavailability declaration reaches the model verbatim so the mismatch is visible');
});

test('without a declared availability the context asserts nothing and the clarify path stays intact', t => {
  const noteText = plainNote(190);
  assert.ok(Buffer.byteLength(noteText, 'utf8') > 38000, 'fixture mirrors the reviewed case size so the whole source cannot fit');
  const { note, args } = scenario(t, { noteText });
  const context = buildContext(args);
  const delivered = context.payload.sources.find(source => source.id === 'private:' + note.id);
  // Without a declared arrangement the bridge stays out: the oversized note
  // keeps the whole-source lookup contract instead of a proactive digest.
  assert.equal(delivered, undefined, 'no declaration means no proactive admission and no asserted availability');
  const availabilityAnywhere = JSON.stringify(context.payload).includes('有空');
  assert.equal(availabilityAnywhere, false, 'the payload nowhere claims availability the user never declared');
  const guidance = helpSystemForPayload({ purpose: 'discussion', generationOrigin: 'private_discussion' });
  assert.ok(guidance.includes('真缺关键事实才clarification'),
    'asking for confirmation remains the default when nothing was declared');
  assert.ok(!JSON.stringify(context.payload).includes('直接采用并给可发送的接受与时间'),
    'the adoption rule rides only with actual declarations, never alone');
});

test('a small latest private source is still admitted verbatim, digest bridge untouched', t => {
  const text = '周六三点半以后我有空，也愿意和她一起去看旧物展。';
  const { note, args } = scenario(t, { noteText: text });
  const context = buildContext(args);
  const delivered = context.payload.sources.find(source => source.id === 'private:' + note.id);
  assert.ok(delivered, 'the small note stays in delivered evidence');
  assert.equal(delivered.text, text, 'below the verbatim cap the complete original is delivered, not digested');
  assert.equal(delivered.digest, undefined);
});


// --- Replay-pipeline shape -------------------------------------------------
// The live divergence (goal round 001d candidate-live-3b): prefix memory
// preparation commits relationship claims grounded on the oversized private
// note; includeGrounded then replaced the declaration digest with a head
// range (0-1810/15617), so the declaration never reached the model. These
// tests drive the real replay session (memory rebuild + assist) instead of
// calling buildContext directly.
const { createReplaySession, makeSyntheticTransport } = require('../scripts/eval-runtime-session.cjs');
const path = require('node:path');

function replayPacket(settings, result) {
  return new Response(JSON.stringify({ model: settings.model,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }), { status: 200 });
}
async function replayScenario(t, { noteText }) {
  const settings = { model: 'synthetic-replay-only', baseUrl: 'http://fixture.invalid/v1', anonymous: true, auto: false };
  const captured = [];
  const fixture = makeSyntheticTransport();
  const transport = async (url, args) => {
    const body = JSON.parse(args.body);
    const content = body.messages && body.messages[1] && body.messages[1].content;
    const parsed = typeof content === 'string' ? JSON.parse(content) : {};
    const input = parsed.originalInput || parsed;
    if (input.batchId) {
      // Mirror the observed live memory model: grounded claims exist for the
      // note either way; the availability claim only when it was declared.
      const claims = [];
      for (const source of input.sources || []) if (source.type === 'private') {
        claims.push({ subject: 'self', aspect: 'recent_context', text: '用户自述整理过一批物件说明。',
          assertionKind: 'reported', epistemicStatus: 'supported', applicabilityKind: 'unspecified', attribution: 'user_report',
          sourceIds: [source.id], topicKeys: ['旧物展'] });
        if ((source.text || '').includes('周六三点半以后我有空'))
          claims.push({ subject: 'self', aspect: 'coordination', text: '用户表示，原消息所说的这周末，周六三点半以后有空。',
            assertionKind: 'stated', epistemicStatus: 'supported', applicabilityKind: 'temporary', attribution: 'speaker',
            context: '2026-09-30的私下说明；这是用户的可用时间，不是双方已经确认的约定。', sourceIds: [source.id], topicKeys: ['周末安排', '旧物展'] });
      }
      return replayPacket(settings, { batchId: input.batchId, reviewedAll: true,
        relationshipPatch: { claims, events: [], retire: [] }, episodes: [] });
    }
    if (['discussion', 'reply', 'draft', 'draft_prepare'].includes(input.purpose)) captured.push(input);
    return fixture(url, args);
  };
  const session = await createReplaySession({ sourceRoot: path.resolve(__dirname, '..'), asOf: '2026-10-01T18:05:00+08:00',
    history: [{ id: 'q1', at: '2026-10-01T18:00:00+08:00', speaker: 'contact', text: '你前阵子说帮旧物展录了点什么？周六下午能一起去看看吗？' }],
    goal: '和她自然交流，分享自己的真实近况，也找到双方愿意做的事。', settings, transport });
  t.after(() => session.close());
  await session.restorePrivate([{ id: 'ls-u1', at: '2026-09-30T18:00:00+08:00', role: 'user', text: noteText }]);
  for (let batch = 0; session.snapshot().memoryStatus && session.snapshot().memoryStatus.pending > 0; batch++) {
    assert.ok(batch < 16, 'prefix memory preparation must finish within the declared checkpoints');
    await session.post('/api/memory-maintain');
  }
  await session.post('/api/assistant', { text: '她问到这些了，帮我回一下。', purpose: 'discussion', taskId: 'declared-arrangement-replay' });
  return { captured };
}

test('replay pipeline: memory-prepared claims keep the declared arrangement in assist evidence', async t => {
  const { captured } = await replayScenario(t, { noteText: declarationNote(180) });
  assert.ok(captured.length >= 1, 'the assist call reached the model');
  const planning = captured.find(payload => (payload.sources || []).some(source => source.type === 'private' && (source.digest || source.delivery)));
  assert.ok(planning, 'a planning payload carried the private note');
  const note = planning.sources.find(source => source.type === 'private');
  // Before the wiring fix this was a 0-~1860 head range: the memory-grounding
  // admission replaced the digest, hiding the mid-document declaration.
  assert.equal(note.delivery.status, 'digest', 'the oversized note stays a digest, not a head range');
  const declaration = (note.digest.declarations || []).find(item => item.sentence.includes('周六三点半以后我有空'));
  assert.ok(declaration, 'the declared Saturday availability reaches the model verbatim');
  assert.ok(JSON.stringify(planning).includes('declarationRule'), 'the adoption rule rides with the declarations');
  const invitation = planning.sources.find(source => source.type === 'qq');
  assert.equal(invitation.text, '你前阵子说帮旧物展录了点什么？周六下午能一起去看看吗？');
});

test('replay pipeline: grounding without declarations still degrades to a bounded head range', async t => {
  const { captured } = await replayScenario(t, { noteText: plainNote(180) });
  const planning = captured.find(payload => (payload.sources || []).some(source => source.type === 'private' && (source.digest || source.delivery)));
  assert.ok(planning, 'a planning payload carried the private note');
  const note = planning.sources.find(source => source.type === 'private');
  assert.equal(note.delivery.status, 'partial', 'the unchanged grounding path still delivers an explicit range');
  assert.equal(note.delivery.start, 0);
  assert.ok(note.delivery.end < note.delivery.originalCharLength, 'the oversized original stays honestly partial with a continuation handle');
  assert.equal(JSON.stringify(planning).includes('declarationRule'), false, 'no adoption rule appears without declarations');
});

test('the adoption rule travels with the declarations, not as free-floating guidance', () => {
  const { digestSource } = require('../src/context/evidence-digest.cjs');
  const view = digestSource({ id: 'private:rule', type: 'private', role: 'user', use: 'discussion',
    at: '2026-09-30T18:00:00+08:00', revision: 'r1', text: declarationNote(4) });
  assert.ok(view.digest.declarations.length >= 1);
  const rule = view.digest.declarationRule;
  assert.ok(rule.includes('与来信邀约一致时直接采用并给可发送的接受与时间'), 'adopt plus sendable acceptance with time');
  assert.ok(rule.includes('不把已声明意愿变成核对问句'), 'do not re-ask a declared willingness');
  assert.ok(rule.includes('未声明、过期或冲突才澄清'), 'the clarify branch is bound to its conditions');
  assert.ok(rule.includes('仅导航非许可'), 'navigation is never disclosure permission');
  // Without declarations the rule must not appear anywhere in the prompt lane.
  const plain = digestSource({ id: 'private:plain-rule', type: 'private', role: 'user', use: 'discussion',
    at: '2026-09-30T18:00:00+08:00', revision: 'r1', text: plainNote(20) });
  assert.equal(plain.digest.declarations, undefined);
  assert.equal(plain.digest.declarationRule, undefined);
});
