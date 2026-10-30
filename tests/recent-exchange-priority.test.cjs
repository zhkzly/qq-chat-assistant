'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext, buildDraftContext } = require('../src/assistant-context.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const { withCurrentDraftControls } = require('./fixtures/draft-controls.cjs');

// Shapes come from the persisted Store/native fixture contracts. All text is fictional.
function message(id, own, text, timestamp, overrides = {}) {
  return normalize(raw(String(id), own, { msgTime: String(timestamp), elements: [{ textElement: { content: text } }], ...overrides }), scope);
}
function fixture(t, options = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const old = Array.from({ length: 24 }, (_, i) => message(20000 + i, i % 2 === 0, `old-${i}:` + '旧'.repeat(800), 1700000000 + i));
  const recent = options.recent || Array.from({ length: 8 }, (_, i) => message(30000 + i, i % 2 === 0, `current-${i}:` + '新'.repeat(170), 1701000000 + i));
  store.add(scope, [...old, ...recent]);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Help me understand and respond to the current interaction.' });
  const relationshipContext = { version: 1, claims: old.map((m, i) => ({ id: `claim-${i}`, text: `past fact ${i}`, sourceIds: [`qq:${m.messageId}`], subject: 'contact', assertionKind: 'reported', reviewComplete: true })), events: [], activities: [], coverage: {} };
  const args = { scope, records: store.messages(scope), companion: store.getCompanion(scope), turn, requestId: 'synthetic-recent-priority', purpose: 'reply', coverage: { status: 'partial' },
    byteBudget: 48000, settings: { model: 'synthetic', assistantRequestBytes: 120000 }, relationshipContext };
  return { store, old, recent, args };
}
const delivered = context => new Set(context.payload.sources.map(source => source.id));
function assertRecent(context, records) {
  const ids = delivered(context);
  for (const record of records) assert.ok(ids.has(`qq:${record.messageId}`), `current source ${record.messageId} must precede optional old closure`);
  assert.deepEqual(context.payload.taskContext.recentExchange.map(m => m.sourceId), records.map(m => `qq:${m.messageId}`));
  for (const entry of context.payload.taskContext.recentExchange) {assert.equal(entry.text,undefined);assert.ok(context.payload.sources.find(s => s.id === entry.sourceId)?.text);}
}

test('current multi-turn exchange precedes large legal old relationship evidence closures', t => {
  const { recent, args } = fixture(t);
  const context = buildContext({ ...args, settings: { ...args.settings, assistantRequestBytes: 64000 }, replyMessageIds: [recent.at(-1).messageId] });
  assertRecent(context, recent);
  assert.ok(context.manifest.inputBytes <= args.byteBudget);
  assert.equal(context.payload.taskContext.recentContext.selection, 'bounded_actual_neighborhoods');
  assert.ok(context.payload.taskContext.recentContext.limits.maxMessages < 60);
  assert.ok(context.payload.taskContext.latestActual.ageMs >= 0);
  assert.equal(context.payload.taskContext.latestActual.ageMs, Date.parse(context.payload.asOf) - recent.at(-1).timestamp);
  assert.ok(context.manifest.serializedTextRequestBytes <= 64000);
  const prepared = buildDraftContext(context, withCurrentDraftControls({ intent: 'reply', quotes: [], style: 'natural' }, context.payload), { ...args, settings: args.settings });
  assertRecent(prepared, recent);
  const rebuilt = context.rebuildForRequest(payload => Buffer.byteLength(JSON.stringify(payload)) + 30000);
  assertRecent(rebuilt, recent);
});

test('recent context has a real message count boundary and counts metadata within the byte allowance', t => {
  const recent = Array.from({ length: 70 }, (_, i) => message(34000 + i, i % 2 === 0, `Synthetic current message ${i}.`, 1701000000 + i));
  const { args } = fixture(t, { recent });
  const context = buildContext(args);
  assert.equal(context.payload.taskContext.recentExchange.length, 24);
  assert.ok(context.payload.taskContext.recentContext.windows.some(window => window.boundaryBefore === 'count_limit'));
  assert.ok(context.manifest.recentQQContext.initialAdditionalBytes <= context.manifest.recentQQContext.limits.maxAdditionalBytes);
  const manyAnchors = buildContext({ ...args, replyMessageIds: ['34000', '34010', '34020', '34030', '34040', '34050', '34060', '34069'], imageMessageIds: ['34005', '34025', '34045'] });
  assert.ok(manyAnchors.payload.taskContext.recentExchange.length <= 24);
  assert.ok(manyAnchors.manifest.recentQQContext.initialAdditionalBytes <= manyAnchors.manifest.recentQQContext.limits.maxAdditionalBytes);
  for (const window of manyAnchors.payload.taskContext.recentContext.windows) for (const id of window.sourceIds) assert.ok(delivered(manyAnchors).has(id));
});

test('optional current context yields to a necessary complete private exchange without a new overflow', t => {
  const { store, args, recent } = fixture(t);
  const prior = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Keep this complete current clarification.' });
  const acknowledgment = store.appendTurn(scope, { role: 'assistant', kind: 'discussion', text: 'A'.repeat(5000) });
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Continue from this clarification.' });
  const context = buildContext({ ...args, companion: store.getCompanion(scope), turn, byteBudget: 18000 });
  assert.equal(context.payload.privateConversation.find(entry => entry.id === acknowledgment.id).text, acknowledgment.text);
  assert.ok(delivered(context).has(`private:${prior.id}`));
  for (const record of recent.slice(-2)) assert.equal(context.payload.sources.find(source => source.id === `qq:${record.messageId}`).text, record.text);
  assert.ok(context.manifest.inputBytes <= 18000);
});

test('selected older focus and attached image receive bounded neighboring context without merging sessions', t => {
  const base = 1701000000;
  const recent = [message(31000, false, 'Before the image.', base), message(31001, true, '[图片]', base + 1), message(31002, false, 'Response to this image.', base + 2),
    message(31003, true, 'An unrelated later session.', base + 7200), message(31004, false, 'Latest response.', base + 7201)];
  const { args } = fixture(t, { recent });
  const context = buildContext({ ...args, replyMessageIds: ['31001'], imageMessageIds: ['31001'] });
  const ids = delivered(context);
  for (const record of recent) assert.ok(ids.has(`qq:${record.messageId}`));
  const windows = context.payload.taskContext.recentContext.windows;
  assert.ok(windows.some(window => window.reasons.includes('image') && window.sourceIds.includes('qq:31000') && window.sourceIds.includes('qq:31002')));
  assert.ok(windows.some(window => window.reasons.includes('reply_focus')));
  assert.ok(context.payload.taskContext.recentContext.gaps.some(gap => gap.gapMs >= 7200000 - 2000));
});

test('unselected history across a long gap is not mislabeled as the recent interaction', t => {
  const recent = [message(32000, false, 'Yesterday context.', 1701000000), message(32001, true, 'A different session.', 1701007200), message(32002, false, 'Current response.', 1701007201)];
  const { args } = fixture(t, { recent });
  const context = buildContext(args);
  assert.deepEqual(context.payload.taskContext.recentExchange.map(m => m.sourceId), ['qq:32001', 'qq:32002']);
  assert.ok(context.payload.taskContext.recentContext.windows.some(window => window.boundaryBefore === 'time_gap'));
});

test('oversized optional earlier message does not cause overflow or silently bridge its missing content', t => {
  const recent = [message(33000, false, 'Earlier context.', 1701000000), message(33001, true, '巨'.repeat(16000), 1701000001),
    message(33002, false, 'A short intervening update.', 1701000002), message(33003, true, 'The current self message.', 1701000003), message(33004, false, 'The current contact response.', 1701000004)];
  const { args } = fixture(t, { recent });
  const context = buildContext(args);
  const ids = delivered(context);
  assert.ok(ids.has('qq:33003') && ids.has('qq:33004'));
  assert.ok(!ids.has('qq:33001'));
  assert.ok(context.manifest.inputBytes <= args.byteBudget);
  assert.ok(context.payload.taskContext.recentContext.windows.some(window => window.omittedMessageCount > 0));
  assert.ok(context.payload.taskContext.recentContext.gaps.some(gap => gap.omittedAccessibleMessageCount > 0));
});

test('recalled, excluded and foreign sources cannot enter the priority window', t => {
  const { store, recent, args } = fixture(t);
  store.forgetSource(scope, `qq:${recent[1].messageId}`);
  const records = store.messages(scope).map(record => record.messageId === recent[2].messageId ? { ...record, recalled: true } : record);
  const foreign = { ...recent[3], messageId: '39999', peerUid: 'different-contact', text: 'FOREIGN_MUST_NOT_APPEAR' };
  const context = buildContext({ ...args, records: [...records, foreign], availableSources: store.memorySources(scope) });
  assert.ok(!delivered(context).has(`qq:${recent[1].messageId}`));
  assert.ok(!delivered(context).has(`qq:${recent[2].messageId}`));
  assert.ok(!JSON.stringify(context.payload).includes('FOREIGN_MUST_NOT_APPEAR'));
  assert.ok(!context.payload.taskContext.recentExchange.some(item => item.sourceId === 'qq:39999'));
});
